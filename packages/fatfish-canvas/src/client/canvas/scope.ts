/**
 * 画布作用域策略（P7）：`偏好 × 当前会话 → 存储键`。
 *
 * 为什么单独一个模块：三份知识必须合在一处才对，但它们天然分居三地 ——
 *   偏好（用户想要共用还是隔离）在 `state.ts`，
 *   当前会话（画布跟着谁走）在 `canvas/bridge.ts` 手里，
 *   换键这件事（不丢东西）在 `canvas/store.ts` 里。
 * 任何一方自己去改另外两方，都会让「谁决定画布键」变成一句口头约定。
 *
 * 三条设计决定：
 *
 * 1. **默认共用**：偏好读不到就是 `shared` —— 老用户升级后画布不会突然变空。
 * 2. **只有「从共用切进隔离」才采用当前画布**（`adopt`）。
 *    否则会话 A → 会话 B 时，B 那块空画布会把 A 的内容抄一份过来，
 *    「按会话隔离」就当场失效了。
 * 3. **拿不到会话 id 时退回共用**：作用域是纯字符串，`null` 即全局键。
 *    无会话（无头组合、`sessions` 服务缺席、列表还没就绪）时画布照常可用，
 *    快照里 `scope` 是 null，视图据此显示「待会话」而不是假装已经隔离。
 *
 * @module fatfish-canvas/client/canvas/scope
 */

import { useEffect, useState } from 'react';
import { getBoardScopeMode, subscribe, type BoardScopeMode } from '../state';
import { getBoardScope, setBoardScope, type BoardScope } from './store';

/** 作用域快照（视图读数与测试用）。 */
export interface ScopeSnapshot {
	/** 用户的偏好。 */
	mode: BoardScopeMode;
	/** 已知的当前会话 id（bridge 告知；null = 还不知道/没有会话）。 */
	sessionId: string | null;
	/** 实际生效的作用域（null = 共用那块画布）。 */
	scope: BoardScope;
}

/** 当前会话 id（bridge 在绑定会话时告知）。 */
let sessionId: string | null = null;

const listeners = new Set<() => void>();

let snapshot: ScopeSnapshot = {
	mode: getBoardScopeMode(),
	sessionId: null,
	scope: getBoardScope(),
};

/** 订阅作用域快照。 */
export function subscribeScope(fn: () => void): () => void {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
}

/** 取当前快照（引用稳定，仅在真正变化时替换）。 */
export function getScopeSnapshot(): ScopeSnapshot {
	return snapshot;
}

/**
 * 重新计算并应用作用域。
 *
 * 幂等：目标作用域与当前一致时**什么都不做**（既不换键也不通知），
 * 因此可以安全地挂在偏好 store 上，被宽度/跟焦的每一次变化顺带叫醒。
 *
 * 导出它是为了让偏好订阅与测试都能直接驱动同一个入口 —— 换画布的逻辑
 * 只有这一处，不要在外面另写一份。
 * @returns 本次快照是否变化（注意：会话变了但两块画布恰好是同名作用域时也算变化）。
 */
export function applyBoardScope(): boolean {
	const mode = getBoardScopeMode();
	const target: BoardScope = mode === 'session' ? sessionId : null;
	const current = getBoardScope();
	// 只有「共用 → 隔离」才把手上这块画布带过去；会话之间互不抄送。
	const adopt = current === null && target !== null;

	if (target !== current) setBoardScope(target, { adopt });
	if (snapshot.mode === mode && snapshot.sessionId === sessionId && snapshot.scope === target) {
		return false;
	}
	snapshot = { mode, sessionId, scope: target };
	for (const fn of listeners) fn();
	return true;
}

/**
 * 桥告知当前会话（会话切换时调用）。
 * @param id - 会话 id；null = 没有可跟随的会话。
 */
export function setScopeSession(id: string | null): void {
	if (sessionId === id) return;
	sessionId = id;
	applyBoardScope();
}

/**
 * 装上偏好订阅：菜单里翻开关之后立刻换画布。
 *
 * 顺手做一次启动应用 —— 偏好可能是上次留下的 `session`，而那时还没有会话，
 * 于是先停在共用画布上，等桥报来会话 id 再切过去（见 `setScopeSession`）。
 * @returns 卸载函数。
 */
export function installBoardScope(): () => void {
	applyBoardScope();
	const off = subscribe(() => {
		applyBoardScope();
	});
	return off;
}

/**
 * 订阅作用域快照（视图读数用）。
 *
 * 与 `state.ts` / `canvas/store.ts` 一致：**不用 `useSyncExternalStore`**
 * （它在真实环境里不触发重渲染，见 `state.ts` 的 `useStoreValue` 注释）。
 */
export function useBoardScope(): ScopeSnapshot {
	const [value, setValue] = useState<ScopeSnapshot>(getScopeSnapshot);
	useEffect(() => {
		setValue(getScopeSnapshot());
		return subscribeScope(() => {
			setValue(getScopeSnapshot());
		});
	}, []);
	return value;
}
