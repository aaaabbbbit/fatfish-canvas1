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
	},
};

/** 裸 specifier 的桩见文件顶部（必须在 loadTsModule 之前）。 */

/**
 * 让「已经废弃的 store 实例」的待写盘定时器全部烧完。
 *
 * 本文件的每一小节都用**新的模块实例**（`loadTsModule`），每个实例各自带一个
 * 400ms 去抖写盘定时器；被丢下的实例并不会因此安静 —— 它的定时器会在**后面的
 * `await` 里**照样触发，把那一节留下的旧画布写回全局键。于是下一节 load 出来的
 * 画布会莫名其妙多出几个陌生节点（真的出现过：3 个节点里混进两个 `n_…`，
 * 而且**间歇性**通过，最难查）。
 * 这不是被测代码的 bug（真实运行中同一时刻只有一个 store 实例，且切换作用域会
 * 先 flush），是**测试要自己把时间轴清干净**：先等定时器烧完，再 clear，再 load。
 * @returns 定时器排空后的 promise。
 */
const drainPersistTimers = () => new Promise((r) => setTimeout(r, 600));

// ─────────────────── 载入被测模块 ───────────────────

const model = await loadTsModule(resolve(root, 'src/client/canvas/model.ts'));
const zip = await loadTsModule(resolve(root, 'src/client/canvas/zip.ts'));

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
}

{
	// 撤销（P51）：快照式 —— 删掉的节点要连坐标、尺寸、顺序一起回来。
	const store = await freshStore();
	check('新画布没有可撤回的步骤', store.canUndo() === false);
	check('栈空时撤回无副作用', store.undo() === false && store.getBoard().nodes.length === 0);

	const first = store.addNode({ kind: 'image', x: 11, y: 22, w: 100, h: 100, status: 'ready' });
	const second = store.addNode({ kind: 'image', x: 33, y: 44, w: 100, h: 100, status: 'ready' });
	check('新增后栈里有东西', store.canUndo() === true);
	store.undo();
	check('撤回一步退回「只剩一个」', store.getBoard().nodes.length === 1);
	store.undo();
	check('再撤回一步退回空画布', store.getBoard().nodes.length === 0);
	check('撤完栈空', store.canUndo() === false);
	check('栈空后再撤回无效', store.undo() === false);
	void first;
	void second;

	const a = store.addNode({ kind: 'image', x: 11, y: 22, w: 100, h: 100, status: 'ready' });
	const b = store.addNode({ kind: 'image', x: 33, y: 44, w: 100, h: 100, status: 'ready' });

	// 视口与选择集不进历史：它们不换 nodes 引用
	store.setViewport({ x: -1, y: -2, zoom: 1.5 });
	store.setSelection([b.id]);
	store.clearSelection();

	store.removeNodes([a.id]);
	check('删除后可撤回', store.canUndo() === true);
	store.undo();
	const back = store.getBoard().nodes.find((node) => node.id === a.id);
	check('撤回把删掉的节点放回来', back !== undefined);
	check('撤回还原坐标与尺寸', back !== undefined && back.x === 11 && back.y === 22 && back.w === 100);
	check(
		'撤回还原前后顺序',
		store.getBoard().nodes.map((node) => node.id).join(',') === `${a.id},${b.id}`,
		store.getBoard().nodes.map((node) => node.id).join(','),
	);

	// 视口变更同样不占撤销步：撤回落到的是「节点那一步」，连视口一起还原
	store.removeNodes([b.id]);
	store.setViewport({ x: 999, y: 999, zoom: 2 });
	store.undo();
	check('视口变更不占撤销步', store.getBoard().nodes.length === 2, String(store.getBoard().nodes.length));
	check('撤回连视口一起还原', store.getBoard().viewport.zoom === 1.5, String(store.getBoard().viewport.zoom));

	// 连删两个节点是两件事：不能被时间窗并成一步
	store.removeNodes([a.id]);
	store.removeNodes([b.id]);
	store.undo();
	check('连删两步：撤一步只回来一个', store.getBoard().nodes.length === 1);
	store.undo();
	check('再撤一步回满', store.getBoard().nodes.length === 2);

	// 拖拽每帧都在 patchNodes：同一批节点的连续微调必须并成一步
	store.patchNodes(new Map([[a.id, { x: 100 }]]));
	store.patchNodes(new Map([[a.id, { x: 110 }]]));
	store.patchNodes(new Map([[a.id, { x: 120 }]]));
	store.undo();
	check(
		'拖拽的连续微调并成一步（不会塞满撤销栈）',
		store.getBoard().nodes.find((node) => node.id === a.id).x === 11,
		String(store.getBoard().nodes.find((node) => node.id === a.id).x),
	);

	// 最吓人的那个动作也要能退回来
	store.clearBoard();
	check('清空后画布为空', store.getBoard().nodes.length === 0);
	store.undo();
	check('清空画布可撤回', store.getBoard().nodes.length === 2);
}

{
	// 换工作区必须清空撤销栈：否则在工作区 B 按一下 Ctrl+Z 会把 A 的节点搬进来
	// （「一个工作区一块画布」是数据隔离，不只是显示）。
	const store = await freshStore();
	store.addNode({ kind: 'image', x: 0, y: 0, w: 10, h: 10, status: 'ready' });
	check('新增后可撤回', store.canUndo() === true);
	store.setBoardScope('D:\\ws\\one');
	check('换工作区后撤销栈清空', store.canUndo() === false);
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
	// 设计技能开关（P41）：缺席 = 开，只有显式 false 才算关 —— 与宿主 schema 缺省同一语义
	check(
		'目录：设计技能缺省按开算（缺席一律 = 开）',
		settings.mediaCatalog({ providers: {} }).designSkillOn === true &&
			catalog.designSkillOn === true,
		String(catalog.designSkillOn),
	);
	check(
		'目录：显式关了才报关（尾巴右键写的 false 在这里读得回来）',
		settings.mediaCatalog({ providers: {}, designSkillOn: false }).designSkillOn === false,
	);
	check(
		'目录：坏数据 / 非布尔不吞掉开关语义（任何不是 false 的值都按开算）',
		settings.mediaCatalog({ providers: {}, designSkillOn: 0 }).designSkillOn === true,
	);
}

// ─────── 3d. 档位：分辨率轴（兄弟 id）+ 质量轴（请求参数） ───────

console.log('\n3d) 档位：家族与两条轴');

{
	const settings = await loadTsModule(resolve(root, 'src/client/settings/models.ts'));
	const catalogLib = await loadTsModule(resolve(root, 'src/client/shared/catalog.ts'));

	// ── 分辨率轴：纯名字派生，因此「检测」就是一次拆分 ──
	const split = catalogLib.splitTier('gpt-image-2.5-sunburst-2k');
	check(
		'splitTier：尾部的档位词拆出去，剩下的是家族词干',
		split.stem === 'gpt-image-2.5-sunburst' && split.tier === '2k',
		JSON.stringify(split),
	);
	check(
		'splitTier：认不出的尾巴不算档位（宁可不分组，也不误分组）',
		catalogLib.splitTier('gpt-image-1').tier === '' &&
			catalogLib.splitTier('Kwai-Kolors/Kolors').tier === '' &&
			catalogLib.splitTier('2k').tier === '',
		[
			catalogLib.splitTier('gpt-image-1').tier,
			catalogLib.splitTier('Kwai-Kolors/Kolors').tier,
			catalogLib.splitTier('2k').tier,
		].join('|'),
	);
	check(
		'家族键按供应商隔离（两个供应商的同名词干不会挤成一行）',
		catalogLib.familyRefOf('acme', 'shot-2k') === 'acme::shot' &&
			catalogLib.familyRefOf('bare', 'shot-2k') !== catalogLib.familyRefOf('acme', 'shot-2k'),
		catalogLib.familyRefOf('acme', 'shot-2k'),
	);

	// ── 质量轴：声明制（`/models` 没有任何「收哪些 quality」的信号） ──
	check(
		'parseTierAxis：坏形状一律当作「没有轴」（不抛：设置可能被手工改坏）',
		catalogLib.parseTierAxis(null) === undefined &&
			catalogLib.parseTierAxis('quality') === undefined &&
			catalogLib.parseTierAxis({ param: 'quality', values: [] }) === undefined &&
			catalogLib.parseTierAxis({ param: '', values: ['low'] }) === undefined,
	);
	check(
		'parseTierAxis：拒掉会写坏请求的参数名（model / prompt / n / image）',
		['model', 'prompt', 'n', 'image'].every(
			(param) => catalogLib.parseTierAxis({ param, values: ['low'] }) === undefined,
		),
	);
	check(
		'parseTierAxis：取值去重、labels 只留非空串',
		(() => {
			const axis = catalogLib.parseTierAxis({
				param: 'quality',
				values: ['low', 'low', '', 'high'],
				labels: { low: '低', high: '  ', junk: 3 },
			});
			return (
				axis !== undefined &&
				axis.values.join(',') === 'low,high' &&
				axis.labels.low === '低' &&
				axis.labels.high === undefined &&
				axis.labels.junk === undefined
			);
		})(),
	);
	check(
		'currentTier：存的值合法就用它，非法/缺失退回第一个取值',
		catalogLib.currentTier('high', { param: 'q', values: ['low', 'high'], labels: {} }) === 'high' &&
			catalogLib.currentTier('  ', { param: 'q', values: ['low', 'high'], labels: {} }) === 'low' &&
			catalogLib.currentTier('nope', { param: 'q', values: ['low', 'high'], labels: {} }) === 'low',
	);

	// ── 目录：模型条目带上家族与轴 ──
	const CONFIG = {
		providers: {
			acme: {
				label: 'Acme',
				models: [
					{ id: 'shot-1k', kind: 'image' },
					{ id: 'shot-2k', kind: 'image' },
					{
						id: 'shot-4k',
						kind: 'image',
						// 声明写在**任意一个**成员上都算这个家族的（这里刻意写在 4k 上）
						tiers: { param: 'quality', values: ['low', 'high'], labels: { low: '低', high: '高' } },
					},
					{ id: 'solo', kind: 'image' },
					{ id: 'lone-with-axis', kind: 'image', tiers: { param: 'quality', values: ['low', 'high'] } },
				],
			},
			bare: { models: [{ id: 'shot-8k', kind: 'image' }] },
		},
		defaultImage: 'acme::shot-2k',
		defaultTiers: { 'acme::shot': 'high' },
	};
	const catalog = settings.mediaCatalog(CONFIG);
	const rows = settings.pickRows(catalog.image, catalog.tiers);
	const shot = rows.find((row) => row.key === 'acme::shot');

	check('目录：模型条目带上家族键与分辨率档位词',
		catalog.image[1].familyRef === 'acme::shot' && catalog.image[1].tier === '2k',
		`${catalog.image[1].familyRef} / ${catalog.image[1].tier}`);
	check('目录：家族里谁声明，全体成员都拿到这条轴',
		catalog.image[0].axis?.param === 'quality' && catalog.image[2].axis?.param === 'quality');
	check('目录：当前档位从 defaultTiers 读出来', catalog.tiers['acme::shot'] === 'high');
	check(
		'pickRows：三个分辨率兄弟折成一行（家族名 = 词干）',
		shot !== undefined && shot.kind === 'family' && shot.label === 'shot' && shot.options.length === 3,
		JSON.stringify(shot?.kind === 'family' ? [shot.label, shot.options.length] : shot),
	);
	check('pickRows：家族当前档位取生效值', shot?.kind === 'family' && shot.tier === 'high', String(shot?.tier));
	check(
		'pickRows：没有兄弟、也没有声明的模型仍是平铺行（升级后观感不变）',
		rows.some((row) => row.kind === 'one' && row.option.modelId === 'solo'),
		rows.map((row) => row.kind).join(','),
	);
	check(
		'pickRows：只有一个成员也可以是一个家族（声明了轴就要能选出档位）',
		rows.some((row) => row.kind === 'family' && row.options.length === 1 && row.options[0].modelId === 'lone-with-axis'),
	);
	check(
		'pickRows：另一个供应商的同名词干自成一个平铺行（不跨供应商合并）',
		rows.filter((row) => row.kind === 'one' && row.option.providerId === 'bare').length === 1,
	);
	check(
		'pickRows：存了一个已经不在取值清单里的档位 → 退回第一个取值',
		settings.pickRows(catalog.image, { 'acme::shot': 'ultra' }).find((row) => row.key === 'acme::shot')?.tier === 'low',
	);
	check(
		'tierTextOf：当前模型在家族里就报出档位展示名，否则空串',
		settings.tierTextOf(rows, 'acme::shot-2k') === '高' &&
			settings.tierTextOf(rows, 'acme::solo') === '' &&
			settings.tierTextOf(rows, 'acme::lone-with-axis') === 'low',
		String(settings.tierTextOf(rows, 'acme::shot-2k')),
	);

	// ── 设置页草稿 ⇄ 轴（读取与写入共用同一个校验） ──
	const draft = settings.parseTierDraft('quality', 'low=低, high=高');
	check(
		'parseTierDraft：取值与中文展示名都解析出来',
		draft.axis?.values.join(',') === 'low,high' && draft.axis.labels.high === '高',
		JSON.stringify(draft.axis),
	);
	check(
		'parseTierDraft：中文逗号也认，缺省展示名用取值原文',
		settings.parseTierDraft('quality', 'low，high').axis?.values.join(',') === 'low,high' &&
			settings.parseTierDraft('quality', 'low，high').axis.labels.low === undefined,
	);
	check(
		'parseTierDraft：参数名非法 / 保留名 / 空取值都当场报错（不写进去再静默失效）',
		settings.parseTierDraft('Model', 'low').axis === undefined &&
			settings.parseTierDraft('model', 'low').error !== '' &&
			settings.parseTierDraft('quality', '  ').error !== '',
		settings.parseTierDraft('model', 'low').error,
	);
	check(
		'tierDraftOf：把已存的轴还原成草稿原文（打开编辑器时预填）',
		settings.tierDraftOf(settings.parseTierDraft('quality', 'low=低, high').axis) === 'low=低, high',
		settings.tierDraftOf(settings.parseTierDraft('quality', 'low=低, high').axis),
	);
}

// ─────── 3e. 常用模型：类型预置 / 其他参数 / 家族行（P29） ───────

console.log('\n3e) 常用模型：类型预置与其他参数');

{
	const settings = await loadTsModule(resolve(root, 'src/client/settings/models.ts'));
	const presets = await loadTsModule(resolve(root, 'src/client/shared/modelPresets.ts'));
	const catalogLib = await loadTsModule(resolve(root, 'src/client/shared/catalog.ts'));

	// ── 预置按词干匹配：这就是「覆盖将来带 2K / 4K 尾缀的模型」的落点 ──
	const stemOf = (id) => catalogLib.splitTier(id).stem;
	check(
		'预置：同一个类型的 -1k / -2k / -4k 兄弟命中同一条预置',
		['gpt-image-2', 'gpt-image-2-2k', 'gpt-image-2-4k'].every(
			(id) => presets.presetOf('image', stemOf(id))?.id === 'gpt-image-2',
		),
		['gpt-image-2', 'gpt-image-2-2k', 'gpt-image-2-4k']
			.map((id) => `${id}→${presets.presetOf('image', stemOf(id))?.id ?? '(无)'}`)
			.join(','),
	);
	check(
		'预置：更具体的前缀先匹配（2.5 的兄弟不会被 2 那条吃掉）',
		presets.presetOf('image', stemOf('gpt-image-2.5-sunburst-2k'))?.id === 'gpt-image-2.5' &&
			presets.presetOf('image', stemOf('nano-banana-pro-4k'))?.id === 'nano-banana',
		[
			presets.presetOf('image', stemOf('gpt-image-2.5-sunburst-2k'))?.id,
			presets.presetOf('image', stemOf('nano-banana-pro-4k'))?.id,
		].join(','),
	);
	check(
		'预置：gemini-nano-banana-2.1 与**之前的香蕉是同一条**（2.1 不是新系列；' +
			'参数也只有 aspect_ratio + image_size，与 T8-penguin-canvas 的 banana-ratio 通道一致）',
		['gemini-nano-banana-2.1', 'gemini-nano-banana-2.1-4k'].every(
			(id) => presets.presetOf('image', stemOf(id))?.id === 'nano-banana',
		) &&
			presets
				.presetOf('image', stemOf('gemini-nano-banana-2.1'))
				.params.map((spec) => spec.key)
				.join(',') === 'aspect_ratio,image_size' &&
			presets
				.presetOf('image', stemOf('gemini-nano-banana-2.1'))
				.params.find((spec) => spec.key === 'image_size')
				.values.join(',') === '1K,2K,4K',
		['gemini-nano-banana-2.1', 'gemini-nano-banana-2.1-4k']
			.map((id) => `${id}→${presets.presetOf('image', stemOf(id))?.id ?? '(无)'}`)
			.join(','),
	);
	check(
		'预置：种类不串（视频词干不会命中图像预置）',
		presets.presetOf('video', 'gpt-image-2') === undefined &&
			presets.presetOf('video', 'sora-2')?.id === 'sora',
		String(presets.presetOf('video', 'sora-2')?.id),
	);
	check(
		'预置：认不出来的模型没有预置（宁可不猜，也不要塞错参数）',
		presets.presetOf('image', 'Kwai-Kolors/Kolors') === undefined &&
			presets.presetOf('image', 'acme-large') === undefined,
	);

	// ── MiniMax H3（海螺）：这一族走 seedance-nz 协议，键名与缺省那套逐个不同 ──
	const minimax = presets.presetOf('video', stemOf('minimax-h3-ow-r2v'));
	const minimaxSpec = (key) => minimax?.params.find((spec) => spec.key === key);
	check(
		'预置：MiniMax H3 一族（-ow-t2v / -ow-r2v / -fast）共用一条，键按 seedance-nz 协议声明',
		minimax?.id === 'minimax-h3' &&
			minimax.wire === 'seedance-nz' &&
			['minimax-h3-ow-t2v', 'minimax-h3-ow-r2v-fast'].every(
				(id) => presets.presetOf('video', stemOf(id))?.id === 'minimax-h3',
			) &&
			minimaxSpec('seconds')?.values.join(',') === '5,10,15' &&
			minimaxSpec('resolution')?.values.join(',') === '480P,768P,1080P' &&
			minimaxSpec('ratio')?.values.join(',') === '1:1,2:3,3:2,3:4,4:3,9:16,16:9,21:9' &&
			// 设置页里的键是平铺的，请求体里是 `metadata.…` —— 提示文案与拼装必须同一份说法
			presets.wirePathOf(minimax.wire, 'resolution') === 'metadata.resolution' &&
			presets.wirePathOf(minimax.wire, 'seconds') === 'seconds' &&
			presets.wirePathOf(undefined, 'resolution') === 'resolution',
		JSON.stringify(minimax?.params.map((spec) => spec.key)),
	);

	// ── MJ 出图：参数不是请求体字段，而是提示词里的 flag（`wire: 'mj-imagine'`） ──
	const mjImagine = presets.presetOf('image', stemOf('mj_fast_imagine'));
	check(
		'预置：mj_fast_imagine 命中 mj-imagine（提示文案给的是 --flag，不是请求体路径）',
		mjImagine?.id === 'mj-imagine' &&
			mjImagine.wire === 'mj-imagine' &&
			mjImagine.params.some((spec) => spec.key === 'ar') &&
			presets.wirePathOf(mjImagine.wire, 'stylize') === '--stylize（拼进提示词，不是请求体字段）',
		JSON.stringify(mjImagine?.params.map((spec) => spec.key)),
	);
	check(
		'预置：relax / turbo / 别的动作**刻意不命中这条**（模式是路径或令牌选的 —— 挂上它就是静默按 fast 计费）',
		['mj_relax_imagine', 'mj_turbo_imagine', 'mj_fast_upscale'].every(
			(id) => presets.presetOf('image', stemOf(id)) === undefined,
		),
		['mj_relax_imagine', 'mj_turbo_imagine', 'mj_fast_upscale']
			.map((id) => `${id}→${presets.presetOf('image', stemOf(id))?.id ?? '(无)'}`)
			.join(','),
	);

	// ── 质量轴：预置摆出 chip，但**默认不传**（用户点一下才进请求体） ──
	const axis = presets.presetAxisOf(presets.presetOf('image', 'gpt-image-2'));
	check(
		'预置的质量轴：取值齐、默认「未选」（fallback 空串 = 不写进请求体）',
		axis?.param === 'quality' &&
			axis.values.join(',') === 'auto,low,medium,high' &&
			catalogLib.currentTier(undefined, axis) === '' &&
			catalogLib.currentTier('high', axis) === 'high',
		JSON.stringify({ values: axis?.values, fallback: axis?.fallback, now: catalogLib.currentTier(undefined, axis) }),
	);
	check(
		'手写声明仍然默认取第一个取值（P28 的行为没被预置改掉）',
		catalogLib.currentTier(undefined, { param: 'q', values: ['low', 'high'], labels: {} }) === 'low',
	);

	// ── 值的收敛：声明过的键按类型转，自加的键认字面量 ──
	const specN = { key: 'n', label: '张数', type: 'number' };
	check(
		'coerceParam：数字类型转成数字（"2" → 2），转不了就当作没填',
		presets.coerceParam(specN, '2') === 2 &&
			presets.coerceParam(specN, 4) === 4 &&
			presets.coerceParam(specN, 'two') === undefined,
		JSON.stringify([presets.coerceParam(specN, '2'), presets.coerceParam(specN, 'two')]),
	);
	check(
		'coerceParam：布尔类型只认 true / false',
		presets.coerceParam({ key: 'watermark', label: '水印', type: 'boolean' }, 'true') === true &&
			presets.coerceParam({ key: 'watermark', label: '水印', type: 'boolean' }, 'maybe') === undefined,
	);
	check(
		'coerceParam：自加的键认字面量（`2` 当数字），其余原样',
		presets.coerceParam(undefined, '2') === 2 &&
			presets.coerceParam(undefined, 'true') === true &&
			presets.coerceParam(undefined, '2048x2048') === '2048x2048',
		JSON.stringify([presets.coerceParam(undefined, '2'), presets.coerceParam(undefined, '2048x2048')]),
	);
	check(
		'coerceParam：闭集不是校验器（网关支持什么我们并不知道，别把值挡在门外）',
		presets.coerceParam({ key: 'size', label: '尺寸', values: ['1024x1024'] }, '3840x2160') === '3840x2160',
	);
	check(
		'isParamKey：保留键与非法形状一律不收（model / prompt / n / image 会把请求写坏；' +
			'n 尤其 —— 网关按它出图、我们只读 data[0]，n>1 是静默丢图）',
		!presets.isParamKey('model') &&
			!presets.isParamKey('prompt') &&
			!presets.isParamKey('n') &&
			!presets.isParamKey('image') &&
			!presets.isParamKey('Size') &&
			presets.isParamKey('output_format') &&
			// 与质量轴那份清单**同源**（各写一份曾经漂移：设置页不让声明、宿主却照收）
			catalogLib.parseTierAxis({ param: 'n', values: ['low'] }) === undefined,
	);

	// ── 目录：预置顶上来之后，聊天栏那格才有 chip 可选 ──
	const CONFIG = {
		providers: {
			acme: {
				label: 'Acme',
				models: [
					{ id: 'gpt-image-2', kind: 'image' },
					{ id: 'gpt-image-2-2k', kind: 'image' },
					{ id: 'gpt-image-2-4k', kind: 'image' },
					{ id: 'acme-large', kind: 'image' },
				],
			},
			bare: { models: [{ id: 'sora-2', kind: 'video' }] },
		},
		commonModels: {
			'acme::gpt-image-2': { pinned: true, quality: true, params: { size: '2048x2048' } },
		},
	};
	const catalog = settings.mediaCatalog(CONFIG);
	const rows = settings.pickRows(catalog.image, catalog.tiers);
	const family = rows.find((row) => row.key === 'acme::gpt-image-2');

	check(
		'目录：预置让三个分辨率兄弟折成一行，且带上了质量轴（零配置就有 chip）',
		family?.kind === 'family' &&
			family.options.length === 3 &&
			family.axis?.param === 'quality' &&
			family.tier === '',
		JSON.stringify(family?.kind === 'family' ? [family.options.length, family.axis?.param, family.tier] : family),
	);
	check(
		'目录：认不出的模型仍是平铺行（预置没命中就什么都不变）',
		rows.some((row) => row.kind === 'one' && row.option.modelId === 'acme-large'),
		rows.map((row) => row.kind).join(','),
	);
	check(
		'目录：勾了「常用」的家族读得出来（聊天栏那格据此分区）',
		catalog.common['acme::gpt-image-2']?.pinned === true &&
			catalog.common['acme::acme-large'] === undefined,
		JSON.stringify(Object.keys(catalog.common)),
	);
	check(
		'目录：设置里的其他参数读得出来（键值原样，收敛在宿主侧做）',
		catalog.common['acme::gpt-image-2']?.params.size === '2048x2048',
		JSON.stringify(catalog.common['acme::gpt-image-2']?.params),
	);
	check(
		'目录：坏形状的 commonModels 整项丢掉（下游用缺省值兜，不抛错）',
		(() => {
			const bad = settings.mediaCatalog({ providers: {}, commonModels: { x: null, y: 'nope' } });
			return bad.common.x === undefined && bad.common.y === undefined;
		})(),
		JSON.stringify(settings.mediaCatalog({ providers: {}, commonModels: { x: null } }).common),
	);

	// ── 关掉质量参数：预置的轴不再顶上来 ──
	const offCatalog = settings.mediaCatalog({
		...CONFIG,
		commonModels: { 'acme::gpt-image-2': { pinned: false, quality: false, params: {} } },
	});
	check(
		'目录：设置里关掉质量参数之后，预置的轴不再顶上来（回到平铺 + 折叠都没有）',
		offCatalog.image[0]?.axis === undefined &&
			settings
				.pickRows(offCatalog.image, {})
				.find((row) => row.key === 'acme::gpt-image-2')?.axis === undefined,
		JSON.stringify(offCatalog.image[0]?.axis ?? null),
	);

	// ── 聊天栏那格的分区：勾过的排前面，一个都没勾就照旧铺开 ──
	const partition = settings.pickerPartition(rows, catalog.common);
	check(
		'pickerPartition：勾了常用的家族分到「常用」那一段（其余进「其他模型」）',
		partition.pinned.length === 1 &&
			partition.pinned[0]?.key === 'acme::gpt-image-2' &&
			partition.others.some((row) => row.key === 'acme::acme-large'),
		`pinned=${partition.pinned.map((row) => row.key).join(',')} others=${partition.others.length}`,
	);
	check(
		'pickerPartition：没勾过任何常用时「常用」为空（观感与升级前一致）',
		settings.pickerPartition(rows, {}).pinned.length === 0 &&
			settings.pickerPartition(rows, {}).others.length === rows.length,
	);
	check(
		'pickerPartition：平铺行也能勾常用（两种行的 key 都是家族键）',
		settings.pickerPartition(rows, { 'acme::acme-large': { pinned: true, quality: true, params: {} } }).pinned[0]
			?.kind === 'one',
	);

	// ── 点档位 = 选用这个模型（家族行只是展开开关，只有一个成员的家族没有别的入口） ──
	const familyRowsOf = (models) =>
		settings.pickRows(settings.mediaCatalog({ providers: { acme: { models } } }).image, {});
	const single = familyRowsOf([{ id: 'gpt-image-2', kind: 'image' }]).find((row) => row.kind === 'family');
	const pair = familyRowsOf([
		{ id: 'gpt-image-2-2k', kind: 'image' },
		{ id: 'gpt-image-2-4k', kind: 'image' },
	]).find((row) => row.kind === 'family');
	const withBase = familyRowsOf([
		{ id: 'gpt-image-2-4k', kind: 'image' },
		{ id: 'gpt-image-2', kind: 'image' },
	]).find((row) => row.kind === 'family');

	check(
		'familyTarget：只有一个成员的家族也要能选中它（「展开挡住了选用按钮」的修法）',
		settings.familyTarget(single, '')?.ref === 'acme::gpt-image-2',
		String(settings.familyTarget(single, '')?.ref),
	);
	check(
		'familyTarget：当前默认已经在这个家族里 → 就用它（换档不会顺带换分辨率）',
		settings.familyTarget(pair, 'acme::gpt-image-2-4k')?.ref === 'acme::gpt-image-2-4k' &&
			settings.familyTarget(withBase, 'acme::gpt-image-2-4k')?.ref === 'acme::gpt-image-2-4k',
		String(settings.familyTarget(pair, 'acme::gpt-image-2-4k')?.ref),
	);
	check(
		'familyTarget：当前默认不在这个家族里 → 优先选不带分辨率尾缀的那个（基名）',
		settings.familyTarget(withBase, 'other::x')?.ref === 'acme::gpt-image-2',
		String(settings.familyTarget(withBase, 'other::x')?.ref),
	);
	check(
		'familyTarget：家族里全是尾缀档（没有基名）→ 退回第一个',
		settings.familyTarget(pair, 'other::x')?.ref === 'acme::gpt-image-2-2k',
		String(settings.familyTarget(pair, 'other::x')?.ref),
	);

	// ── 设置页那一块的数据：家族行 ──
	const families = settings.familyRows(CONFIG);
	const gpt = families.find((row) => row.familyRef === 'acme::gpt-image-2');
	check(
		'familyRows：一个家族一行，成员含全部 -2k / -4k 兄弟（将来多一个尾缀也自动进这一行）',
		gpt?.members.join(',') === 'gpt-image-2,gpt-image-2-2k,gpt-image-2-4k' &&
			gpt.preset?.id === 'gpt-image-2' &&
			gpt.declared === false,
		JSON.stringify(gpt?.members),
	);
	check(
		'familyRows：视频家族也在（种类只影响预置匹配与徽标）',
		families.some(
			(row) => row.familyRef === 'bare::sora-2' && row.kind === 'video' && row.preset?.id === 'sora',
		),
		families.map((row) => row.familyRef).join(','),
	);
	check(
		'familyRows：视觉模型不进这一块（它不是产物，没有档位也没有常用之说）',
		settings
			.familyRows({ providers: { a: { models: [{ id: 'vl-1', kind: 'vision' }] } } })
			.length === 0,
	);
	check(
		'familyRows：用户那把 mj_fast_imagine（挂在 custom 供应商下）照样成一行，并挂上 MJ 那套参数',
		(() => {
			const row = settings.familyRows({
				providers: { custom: { models: [{ id: 'mj_fast_imagine', kind: 'image' }] } },
			})[0];
			return (
				row?.familyRef === 'custom::mj_fast_imagine' &&
				row.preset?.id === 'mj-imagine' &&
				row.preset.label === 'Midjourney Imagine'
			);
		})(),
	);
	check(
		'familyRows：2.1 是**自己一行**（与 3.1-preview 不并——并了它就从聊天栏那格的常用里消失）',
		(() => {
			// 用用户真实的三个 id + 真实的顺序（-2k 在前、2.1 在最后）
			const rows = settings.familyRows({
				providers: {
					custom: {
						models: [
							{ id: 'gemini-3.1-flash-image-preview-2k', kind: 'image' },
							{ id: 'gemini-3.1-flash-image-preview', kind: 'image' },
							{ id: 'gemini-nano-banana-2.1', kind: 'image' },
						],
					},
				},
			});
			const preview = rows.find((row) => row.familyRef === 'custom::gemini-3.1-flash-image-preview');
			const nano = rows.find((row) => row.familyRef === 'custom::gemini-nano-banana-2.1');
			return (
				rows.length === 2 &&
				preview?.members.join(',') === 'gemini-3.1-flash-image-preview-2k,gemini-3.1-flash-image-preview' &&
				nano?.members.join(',') === 'gemini-nano-banana-2.1' &&
				// 行分开、预置共用：2.1 照旧拿到香蕉那份参数（aspect_ratio + image_size）
				preview?.preset?.id === 'nano-banana' &&
				nano?.preset?.id === 'nano-banana' &&
				nano?.stem === 'gemini-nano-banana-2.1'
			);
		})(),
		(() => {
			const rows = settings.familyRows({
				providers: {
					custom: {
						models: [
							{ id: 'gemini-3.1-flash-image-preview-2k', kind: 'image' },
							{ id: 'gemini-3.1-flash-image-preview', kind: 'image' },
							{ id: 'gemini-nano-banana-2.1', kind: 'image' },
						],
					},
				},
			});
			return rows.map((row) => `${row.familyRef}[${row.members.join('/')}]`).join(' | ');
		})(),
	);
	check(
		'familyRows：两行的配置各归各的（老键 `custom::gemini-3.1-flash-image-preview` 只作用在预览那行）',
		(() => {
			const rows = settings.familyRows({
				providers: {
					custom: {
						models: [
							{ id: 'gemini-3.1-flash-image-preview', kind: 'image' },
							{ id: 'gemini-nano-banana-2.1', kind: 'image' },
						],
					},
				},
				commonModels: {
					'custom::gemini-3.1-flash-image-preview': { pinned: true },
					'custom::gemini-nano-banana-2.1': { pinned: true, params: { image_size: '2K' } },
				},
			});
			const preview = rows.find((row) => row.familyRef === 'custom::gemini-3.1-flash-image-preview');
			const nano = rows.find((row) => row.familyRef === 'custom::gemini-nano-banana-2.1');
			return (
				rows.length === 2 &&
				preview?.common.pinned === true &&
				preview?.common.params.image_size === undefined &&
				nano?.common.pinned === true &&
				nano?.common.params.image_size === '2K'
			);
		})(),
	);
	check(
		'familyRows：手写声明优先，并标出「这是声明的」（设置页据此显示「清除声明」）',
		(() => {
			const row = settings.familyRows({
				providers: {
					a: { models: [{ id: 'gpt-image-2', kind: 'image', tiers: { param: 'resolution', values: ['1k'] } }] },
				},
			})[0];
			return row?.declared === true && row.axis?.param === 'resolution';
		})(),
	);
	check(
		'familyRows：坏数据不炸（null / 非数组 models）',
		settings.familyRows({ providers: { a: null, b: { models: 'x' } } }).length === 0,
	);
}

// ─────────────────── 4. 生成结果 → 画布落图（P3） ───────────────────

console.log('\n4) 生成结果 → 画布落图（P3）');

{
	// ⚠️ 先排空**前面小节遗留的去抖写盘**再清存储（见 drainPersistTimers 的说明）：
	// 少了这一句，3b 的拖放测试留下的 400ms 定时器会在本节的某个 await 里落地，
	// 把它的画布写回全局键 —— 本节 load 出来的画布就多出几个陌生节点
	// （现象：`节点 id 由 callId 派生` 等一串断言全红，而且**间歇性**）。
	await drainPersistTimers();
	storage.clear();
	// ingest 与 store 必须共用同一份模块实例：落图动作写的是 store 的模块级
	// 状态，若各加载一份，断言读到的会是另一个空画布。
	const shared = new Map();
	const storePath = resolve(root, 'src/client/canvas/store.ts');
	const store = await loadTsModule(storePath, shared);
	const ingest = await loadTsModule(resolve(root, 'src/client/canvas/ingest.ts'), shared);
	const media = await loadTsModule(resolve(root, 'src/client/shared/media.ts'), shared);

	const callArgs = JSON.stringify({
		prompt: '一只肥鱼',
		kind: 'image',
		reference: ['https://media.test/ref.png', 'attached'],
	});
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
	// ── 4.1c 参考图句柄：一张写字符串、多张写数组（「生成信息」靠它回看） ──
	check(
		'parseMediaCallArgs 收下 reference（字符串与数组两种写法、按顺序、去掉空白）',
		(() => {
			const one = media.parseMediaCallArgs({ prompt: '猫', reference: ' https://x/a.png ' });
			const many = media.parseMediaCallArgs({
				prompt: '猫',
				reference: ['https://x/a.png', '', 42, 'attached'],
			});
			return (
				JSON.stringify(one.references) === '["https://x/a.png"]' &&
				JSON.stringify(many.references) === '["https://x/a.png","attached"]'
			);
		})(),
		JSON.stringify(media.parseMediaCallArgs({ prompt: '猫', reference: ['a', 42, ''] })),
	);
	check(
		'没有 reference 时 references 是 undefined（纯文生图不该显示「参考图 0 张」）',
		media.parseMediaCallArgs('{"prompt":"猫"}').references === undefined,
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
	check(
		'参考图句柄写进 pending 节点（生成的那一刻唯一看得到它们的地方）',
		JSON.stringify(pending.references) === '["https://media.test/ref.png","attached"]',
		JSON.stringify(pending.references),
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
		'结果到达也不丢参考图（改状态只补字段，不重置节点）',
		JSON.stringify(ready?.references) === '["https://media.test/ref.png","attached"]',
		JSON.stringify(ready?.references),
	);
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
		'v2 持久化形态回读正确（nodes/viewport/ingested 都在）',
		(() => {
			const raw = JSON.parse(storage.get('fatfish-canvas:board'));
			return raw.version === 2 && Array.isArray(raw.nodes) && Array.isArray(raw.ingested);
		})(),
		String(storage.get('fatfish-canvas:board')).slice(0, 120),
	);
	// v1（P2 时代）的数据没有 ingested 字段，必须照样能读
	//
	// ⚠️ 先排空**前面几节遗留的去抖写盘**（§8.20）：废弃的 store 实例会在下面的
	// `await` 里照样触发，把它那一节的旧画布写回全局键 —— 于是这里「刚写进去的」
	// 被覆盖，表现为这两条断言**间歇性**红（本轮实测到两次，红的还不是同一条）。
	await drainPersistTimers();
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
	// ── 参考图在「生成信息」里的呈现：能看图的给图，只能看说明的说清它是什么 ──
	check(
		'referenceViews：真地址可渲染（http(s) / 本机留档 / 小 data:）',
		(() => {
			const views = model.referenceViews([
				'https://cdn.example.com/a.png',
				'/ffc-media/海边.png',
				'data:image/png;base64,QUJD',
			]);
			return views.length === 3 && views.every((v) => v.loadable === true && v.note === undefined);
		})(),
		JSON.stringify(model.referenceViews(['https://cdn.example.com/a.png'])),
	);
	check(
		'referenceViews：取不到字节的句柄说清是什么，且不许当 src（否则必然是裂图）',
		(() => {
			const views = model.referenceViews([
				'attached',
				'sha256:abc',
				'attachment:abc',
				'C:/pics/a.png',
			]);
			return (
				views.length === 4 &&
				views.every((v) => v.loadable === false) &&
				views[0].note?.includes('附在') === true &&
				views[1].note?.includes('附件') === true &&
				views[2].note?.includes('附件') === true &&
				// 本地路径没有更好的说法：原样显示地址（宿主读得到、浏览器读不到）
				views[3].note === undefined &&
				views[3].handle === 'C:/pics/a.png'
			);
		})(),
		JSON.stringify(model.referenceViews(['attached', 'sha256:abc', 'C:/pics/a.png'])),
	);
	check(
		'referenceViews：空句柄剔除、缺席即空数组（老节点没有这个字段）',
		model.referenceViews(['', '  ']).length === 0 && model.referenceViews(undefined).length === 0,
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
		(await regen.regenerate('一只肥鱼', 'image', '16:9')) === 'prompt' &&
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
			regen.regenerateCommandLine('猫', 'image', '16:9') === '/generate --ratio 16:9 猫 ' &&
				regen.regenerateCommandLine('海浪', 'video') === '/generate --video 海浪 ' &&
				regen.regenerateCommandLine('猫') === '/generate 猫 ',
			`${regen.regenerateCommandLine('猫', 'image', '16:9')} | ${regen.regenerateCommandLine('海浪', 'video')}`,
		);
		check(
			'regenerateCommandLine：多张参考图 = 多个 --ref，**按给的顺序**',
			regen.regenerateCommandLine('融合', 'image', '1:1', ['https://x/a.png', 'https://x/b.png']) ===
				'/generate --ratio 1:1 --ref https://x/a.png --ref https://x/b.png 融合 ',
			regen.regenerateCommandLine('融合', 'image', '1:1', ['https://x/a.png', 'https://x/b.png']),
		);
		check(
			'referencesOf：只收能当参考图的（http(s) / 小 data:），顺序不变',
			JSON.stringify(
				regen.referencesOf([
					{ src: 'https://x/a.png' },
					{ src: 'blob:http://localhost/1' },
					{ src: undefined },
					{ src: 'data:image/png;base64,QUJD' },
				]),
			) === '["https://x/a.png","data:image/png;base64,QUJD"]',
			JSON.stringify(
				regen.referencesOf([{ src: 'https://x/a.png' }, { src: 'blob:x' }, { src: 'data:image/png;base64,QUJD' }]),
			),
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
			(await regen.regenerate('一只肥鱼', 'image', '1:1')) === 'command' &&
				lines.length === 1 &&
				prompts.length === 0,
			JSON.stringify(lines),
		);
		check(
			'多张参考图也走命令，且两张都在那一行里（顺序不变）',
			(await regen.regenerate('融合', 'image', undefined, ['https://x/a.png', 'https://x/b.png'])) === 'command' &&
				String(lines[1]).includes('--ref https://x/a.png --ref https://x/b.png'),
			String(lines[1]),
		);
		off3();

		// 带参考图时**不许**退回提示词：模型看不见图，让它「参考图生成」只会得到一句空话
		const off3b = regen.setRegenerateTarget({
			command: () => Promise.resolve({ ok: true, value: { matched: false } }),
			prompt: () => Promise.resolve({ ok: true }),
		});
		check(
			'带参考图 + 命令不可用 → 返回 null（不退回提示词，免得发一次注定失败的生成）',
			(await regen.regenerate('融合', 'image', undefined, ['https://x/a.png'])) === null,
		);
		off3b();

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
	// ⚠️ 先排空**上一段遗留的去抖写盘**再清存储（见 drainPersistTimers）：
	// 不排空的话这一节读到的是上一段的画布 —— main 上就有这个偶发（约 1/10）。
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
		args: '--ratio 16:9 --ref https://cdn.example.com/ref.png 一只胖乎乎的肥鱼',
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
	check(
		'命令行的 --ref 落到节点上（命令这条路连事后打开页面也记得住）',
		JSON.stringify(pending.references) === '["https://cdn.example.com/ref.png"]',
		JSON.stringify(pending.references),
	);

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
		'命令成功后参考图仍在（终态节点上还看得到当时参考了哪张）',
		JSON.stringify(ready?.references) === '["https://cdn.example.com/ref.png"]',
		JSON.stringify(ready?.references),
	);
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

// ─────────────── 8. 画布按工作区分隔（一个工作区一块画布） ───────────────

console.log('\n8) 画布按工作区分隔');

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
	const WS_ONE = 'D:\\agent文件目录\\a画布\\泳装';
	const WS_TWO = 'D:\\agent文件目录\\a画布\\视频';
	const keyOf = (ws) => `fatfish-canvas:board:${ws}`;
	const nodeOf = (id, x = 0, sessionId) => ({
		id,
		kind: 'image',
		x,
		y: 0,
		w: 100,
		h: 100,
		status: 'ready',
		...(sessionId === undefined ? {} : { sessionId }),
	});

	check(
		'作用域 → 存储键：null 是所有工作区共用那块，字符串是那个工作区自己的键',
		store.boardKeyFor(null) === GLOBAL && store.boardKeyFor(WS_ONE) === keyOf(WS_ONE),
		`${store.boardKeyFor(null)} / ${store.boardKeyFor(WS_ONE)}`,
	);
	check(
		'默认作用域是共用（启动时还不知道在哪个工作区）',
		store.getBoardScope() === null && store.getBoardKey() === GLOBAL,
		String(store.getBoardScope()),
	);
	check(
		'作用域偏好默认 workspace（一个工作区一块画布）',
		state.getBoardScopeMode() === 'workspace',
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

	store.setBoardScope(WS_ONE);
	check(
		'切到工作区：画布是空的（换键本身不搬运，靠拆分送内容）',
		store.getBoard().nodes.length === 0,
		`实际 ${String(store.getBoard().nodes.length)}`,
	);
	check('切换后当前键跟着换', store.getBoardKey() === keyOf(WS_ONE), store.getBoardKey());
	store.addNode(nodeOf('a1'));
	store.flushPersist();

	store.setBoardScope(null);
	check(
		'切回共用：全局画布的节点还在（切换不丢东西）',
		store.getBoard().nodes.length === 1 && store.getBoard().nodes[0].id === 'g1',
		JSON.stringify(store.getBoard().nodes.map((n) => n.id)),
	);
	check(
		'两边的内容没有混：工作区的节点不在共用画布里',
		store.getBoard().nodes.every((n) => n.id !== 'a1'),
	);
	check(
		'切回来时共用画布被写回全局键（旧内容没被新内容顶掉）',
		String(storage.get(GLOBAL)).includes('"g1"'),
	);

	store.setBoardScope(WS_ONE);
	check(
		'切回工作区：它自己的节点也在',
		store.getBoard().nodes.length === 1 && store.getBoard().nodes[0].id === 'a1',
		JSON.stringify(store.getBoard().nodes.map((n) => n.id)),
	);

	// ── 8.2 记账账本随作用域独立（「不重放」的前提） ──
	check(
		'工作区那块的账本里没有别的画布的记账',
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
	store.setBoardScope(WS_ONE);
	check(
		'再切回工作区：它自己的记账还在（因此历史生成不会被重放）',
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

	// ── 8.4 拆分：共用那块按「节点是哪个会话生成的」送到各自的工作区 ──
	await drainPersistTimers();
	storage.clear();
	const store2 = await loadTsModule(storePath); // 新实例：键与内存都从零开始
	store2.addNode(nodeOf('one', 0, 'sess-1'));
	store2.addNode(nodeOf('two', 4000, 'sess-2'));
	store2.addNode(nodeOf('orphan', 200));
	store2.markIngested(['gen_one']);
	store2.flushPersist();
	const lookup = (sessionId) =>
		sessionId === 'sess-1' ? WS_ONE : sessionId === 'sess-2' ? WS_TWO : undefined;
	const split = () =>
		store2.rehomeSharedBoard((node) =>
			node.sessionId === undefined ? null : (lookup(node.sessionId) ?? null),
		);
	const moved = split();
	check(
		'拆分：按节点记的会话送回各自工作区，认不出的留下',
		moved.moved === 2 && moved.kept === 1,
		JSON.stringify(moved),
	);
	check(
		'工作区一那块写着它自己的节点',
		String(storage.get(keyOf(WS_ONE))).includes('"one"'),
		String(storage.get(keyOf(WS_ONE))).slice(0, 80),
	);
	check(
		'工作区二那块写着它自己的节点（拆分是全局动作，不只拆当前那个）',
		String(storage.get(keyOf(WS_TWO))).includes('"two"'),
		String(storage.get(keyOf(WS_TWO))).slice(0, 80),
	);
	check(
		'认不出会话的节点留在共用那块（宁可留在原地，也不猜一个工作区）',
		!String(storage.get(keyOf(WS_ONE))).includes('"orphan"') &&
			String(storage.get(GLOBAL)).includes('"orphan"'),
	);
	check(
		'共用那块一个字节都不动（它是全部内容的备份）',
		['"one"', '"two"', '"orphan"'].every((id) => String(storage.get(GLOBAL)).includes(id)),
	);
	check(
		'拆分把记账账本一起带过去（否则刚落的节点会被「最近结果补落」重放）',
		String(storage.get(keyOf(WS_ONE))).includes('gen_one'),
		String(storage.get(keyOf(WS_ONE))).slice(0, 80),
	);
	const twoBoard = JSON.parse(String(storage.get(keyOf(WS_TWO))));
	check(
		'拆到一块空画布上时视口对准这批节点（不是停在世界原点看一片空白）',
		twoBoard.viewport.x === 3960 && twoBoard.viewport.y === -40 && twoBoard.viewport.zoom === 1,
		JSON.stringify(twoBoard.viewport),
	);
	const before = String(storage.get(keyOf(WS_ONE)));
	split();
	check('拆分是幂等的：再拆一遍不会多出节点', String(storage.get(keyOf(WS_ONE))) === before);
	store2.setBoardScope(WS_ONE);
	check(
		'切到该工作区就能看到刚拆过去的节点，且**没有**别的工作区的节点',
		JSON.stringify(store2.getBoard().nodes.map((n) => n.id)) === '["one"]',
		JSON.stringify(store2.getBoard().nodes.map((n) => n.id)),
	);
	storage.clear();
}

{
	// ── 8.5 策略层：偏好 × 当前会话的工作区 → 作用域 ──
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

	const WS_ONE = 'D:\\ws\\one';
	const WS_TWO = 'D:\\ws\\two';
	const GLOBAL = 'fatfish-canvas:board';
	const keyOf = (ws) => `fatfish-canvas:board:${ws}`;
	const nodeOf = (id, sessionId) => ({
		id,
		kind: 'image',
		x: 0,
		y: 0,
		w: 100,
		h: 100,
		status: 'ready',
		...(sessionId === undefined ? {} : { sessionId }),
	});
	scope.setWorkspaceLookup((sessionId) =>
		sessionId === 'sess-a' || sessionId === 'sess-a2'
			? WS_ONE
			: sessionId === 'sess-b'
				? WS_TWO
				: undefined,
	);

	// 共用那块上先有一堆东西：一个认不出会话的，一个属于「另一个工作区」的会话
	store.addNode(nodeOf('shared-node'));
	store.addNode(nodeOf('b-node', 'sess-b'));
	store.flushPersist();

	scope.setScopeSession('sess-a', WS_ONE);
	check(
		'桥报来工作区：画布立刻落到那个工作区的键上',
		store.getBoardScope() === WS_ONE && store.getBoardKey() === keyOf(WS_ONE),
		`${String(store.getBoardScope())} / ${store.getBoardKey()}`,
	);
	check(
		'作用域快照带上了工作区（工具条 title 用它说明「当前是哪个工作区」）',
		scope.getScopeSnapshot().workspace === WS_ONE && scope.getScopeSnapshot().scope === WS_ONE,
		JSON.stringify(scope.getScopeSnapshot()),
	);
	check(
		'当前工作区那块是空的：认不出会话的节点不跟过来',
		store.getBoard().nodes.length === 0,
		JSON.stringify(store.getBoard().nodes.map((n) => n.id)),
	);
	check(
		'属于别的工作区会话的节点已经被送回**那个**工作区（拆分是全局动作）',
		String(storage.get(keyOf(WS_TWO))).includes('"b-node"'),
		String(storage.get(keyOf(WS_TWO))).slice(0, 80),
	);
	check(
		'共用那块内容原样保留（点回「共用画布」还看得到全部）',
		['"shared-node"', '"b-node"'].every((id) => String(storage.get(GLOBAL)).includes(id)),
	);
	check(
		'默认值不该落盘（用户没选过就不写偏好）',
		storage.get('fatfish-canvas:board-scope') == null,
		String(storage.get('fatfish-canvas:board-scope')),
	);

	// 同一个工作区里换会话：还是同一块画布
	store.addNode(nodeOf('one-node'));
	store.flushPersist();
	scope.setScopeSession('sess-a2', WS_ONE);
	check(
		'同一工作区里换个会话：画布不变（一个工作区共用一块）',
		store.getBoardScope() === WS_ONE &&
			JSON.stringify(store.getBoard().nodes.map((n) => n.id)) === '["one-node"]',
		JSON.stringify(store.getBoard().nodes.map((n) => n.id)),
	);

	// 换到另一个工作区：另一块，互不抄送
	scope.setScopeSession('sess-b', WS_TWO);
	check(
		'换到另一个工作区：拿到它自己的画布（拆过来的节点在），**不会**抄上一个工作区的',
		JSON.stringify(store.getBoard().nodes.map((n) => n.id)) === '["b-node"]',
		JSON.stringify(store.getBoard().nodes.map((n) => n.id)),
	);

	scope.setScopeSession('sess-a', WS_ONE);
	check(
		'切回第一个工作区：它自己的节点还在',
		JSON.stringify(store.getBoard().nodes.map((n) => n.id)) === '["one-node"]',
		JSON.stringify(store.getBoard().nodes.map((n) => n.id)),
	);
	check(
		'另一个工作区那块也各自持久化着',
		String(storage.get(keyOf(WS_TWO))).includes('"b-node"'),
		String(storage.get(keyOf(WS_TWO))).slice(0, 80),
	);

	// 翻开关：回到共用那块（内容原样，别的画布的东西不许混进来）
	state.setBoardScopeMode('shared');
	check(
		'切回共用：看到的是共用那块（认不出的节点 + 别的工作区那个都在）',
		store.getBoardScope() === null &&
			JSON.stringify(store.getBoard().nodes.map((n) => n.id)) === '["shared-node","b-node"]',
		JSON.stringify(store.getBoard().nodes.map((n) => n.id)),
	);
	check(
		'偏好写进 localStorage',
		storage.get('fatfish-canvas:board-scope') === 'shared',
		String(storage.get('fatfish-canvas:board-scope')),
	);
	state.setBoardScopeMode('workspace');
	check(
		'再翻回来：回到当前工作区那块（拆过的东西还在，且没有重复）',
		store.getBoardScope() === WS_ONE &&
			JSON.stringify(store.getBoard().nodes.map((n) => n.id)) === '["one-node"]',
		JSON.stringify(store.getBoard().nodes.map((n) => n.id)),
	);

	// 没有会话时退回共用，而不是记着一块不存在的工作区画布
	scope.setScopeSession(null, null);
	check(
		'认不出工作区（没有会话）：退回共用（scope 为 null，读数显示「共用画布」）',
		scope.getScopeSnapshot().mode === 'workspace' &&
			scope.getScopeSnapshot().scope === null &&
			store.getBoardScope() === null,
		JSON.stringify(scope.getScopeSnapshot()),
	);

	check(
		'重复应用是幂等的（偏好 store 每次变化都会叫醒它）',
		scope.applyBoardScope() === false && scope.applyBoardScope() === false,
	);

	// ── 8.6 启动时按存储的偏好恢复 ──
	off();
	await drainPersistTimers();
	storage.clear();
	// P7 时代留下的 `session`（每个会话一块）读作 `workspace`：同样的意图、更粗的粒度
	storage.set('fatfish-canvas:board-scope', 'session');
	const state2 = await loadTsModule(statePath);
	const scope2 = await loadTsModule(scopePath, new Map([[statePath, { exports: state2 }]]));
	check(
		'老偏好 `session` 读作 `workspace`（升级不该把开关关掉）',
		state2.getBoardScopeMode() === 'workspace',
		state2.getBoardScopeMode(),
	);
	storage.set('fatfish-canvas:board-scope', 'shared');
	const state3 = await loadTsModule(statePath);
	check(
		'明文 `shared` 仍然是共用（用户显式选过的要认）',
		state3.getBoardScopeMode() === 'shared',
		state3.getBoardScopeMode(),
	);
	check(
		'重启时还没有会话 → 先停在共用那块上，不炸也不清空',
		scope2.getScopeSnapshot().scope === null && scope2.applyBoardScope() === false,
		JSON.stringify(scope2.getScopeSnapshot()),
	);
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
				// ⚠️ 真实 File 的 BlobPart 可以是 Blob（它只有 `size`，没有 length/byteLength）
				// —— 替身少认一种形状就会把「字节数」算成 0（P32 实测踩到一次）
				this.size = parts.reduce((sum, p) => sum + (p.size ?? p.length ?? p.byteLength ?? 0), 0);
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

// ─────────────────── 11. P27：背景点阵与导出归档 ───────────────────

console.log('11) 背景点阵与导出归档');

{
	// 判据：点阵与节点层必须**共用同一套**视口变换 —— 世界坐标上「整数格」的点，
	// 必须落在「背景原点 + 整数格」。写错符号（背景往反方向跑）或漏乘 zoom 都会挂。
	const vp = { x: 37.5, y: -12.25, zoom: 0.4 };
	const grid = model.gridOf(vp);
	const step = grid.size / vp.zoom;
	const screen = model.toScreen({ x: 2 * step, y: 3 * step }, vp);
	check(
		'点阵与节点层共用同一套视口变换',
		Math.abs(screen.x - (grid.x + 2 * grid.size)) < 1e-9 &&
			Math.abs(screen.y - (grid.y + 3 * grid.size)) < 1e-9,
		`screen=${JSON.stringify(screen)} grid=${JSON.stringify(grid)}`,
	);
	check(
		'背景原点就是世界原点在屏幕上的位置',
		grid.x === model.toScreen({ x: 0, y: 0 }, vp).x && grid.y === model.toScreen({ x: 0, y: 0 }, vp).y,
		`${String(grid.x)},${String(grid.y)}`,
	);

	const at1 = model.gridOf({ x: -100, y: 60, zoom: 1 });
	check(
		'zoom=1 时一格 24px、原点跟着平移走',
		at1.size === model.GRID_STEP && at1.x === 100 && at1.y === -60,
		JSON.stringify(at1),
	);

	// 屏幕上的格距不能太密（否则缩到 10% 时点阵糊成一片灰），且只能是 24 的 2 的幂倍
	// （不是整数倍就会与节点错位）。
	for (const zoom of [model.ZOOM_MIN, 0.3, 1, 4, model.ZOOM_MAX]) {
		const g = model.gridOf({ x: 0, y: 0, zoom });
		// 浮点：`size / zoom / 24` 会带出 8.000000000000002 这种尾巴，先取整再判
		const factor = Math.round(g.size / zoom / model.GRID_STEP);
		check(
			`zoom=${String(zoom)}：格距 ≥12px 且是世界格距的 2 的幂倍`,
			g.size >= 12 - 1e-9 && (factor & (factor - 1)) === 0,
			`screen=${g.size.toFixed(2)} factor=${String(factor)}`,
		);
	}

	check('点的半径两头夹住（太小看不见、太大成麻子）', model.gridOf({ x: 0, y: 0, zoom: 0.1 }).dot === 0.5 && model.gridOf({ x: 0, y: 0, zoom: 10 }).dot === 2, '');
}

{
	// zip：自己写的 STORE 写入器。这里**逐字节解析回来**，而不是只看函数返回了东西。
	const enc = new TextEncoder();
	check('crc32 已知值（"hello"）', zip.crc32(enc.encode('hello')) === 0x3610a686, `0x${zip.crc32(enc.encode('hello')).toString(16)}`);
	check('crc32 空数据为 0', zip.crc32(new Uint8Array(0)) === 0);

	const files = [
		{ name: 'a.png', bytes: enc.encode('AAAA'), mime: 'image/png' },
		{ name: '中文 标题.png', bytes: new Uint8Array([0, 1, 2, 255]), mime: 'image/png' },
	];
	const out = zip.zipStore(files);
	const view = new DataView(out.buffer);
	const eocd = out.length - 22;
	check(
		'EOCD 签名 / 条目数正确',
		view.getUint32(eocd, true) === 0x06054b50 && view.getUint16(eocd + 10, true) === 2,
		`sig=0x${view.getUint32(eocd, true).toString(16)}`,
	);

	const decoder = new TextDecoder();
	const entries = [];
	let at = view.getUint32(eocd + 16, true);
	for (let i = 0; i < view.getUint16(eocd + 10, true); i += 1) {
		const nameLen = view.getUint16(at + 28, true);
		const localAt = view.getUint32(at + 42, true);
		const size = view.getUint32(at + 24, true);
		const dataAt = localAt + 30 + view.getUint16(localAt + 26, true);
		entries.push({
			name: decoder.decode(out.subarray(at + 46, at + 46 + nameLen)),
			flags: view.getUint16(at + 8, true),
			method: view.getUint16(at + 10, true),
			crc: view.getUint32(at + 16, true),
			bytes: out.subarray(dataAt, dataAt + size),
			localSig: view.getUint32(localAt, true),
		});
		at += 46 + nameLen;
	}
	check('中央目录长度与偏移自洽（走完刚好接上 EOCD）', at === eocd, `at=${String(at)} eocd=${String(eocd)}`);
	check(
		'两条条目的名字与字节都还原得回来',
		entries.length === 2 &&
			entries[0].name === 'a.png' &&
			decoder.decode(entries[0].bytes) === 'AAAA' &&
			entries[1].name === '中文 标题.png' &&
			entries[1].bytes.length === 4 &&
			entries[1].bytes[3] === 255,
		JSON.stringify(entries.map((e) => e.name)),
	);
	check(
		'本地头签名正确 / STORE / CRC 落在条目上',
		entries.every((e) => e.localSig === 0x04034b50 && e.method === 0 && e.crc === zip.crc32(e.bytes)),
		JSON.stringify(entries.map((e) => e.method)),
	);
	check(
		'文件名置了 UTF-8 位（不置中文解压出来就是乱码）',
		entries.every((e) => (e.flags & 0x800) !== 0),
		String(entries[1].flags),
	);

	check(
		'safeName 去掉路径分隔符等非法字符',
		zip.safeName('a/b:c*d?e"f<g>h|i', 'x', 'png') === 'a_b_c_d_e_f_g_h_i.png',
		zip.safeName('a/b:c*d?e"f<g>h|i', 'x', 'png'),
	);
	check('safeName 空标题退回默认名', zip.safeName('   ', '画布图-01', 'jpg') === '画布图-01.jpg', zip.safeName('   ', '画布图-01', 'jpg'));
	check('safeName 不把已有的图片后缀接成 .png.png', zip.safeName('cat.png', 'x', 'png') === 'cat.png', zip.safeName('cat.png', 'x', 'png'));
	check(
		// 导出改成复合（图 + 视频）之后才会踩到：视频标题自带 .mp4，老的正则只剥图片后缀
		'safeName 也不把视频后缀接成 .mp4.mp4',
		zip.safeName('海边.mp4', '画布视频-01', 'mp4') === '海边.mp4' &&
			zip.safeName('海边.MOV', 'x', 'mov') === '海边.mov',
		zip.safeName('海边.mp4', '画布视频-01', 'mp4'),
	);
	check(
		'extOf 认识视频的 MIME（导出靠它定后缀，quicktime 要落成 .mov）',
		zip.extOf('video/mp4') === 'mp4' &&
			zip.extOf('video/quicktime') === 'mov' &&
			zip.extOf('video/x-matroska') === 'mkv',
		`${zip.extOf('video/mp4')} / ${zip.extOf('video/quicktime')}`,
	);
	check(
		'safeName 截断长提示词',
		zip.safeName('画一只在雨里打伞的鲸鱼并且要赛博朋克风格细节丰富', 'x', 'png').length <= 24 + 4,
		zip.safeName('画一只在雨里打伞的鲸鱼并且要赛博朋克风格细节丰富', 'x', 'png'),
	);
	const used = new Set();
	check(
		'uniqueName 重名加序号（一个 zip 里两条同名会让解压工具打架）',
		zip.uniqueName('a.png', used) === 'a.png' &&
			zip.uniqueName('a.png', used) === 'a-2.png' &&
			zip.uniqueName('a.png', used) === 'a-3.png',
		[...used].join(','),
	);
}

{
	// 远程取图：宿主方法的返回值**装在信封里**（RemoteResult），必须先拆。
	// 不拆的症状：宿主明明取到了图，页面说「取图失败」（P27 导出压缩包就这么炸的）。
	const probeLib = await loadTsModule(resolve(root, 'src/client/shared/probe.ts'));

	const envelope = (value) => ({ ok: true, value });
	const okImage = { ok: true, message: '已取到图片（700 KB）', dataUrl: 'data:image/jpeg;base64,QUJD', mimeType: 'image/jpeg', name: 'a.jpg' };

	check(
		'信封成功分支：拆出 dataUrl / mimeType / name（**不是**读外层字段）',
		(() => {
			const got = probeLib.unwrapFetchedImage(envelope(okImage));
			return got.ok === true && got.dataUrl === okImage.dataUrl && got.mimeType === 'image/jpeg' && got.name === 'a.jpg';
		})(),
		JSON.stringify(probeLib.unwrapFetchedImage(envelope(okImage))),
	);
	check(
		'信封失败分支：带出 RemoteError 的 message（载体失败 ≠ 业务失败）',
		(() => {
			const got = probeLib.unwrapFetchedImage({ ok: false, error: { code: 'unmounted', message: '方法没挂上' } });
			return got.ok === false && got.message === '方法没挂上';
		})(),
		JSON.stringify(probeLib.unwrapFetchedImage({ ok: false, error: { message: '方法没挂上' } })),
	);
	check(
		'业务失败：宿主那句原因原样带出来（HTTP 403 / 太大 / 不是图片）',
		(() => {
			const got = probeLib.unwrapFetchedImage(envelope({ ok: false, message: '取图失败：HTTP 403' }));
			return got.ok === false && got.message === '取图失败：HTTP 403';
		})(),
	);
	check(
		'裸值也认（万一以后有人把宿主方法直接挂上来，判断不分叉）',
		(() => {
			const got = probeLib.unwrapFetchedImage(okImage);
			return got.ok === true && got.dataUrl === okImage.dataUrl;
		})(),
	);
	check(
		'形状不对时不炸、给一句可读的话（值缺失 / 不是对象）',
		probeLib.unwrapFetchedImage(envelope(undefined)).ok === false &&
			probeLib.unwrapFetchedImage(null).ok === false &&
			probeLib.unwrapFetchedImage(envelope({ ok: true, message: 'ok' })).ok === false,
	);

	// 结构守卫：取字节的两个调用点都必须走 client/index 的包装（信封只在那里拆一次）。
	// 这条能抓住的正是 P27 的真 bug —— 调用点自己读 remote 结果的字段。
	// 两边走的方法**故意不同**：附件那条只收图（fetchImageViaHost），
	// 导出那条还收视频（fetchMediaViaHost，见 host/probe.ts 的 fetchBytes）。
	const callSites = [
		['src/client/canvas/exportImages.ts', 'fetchMediaViaHost'],
		['src/client/canvas/CanvasStage.tsx', 'fetchImageViaHost'],
	];
	for (const [rel, helper] of callSites) {
		const source = await readFile(resolve(root, rel), 'utf8');
		const direct = /probe\.(fetchImage|fetchMedia)\(/.test(source);
		check(
			`${rel} 走 ${helper}（不在调用点自己拆信封）`,
			source.includes(`${helper}(`) && !direct,
			direct ? '有直连 probe.* 的调用' : `没调用 ${helper}`,
		);
	}
}

// ─────────────────── P46：复合导出的计数文案 ───────────────────

console.log('\nP46) 复合导出（图 + 视频）');

{
	// 导出的条目文案（点之前）与结论（点之后）要说同一句话 —— 判据抽成纯函数，
	// 写歪的症状是「菜单说导出 2 张，结果导出了 3 项」。
	const nodes = [
		{ kind: 'image' },
		{ kind: 'video' },
		{ kind: 'image' },
	];
	check(
		'mediaCounts 按节点种类数图与视频（文字节点不计）',
		JSON.stringify(model.mediaCounts(nodes)) === '{"image":2,"video":1}' &&
			JSON.stringify(model.mediaCounts([{ kind: 'text' }])) === '{"image":0,"video":0}',
		JSON.stringify(model.mediaCounts(nodes)),
	);
	check(
		'mediaCountsText 三种说法：只有图 / 只有视频 / 混在一起',
		model.mediaCountsText({ image: 3, video: 0 }) === '3 张' &&
			model.mediaCountsText({ image: 0, video: 2 }) === '2 个视频' &&
			model.mediaCountsText({ image: 2, video: 1 }) === '2 图 + 1 视频',
		`${model.mediaCountsText({ image: 3, video: 0 })} / ${model.mediaCountsText({ image: 0, video: 2 })} / ${model.mediaCountsText({ image: 2, video: 1 })}`,
	);
}

// ─────────────────── P32：一键复制（图 + 文字） ───────────────────
//
// 这一节锁的是「复制（含图）」那三个纯函数与写剪贴板的两条通路。
// 值得钉住的原因：拆块判据必须与本体气泡**完全一致**（界面上看得见图、
// 复制出来却没有，是最难解释的一类 bug），而剪贴板那条路一旦退化成
// 只写纯文本，用户拿到的是「看起来成功了、图没了」。

console.log('\nP32) 一键复制（图 + 文字）');

{
	const copy = await loadTsModule(resolve(root, 'src/client/chat/messageCopy.ts'));

	// ① 拆块：与本体 contentParts 同一条判据
	const parts = copy.copyPartsOf([
		{ type: 'text', text: '第一段' },
		{ type: 'image', attachment: { attachmentId: 'sha256:aa', name: 'a.png' } },
		{ type: 'text', text: '第二段' },
		{ type: 'image' },
		{ type: 'image', attachment: { name: '没有 id' } },
		{ type: 'file', attachment: { name: 'x.pdf' } },
		{ type: 'tool-result', content: [] },
	]);
	check(
		'拆块：文字按顺序拼接、图片按顺序收集',
		parts.text === '第一段第二段' && parts.images.length === 1 && parts.images[0].name === 'a.png',
		JSON.stringify({ text: parts.text, images: parts.images.length }),
	);
	check(
		'拆块：没有 attachmentId 的 image 块被丢掉（否则会拿一个取不到的句柄去取图）',
		parts.images.length === 1,
	);
	check(
		'拆块：文件附件只留名字；认不出的块进 rest（不静默丢）',
		// `{type:'image'}`（没有 attachment）与 tool-result 都算「认不出」——
		// 本体 contentParts 也是这么分的（它的 else 分支就是 rest）。
		parts.fileNames.length === 1 && parts.fileNames[0] === 'x.pdf' && parts.rest.length === 2,
		JSON.stringify({ files: parts.fileNames, rest: parts.rest.length }),
	);
	check(
		'拆块：content 不是数组时给空结果（不炸）',
		copy.copyPartsOf(undefined).text === '' && copy.copyPartsOf('nope').images.length === 0,
	);

	// ② 富文本：用户文字必须转义（这是唯一一个注入面）
	const html = copy.buildCopyHtml('<b>hi</b>\n第二行', [{ dataUrl: 'data:image/png;base64,AAA', name: 'a&b.png' }], ['x.pdf']);
	check(
		'HTML：用户文字被转义、换行变 <br>',
		html.includes('&lt;b&gt;hi&lt;/b&gt;<br>第二行') && !html.includes('<b>hi</b>'),
		html,
	);
	check(
		'HTML：图内联成 data: 进 <img>，附件名也带上',
		html.includes('<img src="data:image/png;base64,AAA"') && html.includes('[附件] x.pdf'),
		html,
	);

	// ③ 内联：一张失败不中断、peek 命中就不调异步、超上限的图不尝试
	const seen = [];
	const loader = Object.assign(async (attachment) => `blob:${String(attachment.attachmentId)}`, {
		peek: (attachment) => (attachment.attachmentId === 'sha256:cached' ? 'blob:cached' : undefined),
	});
	globalThis.fetch = async (url) => {
		seen.push(String(url));
		if (String(url) === 'blob:sha256:bad') throw new Error('取不到');
		// ⚠️ 替身必须给 `ok`：真实 Response 一定有它，而 `fetchAsDataUrl` 会先看它
		// （少这一项时所有图都会被判成失败 —— 测试替身比被测代码更简单，是失真的一种）
		return { ok: true, blob: async () => ({ size: 3, type: 'image/png' }) };
	};
	globalThis.FileReader = class {
		/** @param {string} text - 造出来的内联数据。 */
		constructor() {
			this.result = 'data:image/png;base64,QUFB';
		}
		/** 触发一次成功的读取。 */
		readAsDataURL() {
			this.onload?.();
		}
	};
	const inline = await copy.inlineImages(
		[
			{ attachment: { attachmentId: 'sha256:ok' }, name: 'ok.png' },
			{ attachment: { attachmentId: 'sha256:bad' }, name: 'bad.png' },
			{ attachment: { attachmentId: 'sha256:cached' }, name: 'cached.png' },
		],
		loader,
	);
	check(
		'内联：成功的按顺序留下、失败的只计数（不中断整批）',
		inline.images.length === 2 && inline.failed === 1 && inline.images[0].name === 'ok.png',
		JSON.stringify({ got: inline.images.length, failed: inline.failed }),
	);
	check(
		'内联：peek 命中时不走异步取 URL（缓存就是省这一次往返）',
		seen.includes('blob:cached'),
		JSON.stringify(seen),
	);
	check(
		'内联：超过体积上限的图**不尝试**（只记账），不把页面卡死',
		await copy
			.inlineImages(
				[
					{ attachment: { attachmentId: 'sha256:ok' }, name: 'ok.png' },
					{ attachment: { attachmentId: 'sha256:ok2' }, name: 'ok2.png' },
				],
				loader,
				0,
			)
			.then((got) => got.images.length === 0 && got.skipped === 2 && got.failed === 0),
	);

	// ④ 写剪贴板：两条通路
	//
	// ⚠️ `globalThis.navigator` 在 Node 24 里是**只有 getter 的**内置属性，
	// 直接赋值会抛 `Cannot set property navigator`，必须 defineProperty。
	const writes = [];
	const setGlobal = (name, value) => {
		Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
	};
	setGlobal(
		'ClipboardItem',
		class {
			/** @param {Record<string, unknown>} types - 各类型的载荷。 */
			constructor(types) {
				this.types = types;
			}
		},
	);
	setGlobal('navigator', {
		clipboard: {
			write: async (items) => {
				writes.push(items[0].types);
			},
			writeText: async (text) => {
				writes.push({ text });
			},
		},
	});
	check(
		'剪贴板：富文本写入成功时返回 null（没有失败说明）',
		(await copy.writeClipboardRich('纯文本', '<div>富文本</div>')) === null,
	);
	check(
		'剪贴板：一次写入里同时有 text/html 与 text/plain（图与字都带得走）',
		writes.length === 1 && 'text/html' in writes[0] && 'text/plain' in writes[0],
		JSON.stringify(Object.keys(writes[0] ?? {})),
	);

	writes.length = 0;
	setGlobal('navigator', { clipboard: { writeText: async (text) => writes.push({ text }) } });
	const degraded = await copy.writeClipboardRich('纯文本', '<div>富文本</div>');
	check(
		'剪贴板：没有 clipboard.write 时退回纯文本（至少文字不丢，且说明退化了）',
		writes.length === 1 && writes[0].text === '纯文本' && typeof degraded === 'string',
		JSON.stringify({ writes, degraded }),
	);

	// ④b 失败要**带真实原因**（上一版吞掉异常，用户只看到一句我猜的「浏览器不允许」）
	writes.length = 0;
	setGlobal('navigator', {
		clipboard: {
			write: async () => {
				throw new Error('Support for multiple ClipboardItems is not implemented.');
			},
			writeText: async () => {
				throw new Error('Document is not focused.');
			},
		},
	});
	const reason = await copy.writeClipboardRich('纯文本', '<div>富文本</div>');
	check(
		'剪贴板：失败时把真实异常带出来（不是「浏览器不允许」这种猜的文案）',
		typeof reason === 'string' && reason.includes('Document is not focused'),
		String(reason),
	);
	// 把替身换回「写得进去」：下面几节还要走成功的路（替身泄漏过一次就会一路红）
	setGlobal('navigator', {
		clipboard: {
			write: async (items) => {
				writes.push(items[0].types);
			},
			writeText: async (text) => {
				writes.push({ text });
			},
		},
	});

	// ⑤ 整条消息：没图时不该报「取图失败」
	const outcome = await copy.copyMessageWithImages(
		{ text: '只有文字', images: [], fileNames: [], rest: [] },
		undefined,
	);
	check(
		'整条消息：纯文字消息复制成功，且不报图片相关的错',
		outcome.ok === true && outcome.message.includes('已复制'),
		JSON.stringify(outcome),
	);
	const empty = await copy.copyMessageWithImages({ text: '', images: [], fileNames: [], rest: [] }, undefined);
	check('整条消息：空消息给出可读的拒绝，而不是静默成功', empty.ok === false, JSON.stringify(empty));

	// ⑥ 「送到输入框」：DSH 那条路（**不经过剪贴板**）
	//
	// 判据来自用户实测 + 无头 Chrome 探针：DSH 的粘贴面只认文件 item，而 Chrome
	// **不支持一次写多个 ClipboardItem**（`Support for multiple ClipboardItems is
	// not implemented.`），系统剪贴板又只能放一张图 —— 所以 DSH 那条改成合成 drop。
	// 这里钉的是「真的把图当成附件派发进输入框、文字也插进去了」。
	const dropped = [];
	const inserted = [];
	const editor = {
		isContentEditable: true,
		focus: () => {},
		// findComposer 用它挑「可见的那一份」（hero 与会话态会各留一棵 DOM）
		getBoundingClientRect: () => ({ width: 100, height: 40, top: 0, left: 0 }),
		dispatchEvent: (event) => {
			dropped.push(event);
			return true;
		},
	};
	setGlobal('document', {
		activeElement: editor,
		execCommand: (name, _ui, text) => {
			inserted.push({ name, text });
			return true;
		},
		querySelectorAll: () => [editor],
	});
	setGlobal(
		'DataTransfer',
		class {
			constructor() {
				this.items = { add: () => {} };
				this.files = [];
				this.types = ['Files'];
			}
		},
	);
	setGlobal(
		'DragEvent',
		class {
			constructor(type, init) {
				this.type = type;
				this.dataTransfer = init?.dataTransfer;
			}
		},
	);
	setGlobal(
		'File',
		class {
			constructor(parts, name, opts) {
				this.name = name;
				this.type = opts?.type;
				this.size = parts.reduce((sum, p) => sum + (p.size ?? p.length ?? 0), 0);
			}
		},
	);
	setGlobal('fetch', async () => ({ ok: true, blob: async () => new Blob([new Uint8Array([1, 2])], { type: 'image/png' }) }));
	const sent = await copy.sendMessageToComposerOutcome(
		{
			text: '正文',
			images: [
				{ attachment: { attachmentId: 'sha256:ok' }, name: 'a.png' },
				{ attachment: { attachmentId: 'sha256:ok2' }, name: '' },
			],
			fileNames: [],
			rest: [],
		},
		loader,
	);
	check(
		'送到输入框：两张图各派发一次合成 drop（**张数不限**，剪贴板那条只能带一张）',
		dropped.length === 2 && dropped.every((event) => event.type === 'drop' && event.dataTransfer?.types.includes('Files')),
		`drops=${String(dropped.length)}`,
	);
	check(
		'送到输入框：文字插进了输入框（落在附件后面）',
		inserted.length === 1 && inserted[0].text === '正文',
		JSON.stringify(inserted),
	);
	check(
		'送到输入框：结论如实报「送了几张图 + 文字」',
		sent.ok === true && sent.message.includes('2 张图') && sent.message.includes('文字'),
		sent.message,
	);

	const noImages = await copy.sendMessageToComposerOutcome({ text: '只有字', images: [], fileNames: [], rest: [] }, loader);
	check(
		'送到输入框：没图时照样能用（纯文字消息也送得进去）',
		noImages.ok === true && noImages.message.includes('文字'),
		noImages.message,
	);

	// ⑦ 结构守卫：影子席位必须带 priority -1
	//
	// 不带的话注册会**抛**（keyed 席位同 key 同优先级 = already has an entry），
	// 那会让整个客户端插件的 apply 失败 —— 一条优先级数值值得钉一下。
	const indexSource = await readFile(resolve(root, 'src/client/index.tsx'), 'utf8');
	check(
		'影子席位：conversation.chat.node 的 user 条目带 priority: -1',
		/conversation\.chat\.node[\s\S]{0,200}?key:\s*'user'[\s\S]{0,80}?priority:\s*-1/.test(indexSource),
		indexSource.includes("key: 'user'") ? '有 user 键但没有 priority: -1' : '没有 user 键',
	);
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
