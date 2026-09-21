/**
 * 统一基座（unified base）的本地类型声明。
 *
 * DSH 浏览器外壳只播种 7 个精确 specifier，客户端 bundle 的同步 `require`
 * 只解析这些词条（已在本机前端产物 `assets/index-*.js` 的 `Gd()` 中核实）：
 *
 *   react | react/jsx-runtime | react-dom | react-dom/client
 *   @deepseek-ai/cordis | @deepseek-ai/dsh-client-ui-slots
 *   @deepseek-ai/dsh-client-ui-primitives
 *
 * 这里手写声明而不是安装官方类型包：本包不依赖 npm 上 `@deepseek-ai/*` 的
 * 版本可用性，构建路径（esbuild）本身不做类型检查，因此声明只服务于
 * `pnpm typecheck`。等类型面稳定后可以替换为官方包。
 */

// ───────────────────────────── react ─────────────────────────────

declare module 'react' {
	export type ReactNode = unknown;
	export type CSSProperties = Record<string, string | number | undefined>;
	export type Ref<T> = { current: T | null };

	export function useState<S>(
		initial: S | (() => S),
	): [S, (next: S | ((prev: S) => S)) => void];
	export function useEffect(
		effect: () => void | (() => void),
		deps?: readonly unknown[],
	): void;
	export function useLayoutEffect(
		effect: () => void | (() => void),
		deps?: readonly unknown[],
	): void;
	export function useMemo<T>(factory: () => T, deps?: readonly unknown[]): T;
	/**
	 * `useRef` 的**精确**语义：`current` 的类型就是 `T` 本身，不是 `T | null`。
	 * 想要可空引用时，调用方自己写成 `useRef<X | null>(null)` —— 这正是 React
	 * 的真实 API。早期版本把 `current` 声明成 `T | null`，于是每一处 ref 读取
	 * 都要多写一次非空断言，或干脆报错（本项目曾因此积了二十多条假报错）。
	 */
	export function useRef<T>(initial: T): { current: T };
	export function useCallback<T extends (...args: never[]) => unknown>(
		fn: T,
		deps?: readonly unknown[],
	): T;
	export function useSyncExternalStore<T>(
		subscribe: (onStoreChange: () => void) => () => void,
		getSnapshot: () => T,
	): T;
	export function createElement(
		type: unknown,
		props?: Record<string, unknown> | null,
		...children: unknown[]
	): unknown;
	export const Fragment: unknown;

	/** 指针捕获所需的最小元素面（避免依赖完整 lib.dom 的 React 事件类型）。 */
	export interface PointerCaptureTarget {
		setPointerCapture(pointerId: number): void;
		hasPointerCapture(pointerId: number): boolean;
		releasePointerCapture(pointerId: number): void;
	}
	/** React 合成指针事件（本包只用到这几个成员）。 */
	export interface PointerEvent<T = PointerCaptureTarget> {
		clientX: number;
		clientY: number;
		pointerId: number;
		/** 0 = 左键，1 = 中键，2 = 右键。 */
		button: number;
		shiftKey: boolean;
		ctrlKey: boolean;
		metaKey: boolean;
		altKey: boolean;
		/** 事件目标（需要判「点的是不是控件」）。 */
		target: EventTarget;
		preventDefault(): void;
		stopPropagation(): void;
		currentTarget: T;
	}
	/** React 合成键盘事件。 */
	export interface KeyboardEvent {
		key: string;
	}
	/** React 合成鼠标事件。 */
	export interface MouseEvent {
		clientX: number;
		clientY: number;
		preventDefault(): void;
	}

	const React: {
		createElement: typeof createElement;
		Fragment: unknown;
		useState: typeof useState;
		useEffect: typeof useEffect;
		useLayoutEffect: typeof useLayoutEffect;
		useMemo: typeof useMemo;
		useRef: typeof useRef;
		useCallback: typeof useCallback;
		useSyncExternalStore: typeof useSyncExternalStore;
	};
	export default React;
}

declare module 'react/jsx-runtime' {
	export const Fragment: unknown;
	export function jsx(type: unknown, props: Record<string, unknown>): unknown;
	export function jsxs(type: unknown, props: Record<string, unknown>): unknown;
	/**
	 * JSX 类型命名空间。`jsx: react-jsx` 模式下 TypeScript 优先从
	 * `react/jsx-runtime` 解析 JSX 类型，因此声明在这里即可，
	 * 无需（也无法在非模块 .d.ts 里）做全局 `declare global` 增强。
	 */
	export namespace JSX {
		interface Element {}
		/**
		 * 放宽「什么能当 JSX 标签」。本 shim 把 `ReactNode` 定成 `unknown`
		 * （见 react 声明），而 TS 默认要求组件的返回类型可赋给 `Element`，
		 * 于是每一个自绘组件都会误报 TS2786「不能作为 JSX 组件使用」。
		 * 用 5.1+ 的 `ElementType` 放宽后，误报消失，而属性检查仍然生效。
		 */
		type ElementType = any;
		interface ElementChildrenAttribute {
			children: Record<string, never>;
		}
		/**
		 * 宿主元素的属性面。
		 *
		 * 刻意用「宽松索引 + 显式事件属性」而不是官方 React 类型：
		 *   - 索引签名让任意属性（`data-*`、`aria-*`、`src`、`controls`…）都能写；
		 *   - 事件属性**必须显式列出**，否则箭头函数的参数拿不到上下文类型，
		 *     每一处 `onClick={(event) => …}` 都会报 `noImplicitAny`。
		 * 事件参数用 `any`：本包自己的指针事件面（见上面的 React.PointerEvent）
		 * 与 lib.dom 的并不互相兼容，两边都不是官方类型，强行统一只会制造新报错。
		 */
		type FfcHandler = (event: any) => void;
		interface FfcEventProps {
			onClick?: FfcHandler;
			onDoubleClick?: FfcHandler;
			onContextMenu?: FfcHandler;
			onPointerDown?: FfcHandler;
			onPointerMove?: FfcHandler;
			onPointerUp?: FfcHandler;
			onPointerCancel?: FfcHandler;
			onPointerEnter?: FfcHandler;
			onPointerLeave?: FfcHandler;
			onKeyDown?: FfcHandler;
			onKeyUp?: FfcHandler;
			onChange?: FfcHandler;
			onInput?: FfcHandler;
			onBlur?: FfcHandler;
			onFocus?: FfcHandler;
			onSubmit?: FfcHandler;
		}
		interface IntrinsicElements {
			[name: string]: Record<string, unknown> & FfcEventProps;
		}
		interface IntrinsicAttributes {
			key?: string | number;
		}
	}
}

declare module 'react-dom' {
	const ReactDOM: Record<string, unknown>;
	/**
	 * 把一个子树挂到别处 —— 本体官方插件就是这么把弹层挂到 `document.body` 的
	 * （免得被祖先的 `overflow` 裁掉、或被祖先的 `transform` 改变定位基准）。
	 * @param children - 子树。
	 * @param container - 目标容器。
	 * @returns 可渲染的节点。
	 */
	export function createPortal(children: unknown, container: unknown): ReactNode;
	export default ReactDOM;
}

declare module 'react-dom/client' {
	export function createRoot(container: Element): { render(node: unknown): void };
}

// ────────────────────────── @deepseek-ai/cordis ──────────────────────────

declare module '@deepseek-ai/cordis' {
	/** cordis context：本包只用到 effect 与事件/注入面，其余按需扩展。 */
	export interface Context {
		/**
		 * 在调用方 fiber 上安装一个 effect：插件卸载即回收。
		 * @param effect - 返回 disposer 的副作用。
		 * @param label - 诊断标签。
		 */
		effect(effect: () => (() => void) | void, label?: string): void;
		/** 订阅事件，返回取消订阅函数。 */
		on(event: string, listener: (...args: never[]) => void): () => void;
		/** 服务注入：目标服务就绪时调用回调。 */
		inject(
			deps: readonly string[],
			callback: (ctx: Context) => void,
		): void;
		/** 按名字取一个可能缺席的服务（不抛错）。 */
		get(name: string): unknown;
		/**
		 * 提供一个服务（返回注销函数）。
		 *
		 * 必须在**插件顶层 ctx** 上 provide：宿主侧的 Typert 网关按名字从应用
		 * 的服务表里解析接收者，在嵌套的 inject scope 里 provide 的服务不一定
		 * 对它可见（P9 的 mediaProbe 就栽过这个位置问题）。
		 * @param name - 服务名。
		 * @param value - 服务实例。
		 * @returns 注销函数。
		 */
		provide(name: string, value: unknown): () => void;
		/** 反射面（provide 等）。 */
		reflect: { provide(name: string, value: unknown): () => void };
		/** 插槽注册表（由 dsh-client-runtime 提供）。 */
		slots: DshSlots;
		/** 视图模式切换时需要协同的面板动作（由 ui-layout 提供）。 */
		layout: DshLayout;
		/** 用户设置服务（@deepseek-ai/dsh-settings 提供）。 */
		settings: DshSettings;
		/** 工具注册表（@deepseek-ai/dsh-tools 提供）。 */
		tools: DshTools;
		/** 直达命令注册表（@deepseek-ai/dsh-commands 提供）。 */
		commands: DshCommands;
		/** 设置传输层（@deepseek-ai/dsh-client-ui-settings 提供）。 */
		settingsScope: DshClientSettingsScopeHost;
		/** 会话服务（dsh-client-runtime 提供）。 */
		sessions: DshSessions;
		/** 远程调用面（dsh-api-gateway 提供）：客户端调宿主服务就靠它。 */
		remote: DshClientRemote;
		/** 凭据服务（宿主侧，dsh-credentials 提供）。 */
		credentials: DshHostCredentials;
		/**
		 * Typert 注册表（宿主侧，dsh-typert-registry 提供）。
		 * 客户端也有同名服务，但客户端半边不注册清单（它挂的是 $mount 贡献）。
		 */
		typert: { register(manifest: unknown): unknown };
	}
	export class Service {
		protected constructor(ctx: Context);
	}
}

// ─────────────── 客户端设置传输层（ui-settings 提供） ───────────────

/** `ctx.settingsScope` 在本插件用到的那一面。 */
interface DshClientSettingsScopeHost {
	/**
	 * 把一个 namespace 绑成按命名空间的 scope。
	 * @param spec - namespace 名与可选解码器。
	 * @returns 该 namespace 的 scope。
	 */
	bind<T>(spec: {
		namespace: string;
		decode?: (section: unknown) => T | undefined;
	}): DshClientSettingsScope<T>;
}

/** 一个 namespace 的客户端同步快照。 */
interface DshClientSettingsSnapshot<T> {
	/** `loading` → 尚未拿到第一份分节；`ready` → 有值；`unavailable` → 读不到设置。 */
	status: 'loading' | 'ready' | 'unavailable';
	/** 最后一次被接受的、经 schema 解析的分节。 */
	value: T | undefined;
	/** 组合层。 */
	base: unknown;
	/** 原始用户层（字段出现即表示被用户覆盖过）。 */
	user: unknown;
	/** 命名空间 revision，写回时用作并发栅栏。 */
	revision: number | undefined;
	/** Host 文档是否接受写入。 */
	writable: boolean;
	/** `host` 与 Host 文档同步；`memory` 只在远端浏览器进程内。 */
	mode: 'host' | 'memory';
}

/** 一个 namespace 的客户端 scope。 */
interface DshClientSettingsScope<T> {
	/** 当前快照（引用稳定，变化时才替换）。 */
	getSnapshot(): DshClientSettingsSnapshot<T>;
	/** 订阅快照替换。 */
	subscribe(listener: () => void): () => void;
	/**
	 * 写一个**顶层标量字段**（底层是单条 `set` 路径 op，因此不会碰到别的字段）。
	 * @param field - 字段名。
	 * @param value - 新值。
	 */
	set(field: string, value: unknown): Promise<void>;
	/**
	 * 清除一个字段，使其重新继承组合层 / schema 默认。
	 * @param field - 字段名。
	 */
	unset(field: string): Promise<void>;
}

// ─────────────── 宿主服务面（dsh-settings / dsh-tools） ───────────────
//
// 这两个包**不**作为运行时依赖引入：宿主半边只需满足它们的结构契约，
// `ctx.tools.register` 只读结构、不检查原型。声明在这里是为了让 typecheck
// 有意义，而不必为一个结构匹配多背一个依赖（out-of-tree 插件每多一个依赖，
// 就多一处版本漂移面）。

/** settings 服务在本插件用到的那一面。 */
interface DshSettings {
	/**
	 * 注册一个 namespace 并拿到 owner scope。
	 * @param ns - 小写 kebab-case 的 namespace 名。
	 * @param schema - schemastery schema。
	 * @param options - 组合 base 层与生效时机。
	 * @returns owner scope。
	 */
	register<T>(
		ns: string,
		schema: unknown,
		options?: {
			base?: Partial<T>;
			applies?: 'live' | 'restart';
			validate?: (value: T) => void;
		},
	): DshSettingsScope<T>;
	/**
	 * 对**用户层**应用一批深路径 op（`set` / `unset`）。
	 *
	 * 这是唯一能写嵌套叶子、也是唯一能删字段的写入口：owner scope 的
	 * `update` 只做浅合并、删不掉东西，而 `unset` 正是**迁移旧字段**必需的
	 * （残留的不明字段不会被脱敏，会被原样下发到浏览器）。
	 * @param ns - namespace 名。
	 * @param ops - 路径 op 列表。
	 * @param expectedRevision - 并发栅栏（可选）。
	 */
	mutate(
		ns: string,
		ops: readonly { op: 'set' | 'unset'; path: string[]; value?: unknown }[],
		expectedRevision?: number,
	): Promise<unknown>;
}

/** 一个 namespace 的 owner scope。 */
interface DshSettingsScope<T> {
	/** 读取解析值（schema 默认 → 组合 base → 用户层）。 */
	get(): T;
	/** 观察已提交的变化。 */
	watch(callback: (next: T, prev: T) => void | Promise<void>): () => void;
	/** 把局部 patch 合并进用户层并持久化。 */
	update(patch: object): Promise<void>;
	/** 整体替换用户层。 */
	replace(section: object): Promise<void>;
}

// ─────────── 远程调用面（P9：设置写入 / 密钥 / 宿主探测） ───────────
//
// 设置页要做三件超出「顶层标量 scope」的事：写嵌套叶子、存取密钥、调宿主探测。
// 三者都走 `ctx.remote.<命名空间>`：`remote.settings` / `remote.credentials` 由
// dsh-api-settings-controller 派生，探测是本插件自己挂上去的贡献
// （`remote.mediaProbe`，见 shared/probe.ts）。
//
// ⚠️ 信封是**一层**的：`{ ok: true, value }` / `{ ok: false, error: { code, message } }`
// —— 与 dsh-client-ui-settings-models 的用法一致。早期版本走 `ctx.connection.api`
// 的 `{ rpcId, result }` 两层信封，而那个面**已经不存在**（`ctx.connection` 现在只有
// rpc / generation / state），插件当时只迁移了探测半边：于是设置页的每一次写入都死在
// `undefined.settings`（实测：改基址失焦即回退、点删除报
// `Cannot read properties of undefined (reading 'settings')`）。

/** 一次远程调用的结果信封。 */
type DshRemoteResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

/** 一条路径 op（`settings.mutate` 的载荷）。 */
interface DshSettingsPathOp {
	/** `set` 写入 / `unset` 清除。 */
	op: 'set' | 'unset';
	/** 从 namespace 根算起的路径。 */
	path: string[];
	/** `set` 的值。 */
	value?: unknown;
}

/** `remote.settings` 在本插件用到的那一面。 */
interface DshRemoteSettings {
	/**
	 * 对某个 namespace 的用户层应用路径 op。
	 * @param ns - namespace 名。
	 * @param ops - 路径 op，按顺序应用。
	 * @param expectedRevision - 读到的 revision；`undefined` = 不做并发栅栏。
	 * @returns 写入后的脱敏视图；冲突时 `error.code === 'settings/conflict'`。
	 */
	mutate(
		ns: string,
		ops: readonly DshSettingsPathOp[],
		expectedRevision?: number,
	): Promise<DshRemoteResult<unknown>>;
}

/** `remote.credentials` 在本插件用到的那一面（值只写不读）。 */
interface DshRemoteCredentials {
	/**
	 * 描述若干引用的状态（configured / source / writable，**永不回值**）。
	 * @param refs - 引用名。
	 * @returns 按引用名键控的状态表。
	 */
	describe(
		refs: readonly string[],
	): Promise<DshRemoteResult<Record<string, { configured: boolean; source?: string; writable: boolean }>>>;
	/**
	 * 写入一个凭据。
	 * @param ref - 引用名。
	 * @param value - 非空值。
	 */
	set(ref: string, value: string): Promise<DshRemoteResult<unknown>>;
	/**
	 * 删除一个凭据。
	 * @param ref - 引用名。
	 */
	unset(ref: string): Promise<DshRemoteResult<unknown>>;
}

/** 设置页要用的宿主写入面（apply 期捕获，随分节注入）。 */
interface DshHostApi {
	/** 深路径写入。 */
	settings: DshRemoteSettings;
	/** 凭据读写。 */
	credentials: DshRemoteCredentials;
}

/**
 * `ctx.remote` 在本插件用到的那一面。
 *
 * 各命名空间（`remote.settings` / `remote.credentials` / `remote.mediaProbe`）
 * 是派生服务，要在**声明过该依赖**的 scope 里用 `ctx.get(名字)` 取（见 index.tsx）。
 */
interface DshClientRemote {
	/**
	 * 挂上一份远程贡献。
	 * @param contribution - `{ package, descriptors }`。
	 * @returns 卸载函数。
	 */
	$mount(contribution: unknown): Promise<() => void>;
}

/** `ctx.credentials`（宿主侧）在本插件用到的那一面。 */
interface DshHostCredentials {
	/**
	 * 解析一个引用。
	 * @param ref - 引用名。
	 * @returns 值与来源；未配置时为 undefined。
	 */
	resolve(ref: string): Promise<{ value: string; source: string } | undefined>;
	/**
	 * 写入一个凭据。
	 * @param ref - 引用名。
	 * @param value - 非空值。
	 */
	set(ref: string, value: string): Promise<void>;
	/**
	 * 删除一个凭据。
	 * @param ref - 引用名。
	 */
	unset(ref: string): Promise<void>;
}

/** 直达命令注册表（`@deepseek-ai/dsh-commands`）在本插件用到的那一面。 */
interface DshCommands {
	/**
	 * 注册一个人可敲的命令（不带斜杠的**小写**名字）。
	 * @param definition - 满足 `CommandDefinition` 契约的对象
	 *   （name / description / input / handler）。
	 * @returns 注销函数。
	 */
	register(definition: Record<string, unknown>): () => void;
}

/** 工具注册表在本插件用到的那一面。 */
interface DshTools {	/**
	 * 注册一个工具。
	 * @param definition - 满足 ToolDefinition 契约的对象
	 *   （name / description / parameters / output / execute）。
	 * @returns 注销函数。
	 */
	register(definition: Record<string, unknown>): () => void;
	/** 为本 scope 限制全局工具可见性。 */
	restrict(filter: { allow?: readonly string[]; deny?: readonly string[] }): () => void;
	/** 注册一个单调守卫。 */
	guard(guard: (exec: unknown) => string | undefined): () => void;
	/** 按 scope 解析一个工具定义。 */
	get(name: string, scope?: unknown): Record<string, unknown> | undefined;
}

// ─────────────────── @deepseek-ai/dsh-client-ui-slots ───────────────────

interface DshSlotRegistration {
	/** 目标槽位键（如 `shell.overlay`、`tool.call.toolview`）。 */
	name: string;
	/**
	 * 列表 / keyed 席位的条目标识。
	 * 列表席位（如 `shell.overlay`）用 `id`；**keyed** 席位
	 * （如 `tool.call.toolview`，key 域是工具名）用 `key`。
	 */
	id?: string;
	/** keyed 席位的分派键（工具行用线上工具名）。 */
	key?: string;
	/** 导航次序（`settings.section` 用）。 */
	order?: number;
	/**
	 * 导航标题 / 无障碍标签。`settings.section` 用**纯字符串**（已实测：写成
	 * locale key 时条目注册成功但导航里不出现）；列表席位允许惰性求值。
	 */
	label?: string | (() => string);
	/** 注入面：返回值作为 props 传给组件。 */
	inject?: (...args: never[]) => Record<string, unknown>;
}

/** `ctx.slots` 的对外面。 */
interface DshSlots {
	/**
	 * 注册一个条目到某个槽位。
	 * @param spec - 条目声明（`name` 为目标槽位键）。
	 * @param component - 渲染用的 React 组件。
	 * @returns 注销函数。
	 */
	register(spec: DshSlotRegistration, component: unknown): () => void;
	/**
	 * 在槽位「被声明」的生命周期内安装 effect：槽位已声明则同步执行。
	 * @param key - 槽位键（如 `'shell.overlay'`、`'settings.section'`）。
	 * @param callback - 返回一个或一组 disposer。
	 * @returns 幂等的取消函数。
	 */
	inject(key: string, callback: () => (() => void) | Iterable<() => void>): () => void;
}

// ─────────────────────── ui-layout 的面板动作面 ───────────────────────

interface DshLayout {
	/** 切换侧边栏（关闭 ⟷ 契约默认宽度）。 */
	toggleSidebar(): void;
	/** 打开详情栏（已打开时为 no-op）。 */
	openDetails(): void;
	/** 关闭详情栏。 */
	closeDetails(): void;
}

// ────────── 会话服务（dsh-client-runtime 提供，P3 落图用） ──────────

/**
 * 最小可观察快照源。会话列表 store 与会话对象本身都满足它
 * （运行时契约里的 `ObservableSnapshot<T>`）。
 */
interface DshObservableSnapshot<T> {
	/** 当前快照（引用稳定，变化时才替换）。 */
	getSnapshot(): T;
	/** 订阅快照替换。 */
	subscribe(fn: () => void): () => void;
}

/** 会话列表 store 里本插件读取的那一面。 */
interface DshSessionListState {
	/** 当前选中的会话 id（无会话时为 undefined）。 */
	current: string | undefined;
	/**
	 * 宿主**可见的全部**会话 id（P25 的画布回收靠它判「这个会话还在不在」）。
	 *
	 * 平台契约（`dsh-api-session-controller` 的 `client/sessions/service.d.ts`）：
	 * `ids` 是 Host-list 顺序，**不含**「只有面包屑的分支行」（子代理地址行）；
	 * `list()` 读的是 `sessionQuery.listSessions()` —— 它列的是**持久化里的全部可见
	 * 会话**，不按工作区过滤（这是敢按它删东西的前提：换个工作区启动 dsh web
	 * 不会把别的工作区的画布当成孤儿）。缺席时按「不知道」办 —— 什么都不删。
	 */
	ids?: readonly string[] | undefined;
	/**
	 * 列表生命期：`pending` = 还在拉，`ready` = 已就位（`ready` + 空表 = 真的没有会话）。
	 * 只有 `ready` 才允许回收 —— 这是平台自己给的「这份表是全的」信号。
	 */
	phase?: 'pending' | 'ready' | undefined;
}

/**
 * 会话对象（`SessionFace`）里本插件读取的那一面。
 *
 * ⚠️ **会话数据不在这里**：真实的 `SessionSnapshot`（`contract/snapshot.d.ts`）
 * 只有生命周期与队列状态（`running` / `openState` / `queue` / …），
 * **没有** `nodes` / `runningCalls` —— 那两样属于 Conversation 目标的投影。
 * 生成结果要从 `DshSessionBinding.eventSource`（事件窗口）里折叠，
 * 见 `canvas/bridge.ts` 的 `conversationOf`。
 */
interface DshSessionFace {
	/** 会话自身的生命周期快照（**不含**会话记录）。 */
	getSnapshot(): unknown;
	/** 订阅快照替换 —— 流式输出期间会高频触发。 */
	subscribe(fn: () => void): () => void;
	/**
	 * 向会话投递一条提示词（右键菜单的「重新生成」用；工具只在宿主侧执行，
	 * 浏览器能发起的只有一条提示词）。
	 * @param content - 内容块（只用到 `{ type: 'text', text }`）。
	 * @param mode - `queue` 追加一轮；`steer` 打断当前轮。
	 * @returns RPC 结果。
	 */
	prompt(
		content: readonly { type: 'text'; text: string }[],
		mode: 'queue' | 'steer',
	): Promise<unknown>;
	/**
	 * 在会话里执行一行斜杠命令（右键菜单的「重新生成」优先走 `/generate`）。
	 * 未匹配的命令以 `{ matched: false }` 结算，**不抛错**。
	 * @param line - 完整命令行（含前导斜杠）。
	 * @returns RPC 结果。
	 */
	command(line: string): Promise<unknown>;
}

/** 一个会话的装配句柄。 */
interface DshSessionBinding {
	/** 会话 id。 */
	readonly sessionId: string;
	/** 只读会话面（生命周期与提示词投递）。 */
	readonly session: DshSessionFace;
	/**
	 * 会话**事件窗口**（`ObservableSnapshot<SessionEventWindow>`）。
	 * 生成结果的唯一实时来源：`entries[]` 里是原始的 `tool/call` / `tool/result` /
	 * `command/run` / `command/done` 事件。
	 */
	readonly eventSource: DshObservableSnapshot<unknown>;
}

/** `ctx.sessions` 在本插件用到的那一面。 */
interface DshSessions {
	/** 会话列表 + 当前选择（同一个快照）。 */
	readonly list: DshObservableSnapshot<DshSessionListState>;
	/**
	 * 解析一个会话的装配句柄。
	 * @param id - 会话 id。
	 * @returns 句柄；会话既不在列表里也未被 scoped 时为 undefined。
	 */
	binding(id: string): DshSessionBinding | undefined;
}

// ────────── @deepseek-ai/dsh-client-ui-primitives（按需取用） ──────────

declare module '@deepseek-ai/dsh-client-ui-primitives' {
	import type { ReactNode } from 'react';

	/** 主题快捷方式（P0 未使用，保留给后续阶段）。 */
	export const Button: (props: Record<string, unknown>) => ReactNode;
	export const Menu: (props: Record<string, unknown>) => ReactNode;
	export const Tooltip: (props: Record<string, unknown>) => ReactNode;
	export const Pill: (props: Record<string, unknown>) => ReactNode;
	export const Toast: (props: Record<string, unknown>) => ReactNode;
	export const IconCloseOutline16: (props: Record<string, unknown>) => ReactNode;
	export const IconPlusOutline16: (props: Record<string, unknown>) => ReactNode;
	export const IconSparkle16: (props: Record<string, unknown>) => ReactNode;
	export const IconFullscreenOutline16: (props: Record<string, unknown>) => ReactNode;
	/**
	 * 官方菜单在用的那两个图标（P17 起）：本体的模型菜单用的就是它们，
	 * 照用才能让插件的菜单与本体「同一个质感」（自绘的勾与箭头总有细微差别）。
	 */
	export const IconChevronDownOutline14: (props: Record<string, unknown>) => ReactNode;
	export const IconCheckOutline16: (props: Record<string, unknown>) => ReactNode;
	export const writeClipboard: (text: string) => Promise<void>;
}
