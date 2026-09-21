/**
 * 画布 store：节点表、视口、选择集，带 localStorage 持久化。
 *
 * 沿用 `state.ts` 的外部 store 模式（`useSyncExternalStore`），不引状态库。
 * 快照是不可变对象，仅在真正变化时替换引用，因此选择器可以安全依赖身份比较。
 *
 * 持久化只落**节点、连线、视口与落图记账**：选择集是瞬时视图状态，重载后清空。
 * 反序列化逐字段校验 —— localStorage 里可能有旧版本或被手工改坏的数据，
 * 宁可退回空画布，也不要让坏数据把画布渲染成 NaN 坐标。
 *
 * `ingested` 是 P3 生成落图的**幂等记账**（已落到画布上的工具调用 id）。
 * 它必须持久化，否则重载后会话快照的历史重放会把用户删掉的节点又造回来。
 *
 * **作用域（P7）**：画布可以按会话隔离 —— `setBoardScope(sessionId)` 之后，
 * 读写的是 `fatfish-canvas:board:<sessionId>` 这个键，记账账本也随之独立。
 * 默认（`null`）仍是所有会话共用一块画布。策略（偏好 × 当前会话）在
 * `canvas/scope.ts`，本模块只负责「换键不丢东西」这件事。
 *
 * @module fatfish-canvas/client/canvas/store
 */

import { useEffect, useState } from 'react';
import { ASPECT_RATIOS, VIDEO_RESOLUTIONS } from '../shared/media';
import {
	clampZoom,
	DEFAULT_VIEWPORT,
	makeLinkId,
	makeNodeId,
	type CanvasLink,
	type CanvasNode,
	type NodeKind,
	type PortSide,
	type Rect,
	type Viewport,
} from './model';

const BOARD_KEY = 'fatfish-canvas:board';

/**
 * 画布作用域：`null` = 所有会话共用一块画布；字符串 = 该会话自己的画布。
 *
 * 刻意用**裸字符串**而不是 `{ kind, sessionId }` 对象：作用域的唯一用途就是
 * 选一个存储键，多一层包装只会让比较与序列化都变啰嗦。
 */
export type BoardScope = string | null;

/** 当前持久化格式版本（v1 没有 ingested；v2 没有 links，读到时按空表处理）。 */
const BOARD_VERSION = 3;

/**
 * 作用域 → 存储键。
 * @param scope - 作用域（`null` = 全局）。
 * @returns localStorage 键名。
 */
export function boardKeyFor(scope: BoardScope): string {
	return scope === null || scope === '' ? BOARD_KEY : `${BOARD_KEY}:${scope}`;
}

/**
 * **会话画布键**的前缀（回收用，P25）。
 *
 * ⚠️ 必须带那个冒号：`fatfish-canvas:board-scope`（作用域偏好）也以
 * `fatfish-canvas:board` 开头，按不带冒号的前缀筛「会话画布键」会把偏好键
 * 当成一块画布 —— 而回收的下一个动作就是把它删掉（§8.17 记着这个坑）。
 */
export const SESSION_BOARD_PREFIX = `${BOARD_KEY}:`;

/**
 * 从存储键反解出它属于哪个会话。
 * @param key - localStorage 键。
 * @returns 会话 id；不是会话画布键时为 null。
 */
export function sessionOfBoardKey(key: string): string | null {
	if (!key.startsWith(SESSION_BOARD_PREFIX)) return null;
	const id = key.slice(SESSION_BOARD_PREFIX.length);
	return id === '' ? null : id;
}

/** store 快照。 */
export interface BoardState {
	/** 全部节点，按 z 升序（后面的画在上面）。 */
	nodes: readonly CanvasNode[];
	/** 全部连线（P18）。端点一定存在于 `nodes` 里 —— 见 `removeNodes` 的级联。 */
	links: readonly CanvasLink[];
	/** 当前视口。 */
	viewport: Viewport;
	/** 选中节点 id。 */
	selection: readonly string[];
	/** 已经落到画布上的生成调用 id（幂等记账，见模块头）。 */
	ingested: readonly string[];
}

const EMPTY: BoardState = {
	nodes: [],
	links: [],
	viewport: DEFAULT_VIEWPORT,
	selection: [],
	ingested: [],
};

// ─────────────────────────── 反序列化校验 ───────────────────────────

const isFiniteNumber = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value);

const KINDS: readonly NodeKind[] = ['image', 'video', 'text', 'gen'];

/** 合法的连接点方位。 */
const SIDES: readonly PortSide[] = ['n', 'e', 's', 'w'];

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
		...(typeof o.ref === 'string' && o.ref !== '' ? { ref: o.ref } : {}),
		...(typeof o.poster === 'string' ? { poster: o.poster } : {}),
		...(typeof o.title === 'string' ? { title: o.title } : {}),
		...(typeof o.prompt === 'string' ? { prompt: o.prompt } : {}),
		...(typeof o.model === 'string' ? { model: o.model } : {}),
		...(typeof o.error === 'string' ? { error: o.error } : {}),
		createdAt: isFiniteNumber(o.createdAt) ? o.createdAt : Date.now(),
		...(typeof o.sessionId === 'string' ? { sessionId: o.sessionId } : {}),
		...(typeof o.workflow === 'string' && o.workflow !== '' ? { workflow: o.workflow } : {}),
		// 生成节点的参数（P19）：坏值一律丢掉，让 `genKindOf` / `genRatioOf` 的
		// 缺省值兜底 —— 宁可回到「图像 · 1:1」，也不要让一个荒唐比例进命令行。
		...(o.genKind === 'video' || o.genKind === 'image' ? { genKind: o.genKind } : {}),
		...(typeof o.ratio === 'string' && ASPECT_RATIOS.includes(o.ratio) ? { ratio: o.ratio } : {}),
		...(isFiniteNumber(o.duration) && o.duration > 0 ? { duration: o.duration } : {}),
		...(typeof o.resolution === 'string' && VIDEO_RESOLUTIONS.includes(o.resolution)
			? { resolution: o.resolution }
			: {}),
	};
}

/**
 * 校验并规范化一条连线。
 *
 * 端点是否存在于节点表里**不在这里判**：反序列化时连线与节点是分别读的，
 * 这个函数看不到节点表。悬空端点在 `load` 里统一剔除（见那里的一段）。
 * @param raw - 来自存储的原始值。
 * @returns 合法连线；不可修复时返回 null。
 */
function reviveLink(raw: unknown): CanvasLink | null {
	if (raw === null || typeof raw !== 'object') return null;
	const o = raw as Record<string, unknown>;
	if (typeof o.id !== 'string' || o.id === '') return null;
	if (typeof o.from !== 'string' || o.from === '') return null;
	if (typeof o.to !== 'string' || o.to === '') return null;
	if (!SIDES.includes(o.fromSide as PortSide) || !SIDES.includes(o.toSide as PortSide)) return null;
	return {
		id: o.id,
		from: o.from,
		to: o.to,
		fromSide: o.fromSide as PortSide,
		toSide: o.toSide as PortSide,
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

	// v2 及更早没有连线。**悬空连线必须在这里剔除**：渲染时它要按 id 找端点，
	// 找不到就会在原点画出一条谁也不知道从哪来的线（或直接抛错）。
	const ids = new Set(nodes.map((node) => node.id));
	const links = (Array.isArray(o.links) ? o.links : [])
		.map(reviveLink)
		.filter((link): link is CanvasLink => link !== null)
		.filter((link) => ids.has(link.from) && ids.has(link.to));

	return { nodes, links, viewport, selection: [], ingested };
}

// ─────────────────────────── store 本体 ───────────────────────────

/** 当前作用域与它对应的存储键（两者永远一起变）。 */
let scopeKey: BoardScope = null;
let storageKey = BOARD_KEY;
/** 当前作用域是否已经有持久化数据（决定「采用当前画布」与否）。 */
function hasStored(key: string): boolean {
	if (typeof window === 'undefined') return false;
	try {
		return window.localStorage.getItem(key) !== null;
	} catch {
		return false;
	}
}

let state: BoardState = typeof window === 'undefined' ? EMPTY : load(storageKey);
const listeners = new Set<() => void>();
/** 「节点被新增」的订阅者（自动跟焦用，见 subscribeNodeAdditions）。 */
const additionListeners = new Set<(created: readonly CanvasNode[]) => void>();

/** 持久化写盘句柄（去抖）。 */
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function persistNow(): void {
	if (typeof window === 'undefined') return;
	try {
		window.localStorage.setItem(
			storageKey,
			JSON.stringify({
				version: BOARD_VERSION,
				nodes: state.nodes,
				links: state.links,
				viewport: state.viewport,
				ingested: state.ingested,
			}),
		);
	} catch {
		// 配额耗尽 / 隐私模式：持久化失败不影响本次会话的内存状态。
	}
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

function commit(next: BoardState): void {
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

/** 订阅连线表（P18）。 */
export function useLinks(): readonly CanvasLink[] {
	return useStoreValue(() => state.links);
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
 * 切换画布作用域（P7：画布按会话隔离）。
 *
 * 三条不变量：
 * 1. **不丢东西**：先把当前画布落盘到**旧键**，再读新键。
 * 2. **`adopt` 只在「新键从没写过」时生效**：用户刚打开隔离开关时，
 *    手上的画布应该跟着自己走，而不是当场变空。
 * 3. **切走再切回要还原**：每个作用域的画布与记账账本各自独立持久化，
 *    A 会话 → B 会话 → A 会话 之后 A 的画布和它的 `ingested` 都还在，
 *    因此 A 的历史生成不会被重放成新节点。
 *
 * ⚠️ `adopt` 必须由调用方按「从共用切进隔离」判定，**不能**无条件传 true：
 * 会话 A → 会话 B 时若 B 的键恰好为空，无条件采用会把 A 的画布抄进 B 里。
 * @param next - 目标作用域。
 * @param options - `adopt`：新键为空时把当前画布整体带过去。
 */
export function setBoardScope(next: BoardScope, options: { adopt?: boolean } = {}): void {
	const nextKey = boardKeyFor(next);
	if (next === scopeKey && nextKey === storageKey) return;

	flushPersist(); // 当前画布先落到旧键
	const carry = options.adopt === true && !hasStored(nextKey) && state.nodes.length > 0;

	scopeKey = next;
	storageKey = nextKey;
	// 选择集是瞬时视图状态：跨画布留着只会指向不存在的节点。
	state = carry ? { ...state, selection: [] } : load(nextKey);
	if (carry) persistNow(); // 采用过来的画布立刻成为新键的内容
	for (const fn of listeners) fn();
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
 *
 * **级联删连线**：连线的一端没了，线就必须一起走。放在这里而不是让渲染层
 * 跳过悬空连线 —— 后者会让坏数据永远留在 localStorage 里，而且每个读
 * 连线的地方都得自己再防一次。
 * @param ids - 目标节点 id。
 */
export function removeNodes(ids: readonly string[]): void {
	if (ids.length === 0) return;
	const target = new Set(ids);
	commit({
		...state,
		nodes: state.nodes.filter((node) => !target.has(node.id)),
		links: state.links.filter((link) => !target.has(link.from) && !target.has(link.to)),
		selection: state.selection.filter((id) => !target.has(id)),
	});
}

/**
 * 新增连线。
 * @param inputs - 除 id 外的字段。
 * @returns 新增的连线。
 */
export function addLinks(
	inputs: readonly (Omit<CanvasLink, 'id'> & { id?: string })[],
): CanvasLink[] {
	if (inputs.length === 0) return [];
	const created = inputs.map(
		(input) => ({ ...input, id: input.id ?? makeLinkId() }) satisfies CanvasLink,
	);
	commit({ ...state, links: [...state.links, ...created] });
	return created;
}

/**
 * 删除连线。
 * @param ids - 目标连线 id。
 */
export function removeLinks(ids: readonly string[]): void {
	if (ids.length === 0) return;
	const target = new Set(ids);
	const next = state.links.filter((link) => !target.has(link.id));
	if (next.length === state.links.length) return;
	commit({ ...state, links: next });
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

/** 清空整块画布（节点 + 连线 + 视口）。 */
export function clearBoard(): void {
	// 刻意**保留 ingested**：清空画布之后，刚生成过的那几张图不应该立刻
	// 又从会话快照里被重放回来。下一次生成照常落图。
	commit({ ...state, nodes: [], links: [], viewport: DEFAULT_VIEWPORT, selection: [] });
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
