/**
 * 画布 store：节点表、视口、选择集，带 localStorage 持久化。
 *
 * 沿用 `state.ts` 的外部 store 模式（`useSyncExternalStore`），不引状态库。
 * 快照是不可变对象，仅在真正变化时替换引用，因此选择器可以安全依赖身份比较。
 *
 * 持久化只落**节点、视口与落图记账**：选择集是瞬时视图状态，重载后清空。
 * 反序列化逐字段校验 —— localStorage 里可能有旧版本或被手工改坏的数据，
 * 宁可退回空画布，也不要让坏数据把画布渲染成 NaN 坐标。
 *
 * `ingested` 是 P3 生成落图的**幂等记账**（已落到画布上的工具调用 id）。
 * 它必须持久化，否则重载后会话快照的历史重放会把用户删掉的节点又造回来。
 *
 * **作用域**：画布按**工作区**（会话的 cwd）分隔 —— `setBoardScope(<工作区路径>)` 之后，
 * 读写的是 `fatfish-canvas:board:<工作区路径>` 这个键，记账账本也随之独立。
 * 默认（`null`）是所有工作区共用一块画布，那块是「全部内容」的备份。
 * 策略（偏好 × 当前会话所在的工作区）在 `canvas/scope.ts`，本模块只负责
 * 「换键不丢东西」（`setBoardScope`）与「把共用那块按工作区拆开」（`rehomeSharedBoard`）。
 *
 * @module fatfish-canvas/client/canvas/store
 */

import { useEffect, useState } from 'react';
import {
	boundsOf,
	clampZoom,
	DEFAULT_VIEWPORT,
	makeNodeId,
	type CanvasNode,
	type NodeKind,
	type Rect,
	type Viewport,
} from './model';

const BOARD_KEY = 'fatfish-canvas:board';

/**
 * 画布作用域：`null` = 所有工作区共用一块画布；字符串 = 那个工作区自己的画布
 * （存的是工作区路径，就是会话的 cwd）。
 *
 * 刻意用**裸字符串**而不是 `{ kind, sessionId }` 对象：作用域的唯一用途就是
 * 选一个存储键，多一层包装只会让比较与序列化都变啰嗦。
 */
export type BoardScope = string | null;

/** 当前持久化格式版本（v1 没有 ingested 字段，读到时按空表处理）。 */
const BOARD_VERSION = 2;

/**
 * 作用域 → 存储键。
 * @param scope - 作用域（`null` = 全局）。
 * @returns localStorage 键名。
 */
export function boardKeyFor(scope: BoardScope): string {
	return scope === null || scope === '' ? BOARD_KEY : `${BOARD_KEY}:${scope}`;
}

/** store 快照。 */
export interface BoardState {
	/** 全部节点，按 z 升序（后面的画在上面）。 */
	nodes: readonly CanvasNode[];
	/** 当前视口。 */
	viewport: Viewport;
	/** 选中节点 id。 */
	selection: readonly string[];
	/** 已经落到画布上的生成调用 id（幂等记账，见模块头）。 */
	ingested: readonly string[];
}

const EMPTY: BoardState = { nodes: [], viewport: DEFAULT_VIEWPORT, selection: [], ingested: [] };

// ─────────────────────────── 反序列化校验 ───────────────────────────

const isFiniteNumber = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value);

const KINDS: readonly NodeKind[] = ['image', 'video', 'text'];

/**
 * 校验并规范化一个节点。
 * @param raw - 来自存储的原始值。
 * @returns 合法节点；不可修复时返回 null。
 */
function reviveNode(raw: unknown): CanvasNode | null {
	if (raw === null || typeof raw !== 'object') return null;
	const o = raw as Record<string, unknown>;
	if (typeof o.id !== 'string' || o.id === '') return null;
	if (!isFiniteNumber(o.x) || !isFiniteNumber(o.y)) return null;
	if (!isFiniteNumber(o.w) || !isFiniteNumber(o.h) || o.w <= 0 || o.h <= 0) return null;

	const kind: NodeKind = KINDS.includes(o.kind as NodeKind) ? (o.kind as NodeKind) : 'image';
	const status =
		o.status === 'ready' || o.status === 'failed' || o.status === 'pending'
			? o.status
			: 'ready';

	return {
		id: o.id,
		kind,
		x: o.x,
		y: o.y,
		w: o.w,
		h: o.h,
		z: isFiniteNumber(o.z) ? o.z : 0,
		status,
		...(typeof o.src === 'string' ? { src: o.src } : {}),
		...(typeof o.poster === 'string' ? { poster: o.poster } : {}),
		...(typeof o.title === 'string' ? { title: o.title } : {}),
		...(typeof o.prompt === 'string' ? { prompt: o.prompt } : {}),
		...(typeof o.model === 'string' ? { model: o.model } : {}),
		// 参考图句柄是「事后回看」用的，坏数据不该让整块画布退回空盘 —— 逐项过滤即可。
		...(Array.isArray(o.references)
			? { references: o.references.filter((item): item is string => typeof item === 'string' && item !== '') }
			: {}),
		...(typeof o.error === 'string' ? { error: o.error } : {}),
		createdAt: isFiniteNumber(o.createdAt) ? o.createdAt : Date.now(),
		...(typeof o.sessionId === 'string' ? { sessionId: o.sessionId } : {}),
	};
}

/**
 * 从 localStorage 读取一块画布。
 * @param key - 存储键（由 `boardKeyFor` 决定，作用域不同则键不同）。
 * @returns 复原后的状态；无数据或数据损坏时返回空画布。
 */
function load(key: string): BoardState {
	if (typeof window === 'undefined') return EMPTY;
	let raw: string | null = null;
	try {
		raw = window.localStorage.getItem(key);
	} catch {
		return EMPTY;
	}
	if (raw === null || raw === '') return EMPTY;

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return EMPTY;
	}
	if (parsed === null || typeof parsed !== 'object') return EMPTY;
	const o = parsed as Record<string, unknown>;

	const nodes = Array.isArray(o.nodes)
		? o.nodes.map(reviveNode).filter((n): n is CanvasNode => n !== null)
		: [];

	let viewport = DEFAULT_VIEWPORT;
	if (o.viewport !== null && typeof o.viewport === 'object') {
		const v = o.viewport as Record<string, unknown>;
		if (isFiniteNumber(v.x) && isFiniteNumber(v.y) && isFiniteNumber(v.zoom)) {
			viewport = { x: v.x, y: v.y, zoom: clampZoom(v.zoom) };
		}
	}

	// v1 的数据没有这个字段；顺手把非字符串项剔掉，坏数据不该让落图逻辑崩掉。
	const ingested = Array.isArray(o.ingested)
		? o.ingested.filter((id): id is string => typeof id === 'string' && id !== '')
		: [];

	return { nodes, viewport, selection: [], ingested };
}

// ─────────────────────────── store 本体 ───────────────────────────

/** 当前作用域与它对应的存储键（两者永远一起变）。 */
let scopeKey: BoardScope = null;
let storageKey = BOARD_KEY;

let state: BoardState = typeof window === 'undefined' ? EMPTY : load(storageKey);
const listeners = new Set<() => void>();
/** 「节点被新增」的订阅者（自动跟焦用，见 subscribeNodeAdditions）。 */
const additionListeners = new Set<(created: readonly CanvasNode[]) => void>();

/** 持久化写盘句柄（去抖）。 */
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** 把一块画布写进指定键（持久化只落节点、视口与记账）。 */
function writeBoard(key: string, board: Pick<BoardState, 'nodes' | 'viewport' | 'ingested'>): void {
	if (typeof window === 'undefined') return;
	try {
		window.localStorage.setItem(
			key,
			JSON.stringify({
				version: BOARD_VERSION,
				nodes: board.nodes,
				viewport: board.viewport,
				ingested: board.ingested,
			}),
		);
	} catch {
		// 配额耗尽 / 隐私模式：持久化失败不影响本次会话的内存状态。
	}
}

function persistNow(): void {
	writeBoard(storageKey, state);
}

/** 去抖持久化：拖拽节点时每帧都会改状态，不能每帧写盘。 */
function schedulePersist(): void {
	if (typeof window === 'undefined') return;
	if (saveTimer !== null) clearTimeout(saveTimer);
	saveTimer = setTimeout(() => {
		saveTimer = null;
		persistNow();
	}, 400);
}

// ─────────────────────────── 撤销 ───────────────────────────

/**
 * 撤销栈。
 *
 * **快照式**，而不是给每个动作写一遍逆运算：store 已经把全部节点变更收敛到
 * `commit()` 这一个口子，分流只要几行；逆运算则要给增删改移各写一份，还得自己
 * 还原 z / 顺序 / 落图记账 —— 那才是真正会写错的地方。
 *
 * 快照是**浅**的（节点对象按引用共享，store 从不原地改节点），50 步也就几百个
 * 引用，不吃内存。
 */
const UNDO_LIMIT = 50;

/** 同一批节点的连续微调并成一步的时间窗（拖拽每帧都在 patchNodes）。 */
const UNDO_MERGE_MS = 600;

/** 撤销栈：每项是「那次改动**之前**」的整份状态。 */
let past: BoardState[] = [];

/** 上一次记历史的时刻（只用于时间窗合并）。 */
let lastPushAt = 0;

/** 两批节点的 id 集合是否一致（一致 = 只是字段微调，可以并成一步）。 */
function sameNodeIds(a: readonly CanvasNode[], b: readonly CanvasNode[]): boolean {
	if (a.length !== b.length) return false;
	const ids = new Set(a.map((node) => node.id));
	return b.every((node) => ids.has(node.id));
}

/**
 * 把「改动前」的状态记一步。
 *
 * 合并判据是 **id 集合没变**，而不只是看时间：拖拽（每帧 patchNodes）与方向键
 * 连按当然要并成一步，但「600 毫秒内连删两个节点」是两件事 —— 撤一步只该回来
 * 一个。增删改（节点集合本身变了）一律各记一步。
 * @param nextNodes - 本次提交后的节点表。
 */
function pushHistory(nextNodes: readonly CanvasNode[]): void {
	const merge = Date.now() - lastPushAt < UNDO_MERGE_MS && sameNodeIds(state.nodes, nextNodes);
	if (!merge) {
		past.push(state);
		if (past.length > UNDO_LIMIT) past.shift();
	}
	lastPushAt = Date.now();
}

function commit(next: BoardState): void {
	// 只有**节点表**换过引用才记历史：视口与选择集都是 `...state` 展开，`nodes`
	// 引用原样保留（见下面各动作），所以这一行就是零成本的判别式。
	if (next.nodes !== state.nodes) pushHistory(next.nodes);
	state = next;
	for (const fn of listeners) fn();
	schedulePersist();
}

/** 订阅 store。 */
export function subscribeBoard(fn: () => void): () => void {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
}

/**
 * 订阅「节点被新增」。
 *
 * 与 `subscribeBoard` 分开，是因为**新增**是一个事件而不是一种状态：
 * 自动跟焦要的是「刚刚落了什么」，而不是「现在有什么」——
 * 后者在挂载时读一次就会把历史节点当成新增。
 * @param fn - 收到本次新增的节点。
 * @returns 取消订阅。
 */
export function subscribeNodeAdditions(fn: (created: readonly CanvasNode[]) => void): () => void {
	additionListeners.add(fn);
	return () => {
		additionListeners.delete(fn);
	};
}

/** 取当前快照（引用稳定，变化时才替换）。 */
export function getBoard(): BoardState {
	return state;
}

/**
 * 把画布 store 接进 React（**不用 `useSyncExternalStore`**，理由见 `state.ts`
 * 的 `useStoreValue`：实测它在真实环境里不触发重渲染，画布面板因此永远停在
 * 首帧的 `null` 上 —— 那就是「进画布黑屏」的根因）。
 * @param get - 取当前快照。
 * @returns 快照；store 变化时重渲染。
 */
function useStoreValue<T>(get: () => T): T {
	const [value, setValue] = useState<T>(get);
	useEffect(() => {
		setValue(get);
		return subscribeBoard(() => {
			setValue(get);
		});
	}, [get]);
	return value;
}

/** 订阅整个画布状态。 */
export function useBoard(): BoardState {
	return useStoreValue(getBoard);
}

/** 订阅节点表。 */
export function useNodes(): readonly CanvasNode[] {
	return useStoreValue(() => state.nodes);
}

/** 订阅视口。 */
export function useViewport(): Viewport {
	return useStoreValue(() => state.viewport);
}

/** 订阅选择集。 */
export function useSelection(): readonly string[] {
	return useStoreValue(() => state.selection);
}

/** 订阅「还有没有可撤回的步骤」（工具条撤销按钮的禁用态）。 */
export function useCanUndo(): boolean {
	return useStoreValue(canUndo);
}

// ─────────────────────────── 作用域 ───────────────────────────

/** 当前作用域（`null` = 所有会话共用一块画布）。 */
export function getBoardScope(): BoardScope {
	return scopeKey;
}

/** 当前作用域对应的存储键。 */
export function getBoardKey(): string {
	return storageKey;
}

/**
 * 切换画布作用域（画布按工作区分隔）。
 *
 * 三条不变量：
 * 1. **不丢东西**：先把当前画布落盘到**旧键**，再读新键。
 * 2. **切走再切回要还原**：每个作用域的画布与记账账本各自独立持久化，
 *    工作区 A → B → A 之后 A 的画布和它的 `ingested` 都还在，
 *    因此 A 的历史生成不会被重放成新节点。
 * 3. **不抄送**：换到另一个工作区时绝不把上一个工作区的节点带过去 ——
 *    「一个工作区一块」的全部意义就在这里。从共用那块切进某个工作区时
 *    手上该看到什么，由 `rehomeSharedBoard` 先按会话分好，不由这里兜底。
 * @param next - 目标作用域。
 */
export function setBoardScope(next: BoardScope): void {
	const nextKey = boardKeyFor(next);
	if (next === scopeKey && nextKey === storageKey) return;

	flushPersist(); // 当前画布先落到旧键

	scopeKey = next;
	storageKey = nextKey;
	// 选择集是瞬时视图状态：跨画布留着只会指向不存在的节点。
	state = load(nextKey);
	// ⚠️ 撤销栈必须跟着清空：留着它，在工作区 B 按一下 Ctrl+Z 就会把工作区 A 的
	// 节点搬进来 —— 那正好是「一个工作区一块画布」要挡住的事（数据串味，不只是显示问题）。
	past = [];
	lastPushAt = 0;
	for (const fn of listeners) fn();
}

/** 拆到空画布上时，视口给包围盒留的边距（世界像素）。 */
const REHOME_MARGIN = 40;

/**
 * 把「共用那块」按工作区拆开（一个工作区一块画布）。
 *
 * 为什么要拆而不是整块抄过去：共用那块是**所有项目**混在一起的一堆节点，
 * 整块抄进当前工作区等于把别的项目也搬来了 —— 那正是这次要修掉的毛病。
 * 每个节点上都记着它是哪个会话生成的，而工作区只有调用方查得到（会话列表），
 * 所以映射从参数进来。
 *
 * 四条规则：
 * 1. **认不出来的留在原地**（没有 `sessionId`、或那个会话已经不在列表里）：
 *    宁可让它留在共用那块（用户点「共用画布」还看得到），也不猜一个工作区。
 * 2. **按 id 去重**：同一个节点不会因为拆两遍而变成两个（幂等，可以在每次
 *    「共用 → 按工作区」时都跑一遍）。
 * 3. **记账账本一起带过去**：否则刚生成过的节点会被「最近结果补落」重放回来
 *    （`ingested` 随作用域独立，见模块头）。
 * 4. **共用那块一个字节都不动**：它是备份，拆过的东西仍然全在那里。
 * @param workspaceOf - 节点 → 工作区路径；`null` = 认不出来。
 * @returns 拆走 / 留下的节点数（日志与断言用）。
 */
export function rehomeSharedBoard(
	workspaceOf: (node: CanvasNode) => string | null,
): { moved: number; kept: number } {
	if (typeof window === 'undefined') return { moved: 0, kept: 0 };
	flushPersist(); // 手上这块可能正是共用那块，且还有没落盘的改动
	const shared = load(BOARD_KEY);
	if (shared.nodes.length === 0) return { moved: 0, kept: 0 };

	const groups = new Map<string, CanvasNode[]>();
	let kept = 0;
	for (const node of shared.nodes) {
		const workspace = workspaceOf(node);
		if (workspace === null || workspace === '') {
			kept += 1;
			continue;
		}
		const list = groups.get(workspace);
		if (list === undefined) groups.set(workspace, [node]);
		else list.push(node);
	}

	let moved = 0;
	for (const [workspace, nodes] of groups) {
		const key = boardKeyFor(workspace);
		const board = load(key);
		const known = new Set(board.nodes.map((node) => node.id));
		const fresh = nodes.filter((node) => !known.has(node.id));
		if (fresh.length === 0) continue;

		const base = topZ(board.nodes);
		const placed = fresh.map((node, index) => ({ ...node, z: base + 1 + index }));
		const box = boundsOf(placed);
		writeBoard(key, {
			nodes: [...board.nodes, ...placed].sort((a, b) => a.z - b.z),
			// 拆到一块**空**画布上时视口对准这批节点的包围盒：否则默认视口停在
			// 世界原点，而这批节点可能落在几千像素外 —— 用户看到的就是「画布是空的」。
			viewport:
				board.nodes.length === 0 && box !== null
					? { x: box.x - REHOME_MARGIN, y: box.y - REHOME_MARGIN, zoom: 1 }
					: board.viewport,
			ingested: [...new Set([...board.ingested, ...shared.ingested])],
		});
		moved += placed.length;
	}
	return { moved, kept };
}

// ─────────────────────────── 动作 ───────────────────────────

/** 取当前最大 z（空画布为 0）。 */
function topZ(nodes: readonly CanvasNode[]): number {
	let max = 0;
	for (const node of nodes) max = Math.max(max, node.z);
	return max;
}

/**
 * 新增节点。
 * @param input - 除 id/z/createdAt 外的字段；未给 x/y 时由 `placeNode` 决定落点。
 * @returns 新节点。
 */
export function addNode(input: Omit<CanvasNode, 'id' | 'z' | 'createdAt'> & { id?: string }): CanvasNode {
	const [node] = addNodes([input]);
	// addNodes 的入参非空，因此这里必定拿到一个节点
	return node ?? { ...input, id: makeNodeId(), z: 0, createdAt: Date.now() };
}

/**
 * 批量新增（P3 生成落图会一次落多个）。
 * @param inputs - 节点输入数组。
 * @returns 新增的节点。
 */
export function addNodes(
	inputs: readonly (Omit<CanvasNode, 'id' | 'z' | 'createdAt'> & { id?: string })[],
): CanvasNode[] {
	if (inputs.length === 0) return [];
	let z = topZ(state.nodes);
	const created = inputs.map((input) => {
		z += 1;
		return {
			...input,
			id: input.id ?? makeNodeId(),
			z,
			createdAt: Date.now(),
		} satisfies CanvasNode;
	});
	commit({
		...state,
		nodes: [...state.nodes, ...created].sort((a, b) => a.z - b.z),
		selection: created.map((n) => n.id),
	});
	for (const fn of additionListeners) fn(created);
	return created;
}

/**
 * 更新节点字段。
 * @param ids - 目标节点 id。
 * @param patch - 要合并的字段。
 */
export function updateNodes(
	ids: readonly string[],
	patch: Partial<Omit<CanvasNode, 'id'>>,
): void {
	if (ids.length === 0) return;
	const target = new Set(ids);
	commit({
		...state,
		nodes: state.nodes.map((node) => (target.has(node.id) ? { ...node, ...patch } : node)),
	});
}

/**
 * 按 id 逐个更新（每项可有不同 patch）——生成进度回填用。
 * @param updates - id → patch 的映射。
 */
export function patchNodes(updates: ReadonlyMap<string, Partial<Omit<CanvasNode, 'id'>>>): void {
	if (updates.size === 0) return;
	commit({
		...state,
		nodes: state.nodes.map((node) => {
			const patch = updates.get(node.id);
			return patch === undefined ? node : { ...node, ...patch };
		}),
	});
}

/**
 * 平移节点（世界坐标增量）。
 * @param ids - 目标节点 id。
 * @param dx - X 增量。
 * @param dy - Y 增量。
 */
export function translateNodes(ids: readonly string[], dx: number, dy: number): void {
	if (ids.length === 0 || (dx === 0 && dy === 0)) return;
	const target = new Set(ids);
	commit({
		...state,
		nodes: state.nodes.map((node) =>
			target.has(node.id) ? { ...node, x: node.x + dx, y: node.y + dy } : node,
		),
	});
}

/**
 * 删除节点。
 * @param ids - 目标节点 id。
 */
export function removeNodes(ids: readonly string[]): void {
	if (ids.length === 0) return;
	const target = new Set(ids);
	commit({
		...state,
		nodes: state.nodes.filter((node) => !target.has(node.id)),
		selection: state.selection.filter((id) => !target.has(id)),
	});
}

/**
 * 把节点提到最前。
 * @param ids - 目标节点 id。
 */
export function bringToFront(ids: readonly string[]): void {
	if (ids.length === 0) return;
	const target = new Set(ids);
	let z = topZ(state.nodes);
	const raised = new Map<string, number>();
	for (const id of ids) {
		z += 1;
		raised.set(id, z);
	}
	commit({
		...state,
		nodes: state.nodes
			.map((node) => {
				const next = raised.get(node.id);
				return next === undefined ? node : { ...node, z: next };
			})
			.sort((a, b) => a.z - b.z),
	});
}

/**
 * 设置视口。
 * @param viewport - 新视口（zoom 会被夹紧）。
 */
export function setViewport(viewport: Viewport): void {
	commit({ ...state, viewport: { ...viewport, zoom: clampZoom(viewport.zoom) } });
}

/**
 * 设置选择集。
 * @param ids - 选中的节点 id。
 */
export function setSelection(ids: readonly string[]): void {
	const same =
		ids.length === state.selection.length && ids.every((id, i) => state.selection[i] === id);
	if (same) return;
	commit({ ...state, selection: ids });
}

/** 追加到选择集（shift 点选）。 */
export function addToSelection(id: string): void {
	if (state.selection.includes(id)) return;
	commit({ ...state, selection: [...state.selection, id] });
}

/** 从选择集移除。 */
export function removeFromSelection(id: string): void {
	if (!state.selection.includes(id)) return;
	commit({ ...state, selection: state.selection.filter((x) => x !== id) });
}

/** 清空选择。 */
export function clearSelection(): void {
	if (state.selection.length === 0) return;
	commit({ ...state, selection: [] });
}

/** 清空整块画布（节点 + 视口）。 */
export function clearBoard(): void {
	// 刻意**保留 ingested**：清空画布之后，刚生成过的那几张图不应该立刻
	// 又从会话快照里被重放回来。下一次生成照常落图。
	commit({ ...state, nodes: [], viewport: DEFAULT_VIEWPORT, selection: [] });
}

/**
 * 撤回一步：把栈顶那份「改动前」的快照放回去。
 *
 * 刻意**不走 `commit()`** —— 那样会把当前状态先记成一步历史，等于一边撤回一边
 * 攒新的可撤回步骤，连按 Ctrl+Z 就会在原地来回跳。这里与 `setBoardScope` 一样
 * 直接换状态并广播。
 *
 * 还原的是整份快照（含视口），因此撤掉删除时视野会回到那个节点还在的地方。
 * @returns 是否真的撤回了一步（栈空时为 false）。
 */
export function undo(): boolean {
	const previous = past.pop();
	if (previous === undefined) return false;
	lastPushAt = 0; // 撤回之后的第一个动作必须自己开一步，不能并进栈顶
	state = previous;
	for (const fn of listeners) fn();
	schedulePersist();
	return true;
}

/** 现在有没有可撤回的步骤。 */
export function canUndo(): boolean {
	return past.length > 0;
}

/**
 * 记录已经落到画布上的生成调用 id（幂等记账，P3 用）。
 *
 * 并集语义：传入完整集合或增量都可以。**不发通知**——没有任何视图读这个字段，
 * 而它总是在一次已经提交过的落图动作之后写入，再发一次通知只会让画布白重渲染。
 * @param ids - 记账项（调用 id 或节点 id，由调用方约定）。
 */
export function markIngested(ids: readonly string[]): void {
	if (ids.length === 0) return;
	const next = [...new Set([...state.ingested, ...ids])];
	if (next.length === state.ingested.length) return;
	state = { ...state, ingested: next };
	schedulePersist();
}

/** 立即写盘（收尾时调用，绕过去抖）。 */
export function flushPersist(): void {
	if (saveTimer !== null) {
		clearTimeout(saveTimer);
		saveTimer = null;
	}
	persistNow();
}

/**
 * 供测试与调试：读取持久化内容的原始字符串。
 * @param scope - 作用域；省略时读**当前**作用域（`null` = 全局共用那块）。
 * @returns 原始 JSON 文本；没有数据时为 null。
 */
export function readPersistedRaw(scope?: BoardScope): string | null {
	if (typeof window === 'undefined') return null;
	const key = scope === undefined ? storageKey : boardKeyFor(scope);
	try {
		return window.localStorage.getItem(key);
	} catch {
		return null;
	}
}

/** 世界矩形（节点自身）辅助。 */
export function nodeRect(node: CanvasNode): Rect {
	return { x: node.x, y: node.y, w: node.w, h: node.h };
}
