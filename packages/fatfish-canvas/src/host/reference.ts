/**
 * 参考图句柄 → 供应商能吃的地址（宿主半边）。
 *
 * ## 为什么需要这一层
 *
 * 文本模型**看不见图**：它拿到的只是一串地址（工具参数里的 `reference`、
 * `/generate --ref`、或者用户在输入框里附的那张图）。字节通路必须绕开模型 ——
 * 模型只递句柄，宿主把句柄变成供应商认的载荷：
 *
 *   `http(s)://…`      原样转给供应商（**零下载**；多数网关收 URL）
 *   `data:image/…`     原样转（已经是内联数据）
 *   `sha256:…` / `attachment:…`   持久附件 → `ctx.attachments.readImage()`
 *   其它               当本地文件路径读盘 → data URL（MIME 按**字节头**判，别信扩展名）
 *
 * ## 一条硬规矩：失败就说出来
 *
 * 参考图取不到时**必须抛错**，绝不静默降级成纯文生图 —— 「用户以为参考图生效了、
 * 实际出了一张无关的图」是这条链路上最坏的失败模式。
 *
 * @module fatfish-canvas/host/reference
 */

import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';

/** 一个持久附件引用里本模块用到的字段（`dsh-attachment` 的 `ImageAttachmentRef`）。 */
export interface MediaAttachmentRef {
	/** 内容寻址的存储标识（形如 `sha256:…`）。 */
	attachmentId: string;
	/** 规范化后被校验的 MIME。 */
	mediaType: string;
}

/** 读一个持久附件的字节（由 `ctx.attachments` 接入；服务缺席时不给这个函数）。 */
export type ReadAttachment = (
	ref: MediaAttachmentRef,
	signal?: AbortSignal,
) => Promise<{ data: Uint8Array; mediaType?: string }>;

/** 解析参考图需要的依赖。 */
export interface ReferenceDeps {
	/** 附件读取面（缺席时附件形式的参考图会明确报错）。 */
	readAttachment?: ReadAttachment;
	/** 诊断日志。 */
	log: (message: string) => void;
}

/** 附件句柄的前缀（`attachment:` 与 `sha256:` 两种写法都认）。 */
const ATTACHMENT_PREFIXES = ['attachment:', 'sha256:'];

/** 按字节头判断图片 MIME（扩展名会说谎，字节头不会）。 */
function sniffMime(bytes: Uint8Array): string | undefined {
	const at = (index: number): number => bytes[index] ?? -1;
	if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image/png';
	if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
	if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return 'image/gif';
	if (
		at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 &&
		at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50
	) {
		return 'image/webp';
	}
	return undefined;
}

/**
 * 把字节包成 data URL。
 * @param bytes - 图片字节。
 * @param mediaType - MIME；空或缺席时按字节头推断。
 * @returns `data:` 地址。
 */
function toDataUrl(bytes: Uint8Array, mediaType?: string): string {
	// ponytail: 认不出来的字节头按 png 报。供应商会自己拒绝坏数据并给出可读错误，
	// 比在这里做全格式嗅探便宜得多。
	const mime = mediaType !== undefined && mediaType !== '' ? mediaType : (sniffMime(bytes) ?? 'image/png');
	return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}

/** 把一个附件 id 字符串规范化成附件服务认的引用。 */
function attachmentRefOf(handle: string): MediaAttachmentRef {
	const id = handle.startsWith('attachment:') ? handle.slice('attachment:'.length) : handle;
	return { attachmentId: id, mediaType: '' };
}

/**
 * 解析一个参考图句柄。
 *
 * 句柄有两种形态：**字符串**（URL / 路径 / `attachment:<id>`）与**持久附件引用对象**
 * （命令面拿到的是后者）。对象形态**原样透传**给附件服务 —— 那个引用是会话日志里的
 * 完整记录（含字节数、尺寸），自己重拼一个残缺的只会换来「无效引用」。
 * @param handle - 地址 / 附件引用 / 文件路径。
 * @param deps - 依赖（附件读取面与日志）。
 * @param signal - 取消信号。
 * @returns 可直接放进请求体的地址。
 * @throws 句柄为空、附件面缺席、文件读不到时 —— 文案可直接展示给用户。
 */
export async function resolveReference(
	handle: string | MediaAttachmentRef,
	deps: ReferenceDeps,
	signal?: AbortSignal,
): Promise<string> {
	if (typeof handle !== 'string') return readAttachmentRef(handle, deps, signal);

	const text = handle.trim();
	if (text === '') throw new Error('参考图地址是空的。');

	if (/^https?:\/\//i.test(text) || text.startsWith('data:')) return text;

	if (ATTACHMENT_PREFIXES.some((prefix) => text.startsWith(prefix))) {
		return readAttachmentRef(attachmentRefOf(text), deps, signal);
	}

	// 其余一律当文件路径。相对路径按宿主进程的工作目录（= 会话工作区）解析。
	const path = resolvePath(text);
	let bytes: Uint8Array;
	try {
		bytes = await readFile(path, signal === undefined ? undefined : { signal });
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`读不到参考图文件：${path}（${reason}）`);
	}
	deps.log(`参考图取自本地文件 ${path}（${String(bytes.byteLength)} 字节）`);
	return toDataUrl(bytes);
}

/**
 * 从附件服务取一张参考图并包成 data URL。
 * @param ref - 持久附件引用（原样来自会话日志）。
 * @param deps - 依赖。
 * @param signal - 取消信号。
 * @returns `data:` 地址。
 * @throws 附件面缺席或读取失败时。
 */
async function readAttachmentRef(
	ref: MediaAttachmentRef,
	deps: ReferenceDeps,
	signal?: AbortSignal,
): Promise<string> {
	if (deps.readAttachment === undefined) {
		throw new Error('参考图是这个会话里的图片附件，但宿主没有装配附件服务，读不到它的内容。');
	}
	const stored = await deps.readAttachment(ref, signal);
	deps.log(`参考图取自会话附件（${stored.mediaType ?? ref.mediaType}，${String(stored.data.byteLength)} 字节）`);
	return toDataUrl(stored.data, stored.mediaType);
}

/**
 * 解析一个 `data:` 地址。
 *
 * 抽出来给两处共用：参考图字节（`referenceBytes`）与「把画布上的内联图存成
 * 参考图句柄」（`host/probe.ts` 的 `storeReference`）—— data URL 的格式只有一份
 * 实现，免得两处各自正则、各自漏掉一种写法。
 * @param value - 候选地址。
 * @returns 字节与 MIME；不是 `data:` 或格式不对时 null。
 */
export function decodeDataUrl(value: string): { data: Uint8Array; mediaType: string } | null {
	if (!value.startsWith('data:')) return null;
	const match = /^data:([^;,]*)[^,]*,(.*)$/s.exec(value);
	if (match === null) return null;
	const declared = match[1] ?? '';
	return {
		data: new Uint8Array(Buffer.from(match[2] ?? '', 'base64')),
		// 没写 MIME 的 data URL 按 png 报（与 `toDataUrl` 的兜底一致）
		mediaType: declared === '' ? 'image/png' : declared,
	};
}

/**
 * 取参考图的**字节**（`/images/edits` 这类 multipart 端点要的是文件而不是地址）。
 *
 * `data:` 就地解码；`http(s)` 则下载一次 —— 这一条是真会多一次往返的，所以只在
 * 供应商确实要求上传字节时才走。
 * @param reference - 已解析的参考图地址。
 * @param signal - 取消信号。
 * @returns 字节与 MIME。
 * @throws 地址取不到时。
 */
export async function referenceBytes(
	reference: string,
	signal?: AbortSignal,
): Promise<{ data: Uint8Array; mediaType: string }> {
	const inline = decodeDataUrl(reference);
	if (inline !== null) return inline;

	let response: Response;
	try {
		response = await fetch(reference, signal === undefined ? {} : { signal });
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`下载参考图失败：无法连接 ${reference}（${reason}）`);
	}
	if (!response.ok) {
		throw new Error(`下载参考图失败：HTTP ${String(response.status)}（${reference}）`);
	}
	const buffer = new Uint8Array(await response.arrayBuffer());
	const header = response.headers.get('content-type') ?? '';
	const mediaType = header.split(';')[0]?.trim() ?? '';
	return { data: buffer, mediaType: mediaType === '' ? 'image/png' : mediaType };
}
