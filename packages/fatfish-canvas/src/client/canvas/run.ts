/**
 * 运行工作流 —— 按**依赖顺序**把画布上的生成节点各跑一次。
 *
 * ## 顺序
 *
 * `topoOrder`（见 `canvas/graph.ts`）：上游在前、同层按视觉顺序。生成节点之间
 * 可以串联（`A → B` 表示「拿 A 出的图当 B 的参考图」），所以顺序不能靠坐标猜。
 *
 * ## 为什么要「等上游」
 *
 * 下游的命令行里要的是上游的**产物地址**，而那个地址是宿主异步回填的
 * （`command/done` → `canvas/ingest.ts`）。`session.command()` 结算时，
 * 回填**不一定**已经发生 —— 因此这里订阅一次 store，等上游真的 `ready` 再往下走。
 * 上游失败就立刻把下游判失败并写明原因，不浪费一次注定失败的生成。
 *
 * ## 为什么是串行
 *
 * `session.command()` 要等命令**执行完**才结算（宿主在 handler 里 await 整次生成），
 * 因此 `await` 一个再发下一个天然就是串行 —— 不需要自己排队，也不会同时占满
 * 供应商的并发额度。
 *
 * ## 结果怎么回到节点上
 *
 * 命令行的 `--wf <节点 id>` 是唯一的凭据：命令结果只能从会话事件里回来
 * （`command/done` → `canvas/ingest.ts`），那里凭这个标记把结果回填到生成节点，
 * 而不是另落一张散图。因此这里**只负责发出去**，状态的迁移由 ingest 完成。
 *
 * @module fatfish-canvas/client/canvas/run
 */

import { inputsOf, promptOf, topoOrder } from './graph';
import {
	genDurationOf,
	genKindOf,
	genRatioOf,
	genResolutionOf,
	type CanvasLink,
	type CanvasNode,
} from './model';
import { regenerateCommandLine, runCommandLine } from './regenerate';
import { getBoard, subscribeBoard, updateNodes } from './store';

/** 一次「运行工作流」的结果。 */
export interface RunReport {
	/** 真正发出去了几次生成。 */
	started: number;
	/** 跳过的节点与原因（连不上提示词、上游没出图、没有会话…）。 */
	skipped: readonly { id: string; reason: string }[];
}

/**
 * 等上游出图的上限。
 *
 * 上游的生成在它自己的 `command()` 结算时**已经跑完**，这里等的只是「回填到达
 * 浏览器」那一下，正常是毫秒级；给足余量只是为了不误判。
 */
export const UPSTREAM_WAIT_MS = 15_000;

/** 没有可用会话时的统一说法（与右键菜单的「重新生成」同一个判据）。 */
export const NO_SESSION_REASON = '当前没有会话，命令发不出去';

/** 一个生成节点要跑的那一行命令（或跑不了的原因）。 */
export type GenPlan = { ok: true; line: string; prompt: string } | { ok: false; reason: string };

/**
 * 组装一个生成节点的命令行。
 *
 * 提示词来自连进来的文字节点（`promptOf`）；参考图来自连进来的第一张图或
 * 上游生成节点的产物，它必须已经是可复用的地址 —— 这一点在**连线那一刻**就查过了
 * （`canLink` → `isReferenceHandle`），这里只是把它取出来。
 *
 * 产物种类、画幅比例、视频时长与分辨率取自节点自己的参数（P19 的参数面板）；
 * 没设的（`duration` / `resolution`）不进命令行，由生成管线用它自己的默认值。
 * @param node - 生成节点。
 * @param nodes - 节点表。
 * @param links - 连线表。
 * @returns 命令行或原因。
 */
export function planOf(
	node: CanvasNode,
	nodes: readonly CanvasNode[],
	links: readonly CanvasLink[],
): GenPlan {
	const inputs = inputsOf(node.id, nodes, links);
	const prompt = promptOf(inputs);
	if (prompt === '') return { ok: false, reason: '没有连入任何提示词' };
	return {
		ok: true,
		prompt,
		line: regenerateCommandLine(prompt, {
			kind: genKindOf(node),
			ratio: genRatioOf(node),
			// 优先用宿主存好的参考图句柄（P22：本地图只有它有）；没有就用 `src`
			reference: referenceHandleOf(inputs.reference),
			wf: node.id,
			duration: genDurationOf(node),
			resolution: genResolutionOf(node),
		}),
	};
}

/**
 * 一个参考图节点该用哪个地址进命令行。
 *
 * 优先 `ref`（宿主存好的句柄，P22）—— 本地拖进来的图只有它有；否则退回 `src`
 * （生成结果的 http 地址）。
 * @param node - 参考图节点；没有参考图时为 null。
 * @returns 可进命令行的地址；都没有时 undefined。
 */
export function referenceHandleOf(node: CanvasNode | null): string | undefined {
	if (node === null) return undefined;
	if (node.ref !== undefined && node.ref !== '') return node.ref;
	return node.src === undefined || node.src === '' ? undefined : node.src;
}

/**
 * 上游生成节点（连进来的参考图来自另一个生成节点时）。
 * @param node - 下游节点。
 * @param nodes - 节点表。
 * @param links - 连线表。
 * @returns 上游生成节点；参考图不是生成节点时为 null。
 */
export function upstreamGenOf(
	node: CanvasNode,
	nodes: readonly CanvasNode[],
	links: readonly CanvasLink[],
): CanvasNode | null {
	const reference = inputsOf(node.id, nodes, links).reference;
	return reference !== null && reference.kind === 'gen' ? reference : null;
}

/**
 * 等一个节点不再是 `pending`。
 *
 * 订阅 store 而不是轮询：回填是一次 store 提交，订阅能立刻醒过来，轮询要么慢
 * 要么费。超时返回 null（节点可能一直卡在 pending，例如命令压根没跑起来）。
 * @param id - 节点 id。
 * @param timeoutMs - 超时上限。
 * @returns 稳定后的节点；超时或节点已被删除时 null。
 */
export function waitForSettled(id: string, timeoutMs: number): Promise<CanvasNode | null> {
	const find = (): CanvasNode | undefined => getBoard().nodes.find((node) => node.id === id);
	const current = find();
	if (current !== undefined && current.status !== 'pending') return Promise.resolve(current);

	return new Promise<CanvasNode | null>((resolve) => {
		let done = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		let off: (() => void) | null = null;
		const finish = (node: CanvasNode | null): void => {
			if (done) return;
			done = true;
			if (timer !== null) clearTimeout(timer);
			if (off !== null) off();
			resolve(node);
		};
		timer = setTimeout(() => {
			finish(null);
		}, timeoutMs);
		off = subscribeBoard(() => {
			const node = find();
			if (node !== undefined && node.status !== 'pending') finish(node);
		});
		// 订阅之后**再查一次**：可能在注册订阅之前就已经就绪了（两个动作之间
		// 没有 await，但依赖这个假设太脆）
		const again = find();
		if (again !== undefined && again.status !== 'pending') finish(again);
	});
}

/** 把一个生成节点标成失败。 */
function fail(id: string, reason: string): void {
	updateNodes([id], { status: 'failed', error: reason });
}

/** 跑一个节点的结果：发出去了，或者因为某个原因跳过。 */
type StepResult = { ok: true } | { ok: false; reason: string };

/**
 * 跑一个生成节点（含「等上游」与失败落账）。
 *
 * 发出去之前先置 `pending` —— 用户立刻就能看到「在画哪一张」，而不是等结果回来才变。
 * 结果与失败原因由 `ingest` 回填（凭命令行里的 `--wf`）。
 * @param node - 目标生成节点。
 * @returns 发出去了还是被跳过。
 */
async function runOne(node: CanvasNode): Promise<StepResult> {
	if (node.status === 'pending') return { ok: false, reason: '正在生成中' };

	// 每一步都重新读 store：一次运行要跑好几个节点，期间用户可能改了参数或挪了线，
	// 而上游刚回填的 `src` 也只在新快照里。
	const fresh = (): CanvasNode | undefined => getBoard().nodes.find((item) => item.id === node.id);
	const self = fresh() ?? node;
	if (self.status === 'pending') return { ok: false, reason: '正在生成中' };

	// ── 上游是生成节点：等它出图（地址是下游命令行的必需输入）──
	const first = getBoard();
	const upstream = upstreamGenOf(self, first.nodes, first.links);
	if (upstream !== null && (upstream.status !== 'ready' || upstream.src === undefined)) {
		const settled = await waitForSettled(upstream.id, UPSTREAM_WAIT_MS);
		if (settled === null) {
			fail(self.id, '上游节点一直没有出图');
			return { ok: false, reason: '上游节点一直没有出图' };
		}
		if (settled.status !== 'ready') {
			const why = settled.error === undefined || settled.error === '' ? '生成失败' : settled.error;
			fail(self.id, `上游节点没有出图：${why}`);
			return { ok: false, reason: '上游节点没有出图' };
		}
		if (settled.src === undefined || settled.src === '') {
			// 「就绪但没图」：上游从没跑过（例如刚还原出来的工作流）
			fail(self.id, '上游节点还没有出图');
			return { ok: false, reason: '上游节点还没有出图' };
		}
	}

	const board = getBoard();
	const latest = board.nodes.find((item) => item.id === node.id) ?? self;
	const plan = planOf(latest, board.nodes, board.links);
	if (!plan.ok) return { ok: false, reason: plan.reason };

	updateNodes([latest.id], { status: 'pending', title: plan.prompt, prompt: plan.prompt });
	if (!(await runCommandLine(plan.line))) {
		fail(latest.id, NO_SESSION_REASON);
		return { ok: false, reason: NO_SESSION_REASON };
	}
	return { ok: true };
}

/**
 * 跑整个工作流。
 *
 * 顺序由 `topoOrder` 决定（上游在前）；**串行**发命令 —— `session.command()` 本身
 * 要等一次生成跑完才结算，而并行会同时占满供应商的并发额度（各家的限制还不一样，
 * 自己限流得先知道额度）。要并行是另一件事，见 STATE 的天花板清单。
 * @param nodes - 节点表（决定执行顺序；每一步的实际取值都重新读 store）。
 * @param links - 连线表。
 * @returns 运行报告。
 */
export async function runWorkflow(
	nodes: readonly CanvasNode[],
	links: readonly CanvasLink[],
): Promise<RunReport> {
	const skipped: { id: string; reason: string }[] = [];
	let started = 0;

	for (const node of topoOrder(nodes, links)) {
		const result = await runOne(node);
		if (result.ok) started += 1;
		else skipped.push({ id: node.id, reason: result.reason });
	}

	return { started, skipped };
}

/**
 * 只跑**一个**生成节点（右键菜单「运行此节点」）。
 *
 * 刻意**不重跑上游**：上游的产物地址就在节点上，用户改完这一个的参数想看到的
 * 是「换一张」，而不是把整条链再烧一遍。上游还没出图时会明确说「上游节点还没有出图」。
 * @param nodeId - 目标生成节点 id。
 * @returns 运行报告（最多一项）。
 */
export async function runSingleNode(nodeId: string): Promise<RunReport> {
	const node = getBoard().nodes.find((item) => item.id === nodeId);
	if (node === undefined) return { started: 0, skipped: [{ id: nodeId, reason: '节点不存在' }] };
	const result = await runOne(node);
	return result.ok
		? { started: 1, skipped: [] }
		: { started: 0, skipped: [{ id: nodeId, reason: result.reason }] };
}

/**
 * 把一次运行报告说成一句人话（顶栏那枚读数用它）。
 * @param report - 运行报告。
 * @returns 一行文案。
 */
export function describeRun(report: RunReport): string {
	if (report.started === 0 && report.skipped.length === 0) return '画布上没有生成节点';
	if (report.skipped.length === 0) return `已运行 ${String(report.started)} 个生成节点`;
	if (report.started === 0) {
		const first = report.skipped[0];
		return `没有可运行的节点：${first === undefined ? '原因不明' : first.reason}`;
	}
	return `已运行 ${String(report.started)} 个，跳过 ${String(report.skipped.length)} 个`;
}
