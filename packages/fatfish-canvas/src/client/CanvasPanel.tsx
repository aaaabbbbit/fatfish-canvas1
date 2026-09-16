/**
 * 左侧画布面板（`shell.overlay` 条目）。
 *
 * `position: fixed` 覆盖视口左侧，宽度由 `--ffc-canvas-width` 决定；
 * 右侧余下区域交给被 CSS 收窄后的 AppFrame —— 也就是本体原生聊天，
 * 因此这里**不复制**任何聊天 UI。
 *
 * P4 把工具条做成了真正有用的一组动词（此前只有「清空 / 重置宽度」两个开关）：
 *
 *   选择   全选 · 删除选中（带选中数读数）
 *   视图   适应内容（与左下角缩放条走同一份实现，见 canvas/actions.ts）
 *   跟焦   新节点自动带进视野的开关（偏好持久化）
 *   面板   清空画布 · 重置宽度 · 宽度读数
 *   模式   纯画布开关（P10：从「视图」菜单里独立出来，单独一格）
 *   作用域 顶栏那枚「共用画布 / 本会话画布」读数**本身就是开关**（P10，
 *          原来这项在「视图」菜单里）—— 读数与开关是同一件事的两面。
 *
 * 标题旁两个读数回答「我现在看的是哪块画布、上面有什么」：节点/选中数，
 * 以及**作用域**（共用一块 / 本会话画布，P7）。后者很重要 ——
 * 按会话隔离打开后，画布内容会随会话切换而变化，不写明白就成了灵异事件。
 *
 * 所有按钮都带 `title` 与 `aria-label`，并且**都在 `.ffc-toolbar` 里带
 * `data-ffc-ui`** —— 画布视口靠这个属性判断「这个指针事件是给控件的」，
 * 不会把它当成拖拽起点（见 CanvasStage 的第一道闸）。
 *
 * @module fatfish-canvas/client/CanvasPanel
 */

import { useCallback, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { ExpandIcon, FitIcon, RiceBowlIcon, SelectAllIcon, TargetIcon, TrashIcon } from './icons';
import { CanvasStage } from './canvas/CanvasStage';
import { fitAll } from './canvas/actions';
import { useBoardScope } from './canvas/scope';
import { clearBoard, removeNodes, setSelection, useBoard } from './canvas/store';
import {
	CANVAS_MAX,
	CANVAS_MIN,
	resetWidth,
	setMode,
	setWidth,
	toggleBoardScopeMode,
	toggleFollowNewNodes,
	useCanvasWidth,
	useFollowNewNodes,
	useViewMode,
} from './state';

/** 右侧至少要留给聊天的最小宽度（px）。 */
const CHAT_MIN = 420;

/**
 * 画布面板。
 * @returns overlay 条目；聊天模式下渲染 null。
 */
export function CanvasPanel(): ReactNode {
	const mode = useViewMode();
	const width = useCanvasWidth();
	const follow = useFollowNewNodes();
	const board = useBoard();
	const scope = useBoardScope();
	const [dragging, setDragging] = useState(false);
	const widthRef = useRef(width);
	widthRef.current = width;

	/** 纯画布模式下右缘拖拽没有意义（画布已经铺满），因此禁用。 */
	const resizable = mode === 'canvas';

	const onResizeStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		setDragging(true);
	}, []);

	const onResizeMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
		if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
		const upper = Math.max(CANVAS_MIN, Math.min(CANVAS_MAX, window.innerWidth - CHAT_MIN));
		const next = Math.max(CANVAS_MIN, Math.min(upper, Math.round(event.clientX)));
		setWidth(`${String(next)}px`);
	}, []);

	const onResizeEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
		if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
		event.currentTarget.releasePointerCapture(event.pointerId);
		setDragging(false);
	}, []);

	const selectedCount = board.selection.length;
	const nodeCount = board.nodes.length;

	// 钩子必须无条件调用，因此把早退放在最后。
	if (mode === 'chat') return null;

	return (
		<div className="ffc-panel" role="region" aria-label="肥鱼画布">
			<div className="ffc-toolbar" data-ffc-ui="toolbar">
				<span className="ffc-toolbar-brand">
					<RiceBowlIcon size={17} />
				</span>
				{/* 标题可以在窄画布下被截断（CSS 里 min-width:0 + 省略号），
				    按钮一律 flex:none —— 宁可少显示两个字，也不能把控件挤变形 */}
				<span className="ffc-title">肥鱼画布</span>
				<span className="ffc-badge" title="画布上的节点数 / 选中数">
					{nodeCount} 节点{selectedCount > 0 ? ` · 选中 ${String(selectedCount)}` : ''}
				</span>
				{/* 作用域读数兼开关（P10：原来在「视图」菜单里。
				    做成按钮而不是再找一个地方放开关：读数本来就写着「当前在看哪块画布」，
				    点它切换是同一件事的两面，也不占额外宽度。） */}
				<button
					type="button"
					className="ffc-badge ffc-badge-btn"
					data-ffc-scope={scope.scope === null ? 'shared' : 'session'}
					aria-pressed={scope.mode === 'session'}
					title={
						scope.mode === 'session'
							? '画布按会话隔离：当前已开启（点击改为所有会话共用一块）'
							: '画布按会话隔离：当前共用一块（点击改为每个会话各自一块）'
					}
					onClick={() => {
						toggleBoardScopeMode();
					}}
				>
					{scope.scope === null ? '共用画布' : '本会话画布'}
				</button>

				{/* 生成模型选择**不在这里**（P17 第二版）：它搬去了 composer 工具行，
				    紧挨着本体那个「对话模型」—— 两者是同一类东西，用户的眼睛在输入框那一行。
				    见 index.tsx 的 conversation.input.right 注册与 settings/ModelPicker.tsx。 */}

				<span className="ffc-spacer" />

				{/* ── 选择 ── */}
				<button
					type="button"
					className="ffc-tbtn"
					title="全选（Ctrl/⌘ + A）"
					aria-label="全选节点"
					disabled={nodeCount === 0}
					onClick={() => {
						setSelection(board.nodes.map((node) => node.id));
					}}
				>
					<SelectAllIcon size={15} />
				</button>
				<button
					type="button"
					className="ffc-tbtn"
					title="删除选中（Delete）"
					aria-label="删除选中节点"
					disabled={selectedCount === 0}
					onClick={() => {
						removeNodes(board.selection);
					}}
				>
					<TrashIcon size={15} />
				</button>

				{/* ── 视图 ── */}
				<button
					type="button"
					className="ffc-tbtn"
					title="适应内容（把所有节点纳入视野）"
					aria-label="适应内容"
					disabled={nodeCount === 0}
					onClick={() => {
						fitAll();
					}}
				>
					<FitIcon size={15} />
				</button>
				<button
					type="button"
					className="ffc-tbtn"
					data-active={follow ? 'true' : undefined}
					title={
						follow
							? '新节点自动带进视野：已开启（点击关闭）'
							: '新节点自动带进视野：已关闭（点击开启）'
					}
					aria-label="新节点自动带进视野"
					aria-pressed={follow}
					onClick={() => {
						toggleFollowNewNodes();
					}}
				>
					<TargetIcon size={15} />
				</button>

				<span className="ffc-toolbar-sep" aria-hidden="true" />

				{/* ── 面板 ── */}
				<button
					type="button"
					className="ffc-tbtn"
					title="清空画布上的全部节点（不影响生成记录）"
					aria-label="清空画布"
					onClick={clearBoard}
				>
					清空
				</button>
				{resizable ? (
					<button
						type="button"
						className="ffc-tbtn"
						title="画布宽度重置为默认（62%）"
						aria-label="重置画布宽度"
						onClick={resetWidth}
					>
						重置宽度
					</button>
				) : null}
				{/* 宽度读数只在并排模式下有意义：纯画布时画布已铺满，
				    再说一个宽度是噪音（而且顶栏右边那个「纯画布」按钮已经说明了状态） */}
				{resizable ? (
					<span
						className="ffc-badge"
						style={{ fontVariantNumeric: 'tabular-nums' }}
						title="当前画布宽度"
					>
						{width}
					</span>
				) : null}

				{/* ── 纯画布模式（P10：从「视图」菜单里独立出来，单独放在顶栏） ──
				    它是纯画布模式下**唯一**能点的出口（那种模式没有聊天列，也就没有
				    右上角的米饭碗），所以必须常驻顶栏、且状态可读（aria-pressed）。 */}
				<button
					type="button"
					className="ffc-tbtn"
					data-active={mode === 'canvas-only' ? 'true' : undefined}
					title={
						mode === 'canvas-only'
							? '退出纯画布（回到并排画布，聊天列重新出现）'
							: '纯画布模式（画布铺满，聊天列收起）'
					}
					aria-label="纯画布模式"
					aria-pressed={mode === 'canvas-only'}
					onClick={() => {
						setMode(mode === 'canvas-only' ? 'canvas' : 'canvas-only');
					}}
				>
					<ExpandIcon size={15} />
					纯画布
				</button>
			</div>

			<CanvasStage />

			{resizable ? (
				<div
					className="ffc-resizer"
					role="separator"
					aria-orientation="vertical"
					aria-label="调整画布宽度"
					data-ffc-ui="resizer"
					data-dragging={dragging ? 'true' : undefined}
					onPointerDown={onResizeStart}
					onPointerMove={onResizeMove}
					onPointerUp={onResizeEnd}
					onDoubleClick={resetWidth}
				/>
			) : null}
		</div>
	);
}
