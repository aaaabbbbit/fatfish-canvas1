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
 *   openai-vision   POST {base}/chat/completions     把参考图读成文字（缺省）
 *   mj-describe     POST {base}/mj/submit/describe   同上，MJ 系网关的两次往返：
 *                   GET  {base}/mj/task/{id}/fetch   提交拿任务 id、轮询到出文字
 *   mj-imagine      POST {base}/mj/submit/imagine    出图也是两次往返（见
 *                   GET  {base}/mj/task/{id}/fetch   generateImageViaMj）；**参数
 *                                                    拼进提示词**而不是请求体
 *   kie-jobs        POST {base}/jobs/createTask      图与视频共用的一条任务式协议：
 *                   GET  {base}/jobs/recordInfo?…    提交拿 data.taskId，再轮询
 *                                                    recordInfo；结果在
 *                                                    data.resultJson（JSON 字符串）
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
 * **请求体有两种形状**，按模型的 `wire`（来自预置表）分：缺省是上面那套 OpenAI 兼容的
 * 平铺体；`seedance-nz` 那一族（`minimax-h3-ow-*`）每个字段名都不同 ——
 * `{ model, prompt, images[], seconds, metadata: { resolution, ratio } }`，见 `videoBody`。
 * 响应侧不分，仍旧嗅探。
 *
 * @module fatfish-canvas/host/providers
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
	 * 参考图地址（已由 host/reference.ts 解析成 `http(s)` / `data:`），**按顺序**。
	 * 提供了它就走图生图 / 视频首帧；否则是纯文生图。
	 *
	 * 多张的两种载荷（见 `referencePayload` / `postImageEdits`）：
	 *   JSON 路径   同一个字段名，值是**数组**（`image: ["url1","url2"]`）
	 *   edits 路径  同一个字段名**重复多份** multipart 文件（`reference-1.png`…）
	 */
	references?: readonly string[];
	/**
	 * 这次调用**临时**覆盖的模型参数（键已由管线按模型的声明校验过）。
	 *
	 * 与 `model.params`（设置里定的那份）分开传，是为了让「谁的值赢」写在
	 * 请求体拼装处一行里就能看出来：**调用时传的覆盖设置里的默认**。
	 */
	params?: Record<string, string | number | boolean>;
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

/**
 * JSON 请求体里的参考图值。
 *
 * **一张时保持字符串**（升级前就是这个形状，老网关照旧收）；**多张时是数组** ——
 * 字段名不变，因此想把数组塞进 `images` 的网关只要把 `referenceField` 改成
 * `images` 就行（网关之间连字段名都不统一，这是既有的做法）。
 *
 * ⚠️ 数组这一形状参考 T8-penguin-canvas（`body.images = refs` /
 * `extra_body.image = refs` 都是数组）。
 * @param references - 已解析的参考图地址（按顺序）。
 * @returns 要写进请求体的值；没有参考图时 undefined。
 */
function referencePayload(references: readonly string[] | undefined): string | string[] | undefined {
	if (references === undefined || references.length === 0) return undefined;
	return references.length === 1 ? references[0] : [...references];
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
 *
 * **多张 = 同一个字段名重复多份文件**（`image` 出现 N 次，文件名 `reference-1.png`
 * …）—— 这是 OpenAI 多图编辑的形状，也是 T8-penguin-canvas 的做法
 * （`files.forEach((file, index) => form.append('image', blob, 'reference-N.ext'))`）。
 * @param model - 已解析的模型。
 * @param request - 请求。
 * @param size - 像素尺寸。
 * @param references - 已解析的参考图地址（按顺序，至少一张）。
 * @param signal - 取消信号。
 * @returns 响应 JSON。
 */
async function postImageEdits(
	model: ResolvedModel,
	request: GenerateRequest,
	size: string,
	references: readonly string[],
	signal?: AbortSignal,
): Promise<any> {
	const form = new FormData();
	form.append('model', model.modelId);
	form.append('prompt', request.prompt);
	form.append('n', '1');
	form.append('size', size);
	// 质量轴（用户在设置里声明的档位参数）。`model`/`prompt`/`n`/参考图字段四个键在
	// catalog 的 RESERVED_PARAM_KEYS 里已被拒（既进不了 `model.params`，也过不了
	// 管线的 `filterParams`），因此这里的先后顺序不会写坏请求。
	for (const [name, value] of Object.entries({ ...model.params, ...request.params })) {
		form.append(name, String(value));
	}

	const field = referenceFieldOf(model);
	for (const [index, reference] of references.entries()) {
		const bytes = await referenceBytes(reference, signal);
		form.append(
			field,
			// Node 的 Blob 本来就吃 Uint8Array；这里只是 lib.dom 的 ArrayBufferView 泛型
			// 与 Node 的 Uint8Array<ArrayBufferLike> 对不上，加一次纯类型断言。
			new Blob([bytes.data as unknown as BlobPart], { type: bytes.mediaType }),
			`reference-${String(index + 1)}.${extensionOf(bytes.mediaType)}`,
		);
	}

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
	const references = request.references ?? [];
	const payload = referencePayload(references);

	const json =
		references.length > 0 && model.referenceMode === 'edits'
			? await postImageEdits(model, request, size, references, signal)
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
							// 参数**放在内置字段之后**：这是刻意的 —— 有的网关用 `size`
							// 而不是 `quality` 分档，声明成 `size` 就该能覆盖上面按比例
							// 算出来的那个值。设置里的默认在前、调用时传的在后（后者赢）。
							...model.params,
							...request.params,
							...(payload === undefined ? {} : { [referenceFieldOf(model)]: payload }),
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

/**
 * 提示词 + MJ 的参数 flag（`wire: 'mj-imagine'`）。
 *
 * MJ 的旋钮**不是请求体字段，而是提示词里的 flag**（`--ar 16:9`、`--stylize 250`、
 * 无值开关 `--tile`）—— 这是它和这个文件里其它每一家都不一样的地方。
 *
 * 三条规矩：
 *   - **设置里的默认在前、调用时传的在后**（后者赢），与其它 wire 同一套；
 *   - 工具参数算出来的比例**只在用户没自己声明比例时才写**：MJ 认最后一个 flag，
 *     写两个只会让「设置里填的那个」看起来没生效；
 *   - 值为 `false` 的开关**不写**（关闭一个 flag 只能靠不写它，MJ 没有 `--no-tile`）。
 * @param model - 已解析的模型（带设置里定的参数）。
 * @param request - 请求。
 * @returns 真正发出去的提示词。
 */
function mjPromptWithFlags(model: ResolvedModel, request: GenerateRequest): string {
	const params = { ...model.params, ...request.params };
	const flags: string[] = [];
	if (request.aspectRatio !== undefined && params['ar'] === undefined && params['aspect_ratio'] === undefined) {
		flags.push(`--ar ${request.aspectRatio}`);
	}
	for (const [key, value] of Object.entries(params)) {
		if (value === false) continue;
		flags.push(value === true ? `--${key}` : `--${key} ${String(value)}`);
	}
	// 提示词就是用户 / 聊天模型给的那句（设计技能注在聊天模型 system prompt，
	// 不进请求体 —— 见 src/index.ts 的段落注册），这里只把 flag 追加在整句之后：
	// MJ 的 flag 扫描认全句里的 `--xx` 记号。
	const prompt = request.prompt.trim();
	return flags.length === 0 ? prompt : `${prompt} ${flags.join(' ')}`;
}

/**
 * 出图：MJ 系网关（`wire: 'mj-imagine'`）—— 提交拿任务 id，再轮询到出图。
 *
 * 与缺省那条 `images/generations` 毫无共同点：
 *   - 请求体**只有** `prompt` 与可选的 `base64Array`（垫图，**只收 base64**，
 *     与 describe 同一条规矩），**没有 `model`** —— 模式（fast / relax / turbo）
 *     由令牌或**路径**决定，这条路走文档里的默认 `/mj`（实测默认即 fast）。
 *   - 参数进提示词，见 `mjPromptWithFlags`。
 *   - 结果**只认 `status === 'SUCCESS'` 时的 `imageUrl`**：文档明说这个字段
 *     「成功**或执行中**时有值」，先读它会把一张进度图读成成品 —— 与图生文那条
 *     路同一个坑（NOTES §8.64）。
 *   - 出来的是**一张四宫格**（2×2）。放大 / 变化要再调 `/mj/submit/action`，
 *     本插件还没接。
 *
 * ponytail: 只取 `imageUrl`（四宫格，实测 2912×1632），**不拆**响应里那四张分图
 * （`imageUrls`，各 1456×816）。天花板 = 用户拿到的是 2×2 拼图；要拆就得让一次调用
 * 落四个节点（`GeneratedMedia` 目前是单值，`host/tool.ts` 也只投影一个 url）。
 * @param model - 已解析的模型（`wire === 'mj-imagine'`）。
 * @param request - 请求。
 * @param signal - 取消信号。
 * @param timeoutMs - 整体超时（轮询用）。
 * @returns 生成结果（`prompt` 是**真正发出去的**那份，含 flag）。
 * @throws 取参考图失败 / 提交失败 / 任务失败 / 超时。
 */
async function generateImageViaMj(
	model: ResolvedModel,
	request: GenerateRequest,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<GeneratedMedia> {
	const base = trimSlash(model.baseURL);
	const references = request.references ?? [];
	const base64Array = await Promise.all(
		references.map(async (reference) => {
			const bytes = await referenceBytes(reference, signal);
			return `data:${bytes.mediaType};base64,${Buffer.from(bytes.data).toString('base64')}`;
		}),
	);
	const prompt = mjPromptWithFlags(model, request);

	const submitted = await postJson(
		`${base}/mj/submit/imagine`,
		{
			method: 'POST',
			headers: authHeaders(model),
			body: JSON.stringify({ prompt, ...(base64Array.length === 0 ? {} : { base64Array }) }),
			signal,
		},
		'MJ 出图提交',
	);
	// code 21/22（已存在 / 排队中）都带任务 id，是正常态；**没有 id 才是真失败**
	const taskId = typeof submitted?.result === 'string' ? submitted.result : '';
	if (taskId === '') {
		throw new Error(
			`MJ 出图提交失败：${String(submitted?.description ?? '')}` +
				`（${JSON.stringify(submitted).slice(0, 300)}）`,
		);
	}

	const deadline = Date.now() + timeoutMs;
	const pollUrl = `${base}/mj/task/${taskId}/fetch`;
	while (Date.now() < deadline) {
		await sleep(MJ_POLL_MS, signal);
		const poll = await postJson(pollUrl, { method: 'GET', headers: authHeaders(model), signal }, 'MJ 出图轮询');
		const status = typeof poll?.status === 'string' ? poll.status.toUpperCase() : '';
		if (status === 'FAILURE' || status === 'FAILED' || status === 'CANCEL') {
			const reason = typeof poll?.failReason === 'string' ? poll.failReason : '';
			throw new Error(`MJ 出图失败：供应商返回 ${status}${reason === '' ? '' : `（${reason}）`}`);
		}
		if (status === 'SUCCESS' && typeof poll?.imageUrl === 'string' && poll.imageUrl !== '') {
			const revised = typeof poll.promptEn === 'string' ? poll.promptEn.trim() : '';
			return {
				kind: 'image',
				url: poll.imageUrl,
				model: model.modelId,
				providerId: model.providerId,
				prompt,
				...(revised === '' ? {} : { revisedPrompt: revised }),
			};
		}
	}
	throw new Error(`MJ 出图超时（${String(Math.round(timeoutMs / 1000))} 秒）`);
}

/**
 * 从轮询响应里挖出视频地址（不同网关落点不同）。
 *
 * 先按已知落点直接取；取不到再按**形状**找一遍：递归任何一层，键名里带 `video`
 * 且值是 http(s) 地址就认。刻意只认 `video` 那一类键 —— 放宽到「任何 url」会把
 * 请求里回显的**参考图地址**当成果视频返回（MiniMax 系的 `image_url: { url }`
 * 正是这个形状，本项目自己也往请求里塞参考图）。
 * @param json - 轮询响应体。
 * @returns 视频地址，找不到返回 undefined。
 */
function extractVideoUrl(json: any): string | undefined {
	const candidates = [
		json?.data?.[0]?.url,
		json?.content?.video_url,
		json?.output?.url,
		json?.video_url,
		json?.url,
		json?.data?.[0]?.video_url,
		json?.data?.video_url,
		json?.data?.url,
		json?.result?.video_url,
		json?.result?.url,
		json?.videos?.[0]?.url,
		json?.output?.[0]?.url,
		// new-api 系中转站（api.seedance.nz 实测）的标准字段；那一家的三条落点里
		// 只有 `data.data.content.video_url` 带 "video"，所以这条得显式列出来
		json?.data?.result_url,
		json?.result_url,
	];
	for (const candidate of candidates) {
		if (typeof candidate === 'string' && candidate !== '') return candidate;
	}
	return findVideoUrl(json, '', new Set());
}

/**
 * 按形状递归找视频地址（键名带 `video`、值是 http(s) 链接）。
 * @param node - 当前节点。
 * @param key - 当前节点在父对象里的键名（根节点传空串）。
 * @param seen - 已访问过的对象，防环。
 * @returns 视频地址，找不到返回 undefined。
 */
function findVideoUrl(node: any, key: string, seen: Set<unknown>): string | undefined {
	if (typeof node === 'string') {
		return /video/i.test(key) && /^https?:\/\//i.test(node) ? node : undefined;
	}
	if (typeof node !== 'object' || node === null || seen.has(node)) return undefined;
	seen.add(node);
	for (const [childKey, value] of Object.entries(node as Record<string, unknown>)) {
		const hit = findVideoUrl(value, childKey, seen);
		if (hit !== undefined) return hit;
	}
	return undefined;
}

/**
 * 把视频这条路的原始响应落盘（`lib/host/` 下，提交与轮询各一份）。
 *
 * 为什么值得留：轮询超时有三种完全不同的原因 —— 供应商压根没出片、出了片但字段
 * 没被认出来、任务 id 没取到 —— 光看错误文案分不清，而三种的修法完全相反。
 * @param name - 文件名（不含扩展名），如 `last-video-submit`。
 * @param url - 请求地址。
 * @param body - 响应体。
 */
function dumpVideoDebug(name: string, url: string, body: unknown): void {
	try {
		writeFileSync(
			fileURLToPath(new URL(`./${name}.json`, import.meta.url)),
			`${JSON.stringify({ at: new Date().toISOString(), url, body }, null, 2)}\n`,
			'utf8',
		);
	} catch {
		// 排查用的副产品：写不进去（只读盘之类）不能连累生成
	}
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
 * 实测）是 `/video/generations`（单数）。只在「这条路由不存在」时才换下一个：那说明
 * 请求根本没到这个地址的模型上，重发不会重复扣费；其余错误一律如实抛出。
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
			if (!isRouteMiss(error)) throw error;
		}
	}
	throw new Error(
		`视频生成失败：这个地址上没有视频端点（试过 ${paths.join('、')}）—— 检查接口基址是否写全（例如要带 /v1）`,
	);
}

/**
 * 这个错误是不是「路由没命中」。
 *
 * 「路由不存在」有两种长相，都表示请求没走到模型上：网关回自家 HTML 首页
 * （贞贞工坊，HTTP 451），或者回 JSON 404（api.seedance.nz 实测：
 * `Invalid URL (POST /v1/videos/generations)`）。后者同样是路由没命中，
 * 不能当成业务错误直接抛 —— 只是这里没有 htmlPage 那个标记可用。
 *
 * 刻意不认其他状态码：400 / 401 / 422 说明供应商看懂了请求并拒绝，
 * 换路径重发既没意义，还会把真正的错误盖掉。
 * @param error - `postJson()` 抛出的错误。
 * @returns 可以换下一个路径重试时为 true。
 */
function isRouteMiss(error: unknown): boolean {
	if ((error as Partial<HtmlPageError>).htmlPage === true) return true;
	const message = error instanceof Error ? error.message : '';
	return message.includes('HTTP 404') || /invalid url/i.test(message);
}

/**
 * 视频请求体（两种形状，按模型的 `wire` 分）。
 *
 * **缺省**是 OpenAI 兼容那套平铺体；`seedance-nz` 那一族（`minimax-h3-ow-*`）
 * 每个字段名都不一样，照 api.seedance.nz 的文档拼：
 *
 * ```
 * { model, prompt, images[], seconds, metadata: { resolution, ratio, … } }
 * ```
 *
 * 两个协议里，**设置里的默认值都排在工具参数之前**（调用时传的再盖过设置）——
 * 与图像那条路同一套规矩，也是「设置页里填的那个框真的生效」的落点。
 * @param model - 已解析的模型。
 * @param request - 请求。
 * @returns 要序列化的请求体。
 */
function videoBody(model: ResolvedModel, request: GenerateRequest): Record<string, unknown> {
	const params = { ...model.params, ...request.params };
	const payload = referencePayload(request.references);

	if (model.wire === 'seedance-nz') {
		// `seconds` 之外的声明键全归 `metadata`（那一族的旋钮都在里面）
		const { seconds, ...extra } = params;
		// 分辨率这一族**大写**（480P / 768P / 1080P），工具参数那边是小写；
		// 两个算出来的值**写在展开之后**，免得设置里手打的 '768p' 原样漏过去
		const resolution = String(extra.resolution ?? request.resolution ?? '480P').toUpperCase();
		const ratio = String(extra.ratio ?? request.aspectRatio ?? '16:9');
		// 参考图在这个协议里叫 `images`、而且是**数组**；供应商显式配了别的字段名就用它的
		const configured = referenceFieldOf(model);
		const field = configured === 'image' ? 'images' : configured;
		return {
			model: model.modelId,
			prompt: request.prompt,
			...(payload === undefined
				? {}
				: { [field]: Array.isArray(payload) ? payload : [payload] }),
			seconds: String(seconds ?? request.duration ?? 5),
			metadata: { ...extra, resolution, ratio },
		};
	}

	return {
		model: model.modelId,
		prompt: request.prompt,
		duration: request.duration ?? 5,
		resolution: request.resolution ?? '480p',
		// 档位参数（质量轴），同上：放在内置字段之后，可覆盖 resolution
		...model.params,
		...request.params,
		...(request.aspectRatio !== undefined ? { aspect_ratio: request.aspectRatio } : {}),
		...(payload === undefined ? {} : { [referenceFieldOf(model)]: payload }),
	};
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

	const submitted = await submitVideo(base, {
		method: 'POST',
		headers: authHeaders(model),
		body: JSON.stringify(videoBody(model, request)),
		signal,
	});
	const json = submitted.json;
	dumpVideoDebug('last-video-submit', `${base}${submitted.path}`, json);

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

	// 任务 id 的落点和视频地址一样杂：顶层 `id` / `task_id`，或者 data 里
	// （`data` 既可能是数组也可能是对象 —— new-api 系是对象）。
	const taskId =
		json?.id ??
		json?.task_id ??
		json?.data?.[0]?.task_id ??
		json?.data?.[0]?.id ??
		json?.data?.task_id ??
		json?.data?.id;
	if (typeof taskId !== 'string' || taskId === '') {
		throw new Error(
			`视频生成失败：响应里既没有视频地址也没有任务 id（${JSON.stringify(json).slice(0, 300)}）`,
		);
	}

	const deadline = Date.now() + timeoutMs;
	const pollUrl = `${base}${submitted.path}/${taskId}`;
	/** 最后一次轮询响应：超时时连同错误一起报出来，也落盘留证（见 dumpVideoDebug）。 */
	let lastPoll: unknown;
	while (Date.now() < deadline) {
		await sleep(3000, signal);
		const poll = await postJson(
			pollUrl,
			{ method: 'GET', headers: authHeaders(model), signal },
			'视频生成轮询',
		);
		lastPoll = poll;
		dumpVideoDebug('last-video-poll', pollUrl, poll);
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
	throw new Error(
		`视频生成超时（${String(Math.round(timeoutMs / 1000))} 秒）：最后一次轮询响应 ${JSON.stringify(lastPoll ?? null).slice(0, 300)}`,
	);
}

/**
 * 出图 / 出片：kie.ai 的任务式协议（`wire: 'kie-jobs'`）。
 *
 * 图与视频走**同一条**路（kie 的模型清单里图像、视频各占一半，端点却是同一个）：
 *   - 提交 `POST {base}/jobs/createTask { model, input }` → `data.taskId`；
 *   - 轮询 `GET {base}/jobs/recordInfo?taskId=…` → `data.state` 走到 `success`；
 *   - 结果在 `data.resultJson` 里，而它**是一个 JSON 字符串**（要再解析一次），
 *     首个地址在 `resultUrls[0]`。
 *
 * 三处与别家不同，都在这里钉死：
 *   ① 参数（含提示词、比例、参考图）全在 `input` 里，不是平铺的请求体；
 *   ② 任务 id 走**查询串**，不是 `{提交路径}/{id}` 那种路径式；
 *   ③ 失败不体现在 HTTP 状态上 —— 未认证 / 校验错 / 限流都回 **HTTP 200**，
 *      结论藏在 `body.code` 里。不查它就会把「密钥不对」读成提交成功，
 *      然后等一个永远不来的结果（见 `kieErrorOf`）。
 *
 * 参考图的字段名各家不同（`nano-banana-2` 是 `image_input`，seedream / kling /
 * seedance 那几族是 `image_urls`），因此仍由供应商配置的 `referenceField` 决定，
 * 这里只把**默认值**换成 kie 主用的那个（`referenceFieldOf` 的 `image` 在 kie 上
 * 没有任何一族认）。
 * @param model - 已解析的模型（`wire === 'kie-jobs'`）。
 * @param request - 请求。
 * @param signal - 取消信号。
 * @param timeoutMs - 整体超时（轮询用）。
 * @returns 生成结果。
 * @throws 提交失败 / 任务失败 / 超时。
 */
async function generateViaKieJobs(
	model: ResolvedModel,
	request: GenerateRequest,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<GeneratedMedia> {
	const base = trimSlash(model.baseURL);
	const payload = referencePayload(request.references);
	const configured = model.referenceField.trim();
	const field = configured === '' ? KIE_REFERENCE_FIELD : configured;
	// 设置里的默认在前、调用时传的在后（后者赢）—— 与这个文件里其它每一条路同一套规矩
	const input: Record<string, unknown> = {
		prompt: request.prompt,
		...(request.aspectRatio === undefined ? {} : { aspect_ratio: request.aspectRatio }),
		...(request.duration === undefined ? {} : { duration: request.duration }),
		...(request.resolution === undefined ? {} : { resolution: request.resolution }),
		...model.params,
		...request.params,
		// 参考图**永远是数组**（kie 的 `image_urls` / `image_input` 都收数组）
		...(payload === undefined ? {} : { [field]: Array.isArray(payload) ? payload : [payload] }),
	};

	const submitted = await postJson(
		`${base}/jobs/createTask`,
		{
			method: 'POST',
			headers: authHeaders(model),
			body: JSON.stringify({ model: model.modelId, input }),
			signal,
		},
		'kie 提交任务',
	);
	const submitError = kieErrorOf('kie 提交任务', submitted);
	if (submitError !== '') throw new Error(submitError);
	const taskId = typeof submitted?.data?.taskId === 'string' ? submitted.data.taskId : '';
	if (taskId === '') {
		throw new Error(`kie 提交任务失败：响应里没有 data.taskId（${JSON.stringify(submitted).slice(0, 300)}）`);
	}

	const deadline = Date.now() + timeoutMs;
	const pollUrl = `${base}/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`;
	/** 最后一次轮询响应：超时时连同错误一起报出来（与视频那条路同一做法）。 */
	let lastPoll: unknown;
	while (Date.now() < deadline) {
		await sleep(KIE_POLL_MS, signal);
		const poll = await postJson(pollUrl, { method: 'GET', headers: authHeaders(model), signal }, 'kie 任务轮询');
		lastPoll = poll;
		const pollError = kieErrorOf('kie 任务轮询', poll);
		if (pollError !== '') throw new Error(pollError);
		const data = poll?.data;
		const state = typeof data?.state === 'string' ? data.state.toLowerCase() : '';
		if (state === 'fail' || state === 'failed') {
			const reason = [data?.failCode, data?.failMsg]
				.filter((value: unknown): value is string => typeof value === 'string' && value !== '')
				.join(' ');
			throw new Error(`kie 生成失败：${reason === '' ? '供应商没给原因' : reason}`);
		}
		const url = kieResultUrl(data?.resultJson);
		if (url !== undefined) {
			return {
				kind: model.kind === 'video' ? 'video' : 'image',
				url,
				model: model.modelId,
				providerId: model.providerId,
				prompt: request.prompt,
			};
		}
	}
	throw new Error(
		`kie 生成超时（${String(Math.round(timeoutMs / 1000))} 秒）：最后一次轮询响应 ${JSON.stringify(lastPoll ?? null).slice(0, 300)}`,
	);
}

/** kie 轮询的间隔（它的图通常十几秒、视频几分钟，与视频那条路同一节奏）。 */
const KIE_POLL_MS = 3000;

/**
 * kie 默认的参考图字段名。
 *
 * 取 `image_urls`：kie 的 seedream / kling / seedance / flux 几族都用它，只有
 * `nano-banana-2` 那一族叫 `image_input` —— 要它就在供应商配置里改
 * `referenceField`（那一族单独开一个供应商条目即可，基址与密钥可以同一份）。
 */
const KIE_REFERENCE_FIELD = 'image_urls';

/**
 * kie 的失败判据：**看 `body.code`，不看 HTTP 状态码**。
 *
 * 这家把未认证（401）/ 校验错（422）/ 限流（429）都包在 HTTP 200 里返回，因此
 * `response.ok` 在这里等于没有信息量。`code` 缺省（不是它的响应形状）时不拦，
 * 交给调用方按成功解析 —— 免得把别的网关的响应误判成失败。
 * @param what - 动作描述。
 * @param json - 响应体。
 * @returns 错误文案；不是失败时为空串。
 */
function kieErrorOf(what: string, json: any): string {
	const code = json?.code;
	if (code === undefined || code === 200) return '';
	const message = typeof json?.msg === 'string' ? json.msg : '';
	return `${what}失败：kie 返回 code ${String(code)}${message === '' ? '' : `（${message}）`}`;
}

/**
 * 从 `data.resultJson` 里取第一个结果地址。
 *
 * 它是**一个 JSON 字符串**（kie 的文档与实测都如此）：`{"resultUrls":["…"]}`，
 * 因此要再解析一次 —— 当成对象读会得到 undefined，而那个失败看起来像
 * 「任务成功了却没有图」，最难查。
 * @param resultJson - `data.resultJson`。
 * @returns 首个地址；没有 / 解析不了时 undefined。
 */
function kieResultUrl(resultJson: unknown): string | undefined {
	if (typeof resultJson !== 'string' || resultJson === '') return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(resultJson);
	} catch {
		return undefined;
	}
	const urls = (parsed as { resultUrls?: unknown })?.resultUrls;
	if (!Array.isArray(urls)) return undefined;
	return urls.find((url): url is string => typeof url === 'string' && url !== '');
}

/**
 * 按模型的适配器分发。
 *
 * 图像的两种形状按 `wire` 分：缺省是 OpenAI 兼容的 `/images/generations`，
 * `mj-imagine` 那条是 MJ 的「提交 + 轮询」（见 `generateImageViaMj`）。
 * @param model - 已解析的模型（供应商 × 模型，见 host/schema.ts）。
 * @param request - 请求。
 * @param signal - 取消信号。
 * @param timeoutMs - 整体超时（视频轮询与 MJ 出图轮询用）。
 * @returns 生成结果。
 */
export async function generate(
	model: ResolvedModel,
	request: GenerateRequest,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<GeneratedMedia> {
	// kie 的图与视频是同一条任务式协议，先按 wire 分掉
	if (model.wire === 'kie-jobs') return generateViaKieJobs(model, request, signal, timeoutMs);
	if (model.api === 'openai-images') {
		return model.wire === 'mj-imagine'
			? generateImageViaMj(model, request, signal, timeoutMs)
			: generateImage(model, request, signal);
	}
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
 * MJ 图生文的轮询间隔与默认等待上限。
 *
 * 实测一次 describe 约 15 秒（ai.t8star.org），3 秒一问足够；上限只是兜底 ——
 * 正常路径由调用方传进来的 `timeoutMs`（设置里的整体超时）决定。
 */
const MJ_POLL_MS = 3000;
const MJ_DESCRIBE_TIMEOUT_MS = 180000;

/**
 * MJ 任务里的**描述文字**。
 *
 * 实测（2026-10-05，ai.t8star.org）：文字落在 `prompt` 里，而 `description` 是斜杠
 * 命令（完成时是字面量 `"/describe"`、刚提交时是 `"提交成功"`）—— 照字段名想当然
 * 取 `description`，拿到的就是一句 "/describe"。`properties.finalPrompt` 是同一份文字，
 * 留着当各家中转的退路。
 * @param json - `GET /mj/task/{id}/fetch` 的响应。
 * @returns 描述文字；还没出结果时是空串。
 */
function mjTextOf(json: any): string {
	const prompt = typeof json?.prompt === 'string' ? json.prompt.trim() : '';
	if (prompt !== '') return prompt;
	const final = json?.properties?.finalPrompt;
	return typeof final === 'string' ? final.trim() : '';
}

/**
 * 一张参考图 → 一段文字（MJ 系网关：提交拿任务 id，再轮询到出文字）。
 *
 * MJ 的 describe **只收 base64**（不收地址），因此这里先把参考图取成字节再内联 ——
 * 与 `chat/completions` 那条路相反（那边本来就是内联地址）。任务式还有个好处：
 * 网关自己排队，撞上限流（提交回「排队中」）也照样给一个任务 id，轮询等就是了。
 * @param model - 已解析的视觉模型（`wire === 'mj-describe'`）。
 * @param reference - 一张参考图的地址（`http(s)` / `data:` / 归档路径）。
 * @param signal - 取消信号。
 * @param timeoutMs - 整体超时。
 * @returns 描述文字（保证非空）。
 * @throws 取图失败 / 提交失败 / 任务失败 / 超时。
 */
async function describeOneViaMj(
	model: ResolvedModel,
	reference: string,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<string> {
	const base = trimSlash(model.baseURL);
	const image = await referenceBytes(reference, signal);
	const base64 = `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`;

	const submitted = await postJson(
		`${base}/mj/submit/describe`,
		{ method: 'POST', headers: authHeaders(model), body: JSON.stringify({ base64 }), signal },
		'参考图描述提交',
	);
	const taskId = submitted?.result;
	if (typeof taskId !== 'string' || taskId === '') {
		throw new Error(
			`参考图描述提交失败：${String(submitted?.description ?? '')}` +
				`（${JSON.stringify(submitted).slice(0, 300)}）`,
		);
	}

	const deadline = Date.now() + timeoutMs;
	const pollUrl = `${base}/mj/task/${taskId}/fetch`;
	while (Date.now() < deadline) {
		await sleep(MJ_POLL_MS, signal);
		const poll = await postJson(pollUrl, { method: 'GET', headers: authHeaders(model), signal }, '参考图描述轮询');
		// 失败态**先判**：这个网关的 `prompt` 字段在别的状态下也可能有值（描述、
		// 或命令原文），先读文字会把一次失败读成一次成功
		const status = typeof poll?.status === 'string' ? poll.status.toUpperCase() : '';
		if (status === 'FAILURE' || status === 'FAILED' || status === 'CANCEL') {
			const reason = typeof poll?.failReason === 'string' ? poll.failReason : '';
			throw new Error(`参考图描述失败：供应商返回 ${status}${reason === '' ? '' : `（${reason}）`}`);
		}
		const text = mjTextOf(poll);
		if (text !== '') return text;
	}
	throw new Error(`参考图描述超时（${String(Math.round(timeoutMs / 1000))} 秒）`);
}

/**
 * 让视觉模型描述参考图。
 *
 * 两条协议，按模型的 `wire` 分（缺省那条覆盖面最广）：
 *   - 缺省：`POST {base}/chat/completions` —— 中转站与各家兼容层都提供它，而且
 *     **同一个供应商的密钥**就能用（用户不必为视觉模型再配一处凭据，这正是它和
 *     图像 / 视频模型挤在同一个供应商字典里的原因）。图片以地址内联 —— 参考图本来
 *     就已经是 `http(s)` / `data:`，再要求供应商去下载一次只会多一处失败点。
 *   - `mj-describe`：MJ 系网关的「提交 + 轮询」，见 `describeOneViaMj`。
 *
 * **多张 = 缺省那条一次往返里多个 `image_url` 内容块**（`chat/completions` 的 content
 * 本来就是数组）：一次拿到一段综合描述，比逐张调用既便宜又不丢「几张图之间的
 * 关系」（这正是多参考图最常见的用法）。MJ 那条收不了数组，因此是每张一个任务、
 * 并发跑完再拼起来。
 * @param model - 已解析的视觉模型（见 `findVisionModel`）。
 * @param request - 参考图地址（按顺序）与用户提示词。
 * @param signal - 取消信号。
 * @param timeoutMs - MJ 那条路的整体超时（轮询用）；缺省 3 分钟。
 * @returns 描述文字（保证非空）。
 * @throws 网络 / 鉴权 / 响应形状异常时 —— 文案可直接展示。
 */
export async function describeImage(
	model: ResolvedModel,
	request: { references: readonly string[]; prompt: string },
	signal?: AbortSignal,
	timeoutMs = MJ_DESCRIBE_TIMEOUT_MS,
): Promise<string> {
	if (model.wire === 'mj-describe') {
		const texts = await Promise.all(
			request.references.map((reference) => describeOneViaMj(model, reference, signal, timeoutMs)),
		);
		const joined = texts
			.map((text) => text.trim())
			.filter((text) => text !== '')
			.join('\n');
		if (joined === '') throw new Error('参考图描述失败：MJ 没回任何文字');
		return joined;
	}

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
							...request.references.map((url) => ({ type: 'image_url', image_url: { url } })),
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
