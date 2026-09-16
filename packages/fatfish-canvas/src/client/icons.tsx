/**
 * 肥鱼画布图标。
 *
 * DSH 的 primitives 里没有「图像 / 画布 / 米饭」这类图标（已核实其 116 个导出），
 * 因此这里自绘内联 SVG。图标一律用 `currentColor`，跟随宿主主题与 hover 态；
 * 需要「挖空」的地方用 `--ffc-grain`（由使用处设成自身底色），保证浅深主题都成立。
 *
 * @module fatfish-canvas/client/icons
 */

import type { ReactNode } from 'react';

/** 图标公共属性。 */
export interface IconProps {
	/** 边长（px），默认 20。 */
	size?: number;
	/** 额外类名。 */
	className?: string;
}

/**
 * 极简白米饭碗 —— 视图切换按钮的标志。
 *
 * 结构（三笔，全部 24×24 网格）：
 *   1. 米饭：高出碗沿的实心圆顶（`a` 半圆，sweep=1 向上鼓）
 *   2. 米粒纹理：三道短竖笔，用 `--ffc-grain` 挖出米粒分界
 *   3. 碗身：碗沿到碗底的收口曲线，描边 + 极淡填充
 * 顺序刻意是「先饭、后碗」，让碗沿压在米饭根部 —— 侧面视角下这才读作
 * 「碗里盛满了饭」，而不是饭浮在碗上面。
 * @param props - 图标属性。
 * @returns 内联 SVG。
 */
export function RiceBowlIcon({ size = 20, className }: IconProps): ReactNode {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			className={className}
			aria-hidden="true"
			focusable="false"
		>
			{/* 1. 米饭：以碗沿为底、向上鼓出的半圆顶 */}
			<path d="M6.3 12.6a5.7 5.7 0 0 1 11.4 0Z" fill="currentColor" fillOpacity="0.9" />
			{/* 2. 米粒纹理 */}
			<path
				d="M9.4 9.9v1.5M12 9.2v2.2M14.6 9.9v1.5"
				stroke="var(--ffc-grain, #ffffff)"
				strokeWidth="1.1"
				strokeLinecap="round"
			/>
			{/* 3. 碗身：碗沿 → 碗底 → 碗沿，收口曲线 */}
			<path
				d="M3.3 12.6C3.9 18 7.4 21.2 12 21.2s8.1-3.2 8.7-8.6Z"
				fill="currentColor"
				fillOpacity="0.14"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

/** 勾选标记（菜单当前项）。 */
export function CheckIcon({ size = 14, className }: IconProps): ReactNode {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none"
			className={className}
			aria-hidden="true"
			focusable="false"
		>
			<path
				d="M3.5 8.5 6.5 11.5 12.5 4.5"
				stroke="currentColor"
				strokeWidth="1.8"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

/** 聊天气泡（菜单项）。 */
export function ChatIcon({ size = 16, className }: IconProps): ReactNode {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none"
			className={className}
			aria-hidden="true"
			focusable="false"
		>
			<path
				d="M2.2 7.2c0-2.6 2.1-4.7 4.7-4.7h2.2c2.6 0 4.7 2.1 4.7 4.7s-2.1 4.7-4.7 4.7H6.6l-3 2.3c-.5.4-1.3 0-1.3-.7V7.2Z"
				stroke="currentColor"
				strokeWidth="1.4"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

/** 缩小 / 放大（画布缩放控件）。 */
export function MinusIcon({ size = 16, className }: IconProps): ReactNode {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none"
			className={className}
			aria-hidden="true"
			focusable="false"
		>
			<path d="M3.5 8h9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
		</svg>
	);
}

/** 放大镜心：加号。 */
export function PlusIcon({ size = 16, className }: IconProps): ReactNode {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none"
			className={className}
			aria-hidden="true"
			focusable="false"
		>
			<path
				d="M8 3.5v9M3.5 8h9"
				stroke="currentColor"
				strokeWidth="1.7"
				strokeLinecap="round"
			/>
		</svg>
	);
}

/** 全选：虚线框 + 四个角上的选中点。 */
export function SelectAllIcon({ size = 16, className }: IconProps): ReactNode {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none"
			className={className}
			aria-hidden="true"
			focusable="false"
		>
			<rect
				x="2.6"
				y="2.6"
				width="10.8"
				height="10.8"
				rx="1.6"
				stroke="currentColor"
				strokeWidth="1.4"
				strokeDasharray="2.4 2"
			/>
			<path
				d="M5.6 8.2 7.4 10l3.2-3.4"
				stroke="currentColor"
				strokeWidth="1.6"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

/** 删除：垃圾桶。 */
export function TrashIcon({ size = 16, className }: IconProps): ReactNode {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none"
			className={className}
			aria-hidden="true"
			focusable="false"
		>
			<path
				d="M3.2 4.6h9.6M6.6 4.6V3.4c0-.5.4-.9.9-.9h1c.5 0 .9.4.9.9v1.2M4.6 4.6l.6 7.6c0 .6.5 1 1.1 1h3.4c.6 0 1.1-.4 1.1-1l.6-7.6"
				stroke="currentColor"
				strokeWidth="1.3"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

/** 生成模型：一大一小两颗星光（「画点什么」的那一格）。 */
export function ModelIcon({ size = 16, className }: IconProps): ReactNode {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none"
			className={className}
			aria-hidden="true"
			focusable="false"
		>
			<path
				d="M6.4 2.2 7.5 5l2.8 1.1L7.5 7.2 6.4 10 5.3 7.2 2.5 6.1 5.3 5z"
				stroke="currentColor"
				strokeWidth="1.3"
				strokeLinejoin="round"
			/>
			<path
				d="M11.6 9.4l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"
				fill="currentColor"
				fillOpacity="0.85"
			/>
		</svg>
	);
}

/** 适应内容：四角向内的取景框。 */
export function FitIcon({ size = 16, className }: IconProps): ReactNode {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none"
			className={className}
			aria-hidden="true"
			focusable="false"
		>
			<path
				d="M2.6 6V3.4c0-.4.4-.8.8-.8H6M10 2.6h2.6c.4 0 .8.4.8.8V6M13.4 10v2.6c0 .4-.4.8-.8.8H10M6 13.4H3.4c-.4 0-.8-.4-.8-.8V10"
				stroke="currentColor"
				strokeWidth="1.4"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<rect
				x="5.6"
				y="5.6"
				width="4.8"
				height="4.8"
				rx="1"
				stroke="currentColor"
				strokeWidth="1.3"
			/>
		</svg>
	);
}

/** 跟焦：准星（新节点自动带进视野）。 */
export function TargetIcon({ size = 16, className }: IconProps): ReactNode {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none"
			className={className}
			aria-hidden="true"
			focusable="false"
		>
			<circle cx="8" cy="8" r="4.2" stroke="currentColor" strokeWidth="1.4" />
			<circle cx="8" cy="8" r="1.3" fill="currentColor" />
			<path
				d="M8 1.6v2.2M8 12.2v2.2M1.6 8h2.2M12.2 8h2.2"
				stroke="currentColor"
				strokeWidth="1.4"
				strokeLinecap="round"
			/>
		</svg>
	);
}

/** 画布模式：一块画布 + 挂在上面的两个节点。 */
export function CanvasIcon({ size = 16, className }: IconProps): ReactNode {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none"
			className={className}
			aria-hidden="true"
			focusable="false"
		>
			<rect
				x="1.9"
				y="2.6"
				width="12.2"
				height="10.8"
				rx="1.6"
				stroke="currentColor"
				strokeWidth="1.3"
			/>
			<rect x="4.1" y="4.8" width="3.4" height="3.4" rx="0.9" fill="currentColor" opacity="0.75" />
			<rect x="8.6" y="7.6" width="3.4" height="3.4" rx="0.9" fill="currentColor" opacity="0.45" />
		</svg>
	);
}

/** 纯画布（全屏）：画布铺满 + 向外的箭头。 */
export function ExpandIcon({ size = 16, className }: IconProps): ReactNode {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none"
			className={className}
			aria-hidden="true"
			focusable="false"
		>
			<path
				d="M9.6 2.6h3.8v3.8M6.4 13.4H2.6V9.6M13.4 2.6 9.2 6.8M2.6 13.4l4.2-4.2"
				stroke="currentColor"
				strokeWidth="1.4"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

/**
 * 按会话隔离画布：两张**错开的**画布（后面那张是「别的会话」）。
 *
 * 与 `CanvasIcon`（一张画布 + 两个节点）刻意画得不一样：那个表示「画布模式」，
 * 这个表示「一人一张」。两笔都是描边，不填色 —— 菜单里成对出现时才读得出
 * 「一张 / 一叠」的差别。
 */
export function LayersIcon({ size = 16, className }: IconProps): ReactNode {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none"
			className={className}
			aria-hidden="true"
			focusable="false"
		>
			<rect
				x="4.6"
				y="1.9"
				width="9.5"
				height="8.2"
				rx="1.4"
				stroke="currentColor"
				strokeWidth="1.3"
				opacity="0.45"
			/>
			<rect
				x="1.9"
				y="5.6"
				width="9.5"
				height="8.5"
				rx="1.4"
				stroke="currentColor"
				strokeWidth="1.3"
			/>
		</svg>
	);
}
