/**
 * 导出「带工作流的 PNG」—— 本模块是整个 P18 里**唯一有副作用**的一处。
 *
 * 三步：拿到字节 → 必要时转成 PNG → 写 tEXt → 触发下载。
 *
 * 为什么要转码：供应商回的常常是 jpg / webp（`fetchImage` 拿到的 MIME 会告诉我们），
 * 而元数据只有 PNG 的 tEXt 一条通路（见 `pngmeta.ts` 的取舍）。转码是
 * 「解码后再用 PNG 无损存一遍」，像素不变、体积变大。
 *
 * @module fatfish-canvas/client/canvas/exportImage
 */

import { getProbeFace } from '../index';
import { unwrapProbeResult } from '../shared/probe';
import type { CanvasNode } from './model';
import { isPng, writePngText } from './pngmeta';
import { getBoard } from './store';
import { serializeWorkflow, WORKFLOW_KEY } from './workflow';

/** 一段媒体字节与它的 MIME。 */
interface MediaBytes {
	bytes: Uint8Array;
	mime: string;
}

/**
 * base64 → 字节。
 * @param base64 - base64 文本。
 * @returns 字节。
 */
function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i) & 0xff;
	return out;
}

/**
 * 解析一个 data URL。
 * @param dataUrl - `data:<mime>;base64,<数据>`。
 * @returns 字节与 MIME；不是 base64 的 data URL 时 null。
 */
function decodeDataUrl(dataUrl: string): MediaBytes | null {
	const comma = dataUrl.indexOf(',');
	if (comma < 0 || !dataUrl.startsWith('data:')) return null;
	const header = dataUrl.slice(5, comma);
	if (!header.includes(';base64')) return null;
	const mime = header.split(';')[0] ?? 'application/octet-stream';
	try {
		return { bytes: base64ToBytes(dataUrl.slice(comma + 1)), mime };
	} catch {
		return null;
	}
}

/**
 * 取一个节点的媒体字节。
 *
 * `http(s)` 走宿主代取（跨域由它解决，与「送进聊天框」那条路共用同一个探测面）；
 * `data:` 直接在手上解。`blob:` 取不到 —— 它是浏览器进程内的地址，宿主拿不着。
 * @param src - 媒体地址。
 * @returns 字节；取不到时 null。
 */
async function bytesOf(src: string): Promise<MediaBytes | null> {
	if (src.startsWith('data:')) return decodeDataUrl(src);
	if (!/^https?:\/\//i.test(src)) return null;
	const probe = getProbeFace();
	if (probe === undefined) return null;
	try {
		// 远程面回的是信封，先拆（不拆永远拿不到 dataUrl → 导出只会静默失败）
		const answer = unwrapProbeResult<{ ok?: boolean; dataUrl?: string; mimeType?: string }>(
			await probe.fetchImage(src),
		);
		if (!answer.ok) return null;
		const raw = answer.value;
		if (raw === undefined || raw.ok !== true || typeof raw.dataUrl !== 'string') return null;
		const decoded = decodeDataUrl(raw.dataUrl);
		if (decoded === null) return null;
		return { bytes: decoded.bytes, mime: raw.mimeType ?? decoded.mime };
	} catch {
		return null;
	}
}

/**
 * 不是 PNG 就解码后重新用 PNG 存一遍。
 * @param media - 原始字节。
 * @returns PNG 字节。
 * @throws 浏览器解不开这个格式时抛错（错误文案可直接展示）。
 */
async function toPng(media: MediaBytes): Promise<Uint8Array> {
	if (isPng(media.bytes)) return media.bytes;
	const blob = new Blob([media.bytes as unknown as BlobPart], { type: media.mime });
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(blob);
	} catch {
		throw new Error('这个格式浏览器解不开，导出不了带工作流的 PNG');
	}
	const canvas = document.createElement('canvas');
	canvas.width = bitmap.width;
	canvas.height = bitmap.height;
	const context = canvas.getContext('2d');
	if (context === null) throw new Error('取不到 2D 画布，导出不了');
	context.drawImage(bitmap, 0, 0);
	bitmap.close();
	const png = await new Promise<Blob | null>((resolve) => {
		canvas.toBlob(resolve, 'image/png');
	});
	if (png === null) throw new Error('转成 PNG 失败');
	return new Uint8Array(await png.arrayBuffer());
}

/**
 * 触发浏览器下载。
 * @param bytes - PNG 字节。
 * @param name - 文件名。
 */
function download(bytes: Uint8Array, name: string): void {
	const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: 'image/png' }));
	const link = document.createElement('a');
	link.href = url;
	link.download = name;
	document.body.appendChild(link);
	link.click();
	link.remove();
	// 立刻 revoke 会让部分浏览器来不及取到内容，放到下一轮事件循环
	setTimeout(() => {
		URL.revokeObjectURL(url);
	}, 0);
}

/** 导出文件名（标题太长就截断，非法字符一律换掉）。 */
function fileNameFor(node: CanvasNode): string {
	const base = (node.title ?? node.prompt ?? '').trim().slice(0, 24).replace(/[\\/:*?"<>|\s]+/g, '-');
	const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
	return `${base === '' ? 'fatfish-canvas' : base}-${stamp}.png`;
}

/**
 * 把整块画布的工作流写进这张图的 PNG 里并下载。
 *
 * 导出的是**整块画布**而不是「这个节点所在的子图」：画布就是工作流，
 * 而用户导出时想要的多半是「把现在这一屏存下来，回头能原样恢复」。
 * @param node - 从哪个节点导出（用它的媒体字节与标题）。
 * @returns 给用户看的一句话。
 * @throws 取不到字节 / 转码失败时抛错（文案可直接展示）。
 */
export async function exportWorkflowPng(node: CanvasNode): Promise<string> {
	const src = node.src;
	if (src === undefined || src === '') throw new Error('这个节点还没有图像');
	const media = await bytesOf(src);
	if (media === null) {
		throw new Error('取不到这张图的字节（本地临时地址宿主读不到，或图超过 8MB）');
	}
	const png = await toPng(media);
	const board = getBoard();
	const withMeta = writePngText(png, {
		[WORKFLOW_KEY]: serializeWorkflow(board.nodes, board.links),
	});
	download(withMeta, fileNameFor(node));
	return '已导出带工作流的 PNG（拖回画布即可还原）';
}
