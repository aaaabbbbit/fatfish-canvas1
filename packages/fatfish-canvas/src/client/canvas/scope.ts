/**
 * 画布作用域策略：`偏好 × 当前会话所在的工作区 → 存储键`。
 *
 * 为什么单独一个模块：三份知识必须合在一处才对，但它们天然分居三地 ——
 *   偏好（用户想要共用还是按工作区分）在 `state.ts`，
 *   当前会话与它的工作区（画布跟着谁走）在 `canvas/bridge.ts` 手里，
 *   换键与拆分（不丢东西）在 `canvas/store.ts` 里。
 * 任何一方自己去改另外两方，都会让「谁决定画布键」变成一句口头约定。
 *
 * 四条设计决定：
 *
 * 1. **默认按工作区**（一个工作区一块画布）：用户要的就是「进哪个项目的对话
 *    就看哪个项目的画布」。偏好读不到时按 `workspace` 走（`state.ts` 里说明）。
 * 2. **工作区 = 会话的 `cwd`**：这是平台上「这个会话属于哪个项目」的权威字段，
 *    画布挂在它上面 —— 同一个工作区里的所有会话共用一块，不同工作区各一块。
 * 3. **从共用切进工作区时先按会话拆开**：共用那块是所有项目混在一起的一堆，
 *    整块抄过去等于把别的项目也搬进来。拆分幂等，且共用那块原样留着当备份
 *    （用户点「共用画布」还看得到全部）。
 * 4. **拿不到工作区时退回共用**：作用域是纯字符串，`null` 即全局键。
 *    无会话（无头组合、`sessions` 服务缺席、会话行还没带 `cwd`）时画布照常可用，
 *    快照里 `scope` 是 null，视图据此显示「共用画布」而不是假装已经分开。
 *
 * @module fatfish-canvas/client/canvas/scope
 */

import { useEffect, useState } from 'react';
import { getBoardScopeMode, subscribe, type BoardScopeMode } from '../state';
import {
	getBoardScope,
	rehomeSharedBoard,
	setBoardScope,
	type BoardScope,
} from './store';

/** 作用域快照（视图读数与测试用）。 */
export interface ScopeSnapshot {
	/** 用户的偏好。 */
	mode: BoardScopeMode;
	/** 已知的当前会话 id（bridge 告知；null = 还不知道/没有会话）。 */
	sessionId: string | null;
	/** 当前会话所在的工作区路径（= 会话的 cwd；null = 还不知道）。 */
	workspace: string | null;
	/** 实际生效的作用域（null = 所有工作区共用那块画布）。 */
	scope: BoardScope;
}

/** 当前会话 id（bridge 在绑定会话时告知）。 */
let sessionId: string | null = null;
/** 当前会话所在的工作区（bridge 从会话列表的 `cwd` 取）。 */
let workspace: string | null = null;

/**
 * 「会话 id → 工作区」的查询口（bridge 在装订阅时装上）。
 *
 * 拆分共用画布要用它：画布节点上记着**是哪个会话**生成的，而会话 → 工作区
 * 只有桥查得到（会话列表在它手里）。查不到就是 undefined —— 那种节点留在共用那块。
 * @param fn - 查询函数。
 */
let workspaceOf: (sessionId: string) => string | undefined = () => undefined;

/** 装/换「会话 → 工作区」的查询口。 */
export function setWorkspaceLookup(fn: (sessionId: string) => string | undefined): void {
	workspaceOf = fn;
}

const listeners = new Set<() => void>();

let snapshot: ScopeSnapshot = {
	mode: getBoardScopeMode(),
	sessionId: null,
	workspace: null,
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
	const target: BoardScope = mode === 'workspace' ? workspace : null;
	const current = getBoardScope();

	// 「共用 → 按工作区」这一步先把共用那块按会话拆到各自的工作区（幂等）：
	// 换键本身不搬运，不拆的话当前工作区看到的会是**所有项目**混在一起的那一堆。
	if (current === null && target !== null) {
		rehomeSharedBoard((node) =>
			node.sessionId === undefined ? null : (workspaceOf(node.sessionId) ?? null),
		);
	}
	if (target !== current) setBoardScope(target);

	if (
		snapshot.mode === mode &&
		snapshot.sessionId === sessionId &&
		snapshot.workspace === workspace &&
		snapshot.scope === target
	) {
		return false;
	}
	snapshot = { mode, sessionId, workspace, scope: target };
	for (const fn of listeners) fn();
	return true;
}

/**
 * 桥告知当前会话与它的工作区（会话切换时调用）。
 * @param id - 会话 id；null = 没有可跟随的会话。
 * @param workspacePath - 会话的工作区（`cwd`）；null = 还认不出（例如列表行上还没有它）。
 */
export function setScopeSession(id: string | null, workspacePath: string | null = null): void {
	if (sessionId === id && workspace === workspacePath) return;
	sessionId = id;
	workspace = workspacePath;
	applyBoardScope();
}

/**
 * 装上偏好订阅：工具条上那枚读数一翻，画布立刻跟着换。
 *
 * 顺手做一次启动应用 —— 启动时还没有会话，先停在共用那块上，
 * 等桥报来「会话 + 工作区」再切过去（见 `setScopeSession`）。
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
