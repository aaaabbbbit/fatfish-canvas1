/**
 * P5 端到端：节点右键菜单 + 菜单键盘导航（真实浏览器 + 真实输入）。
 *
 * 为什么这两件事必须上真实浏览器：
 *   - 右键菜单的入口是 `contextmenu` 事件 + 光标坐标，替身里调用回调测不到
 *     「菜单有没有出现在光标旁边、能不能被点到」；
 *   - 键盘导航依赖 **焦点真的在菜单里** + `aria-activedescendant` 生效，
 *     而这正是「组件渲染了但按键到不了」这类故障的藏身处。
 *
 * 覆盖：
 *   1. 右键节点 → 菜单出现在光标附近、在视口内、可命中；空白处右键不出菜单
 *   2. 菜单项：带到视野（真的把节点带回视口中心）/ 删除（真的删掉）
 *   3. 键盘：方向键移动高亮（跳过禁用项）、Enter 执行、Esc 关闭
 *   4. 作用域开关（P10：从「视图」菜单搬到工具条读数上，读数即按钮、可点、双向）
 *   5. 缩放档位菜单：方向键 + Enter 能改缩放
 *
 * 用法（需放宽沙箱：无头 Chrome 要创建命名管道）：
 *   node scripts/e2e-p5.mjs
 */

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PACKAGE_ROOT, PIN_SHARED_BOARD, seedBoardExpression, click, evaluate, launch, sleep, wheel } from './lib/cdp.mjs';

const URL_TARGET = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080/';
const SHOT = resolve(PACKAGE_ROOT, 'lib/e2e-p5.png');
/** 「生成信息」卡片展开态的截图（那一块好不好读，断言读不出来）。 */
const SHOT_INFO = resolve(PACKAGE_ROOT, 'lib/e2e-p5-info.png');

let failures = 0;
const results = [];
const check = (label, ok, detail = '') => {
	if (!ok) failures += 1;
	results.push(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail === '' ? '' : ` — ${detail}`}`);
};
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN);

/** 页面事实。 */
const PROBE = `(() => {
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const center = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; };
  const menu = q('.ffc-node-menu');
  const activeId = menu ? menu.getAttribute('aria-activedescendant') : null;
  const world = q('.ffc-world');
  const m = world ? new DOMMatrixReadOnly(getComputedStyle(world).transform) : null;
  const zoom = m ? m.a : null;
  return JSON.stringify({
    mode: document.body.dataset.ffcMode ?? null,
    zoom,
    vx: m && zoom ? -m.e / zoom : null,
    vy: m && zoom ? -m.f / zoom : null,
    viewport: rect(q('.ffc-viewport')),
    nodes: qa('.ffc-node').map((n) => {
      const r = n.getBoundingClientRect();
      return {
        id: n.dataset.nodeId,
        selected: n.dataset.selected === 'true',
        left: parseFloat(n.style.left),
        top: parseFloat(n.style.top),
        box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        center: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) },
      };
    }),
    hasNodeMenu: menu !== null,
    nodeMenuRect: rect(menu),
    nodeMenuItems: qa('.ffc-node-menu .ffc-menu-item').map((b) => ({
      id: b.id,
      label: (b.textContent || '').trim(),
      disabled: b.disabled === true,
      // 禁用原因（title）—— 「点不动又不说为什么」是最难查的一类反馈
      title: b.getAttribute('title'),
      navActive: b.getAttribute('data-nav-active') === 'true',
    })),
    activeId,
    activeLabel: activeId ? (document.getElementById(activeId)?.textContent || '').trim() : null,
    // 焦点落在哪里（键盘导航失效时第一个要看的东西）
    focus: document.activeElement
      ? document.activeElement.tagName.toLowerCase() +
        (typeof document.activeElement.className === 'string' && document.activeElement.className
          ? '.' + document.activeElement.className.trim().split(/\\s+/)[0]
          : '')
      : null,
    hasViewMenu: qa('.ffc-view-btn').length > 0,
    // 工具条上的「适应内容」按钮（删除测试前先用它把所有节点收进视口）
    toolbarFit: center(qa('.ffc-toolbar button').find((x) => x.getAttribute('aria-label') === '适应内容')),
    // P10：作用域开关从「视图」菜单搬到了工具条那枚读数上（读数自己就是按钮）
    scopeBtn: (() => {
      const el = q('[data-ffc-scope]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.x + r.width / 2),
        y: Math.round(r.y + r.height / 2),
        pressed: el.getAttribute('aria-pressed'),
        text: (el.textContent || '').trim(),
        hit: (() => { const h = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return h !== null && (h === el || el.contains(h)); })(),
      };
    })(),
    hasZoomMenu: q('.ffc-zoom-menu') !== null,
    zoomPercent: q('.ffc-zoom-pct') ? (q('.ffc-zoom-pct').textContent || '').trim() : null,
    follow: (() => {
      const b = qa('.ffc-toolbar button').find((x) => x.getAttribute('aria-label') === '新节点自动带进视野');
      return b ? b.getAttribute('aria-pressed') === 'true' : null;
    })(),
    storage: {
      mode: window.localStorage.getItem('fatfish-canvas:view-mode'),
      follow: window.localStorage.getItem('fatfish-canvas:follow-new'),
      // 画布作用域偏好（P7）：P10 起这个开关就是工具条那枚读数
      scope: window.localStorage.getItem('fatfish-canvas:board-scope'),
    },
    // 菜单是否真的可命中（可能被别的层挡住）
    menuHit: (() => {
      const el = q('.ffc-node-menu .ffc-menu-item');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return hit !== null && (hit === el || el.contains(hit));
    })(),
    // 「生成中」占位那一格就是图像生成的**加载页**：它的图标必须是摇起来的
    // 鲸鱼尾巴（静止态是矢量描边、动图那枚 display:none；生成中反过来）。
    pendingIcon: (() => {
      const el = q('.ffc-node-pending .ffc-whale');
      if (el === null) return null;
      const still = el.querySelector('.ffc-whale-still');
      const anim = el.querySelector('.ffc-whale-anim');
      const path = still ? still.querySelector('path') : null;
      const r = el.getBoundingClientRect();
      return {
        generating: el.getAttribute('data-ffc-generating'),
        stillDisplay: still ? getComputedStyle(still).display : null,
        animDisplay: anim ? getComputedStyle(anim).display : null,
        animMaskLen: anim ? (getComputedStyle(anim).maskImage || '').length : 0,
        stroke: path ? getComputedStyle(path).stroke : null,
        box: { w: Math.round(r.width), h: Math.round(r.height) },
      };
    })(),
  });
})()`;

/** 「生成信息」卡片必须**滚得动**才说明视口没抢走滚轮，因此节点上的提示词要长到 46vh 装不下。 */
const LONG_PROMPT = '镜头全程紧跟服装移动，与衣料保持恒定景深 30-50cm，服装占画面六成以上，无全身正面、无硬切。'.repeat(20);

/** 三个节点：正常节点、远处节点、待删节点；外加一个「没有提示词/地址」的生成中节点 ——
    它让「禁用项与跳过禁用」这两件事变成确定性断言（不依赖是否真的有会话）。 */
const SEED = JSON.stringify({
	version: 2,
	nodes: [
		{ id: 'near', kind: 'image', x: 0, y: 0, w: 320, h: 320, z: 1, status: 'ready', src: 'data:,1', title: '近处', prompt: LONG_PROMPT, model: 'gpt-image-1', createdAt: 1,
			// 参考图两种形态各一个：「生成信息」据此分别渲染缩略图 / 占位说明
			references: ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'attached'] },
		{ id: 'far', kind: 'image', x: 4000, y: 3000, w: 320, h: 320, z: 2, status: 'ready', src: 'data:,2', title: '远处', prompt: '远处的鱼', createdAt: 2 },
		{ id: 'doomed', kind: 'image', x: 760, y: 0, w: 320, h: 320, z: 3, status: 'ready', src: 'data:,3', title: '待删', prompt: '要被删的鱼', createdAt: 3 },
		{ id: 'bare', kind: 'image', x: 380, y: 0, w: 320, h: 320, z: 4, status: 'pending', createdAt: 4 },
	],
	viewport: { x: 0, y: 0, zoom: 1 },
	ingested: [],
});

const browser = await launch();
const read = async () => JSON.parse(await evaluate(browser.cdp, PROBE));

/** 派发一次按键。 */
async function press(key, code, vk) {
	await browser.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
	await browser.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
	await sleep(180);
}

/** 在某个坐标右键。 */
async function rightClick(x, y) {
	await browser.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 });
	await browser.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 });
	await sleep(320);
}

console.log(`\n肥鱼画布 · P5 端到端（节点右键菜单 / 菜单键盘导航）\n目标：${URL_TARGET}\n`);

try {
	// 剪贴板权限：headless 下不授权的话 writeText 会被拒，菜单只会显示失败提示
	await browser.cdp.send('Browser.grantPermissions', {
		origin: new URL(URL_TARGET).origin,
		permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
	});

	let loaded = browser.cdp.once('Page.loadEventFired');
	await browser.cdp.send('Page.navigate', { url: URL_TARGET });
	await loaded;
	await evaluate(
		browser.cdp,
		`(() => {
			${seedBoardExpression(SEED)};
			window.localStorage.setItem('fatfish-canvas:view-mode', 'canvas');
			window.localStorage.setItem('fatfish-canvas:follow-new', 'on');
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
	check('四个节点都已渲染', s.nodes.length === 4, `实际 ${String(s.nodes.length)}`);
	check('初始没有右键菜单', s.hasNodeMenu === false);

	// ── 0. 「生成中」占位的图标：图像生成的加载页用动态动画 ──
	console.log('0) 画布「生成中」占位（= 图像生成的加载页）');
	const icon = s.pendingIcon;
	check('生成中占位里有鲸鱼尾巴图标', icon !== null, JSON.stringify(icon));
	if (icon !== null) {
		check('占位图标带 data-ffc-generating（这一格在用动态遮罩）', icon.generating === 'true', String(icon.generating));
		check(
			'占位图标真的摇尾巴（动图那枚 display:block，静止态让位）',
			icon.animDisplay === 'block' && icon.stillDisplay === 'none' && icon.animMaskLen > 5000,
			`anim ${String(icon.animDisplay)} / still ${String(icon.stillDisplay)} / 遮罩 ${String(icon.animMaskLen)} 字符`,
		);
		check(
			'占位图标颜色走 currentColor（不是写死白色）',
			typeof icon.stroke === 'string' && icon.stroke.startsWith('rgb('),
			String(icon.stroke),
		);
		check(
			'占位图标是 28×28 的正方（老位图是 1152:976，会在这里露馅）',
			icon.box.w === 28 && icon.box.h === 28,
			JSON.stringify(icon.box),
		);
	}

	// ── 1. 右键开关 ──
	console.log('1) 节点右键菜单');
	const near = s.nodes.find((n) => n.id === 'near');
	await rightClick(near.center.x, near.center.y);
	s = await read();
	check('右键节点后菜单出现', s.hasNodeMenu === true);
	check('右键的节点被选中', s.nodes.find((n) => n.id === 'near')?.selected === true);
	check(
		'菜单出现在光标附近（不是屏幕角落）',
		s.nodeMenuRect !== null &&
			Math.abs(s.nodeMenuRect.x - near.center.x) < 260 &&
			Math.abs(s.nodeMenuRect.y - near.center.y) < 260,
		`menu=${JSON.stringify(s.nodeMenuRect)} 光标=${JSON.stringify(near.center)}`,
	);
	check(
		'菜单完整落在视口内（右下角右键也不会顶出去）',
		s.nodeMenuRect.x >= 0 &&
			s.nodeMenuRect.y >= 0 &&
			s.nodeMenuRect.x + s.nodeMenuRect.w <= 1680 &&
			s.nodeMenuRect.y + s.nodeMenuRect.h <= 1000,
		JSON.stringify(s.nodeMenuRect),
	);
	check('菜单可以被命中（没有被别的层挡住）', s.menuHit === true, String(s.menuHit));
	const labels = s.nodeMenuItems.map((i) => i.label).join(' / ');
	check('菜单有 8 个动作', s.nodeMenuItems.length === 8, labels);
	check(
		'动作齐全：带到视野 / 复制提示词 / 复制地址 / 生成信息 / 导出 / 重新生成 / 以此为参考图生成 / 删除',
		['带到视野', '复制提示词', '复制地址', '生成信息', '导出', '重新生成', '以此为参考图生成', '删除'].every((want) =>
			s.nodeMenuItems.some((item) => item.label.includes(want)),
		),
		labels,
	);
	check(
		'有提示词、地址与会话时，「重新生成」可用（可用性由数据与会话共同决定）',
		s.nodeMenuItems.find((i) => i.label.includes('重新生成'))?.disabled === false,
		JSON.stringify(s.nodeMenuItems.find((i) => i.label.includes('重新生成'))),
	);
	check(
		'有地址与会话时，「以此为参考图生成」可用（参考图不经过模型，只递地址）',
		s.nodeMenuItems.find((i) => i.label.includes('以此为参考图生成'))?.disabled === false,
		JSON.stringify(s.nodeMenuItems.find((i) => i.label.includes('以此为参考图生成'))),
	);
	check(
		'有图的节点上「导出」可用（多选时导出的是压缩包）',
		s.nodeMenuItems.find((i) => i.label.includes('导出'))?.disabled === false,
		JSON.stringify(s.nodeMenuItems.find((i) => i.label.includes('导出'))),
	);

	// ── 2. 键盘导航（用「没有提示词/地址」的生成中节点：禁用项是确定的）──
	console.log('\n2) 菜单键盘导航');
	const bare = s.nodes.find((n) => n.id === 'bare');
	await rightClick(bare.center.x, bare.center.y);
	s = await read();
	check(
		'生成中的节点：五个依赖内容的动作都禁用（复制提示词/地址、导出、重新生成、参考图）',
		s.nodeMenuItems.filter((i) => i.disabled === true).map((i) => i.id).join(',') ===
			'copy-prompt,copy-src,export,regenerate,reference',
		JSON.stringify(s.nodeMenuItems.map((i) => `${i.label}:${String(i.disabled)}`)),
	);
	check(
		'禁用项写明了原因（不是一句「当前不可用」）',
		s.nodeMenuItems.find((i) => i.id === 'reference')?.title === '选中的节点里没有图',
		String(s.nodeMenuItems.find((i) => i.id === 'reference')?.title),
	);
	check('菜单初始没有高亮项', s.activeId === null, String(s.activeId));
	check('打开菜单后焦点真的在菜单里（否则按键到不了它）', String(s.focus).startsWith('div.ffc-menu'), String(s.focus));

	// ⚠️ 这几条按 **id** 断言而不是下标：菜单加一项就会让下标全部错位，
	// 而错位的断言看起来仍然「红得有道理」（P47 就把它们全部改成 id）。
	await press('ArrowDown', 'ArrowDown', 40);
	s = await read();
	check('按 ↓ 高亮第一项', s.activeId === 'focus', JSON.stringify(s.nodeMenuItems.map((i) => i.navActive)));
	check(
		'容器暴露 aria-activedescendant（无障碍与激活态都靠它）',
		typeof s.activeId === 'string' && s.activeId !== '',
		String(s.activeId),
	);
	await press('ArrowDown', 'ArrowDown', 40);
	s = await read();
	check(
		'按 ↓ 跳过「复制提示词 / 复制地址」两个禁用项，落到「生成信息」',
		s.activeId === 'info',
		`高亮=${String(s.activeLabel)}`,
	);
	await press('ArrowDown', 'ArrowDown', 40);
	s = await read();
	check(
		'再按 ↓ 越过中间三个禁用项，落到「删除」（生成信息是开关，一直可用）',
		s.activeId === 'remove',
		`高亮=${String(s.activeLabel)}`,
	);
	await press('ArrowDown', 'ArrowDown', 40);
	s = await read();
	check('按 ↓ 到末尾后回到第一项（循环）', s.activeId === 'focus', String(s.activeLabel));
	await press('ArrowUp', 'ArrowUp', 38);
	s = await read();
	check('按 ↑ 从第一项回到最后一项', s.activeId === 'remove', String(s.activeLabel));
	await press('Escape', 'Escape', 27);
	s = await read();
	check('Esc 关闭菜单', s.hasNodeMenu === false);

	// 有提示词的节点：三项可用性由**数据**决定（会话是否绑定只影响「重新生成」）
	s = await read();
	const nearNow = s.nodes.find((n) => n.id === 'near');
	await rightClick(nearNow.center.x, nearNow.center.y);
	s = await read();
	check('右键「有内容」的节点后菜单出现', s.hasNodeMenu === true);
	check(
		'有提示词与地址的节点：复制提示词 / 复制地址都可用',
		s.nodeMenuItems.find((i) => i.id === 'copy-prompt')?.disabled === false &&
			s.nodeMenuItems.find((i) => i.id === 'copy-src')?.disabled === false,
		JSON.stringify(s.nodeMenuItems.map((i) => `${i.label}:${String(i.disabled)}`)),
	);
	check(
		'「重新生成」在会话可用时是启用的（可用性由提示词与会话共同决定）',
		s.nodeMenuItems.find((i) => i.id === 'regenerate')?.disabled === false,
		JSON.stringify(s.nodeMenuItems.find((i) => i.id === 'regenerate')),
	);
	await press('Escape', 'Escape', 27);

	// ── 3. 空白处右键 ──
	await rightClick(Math.round(s.viewport.x + s.viewport.w - 60), Math.round(s.viewport.y + s.viewport.h - 60));
	s = await read();
	check('空白处右键不出菜单（只吞掉浏览器默认菜单）', s.hasNodeMenu === false);

	// ── 4. 带到视野 ──
	// ⚠️ 每次动作之后都要**重新读坐标**：动作本身会移动视口（甚至是带 240ms 动画的），
	// 沿用旧的屏幕坐标会点到别的地方去（P5 首轮就是这么连挂好几条的）。
	console.log('\n3) 菜单动作');
	s = await read();
	const nearReady = s.nodes.find((n) => n.id === 'near');
	await rightClick(nearReady.center.x, nearReady.center.y);
	await evaluate(
		browser.cdp,
		`(() => {
			const b = Array.from(document.querySelectorAll('.ffc-node-menu .ffc-menu-item')).find((x) => (x.textContent || '').includes('带到视野'));
			if (b) b.click();
			return true;
		})()`,
	);
	await sleep(700);
	s = await read();
	const nearAfter = s.nodes.find((n) => n.id === 'near');
	const nodeScreen = { x: (num(nearAfter.left) - num(s.vx)) * num(s.zoom), y: (num(nearAfter.top) - num(s.vy)) * num(s.zoom) };
	check(
		'「带到视野」把节点摆到视口正中',
		Math.abs(nodeScreen.x + nearAfter.box.w / 2 - s.viewport.w / 2) < 12 &&
			Math.abs(nodeScreen.y + nearAfter.box.h / 2 - s.viewport.h / 2) < 12,
		`节点中心=${JSON.stringify({ x: nodeScreen.x + nearAfter.box.w / 2, y: nodeScreen.y + nearAfter.box.h / 2 })} 视口中心=${JSON.stringify({ x: s.viewport.w / 2, y: s.viewport.h / 2 })}`,
	);
	check('执行动作后菜单关闭', s.hasNodeMenu === false);

	// ── 5. 键盘 Enter 执行（复制提示词）──
	// 视口刚被「带到视野」挪动过，必须重新取节点坐标
	s = await read();
	const nearCopy = s.nodes.find((n) => n.id === 'near');
	await rightClick(nearCopy.center.x, nearCopy.center.y);
	await press('ArrowDown', 'ArrowDown', 40);
	await press('ArrowDown', 'ArrowDown', 40);
	s = await read();
	check('高亮停在「复制提示词」', s.nodeMenuItems[1]?.navActive === true, String(s.activeLabel));
	await press('Enter', 'Enter', 13);
	await sleep(400);
	s = await read();
	const copyItem = s.nodeMenuItems.find((i) => i.label.includes('复制') && i.label.includes('提示词'));
	check(
		'Enter 执行「复制提示词」并给出反馈（说明剪贴板写入成功）',
		copyItem?.label.includes('已复制') === true,
		`菜单项=${String(copyItem?.label)}`,
	);
	check('复制类动作不关菜单（用户可能接着复制地址）', s.hasNodeMenu === true);
	const clip = await evaluate(browser.cdp, "navigator.clipboard.readText().then((t) => t).catch(() => '')");
	check('剪贴板里确实是提示词', String(clip).includes(LONG_PROMPT), `长度=${String(clip).length}`);
	await press('Escape', 'Escape', 27);

	// ── 5b. **真鼠标**点菜单项（P27 补的盲区）──
	//
	// 为什么单列一步：上面两节用的是合成 `b.click()` 与键盘 Enter，**都不产生
	// pointerdown** —— 而 P5 起 `.ffc-viewport` 的 pointerdown 会先把菜单卸载掉，
	// 于是「用鼠标点菜单项」这条最常用的路径整条失效（每一项都点不动），
	// e2e 却 45 项全绿。这一节就按真实用户那样按下鼠标：菜单项必须真的执行。
	// 判据取「复制地址」（无副作用、不关菜单、标签会翻成已复制）。
	s = await read();
	const nearMouse = s.nodes.find((n) => n.id === 'near');
	await rightClick(nearMouse.center.x, nearMouse.center.y);
	const copySrcAt = JSON.parse(
		await evaluate(
			browser.cdp,
			`(() => {
				const b = Array.from(document.querySelectorAll('.ffc-node-menu .ffc-menu-item')).find((x) => (x.textContent || '').includes('复制地址'));
				if (!b) return 'null';
				const r = b.getBoundingClientRect();
				return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
			})()`,
		),
	);
	check('取到「复制地址」项的屏幕坐标', copySrcAt !== null, JSON.stringify(copySrcAt));
	await click(browser.cdp, copySrcAt?.x ?? 0, copySrcAt?.y ?? 0);
	await sleep(320);
	s = await read();
	const mouseItem = s.nodeMenuItems.find((i) => i.label.includes('地址'));
	check(
		'真鼠标点菜单项真的执行了（pointerdown 不能把菜单卸掉）',
		mouseItem?.label.includes('已复制') === true,
		`菜单项=${String(mouseItem?.label)} 菜单还在=${String(s.hasNodeMenu)}`,
	);
	await press('Escape', 'Escape', 27);

	// ── 5c. 「生成信息」：提示词 + 参考图（P47）──
	//
	// 判据取三件不同的事：① 卡片真的展开在菜单里（菜单不关，动作还在手边）；
	// ② 提示词原样显示；③ 参考图**分两种情况** —— 真地址给缩略图、取不到字节的
	// 给占位与一句说明（后者渲染成 src 只会在界面上留一张裂图）。
	s = await read();
	const nearInfo = s.nodes.find((n) => n.id === 'near');
	await rightClick(nearInfo.center.x, nearInfo.center.y);
	const infoAt = JSON.parse(
		await evaluate(
			browser.cdp,
			`(() => {
				const b = Array.from(document.querySelectorAll('.ffc-node-menu .ffc-menu-item')).find((x) => x.id === 'info');
				if (!b) return 'null';
				const r = b.getBoundingClientRect();
				return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
			})()`,
		),
	);
	check('菜单里有「生成信息」', infoAt !== null, JSON.stringify(infoAt));
	await click(browser.cdp, infoAt?.x ?? 0, infoAt?.y ?? 0);
	await sleep(320);
	s = await read();
	const infoCard = JSON.parse(
		await evaluate(
			browser.cdp,
			`(() => {
				const card = document.querySelector('.ffc-node-info');
				if (card === null) return 'null';
				const rect = card.getBoundingClientRect();
				return JSON.stringify({
					prompt: (card.querySelector('.ffc-node-info-prompt')?.textContent || '').trim(),
					thumbs: card.querySelectorAll('img.ffc-node-info-thumb').length,
					empty: card.querySelectorAll('.ffc-node-info-thumb[data-empty="true"]').length,
					texts: Array.from(card.querySelectorAll('.ffc-node-info-reftext')).map((x) => (x.textContent || '').trim()),
					foot: (card.querySelector('.ffc-node-info-foot')?.textContent || '').trim(),
					bottom: Math.round(rect.bottom),
				});
			})()`,
		),
	);
	check('点「生成信息」展开卡片（菜单不关，复制/重新生成还在手边）', infoCard !== null && s.hasNodeMenu === true, `菜单还在=${String(s.hasNodeMenu)}`);
	check(
		'卡片显示提示词原文（节点上放不下的长文本靠它才看得到）',
		infoCard?.prompt === LONG_PROMPT,
		`长度=${String(infoCard?.prompt?.length)}/${String(LONG_PROMPT.length)}`,
	);
	check(
		'参考图：真地址给缩略图、取不到字节的给占位 + 说明',
		infoCard?.thumbs === 1 && infoCard?.empty === 1 && String(infoCard?.texts?.[1]).includes('附在') === true,
		JSON.stringify({ thumbs: infoCard?.thumbs, empty: infoCard?.empty, texts: infoCard?.texts }),
	);
	check('卡片里也带上模型与画幅', String(infoCard?.foot).includes('1:1'), String(infoCard?.foot));
	check('展开后重新夹进视口（卡片不会顶到屏幕外）', (infoCard?.bottom ?? 9999) <= 1000, String(infoCard?.bottom));

	// 滚轮得归卡片自己：视口那个 `wheel` 监听是 preventDefault + 缩放，它先吃到的话
	// 卡片的原生滚动会被一起取消 —— 长提示词永远滚不动、画面反倒缩放（NOTES §8.83）。
	const cardAt = JSON.parse(
		await evaluate(
			browser.cdp,
			`(() => {
				const card = document.querySelector('.ffc-node-info');
				if (card === null) return 'null';
				const r = card.getBoundingClientRect();
				return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
			})()`,
		),
	);
	const zoomBefore = num(s.zoom);
	// 一次滚到底（浏览器会夹到 max）：这样等下的截图里能同时看到参考图与模型 · 画幅
	await wheel(browser.cdp, cardAt?.x ?? 0, cardAt?.y ?? 0, 600);
	await sleep(500);
	s = await read();
	const cardScroll = JSON.parse(
		await evaluate(
			browser.cdp,
			`(() => {
				const card = document.querySelector('.ffc-node-info');
				if (card === null) return 'null';
				return JSON.stringify({
					top: Math.round(card.scrollTop),
					max: Math.round(card.scrollHeight - card.clientHeight),
				});
			})()`,
		),
	);
	check('卡片内容高过 46vh 上限（不然下面的滚动断言是空的）', (cardScroll?.max ?? 0) > 0, JSON.stringify(cardScroll));
	check(
		'卡片里的滚轮滚的是卡片自己，画布不跟着缩放',
		(cardScroll?.top ?? 0) > 0 && num(s.zoom) === zoomBefore,
		`scrollTop=${String(cardScroll?.top)} 缩放 ${String(zoomBefore)}=>${String(s.zoom)}`,
	);
	check('滚卡片不关菜单（还能接着看）', s.hasNodeMenu === true);
	// 截图留 **滚到底** 那一帧：提示词长到一帧装不下，滚到底才同时看得到参考图与
	// 模型 · 画幅（这一块是「好不好读」的问题，断言读不出来）。
	const infoShot = await browser.cdp.send('Page.captureScreenshot', { format: 'png' });
	await writeFile(SHOT_INFO, Buffer.from(infoShot.data, 'base64'));
	await press('Escape', 'Escape', 27);
	s = await read();
	check('Esc 连卡片一起关掉', s.hasNodeMenu === false);

	// ── 6. 删除 ──
	// 先适应内容：上一步的「带到视野」把视口挪到了 near 上，待删节点可能已经在屏幕外，
	// 右键点不到（P5 第二轮就是这么挂的）。这一步也顺带回归了工具条的适应内容。
	s = await read();
	await click(browser.cdp, s.toolbarFit?.x ?? 0, s.toolbarFit?.y ?? 0);
	await sleep(700);
	s = await read();
	const doomed = s.nodes.find((n) => n.id === 'doomed');
	check('适应内容后待删节点回到视口内', doomed !== undefined, JSON.stringify(s.nodes.map((n) => n.id)));
	await rightClick(doomed.center.x, doomed.center.y);
	await press('End', 'End', 35);
	s = await read();
	check('按 End 直接跳到最后一个动作（删除）', s.activeId === 'remove', String(s.activeLabel));
	await press('Enter', 'Enter', 13);
	await sleep(400);
	s = await read();
	check(
		'Enter 执行删除',
		s.nodes.length === 3 && s.nodes.every((n) => n.id !== 'doomed'),
		JSON.stringify(s.nodes.map((n) => n.id)),
	);
	check('删除后菜单关闭', s.hasNodeMenu === false);

	// ── 7. 作用域开关（P10：从「视图」菜单搬到工具条读数上） ──
	//
	// 菜单键盘导航本身由上面两节（节点右键菜单）与下一节（缩放档位菜单）覆盖，
	// 这一节测的是**搬了家的那个开关还点得动**：读数即按钮，点是双向的。
	console.log('\n4) 作用域开关（读数即按钮）');
	s = await read();
	check('此时仍在画布模式（作用域读数的前提）', s.mode === 'canvas', String(s.mode));
	check('顶栏不再有「视图」菜单（P10 已整块移除）', s.hasViewMenu === false && s.hasNodeMenu === false);
	check(
		'作用域读数是可点的按钮，初始未按下（本套件把作用域钉在共用那块上）',
		s.scopeBtn !== null && s.scopeBtn.pressed === 'false' && s.scopeBtn.hit === true,
		JSON.stringify(s.scopeBtn),
	);
	await click(browser.cdp, s.scopeBtn.x, s.scopeBtn.y);
	await sleep(560);
	s = await read();
	check('点一下真的打开了按工作区分隔（偏好已写盘）', s.storage.scope === 'workspace', String(s.storage.scope));
	check(
		'按下态与读数文本都跟着变',
		s.scopeBtn?.pressed === 'true' && String(s.scopeBtn?.text).includes('本工作区'),
		`${String(s.scopeBtn?.pressed)}/${String(s.scopeBtn?.text)}`,
	);
	// 关掉：既验证开关是双向的，也不给后面（以及下一次运行的别的 e2e）
	// 留下一块会改变「画布读哪个键」的残留偏好。
	await click(browser.cdp, s.scopeBtn.x, s.scopeBtn.y);
	await sleep(560);
	s = await read();
	check('再点一下切回共用', s.storage.scope === 'shared', String(s.storage.scope));

	// 这一节全程留在画布模式（不再像菜单时代那样先切到聊天再切回来）——
	// 下一节的缩放档位菜单就在画布上，保持现状即可。
	s = await read();
	check('仍然是画布模式，可以接着测缩放档位菜单', s.mode === 'canvas', String(s.mode));

	// ── 8. 缩放档位菜单键盘 ──
	console.log('\n5) 缩放档位菜单键盘导航');
	s = await read();
	check('回到画布模式后视口可用', s.viewport !== null, JSON.stringify(s.viewport));
	const pct = JSON.parse(
		await evaluate(
			browser.cdp,
			`(() => {
				const b = document.querySelector('.ffc-zoom-pct');
				if (!b) return 'null';
				const r = b.getBoundingClientRect();
				return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
			})()`,
		),
	);
	check('缩放档位按钮可达', pct !== null);
	if (pct !== null) await click(browser.cdp, pct.x, pct.y);
	await sleep(360);
	s = await read();
	const before = s.zoomPercent;
	check('缩放档位菜单已打开', s.hasZoomMenu === true);
	await press('End', 'End', 35);
	await press('Enter', 'Enter', 13);
	await sleep(450);
	s = await read();
	// 档位表最后一项是 1000%（ZoomControls 的 PRESETS，上限与 ZOOM_MAX 对齐）——
	// 这条断言曾经写的是 200%（那时档位表只到 200），档位一加就变成长期红项。
	check(
		'方向键 + Enter 改缩放（End 跳到最后一档 1000%）',
		s.zoomPercent === '1000%' && before !== '1000%',
		`${String(before)} -> ${String(s.zoomPercent)}`,
	);

	const shot = await browser.cdp.send('Page.captureScreenshot', { format: 'png' });
	await writeFile(SHOT, Buffer.from(shot.data, 'base64'));
	console.log(`\n[e2e-p5] 截图：${SHOT}`);
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
