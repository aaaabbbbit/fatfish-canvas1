/**
 * 一次生成的**公共管线**（宿主半边）。
 *
 * P2 里这段逻辑长在工具定义内部；P6 加 `/generate` 直达命令之后，工具与命令
 * 都要「按参数挑供应商 → 校验密钥 → 调适配器 → 归一化结果」这同一条链。
 * 把它抽出来只有一个理由：**两处各写一份迟早会分叉**（例如只在一处加了
 * 「点名供应商但没密钥」的提示），而这类分叉表现为「同一个错误，两种说法」。
 *
 * 出错一律 **throw**：工具需要抛出（由工具注册表materialize成错误结果），
 * 命令需要捕获后转成 `{ kind: 'error', text }`。两边各自决定怎么呈现，
 * 但错误文案来自这里一处。
 *
 * @module fatfish-canvas/host/generate
 */

import { archiveGeneration, expandHome } from './archive';
import { describeImage, generate } from './providers';
import { resolveReferences, type MediaAttachmentRef, type ReadAttachment } from './reference';
import type { SessionLike } from './session-images';
import { coerceParam } from '../client/shared/modelPresets';
import { findVisionModel, isUsable, pickModel, type MediaKind, type ResolvedModel } from './schema';

/** 一次生成的请求（工具参数与命令参数都收敛到这里）。 */
export interface GenerationRequest {
	/** 提示词。 */
	prompt: string;
	/** 媒体种类。 */
	kind: MediaKind;
	/**
	 * 点名目标（可选）。三种写法：`供应商::模型`（精确）、`供应商`、
	 * 或者光一个模型名。空 = 用设置里的默认，再退到第一个可用的。
	 */
	provider?: string;
	/** 画幅比例。 */
	aspectRatio?: string;
	/** 视频分辨率。 */
	resolution?: string;
	/** 视频时长（秒）。 */
	duration?: number;
	/**
	 * 参考图句柄（可选，**按顺序**）：`http(s)` 地址、`data:` 地址、会话附件引用、
	 * 或本地文件路径。模型看不见图片内容，它只负责把用户给的地址抄进来
	 * （见 host/reference.ts）；命令面带附件时递的是**持久附件引用对象**
	 * （原样透传，不重拼）。多张参考图 = 多个元素，顺序会原样进请求体。
	 */
	references?: readonly (string | MediaAttachmentRef)[];
	/**
	 * 是否请**视觉模型**把参考图读成一段文字、注入提示词（可选）。
	 *
	 * 只有「当前模型看不见图」这条分支才该打开它（判据在工具那一侧，见 host/tool.ts）：
	 * 看得见的模型不需要别人替它转述；看不见的模型需要一个既进提示词、又回给它自己的
	 * 文字版本，否则它连图里有什么都不知道。没有配置视觉模型时这一项是空操作。
	 */
	describeReference?: boolean;
	/**
	 * 这次生成要**临时覆盖**的模型参数（模型在调用工具时给的）。
	 *
	 * 键必须在这个模型的声明范围内（预置 + 设置页里写的那些），否则整项被忽略
	 * 并随结果回一句「忽略了哪些键」—— 见 `filterParams`。
	 */
	params?: Record<string, unknown>;
}

/** 归一化后的生成结果。 */
export interface GenerationValue {
	kind: MediaKind;
	/**
	 * 客户端应当使用的地址。
	 *
	 * **留档成功时是本地路由**（`/ffc-media/…`，不会过期）；没配留档目录、
	 * 或这次留档失败时，就是供应商回的那个地址。
	 */
	url: string;
	/** 供应商回的原始地址（只有留档成功时才有 —— 留着备查与排障）。 */
	remoteUrl?: string;
	/** 这次留档失败的原因（配了目录但没写成时才出现，随工具回执给用户看）。 */
	archiveError?: string;
	model: string;
	providerId: string;
	prompt: string;
	aspectRatio: string;
	width?: number;
	height?: number;
	mimeType?: string;
	/** 这次生成是否带上了参考图（只表示**发出去了**，供应商有没有采纳探测不到）。 */
	usedReference?: boolean;
	/** 带了几张参考图（与 `usedReference` 一起出现，供工具回执与聊天行显示）。 */
	referenceCount?: number;
	/** 视觉模型对参考图的描述（`describeReference` 生效时才有）。 */
	referenceDescription?: string;
	/**
	 * 被忽略掉的调用参数（键不在这个模型的声明范围内，或值收敛不了）。
	 *
	 * 回给模型自己：它才知道「我要求的那个参数没生效」，而不是默默出一张
	 * 不符合要求的图。
	 */
	ignoredParams?: string[];
}

/** 管线依赖。 */
export interface GenerationDeps {
	/**
	 * 读取已解析的模型清单（供应商 × 模型 + 凭据库里的密钥）。
	 *
	 * **异步**：密钥必须每次操作重新解析（凭据服务的语义），同步接口会逼实现
	 * 去缓存，而缓存意味着「刚填完密钥还得重启/改配置才生效」。
	 */
	getModels: () => Promise<ResolvedModel[]>;
	/** 单次生成的整体超时。 */
	getTimeoutMs: () => number;
	/** 诊断日志。 */
	log: (message: string) => void;
	/**
	 * 读一个会话附件的字节（图像模型看不见图，参考图就得由宿主自己取）。
	 * 宿主没有装配附件服务时不给这个函数 —— 那时附件形式的参考图会明确报错，
	 * 而不是静默出一张无关的图。
	 */
	readAttachment?: ReadAttachment;
	/**
	 * 生成结果的**本地留档目录**（P32）；空 = 不留档。
	 *
	 * 函数整个缺席时同样按「不留档」处理（裁剪过的组合里没有设置页）。
	 */
	getArchiveDir?: () => string;
	/**
	 * 当前这条路由**看不看得见图**（决定「自动套用用户附的图」该不该发生）。
	 *
	 *   `true`      路由声明支持图像输入 → 模型自己看得见，参不参考它说了算
	 *   `false`     明确只支持文本 → 自动套用（模型手上只有一行摘要，没有别的办法）
	 *   `undefined` 查不到（没有 llm 服务 / 模型不在目录里 / 还没有路由信息）
	 *
	 * 函数整个缺席时同样按「不知道」处理。两种「不知道」都照自动套用办：
	 * 让参考图真的到达生成 API，比让它悄悄丢掉划算。
	 */
	routeSeesImages?: (session: SessionLike | undefined) => Promise<boolean | undefined>;
}

/**
 * 选定模型并校验它确实可用。
 *
 * `pickModel` 已经保证了「整类都没配」时抛错；这里兜的是
 * 「点名了某个目标、但它自己缺密钥/基址」——两种提示的下一步动作不同，
 * 所以分两句话。
 * @param deps - 管线依赖。
 * @param request - 请求。
 * @returns 可用的模型。
 */
async function resolveTarget(deps: GenerationDeps, request: GenerationRequest): Promise<ResolvedModel> {
	const model = pickModel(await deps.getModels(), request.kind, request.provider);
	if (!isUsable(model)) {
		throw new Error(
			`模型「${model.ref}」还没有配置 API 密钥。` +
				`请让用户打开「设置 → 图像 / 视频模型」填写密钥后再试。`,
		);
	}
	return model;
}

/**
 * 跑一次生成。
 * @param deps - 管线依赖。
 * @param request - 请求。
 * @param signal - 取消信号。
 * @returns 归一化结果。
 * @throws 模型不可用、网络失败、响应不符合预期等 —— 错误文案可直接展示。
 */
export async function runGeneration(
	deps: GenerationDeps,
	request: GenerationRequest,
	signal?: AbortSignal,
): Promise<GenerationValue> {
	const model = await resolveTarget(deps, request);

	// 比例在这里就定死并随结果回传：客户端要在**结果到达之前**就知道该给节点
	// 多大（等待中的占位节点与出图后的节点形状必须一致，否则会跳）。
	const aspectRatio = request.aspectRatio ?? (request.kind === 'video' ? '16:9' : '1:1');

	// 参考图句柄 → 供应商认的地址（**按顺序**，多张就是多个）。取不到就**抛错**
	// （绝不静默降级成纯文生图，也绝不静默少发一张）。
	const requested = (request.references ?? []).filter(
		(handle) => !(typeof handle === 'string' && handle.trim() === ''),
	);
	const references =
		requested.length === 0
			? []
			: await resolveReferences(
					requested,
					{
						...(deps.readAttachment === undefined ? {} : { readAttachment: deps.readAttachment }),
						// 留档地址（`/ffc-media/…`）当参考图时要映射回归档目录里的文件
						...(deps.getArchiveDir === undefined ? {} : { archiveDir: deps.getArchiveDir }),
						log: deps.log,
					},
					signal,
				);

	const count = references.length;
	deps.log(`${request.kind} via ${model.ref}${count === 0 ? '' : `（带 ${String(count)} 张参考图）`}`);

	// 看不见图的模型（文本模型）需要一个文字版的参考图：请视觉模型读一遍，
	// 拼进提示词前面，同时随结果回给模型自己（见 GenerationValue.referenceDescription）。
	const description =
		count === 0 || request.describeReference !== true
			? undefined
			: await describeReference(deps, request.prompt, references, signal);
	const prompt = description === undefined ? request.prompt : `${REFERENCE_PROMPT_PREFIX}${description}\n\n${request.prompt}`;

	// 调用时传的参数：按这个模型的声明过滤（键不认识 / 值收敛不了就记进 ignored）
	const callParams = filterParams(model, request.params);

	const result = await generate(
		model,
		{
			prompt,
			aspectRatio,
			resolution: request.resolution,
			duration: request.duration,
			...(count === 0 ? {} : { references }),
			...(callParams.params === undefined ? {} : { params: callParams.params }),
		},
		signal,
		deps.getTimeoutMs(),
	);

	// ── 本地留档（P32） ──
	//
	// 供应商（尤其转中站）回的是**会过期的签名地址**，这是「图放久了加载不出来」
	// 的根因。配了目录就把字节抓下来写盘，结果地址换成同源的本机路由。
	//
	// 三条刻意的选择：
	//   1. **等它写完再返回**。这些字节浏览器要显示时反正也得下载一遍；让宿主
	//      下完再本地供图，比「先给一个会死的地址、之后再补」简单得多。
	//   2. **失败绝不打断生成**：图已经出来了，写不进盘只是「这次没留档」，
	//      原因随结果回给用户（见 GenerationValue.archiveError）。
	//   3. **视频也留**：视频地址同样会过期，而且丢一个更贵。
	const archiveDir = (deps.getArchiveDir?.() ?? '').trim();
	let url = result.url;
	let remoteUrl: string | undefined;
	let archiveError: string | undefined;
	if (archiveDir !== '') {
		const archived = await archiveGeneration(
			expandHome(archiveDir),
			{
				url: result.url,
				kind: result.kind,
				...(result.mimeType === undefined ? {} : { mimeType: result.mimeType }),
				model: result.model,
			},
			signal,
		);
		if (archived.ok) {
			url = archived.url;
			remoteUrl = result.url;
			deps.log(`已留档 ${archived.rel}（${(archived.bytes / 1024).toFixed(0)} KB）`);
		} else {
			archiveError = archived.error;
			deps.log(`留档失败（结果仍指向远端地址）：${archived.error}`);
		}
	}

	return {
		kind: result.kind,
		url,
		...(remoteUrl === undefined ? {} : { remoteUrl }),
		...(archiveError === undefined ? {} : { archiveError }),
		model: result.model,
		providerId: result.providerId,
		prompt: result.prompt,
		aspectRatio,
		...(result.width !== undefined ? { width: result.width } : {}),
		...(result.height !== undefined ? { height: result.height } : {}),
		...(result.mimeType !== undefined ? { mimeType: result.mimeType } : {}),
		// 只回张数：参考图地址本身可能是兆级的 data:，决不能再进会话事件
		...(count === 0 ? {} : { usedReference: true, referenceCount: count }),
		...(description === undefined ? {} : { referenceDescription: description }),
		...(callParams.ignored.length === 0 ? {} : { ignoredParams: callParams.ignored }),
	};
}

/**
 * 按模型的声明过滤调用时传的参数（纯函数）。
 *
 * **不抛错**：一个没声明过的键不该让整次生成失败 —— 但也不能悄悄丢掉，
 * 因此把它记进 `ignored`，由结果文本回给模型自己（见 host/tool.ts）。
 *
 * **质量档不在这条路上**：它归聊天栏那格的档位 chip 管（`defaultTiers`），
 * 所以模型传 `quality` 时忽略，并附一句「在哪选」—— 模型才有话可回用户，
 * 而不是默默按用户没选的那一档出图。
 * @param model - 已解析的模型（带这个家族的声明）。
 * @param raw - 模型给的参数。
 * @returns 要展开进请求体的值（一个都没有时缺席），以及被忽略的键（带原因）。
 */
function filterParams(
	model: ResolvedModel,
	raw: Record<string, unknown> | undefined,
): { params?: Record<string, string | number | boolean>; ignored: string[] } {
	const entries = Object.entries(raw ?? {});
	if (entries.length === 0) return { ignored: [] };
	const params: Record<string, string | number | boolean> = {};
	const ignored: string[] = [];
	for (const [key, value] of entries) {
		if (key === model.axis?.param) {
			ignored.push(`${key}（质量档在聊天栏那格里选）`);
			continue;
		}
		const spec = model.paramSpecs.find((entry) => entry.key === key);
		// 声明过的键才收（值只做类型收敛：闭集是设置页的下拉，不是校验器）
		const coerced = spec === undefined ? undefined : coerceParam(spec, value);
		if (coerced === undefined) {
			ignored.push(key);
			continue;
		}
		params[key] = coerced;
	}
	return { params, ignored };
}

/** 注入参考图描述时，加在提示词前面的那行说明。 */
const REFERENCE_PROMPT_PREFIX = '参考图内容：';

/**
 * 请视觉模型把参考图读成一段文字。
 *
 * **失败只记日志、不打断生成**：描述是加分项（参考图本身已经发给供应商了），
 * 而一个配错密钥的视觉模型不该让整次生成失败 —— 那种「配了个可选项反而什么都做不了」
 * 的行为比没有这个功能更糟。
 * @param deps - 管线依赖。
 * @param prompt - 用户提示词（给视觉模型当语言与意图的线索）。
 * @param references - 已解析的参考图地址（**按顺序**，一次调用里全给它）。
 * @param signal - 取消信号。
 * @returns 描述文字；没配视觉模型或调用失败时 undefined。
 */
async function describeReference(
	deps: GenerationDeps,
	prompt: string,
	references: readonly string[],
	signal?: AbortSignal,
): Promise<string | undefined> {
	let vision: ResolvedModel | undefined;
	try {
		vision = findVisionModel(await deps.getModels());
	} catch (error) {
		deps.log(`读模型清单失败，跳过参考图描述：${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
	if (vision === undefined) {
		deps.log('没有配置可用的视觉模型，提示词里不会有参考图描述（设置 → 图像 / 视频模型里加一个「视觉」模型即可）');
		return undefined;
	}

	try {
		const description = await describeImage(vision, { references, prompt }, signal, deps.getTimeoutMs());
		deps.log(`参考图描述来自 ${vision.ref}（${String(description.length)} 字，${String(references.length)} 张图）`);
		return description;
	} catch (error) {
		deps.log(`参考图描述失败（继续生成）：${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}
