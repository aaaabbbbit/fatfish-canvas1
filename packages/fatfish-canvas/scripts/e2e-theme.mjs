/**
 * P5 打磨：**浅 / 深两套主题下的对比度自动复查**（真实浏览器）。
 *
 * 为什么值得自动化：本插件的配色全部取自 DSH 的设计 token，理论上两套主题都成立 ——
 * 但「理论上」的地方正是最容易漏的地方：一个写死的 `#ffffff`、一处漏了 alpha 的
 * 背景、一个本该用 `-inverted` 的前景，在深色下看着正常、切到浅色就糊成一片。
 * 浏览器里算一遍对比度只要几百毫秒，人工点两遍主题却常常不会做。
 *
 * 主题切换的钩子（已核实）：`body[data-ds-dark-theme]` —— 一个稳定的数据属性，
 * 不是哈希类名，因此测试里直接 toggle 属性即可复现两套主题。
 *
 * 判据（WCAG 相对亮度对比度）：
 *   - 正文/标题类：≥ 4.5
 *   - 次要文字（读数、提示、note）：≥ 3.0
 *   - 任何元素都不许出现「算不出对比度」的情况（说明背景透明链断了）
 *
 * 用法（需放宽沙箱：无头 Chrome 要创建命名管道）：
 *   node scripts/e2e-theme.mjs
 */

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PACKAGE_ROOT, RESET_BOARD_PREFS, seedBoardExpression, evaluate, launch, sleep } from './lib/cdp.mjs';

const URL_TARGET = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080/';

let failures = 0;
const results = [];
const check = (label, ok, detail = '') => {
	if (!ok) failures += 1;
	results.push(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail === '' ? '' : ` — ${detail}`}`);
};

/** 要检查的元素：选择器 + 最低对比度 + 说明。 */
const TARGETS = [
	{ sel: '.ffc-title', min: 4.5, what: '面板标题' },
	{ sel: '.ffc-badge', min: 3, what: '徽标' },
	// ⚠️ 只查**可用**的工具条按钮：`.ffc-tbtn` 禁用时自身 `opacity: 0.4`（刻意的视觉降级），
	// 半透明文字算出来的对比度必然不达标。P26 实测就是这么假红的：P18 把「运行」这个
	// `.ffc-tbtn` 插到了这一组的最前面，而种子里没有生成节点 → 它一直是禁用态 →
	// `querySelector` 每次都挑中它，两个主题都报 2.39 / 1.57（< 3），而真正要守的是
	// **可用控件**的可读性（WCAG 也把禁用控件排除在对比度要求之外）。
	{ sel: '.ffc-toolbar .ffc-tbtn:not([disabled])', min: 3, what: '工具条按钮（可用态）' },
	{ sel: '.ffc-node[data-status="ready"] .ffc-node-title', min: 3, what: '节点标题（悬浮条）' },
	{ sel: '.ffc-node[data-status="pending"] .ffc-node-pending-text', min: 3, what: '生成中文案' },
	{ sel: '.ffc-node[data-status="failed"] .ffc-node-failed-title', min: 4.5, what: '失败标题' },
	{ sel: '.ffc-node[data-status="failed"] .ffc-node-failed-reason', min: 3, what: '失败原因' },
	{ sel: '.ffc-node[data-status="failed"] .ffc-node-flag', min: 4.5, what: '失败徽标（反色写法，靠主题切换才对）' },
	{ sel: '.ffc-node[data-kind="text"] .ffc-node-text', min: 4.5, what: '文字节点' },
	{ sel: '.ffc-zoombar-readout', min: 3, what: '节点读数' },
	{ sel: '.ffc-zoom-pct', min: 4.5, what: '缩放读数' },
	{ sel: '.ffc-menu-item', min: 4.5, what: '菜单项' },
	{ sel: '.ffc-menu-label', min: 3, what: '菜单分组名' },
	// P10：`.ffc-menu-chip`（宽度预设）与 `.ffc-menu-note`（菜单底部说明）随着
	// 「视图」菜单一起消失了 —— 这两个目标没有元素可查，已从清单里移除。顶栏那枚
	// 作用域读数仍是 `.ffc-badge`（上面的目标覆盖它），只是现在它还是个按钮。
	{
		sel: '.ffc-node-menu .ffc-menu-item[data-danger="true"]',
		min: 3,
		// 深色主题的设计系统里，错误色只有 #f25a5a 这一个（它自己压在 layer-3 上
		// 也只有 3.7）。这里跟随设计系统而不是自造一个非 token 的红，因此门限取 3。
		what: '菜单危险项（设计系统的错误色，门限 3）',
	},
];

/** 空画布时才存在的空态元素（单独一轮扫描）。 */
const EMPTY_TARGETS = [
	{ sel: '.ffc-placeholder-title', min: 4.5, what: '空态标题' },
	{ sel: '.ffc-placeholder-hint', min: 3, what: '空态提示' },
];

/** 三个状态的节点 + 一个文字节点，保证各条分支都有东西可查。 */
const SEED = JSON.stringify({
	version: 2,
	nodes: [
		{
			id: 'ready',
			kind: 'image',
			x: 0,
			y: 0,
			w: 240,
			h: 240,
			z: 1,
			status: 'ready',
			src: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNDAiIGhlaWdodD0iMjQwIj48cmVjdCB3aWR0aD0iMjQwIiBoZWlnaHQ9IjI0MCIgZmlsbD0iIzMzNjZjYyIvPjwvc3ZnPg==',
			title: '已生成',
			prompt: '一只肥鱼',
			createdAt: 1,
		},
		{ id: 'pending', kind: 'image', x: 280, y: 0, w: 240, h: 240, z: 2, status: 'pending', createdAt: 2 },
		{
			id: 'failed',
			kind: 'image',
			x: 560,
			y: 0,
			w: 240,
			h: 240,
			z: 3,
			status: 'failed',
			error: '供应商没有配置密钥',
			createdAt: 3,
		},
		{ id: 'text', kind: 'text', x: 0, y: 280, w: 240, h: 120, z: 4, status: 'ready', title: '文字节点', createdAt: 4 },
	],
	viewport: { x: 0, y: 0, zoom: 0.8 },
	ingested: [],
});

/** 在页面里计算对比度的表达式（自包含；颜色合成按 WCAG 相对亮度）。 */
const SCAN = (targets) => `(() => {
  const parse = (css) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(css || '');
    if (m === null) return { r: 0, g: 0, b: 0, a: 0 };
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { r: p[0] || 0, g: p[1] || 0, b: p[2] || 0, a: p.length > 3 ? p[3] : 1 };
  };
  const over = (src, dst) => ({
    r: src.r * src.a + dst.r * (1 - src.a),
    g: src.g * src.a + dst.g * (1 - src.a),
    b: src.b * src.a + dst.b * (1 - src.a),
    a: src.a + dst.a * (1 - src.a),
  });
  // 有效背景：从元素往上找到第一个不透明层，沿途用 alpha 合成
  const bgOf = (el) => {
    const stack = [];
    for (let n = el; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c.a > 0) stack.push(c);
      if (c.a === 1) break;
    }
    let out = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = stack.length - 1; i >= 0; i -= 1) out = over(stack[i], out);
    return out;
  };
  // 元素**自身**的 opacity 要算进去（半透明文字对比度会明显下降）。
  //
  // 刻意不往上累加祖先的 opacity：节点悬浮条默认 opacity:0（悬停才出现），
  // 那是可见性机制而不是对比度因素 —— 累加进去会让条上的文字算出「前景=背景」，
  // 得到 1.0 这种假故障（第一版就这么误报过）。
  const ownOpacity = (el) => {
    const o = parseFloat(getComputedStyle(el).opacity);
    return Number.isFinite(o) ? o : 1;
  };
  const lum = (c) => {
    const f = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (fg, bg) => {
    const a = lum(fg);
    const b = lum(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  return JSON.stringify({
    dark: document.body.hasAttribute('data-ds-dark-theme'),
    rows: ${JSON.stringify(targets)}.map((t) => {
      const el = document.querySelector(t.sel);
      if (el === null) return { sel: t.sel, what: t.what, min: t.min, missing: true };
      const cs = getComputedStyle(el);
      const bg = bgOf(el);
      const fgRaw = parse(cs.color);
      fgRaw.a = fgRaw.a * ownOpacity(el);
      const fg = over(fgRaw, bg);
      const visible = el.getBoundingClientRect().width > 0;
      return {
        sel: t.sel, what: t.what, min: t.min,
        ratio: Math.round(ratio(fg, bg) * 100) / 100,
        color: cs.color,
        bg: 'rgb(' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b) + ')',
        visible,
      };
    }),
  });
})()`;

const browser = await launch();

/**
 * 在一种主题下扫一遍给定目标，并断言对比度。
 * @param targets - 目标清单。
 * @param theme - `深色` / `浅色`（只用于文案）。
 * @param dark - 是否深色。
 * @returns 是否全部达标。
 */
async function audit(targets, theme, dark) {
	await evaluate(
		browser.cdp,
		dark
			? "document.body.setAttribute('data-ds-dark-theme', ''); true"
			: "document.body.removeAttribute('data-ds-dark-theme'); true",
	);
	await sleep(300);
	const scan = JSON.parse(await evaluate(browser.cdp, SCAN(targets)));
	check(`主题切换生效（${theme}）`, scan.dark === dark, `实际 dark=${String(scan.dark)}`);

	const missing = scan.rows.filter((row) => row.missing === true);
	check(`${theme}：目标元素都已渲染`, missing.length === 0, missing.map((r) => r.sel).join(', '));
	const rows = scan.rows.filter((row) => row.missing !== true);
	const fails = rows.filter((row) => row.ratio < row.min);
	check(
		`${theme}：全部元素对比度达标`,
		fails.length === 0,
		fails.map((r) => `${r.what}(${String(r.ratio)} < ${String(r.min)})`).join('；'),
	);
	const worst = rows.reduce((acc, row) => (acc === null || row.ratio < acc.ratio ? row : acc), null);
	console.log(
		`  ${theme}：检查 ${String(rows.length)} 处，最低对比度 ${String(worst?.ratio)}` +
			`（${String(worst?.what)}，${String(worst?.color)} on ${String(worst?.bg)}）`,
	);
	return fails.length === 0;
}

console.log(`\n肥鱼画布 · 浅/深主题对比度复查\n目标：${URL_TARGET}\n`);

try {
	// ── 第一轮：空画布（只有这一轮才有空态元素） ──
	let loaded = browser.cdp.once('Page.loadEventFired');
	await browser.cdp.send('Page.navigate', { url: URL_TARGET });
	await loaded;
	await evaluate(
		browser.cdp,
		`(() => {
			${seedBoardExpression(
				JSON.stringify({ version: 2, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } }),
			)};
			window.localStorage.setItem('fatfish-canvas:view-mode', 'canvas');
			${RESET_BOARD_PREFS}
			return true;
		})()`,
	);
	loaded = browser.cdp.once('Page.loadEventFired');
	await browser.cdp.send('Page.reload', { ignoreCache: false });
	await loaded;
	await sleep(9000);
	check('空态占位已渲染（第一轮的前提）', (await evaluate(browser.cdp, "!!document.querySelector('.ffc-placeholder')")) === true);
	for (const dark of [true, false]) {
		await audit(EMPTY_TARGETS, dark ? '深色·空态' : '浅色·空态', dark);
	}

	// ── 第二轮：种下三种状态的节点 + 打开节点右键菜单 ──
	await evaluate(browser.cdp, `${seedBoardExpression(SEED)}`);
	loaded = browser.cdp.once('Page.loadEventFired');
	await browser.cdp.send('Page.reload', { ignoreCache: false });
	await loaded;
	await sleep(9000);

	// 菜单类的元素只有渲染出来才能查。P10 之后画布上只剩两个菜单
	// （节点右键菜单、缩放档位菜单）—— 「视图」菜单已整块移除，
	// 那几个菜单目标因此改由节点右键菜单提供。
	const nodeRect = JSON.parse(
		await evaluate(
			browser.cdp,
			`(() => {
				const el = document.querySelector('.ffc-node[data-kind="image"][data-status="ready"]');
				if (!el) return 'null';
				const r = el.getBoundingClientRect();
				return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
			})()`,
		),
	);
	// 用真实右键打开节点菜单（顺便验证 contextmenu 链路）
	await browser.cdp.send('Input.dispatchMouseEvent', {
		type: 'mousePressed',
		x: nodeRect.x,
		y: nodeRect.y,
		button: 'right',
		buttons: 2,
		clickCount: 1,
	});
	await browser.cdp.send('Input.dispatchMouseEvent', {
		type: 'mouseReleased',
		x: nodeRect.x,
		y: nodeRect.y,
		button: 'right',
		buttons: 0,
		clickCount: 1,
	});
	await sleep(400);
	check(
		'右键节点后出现节点菜单（主题复查的前提）',
		(await evaluate(browser.cdp, "!!document.querySelector('.ffc-node-menu')")) === true,
	);

	for (const dark of [true, false]) {
		await audit(TARGETS, dark ? '深色' : '浅色', dark);
		const shot = await browser.cdp.send('Page.captureScreenshot', { format: 'png' });
		const path = resolve(PACKAGE_ROOT, `lib/e2e-theme-${dark ? 'dark' : 'light'}.png`);
		await writeFile(path, Buffer.from(shot.data, 'base64'));
		console.log(`  ${dark ? '深色' : '浅色'}：截图 ${path}`);
	}

	// 主题切换不该影响布局骨架
	const layout = JSON.parse(
		await evaluate(
			browser.cdp,
			`(() => {
				const p = document.querySelector('.ffc-panel');
				const v = document.querySelector('.ffc-viewport');
				return JSON.stringify({ panel: Math.round(p ? p.getBoundingClientRect().width : 0), viewport: Math.round(v ? v.getBoundingClientRect().width : 0), width: getComputedStyle(document.documentElement).getPropertyValue('--ffc-canvas-width').trim() });
			})()`,
		),
	);
	check(
		'两套主题下布局骨架一致（面板宽度与视口都对）',
		layout.panel > 300 && Math.abs(layout.panel - layout.viewport) < 4,
		JSON.stringify(layout),
	);
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
