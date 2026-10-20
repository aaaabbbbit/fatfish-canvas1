/**
 * 端到端：画布按工作区分隔（真实浏览器 + 真实点击）。
 *
 * 离线测试能证明「作用域是工作区路径、拆分按会话走」，但有三件事只有真实 GUI
 * 能证明：
 *   1. **桥真的拿得到工作区** —— 工作区来自会话列表行上的 `cwd`，而那行是宿主
 *      发过来的；离线替身里的 `cwd` 是我们自己塞的（NOTES §8.x：替身与真机一起
 *      漂移过一次，代价是画布永远空）。
 *   2. **共用那块上属于当前会话的节点真的被拆出来了**：拆分要用「节点 → 会话 →
 *      工作区」两步查表，任何一环没接上都只会静静地把节点留在原地。
 *   3. **工具条上那枚读数点得动、点完真的换了画布**（读数按钮 → `state` 偏好 →
 *      `scope.applyBoardScope` → `store.setBoardScope`）。
 *
 * 覆盖：
 *   1. 默认就按工作区分：读数是「本工作区画布」，且共用那块上属于当前会话的节点
 *      被拆进当前工作区那块（拆完就渲染出来了）
 *   2. 拆分只搬认得出来的：没有会话标记的节点留在共用那块
 *   3. 画布键必须是**完整的工作区路径**（会话的 cwd），与读数上那枚 `data-ffc-scope-path` 一致
 *   4. 共用那块一个字节都不动（它是全部内容的备份）
 *   5. 点一下读数：回到「共用画布」（两个节点都在），再点回来还是本工作区
 *      （节点不重复、不丢）
 *   6. 刷新之后仍在工作区那块
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
  // 存储里所有「画布」键：共用那块无后缀，按工作区的那块带 :<工作区路径>。
  // ⚠️ 前缀必须带冒号：fatfish-canvas:board-scope（偏好）也以
  // fatfish-canvas:board 开头，用不带冒号的前缀筛会把偏好键当成一块画布。
  const keys = Object.keys(window.localStorage).filter((k) => k.indexOf('fatfish-canvas:board') === 0).sort();
  const scoped = keys.filter((k) => k.indexOf('fatfish-canvas:board:') === 0);
  const nodeIds = qa('.ffc-node').map((n) => n.dataset.nodeId);
  return JSON.stringify({
    mode: document.body.dataset.ffcMode ?? null,
    scopeBadge: badge
      ? {
          scope: badge.getAttribute('data-ffc-scope'),
          path: badge.getAttribute('data-ffc-scope-path'),
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
    boardNodes: nodeIds,
    // 同一个节点渲染两次 = 拆分没去重（画布上会出现两块一模一样的图）
    boardNodesUnique: new Set(nodeIds).size === nodeIds.length,
    storage: {
      pref: window.localStorage.getItem('fatfish-canvas:board-scope'),
      keys,
      scoped,
      // 会话候选（本地记录）：用来给种下的节点标上「是哪个会话生成的」
      current: window.localStorage.getItem('dsh.sessions.current'),
    },
  });
})()`;

/** 种下的共用画布：两个节点，一个属于当前会话（会被拆走），一个认不出来（留下）。 */
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
			title: '本会话生成的鱼',
			createdAt: 1,
		},
		{
			id: 'orphan',
			kind: 'image',
			x: 400,
			y: 0,
			w: 320,
			h: 320,
			z: 2,
			status: 'ready',
			src: 'data:,orphan',
			title: '不知道是谁生成的鱼',
			createdAt: 2,
		},
	],
	viewport: { x: 0, y: 0, zoom: 1 },
	ingested: [],
});

const browser = await launch();
const read = async () => JSON.parse(await evaluate(browser.cdp, PROBE));

/**
 * 点一次作用域读数（读数自己就是开关）。
 * @returns 点击后的页面事实。
 */
async function toggleScope() {
	const s = await read();
	if (s.scopeBadge?.center == null) throw new Error('工具条里没有作用域读数（开关不在）');
	await click(browser.cdp, s.scopeBadge.center.x, s.scopeBadge.center.y);
	await sleep(420); // 换画布 + 图钉去抖写盘
	return read();
}

console.log(`\n肥鱼画布 · 端到端（画布按工作区分隔）\n目标：${URL_TARGET}\n`);

try {
	// ── 就位：先认出当前会话（种下的节点要标上它），再种共用画布、进画布模式 ──
	let loaded = browser.cdp.once('Page.loadEventFired');
	await browser.cdp.send('Page.navigate', { url: URL_TARGET });
	await loaded;
	await sleep(4000);
	const candidate = await evaluate(
		browser.cdp,
		`(() => { try { return JSON.parse(window.localStorage.getItem('dsh.sessions.current') || 'null')?.sessionId ?? null; } catch { return null; } })()`,
	);
	check(
		'前置：探针 profile 里认得出当前会话（不然「按会话拆分」无从判起）',
		typeof candidate === 'string' && candidate !== '',
		String(candidate),
	);

	await evaluate(
		browser.cdp,
		`(() => {
			// ⚠️ 先把**共用那块**的落图账本读出来 —— 下面会把所有按工作区的画布键删掉
			// （包括别的套件留下的，这是有意隔离），但账本不能跟着丢：
			// 账本一空，「最近结果补落」（INGEST_FRESH_MS = 10 分钟）就会把同一个
			// 会话里刚跑过的 /generate 节点**又造回画布**，后面所有数节点的断言
			// 都会莫名其妙多出几个（NOTES §8.61）。
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
			// 「kept」标上当前会话：拆分就是靠这个字段把它送回本工作区的。
			seed.nodes[0].sessionId = ${JSON.stringify(candidate)};
			seed.ingested = ledger;
			window.localStorage.setItem('fatfish-canvas:board', JSON.stringify(seed));
			window.localStorage.setItem('fatfish-canvas:view-mode', 'canvas');
			// 固定成**最窄**的画布宽度：常驻徽标挤爆工具条这件事只在窄的时候发生
			window.localStorage.setItem('fatfish-canvas:canvas-width', '40%');
			// 清掉偏好 → 走**默认**（按工作区）。作用域的行为就是这个套件要测的，
			// 不能被上一轮留下的偏好顶掉。
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

	// ── 1. 默认就按工作区分 ──
	console.log('1) 默认：一个工作区一块画布');
	check(
		'工具条读数是「本工作区画布」且 data-ffc-scope=workspace',
		s.scopeBadge?.scope === 'workspace' && s.scopeBadge?.text === '本工作区画布',
		JSON.stringify(s.scopeBadge),
	);
	check(
		'读数把工作区路径写在 DOM 上（绝对路径，不是会话 id）',
		typeof s.scopeBadge?.path === 'string' && /^[A-Za-z]:[\\/]|^\//.test(s.scopeBadge.path),
		String(s.scopeBadge?.path),
	);
	check(
		'属于当前会话的节点已经拆进本工作区那块，并且渲染出来了',
		s.boardNodes.includes('kept'),
		`工作区=${String(s.scopeBadge?.path)} 节点=${JSON.stringify(s.boardNodes)}`,
	);
	check(
		'认不出会话的节点留在共用那块（不在本工作区画布上）',
		!s.boardNodes.includes('orphan'),
		JSON.stringify(s.boardNodes),
	);
	check(
		'出现且仅出现一个工作区画布键，后缀就是刚才那个工作区路径',
		s.storage.scoped.length === 1 &&
			s.storage.scoped[0] === `fatfish-canvas:board:${String(s.scopeBadge?.path)}`,
		JSON.stringify(s.storage.keys),
	);
	const scopedKey = s.storage.scoped[0] ?? '';
	const scopedRaw = String(await evaluate(browser.cdp, `window.localStorage.getItem(${JSON.stringify(scopedKey)})`));
	check(
		'工作区那块里只写了它自己的节点（没把共用那块整块抄过来）',
		scopedRaw.includes('"kept"') && !scopedRaw.includes('"orphan"'),
		scopedRaw.slice(0, 120),
	);
	const sharedRaw = String(await evaluate(browser.cdp, "window.localStorage.getItem('fatfish-canvas:board')"));
	check(
		'共用那块一个字节都不动（它是全部内容的备份）',
		sharedRaw.includes('"kept"') && sharedRaw.includes('"orphan"'),
		sharedRaw.slice(0, 120),
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

	// ── 2. 读数即开关 ──
	console.log('\n2) 作用域读数即开关');
	s = await read();
	check('读数是 <button>（不是纯文字徽标）', s.scopeBadge?.tag === 'button', String(s.scopeBadge?.tag));
	check(
		'按工作区分时是按下态（aria-pressed=true）',
		s.scopeBadge?.pressed === 'true',
		String(s.scopeBadge?.pressed),
	);
	check('读数可命中（点得动，不是死按钮）', s.scopeBadge?.hit === true, JSON.stringify(s.scopeBadge));
	check(
		'title 带着当前工作区路径，并说明点它会切换',
		String(s.scopeBadge?.title).includes('点击') &&
			String(s.scopeBadge?.title).includes(String(s.scopeBadge?.path)),
		String(s.scopeBadge?.title),
	);

	// ── 3. 切回共用：两个节点都回来 ──
	console.log('\n3) 切回「共用画布」');
	s = await toggleScope();
	check(
		'工具条读数变成「共用画布」',
		s.scopeBadge?.scope === 'shared' && s.scopeBadge?.text === '共用画布',
		JSON.stringify(s.scopeBadge),
	);
	check('偏好已持久化', s.storage.pref === 'shared', String(s.storage.pref));
	check(
		'共用那块上两个节点都在（拆走的节点没丢：它本来就在这儿）',
		s.boardNodes.includes('kept') && s.boardNodes.includes('orphan'),
		JSON.stringify(s.boardNodes),
	);

	// ── 4. 再切回工作区：幂等，不重复也不丢 ──
	console.log('\n4) 再切回「本工作区画布」');
	s = await toggleScope();
	check(
		'读数回到「本工作区画布」',
		s.scopeBadge?.scope === 'workspace' && s.scopeBadge?.text === '本工作区画布',
		JSON.stringify(s.scopeBadge),
	);
	check(
		'画布上还是那个节点，且**没有重复渲染**（重复 = 拆分没去重）',
		s.boardNodes.includes('kept') && !s.boardNodes.includes('orphan') && s.boardNodesUnique === true,
		JSON.stringify(s.boardNodes),
	);
	check(
		'工作区那块仍然只有自己的节点（重复拆分不会把它撑成两份）',
		String(await evaluate(browser.cdp, `window.localStorage.getItem(${JSON.stringify(scopedKey)})`)).split('"kept"').length === 2,
	);

	// ── 5. 刷新后仍在工作区那块 ──
	console.log('\n5) 刷新之后');
	loaded = browser.cdp.once('Page.loadEventFired');
	await browser.cdp.send('Page.reload', { ignoreCache: false });
	await loaded;
	await sleep(9000);
	s = await read();
	check(
		'刷新后仍在本工作区画布上',
		s.scopeBadge?.scope === 'workspace',
		JSON.stringify(s.scopeBadge),
	);
	check(
		'刷新后画布内容还在（从工作区键读回来）',
		s.boardNodes.includes('kept') && !s.boardNodes.includes('orphan'),
		JSON.stringify(s.boardNodes),
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
