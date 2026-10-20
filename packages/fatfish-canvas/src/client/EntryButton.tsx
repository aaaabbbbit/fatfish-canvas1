/**
 * 会话头部右上角的鲸鱼尾巴入口（聊天 ⟷ 画布）。P10：回到右上角，但换了席位。
 *
 * ## 为什么能回右上角（P8 曾经不能）
 *
 * P8 把入口从浮层搬进 composer 工具行，理由是「浮层压别人是这个做法本身的属性」：
 * 它当时是 `shell.overlay` 里一张 `position: fixed; top:10px; right:12px` 的**贴纸**，
 * 而视口右上角正是聊天区头部右对齐的 Session utilities 席位
 * （`dsh-session-log-export` 占了它）—— 于是入口正好压在 session log 上。
 *
 * P10 要的是「就在右上角，而且进画布后位置不变」，所以这次不谈像素，改谈**席位**：
 * 入口注册进 `conversation.session.header.utilities` —— session log 住的**同一个
 * 席位**。它是布局自己排出来的一行 flex（`gap: 8px`），条目之间互不重叠，
 * 因此「不压住 session log」是结构事实，不是调出来的间距。
 *
 * ## 位置为什么在两种模式下不变
 *
 * 这个席位右对齐在聊天列头部。并排画布模式下 AppFrame 被钉在
 * `left: var(--ffc-canvas-width); right: 0`，聊天列右缘就是视口右缘 ——
 * 于是入口在聊天模式与并排画布模式下**落在同一个屏幕位置**。
 *
 * 纯画布模式（canvas-only）例外：那时聊天列整列收起，头部跟着不存在，
 * 也就没有这个按钮 —— 退出纯画布走**顶栏的「纯画布」按钮**或 Esc，
 * 两者都在画布自己身上，不会跟着聊天列一起消失。
 *
 * P49 补上同一个洞的另一半：**没有当前会话**（欢迎页）时这个席位整行都不渲染，
 * 而画布模式是记住的（刷新会直接落回画布）—— 那时顶栏那格「返回聊天」就是
 * 唯一的出口。原则：**出口必须跟着画布自己走**，不能只住在会话作用域的席位上。
 *
 * ## 只有一件事：单击切换
 *
 * 聊天 = 进画布（上一次用的画布模式），画布 = 回聊天。视图模式与画布宽度
 * 的**选择**已从界面上移除（P10）；纯画布是顶栏上独立的一个按钮。
 * 因此这里既没有菜单也没有第二层：一个按钮、一次点击、一个布尔状态
 * （`toggleCanvasMode()` 就是那一个状态的全部实现）。
 *
 * 按钮里**只有图形**（P10 收尾时去掉了「画布 / 聊天」两个字）：那一行紧挨着
 * 111px 的 session log，少两个字就是少 42px 挤压；语义由 title 与 aria-label 承担。
 *
 * ⚠️ 本席位是**会话作用域**：没有当前会话时（新会话欢迎页）它不存在，
 * 那时进入画布靠快捷键 `Ctrl/⌘ + Shift + B`（按钮 title 里就写着这个），
 * **退出**靠画布顶栏那格常驻的「返回聊天」（P49，见 `CanvasPanel.tsx`）。
 *
 * ⚠️ 图形是 **DSH 原生那枚鲸鱼尾巴**（P38 换掉了原来的米饭碗位图）：静止态是
 * APNG 的第 0 帧，**鼠标放上去就摇**（`styles.ts` 里 `.ffc-entry:hover .ffc-whale`
 * 把遮罩换成动图）—— 悬停态是纯 CSS 事实，这里一行状态都不用加。
 *
 * @module fatfish-canvas/client/EntryButton
 */

import type { ReactNode } from 'react';
import { WhaleTailIcon } from './icons';
import { VIEW_SHORTCUT_LABEL } from './shortcut';
import { toggleCanvasMode, useViewMode } from './state';

/**
 * 鲸鱼尾巴入口按钮（会话头部右上角）。
 *
 * 只有图形，没有文字：一个 32×32 的鲸鱼尾巴是这一格的全部内容 —— 它标记的是
 * 「肥鱼画布」这个去处，而不是当前状态；状态与动作由 title / aria-label 说
 * （进画布后同一个图标就是回聊天的路）。文字版曾写在按钮里，P10 收尾时去掉：
 * 同一行里紧挨着 111px 的 session log，多两个字只会让这排更挤。
 * @returns 按钮；任何模式下都渲染（纯画布模式除外，那时席位本身不存在）。
 */
export function CanvasEntryButton(): ReactNode {
	const mode = useViewMode();
	const inCanvas = mode !== 'chat';

	return (
		<button
			type="button"
			className="ffc-entry"
			data-ffc-ui="entry"
			title={
				inCanvas
					? `返回聊天界面（${VIEW_SHORTCUT_LABEL} 快速切换）`
					: `进入肥鱼画布（${VIEW_SHORTCUT_LABEL} 快速切换）`
			}
			aria-label={inCanvas ? '返回聊天界面' : '进入肥鱼画布'}
			onClick={() => {
				// 一次点击一个状态：聊天 ⟷ 上一次用的画布模式（state.ts 里就这一处实现）
				toggleCanvasMode();
			}}
		>
			<WhaleTailIcon size={17} />
		</button>
	);
}
