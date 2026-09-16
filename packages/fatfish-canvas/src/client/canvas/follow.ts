/**
 * 新节点自动跟焦（P4）。
 *
 * 生成结果落到画布上时，用户通常正盯着聊天在读结果 —— 如果那个节点落在
 * 视野之外，画布看起来「什么都没发生」。跟焦就是把这个新节点带进视野。
 *
 * 但自动移动视口是**有代价**的：如果用户正在平移/缩放、或在拖动节点，
 * 抢走视口会让人非常恼火。因此策略是三条闸：
 *
 *   1. `enabled` —— 用户可以在菜单里关掉（偏好持久化）；
 *   2. `busy` —— 正在拖拽 / 框选时绝不抢；
 *   3. 安静期 —— 用户最后一次操作视口之后 `QUIET_MS` 内不抢，排队重试；
 *      超过 `RETRY_MS` 还没安静下来就放弃（宁可不动，也不要跟用户拉扯）。
 *
 * 几何部分是纯函数（`planFocus`），策略部分也是纯函数（`decideFollow`），
 * 只有「排队」这一小块带状态 —— 因此这条最容易出错的逻辑可以完全离线单测。
 *
 * @module fatfish-canvas/client/canvas/follow
 */

import { boundsOf, clampZoom, fitRect, toScreen, type CanvasNode, type Viewport } from './model';

/** 跟焦时四周留的空白（屏幕像素）。 */
export const FOLLOW_PADDING = 64;

/** 用户最后一次操作视口之后，这么久内不抢视口（毫秒）。 */
export const FOLLOW_QUIET_MS = 700;

/** 排队重试的总时长上限：超过就放弃（毫秒）。 */
export const FOLLOW_RETRY_MS = 1500;

/** 排队重试的间隔（毫秒）。 */
export const FOLLOW_RETRY_STEP_MS = 200;

/** 跟焦结果。 */
export interface FocusPlan {
	/** 目标视口（no-op 时等于传入的视口）。 */
	viewport: Viewport;
	/** 是否真的需要移动。 */
	moved: boolean;
	/** 判定原因（测试与诊断用）。 */
	reason: 'empty' | 'no-size' | 'visible' | 'centered' | 'fitted';
}

/**
 * 判断世界矩形是否完整落在视口内（含留白）。
 * @param rect - 世界矩形。
 * @param viewport - 当前视口。
 * @param size - 视口屏幕尺寸。
 * @param padding - 留白（屏幕像素）。
 * @returns 是否完整可见。
 */
function isVisible(
	rect: { x: number; y: number; w: number; h: number },
	viewport: Viewport,
	size: { w: number; h: number },
	padding: number,
): boolean {
	const tl = toScreen({ x: rect.x, y: rect.y }, viewport);
	const br = toScreen({ x: rect.x + rect.w, y: rect.y + rect.h }, viewport);
	return (
		tl.x >= padding - 1 &&
		tl.y >= padding - 1 &&
		br.x <= size.w - padding + 1 &&
		br.y <= size.h - padding + 1
	);
}

/**
 * 计算把一组节点带进视野所需的视口。
 *
 * 三条规则：
 *   - 已经完整可见 → 原样返回（**绝不因为「刚刚好」而重新居中**，
 *     否则用户每生成一张图，画面都会无谓地抖一下）；
 *   - 当前缩放下能容下 → 保持缩放，只平移到居中；
 *   - 容不下 → 缩小到能容下（`fitRect`，已夹在 ZOOM_MIN/ZOOM_MAX 内）。
 * @param nodes - 要带进视野的节点。
 * @param viewport - 当前视口。
 * @param size - 视口屏幕尺寸。
 * @param options - 留白覆盖。
 * @returns 目标视口与判定原因。
 */
export function planFocus(
	nodes: readonly CanvasNode[],
	viewport: Viewport,
	size: { w: number; h: number },
	options: { padding?: number } = {},
): FocusPlan {
	if (nodes.length === 0) return { viewport, moved: false, reason: 'empty' };
	if (!(size.w > 0) || !(size.h > 0)) return { viewport, moved: false, reason: 'no-size' };

	const padding = options.padding ?? FOLLOW_PADDING;
	const rect = boundsOf(nodes);
	if (rect === null) return { viewport, moved: false, reason: 'empty' };

	if (isVisible(rect, viewport, size, padding)) {
		return { viewport, moved: false, reason: 'visible' };
	}

	// 当前缩放下能容下（含留白）→ 只平移
	const availW = size.w - padding * 2;
	const availH = size.h - padding * 2;
	const fits = rect.w * viewport.zoom <= availW && rect.h * viewport.zoom <= availH;
	if (fits) {
		const cx = rect.x + rect.w / 2;
		const cy = rect.y + rect.h / 2;
		return {
			viewport: {
				x: cx - size.w / (2 * viewport.zoom),
				y: cy - size.h / (2 * viewport.zoom),
				zoom: viewport.zoom,
			},
			moved: true,
			reason: 'centered',
		};
	}

	const fitted = fitRect(rect, size, padding);
	return { viewport: { ...fitted, zoom: clampZoom(fitted.zoom) }, moved: true, reason: 'fitted' };
}

/** 跟焦动作判定。 */
export type FollowAction = 'apply' | 'queue' | 'skip';

/**
 * 判定此刻该不该动视口。
 * @param input - 开关、忙碌状态、距上次用户操作的时间、已排队时长。
 * @returns `apply` 立即执行；`queue` 稍后重试；`skip` 放弃这次。
 */
export function decideFollow(input: {
	enabled: boolean;
	busy: boolean;
	sinceUserMs: number;
	queuedMs: number;
	quietMs?: number;
	retryMs?: number;
}): FollowAction {
	if (!input.enabled) return 'skip';
	if (input.busy) {
		return input.queuedMs >= (input.retryMs ?? FOLLOW_RETRY_MS) ? 'skip' : 'queue';
	}
	if (input.sinceUserMs < (input.quietMs ?? FOLLOW_QUIET_MS)) {
		return input.queuedMs >= (input.retryMs ?? FOLLOW_RETRY_MS) ? 'skip' : 'queue';
	}
	return 'apply';
}

// ─────────────────────── 待跟焦队列 ───────────────────────
//
// 画布可能根本没挂载（聊天模式、或纯画布模式还没进来）。节点这时落下也应该
// 被记住：等画布下次挂载时再消费一次，而不是让用户切过去看到「什么都没发生」。

/** 待跟焦的节点 id 与它们最早一次入队的时间。 */
let pending: { ids: string[]; at: number } | null = null;

/**
 * 把节点加入待跟焦队列（并集语义）。
 * @param ids - 新增节点 id。
 * @param at - 入队时间（默认现在）。
 */
export function queueFocus(ids: readonly string[], at: number = Date.now()): void {
	if (ids.length === 0) return;
	if (pending === null) {
		pending = { ids: [...new Set(ids)], at };
		return;
	}
	pending = { ids: [...new Set([...pending.ids, ...ids])], at: pending.at };
}

/** 取当前待跟焦队列（不移除）。 */
export function peekFocus(): { ids: readonly string[]; at: number } | null {
	return pending;
}

/** 清空待跟焦队列（已消费或已放弃）。 */
export function clearFocus(): void {
	pending = null;
}

/** 队列是否为空（测试用）。 */
export function hasPendingFocus(): boolean {
	return pending !== null;
}
