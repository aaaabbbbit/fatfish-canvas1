/**
 * 连接点的几何 —— 纯函数，无 React、无 DOM。
 *
 * 连接点只有一个：节点**四条边的中点**各一个，进出合一。因此这里只需要
 * 「边 → 点」的换算，以及「连线该画成什么形状」。
 *
 * 为什么线的方向由 `PortSide` 决定而不是「离得最近的那两条边」：
 * 用户是从**某个具体的点**拉出来的，线就必须从那个点出发 —— 否则会出现
 * 「从上面那个点拉出来、线却从左边冒出来」的错位。两个端点各自带着自己
 * 那一侧的外法线，控制点沿法线外推，线就会自然地从各自的面「长出去」。
 *
 * @module fatfish-canvas/client/canvas/ports
 */

import type { Point, PortSide, Rect } from './model';

/** 四条边的顺序（渲染与命中判定都用它，保证确定性）。 */
export const PORT_SIDES: readonly PortSide[] = ['n', 'e', 's', 'w'];

/**
 * 某条边的中点（世界坐标）。
 * @param rect - 节点的世界矩形。
 * @param side - 哪条边。
 * @returns 连接点位置。
 */
export function portPoint(rect: Rect, side: PortSide): Point {
	switch (side) {
		case 'n':
			return { x: rect.x + rect.w / 2, y: rect.y };
		case 's':
			return { x: rect.x + rect.w / 2, y: rect.y + rect.h };
		case 'w':
			return { x: rect.x, y: rect.y + rect.h / 2 };
		case 'e':
			return { x: rect.x + rect.w, y: rect.y + rect.h / 2 };
	}
}

/**
 * 某条边的**外法线**（单位向量，世界坐标）。
 * @param side - 哪条边。
 * @returns 朝外的方向。
 */
export function portNormal(side: PortSide): Point {
	switch (side) {
		case 'n':
			return { x: 0, y: -1 };
		case 's':
			return { x: 0, y: 1 };
		case 'w':
			return { x: -1, y: 0 };
		case 'e':
			return { x: 1, y: 0 };
	}
}

/**
 * 离给定点最近的那条边（落点判定用）。
 *
 * 拖连线时松手不要求精确命中某个连接点 —— 落在节点上就取离指针最近的那个，
 * 这是「拖过去就成」的手感；平手时按 `PORT_SIDES` 的顺序取，结果确定。
 * @param rect - 目标节点的世界矩形。
 * @param point - 世界坐标点。
 * @returns 最近的那条边。
 */
export function nearestPort(rect: Rect, point: Point): PortSide {
	let best: PortSide = 'n';
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const side of PORT_SIDES) {
		const at = portPoint(rect, side);
		const distance = Math.hypot(at.x - point.x, at.y - point.y);
		if (distance < bestDistance) {
			bestDistance = distance;
			best = side;
		}
	}
	return best;
}

/** 控制点外推的距离上下限（世界坐标）—— 太短会贴着节点，太长会甩成一个大圈。 */
const BEND_MIN = 32;
const BEND_MAX = 180;

/**
 * 一条连线的 SVG 路径（世界坐标）。
 *
 * 三次贝塞尔：两个控制点各自沿所属边的外法线外推，外推距离随两端距离增长
 * （有上下限）。这是主流节点编辑器的画法，好处是无论两个节点怎么摆，
 * 线都是从「面」上长出去的，不会斜穿自己的卡片。
 * @param from - 起点（世界坐标）。
 * @param fromSide - 起点在哪条边。
 * @param to - 终点（世界坐标）。
 * @param toSide - 终点在哪条边。
 * @returns `d` 属性字符串。
 */
export function linkPath(from: Point, fromSide: PortSide, to: Point, toSide: PortSide): string {
	const bend = Math.min(BEND_MAX, Math.max(BEND_MIN, Math.hypot(to.x - from.x, to.y - from.y) * 0.45));
	const a = portNormal(fromSide);
	const b = portNormal(toSide);
	const c1 = { x: from.x + a.x * bend, y: from.y + a.y * bend };
	const c2 = { x: to.x + b.x * bend, y: to.y + b.y * bend };
	/** 两位小数够了（世界坐标的一像素以下），字符串稳定，便于测试断言。 */
	const n = (value: number): string => String(Math.round(value * 100) / 100);
	return `M ${n(from.x)} ${n(from.y)} C ${n(c1.x)} ${n(c1.y)} ${n(c2.x)} ${n(c2.y)} ${n(to.x)} ${n(to.y)}`;
}

/**
 * 一条连线在屏幕上的中点（放删除按钮用）。
 *
 * 取**直线**中点而不是贝塞尔的中点：两者最多差几个像素，而直线中点不需要
 * 求曲线的参数方程，少一段容易写错的数学。
 * @param from - 起点（世界坐标）。
 * @param to - 终点（世界坐标）。
 * @returns 中点。
 */
export function linkMidpoint(from: Point, to: Point): Point {
	return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
}
