/**
 * 「复制这条消息（含图）」的全部逻辑 —— 聊天用户消息上那两个按钮。
 *
 * ## 两条出口，因为「拿去用」有两种去处
 *
 *   1. **富文本复制**（`writeClipboardRich`）：`text/html`（图内联成 `data:`）+
 *      `text/plain`。微信 / 飞书 / Notion / 备忘录这类**富文本编辑器**吃这一套，
 *      粘过去图与字都在（用户实测微信正常 ✅）。
 *   2. **送到输入框**（`sendMessageToComposer`）：文字插进聊天输入框、每张图经
 *      平台的附件管线变成**真附件**（合成 drop，与「点画布图 → 送进聊天框」同一条路）。
 *      这是**给 DSH 自己用的**那一条。
 *
 * ## 为什么 DSH 那条不走剪贴板（P32 实测，别再试第二次）
 *
 * 本体的粘贴处理器（`dsh-client-ui-conversation` 的 `PASTE_COMMAND`）只收
 * `clipboardData.items` 里 `kind === 'file'` 的那些 —— 所以「图 + 字」要能粘进 DSH，
 * 图必须以**图片文件**的形式躺在剪贴板上。而这条路被浏览器堵死了两道：
 *
 *   - **Chrome 不支持一次写多个 ClipboardItem**（实测报错原文：
 *     `NotAllowedError: Support for multiple ClipboardItems is not implemented.`），
 *     因此「一个文字项 + 每张图一个图片项」这种写法必然抛；
 *   - 就算合成**一个** item（`{ 'text/plain': …, 'image/png': … }`），系统剪贴板
 *     也只能放**一张**图 —— 一条消息常常有好几张。
 *
 * 于是 DSH 那条改成**不经过剪贴板**：直接把文字插进输入框、把图按附件送进去
 * （`client/dom.ts` 的 `attachImageToComposer` 复用平台自己的附件管线）。
 * 顺带还更好：**张数不限、动图不会被拍成静帧**。
 *
 * ## 图片字节从哪来
 *
 * 消息里的图是**持久附件引用**（`{ attachmentId, mediaType, … }`），浏览器要拿
 * 到可显示的 URL 只能经本体的 `loadImage(attachment)`（`uiConversation.imageUrl`，
 * 会话作用域、带缓存）。拿到 URL（blob: 或同源路由）后再 `fetch` 一次读字节 ——
 * 内联进 HTML 的必须是自包含数据，否则粘出去就是一堆死链。
 *
 * 纯函数部分可以在无浏览器环境下单测（见 `scripts/test-model.mjs`）。
 *
 * @module fatfish-canvas/client/chat/messageCopy
 */

import { attachImageToComposer, blobToDataUrl, fetchBlob, insertIntoComposer } from '../dom';

/** 一个持久图片附件（本模块只用到这几个字段）。 */
export interface MessageAttachment {
	/** 内容寻址的存储标识。 */
	attachmentId?: unknown;
	/** 展示名。 */
	name?: unknown;
	/** 尺寸（本体拿它排版，这里不读，留着以免类型断言时丢字段）。 */
	[key: string]: unknown;
}

/** 一条消息里的一张图。 */
export interface MessageImage {
	/** 持久附件引用（原样交给 `loadImage`）。 */
	attachment: MessageAttachment;
	/** 展示名（alt 与失败提示里用）。 */
	name: string;
}

/** 一条消息拆开后的样子。 */
export interface CopyParts {
	/** 全部文字块拼起来（与本体气泡显示的一致）。 */
	text: string;
	/** 图片附件（按出现顺序）。 */
	images: MessageImage[];
	/** 文件附件的展示名（图之外的附件，只报名字）。 */
	fileNames: string[];
	/** 其余内容块（本体渲染成 JSON 卡片的那类；这里原样留着，不静默丢）。 */
	rest: unknown[];
}

/** 空结果（没有内容时复用）。 */
const EMPTY_PARTS: CopyParts = { text: '', images: [], fileNames: [], rest: [] };

/** 读一个非空字符串。 */
function textOf(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

/**
 * 把一条消息的 `content` 拆成「文字 / 图片 / 文件 / 其余」。
 *
 * 与本体 `MessageItem` 的 `contentParts` **同一条判据**（`type` 认块，
 * 图片必须有 `attachment`）：两处判断不一致的话，界面上看得见图、
 * 复制出来却没有，是最难解释的一类 bug。
 * @param content - `node.data.content`（任意类型，逐块校验）。
 * @returns 拆开后的四类内容。
 */
export function copyPartsOf(content: unknown): CopyParts {
	if (!Array.isArray(content)) return EMPTY_PARTS;
	const texts: string[] = [];
	const images: MessageImage[] = [];
	const fileNames: string[] = [];
	const rest: unknown[] = [];

	for (const block of content) {
		if (block === null || typeof block !== 'object') continue;
		const typed = block as { type?: unknown; text?: unknown; attachment?: unknown };
		if (typed.type === 'text') {
			texts.push(textOf(typed.text));
			continue;
		}
		if (typed.type === 'image' && typed.attachment !== null && typeof typed.attachment === 'object') {
			const attachment = typed.attachment as MessageAttachment;
			if (typeof attachment.attachmentId !== 'string' || attachment.attachmentId === '') continue;
			images.push({ attachment, name: textOf(attachment.name) });
			continue;
		}
		if (typed.type === 'file' && typed.attachment !== null && typeof typed.attachment === 'object') {
			const name = textOf((typed.attachment as MessageAttachment).name);
			fileNames.push(name === '' ? '附件' : name);
			continue;
		}
		rest.push(block);
	}

	return { text: texts.join(''), images, fileNames, rest };
}

/** HTML 转义（用户文字会原样进剪贴板 HTML，不转义就是一个注入面）。 */
export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/** 内联图的体积上限：再多就不是「复制一条消息」，而是往剪贴板里塞一个相册。 */
export const COPY_MAX_INLINE_BYTES = 32 * 1024 * 1024;

/**
 * 拼出要写进剪贴板的富文本。
 *
 * 只用最朴素的结构（`<p>` + `<img>`）：粘贴目标五花八门，越简单越容易活下来。
 * @param text - 消息文字。
 * @param images - 已内联的图（`dataUrl` 与展示名，按顺序）。
 * @param fileNames - 图之外的文件附件名（粘出去时至少留下名字）。
 * @returns HTML 字符串。
 */
export function buildCopyHtml(
	text: string,
	images: readonly { dataUrl: string; name: string }[],
	fileNames: readonly string[] = [],
): string {
	const parts: string[] = [];
	if (text !== '') parts.push(`<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`);
	for (const image of images) {
		// dataUrl 由本文件自己生成（前缀已校验），进属性前只挡一次引号
		parts.push(`<p><img src="${image.dataUrl.replace(/"/g, '')}" alt="${escapeHtml(image.name)}"></p>`);
	}
	for (const name of fileNames) parts.push(`<p>[附件] ${escapeHtml(name)}</p>`);
	return `<div>${parts.join('')}</div>`;
}

/** 图片加载面（本体的 `loadImage`：异步取 URL + `peek` 同步读缓存）。 */
export interface ImageLoader {
	/**
	 * 取一张图的显示地址。
	 * @param attachment - 持久附件引用。
	 * @returns 浏览器可用的地址。
	 */
	(attachment: MessageAttachment): Promise<string>;
	/**
	 * 同步读已缓存的地址（没有就返回 undefined）。
	 * @param attachment - 持久附件引用。
	 * @returns 地址或 undefined。
	 */
	peek?: (attachment: MessageAttachment) => string | undefined;
}

/**
 * 把一个可显示的图片地址读成 data URL。
 * @param url - `blob:` / 同源地址。
 * @returns 内联地址；读不到时 null。
 */
async function inlineOne(url: string): Promise<string | null> {
	const blob = await fetchBlob(url);
	return blob === null ? null : await blobToDataUrl(blob);
}

/** 内联一批图的结果。 */
export interface InlineOutcome {
	/** 成功内联的图（按原顺序）。 */
	images: { dataUrl: string; name: string }[];
	/** 取不到的图数（附件已失效 / 太大 / 读盘失败）。 */
	failed: number;
	/** 因为超过体积上限而**没有尝试**的图数。 */
	skipped: number;
}

/**
 * 把消息里的图逐张读成内联数据。
 *
 * 逐张串行：图动辄几兆，并发读只会同时占住几份内存；一张失败**不中断**
 * 其余（能带几张带几张，结论里报个数）。
 * @param images - 消息里的图（按顺序）。
 * @param load - 图片加载面；缺席时全部计为失败。
 * @param maxBytes - 内联总量上限。
 * @returns 内联结果。
 */
export async function inlineImages(
	images: readonly MessageImage[],
	load: ImageLoader | undefined,
	maxBytes: number = COPY_MAX_INLINE_BYTES,
): Promise<InlineOutcome> {
	const out: { dataUrl: string; name: string }[] = [];
	let failed = 0;
	let skipped = 0;
	let bytes = 0;

	for (const image of images) {
		if (load === undefined) {
			failed += 1;
			continue;
		}
		if (bytes >= maxBytes) {
			skipped += 1;
			continue;
		}
		const url = await imageUrlOf(image, load);
		const dataUrl = url === null ? null : await inlineOne(url);
		if (dataUrl === null) {
			failed += 1;
			continue;
		}
		bytes += dataUrl.length;
		out.push({ dataUrl, name: image.name === '' ? '图片' : image.name });
	}
	return { images: out, failed, skipped };
}

/**
 * 取一张图的显示地址（先看本体的同步缓存，再走异步）。
 * @param image - 消息里的一张图。
 * @param load - 图片加载面。
 * @returns 地址；取不到时 null。
 */
async function imageUrlOf(image: MessageImage, load: ImageLoader): Promise<string | null> {
	try {
		const cached = load.peek?.(image.attachment) ?? '';
		if (cached !== '') return cached;
		const url = await load(image.attachment);
		return url === '' ? null : url;
	} catch {
		return null;
	}
}

/**
 * 往剪贴板写「富文本 + 纯文本」。
 *
 * 两条通路：`clipboard.write`（带 `text/html`，这是本功能存在的理由）→
 * `clipboard.writeText`（老浏览器 / 权限被拒时的退路，至少文字不丢）。
 *
 * ⚠️ **一次只能传一个 `ClipboardItem`**：Chrome 实测
 * `Support for multiple ClipboardItems is not implemented.`（P32 的探针结论）。
 * @param text - 纯文本。
 * @param html - 富文本。
 * @returns 成功时 null；失败时一句**带真实原因**的话（别再猜「权限问题」）。
 */
export async function writeClipboardRich(text: string, html: string): Promise<string | null> {
	const clipboard = navigator.clipboard as Clipboard | undefined;
	let richError = '';
	if (clipboard !== undefined && typeof clipboard.write === 'function' && typeof ClipboardItem === 'function') {
		try {
			await clipboard.write([
				new ClipboardItem({
					'text/html': new Blob([html], { type: 'text/html' }),
					'text/plain': new Blob([text], { type: 'text/plain' }),
				}),
			]);
			return null;
		} catch (error) {
			// 把真实异常留着：上一版这里吞掉它，用户只看到一句我猜的「浏览器不允许」，
			// 而真正的原因（多 item 不支持 / 没有焦点）完全不可见
			richError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		}
	}
	if (clipboard !== undefined && typeof clipboard.writeText === 'function') {
		try {
			await clipboard.writeText(text);
			return '浏览器不接受富文本，只写进了纯文本';
		} catch (error) {
			const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
			return `写剪贴板被拒（${reason}）`;
		}
	}
	return richError === '' ? '这个页面没有剪贴板写入面（需要 https / 127.0.0.1）' : `写剪贴板被拒（${richError}）`;
}

/** 一次「送到输入框」的结论。 */
export interface ComposeOutcome {
	/** 成功送进去的图数。 */
	attached: number;
	/** 取不到的图数。 */
	failed: number;
	/** 因为超过体积上限而**没有尝试**的图数。 */
	skipped: number;
	/** 文字是否插进了输入框。 */
	textInserted: boolean;
	/** 图之外的文件附件名（送不进去，只在结论里报个数）。 */
	fileNames: readonly string[];
}

/**
 * 把一条消息送进**聊天输入框**：文字插进去、每张图变成真附件。
 *
 * 这是 DSH 那条路（见文件头：剪贴板那条被浏览器堵死了）。图走平台自己的附件管线
 * ——`attachImageToComposer` 在输入框上派发一次合成 drop，本体收到后照常上传、
 * 照常渲染附件卡片；因此**张数不限**，动图也不会被拍成静帧。
 *
 * 顺序：先送图（drop 会把焦点给输入框），再插文字（落在光标处 = 附件后面）。
 * 一张图失败**不中断**其余，结论里报个数。
 * @param parts - 拆开的消息。
 * @param load - 图片加载面。
 * @param maxBytes - 图片总量上限。
 * @returns 结论。
 */
export async function sendMessageToComposer(
	parts: CopyParts,
	load: ImageLoader | undefined,
	maxBytes: number = COPY_MAX_INLINE_BYTES,
): Promise<ComposeOutcome> {
	let attached = 0;
	let failed = 0;
	let skipped = 0;
	let bytes = 0;

	for (const image of parts.images) {
		if (load === undefined) {
			failed += 1;
			continue;
		}
		if (bytes >= maxBytes) {
			skipped += 1;
			continue;
		}
		const url = await imageUrlOf(image, load);
		const blob = url === null ? null : await fetchBlob(url);
		const dataUrl = blob === null ? null : await blobToDataUrl(blob);
		if (dataUrl === null) {
			failed += 1;
			continue;
		}
		bytes += dataUrl.length;
		// 附件名：用消息里的原名（没有就按序号），扩展名跟着字节的实际 MIME
		const ext = (blob?.type ?? 'image/png').split('/')[1] ?? 'png';
		const base = (image.name === '' ? `图片-${String(attached + 1)}` : image.name).replace(/\.[a-z0-9]+$/i, '');
		const outcome = attachImageToComposer(dataUrl, `${base}.${ext}`);
		if (outcome.kind === 'attached') attached += 1;
		else failed += 1;
	}

	const textInserted = parts.text === '' ? false : insertIntoComposer(parts.text);
	return { attached, failed, skipped, textInserted, fileNames: parts.fileNames };
}

/** 一次复制的结论（直接显示给用户）。 */
export interface CopyOutcome {
	/** 是否写进了剪贴板。 */
	ok: boolean;
	/** 一句话结论。 */
	message: string;
}

/**
 * 复制一条消息（文字 + 图）为**富文本**。
 *
 * 没图时退化成纯文字复制 —— 那时**不该**报「取图失败」，
 * 用户只是复制了一条纯文本消息。
 * @param parts - 拆开的消息。
 * @param load - 图片加载面。
 * @returns 结论。
 */
export async function copyMessageWithImages(
	parts: CopyParts,
	load: ImageLoader | undefined,
): Promise<CopyOutcome> {
	if (parts.text === '' && parts.images.length === 0 && parts.fileNames.length === 0) {
		return { ok: false, message: '这条消息没有可复制的内容' };
	}

	const inline = parts.images.length === 0 ? { images: [], failed: 0, skipped: 0 } : await inlineImages(parts.images, load);
	const html = buildCopyHtml(parts.text, inline.images, parts.fileNames);
	const failure = await writeClipboardRich(parts.text, html);
	if (failure !== null) return { ok: false, message: failure };

	const notes = notesOf(inline.failed, inline.skipped);
	if (inline.images.length === 0 && parts.images.length > 0) return { ok: false, message: `已复制文字，图片没带上（${notes}）` };
	return { ok: true, message: notes === '' ? '已复制（图 + 文字）' : `已复制（图 + 文字，${notes}）` };
}

/**
 * 把一条消息**送到输入框**（DSH 那条路）。
 *
 * 与富文本复制的差别不在「取图」而在「交付」：那边写剪贴板（给微信 / 飞书），
 * 这边把文字插进输入框、把图按附件送进去（见 `sendMessageToComposer`）。
 * @param parts - 拆开的消息。
 * @param load - 图片加载面。
 * @returns 结论。
 */
export async function sendMessageToComposerOutcome(
	parts: CopyParts,
	load: ImageLoader | undefined,
): Promise<CopyOutcome> {
	if (parts.text === '' && parts.images.length === 0 && parts.fileNames.length === 0) {
		return { ok: false, message: '这条消息没有可送的内容' };
	}
	const got = await sendMessageToComposer(parts, load);
	const notes = notesOf(got.failed, got.skipped);
	const files = got.fileNames.length === 0 ? '' : `（${String(got.fileNames.length)} 个文件附件没送，只送了图）`;

	if (got.attached === 0 && !got.textInserted) {
		return { ok: false, message: `没能送进输入框${notes === '' ? '' : `（${notes}）`}` };
	}
	const partsText: string[] = [];
	if (got.attached > 0) partsText.push(`${String(got.attached)} 张图`);
	if (got.textInserted) partsText.push('文字');
	if (got.textInserted && got.attached === 0 && parts.images.length > 0) {
		// 图一张都没进去：说清楚，别让用户以为附件在
		return { ok: false, message: `只送进了文字，图片没进去（${notes}）` };
	}
	return {
		ok: true,
		message: `已送进输入框：${partsText.join(' + ')}${notes === '' ? '' : `（${notes}）`}${files}`,
	};
}

/**
 * 拼一句「取不到的 / 没带的」说明。
 * @param failed - 取不到的图数。
 * @param skipped - 超过上限没尝试的图数。
 * @returns 说明文字；都没有时为空串。
 */
function notesOf(failed: number, skipped: number): string {
	const notes: string[] = [];
	if (failed > 0) notes.push(`${String(failed)} 张取不到`);
	if (skipped > 0) notes.push(`${String(skipped)} 张超过体积上限没带`);
	return notes.join('，');
}
