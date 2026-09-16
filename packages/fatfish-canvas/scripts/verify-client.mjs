/**
 * 无浏览器冒烟测试：在不启动 GUI 的前提下验证客户端 bundle 的四件事。
 *
 * 为什么需要它：客户端插件最常见的故障是「bundle 加载/物化即抛错」，
 * 而这类错误只落在浏览器控制台 —— 服务端日志、HTTP 探活都看不见。
 * 这里按 DSH 内核的真实语义搭一个最小替身：
 *
 *   - 惰性 CJS：脚本执行只应**注册 factory**，不得产生任何副作用
 *   - factory(require)：`require` 只在统一基座里解析（这里用桩替代）
 *   - 物化后才运行模块体（含 CSS 注入）
 *
 * 断言：
 *   1. 脚本恰好注册 1 个 factory，且 id 等于包名
 *   2. 执行脚本阶段没有任何 DOM 副作用（惰性契约）
 *   3. factory 物化出带 apply / inject / name 的插件对象
 *   4. apply(fakeCtx) 不抛错，并注册了预期的 shell.overlay 条目
 *   5. 每个已注册的 overlay 组件都能被调用渲染而不抛错
 *
 * 用法：node scripts/verify-client.mjs
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const bundlePath = resolve(root, 'lib/client.js');

let failures = 0;
const check = (label, ok, detail = '') => {
	const mark = ok ? 'PASS' : 'FAIL';
	if (!ok) failures += 1;
	console.log(`  [${mark}] ${label}${detail === '' ? '' : ` — ${detail}`}`);
};

// ───────────────────────── 最小 DOM 替身 ─────────────────────────

let domMutations = 0;

const makeStyle = () => {
	const props = new Map();
	return {
		setProperty: (name, value) => {
			props.set(name, value);
			domMutations += 1;
		},
		removeProperty: (name) => {
			props.delete(name);
			domMutations += 1;
		},
		getPropertyValue: (name) => props.get(name) ?? '',
	};
};

/**
 * 元素替身必须是**真实类实例** —— 插件用 `instanceof HTMLElement`
 * 做类型收窄（tagFrame 里），普通对象字面量会让它静默失败。
 */
class NodeStub {}

class HTMLElementStub extends NodeStub {
	constructor(tag) {
		super();
		this.tagName = String(tag).toUpperCase();
		this.dataset = {};
		this.style = makeStyle();
		this.textContent = '';
		this.children = [];
		this.isConnected = true;
		this.parentElement = null;
	}

	appendChild(child) {
		this.children.push(child);
		child.parentElement = this;
		return child;
	}

	remove() {
		domMutations += 1;
	}

	setAttribute() {}
	removeAttribute() {}
	addEventListener() {}
	removeEventListener() {}
	contains() {
		return false;
	}
	querySelector() {
		return null;
	}
	querySelectorAll() {
		return [];
	}
	getBoundingClientRect() {
		return { width: 1280, height: 800, top: 0, right: 1280, bottom: 800, left: 0 };
	}
	setPointerCapture() {}
	hasPointerCapture() {
		return false;
	}
	releasePointerCapture() {}
	focus() {}
}

globalThis.Node = NodeStub;
globalThis.HTMLElement = HTMLElementStub;

const makeElement = (tag) => new HTMLElementStub(tag);

const head = makeElement('head');
const bodyEl = makeElement('body');
const documentElement = makeElement('html');

/** `[data-ffc-frame]` 打点探测：让 querySelector 能命中一个假的 AppFrame。 */
const frameEl = makeElement('div');
const overlayLayerEl = makeElement('div');
overlayLayerEl.parentElement = frameEl;

const documentStub = {
	head,
	body: bodyEl,
	documentElement,
	createElement: (tag) => makeElement(tag),
	querySelector: (selector) =>
		selector === '[data-shell-overlay]' ? overlayLayerEl : null,
	querySelectorAll: () => [],
	addEventListener: () => {},
	removeEventListener: () => {},
};

class MutationObserverStub {
	observe() {}
	disconnect() {}
}

class ResizeObserverStub {
	constructor(callback) {
		this.callback = callback;
	}
	observe() {}
	unobserve() {}
	disconnect() {}
}

const storage = new Map();

globalThis.document = documentStub;
globalThis.MutationObserver = MutationObserverStub;
globalThis.ResizeObserver = ResizeObserverStub;
globalThis.requestAnimationFrame = (fn) => {
	fn(0);
	return 1;
};
globalThis.cancelAnimationFrame = () => {};

/** window 上已注册的监听器（视图快捷键与 Esc 逃生梯都挂在这里）。 */
const windowListeners = new Map();

/**
 * 向 window 同步派发一个事件。
 * @param type - 事件名。
 * @param event - 事件对象。
 */
function fireWindow(type, event) {
	for (const fn of windowListeners.get(type) ?? []) fn(event);
}

const windowStub = {
	document: documentStub,
	innerWidth: 1920,
	innerHeight: 1080,
	localStorage: {
		getItem: (k) => storage.get(k) ?? null,
		setItem: (k, v) => {
			storage.set(k, String(v));
		},
		removeItem: (k) => {
			storage.delete(k);
		},
	},
	// 事件面照实建模：插件的快捷键挂 window，用空实现会让「装上了但没生效」
	// 这类故障在离线测试里彻底不可见。
	addEventListener: (type, fn) => {
		const list = windowListeners.get(type) ?? [];
		list.push(fn);
		windowListeners.set(type, list);
	},
	removeEventListener: (type, fn) => {
		windowListeners.set(
			type,
			(windowListeners.get(type) ?? []).filter((entry) => entry !== fn),
		);
	},
};
globalThis.window = windowStub;

// ─────────────────── 统一基座（static modules）桩 ───────────────────

/** 被调用到的 hook 记录，用于确认组件确实渲染过。 */
const hookCalls = [];

/**
 * 组件写下的状态。
 *
 * 替身没有渲染器，`setState` 不会触发重渲染 —— 但把每次写入记下来，就能看见
 * 「某个动作把自己弄成了错误态」这类故障（本轮就是靠它抓住设置页写入失败的）。
 */
const stateWrites = [];

const reactStub = {
	createElement: (type, props, ...children) => ({ type, props, children }),
	Fragment: Symbol('Fragment'),
	useState: (initial) => {
		hookCalls.push('useState');
		const current = typeof initial === 'function' ? initial() : initial;
		return [
			current,
			(next) => {
				stateWrites.push(typeof next === 'function' ? next(current) : next);
			},
		];
	},
	useEffect: () => {
		hookCalls.push('useEffect');
	},
	useLayoutEffect: () => {
		hookCalls.push('useLayoutEffect');
	},
	useMemo: (factory) => factory(),
	useRef: (initial) => ({ current: initial }),
	useCallback: (fn) => fn,
	useSyncExternalStore: (_subscribe, getSnapshot) => {
		hookCalls.push('useSyncExternalStore');
		return getSnapshot();
	},
};

const jsxStub = {
	Fragment: Symbol('Fragment'),
	jsx: (type, props) => ({ type, props }),
	jsxs: (type, props) => ({ type, props }),
};

/** 未实现的 primitives：任何成员都返回一个渲染成 null 的组件。 */
const primitivesStub = new Proxy(
	{},
	{ get: () => () => null },
);

const staticModules = {
	react: reactStub,
	'react/jsx-runtime': jsxStub,
	'react-dom': {
		// 弹层挂到 body 上（官方 ModelSelect 同款）：替身直接把子树原样返回，
		// 于是菜单在元素树里仍然可断言。
		createPortal: (node) => node,
	},
	'react-dom/client': {},
	'@deepseek-ai/cordis': {},
	'@deepseek-ai/dsh-client-ui-slots': {},
	'@deepseek-ai/dsh-client-ui-primitives': primitivesStub,
};

const makeRequire = (id) => (specifier) => {
	if (Object.hasOwn(staticModules, specifier)) return staticModules[specifier];
	throw new Error(`require("${specifier}") 不在统一基座内：bundle 引入了基座之外的模块，` +
		`必须内联打包或经 dsh.client.external 登记（来源：${id}）`);
};

// ───────────────────────── 1. 执行脚本 ─────────────────────────

console.log(`\n肥鱼画布 · 客户端 bundle 冒烟测试\nbundle: ${bundlePath}\n`);

const code = await readFile(bundlePath, 'utf8');

const registrations = [];
globalThis.window.__ModuleLoader__ = {
	load: (record) => {
		registrations.push(record);
	},
};

domMutations = 0;
// eslint-disable-next-line no-new-func -- 刻意在隔离作用域内执行产物，模拟内核的 classic script 装载
new Function('window', 'document', code)(globalThis.window, documentStub);
const mutationsAfterScript = domMutations;

console.log('1) 惰性契约');
check('脚本注册了恰好 1 个 factory', registrations.length === 1, `实际 ${String(registrations.length)}`);
const registration = registrations[0];
check('注册 id 等于包名', registration?.id === pkg.name, `期望 ${pkg.name}，实际 ${String(registration?.id)}`);
check(
	'执行脚本阶段零副作用（不注入样式/DOM）',
	mutationsAfterScript === 0,
	`观察到 ${String(mutationsAfterScript)} 次 DOM 写入`,
);

// ───────────────────────── 2. 物化 factory ─────────────────────────

console.log('\n2) factory 物化');
const factory = registration?.factory;
check('factory 是函数', typeof factory === 'function');

const plugin = factory(makeRequire(pkg.name));
check('物化返回对象', plugin !== null && typeof plugin === 'object');
check('导出 name', plugin.name === pkg.name, `实际 ${String(plugin.name)}`);
check('导出 apply 函数', typeof plugin.apply === 'function');
check('导出 inject 数组', Array.isArray(plugin.inject), JSON.stringify(plugin.inject));
check(
	'inject 声明的服务都在统一基座可达的服务面内',
	Array.isArray(plugin.inject) && plugin.inject.every((s) => typeof s === 'string'),
);

// ───────────────────────── 3. apply(fakeCtx) ─────────────────────────

console.log('\n3) apply(fakeCtx)');
const sectionEntries = [];
const effects = [];
const injections = [];

/**
 * 造一个客户端 ctx 替身。
 *
 * `extraProvided` 用来替换某个服务的面：P7 的作用域测试需要一个
 * **有当前会话**的 `sessions` 面（默认这个替身故意没有当前会话，那正是
 * 首次打开页面时的真实形状）；P9 的设置页测试需要 `remote.settings` /
 * `remote.credentials`（深路径写入与凭据）与 `remote`（宿主探测服务）。
 * @param extraProvided - 覆盖/追加的服务面。
 * @returns ctx 替身。
 */
function makeFakeCtx(extraProvided = {}) {
	/** 服务表：`inject` 与 `get` 都读它（cordis 的 ctx.get 就是按名字解析服务）。 */
	const services = {
		layout: { toggleSidebar: () => {}, openDetails: () => {}, closeDetails: () => {} },
		// P3：生成落图的订阅桥只碰 sessions 的这两个成员。这里给一个
		// 「没有当前会话」的最小面 —— 正是首次打开页面时的真实形状。
		sessions: {
			list: {
				getSnapshot: () => ({ current: undefined }),
				subscribe: () => () => {},
			},
			binding: () => undefined,
		},
		settingsScope: {
			bind: (spec) => ({
				namespace: spec.namespace,
				getSnapshot: () => ({
					status: 'ready',
					value: { model_openai_images: 'gpt-image-1' },
					base: undefined,
					user: undefined,
					revision: 1,
					writable: true,
					mode: 'host',
				}),
				subscribe: () => () => {},
				set: async () => {},
				unset: async () => {},
			}),
		},
		...extraProvided,
	};

	const ctx = {
		effect: (fn, label) => {
			effects.push({ label, dispose: fn() });
		},
		on: () => () => {},
		// cordis 的 inject 只在**依赖齐备**时才调用回调 —— 替身必须照此建模，
		// 否则会在服务缺席时误触发插件里「服务已就绪」的分支（真实运行不会）。
		inject: (deps, callback) => {
			injections.push(deps);
			const missing = deps.filter((d) => !Object.hasOwn(services, d));
			if (missing.length > 0) return;
			const scoped = { ...ctx };
			for (const dep of deps) scoped[dep] = services[dep];
			callback(scoped);
		},
		/** 按名字取服务（与 cordis 的 ctx.get 同义）。 */
		get: (name) => services[name],
		slots: {
			register: (spec, component) => {
				sectionEntries.push({ spec, component });
				return () => {};
			},
			inject: (key, callback) => {
				injections.push([key]);
				callback();
				return () => {};
			},
		},
		reflect: { provide: () => () => {} },
	};
	return ctx;
}

const fakeCtx = makeFakeCtx();

/**
 * 一个有「当前会话」的 `sessions` 面。
 *
 * ⚠️ **形状必须照真实建模**（本轮踩过的坑）：`SessionSnapshot` 里**没有**
 * `nodes` / `runningCalls`，会话数据只在 `binding.eventSource`
 * （`ObservableSnapshot<SessionEventWindow>`）里。早先这个替身给
 * `session.getSnapshot()` 塞了 `{ nodes, runningCalls }`，于是替身与真机一起漂移：
 * 桥在真机上读到的永远是 `undefined`，一个节点都不落、记账也不写，而离线测试全绿。
 * 现在只给**真实存在**的成员；落图用例走 `events`。
 * @param id - 当前会话 id。
 * @param events - 事件窗口条目（真实 wire 形状，见第 12 节）。
 * @returns sessions 服务替身。
 */
function sessionsWith(id, events = []) {
	const listeners = new Set();
	const session = {
		subscribe: () => () => {},
		// 真实 SessionSnapshot：**没有会话数据**（这正是本轮 bug 的根源）。
		getSnapshot: () => ({ sessionId: id, running: false, openState: 'open', blank: false }),
		prompt: () => {},
	};
	const eventSource = {
		getSnapshot: () => ({
			entries: events,
			hasMore: false,
			revision: 1,
			change: { kind: 'replace', entries: [] },
		}),
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	return {
		list: {
			getSnapshot: () => ({ current: id }),
			subscribe: () => () => {},
		},
		binding: (asked) => (asked === id ? { sessionId: id, session, eventSource, ctx: {} } : undefined),
		/** 测试用：像真实发布那样把新条目推进窗口并通知订阅者。 */
		push: (...entries) => {
			events.push(...entries);
			for (const fn of listeners) fn();
		},
	};
}

/** 所有槽位注册（含设置页），用于断言注册面。 */
function overlayOf(list) {
	return list.filter((e) => e.spec.name === 'shell.overlay');
}

let applyError = null;
try {
	plugin.apply(fakeCtx);
} catch (error) {
	applyError = error;
}
check('apply 不抛错', applyError === null, applyError === null ? '' : String(applyError));

const overlayEntries = overlayOf(sectionEntries);
const ids = overlayEntries.map((e) => e.spec.id);
check(
	'注册了 1 个 shell.overlay 条目（只剩画布面板）',
	overlayEntries.length === 1,
	`实际 ${String(overlayEntries.length)}：${ids.join(', ')}`,
);
check(
	'每个条目都投到 shell.overlay 槽位',
	overlayEntries.every((e) => e.spec.name === 'shell.overlay'),
);
check(
	'条目 id 唯一且非空',
	new Set(ids).size === ids.length && ids.every((id) => typeof id === 'string' && id !== ''),
	ids.join(', '),
);
check('安装了样式 effect', effects.some((e) => e.label.includes('stylesheet')));
check(
	'样式标签写入了 head',
	head.children.some((el) => el.dataset.pluginCss !== undefined),
	`head 子节点 ${String(head.children.length)} 个`,
);
check('声明了 layout 注入', injections.some((d) => Array.isArray(d) && d.includes('layout')));
check(
	'声明了 sessions 注入（P3 落图）',
	injections.some((d) => Array.isArray(d) && d.includes('sessions')),
);
check(
	'注册了 tool.call.toolview 席位（聊天侧媒体行）',
	sectionEntries.some((e) => e.spec.name === 'tool.call.toolview'),
	sectionEntries.map((e) => e.spec.name).join(','),
);
{
	// keyed 席位的分派键就是**线上工具名** —— 写歪了不会报错，只会静默回落到
	// 通用 JSON 卡片，因此这条断言是那次「看起来注册成功但没生效」的守卫。
	const toolviews = sectionEntries.filter((e) => e.spec.name === 'tool.call.toolview');
	check(
		'toolview 的 key 是 media_generate',
		toolviews.every((e) => e.spec.key === 'media_generate'),
		JSON.stringify(toolviews.map((e) => e.spec.key)),
	);
}

// ───────────────────────── 4. 渲染每个条目 ─────────────────────────

console.log('\n4) 条目渲染（chat 模式）');
for (const entry of overlayEntries) {
	let renderError = null;
	let node = null;
	try {
		node = entry.component({});
	} catch (error) {
		renderError = error;
	}
	check(
		`渲染 ${String(entry.spec.id)}`,
		renderError === null,
		renderError === null ? '' : String(renderError),
	);
	// chat 模式下画布面板应为 null（不影响其他条目）
	if (entry.spec.id.endsWith('-panel')) {
		check('  chat 模式下画布面板渲染 null', node === null, `实际 ${String(node)}`);
	}
}

// 切到画布模式后再渲染一次：覆盖 mode==='canvas' 分支
storage.set('fatfish-canvas:view-mode', 'canvas');
const freshPlugin = factory(makeRequire(pkg.name));
const sectionEntries2 = [];
const fakeCtx2 = {
	...fakeCtx,
	slots: {
		register: (spec, component) => {
			sectionEntries2.push({ spec, component });
			return () => {};
		},
		inject: (key, callback) => {
			callback();
			return () => {};
		},
	},
};

console.log('\n5) 条目渲染（canvas 模式）');
let canvasApplyError = null;
try {
	freshPlugin.apply(fakeCtx2);
} catch (error) {
	canvasApplyError = error;
}
check('canvas 模式下 apply 不抛错', canvasApplyError === null, String(canvasApplyError ?? ''));

const panelEntry = overlayOf(sectionEntries2).find((e) => e.spec.id.endsWith('-panel'));
{
	// 注意 entries 会累积多次 apply 的注册（替身的 inject 闭包共享同一个 slots），
	// 因此这里断言的是**注册形状**而不是数量。
	const sections = sectionEntries.filter((e) => e.spec.name === 'settings.section');
	check('注册了设置页席位（settings.section）', sections.length >= 1, sectionEntries.map((e) => e.spec.name).join(','));
	// spec 形状照抄已工作的第三方分节：id + order + label（纯字符串）。
	// 早期版本按 key/locale 写，结果分节注册成功但导航里不出现 —— 这条断言就是
	// 那次回归的守卫。
	check(
		'设置页 spec 用 id / order / label（而非 key / locale）',
		sections.every(
			(e) =>
				typeof e.spec.id === 'string' &&
				e.spec.id !== '' &&
				typeof e.spec.order === 'number' &&
				typeof e.spec.label === 'string' &&
				e.spec.label !== '' &&
				e.spec.key === undefined,
		),
		JSON.stringify(sections[0]?.spec ?? null),
	);
	check(
		'设置页通过 inject 面拿到已绑定的 namespace scope',
		sections.every((e) => e.spec.inject?.().scope !== undefined),
	);
	check(
		'设置页的 inject 面还带上写入面与探测读取器（api / getProbe）',
		(() => {
			const face = sections[sections.length - 1]?.spec.inject?.();
			return face !== undefined && 'api' in face && 'getProbe' in face;
		})(),
		JSON.stringify(Object.keys(sections[sections.length - 1]?.spec.inject?.() ?? {})),
	);
}
let panelNode = null;
let panelRenderError = null;
try {
	panelNode = panelEntry?.component({});
} catch (error) {
	panelRenderError = error;
}
check('canvas 模式下画布面板渲染不抛错', panelRenderError === null, String(panelRenderError ?? ''));
check('canvas 模式下画布面板渲染出内容（非 null）', panelNode !== null);
check(
	'body 已投影 data-ffc-mode="canvas"',
	bodyEl.dataset.ffcMode === 'canvas',
	`实际 ${String(bodyEl.dataset.ffcMode)}`,
);
check(
	'--ffc-canvas-width 已投影到根元素',
	documentElement.style.getPropertyValue('--ffc-canvas-width') !== '',
	documentElement.style.getPropertyValue('--ffc-canvas-width'),
);
check(
	'AppFrame 已打点 data-ffc-frame',
	frameEl.dataset.ffcFrame !== undefined,
);
check(`组件确实走到过 React hook（${String(hookCalls.length)} 次）`, hookCalls.length > 0);

// ─────────────── 6. 深度渲染：带节点的画布 ───────────────
//
// 上面只断言了「不抛错」。这里把函数组件递归展开成真实元素树，从而真正走遍
// CanvasStage / NodeCard 的每一条分支（图像、视频、生成中、失败、文字），
// 并断言渲染结果 —— 不需要浏览器，也不依赖任何测试框架。

/** 递归展开函数组件，得到元素树（宿主元素保留，并继续展开其子节点）。 */
function renderDeep(node) {
	if (node === null || node === undefined || typeof node === 'boolean') return null;
	if (Array.isArray(node)) return node.map(renderDeep);
	if (typeof node !== 'object') return node;
	// 函数组件：调用它，再展开其返回的子树
	if (typeof node.type === 'function') return renderDeep(node.type(node.props ?? {}));
	// 宿主元素（'div' / 'img' / 'video' …）：保留自身，并递归展开 children
	const props = { ...(node.props ?? {}) };
	if (props.children !== undefined) props.children = renderDeep(props.children);
	return { type: node.type, props };
}

/** 在元素树里收集满足条件的节点。 */
function collect(tree, predicate, out = []) {
	if (tree === null || tree === undefined || typeof tree === 'boolean') return out;
	if (Array.isArray(tree)) {
		for (const child of tree) collect(child, predicate, out);
		return out;
	}
	if (typeof tree !== 'object') return out;
	if (predicate(tree)) out.push(tree);
	const children = tree.props?.children;
	if (children !== undefined) collect(children, predicate, out);
	return out;
}

console.log('\n6) 深度渲染：带节点的画布（走遍 NodeCard 全部分支）');

storage.set(
	'fatfish-canvas:board',
	JSON.stringify({
		version: 1,
		nodes: [
			{ id: 'img', kind: 'image', x: 0, y: 0, w: 200, h: 200, z: 1, status: 'ready', src: 'data:,i', title: '图', createdAt: 1 },
			{ id: 'vid', kind: 'video', x: 220, y: 0, w: 200, h: 200, z: 2, status: 'ready', src: 'data:,v', createdAt: 2 },
			{ id: 'pen', kind: 'image', x: 0, y: 220, w: 200, h: 200, z: 3, status: 'pending', createdAt: 3 },
			{ id: 'bad', kind: 'image', x: 220, y: 220, w: 200, h: 200, z: 4, status: 'failed', error: '额度不足', createdAt: 4 },
			{ id: 'txt', kind: 'text', x: 0, y: 440, w: 200, h: 100, z: 5, status: 'ready', title: '文字节点', createdAt: 5 },
		],
		viewport: { x: 0, y: 0, zoom: 1 },
	}),
);
storage.set('fatfish-canvas:view-mode', 'canvas');

const plugin3 = factory(makeRequire(pkg.name));
const sectionEntries3 = [];
plugin3.apply({
	...fakeCtx,
	slots: {
		register: (spec, component) => {
			sectionEntries3.push({ spec, component });
			return () => {};
		},
		inject: (key, callback) => {
			callback();
			return () => {};
		},
	},
});

const panel3 = overlayOf(sectionEntries3).find((e) => e.spec.id.endsWith('-panel'));
let tree = null;
let deepError = null;
try {
	tree = renderDeep(panel3.component({}));
} catch (error) {
	deepError = error;
}
check('深度渲染不抛错', deepError === null, String(deepError ?? ''));

const nodeEls = collect(tree, (el) => el.props?.className === 'ffc-node');
check('渲染出 5 个节点卡片', nodeEls.length === 5, `实际 ${String(nodeEls.length)}`);

const statuses = nodeEls.map((el) => el.props['data-status']).sort();
check(
	'节点状态覆盖 pending / ready / failed',
	JSON.stringify(statuses) === '["failed","pending","ready","ready","ready"]',
	JSON.stringify(statuses),
);

const kinds = nodeEls.map((el) => el.props['data-kind']).sort();
check(
	'节点种类覆盖 image / text / video',
	JSON.stringify(kinds) === '["image","image","image","text","video"]',
	JSON.stringify(kinds),
);

check(
	'加载后没有默认选中（选择集是瞬时的）',
	nodeEls.every((el) => el.props['data-selected'] === undefined),
);

check(
	'图像节点渲染 <img>',
	collect(tree, (el) => el.type === 'img').length === 1,
	`实际 ${String(collect(tree, (el) => el.type === 'img').length)}`,
);
check(
	'视频节点渲染 <video> 且带独立播放按钮',
	collect(tree, (el) => el.type === 'video').length === 1 &&
		collect(tree, (el) => el.props?.className === 'ffc-node-play').length === 1,
);
check(
	'失败节点显示原因文案',
	collect(tree, (el) => el.props?.className === 'ffc-node-failed-reason').some((el) =>
		String(el.props.children).includes('额度不足'),
	),
);
check(
	'文字节点渲染文本内容',
	collect(tree, (el) => el.props?.className === 'ffc-node-text').some((el) =>
		String(el.props.children).includes('文字节点'),
	),
);
check(
	'世界层施加了视口 transform',
	collect(tree, (el) => el.props?.className === 'ffc-world').some(
		(el) => typeof el.props.style?.transform === 'string' && el.props.style.transform.includes('scale(1)'),
	),
);
/** 元素的 className 是否包含某个类（className 常是多个类的组合）。 */
const hasClass = (el, name) => String(el.props?.className ?? '').split(/\s+/).includes(name);

check(
	'缩放控件渲染（含百分比读数与档位菜单容器）',
	collect(tree, (el) => hasClass(el, 'ffc-zoombar')).length === 1 &&
		collect(tree, (el) => hasClass(el, 'ffc-zoom-pct')).some((el) =>
			String(el.props.children).includes('%'),
		),
);
check(
	'节点数非零时不渲染空画布占位',
	collect(tree, (el) => el.props?.className === 'ffc-placeholder').length === 0,
);

// ─────────────── 7. 深度渲染：聊天侧媒体工具行 ───────────────
//
// 工具行的三种形态（进行中 / 成功 / 失败）在聊天里各占一条分支，
// 而「keyed tool view 静默回落到通用卡片」这种故障在浏览器控制台里
// 一声不响。这里把三态都渲染成元素树并断言关键节点。

console.log('\n7) 深度渲染：聊天侧 media_generate 工具行');

const toolRow = sectionEntries.find((e) => e.spec.name === 'tool.call.toolview')?.component;
check('取到已注册的工具行组件', typeof toolRow === 'function');

/** 渲染一次工具行并展开成元素树。 */
function renderRow(block) {
	try {
		return renderDeep(toolRow({ block }));
	} catch (error) {
		check(`渲染工具行(${String(block?.kind ?? 'running')})不抛错`, false, String(error));
		return null;
	}
}

const ARGS = JSON.stringify({ prompt: '一只肥鱼', kind: 'image', aspectRatio: '16:9' });
const META = {
	fatfishCanvas: {
		kind: 'image',
		url: 'http://media.test/a.png',
		model: 'gpt-image-1',
		providerId: 'openai-images',
		prompt: '一只肥鱼',
		aspectRatio: '16:9',
	},
};

{
	// 进行中：只有提示词与状态，没有媒体
	const tree = renderRow({ callId: 'c1', name: 'media_generate', argsRaw: ARGS });
	const root = collect(tree, (el) => hasClass(el, 'ffc-tool'));
	check('进行中：渲染出 .ffc-tool', root.length === 1, `实际 ${String(root.length)}`);
	check('进行中：data-state=running', root[0]?.props['data-state'] === 'running', String(root[0]?.props['data-state']));
	check(
		'进行中：显示提示词',
		collect(tree, (el) => hasClass(el, 'ffc-tool-prompt')).some((el) =>
			String(el.props.children).includes('一只肥鱼'),
		),
	);
	check('进行中：还没有媒体元素', collect(tree, (el) => el.type === 'img' || el.type === 'video').length === 0);
}

{
	// 成功：渲染图像并提供新标签页入口
	const tree = renderRow({
		kind: 'tool-result',
		callId: 'c1',
		call: { name: 'media_generate', argsRaw: ARGS },
		meta: META,
		isError: false,
		content: [{ type: 'text', text: '已生成图像' }],
	});
	const root = collect(tree, (el) => hasClass(el, 'ffc-tool'));
	check('成功：data-state=ready', root[0]?.props['data-state'] === 'ready', String(root[0]?.props['data-state']));
	const imgs = collect(tree, (el) => el.type === 'img');
	check('成功：渲染 <img> 且 src 正确', imgs.length === 1 && imgs[0].props.src === META.fatfishCanvas.url, JSON.stringify(imgs.map((i) => i.props.src)));
	check('成功：显示模型名', collect(tree, (el) => hasClass(el, 'ffc-tool-badge')).some((el) => String(el.props.children) === 'gpt-image-1'));
	check(
		'成功：提供新标签页打开入口',
		collect(tree, (el) => el.type === 'a').some((el) => el.props.href === META.fatfishCanvas.url),
	);
	check('成功：不再显示「生成中」提示', collect(tree, (el) => hasClass(el, 'ffc-tool-note')).length === 0);
}

{
	// 参考图：结果里带 usedReference 时给一枚徽标（用户要能看出这次用了参考图）
	const tree = renderRow({
		kind: 'tool-result',
		callId: 'c9',
		call: { name: 'media_generate', argsRaw: ARGS },
		meta: { fatfishCanvas: { ...META.fatfishCanvas, usedReference: true } },
		isError: false,
		content: [{ type: 'text', text: '已生成图像' }],
	});
	check(
		'带参考图的成功结果：多一枚「参考图」徽标',
		collect(tree, (el) => hasClass(el, 'ffc-tool-badge')).some(
			(el) => String(el.props.children) === '参考图',
		),
		JSON.stringify(collect(tree, (el) => hasClass(el, 'ffc-tool-badge')).map((el) => el.props.children)),
	);
}

{
	// 成功（视频）：走 <video> 分支
	const tree = renderRow({
		kind: 'tool-result',
		callId: 'c2',
		call: { name: 'media_generate', argsRaw: JSON.stringify({ prompt: '海浪', kind: 'video' }) },
		meta: { fatfishCanvas: { kind: 'video', url: 'http://media.test/v.mp4', prompt: '海浪', model: 'sora-2' } },
		isError: false,
		content: [],
	});
	const videos = collect(tree, (el) => el.type === 'video');
	check(
		'视频结果渲染 <video src>（且带原生 controls —— 这里不是画布节点）',
		videos.length === 1 && videos[0].props.src === 'http://media.test/v.mp4' && videos[0].props.controls === true,
		JSON.stringify(videos.map((v) => v.props.src)),
	);
	check(
		'视频结果的标题按 meta.kind 而不是参数判定',
		collect(tree, (el) => hasClass(el, 'ffc-tool-title')).some((el) =>
			String(el.props.children).includes('视频'),
		),
	);
}

{
	// 失败：把宿主给出的原因原样显示
	const reason = '供应商「OpenAI · 图像」还没有配置 API 密钥。';
	const tree = renderRow({
		kind: 'tool-result',
		callId: 'c3',
		call: { name: 'media_generate', argsRaw: ARGS },
		meta: undefined,
		isError: true,
		content: [{ type: 'text', text: reason }],
	});
	const root = collect(tree, (el) => hasClass(el, 'ffc-tool'));
	check('失败：data-state=error', root[0]?.props['data-state'] === 'error', String(root[0]?.props['data-state']));
	check(
		'失败：显示失败原因',
		collect(tree, (el) => hasClass(el, 'ffc-tool-error')).some((el) =>
			String(el.props.children).includes('API 密钥'),
		),
	);
	check('失败：不渲染任何媒体', collect(tree, (el) => el.type === 'img' || el.type === 'video').length === 0);
}

{
	// 坏 meta（比如跨版本错位）不能把工具行渲染崩，也不能伪装成成功
	const tree = renderRow({
		kind: 'tool-result',
		callId: 'c4',
		call: { name: 'media_generate', argsRaw: ARGS },
		meta: { fatfishCanvas: { kind: 'image' } },
		isError: false,
		content: [{ type: 'text', text: '返回体缺少 url' }],
	});
	const root = collect(tree, (el) => hasClass(el, 'ffc-tool'));
	check(
		'坏 meta 一律按失败呈现（不会渲染出一个空 img）',
		root[0]?.props['data-state'] === 'error' &&
			collect(tree, (el) => el.type === 'img').length === 0,
		String(root[0]?.props['data-state']),
	);
}

// ─────────────── 8. 深度渲染：P4 工具条与纯画布模式 ───────────────

console.log('\n8) 深度渲染：画布工具条（P4）与纯画布模式');

/** 按 aria-label 找按钮。 */
const buttonByLabel = (tree, label) =>
	collect(tree, (el) => el.type === 'button' && el.props?.['aria-label'] === label);

{
	// 并排画布模式：完整工具条（先把画布清空，才能断言「空画布时按钮禁用」）
	storage.set('fatfish-canvas:view-mode', 'canvas');
	storage.delete('fatfish-canvas:follow-new');
	storage.set(
		'fatfish-canvas:board',
		JSON.stringify({ version: 2, nodes: [], viewport: { x: 0, y: 0, zoom: 1 }, ingested: [] }),
	);
	const plugin4 = factory(makeRequire(pkg.name));
	const entries4 = [];
	plugin4.apply({
		...fakeCtx,
		slots: {
			register: (spec, component) => {
				entries4.push({ spec, component });
				return () => {};
			},
			inject: (key, callback) => {
				callback();
				return () => {};
			},
		},
	});
	const panel4 = overlayOf(entries4).find((e) => e.spec.id.endsWith('-panel'));
	let tree4 = null;
	let err4 = null;
	try {
		tree4 = renderDeep(panel4.component({}));
	} catch (error) {
		err4 = error;
	}
	check('工具条深度渲染不抛错', err4 === null, String(err4 ?? ''));

	const bar = collect(tree4, (el) => hasClass(el, 'ffc-toolbar'));
	check('渲染出画布工具条', bar.length === 1, `实际 ${String(bar.length)}`);
	// 工具条必须带 data-ffc-ui：画布视口靠它把「控件的指针事件」与「拖拽起点」分开
	check('工具条带 data-ffc-ui（画布据此不抢控件指针）', bar[0]?.props['data-ffc-ui'] === 'toolbar');

	for (const label of ['全选节点', '删除选中节点', '适应内容', '新节点自动带进视野', '清空画布', '重置画布宽度', '纯画布模式']) {
		const hits = buttonByLabel(tree4, label);
		check(
			`工具条有「${label}」按钮`,
			hits.length === 1 && typeof hits[0].props.title === 'string' && hits[0].props.title !== '',
			`实际 ${String(hits.length)} 个`,
		);
	}
	check(
		'空画布时「全选 / 删除选中 / 适应内容」是禁用态（不留死按钮）',
		buttonByLabel(tree4, '全选节点')[0]?.props.disabled === true &&
			buttonByLabel(tree4, '删除选中节点')[0]?.props.disabled === true &&
			buttonByLabel(tree4, '适应内容')[0]?.props.disabled === true,
	);

	check(
		'跟焦开关默认按下（aria-pressed=true）',
		buttonByLabel(tree4, '新节点自动带进视野')[0]?.props['aria-pressed'] === true,
		String(buttonByLabel(tree4, '新节点自动带进视野')[0]?.props['aria-pressed']),
	);
	check(
		'工具条显示节点数与选中数读数',
		collect(tree4, (el) => hasClass(el, 'ffc-badge')).some((el) =>
			String(el.props.children).includes('节点'),
		),
	);
	check('并排模式下有宽度拖拽条', collect(tree4, (el) => hasClass(el, 'ffc-resizer')).length === 1);

	// P10：纯画布是顶栏上**独立**的一个按钮（不再是「视图」菜单里的一项）
	{
		const only = buttonByLabel(tree4, '纯画布模式')[0];
		check(
			'并排模式下「纯画布」按钮是未按下态（aria-pressed=false）',
			only?.props['aria-pressed'] === false,
			String(only?.props['aria-pressed']),
		);
		check(
			'「纯画布」按钮的 title 说明它会收起聊天列',
			String(only?.props.title).includes('纯画布模式'),
			String(only?.props.title),
		);
	}

	// P10：作用域读数自己就是开关（原来这项在「视图」菜单里）
	{
		const scopeBadge = collect(tree4, (el) => el.props?.['data-ffc-scope'] !== undefined)[0];
		check(
			'作用域读数是可点的按钮（带 onClick 与 aria-pressed）',
			scopeBadge?.type === 'button' &&
				typeof scopeBadge.props.onClick === 'function' &&
				typeof scopeBadge.props['aria-pressed'] === 'boolean',
			`tag=${String(scopeBadge?.type)}`,
		);
	}

	// 跟焦关掉之后，同一个按钮应变成未按下
	storage.set('fatfish-canvas:follow-new', 'off');
	const plugin5 = factory(makeRequire(pkg.name));
	const entries5 = [];
	plugin5.apply({
		...fakeCtx,
		slots: {
			register: (spec, component) => {
				entries5.push({ spec, component });
				return () => {};
			},
			inject: (key, callback) => {
				callback();
				return () => {};
			},
		},
	});
	const panel5 = overlayOf(entries5).find((e) => e.spec.id.endsWith('-panel'));
	const tree5 = renderDeep(panel5.component({}));
	check(
		'跟焦偏好持久化后按钮状态跟着变（aria-pressed=false）',
		buttonByLabel(tree5, '新节点自动带进视野')[0]?.props['aria-pressed'] === false,
		String(buttonByLabel(tree5, '新节点自动带进视野')[0]?.props['aria-pressed']),
	);

	// 画布上有节点时，按钮应恢复可用（否则「禁用」只是常量，不是逻辑）
	storage.set(
		'fatfish-canvas:board',
		JSON.stringify({
			version: 2,
			nodes: [
				{ id: 'a', kind: 'image', x: 0, y: 0, w: 100, h: 100, z: 1, status: 'ready', createdAt: 1 },
			],
			viewport: { x: 0, y: 0, zoom: 1 },
			ingested: [],
		}),
	);
	const plugin5b = factory(makeRequire(pkg.name));
	const entries5b = [];
	plugin5b.apply({
		...fakeCtx,
		slots: {
			register: (spec, component) => {
				entries5b.push({ spec, component });
				return () => {};
			},
			inject: (key, callback) => {
				callback();
				return () => {};
			},
		},
	});
	const tree5b = renderDeep(
		overlayOf(entries5b)
			.find((e) => e.spec.id.endsWith('-panel'))
			.component({}),
	);
	check(
		'有节点后「全选 / 适应内容」变为可用（选中集仍为空 ⇒ 删除仍禁用）',
		buttonByLabel(tree5b, '全选节点')[0]?.props.disabled !== true &&
			buttonByLabel(tree5b, '适应内容')[0]?.props.disabled !== true &&
			buttonByLabel(tree5b, '删除选中节点')[0]?.props.disabled === true,
	);
}

{
	// 纯画布模式：没有宽度拖拽条，宽度徽标说明画布已铺满。
	//
	// 注意这里**不能**靠「预置存储再加载」来进入纯画布 —— state.ts 有一条刻意的
	// 刷新自救：从存储恢复时会把 canvas-only 降级成并排画布（纯画布一旦渲染失败
	// 就是白屏且退不出去）。所以这里先正常加载，再用真实快捷键把它切进纯画布 ——
	// 顺带把快捷键本身也测了。
	storage.set('fatfish-canvas:view-mode', 'canvas');
	storage.set('fatfish-canvas:last-canvas-mode', 'canvas-only');
	const plugin6 = factory(makeRequire(pkg.name));
	const entries6 = [];
	plugin6.apply({
		...fakeCtx,
		slots: {
			register: (spec, component) => {
				entries6.push({ spec, component });
				return () => {};
			},
			inject: (key, callback) => {
				callback();
				return () => {};
			},
		},
	});
	check('快捷键装上去了（window 上有 keydown 监听）', (windowListeners.get('keydown') ?? []).length > 0);

	/** 派发一次 Ctrl+Shift+B。 */
	const pressViewShortcut = () => {
		fireWindow('keydown', {
			key: 'B',
			shiftKey: true,
			ctrlKey: true,
			metaKey: false,
			altKey: false,
			target: null,
			preventDefault: () => {},
		});
	};
	pressViewShortcut(); // canvas → chat
	check('快捷键第一次：回到聊天模式', bodyEl.dataset.ffcMode === 'chat', String(bodyEl.dataset.ffcMode));
	pressViewShortcut(); // chat → 上一次的画布模式（纯画布）
	check('快捷键第二次：进入纯画布（记住上次的画布模式）', bodyEl.dataset.ffcMode === 'canvas-only', String(bodyEl.dataset.ffcMode));

	const panel6 = overlayOf(entries6).find((e) => e.spec.id.endsWith('-panel'));
	const tree6 = renderDeep(panel6.component({}));
	check('纯画布模式下画布面板仍然渲染', tree6 !== null);
	check('纯画布模式下没有宽度拖拽条', collect(tree6, (el) => hasClass(el, 'ffc-resizer')).length === 0);
	check(
		'纯画布模式下没有「重置宽度」按钮',
		buttonByLabel(tree6, '重置画布宽度').length === 0,
	);
	// P10：纯画布模式没有聊天列，因此**没有**右上角的米饭碗入口 ——
	// 出口就是顶栏这个按钮（它必须常驻、且读数说明当前正在纯画布里）。
	check(
		'纯画布模式下顶栏「纯画布」按钮是按下态（这就是出口）',
		buttonByLabel(tree6, '纯画布模式')[0]?.props['aria-pressed'] === true,
		String(buttonByLabel(tree6, '纯画布模式')[0]?.props['aria-pressed']),
	);
	check(
		'纯画布模式下「纯画布」按钮的 title 变成退出说明',
		String(buttonByLabel(tree6, '纯画布模式')[0]?.props.title).includes('退出纯画布'),
		String(buttonByLabel(tree6, '纯画布模式')[0]?.props.title),
	);
	check(
		'纯画布模式下不再显示宽度读数（画布已铺满，再说一个宽度是噪音）',
		collect(tree6, (el) => hasClass(el, 'ffc-badge')).every(
			(el) => !String(el.props.children).includes('%'),
		),
	);
	check(
		'纯画布模式下画布节点仍然渲染',
		collect(tree6, (el) => el.props?.className === 'ffc-node').length > 0,
	);

	// Esc 逃生梯
	fireWindow('keydown', {
		key: 'Escape',
		shiftKey: false,
		ctrlKey: false,
		metaKey: false,
		altKey: false,
		target: null,
		preventDefault: () => {},
	});
	check('纯画布下按 Esc 退回并排画布', bodyEl.dataset.ffcMode === 'canvas', String(bodyEl.dataset.ffcMode));

	// 刷新自救：存储里写着 canvas-only，重新加载也不能落在纯画布
	storage.set('fatfish-canvas:view-mode', 'canvas-only');
	const plugin6b = factory(makeRequire(pkg.name));
	plugin6b.apply({
		...fakeCtx,
		slots: {
			register: () => () => {},
			inject: (key, callback) => {
				callback();
				return () => {};
			},
		},
	});
	check(
		'刷新自救：存储里的 canvas-only 在加载时降级为并排画布（不会白屏）',
		bodyEl.dataset.ffcMode === 'canvas',
		String(bodyEl.dataset.ffcMode),
	);
}

// P10：顶栏的「视图」菜单已整块移除（视图模式与画布宽度选择都不要了）；
// 菜单里唯一还活着的两个开关各自有了新家（跟焦 = 工具条图标，作用域 = 那枚读数）。
{
	storage.set('fatfish-canvas:view-mode', 'canvas');
	const plugin7 = factory(makeRequire(pkg.name));
	const entries7 = [];
	plugin7.apply({
		...fakeCtx,
		slots: {
			register: (spec, component) => {
				entries7.push({ spec, component });
				return () => {};
			},
			inject: (key, callback) => {
				callback();
				return () => {};
			},
		},
	});
	const panel7 = overlayOf(entries7).find((e) => e.spec.id.endsWith('-panel'));
	const tree7 = renderDeep(panel7.component({}));
	check(
		'顶栏不再渲染「视图」菜单按钮',
		collect(tree7, (el) => hasClass(el, 'ffc-view-btn')).length === 0,
	);
	check(
		'顶栏不再渲染宽菜单（视图模式 / 宽度预设那一块）',
		collect(tree7, (el) => hasClass(el, 'ffc-menu-wide')).length === 0,
	);
	check(
		'顶栏渲染出「纯画布」按钮（顶栏唯一的新控件）',
		buttonByLabel(tree7, '纯画布模式').length === 1,
	);
	check(
		'旧的右上角浮层按钮已彻底移除（.ffc-rice 不再渲染）',
		collect(tree7, (el) => hasClass(el, 'ffc-rice')).length === 0,
	);
}

// ─────────── 8b. P10：米饭碗入口在会话头部右上角（与 session log 同席位） ───────────

console.log('\n8b) P10：入口按钮的席位与切换职责');

{
	storage.set('fatfish-canvas:view-mode', 'chat');
	const plugin8 = factory(makeRequire(pkg.name));
	const entries8 = [];
	plugin8.apply({
		...fakeCtx,
		slots: {
			register: (spec, component) => {
				entries8.push({ spec, component });
				return () => {};
			},
			inject: (key, callback) => {
				callback();
				return () => {};
			},
		},
	});
	const names8 = entries8.map((e) => e.spec.name).join(',');

	const entryReg = entries8.find((e) => e.spec.name === 'conversation.session.header.utilities');
	check(
		'入口注册进 session log 所在的同一个席位（conversation.session.header.utilities）',
		entryReg !== undefined,
		names8,
	);
	check(
		'入口的席位 id 稳定',
		entryReg?.spec.id === 'fatfish-canvas-entry',
		String(entryReg?.spec.id),
	);
	check(
		'入口在席位里的 order 明确排在 session log（0）之后 = 视口最右上角',
		typeof entryReg?.spec.order === 'number' && entryReg.spec.order > 0,
		String(entryReg?.spec.order),
	);
	check(
		'不再占用 composer 工具行席位（conversation.input.left）',
		entries8.every((e) => e.spec.name !== 'conversation.input.left'),
		names8,
	);
	check(
		'不再注册任何浮层入口（shell.overlay 只剩画布面板一条）',
		overlayOf(entries8).length === 1 && overlayOf(entries8)[0]?.spec.id.endsWith('-panel'),
		overlayOf(entries8).map((e) => e.spec.id).join(','),
	);

	// 聊天模式：入口渲染，且只有一个按钮、只做「进画布」一件事
	const treeChat = renderDeep(entryReg.component({}));
	const btns = collect(treeChat, (el) => el.type === 'button' && hasClass(el, 'ffc-entry'));
	check('聊天模式下入口按钮渲染', btns.length === 1, `实际 ${String(btns.length)}`);
	check(
		'聊天模式下无障碍标签是「进入肥鱼画布」',
		btns[0]?.props['aria-label'] === '进入肥鱼画布',
		String(btns[0]?.props['aria-label']),
	);
	check(
		'入口带 data-ffc-ui（探针与 e2e 靠它认按钮）',
		btns[0]?.props['data-ffc-ui'] === 'entry',
		String(btns[0]?.props['data-ffc-ui']),
	);
	check(
		'聊天模式下单击就是进入画布（没有菜单、没有第二层）',
		typeof btns[0]?.props.onClick === 'function' &&
			btns[0]?.props['aria-haspopup'] === undefined,
		`haspopup=${String(btns[0]?.props['aria-haspopup'])}`,
	);

	// 点一下：真的进画布（走的是 state.ts 里唯一的那个切换实现）
	storage.delete('fatfish-canvas:last-canvas-mode');
	btns[0].props.onClick();
	check(
		'单击之后进入画布模式（未记录过则是并排画布）',
		bodyEl.dataset.ffcMode === 'canvas',
		String(bodyEl.dataset.ffcMode),
	);
	storage.set('fatfish-canvas:view-mode', 'canvas');

	// 画布模式：入口**不消失**（位置不变），但语义变成「返回聊天」
	const plugin8b = factory(makeRequire(pkg.name));
	const entries8b = [];
	plugin8b.apply({
		...fakeCtx,
		slots: {
			register: (spec, component) => {
				entries8b.push({ spec, component });
				return () => {};
			},
			inject: (key, callback) => {
				callback();
				return () => {};
			},
		},
	});
	const entryReg8b = entries8b.find((e) => e.spec.name === 'conversation.session.header.utilities');
	const btns8b = collect(
		renderDeep(entryReg8b.component({})),
		(el) => el.type === 'button' && hasClass(el, 'ffc-entry'),
	);
	check('画布模式下入口仍然渲染（位置不变）', btns8b.length === 1, `实际 ${String(btns8b.length)}`);
	check(
		'画布模式下无障碍标签变成「返回聊天界面」',
		btns8b[0]?.props['aria-label'] === '返回聊天界面',
		String(btns8b[0]?.props['aria-label']),
	);
	// P10 收尾：按钮里**只有图形**，聊天/画布两个字都去掉了 ——
	// 语义全部由 aria-label / title 承担，图案本身两种模式共用（米饭碗）。
	check(
		'入口只有米饭碗图标，没有任何文字子节点（两种模式都一样）',
		collect(renderDeep(entryReg8b.component({})), (el) => hasClass(el, 'ffc-entry-text')).length === 0 &&
			collect(treeChat, (el) => hasClass(el, 'ffc-entry-text')).length === 0,
	);
	btns8b[0].props.onClick();
	check(
		'画布模式下单击 = 返回聊天界面',
		bodyEl.dataset.ffcMode === 'chat',
		String(bodyEl.dataset.ffcMode),
	);
	storage.set('fatfish-canvas:view-mode', 'canvas');
}

// ─────── 8c. P17：生成模型选择在 composer 工具行（本体模型位左边那一格） ───────

console.log('\n8c) P17：composer 的生成模型格');

{
	/** 一份配好图像 + 视频模型的设置值。 */
	const CONFIG = {
		providers: {
			acme: {
				label: 'Acme 网关',
				baseURL: 'https://gw.acme.example/v1',
				models: [
					{ id: 'acme-large', kind: 'image' },
					{ id: 'acme-mov', kind: 'video' },
				],
			},
		},
		defaultImage: 'acme::acme-large',
		defaultVideo: 'acme::acme-mov',
	};

	/**
	 * 起一个插件实例并取出 composer 那一格的条目。
	 * @param value - 设置 namespace 的值；不传则用「读不到设置」的形状。
	 * @returns `{ reg, tree }`。
	 */
	const setup = (value) => {
		const scopeFor = (v) => ({
			bind: () => ({
				namespace: 'media-generation',
				getSnapshot: () => ({
					status: 'ready',
					value: v,
					base: undefined,
					user: undefined,
					revision: 1,
					writable: true,
					mode: 'host',
				}),
				subscribe: () => () => {},
				set: async () => {},
				unset: async () => {},
			}),
		});
		const ctx = value === undefined ? fakeCtx : makeFakeCtx({ settingsScope: scopeFor(value) });
		const plugin = factory(makeRequire(pkg.name));
		const entries = [];
		plugin.apply({
			...ctx,
			slots: {
				register: (spec, component) => {
					entries.push({ spec, component });
					return () => {};
				},
				inject: (key, callback) => {
					callback();
					return () => {};
				},
			},
		});
		const reg = entries.find((e) => e.spec.name === 'conversation.input.right');
		// 替身没有渲染器：只断言返回的树，绝不点开菜单（菜单走 portal，属 e2e）
		return { reg, entries, tree: reg === undefined ? null : renderDeep(reg.component({})) };
	};

	const { reg, entries, tree } = setup(CONFIG);
	check(
		'生成模型格注册进 conversation.input.right（本体模型位的紧左边那一格）',
		reg !== undefined,
		entries.map((e) => e.spec.name).join(','),
	);
	check('席位 id 稳定', reg?.spec.id === 'fatfish-canvas-model', String(reg?.spec.id));
	check(
		'注册时不再占用画布工具条（工具条那一格已按用户要求搬走）',
		collect(tree, (el) => hasClass(el, 'ffc-model-btn')).length === 0,
	);

	const trigger = collect(tree, (el) => el.type === 'button' && el.props?.['data-ffc-ui'] === 'model-picker')[0];
	check('渲染出一个触发器按钮', trigger !== undefined && hasClass(trigger, 'ffc-mp-trigger'));
	check(
		'触发器声明 aria-haspopup=menu、初始 aria-expanded=false',
		trigger?.props['aria-haspopup'] === 'menu' && trigger?.props['aria-expanded'] === false,
		`haspopup=${String(trigger?.props['aria-haspopup'])} expanded=${String(trigger?.props['aria-expanded'])}`,
	);
	check(
		'触发器是两段式标签：种类（图像）+ 当前模型名（caption 段）',
		collect(trigger, (el) => el.type === 'span' && el.props.children === '图像').length === 1 &&
			collect(trigger, (el) => hasClass(el, 'ffc-mp-value') && el.props.children === 'acme-large').length === 1,
		JSON.stringify(collect(trigger, (el) => el.type === 'span').map((el) => el.props.children)),
	);
	check(
		'无障碍标签写明种类与当前模型',
		String(trigger?.props['aria-label']).includes('图像') &&
			String(trigger?.props['aria-label']).includes('acme-large'),
		String(trigger?.props['aria-label']),
	);
	check(
		'title 同时写出图像与视频模型（一格管两种）',
		String(trigger?.props.title).includes('acme-large') && String(trigger?.props.title).includes('acme-mov'),
		String(trigger?.props.title),
	);
	check(
		'触发器结构是四件套：星光图标 + 种类 + 模型名 + 箭头',
		Array.isArray(trigger?.props.children) && trigger.props.children.length === 4,
		`子节点数 ${String(trigger?.props.children?.length)}`,
	);

	// 点一下 = 记下「展开菜单」（替身无渲染器，因此断言的落点是状态写入本身；
	// 菜单本体挂在 document.body 上，真实结构由浏览器负责验证）
	stateWrites.length = 0;
	trigger?.props.onClick();
	check('点它记下「菜单已展开」', stateWrites.includes(true), JSON.stringify(stateWrites));

	// 读不到设置时如实显示「自动」，而不是空白或报错
	const bare = setup(undefined);
	const bareTrigger = collect(bare.tree, (el) => el.type === 'button' && el.props?.['data-ffc-ui'] === 'model-picker')[0];
	check(
		'读不到设置时显示「自动」而不是空白/报错',
		collect(bareTrigger, (el) => el.type === 'span' && el.props.children === '自动').length === 1,
		JSON.stringify(collect(bareTrigger, (el) => el.type === 'span').map((el) => el.props.children)),
	);
}

// ─────────────── 9. P7：画布按会话隔离（桥 × 作用域 × 工具条读数） ───────────────

console.log('\n9) P7：画布按会话隔离');

{
	/** 一块只有种子节点的画布（v2 形态）。 */
	const seedBoard = (id) =>
		JSON.stringify({
			version: 2,
			nodes: [
				{ id, kind: 'image', x: 0, y: 0, w: 120, h: 120, z: 1, status: 'ready', createdAt: 1 },
			],
			viewport: { x: 0, y: 0, zoom: 1 },
			ingested: [],
		});

	/** 渲染一块工具条，返回作用域读数。 */
	const scopeBadgeOf = (ctx, entriesOut) => {
		const plugin = factory(makeRequire(pkg.name));
		const entries = entriesOut ?? [];
		const local = { ...ctx, slots: {
			register: (spec, component) => {
				entries.push({ spec, component });
				return () => {};
			},
			inject: (key, callback) => {
				callback();
				return () => {};
			},
		} };
		plugin.apply(local);
		const panel = overlayOf(entries).find((e) => e.spec.id.endsWith('-panel'));
		const tree = renderDeep(panel.component({}));
		return collect(tree, (el) => el.props?.['data-ffc-scope'] !== undefined)[0] ?? null;
	};

	// ── 9.1 偏好开、有当前会话：画布换到该会话的键上，并采用手上的画布 ──
	storage.clear();
	storage.set('fatfish-canvas:view-mode', 'canvas');
	storage.set('fatfish-canvas:board-scope', 'session');
	storage.set('fatfish-canvas:board', seedBoard('kept'));
	const badgeA = scopeBadgeOf(makeFakeCtx({ sessions: sessionsWith('session-live') }));
	check(
		'打开隔离且有会话：工具条读数是「本会话画布」',
		badgeA?.props['data-ffc-scope'] === 'session' && String(badgeA.props.children) === '本会话画布',
		`${String(badgeA?.props['data-ffc-scope'])} / ${String(badgeA?.props.children)}`,
	);
	check(
		'桥报来会话 id 之后，画布立刻落到会话自己的键上',
		String(storage.get('fatfish-canvas:board:session-live')).includes('"kept"'),
		String(storage.get('fatfish-canvas:board:session-live')).slice(0, 80),
	);
	check(
		'采用当前画布不会搬空共用那块（原来的键原样保留）',
		String(storage.get('fatfish-canvas:board')).includes('"kept"'),
	);

	// ── 9.2 有偏好但**没有**会话：退回共用，读数如实说「共用画布」 ──
	storage.delete('fatfish-canvas:board:session-live');
	const badgeB = scopeBadgeOf(makeFakeCtx());
	check(
		'打开隔离但没有会话：读数是「共用画布」（不假装已隔离）',
		badgeB?.props['data-ffc-scope'] === 'shared' && String(badgeB.props.children) === '共用画布',
		`${String(badgeB?.props['data-ffc-scope'])} / ${String(badgeB?.props.children)}`,
	);
	check(
		'没有会话时不会凭空造出一块会话画布',
		storage.get('fatfish-canvas:board:session-live') == null,
		String(storage.get('fatfish-canvas:board:session-live')),
	);

	// ── 9.3 `sessions` 服务缺席（裁剪过的组合）：画布照常可用 ──
	storage.delete('fatfish-canvas:board:session-live');
	const base9 = makeFakeCtx();
	const ctxNoSessions = {
		...base9,
		// cordis 在依赖缺席时**不回调** —— 桥因此根本不会装，更不会报错。
		inject: (deps, callback) => {
			if (Array.isArray(deps) && deps.includes('sessions')) {
				injections.push(deps);
				return;
			}
			base9.inject(deps, callback);
		},
	};
	const badgeC = scopeBadgeOf(ctxNoSessions);
	check(
		'`sessions` 缺席时画布仍可用，作用域停在共用',
		badgeC?.props['data-ffc-scope'] === 'shared',
		String(badgeC?.props['data-ffc-scope']),
	);

	// ── 9.4 偏好默认关：即使有会话也不隔离 ──
	storage.clear();
	storage.set('fatfish-canvas:view-mode', 'canvas');
	storage.set('fatfish-canvas:board', seedBoard('shared-one'));
	const badgeD = scopeBadgeOf(makeFakeCtx({ sessions: sessionsWith('session-live') }));
	check(
		'默认（共用偏好）下，有会话也不换成会话画布',
		badgeD?.props['data-ffc-scope'] === 'shared' &&
			storage.get('fatfish-canvas:board:session-live') == null,
		`${String(badgeD?.props['data-ffc-scope'])} / ${String(storage.get('fatfish-canvas:board:session-live'))}`,
	);
	storage.clear();
}

// ─────────── 10. P9：设置页（供应商 / 模型 / 密钥 / 探测） ───────────

console.log('\n10) P9：设置页的渲染结构');

{
	/** 一份有内容的配置：两个供应商，一个有图像+视频两个模型，一个只有基址。 */
	const CONFIG = {
		providers: {
			acme: {
				label: 'Acme 网关',
				baseURL: 'https://gw.acme.example/v1',
				apiKeyEnv: 'FFC_ACME_API_KEY',
				models: [
					{ id: 'acme-large', kind: 'image', apiKeyEnv: '', label: '' },
					{ id: 'acme-mov', kind: 'video', apiKeyEnv: 'FFC_ACME_ACME_MOV_API_KEY', label: '' },
					{ id: 'acme-vl', kind: 'vision', apiKeyEnv: '', label: '' },
				],
			},
			bare: { label: '', baseURL: '', apiKeyEnv: '', models: [] },
		},
		defaultImage: 'acme::acme-large',
		defaultVideo: '',
		defaultVision: 'acme::acme-vl',
	};

	/** 记录写入的假 api。 */
	const mutateCalls = [];
	const credentialCalls = [];
	const probeCalls = [];
	/** 替身看到的调用形状与当前网关契约不一致时记一笔。 */
	const protocolErrors = [];

	/**
	 * 造一个设置页可用的 ctx。
	 *
	 * ⚠️ 两个形状必须照**当前**真实契约建模，否则测出来的是替身而不是插件：
	 *   1. 写入面是网关派生的命名空间 `remote.settings` / `remote.credentials`，
	 *      签名是**位置参数**，信封是**一层**的 `{ ok, value }` / `{ ok, error }`
	 *      （与 dsh-client-ui-settings-models 的用法一致）。这里刻意改成过一版
	 *      两层 `{ result }` + 对象参数，结果替身与真机一起漂移：改基址失焦即回退、
	 *      点删除报 `Cannot read properties of undefined (reading 'settings')`，
	 *      离线测试却全绿。
	 *   2. 探测服务是**派生服务** `remote.mediaProbe`（`$mount` 之后才出现），
	 *      因此要按那个**服务键**提供，插件才会用嵌套 inject 捕获到它。
	 *   3. 捕获发生在 apply 期，`inject` 面只返回取值函数 —— 断言要读 `getProbe()`。
	 * @param options - `{ withProbe }` 是否提供宿主探测服务。
	 * @returns `{ ctx, section, errors }`。
	 */
	const setup = (options = {}) => {
		const withProbe = options.withProbe !== false;
		const settings = {
			mutate: async (ns, ops, expectedRevision) => {
				if (typeof ns !== 'string' || !Array.isArray(ops)) {
					protocolErrors.push(`settings.mutate 收到 ${JSON.stringify([ns, ops])}（当前签名是 (ns, ops, expectedRevision)）`);
				}
				mutateCalls.push({ ns, ops, expectedRevision });
				return { ok: true, value: { revision: 2 } };
			},
		};
		const credentials = {
			describe: async (refs) => {
				if (!Array.isArray(refs)) {
					protocolErrors.push(`credentials.describe 收到 ${JSON.stringify(refs)}（当前签名是 (refs)）`);
				}
				credentialCalls.push({ describe: refs });
				return {
					ok: true,
					value: { FFC_ACME_API_KEY: { configured: true, source: 'file', writable: true } },
				};
			},
			set: async (ref, value) => {
				if (typeof ref !== 'string' || typeof value !== 'string') {
					protocolErrors.push(`credentials.set 收到 ${JSON.stringify([ref, value])}（当前签名是 (ref, value)）`);
				}
				credentialCalls.push({ ref, value });
				return { ok: true, value: {} };
			},
			unset: async (ref) => {
				if (typeof ref !== 'string') {
					protocolErrors.push(`credentials.unset 收到 ${JSON.stringify(ref)}（当前签名是 (ref)）`);
				}
				credentialCalls.push({ ref, unset: true });
				return { ok: true, value: {} };
			},
		};
		const probe = {
			testConnection: async (id) => {
				probeCalls.push(['test', id]);
				return { ok: true, value: { ok: true, message: '连接正常（12 ms）', models: ['a'], kinds: ['image'] } };
			},
			listModels: async (id) => {
				probeCalls.push(['models', id]);
				return {
					ok: true,
					value: { ok: true, message: '连接成功，拿到 1 个模型', models: ['sora-2'], kinds: ['video'] },
				};
			},
		};

		const ctx = makeFakeCtx({
			'remote.settings': settings,
			'remote.credentials': credentials,
			...(withProbe
				? { remote: { $mount: async () => () => {} }, 'remote.mediaProbe': probe }
				: {}),
			settingsScope: {
				bind: (spec) => ({
					namespace: spec.namespace,
					getSnapshot: () => ({
						status: 'ready',
						value: CONFIG,
						base: undefined,
						user: undefined,
						revision: 1,
						writable: true,
						mode: 'host',
					}),
					subscribe: () => () => {},
				}),
			},
		});

		const entries = [];
		ctx.slots.register = (spec, component) => {
			entries.push({ spec, component });
			return () => {};
		};
		const plugin = factory(makeRequire(pkg.name));
		const errors = [];
		try {
			plugin.apply(ctx);
		} catch (error) {
			errors.push(error);
		}
		const section = entries.find((e) => e.spec.name === 'settings.section');
		return { entries, section, errors };
	};

	// ── 10.1 有探测服务：完整渲染 ──
	const a = setup();
	check('设置页 apply 不抛错（含 remote.settings / remote 注入）', a.errors.length === 0, String(a.errors[0] ?? ''));
	const face = a.section?.spec.inject?.();
	check(
		'inject 面给出 scope / api / getProbe 三样',
		face?.scope !== undefined && face?.api !== undefined && typeof face?.getProbe === 'function',
		JSON.stringify(Object.keys(face ?? {})),
	);
	check(
		'派生服务就绪后 getProbe() 取得到宿主探测服务',
		typeof face?.getProbe?.()?.testConnection === 'function',
		String(typeof face?.getProbe?.()),
	);

	let tree = null;
	let renderError = null;
	try {
		tree = renderDeep(a.section.component(face));
	} catch (error) {
		renderError = error;
	}
	check('设置页渲染不抛错', renderError === null, String(renderError ?? ''));

	const cards = collect(tree, (el) => el.props?.['data-provider'] !== undefined);
	check(
		'每个供应商渲染一张卡片（两个供应商两张卡）',
		cards.length === 2,
		cards.map((c) => c.props['data-provider']).join(','),
	);
	check(
		'卡片上带供应商 id（e2e 靠它定位）',
		cards.map((c) => c.props['data-provider']).sort().join(',') === 'acme,bare',
		cards.map((c) => c.props['data-provider']).join(','),
	);

	const baseInput = collect(tree, (el) => el.props?.['data-field'] === 'baseURL')[0];
	check(
		'接口基址输入框显示已配置的值',
		baseInput?.props?.value === 'https://gw.acme.example/v1',
		String(baseInput?.props?.value),
	);
	check(
		'基址输入框逐键不写盘（草稿 + 失焦提交，避免每敲一个字写一次设置）',
		typeof baseInput?.props?.onBlur === 'function' && typeof baseInput?.props?.onChange === 'function',
	);

	const rows = collect(tree, (el) => el.props?.['data-model'] !== undefined && el.props?.['data-kind'] !== undefined);
	check('每个模型渲染一行', rows.length === 3, String(rows.length));
	check(
		'模型行带种类标识（图像 / 视频 / 视觉）',
		rows.map((r) => r.props['data-kind']).sort().join(',') === 'image,video,vision',
		rows.map((r) => r.props['data-kind']).join(','),
	);
	check(
		'种类以中文徽标呈现（不是只靠颜色）',
		collect(tree, (el) => hasClass(el, 'ffc-set-kind')).length === 3,
	);
	check(
		'每个模型行都有「⋯」入口（右键菜单的等价可点入口）',
		collect(tree, (el) => el.props?.['data-action'] === 'model-menu').length === 3,
	);
	check(
		'模型行挂了 onContextMenu（右键单独配密钥的入口）',
		rows.every((r) => typeof r.props?.onContextMenu === 'function'),
	);
	const keyStates = collect(tree, (el) => hasClass(el, 'ffc-set-keystate'));
	check(
		'密钥状态区分「继承」与「单独」（其中一个模型配了自己的引用）',
		keyStates.some((el) => String(el.props.children).includes('继承')) &&
			keyStates.some((el) => String(el.props.children).includes('单独')),
		keyStates.map((el) => String(el.props.children)).join(' | '),
	);
	check(
		'模型级密钥状态带 data-own（e2e 与样式都靠它）',
		keyStates.map((el) => el.props['data-own']).sort().join(',') === 'false,false,true',
		keyStates.map((el) => el.props['data-own']).join(','),
	);

	const actions = collect(tree, (el) => typeof el.props?.['data-action'] === 'string').map((el) => el.props['data-action']);
	for (const action of ['test', 'models', 'remove-provider', 'add-model', 'edit-provider-key', 'clear-provider-key']) {
		check(`设置页有「${action}」按钮`, actions.filter((x) => x === action).length >= 1, actions.join(','));
	}
	check(
		'有探测服务时「测试连接 / 获取模型列表」可用',
		collect(tree, (el) => el.props?.['data-action'] === 'test').every((el) => el.props.disabled !== true),
	);
	check(
		'没有模型时给出下一步提示（而不是空白卡片）',
		collect(tree, (el) => hasClass(el, 'ffc-set-hint')).some((el) =>
			String(el.props.children).includes('还没有模型'),
		),
	);

	const selects = collect(tree, (el) => el.props?.['data-default'] !== undefined);
	check(
		'默认模型三个下拉都在（图像 / 视频 / 视觉并排），且只列同种类的模型',
		selects.length === 3 &&
			selects.every((el) => {
				const options = collect(el, (child) => child.type === 'option');
				const kindOf = (value) =>
					String(value).includes('acme-large') ? 'image' : String(value).includes('acme-vl') ? 'vision' : 'video';
				const kinds = options.slice(1).map((option) => kindOf(option.props.value));
				return kinds.every((kind) => kind === el.props['data-default']);
			}),
		selects.map((el) => `${String(el.props['data-default'])}=${String(el.props.value)}`).join(' | '),
	);
	check(
		'默认图像下拉选中了配置里的值',
		selects.find((el) => el.props['data-default'] === 'image')?.props.value === 'acme::acme-large',
		String(selects.find((el) => el.props['data-default'] === 'image')?.props.value),
	);
	check(
		'默认视觉模型与图像 / 视频并排在同一处，视觉模型只出现在这一项里',
		selects.find((el) => el.props['data-default'] === 'vision')?.props.value === 'acme::acme-vl' &&
			collect(
				selects.find((el) => el.props['data-default'] === 'vision'),
				(child) => child.type === 'option',
			).some((option) => String(option.props.value) === 'acme::acme-vl'),
		String(selects.find((el) => el.props['data-default'] === 'vision')?.props.value),
	);
	check(
		'视觉模型项写明了它是干什么的（不然没人知道该不该填）',
		String(
			collect(tree, (el) => hasClass(el, 'ffc-set-note'))
				.map((el) => String(el.props.children))
				.join(''),
		).includes('参考图'),
	);

	// ── 10.2 没有探测服务：按钮置灰并说明原因 ──
	const b = setup({ withProbe: false });
	const faceB = b.section?.spec.inject?.();
	check(
		'没有 remote 服务时 inject 面仍可用，且 getProbe() 返回 undefined',
		faceB?.scope !== undefined && faceB?.getProbe?.() === undefined,
		String(typeof faceB?.getProbe?.()),
	);
	const treeB = renderDeep(b.section.component(faceB));
	check(
		'没有探测服务时按钮置灰',
		collect(treeB, (el) => el.props?.['data-action'] === 'test').every((el) => el.props.disabled === true),
	);
	check(
		'没有探测服务时明确说明原因（不是静默不可用）',
		collect(treeB, (el) => hasClass(el, 'ffc-set-status')).some((el) =>
			String(el.props.children).includes('mediaProbe'),
		),
	);

	// ── 10.3 只读文档 ──
	const c = setup();
	const faceC = { ...c.section.spec.inject(), scope: { getSnapshot: () => ({ status: 'ready', value: CONFIG, writable: false, revision: 1 }), subscribe: () => () => {} } };
	const treeC = renderDeep(c.section.component(faceC));
	check(
		'只读设置文档时明确提示无法保存，且写入控件置灰',
		collect(treeC, (el) => hasClass(el, 'ffc-set-status')).some((el) =>
			String(el.props.children).includes('只读'),
		) && collect(treeC, (el) => el.props?.['data-action'] === 'test').every((el) => el.props.disabled === true),
	);

	check('渲染过程没有真的写设置（渲染必须是纯的）', mutateCalls.length === 0, JSON.stringify(mutateCalls));
	check('渲染过程没有读凭据（副作用只在挂载后的 effect 里）', credentialCalls.length === 0);
	check('渲染过程没有发起探测', probeCalls.length === 0, JSON.stringify(probeCalls));

	// ── 10.4 真走一次交互（这一条是本轮补的回归） ──
	//
	// 上一版只断言「渲染出来了、按钮没置灰」，于是**写入面整个是坏的**都没被发现：
	// 改基址失焦即回退、点删除报 `Cannot read properties of undefined (reading
	// 'settings')`。这里真的改一次字段、点一次测试连接，并断言替身看到的调用形状
	// 与「动作没有把自己弄成错误态」。
	/** 让挂起的微任务与定时器跑完（动作是 `void (async () => …)()`）。 */
	const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 0));

	stateWrites.length = 0;
	mutateCalls.length = 0;
	const baseField = collect(tree, (el) => el.props?.['data-field'] === 'baseURL')[0];
	baseField.props.onBlur({ target: { value: 'https://gw2.example/v1' } });
	await flushAsync();
	check(
		'改基址失焦真的写了设置（不是只改了草稿就回退）',
		mutateCalls.length === 1 &&
			mutateCalls[0].ns === 'media-generation' &&
			JSON.stringify(mutateCalls[0].ops) ===
				JSON.stringify([{ op: 'set', path: ['providers', 'acme', 'baseURL'], value: 'https://gw2.example/v1' }]) &&
			mutateCalls[0].expectedRevision === 1,
		JSON.stringify(mutateCalls),
	);
	check(
		'写入没有把自己弄成错误态（读错信封就会炸在 undefined.settings）',
		!stateWrites.some((write) => Object.values(write ?? {}).some((card) => card?.message?.kind === 'error')),
		JSON.stringify(stateWrites),
	);

	stateWrites.length = 0;
	probeCalls.length = 0;
	collect(tree, (el) => el.props?.['data-action'] === 'test')[0].props.onClick();
	await flushAsync();
	check(
		'点「测试连接」真的调了宿主探测且没有进错误态',
		probeCalls.length === 1 &&
			probeCalls[0][0] === 'test' &&
			!stateWrites.some((write) => Object.values(write ?? {}).some((card) => card?.message?.kind === 'error')),
		JSON.stringify({ probeCalls, stateWrites }),
	);
	check('替身看到的调用形状全部符合当前网关契约', protocolErrors.length === 0, protocolErrors.join('；'));
}

// ───────── 12. P3 回归：落图必须走**真实**事件窗口（SessionSnapshot 里没有会话数据） ─────────

console.log('\n12) P3 回归：事件窗口 → 画布节点');

{
	await (async () => {
	/** 落盘是去抖的（400ms）：断言前必须让它跑完，否则读到的是旧画布。 */
	const settle = () => new Promise((resolve) => setTimeout(resolve, 500));
	/** 真实 wire 形状：`tool/call`（事件窗口里的原始形状）。 */
	const callEvent = (callId, name, argsRaw, seq) => ({
		type: 'event',
		event: { type: 'tool/call', seq, time: Date.now(), data: { turn: 1, step: 1, callId, name, arguments: argsRaw } },
	});
	/** 真实 wire 形状：`tool/result`（名字**不在**结果里，只有 callId）。 */
	const resultEvent = (callId, meta, seq) => ({
		type: 'event',
		event: {
			type: 'tool/result',
			seq,
			time: Date.now(),
			data: {
				turn: 1,
				step: 1,
				message: {
					source: { kind: 'tool', callId },
					content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: '已生成图像' }], isError: false }],
				},
				meta,
			},
		},
	});

	const META = {
		fatfishCanvas: {
			kind: 'image',
			url: 'https://example.test/try-on.png',
			model: 'gpt-image-2.5-sunburst-2k',
			providerId: 'custom',
			prompt: '驼色短款夹克模特试穿图',
			aspectRatio: '3:4',
		},
	};

	// ── 12.1 工具这条路：先 pending，结果到了变 ready ──
	storage.clear();
	storage.set('fatfish-canvas:view-mode', 'canvas');
	storage.set('fatfish-canvas:board', JSON.stringify({ version: 2, nodes: [], viewport: { x: 0, y: 0, zoom: 1 }, ingested: [] }));
	const sessions1 = sessionsWith('session-live-1', [
		callEvent('call_00_live', 'media_generate', '{"prompt":"驼色夹克模特试穿图","kind":"image","aspectRatio":"3:4"}', 41),
	]);
	const ctxTool = makeFakeCtx({ sessions: sessions1 });
	factory(makeRequire(pkg.name)).apply(ctxTool);
	const boardOf = (key = 'fatfish-canvas:board') => JSON.parse(String(storage.get(key)));
	await settle(); // 等落盘去抖

	check(
		'只发生 tool/call 时就有 pending 节点（等待期间看得见「在画什么」）',
		boardOf().nodes.length === 1 && boardOf().nodes[0].status === 'pending',
		JSON.stringify(boardOf().nodes),
	);

	// 结果到达（推进窗口并通知订阅者）
	sessions1.push(resultEvent('call_00_live', META, 42));
	await settle();
	const after = boardOf();
	check(
		'tool/result 到达后节点变 ready 且带上了媒体地址',
		after.nodes.length === 1 &&
			after.nodes[0].status === 'ready' &&
			after.nodes[0].src === 'https://example.test/try-on.png' &&
			after.nodes[0].kind === 'image',
		JSON.stringify(after.nodes.map((n) => ({ s: n.status, src: n.src }))),
	);
	check('落图写进了幂等记账', after.ingested.length === 1, JSON.stringify(after.ingested));

	// ── 12.2 窗口重放不重复落图（幂等） ──
	sessions1.push(resultEvent('call_00_live', META, 42));
	await settle();
	check('同一个结果重放不会造第二个节点', boardOf().nodes.length === 1, String(boardOf().nodes.length));

	// ── 12.3 命令这条路：一开始就有 pending，`command/done` 后变 ready ──
	storage.clear();
	storage.set('fatfish-canvas:view-mode', 'canvas');
	storage.set('fatfish-canvas:board', JSON.stringify({ version: 2, nodes: [], viewport: { x: 0, y: 0, zoom: 1 }, ingested: [] }));
	const sessions2 = sessionsWith('session-live-2', [
		{
			type: 'event',
			event: {
				type: 'command/run',
				seq: 10,
				time: Date.now(),
				data: { commandId: 'cmd-live-1', name: 'generate', args: ' --ratio 3:4 驼色夹克模特试穿图', source: { kind: 'user' } },
			},
		},
	]);
	const ctxCommand = makeFakeCtx({ sessions: sessions2 });
	factory(makeRequire(pkg.name)).apply(ctxCommand);
	await settle();
	check(
		'命令一开跑就有 pending 节点（提示词与形状都从命令行原文还原）',
		boardOf().nodes.length === 1 &&
			boardOf().nodes[0].status === 'pending' &&
			boardOf().nodes[0].prompt === '驼色夹克模特试穿图',
		JSON.stringify(boardOf().nodes),
	);

	sessions2.push({
		type: 'event',
		event: {
			type: 'command/done',
			seq: 11,
			time: Date.now(),
			data: { commandId: 'cmd-live-1', kind: 'success', text: 'https://example.test/cmd.png\n图像 · 3:4' },
		},
	});
	await settle();
	check(
		'command/done 之后同一个节点变 ready（不另起一个）',
		boardOf().nodes.length === 1 &&
			boardOf().nodes[0].status === 'ready' &&
			boardOf().nodes[0].src === 'https://example.test/cmd.png',
		JSON.stringify(boardOf().nodes),
	);

	// ── 12.4 失败的命令要把原因写出来（文本在两层 content 里） ──
	storage.clear();
	storage.set('fatfish-canvas:view-mode', 'canvas');
	storage.set('fatfish-canvas:board', JSON.stringify({ version: 2, nodes: [], viewport: { x: 0, y: 0, zoom: 1 }, ingested: [] }));
	const sessions3 = sessionsWith('session-live-3');
	const ctxFail = makeFakeCtx({ sessions: sessions3 });
	factory(makeRequire(pkg.name)).apply(ctxFail);
	sessions3.push(callEvent('call_fail', 'media_generate', '{"prompt":"x","kind":"image"}', 20));
	sessions3.push({
		type: 'event',
		event: {
			type: 'tool/result',
			seq: 21,
			time: Date.now(),
			data: {
				turn: 1,
				step: 1,
				message: {
					source: { kind: 'tool', callId: 'call_fail' },
					content: [{ type: 'tool-result', toolCallId: 'call_fail', content: [{ type: 'text', text: '供应商不可用' }], isError: true }],
				},
			},
		},
	});
	await settle();
	check(
		'失败的生成落成 failed 节点并写明原因（两层 content 都要读到）',
		boardOf().nodes.length === 1 &&
			boardOf().nodes[0].status === 'failed' &&
			boardOf().nodes[0].error === '供应商不可用',
		JSON.stringify(boardOf().nodes),
	);

	// ── 12.5 假的「会话快照」不能再糊弄过去 ──
	// 这是本次 bug 的核心断言：把会话数据错放在 getSnapshot() 上，必须**不**落图。
	storage.clear();
	storage.set('fatfish-canvas:view-mode', 'canvas');
	storage.set('fatfish-canvas:board', JSON.stringify({ version: 2, nodes: [], viewport: { x: 0, y: 0, zoom: 1 }, ingested: [] }));
	const fakeSessionCtx = makeFakeCtx({
		sessions: {
			list: { getSnapshot: () => ({ current: 'legacy' }), subscribe: () => () => {} },
			binding: () => ({
				sessionId: 'legacy',
				// 旧替身的形状：会话数据挂在 SessionSnapshot 上（真实运行里不存在）
				session: { subscribe: () => () => {}, getSnapshot: () => ({ nodes: [{ kind: 'tool-result', callId: 'x', seq: 99, time: Date.now(), meta: META, isError: false }], runningCalls: [] }) },
			}),
		},
	});
	factory(makeRequire(pkg.name)).apply(fakeSessionCtx);
	await settle();
	check(
		'会话数据挂在 SessionSnapshot 上时**不**落图（钉住正确的数据来源）',
		boardOf().nodes.length === 0 && boardOf().ingested.length === 0,
		JSON.stringify(boardOf()),
	);
	storage.clear();
	})();
}

// ───────────────────────── 结果 ─────────────────────────

console.log('');
if (failures === 0) {
	console.log('全部通过 ✅');
	process.exit(0);
}
console.log(`${String(failures)} 项失败 ❌`);
process.exit(1);
