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

import { WHALE_TAIL_ANIM } from './generated/whale';

/** 样式标签 id：HMR 驱动器按它做卸载清理，必须稳定且唯一。 */
export const STYLE_TAG_ID = 'fatfish-canvas/styles.css';

/** 样式文本。 */
export const CSS = `
/* ─────────────── 变量 ─────────────── */

/* token 层刻意分两处声明，这不是排版而是**必须**的：
   --dsw-radius-* / --ds-* 挂在本体的 :root 上 → 可以在这里求值；
   --dsw-alias-* / --dsw-specific-* / --dsw-menu-* 是主题挂在 **body** 上的
   → 只能在 body（或其后代）上求值，写进 :root 会整条失效
   （var() 在**声明它的那个元素**上替换）。下面的 body 那一段同理。 */

:root {
	--ffc-canvas-width: 62%;
	--ffc-canvas-min: 360px;
	--ffc-toolbar-h: 44px;

	/* 圆角阶：直接照搬本体的 --dsw-radius-*，因此与本体控件同心同曲率。
	   插件里的圆角一律走这一阶，不要再写裸 px（10 / 9 / 7 / 6 那种）——
	   裸值一旦与本体那阶错开，插件里的控件就比本体「方一点」，很难指认但看得出来。
	   --ffc-r-sm 给 ≤30px 的控件，--ffc-r-md 给卡片，--ffc-r-lg 给浮层。 */
	--ffc-r-xs: var(--dsw-radius-xs, 4px);
	--ffc-r-sm: var(--dsw-radius-sm, 8px);
	--ffc-r-md: var(--dsw-radius-md, 12px);
	--ffc-r-lg: var(--dsw-radius-lg, 16px);
	--ffc-r-pill: 999px;

	/* 动效：--ffc-transition 走本体那条缓动；--ffc-transition-fast 用苹果那条
	   「快出」曲线，只给 100ms 级的小状态（箭头翻转这类）。
	   时长取本体的**基准档**（0.2s）而不是 slow 档（0.3s）：300ms 的 hover
	   在指针扫过一排节点时明显发黏，本体的按钮态也都是 0.2s。
	   ⚠️ 本文件所有 transition 都必须走这两个变量，不许写死 0.12s 那种字面量 ——
	   末尾的 prefers-reduced-motion 只要把这两个变量压成 1ms 就能**全量**关掉动效。 */
	--ffc-ease-out: cubic-bezier(0.32, 0.72, 0, 1);
	--ffc-transition: var(--ds-transition-duration, 200ms) var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1));
	--ffc-transition-fast: var(--ds-transition-duration-fast, 100ms) var(--ffc-ease-out);
	/* 按下时的缩放量（苹果按钮那一下）。只在**小控件**上用，理由见动效层那段。 */
	--ffc-press: 0.96;
}

/* 颜色 / 材质 / 强调色。⚠️ 必须落在 body 上：--dsw-alias-*、--dsw-specific-menu、
   --dsw-menu-backdrop-filter 全是主题挂在 body 上的，写进上面那个 :root
   一律求值不到（整条 var() 失效，回退到初始值）。 */
body {
	/* 画布底：比 chrome 低一档的凹陷工作面。浅色 #f9fafb、深色 #1b1b1c ——
	   两边都与 bg-base 拉开一档，于是浅色下白卡片不再是「白压白」。
	   （浅色主题的 bg-layer-1/2/3 **全是 #fff**，拿它们分层等于没分。） */
	--ffc-canvas-surface: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-layer-1));
	--ffc-card-surface: var(--dsw-alias-bg-layer-2);
	/* 凹陷的「槽」（卡片里的行、承载媒体的那块底）。深色下它比卡片暗一档
	   （#232324 vs #2c2c2e），浅色下两者都是 #fff（本体浅色主题的
	   layer-1/2/3 全白），因此浅色只靠描边、深色靠明度差。
	   ⚠️ 这个值**不是纯装饰**：.ffc-node-failed-title 那支错误红是按它算过对比度的 ——
	   换成卡片面会让深色下的失败标题掉到 4.24（门限 4.5），e2e:theme 会红。 */
	--ffc-well-surface: var(--dsw-alias-bg-layer-1);
	/* 小徽标 / 药丸的底：浅色下 bg-layer-2 也是白的，徽标会只剩几个字飘在工具条上 */
	--ffc-chip-surface: var(--dsw-alias-interactive-bg-hover);

	/* 浮层材质：本体每个菜单都是「半透明底 + 40px 模糊」，缺了模糊菜单就是
	   一张能看见底下正文的塑料膜、字直接糊在一起。
	   ⚠️ 只给**叶子浮层**（菜单本身）：容器一旦带 backdrop-filter 就成了新的
	   backdrop root，嵌在里面的浮层只会去模糊容器的内容，看起来是平的。 */
	--ffc-material: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3));
	--ffc-material-blur: var(--dsw-menu-backdrop-filter, blur(40px) saturate(150%));

	/* 强调色：本体的 brand-primary 其实是**对比色**（浅色 #0f1115、深色 #f9fafb，
	   与 label-primary 逐字相同），拿它当强调色只会得到一圈黑/白。
	   真正的强调色是 state-business-primary（deepseek 蓝）—— 两套主题下都是同一个
	   中间调，既不像纯黑那样跟图片抢视线，也不像灰那样看不出「已选中」。
	   选择框 / 对齐线 / 焦点环统一走它。 */
	--ffc-accent: var(--dsw-alias-state-business-primary);
	--ffc-select-line: var(--ffc-accent);
	--ffc-focus-ring: var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
	--ffc-focus-width: var(--dsw-focus-ring-width, 2px);

	/* 压在任意媒体上的那一层：**刻意不跟随主题**（用户生成的图可能是任何颜色）。
	   主题色的对比色在深色下是 #353638，压在这种深遮罩上只有 1.6 的对比度 ——
	   所以文字用写死的白，hover 用白色半透明（用主题的 hover 色在浅色下是深色
	   叠加，压在黑遮罩上等于没反应）。 */
	--ffc-scrim: rgb(0 0 0 / 60%);
	--ffc-scrim-hover: rgb(255 255 255 / 18%);
	--ffc-on-scrim: #fff;

	/* 种类徽标的三个固定淡色（图像 / 视频 / 视觉）。刻意不用主题 token：
	   它们要压在浅深两种底上都看得清，语义上也不属于 success / warn 任何一档。 */
	--ffc-tint-image: rgb(64 128 255 / 16%);
	--ffc-tint-video: rgb(180 96 255 / 16%);
	--ffc-tint-vision: rgb(46 160 120 / 16%);
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
	border-radius: var(--ffc-r-xs);
	background: var(--ffc-chip-surface);
	color: var(--dsw-alias-label-tertiary);
	white-space: nowrap;
	/* 读数会随节点数 / 宽度变化，等宽数字才不会让整条工具条左右抖 */
	font-variant-numeric: tabular-nums;
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
	border-radius: var(--ffc-r-sm);
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
	outline: var(--ffc-focus-width) solid var(--ffc-focus-ring);
	outline-offset: 1px;
}

/* 画布视口（P0 为占位；P1 接管为无限画布） */

.ffc-viewport {
	flex: 1;
	position: relative;
	min-height: 0;
	overflow: hidden;
	/* ⚠️ 只能用 background-color，不能用 background 简写：简写会把下面那条
	   background-image（点阵）一起重置掉。 */
	background-color: var(--ffc-canvas-surface);
	/* 点阵的间距/原点由视口内联样式按 zoom 与平移覆盖（见 model.ts 的 gridOf）：
	   背景是**世界的一部分**，不跟着走就会「节点动、背景钉死」。
	   这里只给不变量：点的半径走 --ffc-dot，以及未挂样式时的默认值。
	   24px 这个默认值必须与 model.ts 的 GRID_STEP 一致。 */
	background-image:
		radial-gradient(circle, var(--dsw-alias-border-l2) var(--ffc-dot, 1px), transparent var(--ffc-dot, 1px));
	background-size: 24px 24px;
	background-position: 0 0;
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
	background: var(--ffc-accent);
}

/* ─────────── 鲸鱼尾巴图标（从 DSH 原生那一枚来的） ───────────
 *
 * 造型与「摇尾巴」= **原生同一套**（静止态是原生那条 d，摇动是原生那 60 帧 /
 * 一圈 3 秒的动画，都在 src/client/generated/whale.ts）。两处都**填成实心**
 * （用户要「实心纯色」，原生两半都是发丝线）：静止态 fill 在 icons.tsx 的标记上，
 * 动图逐帧填面在 scripts/lib/whale-solid.mjs。原生自己也是**两个元素**，
 * 这里照抄同一个结构，于是只剩两件事：
 *
 *   ① **上色走 currentColor**（原生就是 currentColor）：深色主题下是浅色、
 *      浅色主题下是深色，两边都看得见。
 *      ⚠️ 不要写死 #fff：浅色主题下那就是隐形（P38 第一版的教训）。
 *   ② **分状态**：静止态是那枚实心的，「生成中」与「入口悬停」才换成会摇的那枚
 *      （绝对定位盖上去，同时把静止态 display:none，不然会重影）。
 *
 * ⚠️ 静止态**不能**拿 APNG 第 0 帧当静帧：那是 28×28 的位图细线，缩到 14/17px
 *    后峰值 alpha 只有七成上下 —— 屏幕上就是一条灰线（NOTES §8.72）。
 * ⚠️ 两个 mask-* 都写全了 -webkit- 前缀：宿主前端是 Chrome，但 Safari 只认前缀。
 * ⚠️ 本文件是 JS 模板字符串：CSS 注释里不能出现反引号（会提前结束模板串）。 */

.ffc-whale {
	display: block;
	/* ⚠️ 必须 flex:none：这几个图标都住在 inline-flex 的格子里，默认的
	   flex-shrink:1 会在窄格子里把它压扁（图形是方的，压了就变形）。 */
	flex: none;
	/* 会摇的那枚是绝对定位，要有个定位祖先 */
	position: relative;
	user-select: none;
}

/* 静止态：实心（fill 与那条同色描边都在标记上，这里只管铺满格子）。
 *
 * ⚠️ 填充的**不是**原生静止态的画法（原生是空心的线稿）：用户明确要「实心纯色」。
 *    同一条 d，开放路径填充时自动闭合，那一段正好是尾柄底边，外形不变（NOTES §3.42）。 */
.ffc-whale-still {
	display: block;
	width: 100%;
	height: 100%;
}

/* 摇尾巴：**实心**动画那枚当遮罩，颜色同样来自 currentColor。
 *
 * 整个动效关在 prefers-reduced-motion: no-preference 那段里：摇动是**帧动画**
 * （APNG 自己在走），末尾那条压 duration 的通配对它无效 —— 只能干脆不切过去，
 * 静止态那枚实心照旧。 */
@media (prefers-reduced-motion: no-preference) {
	.ffc-whale-anim {
		/* 默认不摇：静止态露的是上面那枚实心的 */
		display: none;
		position: absolute;
		inset: 0;
		background: currentColor;
		-webkit-mask-image: url(${WHALE_TAIL_ANIM});
		mask-image: url(${WHALE_TAIL_ANIM});
		-webkit-mask-repeat: no-repeat;
		mask-repeat: no-repeat;
		-webkit-mask-position: center;
		mask-position: center;
		-webkit-mask-size: contain;
		mask-size: contain;
	}

	/* 摇尾巴的两个入口：JS 打的「生成中」，以及**鼠标悬停**（入口按钮 / 模型选择那枚
	   图标，都不用点击 —— 后者是 P39 用户点名要的「移上去有小动画」）。 */
	.ffc-whale[data-ffc-generating='true'] .ffc-whale-still,
	.ffc-entry:hover .ffc-whale .ffc-whale-still,
	.ffc-mp-trigger:hover .ffc-whale .ffc-whale-still {
		display: none;
	}

	.ffc-whale[data-ffc-generating='true'] .ffc-whale-anim,
	.ffc-entry:hover .ffc-whale .ffc-whale-anim,
	.ffc-mp-trigger:hover .ffc-whale .ffc-whale-anim {
		display: block;
	}
}

/* ─────────── 旧入口浮层按钮（P8 已删除，P10 席位说明见下） ───────────
 *
 * 这里**刻意什么规则都没有**。它曾经是
 * position:fixed / top:10px / right:12px 的浮层按钮，而视口右上角正是
 * 聊天区头部右对齐的 Session utilities 席位（dsh-session-log-export 的
 * session log 按钮占着它）—— 于是入口正好压在 session log 上。
 *
 * P10 又把入口放回了右上角，但**换成了席位**：条目注册进那个 utilities 席位
 * （conversation.session.header.utilities，与 session log 同一个 flex 行），
 * 因此仍然不需要任何定位 —— 定位缺席才是「压不住别人」的原因。
 *
 * ⚠️ 本文件是 JS 模板字符串：CSS 注释里不能出现反引号（会提前结束模板串）。 */

/* ─────────── 鲸鱼尾巴入口按钮（会话头部右上角，P10） ───────────
 *
 * 它在 Session utilities 那一行里，与同行的 session log 按钮同高（32px），
 * 但**只有图形**：没有文字（P10 收尾时去掉），也没有边框/底色（用户要求
 * 「只保留里面的图形」）—— 32×32 的透明热区里就一枚鲸鱼尾巴。
 * 仍然没有任何 position：它住的是一格真实布局。
 *
 * 热区仍是 32×32（可点面积不能跟着视觉一起缩小），焦点态靠 focus-visible
 * 的那圈 outline 表示。 */

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
	border: none;
	border-radius: 50%;
	/* 本体全局把 corner-shape 设成了 superellipse(1.5)（苹果那种连续曲率圆角），
	   50% 的圆必须显式圆回来，否则会得到一个「方一点的圆」。
	   本体自己的 Pill / Tag / Switch / StateDot 都是这么做的。 */
	corner-shape: round;
	background: transparent;
	color: var(--dsw-alias-label-secondary);
	font-family: var(--dsw-font-family);
	white-space: nowrap;
	cursor: pointer;
	/* 图标（鲸鱼尾巴）的颜色就是这里的 color：本体那阶次要文字色，
	   浅深主题都成立。hover / 按下由底色与缩放承担，不再压不透明度 ——
	   压了那枚就不是纯色了（P38）。 */
	transition: background var(--ffc-transition);
}

.ffc-entry:hover {
	background: var(--dsw-alias-interactive-bg-hover);
}

.ffc-entry:active {
	background: var(--dsw-alias-interactive-bg-active);
}

.ffc-entry:focus-visible {
	outline: var(--ffc-focus-width) solid var(--ffc-focus-ring);
	outline-offset: 2px;
}

/* ─────────── 作用域读数兼开关（P10） ───────────
 *
 * 顶栏那枚「共用画布 / 本工作区画布」读数现在自己就是开关（原来这项在
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
	outline: var(--ffc-focus-width) solid var(--ffc-focus-ring);
	outline-offset: 1px;
}

/* ─────────────────── 菜单 ─────────────────── */

.ffc-menu {
	position: fixed;
	z-index: 31;
	min-width: 180px;
	padding: 4px;
	box-sizing: border-box;
	/* 与本体菜单同款：border:0 + --dsw-elevation-prominent（自带那条 0.5px 发丝
	   描边与两层柔光）+ 半透明材质底 + 40px 模糊，圆角取本体的 --dsw-radius-lg。
	   本体所有高层级表面都是 border:0 —— 多一圈 1px 实边在这套语言里就是「厚了一层」。 */
	border: 0;
	border-radius: var(--ffc-r-lg);
	background: var(--ffc-material);
	backdrop-filter: var(--ffc-material-blur);
	/* 发丝描边走这个变量；本体的默认值（border-l4）在浅色下 16% 偏重，菜单也重绑成浅一档 */
	--dsw-elevation-stroke-color: var(--dsw-alias-border-l2);
	box-shadow: var(--dsw-elevation-prominent, var(--dsw-shadow-lv2, 0 8px 24px rgba(0, 0, 0, 0.16)));
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
	border-radius: var(--ffc-r-sm);
	cursor: pointer;
	text-align: left;
}

.ffc-menu-item:hover {
	background: var(--dsw-alias-interactive-bg-hover);
}

.ffc-menu-item[data-active='true'] {
	background: var(--dsw-alias-button-ghost-active-fill);
}

/* 勾用强调色：macOS 菜单里的勾就是强调色；用主文字色等于「勾也只是个字」 */
.ffc-menu-check {
	flex: none;
	width: 14px;
	display: inline-flex;
	justify-content: center;
	color: var(--ffc-accent);
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

/* ─── 「生成信息」卡片（右键菜单里展开的那一块）───
   提示词是长文本，因此卡片比菜单本身宽、并且自己滚动（菜单被 JS 夹在视口内，
   长到溢出就等于底部内容永远看不到）。参考图一行一张：能直接显示的给缩略图，
   不能的说清它是什么 —— 文字一律次级色，它在菜单里是补充说明而不是动作。 */
.ffc-node-info {
	display: flex;
	flex-direction: column;
	gap: 2px;
	width: 300px;
	max-height: 46vh;
	overflow: auto;
	margin-top: 4px;
	padding: 6px 8px;
	border-top: 1px solid var(--dsw-alias-border-l1);
}

.ffc-node-info-head {
	font-size: 11px;
	line-height: 16px;
	color: var(--dsw-alias-label-tertiary);
}

.ffc-node-info-prompt {
	font-size: 12px;
	line-height: 18px;
	color: var(--dsw-alias-label-primary);
	white-space: pre-wrap;
	word-break: break-word;
}

.ffc-node-info-empty {
	font-size: 12px;
	line-height: 18px;
	color: var(--dsw-alias-label-tertiary);
}

.ffc-node-info-refs {
	display: flex;
	flex-direction: column;
	gap: 6px;
	margin-top: 2px;
}

.ffc-node-info-ref {
	display: flex;
	align-items: center;
	gap: 8px;
	min-width: 0;
}

.ffc-node-info-thumb {
	flex: none;
	width: 44px;
	height: 44px;
	border-radius: var(--ffc-r-sm);
	background: var(--dsw-alias-interactive-bg-hover);
	object-fit: cover;
}

/* 取不到字节的那种参考图：留一个虚线占位，好让「这里本来该有一张图」看得出来。
   ⚠️ 边框色要 l3 而不是 l2：菜单是半透明材质底，深色主题下 l2 的虚线**看不见**，
   那一行就成了一段没来由的缩进（P47 首轮截图实测）。 */
.ffc-node-info-thumb[data-empty='true'] {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	border: 1px dashed var(--dsw-alias-border-l3);
	background: transparent;
	font-size: 15px;
	line-height: 1;
	color: var(--dsw-alias-label-tertiary);
}

.ffc-node-info-reftext {
	/* 地址可能很长：最多两行，剩下的靠 title 看全 */
	display: -webkit-box;
	-webkit-line-clamp: 2;
	-webkit-box-orient: vertical;
	overflow: hidden;
	font-size: 11px;
	line-height: 15px;
	color: var(--dsw-alias-label-secondary);
	word-break: break-all;
}

.ffc-node-info-foot {
	font-size: 11px;
	line-height: 16px;
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
	border-radius: var(--ffc-r-sm);
	cursor: pointer;
	white-space: nowrap;
}

.ffc-menu-chip:hover:not(:disabled) {
	background: var(--dsw-alias-interactive-bg-hover);
	color: var(--dsw-alias-label-primary);
}

.ffc-menu-chip[data-active='true'] {
	border-color: var(--ffc-accent);
	color: var(--ffc-accent);
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
	border-radius: var(--ffc-r-pill);
	corner-shape: round;
	font-size: 12px;
	line-height: 18px;
	/* ⚠️ 这里**不能**用 label-primary-inverted：它是「主色的**反色**」而不是
	   「恒为白」—— 深色主题下求值成 #353638，压在 #0f0f0f 上只有 1.58 的对比度，
	   提示等于看不见。底色写死成深色，前景就必须写死成白（同 .ffc-node-flag 那次教训）。 */
	color: var(--ffc-on-scrim);
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

/* 背景点阵走的是内联的 background-size/position（见 model.ts 的 gridOf），
   不带上同一段过渡的话，程序化移动时会出现「节点滑过去、点阵啪地跳过去」。 */
.ffc-viewport[data-anim='true'] {
	transition:
		background-position 240ms var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1)),
		background-size 240ms var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1));
}

@media (prefers-reduced-motion: reduce) {
	.ffc-viewport[data-anim='true'] .ffc-world {
		transition: none;
	}

	.ffc-viewport[data-anim='true'] {
		transition: none;
	}
}

/* ── 节点卡片 ── */

.ffc-node {
	position: absolute;
	pointer-events: auto;
	box-sizing: border-box;
	border-radius: var(--ffc-r-md);
	overflow: hidden;
	background: var(--ffc-card-surface);
	border: 0;
	/* 卡片不画 1px 实边，走 elevation 自带的那条 0.5px 发丝描边 + 两层柔光：
	   本体所有高层级表面都是这个写法，1px 实边会比本体「厚一圈」。
	   描边色重绑成 border-l2（默认的 border-l4 在浅色下 16% 偏重）。 */
	--dsw-elevation-stroke-color: var(--dsw-alias-border-l2);
	box-shadow: var(--dsw-elevation-panel, var(--dsw-shadow-lv1, 0 1px 3px rgba(0, 0, 0, 0.12)));
	cursor: move;
	/* 悬停只该「抬起」，不该换描边色：换色会让整片画布在指针扫过时一起闪 */
	transition: box-shadow var(--ffc-transition);
}

.ffc-node:hover {
	box-shadow: var(--dsw-elevation-prominent, var(--dsw-shadow-lv2, 0 4px 12px rgba(0, 0, 0, 0.18)));
}

/* 选中 = 强调色一圈 + 抬到 hover 之上。
   原来是「与框选虚线共用一条灰」（label-secondary），浅色下几乎看不出选中了哪一张；
   而 brand-primary 那条路更是死的 —— 它逐字等于 label-primary（浅色近黑 / 深色近白），
   所以旧注释里说的「太扎眼 / 又发白」其实是同一个颜色在两种主题下的两种抱怨。
   真正的强调色是 state-business-primary，两套主题下都是同一个中间调蓝。 */
.ffc-node[data-selected='true'] {
	box-shadow:
		0 0 0 2px var(--ffc-select-line),
		var(--dsw-elevation-prominent, var(--dsw-shadow-lv2, 0 4px 12px rgba(0, 0, 0, 0.18)));
}

/* 媒体槽是卡片里的**凹陷槽**（--ffc-well-surface），不是卡片面：
   待生成 / 失败 / 文字节点整块都是它，所以这三类卡片在深色下比图片卡片暗一档
   —— 这是刻意的，也正是 .ffc-node-failed-title 的对比度赖以成立的那一档
   （见 --ffc-well-surface 的注释）。 */
.ffc-node-media {
	width: 100%;
	height: 100%;
	display: flex;
	align-items: center;
	justify-content: center;
	background: var(--ffc-well-surface);
}

.ffc-node-el {
	width: 100%;
	height: 100%;
	object-fit: contain;
	display: block;
	/* 图片不参与 HTML5 原生拖拽，拖拽一律走画布自己的指针逻辑 */
	-webkit-user-drag: none;
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
	/* 没有 opacity 呼吸：那枚鲸鱼尾巴自己在摇，再叠一层脉动只会把它糊掉
	   （P27 之前是自绘 SVG，那时才需要脉动）。 */
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
	/* 底色走 --ffc-scrim（写死的 60% 黑）、前景走 --ffc-on-scrim（写死的白）：
	   这一条压的是用户生成的图，可能是任何颜色，因此它**不跟随主题**。
	   那层渐变只负责「往下渐深」的层次（纯色遮罩在照片上像贴了条胶带）；
	   它不参与对比度判据 —— 判据读的是 background-color，所以底色要保持
	   60% 这一档（旧值是裸写的 62%，收进 token 后只差 2 个百分点）。 */
	background-color: var(--ffc-scrim);
	background-image: linear-gradient(to bottom, rgb(0 0 0 / 0%), rgb(0 0 0 / 18%));
	color: var(--ffc-on-scrim);
	font-size: 11px;
	opacity: 0;
	transition: opacity var(--ffc-transition);
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
	border-radius: var(--ffc-r-xs);
	display: inline-flex;
	align-items: center;
	justify-content: center;
	font-size: 13px;
	line-height: 1;
	cursor: pointer;
	text-decoration: none;
}

/* ⚠️ 不能用主题的 interactive-bg-hover：它是**深色**叠加（浅色 #2631480f），
   压在 .ffc-node-bar 的深遮罩上等于没有反馈 —— 浅色主题下这两个按钮
   悬停时看不出任何变化。挂在深遮罩上的按钮一律用白色叠加。 */
.ffc-node-act:hover {
	background: var(--ffc-scrim-hover);
}

.ffc-node-flag {
	flex: none;
	padding: 0 5px;
	border-radius: var(--ffc-r-xs);
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
	/* 描边也是一圈白，不能用 --dsw-alias-border-l3：它在浅色下是 12% 的**黑**，
	   压在（几乎不透明的）黑圆上等于没有描边。 */
	border: 1px solid var(--ffc-scrim-hover);
	border-radius: 50%;
	corner-shape: round;
	background: var(--dsw-alias-bg-mask-photo, rgba(0, 0, 0, 0.5));
	color: var(--ffc-on-scrim);
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

/* 悬停要更**深**。原来写的是 bg-mask-2，浅色下是 12% 黑、深色下更是 1% —— 
   一悬停播放按钮直接变透明，两个主题都反了。 */
.ffc-node-play:hover {
	background: rgb(0 0 0 / 96%);
}

/* ── 框选矩形（屏幕空间，不随缩放变形） ──

   刻意**不填色**：填了就会把框里的图蒙上一层（用户报的「选框把图片挡住」）。
   灰虚线本身就够说明范围了 —— 颜色与选中节点的边框同源（--ffc-select-line）。 */

.ffc-marquee {
	position: absolute;
	pointer-events: none;
	border: 1px dashed var(--ffc-select-line);
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
	border-left: 1px dashed var(--ffc-accent);
}

.ffc-guide-y {
	height: 0;
	min-width: 6px;
	border-top: 1px dashed var(--ffc-accent);
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
	/* 与本体菜单同一套高度：border:0 + elevation-prominent（自带那条发丝描边）。
	   ⚠️ 这里**刻意不给 backdrop-filter**：容器一旦带模糊就成了新的 backdrop root，
	   嵌在里面的 .ffc-zoom-menu 只会去模糊工具条自己的内容，菜单看着就是平的。
	   模糊只给叶子浮层（见 --ffc-material 那段注释）。 */
	border: 0;
	border-radius: var(--ffc-r-lg);
	background: var(--dsw-alias-button-floating-fill, var(--dsw-alias-bg-layer-2));
	--dsw-elevation-stroke-color: var(--dsw-alias-border-l2);
	box-shadow: var(--dsw-elevation-prominent, var(--dsw-shadow-lv1, 0 1px 3px rgba(0, 0, 0, 0.12)));
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
	/* 紧凑档：本体 MenuSurface 的 .compact 用的就是 --dsw-radius-md */
	border: 0;
	border-radius: var(--ffc-r-md);
	background: var(--ffc-material);
	backdrop-filter: var(--ffc-material-blur);
	--dsw-elevation-stroke-color: var(--dsw-alias-border-l2);
	box-shadow: var(--dsw-elevation-prominent, var(--dsw-shadow-lv2, 0 8px 24px rgba(0, 0, 0, 0.16)));
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
	border-radius: var(--ffc-r-sm);
	background: var(--ffc-chip-surface);
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
	border-radius: var(--ffc-r-md);
	/* 本体自己的设置卡片就是 --dsw-alias-settings-card-fill（= bg-layer-2）；
	   深色下 layer-2 比 bg-base 亮一档，卡片才是「抬起来的一张」，
	   用 layer-1 会跟页面底几乎同色。 */
	background: var(--ffc-card-surface);
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
	border-radius: var(--ffc-r-sm);
	background: var(--dsw-alias-bg-base);
	color: var(--dsw-alias-label-primary);
	font-family: inherit;
	font-size: 13px;
	outline: none;
}

/* 聚焦态用强调色（本体输入框也是 --dsw-alias-state-business-primary）；
   原来用的是 brand-primary，那逐字等于 label-primary —— 浅色下几乎看不出聚焦。 */
.ffc-set-input:focus {
	border-color: var(--ffc-accent);
}

.ffc-set-input::placeholder {
	color: var(--dsw-alias-label-dimmed);
}

/* 设计技能那块的多行文案（P41）：借 .ffc-set-input 的全部外观，只放开高度 ——
   那条 30px 的定高对 textarea 是一行还竖着裁半行。宽窄由卡片的 flex 列自己给。 */
.ffc-set-textarea {
	height: auto;
	min-height: 104px;
	padding: 6px 8px;
	line-height: 18px;
	resize: vertical;
}

/* P45 · 设计技能「放大」按钮 + 放大编辑窗：settings 那栏窄，长文案不好改。
   按钮直接借 .ffc-tbtn（外观 / hover / 焦点环全自带），这里只补排版。 */
.ffc-set-labelrow {
	display: flex;
	align-items: center;
	gap: 8px;
}

.ffc-set-labelrow .ffc-set-label {
	flex: 1;
	min-width: 0;
}

/* 覆盖层：整页压暗，卡片居中；跟本体浮层同语言 border:0 + elevation-prominent */
.ffc-set-big {
	position: fixed;
	inset: 0;
	z-index: 60;
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 24px;
	box-sizing: border-box;
	background: var(--ffc-scrim);
}

.ffc-set-big-card {
	display: flex;
	flex-direction: column;
	gap: 8px;
	width: min(880px, 100%);
	max-height: 86vh;
	padding: 16px;
	box-sizing: border-box;
	border-radius: var(--ffc-r-lg);
	background: var(--ffc-card-surface);
	box-shadow: var(--dsw-elevation-prominent, var(--dsw-shadow-lv2, 0 8px 24px rgba(0, 0, 0, 0.16)));
}

/* 大窗里那块文本：借 .ffc-set-textarea 的外观，只把空间放开 */
.ffc-set-big-text {
	flex: 1;
	min-height: 280px;
	resize: none;
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
	border-color: var(--ffc-accent);
	color: var(--ffc-accent);
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
	border-radius: var(--ffc-r-md);
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
	border-radius: var(--ffc-r-sm);
	/* 模型行是卡片里的凹陷槽（深色下比卡片暗一档），见 --ffc-well-surface */
	background: var(--ffc-well-surface);
}

.ffc-set-model[data-editing='true'] {
	border-color: var(--ffc-accent);
}

/* 种类徽标。模型行与「常用模型」行**共用这一套** —— 两个类名各自保留，是为了让
   「只数模型行的徽标」那条断言还数得准；样式本身不再各写一份（这两份曾经逐字
   重复，改一处忘一处是迟早的事）。 */
.ffc-set-kind,
.ffc-cm-kind {
	flex: none;
	font-size: 11px;
	line-height: 16px;
	padding: 0 6px;
	border-radius: var(--ffc-r-xs);
	background: var(--ffc-chip-surface);
	color: var(--dsw-alias-label-secondary);
}

/* 图像 / 视频 / 视觉各给一个**固定**淡色（不随主题反色）：它们要压在浅深两种底上
   都看得清；语义上也不属于 success / warn 任何一档，所以不走主题 token。 */
.ffc-set-kind[data-kind='image'],
.ffc-cm-kind[data-kind='image'] {
	background: var(--ffc-tint-image);
	color: var(--dsw-alias-label-primary);
}

.ffc-set-kind[data-kind='video'],
.ffc-cm-kind[data-kind='video'] {
	background: var(--ffc-tint-video);
	color: var(--dsw-alias-label-primary);
}

/* 视觉模型：它是「眼睛」而不是产物，用偏绿的一档区分 */
.ffc-set-kind[data-kind='vision'],
.ffc-cm-kind[data-kind='vision'] {
	background: var(--ffc-tint-vision);
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
	color: var(--ffc-accent);
}

/* 模型行上的「档位 low/high」记号（挂在这个家族上的质量轴声明） */
.ffc-set-tierstate {
	flex: none;
	font-size: 11px;
	line-height: 16px;
	padding: 0 6px;
	border-radius: var(--ffc-r-xs);
	background: var(--ffc-chip-surface);
	color: var(--dsw-alias-label-secondary);
}

/* 「配档位参数…」内联编辑器里的参数名输入框：短，取值那个占剩下的 */
.ffc-set-tiersparam {
	flex: none;
	width: 110px;
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
	border-radius: var(--ffc-r-sm);
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
 * 数值抄自本体官方 dsh-client-ui-model-selection 的 ModelSelect.module.css
 * （菜单 specific-menu 底 + --dsw-radius-lg 圆角 + elevation-prominent 阴影 +
 * sticky 分组标题 + 34px 行高 + 13px/400 模型名）。
 * 「字体质感」没有捷径：只能与本体用同一批数值、同一批 token、同一批图标。
 *
 * 位置：注册进 conversation.input.right —— composer bar 的渲染顺序是
 * input.right → input.model → 用量环 → 发送，所以它落在本体模型位的紧左边。
 *
 * P39 起触发器**只有一枚鲸鱼尾巴**（模型名搬进菜单顶部那一行），家族行的档位
 * 开在菜单右侧的飞出面板里 —— 两件事的理由都写在 ModelPicker.tsx 的文件头。
 *
 * ⚠️ 本文件是 JS 模板字符串，注释里不能出现反引号。 */

.ffc-mp-root {
	position: relative;
	min-width: 0;
}

/* 触发器：**只有一枚图标**（P39 用户要的「主界面只留下一个图标」）。
 *
 * 尺寸与本体同一行里那些图标格一致（28×28），图形是那枚 17px 的鲸鱼尾巴 ——
 * 与右上角入口**同一个组件、同一个尺寸**，颜色走 currentColor 落到尾巴上。
 * ⚠️ flex: none 与 .ffc-entry 上那条同理：composer 行是 flex 行，默认的
 * flex-shrink:1 在窄行里会把它压成 0 宽 —— 元素还在、却完全点不到。
 * ⚠️ 这里**不再**有文字，所以原来那批 font-size / line-height / max-width 全部删掉：
 * 留着它们只会在换行宽时悄悄改掉热区。 */
.ffc-mp-trigger {
	box-sizing: border-box;
	width: 28px;
	height: 28px;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	flex: none;
	padding: 0;
	border: none;
	border-radius: var(--ffc-r-sm);
	outline: none;
	background: transparent;
	color: var(--dsw-alias-label-secondary);
	cursor: pointer;
}

.ffc-mp-trigger:hover:not(:disabled) {
	background: var(--dsw-alias-interactive-bg-hover);
}

.ffc-mp-trigger:focus-visible {
	box-shadow: 0 0 0 var(--ffc-focus-width) var(--ffc-focus-ring);
}

.ffc-mp-trigger:disabled {
	color: var(--dsw-alias-label-dimmed);
	cursor: default;
}

/* 选过模型的读数（用户要的「选择之后，小鱼尾巴变成蓝色」）：
 * 强调色 = state-business-primary（不是 brand-primary，那是对比色，见 NOTES §8.62）。
 * 一个 color 就够两半都变色 —— 静止那枚填的是 currentColor、会摇那枚是 background。 */
.ffc-mp-trigger[data-ffc-picked='true'] {
	color: var(--ffc-accent);
}

/* 设计技能的关闭读数（这条尾巴还是那个开关，用户要的「关闭后变成默认的纯色」）。
 * 渲染上只有关闭态才写 data-ffc-skill='false'，因此开着时上面那条照常工作
 * （默认观感不变）；关闭必须排在它后面 —— 同等优先级时后写的赢。 */
.ffc-mp-trigger[data-ffc-skill='false'] {
	color: var(--dsw-alias-label-secondary);
}

/* 菜单顶部：**当前选中的模型名**。
 * 触发器上不再有文字（用户要的「点了才看得见」），这一行就是那个「看得见」。 */
.ffc-mp-head {
	display: flex;
	flex-direction: column;
	gap: 1px;
	padding: 6px 8px 8px;
}

.ffc-mp-headKind {
	color: var(--dsw-alias-label-tertiary);
	font-size: 12px;
	line-height: 16px;
}

.ffc-mp-headName {
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	color: var(--dsw-alias-label-primary);
	font-size: 14px;
	font-weight: 500;
	line-height: 20px;
}

/* 家族行上那个箭头：指向**右边**（档位开在右边那块飞出面板里），开着时转成朝下。
 * 与旧版（朝下 ⟷ 朝上，那时是行内展开）方向相反 —— 方向就是「东西在哪边」。 */
.ffc-mp-chevron {
	flex: none;
	display: inline-flex;
	align-items: center;
	color: var(--dsw-alias-label-caption);
	transform: rotate(-90deg);
	transition: transform var(--ffc-transition-fast);
}

.ffc-mp-chevron[data-open='true'] {
	transform: rotate(0deg);
}

/* 浮层容器：菜单与飞出面板的**共同祖先**（两者不是父子，但必须是「同一块浮层」）。
 *
 * 为什么必须有这一层：useMenuDismiss 只查一个 ref —— 点飞出面板里的档位不算
 * 「点到外面」。少了它，pointerdown 会先把面板卸掉、随后的 click 找不到目标，
 * 整块面板看着能点却点不动（NOTES §8.48 那个坑）。
 * ⚠️ pointer-events: none 必须在这一层、auto 在两个面板上：容器铺满视口，
 * 少了这一对，它会替整个页面挡下所有点击。 */
.ffc-mp-layer {
	position: fixed;
	inset: 0;
	z-index: 1100;
	pointer-events: none;
	/* 焦点是 JS 打上来的（role=menu + tabIndex=-1），这层不该有焦点环 */
	outline: none;
}

/* 菜单与飞出面板共用同一条外观（材质 / 圆角 / 阴影 / 字体 / 行高都一致），
 * 差的那几处在这个规则之后单独覆写。 */
.ffc-mp-menu,
.ffc-mp-flyout {
	position: fixed;
	pointer-events: auto;
	box-sizing: border-box;
	display: flex;
	flex-direction: column;
	width: max-content;
	min-width: min(240px, 100vw - 32px);
	max-width: min(420px, 100vw - 32px);
	max-height: min(360px, 100vh - 96px);
	padding: 4px;
	/* 圆角与发丝描边都跟本体走：本体的菜单圆角来自 MenuSurface
	   （--dsw-radius-lg，不是 20px），描边色由菜单自己重绑成 border-l1。 */
	border: 0;
	border-radius: var(--ffc-r-lg);
	--dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
	background: var(--ffc-material);
	/* 菜单底是**半透明**的（--dsw-specific-menu = #43454a73，45%），本体每个菜单
	   都配了同一颗模糊（ui-conversation 的 panel / ui-chat 的浮层同款）：
	   少了它菜单就是一张能看见底下正文的塑料膜，字直接糊在一起。 */
	backdrop-filter: var(--ffc-material-blur);
	color: var(--dsw-alias-label-primary);
	box-shadow: var(--dsw-elevation-prominent, var(--dsw-shadow-lv2, 0 8px 24px rgba(0, 0, 0, 0.16)));
	overflow: hidden;
	font-family: var(--dsw-font-family);
	--dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
	--dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
}

/* 飞出面板（P39）：家族行悬停时从菜单右侧「跳出来」的那块。
 * 比菜单窄一档（里面是档位名，不是模型清单），滚动挂在它自己身上
 * （菜单里滚动的是 .ffc-mp-groups）。
 * ⚠️ 别再给它套一层带 backdrop-filter 的容器：容器一旦带它就成了新的 backdrop
 * root，嵌在里面的浮层只会去模糊容器的内容，看起来是平的（NOTES §3.39）。 */
.ffc-mp-flyout {
	min-width: min(180px, 100vw - 32px);
	max-width: min(300px, 100vw - 32px);
	max-height: min(300px, 100vh - 96px);
	overflow-y: auto;
	overflow-x: hidden;
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
	border-radius: var(--ffc-r-md);
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
	box-shadow: 0 0 0 var(--ffc-focus-width) var(--ffc-focus-ring);
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
	/* 吸顶分组标题用本体那颗**专用**的 94% 不透明底：用菜单材质（浅色 58% /
	   深色 45% 半透明）的话，滚上来的行会从标题底下透出来。 */
	background: var(--dsw-alias-menu-group-header-fill, var(--ffc-material));
	color: var(--dsw-alias-label-tertiary);
	font-size: 12px;
	font-weight: 500;
	line-height: 18px;
}

/* ⚠️ 行高 / 内边距 / 圆角 / 字重全部对齐本体 _7KE1Ra_option：
   min-height 34px、padding 5px 7px、gap 6px、border-radius --dsw-radius-md、
   模型名 13px/400/18px。本体的「对话模型」菜单就挂在同一个 composer 行上，
   这两份菜单是并排被看到的 —— 行高一差 4px 谁都看得出来「不是一家」。 */
.ffc-mp-option {
	box-sizing: border-box;
	width: 100%;
	min-height: 34px;
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 5px 7px;
	border: none;
	border-radius: var(--ffc-r-md);
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
	font-size: 13px;
	font-weight: 400;
	line-height: 18px;
}

/* 这是**唯一**一处刻意偏离本体取值的地方：本体的勾用主文字色，这里用强调色。
   理由是插件自己的菜单（.ffc-menu-check）已经是强调色的勾，两套选择器挨在
   同一条 composer 行上却勾出两种颜色，比「与本体逐字相同」更扎眼。 */
.ffc-mp-check {
	flex: 0 0 18px;
	display: grid;
	place-items: center;
	color: var(--ffc-accent);
}

/* ── 档位：家族行 + 展开出来的分辨率/质量两排 ── */

/* 家族行就是 .ffc-mp-option 加一颗档位药丸与一个箭头，鼠标态与普通行共用 */
.ffc-mp-family {
	gap: 6px;
}

.ffc-mp-tier {
	flex: none;
	padding: 1px 6px;
	border-radius: var(--ffc-r-xs);
	background: var(--dsw-alias-interactive-bg-hover);
	color: var(--dsw-alias-label-caption);
	font-size: 12px;
	font-weight: 500;
	line-height: 16px;
}

/* 展开出来的子行比家族行矮一档。
   这里原来还有一条「子行名字 13px/400」—— 基线改成 13px/400 之后它与基线
   逐字相同、已经不起作用了，直接删掉而不是留着当死规则。
   （P39 起子行住在 .ffc-mp-flyout 里，那条 .ffc-mp-sub 的左细线规则也一起删了：
   面板自己就是一块浮层，不再需要「这几行属于上面那一行」的视觉从属。） */
.ffc-mp-option[data-indent='true'] {
	min-height: 28px;
}

/* 质量档 chip 那一排：参数名（小字）+ 几个可点的药丸 */
.ffc-mp-tierrow {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 6px;
	padding: 4px 8px 6px;
}

.ffc-mp-tiername {
	color: var(--dsw-alias-label-tertiary);
	font-size: 12px;
	line-height: 18px;
}

/* 「选档即用此模型」：点档位同时会选用这个模型，不写出来没人猜得到 */
.ffc-mp-tierhint {
	color: var(--dsw-alias-label-dimmed);
	font-size: 11px;
	line-height: 18px;
}

.ffc-mp-chip {
	box-sizing: border-box;
	height: 24px;
	display: inline-flex;
	align-items: center;
	gap: 4px;
	padding: 0 10px;
	border: none;
	border-radius: var(--ffc-r-sm);
	outline: none;
	background: transparent;
	color: var(--dsw-alias-label-secondary);
	font-family: inherit;
	font-size: 12px;
	font-weight: 500;
	line-height: 24px;
	cursor: pointer;
}

.ffc-mp-chip:hover,
.ffc-mp-chip[data-nav-active='true'] {
	background: var(--dsw-alias-interactive-bg-hover);
	color: var(--dsw-alias-label-primary);
}

/* 选中的档位：勾 + 亮字 + 一圈描边。
   刻意**不用** --dsw-alias-bg-layer-* 做填充：浅色主题下 layer-1 与菜单用的
   layer-3 都是白的，选中的 chip 会整个看不见（同类坑：NOTES §8 的不透明 token）。 */
.ffc-mp-chip[data-active='true'] {
	background: var(--dsw-alias-interactive-bg-hover);
	color: var(--dsw-alias-label-primary);
	box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l3);
}

.ffc-mp-chip:focus-visible {
	box-shadow: 0 0 0 var(--ffc-focus-width) var(--ffc-focus-ring);
}

.ffc-mp-empty,
.ffc-mp-note {
	padding: 10px;
	color: var(--dsw-alias-label-tertiary);
	font-size: 13px;
	line-height: 20px;
}

/* 「其他模型（N）」：勾过常用之后，没勾的那些收在这一行后面 */
.ffc-mp-more {
	box-sizing: border-box;
	width: 100%;
	padding: 6px 8px;
	border: none;
	border-radius: var(--ffc-r-md);
	background: transparent;
	color: var(--dsw-alias-label-tertiary);
	font-family: inherit;
	font-size: 12px;
	line-height: 18px;
	text-align: left;
	cursor: pointer;
}

.ffc-mp-more:hover,
.ffc-mp-more:focus-visible {
	background: var(--dsw-alias-interactive-bg-hover);
	color: var(--dsw-alias-label-primary);
}

.ffc-mp-note[role='alert'] {
	color: var(--dsw-alias-state-error-primary);
}

/* ─────────── 设置页：常用模型（按家族一行） ─────────── */

.ffc-cm-row {
	display: flex;
	flex-direction: column;
	gap: 6px;
	padding: 8px 10px;
	border: 1px solid var(--dsw-alias-border-l1);
	border-radius: var(--ffc-r-sm);
	/* 原来填 bg-base（= 设置页自己的底色），浅色下这行就只剩一圈描边；
	   深色下它也跟页面同色。改用卡片面，两套主题下才都是「一张行卡」。 */
	background: var(--ffc-card-surface);
}

.ffc-cm-head {
	display: flex;
	align-items: center;
	gap: 8px;
}

.ffc-cm-pin {
	display: flex;
	align-items: center;
	gap: 4px;
	flex: none;
	font-size: 12px;
	line-height: 18px;
	color: var(--dsw-alias-label-secondary);
	cursor: pointer;
}

.ffc-cm-name {
	font-size: 13px;
	line-height: 20px;
	font-weight: 600;
	color: var(--dsw-alias-label-primary);
}

/* 家族成员（含 -2k / -4k 兄弟）：等宽字体，方便一眼看出是哪几个 id */
.ffc-cm-members {
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-family: var(--dsw-font-family-mono, monospace);
	font-size: 11px;
	line-height: 16px;
	color: var(--dsw-alias-label-tertiary);
}

.ffc-cm-line {
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	gap: 6px;
}

.ffc-cm-key {
	flex: none;
	width: 30px;
	font-size: 11px;
	line-height: 16px;
	color: var(--dsw-alias-label-tertiary);
}

.ffc-cm-axis {
	font-size: 12px;
	line-height: 18px;
	color: var(--dsw-alias-label-secondary);
}

.ffc-cm-param {
	display: flex;
	align-items: center;
	gap: 4px;
}

/* .ffc-cm-kind（「常用模型」行的种类徽标）的形状与配色在上面与 .ffc-set-kind
   共用同一条规则，这里不再重复一份 —— 两份并存时改一处忘一处，徽标就会
   在设置页的两个区块里长得不一样。 */

.ffc-cm-paramlabel {
	font-size: 11px;
	line-height: 16px;
	color: var(--dsw-alias-label-tertiary);
}

.ffc-cm-paraminput {
	width: 116px;
	height: 26px;
	font-size: 12px;
}

.ffc-cm-paramname {
	width: 110px;
}

.ffc-cm-paramvalues {
	flex: 1;
	min-width: 160px;
}

.ffc-cm-addkey {
	display: flex;
	align-items: center;
	gap: 4px;
}

.ffc-cm-drop {
	padding: 0 6px;
}

/* ─────────── 聊天侧：media_generate 的工具行（keyed tool view） ─────────── */

.ffc-tool {
	display: flex;
	flex-direction: column;
	gap: 6px;
	padding: 8px 10px;
	box-sizing: border-box;
	border: 1px solid var(--dsw-alias-border-l1);
	border-radius: var(--ffc-r-md);
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
	color: var(--ffc-accent);
}

/* 生成中的工具行：脉动去掉，改由那枚摇尾巴的鲸鱼表达。 */

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
	border-radius: var(--ffc-r-xs);
	background: var(--ffc-chip-surface);
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
	border-radius: var(--ffc-r-sm);
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

/* 留档失败那一行（P32）：与普通提示同形，但要用错误色点出来 */
.ffc-tool-note[data-kind='error'] {
	color: var(--dsw-alias-state-error-primary);
}

/* ─────────── 聊天侧：用户消息（影子席位）+「复制（含图）」 ───────────
   本体的 CSS 类是哈希类名，插件拿不到，因此这一套是自己写的；
   取的是同一批 DSH 变量，观感接近本体气泡（不是像素级相同）。
   背景/圆角/行高照抄本体 UserStyleBubble 的取值，改之前先看一眼那边。 */

.ffc-msg {
	display: flex;
	flex-direction: column;
	align-items: flex-end;
	gap: 6px;
	width: 100%;
	box-sizing: border-box;
	font-family: var(--dsw-font-family);
}

.ffc-msg-stack {
	display: flex;
	flex-direction: column;
	align-items: flex-end;
	gap: 8px;
	min-width: 0;
	max-width: 82%;
}

.ffc-msg-images {
	display: flex;
	flex-wrap: wrap;
	justify-content: flex-end;
	gap: 6px;
	max-width: 100%;
}

.ffc-msg-image {
	display: inline-flex;
	min-width: 0;
}

.ffc-msg-bubble {
	background: var(--dsw-specific-bubble);
	max-width: 100%;
	box-sizing: border-box;
	font-size: var(--dsh-content-font-size, 14px);
	line-height: calc(22px + var(--dsh-content-font-delta, 0px));
	color: var(--dsw-alias-label-primary);
	white-space: pre-wrap;
	word-break: break-word;
	border-radius: 22px;
	padding: 10px 16px;
}

.ffc-msg-note {
	font-size: var(--dsh-content-font-size-secondary, 13px);
	line-height: calc(18px + var(--dsh-content-font-delta-secondary, 0px));
	color: var(--dsw-alias-label-tertiary);
	word-break: break-word;
}

.ffc-msg-note[data-kind='error'] {
	color: var(--dsw-alias-state-error-primary);
}

.ffc-msg-extra {
	margin: 0;
	max-width: 100%;
	max-height: 160px;
	overflow: auto;
	font-size: 12px;
	line-height: 18px;
	color: var(--dsw-alias-label-secondary);
	background: var(--ffc-chip-surface);
	border-radius: var(--ffc-r-sm);
	padding: 6px 8px;
}

.ffc-msg-actions {
	display: flex;
	align-items: center;
	justify-content: flex-end;
	gap: 8px;
	min-height: 24px;
}

.ffc-msg-time {
	font-size: var(--dsh-content-font-size-secondary, 13px);
	color: var(--dsw-alias-label-tertiary);
	white-space: nowrap;
}

/* 图标按钮：**照本体那条复制按钮的尺寸与配色**（用户要求「按原版的复制按钮来」）。
   取值来自 ui-chat 的 MessageIconActions.module.css：28px 圆形、透明底、三级文字色、
   15px 图标、hover 用 --dsw-alias-interactive-bg-hover。改之前先对一眼那边。 */

.ffc-msg-action {
	width: calc(28px + var(--dsh-content-font-delta, 0px));
	height: calc(28px + var(--dsh-content-font-delta, 0px));
	display: inline-flex;
	align-items: center;
	justify-content: center;
	padding: 6px;
	border: none;
	border-radius: 28px;
	corner-shape: round;
	background: 0 0;
	color: var(--dsw-alias-label-tertiary);
	cursor: pointer;
}

.ffc-msg-action svg {
	width: calc(15px + var(--dsh-content-font-delta, 0px));
	height: calc(15px + var(--dsh-content-font-delta, 0px));
}

.ffc-msg-action:hover:not(:disabled) {
	background: var(--dsw-alias-interactive-bg-hover);
	color: var(--dsw-alias-label-secondary);
}

.ffc-msg-action:disabled {
	cursor: default;
	opacity: 0.45;
}

/* 成功那一枚换成勾（与本体一致），并短暂染上品牌色 */
.ffc-msg-action[data-state='done'] {
	color: var(--dsw-alias-brand-primary);
}

.ffc-msg-action[data-state='done']:hover {
	background: 0 0;
}

/* ─────────── 动效层（P37）· 苹果那套「短、只动该动的、不跟手势抢」 ───────────
 *
 * 加动效之前先对一眼这四条，它们互斥，别混着用：
 *   1. **状态色**（hover / 按下 / 选中 / 聚焦）走 --ffc-transition-fast（100ms 快出）：
 *      指针扫过一排按钮不会拖出一条尾巴。卡片阴影仍走 200ms 那一档 ——
 *      东西越大越慢，这是同一套物理直觉，不是随手取的数。
 *   2. **按下缩放只给小控件**：transform 会把**热区**一起缩掉，而按下期间的
 *      pointerup 一旦落到元素外，click 就不派发到它身上（按了没反应）。
 *      所以缩的只有**按钮量级**的控件（缩 4% = 边缘让出 ≤ 3px）；
 *      360px 的模型触发器会让出 7px、菜单行缩了更明显 —— 它们一律只做颜色反馈。
 *   3. **入场动画**只做 opacity + 几像素位移或 3–4% 缩放，160–200ms，并且
 *      从**它挂着的那个角**长出来（transform-origin）—— 凭空在原地淡入像贴纸，
 *      从锚点长出来才是「这个菜单是从那个按钮来的」。
 *   4. **跟着指针走的东西一律不加**：框选矩形、对齐辅助线、拖拽中的面板宽度全部即时。
 *      直接操纵的反馈延迟一帧就是不跟手，那比缺一段动画难看得多。
 *
 * ⚠️ transition 仍然只能用 --ffc-transition / --ffc-transition-fast（test-icon.mjs 有守卫）；
 *    动画一律命名 ffc-* —— 末尾的 reduced-motion 用一条 [class*='ffc-'] 全关，
 *    以后新增动画不必回去补选择器（守卫会查动画名与 @keyframes 对不对得上）。 */

/* 1 · 状态色：所有带 hover / 选中 / 聚焦态的叶子控件。
   只列真正会变的属性 —— 不用 all：那会把 padding / width 这类布局属性
   也变成动画，一帧一次 layout，且没人知道哪些属性在动。 */
.ffc-tbtn,
.ffc-badge-btn,
.ffc-menu-item,
.ffc-menu-chip,
.ffc-set-input,
.ffc-set-addbtn,
.ffc-set-model,
.ffc-set-status,
.ffc-set-msg,
.ffc-set-keystate,
.ffc-set-tierstate,
.ffc-mp-trigger,
.ffc-mp-tab,
.ffc-mp-option,
.ffc-mp-chip,
.ffc-mp-more,
.ffc-tool-link,
.ffc-msg-action,
.ffc-node-act,
.ffc-entry,
.ffc-cm-addkey {
	transition:
		background-color var(--ffc-transition-fast),
		border-color var(--ffc-transition-fast),
		box-shadow var(--ffc-transition-fast),
		color var(--ffc-transition-fast),
		opacity var(--ffc-transition-fast),
		transform var(--ffc-transition-fast);
}

/* 卡片上的播放键：露出 / 收起跟**卡片**同一拍（200ms，和阴影抬起同步），
   但它自己按下 / 悬停是个小控件，走快那档。 */
.ffc-node-play {
	transition:
		opacity var(--ffc-transition),
		background-color var(--ffc-transition-fast),
		transform var(--ffc-transition-fast);
}

/* 2 · 按下：缩 4%（这条列表就是「按钮量级」的白名单 —— 加新控件前先看上面第 2 条） */
.ffc-tbtn:active,
.ffc-badge-btn:active,
.ffc-entry:active,
.ffc-node-act:active,
.ffc-msg-action:active,
.ffc-menu-chip:active,
.ffc-mp-chip:active,
.ffc-set-addbtn:active {
	transform: scale(var(--ffc-press));
}

/* 播放键自己是 translate(-50%,-50%) 居中的：缩放必须**接着**那条写，
   写成裸 scale() 会把它一把甩到卡片左上角。 */
.ffc-node-play:active {
	transform: translate(-50%, -50%) scale(var(--ffc-press));
}

/* 3 · 入场 */

/* 挂载点在上（菜单都开在触发器下方）：缩小 + 往上 2px 一起收，
   于是第一帧看起来就是「从锚点里长出来」。 */
@keyframes ffc-pop-in {
	from {
		opacity: 0;
		transform: scale(0.96) translateY(-2px);
	}
}

/* 反过来那支：缩放菜单开在缩放条**上方**，从下沿长出来 */
@keyframes ffc-pop-up {
	from {
		opacity: 0;
		transform: scale(0.96) translateY(2px);
	}
}

@keyframes ffc-node-in {
	from {
		opacity: 0;
		transform: scale(0.97);
	}
}

@keyframes ffc-fade-in {
	from {
		opacity: 0;
	}
}

/* 聊天里的富块用它：本体自己的入场就是「淡入 + 抬 4px」（ui-chat 的
   turn-preview-enter 逐字是 translate(4px)），跟着它走才像同一个应用。 */
@keyframes ffc-rise-in {
	from {
		opacity: 0;
		transform: translateY(4px);
	}
}

/* 菜单：.ffc-menu 的 left/top 就是锚点（触发器左下 / 右键那一点），
   所以从 top left 长出来；.ffc-model-menu / .ffc-preset-menu 也带 .ffc-menu。
   .ffc-mp-flyout 用同一条：它贴的是那一行的左上角。 */
.ffc-menu,
.ffc-mp-menu,
.ffc-mp-flyout {
	animation: ffc-pop-in 160ms var(--ffc-ease-out);
	transform-origin: top left;
}

.ffc-zoom-menu {
	animation: ffc-pop-up 160ms var(--ffc-ease-out);
	transform-origin: bottom left;
}

/* 节点落下来（生成开始时的「生成中」占位也走这条）。
   ⚠️ 入场用 transform 缩放是**有前提**的：拖拽起点取节点**中心**（中心不随缩放移动），
   框选命中走**模型坐标**（rectsIntersect 吃的是 x/y/w/h，不是 DOM rect），
   所以这 3% 不会污染任何几何判据。哪天有代码改成读节点的 getBoundingClientRect()，
   这条动画就得跟着改（读到的会比真实小 3%）。 */
.ffc-node {
	animation: ffc-node-in 200ms var(--ffc-ease-out);
}

/* 卡片里那一格换了内容：占位 → 出图 / 出错。整块是同一尺寸的槽，
   所以只淡入、不动位置（动位置会让网格里其他节点看着像被推了一下）。 */
.ffc-node-el,
.ffc-node-pending,
.ffc-node-failed {
	animation: ffc-fade-in 200ms var(--ffc-ease-out);
}

/* 聊天里的富块（媒体工具行 / 附加上下文）挂载时抬 4px 淡入 */
.ffc-msg,
.ffc-tool {
	animation: ffc-rise-in 200ms var(--ffc-ease-out);
}

/* 设置页的「已保存 / 报错」那一行 */
.ffc-set-msg {
	animation: ffc-fade-in 160ms var(--ffc-ease-out);
}

/* ─────────── 减少动效（prefers-reduced-motion） ───────────
 *
 * 过渡：整个文件只有两个过渡时长来源：--ffc-transition 与 --ffc-transition-fast。
 * 所以这里把这两个变量压成 1ms 就**全量**关掉了 hover / 淡入 / 箭头翻转 / 按下缩放 ——
 * 不需要逐条列举选择器，也不会因为以后新增控件而漏掉。
 * 这正是上面要求「所有 transition 都必须走这两个变量」的原因。
 *
 * 入场动画：时长写死在关键帧调用处（关键帧本身没法用变量表达时长），
 * 但插件的类全带 ffc- 前缀，于是一条通配同样**全量**关掉，不必逐条列举。
 * 压 duration 而不是 animation:none —— 保留「动画放完 = 回到自然状态」的语义，
 * 元素不会停在 from 那一帧（透明）。
 *
 * 剩下只有两处写死时长的动效（不能用变量表达），单独关：
 *   - .ffc-sent-notice 的入场动画
 *   - 世界层与点阵的 240ms 程序化移动（已在上面的 @media 里单独处理）
 *
 * ⚠️ 还有一类压不住：鲸鱼尾巴的摇动是**帧动画**（APNG 遮罩在走，不是 CSS 动画），
 *    duration 那条通配对它无效 —— 它自己那条 @media (no-preference) 就是为这个
 *    存在的：减少动效时压根不切到会摇的那枚。 */
@media (prefers-reduced-motion: reduce) {
	body {
		--ffc-transition: 1ms linear;
		--ffc-transition-fast: 1ms linear;
	}

	[class*='ffc-'] {
		animation-duration: 1ms !important;
	}

	.ffc-sent-notice {
		animation: none;
	}
}
`;
