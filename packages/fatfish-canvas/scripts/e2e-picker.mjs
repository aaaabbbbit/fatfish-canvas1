/**
 * P39 端到端：composer 那格生成模型选择器（图标触发器 / 悬停飞出档位 / 蓝尾巴）。
 *
 * 覆盖三件事，每一条都**只有真实浏览器**能回答：
 *
 *   1. **触发器只剩一枚鲸鱼尾巴图标**：没有文字、17×17、放上去（不点）就摇、
 *      选过模型之后颜色 = 强调色（`--dsw-alias-state-business-primary`）。
 *   2. **点开菜单才看得见模型名**：菜单顶部那行写的是当前选中的模型。
 *   3. **档位「移上去就跳出来」**：悬停家族行 → 右侧飞出面板出现（**没有点击**）；
 *      指针从行挪进面板时面板不会消失（那 150ms 的宽限）；换一行悬停面板跟着换；
 *      **在面板里真按下鼠标**能选中并关掉菜单（NOTES §8.48 那个坑的回归守卫）。
 *   4. **右键 = 开关设计技能**（P41）：真右键把设置里的开关翻过来 —— 关了尾巴
 *      压回默认纯色（选过模型的蓝也照压），再右键一回回到原样（profile 留在初始态）。
 *
 * ⚠️ 指针路径必须用 `Input.dispatchMouseEvent` 真派发：合成 `el.click()` 不产生
 *    pointerdown / mouseenter，菜单与面板的开关时机它一概测不到（NOTES §8.48 末）。
 * ⚠️ 本轮**故意不点「别的」模型**：那会写进用户的真实设置。收尾点的是
 *   **当前已经选中的那一行**（写回同一个值）—— 菜单关上就证明这次点击真的到了。
 *
 * 用法（需放宽沙箱：无头 Chrome 要创建命名管道）：
 *   node scripts/e2e-picker.mjs
 */

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PACKAGE_ROOT, click, evaluate, launch, sleep } from './lib/cdp.mjs';

const URL_TARGET = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080/';
const SHOT = resolve(PACKAGE_ROOT, 'lib/e2e-picker.png');
const SHOT_FLY = resolve(PACKAGE_ROOT, 'lib/e2e-picker-flyout.png');

/** 飞出面板与菜单之间那条缝（px，与 ModelPicker.tsx 的 FLY_GAP 同值）。 */
const FLY_GAP = 4;

/** 与 ModelPicker.tsx 的 FLY_GRACE 同值：指针穿过那条缝的宽限时间。 */
const FLY_GRACE = 150;

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
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) }; };
  const center = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; };
  const cls = (el) => (el && typeof el.className === 'string' ? el.className.trim() : '');
  const text = (el) => (el ? (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80) : null);
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const hit = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); if (r.width === 0) return false; const h = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return h !== null && (h === el || el.contains(h)); };
  /* 令牌求值：临时插一个元素把 var(--x) 算出具体色值（页面里没别的口子能读到它） */
  const tokenColor = (name) => { const el = document.createElement('span'); el.style.color = 'var(' + name + ')'; el.style.position = 'absolute'; document.body.appendChild(el); const c = getComputedStyle(el).color; el.remove(); return c; };

  const trigger = qa('.ffc-mp-trigger').filter(visible)[0] ?? null;
  const layer = qa('.ffc-mp-layer')[0] ?? null;
  const menu = qa('.ffc-mp-menu').filter(visible)[0] ?? null;
  const fly = qa('.ffc-mp-flyout').filter(visible)[0] ?? null;
  const whale = trigger ? trigger.querySelector('.ffc-whale') : null;
  const still = whale ? whale.querySelector('.ffc-whale-still') : null;
  const anim = whale ? whale.querySelector('.ffc-whale-anim') : null;
  const path = still ? still.querySelector('path') : null;
  const checkOf = (el) => el !== null && el.querySelector('.ffc-mp-check svg') !== null;

  return JSON.stringify({
    mode: document.body.dataset.ffcMode ?? null,
    trigger: rect(trigger),
    triggerCenter: center(trigger),
    triggerText: text(trigger),
    triggerLabel: trigger ? trigger.getAttribute('aria-label') : null,
    triggerTitle: trigger ? trigger.getAttribute('title') : null,
    triggerPicked: trigger ? trigger.getAttribute('data-ffc-picked') : null,
    triggerSkill: trigger ? trigger.getAttribute('data-ffc-skill') : null,
    triggerColor: trigger ? getComputedStyle(trigger).color : null,
    triggerChildren: trigger ? trigger.children.length : null,
    accent: tokenColor('--dsw-alias-state-business-primary'),
    secondary: tokenColor('--dsw-alias-label-secondary'),
    whale: whale ? {
      box: { w: Math.round(whale.getBoundingClientRect().width), h: Math.round(whale.getBoundingClientRect().height) },
      rect: rect(whale),
      stillDisplay: still ? getComputedStyle(still).display : null,
      animDisplay: anim ? getComputedStyle(anim).display : null,
      fill: path ? getComputedStyle(path).fill : null,
      stroke: path ? getComputedStyle(path).stroke : null,
    } : null,
    menuOpen: menu !== null,
    menu: rect(menu),
    headKind: menu ? text(menu.querySelector('.ffc-mp-headKind')) : null,
    headName: menu ? text(menu.querySelector('.ffc-mp-headName')) : null,
    hasFly: fly !== null,
    fly: rect(fly),
    flyKey: fly ? fly.getAttribute('data-flyout') : null,
    flyTitle: fly ? text(fly.querySelector('.ffc-mp-groupTitle')) : null,
    inLayer: layer !== null && menu !== null && layer.contains(menu),
    flyInLayer: layer !== null && fly !== null && layer.contains(fly),
    families: qa('.ffc-mp-menu [data-model-family]').map((el) => ({ key: el.getAttribute('data-model-family'), current: checkOf(el), center: center(el), rect: rect(el) })),
    flyRows: fly ? Array.from(fly.querySelectorAll('.ffc-mp-option')).map((el) => ({ ref: el.getAttribute('data-model-option'), label: text(el), current: checkOf(el), center: center(el), hit: hit(el) })) : [],
    sessionRows: qa('div[class*="sessionRow"]').length,
  });
})()`;

const browser = await launch();
const read = async () => JSON.parse(await evaluate(browser.cdp, PROBE));

/** 只移动指针（不点击）——「放上去就动」这类判据只能这么测。 */
const hover = async (point) => {
	await browser.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, buttons: 0 });
};

/** 右键（按下 + 抬起）：切换设计技能的那只手。合成的 contextmenu 必须真派发。 */
const rightClick = async (point) => {
	await browser.cdp.send('Input.dispatchMouseEvent', {
		type: 'mousePressed', x: point.x, y: point.y, button: 'right', buttons: 2, clickCount: 1,
	});
	await browser.cdp.send('Input.dispatchMouseEvent', {
		type: 'mouseReleased', x: point.x, y: point.y, button: 'right', buttons: 0, clickCount: 1,
	});
};

/**
 * 打开一个**正常**的真实会话（模型选择器住在 composer 里，只有会话页才有）。
 * @returns 打开的会话文案；找不到时为 null。
 */
async function openRealSession() {
	const rows = await evaluate(
		browser.cdp,
		`Array.from(document.querySelectorAll('div[class*="sessionRow"]')).map((el) => { const r = el.getBoundingClientRect(); return { text: (el.textContent || '').replace(/\\s+/g, ' ').trim(), kids: el.children.length, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })`,
	);
	const candidates = rows.filter(
		(row) => row.kids >= 4 && row.text !== '' && !row.text.includes('新会话') && !row.text.includes('等待审批'),
	);
	for (const row of candidates.slice(0, 3)) {
		await click(browser.cdp, row.x, row.y);
		await sleep(3000);
		const after = await read();
		if (after.trigger !== null) return row.text;
	}
	return null;
}

console.log(`\n肥鱼画布 · P39 端到端（生成模型格：图标触发器 / 悬停飞出档位 / 蓝尾巴）\n目标：${URL_TARGET}\n`);

try {
	// ── 就位：聊天模式（composer 在聊天列里），并刷新一次拿最新产物 ──
	let loaded = browser.cdp.once('Page.loadEventFired');
	await browser.cdp.send('Page.navigate', { url: URL_TARGET });
	await loaded;
	await evaluate(browser.cdp, `(() => { window.localStorage.setItem('fatfish-canvas:view-mode', 'chat'); return true; })()`);
	loaded = browser.cdp.once('Page.loadEventFired');
	await browser.cdp.send('Page.reload', { ignoreCache: false });
	await loaded;
	await sleep(9000);

	// ── 0. 打开真实会话，找到那一格 ──
	console.log('0) 打开一个真实会话，找到 composer 里那格模型选择');
	const opened = await openRealSession();
	check('打开了一个正常会话', opened !== null, String(opened));
	let s = await read();
	check('生成模型触发器渲染出来了（composer 的 input.right 席位）', s.trigger !== null && s.trigger.w > 0, JSON.stringify(s.trigger));
	if (s.trigger === null) throw new Error('找不到 .ffc-mp-trigger：这一轮没法继续（先确认会话页的 composer 在）');

	// ── 1. 触发器：只有一枚鲸鱼尾巴图标 ──
	console.log('\n1) 触发器只有一枚图标（模型名不在这里）');
	check('触发器里没有任何文字', s.triggerText === '', JSON.stringify(s.triggerText));
	check('触发器只有一枚子元素（那枚图标）', s.triggerChildren === 1, String(s.triggerChildren));
	check(
		'它是 28×28 的方格（图标格的尺寸，与本体同一行那些格子一致）',
		s.trigger.w === 28 && s.trigger.h === 28,
		JSON.stringify(s.trigger),
	);
	check(
		'图形是鲸鱼尾巴：17×17 正方（老位图是 1152:976，会在这里露馅）',
		s.whale !== null && s.whale.box.w === 17 && s.whale.box.h === 17,
		JSON.stringify(s.whale),
	);
	check(
		'颜色走 currentColor：填充与描边都 = 触发器的 color',
		s.whale !== null && s.whale.fill !== null && s.whale.fill === s.triggerColor && s.whale.stroke === s.triggerColor,
		`fill ${String(s.whale?.fill)} / stroke ${String(s.whale?.stroke)} vs color ${String(s.triggerColor)}`,
	);

	// ── 2. 选过模型 → 尾巴是强调蓝；没选过 → 次要文字色 ──
	console.log('\n2) 尾巴的颜色：选过模型 = 强调蓝');
	const picked = s.triggerPicked === 'true';
	check(
		picked
			? '选过模型时颜色 = 强调色（state-business-primary，deepseek 蓝）'
			: '没选过模型时颜色 = 次要文字色（不是蓝）',
		picked ? s.triggerColor === s.accent : s.triggerColor === s.secondary,
		`data-ffc-picked=${String(s.triggerPicked)} color=${String(s.triggerColor)} 强调=${String(s.accent)} 次要=${String(s.secondary)}`,
	);

	// ── 3. 鼠标放上去（不点）就摇 ──
	console.log('\n3) 鼠标放上去（不点击）就摇尾巴');
	await hover({ x: 20, y: 500 });
	await sleep(300);
	s = await read();
	check(
		'没碰它时是静止态：实心那枚在、会摇的那枚 display:none',
		s.whale !== null && s.whale.stillDisplay !== 'none' && s.whale.animDisplay === 'none',
		`still ${String(s.whale?.stillDisplay)} / anim ${String(s.whale?.animDisplay)}`,
	);
	const triggerCenter = s.triggerCenter;
	await hover(triggerCenter);
	await sleep(400);
	s = await read();
	check(
		'悬停（真的只移动指针）就换成会摇的那枚',
		s.whale !== null && s.whale.animDisplay === 'block' && s.whale.stillDisplay === 'none',
		`anim ${String(s.whale?.animDisplay)} / still ${String(s.whale?.stillDisplay)}`,
	);
	const wagFrames = [];
	for (let i = 0; i < 5; i += 1) {
		const shot = await browser.cdp.send('Page.captureScreenshot', {
			format: 'png',
			clip: { x: s.whale.rect.x, y: s.whale.rect.y, width: s.whale.rect.w, height: s.whale.rect.h, scale: 2 },
		});
		wagFrames.push(Buffer.from(shot.data, 'base64').toString('base64'));
		await sleep(120);
	}
	check(
		'它真的在摇（真实时钟下 5 张截图里不止一种画面）',
		new Set(wagFrames).size >= 2,
		`不同帧 ${String(new Set(wagFrames).size)}/5`,
	);
	// 悬停态下颜色同样是强调蓝（会摇那枚是 currentColor 的遮罩）
	check(
		'摇着的时候颜色也跟触发器一致（跟主题，不写死）',
		s.triggerColor === (picked ? s.accent : s.secondary),
		`color=${String(s.triggerColor)}`,
	);

	// ── 4. 点开：菜单顶部才显示当前模型名 ──
	console.log('\n4) 点开菜单：模型名在菜单顶部那一行');
	await click(browser.cdp, triggerCenter.x, triggerCenter.y);
	await sleep(600);
	s = await read();
	check('单击触发器打开菜单', s.menuOpen === true, JSON.stringify(s.menu));
	check(
		'菜单与飞出面板挂在同一个浮层容器里（点面板里不算点到外面）',
		s.inLayer === true,
		`inLayer=${String(s.inLayer)}`,
	);
	check(
		'菜单顶部写着「当前选中的模型」（点了才看得见的那行字）',
		s.headName !== null && s.headName !== '',
		`${String(s.headKind)} / ${String(s.headName)}`,
	);
	// 期望值从**触发器自己的无障碍标签**里取，不写死某个模型名（用户的配置会变）
	const labelModel = String(s.triggerLabel).replace(/^.*当前图像模型 /, '').trim();
	check(
		'那一行与无障碍标签里那个模型是同一份读数',
		s.headName !== null && (s.headName === labelModel || String(s.headName).startsWith(labelModel)),
		`head=${String(s.headName)} label=${labelModel}`,
	);
	check('触发器上仍然没有文字（名字只在菜单里）', s.triggerText === '', JSON.stringify(s.triggerText));
	check('**还没悬停任何家族行**时没有飞出面板（面板由悬停开，不由打开菜单开）', s.hasFly === false, String(s.hasFly));
	check('菜单里至少有一个家族行（有分辨率兄弟的那种模型）', s.families.length > 0, JSON.stringify(s.families.map((f) => f.key)));

	// ── 5. 悬停家族行：档位自己跳出来（不点） ──
	console.log('\n5) 悬停家族行 → 档位面板自己跳出来（没有点击）');
	const currentFamily = s.families.find((f) => f.current === true);
	check('找到「当前模型所在的那一行」（会打勾的那种）', currentFamily !== undefined, JSON.stringify(s.families));
	if (currentFamily === undefined) throw new Error('菜单里没有勾着的家族行：这一轮的悬停判据没法定位');
	await hover(currentFamily.center);
	await sleep(400);
	s = await read();
	check('悬停家族行就开出了飞出面板', s.hasFly === true, JSON.stringify(s.fly));
	check(
		'它就是那一行的面板（data-flyout = 家族键）',
		s.flyKey === currentFamily.key,
		`${String(s.flyKey)} vs ${currentFamily.key}`,
	);
	check(
		'面板贴在菜单**右侧**（右缘起 ' + String(FLY_GAP) + 'px 的缝；贴边时允许翻到左边）',
		s.fly !== null && s.menu !== null && (Math.abs(s.fly.x - s.menu.right - FLY_GAP) <= 2 || Math.abs(s.menu.x - s.fly.right - FLY_GAP) <= 2),
		`menu=${JSON.stringify(s.menu)} fly=${JSON.stringify(s.fly)}`,
	);
	check(
		'面板与那一行对齐（顶端落在行的范围内）',
		s.fly !== null && currentFamily.rect !== null && s.fly.y >= currentFamily.rect.y - 24 && s.fly.y <= currentFamily.rect.bottom,
		`fly.y=${String(s.fly?.y)} row=${JSON.stringify(currentFamily.rect)}`,
	);
	check('面板标题写着这是哪个家族', s.flyTitle !== null && s.flyTitle !== '', String(s.flyTitle));
	check(
		'面板里有成员行（「用这个模型」的入口，NOTES §8.51：没有它等于选不中）',
		s.flyRows.length > 0,
		JSON.stringify(s.flyRows.map((r) => r.ref)),
	);
	check(
		'当前选中的那一行在面板里打着勾',
		s.flyRows.some((r) => r.current === true),
		JSON.stringify(s.flyRows.map((r) => `${String(r.ref)}:${String(r.current)}`)),
	);
	check(
		'面板里的每一行都真的可命中（elementFromPoint 落在它身上，不只看坐标）',
		s.flyRows.length > 0 && s.flyRows.every((r) => r.hit === true),
		JSON.stringify(s.flyRows.map((r) => `${String(r.ref)}:${String(r.hit)}`)),
	);

	// 指针从行挪进面板：那 150ms 的宽限要能兜住
	await hover({ x: s.fly.x + Math.round(s.fly.w / 2), y: s.fly.y + Math.round(s.fly.h / 2) });
	await sleep(FLY_GRACE + 250);
	s = await read();
	check(
		'指针挪进面板之后它还开着（行与面板之间那条缝不能把面板关掉）',
		s.hasFly === true,
		String(s.hasFly),
	);

	// ── 6. 换一行悬停：面板跟着换 ──
	console.log('\n6) 悬停另一行 → 面板跟着换（确实是悬停在驱动）');
	const otherFamily = s.families.find((f) => f.current === false) ?? null;
	if (otherFamily === null) {
		check('（菜单里只有一个家族行，跳过「换行」这条）', true);
	} else {
		await hover(otherFamily.center);
		await sleep(400);
		s = await read();
		check(
			'悬停另一行 → 面板换成它的',
			s.hasFly === true && s.flyKey === otherFamily.key,
			`${String(s.flyKey)} vs ${otherFamily.key}`,
		);
	}

	// ── 7. 在面板里**真按下鼠标**：选中并关掉菜单（§8.48 的回归守卫） ──
	console.log('\n7) 在飞出面板里真按下鼠标：选中生效、菜单关上');
	await hover(currentFamily.center);
	await sleep(400);
	s = await read();
	const titleBefore = s.triggerTitle;
	const target = s.flyRows.find((r) => r.current === true) ?? null;
	if (target === null) {
		check('（当前没有勾着的成员行 —— 是「自动」，跳过真点这一条）', true);
	} else {
		check('要点的就是当前那一行（写回同一个值，不动用户的配置）', target.current === true, String(target.ref));
		const shot = await browser.cdp.send('Page.captureScreenshot', { format: 'png' });
		await writeFile(SHOT_FLY, Buffer.from(shot.data, 'base64'));
		await click(browser.cdp, target.center.x, target.center.y);
		await sleep(1500);
		s = await read();
		check(
			'真按下鼠标之后菜单关上了（pointerdown 没把面板提前卸掉 —— 否则这一下点不动）',
			s.menuOpen === false,
			`menuOpen=${String(s.menuOpen)}`,
		);
		check(
			'选的是同一个模型，所以设置没被改动（title 一字不变）',
			s.triggerTitle === titleBefore,
			`${String(titleBefore)} -> ${String(s.triggerTitle)}`,
		);
		check('关掉之后飞出面板也跟着收了', s.hasFly === false, String(s.hasFly));
	}

	// ── 8. 指针移开：回到静止态 ──
	console.log('\n8) 指针移开：尾巴回到静止态');
	await hover({ x: 20, y: 500 });
	await sleep(400);
	s = await read();
	check(
		'移开后回到静止态（实心那枚回来、动图那枚收掉）',
		s.whale !== null && s.whale.animDisplay === 'none' && s.whale.stillDisplay !== 'none',
		`anim ${String(s.whale?.animDisplay)} / still ${String(s.whale?.stillDisplay)}`,
	);

	// ── 9. 键盘还在（焦点搬到浮层容器上了，Esc 要照样能关） ──
	console.log('\n9) 键盘：Esc 关掉菜单（焦点在浮层容器上，事件仍到得了）');
	await click(browser.cdp, triggerCenter.x, triggerCenter.y);
	await sleep(600);
	s = await read();
	check('再点一次又打开了（顺带验一次往返）', s.menuOpen === true, String(s.menuOpen));
	const focused = await evaluate(browser.cdp, `(() => { const a = document.activeElement; return a ? a.className : null; })()`);
	check('焦点落在浮层容器上（菜单与飞出面板的共同祖先）', focused === 'ffc-mp-layer', String(focused));
	await browser.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
	await browser.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
	await sleep(400);
	s = await read();
	check('Esc 关掉了菜单', s.menuOpen === false, String(s.menuOpen));

	// ── 10. 右键 = 开关设计技能（P41） ──
	console.log('\n10) 右键尾巴：开关设计技能');
	// 初始态可能带着上一轮残留：不预设「一定开着」，断言的是**往返**与「关时的读数」。
	const skillBefore = s.triggerSkill;
	const colorBefore = s.triggerColor;
	let center = await read().then((r) => r.triggerCenter);
	await rightClick(center);
	await sleep(1200);
	s = await read();
	const turnedOff = skillBefore === null; // 缺席 = 开 → 这次该变成关
	check(
		'右键一次：设计开关翻转（设置里写进了显式布尔）',
		turnedOff ? s.triggerSkill === 'false' : s.triggerSkill === null,
		`before=${String(skillBefore)} after=${String(s.triggerSkill)}`,
	);
	if (turnedOff) {
		check(
			'关掉之后尾巴是默认的纯色（用户要的「关闭后变成默认的纯色」，哪怕是选过模型的蓝也被压回去）',
			s.triggerColor === s.secondary,
			`color=${String(s.triggerColor)} 次要=${String(s.secondary)}`,
		);
	} else {
		check(
			'重新打开之后关态消失（回到 picked 语义的颜色）',
			s.triggerSkill === null,
			String(s.triggerSkill),
		);
	}
	// 右键再切回来：读写都要能回到原样（顺带把 profile 留在初始态）
	center = s.triggerCenter;
	await rightClick(center);
	await sleep(1200);
	s = await read();
	check(
		'右键第二次：开关回原样（属性与颜色都回到右键前）',
		s.triggerSkill === skillBefore && s.triggerColor === colorBefore,
		`skill ${String(skillBefore)}→${String(s.triggerSkill)} color ${String(colorBefore)}→${String(s.triggerColor)}`,
	);
	check('往返之后菜单没有被误开（contextmenu 没当成点击）', s.menuOpen === false, String(s.menuOpen));

	const shot = await browser.cdp.send('Page.captureScreenshot', { format: 'png' });
	await writeFile(SHOT, Buffer.from(shot.data, 'base64'));
	console.log(`\n截图：${SHOT}${target === null ? '' : `\n顺手留了一张悬停面板的：${SHOT_FLY}`}`);
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
