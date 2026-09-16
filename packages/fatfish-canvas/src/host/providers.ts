/**
 * 媒体生成适配器（宿主半边）。
 *
 * 两种适配器都按 **OpenAI 兼容** 协议通信 —— 这是覆盖面最广的一种约定：
 * OpenAI 自家的 images / videos 端点，以及绝大多数国内网关（火山方舟、
 * 硅基流动、智谱、各类中转）都提供同一形状的接口。
 *
 *   openai-images   POST {base}/images/generations
 *                   → { data: [{ url } | { b64_json }] }
 *                   POST {base}/images/edits           带参考图、且供应商配成 edits 模式时
 *                   （multipart；OpenAI 官方的 gpt-image-1 / dall-e-2 只认这条）
 *
 *   openai-videos   POST {base}/videos/generations
 *                   （这个路径在此地址上不存在时改试 {base}/video/generations ——
 *                    new-api 系中转站只有单数那条，见 submitVideo）
 *                   → { data: [{ url }] }            直接出片
 *                   → { id } / { task_id }           任务式：轮询到完成为止
 *
 * ## 参考图（图生图 / 视频首帧）
 *
 * 参考图**不经过模型**：模型（或命令行、或输入框里的附件）只给一个句柄，
 * 宿主把句柄变成供应商认的载荷（见 host/reference.ts）。字段名与端点在供应商之间
 * 并不统一 —— 图像默认往 `/images/generations` 的 `image` 字段塞（new-api 系中转、
 * 各家兼容层都收），OpenAI 官方那类只认 `/images/edits` 的 multipart；视频的
 * 首帧字段名更杂。因此两者都由供应商配置覆盖（`referenceField` / `referenceMode`）：
 * 字段名不对时网关**不报错、直接出纯文生图**，那种静默忽略是这里最坏的失败模式。
 *
 * 视频没有真正的行业标准，因此这里对响应做**形状嗅探**而不是按供应商分支：
 * 直接拿到 url 就返回；只拿到任务 id 就轮询 —— 轮询时同时接受
 * `data[0].url` / `content.video_url` / `output.url` 三种落点。
 *
 * @module fatfish-canvas/host/providers
 */

import { referenceBytes } from './reference';
import type { MediaKind, ResolvedModel } from './schema';

/** 一次生成请求。 */
export interface GenerateRequest {
	/** 提示词。 */
	prompt: string;
	/** 画幅比例，取值 `1:1` / `16:9` / `4:3` / `3:4` / `9:16`（移植自 jaaz 的合法值）。 */
	aspectRatio?: string;
	/** 视频分辨率，`480p` / `1080p`。 */
	resolution?: string;
	/** 视频时长（秒）。 */
	duration?: number;
	/**
	 * 参考图地址（已由 host/reference.ts 解析成 `http(s)` / `data:`）。
	 * 提供了它就走图生图 / 视频首帧；否则是纯文生图。
	 */
	reference?: string;
}

/** 一次生成结果。 */
export interface GeneratedMedia {
	/** 媒体种类。 */
	kind: MediaKind;
	/** 可直接交给 <img> / <video> 的地址（http(s) 或 data:）。 */
	url: string;
	/** 内联数据的 MIME（url 是 data: 时有值）。 */
	mimeType?: string;
	/** 宽（像素，供应商返回时可填）。 */
	width?: number;
	/** 高（像素）。 */
	height?: number;
	/** 实际使用的模型。 */
	model: string;
	/** 供应商 id。 */
	providerId: string;
	/** 原始提示词。 */
	prompt: string;
	/** 供应商改写后的提示词（部分接口会回传）。 */
	revisedPrompt?: string;
}

/** 画幅比例 → 像素尺寸。取 jaaz 声明为合法的五个比例。 */
const IMAGE_SIZE_BY_RATIO: Record<string, string> = {
	'1:1': '1024x1024',
	'16:9': '1792x1024',
	'9:16': '1024x1792',
	'4:3': '1024x768',
	'3:4': '768x1024',
};

/** 去掉结尾斜杠。 */
function trimSlash(base: string): string {
	return base.replace(/\/+$/, '');
}

/** 休眠，且可被 abort 打断。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(new Error('已取消'));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

/** 响应体是一整页网页吗（中转站对不属于自己的路径回的是自家首页）。 */
function isHtmlPage(text: string): boolean {
	return /^\uFEFF?\s*(?:<!doctype|<html)/i.test(text);
}

/** 「这个地址上没有这个端点」：网关回了一整页 HTML 而不是 JSON。 */
interface HtmlPageError extends Error {
	htmlPage: true;
}

/**
 * 造一个「回的是网页」错误。
 *
 * 中转站（new-api 系，贞贞工坊就是）对**不存在的路径**不返回 404，而是回自己
 * 那页 HTML 首页（实测 HTTP 451）。所以「回的是不是网页」就是「这个端点在不在
 * 这个地址上」的判据 —— 视频提交靠它换用另一种路径写法。
 * @param what - 动作描述。
 * @param status - HTTP 状态码。
 * @returns 带标记的错误。
 */
function htmlPageError(what: string, status: number): HtmlPageError {
	const error = new Error(
		`${what}失败：HTTP ${String(status)} —— 这个地址返回的是网页而不是 API，检查接口基址是否漏了 /v1 之类的版本路径`,
	) as HtmlPageError;
	error.htmlPage = true;
	return error;
}

/**
 * 发一个 JSON 请求并把失败翻译成可读错误。
 * @param url - 完整地址。
 * @param init - fetch 参数。
 * @param what - 用于错误文案的动作描述。
 * @returns 解析后的 JSON。
 */
async function postJson(url: string, init: RequestInit, what: string): Promise<any> {
	let response: Response;
	try {
		response = await fetch(url, init);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`${what}失败：无法连接 ${url}（${reason}）`);
	}
	const text = await response.text();
	const html = isHtmlPage(text);
	if (!response.ok) {
		// 供应商的错误体通常是 JSON，网关故障可能是 HTML —— 后者先给结论
		if (html) throw htmlPageError(what, response.status);
		throw new Error(`${what}失败：HTTP ${String(response.status)} ${text.slice(0, 500)}`);
	}
	try {
		return JSON.parse(text);
	} catch {
		if (html) throw htmlPageError(what, response.status);
		throw new Error(`${what}失败：响应不是 JSON（${text.slice(0, 300)}）`);
	}
}

/** 组装鉴权头。 */
function authHeaders(model: ResolvedModel): Record<string, string> {
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	const key = model.apiKey.trim();
	if (key !== '') headers.authorization = `Bearer ${key}`;
	return headers;
}

/** 参考图字段名（供应商配置可覆盖，默认 `image`）。 */
function referenceFieldOf(model: ResolvedModel): string {
	const field = model.referenceField.trim();
	return field === '' ? 'image' : field;
}

/** 文件扩展名（multipart 上传时的文件名用）。 */
function extensionOf(mediaType: string): string {
	const subtype = mediaType.split('/')[1]?.split(';')[0]?.trim().toLowerCase() ?? '';
	if (subtype === 'jpeg' || subtype === 'jpg') return 'jpg';
	return subtype === '' ? 'png' : subtype;
}

/**
 * 走 `/images/edits` 的 multipart（OpenAI 官方那类只认这条端点）。
 *
 * 这里必须先把参考图**拿成字节**：`data:` 就地解码，`http(s)` 真的下载一次 ——
 * 所以只在供应商确实声明了 `edits` 模式时才走这条路。
 * @param model - 已解析的模型。
 * @param request - 请求。
 * @param size - 像素尺寸。
 * @param reference - 已解析的参考图地址。
 * @param signal - 取消信号。
 * @returns 响应 JSON。
 */
async function postImageEdits(
	model: ResolvedModel,
	request: GenerateRequest,
	size: string,
	reference: string,
	signal?: AbortSignal,
): Promise<any> {
	const bytes = await referenceBytes(reference, signal);
	const form = new FormData();
	form.append('model', model.modelId);
	form.append('prompt', request.prompt);
	form.append('n', '1');
	form.append('size', size);
	form.append(
		referenceFieldOf(model),
		// Node 的 Blob 本来就吃 Uint8Array；这里只是 lib.dom 的 ArrayBufferView 泛型
		// 与 Node 的 Uint8Array<ArrayBufferLike> 对不上，加一次纯类型断言。
		new Blob([bytes.data as unknown as BlobPart], { type: bytes.mediaType }),
		`reference.${extensionOf(bytes.mediaType)}`,
	);

	// multipart 的 content-type 必须由 fetch 自己写（带 boundary），这里不能继承 JSON 头
	const headers = authHeaders(model);
	delete headers['content-type'];
	return postJson(
		`${trimSlash(model.baseURL)}/images/edits`,
		{ method: 'POST', headers, body: form, signal },
		'图像生成（参考图）',
	);
}

/**
 * 生成图像。
 * @param model - 已解析的模型（供应商 × 模型，见 host/schema.ts）。
 * @param request - 请求。
 * @param signal - 取消信号。
 * @returns 生成结果。
 */
export async function generateImage(
	model: ResolvedModel,
	request: GenerateRequest,
	signal?: AbortSignal,
): Promise<GeneratedMedia> {
	const base = trimSlash(model.baseURL);
	const ratio = request.aspectRatio ?? '1:1';
	const size = IMAGE_SIZE_BY_RATIO[ratio] ?? IMAGE_SIZE_BY_RATIO['1:1'] ?? '1024x1024';
	const reference = request.reference;

	const json =
		reference !== undefined && model.referenceMode === 'edits'
			? await postImageEdits(model, request, size, reference, signal)
			: await postJson(
					`${base}/images/generations`,
					{
						method: 'POST',
						headers: authHeaders(model),
						body: JSON.stringify({
							model: model.modelId,
							prompt: request.prompt,
							n: 1,
							size,
							...(reference === undefined ? {} : { [referenceFieldOf(model)]: reference }),
						}),
						signal,
					},
					'图像生成',
				);

	const first = Array.isArray(json?.data) ? json.data[0] : undefined;
	if (first === undefined) {
		throw new Error(`图像生成失败：响应里没有 data[0]（${JSON.stringify(json).slice(0, 300)}）`);
	}

	if (typeof first.url === 'string' && first.url !== '') {
		return {
			kind: 'image',
			url: first.url,
			...(typeof first.width === 'number' ? { width: first.width } : {}),
			...(typeof first.height === 'number' ? { height: first.height } : {}),
			model: model.modelId,
			providerId: model.providerId,
			prompt: request.prompt,
			...(typeof first.revised_prompt === 'string' ? { revisedPrompt: first.revised_prompt } : {}),
		};
	}
	if (typeof first.b64_json === 'string' && first.b64_json !== '') {
		const mime = typeof first.mime_type === 'string' ? first.mime_type : 'image/png';
		return {
			kind: 'image',
			url: `data:${mime};base64,${first.b64_json}`,
			mimeType: mime,
			model: model.modelId,
			providerId: model.providerId,
			prompt: request.prompt,
		};
	}
	throw new Error(`图像生成失败：data[0] 既没有 url 也没有 b64_json`);
}

/** 从轮询响应里挖出视频地址（不同网关落点不同）。 */
function extractVideoUrl(json: any): string | undefined {
	const candidates = [
		json?.data?.[0]?.url,
		json?.content?.video_url,
		json?.output?.url,
		json?.video_url,
		json?.url,
		json?.data?.[0]?.video_url,
	];
	for (const candidate of candidates) {
		if (typeof candidate === 'string' && candidate !== '') return candidate;
	}
	return undefined;
}

/** 从轮询响应里读出状态。 */
function extractStatus(json: any): string | undefined {
	const status = json?.status ?? json?.data?.[0]?.status ?? json?.state;
	return typeof status === 'string' ? status.toLowerCase() : undefined;
}

/**
 * 提交视频任务：两种常见路径写法都试一遍。
 *
 * 视频端点没有行业标准 —— OpenAI 官方是 `/videos`，new-api 系中转站（贞贞工坊
 * 实测）是 `/video/generations`（单数）。只在「回的是网页」时才换下一个：那说明
 * 请求根本没到这个地址的模型上，重发不会重复扣费；JSON 错误一律如实抛出。
 * @param base - 已去掉尾斜杠的基址。
 * @param init - fetch 参数。
 * @returns 成功的响应体与真正生效的路径（轮询要用同一条）。
 */
async function submitVideo(base: string, init: RequestInit): Promise<{ json: any; path: string }> {
	const paths = ['/videos/generations', '/video/generations'];
	for (const path of paths) {
		try {
			return { json: await postJson(`${base}${path}`, init, '视频生成'), path };
		} catch (error) {
			if ((error as Partial<HtmlPageError>).htmlPage !== true) throw error;
		}
	}
	throw new Error(
		`视频生成失败：这个地址上没有视频端点（试过 ${paths.join('、')}）—— 检查接口基址是否写全（例如要带 /v1）`,
	);
}

/**
 * 生成视频。直接出片就返回；任务式则轮询到完成。
 * @param model - 已解析的模型（供应商 × 模型，见 host/schema.ts）。
 * @param request - 请求。
 * @param signal - 取消信号。
 * @param timeoutMs - 整体超时。
 * @returns 生成结果。
 */
export async function generateVideo(
	model: ResolvedModel,
	request: GenerateRequest,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<GeneratedMedia> {
	const base = trimSlash(model.baseURL);
	const duration = request.duration ?? 5;
	const resolution = request.resolution ?? '480p';

	const submitted = await submitVideo(base, {
		method: 'POST',
		headers: authHeaders(model),
		body: JSON.stringify({
			model: model.modelId,
			prompt: request.prompt,
			duration,
			resolution,
			...(request.aspectRatio !== undefined ? { aspect_ratio: request.aspectRatio } : {}),
			...(request.reference === undefined
				? {}
				: { [referenceFieldOf(model)]: request.reference }),
		}),
		signal,
	});
	const json = submitted.json;

	const direct = extractVideoUrl(json);
	if (direct !== undefined) {
		return {
			kind: 'video',
			url: direct,
			model: model.modelId,
			providerId: model.providerId,
			prompt: request.prompt,
		};
	}

	const taskId = json?.id ?? json?.task_id ?? json?.data?.[0]?.task_id ?? json?.data?.[0]?.id;
	if (typeof taskId !== 'string' || taskId === '') {
		throw new Error(
			`视频生成失败：响应里既没有视频地址也没有任务 id（${JSON.stringify(json).slice(0, 300)}）`,
		);
	}

	const deadline = Date.now() + timeoutMs;
	const pollUrl = `${base}${submitted.path}/${taskId}`;
	while (Date.now() < deadline) {
		await sleep(3000, signal);
		const poll = await postJson(
			pollUrl,
			{ method: 'GET', headers: authHeaders(model), signal },
			'视频生成轮询',
		);
		const url = extractVideoUrl(poll);
		if (url !== undefined) {
			return {
				kind: 'video',
				url,
				model: model.modelId,
				providerId: model.providerId,
				prompt: request.prompt,
			};
		}
		const status = extractStatus(poll);
		if (status === 'failed' || status === 'error' || status === 'cancelled') {
			throw new Error(
				`视频生成失败：供应商返回 ${status}（${JSON.stringify(poll).slice(0, 300)}）`,
			);
		}
	}
	throw new Error(`视频生成超时（${String(Math.round(timeoutMs / 1000))} 秒）`);
}

/**
 * 按模型的适配器分发。
 * @param model - 已解析的模型（供应商 × 模型，见 host/schema.ts）。
 * @param request - 请求。
 * @param signal - 取消信号。
 * @param timeoutMs - 整体超时（视频轮询用）。
 * @returns 生成结果。
 */
export async function generate(
	model: ResolvedModel,
	request: GenerateRequest,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<GeneratedMedia> {
	if (model.api === 'openai-images') return generateImage(model, request, signal);
	return generateVideo(model, request, signal, timeoutMs);
}

// ───────────────────── 视觉模型：把参考图读成文字 ─────────────────────

/**
 * 给视觉模型的指令。
 *
 * 刻意要求「直接给描述、不要客套、不要 Markdown」：这段文字会被拼进生成提示词，
 * 任何寒暄都是污染。语言跟随用户要求，省得中文用户拿到英文描述还得自己翻。
 */
const VISION_INSTRUCTION =
	'用简洁的语言描述这张图的**主体、风格、色彩、构图与光线**，供图像生成模型参考。' +
	'直接给描述：不要客套、不要 Markdown、不要分点。' +
	'若下面的用户要求是中文就用中文，否则用英文。用户要求：';

/** 从 chat/completions 响应里取正文（兼容字符串与分块两种形状）。 */
function contentOf(json: any): string {
	const content = json?.choices?.[0]?.message?.content;
	if (typeof content === 'string') return content.trim();
	if (Array.isArray(content)) {
		return content
			.map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
			.join('')
			.trim();
	}
	return '';
}

/**
 * 让视觉模型描述一张参考图。
 *
 * 走最通用的 `POST {base}/chat/completions`：中转站与各家兼容层都提供它，而且
 * **同一个供应商的密钥**就能用（用户不必为视觉模型再配一处凭据，这正是它和
 * 图像 / 视频模型挤在同一个供应商字典里的原因）。图片以地址内联 —— 参考图本来
 * 就已经是 `http(s)` / `data:`，再要求供应商去下载一次只会多一处失败点。
 * @param model - 已解析的视觉模型（见 `findVisionModel`）。
 * @param request - 参考图地址与用户提示词。
 * @param signal - 取消信号。
 * @returns 描述文字（保证非空）。
 * @throws 网络 / 鉴权 / 响应形状异常时 —— 文案可直接展示。
 */
export async function describeImage(
	model: ResolvedModel,
	request: { reference: string; prompt: string },
	signal?: AbortSignal,
): Promise<string> {
	const json = await postJson(
		`${trimSlash(model.baseURL)}/chat/completions`,
		{
			method: 'POST',
			headers: authHeaders(model),
			body: JSON.stringify({
				model: model.modelId,
				max_tokens: 400,
				messages: [
					{
						role: 'user',
						content: [
							{ type: 'text', text: `${VISION_INSTRUCTION}${request.prompt}` },
							{ type: 'image_url', image_url: { url: request.reference } },
						],
					},
				],
			}),
			signal,
		},
		'参考图描述',
	);

	const text = contentOf(json);
	if (text === '') {
		throw new Error(
			`参考图描述失败：响应里没有 choices[0].message.content（${JSON.stringify(json).slice(0, 300)}）`,
		);
	}
	return text;
}
