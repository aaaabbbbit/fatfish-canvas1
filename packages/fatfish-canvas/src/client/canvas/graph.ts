/**
 * 节点图的规则 —— 纯函数，无 React、无 DOM。
 *
 * 图只有一种边：**产物 → 生成**。产物可以是图片节点、视频节点、文字节点，
 * 也可以是**另一个生成节点的产物**（串联，P19）—— 于是 `A → B → C` 这种链
 * 是合法的，工作流从「一堆互不相干的生成」变成了真的管线。
 *
 * 放开串联带来两件必须自己做的事：
 *
 *   1. **环检测**（`wouldCycle`）—— 有了生成节点之间的边，环就可能出现，
 *      而环会让「按依赖顺序跑」永远排不出顺序；
 *   2. **拓扑序**（`topoOrder`）—— 下游必须在上游出图之后才能组命令行
 *      （它要的是上游的**产物地址**，不是上游这个节点）。
 *
 * 仍然不做的：`run.ts` 只按拓扑序**串行发命令**，没有并行分支调度、
 * 没有「上游失败时下游的降级路径」（下游直接判失败并写明原因）。
 *
 * @module fatfish-canvas/client/canvas/graph
 */

import { isReferenceHandle } from '../shared/media';
import type { CanvasLink, CanvasNode } from './model';

/** 连线是否成立的判定结果。 */
export type LinkCheck = { ok: true } | { ok: false; reason: string };

/**
 * 这个节点是「内联图，但还没有宿主句柄」吗 —— 连线会被拒的那一种。
 *
 * 单独导出：连线被拒时客户端要**当场**请宿主补存一次句柄再连上
 * （见 `CanvasStage` 的 `linkAfterStoringReference`），而判据不能两处各写一遍 ——
 * 写歪了就是「提示让人重拖、重拖也没用」。
 * @param node - 参考图来源节点。
 * @returns 需要补一次句柄时为 true。
 */
export function needsReferenceHandle(node: CanvasNode): boolean {
	if (node.ref !== undefined && node.ref !== '') return false;
	const src = node.src;
	if (src === undefined || src === '') return false;
	return src.startsWith('data:') && !isReferenceHandle(src);
}

/** 判断一个节点能不能当**参考图**来源（地址得是宿主取得到的句柄）。 */
function referenceProblem(node: CanvasNode): string | null {
	if (node.status === 'pending') return '这个节点还在生成中，等它出图再连';
	if (node.status === 'failed') return '这个节点生成失败了，不能当参考图';
	// 宿主已经把它存成参考图句柄了（P22：本地拖进来的图走这条路）——
	// 句柄是宿主自己发的，这里不必再按地址格式挑一遍。
	if (node.ref !== undefined && node.ref !== '') return null;
	if (node.src === undefined || node.src === '') return '这个节点还没有图，不能当参考图';
	// 判据与画布右键的「以此为参考图生成」共用一份（`shared/media.ts`）：
	// `blob:` 这类进程内地址宿主取不到，兆级的 data: 会把命令行撑爆。
	//
	// ⚠️ 先存成一个布尔再用：`isReferenceHandle` 是**类型谓词**（`value is string`），
	// 直接在条件里写它会把 `node.src`（此时已经是 `string`）在 else 分支收窄成
	// `never` —— 后面那句 `startsWith` 就没法读了。
	const usable: boolean = isReferenceHandle(node.src);
	if (!usable) {
		// 内联图（本地拖进来的、供应商内联回的生成结果）：连线那一刻客户端**先**请
		// 宿主把它存成句柄再连（`CanvasStage`），因此走到这条说明**存不成** ——
		// 命令行是文本通路，塞不下几兆的 base64。说清还能怎么办，别只报「地址不行」。
		if (needsReferenceHandle(node)) {
			return (
				'这张图的字节没能存成参考图（内联数据太长，塞不进命令行；具体原因见底部提示）。' +
				'把图另存成文件、从资源管理器拖进画布，或改用生成出来的图（http 地址）。'
			);
		}
		// `blob:` 这类进程内地址：宿主根本取不到，多说一句也没用
		return '这个节点的地址不能当参考图（需要 http(s) 地址或较小的内联图）';
	}
	return null;
}

/**
 * 加一条 `from → to` 的边会不会成环。
 *
 * 判据很短：新边让 `to` 能走回 `from` 时才成环。从 `to` 出发顺着出边做深度
 * 优先搜索，撞上 `from` 就是环。节点数是画布量级（几百），不做记忆化。
 * @param links - 当前连线表。
 * @param fromId - 新边的起点。
 * @param toId - 新边的终点。
 * @returns 是否会成环。
 */
export function wouldCycle(links: readonly CanvasLink[], fromId: string, toId: string): boolean {
	const stack = [toId];
	const seen = new Set<string>();
	while (stack.length > 0) {
		const current = stack.pop();
		if (current === undefined) continue;
		if (current === fromId) return true;
		if (seen.has(current)) continue;
		seen.add(current);
		for (const link of links) {
			if (link.from === current) stack.push(link.to);
		}
	}
	return false;
}

/**
 * 一条连线能不能建立。
 *
 * 全部拒绝理由都是**给人看的一句话**：静默不生效是最难查的一类反馈，
 * 而这里每一条都对应一个用户真的会做的动作。
 * @param nodes - 当前节点表。
 * @param links - 当前连线表。
 * @param fromId - 起点节点 id（用户从它的连接点拉出来的）。
 * @param toId - 终点节点 id（松手落在的那个）。
 * @returns 判定结果。
 */
export function canLink(
	nodes: readonly CanvasNode[],
	links: readonly CanvasLink[],
	fromId: string,
	toId: string,
): LinkCheck {
	if (fromId === toId) return { ok: false, reason: '不能连到自己' };
	const from = nodes.find((node) => node.id === fromId);
	const to = nodes.find((node) => node.id === toId);
	if (from === undefined || to === undefined) return { ok: false, reason: '节点不存在' };

	if (links.some((link) => link.from === fromId && link.to === toId)) {
		return { ok: false, reason: '这两个节点已经连过了' };
	}

	if (to.kind !== 'gen') {
		return { ok: false, reason: '只有生成节点接受输入（把线拉到生成节点上）' };
	}
	if (wouldCycle(links, fromId, toId)) {
		return { ok: false, reason: '这样会绕成一个环，工作流排不出执行顺序' };
	}

	if (from.kind === 'text') {
		if ((from.prompt ?? from.title ?? '').trim() === '') {
			return { ok: false, reason: '这个文字节点是空的，先双击写点内容' };
		}
		return { ok: true };
	}

	// 图片 / 视频 / 另一个生成节点的产物 → 参考图：现有管线只收一个 `reference`，
	// 因此只允许一条。
	const existing = links.find((link) => link.to === toId);
	if (existing !== undefined) {
		const source = nodes.find((node) => node.id === existing.from);
		if (source !== undefined && source.kind !== 'text') {
			return { ok: false, reason: '一个生成节点只支持一张参考图' };
		}
	}
	const problem = referenceProblem(from);
	if (problem !== null) return { ok: false, reason: problem };
	return { ok: true };
}

/** 一个生成节点从连线上取到的输入。 */
export interface GenInputs {
	/** 参考图节点（最多一个）；没有连线时为 null。 */
	reference: CanvasNode | null;
	/** 连过来的提示词片段（按连线建立顺序拼接）。 */
	prompts: readonly string[];
}

/**
 * 取一个生成节点的输入。
 *
 * 提示词按**连线表里的顺序**拼接，而不是按节点坐标 —— 用户先连的那段在前，
 * 这与「拖进来就是一句话」的直觉一致，也不会因为挪动节点而改变结果。
 * @param nodeId - 生成节点 id。
 * @param nodes - 节点表。
 * @param links - 连线表。
 * @returns 参考图与提示词片段。
 */
export function inputsOf(
	nodeId: string,
	nodes: readonly CanvasNode[],
	links: readonly CanvasLink[],
): GenInputs {
	let reference: CanvasNode | null = null;
	const prompts: string[] = [];
	for (const link of links) {
		if (link.to !== nodeId) continue;
		const source = nodes.find((node) => node.id === link.from);
		if (source === undefined) continue;
		if (source.kind === 'text') {
			const text = (source.prompt ?? source.title ?? '').trim();
			if (text !== '') prompts.push(text);
			continue;
		}
		if (reference === null) reference = source;
	}
	return { reference, prompts };
}

/**
 * 一个生成节点要发出去的命令行正文（提示词部分）。
 * @param inputs - 它的输入。
 * @param own - 节点自己记着的提示词（从命令行还原出来的工作流会带上它）。
 * @returns 拼好的提示词；没有任何来源时为空串。
 */
export function promptOf(inputs: GenInputs, own?: string | undefined): string {
	const parts = [...inputs.prompts];
	const extra = (own ?? '').trim();
	if (extra !== '' && !parts.includes(extra)) parts.push(extra);
	return parts.join('\n');
}

/** 视觉顺序：先上后下、先左后右（同一层的并列节点按它排，结果确定）。 */
function visualOrder(a: CanvasNode, b: CanvasNode): number {
	return a.y - b.y || a.x - b.x;
}

/**
 * 生成节点的执行顺序：**依赖在前**，同一层的按视觉顺序。
 *
 * Kahn 算法，但只把「生成节点之间的边」算作依赖 —— 图片 / 文字节点永远是就绪的，
 * 让它们参与排序只会让顺序变得看不懂。
 *
 * 每轮重新扫一遍找入度为 0 的节点（O(n²)）：生成节点的数量是「一屏几个」的量级，
 * 为它维护一个优先队列不值得。
 * @param nodes - 节点表。
 * @param links - 连线表。
 * @returns 生成节点，依赖在前。
 */
export function topoOrder(
	nodes: readonly CanvasNode[],
	links: readonly CanvasLink[],
): CanvasNode[] {
	const gens = nodes.filter((node) => node.kind === 'gen');
	const byId = new Map(gens.map((node) => [node.id, node]));
	const indegree = new Map<string, number>();
	for (const node of gens) indegree.set(node.id, 0);
	for (const link of links) {
		if (!byId.has(link.from) || !byId.has(link.to)) continue;
		indegree.set(link.to, (indegree.get(link.to) ?? 0) + 1);
	}

	const remaining = new Set(byId.keys());
	const out: CanvasNode[] = [];
	while (remaining.size > 0) {
		const ready = [...remaining]
			.map((id) => byId.get(id))
			.filter((node): node is CanvasNode => node !== undefined && (indegree.get(node.id) ?? 0) === 0)
			.sort(visualOrder);
		const next = ready[0];
		// 没有入度为 0 的节点 = 有环。canLink 挡住了环，但**存储里可能有手工改坏的
		// 数据** —— 那种情况下宁可把剩下的按视觉顺序跑一遍，也不要卡死在这里。
		if (next === undefined) break;
		remaining.delete(next.id);
		out.push(next);
		for (const link of links) {
			if (link.from !== next.id || !remaining.has(link.to)) continue;
			indegree.set(link.to, (indegree.get(link.to) ?? 0) - 1);
		}
	}

	if (remaining.size > 0) {
		out.push(
			...[...remaining]
				.map((id) => byId.get(id))
				.filter((node): node is CanvasNode => node !== undefined)
				.sort(visualOrder),
		);
	}
	return out;
}
