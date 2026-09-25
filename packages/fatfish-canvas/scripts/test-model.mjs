/**
 * 画布核心逻辑单元测试（无需浏览器、无测试框架）。
 *
 * 覆盖两处最容易出错、也最值得锁死的东西：
 *   1. 视口数学 —— 尤其「以光标为锚点缩放」必须让锚点下的世界坐标不动
 *   2. store 的反序列化校验与动作语义 —— localStorage 里的坏数据不能把画布
 *      变成 NaN 坐标
 *
 * 源码是 TypeScript，因此这里用编译器 API 在内存中转译为 CJS 再求值，
 * 避免为了测试再引一套构建产物。
 *
 * 用法：node scripts/test-model.mjs
 */

import ts from 'typescript';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const results = [];
const check = (label, ok, detail = '') => {
	if (!ok) failures += 1;
	results.push(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail === '' ? '' : ` — ${detail}`}`);
};

// ─────────────────── 在内存里求值一个 TS 模块 ───────────────────

/**
 * 裸 specifier 的桩（**必须在 loadTsModule 之前声明**：它内部会引用这个常量，
 * 声明在后面的 `const` 会落进 TDZ，表现为「测试未提供外部依赖桩：react」）。
 */
const BARE_STUBS = {
	react: {
		useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
		// 订阅改成 useState + useEffect 之后（见 state.ts 的 useStoreValue），
		// 这两个也要有；真正的订阅语义在第 10 节用自写替身单测。
		useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
		useEffect: () => {},
	},
};

const REL_RE = /require\(["'](\.[^"']+)["']\)/g;

/**
 * 把一个 TS 模块（及其相对依赖）转译为 CJS 并求值。
 * @param absPath - 入口绝对路径。
 * @param sharedCache - 可选的共享模块表：需要「两个入口共用同一份模块实例」
 *   时传入（P3 落图测试要让 ingest 与 store 指向同一个 store 实例）。
 * @param bareStubs - 可选的裸 specifier 覆盖（P16 的订阅测试要换掉 react 桩）。
 * @returns 模块导出对象。
 */
async function loadTsModule(absPath, sharedCache, bareStubs) {
	const cache = sharedCache ?? new Map();

	async function build(file, stubs) {
		if (cache.has(file)) return cache.get(file).exports;
		const source = await readFile(file, 'utf8');
		const js = ts.transpileModule(source, {
			compilerOptions: {
				target: ts.ScriptTarget.ES2022,
				module: ts.ModuleKind.CommonJS,
				esModuleInterop: true,
			},
			fileName: file,
		}).outputText;

		const mod = { exports: {} };
		cache.set(file, mod);

		const dir = dirname(file);
		const localRequire = (spec) => {
			if (!spec.startsWith('.')) {
				// 裸 specifier：store.ts 需要 react，这里给桩即可 ——
				// 被测的是纯逻辑，hook 不参与。
				const stub = (stubs ?? BARE_STUBS)[spec];
				if (stub !== undefined) return stub;
				throw new Error(`测试未提供外部依赖桩：${spec}`);
			}
			// 只支持本包内的相对依赖，按 .ts → .tsx → .js 依次尝试
			for (const ext of ['.ts', '.tsx', '.js']) {
				try {
					return requireSync(resolve(dir, `${spec}${ext}`));
				} catch {
					continue;
				}
			}
			throw new Error(`解析不到 ${spec}（来自 ${file}）`);
		};

		// requireSync 需要同步返回，因此这里对相对依赖做同步占位：
		// 先用已知文件集预读一次（本模块图很小且无环）。
		for (const match of js.matchAll(REL_RE)) {
			const spec = match[1];
			for (const ext of ['.ts', '.tsx', '.js']) {
				const candidate = resolve(dir, `${spec}${ext}`);
				try {
					await readFile(candidate, 'utf8');
				} catch {
					continue;
				}
				// 深度优先预求值，之后 localRequire 命中缓存
				await build(candidate, stubs);
				break;
			}
		}

		function requireSync(target) {
			const hit = cache.get(target);
			if (hit === undefined) throw new Error(`未预求值：${target}`);
			return hit.exports;
		}

		// eslint-disable-next-line no-new-func -- 刻意用函数构造器求值转译产物
		const fn = new Function('exports', 'require', 'module', js);
		fn(mod.exports, localRequire, mod);
		return mod.exports;
	}

	return build(absPath, bareStubs);
}

// ─────────────────── 最小 DOM / storage 替身 ───────────────────

const storage = new Map();
globalThis.window = {
	localStorage: {
		getItem: (k) => storage.get(k) ?? null,
		setItem: (k, v) => storage.set(k, String(v)),
		removeItem: (k) => storage.delete(k),
		// 枚举面（P25 的画布回收要按前缀扫键）：真实的 Storage 就是 length + key(i)。
		get length() {
			return storage.size;
		},
		key: (i) => [...storage.keys()][i] ?? null,
	},
};

/** 裸 specifier 的桩见文件顶部（必须在 loadTsModule 之前）。 */

/**
 * 等所有**去抖写盘定时器**烧完。
 *
 * 本文件的每一小节都用**新的模块实例**（`loadTsModule`），每个实例各自带一个
 * 400ms 去抖写盘定时器；被丢下的实例并不会因此安静 —— 它的定时器会在**后面的
 * `await` 里**照样触发，把那一节留下的旧画布写回全局键。于是下一节 load 出来的
 * 画布会莫名其妙多出几个陌生节点（P18 加连线时又出现过一次：section 7 的
 * 「先落一个 pending 节点」看到 2 个节点，多出来的正是 section 2 的 `n_…`）。
 * 这不是被测代码的 bug（真实运行中同一时刻只有一个 store 实例，且切换作用域会
 * 先 flush），是**测试要自己把时间轴清干净**：先等定时器烧完，再 clear，再 load。
 *
 * 更省事的做法是让每一节的 store 在结束时 `flushPersist()`（立刻写盘并取消定时器），
 * 但那只对「还握着 store 引用」的小节成立；这个等待是兜底。
 * @returns 定时器排空后的 promise。
 */
const drainPersistTimers = () => new Promise((r) => setTimeout(r, 600));

// ─────────────────── 载入被测模块 ───────────────────

const model = await loadTsModule(resolve(root, 'src/client/canvas/model.ts'));

console.log('\n肥鱼画布 · 画布核心逻辑测试\n');

// ─────────────────── 1. 视口数学 ───────────────────

console.log('1) 视口数学');

{
	const vp = { x: 100, y: 50, zoom: 2 };
	const world = { x: 300, y: 250 };
	const screen = model.toScreen(world, vp);
	const back = model.toWorld(screen, vp);
	check(
		'toScreen / toWorld 往返一致',
		Math.abs(back.x - world.x) < 1e-9 && Math.abs(back.y - world.y) < 1e-9,
		`${JSON.stringify(back)}`,
	);
	check(
		'toScreen 公式正确',
		screen.x === (300 - 100) * 2 && screen.y === (250 - 50) * 2,
		JSON.stringify(screen),
	);
}

{
	// 锚点缩放的**唯一判据**：锚点下的世界坐标在缩放前后必须完全相同。
	const vp = { x: -37, y: 12, zoom: 0.8 };
	const anchor = { x: 640, y: 360 };
	const before = model.toWorld(anchor, vp);
	const after = model.zoomAround(vp, anchor, 2.5);
	const nowWorld = model.toWorld(anchor, after);
	check(
		'以光标缩放：锚点下的世界坐标保持不动',
		Math.abs(nowWorld.x - before.x) < 1e-9 && Math.abs(nowWorld.y - before.y) < 1e-9,
		`before=${JSON.stringify(before)} after=${JSON.stringify(nowWorld)}`,
	);
	check('以光标缩放：倍率已更新', after.zoom === 2.5, String(after.zoom));
}

{
	const vp = { x: 0, y: 0, zoom: 1 };
	check('clampZoom 下限', model.clampZoom(0.0001) === model.ZOOM_MIN, String(model.ZOOM_MIN));
	check('clampZoom 上限', model.clampZoom(999) === model.ZOOM_MAX, String(model.ZOOM_MAX));
	check('clampZoom 区间内原样', model.clampZoom(1.5) === 1.5);
	const atMax = { x: 0, y: 0, zoom: model.ZOOM_MAX };
	check('zoomAround 已在最大值时返回原对象', model.zoomAround(atMax, { x: 1, y: 1 }, 99) === atMax);
	check('zoomBy 按比例放大', model.zoomBy(vp, { x: 0, y: 0 }, 1.15).zoom === 1.15);
}

{
	const nodes = [
		{ x: 0, y: 0, w: 100, h: 50 },
		{ x: 200, y: 100, w: 100, h: 50 },
	];
	const b = model.boundsOf(nodes);
	check(
		'boundsOf 求并集包围盒',
		b.x === 0 && b.y === 0 && b.w === 300 && b.h === 150,
		JSON.stringify(b),
	);
	check('boundsOf 空列表返回 null', model.boundsOf([]) === null);
}

{
	const rect = { x: 100, y: 100, w: 400, h: 200 };
	const size = { w: 800, h: 600 };
	const vp = model.fitRect(rect, size, 0);
	check('fitRect 倍率不超过上限', vp.zoom <= model.ZOOM_MAX, String(vp.zoom));
	// 居中判据：矩形中心应落在视口中心
	const center = model.toScreen({ x: 300, y: 200 }, vp);
	check(
		'fitRect 使矩形中心落在视口中心',
		Math.abs(center.x - size.w / 2) < 1e-6 && Math.abs(center.y - size.h / 2) < 1e-6,
		JSON.stringify(center),
	);
	// 完整纳入判据
	const tl = model.toScreen({ x: rect.x, y: rect.y }, vp);
	const br = model.toScreen({ x: rect.x + rect.w, y: rect.y + rect.h }, vp);
	check(
		'fitRect 完整纳入且不溢出',
		tl.x >= -1e-6 && tl.y >= -1e-6 && br.x <= size.w + 1e-6 && br.y <= size.h + 1e-6,
		`tl=${JSON.stringify(tl)} br=${JSON.stringify(br)}`,
	);
}

{
	check(
		'rectsIntersect 相交',
		model.rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }),
	);
	check(
		'rectsIntersect 相邻不交',
		!model.rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 }),
	);
	const r = model.rectFromPoints({ x: 100, y: 100 }, { x: 40, y: 30 });
	check(
		'rectFromPoints 反向拖拽也规范化为左上原点',
		r.x === 40 && r.y === 30 && r.w === 60 && r.h === 70,
		JSON.stringify(r),
	);
}

// ─────────────────── 2. store 语义 ───────────────────

console.log('\n2) store 语义与持久化');

/** 每个用例都重新载入 store 模块，避免模块级单例串味。 */
async function freshStore() {
	storage.clear();
	// 清掉模块缓存（用查询串无法命中，改为重新求值：loadTsModule 每次调用都是新缓存）
	return loadTsModule(resolve(root, 'src/client/canvas/store.ts'));
}

{
	const store = await freshStore();
	const n = store.addNode({ kind: 'image', x: 10, y: 20, w: 100, h: 100, status: 'ready' });
	check('addNode 返回带 id 的节点', typeof n.id === 'string' && n.id !== '');
	check('addNode 自动带上 z 与 createdAt', n.z > 0 && n.createdAt > 0);
	check('addNode 后节点入列', store.getBoard().nodes.length === 1);
	check('addNode 后自动选中新节点', store.getBoard().selection.includes(n.id));

	const more = store.addNodes([
		{ kind: 'image', x: 200, y: 0, w: 50, h: 50, status: 'ready' },
		{ kind: 'video', x: 300, y: 0, w: 50, h: 50, status: 'pending' },
	]);
	check('addNodes 批量入列', store.getBoard().nodes.length === 3, String(more.length));
	check(
		'addNodes 的 z 严格递增',
		store.getBoard().nodes.every((node, i, all) => i === 0 || node.z > all[i - 1].z),
	);

	store.translateNodes([n.id], 5, -5);
	const moved = store.getBoard().nodes.find((x) => x.id === n.id);
	check('translateNodes 平移', moved.x === 15 && moved.y === 15, `${moved.x},${moved.y}`);

	store.translateNodes([n.id], 0, 0);
	check('translateNodes 零位移不改变引用', store.getBoard().nodes.find((x) => x.id === n.id) === moved);

	store.updateNodes([n.id], { title: '柴犬' });
	check('updateNodes 合并字段', store.getBoard().nodes.find((x) => x.id === n.id).title === '柴犬');

	const before = store.getBoard().nodes.find((x) => x.id === n.id).z;
	store.bringToFront([n.id]);
	check(
		'bringToFront 提到最前',
		store.getBoard().nodes.find((x) => x.id === n.id).z > before,
	);
	check(
		'节点按 z 升序存放',
		store.getBoard().nodes.every((node, i, all) => i === 0 || node.z >= all[i - 1].z),
	);

	store.removeNodes([n.id]);
	check('removeNodes 删除节点', store.getBoard().nodes.length === 2);
	check('removeNodes 同时清理选择集', !store.getBoard().selection.includes(n.id));

	store.setSelection([more[0].id]);
	check('setSelection 生效', store.getBoard().selection.length === 1);
	store.clearSelection();
	check('clearSelection 清空', store.getBoard().selection.length === 0);

	// 收尾立刻写盘：不然这个实例的 400ms 去抖定时器会在**后面某一节的 await 里**
	// 触发，把这里的两个节点写回全局键，污染下一节 load 出来的画布（见 drainPersistTimers）。
	store.flushPersist();
}

{
	// 持久化：write → 重新载入 → 复原
	const store = await freshStore();
	const n = store.addNode({ kind: 'video', x: 7, y: 9, w: 640, h: 360, status: 'ready', src: 'https://x/y.mp4' });
	store.setViewport({ x: -100, y: -200, zoom: 1.75 });
	store.flushPersist();

	const raw = store.readPersistedRaw();
	check('flushPersist 写入 localStorage', typeof raw === 'string' && raw.length > 0);

	const reloaded = await freshStore();
	// freshStore 会清空 storage，因此这里手工回灌原始内容再重载
	storage.set('fatfish-canvas:board', raw);
	const restored = await loadTsModule(resolve(root, 'src/client/canvas/store.ts'));
	check('重载后节点数复原', restored.getBoard().nodes.length === 1, String(restored.getBoard().nodes.length));
	check(
		'重载后节点字段复原',
		restored.getBoard().nodes[0].id === n.id && restored.getBoard().nodes[0].src === 'https://x/y.mp4',
	);
	check(
		'重载后视口复原',
		restored.getBoard().viewport.zoom === 1.75 &&
			restored.getBoard().viewport.x === -100 &&
			restored.getBoard().viewport.y === -200,
		JSON.stringify(restored.getBoard().viewport),
	);
	check('重载后选择集为空（瞬时状态不落盘）', restored.getBoard().selection.length === 0);
	void reloaded;
}

{
	// 坏数据防御
	// 上限以契约模块为准（不在测试里写死 4 或 10）
	const zoomMax = (await loadTsModule(resolve(root, 'src/client/canvas/model.ts'))).ZOOM_MAX;
	const cases = [
		['非法 JSON', 'not json at all'],		['顶层不是对象', '"hello"'],
		['nodes 不是数组', '{"nodes":"nope"}'],
		['节点坐标是 NaN 字符串', '{"nodes":[{"id":"a","x":"NaN","y":0,"w":10,"h":10}]}'],
		['节点宽高为 0', '{"nodes":[{"id":"a","x":0,"y":0,"w":0,"h":10}]}'],
		['节点缺 id', '{"nodes":[{"x":0,"y":0,"w":10,"h":10}]}'],
		['视口含非有限数', '{"nodes":[],"viewport":{"x":null,"y":0,"zoom":1}}'],
		['视口 zoom 超界', '{"nodes":[],"viewport":{"x":0,"y":0,"zoom":99999}}'],
	];
	for (const [label, payload] of cases) {
		storage.clear();
		storage.set('fatfish-canvas:board', payload);
		const store = await loadTsModule(resolve(root, 'src/client/canvas/store.ts'));
		const board = store.getBoard();
		const nodesOk = Array.isArray(board.nodes);
		const coordsOk = board.nodes.every(
			(node) =>
				Number.isFinite(node.x) &&
				Number.isFinite(node.y) &&
				Number.isFinite(node.w) &&
				Number.isFinite(node.h) &&
				node.w > 0 &&
				node.h > 0,
		);
		// 上限直接读 ZOOM_MAX，别写死数字：改上限（本轮 4 → 10）时这里不该再漂一次
		const zoomOk = Number.isFinite(board.viewport.zoom) && board.viewport.zoom <= zoomMax;
		check(`坏数据防御：${label}`, nodesOk && coordsOk && zoomOk, JSON.stringify(board.viewport));
	}
	storage.clear();
}

{
	// 合法但 mix 的数据：坏节点被剔除，好节点保留
	storage.set(
		'fatfish-canvas:board',
		JSON.stringify({
			version: 1,
			nodes: [
				{ id: 'good', kind: 'image', x: 1, y: 2, w: 30, h: 40, z: 1, status: 'ready', createdAt: 1 },
				{ id: 'bad', x: 'oops', y: 0, w: 10, h: 10 },
			],
			viewport: { x: 0, y: 0, zoom: 1 },
		}),
	);
	const store = await loadTsModule(resolve(root, 'src/client/canvas/store.ts'));
	check(
		'混合数据：坏节点剔除、好节点保留',
		store.getBoard().nodes.length === 1 && store.getBoard().nodes[0].id === 'good',
		JSON.stringify(store.getBoard().nodes.map((n) => n.id)),
	);
	storage.clear();
}

// ─────────────────── 3. 生成落位算法（移植自 jaaz） ───────────────────

console.log('\n3) 生成落位算法');

{
	/** 造一个节点。 */
	const node = (x, y, w = 100, h = 100, kind = 'image') => ({
		id: `n_${String(x)}_${String(y)}`,
		kind,
		x,
		y,
		w,
		h,
		z: 1,
		status: 'ready',
		createdAt: 0,
	});

	check('空画布落在原点', JSON.stringify(model.nextPlacement([], { w: 100, h: 100 })) === '{"x":0,"y":0}');

	check(
		'单个节点：贴在其右侧 + spacing，y 对齐',
		JSON.stringify(model.nextPlacement([node(0, 0)], { w: 100, h: 100 })) === '{"x":120,"y":0}',
		JSON.stringify(model.nextPlacement([node(0, 0)], { w: 100, h: 100 })),
	);

	check(
		'同一行第 2 个：接在最右节点之后',
		JSON.stringify(model.nextPlacement([node(0, 0), node(120, 0)], { w: 100, h: 100 })) ===
			'{"x":240,"y":0}',
	);

	check(
		'同一行第 4 个：仍在该行（未满 4）',
		JSON.stringify(
			model.nextPlacement([node(0, 0), node(120, 0), node(240, 0)], { w: 100, h: 100 }),
		) === '{"x":360,"y":0}',
	);

	check(
		'一行满 4 个后换行：x 归零、y = 末行底部 + spacing',
		JSON.stringify(
			model.nextPlacement(
				[node(0, 0), node(120, 0), node(240, 0), node(360, 0)],
				{ w: 100, h: 100 },
			),
		) === '{"x":0,"y":120}',
	);

	// 垂直重叠判据：max(y1,y2) < min(y1+h1, y2+h2) → 同一行
	check(
		'垂直重叠的两个节点归为同一行，y 取行内最小值',
		JSON.stringify(model.nextPlacement([node(0, 0), node(120, 10)], { w: 100, h: 100 })) ===
			'{"x":240,"y":0}',
	);

	check(
		'垂直不重叠时分行，取平均 y 最大的那一行',
		JSON.stringify(model.nextPlacement([node(0, 0), node(0, 500)], { w: 100, h: 100 })) ===
			'{"x":120,"y":500}',
	);

	check(
		'文字节点不参与排布（jaaz 只考虑媒体元素）',
		JSON.stringify(model.nextPlacement([node(0, 0, 100, 100, 'text')], { w: 100, h: 100 })) ===
			'{"x":0,"y":0}',
	);

	check(
		'媒体与文字混合：文字被忽略，位置紧贴媒体',
		JSON.stringify(
			model.nextPlacement([node(0, 0, 100, 100, 'text'), node(500, 0)], { w: 100, h: 100 }),
		) === '{"x":620,"y":0}',
	);

	check(
		'spacing 可覆盖',
		JSON.stringify(model.nextPlacement([node(0, 0)], { w: 100, h: 100 }, { spacing: 0 })) ===
			'{"x":100,"y":0}',
	);

	check(
		'maxPerRow 可覆盖（改为 2 后第 3 个换行）',
		JSON.stringify(
			model.nextPlacement([node(0, 0), node(120, 0)], { w: 100, h: 100 }, { maxPerRow: 2 }),
		) === '{"x":0,"y":120}',
	);

	// 连续落 5 次应形成 4 + 1 的两行布局，且互不重叠
	{
		const placed = [];
		for (let i = 0; i < 5; i += 1) {
			const pos = model.nextPlacement(placed, { w: 100, h: 100 });
			placed.push(node(pos.x, pos.y));
		}
		const overlap = placed.some((a, i) =>
			placed.some(
				(b, j) => i !== j && model.rectsIntersect({ x: a.x, y: a.y, w: 100, h: 100 }, { x: b.x, y: b.y, w: 100, h: 100 }),
			),
		);
		check('连续落 5 个节点互不重叠', !overlap, JSON.stringify(placed.map((n) => [n.x, n.y])));
		check(
			'连续落 5 个形成 4+1 两行',
			placed[3].x === 360 && placed[4].x === 0 && placed[4].y === 120,
			JSON.stringify(placed.map((n) => [n.x, n.y])),
		);
	}
}

// ─────── 3b. 拖入多张图的排布 + 拖动时的对齐吸附（P17） ───────

console.log('\n3b) 拖入多张图的排布与对齐吸附');

{
	const size = (w, h) => ({ w, h });
	const overlaps = (spots, sizes) =>
		spots.some((a, i) =>
			spots.some(
				(b, j) =>
					i !== j &&
					model.rectsIntersect(
						{ x: a.x, y: a.y, ...sizes[i] },
						{ x: b.x, y: b.y, ...sizes[j] },
					),
			),
		);

	check('dropLayout：空输入返回空数组', model.dropLayout({ x: 5, y: 5 }, []).length === 0);

	{
		const sizes = [size(100, 100), size(100, 100), size(100, 100), size(100, 100), size(100, 100)];
		const spots = model.dropLayout({ x: 100, y: 200 }, sizes);
		check('dropLayout：第一个落在锚点（不居中、不偏移）', spots[0].x === 100 && spots[0].y === 200);
		check(
			'dropLayout：第二个接在右边 + spacing',
			spots[1].x === 220 && spots[1].y === 200,
			JSON.stringify(spots[1]),
		);
		check(
			'dropLayout：第 5 个换行（一行 4 个）',
			spots[4].x === 100 && spots[4].y === 320,
			JSON.stringify(spots[4]),
		);
		check('dropLayout：一批 5 张互不重叠', !overlaps(spots, sizes));
	}

	{
		// 尺寸不一：行内按**前一个的宽度**推进，换行用**该行最高者**
		const sizes = [size(100, 50), size(200, 120), size(50, 50), size(50, 50), size(50, 50)];
		const spots = model.dropLayout({ x: 0, y: 0 }, sizes);
		check('dropLayout：宽度不同也不压（按各自宽度推进）', spots[1].x === 120, JSON.stringify(spots[1]));
		check('dropLayout：换行高度取该行最高者', spots[4].y === 140, JSON.stringify(spots[4]));
		check('dropLayout：尺寸不一的一批互不重叠', !overlaps(spots, sizes));
	}

	{
		const spots = model.dropLayout({ x: 0, y: 0 }, [size(10, 10), size(10, 10)], { maxPerRow: 1 });
		check('dropLayout：maxPerRow 可覆盖（1 = 每行一个）', spots[1].x === 0 && spots[1].y === 30);
	}

	// ── 对齐吸附 ──
	const rect = (x, y, w = 100, h = 100) => ({ x, y, w, h });

	{
		const s = model.snapMove(rect(104, 300), [rect(100, 0)], 6);
		check('snapMove：左边缘吸附（dx = -4）', s.dx === -4 && s.dy === 0, JSON.stringify(s));
		check(
			'snapMove：回一条竖线，落在被对齐的那条边上',
			s.guides.length === 1 && s.guides[0].axis === 'x' && s.guides[0].position === 100,
			JSON.stringify(s.guides),
		);
		check(
			'snapMove：辅助线覆盖「我」与「它」（y 0 → 400）',
			s.guides[0].from === 0 && s.guides[0].to === 400,
			JSON.stringify(s.guides[0]),
		);
	}

	{
		const s = model.snapMove(rect(120, 300), [rect(100, 0)], 6);
		check('snapMove：超出容差不吸附、也不画线', s.dx === 0 && s.dy === 0 && s.guides.length === 0);
	}

	{
		// 中线对齐：移动矩形 top=253（中线 303） vs 对方中线 250 → 取最近的 -3
		const s = model.snapMove(rect(300, 253), [rect(0, 200)], 6);
		check(
			'snapMove：中线也能吸（dy = -3、线在 250）',
			s.dy === -3 && s.guides.length === 1 && s.guides[0].position === 250,
			JSON.stringify(s),
		);
	}

	{
		const s = model.snapMove(rect(103, 305), [rect(100, 300), rect(300, 100)], 6);
		check(
			'snapMove：两个轴各吸一次（一横一竖）',
			s.dx === -3 && s.dy === -5 && s.guides.length === 2,
			JSON.stringify(s),
		);
	}

	{
		const s = model.snapMove(rect(100, 300), [rect(100, 0)], 6);
		check('snapMove：本来就在线上（偏移 0）也回线', s.dx === 0 && s.guides.length === 1);
	}

	check('snapMove：容差为 0 等于不吸附', model.snapMove(rect(104, 300), [rect(100, 0)], 0).guides.length === 0);
	check(
		'snapMove：画布上只有自己（没有别的节点）时不吸附',
		model.snapMove(rect(0, 0), [], 6).guides.length === 0,
	);
}

// ─────── 3c. 生成模型目录（主界面那一格读的就是它，P17） ───────

console.log('\n3c) 生成模型目录');

{
	const settings = await loadTsModule(resolve(root, 'src/client/settings/models.ts'));

	const catalog = settings.mediaCatalog({
		providers: {
			acme: {
				label: 'Acme 网关',
				baseURL: 'https://gw.acme.example/v1',
				models: [
					{ id: 'acme-large', kind: 'image', label: '大模型' },
					{ id: 'acme-mov', kind: 'video' },
					{ id: 'acme-vl', kind: 'vision' },
				],
			},
			bare: { models: [{ id: 'b1', kind: 'image' }] },
		},
		defaultImage: 'acme::acme-large',
		defaultVideo: 'acme::acme-mov',
	});

	check(
		'目录：图像模型来自所有供应商（顺序不变）',
		catalog.image.map((o) => o.ref).join(',') === 'acme::acme-large,bare::b1',
		catalog.image.map((o) => o.ref).join(','),
	);
	check(
		'目录：视频模型单列',
		catalog.video.length === 1 && catalog.video[0].ref === 'acme::acme-mov',
		JSON.stringify(catalog.video),
	);
	check(
		'目录：视觉模型不进这两张清单（它不是产物）',
		![...catalog.image, ...catalog.video].some((o) => o.modelId === 'acme-vl'),
	);
	check('目录：供应商展示名缺省用 id', catalog.image[1].providerLabel === 'bare');
	check('目录：模型展示名缺省用 id，有 label 则用 label', catalog.image[0].modelLabel === '大模型' && catalog.image[1].modelLabel === 'b1');
	check(
		'目录：默认值原样读出（按钮上的勾靠它）',
		catalog.defaults.image === 'acme::acme-large' && catalog.defaults.video === 'acme::acme-mov',
	);

	// 坏数据只应该让这一项消失，不该让整块炸掉（设置可能被手工改坏）
	const broken = settings.mediaCatalog({
		providers: {
			good: { models: [{ id: 'ok', kind: 'image' }, { id: '', kind: 'image' }, null, 'x'] },
			bad: null,
			worse: { models: 'not-an-array' },
		},
	});
	check(
		'目录：坏数据只剔掉坏项（不抛、不造空 id）',
		broken.image.length === 1 && broken.image[0].modelId === 'ok',
		JSON.stringify(broken.image),
	);
	check(
		'目录：值不是对象时返回空目录',
		settings.mediaCatalog(null).image.length === 0 && settings.mediaCatalog(undefined).video.length === 0,
	);
	check('目录：默认值缺失时为空串（= 自动）', settings.mediaCatalog({ providers: {} }).defaults.image === '');
}

// ─────────────────── 4. 生成结果 → 画布落图（P3） ───────────────────

console.log('\n4) 生成结果 → 画布落图（P3）');

{
	storage.clear();
	// ingest 与 store 必须共用同一份模块实例：落图动作写的是 store 的模块级
	// 状态，若各加载一份，断言读到的会是另一个空画布。
	const shared = new Map();
	const storePath = resolve(root, 'src/client/canvas/store.ts');
	const store = await loadTsModule(storePath, shared);
	const ingest = await loadTsModule(resolve(root, 'src/client/canvas/ingest.ts'), shared);
	const media = await loadTsModule(resolve(root, 'src/client/shared/media.ts'), shared);

	const callArgs = JSON.stringify({ prompt: '一只肥鱼', kind: 'image' });
	const runningSnap = (callId, name = 'media_generate', argsRaw = callArgs) => ({
		runningCalls: [{ callId, name, argsRaw }],
		nodes: [],
	});
	const resultSnap = (callId, over = {}) => ({
		runningCalls: [],
		nodes: [
			{
				kind: 'tool-result',
				seq: 5,
				time: Date.now(),
				callId,
				call: { name: 'media_generate', argsRaw: callArgs },
				isError: false,
				content: [{ type: 'text', text: '已生成图像' }],
				meta: {
					fatfishCanvas: {
						kind: 'image',
						url: `http://media.test/${callId}.png`,
						model: 'gpt-image-1',
						providerId: 'openai-images',
						prompt: '一只肥鱼',
						aspectRatio: '1:1',
					},
				},
				...over,
			},
		],
	});
	const now = () => Date.now();

	// ── 4.1 共享契约的解析（跨进程数据，必须逐字段校验） ──
	check(
		'readMediaPresentation 解析合法 meta',
		(() => {
			const m = media.readMediaPresentation({
				fatfishCanvas: { kind: 'video', url: 'http://x/1.mp4', prompt: '海' },
			});
			return m !== null && m.kind === 'video' && m.url === 'http://x/1.mp4' && m.prompt === '海';
		})(),
	);
	const badMetas = [
		['空 meta', {}],
		['没有本插件的键', { other: { kind: 'image', url: 'x' } }],
		['未知种类', { fatfishCanvas: { kind: 'audio', url: 'x' } }],
		['没有地址', { fatfishCanvas: { kind: 'image' } }],
		['空地址', { fatfishCanvas: { kind: 'image', url: '' } }],
		['meta 是字符串', 'fatfishCanvas'],
		['meta 是 null', null],
	];
	check(
		'坏 meta 一律解析成 null（不进画布）',
		badMetas.every(([, meta]) => media.readMediaPresentation(meta) === null),
		badMetas.map(([label, meta]) => `${label}:${String(media.readMediaPresentation(meta))}`).join(' '),
	);
	check(
		'parseMediaCallArgs 接受 argsRaw 字符串',
		media.parseMediaCallArgs('{"prompt":"猫","kind":"video"}').kind === 'video',
	);
	check(
		'parseMediaCallArgs 对坏 JSON 给出安全默认值',
		(() => {
			const a = media.parseMediaCallArgs('这不是 JSON');
			return a.kind === 'image' && a.prompt === '';
		})(),
	);
	// ── 4.1b 参考图句柄（画布菜单据此启用/禁用「以此为参考图生成」） ──
	check(
		'isReferenceHandle 收 http(s) 与小的 data:（宿主取得到）',
		media.isReferenceHandle('https://cdn.example.com/a.png') &&
			media.isReferenceHandle('data:image/png;base64,QUJD'),
	);
	check(
		'isReferenceHandle 拒 blob: / 相对路径 / 空值（宿主取不到这些）',
		!media.isReferenceHandle('blob:http://127.0.0.1/abc') &&
			!media.isReferenceHandle('/image/a.png') &&
			!media.isReferenceHandle('') &&
			!media.isReferenceHandle(undefined),
	);
	check(
		'isReferenceHandle 拒超大的 data: 内联图（命令行会被撑爆）',
		!media.isReferenceHandle(`data:image/png;base64,${'A'.repeat(media.REFERENCE_MAX_INLINE)}`),
		String(media.REFERENCE_MAX_INLINE),
	);
	check(
		'usedReference 只有明确为 true 才认（缺字段 / 假值都不显示徽标）',
		(() => {
			const withRef = media.readMediaPresentation({
				fatfishCanvas: { kind: 'image', url: 'http://x/1.png', usedReference: true },
			});
			const without = media.readMediaPresentation({
				fatfishCanvas: { kind: 'image', url: 'http://x/1.png' },
			});
			const bogus = media.readMediaPresentation({
				fatfishCanvas: { kind: 'image', url: 'http://x/1.png', usedReference: 'yes' },
			});
			return (
				withRef?.usedReference === true &&
				without?.usedReference === undefined &&
				bogus?.usedReference === undefined
			);
		})(),
	);
	check(
		'mediaNodeSize：图像默认 1:1',
		JSON.stringify(media.mediaNodeSize({ kind: 'image' })) === '{"w":320,"h":320}',
		JSON.stringify(media.mediaNodeSize({ kind: 'image' })),
	);
	check(
		'mediaNodeSize：视频默认 16:9',
		JSON.stringify(media.mediaNodeSize({ kind: 'video' })) === '{"w":320,"h":180}',
		JSON.stringify(media.mediaNodeSize({ kind: 'video' })),
	);
	check(
		'mediaNodeSize：竖向比例 9:16',
		JSON.stringify(media.mediaNodeSize({ aspectRatio: '9:16' })) === '{"w":180,"h":320}',
		JSON.stringify(media.mediaNodeSize({ aspectRatio: '9:16' })),
	);
	check(
		'mediaNodeSize：像素尺寸优先于比例',
		JSON.stringify(media.mediaNodeSize({ width: 1024, height: 768 })) === '{"w":320,"h":240}',
		JSON.stringify(media.mediaNodeSize({ width: 1024, height: 768 })),
	);
	check('mediaNodeId 由 callId 派生', media.mediaNodeId('abc') === 'gen_abc');

	// ── 4.2 进行中的调用先落 pending 节点 ──
	let report = ingest.syncConversation(runningSnap('c1'), 'sess-1', {
		baselineSeq: 0,
		now: now(),
	});
	let board = store.getBoard();
	check('进行中的生成落下一个节点', board.nodes.length === 1, `created=${String(report.created)}`);
	const pending = board.nodes[0];
	check('节点 id 由 callId 派生', pending.id === 'gen_c1', pending.id);
	check('节点状态是 pending', pending.status === 'pending', pending.status);
	check('节点种类来自调用参数', pending.kind === 'image', pending.kind);
	check('节点带上提示词', String(pending.title).includes('一只肥鱼'), String(pending.title));
	check('节点带上会话 id', pending.sessionId === 'sess-1', String(pending.sessionId));
	check(
		'节点尺寸按参数比例定好（1:1）',
		pending.w === 320 && pending.h === 320,
		`${String(pending.w)}x${String(pending.h)}`,
	);

	// 幂等：同一个快照再来多少次都只落一个节点
	report = ingest.syncConversation(runningSnap('c1'), 'sess-1', { baselineSeq: 0, now: now() });
	check(
		'重复快照不会重复落图（幂等）',
		store.getBoard().nodes.length === 1 && report.created === 0,
		`created=${String(report.created)}`,
	);
	check(
		'非本工具的运行中调用被忽略',
		(() => {
			ingest.syncConversation(runningSnap('x1', 'bash', '{}'), 'sess-1', {
				baselineSeq: 0,
				now: now(),
			});
			return store.getBoard().nodes.length === 1;
		})(),
	);

	// 两个不同的并发生成：落位必须错开（同一批同步里也不能重叠）
	ingest.syncConversation(
		{
			runningCalls: [
				{ callId: 'c1', name: 'media_generate', argsRaw: callArgs },
				{ callId: 'c2', name: 'media_generate', argsRaw: callArgs },
			],
			nodes: [],
		},
		'sess-1',
		{ baselineSeq: 0, now: now() },
	);
	board = store.getBoard();
	check('并发生成各落一个节点', board.nodes.length === 2, `实际 ${String(board.nodes.length)}`);
	check(
		'同批节点错开落位（不重叠）',
		board.nodes[0].x !== board.nodes[1].x || board.nodes[0].y !== board.nodes[1].y,
		JSON.stringify(board.nodes.map((n) => [n.x, n.y])),
	);

	// ── 4.3 结果到达：pending → ready，节点不跳位 ──
	const beforePos = { x: pending.x, y: pending.y };
	report = ingest.syncConversation(resultSnap('c1'), 'sess-1', { baselineSeq: 0, now: now() });
	board = store.getBoard();
	const ready = board.nodes.find((n) => n.id === 'gen_c1');
	check('结果到达后节点转为 ready', ready?.status === 'ready', String(ready?.status));
	check('结果写入媒体地址', ready?.src === 'http://media.test/c1.png', String(ready?.src));
	check('结果写入模型名', ready?.model === 'gpt-image-1', String(ready?.model));
	check(
		'状态变更不移动节点（等待中的占位不跳位）',
		ready?.x === beforePos.x && ready?.y === beforePos.y,
		`${JSON.stringify(beforePos)} -> ${JSON.stringify({ x: ready?.x, y: ready?.y })}`,
	);
	check('报告里记为 1 次状态变更', report.resolved === 1, JSON.stringify(report));
	check(
		'重复的结果快照不再产生变更',
		(() => {
			const again = ingest.syncConversation(resultSnap('c1'), 'sess-1', {
				baselineSeq: 0,
				now: now(),
			});
			return again.created === 0 && again.resolved === 0;
		})(),
		JSON.stringify(report),
	);

	// ── 4.4 失败结果：pending → failed 且带原因 ──
	ingest.syncConversation(runningSnap('c3'), 'sess-1', { baselineSeq: 0, now: now() });
	ingest.syncConversation(
		resultSnap('c3', {
			isError: true,
			meta: undefined,
			content: [{ type: 'text', text: '供应商「OpenAI · 图像」还没有配置 API 密钥。' }],
		}),
		'sess-1',
		{ baselineSeq: 0, now: now() },
	);
	const failed = store.getBoard().nodes.find((n) => n.id === 'gen_c3');
	check('失败结果把节点置为 failed', failed?.status === 'failed', String(failed?.status));
	check(
		'失败原因来自结果内容',
		String(failed?.error).includes('API 密钥'),
		String(failed?.error),
	);
	check(
		'textOfContent 拼接文本块并截断',
		ingest.textOfContent([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]) ===
			'a\nb',
	);
	check(
		'textOfContent 剥掉 RPC 的 Error: 前缀',
		ingest.textOfContent([{ type: 'text', text: 'Error: 供应商没有密钥' }]) === '供应商没有密钥',
		ingest.textOfContent([{ type: 'text', text: 'Error: 供应商没有密钥' }]),
	);

	// ── 4.5 只吃新结果：历史不进画布 ──
	const oldSnap = resultSnap('c8', { seq: 2, time: Date.now() - 60 * 60 * 1000 });
	ingest.syncConversation(oldSnap, 'sess-2', { baselineSeq: 99, now: now() });
	check(
		'历史结果（seq 低于基线且时间很旧）不落图',
		store.getBoard().nodes.every((n) => n.id !== 'gen_c8'),
		JSON.stringify(store.getBoard().nodes.map((n) => n.id)),
	);
	const freshSnap = resultSnap('c9', { seq: 2, time: Date.now() - 30 * 1000 });
	ingest.syncConversation(freshSnap, 'sess-2', { baselineSeq: 99, now: now() });
	const late = store.getBoard().nodes.find((n) => n.id === 'gen_c9');
	check(
		'刚完成的结果即使在基线之前也补落（打开页面时正好生成完）',
		late?.status === 'ready',
		String(late?.status),
	);
	check(
		'isFreshResult：seq 越过基线即新鲜',
		ingest.isFreshResult({ seq: 100, time: 0 }, 99, Date.now()),
	);
	check(
		'isFreshResult：老事件且老时间不算新鲜',
		!ingest.isFreshResult({ seq: 2, time: 0 }, 99, Date.now()),
	);

	// ── 4.6 用户删掉的节点不会被历史重放复活 ──
	store.removeNodes(['gen_c1']);
	check(
		'删除节点成功',
		store.getBoard().nodes.every((n) => n.id !== 'gen_c1'),
	);
	ingest.syncConversation(resultSnap('c1'), 'sess-1', { baselineSeq: 0, now: now() });
	check(
		'再同步同一结果不会复活已删除的节点',
		store.getBoard().nodes.every((n) => n.id !== 'gen_c1'),
		JSON.stringify(store.getBoard().nodes.map((n) => n.id)),
	);
	// 清空画布同样保留记账：刚生成过的那几张不会立刻被重放回来
	store.clearBoard();
	ingest.syncConversation(resultSnap('c1'), 'sess-1', { baselineSeq: 0, now: now() });
	check(
		'清空画布后 ingested 仍记账（不重放）',
		store.getBoard().nodes.length === 0,
		`实际 ${String(store.getBoard().nodes.length)}`,
	);

	// ── 4.7 记账持久化（重载后仍然幂等） ──
	store.flushPersist();
	const reloaded = await loadTsModule(storePath); // 新实例：走真实的 localStorage 读取
	check(
		'账本随画布一起持久化',
		reloaded.getBoard().ingested.includes('gen_c1'),
		JSON.stringify(reloaded.getBoard().ingested),
	);
	check(
		'持久化形态回读正确（nodes/links/viewport/ingested 都在）',
		(() => {
			const raw = JSON.parse(storage.get('fatfish-canvas:board'));
			return (
				raw.version === 3 &&
				Array.isArray(raw.nodes) &&
				Array.isArray(raw.links) &&
				Array.isArray(raw.ingested)
			);
		})(),
		String(storage.get('fatfish-canvas:board')).slice(0, 120),
	);
	// v1（P2 时代）的数据没有 ingested 字段，必须照样能读
	storage.set(
		'fatfish-canvas:board',
		JSON.stringify({
			version: 1,
			nodes: [
				{ id: 'old', kind: 'image', x: 0, y: 0, w: 10, h: 10, z: 1, status: 'ready', createdAt: 1 },
			],
			viewport: { x: 0, y: 0, zoom: 1 },
		}),
	);
	const legacy = await loadTsModule(storePath);
	check(
		'v1 数据反序列化后 ingested 为空数组、节点保留',
		legacy.getBoard().ingested.length === 0 && legacy.getBoard().nodes.length === 1,
		JSON.stringify({ ingested: legacy.getBoard().ingested, nodes: legacy.getBoard().nodes.length }),
	);
	check(
		'坏账本（非字符串项）被剔除',
		await (async () => {
			storage.set(
				'fatfish-canvas:board',
				JSON.stringify({
					version: 2,
					nodes: [],
					viewport: { x: 0, y: 0, zoom: 1 },
					ingested: ['gen_ok', 42, null, ''],
				}),
			);
			const bad = await loadTsModule(storePath);
			return JSON.stringify(bad.getBoard().ingested) === '["gen_ok"]';
		})(),
	);
	storage.clear();
}

// ─────────────────── 5. P4：跟焦 / 视图动作 / 视图模式 ───────────────────

console.log('\n5) P4：新节点跟焦 · 视图动作 · 视图模式');

{
	storage.clear();
	const shared = new Map();
	const modelPath = resolve(root, 'src/client/canvas/model.ts');
	const storePath = resolve(root, 'src/client/canvas/store.ts');
	const followPath = resolve(root, 'src/client/canvas/follow.ts');
	const actionsPath = resolve(root, 'src/client/canvas/actions.ts');
	const statePath = resolve(root, 'src/client/state.ts');

	storage.set('fatfish-canvas:view-mode', 'chat');
	const state = await loadTsModule(statePath, shared);
	const follow = await loadTsModule(followPath, shared);
	const store = await loadTsModule(storePath, shared);
	const actions = await loadTsModule(actionsPath, shared);
	const m = await loadTsModule(modelPath, shared);

	/** 造一个节点（世界坐标）。 */
	const node = (id, x, y, w = 320, h = 320) => ({
		id,
		kind: 'image',
		x,
		y,
		w,
		h,
		z: 1,
		status: 'ready',
		createdAt: 1,
	});

	// ── 5.1 planFocus 的几何 ──
	const size = { w: 1000, h: 700 };
	const vp = { x: 0, y: 0, zoom: 1 };

	check(
		'planFocus：没有节点时不动',
		(() => {
			const plan = follow.planFocus([], vp, size);
			return plan.moved === false && plan.reason === 'empty' && plan.viewport === vp;
		})(),
	);
	check(
		'planFocus：视口没有尺寸时不动（画布还没挂载）',
		follow.planFocus([node('a', 0, 0)], vp, { w: 0, h: 0 }).reason === 'no-size',
	);
	check(
		'planFocus：已经完整可见时**绝不**重新居中（否则每次生成画面都抖一下）',
		(() => {
			const plan = follow.planFocus([node('a', 100, 100)], vp, size);
			return plan.moved === false && plan.reason === 'visible' && plan.viewport === vp;
		})(),
	);
	check(
		'planFocus：贴着边缘（落在留白里）也算不可见',
		(() => {
			const plan = follow.planFocus([node('a', 8, 300)], vp, size);
			return plan.moved === true && plan.reason === 'centered';
		})(),
		follow.planFocus([node('a', 8, 300)], vp, size).reason,
	);

	{
		const target = node('a', 2000, 1200);
		const plan = follow.planFocus([target], vp, size);
		const center = m.toScreen(
			{ x: target.x + target.w / 2, y: target.y + target.h / 2 },
			plan.viewport,
		);
		check(
			'planFocus：视野外 → 保持缩放并居中到视口中心',
			plan.moved === true &&
				plan.reason === 'centered' &&
				plan.viewport.zoom === 1 &&
				Math.abs(center.x - size.w / 2) < 1e-6 &&
				Math.abs(center.y - size.h / 2) < 1e-6,
			`${JSON.stringify(plan.viewport)} center=${JSON.stringify(center)}`,
		);
	}

	{
		const huge = node('big', 5000, 5000, 4000, 3000);
		const plan = follow.planFocus([huge], vp, size);
		const tl = m.toScreen({ x: huge.x, y: huge.y }, plan.viewport);
		const br = m.toScreen({ x: huge.x + huge.w, y: huge.y + huge.h }, plan.viewport);
		check(
			'planFocus：节点比视口大 → 缩小到能装下（且完整落在留白内）',
			plan.moved === true &&
				plan.reason === 'fitted' &&
				plan.viewport.zoom < 1 &&
				tl.x >= follow.FOLLOW_PADDING - 1 &&
				br.x <= size.w - follow.FOLLOW_PADDING + 1,
			`zoom=${String(plan.viewport.zoom)} tl=${JSON.stringify(tl)} br=${JSON.stringify(br)}`,
		);
	}

	{
		// 多个节点：按并集包围盒居中
		const many = [node('a', 3000, 0), node('b', 3000, 900)];
		const plan = follow.planFocus(many, vp, size);
		const bounds = m.boundsOf(many);
		const center = m.toScreen(
			{ x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 },
			plan.viewport,
		);
		check(
			'planFocus：多节点按并集居中',
			plan.moved === true && Math.abs(center.x - size.w / 2) < 1e-6,
			JSON.stringify(center),
		);
	}

	// ── 5.2 decideFollow 的策略 ──
	check(
		'decideFollow：开关关掉就什么都不做',
		follow.decideFollow({ enabled: false, busy: false, sinceUserMs: 9999, queuedMs: 0 }) === 'skip',
	);
	check(
		'decideFollow：安静期内先排队（不抢用户正在看的画面）',
		follow.decideFollow({ enabled: true, busy: false, sinceUserMs: 100, queuedMs: 0 }) === 'queue',
	);
	check(
		'decideFollow：安静期过了就执行',
		follow.decideFollow({ enabled: true, busy: false, sinceUserMs: 5000, queuedMs: 0 }) === 'apply',
	);
	check(
		'decideFollow：用户正在拖拽时不抢（排队）',
		follow.decideFollow({ enabled: true, busy: true, sinceUserMs: 9999, queuedMs: 0 }) === 'queue',
	);
	check(
		'decideFollow：一直忙 / 一直不安静 → 超时放弃（宁可不动，也不跟用户拉扯）',
		follow.decideFollow({ enabled: true, busy: true, sinceUserMs: 9999, queuedMs: 99999 }) === 'skip' &&
			follow.decideFollow({ enabled: true, busy: false, sinceUserMs: 1, queuedMs: 99999 }) === 'skip',
	);

	// ── 5.3 待跟焦队列 ──
	check('队列初始为空', follow.hasPendingFocus() === false);
	follow.queueFocus(['a', 'b'], 1000);
	follow.queueFocus(['b', 'c'], 2000);
	check(
		'队列取并集、保留最早入队时间',
		(() => {
			const q = follow.peekFocus();
			return JSON.stringify(q.ids) === '["a","b","c"]' && q.at === 1000;
		})(),
		JSON.stringify(follow.peekFocus()),
	);
	follow.clearFocus();
	check('清空后队列为空', follow.hasPendingFocus() === false);
	check('空入参不入队', (follow.queueFocus([]), follow.hasPendingFocus() === false));

	// ── 5.4 视图动作（fit / 缩放 / 聚焦） ──
	store.clearBoard();
	actions.reportViewportSize({ w: 1000, h: 700 });
	check('画布没挂载（尺寸为 0）时视图动作是安全空操作', (() => {
		actions.reportViewportSize({ w: 0, h: 0 });
		const ok = actions.fitAll() === false && actions.zoomToPercent(200) === false;
		actions.reportViewportSize({ w: 1000, h: 700 });
		return ok;
	})());

	check(
		'空画布上「适应内容」把世界原点放到视口中心',
		(() => {
			actions.fitAll();
			const v = store.getBoard().viewport;
			return v.x === -500 && v.y === -350 && v.zoom === 1;
		})(),
		JSON.stringify(store.getBoard().viewport),
	);

	store.addNodes([{ id: 'n1', kind: 'image', x: 0, y: 0, w: 200, h: 200, status: 'ready' }, { id: 'n2', kind: 'image', x: 1600, y: 900, w: 200, h: 200, status: 'ready' }]);
	check(
		'「适应内容」把两个离得很远的节点都装进视口',
		(() => {
			actions.fitAll();
			const v = store.getBoard().viewport;
			const tl = m.toScreen({ x: 0, y: 0 }, v);
			const br = m.toScreen({ x: 1800, y: 1100 }, v);
			return tl.x >= -1 && tl.y >= -1 && br.x <= 1001 && br.y <= 701 && v.zoom < 1;
		})(),
		JSON.stringify(store.getBoard().viewport),
	);

	check(
		'zoomToPercent 以视口中心为锚点（内容不漂移）',
		(() => {
			// 按钮缩放锚定的是**视口中心**，所以该断言必须取中心点 ——
			// 取别的点会「测出漂移」，那是断言错而不是代码错（P1 踩过一模一样的坑）。
			const center = { x: 1000 / 2, y: 700 / 2 };
			const before = m.toWorld(center, store.getBoard().viewport);
			actions.zoomToPercent(200);
			const after = m.toWorld(center, store.getBoard().viewport);
			return (
				Math.abs(store.getBoard().viewport.zoom - 2) < 1e-9 &&
				Math.abs(after.x - before.x) < 1e-6 &&
				Math.abs(after.y - before.y) < 1e-6
			);
		})(),
		JSON.stringify(store.getBoard().viewport),
	);
	check(
		'zoomByPoints 是「加 10 个百分点」而不是乘法步进',
		(() => {
			actions.zoomToPercent(100);
			actions.zoomByPoints(0.1);
			return Math.abs(store.getBoard().viewport.zoom - 1.1) < 1e-9;
		})(),
		String(store.getBoard().viewport.zoom),
	);

	check(
		'focusNodes：已经可见的节点不移动视口（返回 false）',
		(() => {
			actions.zoomToPercent(100);
			actions.focusNodes(['n1', 'n2'], { padding: 40 });
			const before = JSON.stringify(store.getBoard().viewport);
			const moved = actions.focusNodes(['n1', 'n2'], { padding: 40 });
			return moved === false && before === JSON.stringify(store.getBoard().viewport);
		})(),
	);
	check(
		'focusNodes：视野外的节点被带进来',
		(() => {
			actions.zoomToPercent(100);
			actions.focusNodes(['n1'], { padding: 40 });
			const moved = actions.focusNodes(['n2'], { padding: 40 });
			const center = m.toScreen({ x: 1700, y: 1000 }, store.getBoard().viewport);
			return moved === true && Math.abs(center.x - 500) < 1e-6;
		})(),
		JSON.stringify(store.getBoard().viewport),
	);
	check(
		'focusNodes：未知 id 不做任何事',
		actions.focusNodes(['nope']) === false,
	);
	check(
		'程序化移动会广播原因（画布据此决定是否加过渡动画）',
		(() => {
			const seen = [];
			const off = actions.subscribeViewportActions((reason) => seen.push(reason));
			actions.zoomToPercent(150);
			actions.fitAll();
			actions.focusNodes(['n1'], { padding: 40 });
			off();
			actions.zoomToPercent(100);
			return JSON.stringify(seen) === '["zoom","fit"]' || seen.includes('fit');
		})(),
	);

	// ── 5.5 视图模式与偏好 ──
	check('初始是聊天模式', state.getMode() === 'chat', state.getMode());
	check(
		'快捷键逻辑：聊天 → 上一次的画布模式（默认并排）',
		state.toggleCanvasMode() === 'canvas' && state.getMode() === 'canvas',
	);
	check('再切一次回到聊天', state.toggleCanvasMode() === 'chat' && state.getMode() === 'chat');
	state.setMode('canvas-only');
	check(
		'纯画布模式下切回聊天、再切回来仍是纯画布（记住上次的画布模式）',
		state.toggleCanvasMode() === 'chat' && state.toggleCanvasMode() === 'canvas-only',
		String(state.getMode()),
	);
	check('纯画布也算画布类模式', state.isCanvasMode('canvas-only') === true && state.isCanvasMode('chat') === false);
	check(
		'模式写进了 localStorage',
		storage.get('fatfish-canvas:view-mode') === 'canvas-only' &&
			storage.get('fatfish-canvas:last-canvas-mode') === 'canvas-only',
		String(storage.get('fatfish-canvas:view-mode')),
	);
	check('跟焦开关默认开', state.getFollowNewNodes() === true);
	check(
		'跟焦开关可翻转并持久化',
		(() => {
			const next = state.toggleFollowNewNodes();
			return next === false && storage.get('fatfish-canvas:follow-new') === 'off';
		})(),
		String(storage.get('fatfish-canvas:follow-new')),
	);
	check(
		'坏的模式值退回聊天模式',
		(() => {
			storage.set('fatfish-canvas:view-mode', 'nonsense');
			return true;
		})(),
	);
	const state2 = await loadTsModule(statePath);
	check('从存储读到非法模式时退回 chat', state2.getMode() === 'chat', state2.getMode());
	storage.clear();
}

// ─────────────────── 6. P5：右键菜单的纯逻辑 ───────────────────

console.log('\n6) P5：节点右键菜单 / 键盘导航 / 重新生成');

{
	storage.clear();
	const shared = new Map();
	const model = await loadTsModule(resolve(root, 'src/client/canvas/model.ts'), shared);
	const menu = await loadTsModule(resolve(root, 'src/client/menu.ts'), shared);
	const regen = await loadTsModule(resolve(root, 'src/client/canvas/regenerate.ts'), shared);

	// ── 6.1 由节点尺寸反推画幅比例 ──
	check('nodeRatio：正方形化简为 1:1', model.nodeRatio({ w: 320, h: 320 }) === '1:1', model.nodeRatio({ w: 320, h: 320 }));
	check('nodeRatio：横图化简为 16:9', model.nodeRatio({ w: 320, h: 180 }) === '16:9', model.nodeRatio({ w: 320, h: 180 }));
	check('nodeRatio：竖图化简为 9:16', model.nodeRatio({ w: 180, h: 320 }) === '9:16', model.nodeRatio({ w: 180, h: 320 }));
	check(
		'nodeRatio：小数点尺寸先取整',
		model.nodeRatio({ w: 319.6, h: 180.2 }) === '16:9',
		model.nodeRatio({ w: 319.6, h: 180.2 }),
	);
	check(
		'nodeRatio：异常尺寸返回 undefined（宁可让参数缺省）',
		model.nodeRatio({ w: 0, h: 100 }) === undefined &&
			model.nodeRatio({ w: -5, h: 10 }) === undefined &&
			model.nodeRatio({ w: Number.NaN, h: 10 }) === undefined &&
			model.nodeRatio({ w: 999999, h: 10 }) === undefined,
	);

	// ── 6.2 菜单键盘导航的取项规则 ──
	const ids = ['a', 'b', 'c', 'd'];
	check('seekEnabled：向下从第一项开始', menu.seekEnabled(ids, -1, 1) === 'a');
	check('seekEnabled：向上从最后一项开始', menu.seekEnabled(ids, 0, -1) === 'd');
	check('seekEnabled：走到末尾后回到第一项（循环）', menu.seekEnabled(ids, 3, 1) === 'a');
	check('seekEnabled：越过开头后回到最后一项（循环）', menu.seekEnabled(ids, 0, -1) === 'd');
	check(
		'seekEnabled：跳过禁用项',
		menu.seekEnabled(ids, 0, 1, (id) => id === 'b') === 'c',
		String(menu.seekEnabled(ids, 0, 1, (id) => id === 'b')),
	);
	check(
		'seekEnabled：连着的禁用项一起跳过',
		menu.seekEnabled(ids, 0, 1, (id) => id === 'b' || id === 'c') === 'd',
	);
	check(
		'seekEnabled：全部禁用时返回 null（键盘不该改变任何东西）',
		menu.seekEnabled(ids, 0, 1, () => true) === null,
	);
	check('seekEnabled：空列表返回 null', menu.seekEnabled([], -1, 1) === null);

	// ── 6.3 浮层夹进视口 ──
	globalThis.window.innerWidth = 1000;
	globalThis.window.innerHeight = 800;
	check(
		'clampToViewport：正常位置原样返回',
		JSON.stringify(menu.clampToViewport({ x: 100, y: 100 }, { w: 200, h: 150 })) === '{"x":100,"y":100}',
	);
	check(
		'clampToViewport：右下角溢出被拉回来（右键菜单最容易顶出屏幕）',
		JSON.stringify(menu.clampToViewport({ x: 990, y: 790 }, { w: 200, h: 150 })) === '{"x":792,"y":642}',
		JSON.stringify(menu.clampToViewport({ x: 990, y: 790 }, { w: 200, h: 150 })),
	);
	check(
		'clampToViewport：左上角负坐标被推回间距内',
		JSON.stringify(menu.clampToViewport({ x: -50, y: -20 }, { w: 180, h: 120 })) === '{"x":8,"y":8}',
	);

	// ── 6.4 「重新生成」的目标与文案 ──
	check('没有目标会话时重新生成不可用（菜单据此禁用）', regen.hasRegenerateTarget() === false);
	check('没有目标时必须拒绝，而不是静默失败', (await regen.regenerate('一只肥鱼')) === null);

	const sent = [];
	const off = regen.setRegenerateTarget({
		prompt: (content, mode) => {
			sent.push({ text: content[0]?.text, mode });
			return Promise.resolve({ ok: true });
		},
	});
	check('注入目标后可用', regen.hasRegenerateTarget() === true);
	check(
		'目标没有命令面时退回提示词（并要求调用工具、带上画幅）',
		(await regen.regenerate('一只肥鱼', { kind: 'image', ratio: '16:9' })) === 'prompt' &&
			sent.length === 1 &&
			String(sent[0].text).includes('media_generate') &&
			String(sent[0].text).includes('一只肥鱼') &&
			String(sent[0].text).includes('16:9') &&
			sent[0].mode === 'queue',
		JSON.stringify(sent[0]),
	);
	check(
		'regeneratePrompt：视频种类也说得对',
		regen.regeneratePrompt('海浪', 'video').includes('视频'),
		regen.regeneratePrompt('海浪', 'video'),
	);
	check('空提示词直接拒绝', (await regen.regenerate('')) === null);
	off();
	check('撤销注入后目标清空', regen.hasRegenerateTarget() === false);

	// ── 6.5 prompt 抛错时不能把异常抛给 UI ──
	const off2 = regen.setRegenerateTarget({
		prompt: () => Promise.reject(new Error('rpc down')),
	});
	check('投递失败返回 null（菜单据此提示，而不是崩掉）', (await regen.regenerate('x')) === null);
	off2();

	// ── 6.6 重新生成优先走 `/generate` 直达命令（P6） ──
	{
		check(
			'regenerateCommandLine：图像不带 --video，视频带；比例可选',
			regen.regenerateCommandLine('猫', { kind: 'image', ratio: '16:9' }) ===
				'/generate --ratio 16:9 猫 ' &&
				regen.regenerateCommandLine('海浪', { kind: 'video' }) === '/generate --video 海浪 ' &&
				regen.regenerateCommandLine('猫') === '/generate 猫 ',
			`${regen.regenerateCommandLine('猫', { kind: 'image', ratio: '16:9' })} | ${regen.regenerateCommandLine('海浪', { kind: 'video' })}`,
		);
		check(
			'regenerateCommandLine：视频参数只对视频生效（图像带上只会让命令行变长）',
			regen.regenerateCommandLine('海浪', { kind: 'video', duration: 5, resolution: '1080p' }) ===
				'/generate --video --duration 5 --resolution 1080p 海浪 ' &&
				regen.regenerateCommandLine('猫', { kind: 'image', duration: 5, resolution: '1080p' }) ===
					'/generate 猫 ',
			regen.regenerateCommandLine('海浪', { kind: 'video', duration: 5, resolution: '1080p' }),
		);

		const lines = [];
		const prompts = [];
		const off3 = regen.setRegenerateTarget({
			command: (line) => {
				lines.push(line);
				return Promise.resolve({ ok: true, value: { matched: true } });
			},
			prompt: (content) => {
				prompts.push(content[0]?.text);
				return Promise.resolve({ ok: true });
			},
		});
		check(
			'命令可用时走命令（零 token），完全不惊动模型',
			(await regen.regenerate('一只肥鱼', { kind: 'image', ratio: '1:1' })) === 'command' &&
				lines.length === 1 &&
				prompts.length === 0,
			JSON.stringify(lines),
		);
		off3();

		const off4 = regen.setRegenerateTarget({
			command: () => Promise.resolve({ ok: true, value: { matched: false } }),
			prompt: () => Promise.resolve({ ok: true }),
		});
		check('命令未匹配（matched: false）时退回提示词', (await regen.regenerate('一只肥鱼')) === 'prompt');
		off4();

		const off5 = regen.setRegenerateTarget({
			command: () => Promise.reject(new Error('no commands service')),
			prompt: () => Promise.resolve({ ok: true }),
		});
		check('命令面抛错时退回提示词', (await regen.regenerate('一只肥鱼')) === 'prompt');
		off5();
	}
	storage.clear();
}

// ─────────────────── 7. P6：/generate 命令落到画布 ───────────────────

console.log('\n7) P6：/generate 命令 → 画布节点');

{
	await drainPersistTimers();
	storage.clear();
	const shared = new Map();
	const storePath = resolve(root, 'src/client/canvas/store.ts');
	const store = await loadTsModule(storePath, shared);
	const ingest = await loadTsModule(resolve(root, 'src/client/canvas/ingest.ts'), shared);

	/** 造一个命令节点。 */
	const commandNode = (over = {}) => ({
		kind: 'command',
		seq: 10,
		time: Date.now(),
		commandId: 'cmd-1',
		name: 'generate',
		args: '--ratio 16:9 一只胖乎乎的肥鱼',
		outcome: null,
		...over,
	});
	const snap = (nodes) => ({ runningCalls: [], nodes });

	// ── 7.1 正在执行的命令 → pending 节点 ──
	let report = ingest.syncConversation(snap([commandNode()]), 'sess-1', {
		baselineSeq: 0,
		now: Date.now(),
	});
	let board = store.getBoard();
	check('命令执行中先落一个 pending 节点', board.nodes.length === 1 && report.created === 1, JSON.stringify(report));
	const pending = board.nodes[0];
	check('命令节点 id 用独立前缀（不与工具节点撞车）', pending.id === 'gencmd_cmd-1', String(pending.id));
	check('状态是 pending', pending.status === 'pending', pending.status);
	check('提示词来自命令行原文（同一套语法）', pending.title === '一只胖乎乎的肥鱼', String(pending.title));
	check('比例也来自命令行（16:9 → 320×180）', pending.w === 320 && pending.h === 180, `${String(pending.w)}x${String(pending.h)}`);
	check('带上会话 id', pending.sessionId === 'sess-1', String(pending.sessionId));

	// ── 7.2 成功结果 → ready ──
	const before = { x: pending.x, y: pending.y };
	ingest.syncConversation(
		snap([
			commandNode({
				outcome: { kind: 'success', text: 'https://cdn.example.com/a.png\n图像 · m · 16:9' },
			}),
		]),
		'sess-1',
		{ baselineSeq: 0, now: Date.now() },
	);
	board = store.getBoard();
	const ready = board.nodes.find((n) => n.id === 'gencmd_cmd-1');
	check('命令成功后节点转为 ready', ready?.status === 'ready', String(ready?.status));
	check('媒体地址取自结果文本的第一行', ready?.src === 'https://cdn.example.com/a.png', String(ready?.src));
	check(
		'状态变更不移动节点（与工具路径同一条规则）',
		ready?.x === before.x && ready?.y === before.y,
		`${JSON.stringify(before)} -> ${JSON.stringify({ x: ready?.x, y: ready?.y })}`,
	);
	check(
		'重复快照不再产生变更（幂等）',
		(() => {
			const again = ingest.syncConversation(
				snap([commandNode({ outcome: { kind: 'success', text: 'https://cdn.example.com/a.png' } })]),
				'sess-1',
				{ baselineSeq: 0, now: Date.now() },
			);
			return again.created === 0 && again.resolved === 0;
		})(),
	);

	// ── 7.3 失败结果 → failed（原因是命令给的那段文字） ──
	ingest.syncConversation(
		snap([
			commandNode({
				commandId: 'cmd-2',
				args: '会失败的鱼',
				outcome: { kind: 'error', text: '图像供应商都还没有配置 API 密钥。\n用法：…' },
			}),
		]),
		'sess-1',
		{ baselineSeq: 0, now: Date.now() },
	);
	board = store.getBoard();
	const failedNode = board.nodes.find((n) => n.id === 'gencmd_cmd-2');
	check('命令失败 → failed 节点', failedNode?.status === 'failed', String(failedNode?.status));
	check(
		'失败原因就是命令给的那段文本',
		String(failedNode?.error).includes('API 密钥'),
		String(failedNode?.error),
	);
	check('失败节点也能直接落地（页面在命令执行中才打开）', board.nodes.length === 2, `实际 ${String(board.nodes.length)}`);

	// ── 7.4 成功但文本里没有地址 → 判失败，而不是落一个空节点 ──
	ingest.syncConversation(
		snap([commandNode({ commandId: 'cmd-3', args: '怪鱼', outcome: { kind: 'success', text: '已生成（但没有地址）' } })]),
		'sess-1',
		{ baselineSeq: 0, now: Date.now() },
	);
	const odd = store.getBoard().nodes.find((n) => n.id === 'gencmd_cmd-3');
	check(
		'命令"成功"但拿不到地址 → 按失败处理（不落一个永远加载不出来的节点）',
		odd?.status === 'failed' && String(odd?.error).includes('媒体地址'),
		`${String(odd?.status)} / ${String(odd?.error)}`,
	);

	// ── 7.5 认不出名字的命令节点要忽略 ──
	check(
		'name 缺失（窗口截断）的命令节点被忽略',
		(() => {
			const before2 = store.getBoard().nodes.length;
			ingest.syncConversation(
				snap([commandNode({ commandId: 'cmd-x', name: null, outcome: { kind: 'success', text: 'https://x/y.png' } })]),
				'sess-1',
				{ baselineSeq: 0, now: Date.now() },
			);
			return store.getBoard().nodes.length === before2;
		})(),
	);
	check(
		'别人的命令节点被忽略',
		(() => {
			const before2 = store.getBoard().nodes.length;
			ingest.syncConversation(
				snap([commandNode({ commandId: 'cmd-y', name: 'compact', outcome: { kind: 'success', text: 'ok' } })]),
				'sess-1',
				{ baselineSeq: 0, now: Date.now() },
			);
			return store.getBoard().nodes.length === before2;
		})(),
	);

	// ── 7.6 新鲜度：历史命令不重放 ──
	check(
		'很旧的命令结果不落图（同一个新鲜度规则）',
		(() => {
			const before2 = store.getBoard().nodes.length;
			ingest.syncConversation(
				snap([
					commandNode({
						commandId: 'cmd-old',
						seq: 2,
						time: Date.now() - 60 * 60 * 1000,
						outcome: { kind: 'success', text: 'https://x/old.png' },
					}),
				]),
				'sess-9',
				{ baselineSeq: 99, now: Date.now() },
			);
			return store.getBoard().nodes.length === before2;
		})(),
	);

	// ── 7.7 删掉的命令节点不复活 ──
	store.removeNodes(['gencmd_cmd-1']);
	ingest.syncConversation(
		snap([commandNode({ outcome: { kind: 'success', text: 'https://cdn.example.com/a.png' } })]),
		'sess-1',
		{ baselineSeq: 0, now: Date.now() },
	);
	check(
		'删掉之后再同步同一命令不会复活（记账同样覆盖命令路径）',
		store.getBoard().nodes.every((n) => n.id !== 'gencmd_cmd-1'),
		JSON.stringify(store.getBoard().nodes.map((n) => n.id)),
	);

	// ── 7.8 工具与命令可以在同一次同步里共存 ──
	store.clearBoard();
	ingest.syncConversation(
		{
			runningCalls: [{ callId: 'call-9', name: 'media_generate', argsRaw: '{"prompt":"工具鱼"}' }],
			nodes: [commandNode({ commandId: 'cmd-9', args: '命令鱼', outcome: null })],
		},
		'sess-2',
		{ baselineSeq: 0, now: Date.now() },
	);
	board = store.getBoard();
	check(
		'同一次同步里，工具与命令各落一个节点且互不干扰',
		board.nodes.length === 2 &&
			board.nodes.some((n) => n.id === 'gen_call-9') &&
			board.nodes.some((n) => n.id === 'gencmd_cmd-9'),
		JSON.stringify(board.nodes.map((n) => n.id)),
	);
	check(
		'两个节点错开落位（不重叠）',
		board.nodes[0].x !== board.nodes[1].x || board.nodes[0].y !== board.nodes[1].y,
		JSON.stringify(board.nodes.map((n) => [n.x, n.y])),
	);
	storage.clear();
}

// ─────────────────── 8. P7：画布按会话隔离（作用域） ───────────────────

console.log('\n8) P7：画布按会话隔离');

{
	await drainPersistTimers();
	storage.clear();
	const shared = new Map();
	const storePath = resolve(root, 'src/client/canvas/store.ts');
	const statePath = resolve(root, 'src/client/state.ts');
	const scopePath = resolve(root, 'src/client/canvas/scope.ts');

	const store = await loadTsModule(storePath, shared);
	const state = await loadTsModule(statePath, shared);
	const scope = await loadTsModule(scopePath, shared);

	const GLOBAL = 'fatfish-canvas:board';
	const keyOf = (id) => `fatfish-canvas:board:${id}`;
	const nodeOf = (id, x = 0) => ({ id, kind: 'image', x, y: 0, w: 100, h: 100, status: 'ready' });

	check(
		'作用域 → 存储键：null 是共用那块，字符串是会话自己的键',
		store.boardKeyFor(null) === GLOBAL && store.boardKeyFor('session-a') === keyOf('session-a'),
		`${store.boardKeyFor(null)} / ${store.boardKeyFor('session-a')}`,
	);
	check(
		'默认作用域是共用（老用户升级后画布不会突然变空）',
		store.getBoardScope() === null && store.getBoardKey() === GLOBAL,
		String(store.getBoardScope()),
	);
	check(
		'作用域偏好默认 shared',
		state.getBoardScopeMode() === 'shared',
		state.getBoardScopeMode(),
	);

	// ── 8.1 换键：两边各自独立，切走再切回要还原 ──
	store.addNode(nodeOf('g1'));
	store.flushPersist();
	check(
		'共用画布落盘在全局键上',
		String(storage.get(GLOBAL)).includes('"g1"'),
		String(storage.get(GLOBAL)).slice(0, 80),
	);

	store.setBoardScope('s1');
	check(
		'切到 s1：画布是空的（不 adopt 时不抄旧画布）',
		store.getBoard().nodes.length === 0,
		`实际 ${String(store.getBoard().nodes.length)}`,
	);
	check('切换后当前键跟着换', store.getBoardKey() === keyOf('s1'), store.getBoardKey());
	store.addNode(nodeOf('a1'));
	store.flushPersist();

	store.setBoardScope(null);
	check(
		'切回共用：全局画布的节点还在（切换不丢东西）',
		store.getBoard().nodes.length === 1 && store.getBoard().nodes[0].id === 'g1',
		JSON.stringify(store.getBoard().nodes.map((n) => n.id)),
	);
	check(
		'两边的内容没有混：s1 的节点不在共用画布里',
		store.getBoard().nodes.every((n) => n.id !== 'a1'),
	);
	check(
		'切回来时共用画布被写回全局键（旧内容没被新内容顶掉）',
		String(storage.get(GLOBAL)).includes('"g1"'),
	);

	store.setBoardScope('s1');
	check(
		'切回 s1：它自己的节点也在',
		store.getBoard().nodes.length === 1 && store.getBoard().nodes[0].id === 'a1',
		JSON.stringify(store.getBoard().nodes.map((n) => n.id)),
	);

	// ── 8.2 记账账本随作用域独立（「不重放」的前提） ──
	check(
		's1 的账本里没有别的画布的记账',
		store.getBoard().ingested.length === 0,
		JSON.stringify(store.getBoard().ingested),
	);
	store.markIngested(['gen_a1']);
	store.flushPersist();
	store.setBoardScope(null);
	check(
		'切回共用后记账互不影响',
		store.getBoard().ingested.length === 0,
		JSON.stringify(store.getBoard().ingested),
	);
	store.markIngested(['gen_g1']);
	store.flushPersist();
	store.setBoardScope('s1');
	check(
		'再切回 s1：它自己的记账还在（因此历史生成不会被重放）',
		JSON.stringify(store.getBoard().ingested) === '["gen_a1"]',
		JSON.stringify(store.getBoard().ingested),
	);

	// ── 8.3 选择集是瞬时状态，不跨画布 ──
	store.addNode(nodeOf('a2', 200));
	store.setSelection(['a1']);
	store.setBoardScope(null);
	check(
		'换画布时选择集清空（旧选择指向的节点已经不在这块画布上）',
		store.getBoard().selection.length === 0,
		JSON.stringify(store.getBoard().selection),
	);

	// ── 8.4 adopt：从共用切进隔离时，手上的画布跟着走 ──
	await drainPersistTimers();
	storage.clear();
	const store2 = await loadTsModule(storePath); // 新实例：键与内存都从零开始
	store2.addNode(nodeOf('keep'));
	store2.markIngested(['gen_keep']);
	store2.flushPersist();
	store2.setBoardScope('s9', { adopt: true });
	check(
		'adopt：新键为空时把当前画布带进新作用域（不会当场变空）',
		store2.getBoard().nodes.length === 1 && store2.getBoard().nodes[0].id === 'keep',
		JSON.stringify(store2.getBoard().nodes.map((n) => n.id)),
	);
	check(
		'adopt 顺带把记账也带过去（否则刚落的节点会被历史重放）',
		store2.getBoard().ingested.includes('gen_keep'),
		JSON.stringify(store2.getBoard().ingested),
	);
	check(
		'adopt 之后新键立刻有内容（不必等下一次提交）',
		String(storage.get(keyOf('s9'))).includes('"keep"'),
	);
	check(
		'adopt 时旧键仍然保留原样（共用画布没被搬走）',
		String(storage.get(GLOBAL)).includes('"keep"'),
	);

	// ── 8.5 adopt 绝不覆盖已经存在的作用域 ──
	storage.set(
		keyOf('s7'),
		JSON.stringify({
			version: 2,
			nodes: [{ id: 'mine', kind: 'image', x: 5, y: 5, w: 20, h: 20, z: 1, status: 'ready', createdAt: 1 }],
			viewport: { x: 0, y: 0, zoom: 1 },
			ingested: [],
		}),
	);
	store2.setBoardScope('s7', { adopt: true });
	check(
		'adopt 只对「从没写过的键」生效：已有内容的会话画布不被顶掉',
		store2.getBoard().nodes.length === 1 && store2.getBoard().nodes[0].id === 'mine',
		JSON.stringify(store2.getBoard().nodes.map((n) => n.id)),
	);
	storage.clear();
}

{
	// ── 8.6 策略层：偏好 × 当前会话 → 作用域 ──
	await drainPersistTimers();
	storage.clear();
	const shared = new Map();
	const storePath = resolve(root, 'src/client/canvas/store.ts');
	const statePath = resolve(root, 'src/client/state.ts');
	const scopePath = resolve(root, 'src/client/canvas/scope.ts');

	const store = await loadTsModule(storePath, shared);
	const state = await loadTsModule(statePath, shared);
	const scope = await loadTsModule(scopePath, shared);
	const off = scope.installBoardScope();

	const nodeOf = (id) => ({ id, kind: 'image', x: 0, y: 0, w: 100, h: 100, status: 'ready' });
	const keyOf = (id) => `fatfish-canvas:board:${id}`;

	// 共用偏好下，报来会话 id 也不换画布
	scope.setScopeSession('sess-a');
	check(
		'偏好是共用时：会话 id 不改变作用域',
		store.getBoardScope() === null && scope.getScopeSnapshot().sessionId === 'sess-a',
		JSON.stringify(scope.getScopeSnapshot()),
	);

	// 打开隔离：立刻换到当前会话的画布，并把手上这块带过去
	store.addNode(nodeOf('shared-node'));
	store.flushPersist();
	state.setBoardScopeMode('session');
	check(
		'翻开关立刻生效（偏好变化经订阅自动应用）',
		store.getBoardScope() === 'sess-a' && store.getBoardKey() === keyOf('sess-a'),
		`${String(store.getBoardScope())} / ${store.getBoardKey()}`,
	);
	check(
		'从共用切进隔离：当前画布被采用（用户看不到「画布突然空了」）',
		store.getBoard().nodes.some((n) => n.id === 'shared-node'),
		JSON.stringify(store.getBoard().nodes.map((n) => n.id)),
	);
	check(
		'偏好写进 localStorage',
		storage.get('fatfish-canvas:board-scope') === 'session',
		String(storage.get('fatfish-canvas:board-scope')),
	);
	check(
		'作用域快照：scope 不再是 null（视图据此显示「本会话画布」）',
		scope.getScopeSnapshot().scope === 'sess-a',
		JSON.stringify(scope.getScopeSnapshot()),
	);

	// 会话 A → 会话 B：不抄送
	store.removeNodes(store.getBoard().nodes.map((n) => n.id));
	store.addNode(nodeOf('a-node'));
	store.flushPersist();
	scope.setScopeSession('sess-b');
	check(
		'切到另一个会话：拿到的是它自己的（空）画布，**不会**抄走上一个会话的节点',
		store.getBoard().nodes.length === 0,
		JSON.stringify(store.getBoard().nodes.map((n) => n.id)),
	);
	store.addNode(nodeOf('b-node'));
	store.flushPersist();
	scope.setScopeSession('sess-a');
	check(
		'切回第一个会话：它自己的节点还在',
		store.getBoard().nodes.length === 1 && store.getBoard().nodes[0].id === 'a-node',
		JSON.stringify(store.getBoard().nodes.map((n) => n.id)),
	);
	check(
		'会话 B 的画布也各自持久化着',
		String(storage.get(keyOf('sess-b'))).includes('"b-node"'),
		String(storage.get(keyOf('sess-b'))).slice(0, 80),
	);

	// 关掉隔离：回到共用那块
	state.setBoardScopeMode('shared');
	check(
		'关掉隔离：回到共用画布（内容还是原来那块）',
		store.getBoardScope() === null &&
			store.getBoard().nodes.length === 1 &&
			store.getBoard().nodes[0].id === 'shared-node',
		JSON.stringify(store.getBoard().nodes.map((n) => n.id)),
	);

	// 没有会话时退回共用，而不是记着一块不存在的画布
	state.setBoardScopeMode('session');
	scope.setScopeSession(null);
	check(
		'打开隔离但没有会话：退回共用（scope 为 null，视图显示「待会话」）',
		scope.getScopeSnapshot().mode === 'session' &&
			scope.getScopeSnapshot().scope === null &&
			store.getBoardScope() === null,
		JSON.stringify(scope.getScopeSnapshot()),
	);

	check(
		'重复应用是幂等的（偏好 store 每次变化都会叫醒它）',
		scope.applyBoardScope() === false && scope.applyBoardScope() === false,
	);

	// ── 8.7 启动时按存储的偏好恢复 ──
	off();
	await drainPersistTimers();
	storage.clear();
	storage.set('fatfish-canvas:board-scope', 'session');
	const state2 = await loadTsModule(statePath);
	const scope2 = await loadTsModule(scopePath, new Map([[statePath, { exports: state2 }]]));
	check(
		'启动读到 session 偏好',
		state2.getBoardScopeMode() === 'session',
		state2.getBoardScopeMode(),
	);
	check(
		'重启时还没有会话 → 先停在共用画布上，不炸也不清空',
		scope2.getScopeSnapshot().scope === null && scope2.applyBoardScope() === false,
		JSON.stringify(scope2.getScopeSnapshot()),
	);
	storage.clear();
}

// ─────────── 8b. P25：会话画布的回收（删会话不删画布 → 键会堆到配额满） ───────────

console.log('\n8b) P25：会话画布回收');

{
	storage.clear();
	// 预置：共用画布、作用域偏好（**绝不能被当成一块画布**）、活着的与已删的会话各一块
	const board = JSON.stringify({ version: 3, nodes: [], links: [], viewport: { x: 0, y: 0, zoom: 1 }, ingested: [] });
	storage.set('fatfish-canvas:board', board);
	storage.set('fatfish-canvas:board-scope', 'session');
	storage.set('fatfish-canvas:board:session-alive', board);
	storage.set('fatfish-canvas:board:session-dead', board);

	const shared = new Map();
	const storePath = resolve(root, 'src/client/canvas/store.ts');
	const statePath = resolve(root, 'src/client/state.ts');
	const scopePath = resolve(root, 'src/client/canvas/scope.ts');
	const store = await loadTsModule(storePath, shared);
	const stateBase = await loadTsModule(statePath, shared);
	const scope = await loadTsModule(scopePath, shared);

	/** 会话列表替身（真实形状：`{ current, ids?, phase? }`，见 ambient 的声明）。 */
	const makeList = (snapshot) => {
		let current = snapshot;
		const listeners = new Set();
		return {
			getSnapshot: () => current,
			subscribe: (fn) => {
				listeners.add(fn);
				return () => listeners.delete(fn);
			},
			push: (next) => {
				current = next;
				for (const fn of listeners) fn();
			},
		};
	};

	/** 用最小 ctx 把回收装起来（`inject` → 作用域 ctx，`effect` → 跑一次并留着清理）。 */
	const install = (list) => {
		scope.installBoardGc({
			inject: (deps, callback) => {
				callback({
					sessions: { list },
					effect: (fn) => {
						void fn();
					},
				});
			},
		});
	};

	// ── 纯判定：什么时候**允许**删 ──
	check(
		'列表还没就绪（phase=pending）→ 不允许回收（宁可不删）',
		scope.prunableSessions({ current: undefined, ids: ['a'], phase: 'pending' }) === null,
	);
	check(
		'就绪但没有 id 全表（老宿主）→ 不允许回收',
		scope.prunableSessions({ current: 'a', phase: 'ready' }) === null,
	);
	const alive = scope.prunableSessions({ current: 'c', ids: [], phase: 'ready' });
	check(
		'就绪 + 空表 = 真的没有会话；但当前选中的那个仍然算活着',
		alive instanceof Set && alive.size === 1 && alive.has('c'),
		JSON.stringify([...(alive ?? [])]),
	);
	check('就绪时拿到的是完整存活表', [...(scope.prunableSessions({ current: undefined, ids: ['a', 'b'], phase: 'ready' }) ?? [])].join(',') === 'a,b');

	// ── 键的筛选：§8.17 那个坑（前缀是另一个键的前缀） ──
	const keep = new Set(['fatfish-canvas:board']);
	const picked = scope.orphanBoardKeys(
		['fatfish-canvas:board', 'fatfish-canvas:board-scope', 'fatfish-canvas:board:a', 'fatfish-canvas:board:', '别的键'],
		new Set(['a']),
		keep,
	);
	check(
		'共用画布、作用域偏好、活着的会话、空 id、别人的键 —— 一个都不挑',
		picked.length === 0,
		JSON.stringify(picked),
	);
	const picked2 = scope.orphanBoardKeys(['fatfish-canvas:board:b'], new Set(['a']), keep);
	check('已死会话那块被挑出来', JSON.stringify(picked2) === '["fatfish-canvas:board:b"]', JSON.stringify(picked2));

	// ── 装上去跑：pending 不删、ready 才删 ──
	const list = makeList({ current: undefined, ids: ['session-alive'], phase: 'pending' });
	install(list);
	check('装上时列表还在 pending：一个键都不删', storage.has('fatfish-canvas:board:session-dead'));
	list.push({ current: undefined, ids: ['session-alive'], phase: 'ready' });
	check('列表就绪 → 删掉宿主已经不认识的会话那块画布', !storage.has('fatfish-canvas:board:session-dead'));
	check('还活着的会话的画布留着', storage.has('fatfish-canvas:board:session-alive'));
	check('共用那块画布留着', storage.has('fatfish-canvas:board'));
	check(
		'作用域偏好键（fatfish-canvas:board-scope）绝不能被当成一块画布删掉',
		storage.get('fatfish-canvas:board-scope') === 'session',
		String(storage.get('fatfish-canvas:board-scope')),
	);

	// ── 当前正在看的那块画布：即使列表里还没有它，也必须留着 ──
	storage.set('fatfish-canvas:board:session-current', board);
	store.setBoardScope('session-current');
	scope.setScopeSession('session-current');
	list.push({ current: undefined, ids: ['session-alive'], phase: 'ready' });
	check(
		'当前生效的那块画布绝不删（列表刷新的一瞬间它可能还没列出来）',
		storage.has('fatfish-canvas:board:session-current'),
	);
	check('它不在 ids 里也照样留着（靠 getBoardKey + 桥告知的会话）', storage.has('fatfish-canvas:board:session-current'));

	// ── ids 缺席：什么都不删 ──
	storage.set('fatfish-canvas:board:session-orphan', board);
	const list2 = makeList({ current: 'session-x', phase: 'ready' });
	install(list2);
	check('宿主没给全表时什么都不删（宁可留着键，也不赌）', storage.has('fatfish-canvas:board:session-orphan'));

	storage.clear();
}

// ───────────── 9. P15：交互修复（点击意图 / 拖放接管 / 缩放上限） ─────────────

console.log('\n9) P15：点击意图 · 拖放接管 · 1000% 缩放');

{
	// ── 9.1 缩放上限必须是 1000%（用户要求；旧值 400% 是瓶颈） ──
	const model2 = await loadTsModule(resolve(root, 'src/client/canvas/model.ts'));
	check('ZOOM_MAX 是 10（= 1000%）', model2.ZOOM_MAX === 10, String(model2.ZOOM_MAX));
	check(
		'clampZoom 允许放到 1000%',
		model2.clampZoom(25) === 10 && model2.clampZoom(10) === 10,
		String(model2.clampZoom(25)),
	);
	check(
		'clampZoom 仍夹住下界（10%）与非法值',
		model2.clampZoom(0.01) === model2.ZOOM_MIN,
		String(model2.clampZoom(0.01)),
	);
	// 缩放到 1000% 时锚点下的世界坐标仍不能漂（沿用第 1 节的不变量）
	const vpHigh = model2.zoomAround({ x: 0, y: 0, zoom: 1 }, { x: 100, y: 50 }, 10);
	const before = model2.toWorld({ x: 100, y: 50 }, { x: 0, y: 0, zoom: 1 });
	const after = model2.toWorld({ x: 100, y: 50 }, vpHigh);
	check(
		'放大到 1000% 时锚点下的世界坐标不动',
		Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9,
		`${JSON.stringify(before)} → ${JSON.stringify(after)}`,
	);

	// ── 9.2 点击图片的意图：只有「光标在输入框里」才发送 ──
	const click = await loadTsModule(resolve(root, 'src/client/canvas/clickintent.ts'));
	check(
		'输入框聚焦 + 有图片地址 → 送进聊天框',
		click.nodeClickIntent({ mediaUrl: 'https://x/y.png', composerFocused: true }).kind ===
			'send-to-composer',
	);
	check(
		'输入框没聚焦 → 照常选中/拖动（不抢手势）',
		click.nodeClickIntent({ mediaUrl: 'https://x/y.png', composerFocused: false }).kind === 'select',
	);
	check(
		'没有媒体地址（pending/failed/文字节点）→ 退回选中，不做无声的「发送」',
		click.nodeClickIntent({ mediaUrl: null, composerFocused: true }).kind === 'select' &&
			click.nodeClickIntent({ mediaUrl: '', composerFocused: true }).kind === 'select',
	);

	// ── 9.3 拖放接管：落在画布上才拦，且**不能**拦聊天输入区 ──
	const drop = await loadTsModule(resolve(root, 'src/client/canvas/dropfiles.ts'));
	check('拖到画布上 → 由画布接管', drop.shouldClaimDrop(true) === true);
	check(
		'拖到聊天区 → 原样交给本体附件通路（这是最怕写反的一条）',
		drop.shouldClaimDrop(false) === false,
	);
	check(
		'落在聊天输入区（视觉上压在画布上面）时画布必须放行 —— 否则「图片存成附件」的合成 drop 会被自己的捕获闸拦死',
		drop.shouldClaimDrop(true, true) === false && drop.shouldClaimDrop(true, false) === true,
	);

	// ── 9.4 存成附件：data URL → File → 合成 drop 交给本体的附件管线 ──
	//
	// 这是「点画布图片 → 聊天框里出现真正的图片附件」的核心一步。用替身 DOM 验
	// 三件必须成立的事：事件**冒泡到 document**（本体监听在那儿）、
	// `dataTransfer.types` 含 `Files`（本体用它过滤）、里面确实是那张图。
	{
		class StubElement {
			constructor(tag) {
				this.tagName = String(tag).toUpperCase();
				this.children = [];
				this.parent = null;
				this.isContentEditable = false;
				this.dispatched = [];
			}
			getBoundingClientRect() {
				return { x: 0, y: 0, width: 100, height: 30, top: 0, left: 0, right: 100, bottom: 30 };
			}
			closest(sel) {
				// 只需要认 [class*="composer"]
				let cur = this;
				while (cur !== null) {
					const cls = String(cur.className ?? '');
					if (sel.includes('composer') && cls.includes('composer')) return cur;
					cur = cur.parent;
				}
				return null;
			}
			/** 模拟冒泡：沿 parent 链把事件交给每一层（并记下经过的元素）。 */
			dispatchEvent(event) {
				let cur = this;
				while (cur !== null) {
					cur.dispatched.push(event);
					cur = cur.parent;
				}
				return true;
			}
			focus() {}
		}
		globalThis.HTMLElement = StubElement;
		globalThis.HTMLTextAreaElement = class extends StubElement {};
		globalThis.HTMLInputElement = class extends StubElement {};
		globalThis.DataTransfer = class {
			constructor() {
				this.files = [];
				/** 真 Chrome 里 `items.add(file)` 之后 types 就含 'Files'。 */
				this.types = {
					includes: (t) => t === 'Files' && this.files.length > 0,
				};
				this.items = {
					add: (file) => {
						this.files.push(file);
					},
				};
			}
		};
		globalThis.DragEvent = class {
			constructor(type, init) {
				this.type = type;
				this.dataTransfer = init?.dataTransfer;
				this.bubbles = init?.bubbles;
			}
		};
		globalThis.File = class {
			constructor(parts, name, opts) {
				this.parts = parts;
				this.name = name;
				this.type = opts?.type;
				this.size = parts.reduce((sum, p) => sum + (p.length ?? p.byteLength ?? 0), 0);
			}
		};
		globalThis.atob = (b64) => Buffer.from(b64, 'base64').toString('binary');

		const composerHost = new StubElement('div');
		composerHost.className = 'abc_composer';
		const editor = new StubElement('div');
		editor.isContentEditable = true;
		editor.parent = composerHost;
		// document 顶层：本体的附件监听就在这里，所以「冒泡到 document」必须成立
		const docRoot = new StubElement('div');
		composerHost.parent = docRoot;
		globalThis.document = {
			activeElement: editor,
			execCommand: () => false,
			querySelectorAll: () => [editor],
		};

		const dom = await loadTsModule(resolve(root, 'src/client/dom.ts'));
		check('composer 聚焦判定认得 contenteditable', dom.isComposerFocused() === true);

		const tiny = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
		const outcome = dom.attachImageToComposer(tiny, 'board.png');
		const dropped = editor.dispatched[0];
		const file = dropped?.dataTransfer?.files?.[0];
		check(
			'data URL → 合成 drop，且**冒泡到文档根**（本体的附件监听挂在 document 上）',
			outcome.kind === 'attached' &&
				dropped?.type === 'drop' &&
				dropped.bubbles === true &&
				docRoot.dispatched.includes(dropped),
			JSON.stringify({ outcome, reachedDocument: dropped !== undefined && docRoot.dispatched.includes(dropped) }),
		);
		check(
			'dataTransfer 声明了 Files 类型（本体靠它过滤，缺了就静默丢弃）',
			dropped?.dataTransfer?.types?.includes('Files') === true,
		);
		check(
			'dataTransfer 里带的是真正的图片 File（名字 / MIME / 字节都对）',
			file !== undefined &&
				file.name === 'board.png' &&
				file.type === 'image/png' &&
				// 字节数由 base64 长度推出来，别写死数字：换一张样例图就漂
				file.size === Buffer.from(tiny.slice(tiny.indexOf(',') + 1), 'base64').length,
			file === undefined ? '没有 File' : `${file.name} ${file.type} ${String(file.size)}B`,
		);
		check(
			'非图片 data URL 不冒充附件',
			dom.attachImageToComposer('data:text/plain;base64,aGk=', 'x.txt').kind === 'failed',
		);
		check('找不到输入框时如实失败（不静默）', (() => {
			globalThis.document = { activeElement: null, execCommand: () => false, querySelectorAll: () => [] };
			return dom.attachImageToComposer(tiny, 'x.png').kind === 'failed';
		})());
	}
}

// ───────── 10. P16：外部 store 的订阅必须真的能触发重渲染 ─────────
//
// 为什么单独立一节：真实环境里 `useSyncExternalStore` **不触发重渲染**，
// 组件只在首帧读一次快照 —— 画布面板在聊天模式那次渲染里返回 `null`，
// 之后永远不重渲染，于是「点米饭碗进画布」只剩一个空面板（用户报的黑屏），
// 米饭碗自己的 aria-label 也永远停在「进入肥鱼画布」。
// 现在改成 `useState` + `useEffect` 订阅。这一节用**自写的 hook 替身**把语义钉死：
// 首帧读快照 → store 变化时订阅回调把新值交给 setState。

console.log('\n10) P16：store 订阅（useState + useEffect 路径）');

{
	/** 组件「已挂载」标志：模拟 React 的生命周期，卸载后不许再 setState。 */
	let mounted = true;
	/** 极简 hook 替身：只保留「state + 订阅回调」这两件事。 */
	const makeHooks = () => {
		const states = [];
		const inited = [];
		const cleanups = [];
		let slot = 0;
		return {
			/** 一次「渲染」开始。 */
			begin: () => {
				slot = 0;
			},
			useState: (initial) => {
				const i = slot++;
				// ⚠️ 只在**首次**挂载时用 initial；之后必须返回缓存值 ——
				// 否则「取消订阅后仍读 store」会让下面的断言失去意义
				// （初始值本身是个会读 store 的函数，等于每次渲染都重新取值）。
				if (inited[i] !== true) {
					states[i] = typeof initial === 'function' ? initial() : initial;
					inited[i] = true;
				}
				return [states[i], (next) => {
					// 真实 React 在卸载后调 setState 是 no-op（这里照此建模，
					// 才能断言「清理函数确实跑过」）
					if (!mounted) return;
					states[i] = typeof next === 'function' ? next(states[i]) : next;
				}];
			},
			useEffect: (fn) => {
				const i = slot++;
				const off = fn();
				if (typeof off === 'function') cleanups[i] = off;
			},
			/**
			 * 模拟 React 卸载：跑掉所有 effect 的清理函数（同时把 mounted 置假，
			 * 之后的 setState 一律 no-op —— 与真实 React 一致）。
			 */
			dispose: () => {
				mounted = false;
				for (const off of cleanups) if (typeof off === 'function') off();
			},
			/** 已挂载标志（卸载后 setState 是 no-op，照真实 React 建模）。 */
			isMounted: () => mounted,
		};
	};

	const hooks = makeHooks();
	const reactStub = {
		...BARE_STUBS.react,
		useState: hooks.useState,
		useEffect: hooks.useEffect,
		useSyncExternalStore: () => {
			throw new Error('不应再使用 useSyncExternalStore');
		},
	};
	const stubsWithHooks = { ...BARE_STUBS, react: reactStub };

	storage.clear();
	storage.set('fatfish-canvas:view-mode', 'chat');
	// state.ts 的 setMode → applyToDocument() 会碰 DOM，这里给最小替身
	globalThis.document = {
		documentElement: { style: { setProperty() {}, removeProperty() {} } },
		body: { dataset: {} },
		querySelector: () => null,
		querySelectorAll: () => [],
	};
	const stateWithHooks = await loadTsModule(resolve(root, 'src/client/state.ts'), new Map(), stubsWithHooks);

	// ① 首帧就该读到快照（不必等 effect —— 否则会先闪一帧错的状态）
	hooks.begin();
	const first = stateWithHooks.useViewMode();

	// ② 挂上 effect（订阅），再改 store：订阅回调把新值交给 setState
	hooks.begin();
	stateWithHooks.useViewMode();
	stateWithHooks.toggleCanvasMode();
	hooks.begin();
	const afterChange = stateWithHooks.useViewMode();
	check(
		'首帧直接读快照，且 store 变化后重渲染能拿到新值（chat → canvas）',
		first === 'chat' && stateWithHooks.getMode() === 'canvas' && afterChange === 'canvas',
		`首帧=${String(first)} 变化后=${String(afterChange)}`,
	);

	// ③ 取消订阅后再改 store：卸载后 setState 必须是 no-op
	//    （subscribe 返回的清理函数由 effect 返回，dispose 会跑掉它）
	hooks.dispose();
	stateWithHooks.toggleCanvasMode();
	check(
		'取消订阅后不再更新组件（卸载后 setState 是 no-op），但 store 自己照常变',
		hooks.isMounted() === false && stateWithHooks.getMode() === 'chat',
		`mounted=${String(hooks.isMounted())} store=${String(stateWithHooks.getMode())}`,
	);

	// ④ DOM 通道：模式优先直接读 body 属性（React 订阅失效时的兜底事实源）
	globalThis.document.body.dataset.ffcMode = 'canvas';
	check(
		'getModeFromDom 优先读 body[data-ffc-mode]',
		stateWithHooks.getModeFromDom() === 'canvas',
		stateWithHooks.getModeFromDom(),
	);
	globalThis.document.body.dataset.ffcMode = '  ';
	check(
		'body 属性不可信时退回模块状态（不返回空字符串）',
		stateWithHooks.getModeFromDom() === 'chat',
		stateWithHooks.getModeFromDom(),
	);
	storage.clear();
}

// ─────────── 11. P18：连接点几何 / 图规则 / 连线的持久化 ───────────

console.log('\n11) 连接点与连线（P18）');

{
	const ports = await loadTsModule(resolve(root, 'src/client/canvas/ports.ts'));
	const rect = { x: 100, y: 200, w: 300, h: 100 };

	check(
		'四条边的中点',
		JSON.stringify([
			ports.portPoint(rect, 'n'),
			ports.portPoint(rect, 's'),
			ports.portPoint(rect, 'w'),
			ports.portPoint(rect, 'e'),
		]) ===
			JSON.stringify([
				{ x: 250, y: 200 },
				{ x: 250, y: 300 },
				{ x: 100, y: 250 },
				{ x: 400, y: 250 },
			]),
	);
	check(
		'外法线朝外',
		ports.portNormal('n').y === -1 &&
			ports.portNormal('s').y === 1 &&
			ports.portNormal('w').x === -1 &&
			ports.portNormal('e').x === 1,
	);
	check('nearestPort 取最近的边', ports.nearestPort(rect, { x: 395, y: 245 }) === 'e');
	check('nearestPort 贴近上边中点时取 n', ports.nearestPort(rect, { x: 250, y: 203 }) === 'n');
	check(
		'nearestPort 在左上角附近取的是左（不是上）—— 按距离，不按象限',
		ports.nearestPort(rect, { x: 101, y: 201 }) === 'w',
	);

	const path = ports.linkPath({ x: 0, y: 0 }, 'e', { x: 200, y: 0 }, 'w');
	check('linkPath 起点终点就是两个连接点', path.startsWith('M 0 0 C ') && path.endsWith('200 0'), path);
	check('linkPath 可重复（同输入同输出）', ports.linkPath({ x: 0, y: 0 }, 'e', { x: 200, y: 0 }, 'w') === path);
	{
		// 控制点必须落在**各自那条边的外法线**上：e 边 → y 不变且向右；w 边 → y 不变且向左。
		// 这是「线从面上长出去、不斜穿自己卡片」的全部保证。
		const d = ports.linkPath({ x: 0, y: 0 }, 'e', { x: 200, y: 100 }, 'w');
		const numbers = d.match(/-?\d+(?:\.\d+)?/g).map(Number);
		const [, , c1x, c1y, c2x, c2y] = numbers;
		check(
			'控制点沿外法线外推（e 向右、w 向左）',
			c1y === 0 && c1x > 0 && c2y === 100 && c2x < 200,
			d,
		);
	}
	check(
		'linkMidpoint 取直线中点',
		JSON.stringify(ports.linkMidpoint({ x: 0, y: 0 }, { x: 10, y: 20 })) ===
			JSON.stringify({ x: 5, y: 10 }),
	);
}

{
	const graph = await loadTsModule(resolve(root, 'src/client/canvas/graph.ts'));
	const node = (id, kind, extra = {}) => ({
		id,
		kind,
		x: 0,
		y: 0,
		w: 100,
		h: 100,
		z: 0,
		status: 'ready',
		createdAt: 0,
		...extra,
	});
	const nodes = [
		node('t1', 'text', { prompt: '一只柴犬' }),
		node('t2', 'text', { prompt: '油画风格' }),
		node('t0', 'text', { prompt: '   ' }),
		node('img', 'image', { src: 'https://x/a.png' }),
		node('img2', 'image', { src: 'https://x/b.png' }),
		node('blob', 'image', { src: 'blob:http://x/y' }),
		node('pending', 'image', { status: 'pending' }),
		node('failed', 'image', { status: 'failed' }),
		node('gen', 'gen'),
		node('gen2', 'gen'),
	];
	const reason = (from, to, links = []) => {
		const result = graph.canLink(nodes, links, from, to);
		return result.ok ? 'OK' : result.reason;
	};

	check('连到自己被拒', reason('gen', 'gen') === '不能连到自己');
	check('只有生成节点接受输入', reason('t1', 'img').includes('生成节点'));
	check('没出过图的生成节点不能当上游', reason('gen', 'gen2').includes('还没有图'), reason('gen', 'gen2'));
	check('文字 → 生成 合法', reason('t1', 'gen') === 'OK');
	check('空文字节点被拒', reason('t0', 'gen').includes('空的'));
	check('图片 → 生成 合法', reason('img', 'gen') === 'OK');
	check('blob 地址不能当参考图', reason('blob', 'gen').includes('地址不能当参考图'));
	check('生成中的图不能当参考图', reason('pending', 'gen').includes('还在生成中'));
	check('失败的图不能当参考图', reason('failed', 'gen').includes('失败'));
	check(
		'重复连线被拒',
		reason('t1', 'gen', [{ id: 'l1', from: 't1', to: 'gen', fromSide: 'e', toSide: 'w' }]).includes(
			'已经连过',
		),
	);
	check(
		'只允许一张参考图',
		reason('img2', 'gen', [
			{ id: 'l1', from: 'img', to: 'gen', fromSide: 'e', toSide: 'w' },
		]).includes('只支持一张参考图'),
	);
	check(
		'多段文字可以都连上',
		reason('t2', 'gen', [{ id: 'l1', from: 't1', to: 'gen', fromSide: 'e', toSide: 'w' }]) === 'OK',
	);

	const links = [
		{ id: 'l1', from: 't1', to: 'gen', fromSide: 'e', toSide: 'w' },
		{ id: 'l2', from: 'img', to: 'gen', fromSide: 'e', toSide: 'w' },
		{ id: 'l3', from: 't2', to: 'gen', fromSide: 'e', toSide: 'w' },
	];
	const inputs = graph.inputsOf('gen', nodes, links);
	check('inputsOf 取到参考图', inputs.reference !== null && inputs.reference.id === 'img');
	check(
		'inputsOf 的提示词按连线顺序',
		JSON.stringify(inputs.prompts) === JSON.stringify(['一只柴犬', '油画风格']),
		JSON.stringify(inputs.prompts),
	);
	check(
		'promptOf 拼接连线提示词',
		graph.promptOf(inputs) === '一只柴犬\n油画风格',
		graph.promptOf(inputs),
	);
	check('promptOf 不会重复自己带的提示词', graph.promptOf(inputs, '一只柴犬') === '一只柴犬\n油画风格');
	check('没有输入时 promptOf 是空串', graph.promptOf({ reference: null, prompts: [] }) === '');
}

{
	// 连线进 store：增删 / 级联 / 持久化 / 悬空剔除 / 旧数据兼容
	const store = await freshStore();
	const a = store.addNode({ kind: 'text', x: 0, y: 0, w: 100, h: 60, status: 'ready', prompt: '一只柴犬' });
	const b = store.addNode({ kind: 'gen', x: 200, y: 0, w: 100, h: 100, status: 'ready' });
	const link = store.addLinks([{ from: a.id, to: b.id, fromSide: 'e', toSide: 'w' }]);
	check('addLinks 入列', store.getBoard().links.length === 1 && typeof link[0].id === 'string');
	check('addLinks 不改动节点', store.getBoard().nodes.length === 2);
	check('useLinks 读到的是同一份', store.getBoard().links[0].from === a.id);

	store.removeLinks([link[0].id]);
	check('removeLinks 删除', store.getBoard().links.length === 0);
	store.removeLinks(['不存在']);
	check('removeLinks 无匹配时不提交', store.getBoard().links.length === 0);

	store.addLinks([{ from: a.id, to: b.id, fromSide: 'e', toSide: 'w' }]);
	store.removeNodes([a.id]);
	check('删节点级联删连线', store.getBoard().links.length === 0, String(store.getBoard().links.length));

	// 持久化往返（含 gen 节点 —— KINDS 白名单漏了它就会被静默降级成 image）
	const c = store.addNode({ kind: 'text', x: 0, y: 0, w: 100, h: 60, status: 'ready', prompt: '油画' });
	store.addLinks([{ from: c.id, to: b.id, fromSide: 'e', toSide: 'w' }]);
	store.flushPersist();
	const raw = store.readPersistedRaw();
	const parsed = JSON.parse(raw);
	check('持久化格式版本升到 3', parsed.version === 3, String(parsed.version));
	check('持久化里有 links', Array.isArray(parsed.links) && parsed.links.length === 1);

	storage.clear();
	storage.set('fatfish-canvas:board', raw);
	const reloaded = await loadTsModule(resolve(root, 'src/client/canvas/store.ts'));
	check('重载后连线复原', reloaded.getBoard().links.length === 1);
	check(
		'重载后 gen 节点没有降级成 image',
		reloaded.getBoard().nodes.find((n) => n.id === b.id).kind === 'gen',
		reloaded.getBoard().nodes.find((n) => n.id === b.id).kind,
	);
	check(
		'重载后连接点方位复原',
		reloaded.getBoard().links[0].fromSide === 'e' && reloaded.getBoard().links[0].toSide === 'w',
	);

	// 悬空连线（端点被删/被手工改坏）必须在读取时剔除
	const broken = JSON.parse(raw);
	broken.links.push({ id: 'l_ghost', from: c.id, to: '不存在', fromSide: 'e', toSide: 'w' });
	broken.links.push({ id: 'l_bad', from: c.id, to: b.id, fromSide: 'x', toSide: 'w' });
	broken.links.push({ id: '', from: c.id, to: b.id, fromSide: 'e', toSide: 'w' });
	storage.clear();
	storage.set('fatfish-canvas:board', JSON.stringify(broken));
	const cleaned = await loadTsModule(resolve(root, 'src/client/canvas/store.ts'));
	check(
		'悬空 / 坏方位的连线被剔除',
		cleaned.getBoard().links.length === 1,
		JSON.stringify(cleaned.getBoard().links),
	);

	// v2 的旧数据（没有 links 字段）必须照旧能载入
	const legacy = JSON.parse(raw);
	delete legacy.links;
	legacy.version = 2;
	storage.clear();
	storage.set('fatfish-canvas:board', JSON.stringify(legacy));
	const fromV2 = await loadTsModule(resolve(root, 'src/client/canvas/store.ts'));
	check('v2 旧数据载入后 links 为空表', fromV2.getBoard().links.length === 0);
	check('v2 旧数据的节点仍在', fromV2.getBoard().nodes.length === 2);
	storage.clear();
}

// ─────────── 12. P18：工作流（命令行标记 / 运行 / 结果回填） ───────────

console.log('\n12) 工作流：运行与结果回填');

{
	await drainPersistTimers();
	storage.clear();
	const shared = new Map();
	const storePath = resolve(root, 'src/client/canvas/store.ts');
	const store = await loadTsModule(storePath, shared);
	const ingest = await loadTsModule(resolve(root, 'src/client/canvas/ingest.ts'), shared);
	const media = await loadTsModule(resolve(root, 'src/client/shared/media.ts'), shared);
	const regen = await loadTsModule(resolve(root, 'src/client/canvas/regenerate.ts'), shared);
	const run = await loadTsModule(resolve(root, 'src/client/canvas/run.ts'), shared);
	const graph = await loadTsModule(resolve(root, 'src/client/canvas/graph.ts'), shared);

	// ── 12.1 命令行里的 --wf ──
	const parsed = media.parseGenerateLine('--ratio 1:1 --wf n_abc 一只柴犬');
	check('--wf 被解析出来', parsed.ok && parsed.args.wf === 'n_abc', JSON.stringify(parsed));
	check(
		'--wf 不写进用法说明（它是画布内部参数）',
		!media.GENERATE_USAGE.includes('--wf'),
	);
	check(
		'不带 --wf 时 wf 是 undefined',
		media.parseGenerateLine('一只柴犬').args.wf === undefined,
	);

	// ── 12.2 运行计划 ──
	const text = store.addNode({ kind: 'text', x: 0, y: 0, w: 100, h: 60, status: 'ready', prompt: '一只柴犬' });
	const img = store.addNode({ kind: 'image', x: 0, y: 200, w: 100, h: 100, status: 'ready', src: 'https://x/ref.png' });
	const gen = store.addNode({ kind: 'gen', x: 300, y: 0, w: 280, h: 280, status: 'ready', title: '生成节点' });
	store.addLinks([
		{ from: text.id, to: gen.id, fromSide: 'e', toSide: 'w' },
		{ from: img.id, to: gen.id, fromSide: 'e', toSide: 'w' },
	]);

	let board = store.getBoard();
	check(
		'topoOrder 只取生成节点',
		graph.topoOrder(board.nodes, board.links)
			.map((n) => n.id)
			.join() === gen.id,
	);

	const plan = run.planOf(gen, board.nodes, board.links);
	check(
		'运行计划带上提示词、参考图与 --wf',
		plan.ok &&
			plan.line.includes('一只柴犬') &&
			plan.line.includes('--ref https://x/ref.png') &&
			plan.line.includes(`--wf ${gen.id}`),
		plan.ok ? plan.line : plan.reason,
	);
	check(
		'没有提示词时给得出原因（而不是发一次注定失败的生成）',
		(() => {
			const bare = run.planOf(
				{ id: 'g2', kind: 'gen', x: 0, y: 0, w: 10, h: 10, z: 0, status: 'ready', createdAt: 0 },
				board.nodes,
				board.links,
			);
			return !bare.ok && bare.reason.includes('提示词');
		})(),
	);

	// ── 12.3 运行：命令真的发出去，节点先变 pending ──
	const lines = [];
	const off = regen.setRegenerateTarget({
		prompt: async () => ({}),
		command: async (line) => {
			lines.push(line);
			return { ok: true, value: { matched: true } };
		},
	});
	const report = await run.runWorkflow(board.nodes, board.links);
	check(
		'runWorkflow 发出了命令并带上 --wf',
		report.started === 1 && lines.length === 1 && lines[0].includes(`--wf ${gen.id}`),
		JSON.stringify({ report, lines }),
	);
	check(
		'发出去之前节点先变 pending（等待期间看得见在画什么）',
		store.getBoard().nodes.find((n) => n.id === gen.id).status === 'pending',
	);
	check('runWorkflow 的报告能说成人话', run.describeRun(report) === '已运行 1 个生成节点', run.describeRun(report));
	off();

	// ── 12.4 结果回填到生成节点（而不是另落一张散图） ──
	const commandNode = (over) => ({
		kind: 'command',
		seq: 10,
		time: Date.now(),
		commandId: 'wf-1',
		name: 'generate',
		args: `--wf ${gen.id} 一只柴犬`,
		outcome: null,
		...over,
	});
	const snap = (nodes) => ({ runningCalls: [], nodes });

	ingest.syncConversation(snap([commandNode({})]), 'sess-1', { baselineSeq: 0, now: Date.now() });
	board = store.getBoard();
	check('工作流运行中：生成节点是 pending', board.nodes.find((n) => n.id === gen.id)?.status === 'pending');
	check('工作流运行中：没有多落 gencmd 节点', board.nodes.length === 3, String(board.nodes.length));

	ingest.syncConversation(
		snap([commandNode({ outcome: { kind: 'success', text: 'https://cdn.example.com/wf.png\n图像' } })]),
		'sess-1',
		{ baselineSeq: 0, now: Date.now() },
	);
	board = store.getBoard();
	const filled = board.nodes.find((n) => n.id === gen.id);
	check(
		'结果回填到生成节点自己身上',
		filled?.status === 'ready' && filled?.src === 'https://cdn.example.com/wf.png',
		`${String(filled?.status)} / ${String(filled?.src)}`,
	);
	check('回填后仍然没有 gencmd 节点', board.nodes.length === 3, String(board.nodes.length));
	check(
		'提示词也一起回填（工作流重载后还知道当时画的是什么）',
		filled?.prompt === '一只柴犬',
		String(filled?.prompt),
	);
	check(
		'回填是幂等的（同一条结果重放不再改动）',
		(() => {
			const again = ingest.syncConversation(
				snap([commandNode({ outcome: { kind: 'success', text: 'https://cdn.example.com/wf.png' } })]),
				'sess-1',
				{ baselineSeq: 0, now: Date.now() },
			);
			return again.created === 0 && again.resolved === 0;
		})(),
	);

	// 12.4b 旧命令重放不得把「刚点的运行」顶掉（真机手测抓到的真 bug）
	//
	// 为什么单独立一条：上面那条幂等断言在「节点字段与结果一致」时也成立（走的是
	// `sameFields` 短路），而 bug 只在用户**又点了一次运行**、节点已经 pending 时
	// 露出来 —— 旧命令还在 10 分钟新鲜期内，于是每一次同步都把 ready + 旧产物重新
	// 盖回去：pending 一次都看不见，界面弹回旧图与旧提示词。
	store.updateNodes([gen.id], { status: 'pending', prompt: '再画一张' });
	const beforeReplay = store.getBoard().nodes.find((n) => n.id === gen.id);
	ingest.syncConversation(
		snap([commandNode({ outcome: { kind: 'success', text: 'https://cdn.example.com/wf.png\n图像' } })]),
		'sess-1',
		{ baselineSeq: 0, now: Date.now() },
	);
	const afterReplay = store.getBoard().nodes.find((n) => n.id === gen.id);
	check(
		'旧命令重放不会把刚点的「运行」顶掉（仍 pending 且提示词是新的）',
		beforeReplay?.status === 'pending' &&
			afterReplay?.status === 'pending' &&
			afterReplay?.prompt === '再画一张',
		JSON.stringify({ 前: beforeReplay?.status, 后: afterReplay?.status, 提示词: afterReplay?.prompt }),
	);

	// ── 12.5 目标节点被删掉 → 退回普通落图（结果不丢） ──
	store.removeNodes([gen.id]);
	ingest.syncConversation(
		snap([
			{
				...commandNode({ commandId: 'wf-2', args: `--wf ${gen.id} 另一张` }),
				outcome: { kind: 'success', text: 'https://cdn.example.com/orphan.png' },
			},
		]),
		'sess-1',
		{ baselineSeq: 0, now: Date.now() },
	);
	check(
		'目标节点不存在时退回普通落图（结果不丢）',
		store.getBoard().nodes.some((n) => n.id === 'gencmd_wf-2'),
		JSON.stringify(store.getBoard().nodes.map((n) => n.id)),
	);
	storage.clear();
}

// ─────────── 13. P18：PNG 元数据 + 工作流文档（导出/还原的往返） ───────────

console.log('\n13) PNG 元数据与工作流文档');

{
	const png = await loadTsModule(resolve(root, 'src/client/canvas/pngmeta.ts'));
	const wf = await loadTsModule(resolve(root, 'src/client/canvas/workflow.ts'));

	// ── 13.1 造一个合成 PNG 当夹具 ──
	//
	// 只有块结构，IDAT 是空的 —— 被测的是「块的读写」，不是解码器。
	// 这里的 crc32 刻意**逐位**实现（被测模块用查表法），两条实现互相印证。
	const crc32 = (bytes) => {
		let c = 0xffffffff;
		for (const byte of bytes) {
			c ^= byte;
			for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
		}
		return (c ^ 0xffffffff) >>> 0;
	};
	const ascii = (text) => [...text].map((ch) => ch.charCodeAt(0));
	// 自查：CRC-32 的标准校验向量（"123456789" → 0xCBF43926）
	check('测试自带的 crc32 是标准 CRC-32', crc32(ascii('123456789')) === 0xcbf43926);
	const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
	const chunkOf = (type, data) => {
		const body = [...ascii(type), ...data];
		return [...u32(data.length), ...body, ...u32(crc32(body))];
	};
	const signature = [137, 80, 78, 71, 13, 10, 26, 10];
	// 1×1、8 位灰度、无隔行
	const ihdr = chunkOf('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0]);
	const iend = chunkOf('IEND', []);
	const fixture = new Uint8Array([...signature, ...ihdr, ...iend]);
	/** 列出 PNG 里的块类型（测试自己走一遍，不复用被测函数）。 */
	const chunkTypes = (bytes) => {
		const out = [];
		let at = 8;
		while (at + 8 <= bytes.length) {
			const len = (bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3];
			const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
			out.push(type);
			at += 12 + len;
			if (type === 'IEND') break;
		}
		return out;
	};

	check('夹具本身是合法 PNG 结构', chunkTypes(fixture).join() === 'IHDR,IEND');
	check('isPng 认得 PNG', png.isPng(fixture));
	check('isPng 不认别的格式', !png.isPng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])));
	check('没有 tEXt 时读到空表', Object.keys(png.readPngText(fixture)).length === 0);

	// ── 13.2 写 / 读往返 ──
	const written = png.writePngText(fixture, { workflow: '{"a":1}' });
	check('tEXt 插在 IHDR 之后', chunkTypes(written).join() === 'IHDR,tEXt,IEND', chunkTypes(written).join());
	check('IHDR 一个字节都没动', (() => {
		const a = fixture.subarray(0, 8 + ihdr.length);
		return a.every((value, i) => written[i] === value);
	})());
	check('读回来的就是写进去的', png.readPngText(written).workflow === '{"a":1}');
	check(
		'写出来的块 CRC 正确（与测试自己的逐位实现一致）',
		(() => {
			const len = (written[8] << 24) | (written[9] << 16) | (written[10] << 8) | written[11];
			const body = written.subarray(12, 16 + len);
			const stored =
				((written[16 + len] << 24) |
					(written[17 + len] << 16) |
					(written[18 + len] << 8) |
					written[19 + len]) >>>
				0;
			return stored === crc32(body);
		})(),
	);

	// ── 13.3 非 ASCII 转义（tEXt 是 Latin-1，中文必须转义） ──
	const chinese = '{"t":"柴犬 · 油画"}';
	const escaped = png.writePngText(fixture, { workflow: chinese });
	/** 取第一个 tEXt 块的数据字节（只看它是不是纯 ASCII —— 文件头里本来就有 0x89）。 */
	const textBytesOf = (bytes) => {
		let at = 8;
		while (at + 8 <= bytes.length) {
			const len = (bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3];
			const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
			if (type === 'tEXt') return bytes.subarray(at + 8, at + 8 + len);
			at += 12 + len;
		}
		return null;
	};
	check(
		'tEXt 块里是纯 ASCII（别的解码器也读得回来）',
		(() => {
			const data = textBytesOf(escaped);
			return data !== null && data.every((byte) => byte < 0x80);
		})(),
	);
	const rawText = png.readPngText(escaped).workflow;
	// 读出来仍是 `\u67f4` 这种转义形态 —— 这与 ComfyUI 的 json.dumps 完全一致：
	// 那一层解码是 JSON 的事，字节层不该擅自猜内容是什么格式。
	check('读回来的文本保持转义形态（与 ComfyUI 的 json.dumps 一致）', rawText.includes('\\u67f4'), rawText);
	check(
		'JSON.parse 之后与原文完全一致（中文无损）',
		JSON.stringify(JSON.parse(rawText)) === JSON.stringify(JSON.parse(chinese)),
	);

	// ── 13.4 同名键先删后写（否则改了工作流还原出来还是老的） ──
	const twice = png.writePngText(png.writePngText(fixture, { workflow: 'old' }), { workflow: 'new' });
	check('同名块只留一个', chunkTypes(twice).filter((t) => t === 'tEXt').length === 1);
	check('读到的是最后一次写的', png.readPngText(twice).workflow === 'new');
	check(
		'不是 PNG 时写元数据抛错（而不是写出一堆坏字节）',
		(() => {
			try {
				png.writePngText(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), { workflow: 'x' });
				return false;
			} catch {
				return true;
			}
		})(),
	);

	// ── 13.5 工作流文档 ──
	const boardNodes = [
		{ id: 't1', kind: 'text', x: 0, y: 0, w: 260, h: 120, z: 1, status: 'ready', createdAt: 1, prompt: '一只柴犬' },
		{ id: 'i1', kind: 'image', x: 0, y: 200, w: 200, h: 200, z: 2, status: 'ready', createdAt: 2, src: 'https://x/ref.png' },
		{ id: 'l1', kind: 'image', x: 300, y: 200, w: 200, h: 200, z: 3, status: 'ready', createdAt: 3, src: 'data:image/png;base64,AAAA' },
		{ id: 'g1', kind: 'gen', x: 320, y: 0, w: 280, h: 280, z: 4, status: 'ready', createdAt: 4, title: '生成节点' },
	];
	const boardLinks = [
		{ id: 'k1', from: 't1', to: 'g1', fromSide: 'e', toSide: 'w' },
		{ id: 'k2', from: 'i1', to: 'g1', fromSide: 'e', toSide: 'w' },
	];
	const text = wf.serializeWorkflow(boardNodes, boardLinks);
	const doc = wf.parseWorkflow(text);
	check('序列化 → 解析往返成功', doc !== null && doc.nodes.length === 4 && doc.links.length === 2);
	check(
		'http 地址进文档，data: 大图不进（否则文档会到兆级）',
		doc.nodes.find((n) => n.id === 'i1').src === 'https://x/ref.png' &&
			doc.nodes.find((n) => n.id === 'l1').src === undefined,
	);
	check('提示词进文档', doc.nodes.find((n) => n.id === 't1').prompt === '一只柴犬');
	check(
		'真 ComfyUI 的工作流认不出来（宁可明说，也不要猜着还原）',
		wf.parseWorkflow(JSON.stringify({ last_node_id: 3, nodes: [{ id: 1, type: 'KSampler' }] })) === null,
	);
	check('坏 JSON 返回 null', wf.parseWorkflow('{不是 json') === null);

	// ── 13.6 还原计划 ──
	const plan = wf.planRestore(doc, { x: 1000, y: 500 }, []);
	check('id 全部重映射（不与原 id 撞车）', plan.nodes.every((n) => !['t1', 'i1', 'g1'].includes(n.id)));
	check(
		'整体锚到落点（左上角对齐 1000,500）',
		Math.min(...plan.nodes.map((n) => n.x)) === 1000 && Math.min(...plan.nodes.map((n) => n.y)) === 500,
		JSON.stringify(plan.nodes.map((n) => [n.x, n.y])),
	);
	check('连线跟着重映射（端点都在新节点里）', (() => {
		const ids = new Set(plan.nodes.map((n) => n.id));
		return plan.links.length === 2 && plan.links.every((l) => ids.has(l.from) && ids.has(l.to));
	})());
	check(
		'还原出来一律 ready（上一次的失败状态不该跟着回来）',
		plan.nodes.every((n) => n.status === 'ready'),
	);

	const occupied = [{ id: 'x', kind: 'image', x: 1000, y: 500, w: 300, h: 300, z: 1, status: 'ready', createdAt: 1 }];
	const shifted = wf.planRestore(doc, { x: 1000, y: 500 }, occupied);
	check(
		'落点被占时整体让开（不与现有节点重叠）',
		Math.min(...shifted.nodes.map((n) => n.x)) > 1300,
		String(Math.min(...shifted.nodes.map((n) => n.x))),
	);

	// ── 13.7 端到端：画布 → PNG 字节 → 拖回来 → 还原 ──
	const exported = png.writePngText(fixture, { workflow: wf.serializeWorkflow(boardNodes, boardLinks) });
	const back = wf.parseWorkflow(png.readPngText(exported).workflow);
	const restored = wf.planRestore(back, { x: 0, y: 0 }, []);
	check(
		'端到端往返：节点种类与提示词都在',
		restored.nodes.length === 4 &&
			restored.nodes.some((n) => n.kind === 'gen') &&
			restored.nodes.some((n) => n.prompt === '一只柴犬'),
	);
	check('端到端往返：连线数量一致', restored.links.length === 2);
	check(
		'端到端往返：可复用的图片地址还在',
		restored.nodes.some((n) => n.src === 'https://x/ref.png'),
	);
}

// ─────────── 14. P19：生成节点串联（拓扑序 / 环 / 等上游） ───────────

console.log('\n14) 生成节点串联');

{
	await drainPersistTimers();
	storage.clear();
	const shared = new Map();
	const storePath = resolve(root, 'src/client/canvas/store.ts');
	const store = await loadTsModule(storePath, shared);
	const run = await loadTsModule(resolve(root, 'src/client/canvas/run.ts'), shared);
	const graph = await loadTsModule(resolve(root, 'src/client/canvas/graph.ts'), shared);
	const regen = await loadTsModule(resolve(root, 'src/client/canvas/regenerate.ts'), shared);

	// ── 14.1 连线规则：生成节点之间可以连，但不能成环 ──
	const ready = { id: 'a', kind: 'gen', x: 0, y: 0, w: 10, h: 10, z: 1, status: 'ready', createdAt: 0, src: 'https://x/a.png' };
	const pending = { id: 'b', kind: 'gen', x: 0, y: 0, w: 10, h: 10, z: 2, status: 'pending', createdAt: 0 };
	const empty = { id: 'c', kind: 'gen', x: 0, y: 0, w: 10, h: 10, z: 3, status: 'ready', createdAt: 0 };
	const nodes = [ready, pending, empty];
	const reason = (from, to, links = []) => {
		const result = graph.canLink(nodes, links, from, to);
		return result.ok ? 'OK' : result.reason;
	};
	check('出过图的生成节点可以当上游', reason('a', 'c') === 'OK');
	check('还在生成中的上游被拒', reason('b', 'c').includes('还在生成中'));
	check('没出过图的上游被拒', reason('c', 'a').includes('还没有图'));
	check(
		'会成环的连线被拒',
		reason('c', 'a', [{ id: 'l1', from: 'a', to: 'c', fromSide: 'e', toSide: 'w' }]).includes('环'),
	);
	check('自环也被拒（不能连到自己）', reason('a', 'a').includes('自己'));
	check('wouldCycle 认得出间接环', graph.wouldCycle(
		[
			{ id: 'l1', from: 'a', to: 'b', fromSide: 'e', toSide: 'w' },
			{ id: 'l2', from: 'b', to: 'c', fromSide: 'e', toSide: 'w' },
		],
		'c',
		'a',
	));
	check('wouldCycle 对无关节点返回 false', !graph.wouldCycle([], 'a', 'b'));

	// ── 14.2 拓扑序：上游在前，同层按视觉顺序 ──
	const chainNodes = [
		{ id: 'g3', kind: 'gen', x: 0, y: 400, w: 10, h: 10, z: 3, status: 'ready', createdAt: 0 },
		{ id: 'g1', kind: 'gen', x: 0, y: 0, w: 10, h: 10, z: 1, status: 'ready', createdAt: 0 },
		{ id: 'g2', kind: 'gen', x: 0, y: 200, w: 10, h: 10, z: 2, status: 'ready', createdAt: 0 },
		{ id: 't1', kind: 'text', x: 0, y: 0, w: 10, h: 10, z: 0, status: 'ready', createdAt: 0, prompt: 'x' },
	];
	const chainLinks = [
		{ id: 'k1', from: 'g1', to: 'g3', fromSide: 'e', toSide: 'w' },
		{ id: 'k2', from: 'g2', to: 'g3', fromSide: 'e', toSide: 'w' },
		{ id: 'k3', from: 't1', to: 'g1', fromSide: 'e', toSide: 'w' },
	];
	check(
		'topoOrder：上游在前，同层按视觉顺序',
		graph.topoOrder(chainNodes, chainLinks)
			.map((n) => n.id)
			.join() === 'g1,g2,g3',
		graph.topoOrder(chainNodes, chainLinks)
			.map((n) => n.id)
			.join(),
	);
	check(
		'topoOrder 遇到坏数据里的环也不卡死（剩下的按视觉顺序收尾）',
		graph.topoOrder(
			chainNodes,
			[
				{ id: 'k1', from: 'g1', to: 'g2', fromSide: 'e', toSide: 'w' },
				{ id: 'k2', from: 'g2', to: 'g1', fromSide: 'e', toSide: 'w' },
			],
		).length === 3,
	);

	// ── 14.3 等上游：订阅 store，不轮询 ──
	{
		const node = store.addNode({ kind: 'gen', x: 0, y: 0, w: 10, h: 10, status: 'pending' });
		const late = setTimeout(() => {
			store.updateNodes([node.id], { status: 'ready', src: 'https://x/late.png' });
		}, 20);
		const settled = await run.waitForSettled(node.id, 2000);
		clearTimeout(late);
		check(
			'waitForSettled 等到状态变化（订阅生效，不是等满超时）',
			settled !== null && settled.status === 'ready' && settled.src === 'https://x/late.png',
			JSON.stringify(settled),
		);
	}
	{
		const node = store.addNode({ kind: 'gen', x: 0, y: 0, w: 10, h: 10, status: 'pending' });
		const settled = await run.waitForSettled(node.id, 30);
		check('waitForSettled 超时返回 null（不无限挂住）', settled === null);
	}
	{
		const node = store.addNode({ kind: 'gen', x: 0, y: 0, w: 10, h: 10, status: 'ready' });
		const settled = await run.waitForSettled(node.id, 1000);
		check('已经稳定的节点立刻返回', settled !== null && settled.id === node.id);
	}

	// ── 14.4 串联执行：B 的命令行里出现 A 出的图 ──
	store.clearBoard();
	const textA = store.addNode({ kind: 'text', x: 0, y: 0, w: 100, h: 60, status: 'ready', prompt: '一只柴犬' });
	const genA = store.addNode({ kind: 'gen', x: 300, y: 0, w: 280, h: 280, status: 'ready' });
	const textB = store.addNode({ kind: 'text', x: 0, y: 400, w: 100, h: 60, status: 'ready', prompt: '改成油画' });
	const genB = store.addNode({ kind: 'gen', x: 300, y: 400, w: 280, h: 280, status: 'ready' });
	store.addLinks([
		{ from: textA.id, to: genA.id, fromSide: 'e', toSide: 'w' },
		{ from: genA.id, to: genB.id, fromSide: 'e', toSide: 'w' },
		{ from: textB.id, to: genB.id, fromSide: 'e', toSide: 'w' },
	]);

	const lines = [];
	const off = regen.setRegenerateTarget({
		prompt: async () => ({}),
		// 模拟宿主：命令结算时 ingest 会把结果回填到那个生成节点上
		command: async (line) => {
			lines.push(line);
			const id = /--wf (\S+)/.exec(line)?.[1] ?? '';
			store.updateNodes([id], { status: 'ready', src: `https://cdn.example.com/${id}.png` });
			return { ok: true, value: { matched: true } };
		},
	});
	const report = await run.runWorkflow(store.getBoard().nodes, store.getBoard().links);
	off();

	check('串联：两个生成节点都跑了', report.started === 2, JSON.stringify(report));
	check(
		'串联：顺序是上游在前',
		lines.length === 2 && lines[0].includes(`--wf ${genA.id}`),
		JSON.stringify(lines),
	);
	check(
		'串联：下游的参考图就是上游出的那张图',
		lines[1].includes(`--ref https://cdn.example.com/${genA.id}.png`),
		lines[1],
	);
	check(
		'串联：下游的提示词来自它自己连的文字节点',
		lines[1].includes('改成油画'),
		lines[1],
	);
	check(
		'串联：结果都回填到了各自的节点上',
		(() => {
			const board = store.getBoard();
			const a = board.nodes.find((n) => n.id === genA.id);
			const b = board.nodes.find((n) => n.id === genB.id);
			return a?.src === `https://cdn.example.com/${genA.id}.png` && b?.src === `https://cdn.example.com/${genB.id}.png`;
		})(),
	);

	// ── 14.5 上游失败 → 下游立刻判失败，不浪费一次生成 ──
	//
	// 注意：`failed` 的节点下一轮**会被重跑**（这是对的，用户可以修好配置再点一次），
	// 因此这里让替身把上游再次跑失败，而不是指望它停在原地。
	store.updateNodes([genB.id], { status: 'ready' });
	const lines2 = [];
	const off2 = regen.setRegenerateTarget({
		prompt: async () => ({}),
		command: async (line) => {
			lines2.push(line);
			const id = /--wf (\S+)/.exec(line)?.[1] ?? '';
			store.updateNodes([id], { status: 'failed', error: '供应商不可用' });
			return { ok: true, value: { matched: true } };
		},
	});
	const report2 = await run.runWorkflow(store.getBoard().nodes, store.getBoard().links);
	off2();
	const downstream = store.getBoard().nodes.find((n) => n.id === genB.id);
	check(
		'上游失败 → 下游判失败并写明原因',
		downstream?.status === 'failed' && String(downstream?.error).includes('上游节点没有出图'),
		`${String(downstream?.status)} / ${String(downstream?.error)}`,
	);
	check(
		'上游失败时下游一次生成都不发',
		lines2.length === 1 && lines2[0].includes(`--wf ${genA.id}`),
		JSON.stringify(lines2),
	);
	check('报告里记下了跳过的原因', report2.skipped.some((s) => s.id === genB.id), JSON.stringify(report2));

	storage.clear();
}

// ─────────── 15. P19：生成节点的参数（种类 / 画幅） ───────────

console.log('\n15) 生成节点参数');

{
	await drainPersistTimers();
	storage.clear();
	const shared = new Map();
	const storePath = resolve(root, 'src/client/canvas/store.ts');
	const store = await loadTsModule(storePath, shared);
	const run = await loadTsModule(resolve(root, 'src/client/canvas/run.ts'), shared);
	const model = await loadTsModule(resolve(root, 'src/client/canvas/model.ts'), shared);
	const wf = await loadTsModule(resolve(root, 'src/client/canvas/workflow.ts'), shared);
	const media = await loadTsModule(resolve(root, 'src/client/shared/media.ts'), shared);
	const regen = await loadTsModule(resolve(root, 'src/client/canvas/regenerate.ts'), shared);

	// ── 15.1 缺省与坏值 ──
	check('缺省是图像 · 1:1', model.genKindOf({}) === 'image' && model.genRatioOf({}) === '1:1');
	check('空白比例退回 1:1', model.genRatioOf({ ratio: '   ' }) === '1:1');
	check('未知种类退回图像', model.genKindOf({ genKind: 'hologram' }) === 'image');
	check(
		'视频参数没设时是 undefined（= 用管线默认值，与「0 秒」不是一回事）',
		model.genDurationOf({}) === undefined &&
			model.genDurationOf({ duration: 0 }) === undefined &&
			model.genDurationOf({ duration: -3 }) === undefined &&
			model.genResolutionOf({ resolution: '  ' }) === undefined,
	);
	check(
		'比例 / 清晰度清单只有一份（参数面板与命令行共用）',
		media.ASPECT_RATIOS.join() === '1:1,16:9,4:3,3:4,9:16' &&
			media.VIDEO_RESOLUTIONS.join() === '480p,1080p' &&
			media.VIDEO_DURATIONS.join() === '4,5,8,10',
	);

	// ── 15.2 参数真的进了命令行 ──
	const text = store.addNode({ kind: 'text', x: 0, y: 0, w: 100, h: 60, status: 'ready', prompt: '一只柴犬' });
	const gen = store.addNode({
		kind: 'gen',
		x: 300,
		y: 0,
		w: 320,
		h: 180,
		status: 'ready',
		genKind: 'video',
		ratio: '16:9',
	});
	store.addLinks([{ from: text.id, to: gen.id, fromSide: 'e', toSide: 'w' }]);
	// 视频时长 / 清晰度也一起设上（改完要**重新读**节点：`gen` 是改之前那份快照）
	store.updateNodes([gen.id], { duration: 5, resolution: '1080p' });
	const genNow = store.getBoard().nodes.find((n) => n.id === gen.id);

	const plan = run.planOf(genNow, store.getBoard().nodes, store.getBoard().links);
	check(
		'视频 + 16:9 + 时长 + 清晰度都进了命令行',
		plan.ok &&
			plan.line.includes('--video') &&
			plan.line.includes('--ratio 16:9') &&
			plan.line.includes('--duration 5') &&
			plan.line.includes('--resolution 1080p'),
		plan.ok ? plan.line : plan.reason,
	);
	check(
		'缺省参数的节点发的是图像命令（不带 --video / --duration）',
		(() => {
			const plain = store.addNode({ kind: 'gen', x: 0, y: 300, w: 280, h: 280, status: 'ready' });
			store.addLinks([{ from: text.id, to: plain.id, fromSide: 'e', toSide: 'w' }]);
			const p = run.planOf(plain, store.getBoard().nodes, store.getBoard().links);
			return (
				p.ok &&
				!p.line.includes('--video') &&
				!p.line.includes('--duration') &&
				p.line.includes('--ratio 1:1')
			);
		})(),
	);
	check(
		'图像节点即使带着 duration 也不发它（参数面板根本不给图像显示这两个）',
		(() => {
			const mixed = store.addNode({
				kind: 'gen',
				x: 0,
				y: 600,
				w: 280,
				h: 280,
				status: 'ready',
				genKind: 'image',
				duration: 8,
				resolution: '480p',
			});
			store.addLinks([{ from: text.id, to: mixed.id, fromSide: 'e', toSide: 'w' }]);
			const p = run.planOf(mixed, store.getBoard().nodes, store.getBoard().links);
			return p.ok && !p.line.includes('--duration') && !p.line.includes('--resolution');
		})(),
	);

	// ── 15.3 参数进持久化 ──
	store.flushPersist();
	const raw = JSON.parse(store.readPersistedRaw());
	const stored = raw.nodes.find((n) => n.id === gen.id);
	check(
		'genKind / ratio / duration / resolution 都写进了持久化',
		stored.genKind === 'video' &&
			stored.ratio === '16:9' &&
			stored.duration === 5 &&
			stored.resolution === '1080p',
		JSON.stringify([stored.genKind, stored.ratio, stored.duration, stored.resolution]),
	);

	// ── 15.4 参数进工作流文档（还原之后还是那个参数） ──
	const doc = wf.parseWorkflow(wf.serializeWorkflow(store.getBoard().nodes, store.getBoard().links));
	const docGen = doc.nodes.find((n) => n.id === gen.id);
	check(
		'工作流文档带上生成节点参数',
		docGen.genKind === 'video' &&
			docGen.ratio === '16:9' &&
			docGen.duration === 5 &&
			docGen.resolution === '1080p',
		JSON.stringify([docGen.genKind, docGen.ratio, docGen.duration, docGen.resolution]),
	);
	const restored = wf.planRestore(doc, { x: 0, y: 0 }, []);
	const restoredGen = restored.nodes.find((n) => n.kind === 'gen' && n.genKind === 'video');
	check(
		'还原计划保留参数',
		restoredGen !== undefined &&
			restoredGen.ratio === '16:9' &&
			restoredGen.duration === 5 &&
			restoredGen.resolution === '1080p',
		JSON.stringify(restored.nodes.filter((n) => n.kind === 'gen')),
	);

	// ── 15.5 「运行此节点」：只跑这一个，不重跑上游 ──
	{
		const lines = [];
		const off = regen.setRegenerateTarget({
			prompt: async () => ({}),
			command: async (line) => {
				lines.push(line);
				const id = /--wf (\S+)/.exec(line)?.[1] ?? '';
				store.updateNodes([id], { status: 'ready', src: `https://cdn.example.com/${id}.png` });
				return { ok: true, value: { matched: true } };
			},
		});
		const report = await run.runSingleNode(gen.id);
		off();
		check(
			'运行此节点：只发一次命令，且是这一个节点',
			report.started === 1 && lines.length === 1 && lines[0].includes(`--wf ${gen.id}`),
			JSON.stringify({ report, lines }),
		);

		// 下游的上游「就绪但没图」（例如刚还原出来的工作流）→ 明确说清楚，不发命令
		const down = store.addNode({ kind: 'gen', x: 900, y: 0, w: 280, h: 280, status: 'ready' });
		const empty = store.addNode({ kind: 'gen', x: 600, y: 0, w: 280, h: 280, status: 'ready' });
		store.addLinks([
			{ from: text.id, to: down.id, fromSide: 'e', toSide: 'w' },
			{ from: empty.id, to: down.id, fromSide: 'e', toSide: 'w' },
		]);
		const lines2 = [];
		const off2 = regen.setRegenerateTarget({
			prompt: async () => ({}),
			command: async (line) => {
				lines2.push(line);
				return { ok: true, value: { matched: true } };
			},
		});
		const report2 = await run.runSingleNode(down.id);
		off2();
		check(
			'上游没出图时明确拒绝（而不是发一次注定失败的生成）',
			report2.started === 0 &&
				lines2.length === 0 &&
				String(store.getBoard().nodes.find((n) => n.id === down.id)?.error).includes(
					'上游节点还没有出图',
				),
			JSON.stringify({ report2, lines2 }),
		);

		const missing = await run.runSingleNode('不存在');
		check(
			'节点不存在时给得出原因',
			missing.started === 0 && missing.skipped[0]?.reason === '节点不存在',
			JSON.stringify(missing),
		);
	}

	// ── 15.6 坏参数在读取时被丢掉（不让荒唐值进命令行） ──
	const broken = JSON.parse(store.readPersistedRaw());
	const target = broken.nodes.find((n) => n.id === gen.id);
	target.genKind = 'hologram';
	target.ratio = '42:1';
	target.duration = -5;
	target.resolution = '8k';
	storage.clear();
	storage.set('fatfish-canvas:board', JSON.stringify(broken));
	const reloaded = await loadTsModule(storePath);
	const back = reloaded.getBoard().nodes.find((n) => n.id === gen.id);
	check(
		'坏参数读取时被丢掉（退回缺省）',
		back.genKind === undefined &&
			back.ratio === undefined &&
			back.duration === undefined &&
			back.resolution === undefined,
		JSON.stringify([back.genKind, back.ratio, back.duration, back.resolution]),
	);
	storage.clear();
}

// ─────────── 16. P22：本地图当参考图（宿主句柄 ref） ───────────

console.log('\n16) 本地图当参考图（ref 句柄）');

{
	await drainPersistTimers();
	storage.clear();
	const shared = new Map();
	const storePath = resolve(root, 'src/client/canvas/store.ts');
	const store = await loadTsModule(storePath, shared);
	const graph = await loadTsModule(resolve(root, 'src/client/canvas/graph.ts'), shared);
	const run = await loadTsModule(resolve(root, 'src/client/canvas/run.ts'), shared);
	const wf = await loadTsModule(resolve(root, 'src/client/canvas/workflow.ts'), shared);
	const media = await loadTsModule(resolve(root, 'src/client/shared/media.ts'), shared);

	// 一张「本地拖进来」的图：整张图的 data URL（远超命令行能带的 8192 字符）
	const bigDataUrl = `data:image/png;base64,${'A'.repeat(20000)}`;
	const node = (id, extra = {}) => ({
		id,
		kind: 'image',
		x: 0,
		y: 0,
		w: 100,
		h: 100,
		z: 1,
		status: 'ready',
		createdAt: 0,
		...extra,
	});
	const gen = node('gen', { kind: 'gen' });
	const local = node('local', { src: bigDataUrl });
	const hosted = node('hosted', { src: bigDataUrl, ref: 'C:\\tmp\\attachments\\abc.png' });
	const remote = node('remote', { src: 'https://cdn.example/a.png' });
	const reason = (from) => {
		const result = graph.canLink([from, gen], [], from.id, gen.id);
		return result.ok ? 'OK' : result.reason;
	};

	check('没有句柄的内联大图连不上（命令行塞不下）', reason(local).includes('没能存成参考图'), reason(local));
	check(
		'提示里说清下一步（另存成文件再拖 / 改用 http 地址），不是只报「地址不行」',
		reason(local).includes('拖进画布') && reason(local).includes('http'),
		reason(local),
	);
	check('拿到宿主句柄之后就能连了', reason(hosted) === 'OK', reason(hosted));
	check('http 地址的图一直都能连', reason(remote) === 'OK');

	// 连线被拒时客户端要当场补存句柄（CanvasStage），判据必须与提示那条分支同源：
	// 写歪了就是「说着要补存、实际不补」，或反过来「能连的图被拖去存一遍」。
	check(
		'needsReferenceHandle 只对「内联大图且没句柄」成立',
		graph.needsReferenceHandle(local) === true &&
			graph.needsReferenceHandle(hosted) === false &&
			graph.needsReferenceHandle(remote) === false &&
			graph.needsReferenceHandle(node('small', { src: 'data:image/png;base64,AAAA' })) === false &&
			graph.needsReferenceHandle(node('empty')) === false,
		JSON.stringify([local, hosted, remote].map((n) => graph.needsReferenceHandle(n))),
	);
	check('拿到宿主句柄之后就能连了', reason(hosted) === 'OK', reason(hosted));
	check('http 地址的图一直都能连', reason(remote) === 'OK');

	check(
		'referenceHandleOf 优先用 ref',
		run.referenceHandleOf(hosted) === 'C:\\tmp\\attachments\\abc.png',
		String(run.referenceHandleOf(hosted)),
	);
	check('没有 ref 时退回 src', run.referenceHandleOf(remote) === 'https://cdn.example/a.png');
	check('没有参考图时是 undefined', run.referenceHandleOf(null) === undefined);
	check(
		'ref 是空串时也退回 src',
		run.referenceHandleOf({ src: 'https://x/a.png', ref: '' }) === 'https://x/a.png',
	);

	// ── 命令行里真的带的是句柄 ──
	{
		const text = store.addNode({ kind: 'text', x: 0, y: 0, w: 100, h: 60, status: 'ready', prompt: '一只柴犬' });
		const refNode = store.addNode({
			kind: 'image',
			x: 0,
			y: 200,
			w: 100,
			h: 100,
			status: 'ready',
			src: bigDataUrl,
			ref: 'C:\\tmp\\attachments\\abc.png',
		});
		const target = store.addNode({ kind: 'gen', x: 300, y: 0, w: 280, h: 280, status: 'ready' });
		store.addLinks([
			{ from: text.id, to: target.id, fromSide: 'e', toSide: 'w' },
			{ from: refNode.id, to: target.id, fromSide: 'e', toSide: 'w' },
		]);
		const plan = run.planOf(target, store.getBoard().nodes, store.getBoard().links);
		check(
			'命令行里的 --ref 是宿主句柄（不是那张几万字符的 data URL）',
			plan.ok && plan.line.includes('--ref C:\\tmp\\attachments\\abc.png') && !plan.line.includes('AAAA'),
			plan.ok ? plan.line : plan.reason,
		);
		check('命令行长度是可控的（这才是整件事的目的）', plan.ok && plan.line.length < 300, String(plan.ok ? plan.line.length : -1));

		// ── 持久化与工作流文档都要带上它 ──
		store.flushPersist();
		const raw = JSON.parse(store.readPersistedRaw());
		check(
			'ref 写进了持久化（刷新后不用重存）',
			raw.nodes.some((n) => n.ref === 'C:\\tmp\\attachments\\abc.png'),
			JSON.stringify(raw.nodes.map((n) => n.ref)),
		);

		const doc = wf.parseWorkflow(wf.serializeWorkflow(store.getBoard().nodes, store.getBoard().links));
		check(
			'ref 进工作流文档（还原出来的工作流能复用同一张本地图）',
			doc.nodes.some((n) => n.ref === 'C:\\tmp\\attachments\\abc.png'),
			JSON.stringify(doc.nodes.map((n) => n.ref)),
		);
		const restored = wf.planRestore(doc, { x: 0, y: 0 }, []);
		check('还原计划保留 ref', restored.nodes.some((n) => n.ref === 'C:\\tmp\\attachments\\abc.png'));
		check(
			'文档里没有把那张 data URL 也存进去（src 仍然只留 http）',
			doc.nodes.every((n) => n.src === undefined || !n.src.startsWith('data:')),
			JSON.stringify(doc.nodes.map((n) => n.src)),
		);

		// 空串 / 非字符串的 ref 在读取时被丢掉
		const broken = JSON.parse(store.readPersistedRaw());
		broken.nodes[0].ref = '';
		broken.nodes[1].ref = 42;
		storage.clear();
		storage.set('fatfish-canvas:board', JSON.stringify(broken));
		const reloaded = await loadTsModule(storePath);
		check(
			'坏 ref 在读取时被丢掉（不让空句柄进命令行）',
			reloaded.getBoard().nodes.every((n) => n.ref === undefined || n.ref !== ''),
			JSON.stringify(reloaded.getBoard().nodes.map((n) => n.ref)),
		);
	}

	check(
		'REFERENCE_MAX_INLINE 仍然卡在 8192（句柄机制是绕开它，不是放开它）',
		media.REFERENCE_MAX_INLINE === 8192,
		String(media.REFERENCE_MAX_INLINE),
	);

	// ── 16.2 落图之后请宿主存句柄（dropfiles 的接线） ──
	{
		const drop = await loadTsModule(resolve(root, 'src/client/canvas/dropfiles.ts'), shared);
		const notice = await loadTsModule(resolve(root, 'src/client/canvas/notice.ts'), shared);
		store.clearBoard();
		const local = store.addNode({ kind: 'image', x: 0, y: 0, w: 10, h: 10, status: 'ready', src: bigDataUrl });
		const remote = store.addNode({
			kind: 'image',
			x: 0,
			y: 0,
			w: 10,
			h: 10,
			status: 'ready',
			src: 'https://cdn.example/a.png',
		});
		const seen = [];
		// ⚠️ 这个替身站的是**远程面**，所以回包必须是信封 `{ok,value}` ——
		// 网关（dsh-api-gateway 的 invoke）就是这么包的。替身要是直接回宿主的结果对象，
		// 「忘了拆信封」这个真 bug 就永远测不出来（实测栽过一次）。
		const off = drop.setReferenceStore(() => ({
			storeReference: async (dataUrl) => {
				seen.push(dataUrl);
				return {
					ok: true,
					value: { ok: true, message: '已存为参考图（12 KB）', ref: 'C:\\tmp\\attachments\\abc.png' },
				};
			},
		}));
		await drop.attachReferenceHandles([local.id, remote.id]);
		off();
		check(
			'内联图会请宿主存句柄，http 地址不会（本来就够短）',
			seen.length === 1 && seen[0] === bigDataUrl,
			JSON.stringify(seen.map((s) => s.slice(0, 20))),
		);
		check(
			'存好了要回一句「没报错」（连线那边据此决定要不要再补一句判定理由）',
			(await drop.attachReferenceHandles([local.id])) === false,
		);
		check(
			'探测面还没就绪时不报错也不记账（连线那一刻会再试一次）',
			(await (async () => {
				const off0 = drop.setReferenceStore(() => undefined);
				const wrote = await drop.attachReferenceHandles([local.id]);
				off0();
				return wrote;
			})()) === false,
		);
		check(
			'存好之后句柄写回节点',
			store.getBoard().nodes.find((n) => n.id === local.id)?.ref === 'C:\\tmp\\attachments\\abc.png',
			String(store.getBoard().nodes.find((n) => n.id === local.id)?.ref),
		);
		// 连线那边存完句柄要**立刻**能连上：判据只能读 store，不能读渲染快照
		// （boardRef 要等下一次渲染才更新，拿它判就是「存成功了却报没存成」，实测踩到）。
		{
			const target = store.addNode({ kind: 'gen', x: 0, y: 0, w: 10, h: 10, status: 'ready' });
			check(
				'存好句柄之后立刻能连上（读 store 而不是渲染快照）',
				graph.canLink(store.getBoard().nodes, store.getBoard().links, local.id, target.id).ok === true,
			);
		}

		// 已经有句柄的不再重复存（拖两次同一张图不该发两次请求）
		const seen2 = [];
		const off2 = drop.setReferenceStore(() => ({
			storeReference: async (dataUrl) => {
				seen2.push(dataUrl);
				return { ok: true, value: { ok: true, message: 'ok', ref: 'C:\\tmp\\other.png' } };
			},
		}));
		await drop.attachReferenceHandles([local.id]);
		off2();
		check('已经有句柄的节点不再重复存', seen2.length === 0, JSON.stringify(seen2));

		// 失败要说一声（否则用户会在连线时撞上一句「重新拖一次」，而真因在这里）
		const failed = store.addNode({ kind: 'image', x: 0, y: 0, w: 10, h: 10, status: 'ready', src: bigDataUrl });
		const off3 = drop.setReferenceStore(() => ({
			storeReference: async () => ({
				ok: true,
				value: { ok: false, message: '这张图太大，存不成参考图' },
			}),
		}));
		notice.pushNotice('');
		const reported = await drop.attachReferenceHandles([failed.id]);
		off3();
		check(
			'存不成时返回「已经说过具体原因」（连线那边不要再用泛泛理由盖掉它）',
			reported === true,
			String(reported),
		);

		check(
			'存不成时立刻说出来（不是静默留个空节点）',
			notice.getNotice().includes('太大'),
			notice.getNotice(),
		);
		check(
			'失败时节点上没有留下半截句柄',
			store.getBoard().nodes.find((n) => n.id === failed.id)?.ref === undefined,
		);

		// 网关层的失败信封（宿主方法压根没跑到 / 调用被拒）：也要把 error.message 说出来
		const refused = store.addNode({ kind: 'image', x: 0, y: 0, w: 10, h: 10, status: 'ready', src: bigDataUrl });
		const off5 = drop.setReferenceStore(() => ({
			storeReference: async () => ({
				ok: false,
				error: { code: 'gateway/not-mounted', message: '这个宿主没有装配 mediaProbe' },
			}),
		}));
		notice.pushNotice('');
		const refusedReported = await drop.attachReferenceHandles([refused.id]);
		off5();
		check(
			'网关失败信封里的原因要转述给用户（不是「没能存成参考图」一句谜语）',
			refusedReported === true && notice.getNotice().includes('没有装配'),
			notice.getNotice(),
		);

		// 远程面回话既不是成功也不是一句原因（解析不出来）：绝不能沉默
		const mute = store.addNode({ kind: 'image', x: 0, y: 0, w: 10, h: 10, status: 'ready', src: bigDataUrl });
		const off4 = drop.setReferenceStore(() => ({ storeReference: async () => undefined }));
		notice.pushNotice('');
		const muteReported = await drop.attachReferenceHandles([mute.id]);
		off4();
		check(
			'宿主没回话时也要说一句（否则用户只看到「没能存成参考图」而不知道原因）',
			muteReported === true && notice.getNotice().includes('没有回话'),
			notice.getNotice(),
		);
		notice.pushNotice('');
	}

	storage.clear();
}

// ─────────────────── 结果 ───────────────────

console.log(results.join('\n'));
console.log('');
if (failures === 0) {
	console.log(`全部通过 ✅（${String(results.length)} 项）`);
	process.exit(0);
}
console.log(`${String(failures)} 项失败 ❌（共 ${String(results.length)} 项）`);
process.exit(1);
