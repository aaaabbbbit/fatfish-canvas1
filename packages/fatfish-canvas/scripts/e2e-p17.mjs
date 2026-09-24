/**
 * P17 端到端：主界面三件事（生成模型格 / 一次拖多张 / 对齐吸附）。
 *
 * 为什么这三件事离线一条都测不到：
 *   - **模型菜单是 `createPortal` 到 `document.body` 的浮层**：它挂在哪、往上弹多少、
 *     有没有被视口裁掉，全靠真实的 `getBoundingClientRect` 与真实布局；替身里
 *     `document.body` 是桩，量出来的全是 0。
 *   - **一次拖多张靠真实 `drop` 事件 + `DataTransfer`**：`dropLayout` 的算法有离线测试，
 *     但「事件真的被画布接管、五张真的落成五个节点」只有真浏览器能给。
 *   - **对齐吸附是拖动过程中的屏幕读数**（`data-guide-count` / `.ffc-guide`）：
 *     辅助线在 `pointerup` 那一刻就被清掉，只能在**按住不放**的时候读。
 *
 * 覆盖（对应 STATE §7.13 的三条）：
 *   ① composer 那一格：菜单挂在 body 上 / 在触发器**上方**且不出视口 / 页签切换是两份清单 /
 *      选中之后**宿主设置里真的变了**（读完再把默认值恢复原样）
 *   ② 合成一次 5 个文件的 drop：一行 4 个 + 第二行 1 个、任意两张不重叠、第一张以拖放点为中心
 *   ③ 拖一个节点靠近另一个：出现竖直辅助线、松手后左边**精确对齐**；按住 Alt 拖则**不吸附**
 *
 * ⚠️ 两处必须照旧规矩来：
 *   - 量那一格时按「可见的那一份」挑（`rect.w > 0`）：本体在 hero 与会话态之间复用同一棵
 *     DOM，隐藏副本留在文档里（NOTES §8.20）。
 *   - 拖节点之前**先点一下空白处**：本体的输入框默认是聚焦的，而 P15 定的规矩是
 *     「输入框里正在打字时点图片 = 把这张图引用进聊天框」（canvas/clickintent.ts）——
 *     那一下按下去不会变成拖节点（e2e-canvas 踩过同一个坑）。
 *
 * ⚠️ 副作用：② 会把 5 张合成的小图当**本地图**落进画布，落图那条路会顺手请宿主把它们
 * 存成参考图句柄（P22）—— 于是宿主的附件库里会多 5 个几 KB 的小文件（e2e-ingest 也会
 * 往宿主里塞测试会话，同一条代价）。③ 的种子画布会覆盖探针 profile 里那一块画布。
 *
 * 用法（需放宽沙箱：无头 Chrome 要创建命名管道；地址要带 dsh web 打印的令牌）：
 *   node scripts/e2e-p17.mjs
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
const SHOT = resolve(PACKAGE_ROOT, 'lib/e2e-p17.png');

/** 吸附容差（**屏幕**像素）——与 model.ts 的 `SNAP_TOLERANCE_PX` 对齐。 */
const SNAP_PX = 6;
/** 网格间距与每行上限——与 model.ts 的 `PLACEMENT_SPACING` / `PLACEMENT_MAX_PER_ROW` 对齐。 */
const SPACING = 20;
const PER_ROW = 4;
/** 种节点用的最小图片（与 e2e-canvas 同一张 240×160 的蓝色方块）。 */
const TILE =
	'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNDAiIGhlaWdodD0iMTYwIj48cmVjdCB3aWR0aD0iMjQwIiBoZWlnaHQ9IjE2MCIgZmlsbD0iIzMzNjZjYyIvPjwvc3ZnPg==';

let failures = 0;
const results = [];
const check = (label, ok, detail = '') => {
	if (!ok) failures += 1;
	results.push(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail === '' ? '' : ` — ${detail}`}`);
};
/** 记一条「这次没条件验」：既不算过也不算错（post-restart 的报告会带上 ⏭ 行）。 */
const skip = (label, why) => {
	results.push(`  ⏭ [SKIP] ${label} — ${why}`);
};
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN);

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
  const text = (el) => (el ? (el.textContent || '').replace(/\\s+/g, ' ').trim() : null);
  // 本体在 hero 与会话态之间复用同一棵 DOM，隐藏副本留在文档里（NOTES §8.20）：
  // 凡是要点、要量的那一份，一律按「有宽度」挑。
  const visible = (sel) => qa(sel).filter((el) => el.getBoundingClientRect().width > 0);
  const trigger = visible('.ffc-mp-trigger')[0] ?? null;
  const menu = q('.ffc-mp-menu');
  const world = q('.ffc-world');
  const m = world ? new DOMMatrixReadOnly(getComputedStyle(world).transform) : null;
  const zoom = m ? m.a : null;
  const stage = q('.ffc-viewport');
  const settingsSel = q('select[data-default="image"]');
  let board = null;
  try { board = JSON.parse(window.localStorage.getItem('fatfish-canvas:board') || 'null'); } catch (e) { board = null; }
  return JSON.stringify({
    mode: document.body.dataset.ffcMode ?? null,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    panel: rect(q('.ffc-panel')),
    stage: rect(stage),
    zoom,
    vx: m && zoom ? -m.e / zoom : null,
    vy: m && zoom ? -m.f / zoom : null,
    guideCount: stage ? Number(stage.dataset.guideCount) : null,
    guideAxes: qa('.ffc-guide').map((g) => g.dataset.guide),
    nodes: qa('.ffc-node').map((n) => ({
      id: n.dataset.nodeId,
      left: Math.round(parseFloat(n.style.left) || 0),
      top: Math.round(parseFloat(n.style.top) || 0),
      box: rect(n),
      center: center(n),
      selected: n.dataset.selected === 'true',
    })),
    triggerCopies: qa('.ffc-mp-trigger').length,
    trigger: trigger === null ? null : {
      rect: rect(trigger),
      center: center(trigger),
      label: text(trigger.querySelector('.ffc-mp-value')),
      title: trigger.getAttribute('title'),
      expanded: trigger.getAttribute('aria-expanded'),
    },
    menu: menu === null ? null : {
      onBody: menu.parentElement === document.body,
      rect: rect(menu),
      hasTabs: q('.ffc-mp-tabs') !== null,
      tabs: qa('.ffc-mp-tab').map((t) => ({ kind: t.dataset.tab, active: t.dataset.active === 'true', selected: t.getAttribute('aria-selected'), center: center(t) })),
      options: qa('.ffc-mp-option').map((b) => ({ ref: b.dataset.modelOption ?? null, auto: b.dataset.modelAuto === 'true', checked: b.getAttribute('aria-checked') === 'true', center: center(b) })),
      empty: q('.ffc-mp-empty') !== null,
      emptyText: text(q('.ffc-mp-empty')),
      note: text(q('.ffc-mp-note')),
    },
    settings: { open: q('.ffc-set') !== null, defaultImage: settingsSel ? settingsSel.value : null },
    sessionRows: qa('div[class*="sessionRow"]').map((el) => ({ text: text(el), center: center(el), kids: el.children.length })),
    board: board === null ? null : { nodes: Array.isArray(board.nodes) ? board.nodes.length : -1 },
  });
})()`;

/** 设置页：打开设置 → 进本插件的分节（与 e2e-settings 同一套导航）。 */
const OPEN_SETTINGS = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const label = (el) => (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();
  if (document.querySelector('.ffc-set') === null) {
    const trigger = Array.from(document.querySelectorAll('button, a, [role="button"]')).find((el) => label(el) === '设置' || label(el) === 'Settings');
    if (trigger === undefined) return 'no-settings-trigger';
    trigger.click();
    await sleep(1600);
  }
  if (document.querySelector('.ffc-set') === null) {
    const nav = Array.from(document.querySelectorAll('button, a, [role="tab"], [role="menuitem"], li')).find((el) => label(el) === '图像 / 视频模型');
    if (nav === undefined) return 'no-section-nav';
    nav.click();
    await sleep(1500);
  }
  return document.querySelector('.ffc-set') !== null ? 'ok' : 'section-missing';
})()`;

/**
 * 合成一次「一次拖进 5 张图」的 drop。
 *
 * 必须用 `new DataTransfer()` + `items.add(file)`：平台自己的附件管线先按
 * `dataTransfer.types.includes('Files')` 过滤，手写的假对象过不了那一关（dom.ts 记着这一条）。
 * 事件派发在 `.ffc-viewport` 上：画布的接管挂在 document 的**捕获**阶段，
 * 只要目标是画布面板里的元素就会被它接住。
 */
const DROP_FIVE = `(async () => {
  const sizes = [[400, 400], [600, 300], [300, 600], [512, 512], [800, 400]];
  const colors = ['#c0392b', '#27ae60', '#2980b9', '#f39c12', '#16a085'];
  const files = [];
  for (let i = 0; i < sizes.length; i += 1) {
    const canvas = document.createElement('canvas');
    canvas.width = sizes[i][0];
    canvas.height = sizes[i][1];
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = colors[i];
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    files.push(new File([blob], 'e2e-drop-' + String(i + 1) + '.png', { type: 'image/png' }));
  }
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  const target = document.querySelector('.ffc-viewport');
  if (target === null) return JSON.stringify({ ok: false, why: 'no-viewport' });
  const r = target.getBoundingClientRect();
  const x = Math.round(r.x + r.width * 0.3);
  const y = Math.round(r.y + r.height * 0.3);
  target.dispatchEvent(new DragEvent('drop', {
    bubbles: true, cancelable: true, dataTransfer: transfer, clientX: x, clientY: y,
  }));
  return JSON.stringify({ ok: true, x, y, files: transfer.files.length, types: Array.from(transfer.types) });
})()`;

const browser = await launch();
const read = async () => JSON.parse(await evaluate(browser.cdp, PROBE));

/**
 * 导航 + 预置偏好 + 重载。
 * @param mode - 视图模式（`chat` = 只有聊天；`canvas` = 左画布 / 右聊天）。
 * @param seed - 画布种子（`null` = 不动画布存储）。
 * @param waitMs - 重载后等多久（客户端 bundle 很大，短了会读到空面板）。
 */
async function load(mode, seed, waitMs = 9000) {
	let loaded = browser.cdp.once('Page.loadEventFired');
	await browser.cdp.send('Page.navigate', { url: URL_TARGET });
	await loaded;
	await evaluate(
		browser.cdp,
		`(() => {
			window.localStorage.setItem('fatfish-canvas:view-mode', ${JSON.stringify(mode)});
			window.localStorage.setItem('fatfish-canvas:canvas-width', '62%');
			${RESET_BOARD_PREFS}
			return true;
		})()`,
	);
	if (seed !== null) await evaluate(browser.cdp, seedBoardExpression(seed));
	loaded = browser.cdp.once('Page.loadEventFired');
	await browser.cdp.send('Page.reload', { ignoreCache: false });
	await loaded;
	await sleep(waitMs);
}

/**
 * 打开一个**正常**的真实会话（composer 那一格只有会话态才渲染）。
 *
 * 侧边栏里可能排着「等待审批」的会话：那种会话的 composer 被审批 UI 接管，拿它会得到假红。
 * @returns 打开的会话文案；全都不可用时为 null。
 */
async function openRealSession() {
	const s = await read();
	const candidates = s.sessionRows.filter(
		(row) => row.kids >= 4 && row.text !== null && !row.text.includes('新会话') && !row.text.includes('等待审批'),
	);
	for (const row of candidates.slice(0, 3)) {
		await click(browser.cdp, row.center.x, row.center.y);
		await sleep(2500);
		const after = await read();
		if (after.trigger !== null && after.trigger.rect.w > 0) return row.text;
	}
	return null;
}

/**
 * 派发一次**带修饰键**的拖拽，并在松手**之前**回调一次。
 *
 * 不复用 `lib/cdp.mjs` 的 `drag()`：它既不带 modifiers（Alt = 关掉吸附要用），
 * 也不给「按住不放时读一次页面」的机会 —— 而辅助线正是在松手那一刻被清掉的
 * （e2e-canvas 的 Shift 框选也是自己写的这一段，同一个理由）。
 * @param from - 起点（视口坐标）。
 * @param to - 终点。
 * @param options - `{ modifiers, onMidway }`。
 */
async function dragPointer(from, to, options = {}) {
	const modifiers = options.modifiers ?? 0;
	const steps = options.steps ?? 8;
	await browser.cdp.send('Input.dispatchMouseEvent', {
		type: 'mousePressed',
		x: from.x,
		y: from.y,
		button: 'left',
		buttons: 1,
		clickCount: 1,
		modifiers,
	});
	for (let i = 1; i <= steps; i += 1) {
		const t = i / steps;
		await browser.cdp.send('Input.dispatchMouseEvent', {
			type: 'mouseMoved',
			x: Math.round(from.x + (to.x - from.x) * t),
			y: Math.round(from.y + (to.y - from.y) * t),
			button: 'left',
			buttons: 1,
			modifiers,
		});
		await sleep(12);
	}
	if (typeof options.onMidway === 'function') await options.onMidway();
	await browser.cdp.send('Input.dispatchMouseEvent', {
		type: 'mouseReleased',
		x: to.x,
		y: to.y,
		button: 'left',
		buttons: 0,
		clickCount: 1,
		modifiers,
	});
	await sleep(150);
}

/** 把设置页那个「默认图像模型」下拉设成某个值（原生 setter + change，React 的 onChange 走原生 change）。 */
async function setDefaultImage(value) {
	const ok = await evaluate(
		browser.cdp,
		`(() => {
			const sel = document.querySelector('select[data-default="image"]');
			if (!sel) return false;
			const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
			setter.call(sel, ${JSON.stringify(value)});
			sel.dispatchEvent(new Event('change', { bubbles: true }));
			return true;
		})()`,
	);
	await sleep(1500);
	return ok === true;
}

/**
 * ① composer 的生成模型格（聊天模式：整列聊天才是常规宽度）。
 *
 * 单独成函数是为了「这一格读不到时**不要连累** ②③」：它依赖宿主的设置服务与一个
 * 已打开的会话，而 ②③ 只依赖画布本身 —— 若直接铺在主流程里，`trigger` 为 null 时
 * 下面那句 `trigger.center` 就会抛错把整条脚本带走。
 */
async function phase1() {
	console.log('① composer 的生成模型格');
	await load('chat', null);
	const opened = await openRealSession();
	check('打开了一个正常会话（生成模型格是会话作用域的席位）', opened !== null, String(opened));

	let s = await read();
	check('聊天模式已生效', s.mode === 'chat', String(s.mode));
	check(
		'composer 那一行里渲染出生成模型格（按可见的那一份挑）',
		s.trigger !== null && s.trigger.rect.w > 0,
		`共 ${String(s.triggerCopies)} 份，可见的那份=${JSON.stringify(s.trigger)}`,
	);
	check('菜单初始是关着的', s.menu === null);
	check(
		'触发器自报「未展开」，title 里同时写着图像与视频两个当前值',
		s.trigger !== null && s.trigger.expanded === 'false' && String(s.trigger.title).includes('图像：') && String(s.trigger.title).includes('视频：'),
		`${String(s.trigger?.expanded)} / ${String(s.trigger?.title)}`,
	);

	const trigger = s.trigger;
	// 读不到这一格就到此为止：上面那条 check 已经把原因说清了，别让它连累 ②③。
	if (trigger === null) return;

	await click(browser.cdp, trigger.center.x, trigger.center.y);
	await sleep(500);
	s = await read();
	const menu = s.menu;
	check('鼠标点一下触发器 → 菜单出现', menu !== null);
	check('触发器自报「已展开」', s.trigger !== null && s.trigger.expanded === 'true', String(s.trigger?.expanded));
	check(
		'菜单挂在 document.body 上（createPortal：不被 AppFrame 的 overflow 裁掉）',
		menu !== null && menu.onBody === true,
		menu === null ? 'no-menu' : `父元素=${String(menu.onBody)}`,
	);
	check(
		'菜单贴着触发器**向上**弹（不是往下、也不是飘到别处）',
		menu !== null && menu.rect !== null && menu.rect.y + menu.rect.h <= s.trigger.rect.y && s.trigger.rect.y - (menu.rect.y + menu.rect.h) <= 24,
		`menu.bottom=${String((menu?.rect?.y ?? 0) + (menu?.rect?.h ?? 0))} trigger.top=${String(s.trigger?.rect?.y)}`,
	);
	check(
		'菜单完全落在视口里（12px 夹取生效，没有一截在屏幕外）',
		menu !== null &&
			menu.rect.x >= 0 &&
			menu.rect.y >= 0 &&
			menu.rect.x + menu.rect.w <= s.viewport.w &&
			menu.rect.y + menu.rect.h <= s.viewport.h,
		`menu=${JSON.stringify(menu?.rect)} viewport=${JSON.stringify(s.viewport)}`,
	);
	check(
		'菜单右缘与触发器右缘对齐（官方 ModelSelect 的定位规则）',
		menu !== null && Math.abs(menu.rect.x + menu.rect.w - (s.trigger.rect.x + s.trigger.rect.w)) <= 14,
		`menu.right=${String((menu?.rect?.x ?? 0) + (menu?.rect?.w ?? 0))} trigger.right=${String((s.trigger?.rect?.x ?? 0) + (s.trigger?.rect?.w ?? 0))}`,
	);
	check('菜单里有两个页签（图像 / 视频）', menu !== null && menu.hasTabs === true && menu.tabs.length === 2, JSON.stringify(menu?.tabs?.map((t) => t.kind)));

	// 页签切换：两份清单必须是两份（不是同一份换了个高亮）
	const imageTab = menu?.tabs.find((t) => t.kind === 'image') ?? null;
	const videoTab = menu?.tabs.find((t) => t.kind === 'video') ?? null;
	const imageRefs = (menu?.options ?? []).filter((o) => o.ref !== null).map((o) => o.ref);
	check('「图像」页签默认选中', imageTab !== null && imageTab.active === true && imageTab.selected === 'true', JSON.stringify(imageTab));

	if (videoTab === null) {
		check('找得到「视频」页签', false, 'no-video-tab');
	} else {
		await click(browser.cdp, videoTab.center.x, videoTab.center.y);
		await sleep(400);
		s = await read();
		const after = s.menu;
		const videoTab2 = after?.tabs.find((t) => t.kind === 'video') ?? null;
		const imageTab2 = after?.tabs.find((t) => t.kind === 'image') ?? null;
		const videoRefs = (after?.options ?? []).filter((o) => o.ref !== null).map((o) => o.ref);
		check(
			'点「视频」页签 → 高亮与 aria-selected 都跟着换',
			videoTab2 !== null && videoTab2.active === true && videoTab2.selected === 'true' && imageTab2 !== null && imageTab2.active === false,
			JSON.stringify(after?.tabs),
		);
		check('切换页签后菜单仍然挂在 body 上、仍然在触发器上方', after !== null && after.onBody === true && after.rect.y + after.rect.h <= s.trigger.rect.y, JSON.stringify(after?.rect));
		check(
			'两份清单是两份：视频页签里没有图像页签那些模型',
			// 视频模型一个都没有时，该出现的是**空态那一句**（`.ffc-mp-empty`），
			// 不是菜单底部那句通用说明（`.ffc-mp-note`）—— 两者是不同的元素。
			videoRefs.length === 0
				? after.empty === true && String(after.emptyText).includes('视频')
				: videoRefs.every((ref) => !imageRefs.includes(ref)),
			`视频=${JSON.stringify(videoRefs)} 图像=${JSON.stringify(imageRefs)} 空态=${String(after?.emptyText)}`,
		);
		if (videoRefs.length === 0) skip('视频页签列出视频模型', '宿主里没配视频模型（这里只验了空态文案）');

		// 切回图像页签，准备选一个模型
		const back = await read();
		const backTab = back.menu?.tabs.find((t) => t.kind === 'image') ?? null;
		if (backTab !== null) {
			await click(browser.cdp, backTab.center.x, backTab.center.y);
			await sleep(400);
		}
	}

	// 选一个与当前不同的模型 → 断言宿主设置真的变了 → 再恢复原样
	s = await read();
	const menuNow = s.menu;
	const checkedRef = (menuNow?.options ?? []).find((o) => o.checked && o.ref !== null)?.ref ?? '';
	const current = (menuNow?.options ?? []).some((o) => o.auto && o.checked) ? '' : checkedRef;
	const pick = (menuNow?.options ?? []).find((o) => o.ref !== null && o.ref !== current) ?? null;
	const wantAuto = pick === null;
	const wantRef = wantAuto ? '' : pick.ref;

	if (menuNow === null) {
		check('菜单还在（切页签不会把菜单关掉）', false, 'menu-gone');
	} else if (wantAuto && current === '') {
		skip('选中一个模型 → 宿主设置跟着变', '宿主里没有可选的图像模型，且当前已经是「自动」');
	} else {
		const spot = pick !== null ? pick.center : (menuNow.options.find((o) => o.auto) ?? null)?.center;
		check('找得到要点的那一行', spot !== null && spot !== undefined, `want=${wantRef === '' ? '自动' : wantRef}`);
		if (spot !== null && spot !== undefined) {
			await click(browser.cdp, spot.x, spot.y);
			await sleep(1200);
			s = await read();
			check('鼠标点一下就选中并**自己关掉**菜单', s.menu === null, JSON.stringify(s.menu?.rect));
			const wantLabel = wantRef === '' ? '自动' : wantRef.slice(wantRef.indexOf('::') + 2);
			check(
				'触发器上的模型名换成刚选的那个',
				s.trigger !== null && s.trigger.label === wantLabel,
				`期望 ${wantLabel}，实际 ${String(s.trigger?.label)}`,
			);

			const openedSettings = await evaluate(browser.cdp, OPEN_SETTINGS);
			check('设置页打开并渲染本插件的分节', openedSettings === 'ok', String(openedSettings));
			s = await read();
			check(
				'宿主设置里真的变了（设置页那份「默认图像模型」就是刚选的那个）',
				s.settings.defaultImage === wantRef,
				`期望 ${JSON.stringify(wantRef)}，实际 ${JSON.stringify(s.settings.defaultImage)}`,
			);

			// 恢复：把用户原来的默认值写回去（不留垃圾配置）
			const restored = await setDefaultImage(current);
			s = await read();
			check(
				'默认图像模型已恢复成原来的值（不给用户留垃圾）',
				restored && s.settings.defaultImage === current,
				`期望 ${JSON.stringify(current)}，实际 ${JSON.stringify(s.settings.defaultImage)}`,
			);
		}
	}
}

console.log(`\n肥鱼画布 · P17 端到端（生成模型格 / 一次拖多张 / 对齐吸附）\n目标：${URL_TARGET}\n`);

try {
	await phase1();

	// ─────────── ② 一次拖进 5 张图 ───────────
	console.log('\n② 一次拖进多张图：一行 4 个 + 第二行 1 个');
	await load(
		'canvas',
		JSON.stringify({ version: 3, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } }),
	);
	let s = await read();
	check('画布模式已生效', s.mode === 'canvas', String(s.mode));
	check('起点是空画布（探针 profile 复用的老节点已清掉）', s.nodes.length === 0, `实际 ${String(s.nodes.length)} 个`);
	check('落图之前缩放是 100%（落图之后跟焦可能改它，下面的断言自己会换算）', Math.abs(num(s.zoom) - 1) < 1e-6, String(s.zoom));

	// 拖放点要用**落下之前**那一份视口换算：落图之后跟焦可能把视口挪走/缩小
	// （`planFocus` 对「一屏放不下」的一批会 fitRect 缩小），那时再拿新视口去反解
	// 拖放点就会算出一个根本不成立的世界坐标（第一版就是这么假红的）。
	const before = s;
	const dropped = JSON.parse(await evaluate(browser.cdp, DROP_FIVE));
	check('合成 drop 派发成功，且 dataTransfer 里真的带 Files（平台那条管线的判据）', dropped.ok === true && dropped.files === 5 && dropped.types.includes('Files'), JSON.stringify(dropped));
	await sleep(2500);
	s = await read();

	const nodes = s.nodes;
	check('一次拖 5 张 → 落成 5 个节点（不是 1 个、也不是全叠在一起）', nodes.length === 5, `实际 ${String(nodes.length)} 个`);
	if (nodes.length === 5) {
		// 节点的 left/top 本来就是**世界坐标**，但 getBoundingClientRect 给的是屏幕像素 ——
		// 两者之间差一个 zoom（落图后跟焦可能已经缩过）。下面一律换算到世界坐标再比。
		const zoom = num(s.zoom);
		const worldW = (n) => n.box.w / zoom;
		const worldH = (n) => n.box.h / zoom;
		const toWorldOf = (x, y) => ({
			x: (x - s.stage.x) / zoom + num(s.vx),
			y: (y - s.stage.y) / zoom + num(s.vy),
		});
		const row1 = nodes.slice(0, PER_ROW);
		const fifth = nodes[PER_ROW];
		check('第一行 4 个顶边对齐', row1.every((n) => Math.abs(n.top - row1[0].top) <= 1), JSON.stringify(row1.map((n) => [n.left, n.top])));
		check(
			`行内按前一个的**宽度** + ${String(SPACING)} 推进（尺寸不一时右侧也不会压到左边）`,
			row1.every((n, i) => i === 0 || Math.abs(n.left - (row1[i - 1].left + worldW(row1[i - 1])) - SPACING) <= 2),
			JSON.stringify(row1.map((n, i) => (i === 0 ? 0 : Math.round(n.left - (row1[i - 1].left + worldW(row1[i - 1])))))),
		);
		check(
			'第 5 张换到第二行：回到锚点的 x、顶边整行下移（行高取该行最高者 + 间距）',
			fifth.left === row1[0].left && fifth.top >= row1[0].top + Math.max(...row1.map(worldH)),
			`第五个=(${String(fifth.left)},${String(fifth.top)}) 第一行顶=${String(row1[0].top)} 行高=${String(Math.max(...row1.map(worldH)))}`,
		);
		const overlapping = [];
		for (let i = 0; i < nodes.length; i += 1) {
			for (let j = i + 1; j < nodes.length; j += 1) {
				const a = { x: nodes[i].left, y: nodes[i].top, w: worldW(nodes[i]), h: worldH(nodes[i]) };
				const b = { x: nodes[j].left, y: nodes[j].top, w: worldW(nodes[j]), h: worldH(nodes[j]) };
				const apart = a.x + a.w <= b.x + 0.5 || b.x + b.w <= a.x + 0.5 || a.y + a.h <= b.y + 0.5 || b.y + b.h <= a.y + 0.5;
				if (!apart) overlapping.push(`${String(i)}×${String(j)}`);
			}
		}
		check('任意两张都不重叠（这就是用户报的那个毛病）', overlapping.length === 0, `重叠的：${JSON.stringify(overlapping)}`);

		const worldX = (dropped.x - before.panel.x) / num(before.zoom) + num(before.vx);
		const worldY = (dropped.y - before.panel.y) / num(before.zoom) + num(before.vy);
		const first = nodes[0].box;
		const firstCenter = toWorldOf(first.x + first.w / 2, first.y + first.h / 2);
		check(
			'第一张仍以**拖放点**为中心（其余向右下铺开）',
			Math.abs(firstCenter.x - worldX) <= 4 && Math.abs(firstCenter.y - worldY) <= 4,
			`拖放点世界=(${worldX.toFixed(1)},${worldY.toFixed(1)}) 第一张中心=(${firstCenter.x.toFixed(1)},${firstCenter.y.toFixed(1)}) zoom=${String(zoom)}`,
		);
		check('这 5 张都落进了画布存储（刷新后还在，不是只在内存里）', s.board !== null && s.board.nodes === 5, JSON.stringify(s.board));
	}

	// ─────────── ③ 拖动时的对齐吸附 ───────────
	console.log('\n③ 对齐吸附（含 Alt 临时关掉）');
	await load(
		'canvas',
		JSON.stringify({
			version: 3,
			nodes: [
				{ id: 'snap-a', kind: 'image', x: 0, y: 0, w: 240, h: 160, z: 1, status: 'ready', src: TILE, title: 'A', createdAt: 1 },
				{ id: 'snap-b', kind: 'image', x: 500, y: 380, w: 200, h: 120, z: 2, status: 'ready', src: TILE, title: 'B', createdAt: 2 },
			],
			viewport: { x: 0, y: 0, zoom: 1 },
		}),
	);
	s = await read();
	check('种下两个节点（A 在原点、B 在右下）', s.nodes.length === 2, JSON.stringify(s.nodes.map((n) => [n.id, n.left, n.top])));

	/** 世界点 → 屏幕点（视口元素的坐标）。 */
	const screenOf = (st, wx, wy) => ({
		x: Math.round(st.stage.x + (wx - num(st.vx)) * num(st.zoom)),
		y: Math.round(st.stage.y + (wy - num(st.vy)) * num(st.zoom)),
	});

	let a = s.nodes.find((n) => n.id === 'snap-a') ?? null;
	let b = s.nodes.find((n) => n.id === 'snap-b') ?? null;
	check('两个种子节点都渲染出来了', a !== null && b !== null);

	if (a !== null && b !== null) {
		// 先点一下空白处：本体的输入框默认聚焦，而「输入框聚焦时点图片 = 送进聊天框」
		// （P15 的规矩）—— 不先点一下，下面那一下按下去根本不会变成拖节点。
		await click(browser.cdp, screenOf(s, 60, 620).x, screenOf(s, 60, 620).y);

		// 把 B 的左边缘拖到 A 的左边缘右边 4px 处：容差 6px 内 ⇒ 应该被吸到**精确对齐**。
		// y 保持在 380（离 A 的三条横向参考线都很远）⇒ 只有竖直辅助线，判定干净。
		const wantX = a.left + 4;
		const from = screenOf(s, b.left + b.box.w / 2, b.top + b.box.h / 2);
		const to = screenOf(s, wantX + b.box.w / 2, b.top + b.box.h / 2);
		let midGuide = null;
		await dragPointer(from, to, {
			onMidway: async () => {
				await sleep(120); // 等 React 把辅助线渲染出来
				midGuide = await read();
			},
		});
		check(
			`拖到差 ${String(SNAP_PX)}px 以内 → 出现竖直对齐辅助线（data-guide-count）`,
			midGuide !== null && midGuide.guideCount === 1 && midGuide.guideAxes.includes('x'),
			`guideCount=${String(midGuide?.guideCount)} axes=${JSON.stringify(midGuide?.guideAxes)}`,
		);
		s = await read();
		b = s.nodes.find((n) => n.id === 'snap-b') ?? null;
		check(
			'松手后左边**精确**贴到 A 的左边缘上（吸附真的改了坐标）',
			b !== null && Math.abs(b.left - a.left) <= 1,
			`A.left=${String(a.left)} B.left=${String(b?.left)}（拖到的位置是 ${String(wantX)}）`,
		);
		check('吸附只动该动的那个轴（y 没被拉走）', b !== null && Math.abs(b.top - 380) <= 1, `B.top=${String(b?.top)}`);
		check('松手后辅助线自己消失（不留在画布上）', s.guideCount === 0, `guideCount=${String(s.guideCount)}`);

		// Alt = 临时关掉吸附：同样拖到差 4px 的位置，这次**不该**被吸走。
		if (b !== null) {
			const altFrom = screenOf(s, b.left + b.box.w / 2, b.top + b.box.h / 2);
			const altTo = screenOf(s, b.left + 4 + b.box.w / 2, b.top + b.box.h / 2);
			let altGuide = null;
			await dragPointer(altFrom, altTo, {
				modifiers: 1,
				onMidway: async () => {
					await sleep(120);
					altGuide = await read();
				},
			});
			s = await read();
			const after = s.nodes.find((n) => n.id === 'snap-b') ?? null;
			check(
				'按住 Alt 拖 = 不吸附：既没有辅助线，坐标也没被拉走',
				altGuide !== null && altGuide.guideCount === 0 && after !== null && Math.abs(after.left - (b.left + 4)) <= 1,
				`guideCount=${String(altGuide?.guideCount)} 期望 left=${String(b.left + 4)} 实际=${String(after?.left)}`,
			);
		}
	}

	const shot = await browser.cdp.send('Page.captureScreenshot', { format: 'png' });
	await writeFile(SHOT, Buffer.from(shot.data, 'base64'));
	console.log(`\n截图：${SHOT}`);
} catch (error) {
	check('脚本执行未抛错', false, error instanceof Error ? error.message : String(error));
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
