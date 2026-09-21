/**
 * 画布数据模型与视口数学 —— 纯函数，无 React、无 DOM。
 *
 * 坐标约定（全画布唯一的一套，务必一致）：
 *
 *   screen = (world - viewport.xy) * viewport.zoom
 *   world  = screen / viewport.zoom + viewport.xy
 *
 * 即 viewport.x/y 是「世界原点在屏幕上的位置」（zoom=1 时）。
 * 画布是无限二维平面，节点坐标用 world 坐标，视口变换由外层容器
 * 用一次 CSS transform 施加（`translate(-x*zoom, -y*zoom) scale(zoom)`
 * 的等价形式，见 stage 组件）。
 *
 * @module fatfish-canvas/client/canvas/model
 */

/**
 * 节点承载的媒体种类。
 *
 * `image` / `video` / `text` 是媒体卡片；`gen` 是**生成节点** —— 它自己不带提示词，
 * 提示词与参考图由连线喂进来（见 `canvas/graph.ts`），产物落在节点自己身上
 * （pending → ready），因此它同时也是「输出」。
 */
export type NodeKind = 'image' | 'video' | 'text' | 'gen';

/** 节点状态：生成中 / 就绪 / 失败。 */
export type NodeStatus = 'pending' | 'ready' | 'failed';

/** 画布上的一个节点（图像、视频或文字卡片）。 */
export interface CanvasNode {
	/** 稳定唯一 id。 */
	id: string;
	/** 媒体种类。 */
	kind: NodeKind;
	/** 世界坐标左上角 X。 */
	x: number;
	/** 世界坐标左上角 Y。 */
	y: number;
	/** 世界坐标宽度。 */
	w: number;
	/** 世界坐标高度。 */
	h: number;
	/** 叠放次序，越大越靠前。 */
	z: number;
	/** 当前状态。 */
	status: NodeStatus;
	/** 媒体地址（http(s)、blob: 或 data:）。pending 时通常为空。 */
	src?: string;
	/**
	 * 这张图的**参考图句柄**（P22：宿主文件系统上的绝对路径）。
	 *
	 * 为什么不能直接用 `src`：`src` 要能喂给 `<img>`（http / data / blob），而参考图
	 * 必须塞进 `/generate --ref` 那一行**文本**。本地拖进来的图 `src` 是一张几兆的
	 * `data:` URL，塞不进去 —— 于是让宿主把字节存进附件库，回一个短路径放在这里。
	 * 连线判定与命令行都优先用它。
	 */
	ref?: string;
	/** 视频封面。 */
	poster?: string;
	/** 卡片标题。 */
	title?: string;
	/** 生成用的提示词。 */
	prompt?: string;
	/** 生成用的模型标识。 */
	model?: string;
	/** 失败原因（status === 'failed' 时）。 */
	error?: string;
	/** 创建时间戳（毫秒）。 */
	createdAt: number;
	/** 生成它的会话 id（P3 用于回溯）。 */
	sessionId?: string;
	/**
	 * 这张图**自带的工作流文档**（P18：拖进来的 PNG 里读出的 `workflow` tEXt 块）。
	 *
	 * 存在节点上而不是内存表里：刷新之后「还原工作流」还得在（用户完全可能先拖
	 * 进来、过一会儿再还原）。文档本身只有几 KB，且里面的 `src` 只留 http(s) 地址。
	 */
	workflow?: string;
	/**
	 * 生成节点的**产物种类**（P19）。缺省 `image`。
	 *
	 * 刻意不复用 `kind`：`kind` 说的是「这是个什么节点」（`gen`），这里说的是
	 * 「它会画出什么」（图像 / 视频）—— 两者混成一个字段之后 `NodeCard` 的分支
	 * 就再也读不懂了。
	 */
	genKind?: 'image' | 'video';
	/** 生成节点的**画幅比例**（P19，如 `16:9`）。缺省 `1:1`。 */
	ratio?: string;
	/** 生成节点的**视频时长（秒）**（P19）。缺省 = 用管线的默认值。 */
	duration?: number;
	/** 生成节点的**视频分辨率**（P19，如 `1080p`）。缺省 = 用管线的默认值。 */
	resolution?: string;
}

/** 生成节点画什么（缺省图像）。 */
export function genKindOf(node: { genKind?: 'image' | 'video' | undefined }): 'image' | 'video' {
	return node.genKind === 'video' ? 'video' : 'image';
}

/** 生成节点的画幅比例（缺省 1:1 —— 与生成管线的默认值一致）。 */
export function genRatioOf(node: { ratio?: string | undefined }): string {
	const value = (node.ratio ?? '').trim();
	return value === '' ? '1:1' : value;
}

/**
 * 生成节点的视频时长。
 *
 * 返回 `undefined` 表示**用管线的默认值** —— 与「0 秒」是两回事，因此这里只认
 * 正数，坏值一律当成没设。
 * @param node - 生成节点。
 * @returns 秒数；没设或坏值时 undefined。
 */
export function genDurationOf(node: { duration?: number | undefined }): number | undefined {
	const value = node.duration;
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * 生成节点的视频分辨率。
 * @param node - 生成节点。
 * @returns 分辨率；没设时 undefined（用管线的默认值）。
 */
export function genResolutionOf(node: { resolution?: string | undefined }): string | undefined {
	const value = (node.resolution ?? '').trim();
	return value === '' ? undefined : value;
}

// ─────────────────────── 连线（P18） ───────────────────────

/**
 * 节点四条边的中点 —— 也就是**连接点**的位置。
 *
 * 进出合一：同一个点既是入口也是出口（用户要的形态，参考 ComfyUI 但把
 * 左侧输入点与右侧输出点合并成一个）。方向因此不记在连接点上，只记在连线上。
 */
export type PortSide = 'n' | 'e' | 's' | 'w';

/** 一条连线：`from` 节点的产物喂给 `to` 节点的输入。 */
export interface CanvasLink {
	/** 稳定唯一 id。 */
	id: string;
	/** 起点节点 id。 */
	from: string;
	/** 终点节点 id。 */
	to: string;
	/** 用户从起点节点的哪条边的连接点拉出来的（渲染要从这个点出发）。 */
	fromSide: PortSide;
	/** 落在终点节点的哪条边上。 */
	toSide: PortSide;
}

/**
 * 命中测试：世界坐标下最上层（z 最大）的那个节点。
 *
 * 连线拖拽的落点判定用它 —— 指针被视口 capture 之后 `event.target` 永远是视口，
 * 因此落点必须自己算，不能指望 DOM 的命中。
 * @param nodes - 节点表（按 z 升序）。
 * @param point - 世界坐标点。
 * @returns 命中的节点；没命中时为 null。
 */
export function nodeAt(nodes: readonly CanvasNode[], point: Point): CanvasNode | null {
	for (let i = nodes.length - 1; i >= 0; i -= 1) {
		const node = nodes[i];
		if (node === undefined) continue;
		if (
			point.x >= node.x &&
			point.x <= node.x + node.w &&
			point.y >= node.y &&
			point.y <= node.y + node.h
		) {
			return node;
		}
	}
	return null;
}

/** 瞬时视口状态。 */
export interface Viewport {
	/** 世界原点在屏幕上的 X 偏移（未乘 zoom）。 */
	x: number;
	/** 世界原点在屏幕上的 Y 偏移（未乘 zoom）。 */
	y: number;
	/** 缩放倍率。 */
	zoom: number;
}

/** 屏幕上的一个点（视口坐标系，通常来自 PointerEvent.clientX/Y 减去容器原点）。 */
export interface Point {
	x: number;
	y: number;
}

/** 世界坐标系里的矩形。 */
export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** 缩放下限。 */
export const ZOOM_MIN = 0.1;
/** 缩放上限（10x = 1000%）。看大图细节（面料纹理、缝线）是画布的主要用途之一。 */
export const ZOOM_MAX = 10;

/** 一次滚轮/按钮缩放的步进比例。 */
export const ZOOM_STEP = 1.15;

/** 默认视口。 */
export const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };

/**
 * 把缩放倍率夹到契约范围。
 * @param zoom - 期望倍率。
 * @returns 夹紧后的倍率。
 */
export function clampZoom(zoom: number): number {
	return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

/**
 * 屏幕坐标 → 世界坐标。
 * @param point - 屏幕点。
 * @param viewport - 当前视口。
 * @returns 世界点。
 */
export function toWorld(point: Point, viewport: Viewport): Point {
	return {
		x: point.x / viewport.zoom + viewport.x,
		y: point.y / viewport.zoom + viewport.y,
	};
}

/**
 * 世界坐标 → 屏幕坐标。
 * @param point - 世界点。
 * @param viewport - 当前视口。
 * @returns 屏幕点。
 */
export function toScreen(point: Point, viewport: Viewport): Point {
	return {
		x: (point.x - viewport.x) * viewport.zoom,
		y: (point.y - viewport.y) * viewport.zoom,
	};
}

/**
 * 以某个屏幕点为锚点缩放：该点下方的世界坐标在缩放前后保持不动。
 *
 * 这是「滚轮缩放跟手」的唯一正确做法；如果直接用视口中心缩放，
 * 光标下的内容会漂移。
 * @param viewport - 当前视口。
 * @param anchor - 屏幕锚点。
 * @param nextZoom - 期望倍率（会被夹紧）。
 * @returns 新视口。
 */
export function zoomAround(viewport: Viewport, anchor: Point, nextZoom: number): Viewport {
	const zoom = clampZoom(nextZoom);
	if (zoom === viewport.zoom) return viewport;
	const world = toWorld(anchor, viewport);
	return {
		x: world.x - anchor.x / zoom,
		y: world.y - anchor.y / zoom,
		zoom,
	};
}

/**
 * 按比例缩放（供 +/- 按钮与滚轮使用）。
 * @param viewport - 当前视口。
 * @param anchor - 屏幕锚点。
 * @param factor - 乘数（>1 放大）。
 * @returns 新视口。
 */
export function zoomBy(viewport: Viewport, anchor: Point, factor: number): Viewport {
	return zoomAround(viewport, anchor, viewport.zoom * factor);
}

/**
 * 计算节点集合的世界包围盒。
 * @param nodes - 节点列表。
 * @returns 包围盒；列表为空时返回 null。
 */
export function boundsOf(nodes: readonly CanvasNode[]): Rect | null {
	if (nodes.length === 0) return null;
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const node of nodes) {
		minX = Math.min(minX, node.x);
		minY = Math.min(minY, node.y);
		maxX = Math.max(maxX, node.x + node.w);
		maxY = Math.max(maxY, node.y + node.h);
	}
	return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * 求出把给定世界矩形完整纳入视口并居中的视口状态。
 * @param rect - 世界矩形。
 * @param size - 视口的屏幕尺寸。
 * @param padding - 四周留白（屏幕像素）。
 * @returns 新视口。
 */
export function fitRect(rect: Rect, size: { w: number; h: number }, padding = 48): Viewport {
	const availW = Math.max(1, size.w - padding * 2);
	const availH = Math.max(1, size.h - padding * 2);
	const zoom = clampZoom(Math.min(availW / Math.max(1, rect.w), availH / Math.max(1, rect.h)));
	const cx = rect.x + rect.w / 2;
	const cy = rect.y + rect.h / 2;
	return {
		x: cx - size.w / (2 * zoom),
		y: cy - size.h / (2 * zoom),
		zoom,
	};
}

/** 两个矩形是否相交（用于框选命中判定）。 */
export function rectsIntersect(a: Rect, b: Rect): boolean {
	return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * 由两个对角点构造规范化矩形（框选拖拽可能朝任意方向）。
 * @param a - 起点。
 * @param b - 终点。
 * @returns 左上角为原点的矩形。
 */
export function rectFromPoints(a: Point, b: Point): Rect {
	return {
		x: Math.min(a.x, b.x),
		y: Math.min(a.y, b.y),
		w: Math.abs(a.x - b.x),
		h: Math.abs(a.y - b.y),
	};
}

/**
 * 把矩形按视口换算为屏幕矩形。
 * @param rect - 世界矩形。
 * @param viewport - 当前视口。
 * @returns 屏幕矩形。
 */
export function rectToScreen(rect: Rect, viewport: Viewport): Rect {
	const origin = toScreen({ x: rect.x, y: rect.y }, viewport);
	return { x: origin.x, y: origin.y, w: rect.w * viewport.zoom, h: rect.h * viewport.zoom };
}

/** 把一个值夹到 [min, max]。 */
export function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

// ─────────────────────── 生成结果的自动落位 ───────────────────────

/** 一行最多排几个媒体节点。移植自 jaaz 的 `max_num_per_row`。 */
export const PLACEMENT_MAX_PER_ROW = 4;

/** 相邻节点之间的间距（world px）。移植自 jaaz 的 `spacing`。 */
export const PLACEMENT_SPACING = 20;

/** 参与自动排布的节点种类（jaaz 的算法只考虑媒体元素）。 */
function isMedia(node: CanvasNode): boolean {
	return node.kind === 'image' || node.kind === 'video';
}

/** 一行节点的平均 y。 */
function averageY(row: readonly CanvasNode[]): number {
	let sum = 0;
	for (const node of row) sum += node.y;
	return sum / row.length;
}

/**
 * 计算下一个生成结果应该落在哪里。
 *
 * 逐行移植 jaaz 的 `find_next_best_element_position`
 * （`server/utils/canvas.py`，常量 `max_num_per_row=4` / `spacing=20`）：
 *
 *   1. 只取媒体节点；一个都没有时落在原点
 *   2. 按 (y, x) 排序
 *   3. **按垂直重叠分行**：y 区间与某行任一成员相交则并入该行，否则新建一行
 *   4. 行按平均 y 排序，取最后一行并按 x 排序
 *   5. 末行未满 → 贴在该行最右节点右边 + spacing，y 与末行顶部对齐
 *   6. 末行已满 → 换行：x 归零，y 取末行底部 + spacing
 *
 * 与 jaaz 一致，本函数**不**消费新节点自身的尺寸 —— 尺寸只影响后续调用时
 * 该节点参与分行与"最右"判定。
 *
 * @param nodes - 当前画布上的全部节点。
 * @param size - 新节点的 world 尺寸（当前实现不参与计算，保留给未来按尺寸换行）。
 * @param options - 覆盖常量（测试与特殊画布用）。
 * @returns 新节点左上角的世界坐标。
 */
export function nextPlacement(
	nodes: readonly CanvasNode[],
	size: { w: number; h: number },
	options: { maxPerRow?: number; spacing?: number } = {},
): Point {
	void size;
	const maxPerRow = options.maxPerRow ?? PLACEMENT_MAX_PER_ROW;
	const spacing = options.spacing ?? PLACEMENT_SPACING;

	const media = nodes.filter(isMedia);
	if (media.length === 0) return { x: 0, y: 0 };

	const sorted = [...media].sort((a, b) => a.y - b.y || a.x - b.x);

	// 按垂直重叠分行：y 区间有交集即视为同一行
	const rows: CanvasNode[][] = [];
	for (const node of sorted) {
		const row = rows.find((candidate) =>
			candidate.some((member) => Math.max(node.y, member.y) < Math.min(node.y + node.h, member.y + member.h)),
		);
		if (row === undefined) rows.push([node]);
		else row.push(node);
	}

	rows.sort((a, b) => averageY(a) - averageY(b));
	const last = rows[rows.length - 1];
	// media 非空 ⇒ 至少分行出一行；这里只是把「读不到」变成显式的安全落点，
	// 而不是让 `[...undefined]` 在运行时抛错。
	if (last === undefined) return { x: 0, y: 0 };
	const lastRow = [...last].sort((a, b) => a.x - b.x);
	const rightmost = lastRow[lastRow.length - 1];
	if (rightmost === undefined) return { x: 0, y: 0 };

	if (lastRow.length < maxPerRow) {
		return {
			x: rightmost.x + rightmost.w + spacing,
			y: Math.min(...lastRow.map((node) => node.y)),
		};
	}
	return {
		x: 0,
		y: Math.max(...lastRow.map((node) => node.y + node.h)) + spacing,
	};
}

/**
 * 一次拖入**多张图**时的落位：以拖放点为锚，按「一行最多 N 个」的网格铺开。
 *
 * 为什么不复用 `nextPlacement`：那是「生成结果接着画布上已有的东西排」的算法，
 * 它的坐标以画布原点为基准 —— 而拖进来的图必须落在**用户松手的地方**。
 * 两者是两种意图，不能共用一个函数。
 *
 * 保证（见测试）：同一批内的任意两个落点互不重叠 —— 行内按前一个的宽度 + spacing
 * 推进，行高取该行最高者，换行时整行下移。尺寸不一时右侧不会压到左边
 * （间距按每个节点自身宽度累加），行高按最高的那个算（矮的下面留白，不会压）。
 * @param anchor - 第一个节点的世界坐标左上角。
 * @param sizes - 每个节点的世界尺寸（按拖入顺序）。
 * @param options - 覆盖常量（测试与特殊画布用）。
 * @returns 与 `sizes` 一一对应的左上角坐标。
 */
export function dropLayout(
	anchor: Point,
	sizes: readonly { w: number; h: number }[],
	options: { maxPerRow?: number; spacing?: number } = {},
): Point[] {
	const maxPerRow = Math.max(1, options.maxPerRow ?? PLACEMENT_MAX_PER_ROW);
	const spacing = options.spacing ?? PLACEMENT_SPACING;
	const out: Point[] = [];
	let x = anchor.x;
	let rowTop = anchor.y;
	let rowHeight = 0;
	let inRow = 0;
	for (const size of sizes) {
		if (inRow >= maxPerRow) {
			rowTop += rowHeight + spacing;
			x = anchor.x;
			rowHeight = 0;
			inRow = 0;
		}
		out.push({ x, y: rowTop });
		x += size.w + spacing;
		rowHeight = Math.max(rowHeight, size.h);
		inRow += 1;
	}
	return out;
}

// ─────────────────────── 拖动时的对齐辅助（P17） ───────────────────────

/** 吸附的容差（**屏幕**像素）。世界坐标下的容差 = 它 ÷ zoom，手感才不随缩放变化。 */
export const SNAP_TOLERANCE_PX = 6;

/** 一条对齐辅助线（世界坐标）。 */
export interface Guide {
	/** `x` = 竖线（对齐的是某一列），`y` = 横线（对齐的是某一行）。 */
	axis: 'x' | 'y';
	/** 线的位置（axis='x' 时是 x，axis='y' 时是 y）。 */
	position: number;
	/** 线沿另一轴的起点。 */
	from: number;
	/** 线沿另一轴的终点。 */
	to: number;
}

/** 一次吸附的结果。 */
export interface SnapResult {
	/** 需要补加的水平偏移（已含在拖动位移里）。 */
	dx: number;
	/** 需要补加的垂直偏移。 */
	dy: number;
	/** 要画的辅助线（最多两条：一横一竖）。 */
	guides: readonly Guide[];
}

/** 矩形在某一轴上的三条参考线：近边 / 中心 / 远边。 */
function edgesOf(rect: Rect, axis: 'x' | 'y'): readonly number[] {
	return axis === 'x'
		? [rect.x, rect.x + rect.w / 2, rect.x + rect.w]
		: [rect.y, rect.y + rect.h / 2, rect.y + rect.h];
}

/** 矩形在**另一轴**上的跨度（辅助线的长度就是它）。 */
function spanOf(rect: Rect, axis: 'x' | 'y'): readonly [number, number] {
	return axis === 'x' ? [rect.y, rect.y + rect.h] : [rect.x, rect.x + rect.w];
}

/** 浮点比较的粒度（世界坐标下 0.01px 已经远小于一个像素）。 */
const GUIDE_EPSILON = 0.01;

/**
 * 拖动时的**对齐吸附**：把移动中的矩形贴到其他矩形的边或中线上。
 *
 * 六条参考线两两比对（移动矩形的左/中/右 × 其他矩形的左/中/右，纵轴同理），
 * 取容差内偏移最小的那一对 —— 因此「对齐」永远选**最省力**的那条，而不是
 * 先遇到的那条。命中的那条线会回带一条辅助线，长度覆盖所有落在它上面的矩形
 * （这正是 Excalidraw 的手感：线从「我」连到「我对齐的那个东西」）。
 *
 * 刻意只吸附**一个轴各一条**：两个轴各选最优，互不干扰；多值对齐（等间距、
 * 分布）不在这一版里 —— 它对用户在拖动当下的帮助远小于复杂度。
 * @param moving - 移动中那组节点的世界包围盒（**未吸附**的位置）。
 * @param others - 画布上其他节点的矩形（不含正在移动的）。
 * @param tolerance - 容差（世界坐标）。
 * @returns 补加偏移与辅助线。
 */
export function snapMove(moving: Rect, others: readonly Rect[], tolerance: number): SnapResult {
	if (!(tolerance > 0)) return { dx: 0, dy: 0, guides: [] };

	/** 某一轴上最优的一次吸附。 */
	const bestOn = (axis: 'x' | 'y'): { delta: number; value: number } | null => {
		const mine = edgesOf(moving, axis);
		let found: { delta: number; value: number } | null = null;
		for (const other of others) {
			for (const line of edgesOf(other, axis)) {
				for (const edge of mine) {
					const delta = line - edge;
					if (Math.abs(delta) > tolerance) continue;
					if (found === null || Math.abs(delta) < Math.abs(found.delta)) {
						found = { delta, value: line };
					}
				}
			}
		}
		return found;
	};

	const onX = bestOn('x');
	const onY = bestOn('y');
	const dx = onX === null ? 0 : onX.delta;
	const dy = onY === null ? 0 : onY.delta;
	const snapped: Rect = { ...moving, x: moving.x + dx, y: moving.y + dy };

	/** 落在这条线上（含吸附后的自己）的矩形有多少个、跨度多大。 */
	const along = (axis: 'x' | 'y', value: number): { count: number; from: number; to: number } => {
		let count = 0;
		let from = Number.POSITIVE_INFINITY;
		let to = Number.NEGATIVE_INFINITY;
		for (const rect of [snapped, ...others]) {
			if (!edgesOf(rect, axis).some((edge) => Math.abs(edge - value) < GUIDE_EPSILON)) continue;
			const [a, b] = spanOf(rect, axis);
			from = Math.min(from, a);
			to = Math.max(to, b);
			count += 1;
		}
		return { count, from, to };
	};

	const guides: Guide[] = [];
	const push = (axis: 'x' | 'y', value: number): void => {
		const { count, from, to } = along(axis, value);
		// 只有自己一条线不算对齐：至少要有「另一个东西」也在那条线上。
		// 允许 from === to（两个等高的矩形完全对齐时线是缩成一点的），
		// 由 CSS 的 min-height/min-width 保证它仍然看得见。
		if (count >= 2) guides.push({ axis, position: value, from, to });
	};
	if (onX !== null) push('x', onX.value);
	if (onY !== null) push('y', onY.value);

	return { dx, dy, guides };
}

/** 生成一个短 id（画布内唯一即可，不追求全局唯一性）。 */
export function makeNodeId(): string {
	return `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 生成一条连线的短 id（与节点 id 同一套做法，前缀不同便于肉眼区分）。 */
export function makeLinkId(): string {
	return `l_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 由节点尺寸反推一个**化简过的**画幅比例（如 `16:9`）。
 *
 * 用途：右键菜单的「重新生成」要把原画幅一起带回去，而画布上只有宽高。
 * 取最大公约数化简，避免把 `320:180` 这种像素数当比例传回去；尺寸异常时返回
 * undefined（宁可让该参数缺省，也不要塞一个荒唐值）。
 * @param node - 含宽高的节点。
 * @returns 化简后的比例字符串；无法判定时为 undefined。
 */
export function nodeRatio(node: { w: number; h: number }): string | undefined {
	const w = Math.round(node.w);
	const h = Math.round(node.h);
	if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return undefined;
	if (w > 100000 || h > 100000) return undefined;
	/** 欧几里得算法。 */
	const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
	const g = gcd(w, h);
	return `${String(w / g)}:${String(h / g)}`;
}
