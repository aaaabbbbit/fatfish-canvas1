/**
 * P9 端到端：设置页真的能配出一家「第三方供应商」并跑通探测。
 *
 * 这条链路只有在**真实 GUI + 真实宿主**上才能验证，因为它横跨四层：
 *
 *   设置页（浏览器）→ settings.mutate / credentials.set（RPC）
 *     → 宿主 settings namespace（providers 字典）与凭据库
 *       → mediaProbe 远程命名空间（Typert）→ 宿主 fetch 供应商
 *         → 本机假服务（scripts/fake-media-server.mjs）
 *
 * 覆盖用户要的四件事：
 *   1. **添加第三方供应商**（自定义 baseURL）
 *   2. **测试连接**（宿主拿密钥去 `{base}/models`）
 *   3. **获取模型列表**（点一下把模型加进来，自动标好图像 / 视频）
 *   4. **每个模型单独配密钥**（右键模型行）
 * 外加：默认模型选择、以及跑完把测试用的供应商与凭据清理干净。
 *
 * 前置：假服务要在跑（脚本自己起一个），且宿主已重启（新 schema + mediaProbe）。
 * 判定宿主是否已重启：设置页那两个探测按钮**能用**（旧宿主没有 mediaProbe，
 * 按钮是置灰的），因此脚本把「按钮置灰」直接判成失败并提示重启。
 *
 * 用法（需放宽沙箱：无头 Chrome 要创建命名管道）：
 *   node scripts/e2e-settings.mjs
 */

import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PACKAGE_ROOT, click, evaluate, launch, sleep } from './lib/cdp.mjs';

const URL_TARGET = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080/';
const SHOT = resolve(PACKAGE_ROOT, 'lib/e2e-settings.png');
const FAKE_PORT = Number(process.env.FFC_FAKE_PORT ?? 8791);
const FAKE_KEY = 'sk-e2e-local';
/** 测试供应商 id 的前缀（id 由页面生成，只能按前缀认）。 */
const TEST_ID_RE = /^(custom|e2e-local)/;

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
  const text = (el) => (el ? (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200) : null);
  const card = qa('.ffc-set-card[data-provider]').find((c) => /^(custom|e2e-local)/.test(c.getAttribute('data-provider'))) || null;
  const inCard = (sel) => card ? card.querySelector(sel) : null;
  const btn = (action) => card ? card.querySelector('[data-action="' + action + '"]') : null;
  const modelRow = (id) => card ? card.querySelector('[data-model="' + id + '"]') : null;

  return JSON.stringify({
    sectionOpen: q('.ffc-set') !== null,
    hasAddButton: q('.ffc-set-addbtn') !== null,
    probeWarning: (() => { const el = qa('.ffc-set-status').find((e) => (e.textContent || '').includes('mediaProbe')); return el ? text(el) : null; })(),
    cardExists: card !== null,
    cardText: text(card ? card.querySelector('.ffc-set-head') : null),
    baseURLValue: inCard('input[data-field="baseURL"]') ? inCard('input[data-field="baseURL"]').value : null,
    providerKeyState: text(inCard('.ffc-set-keyvalue')),
    cardMessage: text(inCard('.ffc-set-msg')),
    testBtn: (() => { const b = btn('test'); return b ? { ...center(b), disabled: b.disabled === true, label: text(b) } : null; })(),
    modelsBtn: (() => { const b = btn('models'); return b ? { ...center(b), disabled: b.disabled === true, label: text(b) } : null; })(),
    saveProviderKeyBtn: (() => { const b = btn('save-provider-key'); return b ? { ...center(b), disabled: b.disabled === true } : null; })(),
    providerSecretInput: (() => { const i = inCard('input[data-field="provider-secret"]'); return i ? { ...center(i), value: i.value } : null; })(),
    editProviderKeyBtn: (() => { const b = btn('edit-provider-key'); return b ? { ...center(b), label: text(b) } : null; })(),
    clearProviderKeyBtn: (() => { const b = btn('clear-provider-key'); return b ? center(b) : null; })(),
    modelIds: card ? Array.from(card.querySelectorAll('.ffc-set-model[data-model]')).map((el) => el.getAttribute('data-model')) : [],
    modelKinds: card ? Array.from(card.querySelectorAll('.ffc-set-model[data-kind]')).map((el) => ({ id: el.getAttribute('data-model'), kind: el.getAttribute('data-kind'), text: text(el) })) : [],
    pickerChips: card ? Array.from(card.querySelectorAll('[data-add-model]')).map((el) => ({ id: el.getAttribute('data-add-model'), ...center(el) })) : [],
    addModelBtn: (() => { const b = btn('add-model'); return b ? center(b) : null; })(),
    menu: (() => {
      const m = q('.ffc-model-menu');
      if (!m) return null;
      return { model: m.getAttribute('data-model'), rect: rect(m), items: qa('.ffc-model-menu .ffc-menu-item').map((b) => ({ action: b.getAttribute('data-action'), label: text(b), ...center(b) })) };
    })(),
    modelKeyEditor: (() => { const i = inCard('input[data-field="model-secret"]'); return i ? { ...center(i), value: i.value } : null; })(),
    saveModelKeyBtn: (() => { const b = btn('save-model-key'); return b ? { ...center(b), disabled: b.disabled === true } : null; })(),
    removeProviderBtn: (() => { const b = btn('remove-provider'); return b ? center(b) : null; })(),
    defaults: {
      image: (() => { const s = q('select[data-default="image"]'); return s ? s.value : null; })(),
      video: (() => { const s = q('select[data-default="video"]'); return s ? s.value : null; })(),
      options: qa('select[data-default="image"] option').map((o) => o.value),
    },
    storage: (() => {
      try { return JSON.parse(window.localStorage.getItem('dsh.settings.pending') || 'null'); } catch (e) { return null; }
    })(),
  });
})()`;

/** 设置页：打开设置 → 进本插件的分节。 */
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

const browser = await launch();
const read = async () => JSON.parse(await evaluate(browser.cdp, PROBE));

/** 在输入框里键入文本（真实按键，走 React 的 onChange）。 */
async function typeInto(selector, text) {
	await evaluate(browser.cdp, `document.querySelector(${JSON.stringify(selector)}).focus()`);
	await browser.cdp.send('Input.insertText', { text });
	await sleep(180);
}

/**
 * 清空并输入。
 * @param selector - CSS 选择器。
 * @param text - 要输入的文本。
 */
async function retype(selector, text) {
	const box = await evaluate(
		browser.cdp,
		`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.focus(); el.select && el.select(); return true; })()`,
	);
	if (box !== true) return false;
	await browser.cdp.send('Input.dispatchKeyEvent', {
		type: 'keyDown',
		key: 'Delete',
		code: 'Delete',
		windowsVirtualKeyCode: 46,
		nativeVirtualKeyCode: 46,
	});
	await browser.cdp.send('Input.dispatchKeyEvent', {
		type: 'keyUp',
		key: 'Delete',
		code: 'Delete',
		windowsVirtualKeyCode: 46,
		nativeVirtualKeyCode: 46,
	});
	await browser.cdp.send('Input.insertText', { text });
	return true;
}

/**
 * 用一次真实鼠标点击制造失焦（并等提交完成）。
 * @param target - 点哪个选择器（安全的中性元素）。
 */
async function blurByClicking(target) {
	const spot = await evaluate(
		browser.cdp,
		`(() => { const el = document.querySelector(${JSON.stringify(target)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
	);
	if (spot !== null) await click(browser.cdp, spot.x, spot.y);
	await sleep(900);
}

/**
 * 往一个「失焦提交」的输入框里填值。
 *
 * ⚠️ **不能用合成事件**：React 把 `onBlur` 委托在原生 **focusout** 上，而
 * `el.dispatchEvent(new Event('blur', { bubbles: true }))` 既不是 focusout、
 * 原生 blur 本身又不冒泡 → React 的 onBlur 永远不触发 → 值只停在**草稿**里，
 * **根本没写进设置**。前两轮验证就栽在这里：界面回显是对的（那是草稿），
 * 宿主读到的却是空基址，于是「测试连接」报「这个供应商还没有填接口基址」。
 * 正解：真实聚焦 + `Input.insertText`（触发真实的 input 事件）+ 点别处造成**真实失焦**。
 * @param selector - 输入框选择器。
 * @param text - 要填的值。
 * @param blurTarget - 点哪里制造失焦（默认点说明文字，安全无害）。
 * @returns 是否找到并填了那个输入框。
 */
async function fillField(selector, text, blurTarget = '.ffc-set-intro') {
	const found = await evaluate(
		browser.cdp,
		`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); if (el.select) el.select(); return true; })()`,
	);
	if (found !== true) return false;
	await browser.cdp.send('Input.insertText', { text });
	await sleep(150);
	await blurByClicking(blurTarget);
	return true;
}

/** 打开假服务（探测的目标）。 */
function startFakeServer() {
	const child = spawn(
		process.execPath,
		[
			resolve(PACKAGE_ROOT, 'scripts/fake-media-server.mjs'),
			'--port',
			String(FAKE_PORT),
			'--delay',
			'300',
			'--key',
			FAKE_KEY,
		],
		{ stdio: 'ignore' },
	);
	return child;
}

console.log(
	`\n肥鱼画布 · P9 端到端（第三方供应商 / 测试连接 / 获取模型列表 / 模型级密钥）\n目标：${URL_TARGET}\n假服务：http://127.0.0.1:${String(FAKE_PORT)}/v1\n`,
);

const fake = startFakeServer();
await sleep(900);

try {
	// 就位：**必须回到聊天模式**。
	//
	// 设置入口（侧边栏底部的「设置」）只在侧边栏展开时存在，而画布模式下
	// AppFrame 被收窄到 <1024px 会触发它自己的 sidebar 自动塌缩 —— 于是
	// 「找不到设置入口」。第一次自动化验证正是栽在这里（`no-settings-trigger`），
	// 因为上一个 e2e 把模式留在了 canvas。
	let loaded = browser.cdp.once('Page.loadEventFired');
	await browser.cdp.send('Page.navigate', { url: URL_TARGET });
	await loaded;
	await evaluate(
		browser.cdp,
		`(() => {
			window.localStorage.setItem('fatfish-canvas:view-mode', 'chat');
			window.localStorage.removeItem('fatfish-canvas:board-scope');
			return true;
		})()`,
	);
	loaded = browser.cdp.once('Page.loadEventFired');
	await browser.cdp.send('Page.reload', { ignoreCache: false });
	await loaded;
	await sleep(9000);

	// ── 1. 打开设置页 ──
	console.log('1) 打开「图像 / 视频模型」设置页');
	const opened = await evaluate(browser.cdp, OPEN_SETTINGS);
	check('设置页打开并渲染本插件的分节', opened === 'ok', String(opened));

	let s = await read();
	check('页面有「添加供应商」入口', s.hasAddButton === true);
	check(
		'宿主已提供探测服务（旧宿主没有 mediaProbe，这里会是置灰+警告）',
		s.probeWarning === null,
		String(s.probeWarning),
	);

	// 上一次跑残留的测试供应商先删掉，保证幂等。
	//
	// ⚠️ 按**前缀**清理而不是按固定 id：新建供应商的 id 由页面生成
	// （`custom`、`custom-2`…），失败的那次运行会把 `custom` 留在设置里，
	// 下一次就会生成 `custom-2`。只删一个固定 id 会让垃圾越积越多。
	const staleIds = await evaluate(
		browser.cdp,
		`(() => Array.from(document.querySelectorAll('.ffc-set-card[data-provider]')).map((c) => c.getAttribute('data-provider')).filter((id) => /^(custom|e2e-local)/.test(id)))()`,
	);
	for (const id of Array.isArray(staleIds) ? staleIds : []) {
		// 先清密钥（顺带把凭据也删掉），再删供应商
		await evaluate(
			browser.cdp,
			`(() => { const c = document.querySelector('[data-provider="${String(id)}"]'); const b = c && c.querySelector('[data-action="clear-provider-key"]'); if (b && !b.disabled) b.click(); return true; })()`,
		);
		await sleep(1000);
		await evaluate(
			browser.cdp,
			`(() => { const c = document.querySelector('[data-provider="${String(id)}"]'); const b = c && c.querySelector('[data-action="remove-provider"]'); if (b) b.click(); return true; })()`,
		);
		await sleep(1200);
	}
	s = await read();
	const stillStale = await evaluate(
		browser.cdp,
		`(() => Array.from(document.querySelectorAll('.ffc-set-card[data-provider]')).map((c) => c.getAttribute('data-provider')).filter((id) => /^(custom|e2e-local)/.test(id)))()`,
	);
	check('起点没有测试供应商（幂等）', Array.isArray(stillStale) && stillStale.length === 0, JSON.stringify(stillStale));

	// ── 2. 添加一个自定义供应商 ──
	console.log('\n2) 添加第三方供应商（自定义）');
	await evaluate(browser.cdp, "document.querySelector('.ffc-set-addbtn').click()");
	await sleep(400);
	const presetClicked = await evaluate(
		browser.cdp,
		`(() => {
			const b = document.querySelector('.ffc-preset-menu [data-preset="custom"]');
			if (!b) return false;
			b.click();
			return true;
		})()`,
	);
	check('预设菜单里有「自定义供应商」并点得动', presetClicked === true);
	await sleep(1200);
	s = await read();
	check(
		'出现了一家新的自定义供应商卡片（id 由页面生成，这里匹配前缀）',
		// 供应商 id 是 freeProviderId('custom') 生成的，因此按前缀找卡片
		await evaluate(
			browser.cdp,
			`(() => Array.from(document.querySelectorAll('.ffc-set-card[data-provider]')).some((c) => /^custom/.test(c.getAttribute('data-provider'))))()`,
		) === true,
		JSON.stringify(s.modelIds),
	);

	// 取到生成的 id，后续都用它
	const generatedId = await evaluate(
		browser.cdp,
		`(() => { const c = Array.from(document.querySelectorAll('.ffc-set-card[data-provider]')).find((x) => /^custom/.test(x.getAttribute('data-provider'))); return c ? c.getAttribute('data-provider') : null; })()`,
	);
	check('拿得到新供应商的 id', typeof generatedId === 'string' && generatedId !== '', String(generatedId));

	// 填显示名与接口基址（两个都是**失焦提交**的字段，必须用真实输入 + 真实失焦）
	await fillField(`[data-provider="${String(generatedId)}"] input[data-field="label"]`, 'E2E 本地假供应商');
	await fillField(
		`[data-provider="${String(generatedId)}"] input[data-field="baseURL"]`,
		`http://127.0.0.1:${String(FAKE_PORT)}/v1`,
	);
	await sleep(900);

	const savedBase = await evaluate(
		browser.cdp,
		`(() => { const card = document.querySelector('[data-provider="${String(generatedId)}"]'); const i = card.querySelector('input[data-field="baseURL"]'); return i ? i.value : null; })()`,
	);
	check('接口基址已保存并回显', savedBase === `http://127.0.0.1:${String(FAKE_PORT)}/v1`, String(savedBase));

	// ── 3. 配密钥（凭据库） ──
	console.log('\n3) 供应商密钥进凭据库');
	await evaluate(
		browser.cdp,
		`(() => { const card = document.querySelector('[data-provider="${String(generatedId)}"]'); card.querySelector('[data-action="edit-provider-key"]').click(); return true; })()`,
	);
	await sleep(400);
	// 密钥框用真实输入（会把值写进组件草稿），再由「保存」按钮提交到凭据库
	await fillField(
		`[data-provider="${String(generatedId)}"] input[data-field="provider-secret"]`,
		FAKE_KEY,
	);
	await evaluate(
		browser.cdp,
		`(() => { const card = document.querySelector('[data-provider="${String(generatedId)}"]'); card.querySelector('[data-action="save-provider-key"]').click(); return true; })()`,
	);
	await sleep(1500);
	const keyState = await evaluate(
		browser.cdp,
		`(() => { const card = document.querySelector('[data-provider="${String(generatedId)}"]'); return { state: card.querySelector('.ffc-set-keyvalue').textContent.trim(), msg: (card.querySelector('.ffc-set-msg') || {}).textContent || '' }; })()`,
	);
	check(
		'密钥保存后状态显示「已配置」（说明它真的进了凭据库）',
		String(keyState.state).includes('已配置'),
		JSON.stringify(keyState),
	);

	// ── 4. 测试连接（宿主 → 假服务） ──
	console.log('\n4) 测试连接');
	await evaluate(
		browser.cdp,
		`(() => { const card = document.querySelector('[data-provider="${String(generatedId)}"]'); card.querySelector('[data-action="test"]').click(); return true; })()`,
	);
	await sleep(2500);
	const testMsg = await evaluate(
		browser.cdp,
		`(() => { const card = document.querySelector('[data-provider="${String(generatedId)}"]'); return (card.querySelector('.ffc-set-msg') || {}).textContent || ''; })()`,
	);
	check(
		'测试连接成功（宿主拿着密钥访问了假服务）',
		String(testMsg).includes('连接正常') || String(testMsg).includes('连接成功'),
		String(testMsg),
	);

	// ── 5. 获取模型列表并添加 ──
	console.log('\n5) 获取模型列表');
	await evaluate(
		browser.cdp,
		`(() => { const card = document.querySelector('[data-provider="${String(generatedId)}"]'); card.querySelector('[data-action="models"]').click(); return true; })()`,
	);
	await sleep(2500);
	const chips = await evaluate(
		browser.cdp,
		`(() => Array.from(document.querySelectorAll('[data-provider="${String(generatedId)}"] [data-add-model]')).map((el) => el.getAttribute('data-add-model')))()`,
	);
	check(
		'拉到了假服务的三个模型',
		Array.isArray(chips) && chips.length === 3 && chips.includes('fake-video-sora'),
		JSON.stringify(chips),
	);
	await evaluate(
		browser.cdp,
		`(() => { const el = document.querySelector('[data-provider="${String(generatedId)}"] [data-add-model="fake-image-large"]'); if (el) el.click(); return el !== null; })()`,
	);
	await sleep(1200);
	const models = await evaluate(
		browser.cdp,
		`(() => Array.from(document.querySelectorAll('[data-provider="${String(generatedId)}"] .ffc-set-model[data-kind]')).map((el) => ({ id: el.getAttribute('data-model'), kind: el.getAttribute('data-kind') })))()`,
	);
	check(
		'模型被加进来且种类是图像',
		Array.isArray(models) && models.some((m) => m.id === 'fake-image-large' && m.kind === 'image'),
		JSON.stringify(models),
	);

	// 再点一个视频模型，验证种类自动标识
	await evaluate(
		browser.cdp,
		`(() => { const el = document.querySelector('[data-provider="${String(generatedId)}"] [data-add-model="fake-video-sora"]'); if (el) el.click(); return el !== null; })()`,
	);
	await sleep(1200);
	const models2 = await evaluate(
		browser.cdp,
		`(() => Array.from(document.querySelectorAll('[data-provider="${String(generatedId)}"] .ffc-set-model[data-kind]')).map((el) => ({ id: el.getAttribute('data-model'), kind: el.getAttribute('data-kind') })))()`,
	);
	check(
		'视频模型被认出来并标成 video（按名字猜的种类，用户可改）',
		Array.isArray(models2) && models2.some((m) => m.id === 'fake-video-sora' && m.kind === 'video'),
		JSON.stringify(models2),
	);

	// ── 6. 右键模型行 → 单独配密钥 ──
	console.log('\n6) 右键模型行单独配密钥');
	const rowCenter = await evaluate(
		browser.cdp,
		`(() => { const el = document.querySelector('[data-provider="${String(generatedId)}"] [data-model="fake-image-large"]'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
	);
	check('拿得到模型行坐标', rowCenter !== null, JSON.stringify(rowCenter));
	if (rowCenter !== null) {
		await browser.cdp.send('Input.dispatchMouseEvent', {
			type: 'mousePressed',
			x: rowCenter.x,
			y: rowCenter.y,
			button: 'right',
			buttons: 2,
			clickCount: 1,
		});
		await browser.cdp.send('Input.dispatchMouseEvent', {
			type: 'mouseReleased',
			x: rowCenter.x,
			y: rowCenter.y,
			button: 'right',
			buttons: 0,
			clickCount: 1,
		});
		await sleep(500);
	}
	const menu = await evaluate(
		browser.cdp,
		`(() => { const m = document.querySelector('.ffc-model-menu'); if (!m) return null; return { model: m.getAttribute('data-model'), items: Array.from(m.querySelectorAll('.ffc-menu-item')).map((b) => ({ action: b.getAttribute('data-action'), label: (b.textContent || '').trim() })) }; })()`,
	);
	check('右键模型行弹出菜单', menu !== null && menu.model === 'fake-image-large', JSON.stringify(menu));
	check(
		'菜单里有「配置这个模型的密钥…」等操作（含视觉模型那一档）',
		menu !== null &&
			['key', 'kind', 'default-image', 'default-video', 'default-vision', 'remove'].every((action) =>
				menu.items.some((item) => item.action === action),
			),
		JSON.stringify(menu?.items?.map((i) => i.action)),
	);
	check(
		'默认视觉模型与图像 / 视频并排在同一处（P13：视觉模型是同一张设置页里的一档）',
		(await evaluate(
			browser.cdp,
			`(() => { const s = document.querySelector('select[data-default="vision"]'); return s ? Array.from(s.options).map((o) => o.value) : null; })()`,
		)) !== null,
	);

	// 点「配置这个模型的密钥…」
	await evaluate(
		browser.cdp,
		`(() => { const b = document.querySelector('.ffc-model-menu [data-action="key"]'); if (b) b.click(); return b !== null; })()`,
	);
	await sleep(600);
	await fillField(`[data-provider="${String(generatedId)}"] input[data-field="model-secret"]`, 'sk-model-only');
	await evaluate(
		browser.cdp,
		`(() => { const b = document.querySelector('[data-provider="${String(generatedId)}"] [data-action="save-model-key"]'); if (b) b.click(); return b !== null; })()`,
	);
	await sleep(1800);
	const modelKeyState = await evaluate(
		browser.cdp,
		`(() => { const row = document.querySelector('[data-provider="${String(generatedId)}"] [data-model="fake-image-large"]'); return row ? row.querySelector('.ffc-set-keystate').textContent.trim() : null; })()`,
	);
	check(
		'这个模型变成「单独密钥 · 已配置」（其余模型仍继承）',
		String(modelKeyState).includes('单独密钥') && String(modelKeyState).includes('已配置'),
		String(modelKeyState),
	);

	// ── 7. 设为默认图像模型 ──
	console.log('\n7) 设为默认图像模型');
	await evaluate(
		browser.cdp,
		`(() => {
			const row = document.querySelector('[data-provider="${String(generatedId)}"] [data-model="fake-image-large"]');
			const b = row.querySelector('[data-action="model-menu"]');
			b.click();
			return true;
		})()`,
	);
	await sleep(500);
	await evaluate(
		browser.cdp,
		`(() => { const b = document.querySelector('.ffc-model-menu [data-action="default-image"]'); if (b) b.click(); return b !== null; })()`,
	);
	await sleep(1500);
	const defaultImage = await evaluate(
		browser.cdp,
		`(() => { const s = document.querySelector('select[data-default="image"]'); return s ? s.value : null; })()`,
	);
	check(
		'默认图像模型变成新加的模型',
		String(defaultImage).includes('fake-image-large'),
		String(defaultImage),
	);

	// ── 8. 清理：删除测试供应商 + 清除测试凭据 ──
	console.log('\n8) 清理测试痕迹');
	await evaluate(
		browser.cdp,
		`(() => { const card = document.querySelector('[data-provider="${String(generatedId)}"]'); const b = card.querySelector('[data-action="clear-provider-key"]'); if (b) b.click(); return true; })()`,
	);
	await sleep(1200);
	await evaluate(
		browser.cdp,
		`(() => { const card = document.querySelector('[data-provider="${String(generatedId)}"]'); const b = card.querySelector('[data-action="remove-provider"]'); b.click(); return true; })()`,
	);
	await sleep(1500);
	const gone = await evaluate(
		browser.cdp,
		`(() => document.querySelector('[data-provider="${String(generatedId)}"]') === null)()`,
	);
	check('测试用的供应商已删除（不给用户留垃圾配置）', gone === true);

	// 默认模型也要恢复成「自动」：测试把它改成了自己的模型，删掉供应商之后
	// 那个默认值就指向不存在的模型（界面上会显示成「（已失效）」）—— 那也是垃圾。
	await evaluate(
		browser.cdp,
		`(() => {
			const sel = document.querySelector('select[data-default="image"]');
			if (!sel) return false;
			// select 用原生 setter + change 事件（React 的 onChange 走原生 change）
			const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
			setter.call(sel, '');
			sel.dispatchEvent(new Event('change', { bubbles: true }));
			return true;
		})()`,
	);
	await sleep(1500);
	const defaultAfter = await evaluate(
		browser.cdp,
		`(() => { const sel = document.querySelector('select[data-default="image"]'); return sel ? sel.value : null; })()`,
	);
	check(
		'默认图像模型已恢复成「自动」（不留指向已删除模型的失效值）',
		defaultAfter === '',
		String(defaultAfter),
	);

	const shot = await browser.cdp.send('Page.captureScreenshot', { format: 'png' });
	await writeFile(SHOT, Buffer.from(shot.data, 'base64'));
	console.log(`\n截图：${SHOT}`);
} catch (error) {
	check('脚本执行未抛错', false, String(error));
} finally {
	await browser.close();
	fake.kill();
	await sleep(200);
}

console.log(results.join('\n'));
console.log('');
if (failures === 0) {
	console.log(`全部通过 ✅（${String(results.length)} 项）`);
	process.exit(0);
}
console.log(`${String(failures)} 项失败 ❌（共 ${String(results.length)} 项）`);
process.exit(1);
