/**
 * 生成结果的**本地留档**（宿主半边，P32）。
 *
 * ## 为什么需要它
 *
 * 供应商（尤其是中转站）回的是一个**会过期的对象存储地址**（签名 URL，
 * 常见 24 小时～几天）。此前插件把那个地址原样交给聊天与画布，于是「图放久了
 * 加载不出来」——不是浏览器缓存问题，是**源头那个地址死了**，本地从来没有过字节。
 *
 * 留档就是在生成成功的那一刻把字节抓下来写进用户指定的目录，并把结果地址换成
 * 本机路由（{@link ARCHIVE_ROUTE_PREFIX}）。之后聊天、画布、导出、参考图全都
 * 指向本地文件：既不会过期，也不再依赖供应商还活着。
 *
 * ## 三条硬规矩
 *
 * 1. **留档失败绝不打断生成**：图已经出来了，写不进盘只是「这次没留档」——
 *    返回值里带上原因，工具回执会说明，而不是把一次成功的生成变成失败。
 * 2. **只在配了目录时工作**（空 = 关）。默认关着：用户的磁盘由用户决定。
 * 3. **路由只服务这一个目录**：请求路径解析回来必须落在归档根里
 *    （{@link archivePathOf} 是纯函数，越界一律 null），并且要过浏览器连接的
 *    鉴权闸门（Host/Origin 栅栏 + 会话 cookie）。
 *
 * @module fatfish-canvas/host/archive
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { MEDIA_ROUTE_PREFIX } from '../client/shared/media';

/**
 * 归档文件的公开地址前缀。
 *
 * 值住在共享模块里（客户端也要按同一个前缀认地址，见 `isReferenceHandle`）；
 * 这里只是本模块内的短名字。
 */
export const ARCHIVE_ROUTE_PREFIX = MEDIA_ROUTE_PREFIX;

/**
 * 单次留档的体积上限。
 *
 * ponytail: 一个够大的常量，不分图像 / 视频。升级路径：按 kind 分别设限
 * （视频要留的量级完全不同），真有人撞到再说。
 */
export const ARCHIVE_MAX_BYTES = 256 * 1024 * 1024;

/** 一次留档的输入。 */
export interface ArchiveInput {
	/** 供应商给的地址（`http(s):` 或 `data:`）。 */
	url: string;
	/** 媒体种类（`image` / `video`）。 */
	kind: string;
	/** 供应商声明的 MIME（有就用它定扩展名）。 */
	mimeType?: string | undefined;
	/** 模型 id（进文件名，方便肉眼找）。 */
	model?: string | undefined;
	/** 落盘时刻（毫秒）；测试注入用。 */
	at?: number | undefined;
	/** 文件名里的随机段；测试注入用。 */
	salt?: string | undefined;
}

/** MIME → 扩展名。 */
const EXT_BY_MIME: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/webp': 'webp',
	'image/gif': 'gif',
	'image/avif': 'avif',
	'image/bmp': 'bmp',
	'video/mp4': 'mp4',
	'video/webm': 'webm',
	'video/quicktime': 'mov',
};

/** 扩展名 → 回给浏览器的 MIME。 */
const MIME_BY_EXT: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	webp: 'image/webp',
	gif: 'image/gif',
	avif: 'image/avif',
	bmp: 'image/bmp',
	mp4: 'video/mp4',
	webm: 'video/webm',
	mov: 'video/quicktime',
};

/**
 * 由 MIME 与地址推一个扩展名。
 *
 * 顺序是「供应商说的 MIME → 地址里的后缀 → 按种类兜底」：中转站常常回
 * `application/octet-stream`，那时地址后缀更可信；两者都没有就按种类给一个
 * 常见值（浏览器按 content-type 播，不靠扩展名）。
 * @param mimeType - 供应商声明的 MIME。
 * @param url - 原始地址。
 * @param kind - 媒体种类。
 * @returns 不含点的扩展名。
 */
export function extensionFor(mimeType: string | undefined, url: string, kind: string): string {
	const mime = (mimeType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
	const byMime = EXT_BY_MIME[mime];
	if (byMime !== undefined) return byMime;

	const match = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(url);
	const byUrl = match?.[1]?.toLowerCase();
	if (byUrl !== undefined && MIME_BY_EXT[byUrl] !== undefined) return byUrl;

	return kind === 'video' ? 'mp4' : 'png';
}

/** 文件名里不许出现的字符（Windows 更严，按它来）。 */
function slug(value: string): string {
	const clean = value
		.replace(/[\\/:*?"<>|]/g, '-')
		.replace(/[\u0000-\u001f\u007f]/g, '')
		.trim()
		.slice(0, 40);
	return clean === '' || clean === '.' || clean === '..' ? 'media' : clean;
}

/**
 * 推出归档文件的**相对路径**（纯函数）。
 *
 * 形状：`<yyyy-MM-dd>/<HHmmss>-<模型>-<随机>.<ext>`。按日期分目录是为了让
 * 「用了一年」的目录仍然能一眼翻；随机段是**同一秒内出多张**时不互相覆盖。
 * @param input - 留档输入。
 * @returns 相对路径（分隔符固定为 `/`）。
 */
export function archiveRelPath(input: ArchiveInput): string {
	const at = new Date(input.at ?? Date.now());
	const pad = (value: number): string => String(value).padStart(2, '0');
	const day = `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
	const clock = `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
	const salt = (input.salt ?? Math.random().toString(16).slice(2, 6)).replace(/[^a-z0-9]/gi, '').slice(0, 4);
	const ext = extensionFor(input.mimeType, input.url, input.kind);
	return `${day}/${clock}-${slug(input.model ?? input.kind)}-${salt === '' ? 'x' : salt}.${ext}`;
}

/**
 * 相对路径 → 浏览器地址（纯函数）。
 * @param rel - 归档相对路径。
 * @returns 同源相对地址。
 */
export function archiveUrl(rel: string): string {
	return `${ARCHIVE_ROUTE_PREFIX}/${rel}`;
}

/**
 * 把请求路径解析回**归档根里的绝对路径**（纯函数）。
 *
 * 越界（`..`、绝对路径、其它前缀）一律 null —— 这条路由只服务归档目录，
 * 不能变成「读本机任意文件」的入口。
 * @param root - 归档根目录（绝对路径）。
 * @param pathname - 请求的 pathname。
 * @returns 绝对路径；不是本路由的合法目标时为 null。
 */
export function archivePathOf(root: string, pathname: string): string | null {
	if (!pathname.startsWith(`${ARCHIVE_ROUTE_PREFIX}/`)) return null;
	let rel: string;
	try {
		rel = decodeURIComponent(pathname.slice(ARCHIVE_ROUTE_PREFIX.length + 1));
	} catch {
		return null;
	}
	if (rel === '' || rel.includes('\0')) return null;
	// 反斜杠在 URL 里是普通字符，但 Windows 上它是分隔符 —— 先统一挡掉，
	// 否则 `..\..\x` 会绕过下面的前缀检查。
	if (rel.includes('\\')) return null;
	const full = resolve(root, rel);
	const base = resolve(root);
	if (full !== base && !full.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)) return null;
	return full;
}

/** 一个地址的字节与 MIME。 */
interface FetchedBytes {
	bytes: Uint8Array;
	mimeType?: string | undefined;
}

/** 取字节的结论：要么拿到，要么一句原因。 */
type FetchOutcome = { ok: true; value: FetchedBytes } | { ok: false; error: string };

/**
 * 取一次生成结果的字节（`data:` 就地解码，`http(s):` 下载一次）。
 * @param url - 结果地址。
 * @param signal - 取消信号。
 * @returns 字节或原因。
 */
export async function fetchMediaBytes(url: string, signal?: AbortSignal): Promise<FetchOutcome> {
	if (url.startsWith('data:')) {
		const match = /^data:([^;,]*)[^,]*,(.*)$/s.exec(url);
		if (match === null) return { ok: false, error: '内联数据解析不了' };
		const bytes = new Uint8Array(Buffer.from(match[2] ?? '', 'base64'));
		return { ok: true, value: { bytes, mimeType: match[1] === '' ? undefined : match[1] } };
	}
	if (!/^https?:\/\//i.test(url)) return { ok: false, error: '这个地址不是 http(s) 也不是 data:' };

	let response: Response;
	try {
		response = await fetch(url, signal === undefined ? {} : { signal });
	} catch (error) {
		return { ok: false, error: `下载失败：${error instanceof Error ? error.message : String(error)}` };
	}
	if (!response.ok) return { ok: false, error: `下载失败：HTTP ${String(response.status)}` };

	const declared = Number(response.headers.get('content-length') ?? '');
	if (Number.isFinite(declared) && declared > ARCHIVE_MAX_BYTES) {
		return { ok: false, error: `文件太大（${(declared / 1024 / 1024).toFixed(1)} MB）` };
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength > ARCHIVE_MAX_BYTES) {
		return { ok: false, error: `文件太大（${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB）` };
	}
	const mime = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
	return { ok: true, value: { bytes, mimeType: mime === '' ? undefined : mime } };
}

/** 一次留档的结论。 */
export type ArchiveOutcome =
	| { ok: true; rel: string; url: string; path: string; bytes: number }
	| { ok: false; error: string };

/**
 * 把一次生成的字节写进归档目录。
 *
 * 目录按需创建（`recursive`）；任何一步失败都只回一句原因，由调用方决定
 * 怎么告诉用户 —— 这里**不抛**。
 * @param dir - 归档根目录（绝对路径）。
 * @param input - 留档输入。
 * @param signal - 取消信号。
 * @returns 结论（成功时带相对路径、公开地址与绝对路径）。
 */
export async function archiveGeneration(
	dir: string,
	input: ArchiveInput,
	signal?: AbortSignal,
): Promise<ArchiveOutcome> {
	const fetched = await fetchMediaBytes(input.url, signal);
	if (!fetched.ok) return { ok: false, error: fetched.error };

	const rel = archiveRelPath({ ...input, mimeType: input.mimeType ?? fetched.value.mimeType });
	const path = resolve(dir, rel);
	try {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, fetched.value.bytes, signal === undefined ? undefined : { signal });
	} catch (error) {
		return { ok: false, error: `写盘失败：${error instanceof Error ? error.message : String(error)}` };
	}
	return { ok: true, rel, url: archiveUrl(rel), path, bytes: fetched.value.bytes.byteLength };
}

/** 把 `~` 展开成用户主目录（设置里手写路径时最常敲的一种）。 */
export function expandHome(dir: string): string {
	if (dir !== '~' && !dir.startsWith('~/') && !dir.startsWith('~\\')) return dir;
	const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? '';
	if (home === '') return dir;
	return dir === '~' ? home : join(home, dir.slice(2));
}

/** 归档路由的依赖。 */
export interface ArchiveRouteDeps {
	/** 当前归档目录（每次请求都重新读 —— 设置改了立刻生效）。 */
	getDir: () => string;
	/** 浏览器连接的鉴权闸门（缺席时不做检查，见下面注释）。 */
	reject?: ((req: DshHttpRequest) => number | undefined) | undefined;
	/** 诊断日志。 */
	log: (message: string) => void;
}

/**
 * 造出归档路由的处理器。
 *
 * ⚠️ 鉴权闸门（`ctx.connection.requestRejection`）做的是 **Host/Origin 栅栏 +
 * 会话 cookie** 两件事：没有它，浏览器里任何一个恶意页面都能通过 DNS rebinding
 * 读这个目录。因此**有 connection 服务就一定挂上**；只有在没有该服务的组合里
 * （无头 / 裁剪过的 profile，那种组合里根本没有浏览器路由流量）才放行。
 * @param deps - 依赖。
 * @returns 路由处理器。
 */
export function createArchiveHandler(
	deps: ArchiveRouteDeps,
): (req: DshHttpRequest, res: DshHttpResponse) => Promise<void> {
	return async (req, res) => {
		const rejection = deps.reject?.(req);
		if (rejection !== undefined) {
			res.statusCode = rejection;
			res.end();
			return;
		}
		if (req.method !== undefined && req.method !== 'GET' && req.method !== 'HEAD') {
			res.statusCode = 405;
			res.setHeader('allow', 'GET, HEAD');
			res.end();
			return;
		}

		const dir = deps.getDir().trim();
		if (dir === '') {
			res.statusCode = 404;
			res.end();
			return;
		}

		const pathname = pathnameOf(req.url);
		const path = archivePathOf(expandHome(dir), pathname);
		if (path === null) {
			res.statusCode = 404;
			res.end();
			return;
		}

		let bytes: Uint8Array;
		try {
			bytes = await readFile(path);
		} catch {
			// 文件被用户挪走 / 删掉：如实 404（画布上那张图会显示裂图，而不是静默空白）
			res.statusCode = 404;
			res.end();
			return;
		}

		const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';
		res.statusCode = 200;
		res.setHeader('content-type', MIME_BY_EXT[ext] ?? 'application/octet-stream');
		// 文件名带时间与随机段 → 同一个地址的内容永不改变，可以放心长缓存
		res.setHeader('cache-control', 'private, max-age=31536000, immutable');
		res.setHeader('content-length', String(bytes.byteLength));
		res.end(req.method === 'HEAD' ? undefined : bytes);
		deps.log(`归档取图 ${pathname}（${String(bytes.byteLength)} 字节）`);
	};
}

/**
 * 取请求的 pathname（只解析本模块需要的那一段）。
 * @param url - `req.url`。
 * @returns pathname；解析不了时给一个必然 404 的值。
 */
function pathnameOf(url: string | undefined): string {
	if (url === undefined) return '';
	try {
		return new URL(url, 'http://localhost').pathname;
	} catch {
		return '';
	}
}
