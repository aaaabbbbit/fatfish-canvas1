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
			onMouseDown?: FfcHandler;
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
		/**
		 * 本插件自己的 fiber。
		 *
		 * Loader 的行挂在 `fiber.entry` 上，因此 `fiber.entry?.options.id` 就是
		 * 本行的 **Loader entry id**（= 设置分节的键）。宿主侧用它写回配置，
		 * 行被改名也跟得上。
		 */
		fiber: { entry?: { options: { id?: string } } };
		/** 视图模式切换时需要协同的面板动作（由 ui-layout 提供）。 */
		layout: DshLayout;
		/** 用户设置服务（@deepseek-ai/dsh-settings 提供）。 */
		settings: DshSettings;
		/** 工具注册表（@deepseek-ai/dsh-tools 提供）。 */
		tools: DshTools;
		/** 直达命令注册表（@deepseek-ai/dsh-commands 提供）。 */
		commands: DshCommands;
		/**
		 * 设置表单（@deepseek-ai/dsh-client-ui-settings 提供）。
		 *
		 * 0.2.0 起客户端读设置**只有这一条路**：按插件自己的 Loader entry id
		 * 取那份表单，读值走 `getSnapshot()` / `subscribe()`，写回走
		 * `set()` / `unset()` / `mutate()`（旧的 `settingsScope` 服务没有了）。
		 */
		configForms: DshClientConfigFormsHost;
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
		/** HTTP 路由注册表（宿主侧，@deepseek-ai/dsh-host-webserver 提供）。 */
		webServer: DshWebServer;
		/** 浏览器连接的鉴权面（宿主侧，@deepseek-ai/dsh-client-connection 提供）。 */
		connection: DshConnection;
	}
	export class Service {
		protected constructor(ctx: Context);
	}
}

// ─────────────── 宿主 HTTP 面（P32 的本地留档路由） ───────────────

/** 路由收到的请求（只声明本插件用到的那一面）。 */
interface DshHttpRequest {
	/** 请求地址（含查询串）。 */
	url?: string;
	/** 方法。 */
	method?: string;
	/** 请求头。 */
	headers: Record<string, string | string[] | undefined>;
}

/** 路由的响应（只声明本插件用到的那一面）。 */
interface DshHttpResponse {
	/** 状态码。 */
	statusCode: number;
	/**
	 * 设一个响应头。
	 * @param name - 头名。
	 * @param value - 头值。
	 */
	setHeader(name: string, value: string | number): void;
	/**
	 * 结束响应。
	 * @param body - 正文（省略 = 空）。
	 */
	end(body?: Uint8Array | string): void;
}

/** `ctx.webServer` 在本插件用到的那一面。 */
interface DshWebServer {
	/**
	 * 注册一条命名路由。
	 * @param route - 种类（`exact` / `prefix`）、路径与处理器。
	 * @returns 注销函数。
	 */
	register(route: {
		kind: 'exact' | 'prefix';
		path: string;
		handler: (req: DshHttpRequest, res: DshHttpResponse) => void | Promise<void>;
	}): () => void;
	/** 监听端口。 */
	readonly port: number | undefined;
	/** 绑定地址。 */
	readonly host: string;
}

/** `ctx.connection` 在本插件用到的那一面。 */
interface DshConnection {
	/**
	 * 判定一个请求该不该被拒（Host/Origin 栅栏 + 会话 cookie）。
	 * @param request - 请求。
	 * @returns 拒绝时给状态码（401 / 403）；放行时 undefined。
	 */
	requestRejection(request: DshHttpRequest): number | undefined;
}

// ─────────────── 客户端设置表单（ui-settings 提供） ───────────────

/**
 * `ctx.configForms` 在本插件用到的那一面。
 *
 * 键是**宿主插件的 Loader entry id**（本插件 = `fatfish-canvas`）。同一个 id
 * 上拿到的是同一份表单实例（provider 自己按 id 缓存），因此两处 `get` 可以
 * 共用一份读/写状态。
 */
interface DshClientConfigFormsHost {
	/**
	 * 取某个宿主插件条目的表单。
	 * @param entryId - 唯一的宿主插件 entry id。
	 * @returns 该条目的表单。
	 */
	get<T>(entryId: string): DshClientConfigForm<T>;
}

/** 一个 entry 的客户端同步快照。 */
interface DshClientConfigSnapshot<T> {
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

/**
 * 一个 entry 的客户端表单。
 *
 * 本插件只声明自己用到的那一面：读（`getSnapshot` / `subscribe`）与单字段写
 * （`set` / `unset`）。嵌套叶子的写回走宿主写入面 `remote.settings.mutate`
 * （见下面的 DshRemoteSettings），因为那一条能带 revision 并报出可读错误。
 */
interface DshClientConfigForm<T> {
	/** 当前快照（引用稳定，变化时才替换）。 */
	getSnapshot(): DshClientConfigSnapshot<T>;
	/** 订阅快照替换。 */
	subscribe(listener: () => void): () => void;
	/**
	 * 写一个**顶层标量字段**（底层是单条 `set` 路径 op，因此不会碰到别的字段）。
	 * @param field - 字段名。
	 * @param value - 新值。
	 * @returns Host 是否接受（**拒绝时返回 false，不抛**）。
	 */
	set(field: string, value: unknown): Promise<boolean>;
	/**
	 * 清除一个字段，使其重新继承组合层 / schema 默认。
	 * @param field - 字段名。
	 * @returns Host 是否接受（**拒绝时返回 false，不抛**）。
	 */
	unset(field: string): Promise<boolean>;
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
	 * 声明本插件的设置呈现策略。
	 *
	 * `{ auto: false }` = 不要自动生成设置页面（本插件自己注册了
	 * `settings.section`）。策略挂在 `owner` 指名的 fiber 上。
	 * @param presentation - 策略。
	 * @param owner - 策略归属的 fiber（传本插件自己的 `ctx.fiber`）。
	 * @returns 注销函数。
	 */
	configure(presentation: { auto?: boolean }, owner?: unknown): () => void;
	/**
	 * 对**用户层**应用一批深路径 op（`set` / `unset`）。
	 *
	 * 这是唯一能写嵌套叶子、也是唯一能删字段的写入口：整体替换式的
	 * `update` 只做浅合并、删不掉东西，而 `unset` 正是**迁移旧字段**必需的
	 * （残留的不明字段不会被脱敏，会被原样下发到浏览器）。
	 * @param ns - profile entry id（= 本插件的 Loader entry id）。
	 * @param ops - 路径 op 列表。
	 * @param expectedRevision - 并发栅栏（可选）。
	 */
	mutate(
		ns: string,
		ops: readonly { op: 'set' | 'unset'; path: string[]; value?: unknown }[],
		expectedRevision?: number,
	): Promise<unknown>;
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
	/** 从分节根算起的路径。 */
	path: string[];
	/** `set` 的值。 */
	value?: unknown;
}

/** `remote.settings` 在本插件用到的那一面。 */
interface DshRemoteSettings {
	/**
	 * 对某个插件条目的**用户层**应用路径 op。
	 * @param ns - profile entry id（= 本插件的 Loader entry id）。
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
	 * 同席位的**顶替**手段（P32）：注册表按 priority **升序**排，keyed / single
	 * 席位同 key（同 id）只取第一个，因此更小的值 = 盖住别人的条目。
	 * 注册表自己的报错文案原话：`register at a different priority to shadow it
	 * (lowest renders)`。不写就是 0 —— 与本体撞车时会直接抛
	 * 「already has an entry for key …」。
	 */
	priority?: number;
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

/**
 * 会话列表 store 里本插件读取的那一面。
 *
 * ⚠️ **这里没有 `current`** —— 曾经有（`current: string | undefined`），而那是个
 * 凭空的假设：真实的 `SessionListState`（dsh-api-session-controller 0.2.0-rc.2）
 * 只有 `ids` / `byId` / `phase` / `projectionsBySession`，当前选择体现在**行的
 * 本地引用计数**上（`retainedBy.mainView > 0` 的就是主视图正看着的那个会话，
 * `dsh-client-ui-session` 判定「谁是主会话」用的也是这条规则）。
 * 代价是落图整条线静默失效：读到 `undefined` → 一个节点都不落、记账不写、不报错。
 */
interface DshSessionListState {
	/** 主机列表顺序的行 id。 */
	readonly ids: readonly string[];
	/** id → 行。 */
	readonly byId: Readonly<Record<string, DshSessionSummary>>;
}

/** 列表行里本插件读取的那一面。 */
interface DshSessionSummary {
	/** 会话 id。 */
	readonly id: string;
	/**
	 * 会话的工作目录（= 工作区路径）。
	 *
	 * **画布作用域就挂在它上面**：同一个 `cwd` 的会话共用一块画布（一个工作区
	 * 一块）。真机上它是会话头部里那个已校验的绝对路径（`SessionHeader.cwd`），
	 * 会话列表 RPC 会把它带出来；老会话没有这一段时为 undefined，
	 * 那时画布退回「共用那块」（见 `canvas/scope.ts`）。
	 */
	readonly cwd?: string | undefined;
	/** 各来源的本地引用计数；`mainView` 即「正被主视图持有」。 */
	readonly retainedBy?: Readonly<Record<string, number>> | undefined;
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

	/**
	 * 官方菜单在用的那两个图标（P17 起）：本体的模型菜单用的就是它们，
	 * 照用才能让插件的菜单与本体「同一个质感」（自绘的勾与箭头总有细微差别）。
	 *
	 * ⚠️ 名字必须与**真机装的那版 dsh** 一致（这里是 0.2.0-rc.2：`Regular` / `Medium`
	 * 两档，默认 16px，`size` 可覆盖）。写错名字 tsc **不会报**（这个 ambient 声明
	 * 就是它看到的全部），而浏览器里那个导出是 `undefined` → React #130
	 * 「Element type is invalid」→ 整个席位崩掉、界面直接不见（见 NOTES §8.59）。
	 * `build.mjs` 现在会在构建期拿真机的导出名核对。
	 */
	export const IconChevronDownOutlineRegular: (props: Record<string, unknown>) => ReactNode;
	export const IconCheckOutlineRegular: (props: Record<string, unknown>) => ReactNode;
	/**
	 * 本体那条「复制」按钮用的就是它（P32 起影子消息行也照用）：
	 * 用户要求「复制含图的按钮按原版的复制按钮来」—— 自己画一个总差一点。
	 */
	export const IconCopyOutlineRegular: (props: Record<string, unknown>) => ReactNode;
	export const writeClipboard: (text: string) => Promise<void>;
}
