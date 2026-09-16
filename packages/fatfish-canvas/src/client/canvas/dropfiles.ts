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

import { mediaNodeSize } from '../shared/media';
import { dropLayout, toWorld } from './model';
import { addNodes, getBoard } from './store';

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
 * 读一个图片文件并量出它的尺寸。
 * @param file - 图片文件。
 * @returns 可直接落成节点的素材；读不出来时为 null。
 */
async function loadImage(
	file: File,
): Promise<{ file: File; src: string; size: { w: number; h: number } } | null> {
	const src = await readAsDataUrl(file);
	if (src === '') return null;
	const pixels = await measure(src);
	return {
		file,
		src,
		size: mediaNodeSize({
			kind: 'image',
			...(pixels === null ? {} : { width: pixels.w, height: pixels.h }),
		}),
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
	addNodes(
		items.map((item, index) => ({
			kind: 'image' as const,
			status: 'ready' as const,
			src: item.src,
			title: item.file.name === '' ? '拖入的图片' : item.file.name,
			...item.size,
			...(spots[index] ?? anchor),
		})),
	);
	// 拖进来的东西落点由用户决定，跟焦只会把视野抢走 —— `addNodes` 只选中它们，
	// 不带过去（这正是想要的行为）。
}

/**
 * 装上画布的拖放接管。
 *
 * 用捕获阶段（`capture: true`）：本体的附件 drop 在 document 的 bubble 阶段，
 * 捕获阶段跑在它前面，`stopPropagation` 之后它收不到事件。
 * @returns 卸载函数。
 */
export function installCanvasDrop(): () => void {
	if (typeof document === 'undefined') return () => {};

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
	};
}
