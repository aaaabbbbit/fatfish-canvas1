/**
 * 视图模式状态：`chat`（本体默认三栏）⟷ `canvas`（左画布 / 右聊天）⟷ `canvas-only`（纯画布）。
 *
 * 两个 shell.overlay 条目（米饭碗按钮、画布面板）是各自独立的 React 根，
 * 需要一个模块级共享源，因此这里用极小的外部 store + `useSyncExternalStore`，
 * 不引第三方状态库。
 *
 * 同一份 store 还装着画布的两个偏好：跟焦开关（P4）与**画布作用域**（P7，
 * 共用一块 ⟷ 每个会话一块）。它们都是「用户想要什么」这一层，不碰画布数据本身
 * —— 数据在 `canvas/store.ts`，两者的接合点在 `canvas/scope.ts`。
 *
 * 副作用集中在 `apply mode` 一处：
 *   - `document.body[data-ffc-mode]` 驱动 styles.ts 里的 AppFrame 重排
 *   - `--ffc-canvas-width` 供画布面板与重排规则共用同一宽度
 *   - `data-ffc-frame` 打点（见下）
 *
 * @module fatfish-canvas/client/state
 */

import { useEffect, useState } from 'react';

/** 视图模式。`canvas-only` = 纯画布（聊天列收起，画布铺满）。 */
export type ViewMode = 'chat' | 'canvas' | 'canvas-only';

/** 画布类模式（除聊天模式外的全部）。 */
export type CanvasMode = Exclude<ViewMode, 'chat'>;

const MODE_KEY = 'fatfish-canvas:view-mode';
/** 记住「上一次用过的画布类模式」，供快捷键在 聊天 ⟷ 画布 之间来回切。 */
const LAST_CANVAS_KEY = 'fatfish-canvas:last-canvas-mode';
const FOLLOW_KEY = 'fatfish-canvas:follow-new';
const WIDTH_KEY = 'fatfish-canvas:canvas-width';
/** 画布作用域偏好（P7）：所有会话共用一块，还是每个会话一块。 */
const SCOPE_KEY = 'fatfish-canvas:board-scope';

/** 画布作用域偏好。 */
export type BoardScopeMode = 'shared' | 'session';

/** 画布宽度契约范围（px）——与 CSS 的 --ffc-canvas-min 保持一致。 */
export const CANVAS_MIN = 360;
export const CANVAS_MAX = 2400;
/** 默认画布宽度：视口百分比。 */
const CANVAS_DEFAULT_PCT = 62;

// ─────────────────────────── 存储 ───────────────────────────

/** 把任意存储值收敛成合法模式。 */
function normalizeMode(value: string | null): ViewMode {
	return value === 'canvas' || value === 'canvas-only' ? value : 'chat';
}

function readMode(): ViewMode {
	try {
		const stored = normalizeMode(window.localStorage.getItem(MODE_KEY));
		// 刷新自救：canvas-only 是"聊天列全部收起"的模式，一旦它自身的界面
		// 因任何原因没渲染出来（样式回归、overlay 挂载失败、构建产物过期），
		// 用户就会开页面即白屏且没有可点的出口。因此**不从存储恢复纯画布**，
		// 降级成并排画布 —— 聊天始终在，永远退得出去。
		// 用户在本次会话里主动选纯画布仍然完全可用（setMode 不受此限制）。
		return stored === 'canvas-only' ? 'canvas' : stored;
	} catch {
		return 'chat';
	}
}

function readLastCanvasMode(): CanvasMode {
	try {
		const value = window.localStorage.getItem(LAST_CANVAS_KEY);
		return value === 'canvas-only' ? 'canvas-only' : 'canvas';
	} catch {
		return 'canvas';
	}
}

function readWidth(): string {
	try {
		const raw = window.localStorage.getItem(WIDTH_KEY);
		if (raw !== null && raw !== '') return raw;
	} catch {
		/* 隐私模式等：退回默认值 */
	}
	return `${String(CANVAS_DEFAULT_PCT)}%`;
}

/** 跟焦偏好：读不到时默认开（生成结果落到画布上，用户通常就是想知道它长什么样）。 */
function readFollow(): boolean {
	try {
		return window.localStorage.getItem(FOLLOW_KEY) !== 'off';
	} catch {
		return true;
	}
}

/**
 * 画布作用域偏好：读不到时默认**共用一块画布**。
 *
 * 默认值必须是老的（全局）行为：升级插件的人不该发现自己的画布莫名其妙空了，
 * 隔离是用户显式打开的开关（视图菜单里）。
 */
function readScopeMode(): BoardScopeMode {
	try {
		return window.localStorage.getItem(SCOPE_KEY) === 'session' ? 'session' : 'shared';
	} catch {
		return 'shared';
	}
}

function write(key: string, value: string): void {
	try {
		window.localStorage.setItem(key, value);
	} catch {
		/* 写不进去不影响本次会话内的行为 */
	}
}

// ─────────────────────────── 外部 store ───────────────────────────

let mode: ViewMode = typeof window === 'undefined' ? 'chat' : readMode();
let lastCanvasMode: CanvasMode =
	typeof window === 'undefined' ? 'canvas' : readLastCanvasMode();
let follow: boolean = typeof window === 'undefined' ? true : readFollow();
let scopeMode: BoardScopeMode = typeof window === 'undefined' ? 'shared' : readScopeMode();
let width: string = typeof window === 'undefined' ? `${String(CANVAS_DEFAULT_PCT)}%` : readWidth();

const listeners = new Set<() => void>();

/** 订阅模式/宽度变化。 */
export function subscribe(fn: () => void): () => void {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
}

function emit(): void {
	for (const fn of listeners) fn();
}

/** 当前模式。 */
export function getMode(): ViewMode {
	return mode;
}

/** 当前画布宽度（CSS 长度）。 */
export function getWidth(): string {
	return width;
}

/**
 * 找到 AppFrame 元素并打上 `data-ffc-frame`。
 *
 * 布局包的 CSS Module 类名带每次构建都会变的哈希（如 `pI_x6G_frame`），
 * 直接依赖它会随 DSH 升级静默失效；`[data-shell-overlay]` 是 overlay 层的
 * 稳定数据属性，它的父元素正是 AppFrame 根节点。用 JS 打点也顺带避开了
 * `:has()` 的浏览器支持面。
 *
 * 同时清掉旧节点上的标记（布局重挂载会换元素）。
 * @returns 打点到的 frame，未找到时为 null。
 */
export function tagFrame(): HTMLElement | null {
	if (typeof document === 'undefined') return null;
	const overlay = document.querySelector('[data-shell-overlay]');
	const frame = overlay?.parentElement;
	if (!(frame instanceof HTMLElement)) return null;
	for (const stale of document.querySelectorAll('[data-ffc-frame]')) {
		if (stale !== frame) stale.removeAttribute('data-ffc-frame');
	}
	frame.dataset.ffcFrame = '';
	return frame;
}

/**
 * 低成本版打点：已经打对点时立即返回。
 *
 * AppFrame 可能在插件挂载之后才出现，也可能因热重载换元素，所以需要一个
 * 观察者兜底；但观察者会随聊天流式输出高频触发，因此这里只做**一次**
 * `querySelector`（命中即停），已打点就直接返回，不做全量清理。
 */
export function ensureFrameTag(): void {
	if (typeof document === 'undefined') return;
	const overlay = document.querySelector('[data-shell-overlay]');
	const frame = overlay?.parentElement;
	if (!(frame instanceof HTMLElement)) return;
	// 找到的 frame 已带标记 = 状态正确，无需动作（新 frame 必然未标记）。
	if (frame.dataset.ffcFrame !== undefined) return;
	tagFrame();
}

/**
 * 把当前模式与宽度投影到 document 上。幂等，可重复调用
 * （frame 重挂载后需要重新打点）。
 */
export function applyToDocument(): void {
	if (typeof document === 'undefined') return;
	document.documentElement.style.setProperty('--ffc-canvas-width', width);
	document.body.dataset.ffcMode = mode;
	tagFrame();
}

/** 切换模式。 */
export function setMode(next: ViewMode): void {
	if (mode === next) return;
	mode = next;
	write(MODE_KEY, next);
	if (next !== 'chat') {
		lastCanvasMode = next;
		write(LAST_CANVAS_KEY, next);
	}
	applyToDocument();
	// 广播一条普通 DOM 事件：这是**不依赖 React、也不依赖模块级 store** 的第三条腿
	// （见 useViewMode）。同一文档里的任何订阅者都能收到，且它是同步的。
	if (typeof document !== 'undefined' && typeof document.dispatchEvent === 'function') {
		document.dispatchEvent(new Event('fatfish-canvas:mode'));
	}
	emit();
}

/** 是否处于画布类模式（画布面板可见）。 */
export function isCanvasMode(value: ViewMode = mode): boolean {
	return value !== 'chat';
}

/** 上一次使用的画布类模式（快捷键回来时用）。 */
export function getLastCanvasMode(): CanvasMode {
	return lastCanvasMode;
}

/**
 * 在「聊天」与「上一次的画布模式」之间来回切。
 *
 * 快捷键只做这一件事：菜单负责选具体是哪种画布。
 */
export function toggleCanvasMode(): ViewMode {
	const next: ViewMode = mode === 'chat' ? lastCanvasMode : 'chat';
	setMode(next);
	return next;
}

/** 直接在两个模式间切换（保留给旧调用点：等价于 聊天 ⟷ 并排画布）。 */
export function toggleMode(): void {
	setMode(mode === 'chat' ? 'canvas' : 'chat');
}

/**
 * 写入画布宽度。
 * @param next - CSS 长度（如 `"62%"`、`"900px"`）。
 */
export function setWidth(next: string): void {
	if (width === next) return;
	width = next;
	write(WIDTH_KEY, next);
	applyToDocument();
	emit();
}

/** 把宽度重置回默认百分比。 */
export function resetWidth(): void {
	setWidth(`${String(CANVAS_DEFAULT_PCT)}%`);
}

/** 新节点自动跟焦开关。 */
export function getFollowNewNodes(): boolean {
	return follow;
}

/**
 * 设置跟焦开关。
 * @param next - 是否跟随新落下的节点。
 */
export function setFollowNewNodes(next: boolean): void {
	if (follow === next) return;
	follow = next;
	write(FOLLOW_KEY, next ? 'on' : 'off');
	emit();
}

/** 翻转跟焦开关。 */
export function toggleFollowNewNodes(): boolean {
	setFollowNewNodes(!follow);
	return follow;
}

/**
 * 画布作用域偏好（P7）。
 *
 * 这里只存「用户想要哪种」；**真正换画布**由 `canvas/scope.ts` 拿它
 * 结合当前会话 id 去调 `store.setBoardScope`（偏好自己不知道会话是谁）。
 */
export function getBoardScopeMode(): BoardScopeMode {
	return scopeMode;
}

/**
 * 设置作用域偏好。
 * @param next - `shared` 所有会话共用一块画布；`session` 每个会话一块。
 */
export function setBoardScopeMode(next: BoardScopeMode): void {
	if (scopeMode === next) return;
	scopeMode = next;
	write(SCOPE_KEY, next);
	emit();
}

/** 翻转作用域偏好。 */
export function toggleBoardScopeMode(): BoardScopeMode {
	setBoardScopeMode(scopeMode === 'session' ? 'shared' : 'session');
	return scopeMode;
}

/**
 * 把外部 store 接进 React。
 *
 * ⚠️ **刻意不用 `useSyncExternalStore`**（P16）：实测在真实运行环境里它不触发重渲染 ——
 * 症状是「组件只在首次渲染时读一次快照，之后永远不动」：画布面板在聊天模式那次
 * 渲染里返回了 `null`，切到画布模式后再也不重渲染，于是**左侧没有面板、没有工具条**
 * （用户报的「黑屏」），而米饭碗自己的 `aria-label` 也永远停在「进入肥鱼画布」。
 * 同时 store 本身是好的（`body[data-ffc-mode]` 会照样翻），所以只有 React 那一半不动。
 *
 * 换成 `useState` + `useEffect` 订阅：只依赖最基础的两个 hook，行为可预期，
 * 而且**首次渲染直接读快照**（不必等 effect 再补一次，避免首帧闪烁）。
 * @param subscribeTo - 订阅函数（返回取消订阅）。
 * @param get - 取当前快照。
 * @returns 当前快照；store 变化时触发重渲染。
 */
function useStoreValue<T>(subscribeTo: (fn: () => void) => () => void, get: () => T): T {
	const [value, setValue] = useState<T>(get);
	useEffect(() => {
		// 挂载与每次变化都对齐一次：effect 可能比 store 的最新值晚一拍
		setValue(get);
		return subscribeTo(() => {
			setValue(get);
		});
	}, [subscribeTo, get]);
	return value;
}

// ─────────────────── 模式的 DOM 通道（与 store 无关的第二条腿） ───────────────────
//
// 为什么还要一条 DOM 通道：`body[data-ffc-mode]` 是**已经验证过会实时更新**的那一份
// 事实（store 的 emit + applyToDocument 都会写它）。而 React 订阅这条路在真实环境里
// 出过问题（见上）。模式是「面板要不要渲染」的开关，它一旦卡住就是整块黑屏 ——
// 这种要命的东西值得用最朴素的 DOM 事实兜底。
//
// 实现刻意用 `MutationObserver`：它不经过 React、不经过模块级 store，
// 只要属性变了就一定回调。

/** `body[data-ffc-mode]` 的订阅者。 */
const bodyModeListeners = new Set<() => void>();
let bodyModeObserver: MutationObserver | null = null;

/** 起订阅时挂上观察者；没人要了就撤掉（避免长期占着一个 observer）。 */
function ensureBodyModeObserver(): void {
	if (bodyModeObserver !== null || typeof document === 'undefined') return;
	// 能力检测：无头/测试环境（以及极老的浏览器）没有 MutationObserver，
	// 那种情况下 store 那条订阅腿仍然是通的，不该因此整块炸掉。
	if (typeof MutationObserver !== 'function' || document.body === undefined) return;
	bodyModeObserver = new MutationObserver(() => {
		for (const fn of bodyModeListeners) fn();
	});
	bodyModeObserver.observe(document.body, {
		attributes: true,
		attributeFilter: ['data-ffc-mode'],
	});
}

/** 停止观察（没有订阅者时）。 */
function dropBodyModeObserver(): void {
	if (bodyModeListeners.size > 0) return;
	bodyModeObserver?.disconnect();
	bodyModeObserver = null;
}

/**
 * 当前模式 —— 直接读 DOM 属性，读不到才退回模块状态。
 * @returns 视图模式。
 */
export function getModeFromDom(): ViewMode {
	if (typeof document !== 'undefined') {
		const raw = document.body.dataset.ffcMode;
		if (raw === 'canvas' || raw === 'canvas-only' || raw === 'chat') return raw;
	}
	return mode;
}

/**
 * 订阅 `body[data-ffc-mode]` 的变化。
 * @param fn - 回调。
 * @returns 取消订阅。
 */
export function subscribeBodyMode(fn: () => void): () => void {
	bodyModeListeners.add(fn);
	ensureBodyModeObserver();
	return () => {
		bodyModeListeners.delete(fn);
		dropBodyModeObserver();
	};
}

/** 订阅当前视图模式。 */
export function useViewMode(): ViewMode {
	const [value, setValue] = useState<ViewMode>(getModeFromDom);
	useEffect(() => {
		const sync = (): void => {
			setValue(getModeFromDom());
		};
		sync();
		// 三条腿，任何一条通就够：
		//   ① store 的订阅（正常路径）
		//   ② `body[data-ffc-mode]` 的 MutationObserver（不经过 React 的 store）
		//   ③ 直接在 document 上挂一个 DOM 事件监听（连 MutationObserver 都不可信时）
		// 模式是面板的渲染开关，值得冗余到这种程度：它一卡住就是整块黑屏。
		const offStore = subscribe(sync);
		const offDom = subscribeBodyMode(sync);
		if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
			document.addEventListener('fatfish-canvas:mode', sync);
		}
		return () => {
			offStore();
			offDom();
			if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
				document.removeEventListener('fatfish-canvas:mode', sync);
			}
		};
	}, []);
	return value;
}

/** 订阅当前画布宽度。 */
export function useCanvasWidth(): string {
	return useStoreValue(subscribe, getWidth);
}

/** 订阅跟焦开关。 */
export function useFollowNewNodes(): boolean {
	return useStoreValue(subscribe, getFollowNewNodes);
}

/** 订阅画布作用域偏好。 */
export function useBoardScopeMode(): BoardScopeMode {
	return useStoreValue(subscribe, getBoardScopeMode);
}
