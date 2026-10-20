/**
 * P10 端到端：米饭碗回到右上角（不压 session log）· 一键往返 · 纯画布独立成顶栏一格。
 *
 * 覆盖本轮改的三件事，每一条都只有真实浏览器能回答：
 *
 *   1. **位置**：入口注册进 session log 住的**同一个席位**
 *      （`conversation.session.header.utilities`），因此断言
 *        - 入口落在视口右上角那块区域里，且在 session log **右边**（order 10 > 0）
 *        - 入口与 session log **不相交**，且 session log 自己**仍然可命中**
 *          （「不压住别人」不是「挪开几像素」，而是两者都在布局里各占一格）
 *        - 进入画布模式后入口**位置不变**（并排模式下聊天列右缘就是视口右缘）
 *   2. **一键往返**：聊天里单击 = 进画布；画布里单击 = 回聊天；
 *      文字与 aria-label 跟着换（图标始终是米饭碗）——没有菜单、没有第二层。
 *   3. **顶栏**：「视图」菜单整块移除（不再有视图模式 / 画布宽度选择），
 *      纯画布独立成一个按钮；窄画布（40%）下顶栏不溢出、控件不被压扁；
 *      纯画布模式里它是唯一出口，必须还点得到。**P49 起顶栏还常驻一格
 *      「返回聊天」**：入口住在会话作用域席位里，欢迎页整行不存在，那一格
 *      就是那时唯一的出口（真鼠标点一次，第 7 节）。
 *
 * 用法（需放宽沙箱：无头 Chrome 要创建命名管道）：
 *   node scripts/e2e-entry.mjs
 */

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PACKAGE_ROOT, PIN_SHARED_BOARD, click, evaluate, launch, sleep } from './lib/cdp.mjs';

const URL_TARGET = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080/';
const SHOT = resolve(PACKAGE_ROOT, 'lib/e2e-entry.png');

/** 入口在画布模式下的允许位移（px）：布局重排会有亚像素差异，但位置必须"没动过"。 */
const DRIFT_TOLERANCE = 6;

let failures = 0;
const results = [];
const check = (label, ok, detail = '') => {
	if (!ok) failures += 1;
	results.push(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail === '' ? '' : ` — ${detail}`}`);
};

/** 页面事实。 */
const PROBE = `(() => {
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right) }; };
  const center = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; };
  const text = (el) => (el ? (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60) : null);
  const cls = (el) => (el && typeof el.className === 'string' ? el.className.trim() : '');
  const intersects = (a, b) => a !== null && b !== null && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const hit = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); if (r.width === 0) return false; const h = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return h !== null && (h === el || el.contains(h)); };
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };

  // 会话头部**可见**的那一份 DOM（hero 里那份隐藏副本留在文档里，会骗过 querySelector）
  const visibles = (sel) => qa(sel).filter(visible);
  const entry = visibles('.ffc-entry')[0] ?? null;
  const logBtn = visibles('[class*="sessionLog"], [class*="session-log"]')[0] ?? null;
  const utilities = q('[class*="headerUtilities"]');
  const inUtilities = entry !== null && utilities !== null && utilities.contains(entry);

  // 视口右上角那一块（session log 与入口共同所在的区域）。
  // 只数**顶层**本插件元素：按钮内部的图标/文字 span 也带 ffc- 前缀，
  // 数进去只会把「一个按钮」误报成「两个东西」。
  const topLevelOwn = (el) => {
    for (let n = el.parentElement; n; n = n.parentElement) {
      if (/(^|\\s)ffc-/.test(cls(n))) return false;
    }
    return true;
  };
  const corner = { x: window.innerWidth - 260, y: 0, w: 260, h: 84 };
  const oursInCorner = qa('[class*="ffc-"]')
    .filter((el) => /(^|\\s)ffc-/.test(cls(el)) && visible(el) && topLevelOwn(el))
    .map((el) => ({ el, r: rect(el) }))
    .filter(({ r }) => intersects(r, corner))
    .map(({ el, r }) => ({ cls: cls(el).split(/\\s+/)[0], rect: r }));

  const bar = q('.ffc-toolbar');
  const barRect = rect(bar);
  const onlyBtn = qa('.ffc-toolbar button').find((b) => b.getAttribute('aria-label') === '纯画布模式') ?? null;
  // P49：顶栏那格「返回聊天」—— 没有当前会话（欢迎页）时右上角那枚入口不存在，
  // 它就是唯一的出口，所以它必须在、必须点得到。
  const backBtn = qa('.ffc-toolbar button').find((b) => b.getAttribute('aria-label') === '返回聊天界面') ?? null;
  const scopeBtn = q('[data-ffc-scope]');

  return JSON.stringify({
    mode: document.body.dataset.ffcMode ?? null,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    corner,
    oursInCorner,
    entry: rect(entry),
    entryVisibleCount: visibles('.ffc-entry').length,
    entryCount: qa('.ffc-entry').length,
    entryCenter: center(entry),
    entryLabel: entry ? entry.getAttribute('aria-label') : null,
    entryTitle: entry ? entry.getAttribute('title') : null,
    entryText: entry ? text(entry) : null,
    entryHit: hit(entry),
    entryInOverlay: entry ? entry.closest('[data-shell-overlay]') !== null : null,
    entryInUtilities: inUtilities,
    entryParent: entry && entry.parentElement ? entry.parentElement.tagName.toLowerCase() + '.' + cls(entry.parentElement).split(/\\s+/)[0] : null,
    logButton: rect(logBtn),
    logButtonText: text(logBtn),
    logHit: hit(logBtn),
    entryOverlapsLog: intersects(rect(entry), rect(logBtn)),
    hasViewBtn: qa('.ffc-view-btn').length > 0,
    hasWideMenu: qa('.ffc-menu-wide').length > 0,
    onlyBtn: rect(onlyBtn),
    onlyBtnCenter: center(onlyBtn),
    onlyBtnPressed: onlyBtn ? onlyBtn.getAttribute('aria-pressed') : null,
    onlyBtnHit: hit(onlyBtn),
    backBtn: rect(backBtn),
    backBtnCenter: center(backBtn),
    backBtnHit: hit(backBtn),
    backBtnText: text(backBtn),
    scopeBtnTag: scopeBtn ? scopeBtn.tagName.toLowerCase() : null,
    scopeBtnPressed: scopeBtn ? scopeBtn.getAttribute('aria-pressed') : null,
    // 图标事实：入口里那枚鲸鱼尾巴（静止 = 实心；悬停 = 换成会摇的 APNG 遮罩）。
    // 状态判据是**动图那枚的 display**（静止 none / 摇 block）—— 不能再比遮罩字符串
    // 长度：遮罩一直挂在动图那枚身上，两种状态下长度一样。
    whale: (() => {
      const el = visibles('.ffc-entry .ffc-whale')[0];
      if (el === undefined) return null;
      const still = el.querySelector('.ffc-whale-still');
      const anim = el.querySelector('.ffc-whale-anim');
      const path = still ? still.querySelector('path') : null;
      const r = el.getBoundingClientRect();
      return {
        box: { w: Math.round(r.width), h: Math.round(r.height) },
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        stillDisplay: still ? getComputedStyle(still).display : null,
        animDisplay: anim ? getComputedStyle(anim).display : null,
        animMaskLen: anim ? (getComputedStyle(anim).maskImage || '').length : 0,
        // 填充色 / 描边色 = currentColor 落到的具体色值，应当与按钮的 color 一致（跟主题）
        fill: path ? getComputedStyle(path).fill : null,
        stroke: path ? getComputedStyle(path).stroke : null,
        entryColor: getComputedStyle(el.closest('.ffc-entry') || el).color,
      };
    })(),
    padWidth: q('[class*="composer"] .ffc-entry') ? rect(q('[class*="composer"] .ffc-entry')) : null,
    toolbar: bar ? { w: Math.round(barRect.w), right: barRect.right, overflow: bar.scrollWidth > bar.clientWidth + 1, clipped: Array.from(bar.children).filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => cls(el).split(/\\s+/)[0]) } : null,
    panel: rect(q('.ffc-panel')),
    chatColumnsHidden: (() => {
      const frame = q('[data-ffc-frame]');
      if (!frame) return null;
      const others = Array.from(frame.children).filter((el) => el.getAttribute('data-shell-overlay') === null);
      return others.length > 0 && others.every((el) => getComputedStyle(el).display === 'none');
    })(),
    sessionRows: qa('div[class*="sessionRow"]').map((el) => ({ text: text(el), center: center(el), kids: el.children.length })),
  });
})()`;

const browser = await launch();
const read = async () => JSON.parse(await evaluate(browser.cdp, PROBE));

/**
 * 打开一个**正常**的真实会话（入口与会话头部都在这类会话里存在）。
 *
 * 侧边栏里可能排着「等待审批」的会话：那种会话的 composer 被审批 UI 接管，
 * 而且它的头部也不带 session log，拿它会得到一堆假红。逐个试到合适的为止。
 * @returns 打开的会话文案；全都不可用时为 null。
 */
async function openRealSession() {
	const s = await read();
	const candidates = s.sessionRows.filter(
		(row) => row.kids >= 4 && row.text !== null && !row.text.includes('新会话') && !row.text.includes('等待审批'),
	);
	for (const row of candidates.slice(0, 3)) {
		await click(browser.cdp, row.center.x, row.center.y);
		await sleep(3000);
		const after = await read();
		if (after.entryVisibleCount > 0 && after.logButton !== null) return row.text;
	}
	return null;
}

console.log(`\n肥鱼画布 · P10 端到端（米饭碗在右上角 / 一键往返 / 纯画布独立成顶栏一格）\n目标：${URL_TARGET}\n`);

try {
	// ── 就位：聊天模式 + 最窄画布宽度（顶栏最容易溢出的那档） ──
	let loaded = browser.cdp.once('Page.loadEventFired');
	await browser.cdp.send('Page.navigate', { url: URL_TARGET });
	await loaded;
	await evaluate(
		browser.cdp,
		`(() => {
			window.localStorage.setItem('fatfish-canvas:view-mode', 'chat');
			window.localStorage.setItem('fatfish-canvas:canvas-width', '40%');
			window.localStorage.setItem('fatfish-canvas:last-canvas-mode', 'canvas');
			${PIN_SHARED_BOARD}
			return true;
		})()`,
	);
	loaded = browser.cdp.once('Page.loadEventFired');
	await browser.cdp.send('Page.reload', { ignoreCache: false });
	await loaded;
	await sleep(9000);

	// ── 0. 打开真实会话：会话头部（入口与 session log）只有这时才存在 ──
	console.log('0) 打开一个真实会话');
	const opened = await openRealSession();
	check('打开了一个正常会话（入口与会话头部都在）', opened !== null, String(opened));
	let s = await read();
	check('聊天模式已生效', s.mode === 'chat', String(s.mode));
	check('入口按钮渲染且可见', s.entry !== null && s.entry.w > 0, JSON.stringify(s.entry));
	check('session log 按钮渲染出来了（说明会话头部真的挂上了）', s.logButton !== null && s.logButton.w > 0, `${JSON.stringify(s.logButton)} / ${String(s.logButtonText)}`);

	// ── 1. 位置：右上角，且与 session log 各占一格 ──
	console.log('\n1) 入口在右上角（与 session log 同一席位，各占一格）');
	s = await read();
	const chatEntry = s.entry;
	check(
		'入口落在视口右上角区域里',
		chatEntry !== null && chatEntry.x + chatEntry.w >= s.viewport.w - 260 && chatEntry.y < 60,
		`entry=${JSON.stringify(chatEntry)} viewport=${JSON.stringify(s.viewport)}`,
	);
	check(
		'入口在 session log **右边**（order 10 > session log 的 0）',
		chatEntry !== null && s.logButton !== null && chatEntry.x >= s.logButton.x + s.logButton.w,
		`entry.x=${String(chatEntry?.x)} log.right=${String(s.logButton?.x + s.logButton?.w)}`,
	);
	check('入口与 session log 不相交', s.entryOverlapsLog === false, `entry=${JSON.stringify(chatEntry)} log=${JSON.stringify(s.logButton)}`);
	check('session log 自己仍然可命中（入口没有压在它上面）', s.logHit === true, String(s.logHit));
	check(
		'入口就在 Session utilities 那一行里（与 session log 同一父容器）',
		s.entryInUtilities === true,
		`父链：${String(s.entryParent)}`,
	);
	check('入口不是浮层按钮（不在 shell.overlay 里）', s.entryInOverlay === false);
	check(
		'入口是**唯一**一个右上角的本插件元素（没有第二份副本）',
		s.oursInCorner.length === 1 && s.oursInCorner[0]?.cls === 'ffc-entry',
		JSON.stringify(s.oursInCorner),
	);
	check('入口可见且可命中（没被别的层挡住）', s.entryHit === true, String(s.entryHit));
	check(
		'聊天模式下入口说明自己是「进入肥鱼画布」，并带上快捷键提示',
		s.entryLabel === '进入肥鱼画布' &&
			String(s.entryTitle).includes('进入肥鱼画布') &&
			String(s.entryTitle).includes('Shift + B'),
		`${String(s.entryLabel)} / ${String(s.entryTitle)}`,
	);
	check(
		'入口只有鲸鱼尾巴图形（没有「画布 / 聊天」任何字样）',
		s.entryText === '',
		`textContent=${JSON.stringify(s.entryText)}`,
	);
	check('入口不再占用 composer 工具行（那一行里没有它）', s.padWidth === null, JSON.stringify(s.padWidth));

	// ── 2. 单击 = 进画布，且位置不变 ──
	console.log('\n2) 单击进画布：位置不变，语义变成「返回聊天」');
	await click(browser.cdp, s.entryCenter.x, s.entryCenter.y);
	await sleep(1000);
	s = await read();
	const canvasEntry = s.entry;
	check('单击入口后进入并排画布', s.mode === 'canvas', String(s.mode));
	check('进入画布后入口**仍然渲染**（不再让位）', canvasEntry !== null && canvasEntry.w > 0, JSON.stringify(canvasEntry));
	check(
		`进入画布后入口位置不变（位移 ≤ ${String(DRIFT_TOLERANCE)}px）`,
		canvasEntry !== null &&
			Math.abs(canvasEntry.x - chatEntry.x) <= DRIFT_TOLERANCE &&
			Math.abs(canvasEntry.y - chatEntry.y) <= DRIFT_TOLERANCE,
		`chat=${JSON.stringify(chatEntry)} canvas=${JSON.stringify(canvasEntry)}`,
	);
	check(
		'画布模式下入口语义变成「返回聊天界面」（图形与位置都不变）',
		s.entryLabel === '返回聊天界面' && String(s.entryTitle).includes('返回聊天') && s.entryText === '',
		`${String(s.entryLabel)} / ${JSON.stringify(s.entryText)}`,
	);
	check('画布模式下入口仍与 session log 不相交', s.entryOverlapsLog === false, `entry=${JSON.stringify(canvasEntry)} log=${JSON.stringify(s.logButton)}`);
	check('画布模式下 session log 仍可命中', s.logHit === true, String(s.logHit));

	// ── 3. 顶栏：视图菜单没了，纯画布独立成按钮 ──
	console.log('\n3) 画布顶栏：没有「视图」菜单，多了一个「纯画布」');
	check('顶栏不再有「视图」菜单按钮', s.hasViewBtn === false);
	check('顶栏不再有宽菜单（视图模式 / 画布宽度选择已移除）', s.hasWideMenu === false);
	check(
		'顶栏有「纯画布」按钮，且在并排模式下是未按下态',
		s.onlyBtn !== null && s.onlyBtnPressed === 'false',
		`rect=${JSON.stringify(s.onlyBtn)} pressed=${String(s.onlyBtnPressed)}`,
	);
	check('「纯画布」按钮可命中', s.onlyBtnHit === true, String(s.onlyBtnHit));
	check(
		'作用域读数是可点的按钮（原来的菜单开关换了个家）',
		s.scopeBtnTag === 'button' && (s.scopeBtnPressed === 'true' || s.scopeBtnPressed === 'false'),
		`tag=${String(s.scopeBtnTag)} pressed=${String(s.scopeBtnPressed)}`,
	);
	check(
		'窄画布（40%）下顶栏不溢出、没有控件被压扁',
		s.toolbar !== null && s.toolbar.overflow === false && s.toolbar.clipped.length === 0,
		JSON.stringify(s.toolbar),
	);

	// ── 4. 纯画布：顶栏那两格是出口，必须还点得到 ──
	console.log('\n4) 纯画布模式：顶栏的「纯画布」与「返回聊天」是出口');
	const onlyCenter = s.onlyBtnCenter;
	await click(browser.cdp, onlyCenter.x, onlyCenter.y);
	await sleep(900);
	s = await read();
	check('点「纯画布」→ 进入纯画布模式', s.mode === 'canvas-only', String(s.mode));
	check('纯画布下聊天列被收起', s.chatColumnsHidden === true, String(s.chatColumnsHidden));
	check('纯画布下画布铺满（面板宽度 ≈ 视口宽度）', Math.abs((s.panel?.w ?? 0) - s.viewport.w) < 4, `panel=${JSON.stringify(s.panel)}`);
	check(
		'纯画布下入口按钮不可见（整列聊天被收起，头部跟着不在）',
		s.entryVisibleCount === 0 && s.entry === null,
		`可见 ${String(s.entryVisibleCount)} 个 / DOM 里 ${String(s.entryCount)} 个（隐藏副本）`,
	);
	check(
		'纯画布下「纯画布」按钮仍在且可命中（白屏 bug 的回归守卫）',
		s.onlyBtn !== null && s.onlyBtnHit === true && s.onlyBtnPressed === 'true',
		`hit=${String(s.onlyBtnHit)} pressed=${String(s.onlyBtnPressed)} center=${JSON.stringify(s.onlyBtnCenter)}`,
	);
	// P49：这里就是用户报的那个状态 —— 入口按钮看不见（没有会话头部）。
	// 出口必须跟着画布自己走，所以顶栏这一格在纯画布下也要在、也要点得到。
	check(
		'入口按钮看不见时，顶栏「返回聊天」仍在且可命中（这就是那个「退不出去」的回归守卫）',
		s.backBtn !== null && s.backBtnHit === true,
		`rect=${JSON.stringify(s.backBtn)} hit=${String(s.backBtnHit)} text=${JSON.stringify(s.backBtnText)}`,
	);
	check(
		'纯画布下顶栏同样不溢出',
		s.toolbar !== null && s.toolbar.overflow === false && s.toolbar.clipped.length === 0,
		JSON.stringify(s.toolbar),
	);

	// 再点一次：退回并排画布（聊天列回来、入口跟着回来）
	await click(browser.cdp, s.onlyBtnCenter.x, s.onlyBtnCenter.y);
	await sleep(900);
	s = await read();
	check('再点一次「纯画布」→ 回到并排画布', s.mode === 'canvas', String(s.mode));
	check('回到并排后聊天列重新可见', s.chatColumnsHidden === false, String(s.chatColumnsHidden));
	check('回到并排后入口按钮又出现，且仍在右上角原位', s.entry !== null && Math.abs(s.entry.x - chatEntry.x) <= DRIFT_TOLERANCE, JSON.stringify(s.entry));

	// ── 5. 单击 = 回聊天 ──
	console.log('\n5) 画布里单击入口 = 回聊天');
	s = await read();
	await click(browser.cdp, s.entryCenter.x, s.entryCenter.y);
	await sleep(900);
	s = await read();
	check('画布里单击入口 → 回到聊天模式', s.mode === 'chat', String(s.mode));
	check(
		'回到聊天后入口语义变回「进入肥鱼画布」',
		s.entryLabel === '进入肥鱼画布' && s.entryText === '',
		`${String(s.entryLabel)} / ${JSON.stringify(s.entryText)}`,
	);
	check(
		'回到聊天后入口位置仍然没变',
		s.entry !== null && Math.abs(s.entry.x - chatEntry.x) <= DRIFT_TOLERANCE && Math.abs(s.entry.y - chatEntry.y) <= DRIFT_TOLERANCE,
		`${JSON.stringify(s.entry)} vs ${JSON.stringify(chatEntry)}`,
	);

	// ── 6. 图标：鲸鱼尾巴（静止 ⟷ 悬停摇尾巴） ──
	console.log('\n6) 图标是 DSH 原生那枚鲸鱼尾巴（颜色跟主题；放上去才摇）');

	// 先把指针挪开：上一节刚在入口上点过一下，指针还停在它身上，
	// 那会让下面「静止态」的断言读到悬停态（假红）。
	await browser.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 20, y: 400, buttons: 0 });
	await sleep(300);
	s = await read();
	const idleIcon = s.whale;
	check(
		'入口里是鲸鱼尾巴（ffc-whale），且是 17×17 的正方（老位图是 1152:976，会在这里露馅）',
		idleIcon !== null && idleIcon.box.w === 17 && idleIcon.box.h === 17,
		JSON.stringify(idleIcon),
	);
	check(
		'颜色走 currentColor：填充与描边都 = 按钮的 color（浅色主题下才会是深色，写死白色就瞎了）',
		idleIcon !== null &&
			idleIcon.fill !== null &&
			idleIcon.fill === idleIcon.entryColor &&
			idleIcon.stroke === idleIcon.entryColor,
		`fill ${String(idleIcon?.fill)} / stroke ${String(idleIcon?.stroke)} vs color ${String(idleIcon?.entryColor)}`,
	);
	check(
		'没碰它的时候是静止态：实心那枚在、会摇的那枚 display:none',
		idleIcon !== null && idleIcon.stillDisplay !== 'none' && idleIcon.animDisplay === 'none',
		`still ${String(idleIcon?.stillDisplay)} / anim ${String(idleIcon?.animDisplay)}`,
	);

	// 悬停：只移动指针，**不点击** —— 用户要的就是这一条
	await browser.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: s.entryCenter.x, y: s.entryCenter.y, buttons: 0 });
	await sleep(400);
	s = await read();
	const hoverIcon = s.whale;
	check(
		'鼠标放上去（不点击）就换成会摇的那枚（实心动画的遮罩）',
		hoverIcon !== null && hoverIcon.animDisplay === 'block' && hoverIcon.animMaskLen > 5000,
		`anim ${String(hoverIcon?.animDisplay)} / 遮罩 ${String(hoverIcon?.animMaskLen)} 字符`,
	);
	check(
		'悬停时静止那枚让位（两枚都画就是重影）',
		hoverIcon !== null && hoverIcon.stillDisplay === 'none',
		String(hoverIcon?.stillDisplay),
	);
	const wagFrames = [];
	if (hoverIcon !== null) {
		for (let i = 0; i < 5; i += 1) {
			const shot = await browser.cdp.send('Page.captureScreenshot', {
				format: 'png',
				clip: { x: hoverIcon.rect.x, y: hoverIcon.rect.y, width: hoverIcon.rect.w, height: hoverIcon.rect.h, scale: 2 },
			});
			wagFrames.push(Buffer.from(shot.data, 'base64').toString('base64'));
			await sleep(120);
		}
	}
	check(
		'悬停时它真的在摇（真实时钟下 5 张截图里不止一种画面）',
		new Set(wagFrames).size >= 2,
		`不同帧 ${String(new Set(wagFrames).size)}/5`,
	);

	// 指针移开：回到静止态（不然它会在没人看的时候一直摇）
	await browser.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 20, y: 400, buttons: 0 });
	await sleep(300);
	s = await read();
	check(
		'指针移开后回到静止态（实心那枚回来、动图那枚收掉）',
		s.whale !== null && s.whale.animDisplay === 'none' && s.whale.stillDisplay !== 'none',
		`anim ${String(s.whale?.animDisplay)} / still ${String(s.whale?.stillDisplay)}`,
	);

	// ── 7. P49：顶栏那格「返回聊天」真鼠标点一次 ──
	// 它是「入口按钮不存在时」的出口（那个席位是会话作用域，欢迎页整行不渲染），
	// 因此必须能被真鼠标点到 —— 冒烟测试只调了 onClick，那是替身，不是浏览器。
	console.log('\n7) 顶栏「返回聊天」：真鼠标点一次就回聊天');
	await click(browser.cdp, s.entryCenter.x, s.entryCenter.y);
	await sleep(900);
	s = await read();
	check('（就位）从聊天进了并排画布', s.mode === 'canvas', String(s.mode));
	await click(browser.cdp, s.backBtnCenter.x, s.backBtnCenter.y);
	await sleep(900);
	s = await read();
	check('点顶栏「返回聊天」→ 回到聊天模式', s.mode === 'chat', String(s.mode));
	check(
		'回到聊天后那一格随画布面板一起收起（它属于画布，不属于聊天）',
		s.backBtn === null,
		JSON.stringify(s.backBtn),
	);

	const shot = await browser.cdp.send('Page.captureScreenshot', { format: 'png' });
	await writeFile(SHOT, Buffer.from(shot.data, 'base64'));
	console.log(`\n截图：${SHOT}`);
} catch (error) {
	check('脚本执行未抛错', false, String(error));
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
