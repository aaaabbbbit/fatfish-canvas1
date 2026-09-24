/**
 * P10 端到端：米饭碗回到右上角（不压行内邻居）· 一键往返 · 纯画布独立成顶栏一格。
 *
 * 覆盖本轮改的三件事，每一条都只有真实浏览器能回答：
 *
 *   1. **位置**：入口注册进会话头部那一行（`conversation.session.header.utilities`），因此断言
 *        - 入口落在视口右上角那块区域里，且在**同行邻居**右边（order 10 > 0）
 *        - 入口与同行邻居**不相交**，且邻居自己**仍然可命中**
 *          （「不压住别人」不是「挪开几像素」，而是两者都在布局里各占一格）
 *        - 进入画布模式后入口**位置不变**（并排模式下聊天列右缘就是视口右缘）
 *   2. **一键往返**：聊天里单击 = 进画布；画布里单击 = 回聊天；
 *      文字与 aria-label 跟着换（图标始终是米饭碗）——没有菜单、没有第二层。
 *   3. **顶栏**：「视图」菜单整块移除（不再有视图模式 / 画布宽度选择），
 *      纯画布独立成一个按钮；窄画布（40%）下顶栏不溢出、控件不被压扁；
 *      纯画布模式里它是唯一出口，必须还点得到。
 *
 * ⚠️ **锚点为什么从「session log」改成「同行邻居」**（P26）：那条断言原来锚在平台的
 * `sessionLog` 控件上，而新版 dsh（0.1.5-rc.3）里那个控件**整个不存在了**（全文档搜
 * `[class*="sessionLog"]` 为空）→ 5 条断言集体假红。改成「那一行里本插件之外的**最后一个**
 * 控件」：要守的不变量（同一行、各占一格、都不被压）与**具体是哪个平台控件**无关，
 * 平台下次再改名/换控件也不会连累这条 e2e（教训见 NOTES §8.37）。
 *
 * 用法（需放宽沙箱：无头 Chrome 要创建命名管道）：
 *   node scripts/e2e-entry.mjs
 */

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PACKAGE_ROOT, RESET_BOARD_PREFS, click, evaluate, launch, sleep } from './lib/cdp.mjs';

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
  const utilities = q('[class*="headerUtilities"]');
  // 同行邻居 = 那一行里**本插件之外**的最后一个控件（入口现在排在这一行的末尾）。
  // 不再锚平台的具体控件（session log 在新版 dsh 里已经不存在），见文件头的说明。
  const neighbourOf = () => {
    if (utilities === null) return null;
    const others = Array.from(utilities.querySelectorAll('button, a, [role="button"]')).filter(
      (el) => el.closest('.ffc-entry') === null && !/(^|\\s)ffc-/.test(cls(el)),
    );
    return others[others.length - 1] ?? null;
  };
  const neighbour = neighbourOf();
  const inUtilities = entry !== null && utilities !== null && utilities.contains(entry);

  // 视口右上角那一块（会话头部那一行与入口共同所在的区域）。
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
    /** 行内邻居（入口的锚点）：位置、文案、能不能被点到。 */
    neighbour: rect(neighbour),
    neighbourLabel: neighbour ? neighbour.getAttribute('aria-label') : null,
    neighbourHit: hit(neighbour),
    entryOverlapsNeighbour: intersects(rect(entry), rect(neighbour)),
    hasViewBtn: qa('.ffc-view-btn').length > 0,
    hasWideMenu: qa('.ffc-menu-wide').length > 0,
    onlyBtn: rect(onlyBtn),
    onlyBtnCenter: center(onlyBtn),
    onlyBtnPressed: onlyBtn ? onlyBtn.getAttribute('aria-pressed') : null,
    onlyBtnHit: hit(onlyBtn),
    scopeBtnTag: scopeBtn ? scopeBtn.tagName.toLowerCase() : null,
    scopeBtnPressed: scopeBtn ? scopeBtn.getAttribute('aria-pressed') : null,
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
 * 而且它的头部也不带那一行 utilities（找不到行内邻居），拿它会得到一堆假红。逐个试到合适的为止。
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
		if (after.entryVisibleCount > 0 && after.neighbour !== null) return row.text;
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
			${RESET_BOARD_PREFS}
			return true;
		})()`,
	);
	loaded = browser.cdp.once('Page.loadEventFired');
	await browser.cdp.send('Page.reload', { ignoreCache: false });
	await loaded;
	await sleep(9000);

	// ── 0. 打开真实会话：会话头部那一行（入口与它的行内邻居）只有这时才存在 ──
	console.log('0) 打开一个真实会话');
	const opened = await openRealSession();
	check('打开了一个正常会话（入口与会话头部都在）', opened !== null, String(opened));
	let s = await read();
	check('聊天模式已生效', s.mode === 'chat', String(s.mode));
	check('入口按钮渲染且可见', s.entry !== null && s.entry.w > 0, JSON.stringify(s.entry));
	check(
		'会话头部那一行渲染出来了（找到入口的行内邻居，说明头部真的挂上了）',
		s.neighbour !== null && s.neighbour.w > 0,
		`邻居=${String(s.neighbourLabel)} ${JSON.stringify(s.neighbour)}`,
	);

	// ── 1. 位置：右上角，且与行内邻居各占一格 ──
	console.log('\n1) 入口在右上角（与行内邻居同一行，各占一格）');
	s = await read();
	const chatEntry = s.entry;
	check(
		'入口落在视口右上角区域里',
		chatEntry !== null && chatEntry.x + chatEntry.w >= s.viewport.w - 260 && chatEntry.y < 60,
		`entry=${JSON.stringify(chatEntry)} viewport=${JSON.stringify(s.viewport)}`,
	);
	check(
		`入口在行内邻居（${String(s.neighbourLabel)}）**右边**（order 10 > 它们的 0）`,
		chatEntry !== null && s.neighbour !== null && chatEntry.x >= s.neighbour.x + s.neighbour.w,
		`entry.x=${String(chatEntry?.x)} neighbour.right=${String(s.neighbour?.x + s.neighbour?.w)}`,
	);
	check(
		'入口与行内邻居不相交',
		s.entryOverlapsNeighbour === false,
		`entry=${JSON.stringify(chatEntry)} neighbour=${JSON.stringify(s.neighbour)}`,
	);
	check(
		`行内邻居（${String(s.neighbourLabel)}）自己仍然可命中（入口没有压在它上面）`,
		s.neighbourHit === true,
		String(s.neighbourHit),
	);
	check(
		'入口就在会话头部那一行里（与行内邻居同一父容器）',
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
		'入口只有米饭碗图形（没有「画布 / 聊天」任何字样）',
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
	check(
		'画布模式下入口仍与行内邻居不相交',
		s.entryOverlapsNeighbour === false,
		`entry=${JSON.stringify(canvasEntry)} neighbour=${JSON.stringify(s.neighbour)}`,
	);
	check('画布模式下行内邻居仍可命中', s.neighbourHit === true, String(s.neighbourHit));

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

	// ── 4. 纯画布：顶栏那格是唯一出口，必须还点得到 ──
	console.log('\n4) 纯画布模式：顶栏的「纯画布」按钮是唯一出口');
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
