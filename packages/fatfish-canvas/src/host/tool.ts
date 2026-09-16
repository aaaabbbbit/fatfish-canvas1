/**
 * `media_generate` 工具定义（宿主半边）。
 *
 * 刻意用**对象字面量**满足 `ToolDefinition` 契约，而不是导入
 * `@deepseek-ai/dsh-tools` 的 `defineTool` —— 那样会为了一次结构匹配而多出
 * 一个运行时依赖，而 out-of-tree 插件每多一个依赖就多一处版本漂移面。
 * `ctx.tools.register(def)` 只读结构，不检查原型。
 *
 * 呈现面：`output.presentationMeta` 把生成结果投影成工具结果的自定义 meta，
 * 客户端因此能在**对话流里直接显示图像**，并把它作为画布节点落地（P3）——
 * 这条通路不需要任何新的 RPC 面，结果随 tool/result 事件自然到达浏览器。
 *
 * @module fatfish-canvas/host/tool
 */

import { MEDIA_META_KEY, MEDIA_TOOL_NAME } from '../client/shared/media';
import { runGeneration, type GenerationDeps, type GenerationValue } from './generate';
import type { MediaAttachmentRef } from './reference';
import { attachedImageRef, type SessionLike } from './session-images';
import type { MediaKind } from './schema';

/**
 * 工具名。定义在**共享模块**里：客户端要按同一个名字登记 keyed tool view，
 * 两处各写一份字面量迟早会漂移成「工具在聊天里渲染成 JSON」。
 */
export { MEDIA_TOOL_NAME };

/**
 * `reference` 的哨兵值：用用户在这一轮消息里附的那张图。
 *
 * 存在的理由就是文本模型：它只看得到一行 `[image omitted …]`，让它自己写地址
 * 只能瞎编。写 `"attached"` 就等于「我刚贴的那张」—— 一个它抄得动的短字符串。
 */
export const REFERENCE_ATTACHED = 'attached';

/** 一次工具执行里本模块用到的那一面（`dsh-tools` 的 `ToolExecution`）。 */
interface MediaExec {
	/** 取消信号。 */
	signal?: AbortSignal;
	/** 调用方 agent（带会话，用来找用户附的图）。 */
	agent?: { session?: SessionLike };
}

/** 一次调用定下来的参考图与「要不要给它配文字」。 */
interface CallReference {
	/** 参考图句柄；这次不用参考图时缺席。 */
	reference?: string | MediaAttachmentRef;
	/** 当前路由看不见图 → 该请视觉模型把参考图读成一段文字。 */
	blind: boolean;
}

/**
 * 决定这次调用用哪张参考图、要不要配一段文字描述。
 *
 * 这条规则就是「看得见就自己看、看不见就换一种方式」那件事的落点：
 *
 *   写了 `reference`        → 用写的（`"attached"` = 用户刚附的那张）
 *   没写 + 路由**看得见图**  → 不用参考图：多模态模型自己看得见，该不该参考它说了算
 *   没写 + 路由看不见/未知   → 自动用用户本回合附的那张：文本模型手上只有一行摘要，
 *                             没有别的办法把图交给生成 API
 *
 * `blind` 与「这次有没有参考图」无关，只看路由能力：看不见图的模型哪怕自己给了
 * 一个地址，也仍然需要有人告诉它那地址后面是什么（它可不会去下载）。
 * @param deps - 管线依赖（含 `routeSeesImages`）。
 * @param requested - 模型给的 `reference` 参数（可能缺席）。
 * @param exec - 执行上下文（会话从这里来）。
 * @returns 定下来的参考图与「是否看不见图」。
 * @throws 写了 `"attached"` 但这一轮没有图片附件时。
 */
async function resolveCallReference(
	deps: MediaToolDeps,
	requested: string | undefined,
	exec: MediaExec | undefined,
): Promise<CallReference> {
	const session = exec?.agent?.session;
	const blind = (await deps.routeSeesImages?.(session)) !== true;

	if (requested !== undefined) {
		if (requested !== REFERENCE_ATTACHED) return { reference: requested, blind };
		const attached = attachedImageRef(session);
		if (attached === undefined) {
			throw new Error(
				'这次要求用「你附的那张图」当参考图，但当前这一轮消息里没有图片附件。' +
					'请让用户把图片贴进输入框，或者给出图片地址。',
			);
		}
		return { reference: attached, blind };
	}

	if (!blind) return { blind };
	const attached = attachedImageRef(session);
	return attached === undefined ? { blind } : { reference: attached, blind };
}

/** 工具依赖：与 `/generate` 命令共用同一份管线依赖。 */
export type MediaToolDeps = GenerationDeps;

/** 解析后的工具参数。 */
interface MediaArgs {
	prompt: string;
	kind: MediaKind;
	provider?: string;
	aspectRatio?: string;
	resolution?: string;
	duration?: number;
	reference?: string;
}

/** 参数 JSON Schema。 */
const PARAMETERS = {
	type: 'object',
	properties: {
		prompt: {
			type: 'string',
			description: '要生成的内容描述。写清楚主体、风格、构图；中英文都可以。',
		},
		kind: {
			type: 'string',
			enum: ['image', 'video'],
			description: '生成图像还是视频，默认 image。',
		},
		provider: {
			type: 'string',
			description:
				'指定用哪个模型生成（P9 起供应商与模型都是用户配的）。三种写法：' +
				'「供应商::模型」（如 acme::acme-large，最精确）、「供应商」（用它下面第一个可用模型）、' +
				'或者光一个模型名。省略则用设置里的默认模型，再退到第一个配好密钥的模型。',
		},
		aspectRatio: {
			type: 'string',
			enum: ['1:1', '16:9', '4:3', '3:4', '9:16'],
			description: '画幅比例，默认 1:1（视频默认 16:9）。',
		},
		resolution: {
			type: 'string',
			enum: ['480p', '1080p'],
			description: '视频分辨率，默认取供应商配置。',
		},
		duration: {
			type: 'number',
			description: '视频时长（秒），默认取供应商配置。',
		},
		reference: {
			type: 'string',
			description:
				'参考图（图生图 / 视频首帧）。三种写法：① http(s) 链接、工作区里的图片文件路径、' +
				'或上一张生成结果里的地址（你**看得见图片**时用这种，也可以顺手描述图里的内容）；' +
				'② 直接写 "attached" = 用用户在**这一轮消息里附的**那张图；③ 省略。' +
				'你**看不到图片**时（纯文本模型）不要猜图里有什么，也不要编地址：' +
				'省略即可 —— 用户这一轮附了图的话，宿主会自动把它当参考图；' +
				'若要明确指定，就写 "attached"。',
		},
	},
	required: ['prompt'],
} as const;

/** 规范化后的生成结果（canonical value）—— 与管线产物同形。 */
type MediaValue = GenerationValue;

/** 结果 JSON Schema。 */
const OUTPUT_SCHEMA = {
	type: 'object',
	properties: {
		kind: { type: 'string', enum: ['image', 'video'] },
		url: { type: 'string' },
		model: { type: 'string' },
		providerId: { type: 'string' },
		prompt: { type: 'string' },
		aspectRatio: { type: 'string' },
		width: { type: 'number' },
		height: { type: 'number' },
		mimeType: { type: 'string' },
		usedReference: { type: 'boolean' },
		referenceDescription: { type: 'string' },
	},
	required: ['kind', 'url', 'model', 'providerId', 'prompt', 'aspectRatio'],
} as const;

/**
 * 把模型给的参数收敛成内部形状。
 * @param raw - 模型参数（已由注册表校验过 schema）。
 * @returns 解析后的参数。
 */
function parseArgs(raw: unknown): MediaArgs {
	const o = (raw ?? {}) as Record<string, unknown>;
	const prompt = typeof o.prompt === 'string' ? o.prompt.trim() : '';
	if (prompt === '') throw new Error('prompt 不能为空');
	const kind: MediaKind = o.kind === 'video' ? 'video' : 'image';
	const args: MediaArgs = { prompt, kind };
	if (typeof o.provider === 'string' && o.provider !== '') args.provider = o.provider;
	if (typeof o.aspectRatio === 'string' && o.aspectRatio !== '') args.aspectRatio = o.aspectRatio;
	if (typeof o.resolution === 'string' && o.resolution !== '') args.resolution = o.resolution;
	if (typeof o.duration === 'number' && Number.isFinite(o.duration)) args.duration = o.duration;
	if (typeof o.reference === 'string' && o.reference.trim() !== '') args.reference = o.reference.trim();
	return args;
}

/**
 * 造出工具定义。
 * @param deps - 依赖。
 * @returns `ctx.tools.register` 可直接接受的工具定义。
 */
export function createMediaTool(deps: MediaToolDeps): Record<string, unknown> {
	return {
		name: MEDIA_TOOL_NAME,
		description:
			'用已配置的图像 / 视频模型生成媒体。生成的图像或视频会同时出现在对话与左侧画布上。' +
			'用户要求「画一张…」「生成一段视频…」时调用本工具。' +
			'若尚未配置密钥，本工具会返回明确提示，请把该提示转告用户。',

		parameters: PARAMETERS,

		output: {
			schema: OUTPUT_SCHEMA,
			/**
			 * 模型看到的正文：给出 URL 与关键参数，便于它后续引用或继续生成。
			 * @param args - 参数。
			 * @param value - canonical 值。
			 * @returns 内容块。
			 */
			render(args: unknown, value: unknown): unknown[] {
				const v = value as MediaValue;
				const label = v.kind === 'video' ? '视频' : '图像';
				const size = v.width !== undefined && v.height !== undefined ? ` ${String(v.width)}×${String(v.height)}` : '';
				const ref = v.usedReference === true ? '，带参考图' : '';
				// 看不见图的模型从这里拿到「图里有什么」：这段文字既进了生成提示词，
				// 也回给模型自己，好让它接着讨论、改提示词或回答用户的问题。
				const described =
					v.referenceDescription === undefined ? '' : `\n参考图内容：${v.referenceDescription}`;
				return [
					{
						type: 'text',
						text: `已生成${label}（模型 ${v.model}，供应商 ${v.providerId}${size}${ref}）${described}\n${v.url}`,
					},
				];
			},
			/**
			 * 客户端呈现用的 meta：画布与对话流据此渲染媒体。
			 * @param args - 参数。
			 * @param value - canonical 值。
			 * @returns JSON 安全的呈现负载。
			 */
			presentationMeta(args: unknown, value: unknown): unknown {
				const v = value as MediaValue;
				return {
					[MEDIA_META_KEY]: {
						kind: v.kind,
						url: v.url,
						model: v.model,
						providerId: v.providerId,
						prompt: v.prompt,
						aspectRatio: v.aspectRatio,
						...(v.width !== undefined ? { width: v.width } : {}),
						...(v.height !== undefined ? { height: v.height } : {}),
						...(v.mimeType !== undefined ? { mimeType: v.mimeType } : {}),
						...(v.usedReference === true ? { usedReference: true } : {}),
						// 给界面看的那段描述（用户在工具行里能核对视觉模型「看到了什么」）
						...(v.referenceDescription === undefined
							? {}
							: { referenceDescription: v.referenceDescription }),
					},
				};
			},
		},

		/**
		 * 执行一次生成。
		 *
		 * 真正的管线在 `host/generate.ts`（与 `/generate` 命令共用）：这里只负责
		 * 把模型参数收敛成请求，并把管线的异常原样抛出 —— 工具注册表会把它
		 * materialize 成错误结果，模型与用户都能看到那句可读的文案。
		 *
		 * 参考图在这里定下来（见 `resolveCallReference`）：模型给的地址、用户附的图、
		 * 或者两者都不用（多模态模型自己看得见时）。
		 * @param raw - 模型参数。
		 * @param exec - 执行上下文（取消信号 + 调用方 agent/会话）。
		 * @returns canonical 值。
		 */
		async execute(raw: unknown, exec: MediaExec): Promise<unknown> {
			const { reference: requested, ...args } = parseArgs(raw);
			const call = await resolveCallReference(deps, requested, exec);
			return runGeneration(
				deps,
				{
					...args,
					...(call.reference === undefined ? {} : { reference: call.reference }),
					// 看不见图的模型：让视觉模型读一遍参考图（没配视觉模型就是空操作）
					...(call.blind ? { describeReference: true } : {}),
				},
				exec?.signal,
			);
		},

		/**
		 * 待办状态的呈现：让用户在等待时就看到「在画什么」。
		 * @param raw - 模型参数。
		 * @returns 呈现意图。
		 */
		presentCall(raw: unknown): unknown {
			const o = (raw ?? {}) as Record<string, unknown>;
			const kind = o.kind === 'video' ? '视频' : '图像';
			const prompt = typeof o.prompt === 'string' ? o.prompt : '';
			return { card: 'generic', title: `生成${kind}`, input: prompt };
		},

		/**
		 * 并发分类：不同提示词之间互不干扰，可以并行；但同类供应商常有速率限制，
		 * 因此保守地声明为独占（不实现 `isConcurrencySafe` 即默认独占）。
		 */
	};
}
