/**
 * 真机 · **真生成**端到端：P19 串联 / P20 单节点与复制 / P22 本地图当参考图。
 *
 * 为什么单独一个脚本：这三件事的判据全在「宿主真跑了一次生成」之后才存在 ——
 * 离线测试只能验命令行组装（`planOf`），而「上游出图后才发下游」「本地图的字节
 * 真的进了参考图通路」必须有真的产物。因此：
 *
 *   ⚠️ **它会真的调模型出图**：慢（每次十几秒起）、花额度、且需要宿主里配好可用
 *   的图像模型。所以它**不在** `npm run check` 里，也**不在**默认 e2e 集合里 ——
 *   只在手测时手动跑：
 *
 *     $env:DSH_WEB_URL = (Get-Content packages/fatfish-canvas/lib/web-url.txt -Raw).Trim()
 *     node scripts/e2e-realgen.mjs
 *
 * 需要 danger-full-access（无头 Chrome 要命名管道）。报告与截图落在 `lib/`。
 *
 * 覆盖：
 *   1. **P19**：`txt→g1`、`txt2→g2`、`g1→g2` 三个节点里 g3 刻意不连提示词 →
 *      点顶栏「运行」应当**串行**跑 g1、g2（g2 在 g1 出图之后才 pending），
 *      跳过 g3，读数「已运行 2 个，跳过 1 个」；且产物尺寸按节点上的 ratio（1:1 → 320×320）。
 *   2. **P20**：右键 g1「运行此节点」（不重跑上游）→ 再次出图；「复制为新节点」→
 *      副本与原节点的 prompt / ratio / genKind 一致。
 *   3. **P22**：合成一次**真实本地 PNG** 的 drop → 节点必须拿到宿主句柄（`ref`）→
 *      连到 g3（内联图没有句柄时连线会被拒，所以「连上了」本身就是句柄存在的证据）→
 *      连上文字节点 → 「运行此节点」→ 真的用这张图当参考图出了图。
 */

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
	PACKAGE_ROOT,
	RESET_BOARD_PREFS,
	click,
	evaluate,
	launch,
	seedBoardExpression,
	sleep,
} from './lib/cdp.mjs';

const URL_TARGET = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080/';
const SHOT = (name) => resolve(PACKAGE_ROOT, `lib/e2e-realgen-${name}.png`);
const REPORT = resolve(PACKAGE_ROOT, 'lib/e2e-realgen-report.txt');

/** 一次真实生成要多久没人能保证：给足余量；超时算失败但要留住现场。 */
const GEN_TIMEOUT_MS = Number(process.env.REALGEN_TIMEOUT_MS ?? '240000');

/**
 * 调试开关：跳过 P19 那两次真实生成（每次十几到几十秒、且花额度）。
 * 只调后面的阶段时用它；**验收必须跑完整的**。
 */
const SKIP_P19 = process.env.REALGEN_SKIP_P19 === '1';

let failures = 0;
const results = [];
const check = (label, ok, detail = '') => {
	if (!ok) failures += 1;
	results.push(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail === '' ? '' : ` — ${detail}`}`);
};
const log = (line) => {
	results.push(line);
};

/** 页面事实（含 localStorage 里那份画布 —— 它是判据的真源）。 */
const PROBE = `(() => {
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const center = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  };
  let board = null;
  try { board = JSON.parse(window.localStorage.getItem('fatfish-canvas:board') || 'null'); } catch (e) { board = null; }
  const run = q('.ffc-toolbar button[aria-label="运行工作流"]');
  const note = q('.ffc-toolbar [role="status"]');
  const menu = q('.ffc-node-menu');
  const notice = q('.ffc-sent-notice');
  return JSON.stringify({
    mode: document.body.dataset.ffcMode ?? null,
    run: run ? {
      disabled: run.disabled === true,
      running: run.dataset.running === 'true',
      title: run.getAttribute('title'),
      text: (run.textContent || '').trim(),
      center: center(run),
    } : null,
    note: note ? (note.textContent || '').trim() : '',
    /** 画布底部那条提示（pushNotice）—— 「点不动又不说为什么」的答案都在这里。 */
    notice: notice ? (notice.textContent || '').trim() : '',
    drafts: qa('.ffc-link-draft').length,
    nodes: qa('.ffc-node').map((n) => {
      const img = n.querySelector('img.ffc-node-el');
      return {
        id: n.dataset.nodeId,
        kind: n.dataset.kind,
        center: center(n),
        box: rect(n),
        world: { w: Math.round(parseFloat(n.style.width) || 0), h: Math.round(parseFloat(n.style.height) || 0) },
        imgLoaded: img ? img.naturalWidth > 0 : false,
        natural: img ? { w: img.naturalWidth, h: img.naturalHeight } : null,
        /** 界面上的真实状态（落盘是去抖的，**存储会落后**，见 statusOf 的注释）。 */
        pending: n.querySelector('.ffc-node-pending') !== null,
        failed: n.querySelector('.ffc-node-failed') !== null,
        domSrc: img ? img.getAttribute('src') : null,
        label: (n.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
        ports: Array.from(n.querySelectorAll('.ffc-port')).map((p) => ({
          side: p.dataset.ffcPort,
          center: center(p),
          rect: rect(p),
          opacity: getComputedStyle(p).opacity,
          pe: getComputedStyle(p).pointerEvents,
        })),
      };
    }),
    board: board === null ? null : {
      nodes: (board.nodes || []).map((n) => ({
        id: n.id, kind: n.kind, status: n.status, src: n.src, ref: n.ref, prompt: n.prompt,
        title: n.title, genKind: n.genKind, ratio: n.ratio, error: n.error, w: n.w, h: n.h,
        /** 有没有自带工作流文档（只报真假：那是几 KB 的字符串）。 */
        hasWorkflow: typeof n.workflow === 'string' && n.workflow !== '',
      })),
      links: (board.links || []).map((l) => ({ from: l.from, to: l.to })),
    },
    /** 当前选中的节点 —— 右键菜单操作的**就是**它，菜单读错节点时靠这个看出来。 */
    selectedIds: qa('.ffc-node').filter((n) => n.dataset.selected === 'true').map((n) => n.dataset.nodeId),
    menu: menu ? {
      label: menu.getAttribute('aria-label'),
      rect: rect(menu),
      items: qa('.ffc-menu-item')
        .filter((b) => menu.contains(b))
        .map((b) => {
          const c = center(b);
          const under = c === null ? null : document.elementFromPoint(c.x, c.y);
          const cls = under && under.className
            ? (under.className.baseVal !== undefined ? under.className.baseVal : under.className)
            : '';
          return {
            label: (b.textContent || '').trim(),
            disabled: b.disabled === true,
            center: c,
            under: under ? under.tagName.toLowerCase() + (cls ? '.' + String(cls).trim().split(/\\s+/)[0] : '') : null,
            hits: under !== null && (under === b || b.contains(under)),
          };
        }),
    } : null,
  });
})()`;

/**
 * 种子：`txt1→g1`，`txt2→g2`，`g1→g2`；g3 与 txt3 **都不连**。
 *
 * 为什么 g3 要留在这里：① 它给 P19 一个「跳过」的样本（没有连入提示词）；
 * ② P22 拿它当「用本地图当参考图」的目标，连线留到那时用真实拖拽建立。
 */
const SEED = JSON.stringify({
	version: 2,
	nodes: [
		{ id: 'txt1', kind: 'text', x: 0, y: 0, w: 260, h: 120, z: 1, status: 'ready', title: '一条穿西装的肥鱼', prompt: '一条穿西装的肥鱼，扁平插画', createdAt: 1 },
		{ id: 'g1', kind: 'gen', x: 360, y: 0, w: 280, h: 280, z: 2, status: 'ready', ratio: '1:1', genKind: 'image', createdAt: 2 },
		{ id: 'txt2', kind: 'text', x: 0, y: 360, w: 260, h: 120, z: 3, status: 'ready', title: '把这张图改成水彩风格', prompt: '把这张图改成水彩风格，保留构图', createdAt: 3 },
		{ id: 'g2', kind: 'gen', x: 360, y: 360, w: 280, h: 280, z: 4, status: 'ready', ratio: '1:1', genKind: 'image', createdAt: 4 },
		{ id: 'txt3', kind: 'text', x: 0, y: 720, w: 260, h: 120, z: 5, status: 'ready', title: '按这张参考图的样子来', prompt: '参照这张图的配色，画一条肥鱼', createdAt: 5 },
		{ id: 'g3', kind: 'gen', x: 360, y: 720, w: 280, h: 280, z: 6, status: 'ready', ratio: '1:1', genKind: 'image', createdAt: 6 },
	],
	links: [
		{ id: 'l1', from: 'txt1', to: 'g1', fromSide: 'e', toSide: 'w' },
		{ id: 'l2', from: 'txt2', to: 'g2', fromSide: 'e', toSide: 'w' },
		{ id: 'l3', from: 'g1', to: 'g2', fromSide: 'e', toSide: 'w' },
	],
	viewport: { x: 0, y: 0, zoom: 1 },
	ingested: [],
});

const browser = await launch();
const read = async () => JSON.parse(await evaluate(browser.cdp, PROBE));
const boardNode = (state, id) => (state.board === null ? null : (state.board.nodes.find((n) => n.id === id) ?? null));
const domNode = (state, id) => state.nodes.find((n) => n.id === id) ?? null;
const linkExists = (state, from, to) =>
	state.board !== null && state.board.links.some((l) => l.from === from && l.to === to);

/**
 * 节点「现在到底怎么样」——**以界面为准，不以 localStorage 为准**。
 *
 * 为什么：画布落盘是 400ms 去抖、而且**每次 commit 都重置计时器**
 * （`store.ts` 的 `schedulePersist`）。生成期间宿主的事件让 ingest 频繁提交，
 * 于是每一次提交都把落盘再往后推 400ms —— 存储可以长时间停在旧状态。实测：
 * 界面已经显示「生成中…」，localStorage 里还是 `ready`，于是「这一次到底跑没跑」
 * 会被判成「没跑」（第一轮就是这么假红的），而且真实生成的产物地址也读不到。
 * @param state - 一次读数。
 * @param id - 节点 id。
 * @returns 界面上的状态。
 */
function statusOf(state, id) {
	const dom = domNode(state, id);
	if (dom === null) return '(不存在)';
	if (dom.pending) return 'pending';
	if (dom.failed) return 'failed';
	if (dom.domSrc !== null && dom.domSrc !== '') return 'ready';
	return boardNode(state, id)?.status ?? '(无)';
}

/** 节点的产物地址（先看界面上那张图，再退回落盘的记录）。 */
function liveSrc(state, id) {
	const dom = domNode(state, id);
	if (dom !== null && dom.domSrc !== null && dom.domSrc !== '') return dom.domSrc;
	return boardNode(state, id)?.src ?? '';
}

/** 存一张现场截图（人眼复核用，也是我判定「质感」的唯一手段）。 */
async function shot(name) {
	const raw = await browser.cdp.send('Page.captureScreenshot', { format: 'png' });
	await writeFile(SHOT(name), Buffer.from(raw.data, 'base64'));
	log(`  · 截图：lib/e2e-realgen-${name}.png`);
}

/** 一次真实右键（菜单挂 document.body，坐标必须真实）。 */
async function rightClick(at) {
	await browser.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'right', buttons: 2, clickCount: 1 });
	await browser.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'right', buttons: 0, clickCount: 1 });
	await sleep(400);
}

/** 从某个连接点拉一条线到目标点（必须先悬停起点节点，否则连接点不接指针）。 */
async function dragLink(fromCenter, portAt, to) {
	await browser.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fromCenter.x, y: fromCenter.y, buttons: 0 });
	await sleep(300);
	await browser.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: portAt.x, y: portAt.y, button: 'left', buttons: 1, clickCount: 1 });
	for (let i = 1; i <= 8; i += 1) {
		const t = i / 8;
		await browser.cdp.send('Input.dispatchMouseEvent', {
			type: 'mouseMoved',
			x: Math.round(portAt.x + (to.x - portAt.x) * t),
			y: Math.round(portAt.y + (to.y - portAt.y) * t),
			button: 'left',
			buttons: 1,
		});
		await sleep(14);
	}
	await browser.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
	await sleep(500);
}

/** 点一次真按钮（菜单项 / 工具条按钮都走它）。 */
async function clickAt(at) {
	await click(browser.cdp, at.x, at.y);
}

/**
 * 点一次工具条上的「适应内容」。
 *
 * 为什么每次量坐标前都要它：种子里的节点按世界坐标铺得很开（y 到 1000），而画布
 * 面板只有几百像素宽/高 —— 收不进视口的节点右键会点到画布外或底部那条缩放条上
 * （第一版实测：菜单根本没弹出来）。e2e-graph 早就踩过这一条。
 */
async function fitContent() {
	const at = JSON.parse(
		await evaluate(
			browser.cdp,
			`(() => {
				const b = Array.from(document.querySelectorAll('.ffc-toolbar button')).find((x) => x.getAttribute('aria-label') === '适应内容');
				if (!b) return 'null';
				const r = b.getBoundingClientRect();
				return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
			})()`,
		),
	);
	if (at !== null) {
		await clickAt(at);
		await sleep(900);
	}
	return at;
}

/**
 * 找一个「落在某个节点身上、且没被别的节点盖住」的点。
 *
 * 为什么需要：连线松手时判据是 `nodeAt`（取 z 最大的那个节点），而拖进来的图就落在
 * g3 那块、压在它上面 —— 松手在「g3 的中心」实际命中上面那张新图，被判成
 * 「只有生成节点接受输入」。第一版实测两次连线全废，右键也开成了那张图的菜单。
 * @param id - 目标节点 id。
 * @returns 屏幕坐标点；找不到时为 null。
 */
async function freePointOn(id) {
	return JSON.parse(
		await evaluate(
			browser.cdp,
			`(() => {
				const node = document.querySelector('.ffc-node[data-node-id="' + ${JSON.stringify(id)} + '"]');
				const vp = document.querySelector('.ffc-viewport');
				if (!node || !vp) return 'null';
				const r = node.getBoundingClientRect();
				const v = vp.getBoundingClientRect();
				const candidates = [
					[r.x + r.width / 2, r.y + r.height / 2],
					[r.x + r.width * 0.75, r.y + r.height * 0.25],
					[r.x + r.width * 0.25, r.y + r.height * 0.75],
					[r.x + r.width * 0.8, r.y + r.height * 0.5],
					[r.x + r.width * 0.5, r.y + r.height * 0.85],
				];
				for (const c of candidates) {
					const x = Math.round(c[0]);
					const y = Math.round(c[1]);
					if (x < v.x + 4 || x > v.right - 4 || y < v.y + 4 || y > v.bottom - 4) continue;
					const under = document.elementFromPoint(x, y);
					if (under !== null && (under === node || node.contains(under))) return JSON.stringify({ x, y });
				}
				return 'null';
			})()`,
		),
	);
}

/**
 * 等画布安静下来（种完画布、开始点之前调一次）。
 *
 * 为什么必须等：上一次运行留下的**真实命令结果**在 10 分钟内算「新鲜」，页面加载时
 * 会被补落/回填一次 —— 如果它带着 `--wf <旧节点 id>`，就会把**同名种子节点**重新补成
 * ready + 旧产物。那一下发生在加载后的头几秒，正好撞上第一件事：实测症状是「刚点的
 * 运行立刻被改回旧状态」，pending 根本量不到（看着像功能坏，其实是上一次的余波）。
 * @param maxMs - 最长等多久。
 * @returns 安静之后的读数。
 */
async function waitBoardQuiet(maxMs = 20000) {
	const keyOf = (state) => JSON.stringify((state.board?.nodes ?? []).map((n) => [n.id, n.status, n.src]));
	const deadline = Date.now() + maxMs;
	let prev = null;
	for (;;) {
		const state = await read();
		const now = keyOf(state);
		if (now === prev) return state;
		prev = now;
		if (Date.now() > deadline) return state;
		await sleep(1200);
	}
}

/**
 * 等节点上的图**真的加载完**（`naturalWidth > 0`）。
 *
 * 为什么要等：状态变 ready 只说明拿到了地址，浏览器还要去取字节；紧接着读会拿到
 * `naturalWidth === 0`（实测就差这几百毫秒到几秒，供应商在境外）。
 * @param ids - 要等的节点。
 * @param timeoutMs - 上限。
 * @returns 都加载完（或超时）之后的读数。
 */
async function waitImagesLoaded(ids, timeoutMs = 20000) {
	const deadline = Date.now() + timeoutMs;
	let state = await read();
	for (;;) {
		const missing = ids.filter((id) => (domNode(state, id)?.imgLoaded ?? false) !== true);
		if (missing.length === 0 || Date.now() > deadline) return state;
		await sleep(600);
		state = await read();
	}
}

/**
 * P19 的判据（抽出来是为了能用 `REALGEN_SKIP_P19` 跳过那两次生成而不跳代码路径）。
 * @param state - 运行结束后的读数。
 * @param run - `watchRun` 的结果。
 * @param g3Before - 开跑之前 g3 的产物地址（判「这一次没碰它」的基线）。
 */
function checkP19(state, run, g3Before) {
	for (const id of ['g1', 'g2']) {
		const src = liveSrc(state, id);
		check(
			`${id} 出图了（ready + src）`,
			statusOf(state, id) === 'ready' && src !== '',
			JSON.stringify({ 界面: statusOf(state, id), 存储: boardNode(state, id)?.status, src: src.slice(0, 60), error: boardNode(state, id)?.error }),
		);
		const dom = domNode(state, id);
		check(`${id} 的图真的加载了（naturalWidth > 0）`, dom !== null && dom.imgLoaded, JSON.stringify({ box: dom?.box }));
	}
	const g1Ready = atOf(run.history, 'g1', 'ready');
	const g2Pending = atOf(run.history, 'g2', 'pending');
	check(
		'P19 串行顺序：g1 出图（ready）在 g2 开始生成（pending）之前',
		g1Ready !== null && g2Pending !== null && g1Ready <= g2Pending,
		`g1 ready@${String(g1Ready)}ms, g2 pending@${String(g2Pending)}ms`,
	);
	check(
		'P19 跳过没有提示词的 g3（读数说「已运行 2 个」+「跳过 1 个」）',
		run.note.includes('已运行 2 个') && run.note.includes('跳过 1 个'),
		run.note,
	);
	// g3 的判据只问「**这一次**运行碰没碰它」：上一次运行留下的产物/失败是加载时
	// 补落的余波，与本次无关（基线在开跑前取，见调用点）
	check(
		'g3 没被这一次运行碰过（没有 pending、产物也没变）',
		liveSrc(state, 'g3') === g3Before && atOf(run.history, 'g3', 'pending') === null,
		JSON.stringify({ 跑前: g3Before, 跑后: liveSrc(state, 'g3'), 界面: statusOf(state, 'g3') }),
	);
	// ⚠️ 这里**刻意不**断言节点被改成 320×320：`--wf` 回填只补 status / src / prompt
	// （ingest.ts），**不动节点几何** —— 节点尺寸是用户的布局，回填把它改掉才是 bug。
	// 所以「ratio 真的生效了」只能看**产物本身**：1:1 出来的图必须是正方形。
	const g1Dom = domNode(state, 'g1');
	check(
		'P19 ratio（1:1）真的传到了生成管线（产物是正方形）',
		g1Dom !== null && g1Dom.natural !== null && g1Dom.natural.w > 0 && g1Dom.natural.w === g1Dom.natural.h,
		JSON.stringify({ natural: g1Dom?.natural, ratio: boardNode(state, 'g1')?.ratio, world: g1Dom?.world }),
	);
	check(
		'回填不改节点几何（节点保持自己的 280×280，而不是被产物尺寸覆盖）',
		g1Dom !== null && g1Dom.world.w === 280 && g1Dom.world.h === 280,
		JSON.stringify({ world: g1Dom?.world }),
	);
}

/**
 * 等一次运行结束，顺便把每个节点的状态迁移按时间记下来。
 *
 * 判据用**运行按钮自己的 running 读数**（`data-running`）而不是「所有节点都不是
 * pending」：后者在「点了但没跑起来」时立刻满足，会把「什么都没发生」误判成完成。
 * @param ids - 要跟踪的生成节点。
 * @returns 终态读数、迁移轨迹、运行读数。
 */
async function watchRun(ids) {
	const history = [];
	const transitions = [];
	const last = new Map();
	const started = Date.now();
	const deadline = started + GEN_TIMEOUT_MS;
	let sawRunning = false;
	let lagged = false;
	let note = '';
	let state = await read();
	/** 记一次状态迁移（同状态不重复记）。 */
	const record = () => {
		for (const id of ids) {
			const status = statusOf(state, id);
			if (last.get(id) !== status) {
				last.set(id, status);
				history.push({ id, status, at: Date.now() - started });
				transitions.push(`${id} ${status}@${String(Date.now() - started)}ms`);
			}
			// 存储落后于界面这件事本身要留痕：它是「落盘去抖被饿住」的观测证据
			const stored = boardNode(state, id)?.status;
			if (!lagged && stored !== undefined && stored !== status) {
				lagged = true;
				transitions.push(`(存储落后：界面=${status} 存储=${stored})`);
			}
		}
	};
	/** 所有被跟踪的节点都不再是 pending。 */
	const allSettled = () => ids.every((id) => statusOf(state, id) !== 'pending');
	/** 见过 pending 吗 —— 「真的跑起来了」的证据（节点菜单那条路不会点亮工具条）。 */
	const sawPending = () => history.some((item) => item.status === 'pending');
	record();
	for (;;) {
		state = await read();
		if (state.run !== null && state.run.running) sawRunning = true;
		if (state.note !== '' && state.note !== '正在运行…') note = state.note;
		record();
		// 完成判据有两条，因为两条路的信号不一样：
		//   ① 顶栏「运行工作流」：按钮的 `data-running` 由 true 变回 false；
		//   ② 右键「运行此节点」：`runSingleNode` **不碰**工具条，只能看节点自己
		//      （见过 pending、且现在全都落定了）。第一版只认 ①，于是把一次
		//      32 秒的真实生成当成了「没跑起来」。
		if (sawRunning && state.run !== null && !state.run.running) break;
		if (sawPending() && allSettled()) break;
		// 「点了但根本没跑起来」：既没进运行态、也没见过 pending
		if (!sawRunning && !sawPending() && Date.now() - started > 15_000 && allSettled()) {
			transitions.push('(没有跑起来：既没进运行态也没见过 pending)');
			break;
		}
		if (Date.now() > deadline) {
			transitions.push('(超时)');
			break;
		}
		await sleep(400);
	}
	// 回填（`command/done` → `ingest`）比「命令结算」晚一步：running 变 false 的那一
	// 刻节点**可能还是 pending**（第一版就是这么读到中间态的）。等它落定再交出去。
	const settleDeadline = Date.now() + 30_000;
	while (!allSettled() && Date.now() < settleDeadline) {
		await sleep(400);
		state = await read();
		record();
	}
	return { state, history, transitions, note, sawRunning, sawPending: sawPending() };
}

/** 某个节点第一次到达某状态的时刻（毫秒，相对本次运行起点）；没到过则 null。 */
const atOf = (history, id, status) => {
	const hit = history.find((h) => h.id === id && h.status === status);
	return hit === undefined ? null : hit.at;
};
/** 菜单项中心。 */
const menuItem = (state, label) => (state.menu === null ? null : (state.menu.items.find((i) => i.label === label) ?? null));

let tail = '';
try {
	// ── 0. 种画布 ──
	let loaded = browser.cdp.once('Page.loadEventFired');
	await browser.cdp.send('Page.navigate', { url: URL_TARGET });
	await loaded;
	await evaluate(
		browser.cdp,
		`(() => {
			window.localStorage.setItem('fatfish-canvas:view-mode', 'canvas');
			// 跟焦会把视口挪走，之后所有屏幕坐标作废 —— 这一轮全靠坐标点目标
			window.localStorage.setItem('fatfish-canvas:follow-new', 'off');
			${RESET_BOARD_PREFS}
			return ${seedBoardExpression(SEED)};
		})()`,
	);
	loaded = browser.cdp.once('Page.loadEventFired');
	await browser.cdp.send('Page.reload', { ignoreCache: false });
	await loaded;
	await sleep(9000);

	let s = await read();
	check('画布模式已生效', s.mode === 'canvas', String(s.mode));
	check('六个种子节点都渲染出来了', s.nodes.length === 6, `实际 ${String(s.nodes.length)}`);
	check('三条种子连线都在', s.board !== null && s.board.links.length === 3, JSON.stringify(s.board?.links));
	check(
		'运行按钮存在且可用（有会话 + 有生成节点）',
		s.run !== null && !s.run.disabled,
		JSON.stringify(s.run),
	);
	// 种子铺得很开（世界 y 到 1000），而画布面板只有几百像素 ——
	// 不先收进视口，后面量到的屏幕坐标全都不成立
	await fitContent();
	await shot('0-seed');
	// 等上一次运行的余波（补落 / `--wf` 回填）落完再开始
	s = await waitBoardQuiet();
	/** P19 的判据要用的基线：开跑前 g3 的产物（上一次的余波不算在这一次头上）。 */
	const g3Before = liveSrc(s, 'g3');
	check(
		'安静之后仍是那 6 个种子节点（余波没有塞进新节点）',
		(s.board?.nodes ?? []).length === 6,
		JSON.stringify((s.board?.nodes ?? []).map((n) => `${n.id}:${n.status}${(n.src ?? '') === '' ? '' : '+图'}`)),
	);

	// ── 1. P19：串联跑工作流 ──
	console.log('1) P19 · 顶栏「运行」串行跑 g1 → g2，跳过没提示词的 g3');
	const runAt = s.run?.center ?? null;
	check('拿得到运行按钮的坐标', runAt !== null, JSON.stringify(runAt));
	if (runAt === null) throw new Error('运行按钮不可点，后面全部无法进行');
	if (SKIP_P19) {
		log('  · REALGEN_SKIP_P19=1 → 跳过 P19 的两次真实生成（调试用；验收别跳）');
	} else {
		await clickAt(runAt);
		const w1 = await watchRun(['g1', 'g2', 'g3']);
		console.log(`  · 迁移：${w1.transitions.join(' / ')}`);
		console.log(`  · 运行读数：「${w1.note}」`);
		check('观察到「运行中…」（按钮真的进了运行态）', w1.sawRunning);
		const settled1 = await waitImagesLoaded(['g1', 'g2']);
		checkP19(settled1, w1, g3Before);
		s = settled1;
		await shot('1-p19');
		tail = `P19：${w1.note}`;
	}

	// ── 2. P20：运行此节点 / 复制为新节点 ──
	console.log('\n2) P20 · 右键「运行此节点」与「复制为新节点」');
	const g1At = domNode(s, 'g1')?.center ?? null;
	await rightClick(g1At);
	s = await read();
	const runOneItem = menuItem(s, '运行此节点');
	const copyItem = menuItem(s, '复制为新节点');
	check('节点菜单里两项都在且可用', runOneItem !== null && copyItem !== null && !runOneItem.disabled && !copyItem.disabled, JSON.stringify(s.menu?.items.map((i) => `${i.label}${i.disabled ? '(禁用)' : ''}`)));
	// 菜单挂在 document.body 上、位置由触发器算出来 ——「量得到坐标」与
	// 「那个坐标上真的是这一项」是两件事，分开记
	log(`  · 菜单 label=${String(s.menu?.label)} rect=${JSON.stringify(s.menu?.rect)}`);
	for (const item of s.menu?.items ?? []) {
		log(`    - ${item.label}${item.disabled ? '(禁用)' : ''} 中心=${JSON.stringify(item.center)} 命中=${String(item.hits)} under=${String(item.under)}`);
	}
	// 菜单操作的必须是刚右键的那个节点：`selectedIds` 与它自己的字段对得上，
	// 「菜单读的是别的节点」才能被看出来（禁用项的组合就是这种错的指纹）
	log(
		`  · 菜单指向：selected=${JSON.stringify(s.selectedIds)} ` +
			JSON.stringify(
				(s.selectedIds ?? []).map((id) => {
					const node = boardNode(s, id);
					return { id, 有图: (node?.src ?? '') !== '', 有工作流: node?.hasWorkflow === true, 有提示词: (node?.prompt ?? '') !== '' };
				}),
			),
	);
	if (runOneItem === null) throw new Error('菜单里没有「运行此节点」');

	// 这一下点击被谁接走了：真实指针先过 pointerdown 才到 click ——「菜单项没反应」
	// 只有这条线索能区分「没点中」和「点中了但处理器没跑」
	await evaluate(
		browser.cdp,
		`(() => {
			window.__ffcClickLog = [];
			for (const type of ['pointerdown', 'pointerup', 'click']) {
				document.addEventListener(type, (e) => {
					const t = e.target;
					const cls = t && t.className ? (t.className.baseVal !== undefined ? t.className.baseVal : t.className) : '';
					window.__ffcClickLog.push(type + '→' + (t ? t.tagName.toLowerCase() : '?') + (cls ? '.' + String(cls).trim().split(/\\s+/)[0] : ''));
				}, true);
			}
			return true;
		})()`,
	);
	const g1SrcBefore = liveSrc(s, 'g1');
	const g2SrcBefore = liveSrc(s, 'g2');
	await clickAt(runOneItem.center);
	log(`  · 这一下被谁接到：${String(await evaluate(browser.cdp, 'JSON.stringify(window.__ffcClickLog || [])'))}`);
	// 「点了没反应」时最要紧的一句话在这里：要么提示说了原因，要么它被静默吞了
	const afterClick = await read();
	log(`  · 点后 1s：${JSON.stringify({ notice: afterClick.notice, g1: boardNode(afterClick, 'g1')?.status, error: boardNode(afterClick, 'g1')?.error })}`);
	let w2 = await watchRun(['g1']);
	console.log(`  · 迁移：${w2.transitions.join(' / ')}`);
	console.log(`  · 运行读数：「${w2.note}」`);
	s = await waitImagesLoaded(['g1']);
	const g1b = boardNode(s, 'g1');
	const g1Live = liveSrc(s, 'g1');
	check(
		'「运行此节点」真的又生成了一张（节点自己 pending → ready，且产物换了新的）',
		w2.sawPending && statusOf(s, 'g1') === 'ready' && g1Live !== '' && g1Live !== g1SrcBefore,
		JSON.stringify({ 界面: statusOf(s, 'g1'), 旧产物: g1SrcBefore, 新产物: g1Live, error: g1b?.error, 迁移: w2.transitions }),
	);
	check(
		'「运行此节点」没有把上游（g2）一起重跑',
		liveSrc(s, 'g2') === g2SrcBefore,
		`g2 的产物地址${liveSrc(s, 'g2') === g2SrcBefore ? '没变（未重跑）' : '变了（被一起重跑了）'}`,
	);

	const before = new Set(s.nodes.map((n) => n.id));
	const g1At2 = domNode(s, 'g1')?.center ?? null;
	await rightClick(g1At2);
	s = await read();
	const copyItem2 = menuItem(s, '复制为新节点');
	check('重新打开菜单后「复制为新节点」仍在', copyItem2 !== null, JSON.stringify(s.menu?.items.map((i) => i.label)));
	if (copyItem2 !== null) await clickAt(copyItem2.center);
	await sleep(600);
	s = await read();
	const added = s.nodes.filter((n) => !before.has(n.id));
	check('「复制为新节点」加了一个节点', s.nodes.length === before.size + 1, `原来 ${String(before.size)} 个，现在 ${String(s.nodes.length)} 个`);
	const copy = added[0] === undefined ? null : boardNode(s, added[0].id);
	const source = boardNode(s, 'g1');
	check(
		'副本带走了 prompt / ratio / genKind（不是一张空壳）',
		copy !== null && copy.prompt === source?.prompt && copy.ratio === source?.ratio && copy.genKind === source?.genKind,
		JSON.stringify({ copy: { id: copy?.id, prompt: copy?.prompt, ratio: copy?.ratio, genKind: copy?.genKind }, source: { id: source?.id, prompt: source?.prompt, ratio: source?.ratio, genKind: source?.genKind } }),
	);
	await shot('2-p20');
	tail += `；P20：${w2.note}`;

	// ── 3. P22：本地图当参考图 ──
	console.log('\n3) P22 · 合成真实本地 PNG 的 drop → 宿主句柄 → 连线 → 参考图生成');
	const dropped = JSON.parse(
		await evaluate(
			browser.cdp,
			`(async () => {
				const canvas = document.createElement('canvas');
				canvas.width = 320;
				canvas.height = 320;
				const ctx = canvas.getContext('2d');
				ctx.fillStyle = '#2c3e50';
				ctx.fillRect(0, 0, 320, 320);
				ctx.fillStyle = '#e67e22';
				ctx.beginPath();
				ctx.arc(160, 160, 90, 0, Math.PI * 2);
				ctx.fill();
				const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
				const file = new File([blob], 'e2e-realgen-ref.png', { type: 'image/png' });
				const transfer = new DataTransfer();
				transfer.items.add(file);
				const target = document.querySelector('.ffc-viewport');
				if (target === null) return JSON.stringify({ ok: false, why: 'no-viewport' });
				const r = target.getBoundingClientRect();
				// 落点必须是**一块真正的空白**：拖进来的节点会盖住底下那个节点，
				// 于是后面「把线拉到 g3 上」命中的是这张新图（第一版实测）
				const inset = 50;
				const spots = [
					[r.left + inset, r.top + inset],
					[r.right - inset, r.top + inset],
					[r.left + inset, r.bottom - inset],
					[r.right - inset, r.bottom - inset],
				];
				let x = null;
				let y = null;
				for (const spot of spots) {
					const px = Math.round(spot[0]);
					const py = Math.round(spot[1]);
					if (document.elementFromPoint(px, py) === target) {
						x = px;
						y = py;
						break;
					}
				}
				if (x === null) return JSON.stringify({ ok: false, why: 'no-blank-spot' });
				target.dispatchEvent(new DragEvent('drop', {
					bubbles: true, cancelable: true, dataTransfer: transfer, clientX: x, clientY: y,
				}));
				return JSON.stringify({ ok: true, x, y, files: transfer.files.length });
			})()`,
		),
	);
	check('drop 派发成功且真的带了一个 File', dropped.ok === true && dropped.files === 1, JSON.stringify(dropped));
	await sleep(1200);
	s = await read();
	const newNode = s.nodes.find((n) => !before.has(n.id) && n.kind === 'image') ?? null;
	check('本地图落成了一个新的 image 节点', newNode !== null, JSON.stringify(s.nodes.map((n) => `${n.id}:${n.kind}`)));

	// 句柄是宿主异步回填的（客户端交字节 → 宿主存附件 → 回路径），给它几秒
	let ref = '';
	const refDeadline = Date.now() + 20000;
	while (Date.now() < refDeadline) {
		s = await read();
		const node = newNode === null ? null : boardNode(s, newNode.id);
		ref = node?.ref ?? '';
		if (ref !== '') break;
		await sleep(500);
	}
	check('P22 关键证据：本地图拿到了宿主句柄（节点上有 ref）', ref !== '', `ref=${ref === '' ? '(空)' : ref}`);

	// 落进来的图让内容变宽了：先把全部节点收进视口，再找一个没被别的节点盖住的落点
	await fitContent();
	s = await read();
	const g3Free = await freePointOn('g3');
	log(`  · 打到 g3 的落点（避开叠在它上面的节点）：${JSON.stringify(g3Free)}`);
	// 连线：本地图 → g3（没有句柄时这一条会被拒），文字 → g3
	// 悬停点也要落在「没被盖住」的位置：连接点只在 `.ffc-node:hover` 时才接指针，
	// 悬停没生效就按下 → 拖出来的是节点本身，线永远拉不出来
	const imgAt = newNode === null ? null : ((await freePointOn(newNode.id)) ?? domNode(s, newNode.id)?.center ?? null);
	const g3At = g3Free;
	const txt3At = domNode(s, 'txt3')?.center ?? null;
	const imgPort = domNode(s, newNode?.id ?? '')?.ports.find((p) => p.side === 'e')?.center ?? null;
	const txt3Port = domNode(s, 'txt3')?.ports.find((p) => p.side === 'e')?.center ?? null;
	check('g3 上找得到没被别的节点盖住的落点', g3Free !== null, JSON.stringify(g3Free));
	check('连线所需的坐标都拿得到', imgAt !== null && g3At !== null && txt3At !== null && imgPort !== null && txt3Port !== null);
	// 连线必须先悬停起点节点（连接点默认 pointer-events: none）——
	// 拉不出线时第一个要看的就是「那个点上当时是什么、连接点接不接指针」
	const srcPort = domNode(s, newNode?.id ?? '')?.ports.find((p) => p.side === 'e') ?? null;
	const txtPort = domNode(s, 'txt3')?.ports.find((p) => p.side === 'e') ?? null;
	log(`  · 起点：本地图 rect=${JSON.stringify(domNode(s, newNode?.id ?? '')?.box)} 东点=${JSON.stringify(srcPort)}`);
	log(`  · 起点：txt3 rect=${JSON.stringify(domNode(s, 'txt3')?.box)} 东点=${JSON.stringify(txtPort)}`);
	log(`  · 落点：g3 center=${JSON.stringify(g3At)} 视口=${JSON.stringify(s.viewport)}`);
	const droppedBoxBefore = JSON.stringify(domNode(s, newNode?.id ?? '')?.box ?? null);
	if (imgAt !== null && g3At !== null && imgPort !== null) await dragLink(imgAt, imgPort, g3At);
	if (txt3At !== null && g3At !== null && txt3Port !== null) await dragLink(txt3At, txt3Port, g3At);
	s = await read();
	log(`  · 两次拖拽之后：links=${JSON.stringify(s.board?.links)} drafts=${String(s.drafts)} notice=「${s.notice}」`);
	log(`  · 本地图有没有被误拖走：before=${droppedBoxBefore} after=${JSON.stringify(domNode(s, newNode?.id ?? '')?.box ?? null)}`);
	check('本地图 → g3 的连线建立成功（句柄不合格时会被拒）', newNode !== null && linkExists(s, newNode.id, 'g3'), JSON.stringify(s.board?.links));
	check('文字 → g3 的连线建立成功', linkExists(s, 'txt3', 'g3'), JSON.stringify(s.board?.links));

	// 落进来的本地图 + 两条新连线让内容变宽了，g3 可能在视口外 —— 先适应内容，
	// 否则右键会点到画布外（第一版实测：菜单根本没弹出来）。右键也要打在那个
	// **没被盖住**的点上，否则开出来的是压在上面那张图的菜单。
	await fitContent();
	s = await read();
	const g3At2 = (await freePointOn('g3')) ?? domNode(s, 'g3')?.center ?? null;
	await rightClick(g3At2);
	s = await read();
	const runG3 = menuItem(s, '运行此节点');
	check('g3 的菜单里有「运行此节点」', runG3 !== null, JSON.stringify(s.menu?.items.map((i) => i.label)));
	if (runG3 !== null) await clickAt(runG3.center);
	const w3 = await watchRun(['g3']);
	console.log(`  · 迁移：${w3.transitions.join(' / ')}`);
	console.log(`  · 运行读数：「${w3.note}」`);
	s = await waitImagesLoaded(['g3']);
	const g3b = boardNode(s, 'g3');
	const g3Live = liveSrc(s, 'g3');
	check('P22 端到端：用本地图当参考图真的出了图', w3.sawPending && statusOf(s, 'g3') === 'ready' && g3Live !== '', JSON.stringify({ 界面: statusOf(s, 'g3'), src: g3Live.slice(0, 60), error: g3b?.error, 迁移: w3.transitions }));
	check('g3 的图真的加载了', (domNode(s, 'g3')?.imgLoaded ?? false) === true);
	check('g3 的提示词来自连进来的文字节点', (g3b?.prompt ?? '').includes('肥鱼'), g3b?.prompt ?? '');
	await shot('3-p22');
	tail += `；P22：${w3.note}`;
} catch (error) {
	failures += 1;
	results.push(`  [FAIL] 中途抛错：${error instanceof Error ? error.message : String(error)}`);
} finally {
	const header = `肥鱼画布 · 真机真生成（P19/P20/P22）\n目标：${URL_TARGET}\n`;
	const summary = `\n${failures === 0 ? '全部通过 ✅' : `失败 ${String(failures)} 项 ❌`}\n`;
	await writeFile(REPORT, header + results.join('\n') + summary, 'utf8');
	console.log(`\n${results.join('\n')}\n${summary}`);
	console.log(`报告：${REPORT}${tail === '' ? '' : `\n读数回顾：${tail}`}`);
	await browser.close();
	process.exit(failures === 0 ? 0 : 1);
}
