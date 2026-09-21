/**
 * 画布底部的一行提示 —— 跨模块的最小发布订阅。
 *
 * 为什么需要它：提示的来源不止画布视口（拖入文件的是 `dropfiles`，导出/还原在
 * 右键菜单里，运行工作流在顶栏），而它们都不在同一个组件树里。为此引一套 toast
 * 系统不值得 —— 全画布同时只有一条提示，一个字符串加一组订阅者就够。
 *
 * 与 `state.ts` / `canvas/store.ts` 同一套外部 store 模式（不用
 * `useSyncExternalStore`，理由见 store.ts 的 `useStoreValue`）。
 *
 * @module fatfish-canvas/client/canvas/notice
 */

import { useEffect, useState } from 'react';

/** 提示停留时长。 */
export const NOTICE_MS = 2600;

let current = '';
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

/**
 * 推一条提示。
 *
 * 每次调用都会**重播**（同样的文案再来一次也会重新计时），因为「又发生了一次」
 * 这件事本身就是要传达的信息。
 * @param text - 提示文案；空串表示立刻收起。
 */
export function pushNotice(text: string): void {
	current = text;
	if (timer !== null) {
		clearTimeout(timer);
		timer = null;
	}
	if (text !== '') {
		timer = setTimeout(() => {
			timer = null;
			current = '';
			for (const fn of listeners) fn();
		}, NOTICE_MS);
	}
	for (const fn of listeners) fn();
}

/** 取当前提示（空串 = 不显示）。 */
export function getNotice(): string {
	return current;
}

/**
 * 订阅提示（组件用）。
 * @returns 当前提示文案。
 */
export function useNotice(): string {
	const [value, setValue] = useState(getNotice);
	useEffect(() => {
		const sync = (): void => {
			setValue(getNotice());
		};
		sync();
		listeners.add(sync);
		return () => {
			listeners.delete(sync);
		};
	}, []);
	return value;
}
