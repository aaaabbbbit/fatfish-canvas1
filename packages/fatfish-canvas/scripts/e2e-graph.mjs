/**
 * P18 / P19 / P21 端到端：节点化交互（真实浏览器 + 真实输入）。
 *
 * 为什么这些必须上真实浏览器（离线一条都测不到）：
 *   - **连接点的可见性是纯 CSS `:hover`**（`opacity` + `pointer-events`）——
 *     替身里没有布局、没有命中测试，`getComputedStyle` 也不会变；
 *   - **连线是一次指针拖拽**（端口按下 → 视口 capture → 松手落点判定），
 *     指针捕获与坐标换算只能在真机上演；
 *   - **连接点的屏幕尺寸恒定**靠内联 `scale(1/zoom)`，只有真实的
 *     `getBoundingClientRect` 才带世界层的缩放矩阵；
 *   - **鼠标点菜单项**（P21 修的那个从 P5 活到 P20 的真 bug）：`pointerdown` 早于
 *     `click`，而离线 `useRef` 替身恒为 `{current:null}`、视口第一行就 return 了 ——
 *     旧套件全用方向键 + Enter 选菜单项，因此 15 个阶段都没抓到它（STATE §8.39）。
 *
 * 覆盖：
 *   1. 悬停节点 → 四个连接点淡入，移开淡出（纯 CSS，零逐帧 JS）
 *   2. 连接点的**屏幕尺寸恒定**：100% 与 10% 缩放下都是 28px、中心都压在边的中点上
 *   3. 从连接点拖到生成节点 → 连线出现、端点在正确的连接点上、落盘；
 *      悬停线的中点 → × 删掉
 *   4. 非法连线**当场说明原因**（第二张参考图 / 已经连过 / 目标不是生成节点 /
 *      连到自己 / 成环）
 *   5. 空白处右键 → **鼠标点**「新建生成节点」→ 真的多一个生成节点（P21 回归）
 *   6. 节点右键 → **鼠标点**「复制为新节点」→ 又 +1
 *   7. 双击文字节点 → 输入框 → 打字 → 失焦后文字变了，且落盘；
 *      编辑期间按 Delete / 方向键**不动**节点
 *
 * 用法（需放宽沙箱：无头 Chrome 要创建命名管道；地址要带 dsh web 打印的令牌）：
 *   node scripts/e2e-graph.mjs
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
const SHOT = resolve(PACKAGE_ROOT, 'lib/e2e-graph.png');

/** 连接点的命中区尺寸（styles.ts 的 `.ffc-port`）——「屏幕尺寸恒定」的期望值。 */
const PORT_HIT_PX = 28;

let failures = 0;
const results = [];
const check = (label, ok, detail = '') => {
	if (!ok) failures += 1;
	results.push(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail === '' ? '' : ` — ${detail}`}`);
};
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN);
const dist = (a, b) =>
	a === null || b === null || a === undefined || b === undefined ? Number.NaN : Math.hypot(a.x - b.x, a.y - b.y);

/** 页面事实。 */
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
  const pointAt = (path, at) => {
    const mtx = path.getScreenCTM();
    if (!mtx) return null;
    const p = path.getPointAtLength(at);
    return { x: Math.round(mtx.a * p.x + mtx.c * p.y + mtx.e), y: Math.round(mtx.b * p.x + mtx.d * p.y + mtx.f) };
  };
  const world = q('.ffc-world');
  const m = world ? new DOMMatrixReadOnly(getComputedStyle(world).transform) : null;
  let board = null;
  try { board = JSON.parse(window.localStorage.getItem('fatfish-canvas:board') || 'null'); } catch (e) { board = null; }
  const hit = q('.ffc-link-hit');
  const midPt = hit ? pointAt(hit, hit.getTotalLength() / 2) : null;
  const describe = (el) => {
    if (!el) return null;
    const cls = typeof el.className === 'string' ? el.className : (el.className && el.className.baseVal) || '';
    return el.tagName.toLowerCase() + (cls ? '.' + cls.trim().split(/\\s+/)[0] : '');
  };
  const midTop = midPt ? describe(document.elementFromPoint(midPt.x, midPt.y)) : null;
  const linksSvg = q('.ffc-links');
  const menu = q('.ffc-node-menu');
  const zoomMenu = q('.ffc-zoom-menu');
  const notice = q('.ffc-sent-notice');
  const edit = q('.ffc-node-edit');
  const items = (root) => root ? qa('.ffc-menu-item').filter((b) => root.contains(b)).map((b) => ({
    label: (b.textContent || '').trim(),
    disabled: b.disabled === true,
    title: b.getAttribute('title'),
    center: center(b),
  })) : null;
  return JSON.stringify({
    mode: document.body.dataset.ffcMode ?? null,
    followPref: window.localStorage.getItem('fatfish-canvas:follow-new'),
    zoom: m ? m.a : null,
    viewport: rect(q('.ffc-viewport')),
    nodeCount: q('.ffc-viewport') ? Number(q('.ffc-viewport').dataset.nodeCount) : null,
    zoomPercent: q('.ffc-zoom-pct') ? (q('.ffc-zoom-pct').textContent || '').trim() : null,
    nodes: qa('.ffc-node').map((n) => ({
      id: n.dataset.nodeId,
      kind: n.dataset.kind,
      selected: n.dataset.selected === 'true',
      left: Math.round(parseFloat(n.style.left) || 0),
      top: Math.round(parseFloat(n.style.top) || 0),
      box: rect(n),
      center: center(n),
      label: (n.textContent || '').trim(),
      ports: Array.from(n.querySelectorAll('.ffc-port')).map((p) => ({
        side: p.dataset.ffcPort,
        rect: rect(p),
        center: center(p),
        opacity: getComputedStyle(p).opacity,
        pointerEvents: getComputedStyle(p).pointerEvents,
      })),
    })),
    links: qa('.ffc-link-hit').map((p) => p.dataset.ffcLink),
    drafts: qa('.ffc-link-draft').length,
    linkStart: hit ? pointAt(hit, 0) : null,
    linkEnd: hit ? pointAt(hit, hit.getTotalLength()) : null,
    linkMid: midPt,
    /** 连线中点上是哪个元素（悬停不生效时第一个要看的东西）。 */
    linkMidTop: midTop,
    hitPE: hit ? getComputedStyle(hit).pointerEvents : null,
    linkX: rect(q('.ffc-link-x')),
    linkXCount: qa('.ffc-link-x').length,
    linkXOpacity: (() => {
      const b = q('.ffc-link-x');
      return b ? Number(getComputedStyle(b).opacity) : null;
    })(),
    /** × 自己能不能被点到（它常年压在所有节点之上，必须真的可命中）。 */
    linkXHit: (() => {
      const b = q('.ffc-link-x');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      const h = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return h !== null && (h === b || b.contains(h));
    })(),
    board: board === null ? null : {
      nodes: Array.isArray(board.nodes) ? board.nodes.length : -1,
      links: Array.isArray(board.links) ? board.links.length : -1,
      txtTitle: (() => {
        if (!Array.isArray(board.nodes)) return null;
        const t = board.nodes.find((n) => n.id === 'txt');
        return t ? (t.title || t.prompt || '') : null;
      })(),
    },
    menu: menu === null ? null : { label: menu.getAttribute('aria-label'), rect: rect(menu), items: items(menu) },
    menuHit: (() => {
      const b = q('.ffc-node-menu .ffc-menu-item');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      const h = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return h !== null && (h === b || b.contains(h));
    })(),
    zoomMenu: zoomMenu === null ? null : { items: items(zoomMenu) },
    notice: notice ? (notice.textContent || '').trim() : '',
    editing: edit !== null,
    editingValue: edit ? edit.value : null,
  });
})()`;

/**
 * 五个节点，覆盖全部连线规则：
 *   txt → 文字（合法提示词来源）· gen / gen2 → 两个**有产物**的生成节点（串联与成环用）
 *   img / img2 → 两张 http 图（合法参考图 + 「只支持一张参考图」用）
 */
const SEED = JSON.stringify({
	version: 2,
	nodes: [
		{ id: 'txt', kind: 'text', x: 0, y: 0, w: 260, h: 120, z: 1, status: 'ready', title: '一条肥鱼', prompt: '一条肥鱼', createdAt: 1 },
		{ id: 'gen', kind: 'gen', x: 420, y: 0, w: 280, h: 280, z: 2, status: 'ready', title: '生成节点', src: 'https://example.test/gen-a.png', createdAt: 2 },
		{ id: 'gen2', kind: 'gen', x: 420, y: 360, w: 280, h: 280, z: 3, status: 'ready', title: '生成节点', src: 'https://example.test/gen-b.png', createdAt: 3 },
		{ id: 'img', kind: 'image', x: 0, y: 200, w: 320, h: 320, z: 4, status: 'ready', title: '图 A', src: 'https://example.test/a.png', createdAt: 4 },
		{ id: 'img2', kind: 'image', x: 800, y: 0, w: 320, h: 320, z: 5, status: 'ready', title: '图 B', src: 'https://example.test/b.png', createdAt: 5 },
	],
	viewport: { x: 0, y: 0, zoom: 1 },
	ingested: [],
});

const browser = await launch();
const read = async () => JSON.parse(await evaluate(browser.cdp, PROBE));

/** 派发一次按键。 */
async function press(key, code, vk, modifiers = 0) {
	await browser.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
	await browser.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
	await sleep(120);
}

/** 把鼠标移到某点（触发真实 `:hover`：连接点的可见性完全靠它）。 */
async function hover(at, waitMs = 280) {
	await browser.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y, buttons: 0 });
	await sleep(waitMs);
}

/** 一次真实的双击。 */
async function doubleClick(at) {
	const base = { x: at.x, y: at.y, button: 'left' };
	await browser.cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1, clickCount: 1 });
	await browser.cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0, clickCount: 1 });
	await sleep(60);
	await browser.cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1, clickCount: 2 });
	await browser.cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0, clickCount: 2 });
	await sleep(260);
}

/** 在某个坐标右键。 */
async function rightClick(x, y) {
	await browser.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 });
	await browser.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 });
	await sleep(340);
}

/**
 * 从某个连接点拖到某点（真实的连线手势）。
 *
 * ⚠️ 必须**先悬停起点节点**：连接点默认 `pointer-events: none`，只有
 * `.ffc-node:hover .ffc-port` 把它变 `auto` —— 不先悬停就按下，按到的是节点本身
 * （于是变成拖节点，线永远拉不出来）。这一步本身就是被测行为的一部分。
 * @param fromCenter - 起点节点中心（先悬停它）。
 * @param portAt - 起点连接点中心。
 * @param to - 落点。
 */
async function dragLink(fromCenter, portAt, to) {
	await hover(fromCenter);
	await browser.cdp.send('Input.dispatchMouseEvent', {
		type: 'mousePressed',
		x: portAt.x,
		y: portAt.y,
		button: 'left',
		buttons: 1,
		clickCount: 1,
	});
	const steps = 8;
	for (let i = 1; i <= steps; i += 1) {
		const t = i / steps;
		await browser.cdp.send('Input.dispatchMouseEvent', {
			type: 'mouseMoved',
			x: Math.round(portAt.x + (to.x - portAt.x) * t),
			y: Math.round(portAt.y + (to.y - portAt.y) * t),
			button: 'left',
			buttons: 1,
		});
		await sleep(14);
	}
	await browser.cdp.send('Input.dispatchMouseEvent', {
		type: 'mouseReleased',
		x: to.x,
		y: to.y,
		button: 'left',
		buttons: 0,
		clickCount: 1,
	});
	await sleep(300);
}

/**
 * 等视口安静下来。
 *
 * 为什么必须有它：新建节点会触发**自动跟焦**（`follow.ts` 的三闸：开关 / 忙碌 /
 * 安静期），而安静期意味着「用户刚操作过就先排队、等 1.5 秒再动」—— 所以创建完
 * 节点后立刻读到的坐标是**动之前**的，右键就点空了（第一轮实测：节点菜单变成了
 * 空白处菜单）。判据用「所有节点的屏幕盒子 + zoom 连续两次读数一致」。
 * @param maxMs - 最长等多久。
 * @returns 安静之后的读数。
 */
async function settle(maxMs = 5000) {
	const deadline = Date.now() + maxMs;
	let prev = null;
	for (;;) {
		const state = await read();
		const key = `${String(state.zoom)}|${state.nodes.map((n) => `${String(n.box.x)},${String(n.box.y)}`).join(';')}`;
		if (key === prev) return state;
		prev = key;
		if (Date.now() > deadline) return state;
		await sleep(420);
	}
}

const nodeOf = (state, id) => state.nodes.find((n) => n.id === id) ?? null;
const portOf = (state, id, side) => nodeOf(state, id)?.ports.find((p) => p.side === side) ?? null;
/** 一次拖拽的落点：给定了目标边就用那个连接点，否则用节点中心。 */
const dropAt = (state, id, side) => (side === null ? nodeOf(state, id).center : portOf(state, id, side).center);

/**
 * 找一个**真正的空白点**（命中测试落回视口自己）。
 *
 * 不能写死「右下角往里 40px」：适应内容的留白宽度不是契约，写到节点上就会变成
 * 「右键弹出的是节点菜单」这种看起来像功能坏了的假故障。候选点按角落往里收，
 * 逐个问 `elementFromPoint`。
 */
async function findBlank() {
	const found = await evaluate(
		browser.cdp,
		`(() => {
			const vp = document.querySelector('.ffc-viewport');
			const r = vp.getBoundingClientRect();
			const inset = 60;
			const candidates = [
				[r.right - inset, r.bottom - inset],
				[r.left + inset, r.bottom - inset],
				[r.right - inset, r.top + inset],
				[r.left + r.width / 2, r.bottom - inset],
			];
			for (const c of candidates) {
				const x = Math.round(c[0]);
				const y = Math.round(c[1]);
				if (document.elementFromPoint(x, y) === vp) return JSON.stringify({ x, y });
			}
			return 'null';
		})()`,
	);
	return JSON.parse(found);
}

console.log(`\n肥鱼画布 · P18 端到端（连接点 / 连线 / 鼠标点菜单 / 内联编辑）\n目标：${URL_TARGET}\n`);

try {
	let loaded = browser.cdp.once('Page.loadEventFired');
	await browser.cdp.send('Page.navigate', { url: URL_TARGET });
	await loaded;
	await evaluate(
		browser.cdp,
		`(() => {
			${seedBoardExpression(SEED)};
			window.localStorage.setItem('fatfish-canvas:view-mode', 'canvas');
			// **关掉自动跟焦**：新建节点会触发它把视口挪到新节点上（安静期 1.5s 之后
			// 才动），于是前面量好的节点坐标全部作废、右键点到空白处去（第一轮实测
			// 就是这么挂的：种子节点被推出视口，y = -75）。跟焦本身有 e2e-ingest 在测，
			// 这一套只关心连线与菜单，要的是一块**不动**的画布。
			window.localStorage.setItem('fatfish-canvas:follow-new', 'off');
			${RESET_BOARD_PREFS}
			return true;
		})()`,
	);
	loaded = browser.cdp.once('Page.loadEventFired');
	await browser.cdp.send('Page.reload', { ignoreCache: false });
	await loaded;
	await sleep(9000);

	let s = await read();
	check('画布模式已生效', s.mode === 'canvas', String(s.mode));
	check('自动跟焦已关掉（这一轮量到的坐标必须一直有效）', s.followPref === 'off', String(s.followPref));
	check('五个种子节点都渲染出来了', s.nodes.length === 5, `实际 ${String(s.nodes.length)}`);
	check('初始没有连线、没有草稿线', s.links.length === 0 && s.drafts === 0, JSON.stringify(s.links));
	check('初始没有菜单、没有提示、没有输入框', s.menu === null && s.notice === '' && s.editing === false);

	// 全部收进视口（种子 x 跨到 1120，画布列放不下）——后面每一步都靠屏幕坐标点目标
	const fitAt = JSON.parse(
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
	check('工具条上的「适应内容」找得到', fitAt !== null, JSON.stringify(fitAt));
	if (fitAt !== null) await click(browser.cdp, fitAt.x, fitAt.y);
	await sleep(1000);
	s = await read();
	const vp = s.viewport;
	check(
		'适应内容后五个节点都落在视口里（后续坐标才有意义）',
		s.nodes.every(
			(n) =>
				n.center.x > vp.x + 4 &&
				n.center.x < vp.x + vp.w - 4 &&
				n.center.y > vp.y + 4 &&
				n.center.y < vp.y + vp.h - 4,
		),
		JSON.stringify(s.nodes.map((n) => ({ id: n.id, c: n.center }))) + ` vp=${JSON.stringify(vp)}`,
	);

	// ── 1. 连接点的可见性（纯 CSS 悬停）──
	console.log('1) 连接点：悬停淡入 / 移开淡出');
	const txt = nodeOf(s, 'txt');
	check('文字节点长了四个连接点（四条边中点，进出合一）', txt.ports.length === 4, JSON.stringify(txt.ports.map((p) => p.side)));
	check(
		'默认不可见且不抢指针（否则节点永远拖不动）',
		txt.ports.every((p) => Number(p.opacity) === 0 && p.pointerEvents === 'none'),
		JSON.stringify(txt.ports.map((p) => `${String(p.side)}:${p.opacity}/${p.pointerEvents}`)),
	);
	await hover(txt.center);
	s = await read();
	check(
		'悬停节点 → 四个连接点一起淡入（opacity 1）',
		nodeOf(s, 'txt').ports.every((p) => Number(p.opacity) === 1),
		JSON.stringify(nodeOf(s, 'txt').ports.map((p) => `${String(p.side)}:${p.opacity}`)),
	);
	check(
		'淡入之后才接指针（不悬停时命中区形同虚设）',
		nodeOf(s, 'txt').ports.every((p) => p.pointerEvents === 'auto'),
		JSON.stringify(nodeOf(s, 'txt').ports.map((p) => p.pointerEvents)),
	);
	await hover(nodeOf(s, 'gen').center);
	s = await read();
	check(
		'悬停另一个节点 → 前一个的连接点淡出（不会整块画布都亮着）',
		Number(nodeOf(s, 'txt').ports[0].opacity) === 0,
		String(nodeOf(s, 'txt').ports[0].opacity),
	);

	// ── 2. 连接点的屏幕尺寸恒定（100% 与 10% 都是 28px）──
	console.log('\n2) 连接点屏幕尺寸恒定（反向缩放）');
	/** 某个节点「东边那个连接点」的量法：尺寸 + 中心离边中点的偏离。 */
	const sizeOf = (state, id) => {
		const node = nodeOf(state, id);
		const port = portOf(state, id, 'e');
		// 连接点的中心应当压在**边框盒**右边中点上（差一个 1px 边框 × zoom）
		const want = { x: node.box.x + node.box.w, y: node.box.y + node.box.h / 2 };
		return { w: port.rect.w, h: port.rect.h, offset: dist(port.center, want), nodeW: node.box.w };
	};
	// ⚠️「适应内容」之后 zoom **不是** 100%（它按内容算），所以下面的对照必须按
	// 实测 zoom 折算，而不是假设 100%。
	const zoom100 = num(s.zoom);
	check('适应内容之后的缩放读数是个正常值', zoom100 > 0.2 && zoom100 < 5, String(zoom100));
	const at100 = sizeOf(s, 'txt');
	check(
		`适应内容后连接点命中区仍是 ${String(PORT_HIT_PX)}px`,
		Math.abs(at100.w - PORT_HIT_PX) <= 2 && Math.abs(at100.h - PORT_HIT_PX) <= 2,
		`${String(at100.w)}x${String(at100.h)} @zoom=${String(zoom100)}`,
	);
	check('连接点中心压在节点那条边的中点上（margin 与 scale 没打架）', at100.offset <= 4, `偏离 ${at100.offset.toFixed(1)}px`);

	// 用真实的缩放档位菜单切到 10%（顺带走一次**鼠标点菜单**的路径）
	const pctAt = JSON.parse(
		await evaluate(
			browser.cdp,
			`(() => {
				const b = document.querySelector('.ffc-zoom-pct');
				const r = b.getBoundingClientRect();
				return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
			})()`,
		),
	);
	await click(browser.cdp, pctAt.x, pctAt.y);
	await sleep(340);
	s = await read();
	check('缩放档位菜单打开了', s.zoomMenu !== null, JSON.stringify(s.zoomMenu));
	const tenAt = s.zoomMenu?.items.find((i) => i.label === '10%')?.center ?? null;
	check('菜单里点得到 10%', tenAt !== null, JSON.stringify(s.zoomMenu?.items.map((i) => i.label)));
	if (tenAt !== null) await click(browser.cdp, tenAt.x, tenAt.y);
	await sleep(700);
	s = await read();
	check('缩放真的到了 10%', Math.abs(num(s.zoom) - 0.1) < 1e-6, String(s.zoom));
	const at10 = sizeOf(s, 'txt');
	check(
		'节点本身确实被缩掉了（不然下面那条断言没有意义）',
		Math.abs(at10.nodeW - at100.nodeW * (num(s.zoom) / zoom100)) <= 2,
		`屏幕宽 ${String(at100.nodeW)} @${String(zoom100)} → ${String(at10.nodeW)} @${String(s.zoom)}`,
	);
	check(
		`10% 下连接点**仍是** ${String(PORT_HIT_PX)}px（反向缩放的唯一证据）`,
		Math.abs(at10.w - PORT_HIT_PX) <= 2 && Math.abs(at10.h - PORT_HIT_PX) <= 2,
		`${String(at10.w)}x${String(at10.h)}`,
	);
	check('10% 下中心仍在边的中点上（缩放不把连接点甩偏）', at10.offset <= 4, `偏离 ${at10.offset.toFixed(1)}px`);

	// 回到 100%
	await click(browser.cdp, pctAt.x, pctAt.y);
	await sleep(340);
	s = await read();
	const hundredAt = s.zoomMenu?.items.find((i) => i.label === '100%')?.center ?? null;
	if (hundredAt !== null) await click(browser.cdp, hundredAt.x, hundredAt.y);
	await sleep(700);
	s = await read();
	check('缩放回到 100%', Math.abs(num(s.zoom) - 1) < 1e-6, String(s.zoom));

	// ── 3. 拖出第一条连线 ──
	console.log('\n3) 从连接点拖出连线');
	s = await read();
	const img = nodeOf(s, 'img');
	const imgPort = portOf(s, 'img', 'e');
	check('起点连接点（图的右边那个）量得到', imgPort !== null && imgPort.rect.w > 0, JSON.stringify(imgPort?.rect));
	await dragLink(img.center, imgPort.center, dropAt(s, 'gen', 'w'));
	s = await read();
	check('拖到生成节点上松手 → 出现一条连线', s.links.length === 1, `links=${JSON.stringify(s.links)}`);
	check('拉的过程中那条虚线已经收掉了', s.drafts === 0, String(s.drafts));
	check(
		'线是从**用户拉的那个点**长出来的（记了 fromSide，不是「最近的那两面」）',
		dist(s.linkStart, portOf(s, 'img', 'e').center) <= 6,
		`起点 ${JSON.stringify(s.linkStart)} 期望 ${JSON.stringify(portOf(s, 'img', 'e').center)}`,
	);
	check(
		'另一端落在目标节点的连接点上',
		dist(s.linkEnd, portOf(s, 'gen', 'w').center) <= 6,
		`终点 ${JSON.stringify(s.linkEnd)} 期望 ${JSON.stringify(portOf(s, 'gen', 'w').center)}`,
	);
	await sleep(700);
	s = await read();
	check('连线进了持久化（不只是渲染层）', s.board?.links === 1, JSON.stringify({ links: s.board?.links }));

	// 每条连线的中点都有一个 × 删除按钮
	//
	// ⚠️ 它是**常驻**的（P23 实测改的）：老版本「悬停线上的中点才出现 ×」看起来更干净，
	// 但按钮正好长在指针底下 —— 显示它这个动作会把指针从连线的命中路径上抢走，
	// 于是线失去 hover、按钮收起、指针又回到线上……来回抖，鼠标实际点不到。
	// 现在：常驻 + 平时淡一点（纯 CSS），下面三条断言钉住「看得见、点得到、点了就删」。
	s = await read();
	check('每条连线中点都有一个 × 删除按钮', s.linkXCount === 1 && s.linkX !== null, `count=${String(s.linkXCount)}`);
	check(
		'× 可以被点到（常年压在节点之上，必须真的可命中）',
		s.linkXHit === true,
		`×中心命中 ${String(s.linkMidTop)}；×=${JSON.stringify(s.linkX)}`,
	);
	check('× 平时是淡的（不喧宾夺主，指针一到才实心）', num(s.linkXOpacity) > 0 && num(s.linkXOpacity) < 1, String(s.linkXOpacity));
	if (s.linkX !== null) {
		await click(browser.cdp, Math.round(s.linkX.x + s.linkX.w / 2), Math.round(s.linkX.y + s.linkX.h / 2));
		await sleep(560);
	}
	s = await read();
	check('点 × 真的删掉了这条连线', s.links.length === 0, `links=${JSON.stringify(s.links)}`);
	check('连线没了，× 也一起消失', s.linkXCount === 0, `count=${String(s.linkXCount)}`);

	// ── 4. 非法连线的理由（每条都是一句人话）──
	console.log('\n4) 非法连线的理由');
	/** 拖一次并回读提示（每次都用**当下**的坐标：视口与节点都可能变过）。 */
	const attempt = async (fromId, fromSide, toId, toSide) => {
		const cur = await read();
		await dragLink(nodeOf(cur, fromId).center, portOf(cur, fromId, fromSide).center, dropAt(cur, toId, toSide));
		return await read();
	};

	s = await attempt('img', 'e', 'gen', 'w');
	check('图 → 生成：连线成立（http 地址是合法参考图）', s.links.length === 1, `links=${String(s.links.length)}`);
	s = await attempt('img2', 'w', 'gen', 'w');
	check(
		'第二张参考图被拒，且说清了原因',
		s.notice.includes('只支持一张参考图'),
		`提示=「${s.notice}」`,
	);
	check('被拒时不会真的连上', s.links.length === 1, `links=${String(s.links.length)}`);
	s = await attempt('txt', 'e', 'gen', 'w');
	check('文字 → 生成：可以（提示词来源，不占参考图名额）', s.links.length === 2, `links=${String(s.links.length)}`);
	s = await attempt('txt', 'e', 'gen', 'w');
	check('同一条再连一次 → 「这两个节点已经连过了」', s.notice.includes('已经连过'), `提示=「${s.notice}」`);
	s = await attempt('gen', 'w', 'img2', 'e');
	check('目标不是生成节点 → 「只有生成节点接受输入」', s.notice.includes('只有生成节点接受输入'), `提示=「${s.notice}」`);
	s = await attempt('txt', 'e', 'txt', 'w');
	check('连到自己 → 「不能连到自己」', s.notice.includes('不能连到自己'), `提示=「${s.notice}」`);
	s = await attempt('gen', 's', 'gen2', 'n');
	check('生成节点 → 生成节点：可以串联（P19）', s.links.length === 3, `links=${String(s.links.length)}`);
	s = await attempt('gen2', 'n', 'gen', 's');
	check('反向再连 → 「这样会绕成一个环」', s.notice.includes('绕成一个环'), `提示=「${s.notice}」`);

	// ── 5. 空白处右键 → 鼠标点「新建生成节点」（P21 的鼠标路径）──
	console.log('\n5) 右键菜单：鼠标点得动（P21 修的 bug）');
	s = await read();
	const before = s.nodes.length;
	const blank = await findBlank();
	check('画布上找得到一块真正的空白（右键新建的前提）', blank !== null, JSON.stringify(blank));
	await rightClick(blank.x, blank.y);
	s = await read();
	check('空白处右键 → 弹出「新建节点」菜单', s.menu !== null && s.menu.label === '新建节点', JSON.stringify(s.menu?.label));
	check('菜单里有文字 / 生成两个条目', s.menu?.items.length === 2, JSON.stringify(s.menu?.items.map((i) => i.label)));
	check('菜单没被别的层挡住（可命中）', s.menuHit === true, String(s.menuHit));
	const newGen = s.menu?.items.find((i) => i.label.includes('新建生成节点'))?.center ?? null;
	check('「新建生成节点」量得到坐标', newGen !== null);
	if (newGen !== null) await click(browser.cdp, newGen.x, newGen.y);
	await sleep(640);
	s = await read();
	check(
		'**鼠标点**菜单项真的建出了节点（P21 的回归）',
		s.nodes.length === before + 1,
		`${String(before)} → ${String(s.nodes.length)}`,
	);
	check('新节点带四个连接点（真是生成节点）', s.nodes.some((n) => n.ports.length === 4 && n.label.includes('生成节点')));
	check('选完菜单自己关掉', s.menu === null);

	// ── 6. 节点右键 → 鼠标点「复制为新节点」──
	// ⚠️ 先等视口安静：上一步新建的节点会触发自动跟焦（安静期 1.5s 之后才动），
	// 不等的话读到的节点坐标是**动之前**的，右键会点到空白处去（第一轮实测）。
	s = await settle();
	const beforeDup = s.nodes.length;
	const genTarget = nodeOf(s, 'gen');
	await rightClick(genTarget.center.x, genTarget.center.y);
	s = await read();
	check(
		'节点右键 → 弹出「节点操作」菜单',
		s.menu !== null && s.menu.label === '节点操作',
		`label=${String(s.menu?.label)} 点=(${String(genTarget.center.x)},${String(genTarget.center.y)})`,
	);
	const dupItem = s.menu?.items.find((i) => i.label.includes('复制为新节点')) ?? null;
	check('「复制为新节点」在生成节点上是启用的', dupItem !== null && dupItem.disabled === false, JSON.stringify(dupItem));
	if (dupItem !== null) await click(browser.cdp, dupItem.center.x, dupItem.center.y);
	await sleep(640);
	s = await read();
	check(
		'**鼠标点**「复制为新节点」→ 多一个节点',
		s.nodes.length === beforeDup + 1,
		`${String(beforeDup)} → ${String(s.nodes.length)}`,
	);

	// ── 7. 双击文字节点 → 内联编辑 ──
	console.log('\n6) 文字节点双击内联编辑');
	s = await settle();
	const txtNow = nodeOf(s, 'txt');
	// 诊断：在节点上挂**原生**监听，看这两下点击到底落在谁身上 ——
	// 「双击进不了编辑态」只有这条线索能指路（P23 就是靠它查出指针捕获改派了 click）。
	await evaluate(
		browser.cdp,
		`(() => {
			const el = document.querySelector('.ffc-node[data-kind="text"]');
			window.__ffcEv = [];
			for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick']) {
				el.addEventListener(type, (e) => {
					const t = e.target;
					const cls = t && t.className ? (t.className.baseVal !== undefined ? t.className.baseVal : t.className) : '';
					window.__ffcEv.push(type + '→' + (cls || (t ? t.tagName : '?')) + '#' + String(e.detail));
				}, true);
			}
			return true;
		})()`,
	);
	await doubleClick(txtNow.center);
	s = await read();
	const dblDiag = await evaluate(browser.cdp, 'JSON.stringify(window.__ffcEv || [])');
	check('双击文字节点 → 出现输入框', s.editing === true, `节点收到的鼠标事件=${dblDiag}`);
	check('输入框里带着原内容', String(s.editingValue).includes('一条肥鱼'), String(s.editingValue));

	// 编辑期间按 Delete / 方向键**不能**动节点（画布快捷键不许从输入框外泄）
	const countBefore = s.nodes.length;
	await press('Delete', 'Delete', 46);
	await press('ArrowLeft', 'ArrowLeft', 37);
	s = await read();
	check('编辑期间按 Delete 不会删掉节点', s.nodes.length === countBefore, `${String(countBefore)} → ${String(s.nodes.length)}`);
	const txtAfterKeys = nodeOf(s, 'txt');
	check(
		'编辑期间按方向键不会挪动节点',
		txtAfterKeys.left === txtNow.left && txtAfterKeys.top === txtNow.top,
		`${JSON.stringify({ l: txtNow.left, t: txtNow.top })} → ${JSON.stringify({ l: txtAfterKeys.left, t: txtAfterKeys.top })}`,
	);

	// 全选后真的打字（真实 input 事件）
	await press('a', 'KeyA', 65, 2);
	await browser.cdp.send('Input.insertText', { text: '两条肥鱼' });
	await sleep(240);
	s = await read();
	check('打得进字（真 input 事件）', String(s.editingValue).includes('两条肥鱼'), String(s.editingValue));

	// 点空白处造成**真实失焦**（合成 blur 不冒泡，React 收不到）
	const blurAt = await findBlank();
	await click(browser.cdp, blurAt.x, blurAt.y);
	await sleep(560);
	s = await read();
	check('失焦后输入框收起', s.editing === false);
	check('节点上的文字真的变了（提交进了 store）', nodeOf(s, 'txt').label.includes('两条肥鱼'), nodeOf(s, 'txt').label.slice(0, 40));
	await sleep(700);
	s = await read();
	check('改动落盘（刷新后还在）', String(s.board?.txtTitle).includes('两条肥鱼'), String(s.board?.txtTitle));

	const shot = await browser.cdp.send('Page.captureScreenshot', { format: 'png' });
	await writeFile(SHOT, Buffer.from(shot.data, 'base64'));
	console.log(`\n[e2e-graph] 截图：${SHOT}`);
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
