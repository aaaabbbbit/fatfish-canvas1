/**
 * 把画布上的**媒体**导出到本地（P27，P46 起图与视频合成一个动作）。
 *
 * 两条出口：**一项 → 直接下载那一个文件**（保留原始格式）；**多项 → 打成一个 zip**
 * （框选一组之后右键「导出」走的就是这条）。图与视频可以混在同一个 zip 里 ——
 * 归档格式见 `zip.ts`（STORE 只装箱，视频不会被二次压缩）。
 *
 * 文件名沿用 `exportImages.ts`（改名的收益抵不过改测试与文档引用的成本），
 * 但**行为**已经是复合的：`exportNodes` 收什么导什么，按 `node.kind` 命名。
 *
 * 字节从哪儿来：
 *   1. `data:` 地址（拖进画布的本地图、供应商回的内联图）→ 自己解 base64；
 *   2. `blob:` 地址 → 同源 `fetch`；
 *   3. 同源相对地址（本机留档的 `/ffc-media/…`）→ 同源 `fetch`；
 *   4. 其余（生成结果常挂在供应商 / 中转站的对象存储上，跨域）→ **请宿主代取**。
 *      浏览器直接 `fetch` 会踩 CORS，这条通路与「点图送进聊天框」共用同一套
 *      拆信封逻辑，但走的是**收视频**的那个宿主方法（`fetchMedia`，视频上限
 *      64MB；超了会明说「先配留档目录」）。
 *
 * @module fatfish-canvas/client/canvas/exportImages
 */

import { fetchMediaViaHost } from '../index';
import type { CanvasNode } from './model';
import { mediaCountsText } from './model';
import { extOf, safeName, uniqueName, zipStore, type ExportFile } from './zip';

/** 一次导出的结论。 */
export interface ExportOutcome {
	/** 是否至少导出了一项。 */
	ok: boolean;
	/** 给用户看的一句话。 */
	message: string;
}

/** 解一个 `data:` 地址。 */
export function dataUrlBytes(url: string): { bytes: Uint8Array; mime: string } | null {
	if (!url.startsWith('data:')) return null;
	const comma = url.indexOf(',');
	if (comma < 0) return null;
	const header = url.slice(0, comma);
	const mime = header.slice(5).split(';')[0] ?? 'image/png';
	const payload = url.slice(comma + 1);
	if (!/;base64/i.test(header)) {
		try {
			return { bytes: new TextEncoder().encode(decodeURIComponent(payload)), mime };
		} catch {
			return null;
		}
	}
	try {
		const binary = atob(payload);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
		return { bytes, mime };
	} catch {
		return null;
	}
}

/** 取一个地址的字节。 */
async function bytesOf(url: string): Promise<{ bytes: Uint8Array; mime: string } | { error: string }> {
	if (url.startsWith('data:')) {
		const got = dataUrlBytes(url);
		return got ?? { error: '这一项的内联数据解析不了' };
	}

	if (url.startsWith('blob:')) {
		try {
			const blob = await (await fetch(url)).blob();
			return {
				bytes: new Uint8Array(await blob.arrayBuffer()),
				mime: blob.type === '' ? 'image/png' : blob.type,
			};
		} catch {
			return { error: '这一项的临时地址已经失效（刷新页面后会这样，重新拖进来即可）' };
		}
	}

	if (url.startsWith('/')) {
		// 同源相对地址 = 本机留档的媒体（P32）。不经过宿主：同源没有 CORS 问题，
		// 而宿主那条路只认 http(s)（见 host/probe.ts 的 fetchBytes）。
		// 留档这条路**没有体积上限**，大视频走它最稳。
		try {
			const response = await fetch(url);
			if (!response.ok) {
				return { error: `这一项的本地留档读不到（HTTP ${String(response.status)}）—— 文件可能被挪走或删掉了` };
			}
			const blob = await response.blob();
			if (!blob.type.startsWith('image/') && !blob.type.startsWith('video/')) {
				return { error: `本地留档返回的不是媒体（${blob.type === '' ? '没有 content-type' : blob.type}）` };
			}
			return {
				bytes: new Uint8Array(await blob.arrayBuffer()),
				mime: blob.type,
			};
		} catch {
			return { error: '这一项的本地留档读不到（留档服务可能没起来）' };
		}
	}

	// 跨域地址请宿主代取（收图**也收视频**的那一个方法；信封由 fetchMediaViaHost
	// 拆开 —— 这里**不要**自己读字段）
	const fetched = await fetchMediaViaHost(url);
	if (!fetched.ok) return { error: fetched.message };
	const got = dataUrlBytes(fetched.dataUrl);
	if (got === null) return { error: '宿主回的媒体数据解析不了' };
	return { bytes: got.bytes, mime: fetched.mimeType };
}

/** 触发一次浏览器下载。 */
function download(bytes: Uint8Array, name: string, mime: string): void {
	// 断言只为过 `Uint8Array<ArrayBufferLike>` 与 `BlobPart` 的类型差：运行时
	// Uint8Array 本来就是合法的 BlobPart（改成拷贝一份只是白搬几 MB 字节）。
	const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
	const link = document.createElement('a');
	link.href = url;
	link.download = name;
	document.body.append(link);
	link.click();
	link.remove();
	// 立刻 revoke 会让部分浏览器取消这次下载，留一会儿再回收。
	setTimeout(() => {
		URL.revokeObjectURL(url);
	}, 10_000);
}

/** 压缩包的名字（到秒，够区分两次导出）。 */
function stamp(): string {
	return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

/**
 * 导出这些节点上的媒体（一项 → 直接下载；多项 → 一个 zip，图与视频可以混在一起）。
 *
 * 单项失败**不中断**整批：能导的都导出去，取不到的只在结论里报个数 ——
 * 「五张里有一张跨域取不到」不该让用户连另外四张也拿不到。
 * @param nodes - 选中的节点（没有地址的会被忽略）。
 * @returns 结论。
 */
export async function exportNodes(nodes: readonly CanvasNode[]): Promise<ExportOutcome> {
	const targets = nodes.filter((node) => (node.src ?? '') !== '');
	if (targets.length === 0) return { ok: false, message: '选中的节点里没有可导出的媒体' };

	const files: ExportFile[] = [];
	const used = new Set<string>();
	const problems: string[] = [];
	let image = 0;
	let video = 0;
	for (const node of targets) {
		const got = await bytesOf(node.src ?? '');
		if ('error' in got) {
			problems.push(got.error);
			continue;
		}
		// 兜底名按节点种类分：没标题的图与没标题的视频不该都叫「画布图-NN」
		const stem = node.kind === 'video' ? '画布视频' : '画布图';
		const fallback = `${stem}-${String(files.length + 1).padStart(2, '0')}`;
		const name = uniqueName(safeName(node.title ?? '', fallback, extOf(got.mime)), used);
		files.push({ name, bytes: got.bytes, mime: got.mime });
		// 「导出了些什么」按**真拿到的 MIME** 数，不按节点种类 —— 真拿到什么算什么
		if (got.mime.startsWith('video/')) video += 1;
		else image += 1;
	}

	if (files.length === 0) return { ok: false, message: problems[0] ?? '没能取到媒体字节' };

	if (files.length === 1) {
		const only = files[0];
		if (only === undefined) return { ok: false, message: '没能取到媒体字节' };
		download(only.bytes, only.name, only.mime);
		return { ok: true, message: `已导出 ${only.name}` };
	}

	download(zipStore(files), `肥鱼画布-${stamp()}.zip`, 'application/zip');
	const skipped = problems.length === 0 ? '' : `（${String(problems.length)} 项取不到，已跳过）`;
	return { ok: true, message: `已导出 ${mediaCountsText({ image, video })}${skipped}` };
}
