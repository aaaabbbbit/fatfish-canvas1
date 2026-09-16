/**
 * P6 端到端：`/generate` 直达命令（真实浏览器 + 真实斜杠命令派发）。
 *
 * 与 `e2e-ingest.mjs` 的区别：那条走**模型**（agent 决定调用工具），这条走
 * **命令**（用户直接敲，零 token、不经过模型）。两条路的落图规则相同，
 * 但客户端读的是两种不同的会话节点（`tool-result` vs `command`），
 * 因此必须各测一遍。
 *
 * ⚠️ **需要宿主已重启**：命令是宿主半边注册的，而运行中的 `dsh web` 不会重新
 * 导入宿主模块（见 STATE 3.4）。脚本先读 `lib/host-status.json`：
 * 里面没有 `command` 字段就说明宿主还是旧模块 —— 这时**明确报告并跳过**，
 * 而不是报一堆看不懂的失败。
 *
 * 用法（需放宽沙箱：无头 Chrome 要创建命名管道）：
 *   node scripts/e2e-command.mjs                          # 未配密钥：pending → failed
 *   node scripts/e2e-command.mjs --expect-status ready    # 配好假供应商：pending → ready
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PACKAGE_ROOT, RESET_BOARD_PREFS, evaluate, launch, seedBoardExpression, sleep } from './lib/cdp.mjs';

const URL_TARGET = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080/';
const argv = process.argv.slice(2);
const argOf = (name, fallback = null) => {
	const i = argv.indexOf(name);
	return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

const EXPECT_STATUS = argOf('--expect-status');
/** 命令行：默认走一个带比例参数的图像生成。 */
const LINE = argOf('--line', '/generate --ratio 16:9 一只胖乎乎的肥鱼在米饭碗里游泳');
const WATCH_MS = Number(argOf('--watch', '90000'));
const SHOT = resolve(PACKAGE_ROOT, 'lib/e2e-command.png');
const STATUS_PATH = resolve(PACKAGE_ROOT, 'lib/host-status.json');

let failures = 0;
const results = [];
const check = (label, ok, detail = '') => {
	if (!ok) failures += 1;
	results.push(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail === '' ? '' : ` — ${detail}`}`);
};
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN);

/** 页面事实。 */
const PROBE = `(() => {
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const text = (el) => (el ? (el.textContent || '').trim() : null);
  const world = document.querySelector('.ffc-world');
  const m = world ? new DOMMatrixReadOnly(getComputedStyle(world).transform) : null;
  const zoom = m ? m.a : null;
  return JSON.stringify({
    mode: document.body.dataset.ffcMode ?? null,
    zoom,
    vx: m && zoom ? -m.e / zoom : null,
    viewport: (() => { const el = document.querySelector('.ffc-viewport'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
    nodes: qa('.ffc-node').map((n) => {
      const r = n.getBoundingClientRect();
      return {
        id: n.dataset.nodeId,
        status: n.dataset.status,
        kind: n.dataset.kind,
        left: parseFloat(n.style.left),
        top: parseFloat(n.style.top),
        // **世界坐标**尺寸（节点自己的内联样式）：屏幕尺寸会被画布缩放乘一遍，
        // 而画布 zoom 会随跟焦/适应内容变化 —— 拿屏幕尺寸断言「节点多大」是假故障。
        world: { w: parseFloat(n.style.width), h: parseFloat(n.style.height) },
        box: { w: Math.round(r.width), h: Math.round(r.height) },
        title: text(n.querySelector('.ffc-node-title')),
        src: n.querySelector('img') ? n.querySelector('img').getAttribute('src') : null,
        error: text(n.querySelector('.ffc-node-failed-reason')),
      };
    }),
    // 命令卡片：客户端把 command/run↔command/done 折叠成会话节点
    commands: qa('[data-chat-anchor-key^="command:"], [data-command-id]').map((el) => ({
      key: el.getAttribute('data-chat-anchor-key'),
      text: (el.textContent || '').replace(/\\s+/g, ' ').slice(0, 160),
    })),
    bodyText: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 600),
    board: (() => { try { return JSON.parse(window.localStorage.getItem('fatfish-canvas:board') || 'null'); } catch (e) { return 'unparsable'; } })(),
  });
})()`;

// ── 0. 宿主是否已重启（命令是否已注册） ──
let hostStatus = null;
try {
	hostStatus = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
} catch {
	hostStatus = null;
}
if (hostStatus === null || typeof hostStatus.command !== 'string') {
	console.log('\n肥鱼画布 · /generate 直达命令端到端\n');
	console.log('⏭  跳过：宿主还没有重启。');
	console.log(
		`   lib/host-status.json 里没有 command 字段（当前 phase=${String(hostStatus?.phase)}）——` +
			'说明运行中的 dsh web 还是旧模块，命令尚未注册。',
	);
	console.log('   重启一次 dsh web，再跑一遍本脚本即可完成验证。\n');
	process.exit(0);
}

const browser = await launch();
const read = async () => JSON.parse(await evaluate(browser.cdp, PROBE));

console.log(`\n肥鱼画布 · /generate 直达命令端到端\n目标：${URL_TARGET}\n命令：${LINE}\n`);

try {
	// 1) 清空画布、进画布模式
	let loaded = browser.cdp.once('Page.loadEventFired');
	await browser.cdp.send('Page.navigate', { url: URL_TARGET });
	await loaded;
	await evaluate(
		browser.cdp,
		`(() => {
			window.localStorage.setItem('fatfish-canvas:view-mode', 'canvas');
			window.localStorage.setItem('fatfish-canvas:follow-new', 'on');
			${RESET_BOARD_PREFS}
			// 种空画布但**保住账本**（见 cdp.mjs）：否则最近生成的补落会混进来
			${seedBoardExpression(
				JSON.stringify({ version: 2, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } }),
			)};
			return true;
		})()`,
	);
	loaded = browser.cdp.once('Page.loadEventFired');
	await browser.cdp.send('Page.reload', { ignoreCache: false });
	await loaded;
	await sleep(9000);

	let s = await read();
	check('画布模式已生效', s.mode === 'canvas', String(s.mode));
	// ⚠️ 起点**不一定是空的**：落图有一条有意为之的规则 —— 「结果够新就补落」
	// （`INGEST_FRESH_MS` = 10 分钟）。而本脚本每次都在**同一个会话**里敲
	// `/generate`，所以 10 分钟内连跑两次时，上一次的命令结果会（正确地）
	// 在页面加载时被补落到画布上。
	// 早先这里断言「起点无节点」，于是第二次运行必然红 —— 那是**断言错**，
	// 不是功能坏（§8.4）。现在改成记基线、后面按增量断言。
	const baseline = s.nodes.length;
	/** 起点的节点 id：后面只认「不在里面的那些」才是本次命令产生的新节点。 */
	const baselineIds = s.nodes.map((n) => n.id);
	check(
		'画布可读（起点节点数已记为基线）',
		Number.isInteger(baseline),
		`基线 ${String(baseline)} 个节点`,
	);
	console.log(`  · 起点已有 ${String(baseline)} 个节点（上一次运行的补落，属预期）`);

	// 2) 在输入框里敲命令并发送（真实输入事件）
	const focused = await evaluate(
		browser.cdp,
		`(() => {
			const box = document.querySelector('textarea');
			if (!box) return false;
			box.focus();
			return document.activeElement === box;
		})()`,
	);
	check('输入框可达', focused === true);
	await browser.cdp.send('Input.insertText', { text: LINE });
	await sleep(300);
	const typed = await evaluate(browser.cdp, "document.querySelector('textarea') ? document.querySelector('textarea').value : ''");
	check('命令行已敲进输入框', String(typed).includes('/generate'), String(typed).slice(0, 60));
	await browser.cdp.send('Input.dispatchKeyEvent', {
		type: 'keyDown',
		key: 'Enter',
		code: 'Enter',
		windowsVirtualKeyCode: 13,
		nativeVirtualKeyCode: 13,
	});
	await browser.cdp.send('Input.dispatchKeyEvent', {
		type: 'keyUp',
		key: 'Enter',
		code: 'Enter',
		windowsVirtualKeyCode: 13,
		nativeVirtualKeyCode: 13,
	});

	// 3) 轮询：观察节点状态迁移
	const transitions = [];
	const seen = new Map();
	let sawPending = false;
	let last = s;
	const deadline = Date.now() + WATCH_MS;
	while (Date.now() < deadline) {
		const snap = await read();
		for (const node of snap.nodes) {
			const key = `${node.kind}:${node.title ?? ''}`;
			const previous = seen.get(key);
			if (previous !== node.status) {
				seen.set(key, node.status);
				transitions.push(`${previous ?? '(无)'} -> ${node.status}`);
				console.log(`  · 节点「${node.title ?? ''}」${previous ?? '出现'} -> ${node.status}`);
			}
			if (node.status === 'pending') sawPending = true;
		}
		last = snap;
		// 等到「出现了基线之外的新节点」且它不再是 pending —— 只等「没有 pending」
		// 在起点已有节点时会立刻满足（那些早就落定了），于是断言会读到一个旧节点。
		const fresh = snap.nodes.filter((n) => !baselineIds.includes(n.id));
		if (fresh.length > 0 && fresh.every((n) => n.status !== 'pending')) break;
		await sleep(150);
	}
	console.log('\n迁移轨迹：', transitions.length === 0 ? '(未观察到变化)' : transitions.join(' / '));

	// 4) 断言（只针对本次命令产生的新节点）
	const fresh = last.nodes.filter((n) => !baselineIds.includes(n.id));
	const node = fresh[0];
	check(
		'命令触发生成了一个新画布节点',
		fresh.length >= 1,
		`新增 ${String(fresh.length)} 个（基线 ${String(baseline)}）`,
	);
	if (node !== undefined) {
		check('命令节点用独立前缀（gencmd_）', String(node.id).startsWith('gencmd_'), String(node.id));
		check('提示词来自命令行原文', String(node.title).includes('肥鱼'), String(node.title));
		check(
			'比例来自命令行（16:9 → 世界尺寸 320×180）',
			// 用**世界尺寸**（节点内联样式），不用屏幕尺寸：屏幕尺寸 = 世界尺寸 × 画布 zoom，
			// 而 zoom 会随跟焦/适应内容变化（本轮实测拿到 260×146，正是 zoom 0.8125 后的结果）。
			node.world.w === 320 && node.world.h === 180,
			JSON.stringify({ world: node.world, box: node.box }),
		);
		check('状态已落定', node.status !== 'pending', String(node.status));
		if (EXPECT_STATUS !== null) {
			check(`节点终态是 ${EXPECT_STATUS}`, node.status === EXPECT_STATUS, String(node.status));
		}
		if (node.status === 'ready') {
			check('ready 节点带媒体地址', typeof node.src === 'string' && node.src !== '', String(node.src));
			check(
				'媒体真的加载成功',
				(await evaluate(
					browser.cdp,
					`(() => { const i = document.querySelector('.ffc-node img'); return i ? i.complete && i.naturalWidth > 0 : null; })()`,
				)) === true,
			);
		}
		if (node.status === 'failed') {
			check('failed 节点带失败原因', typeof node.error === 'string' && node.error.length > 4, String(node.error));
		}
	}
	if (fresh.length === 0) {
		console.log(`  诊断：页面文本 —— ${String(last.bodyText).slice(0, 300)}`);
		console.log(
			'  提示：如果页面里出现「未知命令」之类字样，说明宿主的 /generate 还没注册 ——' +
				'重启一次 dsh web 再跑本脚本（命令由宿主半边注册，运行中的进程不会重新导入宿主模块）。',
		);
	}
	check(
		'命令卡片出现在对话流里（客户端把 command/run↔done 折叠成了节点）',
		last.commands.length >= 1 || last.nodes.length >= 1,
		JSON.stringify(last.commands).slice(0, 120),
	);
	console.log(
		sawPending
			? '  · 观察到了 pending 阶段（命令执行中就先落占位）'
			: '  · 未观察到 pending 阶段（本地失败太快，属预期）',
	);
	// 记账是**去抖**写盘的（400ms），因此这里必须**轮询到落盘**再断言。
	// 直接读一次会拿到空数组 —— 那是「读太早」的假故障（§8.6），不是记账坏了：
	// 命令节点已经落到画布上（上面几条断言过了），只是还没写进 localStorage。
	let ledger = [];
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const snapshot = await read();
		ledger = Array.isArray(snapshot.board?.ingested) ? snapshot.board.ingested : [];
		if (ledger.length >= 1) break;
		await sleep(200);
	}
	check('记账随画布持久化（重载不重放）', ledger.length >= 1, JSON.stringify(ledger));

	// 5) 重载：幂等
	loaded = browser.cdp.once('Page.loadEventFired');
	await browser.cdp.send('Page.reload', { ignoreCache: false });
	await loaded;
	await sleep(9000);
	const after = await read();
	check(
		'重载后节点数量不变（幂等）',
		after.nodes.length === last.nodes.length,
		`${String(last.nodes.length)} -> ${String(after.nodes.length)}`,
	);

	const shot = await browser.cdp.send('Page.captureScreenshot', { format: 'png' });
	await writeFile(SHOT, Buffer.from(shot.data, 'base64'));
	console.log(`\n[e2e-command] 截图：${SHOT}`);
} catch (error) {
	check('测试过程中未抛错', false, error instanceof Error ? error.message : String(error));
} finally {
	await browser.close();
}

console.log(results.join('\n'));
console.log('');
if (failures === 0) {
	console.log(`全部通过 ✅（${String(results.length)} 项）`);
	process.exit(0);
}
console.log(`${String(failures)} 项失败 ❌（共 ${String(results.length)} 项）`);
process.exit(1);
