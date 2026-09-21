/**
 * 画布端到端交互测试（真实浏览器 + 真实输入事件）。
 *
 * 通过 CDP 派发真正的 mousePressed / mouseMoved / mouseWheel，而不是在
 * 无浏览器替身里调用回调 —— 因为「按钮点不动」这类故障恰恰出在
 * 事件派发与指针捕获层，只有真实浏览器能暴露它。
 *
 * 覆盖：
 *   1. 插件已加载、画布面板与缩放条存在且可命中
 *   2. 缩放按钮（+ / − / 1:1）真的改变缩放读数，且不会顺带平移画布
 *   3. 滚轮缩放以光标为锚点 —— 光标下的世界坐标在缩放前后不漂移
 *   4. Shift + 滚轮横向平移
 *   5. 空白处拖拽 = 平移（世界层 transform 真的变化）
 *   6. 节点拖拽真的移动节点，并持久化到 localStorage
 *   7. Shift + 拖拽 = 框选，命中节点
 *
 * 用法（需放宽沙箱：无头 Chrome 要创建命名管道）：
 *   node scripts/e2e-canvas.mjs
 */

import { goto, launch, click, drag, evaluate, seedBoardExpression, sleep, wheel } from './lib/cdp.mjs';

const URL_TARGET = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080/';

let failures = 0;
const results = [];
const check = (label, ok, detail = '') => {
	if (!ok) failures += 1;
	results.push(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail === '' ? '' : ` — ${detail}`}`);
};
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN);

/** 读取画布视口、缩放条按钮位置与缩放读数。 */
const PROBE = `(() => {
  const q = (s) => document.querySelector(s);
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
  const btn = (title) => {
    const b = Array.from(document.querySelectorAll('.ffc-zoombar button')).find((x) => x.title === title);
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  };
  const vp = q('.ffc-viewport');
  const world = q('.ffc-world');
  const m = world ? new DOMMatrixReadOnly(getComputedStyle(world).transform) : null;
  const zoom = m ? m.a : null;
  return JSON.stringify({
    hasPanel: !!q('.ffc-panel'),
    hasViewport: !!vp,
    hasZoombar: !!q('.ffc-zoombar'),
    vp: rect(vp),
    zoom,
    // transform 是 translate(-vp.x*z, -vp.y*z) scale(z)，因此反解出视口原点
    vx: m && zoom ? -m.e / zoom : null,
    vy: m && zoom ? -m.f / zoom : null,
    readout: q('.ffc-zoom-pct') ? q('.ffc-zoom-pct').textContent : null,
    status: q('.ffc-zoombar-readout') ? q('.ffc-zoombar-readout').textContent : null,
    nodes: Array.from(document.querySelectorAll('.ffc-node')).map((n) => ({
      left: parseFloat(n.style.left), top: parseFloat(n.style.top),
      box: (() => { const r = n.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
      selected: n.dataset.selected === 'true', status: n.dataset.status,
    })),
    btnZoomIn: btn('放大 10%'),
    btnZoomOut: btn('缩小 10%'),
    btnReset: btn('回到 100%'),
  });
})()`;

/** 页面上取一个「空白画布」点（避开左下角缩放条与顶部工具条）。 */
function emptyPoint(vp) {
	return { x: Math.round(vp.x + vp.w * 0.62), y: Math.round(vp.y + vp.h * 0.32) };
}

/** 一个世界点对应的屏幕点（相对于视口元素的原点）。 */
const screenOfWorld = (state, wx, wy) => ({
	x: state.vp.x + (wx - state.vx) * state.zoom,
	y: state.vp.y + (wy - state.vy) * state.zoom,
});

const browser = await launch();
console.log(`\n肥鱼画布 · 端到端交互测试\n目标：${URL_TARGET}\n`);

try {
	// 先把画布清空再开始。
	//
	// 探针 profile 是**复用**的：上一次运行（尤其是 e2e-p5 / e2e-ingest）可能在
	// localStorage 里留下节点。本脚本的「空白处拖拽 = 平移」选的是一片区域中心
	// 偏右上的点，一旦那里压着一个节点，拖拽就变成「移动节点」，
	// 断言会以「视口没动 Δ=0」的形式失败 —— 看着像平移坏了，其实是环境没清干净。
	let preload = browser.cdp.once('Page.loadEventFired');
	await browser.cdp.send('Page.navigate', { url: URL_TARGET });
	await preload;
	await evaluate(
		browser.cdp,
		// 种一块空画布，但**保住原账本**：否则「最近结果补落」会把别的套件
		// （或本套件上一次运行）产生的命令节点又造回来，画布就不空了（见 cdp.mjs）。
		seedBoardExpression(
			JSON.stringify({ version: 2, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } }),
		),
	);

	await goto(browser.cdp, URL_TARGET, { canvasMode: true, waitMs: 9000 });

	// ─────────── 1. 就位 ───────────
	console.log('1) 插件与画布就位');
	let s = JSON.parse(await evaluate(browser.cdp, PROBE));
	check('画布面板存在', s.hasPanel === true);
	check('画布视口存在', s.hasViewport === true);
	check('缩放条存在', s.hasZoombar === true);
	check('视口有实际尺寸', num(s.vp?.w) > 100 && num(s.vp?.h) > 100, JSON.stringify(s.vp));
	check('缩放读数存在', typeof s.readout === 'string' && s.readout.includes('%'), String(s.readout));
	check('三个缩放按钮都可定位', s.btnZoomIn !== null && s.btnZoomOut !== null && s.btnReset !== null);

	// ─────────── 2. 缩放按钮 ───────────
	console.log('\n2) 缩放按钮');
	const zoom0 = num(s.zoom);
	// 按钮缩放以**视口中心**为锚点，因此视口原点必然变化 —— 真正该断言的不变量
	// 是「视口中心下的世界坐标不变」，也就是画面不会横向跳动。
	const centerWorld = (st) => ({
		x: st.vp.w / 2 / num(st.zoom) + num(st.vx),
		y: st.vp.h / 2 / num(st.zoom) + num(st.vy),
	});
	const centerBefore = centerWorld(s);

	await click(browser.cdp, s.btnZoomIn.x, s.btnZoomIn.y);
	s = JSON.parse(await evaluate(browser.cdp, PROBE));
	const zoom1 = num(s.zoom);
	check('点「放大」后缩放变大', zoom1 > zoom0, `${String(zoom0)} -> ${String(zoom1)}`);
	check('缩放读数同步更新', s.readout === `${String(Math.round(zoom1 * 100))}%`, String(s.readout));
	const centerAfter = centerWorld(s);
	check(
		'点按钮以视口中心为锚点缩放（内容不横向跳动）',
		Math.abs(centerAfter.x - centerBefore.x) < 0.5 && Math.abs(centerAfter.y - centerBefore.y) < 0.5,
		`center ${JSON.stringify(centerBefore)} -> ${JSON.stringify(centerAfter)}`,
	);

	await click(browser.cdp, s.btnZoomOut.x, s.btnZoomOut.y);
	await click(browser.cdp, s.btnZoomOut.x, s.btnZoomOut.y);
	s = JSON.parse(await evaluate(browser.cdp, PROBE));
	const zoom2 = num(s.zoom);
	check('连点两次「缩小」后缩小', zoom2 < zoom1, `${String(zoom1)} -> ${String(zoom2)}`);

	await click(browser.cdp, s.btnReset.x, s.btnReset.y);
	s = JSON.parse(await evaluate(browser.cdp, PROBE));
	check('点「1:1」回到 100%', Math.abs(num(s.zoom) - 1) < 1e-6, String(s.zoom));

	// ─────────── 3. 滚轮缩放（锚点不漂移） ───────────
	console.log('\n3) 滚轮缩放');
	s = JSON.parse(await evaluate(browser.cdp, PROBE));
	const anchor = emptyPoint(s.vp);
	const beforeState = { zoom: num(s.zoom), vx: num(s.vx), vy: num(s.vy), vp: s.vp };
	// 光标下的世界坐标（锚点必须保持不动）
	const anchorWorld = {
		x: (anchor.x - s.vp.x) / num(s.zoom) + num(s.vx),
		y: (anchor.y - s.vp.y) / num(s.zoom) + num(s.vy),
	};

	await wheel(browser.cdp, anchor.x, anchor.y, -240);
	s = JSON.parse(await evaluate(browser.cdp, PROBE));
	const zoom3 = num(s.zoom);
	check('滚轮向上 = 放大', zoom3 > beforeState.zoom, `${String(beforeState.zoom)} -> ${String(zoom3)}`);

	const afterWorld = {
		x: (anchor.x - s.vp.x) / num(s.zoom) + num(s.vx),
		y: (anchor.y - s.vp.y) / num(s.zoom) + num(s.vy),
	};
	check(
		'以光标为锚点：锚点下的世界坐标不漂移',
		Math.abs(afterWorld.x - anchorWorld.x) < 0.6 && Math.abs(afterWorld.y - anchorWorld.y) < 0.6,
		`before ${JSON.stringify(anchorWorld)} after ${JSON.stringify(afterWorld)}`,
	);

	await wheel(browser.cdp, anchor.x, anchor.y, 240);
	s = JSON.parse(await evaluate(browser.cdp, PROBE));
	check('滚轮向下 = 缩小', num(s.zoom) < zoom3, `${String(zoom3)} -> ${String(s.zoom)}`);

	// ─────────── 4. Shift + 滚轮横向平移 ───────────
	console.log('\n4) Shift + 滚轮横向平移');
	const beforeShift = { vx: num(s.vx), zoom: num(s.zoom) };
	await wheel(browser.cdp, anchor.x, anchor.y, 240, 8);
	s = JSON.parse(await evaluate(browser.cdp, PROBE));
	check('横向平移改变视口原点', Math.abs(num(s.vx) - beforeShift.vx) > 1, `${String(beforeShift.vx)} -> ${String(s.vx)}`);
	check('横向平移不改变缩放', Math.abs(num(s.zoom) - beforeShift.zoom) < 1e-6);

	// ─────────── 5. 空白处拖拽 = 平移 ───────────
	console.log('\n5) 空白处拖拽平移');
	s = JSON.parse(await evaluate(browser.cdp, PROBE));
	const p0 = { vx: num(s.vx), vy: num(s.vy), zoom: num(s.zoom) };
	const from = emptyPoint(s.vp);
	await drag(browser.cdp, from, { x: from.x - 160, y: from.y - 90 });
	s = JSON.parse(await evaluate(browser.cdp, PROBE));
	const dx = num(s.vx) - p0.vx;
	const dy = num(s.vy) - p0.vy;
	check('拖拽改变视口原点', Math.abs(dx) > 50 && Math.abs(dy) > 30, `Δ=(${dx.toFixed(1)}, ${dy.toFixed(1)})`);
	check('平移不改变缩放', Math.abs(num(s.zoom) - p0.zoom) < 1e-6);

	// ─────────── 6. 节点拖拽 + 持久化 ───────────
	console.log('\n6) 节点拖拽与持久化');
	// 种一个节点再重载：走的正是 store 的反序列化路径
	await evaluate(
		browser.cdp,
		// 同上：保住账本，否则「补落」的节点会混进来（那条断言就会数到 5 个而不是 1 个）
		seedBoardExpression(
			JSON.stringify({
				version: 1,
				nodes: [
					{
						id: 'e2e-node',
						kind: 'image',
						x: 0,
						y: 0,
						w: 240,
						h: 160,
						z: 1,
						status: 'ready',
						src: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNDAiIGhlaWdodD0iMTYwIj48cmVjdCB3aWR0aD0iMjQwIiBoZWlnaHQ9IjE2MCIgZmlsbD0iIzMzNjZjYyIvPjwvc3ZnPg==',
						title: 'e2e',
						createdAt: 1,
					},
				],
				viewport: { x: 0, y: 0, zoom: 1 },
			}),
		),
	);
	const loaded = browser.cdp.once('Page.loadEventFired');
	await browser.cdp.send('Page.reload', { ignoreCache: false });
	await loaded;
	await sleep(9000);

	s = JSON.parse(await evaluate(browser.cdp, PROBE));
	check('重载后节点从 localStorage 复原', s.nodes.length === 1, `实际 ${String(s.nodes.length)}`);
	check('重载后视口复原为 100%', Math.abs(num(s.zoom) - 1) < 1e-6, String(s.zoom));

	const node = s.nodes[0];
	const nodeCenter = screenOfWorld(s, node.left + 120, node.top + 80);
	const beforeLeft = node.left;
	// ⚠️ 先点一下空白处再拖节点：**本体的输入框默认是聚焦的**，而 P15 定的规矩是
	// 「输入框里正在打字时点图片 = 把这张图引用进聊天框」（canvas/clickintent.ts，
	// 有真值表测试）。那一下按下去就走「送进聊天框」而不是「拖节点」——
	// 症状是节点既没动也没被选中，看着像拖拽坏了。真人要先点一下画布（视口拿到焦点）才拖。
	await click(browser.cdp, emptyPoint(s.vp).x, emptyPoint(s.vp).y);
	// 诊断：按下去的那一点上到底是谁？焦点在谁身上？（「拖不动」时唯一能指路的东西）
	const diagBefore = await evaluate(
		browser.cdp,
		`(() => {
			const el = document.elementFromPoint(${String(Math.round(nodeCenter.x))}, ${String(Math.round(nodeCenter.y))});
			const cls = el && el.className ? (el.className.baseVal !== undefined ? el.className.baseVal : el.className) : '';
			const a = document.activeElement;
			const notice = document.querySelector('.ffc-sent-notice');
			return JSON.stringify({
				top: el ? el.tagName + '.' + cls : null,
				active: a ? a.tagName + '.' + (typeof a.className === 'string' ? a.className : '') : null,
				notice: notice ? (notice.textContent || '') : '',
			});
		})()`,
	);
	await drag(browser.cdp, nodeCenter, { x: nodeCenter.x + 120, y: nodeCenter.y + 60 });
	s = JSON.parse(await evaluate(browser.cdp, PROBE));
	const moved = s.nodes[0];
	check(
		'拖拽节点真的移动了它',
		num(moved.left) > beforeLeft + 80,
		`left ${String(beforeLeft)} -> ${String(moved.left)} (Δ=${(num(moved.left) - beforeLeft).toFixed(1)}, 期望约 120)；` +
			`节点盒=${JSON.stringify(node.box)} 按下点=(${String(Math.round(nodeCenter.x))},${String(Math.round(nodeCenter.y))}) 该点上是 ${diagBefore}`,
	);
	check('拖拽后节点被选中', moved.selected === true, `移动后盒=${JSON.stringify(moved.box)}；按下前 ${diagBefore}`);

	await sleep(800); // 等去抖持久化落盘
	const persisted = JSON.parse(
		await evaluate(browser.cdp, "window.localStorage.getItem('fatfish-canvas:board')"),
	);
	check(
		'移动后的坐标已持久化',
		Math.abs(persisted.nodes[0].x - num(moved.left)) < 1.5,
		`存储 ${String(persisted.nodes[0].x)} vs 渲染 ${String(moved.left)}`,
	);

	// ─────────── 7. Shift + 拖拽 = 框选 ───────────
	console.log('\n7) Shift + 拖拽框选');
	s = JSON.parse(await evaluate(browser.cdp, PROBE));
	const nodeNow = s.nodes[0];
	// 从节点的**右下方空白处**拉一个框盖住它。⚠️ 起点不能落在节点自己身上：种子把节点
	// 摆在世界原点、视口也是 (0,0)，于是节点正好压着视口左上角 —— 老写法从
	// (vp.x+6, vp.y+6) 起手，那一点在节点里面，按下去变成「拖节点」，
	// 选框根本不出现（实测：没有 .ffc-marquee，但松手后节点被选中）。
	const boxFrom = { x: Math.round(s.vp.x + 420), y: Math.round(s.vp.y + 320) };
	const boxTo = { x: Math.round(s.vp.x + 20), y: Math.round(s.vp.y + 20) };
	await browser.cdp.send('Input.dispatchMouseEvent', {
		type: 'mousePressed',
		x: boxFrom.x,
		y: boxFrom.y,
		button: 'left',
		buttons: 1,
		clickCount: 1,
		modifiers: 8, // Shift
	});
	for (let i = 1; i <= 6; i += 1) {
		const t = i / 6;
		await browser.cdp.send('Input.dispatchMouseEvent', {
			type: 'mouseMoved',
			x: Math.round(boxFrom.x + (boxTo.x - boxFrom.x) * t),
			y: Math.round(boxFrom.y + (boxTo.y - boxFrom.y) * t),
			button: 'left',
			buttons: 1,
			modifiers: 8,
		});
		await sleep(15);
	}
	s = JSON.parse(await evaluate(browser.cdp, PROBE));
	check('框选过程中出现选框', (await evaluate(browser.cdp, "document.querySelectorAll('.ffc-marquee').length")) === 1);
	await browser.cdp.send('Input.dispatchMouseEvent', {
		type: 'mouseReleased',
		x: boxTo.x,
		y: boxTo.y,
		button: 'left',
		buttons: 0,
		clickCount: 1,
		modifiers: 8,
	});
	await sleep(120);
	s = JSON.parse(await evaluate(browser.cdp, PROBE));
	check('框选命中节点', s.nodes.some((n) => n.selected === true), JSON.stringify(s.status));

	// ─────────── 8. 键位：Delete 删除选中 ───────────
	console.log('\n8) 键盘：Delete 删除选中节点');
	// 先点一下画布让视口获得焦点（快捷键刻意绑在画布元素上，不监听 window）
	await click(browser.cdp, emptyPoint(s.vp).x, emptyPoint(s.vp).y);
	await click(browser.cdp, screenOfWorld(s, s.nodes[0].left + 120, s.nodes[0].top + 80).x, screenOfWorld(s, s.nodes[0].left + 120, s.nodes[0].top + 80).y);
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
	await sleep(200);
	s = JSON.parse(await evaluate(browser.cdp, PROBE));
	check('Delete 删除了选中节点', s.nodes.length === 0, `剩余 ${String(s.nodes.length)}`);
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
