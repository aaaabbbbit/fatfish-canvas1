/**
 * P4 端到端：画布工具条 · 纯画布模式 · 快捷键（真实浏览器 + 真实输入）。
 *
 * 为什么不能只靠无浏览器替身：这一轮加的东西全是「点一下会发生什么」——
 * 按钮是否真的可点、纯画布模式下 AppFrame 是否真的收起、切回来是否真的恢复。
 * 替身只能调用组件的回调，测不到事件派发、命中测试、布局重排这三层。
 *
 * 覆盖：
 *   1. 工具条：全选 / 删除选中 / 适应内容 / 跟焦开关 / 清空（含按钮禁用态）
 *      + 画布宽度（拖拽条与重置按钮；宽度预设选择见下方 P10 说明）
 *   2. 顶栏（P10）：**没有**「视图」菜单（视图模式与画布宽度选择已移除），
 *      纯画布独立成一个按钮，作用域读数自己就是开关
 *   3. 纯画布模式：AppFrame 真的收起、画布真的铺满、切回来真的恢复
 *   4. 快捷键 Ctrl/⌘ + Shift + B 在聊天与画布之间来回切
 *
 * P10 之后本脚本的两处改动（都是被删掉的东西）：
 *   - 「视图菜单」那一节整块删掉 —— 菜单没了（模式切换 = 米饭碗 ↔ 顶栏纯画布按钮，
 *     见 e2e-entry.mjs；作用域的开关点这里第 2 节）。
 *   - 切模式不再走菜单：`setMode(target)` 直接点**界面上那两个按钮**，
 *     比原来走菜单更接近用户动作。
 *
 * 用法（需放宽沙箱：无头 Chrome 要创建命名管道）：
 *   node scripts/e2e-p4.mjs
 */

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PACKAGE_ROOT, PIN_SHARED_BOARD, seedBoardExpression, click, evaluate, launch, sleep } from './lib/cdp.mjs';

const URL_TARGET = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080/';
const SHOT = resolve(PACKAGE_ROOT, 'lib/e2e-p4.png');

let failures = 0;
const results = [];
const check = (label, ok, detail = '') => {
	if (!ok) failures += 1;
	results.push(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail === '' ? '' : ` — ${detail}`}`);
};
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN);

/** 页面事实：画布节点、工具条按钮、两个模式开关、布局。 */
const PROBE = `(() => {
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right) }; };
  const center = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; };
  const hit = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); if (r.width === 0) return false; const h = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return h !== null && (h === el || el.contains(h)); };
  const btn = (label) => {
    const b = qa('.ffc-toolbar button').find((x) => x.getAttribute('aria-label') === label);
    if (!b) return null;
    const c = center(b);
    return { x: c.x, y: c.y, disabled: b.disabled, pressed: b.getAttribute('aria-pressed'), hit: hit(b) };
  };
  const world = q('.ffc-world');
  const m = world ? new DOMMatrixReadOnly(getComputedStyle(world).transform) : null;
  const frame = q('[data-ffc-frame]');
  const only = qa('.ffc-toolbar button').find((b) => b.getAttribute('aria-label') === '纯画布模式') ?? null;
  const scopeBtn = q('[data-ffc-scope]');
  return JSON.stringify({
    mode: document.body.dataset.ffcMode ?? null,
    lastToggle: document.body.dataset.ffcLastToggle ?? null,
    panel: rect(q('.ffc-panel')),
    viewport: rect(q('.ffc-viewport')),
    frame: rect(frame),
    frameDisplay: frame ? getComputedStyle(frame).display : null,
    zoom: m ? m.a : null,
    hasMenu: !!q('.ffc-menu'),
    hasViewBtn: qa('.ffc-view-btn').length > 0,
    hasWideMenu: qa('.ffc-menu-wide').length > 0,
    onlyBtn: rect(only),
    onlyBtnCenter: center(only),
    onlyBtnPressed: only ? only.getAttribute('aria-pressed') : null,
    // 纯画布模式下这个按钮是**唯一**出口，必须还点得到（白屏 bug 的回归守卫）
    onlyBtnHit: hit(only),
    scopeBtn: rect(scopeBtn),
    scopeBtnCenter: center(scopeBtn),
    scopeBtnPressed: scopeBtn ? scopeBtn.getAttribute('aria-pressed') : null,
    scopeBtnHit: hit(scopeBtn),
    scopeBtnText: scopeBtn ? (scopeBtn.textContent || '').trim() : null,
    toolbar: (() => { const b = q('.ffc-toolbar'); return b ? { overflow: b.scrollWidth > b.clientWidth + 1 } : null; })(),
    resizer: rect(q('.ffc-resizer')),
    // 纯画布模式的正确判据不是「frame 被 display:none」——overlay 层（画布面板）
    // 是 frame 的子节点，隐藏 frame 会把插件自己的界面一起藏掉，
    // 变成白屏且退不出来。正确做法是隐藏 frame 里**除 overlay 以外**的列。
    frameChildren: frame ? Array.from(frame.children).length : 0,
    chatColumnsHidden: (() => {
      if (!frame) return null;
      const others = Array.from(frame.children).filter(
        (el) => el.getAttribute('data-shell-overlay') === null,
      );
      return others.length > 0 && others.every((el) => getComputedStyle(el).display === 'none');
    })(),
    overlayVisible: (() => {
      const el = q('[data-shell-overlay]');
      return el ? getComputedStyle(el).display !== 'none' : null;
    })(),
    panelHit: (() => {
      const el = q('.ffc-panel');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const h = document.elementFromPoint(r.x + 20, r.y + 20);
      return h !== null && el.contains(h);
    })(),
    nodes: qa('.ffc-node').map((n) => {
      const r = n.getBoundingClientRect();
      return {
        id: n.dataset.nodeId,
        selected: n.dataset.selected === 'true',
        box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        world: { x: parseFloat(n.style.left), y: parseFloat(n.style.top) },
      };
    }),
    buttons: {
      selectAll: btn('全选节点'),
      remove: btn('删除选中节点'),
      fit: btn('适应内容'),
      follow: btn('新节点自动带进视野'),
      clear: btn('清空画布'),
      width: btn('重置画布宽度'),
    },
    storage: {
      mode: window.localStorage.getItem('fatfish-canvas:view-mode'),
      follow: window.localStorage.getItem('fatfish-canvas:follow-new'),
      lastCanvas: window.localStorage.getItem('fatfish-canvas:last-canvas-mode'),
      scope: window.localStorage.getItem('fatfish-canvas:board-scope'),
    },
  });
})()`;

/** 三个离得很远的节点：适应内容必须真的改变缩放。 */
const SEED = JSON.stringify({
	version: 2,
	nodes: [
		{ id: 'p1', kind: 'image', x: 0, y: 0, w: 320, h: 320, z: 1, status: 'ready', src: 'data:,1', title: '一号', createdAt: 1 },
		{ id: 'p2', kind: 'image', x: 1800, y: 0, w: 320, h: 320, z: 2, status: 'ready', src: 'data:,2', title: '二号', createdAt: 2 },
		{ id: 'p3', kind: 'image', x: 900, y: 1400, w: 320, h: 320, z: 3, status: 'ready', src: 'data:,3', title: '三号', createdAt: 3 },
	],
	viewport: { x: 0, y: 0, zoom: 1 },
	ingested: [],
});

const browser = await launch();

/** 重新读一次页面事实。 */
const read = async () => JSON.parse(await evaluate(browser.cdp, PROBE));

/**
 * 切到指定视图模式 —— 用**不需要会话**的两条路径。
 *
 * P10 之后界面上只有两个模式开关：
 *   并排画布 ⟷ 纯画布   顶栏的「纯画布」按钮（任何模式下都在）
 *   聊天 ⟷ 上一次的画布模式  快捷键 Ctrl/⌘ + Shift + B
 * 而右上角的米饭碗入口是**会话作用域**（没有当前会话的欢迎页上不存在），
 * 所以这里刻意不用它 —— 入口自己的席位与单击语义由 e2e-entry.mjs 在真实会话里测。
 * @param target - `'chat' | 'canvas' | 'canvas-only'`。
 * @returns 切换后的页面事实。
 */
async function setMode(target) {
	for (let step = 0; step < 3; step += 1) {
		const s = await read();
		if (s.mode === target) return s;
		// 纯画布是唯一「不在并排/聊天二分里」的状态：先退出它
		if (s.mode === 'canvas-only') {
			if (s.onlyBtnCenter === null) return s;
			await click(browser.cdp, s.onlyBtnCenter.x, s.onlyBtnCenter.y);
		} else if (target === 'canvas-only') {
			if (s.onlyBtnCenter === null) return s;
			await click(browser.cdp, s.onlyBtnCenter.x, s.onlyBtnCenter.y);
		} else {
			await pressShortcut();
		}
		await sleep(520);
	}
	return read();
}

/** 派发一次 Ctrl+Shift+B（聊天 ⟷ 上一次的画布模式）。 */
async function pressShortcut() {
	const base = { key: 'B', code: 'KeyB', windowsVirtualKeyCode: 66, nativeVirtualKeyCode: 66, modifiers: 10 };
	await browser.cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyDown' });
	await browser.cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
	await sleep(460);
}

console.log(`\n肥鱼画布 · P4 端到端（工具条 / 纯画布 / 快捷键）\n目标：${URL_TARGET}\n`);

try {
	// ── 就位：种下三个节点、最窄画布宽度（40%，顶栏最容易溢出的那档）并进画布模式 ──
	let loaded = browser.cdp.once('Page.loadEventFired');
	await browser.cdp.send('Page.navigate', { url: URL_TARGET });
	await loaded;
	await evaluate(
		browser.cdp,
		`(() => {
			${seedBoardExpression(SEED)};
			window.localStorage.setItem('fatfish-canvas:view-mode', 'canvas');
			window.localStorage.setItem('fatfish-canvas:canvas-width', '40%');
			window.localStorage.removeItem('fatfish-canvas:follow-new');
			${PIN_SHARED_BOARD}
			return true;
		})()`,
	);
	loaded = browser.cdp.once('Page.loadEventFired');
	await browser.cdp.send('Page.reload', { ignoreCache: false });
	await loaded;
	await sleep(9000);

	let s = await read();
	check('画布模式已生效', s.mode === 'canvas', String(s.mode));
	check('种下的 3 个节点已渲染', s.nodes.length === 3, `实际 ${String(s.nodes.length)}`);
	check('画布面板铺在左侧（宽度 > 300）', num(s.panel?.w) > 300, JSON.stringify(s.panel));
	check(
		'画布宽度按存储里的 40% 生效（宽度预设已移除，但仍读同一个偏好键）',
		Math.abs(num(s.panel?.w) - 1680 * 0.4) < 40,
		`panel.w=${String(s.panel?.w)}`,
	);
	check('并排模式下 AppFrame 可见（display 不是 none）', s.frameDisplay !== 'none', String(s.frameDisplay));

	// ── 1. 工具条 ──
	console.log('1) 画布工具条');
	check(
		'工具条按钮齐全',
		Object.values(s.buttons).every((b) => b !== null),
		`缺失：${Object.keys(s.buttons).filter((k) => s.buttons[k] === null).join(',')}`,
	);
	check('空选中时「删除选中」是禁用的', s.buttons.remove?.disabled === true, String(s.buttons.remove?.disabled));
	check('有节点时「全选」可用', s.buttons.selectAll?.disabled === false);
	check('窄画布（40%）下工具条不溢出', s.toolbar?.overflow === false, JSON.stringify(s.toolbar));

	await click(browser.cdp, s.buttons.selectAll.x, s.buttons.selectAll.y);
	await sleep(240);
	s = await read();
	check(
		'点「全选」后 3 个节点都被选中',
		s.nodes.every((n) => n.selected === true),
		JSON.stringify(s.nodes.map((n) => n.selected)),
	);
	check('选中后「删除选中」变为可用', s.buttons.remove?.disabled === false);

	await click(browser.cdp, s.buttons.remove.x, s.buttons.remove.y);
	await sleep(280);
	s = await read();
	check('点「删除选中」后画布清空', s.nodes.length === 0, `实际 ${String(s.nodes.length)}`);

	// 重新种节点（顺带走一次真实重载，验证 store 反序列化）
	// ⚠️ 也要**保住账本**：这一步种完还会重载，账本一空最近生成就会补落回来
	// （本轮实测：这里漏改时后面「节点仍然渲染」数到 7 个而不是 3 个）
	await evaluate(browser.cdp, seedBoardExpression(SEED));
	loaded = browser.cdp.once('Page.loadEventFired');
	await browser.cdp.send('Page.reload', { ignoreCache: false });
	await loaded;
	await sleep(9000);
	s = await read();
	const zoomBeforeFit = num(s.zoom);
	await click(browser.cdp, s.buttons.fit.x, s.buttons.fit.y);
	await sleep(700);
	s = await read();
	const vp = s.viewport;
	const inside = s.nodes.every(
		(n) =>
			n.box.x >= vp.x - 2 &&
			n.box.y >= vp.y - 2 &&
			n.box.x + n.box.w <= vp.x + vp.w + 2 &&
			n.box.y + n.box.h <= vp.y + vp.h + 2,
	);
	check(
		'点「适应内容」后三个节点全部落入视口',
		inside,
		`zoom ${String(zoomBeforeFit)} -> ${String(s.zoom)} vp=${JSON.stringify(vp)} boxes=${JSON.stringify(s.nodes.map((n) => n.box))}`,
	);
	check(
		'适应内容真的改变了缩放（三个节点跨度很大）',
		num(s.zoom) < zoomBeforeFit,
		`${String(zoomBeforeFit)} -> ${String(s.zoom)}`,
	);

	check('跟焦按钮初始为按下（默认开）', s.buttons.follow?.pressed === 'true', String(s.buttons.follow?.pressed));
	await click(browser.cdp, s.buttons.follow.x, s.buttons.follow.y);
	await sleep(240);
	s = await read();
	check('点一下跟焦按钮 → 变为未按下', s.buttons.follow?.pressed === 'false', String(s.buttons.follow?.pressed));
	check('跟焦偏好写进 localStorage', s.storage.follow === 'off', String(s.storage.follow));
	await click(browser.cdp, s.buttons.follow.x, s.buttons.follow.y);
	await sleep(240);
	s = await read();
	check(
		'再点一下恢复开启',
		s.buttons.follow?.pressed === 'true' && s.storage.follow === 'on',
		`${String(s.buttons.follow?.pressed)}/${String(s.storage.follow)}`,
	);

	// ── 2. 顶栏（P10：视图菜单移除，纯画布独立，作用域读数自己就是开关） ──
	console.log('\n2) 顶栏：没有「视图」菜单，多了一个「纯画布」');
	s = await read();
	check('顶栏不再有「视图」菜单按钮', s.hasViewBtn === false);
	check('顶栏不再有宽菜单（视图模式 / 画布宽度选择已移除）', s.hasWideMenu === false && s.hasMenu === false);
	check(
		'顶栏有「纯画布」按钮，且并排模式下是未按下态',
		s.onlyBtn !== null && s.onlyBtnPressed === 'false',
		`rect=${JSON.stringify(s.onlyBtn)} pressed=${String(s.onlyBtnPressed)}`,
	);
	check('「纯画布」按钮可命中', s.onlyBtnHit === true, String(s.onlyBtnHit));

	// 作用域开关：原来在菜单里，现在就是顶栏那枚读数
	check(
		'作用域读数是可点的按钮，初始未按下（本套件把作用域钉在共用那块上）',
		s.scopeBtnCenter !== null && s.scopeBtnPressed === 'false' && s.scopeBtnHit === true,
		`rect=${JSON.stringify(s.scopeBtn)} pressed=${String(s.scopeBtnPressed)} 文本=${String(s.scopeBtnText)}`,
	);
	await click(browser.cdp, s.scopeBtnCenter.x, s.scopeBtnCenter.y);
	await sleep(520);
	s = await read();
	check('点作用域读数 → 打开按工作区分隔（偏好写盘）', s.storage.scope === 'workspace', String(s.storage.scope));
	check(
		'开关是双向的：按钮按下态与读数文本都跟着变',
		s.scopeBtnPressed === 'true',
		`pressed=${String(s.scopeBtnPressed)} 文本=${String(s.scopeBtnText)}`,
	);
	await click(browser.cdp, s.scopeBtnCenter.x, s.scopeBtnCenter.y);
	await sleep(520);
	s = await read();
	check('再点一次切回共用（不给后面留下会换画布键的残留偏好）', s.storage.scope === 'shared', String(s.storage.scope));

	// ── 3. 纯画布模式 ──
	console.log('\n3) 纯画布模式');
	s = await setMode('canvas-only');
	check('切到纯画布模式', s.mode === 'canvas-only', String(s.mode));
	check(
		'聊天/侧栏列被收起（frame 里除 overlay 之外的直接子元素都不渲染）',
		s.chatColumnsHidden === true,
		`children=${String(s.frameChildren)} hidden=${String(s.chatColumnsHidden)}`,
	);
	check(
		'overlay 层仍然渲染（画布面板没被一起藏掉）',
		s.overlayVisible === true,
		String(s.overlayVisible),
	);
	check('纯画布下顶栏「纯画布」按钮仍然命得中（白屏 bug 的回归守卫）', s.onlyBtnHit === true, String(s.onlyBtnHit));
	check('纯画布下按钮是按下态（读数说明现在正在纯画布里）', s.onlyBtnPressed === 'true', String(s.onlyBtnPressed));
	check('纯画布下画布面板仍然命得中', s.panelHit === true, String(s.panelHit));
	check(
		'画布铺满整个视口宽度',
		Math.abs(num(s.panel?.w) - num(s.viewport?.w)) < 4 && num(s.panel?.w) > 1000,
		`panel=${JSON.stringify(s.panel)} viewport=${JSON.stringify(s.viewport)}`,
	);
	check('纯画布模式下没有宽度拖拽条', s.resizer === null, JSON.stringify(s.resizer));
	check('纯画布模式下没有「重置宽度」按钮', s.buttons.width === null);
	check(
		'模式已持久化（并记住这是「上次用的画布模式」）',
		s.storage.mode === 'canvas-only' && s.storage.lastCanvas === 'canvas-only',
		`${String(s.storage.mode)}/${String(s.storage.lastCanvas)}`,
	);
	check('画布节点仍然渲染（切模式不动画布内容）', s.nodes.length === 3, `实际 ${String(s.nodes.length)}`);

	// 顶栏那格真的能退出纯画布（不只 Esc）
	await click(browser.cdp, s.onlyBtnCenter.x, s.onlyBtnCenter.y);
	await sleep(560);
	s = await read();
	check('点顶栏「纯画布」再点一次 → 回到并排画布', s.mode === 'canvas', String(s.mode));
	s = await setMode('canvas-only');
	check('重新进入纯画布（为 Esc 与刷新自救做准备）', s.mode === 'canvas-only', String(s.mode));

	// Esc 逃生梯：纯画布是最容易「看起来卡住」的模式，必须有一个人人会按的出口
	await browser.cdp.send('Input.dispatchKeyEvent', {
		type: 'keyDown',
		key: 'Escape',
		code: 'Escape',
		windowsVirtualKeyCode: 27,
		nativeVirtualKeyCode: 27,
	});
	await browser.cdp.send('Input.dispatchKeyEvent', {
		type: 'keyUp',
		key: 'Escape',
		code: 'Escape',
		windowsVirtualKeyCode: 27,
		nativeVirtualKeyCode: 27,
	});
	await sleep(420);
	s = await read();
	check('在纯画布下按 Esc 退回并排画布（不会卡在纯画布）', s.mode === 'canvas', String(s.mode));
	check('Esc 之后聊天列重新可见', s.chatColumnsHidden === false, String(s.chatColumnsHidden));

	// 刷新自救：即使存储里还留着纯画布，重新打开页面也不该白屏
	await setMode('canvas-only');
	s = await read();
	check('重新进入纯画布（为刷新自救做准备）', s.mode === 'canvas-only', String(s.mode));
	loaded = browser.cdp.once('Page.loadEventFired');
	await browser.cdp.send('Page.reload', { ignoreCache: false });
	await loaded;
	await sleep(9000);
	s = await read();
	check(
		'刷新后不落在纯画布（即使存储里写着 canvas-only，也降级成并排画布）',
		s.mode === 'canvas',
		String(s.mode),
	);
	check('刷新后画布面板与顶栏「纯画布」按钮都在', s.panel !== null && s.onlyBtnHit === true);
	check('刷新后节点仍在（持久化正常）', s.nodes.length === 3, `实际 ${String(s.nodes.length)}`);

	// ── 4. 快捷键 ──
	console.log('\n4) 快捷键 Ctrl/⌘ + Shift + B');
	await setMode('canvas-only');
	s = await read();
	check('从纯画布开始测快捷键', s.mode === 'canvas-only', String(s.mode));
	// 先把焦点从按钮上挪开（快捷键在输入框里让路）
	await click(browser.cdp, Math.round(s.viewport.x + s.viewport.w / 2), Math.round(s.viewport.y + 160));
	await sleep(260);
	await pressShortcut();
	s = await read();
	check('Ctrl+Shift+B：纯画布 → 聊天模式', s.mode === 'chat', String(s.mode));
	check('聊天模式下 AppFrame 恢复可见', s.frameDisplay !== 'none', String(s.frameDisplay));
	check('画布面板在聊天模式下不渲染', s.panel === null, JSON.stringify(s.panel));

	await pressShortcut();
	s = await read();
	check('再按一次回到上次用的画布模式（纯画布）', s.mode === 'canvas-only', String(s.mode));
	check('页面留下了切换痕迹（诊断用 dataset）', s.lastToggle === 'canvas-only', String(s.lastToggle));

	// 切回并排模式收尾：确认布局能完整恢复
	s = await setMode('canvas');
	check('切回并排模式', s.mode === 'canvas' && s.storage.mode === 'canvas', String(s.mode));
	check('AppFrame 恢复可见且有实际宽度', s.frameDisplay !== 'none' && num(s.frame?.w) > 200, JSON.stringify(s.frame));
	check(
		'聊天列回到了右侧（frame 起点不早于画布右缘）',
		num(s.frame?.x) >= num(s.panel?.w) - 6,
		`frame.x=${String(s.frame?.x)} panel.w=${String(s.panel?.w)}`,
	);

	// 清空按钮收尾
	await click(browser.cdp, s.buttons.clear.x, s.buttons.clear.y);
	await sleep(340);
	s = await read();
	check('点「清空」后画布为空', s.nodes.length === 0, `实际 ${String(s.nodes.length)}`);
	check(
		'清空后空态占位再次出现',
		(await evaluate(browser.cdp, "!!document.querySelector('.ffc-placeholder')")) === true,
	);

	const shot = await browser.cdp.send('Page.captureScreenshot', { format: 'png' });
	await writeFile(SHOT, Buffer.from(shot.data, 'base64'));
	console.log(`\n[e2e-p4] 截图：${SHOT}`);
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
