/**
 * GUI 探针：用无头 Chrome 打开运行中的 DeepSeek Harness，通过 CDP 取回
 * 真实的 DOM 命中测试结果与截图。
 *
 * 为什么需要它：客户端插件的故障（元素被遮挡、层级被压、pointer-events 被吞、
 * 布局算错）只存在于浏览器里 —— 服务端日志、HTTP 探活、无浏览器冒烟测试
 * 都看不见。这个探针把「浏览器里到底发生了什么」变成可读取的事实，
 * 从而不必靠猜、也不必反复打扰用户去 DevTools 里读数。
 *
 * 只依赖 Node 24 内置的 fetch 与 WebSocket，不需要任何 npm 包。
 *
 * 用法：
 *   node scripts/probe-gui.mjs                        # 跑内置诊断并截图
 *   node scripts/probe-gui.mjs --expr-file diag.js     # 跑自定义表达式
 *   node scripts/probe-gui.mjs --shot out.png          # 指定截图输出路径
 *   node scripts/probe-gui.mjs --json out.json         # 把探针结果写进文件
 *   node scripts/probe-gui.mjs --url http://127.0.0.1:3080/
 *
 * ⚠️ 想把结果存成文件时用 `--json`，**不要用 PowerShell 的 `>` 重定向**：
 * PowerShell 5.1 的 `>` 写的是 UTF-16LE，含中文的结果读出来是「二进制文件」；
 * 而 `| Out-File -Encoding utf8` 又会带 BOM。让 Node 自己写盘就没这问题。
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ─────────────────────────── 参数 ───────────────────────────

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
	const i = argv.indexOf(name);
	return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

const URL_TARGET = argOf('--url', 'http://127.0.0.1:3080/');
const SHOT_PATH = argOf('--shot', resolve(root, 'lib/probe-shot.png'));
const EXPR_FILE = argOf('--expr-file', null);
const JSON_PATH = argOf('--json', null);
const PORT = Number(argOf('--port', '9222'));
const BOOT_WAIT_MS = Number(argOf('--wait', '9000'));

/** 候选浏览器（按优先级）。 */
const BROWSERS = [
	'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
	'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
	'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
	'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

/** 默认诊断表达式：一次性回答「我的元素到底怎么了」。 */
const DEFAULT_EXPR = `(() => {
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const topAt = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    if (!hit) return null;
    const path = [];
    for (let n = hit; n && path.length < 6; n = n.parentElement) {
      path.push(n.tagName.toLowerCase() + (typeof n.className === 'string' && n.className ? '.' + n.className.trim().split(/\\s+/).join('.') : ''));
    }
    return path;
  };
  const cs = (el, prop) => (el ? getComputedStyle(el)[prop] : null);

  const panel = q('.ffc-panel');
  const viewport = q('.ffc-viewport');
  const bar = q('.ffc-zoombar');
  const btn = q('.ffc-zoombar button');
  const overlay = q('[data-shell-overlay]');
  const frame = overlay ? overlay.parentElement : null;

  return JSON.stringify({
    url: location.href,
    bodyMode: document.body.dataset.ffcMode ?? null,
    frameTagged: frame ? frame.dataset.ffcFrame !== undefined : false,
    window: { w: window.innerWidth, h: window.innerHeight },
    frame: rect(frame),
    framePos: cs(frame, 'position'),
    overlay: rect(overlay),
    overlayPE: cs(overlay, 'pointerEvents'),
    panel: rect(panel),
    panelPos: cs(panel, 'position'),
    panelPE: cs(panel, 'pointerEvents'),
    panelZ: cs(panel, 'zIndex'),
    panelParentChain: (() => {
      const out = [];
      for (let n = panel; n && out.length < 6; n = n.parentElement) {
        out.push(n.tagName.toLowerCase() + (typeof n.className === 'string' && n.className ? '.' + n.className.trim().split(/\\s+/).join('.') : ''));
      }
      return out;
    })(),
    viewport: rect(viewport),
    viewportTopAt: topAt(viewport),
    bar: rect(bar),
    barTopAt: topAt(bar),
    btn: rect(btn),
    btnTopAt: topAt(btn),
    nodeCount: qa('.ffc-node').length,
    styleTags: qa('style[data-plugin="fatfish-canvas"]').length,
    bootHasPlugin: (() => {
      const b = window.__DSH_BOOT__;
      if (!b || !Array.isArray(b.entries)) return null;
      return b.entries.filter((e) => String(e.id).includes('fatfish')).map((e) => e.id + '@' + e.rev);
    })(),
  }, null, 1);
})()`;

// ─────────────────────────── CDP 客户端 ───────────────────────────

/** 极简 CDP 客户端：请求/响应 + 事件订阅。 */
class Cdp {
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

	/** 等待一个 CDP 事件。 */
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

// ─────────────────────────── 主流程 ───────────────────────────

const browserPath = BROWSERS.find((candidate) => existsSync(candidate));
if (browserPath === undefined) {
	console.error('probe-gui: 找不到可用的 Chrome / Edge');
	process.exit(2);
}

// profile 放在工作区内：临时目录在受限沙箱下可能不可写，而工作区一定可写。
// 刻意不删除 —— 复用 profile 能让重复运行的启动快很多。
const profileDir = resolve(root, 'lib/probe-profile');
await mkdir(profileDir, { recursive: true });

const child = spawn(
	browserPath,
	[
		'--headless=new',
		'--disable-gpu',
		'--no-first-run',
		'--no-default-browser-check',
		'--disable-extensions',
		'--hide-scrollbars',
		'--disable-crash-reporter',
		'--noerrdialogs',
		`--remote-debugging-port=${String(PORT)}`,
		`--user-data-dir=${profileDir}`,
		'--window-size=1680,1000',
		'about:blank',
	],
	{ stdio: 'ignore', detached: false },
);

/** 轮询调试端点，直到浏览器就绪。 */
async function waitForDevtools(timeoutMs = 30000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`http://127.0.0.1:${String(PORT)}/json/version`);
			if (res.ok) return await res.json();
		} catch {
			/* 还没起来 */
		}
		await new Promise((r) => setTimeout(r, 300));
	}
	throw new Error('devtools 端点不可达');
}

let exitCode = 0;
try {
	await waitForDevtools();

	const list = await (await fetch(`http://127.0.0.1:${String(PORT)}/json/list`)).json();
	const page = list.find((t) => t.type === 'page');
	if (page === undefined) throw new Error('没有 page target');

	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((res, rej) => {
		ws.addEventListener('open', res, { once: true });
		ws.addEventListener('error', rej, { once: true });
	});
	const cdp = new Cdp(ws);

	await cdp.send('Page.enable');
	await cdp.send('Runtime.enable');

	const loaded = cdp.once('Page.loadEventFired');
	await cdp.send('Page.navigate', { url: URL_TARGET });
	await loaded;

	// 全新 profile 没有 localStorage，视图模式默认是 chat —— 那样画布面板会
	// 渲染成 null，探针什么都看不到。先预置成 canvas 模式再重载一次。
	// `--chat` 则保持聊天模式（侧边栏展开），用于探查设置入口这类外壳控件。
	const wantedMode = argv.includes('--chat') ? 'chat' : 'canvas';
	await cdp.send('Runtime.evaluate', {
		// 顺手清掉画布作用域偏好：残留的 session 会让 app 去读会话那块画布，
		// 探针就会看到一片空白，看起来像插件没工作。
		expression:
			`window.localStorage.setItem('fatfish-canvas:view-mode', ${JSON.stringify(wantedMode)});` +
			"window.localStorage.removeItem('fatfish-canvas:board-scope');",
	});
	const reloaded = cdp.once('Page.loadEventFired');
	await cdp.send('Page.reload', { ignoreCache: false });
	await reloaded;

	// 应用要跑完启动图（加载并物化全部客户端插件），因此这里必须等
	await new Promise((r) => setTimeout(r, BOOT_WAIT_MS));

	const expression =
		EXPR_FILE === null ? DEFAULT_EXPR : await readFile(resolve(EXPR_FILE), 'utf8');
	const result = await cdp.send('Runtime.evaluate', {
		expression,
		returnByValue: true,
		awaitPromise: true,
	});

	if (result.exceptionDetails !== undefined) {
		console.error('probe-gui: 表达式抛错：', JSON.stringify(result.exceptionDetails, null, 1));
		exitCode = 1;
	} else {
		const value = result.result?.value;
		const rendered = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
		console.log(rendered);
		if (JSON_PATH !== null) {
			// 由 Node 自己写盘：含中文的结果经 PowerShell 重定向会变成 UTF-16/乱码
			await writeFile(resolve(JSON_PATH), rendered, 'utf8');
			console.log(`\n[probe-gui] 结果已写入：${resolve(JSON_PATH)}`);
		}
	}

	// 截图：这是「肉眼看一眼」的替代品
	const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
	await writeFile(SHOT_PATH, Buffer.from(shot.data, 'base64'));
	console.log(`\n[probe-gui] 截图已保存：${SHOT_PATH}`);

	ws.close();
} catch (error) {
	console.error('probe-gui 失败：', error instanceof Error ? error.message : String(error));
	exitCode = 1;
} finally {
	child.kill();
}

process.exit(exitCode);
