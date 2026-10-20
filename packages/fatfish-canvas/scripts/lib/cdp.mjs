/**
 * CDP 测试基础设施：启动无头 Chrome、连上调试协议、派发真实输入事件。
 *
 * 由 probe-gui.mjs（诊断）与 e2e-canvas.mjs（端到端交互测试）共用。
 * 只依赖 Node 24 内置的 fetch 与 WebSocket。
 *
 * 注意：无头 Chrome 需要创建命名管道，因此在受限沙箱下无法启动；
 * 运行本模块的任何脚本都需要放宽文件/进程沙箱。
 *
 * @module fatfish-canvas/scripts/lib/cdp
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = resolve(here, '../..');

/** 候选浏览器（按优先级）。 */
export const BROWSERS = [
	'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
	'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
	'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
	'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

/** 极简 CDP 客户端：请求/响应 + 事件订阅。 */
export class Cdp {
	/** @param {WebSocket} ws - 已连接的调试 WebSocket。 */
	constructor(ws) {
		this.ws = ws;
		this.seq = 0;
		this.pending = new Map();
		this.handlers = new Map();
		ws.addEventListener('message', (event) => {
			const msg = JSON.parse(event.data);
			if (msg.id !== undefined) {
				const entry = this.pending.get(msg.id);
				if (entry === undefined) return;
				this.pending.delete(msg.id);
				if (msg.error !== undefined) entry.reject(new Error(JSON.stringify(msg.error)));
				else entry.resolve(msg.result);
				return;
			}
			for (const handler of this.handlers.get(msg.method) ?? []) handler(msg.params);
		});
	}

	/**
	 * 发送一条 CDP 命令。
	 * @param method - CDP 方法名。
	 * @param params - 参数。
	 * @returns 命令结果。
	 */
	send(method, params = {}) {
		const id = ++this.seq;
		return new Promise((resolvePromise, rejectPromise) => {
			this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
			this.ws.send(JSON.stringify({ id, method, params }));
		});
	}

	/**
	 * 订阅一个 CDP 事件。
	 * @param method - 事件名。
	 * @param handler - 回调。
	 */
	on(method, handler) {
		const list = this.handlers.get(method) ?? [];
		list.push(handler);
		this.handlers.set(method, list);
	}

	/**
	 * 等待一个 CDP 事件。
	 * @param method - 事件名。
	 * @param timeoutMs - 超时。
	 * @returns 事件参数。
	 */
	once(method, timeoutMs = 30000) {
		return new Promise((resolvePromise, rejectPromise) => {
			const timer = setTimeout(() => {
				rejectPromise(new Error(`timeout waiting for ${method}`));
			}, timeoutMs);
			this.on(method, (params) => {
				clearTimeout(timer);
				resolvePromise(params);
			});
		});
	}
}

/** 等待若干毫秒。 */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 启动浏览器并连上调试协议。
 * @param options - 配置。
 * @returns 句柄：`{ cdp, browser, close }`。
 */
export async function launch(options = {}) {
	const port = options.port ?? 9222;
	const browserPath = (options.browsers ?? BROWSERS).find((candidate) => existsSync(candidate));
	if (browserPath === undefined) throw new Error('cdp: 找不到可用的 Chrome / Edge');

	const profileDir = options.profileDir ?? resolve(PACKAGE_ROOT, 'lib/probe-profile');
	await mkdir(profileDir, { recursive: true });

	const child = spawn(
		browserPath,
		[
			'--headless=new',
			'--disable-gpu',
			'--no-first-run',
			'--no-default-browser-check',
			'--disable-extensions',
			'--disable-crash-reporter',
			'--noerrdialogs',
			'--hide-scrollbars',
			// 视口尺寸直接决定画布与聊天的宽度求解，固定住才能让断言可复现
			'--window-size=1680,1000',
			`--remote-debugging-port=${String(port)}`,
			`--user-data-dir=${profileDir}`,
			'about:blank',
		],
		{ stdio: 'ignore' },
	);

	const deadline = Date.now() + 30000;
	let version = null;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`http://127.0.0.1:${String(port)}/json/version`);
			if (res.ok) {
				version = await res.json();
				break;
			}
		} catch {
			/* 还没起来 */
		}
		await sleep(300);
	}
	if (version === null) {
		child.kill();
		throw new Error('cdp: devtools 端点不可达（受限沙箱会阻止 Chrome 创建命名管道）');
	}

	const list = await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json();
	const page = list.find((t) => t.type === 'page');
	if (page === undefined) {
		child.kill();
		throw new Error('cdp: 没有 page target');
	}

	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((res, rej) => {
		ws.addEventListener('open', res, { once: true });
		ws.addEventListener('error', rej, { once: true });
	});
	const cdp = new Cdp(ws);
	await cdp.send('Page.enable');
	await cdp.send('Runtime.enable');

	return {
		cdp,
		version,
		async close() {
			try {
				ws.close();
			} catch {
				/* 已关 */
			}
			child.kill();
			await sleep(300);
		},
	};
}

/**
 * 种状态时的公共前置：把画布作用域钉在**共用那块**上。
 *
 * 为什么必须钉：e2e 脚本统统往 `fatfish-canvas:board`（共用那块）里种节点，
 * 而画布默认是**按工作区分**的（一个工作区一块）—— 页面一认出当前会话的工作区，
 * 就去读 `fatfish-canvas:board:<工作区路径>`，种下的节点一个都不渲染，
 * 看着像组件坏了。探针 profile 是复用的，这件事特别容易发生
 * （P7 时代是同一个坑的另一半：残留的 `session` 偏好）。
 * 因此凡自己种共用画布的脚本都要先钉成 `shared`。
 * 作用域本身的行为由 `e2e-scope.mjs` 专门覆盖，不靠别人顺带测。
 */
export const PIN_SHARED_BOARD = "window.localStorage.setItem('fatfish-canvas:board-scope','shared');";

/**
 * 造一段「种画布但**保住原账本**」的表达式。
 *
 * 为什么必须保住 `ingested`：落图有一条有意为之的规则 ——
 * **结果够新就补落**（`INGEST_FRESH_MS` = 10 分钟）。于是「同一个会话里刚跑过
 * `/generate`」之后，任何**清空账本**再重载的脚本都会让那个命令节点**又落回画布**
 * （这不是 bug，正是「打开页面时正好生成完的那次要补上」）。
 * 老脚本的种子写着 `ingested: []`，于是它们互相污染、而且与时间有关：
 * 本轮实测 `e2e-canvas` 报「重载后节点从 localStorage 复原，实际 5 个」、
 * `e2e-theme` 的空态占位根本没渲染（因为画布不空）。
 *
 * 做法：把当前存储里的账本读出来、原样放进新种子 ——
 * 已经落过图的生成不会被重放，种下的节点就是唯一内容。
 *
 * ⚠️ 返回的是一段**表达式字符串**，要放进 `Runtime.evaluate` 的 expression。
 * @param seedJson - 种子画布的 JSON 字符串（形如 `JSON.stringify({version,nodes,…})`）。
 * @returns 可直接求值的 JS 表达式。
 */
export function seedBoardExpression(seedJson) {
	return `(() => {
		const key = 'fatfish-canvas:board';
		let ledger = [];
		try {
			const prev = JSON.parse(window.localStorage.getItem(key) || 'null');
			if (prev !== null && Array.isArray(prev.ingested)) ledger = prev.ingested;
		} catch {
			/* 坏数据按空账本处理 */
		}
		let seed = ${seedJson};
		// 防御：万一调用方把「已经是 JSON 字符串」的种子又 stringify 了一次，
		// 这里会拿到一个字符串。直接写下去会让 store 反序列化出一个字符串
		// （typeof !== 'object'）→ 回退成**空画布**，症状是「种下的节点全都不见了」。
		// 本轮就踩过这一次（e2e-theme 第二轮），所以顺手拆一层。
		if (typeof seed === 'string') {
			try {
				seed = JSON.parse(seed);
			} catch {
				/* 真不是 JSON 就原样交给它失败，至少不静默 */
			}
		}
		seed.ingested = ledger;
		window.localStorage.setItem(key, JSON.stringify(seed));
		return ledger.length;
	})()`;
}

/**
 * 导航到目标并在需要时预置画布模式。
 * @param cdp - CDP 客户端。
 * @param url - 目标地址。
 * @param options - `{ canvasMode, waitMs }`。
 */
export async function goto(cdp, url, options = {}) {
	const canvasMode = options.canvasMode ?? true;
	const waitMs = options.waitMs ?? 9000;

	let loaded = cdp.once('Page.loadEventFired');
	await cdp.send('Page.navigate', { url });
	await loaded;

	if (canvasMode) {
		// 全新 profile 没有 localStorage，视图模式默认 chat —— 那样画布面板渲染成
		// null。先预置模式再重载一次。
		await cdp.send('Runtime.evaluate', {
			expression:
				`window.localStorage.setItem('fatfish-canvas:view-mode','canvas');` +
				PIN_SHARED_BOARD,
		});
		loaded = cdp.once('Page.loadEventFired');
		await cdp.send('Page.reload', { ignoreCache: false });
		await loaded;
	}

	await sleep(waitMs);
}

/**
 * 在页面里求值一个表达式并取回值。
 * @param cdp - CDP 客户端。
 * @param expression - JS 表达式。
 * @returns 值。
 */
export async function evaluate(cdp, expression) {
	const result = await cdp.send('Runtime.evaluate', {
		expression,
		returnByValue: true,
		awaitPromise: true,
	});
	if (result.exceptionDetails !== undefined) {
		throw new Error(
			`evaluate 抛错：${JSON.stringify(result.exceptionDetails.exception?.description ?? result.exceptionDetails)}`,
		);
	}
	return result.result?.value;
}

/**
 * 派发一次左键单击。
 * @param cdp - CDP 客户端。
 * @param x - 视口 X。
 * @param y - 视口 Y。
 */
export async function click(cdp, x, y) {
	const base = { x, y, button: 'left', clickCount: 1 };
	await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1 });
	await sleep(30);
	await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 });
	await sleep(60);
}

/**
 * 派发一次带拖拽的指针序列。
 * @param cdp - CDP 客户端。
 * @param from - 起点。
 * @param to - 终点。
 * @param steps - 中间步数。
 */
export async function drag(cdp, from, to, steps = 8) {
	await cdp.send('Input.dispatchMouseEvent', {
		type: 'mousePressed',
		x: from.x,
		y: from.y,
		button: 'left',
		buttons: 1,
		clickCount: 1,
	});
	for (let i = 1; i <= steps; i += 1) {
		const t = i / steps;
		await cdp.send('Input.dispatchMouseEvent', {
			type: 'mouseMoved',
			x: Math.round(from.x + (to.x - from.x) * t),
			y: Math.round(from.y + (to.y - from.y) * t),
			button: 'left',
			buttons: 1,
		});
		await sleep(12);
	}
	await cdp.send('Input.dispatchMouseEvent', {
		type: 'mouseReleased',
		x: to.x,
		y: to.y,
		button: 'left',
		buttons: 0,
		clickCount: 1,
	});
	await sleep(80);
}

/**
 * 派发一次滚轮事件。
 * @param cdp - CDP 客户端。
 * @param x - 视口 X。
 * @param y - 视口 Y。
 * @param deltaY - 纵向增量（负值向上/放大）。
 * @param modifiers - 位掩码：1=Alt 2=Ctrl 4=Meta 8=Shift。
 */
export async function wheel(cdp, x, y, deltaY, modifiers = 0) {
	await cdp.send('Input.dispatchMouseEvent', {
		type: 'mouseWheel',
		x,
		y,
		deltaX: 0,
		deltaY,
		modifiers,
	});
	await sleep(60);
}
