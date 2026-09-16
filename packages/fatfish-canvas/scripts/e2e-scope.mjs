/**
 * P7 端到端：画布按会话隔离（真实浏览器 + 真实点击）。
 *
 * 离线测试能证明「作用域换了键、画布没丢」，但有一件事只有真实 GUI 能证明：
 * **工具条上那枚读数点得动、点完真的换了画布**（P10 之前这项在「视图」菜单里，
 * 现在读数自己就是开关）。链路是
 * 读数按钮 → `state` 偏好 → `scope.applyBoardScope` → `store.setBoardScope`，
 * 外加桥报来的会话 id；任何一环没接上，离线测试都照样全绿。
 *
 * 覆盖：
 *   1. 默认共用：工具条读数是「共用画布」，关掉开关时什么都不换
 *   2. 打开隔离：读数变「本会话画布」，出现 **一个** 会话作用域的键，
 *      且它带着原来的画布（adopt —— 用户看不到「画布突然空了」）
 *   3. 键名必须是完整的会话 id（`session-<uuid>`）：削掉前缀会静默落到
 *      别的会话上，是这块功能最容易犯又最看不见的错
 *   4. 关掉隔离：回到共用那块（内容原样），会话那块**保留**在存储里
 *      （下次打开还能回来），刷新之后偏好仍然记得
 *
 * 用法（需放宽沙箱：无头 Chrome 要创建命名管道）：
 *   node scripts/e2e-scope.mjs
 */

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PACKAGE_ROOT, click, evaluate, launch, sleep } from './lib/cdp.mjs';

const URL_TARGET = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080/';
const SHOT = resolve(PACKAGE_ROOT, 'lib/e2e-scope.png');

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
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const center = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; };
  const badge = q('.ffc-toolbar [data-ffc-scope]');
  // 工具条布局体检：多了一个常驻徽标，窄画布下会不会把控件挤出去 / 压没。
  // flex 容器不会自动换行，被挤到的控件是**静默**变形或溢出的，不上真实浏览器量不出来。
  const toolbar = (() => {
    const bar = q('.ffc-toolbar');
    if (!bar) return null;
    const br = bar.getBoundingClientRect();
    const kids = Array.from(bar.children).map((el) => {
      const r = el.getBoundingClientRect();
      return {
        cls: String(el.className || '').split(/\\s+/)[0],
        right: Math.round(r.right),
        w: Math.round(r.width),
        clipped: el.scrollWidth > el.clientWidth + 1,
      };
    });
    const bR = badge ? badge.getBoundingClientRect() : null;
    return {
      w: Math.round(br.width),
      barRight: Math.round(br.right),
      overflow: bar.scrollWidth > bar.clientWidth + 1,
      lastRight: kids.length > 0 ? kids[kids.length - 1].right : null,
      clipped: kids.filter((k) => k.clipped).map((k) => k.cls),
      sameLine: new Set(kids.map((k) => k.right)).size === kids.length,
      badgeVisible: bR !== null && bR.width > 0 && bR.height > 0,
      badgeHit: bR
        ? (() => {
            const hit = document.elementFromPoint(bR.x + bR.width / 2, bR.y + bR.height / 2);
            return hit !== null && badge.contains(hit);
          })()
        : null,
    };
  })();
  // 存储里所有「画布」键：全局那个无后缀，会话作用域的那块带 :session-…。
  // ⚠️ 前缀必须带冒号：fatfish-canvas:board-scope（偏好）也以
  // fatfish-canvas:board 开头，用不带冒号的前缀筛会把偏好键当成一块画布。
  const keys = Object.keys(window.localStorage).filter((k) => k.indexOf('fatfish-canvas:board') === 0).sort();
  const scoped = keys.filter((k) => k.indexOf('fatfish-canvas:board:') === 0);
  return JSON.stringify({
    mode: document.body.dataset.ffcMode ?? null,
    // P10：作用域开关从「视图」菜单搬到了工具条那枚读数上（读数自己就是按钮）
    scopeBadge: badge
      ? {
          scope: badge.getAttribute('data-ffc-scope'),
          text: (badge.textContent || '').trim(),
          title: badge.getAttribute('title'),
          tag: badge.tagName.toLowerCase(),
          pressed: badge.getAttribute('aria-pressed'),
          center: center(badge),
          hit: (() => {
            const r = badge.getBoundingClientRect();
            const hitEl = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            return hitEl !== null && badge.contains(hitEl);
          })(),
        }
      : null,
    toolbar,
    boardNodes: qa('.ffc-node').map((n) => n.dataset.nodeId),
    storage: {
      pref: window.localStorage.getItem('fatfish-canvas:board-scope'),
      keys,
      scoped,
      // 会话候选（本地记录）：用来交叉核对键后缀确实是当前会话的 id
      current: window.localStorage.getItem('dsh.sessions.current'),
    },
    // 会话 id 的页面内独立来源（若宿主把当前会话挂在了 DOM 上）
    domSession: (() => {
      const el = q('[data-session-id]') || q('[data-session]');
      return el ? (el.getAttribute('data-session-id') || el.getAttribute('data-session')) : null;
    })(),
  });
})()`;

/** 种下的共用画布：一个节点，用来观察「切换会不会把画布弄丢」。 */
const SEED = JSON.stringify({
	version: 2,
	nodes: [
		{
			id: 'kept',
			kind: 'image',
			x: 0,
			y: 0,
			w: 320,
			h: 320,
			z: 1,
			status: 'ready',
			src: 'data:,kept',
			title: '共用画布上的鱼',
			createdAt: 1,
		},
	],
	viewport: { x: 0, y: 0, zoom: 1 },
	ingested: [],
});

const browser = await launch();
const read = async () => JSON.parse(await evaluate(browser.cdp, PROBE));

/**
 * 点一次作用域读数（P10 起那枚读数自己就是开关）。
 * @returns 点击后的页面事实。
 */
async function toggleScope() {
	const s = await read();
	if (s.scopeBadge?.center == null) throw new Error('工具条里没有作用域读数（开关不在）');
	await click(browser.cdp, s.scopeBadge.center.x, s.scopeBadge.center.y);
	await sleep(420); // 换画布 + 图钉去抖写盘
	return read();
}

console.log(`\n肥鱼画布 · P7 端到端（画布按会话隔离）\n目标：${URL_TARGET}\n`);

try {
	// ── 就位：清掉上一轮留下的会话画布，种下共用画布，进画布模式 ──
	let loaded = browser.cdp.once('Page.loadEventFired');
	await browser.cdp.send('Page.navigate', { url: URL_TARGET });
	await loaded;
	await evaluate(
		browser.cdp,
		`(() => {
			// ⚠️ 先把**全局那块**的落图账本读出来 —— 下面会把所有画布键删掉
			// （包括别的套件留下的会话画布，这是有意隔离），但账本不能跟着丢：
			// 账本一空，「最近结果补落」（INGEST_FRESH_MS = 10 分钟）就会把同一个
			// 会话里刚跑过的 /generate 节点**又造回画布**，后面所有数节点的断言
			// 都会莫名其妙多出几个（本轮实测：e2e-p4 数到 7 个而不是 3 个）。
			let ledger = [];
			try {
				const prev = JSON.parse(window.localStorage.getItem('fatfish-canvas:board') || 'null');
				if (prev !== null && Array.isArray(prev.ingested)) ledger = prev.ingested;
			} catch {
				/* 坏数据按空账本处理 */
			}
			for (const k of Object.keys(window.localStorage)) {
				if (k.indexOf('fatfish-canvas:board:') === 0) window.localStorage.removeItem(k);
			}
			// ⚠️ 这里**不要**再 JSON.stringify(SEED)：SEED 本身就是 JSON 字符串，
			// 再 stringify 一次会写成「一个 JSON 字符串」→ store 反序列化出字符串
			// （typeof !== 'object'）→ 回退成空画布，种下的节点一个都不见。
			const seed = ${SEED};
			seed.ingested = ledger;
			window.localStorage.setItem('fatfish-canvas:board', JSON.stringify(seed));
			window.localStorage.setItem('fatfish-canvas:view-mode', 'canvas');
			// 固定成**最窄**的画布宽度：常驻徽标挤爆工具条这件事只在窄的时候发生
			window.localStorage.setItem('fatfish-canvas:canvas-width', '40%');
			window.localStorage.removeItem('fatfish-canvas:board-scope');
			return true;
		})()`,
	);
	loaded = browser.cdp.once('Page.loadEventFired');
	await browser.cdp.send('Page.reload', { ignoreCache: false });
	await loaded;
	await sleep(9000);

	let s = await read();
	check('画布模式已生效', s.mode === 'canvas', String(s.mode));
	check('种下的共用画布已渲染', s.boardNodes.includes('kept'), JSON.stringify(s.boardNodes));

	// ── 1. 默认共用 ──
	console.log('1) 默认：所有会话共用一块画布');
	check(
		'工具条读数是「共用画布」且 data-ffc-scope=shared',
		s.scopeBadge?.scope === 'shared' && s.scopeBadge?.text === '共用画布',
		JSON.stringify(s.scopeBadge),
	);
	check(
		'起点只有全局那一个画布键',
		s.storage.keys.length === 1 && s.storage.scoped.length === 0,
		JSON.stringify(s.storage.keys),
	);
	check('偏好还没有写（默认值不该落盘）', s.storage.pref === null, String(s.storage.pref));

	// ── 1b. 工具条布局体检（最窄宽度下多了一个常驻徽标） ──
	console.log('\n1b) 窄画布下的工具条布局');
	check(
		'工具条没有溢出（新徽标没把控件挤出可视区）',
		s.toolbar !== null && s.toolbar.overflow === false && s.toolbar.lastRight <= s.toolbar.barRight + 1,
		JSON.stringify(s.toolbar),
	);
	check(
		'工具条里没有被压扁 / 裁掉内容的控件',
		s.toolbar !== null && s.toolbar.clipped.length === 0,
		JSON.stringify(s.toolbar?.clipped),
	);
	check(
		'作用域读数可见、可命中（不是 0 宽或压在别的东西下面）',
		s.toolbar?.badgeVisible === true && s.toolbar?.badgeHit === true,
		`visible=${String(s.toolbar?.badgeVisible)} hit=${String(s.toolbar?.badgeHit)} bar=${String(s.toolbar?.w)}px`,
	);

	// ── 2. 开关本身就是那枚读数（P10：原来的「视图」菜单项已移除） ──
	console.log('\n2) 作用域读数即开关');
	s = await read();
	check('读数是 <button>（不是纯文字徽标）', s.scopeBadge?.tag === 'button', String(s.scopeBadge?.tag));
	check(
		'默认未按下（aria-pressed=false，默认共用一块）',
		s.scopeBadge?.pressed === 'false',
		String(s.scopeBadge?.pressed),
	);
	check('读数可命中（点得动，不是死按钮）', s.scopeBadge?.hit === true, JSON.stringify(s.scopeBadge));
	check(
		'title 说明了点它会切换（读数与开关是同一件事的两面）',
		String(s.scopeBadge?.title).includes('点击'),
		String(s.scopeBadge?.title),
	);

	// ── 3. 打开隔离：真的换到会话那块，且画布跟着走 ──
	console.log('\n3) 打开隔离');
	s = await toggleScope();
	check(
		'工具条读数变成「本会话画布」',
		s.scopeBadge?.scope === 'session' && s.scopeBadge?.text === '本会话画布',
		JSON.stringify(s.scopeBadge),
	);
	check('偏好已持久化', s.storage.pref === 'session', String(s.storage.pref));
	check(
		'出现且仅出现一个会话画布键',
		s.storage.scoped.length === 1,
		JSON.stringify(s.storage.keys),
	);
	const scopedKey = s.storage.scoped[0] ?? '';
	check(
		'会话画布的键名带完整会话 id（`session-<uuid>`，没被削掉前缀）',
		/^fatfish-canvas:board:session-[0-9a-fA-F-]{36}$/.test(scopedKey),
		scopedKey,
	);
	check(
		'画布没有变空：原来的节点被带进了会话画布（adopt）',
		s.boardNodes.includes('kept'),
		JSON.stringify(s.boardNodes),
	);
	const scopedRaw = await evaluate(browser.cdp, `window.localStorage.getItem(${JSON.stringify(scopedKey)})`);
	check(
		'会话画布键里已经写好了内容（不等下一次改动）',
		String(scopedRaw).includes('"kept"'),
		String(scopedRaw).slice(0, 90),
	);
	const sharedRaw = await evaluate(browser.cdp, "window.localStorage.getItem('fatfish-canvas:board')");
	check(
		'共用那块原样保留（采用不等于搬走）',
		String(sharedRaw).includes('"kept"'),
		String(sharedRaw).slice(0, 90),
	);

	// 交叉核对：会话候选（页面自己记的）与键后缀一致
	const candidate = (() => {
		try {
			return JSON.parse(s.storage.current ?? 'null')?.sessionId ?? null;
		} catch {
			return null;
		}
	})();
	check(
		'键后缀与页面记录的当前会话一致（不是随手编的键）',
		candidate === null || scopedKey === `fatfish-canvas:board:${String(candidate)}`,
		`候选=${String(candidate)} 键=${scopedKey}`,
	);

	// ── 4. 刷新后偏好还记得 ──
	console.log('\n4) 刷新之后');
	loaded = browser.cdp.once('Page.loadEventFired');
	await browser.cdp.send('Page.reload', { ignoreCache: false });
	await loaded;
	await sleep(9000);
	s = await read();
	check(
		'刷新后仍在会话画布上（偏好从存储恢复）',
		s.scopeBadge?.scope === 'session',
		JSON.stringify(s.scopeBadge),
	);
	check(
		'刷新后画布内容还在（从会话键读回来）',
		s.boardNodes.includes('kept'),
		JSON.stringify(s.boardNodes),
	);

	// ── 5. 关掉隔离：回到共用那块，会话那块留着 ──
	console.log('\n5) 关掉隔离');
	s = await toggleScope();
	check(
		'工具条读数回到「共用画布」',
		s.scopeBadge?.scope === 'shared' && s.scopeBadge?.text === '共用画布',
		JSON.stringify(s.scopeBadge),
	);
	check('偏好变回 shared', s.storage.pref === 'shared', String(s.storage.pref));
	check(
		'共用画布内容原样',
		s.boardNodes.includes('kept'),
		JSON.stringify(s.boardNodes),
	);
	const scopedAfter = String(
		await evaluate(browser.cdp, `window.localStorage.getItem(${JSON.stringify(scopedKey)})`),
	);
	check(
		'会话画布的那块仍然留在存储里（下次开开关还能回来）',
		s.storage.scoped.length === 1 && scopedAfter.includes('"kept"'),
		JSON.stringify(s.storage.keys),
	);

	// ── 截图（人工复核用） ──
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
