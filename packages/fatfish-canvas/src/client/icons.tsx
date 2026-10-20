/**
 * 肥鱼画布图标。
 *
 * 两个来源：
 *   1. **鲸鱼尾巴**（`WhaleTailIcon`）—— **从 DSH 原生那一枚来的**：静止态是原生那条
 *      路径（`WHALE_TAIL_PATH`），能动时是一张 28×28 / 60 帧 APNG 遮罩（都在
 *      `generated/whale.ts`，由 `scripts/make-whale.mjs` 从原生客户端产物里抽 / 推）。
 *      姿态与节奏**逐帧照抄原生**；两处**填成实心**是我们加的 —— 用户要「实心纯色」，
 *      而原生两半都是发丝线（静止态 `fill="currentColor"` + 同色描边，动图逐帧填面，
 *      见 `scripts/lib/whale-solid.mjs`）。填的是同一条 d / 同 60 帧，外形与动效不变。
 *      颜色一律 `currentColor`（原生就是），所以浅色 / 深色主题都看得见。
 *   2. 其余小图标（勾选 / 垃圾桶 / 缩放…）—— 自绘内联 SVG，一律 `currentColor`，
 *      跟随宿主主题与 hover 态。需要「挖空」的地方用 `--ffc-grain`
 *      （由使用处设成自身底色），保证浅深主题都成立。
 *
 * @module fatfish-canvas/client/icons
 */

import type { ReactNode } from 'react';
import { WHALE_TAIL_PATH } from './generated/whale';

/** 图标公共属性。 */
export interface IconProps {
	/** 边长（px），默认 20。 */
	size?: number;
	/** 额外类名。 */
	className?: string;
}

/** 图标公共属性 + 本图独有的「正在摇尾巴」开关。 */
export interface WhaleTailIconProps extends IconProps {
	/**
	 * 生成中：一直摇尾巴（静止态是那枚实心的，不会动）。
	 *
	 * 入口那枚刻意**不用**它：悬停由 CSS 负责（`.ffc-entry:hover .ffc-whale`），
	 * 这样「鼠标放上去就动、不用点」是纯样式事实，不必给按钮加状态。
	 *
	 * 尺寸不再分档（旧的米饭碗动图按 24px 卡过一道）：APNG 是 CSS 里的
	 * **一份**资源，14px 那枚也摇得起，不必省。
	 */
	generating?: boolean;
}

/**
 * 鲸鱼尾巴（内联标记）。
 *
 * 结构照抄原生（两个元素、两层状态），造型 / 颜色 / 状态全在 styles.ts：
 *   - `.ffc-whale-still` 实心矢量 —— 静止态（14/17px 下也清晰、满不透明度）
 *   - `.ffc-whale-anim`  实心动画的遮罩 —— 「生成中」或入口悬停时盖在上面
 * 这里只决定三件事：
 *   ① 边长（原生图形是正方的，所以宽高都给）
 *   ② 额外类名
 *   ③ `data-ffc-generating`（styles.ts 按它把静止态换成会摇的那枚）
 *
 * @param props - 图标属性 + 生成中开关。
 * @returns 内联标记（外层 span + 实心 SVG + 动图 span）。
 */
export function whaleTailHtml({
	size = 20,
	className,
	generating = false,
}: WhaleTailIconProps = {}): string {
	const cls = className === undefined ? 'ffc-whale' : `ffc-whale ${className}`;
	return (
		`<span class="${cls}" style="width:${String(size)}px;height:${String(size)}px"` +
		(generating ? ' data-ffc-generating="true"' : '') +
		' aria-hidden="true">' +
		// 静止态：原生那条 d，**填成实心**（fill 与 stroke 都走 currentColor，跟主题）。
		// 那条同色描边是特意留的：悬停换成动图时轮廓线位置不变，只有内部空掉。
		'<svg class="ffc-whale-still" width="100%" height="100%" viewBox="0 0 16 16" fill="currentColor"' +
		` aria-hidden="true"><path d="${WHALE_TAIL_PATH}" stroke="currentColor" stroke-width="1"></path></svg>` +
		// 摇尾巴：**实心**动画那枚（原生 60 帧推导来的，默认 display:none，见 styles.ts）
		'<span class="ffc-whale-anim"></span>' +
		'</span>'
	);
}

/**
 * {@link whaleTailHtml} 的 React 壳。
 *
 * 用 `dangerouslySetInnerHTML` 是有意的：字符串出口让「预览 / 断言脚本看到的那份」
 * 与「组件渲染的那份」是同一个东西（`npm run preview:icon`、`test-icon.mjs`）。
 * 内容是自己拼的常量，没有外部输入。
 * @param props - 图标属性 + 生成中开关。
 * @returns 内联图形元素。
 */
export function WhaleTailIcon(props: WhaleTailIconProps): ReactNode {
	return <span dangerouslySetInnerHTML={{ __html: whaleTailHtml(props) }} />;
}

/**
 * 送进输入框：一支向下的箭头落进托盘。
 *
 * 语义刻意选「向下」：输入框在这条消息**下方**，「送进去」= 往下落到那一格里。
 * 刻意不用 ui-primitives 的 `IconSendOutlineRegular`（纸飞机）—— 那个读作「发送消息」，
 * 而这一步只把内容放进输入框、并不发送。
 */
export function SendToComposerIcon({ size = 16, className }: IconProps): ReactNode {
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
			<path d="M8 2.4v7.3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
			<path
				d="M4.9 6.8 8 9.9l3.1-3.1"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<path d="M3 13.3h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
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
 * 一叠画布：两张**错开的**画布（后面那张是「别的」那一叠）。
 *
 * 与 `CanvasIcon`（一张画布 + 两个节点）刻意画得不一样：那个表示「画布模式」，
 * 这个表示「一叠」。两笔都是描边，不填色 —— 菜单里成对出现时才读得出
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
