/**
 * 连线层（P18）—— 世界层里的一张 SVG 加一组删除按钮。
 *
 * 为什么画在世界层而不是屏幕层：连线的两个端点就是两个节点的边中点，
 * 世界层里它们天然跟着节点走（拖节点、跟焦、适应内容都不需要任何额外同步）；
 * 线宽用 `vector-effect: non-scaling-stroke` 保持屏幕上的 1.5px，缩放不会把它拉粗。
 *
 * 每个连接点（`NodeCard` 里的 `.ffc-port`）的可见性**完全由 CSS 决定**，
 * 这一层不参与 hover 判定；这里只负责：
 *
 *   1. 已建立的连线（一条可见的 + 一条 14px 宽的透明命中路径）
 *   2. 正在拉的那条虚线
 *   3. 每条连线中点的删除按钮（**常驻**，理由见 styles.ts 里那一段 —— 
 *      「悬停才出现」那一版会让按钮自己把指针从命中路径上抢走，来回抖、点不到）
 *
 * @module fatfish-canvas/client/canvas/LinkLayer
 */

import type { ReactNode } from 'react';
import type { CanvasLink, CanvasNode, Point, PortSide } from './model';
import { linkMidpoint, linkPath, portPoint } from './ports';

/** 正在拉的一条连线。 */
export interface LinkDraft {
	/** 起点节点 id。 */
	fromId: string;
	/** 起点在哪条边。 */
	fromSide: PortSide;
	/** 指针当前的世界坐标。 */
	to: Point;
}

/** 连线层属性。 */
export interface LinkLayerProps {
	/** 节点表（找端点用）。 */
	nodes: readonly CanvasNode[];
	/** 连线表。 */
	links: readonly CanvasLink[];
	/** 正在拉的那条（没有时为 null）。 */
	draft: LinkDraft | null;
	/** 当前缩放（删除按钮要反向缩放，屏幕尺寸才恒定）。 */
	zoom: number;
	/** 删除一条连线。 */
	onRemove: (id: string) => void;
}

/** 反向的那条边（拉虚线时给自由端一个朝向，曲线才顺）。 */
const OPPOSITE: Record<PortSide, PortSide> = { n: 's', s: 'n', e: 'w', w: 'e' };

/**
 * 连线层。
 * @param props - 节点表、连线表、草稿与回调。
 * @returns SVG + 删除按钮。
 */
export function LinkLayer({ nodes, links, draft, zoom, onRemove }: LinkLayerProps): ReactNode {
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const inverse = Number.isFinite(zoom) && zoom > 0 ? 1 / zoom : 1;

	/** 一条连线的两个端点（世界坐标）。 */
	const endsOf = (link: CanvasLink): { a: Point; b: Point } | null => {
		const from = byId.get(link.from);
		const to = byId.get(link.to);
		if (from === undefined || to === undefined) return null;
		return { a: portPoint(from, link.fromSide), b: portPoint(to, link.toSide) };
	};

	const draftFrom = draft === null ? null : byId.get(draft.fromId);
	const draftPath =
		draft === null || draftFrom === null || draftFrom === undefined
			? null
			: linkPath(
					portPoint(draftFrom, draft.fromSide),
					draft.fromSide,
					draft.to,
					OPPOSITE[draft.fromSide],
				);

	return (
		<>
			{/* 1×1 的 SVG + overflow:visible：内容用世界坐标绝对定位，不需要给它开画布尺寸 */}
			<svg className="ffc-links" width="1" height="1" aria-hidden="true">
				{links.map((link) => {
					const ends = endsOf(link);
					if (ends === null) return null;
					const d = linkPath(ends.a, link.fromSide, ends.b, link.toSide);
					return (
						<g key={link.id}>
							<path className="ffc-link" d={d} />
							{/* 命中路径：看不见但 14px 宽（线的光标落点 + 「这条线是个控件、
							    不算空白」的判据）。`data-ffc-link` 让画布视口把它认成控件、
							    不当拖拽起点。 */}
							<path className="ffc-link-hit" d={d} data-ffc-link={link.id} />
						</g>
					);
				})}
				{draftPath === null ? null : <path className="ffc-link ffc-link-draft" d={draftPath} />}
			</svg>

			{links.map((link) => {
				const ends = endsOf(link);
				if (ends === null) return null;
				const mid = linkMidpoint(ends.a, ends.b);
				return (
					<button
						key={link.id}
						type="button"
						className="ffc-link-x"
						data-ffc-ui="link-remove"
						title="删除这条连线"
						aria-label="删除连线"
						style={{
							left: `${String(mid.x)}px`,
							top: `${String(mid.y)}px`,
							transform: `scale(${String(inverse)})`,
						}}
						onPointerDown={(event) => {
							event.stopPropagation();
						}}
						onClick={(event) => {
							event.stopPropagation();
							onRemove(link.id);
						}}
					>
						×
					</button>
				);
			})}
		</>
	);
}
