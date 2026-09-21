/**
 * 画布缩放控件（左下角浮层）。
 *
 * 步进与预设对齐 jaaz 的 `CanvasViewMenu`：
 *   − / + 每次 10 个**百分点**（100% → 110% → 120% …），不是乘法步进
 *   预设下拉：10 / 50 / 100 / 150 / 200 %
 *   适应内容：等价于 jaaz 的 `scrollToContent(fitToContent: true)`
 *
 * jaaz 未声明缩放上下界（由 Excalidraw 内部约束）；本画布显式夹在
 * 0.1x – 10x（见 model.ts 的 ZOOM_MIN / ZOOM_MAX）—— 上限就是用户要的 1000%。
 *
 * @module fatfish-canvas/client/canvas/ZoomControls
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { CheckIcon, MinusIcon, PlusIcon } from '../icons';
import { useMenuDismiss, useMenuFocus, useMenuNav } from '../menu';
import { ZOOM_MAX, ZOOM_MIN } from './model';

/** 预设缩放档位（百分比）。上限与 ZOOM_MAX 对齐。 */
const PRESETS = [10, 50, 100, 150, 200, 400, 800, 1000] as const;

/** 控件属性。 */
export interface ZoomControlsProps {
	/** 当前缩放倍率。 */
	zoom: number;
	/** 画布节点数（状态读数）。 */
	nodeCount: number;
	/** 选中节点数（状态读数）。 */
	selectedCount: number;
	/** 放大一档（+10 个百分点）。 */
	onZoomIn: () => void;
	/** 缩小一档（−10 个百分点）。 */
	onZoomOut: () => void;
	/** 直接跳到指定百分比。 */
	onZoomTo: (percent: number) => void;
	/** 回到 100%。 */
	onReset: () => void;
	/** 适应内容。 */
	onFit: () => void;
}

/**
 * 缩放控件集群。
 * @param props - 控件属性。
 * @returns 浮层元素。
 */
export function ZoomControls({
	zoom,
	nodeCount,
	selectedCount,
	onZoomIn,
	onZoomOut,
	onZoomTo,
	onReset,
	onFit,
}: ZoomControlsProps): ReactNode {
	const [menuOpen, setMenuOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement | null>(null);
	const menuRef = useRef<HTMLDivElement | null>(null);

	const close = useCallback(() => {
		setMenuOpen(false);
	}, []);

	// 键盘导航与关闭时机走公共实现（menu.ts），菜单各自只管外观
	const navIds = useMemo(() => PRESETS.map((preset) => `zoom:${String(preset)}`), []);
	const nav = useMenuNav({
		ids: navIds,
		onChoose: (id) => {
			onZoomTo(Number(id.slice(5)));
			close();
		},
		onClose: close,
	});
	useMenuFocus(menuRef, [menuOpen]);
	useMenuDismiss({ menuRef, buttonRef: rootRef, onClose: close, watchResize: false });

	const percent = Math.round(zoom * 100);
	const atMin = zoom <= ZOOM_MIN + 1e-6;
	const atMax = zoom >= ZOOM_MAX - 1e-6;

	return (
		<div className="ffc-zoombar" ref={rootRef}>
			<div className="ffc-zoombar-group">
				<button
					type="button"
					className="ffc-tbtn"
					title="缩小 10%"
					aria-label="缩小"
					disabled={atMin}
					onClick={onZoomOut}
				>
					<MinusIcon size={15} />
				</button>
				<button
					type="button"
					className="ffc-tbtn ffc-zoom-pct"
					title="选择缩放档位"
					aria-haspopup="menu"
					aria-expanded={menuOpen}
					// 视口靠这个属性认出「这是菜单的触发按钮」，不去抢它的 pointerdown
					// （否则点它 = 先被视口关掉菜单、再被自己的 onClick 打开 = 永远关不掉）
					data-ffc-menu-trigger="true"
					onClick={() => {
						setMenuOpen((prev) => !prev);
					}}
				>
					{percent}%
				</button>
				<button
					type="button"
					className="ffc-tbtn"
					title="放大 10%"
					aria-label="放大"
					disabled={atMax}
					onClick={onZoomIn}
				>
					<PlusIcon size={15} />
				</button>
			</div>

			<div className="ffc-zoombar-group">
				<button type="button" className="ffc-tbtn" title="适应内容" onClick={onFit}>
					适应内容
				</button>
				<button
					type="button"
					className="ffc-tbtn"
					title="回到 100%"
					disabled={percent === 100}
					onClick={onReset}
				>
					1:1
				</button>
			</div>

			<span className="ffc-zoombar-readout" title="节点数 / 选中数">
				{nodeCount} 节点
				{selectedCount > 0 ? ` · 选中 ${String(selectedCount)}` : ''}
			</span>

			{menuOpen ? (
				<div
					ref={menuRef}
					className="ffc-zoom-menu"
					// 画布视口靠这个属性认「这是菜单自己」（见 NodeMenu 的说明）
					data-ffc-menu="true"
					role="menu"
					aria-label="缩放档位"
					tabIndex={-1}
					onKeyDown={nav.onKeyDown}
					{...nav.containerProps}
				>
					{PRESETS.map((preset) => (
						<button
							key={preset}
							type="button"
							role="menuitemradio"
							aria-checked={percent === preset}
							className="ffc-menu-item"
							data-active={percent === preset ? 'true' : undefined}
							onClick={() => {
								onZoomTo(preset);
								close();
							}}
							{...nav.itemProps(`zoom:${String(preset)}`)}
						>
							<span className="ffc-menu-check">
								{percent === preset ? <CheckIcon size={13} /> : null}
							</span>
							<span>{preset}%</span>
						</button>
					))}
				</div>
			) : null}
		</div>
	);
}
