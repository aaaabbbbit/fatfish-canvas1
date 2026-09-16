/**
 * 画布的「视图动作」—— 谁都能调的那几个动词（P4）。
 *
 * 为什么不让工具条直接改视口：视口动作需要**视口元素的实测尺寸**（按钮缩放的
 * 锚点是视口中心、适应内容是 fitRect 的容器），而那个尺寸只有画布组件知道。
 * 于是这里用一个极小的模块级注册表把尺寸与应用动作集中起来：
 *
 *   - CanvasStage 挂载/尺寸变化时调用 `reportViewportSize()`
 *   - 工具条、菜单、快捷键调用 `fitAll()` / `zoomToPercent()` / `focusNodes()`
 *
 * 这样「工具条按钮」与「画布内部动作」永远走同一份实现，不会出现两处算法漂移
 * （例如工具条自己算一遍 fitRect，锚点或留白与画布不一致）。
 *
 * `focusNodes` 还会通知订阅者「这次是程序化移动」，画布据此挂一小段过渡动画 ——
 * 用户自己拖拽时**不能**有动画（会跟手），程序化跳转时**应该**有（否则画面瞬移）。
 *
 * @module fatfish-canvas/client/canvas/actions
 */

import { planFocus } from './follow';
import { boundsOf, clampZoom, fitRect, zoomAround, type CanvasNode, type Viewport } from './model';
import { getBoard, setViewport } from './store';

/** 程序化移动的原因（订阅者据此决定要不要动画）。 */
export type ViewportActionReason = 'fit' | 'zoom' | 'focus';

/** 视口实测尺寸（由画布组件上报）。 */
let viewSize = { w: 0, h: 0 };

/** 程序化移动的订阅者。 */
const listeners = new Set<(reason: ViewportActionReason) => void>();

/**
 * 上报视口元素的实测尺寸。
 * @param size - 屏幕尺寸（CSS 像素）。
 */
export function reportViewportSize(size: { w: number; h: number }): void {
	viewSize = size;
}

/** 当前视口尺寸（未挂载时为 0×0）。 */
export function getViewportSize(): { w: number; h: number } {
	return viewSize;
}

/**
 * 订阅程序化视口移动。
 * @param fn - 收到动作原因。
 * @returns 取消订阅。
 */
export function subscribeViewportActions(fn: (reason: ViewportActionReason) => void): () => void {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
}

/**
 * 应用一个新视口并广播原因。
 * @param viewport - 目标视口。
 * @param reason - 动作原因。
 */
function applyViewport(viewport: Viewport, reason: ViewportActionReason): void {
	setViewport(viewport);
	for (const fn of listeners) fn(reason);
}

/** 视口是否已有实测尺寸（没有就什么都做不了）。 */
function sized(): boolean {
	return viewSize.w > 0 && viewSize.h > 0;
}

/**
 * 适应内容：把所有节点纳入视野；空画布回到原点附近。
 * @returns 是否真的执行了（画布没挂载时为 false）。
 */
export function fitAll(): boolean {
	if (!sized()) return false;
	const bounds = boundsOf(getBoard().nodes);
	if (bounds === null) {
		applyViewport({ x: -viewSize.w / 2, y: -viewSize.h / 2, zoom: 1 }, 'fit');
		return true;
	}
	applyViewport(fitRect(bounds, viewSize, 48), 'fit');
	return true;
}

/**
 * 缩放到指定百分比（以视口中心为锚点）。
 * @param percent - 目标百分比（100 = 1x）。
 * @returns 是否真的执行了。
 */
export function zoomToPercent(percent: number): boolean {
	if (!sized()) return false;
	const anchor = { x: viewSize.w / 2, y: viewSize.h / 2 };
	const current = getBoard().viewport;
	const next = zoomAround(current, anchor, percent / 100);
	if (next === current) return false;
	applyViewport({ ...next, zoom: clampZoom(next.zoom) }, 'zoom');
	return true;
}

/**
 * 按百分点步进缩放（jaaz 的 ±10 个百分点）。
 * @param delta - 百分点增量（0.1 = +10%）。
 * @returns 是否真的执行了。
 */
export function zoomByPoints(delta: number): boolean {
	const current = getBoard().viewport;
	return zoomToPercent((current.zoom + delta) * 100);
}

/**
 * 把指定节点带进视野（自动跟焦与「定位选中」共用）。
 * @param ids - 目标节点 id。
 * @param options - `padding` 覆盖与 `force`（即使当前已可见也重新居中）。
 * @returns 是否真的移动了视口。
 */
export function focusNodes(
	ids: readonly string[],
	options: { padding?: number; force?: boolean } = {},
): boolean {
	if (!sized() || ids.length === 0) return false;
	const wanted = new Set(ids);
	const nodes: CanvasNode[] = getBoard().nodes.filter((node) => wanted.has(node.id));
	if (nodes.length === 0) return false;
	const plan = planFocus(nodes, getBoard().viewport, viewSize, options);
	if (!plan.moved && options.force !== true) return false;
	applyViewport(plan.viewport, 'focus');
	return true;
}
