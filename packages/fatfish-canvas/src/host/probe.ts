/**
 * 宿主侧的「探测」服务（P9）：测试连接 / 获取模型列表。
 *
 * ## 为什么必须在宿主做
 *
 * 两件事都要用**密钥**去访问供应商，而密钥住在宿主侧的凭据库里
 * （`ctx.credentials`，值从不进浏览器）。让浏览器去 fetch 就得把密钥发下去 ——
 * 那是这套设计一开始就在避免的事（P2 起就没有把密钥下发给过浏览器）。
 * 因此探测走宿主，客户端只拿到「成没成 / 有哪些模型」。
 *
 * ## 怎么被调用（Typert 远程命名空间）
 *
 * 宿主：`ctx.typert.register(manifest)` 声明 `mediaProbe` 命名空间的两个方法
 * （见 `probe-manifest.ts`），本服务对象带 `typertRemote` 绑定。
 * 客户端：`ctx.remote.$mount(...)` 之后 `ctx.remote.mediaProbe.testConnection(id)`
 * —— 返回的就是这里的返回值，不必经过会话快照，也不写任何命令日志。
 *
 * ## 两条硬约束
 *
 * 1. **返回值必须是纯 JSON**（网关注册表会拒绝类实例 / 循环 / 非有限数），
 *    因此这里只返回普通对象与数组。
 * 2. **绝不把密钥放进返回值**。错误里也不带 —— 供应商的错误体可能回显请求头。
 *
 * @module fatfish-canvas/host/probe
 */

import type { ModelKind } from '../client/shared/catalog';

/** 探测目标：一个供应商的基址与已解析出来的密钥。 */
export interface ProbeTarget {
	/** 接口基址。 */
	baseURL: string;
	/** 已解析的密钥（空 = 未配置）。 */
	apiKey: string;
	/** 密钥来自哪个凭据引用（错误文案里告诉用户去哪儿配）。 */
	keyRef: string;
}

/** 一次探测的结果。 */
export interface ProbeResult {
	/** 是否成功。 */
	ok: boolean;
	/** 人类可读的一句话（成功与失败都给）。 */
	message: string;
	/** 拿到的模型 id 列表（`listModels` 成功时）。 */
	models?: string[];
	/** 猜测的种类（与 models 一一对应）。 */
	kinds?: ModelKind[];
	/** 往返耗时（毫秒）。 */
	latencyMs?: number;
	/** HTTP 状态码（拿到响应时）。 */
	status?: number;
}

/** 探测服务依赖。 */
export interface ProbeDeps {
	/**
	 * 按供应商 id 取一个「已解析」的目标（基址与密钥都已解析好）。
	 *
	 * **每次调用都重新解析**密钥：凭据是「每次操作重新解析」的语义
	 * （`dsh-credentials` 明确要求消费者不得跨操作缓存），用户刚填完密钥
	 * 就该立刻能测通。
	 * @param providerId - 供应商 id。
	 * @returns 目标；不存在时为 undefined。
	 */
	providerOf: (providerId: string) => Promise<ProbeTarget | undefined>;
	/** 单次请求超时（毫秒）。 */
	timeoutMs: () => number;
}

/**
 * 从模型 id 猜种类。
 *
 * 只用于「获取模型列表」后的**预填**：用户可以随时改。判据是各家命名习惯里
 * 那些稳定出现的词根 —— 先认视觉（`-vl` / `vision` / 多模态家族名），再认视频，
 * 其余一律算图像。顺序不能反：`qwen-vl-max` 与 `gpt-4o` 都不含视频词根，
 * 但把它们预填成图像模型，用户就得每次手动改。
 * @param id - 模型 id。
 * @returns 猜测的种类。
 */
export function guessKind(id: string): ModelKind {
	if (/vision|-vl\b|vl-|gpt-4o|gpt-4\.1|gemini|claude|glm-4v|internvl|multimodal|omni/i.test(id)) {
		return 'vision';
	}
	return /video|sora|veo|kling|seedance|wan|hunyuan|pika|runway|luma|vidu/i.test(id)
		? 'video'
		: 'image';
}

/** 去掉结尾斜杠。 */
function trimSlash(base: string): string {
	return base.replace(/\/+$/, '');
}

/**
 * 响应体是一整页网页吗。
 *
 * 中转站（new-api 系，贞贞工坊就是）对**不属于自己的路径**不返回 404，而是回
 * 自己那页 HTML 首页（实测 `HTTP 451 Unavailable For Legal Reasons`）。认出
 * 这种响应，才能把「地址指到网页上了」这个人话说出来，而不是把 200 个字符的
 * doctype 甩给用户。
 * @param text - 响应体。
 * @returns 是否像 HTML 页面。
 */
function looksLikeHtml(text: string): boolean {
	return /^\uFEFF?\s*(?:<!doctype|<html)/i.test(text);
}

/**
 * 把「地址指到网页上了」翻成一句可展示的结论。
 * @param status - HTTP 状态码。
 * @param text - 响应体（取页面标题，告诉用户这是谁的网页）。
 * @returns 可展示文案。
 */
function htmlEndpointHint(status: number, text: string): string {
	const title = /<title[^>]*>([^<]*)</i.exec(text)?.[1]?.trim() ?? '';
	return `接口基址指向了一个网页而不是 API（HTTP ${String(status)}${title === '' ? '' : `，页面标题：${title}`}）：多半是漏了版本路径（例如 /v1），也可能把站点首页当成了接口地址`;
}

/**
 * 把网络异常翻译成一句能给用户看的话。
 *
 * 刻意**不带 URL 里的查询串**，也不回显请求头：错误文案会进设置页与日志，
 * 而密钥就在请求头里。
 * @param error - 捕获到的异常。
 * @returns 可展示的文案。
 */
function describeNetworkError(error: unknown): string {
	const reason = error instanceof Error ? error.message : String(error);
	if (/abort/i.test(reason)) return '请求超时（供应商没有在超时时间内响应）';
	return `无法连接：${reason}`;
}

/**
 * 探测服务的实现（不含 cordis 依赖，便于离线单测）。
 */
export class MediaProbeCore {
	/** 依赖。 */
	private readonly deps: ProbeDeps;

	/**
	 * @param deps - 依赖。
	 */
	constructor(deps: ProbeDeps) {
		this.deps = deps;
	}

	/**
	 * 向供应商要一次模型列表（OpenAI 兼容的 `GET {base}/models`）。
	 *
	 * 这一个调用同时承担两件事：**测试连接**（能不能连上、密钥对不对）与
	 * **获取模型列表**（返回体里的 `data[].id`）。分开做两次请求没有意义 ——
	 * 能列出模型就已经证明了连接与鉴权都通。
	 * @param providerId - 供应商 id。
	 * @returns 探测结果。
	 */
	async listModels(providerId: string): Promise<ProbeResult> {
		const target = await this.deps.providerOf(providerId);
		if (target === undefined) {
			return {
				ok: false,
				message: `找不到供应商 "${providerId}"（可能配置还没保存成功，或已被删除）`,
			};
		}
		if (target.baseURL === '') {
			return { ok: false, message: '这个供应商还没有填接口基址' };
		}
		if (target.apiKey === '') {
			return {
				ok: false,
				message: `还没有配置密钥（凭据引用 ${target.keyRef === '' ? '未设置' : target.keyRef}）`,
			};
		}

		const url = `${trimSlash(target.baseURL)}/models`;
		const started = Date.now();
		const controller = new AbortController();
		const timer = setTimeout(() => {
			controller.abort();
		}, this.deps.timeoutMs());

		try {
			const response = await fetch(url, {
				method: 'GET',
				headers: { authorization: `Bearer ${target.apiKey}` },
				signal: controller.signal,
			});
			const latencyMs = Date.now() - started;
			const text = await response.text();

			if (!response.ok) {
				// 回的是网页 = 这个地址上没有这个端点（实测：基址漏了 /v1 时，
				// 中转站回的是自家首页 + 451），先说这个结论
				if (looksLikeHtml(text)) {
					return {
						ok: false,
						status: response.status,
						latencyMs,
						message: htmlEndpointHint(response.status, text),
					};
				}
				// 401/403 是最常见的一类，单独说清楚（别让用户去猜是网络问题）
				const hint =
					response.status === 401 || response.status === 403
						? '密钥被拒绝'
						: response.status === 404
							? '这个地址上没有 /models 端点（检查基址是否写全，例如要带 /v1）'
							: '供应商返回了错误';
				return {
					ok: false,
					status: response.status,
					latencyMs,
					message: `${hint}：HTTP ${String(response.status)} ${text.slice(0, 200)}`,
				};
			}

			let json: unknown;
			try {
				json = JSON.parse(text);
			} catch {
				return {
					ok: false,
					status: response.status,
					latencyMs,
					message: looksLikeHtml(text)
						? htmlEndpointHint(response.status, text)
						: `响应不是 JSON（${text.slice(0, 200)}）`,
				};
			}

			const ids = extractModelIds(json);
			if (ids.length === 0) {
				return {
					ok: true,
					status: response.status,
					latencyMs,
					models: [],
					kinds: [],
					message: '连接成功，但响应里没有模型列表（可以手动添加模型）',
				};
			}
			return {
				ok: true,
				status: response.status,
				latencyMs,
				models: ids,
				kinds: ids.map(guessKind),
				message: `连接成功，拿到 ${String(ids.length)} 个模型（${String(latencyMs)} ms）`,
			};
		} catch (error) {
			return { ok: false, latencyMs: Date.now() - started, message: describeNetworkError(error) };
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * 只测连接（不关心模型列表）。
	 * @param providerId - 供应商 id。
	 * @returns 探测结果（带着 models，省得前端再问一次）。
	 */
	async testConnection(providerId: string): Promise<ProbeResult> {
		const result = await this.listModels(providerId);
		if (!result.ok) return result;
		return { ...result, message: `连接正常（${String(result.latencyMs ?? 0)} ms）` };
	}

	/**
	 * 按地址取一张图，以 data URL 交给客户端（「点画布图 → 存成附件」那条路）。
	 * @param url - 图片地址（http/https）。
	 * @returns 取到的字节（data URL）或一句可展示的失败原因。
	 */
	async fetchImage(url: string): Promise<FetchedBytes> {
		return this.fetchBytes(url, false);
	}

	/**
	 * 按地址取一份**媒体**字节（图或视频）—— 画布右键「导出」那条路用。
	 *
	 * 与 {@link fetchImage} 分成两个方法、而不是给它加一个开关参数：附件那条路
	 * **只该收图片**（把几十兆的视频塞进聊天附件是另一种行为，也没有意义）。
	 * @param url - 媒体地址（http/https）。
	 * @returns 取到的字节（data URL）或一句可展示的失败原因。
	 */
	async fetchMedia(url: string): Promise<FetchedBytes> {
		return this.fetchBytes(url, true);
	}

	/**
	 * 共用的取字节实现。
	 *
	 * **为什么这一步必须在宿主做**：画布节点上的媒体常常挂在供应商 / 中转站的
	 * 对象存储上（跨域），浏览器直接 `fetch` 会踩 CORS，而「存成附件」与
	 * 「导出到本地」都必须要字节。宿主没有同源策略，取回来转成 data URL
	 * 交给页面即可。
	 *
	 * 三条硬规矩：
	 * 1. **认得出才取**：`content-type` 不在允许的范围内直接拒绝 ——
	 *    `fetchImage` 只认 `image/*`，`fetchMedia` 还认 `video/*`。
	 * 2. **有上限**（图 {@link FETCH_IMAGE_MAX_BYTES} / 视频 {@link FETCH_VIDEO_MAX_BYTES}）：
	 *    字节要经 RPC 过一遍，几兆以上就会把页面卡一下；超了就报清楚，不要硬塞。
	 * 3. **错误里带地址但不带凭证**：这里没有任何密钥，纯 GET。
	 * @param url - 媒体地址（http/https）。
	 * @param allowVideo - 允不允许视频（决定 MIME 判据与体积上限）。
	 * @returns 取到的字节（data URL）或一句可展示的失败原因。
	 */
	private async fetchBytes(url: string, allowVideo: boolean): Promise<FetchedBytes> {
		if (!/^https?:\/\//i.test(url)) {
			return { ok: false, message: '只支持 http(s) 地址（本地文件请直接拖进画布）' };
		}
		const controller = new AbortController();
		const timer = setTimeout(() => {
			controller.abort();
		}, this.deps.timeoutMs());
		try {
			const response = await fetch(url, { method: 'GET', signal: controller.signal });
			if (!response.ok) {
				return { ok: false, message: `取字节失败：HTTP ${String(response.status)}` };
			}
			const mime = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
			const video = mime.startsWith('video/');
			if (!mime.startsWith('image/') && !(video && allowVideo)) {
				const what = allowVideo ? '不是图片或视频' : '不是图片';
				return {
					ok: false,
					message: `这个地址返回的${what}（${mime === '' ? '没有 content-type' : mime}）`,
				};
			}
			const limit = video ? FETCH_VIDEO_MAX_BYTES : FETCH_IMAGE_MAX_BYTES;
			/** 超了上限时那句话（两种媒体的上限与下一步建议都不同）。 */
			const tooBig = (bytes: number): string => {
				const size = `${(bytes / 1024 / 1024).toFixed(1)} MB`;
				const cap = `${String(limit / 1024 / 1024)} MB`;
				return video
					? `视频太大（${size}，上限 ${cap}）—— 字节要经页面过一次。先配「留档目录」（设置 → 肥鱼画布）让视频落到本机，再导出就不受这个上限限制`
					: `图片太大（${size}，上限 ${cap}）—— 附件通路要把字节过一遍页面，先存到本地再拖进画布更稳`;
			};
			// 声明了长度就先拒绝：视频动辄几十兆，白下一遍再报错最亏。
			const declared = Number(response.headers.get('content-length') ?? '');
			if (Number.isFinite(declared) && declared > limit) {
				return { ok: false, message: tooBig(declared) };
			}
			const buffer = Buffer.from(new Uint8Array(await response.arrayBuffer()));
			if (buffer.byteLength > limit) {
				return { ok: false, message: tooBig(buffer.byteLength) };
			}
			const which = video ? '视频' : '图片';
			const ext = mime.split('/')[1] ?? (video ? 'mp4' : 'png');
			return {
				ok: true,
				message: `已取到${which}（${(buffer.byteLength / 1024).toFixed(0)} KB）`,
				dataUrl: `data:${mime};base64,${buffer.toString('base64')}`,
				mimeType: mime,
				name: fileNameFromUrl(url, ext, video),
				bytes: buffer.byteLength,
			};
		} catch (error) {
			return { ok: false, message: describeNetworkError(error) };
		} finally {
			clearTimeout(timer);
		}
	}
}

/** {@link MediaProbeCore.fetchImage} / `fetchMedia` 的结果形状。 */
export interface FetchedBytes {
	/** 是否取到。 */
	ok: boolean;
	/** 一句可展示的说明（成功也是）。 */
	message: string;
	/** 内联数据（`ok` 时才有）。 */
	dataUrl?: string;
	/** MIME。 */
	mimeType?: string;
	/** 从地址猜出来的文件名。 */
	name?: string;
	/** 字节数。 */
	bytes?: number;
}

/** `fetchImage` 的体积上限：字节要经 RPC 过一次页面，再大就不是「顺手存附件」了。 */
export const FETCH_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * `fetchMedia` 里**视频**的体积上限。
 *
 * 比图片宽得多（视频本来就大），但仍有天花板：字节要 base64 过一遍 RPC。
 * 64 MB 的视频 ≈ 85 MB 的字符串，页面会顿一下但不至于卡死。
 * `ponytail:` 再大就该走「留档目录 → 同源地址」那条路（`/ffc-media/…`
 * 不经 RPC、没有上限），别在这里继续加码。
 */
export const FETCH_VIDEO_MAX_BYTES = 64 * 1024 * 1024;

/**
 * 从地址里猜一个像样的文件名（附件卡片上要显示它）。
 * @param url - 媒体地址。
 * @param ext - 由 MIME 推出的扩展名（地址里没有文件名时用它）。
 * @param video - 这是不是视频（决定兜底名）。
 * @returns 文件名。
 */
function fileNameFromUrl(url: string, ext: string, video: boolean): string {
	try {
		const last = new URL(url).pathname.split('/').pop() ?? '';
		const decoded = decodeURIComponent(last);
		if (/\.(png|jpe?g|webp|gif|avif|bmp|mp4|webm|mov|m4v)$/i.test(decoded)) return decoded;
		if (decoded !== '') return `${decoded}.${ext}`;
	} catch {
		/* 地址解析不了就退回默认名 */
	}
	return `${video ? 'canvas-video' : 'canvas-image'}.${ext}`;
}

/**
 * 从 `GET /models` 的响应里挖出模型 id。
 *
 * 接受四种形状（各家网关不一致，全都在真实响应里见过）：
 *   `{ data: [{ id }] }`（OpenAI 官方）、`{ models: [...] }`、直接一个字符串数组，
 *   以及 `{ code, data: { total, models: [...] } }` —— kie.ai 实测：列表在 `data`
 *   里再套一层，条目里是 `model` / `slug`（`fromEntry` 认 `model`）。
 * @param json - 解析后的响应体。
 * @returns 去重后的 id 列表（保持原顺序）。
 */
export function extractModelIds(json: unknown): string[] {
	const out: string[] = [];
	const push = (value: unknown): void => {
		if (typeof value === 'string' && value !== '') out.push(value);
	};
	const fromEntry = (entry: unknown): void => {
		if (typeof entry === 'string') push(entry);
		else if (entry !== null && typeof entry === 'object') {
			const o = entry as Record<string, unknown>;
			push(o.id ?? o.name ?? o.model);
		}
	};

	if (Array.isArray(json)) {
		for (const entry of json) fromEntry(entry);
	} else if (json !== null && typeof json === 'object') {
		const o = json as Record<string, unknown>;
		// `data` 是对象时再往下找一层（kie 把列表套在里面）；是数组时照旧当列表读
		const nested = o['data'];
		const containers =
			nested !== null && typeof nested === 'object' && !Array.isArray(nested)
				? [o, nested as Record<string, unknown>]
				: [o];
		for (const container of containers) {
			for (const key of ['data', 'models', 'model_list', 'result']) {
				const list = container[key];
				if (Array.isArray(list)) {
					for (const entry of list) fromEntry(entry);
					if (out.length > 0) break;
				}
			}
			if (out.length > 0) break;
		}
	}
	return [...new Set(out)];
}
