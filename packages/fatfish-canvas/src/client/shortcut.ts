/**
 * 视图快捷键（P4）。
 *
 * `Ctrl/⌘ + Shift + B` 在「聊天」与「上一次用的画布模式」之间来回切。
 * 选这个键位的理由：B = Board，浏览器没有默认绑定（`Ctrl+Shift+C` 会撞
 * DevTools 的「检查元素」）。
 *
 * 两条必须守住的规矩：
 *   1. **焦点在输入框里时让路** —— 右侧就是本体原生聊天，抢键会毁掉输入；
 *   2. 处理过就 `preventDefault`，避免同时触发浏览器的默认行为。
 *
 * @module fatfish-canvas/client/shortcut
 */

import type { Context } from '@deepseek-ai/cordis';
import { isEditableTarget } from './dom';
import { getMode, setMode, toggleCanvasMode, type ViewMode } from './state';

/**
 * 快捷键的展示文案（按钮 title、菜单提示都用它）。
 *
 * 定义在这里而不是某个组件里：入口按钮与画布顶栏菜单都要显示它，
 * 两个组件各自复制一份迟早会漂移成两种写法。
 */
export const VIEW_SHORTCUT_LABEL = 'Ctrl/⌘ + Shift + B';

/** 快捷键：Ctrl/⌘ + Shift + B。 */
function isViewShortcut(event: KeyboardEvent): boolean {
	return (
		(event.key === 'b' || event.key === 'B') &&
		event.shiftKey &&
		(event.ctrlKey || event.metaKey) &&
		!event.altKey
	);
}

/**
 * 安装视图快捷键。
 * @param ctx - 客户端根 context（用 ctx.effect 保证随插件卸载回收）。
 * @returns 无。
 */
export function installViewShortcut(ctx: Context): void {
	ctx.effect(() => {
		const onKeyDown = (event: KeyboardEvent): void => {
			// Esc 逃生梯：纯画布模式收起了聊天列，是最容易"看起来卡住"的模式。
			// 给它一个人人都会先按的退出键，退回并排画布（聊天可见）。
			// 输入框里让路，且不拦其他模式的 Esc（菜单/弹层照常处理自己的 Esc）。
			if (
				event.key === 'Escape' &&
				getMode() === 'canvas-only' &&
				!isEditableTarget(event.target)
			) {
				setMode('canvas');
				document.body.dataset.ffcLastToggle = 'canvas';
				return;
			}
			if (!isViewShortcut(event)) return;
			// 输入框里让路：用户在聊天里按 Ctrl+Shift+B 不该被我们吃掉
			if (isEditableTarget(event.target)) return;
			event.preventDefault();
			const next: ViewMode = toggleCanvasMode();
			// 留下一点痕迹，便于 e2e 与用户确认「刚才那下生效了」
			document.body.dataset.ffcLastToggle = next;
		};
		window.addEventListener('keydown', onKeyDown);
		return () => {
			window.removeEventListener('keydown', onKeyDown);
			delete document.body.dataset.ffcLastToggle;
		};
	}, 'fatfish-canvas: view shortcut');
}
