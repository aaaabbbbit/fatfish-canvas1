/**
 * 肥鱼画布样式表。
 *
 * 全部配色取自 DSH 本体设计 token（由 ui-layout 的主题呈现器以 body 内联变量发布），
 * 因此浅色/深色主题自动跟随，无需自己维护两套色板。
 *
 * 两处结构性要点：
 *
 * 1. AppFrame 是 CSS Grid，列宽由它**自身实测宽度**经 ResizeObserver 求解决定
 *    （ui-layout 的 computeColumns）。所以「聊天移到右边」不能靠盖住左边实现 ——
 *    必须真的把 frame 收窄，让 solver 重排。canvas 模式下把 frame 固定到
 *    右侧区域即可；顺带因为它变窄（< 1024px）触发 sidebar 自动塌缩成 56px 轨道。
 *
 * 2. `data-ffc-frame` 由 JS 打点（`[data-shell-overlay]` 的父元素），
 *    避免依赖布局包每次构建都会变哈希的 CSS Module 类名，也避开 `:has()`。
 */

/** 样式标签 id：HMR 驱动器按它做卸载清理，必须稳定且唯一。 */
export const STYLE_TAG_ID = 'fatfish-canvas/styles.css';

/** 样式文本。 */
export const CSS = `
/* ─────────────── 变量 ─────────────── */

:root {
	--ffc-canvas-width: 62%;
	--ffc-canvas-min: 360px;
	--ffc-transition: var(--ds-transition-duration-slow, 200ms) var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1));
	--ffc-toolbar-h: 44px;
}

/* ─────────── 画布模式：把 AppFrame 真正收窄到右侧 ─────────── */

body[data-ffc-mode='canvas'] [data-ffc-frame] {
	position: fixed;
	left: var(--ffc-canvas-width);
	right: 0;
	top: 0;
	bottom: 0;
	width: auto;
}

/* 纯画布模式：画布铺满，聊天列收起。

   ⚠️ 这里**不能**对 [data-ffc-frame] 用 display:none。
   overlay 层（[data-shell-overlay]，承载画布面板）是
   AppFrame 的**子节点** —— 隐藏 frame 会把插件自己的界面一起隐藏掉，
   结果是白屏且退不出来（退出入口就在被隐藏的那棵子树里）。
   实测：canvas-only 下 .ffc-panel 为 0×0，无法点击。

   正确做法：frame 本身继续存在并铺满视口（当 overlay 的活容器），
   只隐藏它**除 overlay 以外**的直接子元素 —— 也就是本体的聊天/侧栏列。
   仍然是「不渲染」而非「宽度 0」，不会把列求解器推进极窄分支。 */
body[data-ffc-mode='canvas-only'] [data-ffc-frame] {
	position: fixed;
	inset: 0;
	width: auto;
}

body[data-ffc-mode='canvas-only'] [data-ffc-frame] > *:not([data-shell-overlay]) {
	display: none;
}

body[data-ffc-mode='canvas-only'] .ffc-panel {
	width: 100vw;
	min-width: 0;
	border-right: none;
}

/* ─────────────────── 画布面板 ─────────────────── */

.ffc-panel {
	position: fixed;
	left: 0;
	top: 0;
	bottom: 0;
	width: var(--ffc-canvas-width);
	min-width: var(--ffc-canvas-min);
	display: flex;
	flex-direction: column;
	box-sizing: border-box;
	background: var(--dsw-alias-bg-base);
	border-right: 1px solid var(--dsw-alias-border-l1);
	overflow: hidden;
	/* 画布面板必须压在 AppFrame 之上：画布宽度可以被拖到比
	   --ffc-canvas-min（360px）更窄的窗口里，此时面板右缘会超出 frame 的左缘，
	   两者重叠；而 AppFrame 在 DOM 里排在 overlay 之后 → 它会把画布右边缘
	   （以及拖到那边的节点）盖住。给面板一个明确的层级，重叠区归画布。 */
	z-index: 10;
	font-family: var(--dsw-font-family);
	color: var(--dsw-alias-label-primary);
}

/* 画布工具条 */

.ffc-toolbar {
	flex: none;
	height: var(--ffc-toolbar-h);
	display: flex;
	align-items: center;
	gap: 4px;
	padding: 0 10px;
	border-bottom: 1px solid var(--dsw-alias-border-l1);
	background: var(--dsw-alias-bg-base);
	user-select: none;
	/* 窄画布下不许把控件挤出可视区：标题可以被截断，控件一律 flex:none。
	   （P8 往顶栏加了一个「视图」按钮，这里必须保证它不会被挤掉或压扁。） */
	min-width: 0;
}

.ffc-toolbar > * {
	flex: none;
}

.ffc-title {
	font-size: 13px;
	line-height: 20px;
	font-weight: 600;
	color: var(--dsw-alias-label-primary);
	margin-right: 4px;
	white-space: nowrap;
	/* 窄面板下**先砍标题**：它是唯一可以缩到看不见也不影响操作的东西 */
	flex: 0 1 auto;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
}

/* 工具条品牌图标：固定宽度，避免节点数变化时整条按钮组左右跳 */
.ffc-toolbar-brand {
	display: inline-flex;
	align-items: center;
	flex: none;
	color: var(--dsw-alias-brand-primary);
}

/* 工具条分组之间的竖线 */
.ffc-toolbar-sep {
	flex: none;
	width: 1px;
	height: 18px;
	margin: 0 3px;
	background: var(--dsw-alias-border-l2);
}

/* 工具条按钮组：窄面板下先砍读数（按钮永远可用）
 *
 * 注意是 flex: 0 1 auto 而不是 flex: none：读数必须**能缩**。
 * 缩的时候走省略号，绝不允许把右边的按钮顶出可视区 —— 顶出去是静默的，
 * 用户只会发现「视图按钮不见了」，却看不出是布局挤的。 */
.ffc-toolbar .ffc-badge {
	flex: 0 1 auto;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
}

.ffc-badge {
	font-size: 11px;
	line-height: 16px;
	padding: 0 6px;
	border-radius: 4px;
	background: var(--dsw-alias-bg-layer-2);
	color: var(--dsw-alias-label-tertiary);
	white-space: nowrap;
}

.ffc-spacer {
	flex: 1;
	min-width: 0;
}

/* 通用工具按钮：与 DSH 工具栏按钮同款 */

.ffc-tbtn {
	appearance: none;
	border: none;
	background: transparent;
	color: var(--dsw-alias-label-secondary);
	height: 28px;
	min-width: 28px;
	padding: 0 6px;
	border-radius: 6px;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	gap: 4px;
	font-family: inherit;
	font-size: 12px;
	cursor: pointer;
	white-space: nowrap;
}

.ffc-tbtn:hover {
	background: var(--dsw-alias-interactive-bg-hover);
	color: var(--dsw-alias-label-primary);
}

.ffc-tbtn:active {
	background: var(--dsw-alias-interactive-bg-active);
}

.ffc-tbtn[data-active='true'] {
	background: var(--dsw-alias-button-ghost-active-fill);
	color: var(--dsw-alias-label-primary);
}

.ffc-tbtn:focus-visible {
	outline: 2px solid var(--dsw-alias-brand-primary);
	outline-offset: 1px;
}

/* 主行动按钮（P18：「运行工作流」）。
   它是画布上唯一会真的花掉一次生成的动作，因此给它一点品牌色 —— 混在
   一片灰按钮里既容易误点，也看不出哪个是「正事」。

   刻意用**描边 + 品牌色文字**而不是实心填充：label-primary-inverted 是
   「主色的反色」而不是恒为白（深色主题下是深灰），压在品牌色实心块上会糊 ——
   这正是 .ffc-node-bar 那段注释里记着的坑。 */
.ffc-tbtn-primary {
	color: var(--dsw-alias-brand-primary);
	box-shadow: inset 0 0 0 1px var(--dsw-alias-brand-primary);
	font-weight: 500;
}

.ffc-tbtn-primary:hover {
	color: var(--dsw-alias-brand-primary);
	background: var(--dsw-alias-interactive-bg-hover);
}

.ffc-tbtn-primary:disabled {
	color: var(--dsw-alias-label-tertiary);
	box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l2);
}

/* 画布视口（P0 为占位；P1 接管为无限画布） */

.ffc-viewport {
	flex: 1;
	position: relative;
	min-height: 0;
	overflow: hidden;
	background: var(--dsw-alias-bg-layer-1);
	background-image:
		radial-gradient(circle, var(--dsw-alias-border-l2) 1px, transparent 1px);
	background-size: 24px 24px;
	touch-action: none;
}

.ffc-placeholder {
	position: absolute;
	inset: 0;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 10px;
	text-align: center;
	padding: 24px;
	pointer-events: none;
}

.ffc-placeholder-title {
	font-size: 14px;
	line-height: 22px;
	font-weight: 600;
	color: var(--dsw-alias-label-secondary);
}

.ffc-placeholder-hint {
	font-size: 12px;
	line-height: 20px;
	color: var(--dsw-alias-label-tertiary);
	max-width: 320px;
}

/* 面板右缘拖拽条：调画布宽度 */

.ffc-resizer {
	position: absolute;
	top: 0;
	bottom: 0;
	right: -3px;
	width: 7px;
	cursor: col-resize;
	z-index: 3;
	touch-action: none;
}

.ffc-resizer::after {
	content: '';
	position: absolute;
	top: 0;
	bottom: 0;
	left: 3px;
	width: 1px;
	background: transparent;
	transition: background var(--ffc-transition);
}

.ffc-resizer:hover::after,
.ffc-resizer[data-dragging='true']::after {
	background: var(--dsw-alias-brand-primary);
}

/* ─────────── 旧米饭碗浮层按钮（P8 已删除，P10 席位说明见下） ───────────
 *
 * 这里**刻意什么规则都没有**。它曾经是
 * position:fixed / top:10px / right:12px 的浮层按钮，而视口右上角正是
 * 聊天区头部右对齐的 Session utilities 席位（dsh-session-log-export 的
 * session log 按钮占着它）—— 于是米饭碗正好压在 session log 上。
 *
 * P10 又把入口放回了右上角，但**换成了席位**：条目注册进那个 utilities 席位
 * （conversation.session.header.utilities，与 session log 同一个 flex 行），
 * 因此仍然不需要任何定位 —— 定位缺席才是「压不住别人」的原因。
 *
 * ⚠️ 本文件是 JS 模板字符串：CSS 注释里不能出现反引号（会提前结束模板串）。 */

/* ─────────── 米饭碗入口按钮（会话头部右上角，P10） ───────────
 *
 * 它在 Session utilities 那一行里，与同行的 session log 按钮同高（32px），
 * 但**只有图形**（没有文字，P10 收尾时去掉）—— 因此是个 32×32 的圆，
 * 而不是胶囊。仍然没有任何 position：它住的是一格真实布局。 */

.ffc-entry {
	appearance: none;
	box-sizing: border-box;
	width: 32px;
	height: 32px;
	padding: 0;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	/* ⚠️ 必须 flex:none：utilities 行是 flex 行，默认的 flex-shrink:1 会在
	   窄聊天列下把入口**压成 0 宽** —— 元素还在 DOM 里、却完全点不到，
	   探针量出来是 0×0，看着像「入口没注册」。 */
	flex: none;
	border: 1px solid var(--dsw-alias-border-l2);
	border-radius: 50%;
	background: transparent;
	color: var(--dsw-alias-label-secondary);
	font-family: var(--dsw-font-family);
	white-space: nowrap;
	cursor: pointer;
	/* 米粒纹理用按钮自身的底色挖空（icons.tsx 读 var(--ffc-grain)）。
	   按钮背景透明 = 头部底色，所以这里给 bg-base：浅深主题都成立。 */
	--ffc-grain: var(--dsw-alias-bg-base);
	transition: color var(--ffc-transition), background var(--ffc-transition), border-color var(--ffc-transition);
}

.ffc-entry:hover {
	color: var(--dsw-alias-label-primary);
	border-color: var(--dsw-alias-border-l3, var(--dsw-alias-border-l2));
	background: var(--dsw-alias-interactive-bg-hover);
}

.ffc-entry:active {
	background: var(--dsw-alias-interactive-bg-active);
}

.ffc-entry:focus-visible {
	outline: 2px solid var(--dsw-alias-brand-primary);
	outline-offset: 2px;
}

/* ─────────── 作用域读数兼开关（P10） ───────────
 *
 * 顶栏那枚「共用画布 / 本会话画布」读数现在自己就是开关（原来这项在
 * 「视图」菜单里）。因此它需要一个按钮该有的重置：本体按钮样式（border /
 * background / font-family）会把 .ffc-badge 的外观带跑。 */
.ffc-badge-btn {
	appearance: none;
	border: none;
	font-family: inherit;
	cursor: pointer;
}

.ffc-badge-btn:hover {
	color: var(--dsw-alias-label-primary);
	background: var(--dsw-alias-interactive-bg-hover);
}

.ffc-badge-btn:focus-visible {
	outline: 2px solid var(--dsw-alias-brand-primary);
	outline-offset: 1px;
}

/* ─────────────────── 菜单 ─────────────────── */

.ffc-menu {
	position: fixed;
	z-index: 31;
	min-width: 180px;
	/* 菜单会长（节点菜单 P20 起有十项左右），窗口矮时必须能滚 ——
	   否则 clampToViewport 只能把顶部压到 8px，下面几项永远点不到。 */
	max-height: min(420px, 100vh - 32px);
	overflow-y: auto;
	padding: 4px;
	box-sizing: border-box;
	border: 1px solid var(--dsw-alias-border-l2);
	border-radius: 10px;
	background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3));
	box-shadow: var(--dsw-shadow-lv2, 0 8px 24px rgba(0, 0, 0, 0.16));
	font-family: var(--dsw-font-family);
}

.ffc-menu-label {
	font-size: 11px;
	line-height: 16px;
	padding: 4px 8px 2px;
	color: var(--dsw-alias-label-tertiary);
}

.ffc-menu-item {
	display: flex;
	align-items: center;
	gap: 8px;
	width: 100%;
	box-sizing: border-box;
	appearance: none;
	border: none;
	background: transparent;
	color: var(--dsw-alias-label-primary);
	font-family: inherit;
	font-size: 13px;
	line-height: 20px;
	padding: 6px 8px;
	border-radius: 6px;
	cursor: pointer;
	text-align: left;
}

.ffc-menu-item:hover {
	background: var(--dsw-alias-interactive-bg-hover);
}

.ffc-menu-item[data-active='true'] {
	background: var(--dsw-alias-button-ghost-active-fill);
}

.ffc-menu-check {
	flex: none;
	width: 14px;
	display: inline-flex;
	justify-content: center;
	color: var(--dsw-alias-brand-primary);
}

/* ─── P5：菜单键盘高亮与危险项 ─── */

/* 键盘高亮（方向键移动）与「当前选中项」是两件事，属性也刻意分开：
   高亮可以落在任何一项上，包括未选中的那一项。 */
.ffc-menu-item[data-nav-active='true'] {
	background: var(--dsw-alias-interactive-bg-hover);
	outline: 1px solid var(--dsw-alias-border-l3);
	outline-offset: -1px;
}

.ffc-menu-item[data-danger='true'] {
	color: var(--dsw-alias-state-error-primary);
	/* 危险项**常驻**一层淡红底：既让「删除」一眼可辨，也把对比度托起来
	   （深色主题的 state-error-primary 是 #f25a5a，直接压菜单底只有 3.7 左右）。 */
	background: var(--dsw-alias-interactive-bg-hover-danger);
}

.ffc-menu-item[data-danger='true']:hover {
	background: var(--dsw-alias-interactive-bg-hover-danger);
}

.ffc-menu-item[data-danger='true'][data-nav-active='true'] {
	background: var(--dsw-alias-interactive-bg-hover-danger);
}

/* 节点右键菜单：贴着光标的浮层，靠 JS 夹进视口内 */
.ffc-node-menu {
	position: fixed;
	z-index: 40;
	min-width: 184px;
}

/* 画布节点上的右键提示（空态与悬浮条上的小字） */
.ffc-node-hint {
	color: var(--dsw-alias-label-tertiary);
}

/* ─── 菜单条目 ─── */

.ffc-menu-item:disabled {
	opacity: 0.5;
	cursor: default;
}

.ffc-menu-item:disabled:hover {
	background: transparent;
}

.ffc-menu-divider {
	height: 1px;
	margin: 4px 6px;
	background: var(--dsw-alias-border-l1);
}

/* 宽度预设：一排小胶囊（P10 后只用在设置页的模型列表里） */
.ffc-menu-chip {
	flex: 1;
	appearance: none;
	border: 1px solid var(--dsw-alias-border-l2);
	background: transparent;
	color: var(--dsw-alias-label-secondary);
	font-family: inherit;
	font-size: 12px;
	line-height: 18px;
	padding: 4px 6px;
	border-radius: 7px;
	cursor: pointer;
	white-space: nowrap;
}

.ffc-menu-chip:hover:not(:disabled) {
	background: var(--dsw-alias-interactive-bg-hover);
	color: var(--dsw-alias-label-primary);
}

.ffc-menu-chip[data-active='true'] {
	border-color: var(--dsw-alias-brand-primary);
	color: var(--dsw-alias-brand-primary);
	background: var(--dsw-alias-button-ghost-active-fill);
}

.ffc-menu-chip:disabled {
	opacity: 0.45;
	cursor: default;
}

/* 底部说明行（一句话说明 / 操作反馈） */
.ffc-menu-note {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 4px 8px 2px;
	font-size: 11px;
	line-height: 16px;
	color: var(--dsw-alias-label-tertiary);
}

/* ─────────────────── P1：无限画布 ─────────────────── */

.ffc-viewport {
	position: relative;
	outline: none;
	user-select: none;
}

/* 刻意**没有** :focus-visible 焦点环：视口是块工作区，点节点就会给它聚焦，
   一圈内描边看着像「整个画布边框出现了一个白色选框」（用户反馈观感差）。
   焦点本身不影响任何操作，键盘可达性由节点自身的选中描边与工具条表达。 */

.ffc-viewport[data-interaction='pan'] {
	cursor: grabbing;
}

.ffc-viewport[data-interaction='box'] {
	cursor: crosshair;
}

/* 「图片已送进聊天框」的即时反馈（见 CanvasStage 的 sentNotice）。
   压在画布底部居中，不抢指针。 */
.ffc-sent-notice {
	position: absolute;
	left: 50%;
	bottom: 16px;
	transform: translateX(-50%);
	z-index: 40;
	pointer-events: none;
	padding: 4px 12px;
	border-radius: 999px;
	font-size: 12px;
	line-height: 18px;
	color: var(--dsw-alias-label-primary-inverted, #fff);
	background: var(--dsw-static-neutral-900, rgba(0, 0, 0, 0.78));
	animation: ffc-sent-in 160ms var(--ds-ease-out, ease-out);
}

@keyframes ffc-sent-in {
	from {
		opacity: 0;
	}
	to {
		opacity: 1;
	}
}

/* 世界层：只施加一次 CSS transform，缩放完全交给它。
   pointer-events 交给节点自身，空白处的指针事件留给视口做框选。

   注意：will-change 只在动画期间加（见下面的 [data-anim] 规则），不能常驻。
   常驻时世界层会被提升成一个独立合成层并缓存栅格化结果：放大之后浏览器
   常常沿用它按旧尺寸栅格化的位图 → 图片越放越糊，而因为没有任何「失效」
   信号，它会一直糊着 —— 直到用户点一下图片（触发重绘）才忽然变清晰，
   这正是用户报的现象。去掉常驻 will-change 后，缩放结束即回到
   「按当前 zoom 栅格化」的常规路径。 */

.ffc-world {
	position: absolute;
	left: 0;
	top: 0;
	transform-origin: 0 0;
	pointer-events: none;
}

/* 程序化移动（跟焦 / 适应内容）时才过渡：用户拖拽必须跟手，所以那条路径
   不加动画，并且一有用户输入就由 JS 立刻撤掉 data-anim。
   动画期间才给 will-change（见上：常驻会让放大后的图片糊着不重绘）。 */
.ffc-viewport[data-anim='true'] .ffc-world {
	will-change: transform;
	transition: transform 240ms var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1));
}

@media (prefers-reduced-motion: reduce) {
	.ffc-viewport[data-anim='true'] .ffc-world {
		transition: none;
	}
}

/* ── 连线（P18） ──

   画在世界层里（跟着节点走），但线宽用 non-scaling-stroke 固定在屏幕上的
   1.5px —— 否则放大 10 倍会变成一条 15px 的带子。 */

.ffc-links {
	position: absolute;
	left: 0;
	top: 0;
	overflow: visible;
	pointer-events: none;
}

.ffc-link {
	fill: none;
	stroke: var(--dsw-alias-border-l3);
	stroke-width: 1.5;
	vector-effect: non-scaling-stroke;
}

.ffc-link-hit {
	fill: none;
	stroke: transparent;
	stroke-width: 14;
	vector-effect: non-scaling-stroke;
	/* 只有它接指针：线本身太细，靠 14px 的透明描边才能悬停到 */
	pointer-events: stroke;
	cursor: pointer;
}

.ffc-link-draft {
	stroke: var(--dsw-alias-brand-primary);
	stroke-dasharray: 5 4;
}

/* 连线中点的删除按钮（屏幕尺寸恒定，靠内联的 scale(1/zoom)）。

   ⚠️ 它是**常驻**的（不是悬停才出现，P23 实测改的）：按钮正好长在指针底下，
   而「显示它」这个动作本身会把指针从连线的命中路径上抢走 → 线失去 hover →
   按钮收起 → 指针又回到线上 → 再出现……来回抖，鼠标实际点不到它
   （e2e 量到的那一刻：中点上命中的是 path.ffc-link-hit，而按钮不在 DOM 里）。
   常驻 + 平时淡一点、指针一到就实心：零 React 状态、零定时器，也没有抖动。 */
.ffc-link-x {
	position: absolute;
	width: 20px;
	height: 20px;
	margin: -10px 0 0 -10px;
	padding: 0;
	box-sizing: border-box;
	appearance: none;
	border: 1px solid var(--dsw-alias-border-l2);
	border-radius: 999px;
	background: var(--dsw-alias-bg-layer-2);
	color: var(--dsw-alias-label-secondary);
	font-size: 12px;
	line-height: 1;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	pointer-events: auto;
	cursor: pointer;
	/* 常驻但淡（见上面的说明）：一眼看得见「这条线能删」，又不至于喧宾夺主 */
	opacity: 0.55;
	/* 压在所有节点之上：节点的 z-index 是 1、2、3…（每次新增 +1），而删除按钮
	   只有一个（悬停时），压在谁上面都不会挡住别的东西。用一个足够大的数，
	   省掉「把按钮挪到屏幕层」那一套坐标换算。 */
	z-index: 1000000;
}

.ffc-link-x:hover {
	opacity: 1;
	background: var(--dsw-alias-state-error-primary, #d33);
	color: #fff;
}

/* ── 节点卡片 ── */

.ffc-node {
	position: absolute;
	pointer-events: auto;
	box-sizing: border-box;
	border-radius: 10px;
	/* ⚠️ 这里**不能**是 hidden（P18 改的）：连接点在四条边的中点上，一半探出卡片
	   外面，hidden 会把它们切掉一半、只剩半个圆可点。裁剪改由 .ffc-node-media
	   与 .ffc-node-bar 各自负责（它们才是需要跟着圆角裁的东西）。 */
	overflow: visible;
	background: var(--dsw-alias-bg-layer-2);
	border: 1px solid var(--dsw-alias-border-l2);
	box-shadow: var(--dsw-shadow-lv1, 0 1px 3px rgba(0, 0, 0, 0.12));
	cursor: move;
}

.ffc-node:hover {
	border-color: var(--dsw-alias-border-l3);
}

.ffc-node[data-selected='true'] {
	border-color: var(--dsw-alias-brand-primary);
	box-shadow:
		0 0 0 2px var(--dsw-alias-brand-primary),
		var(--dsw-shadow-lv2, 0 4px 12px rgba(0, 0, 0, 0.18));
}

.ffc-node-media {
	width: 100%;
	height: 100%;
	display: flex;
	align-items: center;
	justify-content: center;
	background: var(--dsw-alias-bg-layer-1);
	/* 圆角裁剪搬到这里（见 .ffc-node 的 overflow 说明） */
	overflow: hidden;
	border-radius: 9px;
}

.ffc-node-el {
	width: 100%;
	height: 100%;
	object-fit: contain;
	display: block;
	/* 图片不参与 HTML5 原生拖拽，拖拽一律走画布自己的指针逻辑 */
	-webkit-user-drag: none;
}

/* ── 连接点（P18） ──

   每个节点四条边的中点各一个，进出合一。可见性**全靠 CSS**：

     默认           opacity 0 + pointer-events none（不抢节点拖拽的指针）
     悬停节点       该节点的四个一起淡入
     悬停某个连接点 它自己保持可见（pointer-events 变 auto 之后 :hover 才成立）

   因此不需要任何「鼠标靠近判定」的 JS —— 命中区（28px）比可见圆点（16px）大，
   所以是「靠近就出现」，而离开时 opacity 的过渡把它淡出。

   margin 负责把中心对到边的中点上，transform: scale(1/zoom) 由内联样式给
   （屏幕尺寸恒定），两者互不干扰 —— 用 translate(-50%) 的话会和 scale 的
   变换原点纠缠在一起，缩放后中心会偏。 */

.ffc-port {
	position: absolute;
	width: 28px;
	height: 28px;
	margin: -14px 0 0 -14px;
	display: flex;
	align-items: center;
	justify-content: center;
	opacity: 0;
	pointer-events: none;
	cursor: crosshair;
	transition: opacity 140ms var(--ds-ease-out, ease-out);
	z-index: 3;
}

.ffc-port[data-ffc-port='n'] {
	left: 50%;
	top: 0;
}

.ffc-port[data-ffc-port='s'] {
	left: 50%;
	top: 100%;
}

.ffc-port[data-ffc-port='w'] {
	left: 0;
	top: 50%;
}

.ffc-port[data-ffc-port='e'] {
	left: 100%;
	top: 50%;
}

.ffc-port::after {
	content: '';
	width: 16px;
	height: 16px;
	box-sizing: border-box;
	border-radius: 999px;
	border: 1px solid var(--dsw-alias-border-l3);
	background-color: var(--dsw-alias-bg-layer-2);
	/* 加号：两条 1.5px 的实线交叉（不引图标组件，端口尺寸随 zoom 反向缩放，
	   图标组件的 viewBox 反而不好对齐） */
	background-image:
		linear-gradient(var(--dsw-alias-label-secondary), var(--dsw-alias-label-secondary)),
		linear-gradient(var(--dsw-alias-label-secondary), var(--dsw-alias-label-secondary));
	background-size:
		8px 1.5px,
		1.5px 8px;
	background-position: center;
	background-repeat: no-repeat;
	box-shadow: var(--dsw-shadow-lv1, 0 1px 3px rgba(0, 0, 0, 0.12));
}

.ffc-node:hover .ffc-port,
.ffc-port:hover {
	opacity: 1;
	pointer-events: auto;
}

.ffc-port:hover::after {
	border-color: var(--dsw-alias-brand-primary);
	background-color: var(--dsw-alias-brand-primary);
	background-image:
		linear-gradient(#fff, #fff),
		linear-gradient(#fff, #fff);
}

/* 生成节点还没出图时的占位说明 */
.ffc-node-gen {
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 6px;
	padding: 14px;
	text-align: center;
}

.ffc-node-gen-title {
	font-size: 13px;
	font-weight: 600;
	color: var(--dsw-alias-label-primary);
}

.ffc-node-gen-hint {
	font-size: 11px;
	line-height: 16px;
	color: var(--dsw-alias-label-tertiary);
}

/* 生成节点的参数条（P19）：卡片变成「上条 + 内容」的竖排。
   只有 gen 节点这样，媒体节点仍旧是内容铺满整张卡片。 */
.ffc-node[data-kind='gen'] {
	display: flex;
	flex-direction: column;
}

.ffc-node[data-kind='gen'] .ffc-node-media {
	flex: 1;
	height: auto;
	min-height: 0;
}

.ffc-node-gen-head {
	flex: none;
	height: 28px;
	display: flex;
	align-items: center;
	gap: 4px;
	padding: 0 6px;
	box-sizing: border-box;
	background: var(--dsw-alias-bg-layer-1);
	border-bottom: 1px solid var(--dsw-alias-border-l1);
	/* 跟着卡片圆角裁（.ffc-node 是 overflow:visible，见那里的说明） */
	border-radius: 9px 9px 0 0;
	cursor: default;
}

.ffc-node-gen-select {
	flex: 1;
	min-width: 0;
	height: 20px;
	padding: 0 2px;
	box-sizing: border-box;
	appearance: none;
	border: 1px solid var(--dsw-alias-border-l2);
	border-radius: 4px;
	background: var(--dsw-alias-bg-layer-2);
	color: var(--dsw-alias-label-secondary);
	font-family: inherit;
	font-size: 11px;
	cursor: pointer;
}

.ffc-node-gen-select:hover {
	border-color: var(--dsw-alias-border-l3);
	color: var(--dsw-alias-label-primary);
}

.ffc-node-text {
	padding: 12px;
	font-size: 13px;
	line-height: 20px;
	color: var(--dsw-alias-label-primary);
	white-space: pre-wrap;
	word-break: break-word;
	overflow: hidden;
}

/* 空文字节点的占位（不然是一张纯白卡片，没人知道能双击） */
.ffc-node-text-empty {
	color: var(--dsw-alias-label-tertiary);
}

/* 文字节点的内联编辑框（双击进入，P18）。
   跟着世界层缩放，所以字体用与 .ffc-node-text 相同的一份 —— 进出编辑态
   文字大小不跳。 */
.ffc-node-edit {
	width: 100%;
	height: 100%;
	box-sizing: border-box;
	resize: none;
	border: none;
	outline: none;
	padding: 12px;
	font-family: inherit;
	font-size: 13px;
	line-height: 20px;
	color: var(--dsw-alias-label-primary);
	background: var(--dsw-alias-bg-layer-2);
}

.ffc-node-pending,
.ffc-node-failed {
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 6px;
	padding: 12px;
	text-align: center;
}

.ffc-node-pending-icon {
	display: inline-flex;
	color: var(--dsw-alias-brand-primary);
	animation: ffc-pulse 1.4s var(--ds-ease-in-out, ease-in-out) infinite;
}

@keyframes ffc-pulse {
	0%,
	100% {
		opacity: 0.35;
	}
	50% {
		opacity: 1;
	}
}

@media (prefers-reduced-motion: reduce) {
	.ffc-node-pending-icon {
		animation: none;
		opacity: 0.8;
	}
}

.ffc-node-pending-text {
	font-size: 12px;
	color: var(--dsw-alias-label-tertiary);
}

.ffc-node-failed-title {
	font-size: 12px;
	font-weight: 600;
	color: var(--dsw-alias-state-error-primary);
}

.ffc-node-failed-reason {
	font-size: 11px;
	line-height: 16px;
	color: var(--dsw-alias-label-tertiary);
	overflow: hidden;
	display: -webkit-box;
	-webkit-line-clamp: 3;
	-webkit-box-orient: vertical;
}

/* ── 悬浮操作条 ──

   这一条**刻意不跟随主题**：它压在任意媒体上（用户生成的图可能是任何颜色），
   因此必须是一层深色遮罩 + 白字 —— 这也是媒体框的通行做法。

   ⚠️ 曾经的写法是 bg-mask-1（遮罩，两套主题都是深色，没问题）配
   label-primary-inverted。后者不是「恒为白」，而是「主色的**反色**」：
   深色主题下它是 #353638，于是深字压在深遮罩上 —— 两套主题都糊，
   深色下尤其明显。这是 P5 的对比度复查（scripts/e2e-theme.mjs）抓到的。

   注意：本文件是 JS 模板字符串，CSS 注释里**不能出现反引号**（会提前结束
   模板串、构建直接报「Invalid character」，而且报在转译阶段而不是这一行）。 */

.ffc-node-bar {
	position: absolute;
	left: 0;
	right: 0;
	bottom: 0;
	height: 28px;
	display: flex;
	align-items: center;
	gap: 2px;
	padding: 0 6px;
	box-sizing: border-box;
	background: rgba(0, 0, 0, 0.62);
	color: #ffffff;
	font-size: 11px;
	opacity: 0;
	transition: opacity var(--ffc-transition);
	/* 跟着卡片圆角裁（.ffc-node 不再 overflow:hidden，见那里的说明） */
	border-radius: 0 0 9px 9px;
}

.ffc-node:hover .ffc-node-bar,
.ffc-node[data-selected='true'] .ffc-node-bar {
	opacity: 1;
}

.ffc-node-title {
	flex: 1;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.ffc-node-title-muted {
	opacity: 0.7;
}

.ffc-node-spacer {
	flex: 1;
}

.ffc-node-act {
	flex: none;
	appearance: none;
	border: none;
	background: transparent;
	color: inherit;
	width: 20px;
	height: 20px;
	border-radius: 4px;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	font-size: 13px;
	line-height: 1;
	cursor: pointer;
	text-decoration: none;
}

.ffc-node-act:hover {
	background: var(--dsw-alias-interactive-bg-hover);
}

.ffc-node-flag {
	flex: none;
	padding: 0 5px;
	border-radius: 4px;
	/* 与悬浮条同理：它挂在深色遮罩上，因此用**静态**红（不随主题翻转）配白字。
	   用主题相关的 state-error-primary 时，深色下它是 #f25a5a，配 label-primary-inverted
	   的深色字只有 3.7 的对比度 —— P5 的对比度复查抓到的第二处。 */
	background: var(--dsw-static-red-900);
	color: #ffffff;
	font-size: 10px;
	line-height: 15px;
}

/* 视频播放按钮：独立于原生控件，pointerdown 阻断冒泡因此永不触发拖拽 */

.ffc-node-play {
	position: absolute;
	left: 50%;
	top: 50%;
	transform: translate(-50%, -50%);
	appearance: none;
	box-sizing: border-box;
	width: 40px;
	height: 40px;
	padding: 0;
	border: 1px solid var(--dsw-alias-border-l3);
	border-radius: 50%;
	background: var(--dsw-alias-bg-mask-photo, rgba(0, 0, 0, 0.5));
	color: #ffffff;
	font-size: 13px;
	line-height: 1;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	cursor: pointer;
	opacity: 0;
	transition: opacity var(--ffc-transition);
}

.ffc-node:hover .ffc-node-play,
.ffc-node[data-selected='true'] .ffc-node-play {
	opacity: 1;
}

.ffc-node-play[data-playing='true'] {
	opacity: 0;
}

.ffc-node:hover .ffc-node-play[data-playing='true'] {
	opacity: 0.75;
}

.ffc-node-play:hover {
	background: var(--dsw-alias-bg-mask-2, rgba(0, 0, 0, 0.7));
}

/* ── 框选矩形（屏幕空间，不随缩放变形） ── */

.ffc-marquee {
	position: absolute;
	pointer-events: none;
	border: 1px solid var(--dsw-alias-brand-primary);
	background: var(--dsw-alias-bg-multi-select, rgba(59, 130, 246, 0.12));
	border-radius: 2px;
}

/* ── 对齐辅助线（拖动节点时出现；屏幕空间，因此 1px 不随缩放变粗） ──

   缩成一点的线（两个等高的矩形完全对齐）靠 min-height/min-width 兜底，
   否则那条线会是 0 长、等于没有反馈。 */

.ffc-guide {
	position: absolute;
	pointer-events: none;
	z-index: 2;
}

.ffc-guide-x {
	width: 0;
	min-height: 6px;
	border-left: 1px dashed var(--dsw-alias-brand-primary);
}

.ffc-guide-y {
	height: 0;
	min-width: 6px;
	border-top: 1px dashed var(--dsw-alias-brand-primary);
}

/* ── 缩放控件（左下角） ── */

.ffc-zoombar {
	position: absolute;
	left: 10px;
	bottom: 10px;
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 3px;
	box-sizing: border-box;
	border: 1px solid var(--dsw-alias-border-l2);
	border-radius: 9px;
	background: var(--dsw-alias-button-floating-fill, var(--dsw-alias-bg-layer-2));
	box-shadow: var(--dsw-shadow-lv1, 0 1px 3px rgba(0, 0, 0, 0.12));
	font-family: var(--dsw-font-family);
	user-select: none;
}

.ffc-zoombar-group {
	display: flex;
	align-items: center;
	gap: 1px;
}

.ffc-zoom-pct {
	min-width: 46px;
	font-variant-numeric: tabular-nums;
	font-weight: 600;
}

.ffc-zoombar-readout {
	padding: 0 8px 0 2px;
	font-size: 11px;
	color: var(--dsw-alias-label-tertiary);
	white-space: nowrap;
	font-variant-numeric: tabular-nums;
}

.ffc-zoom-menu {
	position: absolute;
	left: 0;
	bottom: calc(100% + 6px);
	min-width: 120px;
	padding: 4px;
	box-sizing: border-box;
	border: 1px solid var(--dsw-alias-border-l2);
	border-radius: 10px;
	background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3));
	box-shadow: var(--dsw-shadow-lv2, 0 8px 24px rgba(0, 0, 0, 0.16));
}

.ffc-tbtn:disabled {
	opacity: 0.4;
	cursor: default;
}

.ffc-tbtn:disabled:hover {
	background: transparent;
	color: var(--dsw-alias-label-secondary);
}

/* ─────────────── 设置页：图像 / 视频模型 ─────────────── */

.ffc-set {
	display: flex;
	flex-direction: column;
	gap: 10px;
	font-family: var(--dsw-font-family);
	color: var(--dsw-alias-label-primary);
	max-width: 720px;
}

.ffc-set-intro {
	font-size: 13px;
	line-height: 20px;
	color: var(--dsw-alias-label-secondary);
}

.ffc-set-status {
	font-size: 13px;
	line-height: 20px;
	padding: 8px 10px;
	border-radius: 8px;
	background: var(--dsw-alias-bg-layer-2);
	color: var(--dsw-alias-label-secondary);
}

.ffc-set-status[data-kind='error'] {
	background: var(--dsw-alias-interactive-bg-hover-danger);
	color: var(--dsw-alias-state-error-primary);
}

.ffc-set-group {
	font-size: 12px;
	line-height: 18px;
	font-weight: 600;
	color: var(--dsw-alias-label-tertiary);
	margin-top: 6px;
}

.ffc-set-card {
	display: flex;
	flex-direction: column;
	gap: 8px;
	padding: 12px;
	box-sizing: border-box;
	border: 1px solid var(--dsw-alias-border-l2);
	border-radius: 10px;
	background: var(--dsw-alias-bg-layer-1);
}

.ffc-set-head {
	display: flex;
	align-items: center;
	gap: 8px;
}

.ffc-set-title {
	font-size: 13px;
	line-height: 20px;
	font-weight: 600;
}

.ffc-set-grid {
	display: flex;
	align-items: flex-end;
	gap: 8px;
}

.ffc-set-field {
	flex: 1;
	min-width: 0;
	display: flex;
	flex-direction: column;
	gap: 4px;
}

.ffc-set-label {
	font-size: 11px;
	line-height: 16px;
	color: var(--dsw-alias-label-tertiary);
}

.ffc-set-input {
	width: 100%;
	box-sizing: border-box;
	height: 30px;
	padding: 0 8px;
	border: 1px solid var(--dsw-alias-border-l2);
	border-radius: 7px;
	background: var(--dsw-alias-bg-base);
	color: var(--dsw-alias-label-primary);
	font-family: inherit;
	font-size: 13px;
	outline: none;
}

.ffc-set-input:focus {
	border-color: var(--dsw-alias-brand-primary);
}

.ffc-set-input::placeholder {
	color: var(--dsw-alias-label-dimmed);
}

.ffc-set-clear {
	flex: none;
}

.ffc-set-hint {
	font-size: 11px;
	line-height: 16px;
	color: var(--dsw-alias-label-dimmed);
}

.ffc-set-msg {
	font-size: 12px;
	line-height: 18px;
}

.ffc-set-msg[data-kind='ok'] {
	color: var(--dsw-alias-state-success-primary);
}

.ffc-set-msg[data-kind='error'] {
	color: var(--dsw-alias-state-error-primary);
}

/* ─────────── 设置页 P9 新增：供应商 / 模型 / 密钥 / 探测 ─────────── */

/* 添加供应商：按钮 + 预设菜单（菜单用 absolute 贴着按钮，避免把整页挤动） */
.ffc-set-add {
	position: relative;
	display: flex;
	align-items: center;
	gap: 8px;
}

.ffc-set-addbtn {
	height: 30px;
	padding: 0 10px;
	border: 1px solid var(--dsw-alias-border-l2);
	font-size: 12px;
}

.ffc-set-addbtn[data-active='true'] {
	border-color: var(--dsw-alias-brand-primary);
	color: var(--dsw-alias-brand-primary);
}

.ffc-preset-menu {
	position: absolute;
	top: calc(100% + 6px);
	left: 0;
	z-index: 5;
	min-width: 260px;
}

.ffc-set-empty {
	font-size: 12px;
	line-height: 18px;
	padding: 10px 12px;
	border: 1px dashed var(--dsw-alias-border-l2);
	border-radius: 10px;
	color: var(--dsw-alias-label-tertiary);
}

/* 供应商密钥一行：标签 + 状态 + 右侧两个按钮 */
.ffc-set-keyrow {
	display: flex;
	align-items: center;
	gap: 8px;
}

.ffc-set-keyvalue {
	font-size: 12px;
	line-height: 18px;
	color: var(--dsw-alias-label-tertiary);
}

.ffc-set-keyvalue[data-configured='true'] {
	color: var(--dsw-alias-state-success-primary);
}

.ffc-set-keyeditor {
	display: flex;
	align-items: center;
	gap: 8px;
}

/* 密钥输入框：等宽一点，粘贴进来容易核对 */
.ffc-set-secret {
	flex: 1;
	min-width: 0;
	font-family: var(--dsw-font-family-mono, monospace);
}

/* 模型行：类型徽标 + 模型名 + 密钥状态 + ⋯ */
.ffc-set-models {
	display: flex;
	flex-direction: column;
	gap: 4px;
}

.ffc-set-model {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 4px 6px;
	border: 1px solid var(--dsw-alias-border-l1);
	border-radius: 8px;
	background: var(--dsw-alias-bg-layer-1);
}

.ffc-set-model[data-editing='true'] {
	border-color: var(--dsw-alias-brand-primary);
}

.ffc-set-kind {
	flex: none;
	font-size: 11px;
	line-height: 16px;
	padding: 0 6px;
	border-radius: 4px;
	background: var(--dsw-alias-bg-layer-2);
	color: var(--dsw-alias-label-secondary);
}

/* 图像 / 视频用**固定色**区分（不随主题反色）：压在浅深两种底上都要看得清 */
.ffc-set-kind[data-kind='image'] {
	background: rgba(64, 128, 255, 0.16);
	color: var(--dsw-alias-label-primary);
}

.ffc-set-kind[data-kind='video'] {
	background: rgba(180, 96, 255, 0.16);
	color: var(--dsw-alias-label-primary);
}

/* 视觉模型：它是「眼睛」而不是产物，用偏绿的一档区分 */
.ffc-set-kind[data-kind='vision'] {
	background: rgba(46, 160, 120, 0.16);
	color: var(--dsw-alias-label-primary);
}

.ffc-set-note {
	display: block;
	margin-top: 2px;
	font-size: 11px;
	line-height: 16px;
	color: var(--dsw-alias-label-tertiary);
}

.ffc-set-modelid {
	font-size: 12px;
	line-height: 18px;
	font-family: var(--dsw-font-family-mono, monospace);
	color: var(--dsw-alias-label-primary);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.ffc-set-keystate {
	flex: none;
	font-size: 11px;
	line-height: 16px;
	color: var(--dsw-alias-label-tertiary);
}

.ffc-set-keystate[data-own='true'] {
	color: var(--dsw-alias-brand-primary);
}

.ffc-set-kindselect {
	flex: none;
	width: 76px;
}

.ffc-set-danger {
	color: var(--dsw-alias-state-error-primary);
}

/* 「获取模型列表」的结果：可点的 chip 列表 */
.ffc-set-picker {
	display: flex;
	flex-direction: column;
	gap: 6px;
	padding: 8px;
	border: 1px dashed var(--dsw-alias-border-l2);
	border-radius: 8px;
}

.ffc-set-pickerlist {
	display: flex;
	flex-wrap: wrap;
	gap: 4px;
	max-height: 160px;
	overflow-y: auto;
}

/* 模型行右键菜单：跟着坐标走（不是固定位置） */
.ffc-model-menu {
	position: fixed;
	z-index: 40;
	min-width: 240px;
}

/* ─── P17：生成模型选择（composer 工具行里、本体模型位左边那一格） ───
 *
 * 数值全部抄自本体官方 dsh-client-ui-model-selection 的 ModelSelect.module.css
 * （触发器 13px/500/胶囊 24px；菜单 specific-menu 底 + 20px 圆角 +
 * elevation-prominent 阴影 + sticky 分组标题 + 38px 行高 + 14px/500 模型名）。
 * 「字体质感」没有捷径：只能与本体用同一批数值、同一批 token、同一批图标。
 *
 * 位置：注册进 conversation.input.right —— composer bar 的渲染顺序是
 * input.right → input.model → 用量环 → 发送，所以它落在本体模型位的紧左边。
 *
 * ⚠️ 本文件是 JS 模板字符串，注释里不能出现反引号。 */

.ffc-mp-root {
	position: relative;
	min-width: 0;
}

/* 触发器：与官方那个同款胶囊 + 两段式标签（主段标签色，次段 caption 色） */
.ffc-mp-trigger {
	box-sizing: border-box;
	min-width: 0;
	max-width: min(320px, 45cqw);
	height: 28px;
	display: flex;
	align-items: center;
	gap: 4px;
	padding: 0 4px 0 8px;
	border: none;
	border-radius: 24px;
	outline: none;
	background: transparent;
	color: var(--dsw-alias-label-secondary);
	font-family: inherit;
	font-size: 13px;
	font-weight: 500;
	line-height: 20px;
	cursor: pointer;
}

.ffc-mp-trigger:hover:not(:disabled) {
	background: var(--dsw-alias-interactive-bg-hover);
}

.ffc-mp-trigger:focus-visible {
	box-shadow: 0 0 0 2px var(--dsw-alias-border-l3);
}

.ffc-mp-trigger:disabled {
	color: var(--dsw-alias-label-dimmed);
	cursor: default;
}

/* 自绘的星光图标比官方那个「数据」图标更能说明这是**画图**的模型；
   官方只在窄容器里显示图标，这里始终显示 —— 它也是两块选择器唯一的形状差异。 */
.ffc-mp-icon {
	flex: none;
	color: var(--dsw-alias-label-caption);
}

.ffc-mp-label {
	flex: none;
	white-space: nowrap;
}

.ffc-mp-value {
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	color: var(--dsw-alias-label-caption);
	flex-shrink: 1000;
}

.ffc-mp-chevron {
	flex: none;
	display: inline-flex;
	align-items: center;
	color: var(--dsw-alias-label-caption);
	transition: transform 0.12s;
}

.ffc-mp-chevron[data-open='true'] {
	transform: rotate(180deg);
}

/* 菜单：官方 Menu 的形状（挂到 body 上，position: fixed 由 JS 定位） */
.ffc-mp-menu {
	position: fixed;
	z-index: 1100;
	box-sizing: border-box;
	display: flex;
	flex-direction: column;
	width: max-content;
	min-width: min(240px, 100vw - 32px);
	max-width: min(420px, 100vw - 32px);
	max-height: min(360px, 100vh - 96px);
	padding: 4px;
	border: 0;
	border-radius: 20px;
	background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3));
	color: var(--dsw-alias-label-primary);
	box-shadow: var(--dsw-elevation-prominent, var(--dsw-shadow-lv2, 0 8px 24px rgba(0, 0, 0, 0.16)));
	overflow: hidden;
	font-family: var(--dsw-font-family);
	--dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
	--dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
}

/* 两个页签：本体没有这一层（它把「模型 / 推理等级」做成两条 cell），
   这里用同一套语言拼一个分段控件 —— 少一次点击，观感仍是本体的。 */
.ffc-mp-tabs {
	display: flex;
	gap: 4px;
	padding: 0 0 4px;
}

.ffc-mp-tab {
	flex: 1;
	height: 34px;
	border: none;
	border-radius: 10px;
	outline: none;
	background: transparent;
	color: var(--dsw-alias-label-tertiary);
	font-family: inherit;
	font-size: 13px;
	font-weight: 500;
	line-height: 20px;
	cursor: pointer;
}

.ffc-mp-tab:hover {
	background: var(--dsw-alias-interactive-bg-hover);
}

.ffc-mp-tab[data-active='true'] {
	background: var(--dsw-alias-interactive-bg-hover);
	color: var(--dsw-alias-label-primary);
}

.ffc-mp-tab:focus-visible {
	box-shadow: 0 0 0 2px var(--dsw-alias-border-l3);
}

.ffc-mp-groups {
	min-height: 0;
	overflow-y: auto;
}

/* 供应商分组标题：sticky，滚动时压住下面的行（官方同款） */
.ffc-mp-groupTitle {
	position: sticky;
	top: 0;
	z-index: 1;
	padding: 5px 8px 3px;
	background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3));
	color: var(--dsw-alias-label-tertiary);
	font-size: 12px;
	font-weight: 500;
	line-height: 18px;
}

.ffc-mp-option {
	box-sizing: border-box;
	width: 100%;
	min-height: 38px;
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 6px 8px;
	border: none;
	border-radius: 10px;
	outline: none;
	background: transparent;
	color: inherit;
	text-align: left;
	cursor: pointer;
	font-family: inherit;
}

.ffc-mp-option:hover,
.ffc-mp-option:focus-visible,
.ffc-mp-option[data-nav-active='true'] {
	background: var(--dsw-alias-interactive-bg-hover);
}

.ffc-mp-option:disabled {
	color: var(--dsw-alias-label-dimmed);
	cursor: default;
}

.ffc-mp-copy {
	display: flex;
	flex-direction: column;
	flex: 1;
	min-width: 0;
}

.ffc-mp-name {
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	color: inherit;
	font-size: 14px;
	font-weight: 500;
	line-height: 20px;
}

.ffc-mp-check {
	flex: 0 0 18px;
	display: grid;
	place-items: center;
	color: var(--dsw-alias-label-primary);
}

.ffc-mp-empty,
.ffc-mp-note {
	padding: 10px;
	color: var(--dsw-alias-label-tertiary);
	font-size: 13px;
	line-height: 20px;
}

.ffc-mp-note[role='alert'] {
	color: var(--dsw-alias-state-error-primary);
}

/* ─────────── 聊天侧：media_generate 的工具行（keyed tool view） ─────────── */

.ffc-tool {
	display: flex;
	flex-direction: column;
	gap: 6px;
	padding: 8px 10px;
	box-sizing: border-box;
	border: 1px solid var(--dsw-alias-border-l1);
	border-radius: 10px;
	background: var(--dsw-alias-bg-layer-1);
	font-family: var(--dsw-font-family);
	color: var(--dsw-alias-label-primary);
	max-width: 520px;
}

.ffc-tool[data-state='error'] {
	border-color: var(--dsw-alias-state-error-primary);
}

.ffc-tool-head {
	display: flex;
	align-items: center;
	gap: 6px;
	min-width: 0;
	font-size: 12px;
	line-height: 18px;
}

.ffc-tool-icon {
	display: inline-flex;
	align-items: center;
	color: var(--dsw-alias-brand-primary);
}

.ffc-tool[data-state='running'] .ffc-tool-icon {
	animation: ffc-pulse 1.4s var(--ds-ease-in-out, ease-in-out) infinite;
}

.ffc-tool[data-state='error'] .ffc-tool-icon {
	color: var(--dsw-alias-state-error-primary);
}

.ffc-tool-title {
	font-weight: 600;
	white-space: nowrap;
}

.ffc-tool-badge {
	font-size: 11px;
	line-height: 16px;
	padding: 0 6px;
	border-radius: 4px;
	background: var(--dsw-alias-bg-layer-2);
	color: var(--dsw-alias-label-tertiary);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	max-width: 220px;
}

.ffc-tool-spacer {
	flex: 1;
	min-width: 0;
}

.ffc-tool-link {
	flex: none;
	color: var(--dsw-alias-label-tertiary);
	text-decoration: none;
	padding: 0 4px;
}

.ffc-tool-link:hover {
	color: var(--dsw-alias-label-primary);
}

.ffc-tool-prompt {
	font-size: 12px;
	line-height: 18px;
	color: var(--dsw-alias-label-secondary);
	overflow: hidden;
	display: -webkit-box;
	-webkit-line-clamp: 2;
	-webkit-box-orient: vertical;
}

.ffc-tool-img,
.ffc-tool-video {
	display: block;
	max-width: 100%;
	max-height: 260px;
	border-radius: 8px;
	background: var(--dsw-alias-bg-layer-2);
	object-fit: contain;
}

.ffc-tool-error {
	font-size: 12px;
	line-height: 18px;
	color: var(--dsw-alias-state-error-primary);
	white-space: pre-wrap;
	word-break: break-word;
}

.ffc-tool-note {
	font-size: 11px;
	line-height: 16px;
	color: var(--dsw-alias-label-dimmed);
}
`;
