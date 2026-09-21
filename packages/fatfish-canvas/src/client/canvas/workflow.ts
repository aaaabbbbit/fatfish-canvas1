/**
 * 工作流文档的序列化与还原 —— 纯函数，无 DOM。
 *
 * 文档写进 PNG 的 `workflow` tEXt 块（见 `pngmeta.ts`），键名与 ComfyUI 相同。
 * 形状也刻意像它：`{ nodes: [...], links: [...] }`，每个节点带自己的坐标与参数。
 *
 * 一个诚实的分界：**`app` 字段是必需的**。真 ComfyUI 的工作流也在这个键里，
 * 但它的节点是 `{ type: 'KSampler', widgets_values: [...] }` 那一套 —— 认不出来时
 * 必须明说「这是 ComfyUI 的工作流，本版本还原不了」，而不是猜着还原出一堆空节点。
 *
 * @module fatfish-canvas/client/canvas/workflow
 */

import { ASPECT_RATIOS, VIDEO_RESOLUTIONS } from '../shared/media';
import {
	boundsOf,
	makeNodeId,
	PLACEMENT_SPACING,
	rectsIntersect,
	type CanvasLink,
	type CanvasNode,
	type NodeKind,
	type PortSide,
	type Rect,
} from './model';

/** 写进 PNG 的那个键（与 ComfyUI 同名，读的那半边以后可以共用）。 */
export const WORKFLOW_KEY = 'workflow';

/** 文档里的应用标识（用来区分「我们的工作流」与「真 ComfyUI 的工作流」）。 */
export const WORKFLOW_APP = 'fatfish-canvas';

/** 文档格式版本。 */
export const WORKFLOW_VERSION = 1;

/** 文档里的一个节点（只留还原画布需要的字段）。 */
export interface WorkflowNode {
	id: string;
	kind: NodeKind;
	x: number;
	y: number;
	w: number;
	h: number;
	/** 只存 `http(s)` 地址：`data:` 大图会把文档撑到兆级，而导出的 PNG 本身就带着像素。 */
	src?: string;
	/**
	 * 参考图句柄（P22：宿主文件路径）。
	 *
	 * 与 `src` 的取舍不同：它**很短**（一条路径），存进文档能让还原出来的工作流
	 * 直接复用同一张本地图，不必让用户再拖一次。
	 */
	ref?: string;
	prompt?: string;
	title?: string;
	model?: string;
	/** 生成节点的产物种类（P19）。 */
	genKind?: 'image' | 'video';
	/** 生成节点的画幅比例（P19）。 */
	ratio?: string;
	/** 生成节点的视频时长（秒，P19）。 */
	duration?: number;
	/** 生成节点的视频分辨率（P19）。 */
	resolution?: string;
}

/** 文档里的一条连线。 */
export interface WorkflowLink {
	from: string;
	to: string;
	fromSide: PortSide;
	toSide: PortSide;
}

/** 工作流文档。 */
export interface WorkflowDoc {
	app: string;
	version: number;
	nodes: WorkflowNode[];
	links: WorkflowLink[];
}

const KINDS: readonly NodeKind[] = ['image', 'video', 'text', 'gen'];
const SIDES: readonly PortSide[] = ['n', 'e', 's', 'w'];

/** 只有能长期复用的地址才进文档（见 `WorkflowNode.src`）。 */
function reusable(src: string | undefined): string | undefined {
	return src !== undefined && /^https?:\/\//i.test(src) ? src : undefined;
}

/**
 * 把画布序列化成工作流文档文本。
 * @param nodes - 节点表。
 * @param links - 连线表。
 * @returns JSON 文本。
 */
export function serializeWorkflow(
	nodes: readonly CanvasNode[],
	links: readonly CanvasLink[],
): string {
	const ids = new Set(nodes.map((node) => node.id));
	const doc: WorkflowDoc = {
		app: WORKFLOW_APP,
		version: WORKFLOW_VERSION,
		nodes: nodes.map((node) => {
			const src = reusable(node.src);
			return {
				id: node.id,
				kind: node.kind,
				x: Math.round(node.x),
				y: Math.round(node.y),
				w: Math.round(node.w),
				h: Math.round(node.h),
				...(src === undefined ? {} : { src }),
				...(node.ref === undefined || node.ref === '' ? {} : { ref: node.ref }),
				...(node.prompt === undefined || node.prompt === '' ? {} : { prompt: node.prompt }),
				...(node.title === undefined || node.title === '' ? {} : { title: node.title }),
				...(node.model === undefined || node.model === '' ? {} : { model: node.model }),
				// 生成节点的参数也要进文档：还原出来的是「那张图是怎么来的」，
				// 少了种类与比例就只还原了一半。
				...(node.genKind === undefined ? {} : { genKind: node.genKind }),
				...(node.ratio === undefined || node.ratio === '' ? {} : { ratio: node.ratio }),
				...(node.duration === undefined ? {} : { duration: node.duration }),
				...(node.resolution === undefined || node.resolution === ''
					? {}
					: { resolution: node.resolution }),
			};
		}),
		// 端点不全的连线不进文档：还原时只会变成一条谁也不知道从哪来的线
		links: links
			.filter((link) => ids.has(link.from) && ids.has(link.to))
			.map((link) => ({
				from: link.from,
				to: link.to,
				fromSide: link.fromSide,
				toSide: link.toSide,
			})),
	};
	return JSON.stringify(doc);
}

/**
 * 解析工作流文档。
 * @param text - tEXt 块里的文本。
 * @returns 文档；不是本插件写的那种（例如真 ComfyUI 的）时返回 null。
 */
export function parseWorkflow(text: string): WorkflowDoc | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const o = raw as Record<string, unknown>;
	if (o.app !== WORKFLOW_APP) return null;
	if (typeof o.version !== 'number') return null;
	if (!Array.isArray(o.nodes)) return null;

	const nodes: WorkflowNode[] = [];
	for (const item of o.nodes) {
		if (item === null || typeof item !== 'object') continue;
		const n = item as Record<string, unknown>;
		if (typeof n.id !== 'string' || n.id === '') continue;
		if (!KINDS.includes(n.kind as NodeKind)) continue;
		const numbers = [n.x, n.y, n.w, n.h];
		if (!numbers.every((value) => typeof value === 'number' && Number.isFinite(value))) continue;
		if ((n.w as number) <= 0 || (n.h as number) <= 0) continue;
		nodes.push({
			id: n.id,
			kind: n.kind as NodeKind,
			x: n.x as number,
			y: n.y as number,
			w: n.w as number,
			h: n.h as number,
			...(typeof n.src === 'string' && n.src !== '' ? { src: n.src } : {}),
			...(typeof n.ref === 'string' && n.ref !== '' ? { ref: n.ref } : {}),
			...(typeof n.prompt === 'string' ? { prompt: n.prompt } : {}),
			...(typeof n.title === 'string' ? { title: n.title } : {}),
			...(typeof n.model === 'string' ? { model: n.model } : {}),
			...(n.genKind === 'image' || n.genKind === 'video' ? { genKind: n.genKind } : {}),
			...(typeof n.ratio === 'string' && ASPECT_RATIOS.includes(n.ratio) ? { ratio: n.ratio } : {}),
			...(typeof n.duration === 'number' && Number.isFinite(n.duration) && n.duration > 0
				? { duration: n.duration }
				: {}),
			...(typeof n.resolution === 'string' && VIDEO_RESOLUTIONS.includes(n.resolution)
				? { resolution: n.resolution }
				: {}),
		});
	}
	if (nodes.length === 0) return null;

	const links: WorkflowLink[] = [];
	for (const item of Array.isArray(o.links) ? o.links : []) {
		if (item === null || typeof item !== 'object') continue;
		const l = item as Record<string, unknown>;
		if (typeof l.from !== 'string' || typeof l.to !== 'string') continue;
		if (!SIDES.includes(l.fromSide as PortSide) || !SIDES.includes(l.toSide as PortSide)) continue;
		links.push({
			from: l.from,
			to: l.to,
			fromSide: l.fromSide as PortSide,
			toSide: l.toSide as PortSide,
		});
	}

	return { app: WORKFLOW_APP, version: o.version, nodes, links };
}

/** 还原计划：可以直接交给 `addNodes` / `addLinks` 的输入。 */
export interface RestorePlan {
	nodes: (Omit<CanvasNode, 'z' | 'createdAt'> & { id: string })[];
	links: Omit<CanvasLink, 'id'>[];
}

/**
 * 把一份文档排成可以落到画布上的节点与连线。
 *
 * 三件事：
 *   1. **id 全部重映射** —— 直接沿用旧 id 会与画布上已有的节点撞车（同一个文档
 *      拖进来两次，第二份会把第一份的节点覆盖掉）；
 *   2. **锚到落点** —— 文档里存的是绝对坐标，还原时要整体平移到用户松手的位置；
 *   3. **不与现有节点重叠** —— 落点被占了就整体挪到现有内容的右侧。
 * @param doc - 文档。
 * @param at - 落点（世界坐标，还原后的左上角对齐到这里）。
 * @param existing - 画布上已有的节点。
 * @returns 还原计划；文档里没有可用节点时返回 null。
 */
export function planRestore(
	doc: WorkflowDoc,
	at: { x: number; y: number },
	existing: readonly CanvasNode[],
): RestorePlan | null {
	if (doc.nodes.length === 0) return null;

	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const node of doc.nodes) {
		minX = Math.min(minX, node.x);
		minY = Math.min(minY, node.y);
		maxX = Math.max(maxX, node.x + node.w);
		maxY = Math.max(maxY, node.y + node.h);
	}

	let dx = Math.round(at.x - minX);
	let dy = Math.round(at.y - minY);
	const box: Rect = { x: minX + dx, y: minY + dy, w: maxX - minX, h: maxY - minY };
	if (existing.some((node) => rectsIntersect(box, { x: node.x, y: node.y, w: node.w, h: node.h }))) {
		const bounds = boundsOf(existing);
		dx = Math.round((bounds === null ? 0 : bounds.x + bounds.w + PLACEMENT_SPACING) - minX);
		dy = Math.round(at.y - minY);
	}

	const idMap = new Map<string, string>();
	const nodes = doc.nodes.map((node) => {
		const id = makeNodeId();
		idMap.set(node.id, id);
		return {
			id,
			kind: node.kind,
			x: Math.round(node.x + dx),
			y: Math.round(node.y + dy),
			w: Math.round(node.w),
			h: Math.round(node.h),
			// 一律就绪：文档里的 `pending` / `failed` 是上一次运行留下的瞬时状态，
			// 还原出来应该是一张能直接再跑的图（失败原因也早已过期）。
			status: 'ready' as const,
			...(node.src === undefined ? {} : { src: node.src }),
			...(node.ref === undefined ? {} : { ref: node.ref }),
			...(node.prompt === undefined ? {} : { prompt: node.prompt }),
			...(node.title === undefined ? {} : { title: node.title }),
			...(node.model === undefined ? {} : { model: node.model }),
			...(node.genKind === undefined ? {} : { genKind: node.genKind }),
			...(node.ratio === undefined ? {} : { ratio: node.ratio }),
			...(node.duration === undefined ? {} : { duration: node.duration }),
			...(node.resolution === undefined ? {} : { resolution: node.resolution }),
		};
	});

	const links: Omit<CanvasLink, 'id'>[] = [];
	for (const link of doc.links) {
		const from = idMap.get(link.from);
		const to = idMap.get(link.to);
		if (from === undefined || to === undefined) continue;
		links.push({ from, to, fromSide: link.fromSide, toSide: link.toSide });
	}

	return { nodes, links };
}
