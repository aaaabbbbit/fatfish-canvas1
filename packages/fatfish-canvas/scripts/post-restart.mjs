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
 *   3. 重新拉起 `dsh web`（detached，父进程死了也活着）
 *   4. 等端口恢复 → 等插件加载 → 读 `lib/host-status.json` 确认宿主是新模块
 *   5. （`--verify`）依次跑 `e2e-settings.mjs`（P9 设置页 + 探测）与
 *      `e2e-command.mjs`（P6 `/generate`，默认断言 pending → failed）
 *   6. 全程**追加**写进 `lib/post-restart-report.txt`
 *
 * 报告是增量写的：即使中途失败，也能看到进行到哪一步、卡在哪。
 *
 * ⚠️ 本脚本要抓子进程输出（`execFileSync` / 管道），在受限沙箱下会 EPERM ——
 * 它本来就是给「放宽沙箱后启动」用的。
 *
 * 用法：
 *   node scripts/post-restart.mjs --delay 40000 --verify
 */

import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = resolve(root, 'lib/post-restart-report.txt');
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
 * 跑一条 e2e 脚本并把结论写进报告。
 * @param script - 脚本文件名。
 * @returns 退出码。
 */
async function runE2E(script) {
	log(`--- 运行 ${script} ---`);
	return await new Promise((resolvePromise) => {
		const child = spawn(process.execPath, [resolve(root, 'scripts', script)], {
			cwd: root,
			stdio: ['ignore', 'pipe', 'pipe'],
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

// ── 2. 拉起新宿主（detached：父进程死了它也活着） ──
log('启动 dsh web（detached）');
const child = spawn('cmd.exe', ['/c', 'dsh', 'web'], {
	cwd: PROJECT_ROOT,
	detached: true,
	stdio: 'ignore',
	windowsHide: true,
});
child.unref();

// ── 3. 等它起来 ──
let up = false;
for (let i = 0; i < 120; i += 1) {
	await sleep(1000);
	if (await portAlive()) {
		up = true;
		break;
	}
}
log(up ? '端口已恢复监听' : '⚠️ 端口在 120 秒内没有恢复 —— 请看宿主自己的输出');

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
}

// ── 4. 验证 ──
if (VERIFY) {
	await runE2E('e2e-settings.mjs');
	await runE2E('e2e-command.mjs');
}

log('重启任务结束');
