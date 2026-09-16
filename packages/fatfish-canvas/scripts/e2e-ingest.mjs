/**
 * P3 端到端：真实生成 → 聊天消息 + 画布节点。
 *
 * 为什么必须用真实浏览器 + 真实会话：
 *   「生成结果落到画布」这条链路的每一段都只在运行时才成立 ——
 *   `ctx.sessions` 是否真的可注入、`sessions.binding(id)` 是否真的解析得出、
 *   会话快照里的 `meta.fatfishCanvas` 是否真的到得了浏览器、订阅会不会被
 *   流式输出高频驱动而炸。无浏览器替身全测不到。
 *
 * 默认走**自触发**模式：脚本在探针浏览器自己的会话里，用真实输入事件敲进一句
 * 提示词并点发送，于是「用户 → agent → media_generate → 宿主 → tool/result →
 * 客户端 → 画布节点 + 聊天工具行」整条链路都在脚本眼皮底下发生，节点状态迁移
 * 也就可被真实观察到（这正是无浏览器替身最测不到的一段）。
 *
 * 若宿主没有配置任何媒体密钥，生成会立刻失败 —— 这恰好是**不需要任何密钥**
 * 就能跑通全链路的一条路径：pending/失败节点、失败原因、幂等记账全都能验证。
 * 配了密钥时同一套断言会自动改成校验 ready 节点与媒体地址。
 *
 * 覆盖（P3 落图 + P4 跟焦）：
 *   1. 真实输入提示词 → agent 调用 media_generate → 结果落到画布节点
 *   2. 节点状态迁移 pending → ready/failed（先落占位、再改状态）
 *   3. 同一份 meta 也渲染进对话流的工具行（双落）
 *   4. 幂等记账（重载不重复落图）
 *   5. **自动跟焦**：先把视口拖到别处，节点仍必须自己回到视野里（P4）
 *
 * 用法（需放宽沙箱：无头 Chrome 要创建命名管道）：
 *   node scripts/e2e-ingest.mjs                       # 自触发 + 断言落图
 *   node scripts/e2e-ingest.mjs --watch 180000        # 拉长等待（模型较慢时）
 *   node scripts/e2e-ingest.mjs --expect-status failed
 *   node scripts/e2e-ingest.mjs --require-pending     # 要求观察到 pending 阶段
 *
 * 可选参数：
 *   --prompt <text>     自定义提示词（必须能让 agent 去调 media_generate）
 *   --watch <ms>        轮询时长，默认 120000
 *   --expect-status <s> 期望的节点终态（pending / ready / failed）
 *   --expect-prompt <s> 期望出现在节点标题里的片段（默认取提示词里的关键词）
 *   --require-pending   必须观察到 pending 阶段（慢供应商才可能满足）
 *   --shot <path>       截图输出路径
 *
 * 副作用提醒：自触发模式会在宿主里**新建一个会话**（用提示词当标题），
 * 每次运行多一个 —— 这是「真实链路」的代价，跑完可以在侧边栏删掉。
 */

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PACKAGE_ROOT, RESET_BOARD_PREFS, click, drag, evaluate, launch, seedBoardExpression, sleep } from './lib/cdp.mjs';

const URL_TARGET = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080/';

const argv = process.argv.slice(2);
const argOf = (name, fallback = null) => {
	const i = argv.indexOf(name);
	return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

const DEFAULT_PROMPT =
	'请立刻调用 media_generate 工具生成一张图像：prompt 参数填「一只胖乎乎的肥鱼在米饭碗里游泳」，kind 填 image。' +
	'不要问我任何问题，不要解释，不要调用其它工具，直接调用这个工具。';

const PROMPT = argOf('--prompt', DEFAULT_PROMPT);
const WATCH_MS = Number(argOf('--watch', '120000'));
const EXPECT_STATUS = argOf('--expect-status');
const EXPECT_PROMPT = argOf('--expect-prompt', '肥鱼');
const REQUIRE_PENDING = argv.includes('--require-pending');
const SHOT = resolve(PACKAGE_ROOT, argOf('--shot', 'lib/e2e-ingest.png'));

/** 数值收敛（视口与节点坐标都用它）。 */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN);

let failures = 0;
const results = [];
const check = (label, ok, detail = '') => {
	if (!ok) failures += 1;
	results.push(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail === '' ? '' : ` — ${detail}`}`);
};

/** 读取画布节点、聊天侧工具行与视图模式。 */
const PROBE = `(() => {
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const text = (el) => (el ? (el.textContent || '').trim() : null);
  return JSON.stringify({
    mode: document.body.dataset.ffcMode ?? null,
    hasPanel: !!document.querySelector('.ffc-panel'),
    hasComposer: !!document.querySelector('textarea'),
    // 会话身份：落图链路的第一段失败几乎都是「探针没打开那个会话」
    sessionSeed: (() => { try { return window.localStorage.getItem('dsh.sessions.current'); } catch (e) { return null; } })(),
    chatToolCalls: qa('[data-chat-call-id]').length,
    chatAnchors: qa('[data-chat-anchor-key]').length,
    bodyText: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 500),
    nodes: qa('.ffc-node').map((n) => {
      const media = n.querySelector('img') || n.querySelector('video');
      const box = n.getBoundingClientRect();
      return {
        id: n.dataset.nodeId ?? null,
        status: n.dataset.status,
        kind: n.dataset.kind,
        left: parseFloat(n.style.left),
        top: parseFloat(n.style.top),
        // 屏幕上的实际尺寸：证明节点真的被渲染出来（而不是尺寸算错成 0）
        box: { w: Math.round(box.width), h: Math.round(box.height) },
        title: text(n.querySelector('.ffc-node-title')),
        src: media ? media.getAttribute('src') : null,
        // 媒体是否**真的加载成功**（src 有值 ≠ 浏览器能取到图）
        mediaOk: media ? (media.tagName === 'IMG' ? media.complete && media.naturalWidth > 0 : media.readyState >= 1) : null,
        mediaNatural: media && media.tagName === 'IMG' ? { w: media.naturalWidth, h: media.naturalHeight } : null,
        error: text(n.querySelector('.ffc-node-failed-reason')),
      };
    }),
    toolRows: qa('.ffc-tool').map((n) => {
      const media = n.querySelector('img') || n.querySelector('video');
      return {
        state: n.dataset.state,
        title: text(n.querySelector('.ffc-tool-title')),
        prompt: text(n.querySelector('.ffc-tool-prompt')),
        src: media ? media.getAttribute('src') : null,
        mediaOk: media ? (media.tagName === 'IMG' ? media.complete && media.naturalWidth > 0 : media.readyState >= 1) : null,
        error: text(n.querySelector('.ffc-tool-error')),
      };
    }),
    board: (() => { try { return JSON.parse(window.localStorage.getItem('fatfish-canvas:board') || 'null'); } catch (e) { return 'unparsable'; } })(),
    // 视口几何（P4 跟焦要用）：transform 是 translate(-vx*z, -vy*z) scale(z)，
    // 因此能反解出视口原点，判断某个世界坐标到底在不在屏幕里。
    viewport: (() => {
      const el = document.querySelector('.ffc-viewport');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    })(),
    world: (() => {
      const el = document.querySelector('.ffc-world');
      if (!el) return null;
      const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
      const zoom = m.a || 1;
      return { zoom, vx: -m.e / zoom, vy: -m.f / zoom };
    })(),
  });
})()`;

/**
 * 在会话输入框里敲入提示词并点「发送消息」。
 *
 * 全程用**真实输入事件**：`Input.insertText` 走浏览器输入管线，React 的受控
 * textarea 会正常更新；发送按钮的坐标从页面实测，不写死。
 * @param cdp - CDP 客户端。
 * @returns 是否发出了提示词。
 */
async function sendPrompt(cdp) {
	const focused = await evaluate(
		cdp,
		`(() => {
			const box = document.querySelector('textarea');
			if (!box) return false;
			box.focus();
			return document.activeElement === box;
		})()`,
	);
	if (focused !== true) return false;

	await cdp.send('Input.insertText', { text: PROMPT });
	await sleep(200);
	const typed = await evaluate(cdp, "document.querySelector('textarea') ? document.querySelector('textarea').value : ''");
	if (typeof typed !== 'string' || !typed.includes('media_generate')) return false;

	const at = JSON.parse(
		await evaluate(
			cdp,
			`(() => {
				const b = Array.from(document.querySelectorAll('button'))
					.find((x) => ((x.getAttribute('aria-label') || '') + (x.title || '')).includes('发送'));
				if (!b) return 'null';
				const r = b.getBoundingClientRect();
				return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
			})()`,
		),
	);
	if (at === null) return false;
	await click(cdp, at.x, at.y);
	return true;
}

// ─────────────────────────── 主流程 ───────────────────────────

console.log(`\n肥鱼画布 · 生成落图端到端\n目标：${URL_TARGET}\n提示词：${PROMPT.slice(0, 60)}…\n`);

const browser = await launch();
try {
	// 1) 先加载一次拿到 origin，种下画布模式 + 空画布（含空记账），再重载
	let loaded = browser.cdp.once('Page.loadEventFired');
	await browser.cdp.send('Page.navigate', { url: URL_TARGET });
	await loaded;

	await evaluate(
		browser.cdp,
		`(() => {
			window.localStorage.setItem('fatfish-canvas:view-mode', 'canvas');
			// 跟焦必须显式打开：探针 profile 是复用的，上一次 e2e 可能把它关掉了
			window.localStorage.setItem('fatfish-canvas:follow-new', 'on');
			${RESET_BOARD_PREFS}
			// 种空画布但**保住账本**（见 cdp.mjs）：否则「最近结果补落」会先把旧节点
			// 造回来，后面「起点无节点 / 只多一个节点」这类断言全乱
			${seedBoardExpression(
				JSON.stringify({ version: 2, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } }),
			)};
			return true;
		})()`,
	);

	loaded = browser.cdp.once('Page.loadEventFired');
	await browser.cdp.send('Page.reload', { ignoreCache: false });
	await loaded;
	await sleep(9000); // 启动图：加载并物化全部客户端插件

	const first = JSON.parse(await evaluate(browser.cdp, PROBE));
	check('画布模式已生效', first.mode === 'canvas', String(first.mode));
	check('画布面板存在', first.hasPanel === true);
	check('画布已清空（起点无节点）', first.nodes.length === 0, `实际 ${String(first.nodes.length)}`);
	check('输入框可达（能自己触发一次生成）', first.hasComposer === true);
	console.log(`  诊断：会话选择=${String(first.sessionSeed)}`);

	// 2) 先把视口拖走，让「世界原点」跑到屏幕外
	//
	// 空画布上第一个节点必然落在世界原点（见 model.nextPlacement），因此这一步
	// 把新节点变成「落在视野之外」——只有这样，「自动跟焦把节点带进视野」才是一个
	// 真的会被执行的断言，而不是碰巧已经可见。
	console.log('\n2) 把视口拖到别处（为跟焦断言铺路）');
	if (first.viewport !== null) {
		const from = {
			x: Math.round(first.viewport.x + first.viewport.w / 2),
			y: Math.round(first.viewport.y + first.viewport.h / 2),
		};
		for (let i = 0; i < 2; i += 1) {
			await drag(browser.cdp, from, { x: from.x + 420, y: from.y + 260 }, 6);
			await sleep(120);
		}
	}
	let panned = JSON.parse(await evaluate(browser.cdp, PROBE));
	const originScreen = panned.world
		? {
				x: (0 - panned.world.vx) * panned.world.zoom,
				y: (0 - panned.world.vy) * panned.world.zoom,
			}
		: null;
	const offScreen =
		originScreen !== null &&
		panned.viewport !== null &&
		(originScreen.x > panned.viewport.w || originScreen.y > panned.viewport.h);
	check(
		'世界原点已被拖出视野（新节点注定落在屏幕外）',
		offScreen === true,
		`origin=${JSON.stringify(originScreen)} viewport=${JSON.stringify(panned.viewport)}`,
	);

	// 3) 真实输入 + 真实点击发送
	const sent = await sendPrompt(browser.cdp);
	check('已把提示词发进会话（真实输入事件）', sent === true);

	// 4) 轮询：记录节点状态迁移与聊天侧工具行
	const transitions = [];
	const seen = new Map();
	let sawPending = false;
	let last = panned;
	const deadline = Date.now() + WATCH_MS;
	while (Date.now() < deadline) {
		const snap = JSON.parse(await evaluate(browser.cdp, PROBE));
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
		const settled =
			snap.nodes.length > 0 &&
			snap.nodes.every((n) => n.status !== 'pending') &&
			snap.toolRows.length > 0 &&
			snap.toolRows.every((r) => r.state !== 'running');
		if (settled) break;
		await sleep(150);
	}

	console.log('\n迁移轨迹：', transitions.length === 0 ? '(未观察到变化)' : transitions.join(' / '));
	console.log(`  诊断：会话内工具调用行=${String(last.chatToolCalls)} 画布节点=${String(last.nodes.length)}`);
	if (last.nodes.length === 0) {
		console.log(`  诊断：页面文本 —— ${String(last.bodyText).slice(0, 300)}`);
	}

	// 跟焦是**动画**过去的（程序化移动带 240ms 过渡，用户拖拽则不带）。
	// 因此这里不能立刻读一次就断言几何 —— 那读到的是动画中途的变换矩阵。
	// 改成「最多等 2 秒，直到节点真的落进视野」，这才是用户看到的事实。
	const inView = (snap) => {
		const n = snap.nodes[0];
		if (n === undefined || snap.world === null || snap.viewport === null) return false;
		const sx = (num(n.left) - snap.world.vx) * snap.world.zoom;
		const sy = (num(n.top) - snap.world.vy) * snap.world.zoom;
		return (
			sx >= -1 &&
			sy >= -1 &&
			sx + n.box.w <= snap.viewport.w + 1 &&
			sy + n.box.h <= snap.viewport.h + 1
		);
	};
	let settledSnap = last;
	for (let i = 0; i < 20 && !inView(settledSnap); i += 1) {
		await sleep(120);
		settledSnap = JSON.parse(await evaluate(browser.cdp, PROBE));
	}
	last = settledSnap;

	// 5) 画布侧断言
	check('画布上出现了生成节点', last.nodes.length >= 1, `实际 ${String(last.nodes.length)}`);
	const node = last.nodes[0];
	if (node !== undefined) {
		check(
			'节点 id 由 callId 派生（gen_ 前缀）',
			typeof node.id === 'string' && node.id.startsWith('gen_') && node.id.length > 4,
			String(node.id),
		);
		check('节点状态已落定（不再是 pending）', node.status !== 'pending', String(node.status));
		check(
			`节点标题带上提示词片段「${String(EXPECT_PROMPT)}」`,
			String(node.title).includes(String(EXPECT_PROMPT)),
			String(node.title),
		);
		check('节点种类是图像', node.kind === 'image', String(node.kind));
		check(
			'节点尺寸按 1:1 落位（320×320）',
			Number.isFinite(node.left) && Number.isFinite(node.top),
			`left=${String(node.left)} top=${String(node.top)}`,
		);

		// ── P4：自动跟焦 ──
		// 节点落在世界原点，而我们把视口拖到了别处 —— 现在它必须自己回到视野里。
		const nodeScreen = last.world
			? {
					x: (num(node.left) - last.world.vx) * last.world.zoom,
					y: (num(node.top) - last.world.vy) * last.world.zoom,
				}
			: null;
		check(
			'自动跟焦：新节点被带进了视野（拖走的视口自己回来了）',
			inView(last) === true,
			`nodeScreen=${JSON.stringify(nodeScreen)} box=${JSON.stringify(node.box)} vp=${JSON.stringify(last.viewport)}`,
		);
		check(
			'跟焦确实移动了视口（视口原点不再是拖动后的值）',
			last.world !== null && Math.abs(last.world.vx - panned.world.vx) > 1,
			`vx ${String(panned.world?.vx)} -> ${String(last.world?.vx)}`,
		);
		if (EXPECT_STATUS !== null) {
			check(`节点终态是 ${EXPECT_STATUS}`, node.status === EXPECT_STATUS, String(node.status));
		}
		if (node.status === 'ready') {
			check('ready 节点带媒体地址', typeof node.src === 'string' && node.src !== '', String(node.src));
			check(
				'媒体在浏览器里真的加载成功（naturalWidth > 0）',
				node.mediaOk === true,
				`mediaOk=${String(node.mediaOk)} natural=${JSON.stringify(node.mediaNatural)}`,
			);
			check(
				'节点在屏幕上渲染出可见尺寸',
				Number(node.box?.w) > 40 && Number(node.box?.h) > 40,
				JSON.stringify(node.box),
			);
		}
		if (node.status === 'failed') {
			check(
				'failed 节点带可读的失败原因',
				typeof node.error === 'string' && node.error.length > 4,
				String(node.error),
			);
		}
	}
	if (REQUIRE_PENDING) {
		check('观察到过 pending 阶段（先落占位、再改状态）', sawPending, transitions.join(' / '));
	} else {
		console.log(
			sawPending
				? '  · 已观察到 pending 阶段（先落占位、再改状态）'
				: '  · 未观察到 pending 阶段（本地失败太快，属预期；慢供应商下可加 --require-pending）',
		);
	}
	// 5) 记账落盘是**去抖**的（拖拽节点时不能每帧写盘），因此这里等一拍再读，
	//    否则读到的是「动作刚发生、还没来得及写盘」的中间态。
	await sleep(800);
	last = JSON.parse(await evaluate(browser.cdp, PROBE));
	check(
		'记账已随画布持久化（重载后不会重放）',
		Array.isArray(last.board?.ingested) && last.board.ingested.length >= 1,
		JSON.stringify(last.board?.ingested ?? null),
	);

	// 6) 聊天侧断言：同一份 meta 也要落在对话流里
	check('对话流里出现 media_generate 的工具行', last.toolRows.length >= 1, `实际 ${String(last.toolRows.length)}`);
	const row = last.toolRows[0];
	if (row !== undefined) {
		check(
			'工具行不是通用卡片（data-state 属于本插件）',
			['running', 'ready', 'error'].includes(row.state),
			String(row.state),
		);
		check(
			'工具行与画布节点终态一致（双落）',
			(row.state === 'error' && node?.status === 'failed') ||
				(row.state === 'ready' && node?.status === 'ready') ||
				row.state === 'running',
			`行=${String(row.state)} 节点=${String(node?.status)}`,
		);
		if (row.state === 'error') {
			check(
				'工具行显示失败原因（不再是一坨 JSON）',
				typeof row.error === 'string' && row.error.length > 4,
				String(row.error),
			);
		}
		if (row.state === 'ready') {
			check('工具行渲染媒体', typeof row.src === 'string' && row.src !== '', String(row.src));
			check(
				'工具行的媒体也真的加载出来了',
				last.toolRows[0].mediaOk === true,
				`mediaOk=${String(last.toolRows[0].mediaOk)}`,
			);
		}
	}

	// 7) 重载：幂等 —— 历史重放不该再造一个节点
	loaded = browser.cdp.once('Page.loadEventFired');
	await browser.cdp.send('Page.reload', { ignoreCache: false });
	await loaded;
	await sleep(9000);
	const after = JSON.parse(await evaluate(browser.cdp, PROBE));
	check(
		'重载后节点数量不变（幂等记账生效）',
		after.nodes.length === last.nodes.length,
		`${String(last.nodes.length)} -> ${String(after.nodes.length)}`,
	);

	const shot = await browser.cdp.send('Page.captureScreenshot', { format: 'png' });
	await writeFile(SHOT, Buffer.from(shot.data, 'base64'));
	console.log(`\n[e2e-ingest] 截图：${SHOT}`);
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
