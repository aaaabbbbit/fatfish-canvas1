/**
 * 菜单基础设施：**键盘导航** + **关闭时机**（P5 打磨）。
 *
 * 插件里有三处菜单（右上角视图菜单、左下角缩放档位、画布节点右键菜单），
 * 它们各自长得不一样，但行为必须一致 —— 而这三件事最容易各写一遍、各漏一点：
 *
 *   1. **方向键 + Home/End 在条目间移动**，跳过禁用项，循环；
 *   2. **Enter / Space 选中当前项**，`Escape` 关闭；
 *   3. **点到菜单外面就关**（capture 阶段的 pointerdown，先于任何 click）。
 *
 * 因此这里把「行为」抽成两个 hook，菜单各自只负责自己的**外观**。
 * 无障碍上配合使用：容器 `role="menu"` + `aria-activedescendant`（指向当前项），
 * 条目 `role="menuitem" | "menuitemradio" | "menuitemcheckbox"` —— 用
 * activedescendant 而不是给每个条目 `tabIndex=0`，这样 Tab 键是「离开菜单」
 * 而不是「在菜单里跳 12 次」。
 *
 * @module fatfish-canvas/client/menu
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 从某个位置出发朝一个方向找下一个**可用**条目（纯函数，可离线单测）。
 *
 * 规则：跳过禁用项、首尾循环；全部禁用时返回 null（此时键盘不该改变任何东西）。
 * @param ids - 条目 id（按显示顺序）。
 * @param from - 起点下标（-1 表示「还没有高亮」）。
 * @param step - 方向：1 向下、-1 向上。
 * @param isDisabled - 禁用判定。
 * @returns 下一个可用条目 id；没有可用项时 null。
 */
export function seekEnabled(
	ids: readonly string[],
	from: number,
	step: number,
	isDisabled?: (id: string) => boolean,
): string | null {
	if (ids.length === 0) return null;
	for (let i = 1; i <= ids.length; i += 1) {
		const index = (((from + step * i) % ids.length) + ids.length) % ids.length;
		const id = ids[index];
		if (id !== undefined && isDisabled?.(id) !== true) return id;
	}
	return null;
}

/** 键盘导航的返回值。 */
export interface MenuNav {
	/** 当前高亮项 id（无高亮时为 null）。 */
	activeId: string | null;
	/** 主动设置高亮（鼠标悬停用）。 */
	setActiveId: (id: string | null) => void;
	/** 挂在容器上的键盘处理。 */
	onKeyDown: (event: KeyboardEvent) => void;
	/** 一个条目的 props（`id` / `data-nav-active` / `onPointerEnter`）。 */
	itemProps: (id: string) => {
		id: string;
		'data-nav-active': string | undefined;
		onPointerEnter: () => void;
	};
	/** 容器上要挂的 aria 属性。 */
	containerProps: { 'aria-activedescendant': string | undefined };
}

/**
 * 菜单键盘导航。
 * @param options - 条目顺序、禁用判定、选中回调、关闭回调。
 * @returns 导航状态与挂载助手。
 */
export function useMenuNav(options: {
	/** 条目 id（按显示顺序，不含分隔线）。 */
	ids: readonly string[];
	/** 某条目是否禁用（禁用项会被跳过）。 */
	isDisabled?: (id: string) => boolean;
	/** Enter / Space 选中。 */
	onChoose: (id: string) => void;
	/** Escape / Tab 关闭。 */
	onClose: () => void;
}): MenuNav {
	const { ids, isDisabled, onChoose, onClose } = options;
	const [activeId, setActiveId] = useState<string | null>(null);

	/** 从某个位置出发，朝一个方向找到第一个可用条目。 */
	const seek = useCallback(
		(from: number, step: number): string | null => seekEnabled(ids, from, step, isDisabled),
		[ids, isDisabled],
	);

	const onKeyDown = useCallback(
		(event: KeyboardEvent) => {
			const current = activeId === null ? -1 : ids.indexOf(activeId);
			switch (event.key) {
				case 'ArrowDown':
				case 'ArrowUp': {
					event.preventDefault();
					// 还没高亮时：向下从第一项开始，向上从最后一项开始
					const step = event.key === 'ArrowDown' ? 1 : -1;
					const from = current === -1 ? (step === 1 ? -1 : 0) : current;
					setActiveId(seek(from, step));
					return;
				}
				case 'Home':
					event.preventDefault();
					setActiveId(seek(-1, 1));
					return;
				case 'End':
					event.preventDefault();
					setActiveId(seek(0, -1));
					return;
				case 'Enter':
				case ' ': {
					if (activeId === null) return;
					event.preventDefault();
					if (isDisabled?.(activeId) !== true) onChoose(activeId);
					return;
				}
				case 'Escape':
					event.preventDefault();
					event.stopPropagation();
					onClose();
					return;
				case 'Tab':
					onClose();
					return;
				default:
					return;
			}
		},
		[activeId, ids, isDisabled, onChoose, onClose, seek],
	);

	const itemProps = useCallback(
		(id: string) => ({
			id,
			// 刻意不叫 `data-active`：那个属性在视图菜单里表示「当前选中的模式」，
			// 键盘高亮是另一件事，两者必须能同时存在（高亮落在未选中的项上）。
			'data-nav-active': activeId === id ? 'true' : undefined,
			onPointerEnter: () => {
				setActiveId(id);
			},
		}),
		[activeId],
	);

	const openId = activeId === null ? undefined : activeId;
	return {
		activeId,
		setActiveId,
		onKeyDown,
		itemProps,
		containerProps: { 'aria-activedescendant': openId },
	};
}

/**
 * 菜单的关闭时机：点到外面、按 Esc、视口尺寸变化。
 *
 * 用 capture 阶段监听 `pointerdown`：它在任何 `click` 之前到达，
 * 因此「点外面」不会先把点击交给后面的元素再关闭菜单（那会误触下层的东西）。
 * @param options - 容器 / 触发按钮的引用与关闭回调。
 */
export function useMenuDismiss(options: {
	/** 菜单容器（点在它里面不算外面）。 */
	menuRef: { current: HTMLElement | null };
	/** 触发按钮（点它自己交给按钮的 toggle 处理，避免「关了又开」）。 */
	buttonRef?: { current: HTMLElement | null };
	/** 关闭。 */
	onClose: () => void;
	/** 是否监听窗口 resize（默认开）。 */
	watchResize?: boolean;
}): void {
	const { menuRef, buttonRef, onClose, watchResize = true } = options;
	// 回调放 ref：调用方每次渲染都会传新的闭包，若进依赖会导致反复装卸监听
	const closeRef = useRef(onClose);
	closeRef.current = onClose;

	useEffect(() => {
		const onPointerDown = (event: PointerEvent): void => {
			const target = event.target;
			if (!(target instanceof Node)) return;
			if (menuRef.current?.contains(target) === true) return;
			if (buttonRef?.current?.contains(target) === true) return;
			closeRef.current();
		};
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === 'Escape') closeRef.current();
		};
		// 具名函数：匿名箭头没法被 removeEventListener 摘掉（会越挂越多）
		const onResize = (): void => {
			closeRef.current();
		};
		document.addEventListener('pointerdown', onPointerDown, true);
		document.addEventListener('keydown', onKeyDown, true);
		if (watchResize) window.addEventListener('resize', onResize);
		return () => {
			document.removeEventListener('pointerdown', onPointerDown, true);
			document.removeEventListener('keydown', onKeyDown, true);
			if (watchResize) window.removeEventListener('resize', onResize);
		};
	}, [menuRef, buttonRef, watchResize]);
}

/**
 * 打开时把焦点移到菜单容器上。
 *
 * 键盘导航的前提是「按键事件先到菜单」。容器用 `tabIndex={-1}` 只是可编程聚焦，
 * 不会进 Tab 序；配合 `aria-activedescendant`，Tab 键就是「离开菜单」。
 *
 * ⚠️ **依赖必须覆盖「菜单真正挂载」的那一刻**，否则会静默失效：菜单若是被
 * `open && anchor !== null` 这类条件渲染的，只写 `[open]` 会在菜单还没挂载时
 * 聚焦一次（ref 为 null，无事发生），之后再也不会重跑 —— 现象就是
 * 「菜单打开了，但方向键毫无反应」。条件渲染的菜单请把条件里的每一项都放进 deps。
 * @param ref - 菜单容器引用。
 * @param deps - 重新聚焦的依赖（一般为「菜单出现」所依赖的全部状态）。
 */
export function useMenuFocus(
	ref: { current: HTMLElement | null },
	deps: readonly unknown[] = [],
): void {
	useEffect(() => {
		ref.current?.focus({ preventScroll: true });
		// eslint-disable-next-line react-hooks/exhaustive-deps -- 依赖由调用方给出
	}, deps);
}

/**
 * 把浮层夹进视口内。
 *
 * 右键菜单最容易翻车的地方：在画布右下角右键，菜单直接跑到屏幕外面去。
 * @param at - 期望的位置（视口坐标，菜单左上角）。
 * @param size - 菜单尺寸。
 * @param gap - 与视口边缘的最小间距。
 * @returns 夹紧后的位置。
 */
export function clampToViewport(
	at: { x: number; y: number },
	size: { w: number; h: number },
	gap = 8,
): { x: number; y: number } {
	const maxX = Math.max(gap, window.innerWidth - size.w - gap);
	const maxY = Math.max(gap, window.innerHeight - size.h - gap);
	return {
		x: Math.min(Math.max(gap, at.x), maxX),
		y: Math.min(Math.max(gap, at.y), maxY),
	};
}
