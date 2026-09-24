/**
 * 重启 `dsh web` 并自动验证（宿主改动生效 + 跑那两条只能在重启后跑的 e2e）。
 *
 * ## 为什么要有这个脚本，而不是直接敲一句重启
 *
 * **`dsh web` 就是承载当前对话的那个进程**。谁在会话里直接 kill 它，自己的
 * 这一轮就当场结束，用户只会看到页面断开、什么解释都没有，验证也做不成。
 * 因此这里把「重启 + 验证」整件事交给一个**独立进程**：
 *
 *   1. 延迟 `--delay` 毫秒（留给当前这一轮把话说完）
 *   2. 找到监听 3080 的进程并结束它
 *   3. 重新拉起 `dsh web`（detached，父进程死了也活着；**输出写进
 *      `lib/dsh-web.log`** —— 带令牌的地址只在那一行里，见 `webUrl()`）
 *   4. 等端口恢复 → 等插件加载 → 读 `lib/host-status.json` 确认宿主是新模块 →
 *      从日志里解析出**带令牌的地址**写进 `lib/web-url.txt`
 *   5. （`--verify`）依次跑 `e2e-settings.mjs`（P9 设置页 + 探测）、
 *      `e2e-command.mjs`（P6 `/generate`）与 `e2e-graph.mjs`（P18 连线 / 菜单鼠标点击 /
 *      内联编辑）—— 三条都把上面那个带令牌的地址经 `DSH_WEB_URL` 传给子进程
 *   6. 全程**追加**写进 `lib/post-restart-report.txt`
 *
 * 报告是增量写的：即使中途失败，也能看到进行到哪一步、卡在哪。
 *
 * ⚠️ 本脚本要抓子进程输出（`execFileSync` / 管道），在受限沙箱下会 EPERM ——
 * 它本来就是给「放宽沙箱后启动」用的。
 *
 * 用法：
 *   node scripts/post-restart.mjs --delay 40000 --verify
 *   node scripts/post-restart.mjs --delay 20000 --e2e e2e-graph.mjs   （只跑一条）
 */

import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = resolve(root, 'lib/post-restart-report.txt');
/** `dsh web` 自己的输出（含**带令牌的地址**）。 */
const WEB_LOG = resolve(root, 'lib/dsh-web.log');
/** 解析出来的带令牌地址，供 e2e 用（见 `webUrl()`）。 */
const WEB_URL_FILE = resolve(root, 'lib/web-url.txt');
const PORT = Number(process.env.FFC_PORT ?? 3080);
/** `dsh web` 的工作目录：仓库根（与用户平时启动的地方一致）。 */
const PROJECT_ROOT = resolve(root, '..', '..');

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
	const i = argv.indexOf(name);
	return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const DELAY_MS = Number(argOf('--delay', '40000'));
const VERIFY = argv.includes('--verify');
/** 只跑一条 e2e（`--e2e e2e-graph.mjs`）—— 不必为了验证一处而把三条都跑一遍。 */
const ONLY = argOf('--e2e', null);

writeFileSync(
	REPORT,
	`肥鱼画布 · 宿主重启 + 验证报告\n开始时间：${new Date().toISOString()}\n` +
		`（这份文件由 scripts/post-restart.mjs 增量写入）\n\n`,
	'utf8',
);

/**
 * 追加一行到报告。
 * @param line - 内容。
 */
function log(line) {
	appendFileSync(REPORT, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
	console.log(line);
}

/** 等待若干毫秒。 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 找到监听目标端口的进程号。
 *
 * 用 `netstat -ano` 而不是 WMI：受限环境下 `Get-CimInstance` 会被拒绝访问，
 * 而 netstat 只要命令行能跑就行。
 * @returns 进程号；没找到时为 null。
 */
function pidOnPort() {
	const out = execFileSync('netstat.exe', ['-ano'], { encoding: 'utf8' });
	for (const line of out.split(/\r?\n/)) {
		const parts = line.trim().split(/\s+/);
		if (parts.length < 5) continue;
		if (parts[1] !== `127.0.0.1:${String(PORT)}` && parts[1] !== `0.0.0.0:${String(PORT)}`) continue;
		if (parts[3] !== 'LISTENING') continue;
		const pid = Number(parts[4]);
		if (Number.isFinite(pid) && pid > 0) return pid;
	}
	return null;
}

/**
 * 端口是否已经在监听。
 * @returns 是否可连。
 */
async function portAlive() {
	try {
		const res = await fetch(`http://127.0.0.1:${String(PORT)}/`, { method: 'HEAD' });
		return res.status > 0;
	} catch {
		return false;
	}
}

/**
 * 读宿主就绪标记（宿主写下的诊断产物）。
 * @returns 标记对象；读不到时为 null。
 */
function readStatus() {
	try {
		return JSON.parse(readFileSync(resolve(root, 'lib/host-status.json'), 'utf8'));
	} catch {
		return null;
	}
}

/**
 * 从 `dsh web` 自己的输出里取出**带令牌的地址**。
 *
 * 为什么必须抓这一行：`dsh web` 每个进程现生成一个启动令牌（内存里的 WeakMap），
 * 只在启动时把它打进那条 `dsh web: <url>?token=…` 里；没有它，无头浏览器打开的
 * `http://127.0.0.1:3080` 只会拿到 401（页面全空，e2e 报 `no-settings-trigger`），
 * 于是**所有浏览器 e2e 都跑不动**。以前这里 `stdio: 'ignore'`，那一行直接丢了，
 * 本文件就把 token 落盘成 `lib/web-url.txt` 并回灌给 e2e 子进程。
 *
 * 同时把整份输出留在 `lib/dsh-web.log`：宿主起不来时，原因就在那儿。
 * @returns 带令牌的地址；还没打印出来时为 null。
 */
function webUrl() {
	let text = '';
	try {
		text = readFileSync(WEB_LOG, 'utf8');
	} catch {
		return null;
	}
	// 只认最后一次启动的那条（日志是追加写的）
	const lines = text.split(/\r?\n/).filter((line) => line.includes('dsh web: http'));
	const last = lines[lines.length - 1];
	if (last === undefined) return null;
	const match = /(https?:\/\/\S+)/.exec(last);
	if (match === null) return null;
	return match[1];
}

/**
 * 跑一条 e2e 脚本并把结论写进报告。
 * @param script - 脚本文件名。
 * @returns 退出码。
 */
async function runE2E(script) {
	log(`--- 运行 ${script} ---`);
	const url = webUrl();
	if (url === null) {
		log('  ⚠️ 没能从 dsh web 的输出里解析出带令牌的地址 —— 浏览器 e2e 会拿到 401，跳过');
		return 1;
	}
	return await new Promise((resolvePromise) => {
		const child = spawn(process.execPath, [resolve(root, 'scripts', script)], {
			cwd: root,
			stdio: ['ignore', 'pipe', 'pipe'],
			// 地址只在这里回灌：`DSH_WEB_URL` 不带令牌（那是给「给人看」的那一份）
			env: { ...process.env, DSH_WEB_URL: url },
		});
		let out = '';
		child.stdout.on('data', (chunk) => {
			out += String(chunk);
		});
		child.stderr.on('data', (chunk) => {
			out += String(chunk);
		});
		child.on('close', (code) => {
			// 只把结论行写进报告（完整输出太长），失败时附上 FAIL 行
			const lines = out.split(/\r?\n/).filter((line) => /全部通过|项失败|\[FAIL\]|⏭/.test(line));
			for (const line of lines) log(`  ${line.trim()}`);
			log(`--- ${script} 退出码 ${String(code)} ---`);
			resolvePromise(code ?? 1);
		});
	});
}

log(
	`重启任务启动：端口 ${String(PORT)}，延迟 ${String(Math.round(DELAY_MS / 1000))} 秒，` +
		`验证=${VERIFY ? '开' : '关'}`,
);
log(`重启前的宿主就绪标记：${JSON.stringify(readStatus())}`);

await sleep(DELAY_MS);

// ── 1. 结束旧宿主 ──
const pid = pidOnPort();
if (pid === null) {
	log('⚠️ 没有找到监听 3080 的进程 —— 也许已经停了，直接进入启动步骤');
} else {
	log(`结束旧宿主 PID=${String(pid)}`);
	try {
		execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' });
		log('taskkill 完成');
	} catch (error) {
		log(`⚠️ taskkill 失败：${error instanceof Error ? error.message : String(error)}`);
	}
}

// 等端口释放
for (let i = 0; i < 40; i += 1) {
	if (!(await portAlive())) break;
	await sleep(500);
}
log('端口已释放（或从未占用）');

/**
 * `dsh` 的入口脚本（就是 `dsh.cmd` 里硬编码的那一条）。
 *
 * ⚠️ **不能再经 `cmd.exe /c dsh` 拉起**（2026-09-24 实测，见下）：`detached: true` +
 * `windowsHide: true` 下，cmd.exe 起的**外部进程**（node.exe 这种）的输出**进不了
 * 我们传进去的文件句柄** —— `lib/dsh-web.log` 是 0 字节，于是带令牌的地址永远解析
 * 不出来，所有浏览器 e2e 都跑不动（症状是那句「没能从 lib/dsh-web.log 里解析出带令牌的地址」）。
 * 实测矩阵（Node 24.12 / Windows）：
 *   cmd /c dsh --version        detached+hide → **空**
 *   cmd /c node --version       detached+hide → **空**
 *   cmd /c echo hello           detached+hide → "hello"（cmd 内建命令反而没事）
 *   node bin.js --version       detached+hide → "0.1.5-rc.3" ✅
 * 所以这里绕开 cmd，直接用 `process.execPath` 跑入口 —— 输出照样抓得到，detached 也保住了。
 * @returns 入口的绝对路径；两处候选都不在时为 null（退回老写法，至少把宿主拉起来）。
 */
function dshEntry() {
	const candidates = [
		// npm 全局前缀（Windows 上就是 `%APPDATA%\npm`，`dsh.cmd` 也在那儿）
		join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
		// node 自己的安装目录旁边（有人把 dsh 装在局部）
		join(dirname(process.execPath), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
	];
	for (const candidate of candidates) {
		if (candidate !== '' && existsSync(candidate)) return candidate;
	}
	return null;
}

// ── 2. 拉起新宿主（detached：父进程死了它也活着） ──
// 输出**不能丢**：带令牌的地址就在那一行里（见 `webUrl()`）。日志每次重启重写
// （不是追加）：留着上一次的地址会让 e2e 拿一个已经作废的令牌，症状是 401 空页面。
log('启动 dsh web（detached，输出写进 lib/dsh-web.log）');
const logFd = openSync(WEB_LOG, 'w');
const entry = dshEntry();
if (entry === null) log('⚠️ 没找到 dsh 的入口脚本 —— 退回 `cmd.exe /c dsh web`（这条路的输出抓不到，令牌多半解析不出来）');
const child =
	entry === null
		? spawn('cmd.exe', ['/c', 'dsh', 'web'], {
				cwd: PROJECT_ROOT,
				detached: true,
				stdio: ['ignore', logFd, logFd],
				windowsHide: true,
			})
		: spawn(process.execPath, [entry, 'web'], {
				cwd: PROJECT_ROOT,
				detached: true,
				stdio: ['ignore', logFd, logFd],
				windowsHide: true,
			});
child.unref();
closeSync(logFd);

// ── 3. 等它起来 ──
let up = false;
for (let i = 0; i < 120; i += 1) {
	await sleep(1000);
	if (await portAlive()) {
		up = true;
		break;
	}
}
log(up ? '端口已恢复监听' : '⚠️ 端口在 120 秒内没有恢复 —— 看 lib/dsh-web.log');

if (up) {
	// 插件加载 + 宿主注册需要一点时间
	await sleep(12000);
	const status = readStatus();
	log(`重启后的宿主就绪标记：${JSON.stringify(status)}`);
	const hasCommand = status !== null && typeof status.command === 'string';
	const hasModels = status !== null && Array.isArray(status.models);
	log(
		hasCommand && hasModels
			? '✅ 宿主是新模块（command + models 字段都在）'
			: '⚠️ 宿主就绪标记里没有 command/models 字段 —— 宿主可能还是旧模块或注册失败',
	);

	// 带令牌的地址：写进 lib/web-url.txt（**整行原样**进日志会把令牌抄进报告，
	// 报告是要给人看的，只回显端口与域名那一段）。
	const url = webUrl();
	if (url === null) {
		log('⚠️ 没能从 lib/dsh-web.log 里解析出带令牌的地址 —— 浏览器 e2e 会 401');
	} else {
		writeFileSync(WEB_URL_FILE, `${url}\n`, 'utf8');
		const parsed = new URL(url);
		log(`✅ 已拿到带令牌的地址并写入 lib/web-url.txt（${parsed.origin}${parsed.pathname}?token=…）`);
	}
}

// ── 4. 验证 ──
if (VERIFY) {
	await runE2E('e2e-settings.mjs');
	await runE2E('e2e-command.mjs');
	await runE2E('e2e-graph.mjs');
} else if (ONLY !== null) {
	await runE2E(ONLY);
}

log('重启任务结束');
