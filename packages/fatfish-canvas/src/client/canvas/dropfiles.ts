/**
 * 画布上的「从屏幕外拖进来的文件」→ 画布节点。
 *
 * 为什么需要它：本体的附件插件把 `drop` 挂在 **document** 上（bubble 阶段）——
 * 文件只要落在页面任何地方都会被塞进聊天输入框，画布自然也逃不掉。
 * 画布用户把图拖进来时想要的显然是「放进画布」，所以这里在**捕获阶段**先动手：
 * 目标是画布就拦下来（`stopPropagation` 让 document 上那个监听器根本收不到），
 * 目标是聊天区就什么都不做，原样交给本体。
 *
 * 只做本地文件（`dataTransfer.files`）：
 *   - 图片 → data URL → 画布节点（持久化跟着画布走，刷新还在）
 *   - 其它文件 → 不拦，交回本体的附件通路（画布没有能表达「文件」的节点）
 *
 * @module fatfish-canvas/client/canvas/dropfiles
 */

import { isReferenceHandle, mediaNodeSize } from '../shared/media';
import { unwrapProbeResult } from '../shared/probe';
import { dropLayout, toWorld } from './model';
import { pushNotice } from './notice';
import { readPngText } from './pngmeta';
import { addNodes, getBoard, updateNodes } from './store';
import { parseWorkflow } from './workflow';

/**
 * 宿主探测面里本模块用到的那一条（把内联图存成参考图句柄，见 `host/probe.ts`）。
 *
 * 刻意**注入**而不是 `import { getProbeFace } from '../index'`：
 * 那样会把 `index.tsx`（JSX、整个插件体）拖进这个纯逻辑模块 —— 离线测试里
 * `ts.transpileModule` 不转 JSX，一加载就炸；顺带还多一个循环 import。
 * 与 `regenerate.ts` 的 `setRegenerateTarget` 是同一个套路。
 */
export interface ReferenceStore {
	/** 把 `data:` 内联图存成宿主句柄。 */
	storeReference(dataUrl: string): Promise<unknown>;
}

/** 当前注入的参考图存储面取法（由 `installCanvasDrop` 接上）。 */
let referenceStoreOf: (() => ReferenceStore | undefined) | undefined;

/**
 * 判断这次拖拽该不该由画布接管。
 *
 * 抽成纯函数是为了能离线测：真实事件流（dragenter → dragover → drop）在浏览器里
 * 很难复现，而「落在谁头上」这个判据才是最容易写错的地方 —— 写反了就会把
 * 拖到聊天区的文件抢进画布（比不生效更糟）。
 *
 * 只要落在画布上就接管，**不分文件类型**：非图片文件画布确实落不了节点，
 * 但也不能漏给本体 —— 否则指针在画布上时本体会亮起整屏「松手即加入对话」的遮罩，
 * 用户松手后图却进了聊天框，正是要修的那个毛病。
 *
 * ⚠️ **但聊天输入区例外**（`overComposer`）。本体的附件 `drop` 挂在 `document`
 * 的**冒泡阶段**，而本模块挂在**捕获阶段**并会 `stopPropagation()` —— 于是
 * 我自己派发的那个「把画布图片变成附件」的合成 drop，会被**我自己的捕获闸**
 * 拦死在半路（它落在 composer 上，而 composer 在视觉上确实位于画布面板之上）。
 * 症状就是：点图片只插进一行地址，附件永远出不来。
 * @param overCanvas - 事件目标是否位于画布面板内。
 * @param overComposer - 事件目标是否位于聊天输入区内（那一块归本体附件管线）。
 * @returns 是否接管。
 */
export function shouldClaimDrop(overCanvas: boolean, overComposer = false): boolean {
	return overCanvas && !overComposer;
}

/** 落点判据：拖拽目标是否落在画布面板里。 */
function canvasUnder(target: EventTarget | null): HTMLElement | null {
	if (!(target instanceof HTMLElement)) return null;
	return target.closest('.ffc-panel');
}

/**
 * 是否落在聊天输入区（composer / 可编辑区 / 附件轨）。
 * @param target - 事件目标。
 * @returns 是否属于聊天输入区。
 */
function composerUnder(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	return (
		target.closest('[class*="composer"], [class*="Composer"]') !== null ||
		target.closest('[contenteditable="true"]') !== null
	);
}

/**
 * 把一条 `drag*` 事件在捕获阶段截住（如果它落在画布上）。
 * @param event - 拖拽事件。
 * @returns 是否已被画布接管。
 */
function claimDragEvent(event: DragEvent): boolean {
	if (!shouldClaimDrop(canvasUnder(event.target) !== null, composerUnder(event.target))) return false;
	// 一定要 preventDefault：否则浏览器既不给 drop 事件，本体的
	// DropOverlay 也会因为 document 上的 dragover 而亮起来（用户会看到
	// 「拖进聊天」的整屏提示，尽管指针在画布上）。
	event.preventDefault();
	event.stopPropagation();
	return true;
}

/** 读一个文件为 data URL。 */
function readAsDataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			resolve(typeof reader.result === 'string' ? reader.result : '');
		};
		reader.onerror = () => {
			reject(reader.error ?? new Error('读取文件失败'));
		};
		reader.readAsDataURL(file);
	});
}

/** 量出图片的像素尺寸（量不出来时返回 null，落点退回按文件类型猜的默认形状）。 */
function measure(url: string): Promise<{ w: number; h: number } | null> {
	return new Promise((resolve) => {
		const probe = new Image();
		probe.onload = () => {
			resolve({ w: probe.naturalWidth, h: probe.naturalHeight });
		};
		probe.onerror = () => {
			resolve(null);
		};
		probe.src = url;
	});
}

/**
 * 一个图片文件里自带的工作流块。
 *
 * 三种结果都要分清楚，因为用户看到的话完全不同：
 *   `ours`    本插件导出的 → 提示可以还原
 *   `foreign` 有 `workflow` 块但不是我们的（真 ComfyUI 导出的）→ 如实说还原不了
 *   `null`    没有这个块 → 什么都不说
 */
type WorkflowProbe = { kind: 'ours'; text: string } | { kind: 'foreign' } | null;

/**
 * 从文件字节里探工作流块。
 *
 * 只读 PNG 的 tEXt（ComfyUI 与我们自己都写在那里）；读不出来就当没有 ——
 * 「拖一张图进来」本身是完全正常且必须成功的操作，探元数据失败不能连累它。
 * @param file - 图片文件。
 * @returns 探测结果。
 */
async function probeWorkflow(file: File): Promise<WorkflowProbe> {
	try {
		const text = readPngText(new Uint8Array(await file.arrayBuffer())).workflow;
		if (text === undefined) return null;
		return parseWorkflow(text) === null ? { kind: 'foreign' } : { kind: 'ours', text };
	} catch {
		return null;
	}
}

/**
 * 读一个图片文件并量出它的尺寸。
 * @param file - 图片文件。
 * @returns 可直接落成节点的素材；读不出来时为 null。
 */
async function loadImage(
	file: File,
): Promise<{
	file: File;
	src: string;
	size: { w: number; h: number };
	workflow: WorkflowProbe;
}> {
	const src = await readAsDataUrl(file);
	if (src === '') throw new Error('读不出这个文件');
	const pixels = await measure(src);
	return {
		file,
		src,
		size: mediaNodeSize({
			kind: 'image',
			...(pixels === null ? {} : { width: pixels.w, height: pixels.h }),
		}),
		workflow: await probeWorkflow(file),
	};
}

/**
 * 把**一批**图片文件落到画布上。
 *
 * 关键是「一批」而不是「一张一张地落」：整个文件夹拖进来时，每张图各算各的落点
 * 会让它们全部叠在指针那一点上（用户只看得见最后一张）—— 因此这里先全部读进内存，
 * 再按 `dropLayout` 算出一片互不重叠的网格，最后**一次** `addNodes` 落位、一次选中。
 * 第一张仍以拖放点为中心（松手的位置就是它），其余向右、向下铺开。
 * @param files - 图片文件（按拖入顺序）。
 * @param at - 画布视口内的屏幕坐标（松手的位置）。
 */
async function dropImages(files: readonly File[], at: { x: number; y: number }): Promise<void> {
	const loaded = await Promise.all(
		files.map((file) =>
			loadImage(file).catch(() => null), // 单张读失败不影响这一批里其余的
		),
	);
	const items = loaded.filter((item): item is NonNullable<typeof item> => item !== null);
	const first = items[0];
	if (first === undefined) return;

	const center = toWorld(at, getBoard().viewport);
	const anchor = {
		x: Math.round(center.x - first.size.w / 2),
		y: Math.round(center.y - first.size.h / 2),
	};
	const spots = dropLayout(
		anchor,
		items.map((item) => item.size),
	);
	const created = addNodes(
		items.map((item, index) => ({
			kind: 'image' as const,
			status: 'ready' as const,
			src: item.src,
			title: item.file.name === '' ? '拖入的图片' : item.file.name,
			...item.size,
			...(spots[index] ?? anchor),
			// 自带工作流的图把文档一起存到节点上：右键就能还原（见 NodeMenu）
			...(item.workflow?.kind === 'ours' ? { workflow: item.workflow.text } : {}),
		})),
	);

	// 检测到工作流要说一声 —— 不然用户根本不知道这张图「能还原」。
	// 不自动还原：那会把用户手上的画布直接换掉。
	const ours = items.filter((item) => item.workflow?.kind === 'ours').length;
	const foreign = items.filter((item) => item.workflow?.kind === 'foreign').length;
	if (ours > 0) pushNotice('检测到工作流：右键这张图 →「还原工作流」');
	else if (foreign > 0) pushNotice('这张图带的是 ComfyUI 的工作流，本版本还不能还原');
	// 拖进来的东西落点由用户决定，跟焦只会把视野抢走 —— `addNodes` 只选中它们，
	// 不带过去（这正是想要的行为）。

	// P22：顺手请宿主把这些内联图存成**参考图句柄**。不这么做的话，本地拖进来的图
	// 连不上生成节点 —— 几兆的 data: URL 塞不进 `/generate --ref` 那一行。
	void attachReferenceHandles(created.map((node) => node.id));
}

/**
 * 请宿主把内联图存成参考图句柄（P22），并把句柄写回节点。
 *
 * 三条刻意的做法：
 * 1. **在落图之后异步做**（不阻塞拖放）：拖进来的图必须立刻出现，存句柄是加分项；
 * 2. **只处理塞不进命令行的那些**（`isReferenceHandle` 判否）：http 地址本来就够短；
 * 3. **失败要说一声**：不说的话，用户会在连参考图时撞上一句「重新拖一次」，
 *    而真正的原因（格式不支持 / 图太大）已经在这一刻发生了。
 *
 * 第二处调用点是**连线被拒的那一刻**（`CanvasStage` 的 `linkAfterStoringReference`）：
 * 落图那一刻是唯一的时机会漏掉两类节点 —— 供应商内联返回的生成结果、刷新前就在画布
 * 上的老节点，它们都到不了这里（那时用户只会看到「重新拖进画布一次」，而重拖不可能）。
 * @param ids - 目标节点 id。
 * @returns 是否已经把**具体原因**推给用户（调用方据此避免用泛泛的判定理由盖掉它）。
 */
export async function attachReferenceHandles(ids: readonly string[]): Promise<boolean> {
	// **取的时候才解析**：宿主探测面是 `$mount` 之后才出现的派生服务，
	// 装拖放的那一刻它常常还没就绪（装早了会永远拿到 undefined）。
	const probe = referenceStoreOf?.();
	// 还没就绪：什么都别做，也别说 —— 连线那一刻还会再试一次（`CanvasStage`）。
	if (probe === undefined) return false;
	let problem = '';
	for (const id of ids) {
		const node = getBoard().nodes.find((item) => item.id === id);
		if (node === undefined || node.ref !== undefined) continue;
		const src = node.src ?? '';
		if (!src.startsWith('data:') || isReferenceHandle(src)) continue;
		try {
			// 远程面回的是**信封**（`{ok,value}`），不是宿主方法自己的结果对象 ——
			// 不拆信封就永远拿到 undefined：句柄写不上，用户只看到连线被拒。
			const answer = unwrapProbeResult<{ ok?: boolean; message?: string; ref?: string }>(
				await probe.storeReference(src),
			);
			if (!answer.ok) {
				problem = answer.message;
				continue;
			}
			const result = answer.value;
			if (result !== undefined && result.ok === true && typeof result.ref === 'string' && result.ref !== '') {
				updateNodes([id], { ref: result.ref });
			} else if (result !== undefined && typeof result.message === 'string') {
				problem = result.message;
			} else {
				// 回话既不是成功也不是「一句原因」——例如宿主返回了半截对象。
				// 这里**不能**沉默：调用方会据此以为「没出事」，用户则只会看到连线被拒。
				problem = '宿主没有回话（存参考图这件事没成功），先刷新页面或重启 dsh web 再试';
			}
		} catch (error) {
			problem = error instanceof Error ? error.message : String(error);
		}
	}
	if (problem !== '') pushNotice(problem);
	return problem !== '';
}

/**
 * 接上宿主的参考图存储面（P22）。
 *
 * 单独开一个口子而不是只藏在 `installCanvasDrop` 里：装上拖放需要 `document`，
 * 而这条接线本身与 DOM 无关 —— 离线测试直接调这个就能验「落图之后请宿主存句柄」。
 * @param getStore - 取服务面的函数；传 undefined 表示摘掉。
 * @returns 撤销函数（只会清掉自己装上的那个）。
 */
export function setReferenceStore(
	getStore: (() => ReferenceStore | undefined) | undefined,
): () => void {
	referenceStoreOf = getStore;
	return () => {
		if (referenceStoreOf === getStore) referenceStoreOf = undefined;
	};
}

/**
 * 装上画布的拖放接管。
 *
 * 用捕获阶段（`capture: true`）：本体的附件 drop 在 document 的 bubble 阶段，
 * 捕获阶段跑在它前面，`stopPropagation` 之后它收不到事件。
 * @param getStore - 取宿主参考图存储面（`() => getProbeFace()`）；未就绪时返回 undefined。
 * @returns 卸载函数。
 */
export function installCanvasDrop(getStore?: () => ReferenceStore | undefined): () => void {
	const uninstall = setReferenceStore(getStore);
	if (typeof document === 'undefined') return uninstall;

	const onDragOver = (event: DragEvent): void => {
		claimDragEvent(event);
	};

	const onDrop = (event: DragEvent): void => {
		if (!claimDragEvent(event)) return;
		const files = [...(event.dataTransfer?.files ?? [])].filter((file) =>
			file.type.startsWith('image/'),
		);
		if (files.length === 0) return; // 非图片：已 claim，直接丢弃（画布表达不了「文件」）
		const panel = canvasUnder(event.target);
		const rect = panel?.getBoundingClientRect();
		const at = {
			x: rect === undefined ? event.clientX : event.clientX - rect.left,
			y: rect === undefined ? event.clientY : event.clientY - rect.top,
		};
		void dropImages(files, at).catch(() => {
			/* 读失败就什么都不做：用户看得见画布没变化，胜过弹一个错误框 */
		});
	};

	// enter/over 都要拦：只拦 drop 的话，拖拽经过画布时本体仍会亮起
	// 「松手即加入对话」的整屏遮罩。
	document.addEventListener('dragenter', onDragOver, true);
	document.addEventListener('dragover', onDragOver, true);
	document.addEventListener('drop', onDrop, true);
	return () => {
		document.removeEventListener('dragenter', onDragOver, true);
		document.removeEventListener('dragover', onDragOver, true);
		document.removeEventListener('drop', onDrop, true);
		uninstall();
	};
}
