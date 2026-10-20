/**
 * 生成结果在**宿主 → 会话事件 → 客户端**这条通路上的共用契约。
 *
 * 通路上有三个必须两边写成一样的名字，任何一个写歪都表现为「静默不生效」：
 *
 *   1. 工具名 —— 宿主 `ctx.tools.register({ name })`，客户端按同一个名字登记
 *      `tool.call.toolview` 的 keyed 条目；
 *   2. `presentationMeta` 的键 —— 它随 `tool/result` 事件到达浏览器，
 *      落在 `ToolResultNode.meta` 上；
 *   3. 由工具调用 id 派生的画布节点 id —— 它同时充当**幂等键**：
 *      同一个生成永远不会在画布上落两个节点，删掉的节点也不会复活。
 *
 * 和 catalog.ts 一样放在 `src/client/shared/`：这是唯一一个宿主与浏览器
 * **都能解析**的位置（宿主用相对路径反向引用）。本文件只有纯数据与纯函数。
 *
 * @module fatfish-canvas/shared/media
 */

/** 工具名。宿主注册它，客户端按它认领 keyed tool view。 */
export const MEDIA_TOOL_NAME = 'media_generate';

/**
 * 直达命令名（不带斜杠）。宿主注册 `/generate`，客户端按同一个名字
 * 认领**命令节点** —— 命令触发的生成同样要落到画布上（见 `canvas/ingest.ts`）。
 */
export const MEDIA_COMMAND_NAME = 'generate';

/** `presentationMeta` 里承载生成结果的那个键。 */
export const MEDIA_META_KEY = 'fatfishCanvas';

/**
 * 本地留档结果的**公开地址前缀**（P32）。
 *
 * 两边必须写成同一个值：宿主按它注册取图路由（`host/archive.ts`），客户端按它
 * 认出「这是本机留档的地址，可以当参考图 / 可以直接取字节」（见
 * {@link isReferenceHandle}）。前缀与其它三个契约名字同理，放在共享模块里。
 */
export const MEDIA_ROUTE_PREFIX = '/ffc-media';

/** 画布节点 id 前缀（`gen_<callId>`）。 */
export const MEDIA_NODE_PREFIX = 'gen_';

/**
 * 命令触发的生成所用的节点 id 前缀。
 *
 * 命令与工具各用一套前缀：两者的 id 空间不同（工具是 `call_…`，命令是自己的
 * 配对 id），混用前缀会让两个不同来源的 id 有撞车的可能。
 */
export const MEDIA_COMMAND_NODE_PREFIX = 'gencmd_';

/** 媒体种类。与 catalog 的 `MediaKind` 同域，这里再声明一次以免共享模块互相依赖。 */
export type MediaKind = 'image' | 'video';

/** 一次生成的呈现负载（`tool/result` 的 `meta.fatfishCanvas`）。 */
export interface MediaPresentation {
	/** 媒体种类。 */
	kind: MediaKind;
	/** 可直接交给 `<img>` / `<video>` 的地址（http(s)、同源相对路径或 data:）。 */
	url: string;
	/** 供应商回的原始地址（本地留档成功时才有；`url` 那时是本机路由）。 */
	remoteUrl?: string;
	/** 本地留档失败的原因（配了目录但没写成时才有）。 */
	archiveError?: string;
	/** 实际使用的模型。 */
	model?: string;
	/** 供应商 id。 */
	providerId?: string;
	/** 原始提示词。 */
	prompt?: string;
	/** 画幅比例（如 `16:9`），用于在没有像素尺寸时推算节点形状。 */
	aspectRatio?: string;
	/** 像素宽（供应商回传时才有）。 */
	width?: number;
	/** 像素高。 */
	height?: number;
	/** 内联数据的 MIME（url 是 data: 时才有）。 */
	mimeType?: string;
	/** 这次生成是否带上了参考图（供应商**是否真的采纳**无法探测，这里只表示我们发出去了）。 */
	usedReference?: boolean;
	/** 带了几张参考图（`usedReference` 为真时才有；单张时宿主可能不写，按 1 理解）。 */
	referenceCount?: number;
	/** 视觉模型对参考图的描述（配了视觉模型、且当前模型看不见图时才有）。 */
	referenceDescription?: string;
}

/** 一次工具调用的参数（从 `tool/call` 的 `argsRaw` 解析而来）。 */
export interface MediaCallArgs {
	/** 提示词。 */
	prompt: string;
	/** 媒体种类。 */
	kind: MediaKind;
	/** 画幅比例（未给时为 undefined）。 */
	aspectRatio?: string;
	/**
	 * 参考图句柄（**按模型写的顺序**；`attached` 这个哨兵值原样保留）。
	 *
	 * 存的是句柄而不是解析后的地址：解析（读盘 / 读附件）只有宿主做得到，
	 * 而解析结果往往是兆级 `data:` —— 把它抄进会话日志会把日志撑爆。
	 * 用途是画布右键的「生成信息」（事后回看这次到底参考了哪几张图）。
	 */
	references?: string[];
}

// ─────────────────────────── 解析 ───────────────────────────

const isObject = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value);

const isKind = (value: unknown): value is MediaKind => value === 'image' || value === 'video';

/** `16:9` / `16/9` / `16x9` / `16×9` 都接受。 */
const RATIO_RE = /^(\d+(?:\.\d+)?)\s*[:/x×]\s*(\d+(?:\.\d+)?)$/;

/**
 * 解析画幅比例字符串。
 * @param value - 原始值（任意类型）。
 * @returns 宽高比（`> 0`）；无法解析时为 null。
 */
export function parseAspectRatio(value: unknown): number | null {
	if (typeof value !== 'string') return null;
	const match = RATIO_RE.exec(value.trim().toLowerCase());
	if (match === null) return null;
	const w = Number(match[1]);
	const h = Number(match[2]);
	if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
	return w / h;
}

/**
 * 从工具结果的 `meta` 里取出生成结果。
 *
 * 逐字段校验而不是断言类型：这条数据是**跨进程**来的（宿主进程 → 浏览器），
 * 任何字段都可能因版本错位而缺席，静默地把坏数据当结果用会渲染出一个
 * 永远加载不出来的节点。
 * @param meta - `ToolResultNode.meta`。
 * @returns 生成结果；不是本插件的 meta 时返回 null。
 */
export function readMediaPresentation(meta: unknown): MediaPresentation | null {
	if (!isObject(meta)) return null;
	const raw = meta[MEDIA_META_KEY];
	if (!isObject(raw)) return null;
	if (!isKind(raw.kind)) return null;
	if (typeof raw.url !== 'string' || raw.url === '') return null;

	const out: MediaPresentation = { kind: raw.kind, url: raw.url };
	if (typeof raw.remoteUrl === 'string' && raw.remoteUrl !== '') out.remoteUrl = raw.remoteUrl;
	if (typeof raw.archiveError === 'string' && raw.archiveError !== '') out.archiveError = raw.archiveError;
	if (typeof raw.model === 'string') out.model = raw.model;
	if (typeof raw.providerId === 'string') out.providerId = raw.providerId;
	if (typeof raw.prompt === 'string') out.prompt = raw.prompt;
	if (typeof raw.aspectRatio === 'string') out.aspectRatio = raw.aspectRatio;
	if (isFiniteNumber(raw.width) && raw.width > 0) out.width = raw.width;
	if (isFiniteNumber(raw.height) && raw.height > 0) out.height = raw.height;
	if (typeof raw.mimeType === 'string') out.mimeType = raw.mimeType;
	if (raw.usedReference === true) out.usedReference = true;
	if (isFiniteNumber(raw.referenceCount) && raw.referenceCount > 0) out.referenceCount = raw.referenceCount;
	if (typeof raw.referenceDescription === 'string' && raw.referenceDescription !== '') {
		out.referenceDescription = raw.referenceDescription;
	}
	return out;
}

/**
 * 解析 `media_generate` 的调用参数。
 *
 * 输入既可以是 `tool/call` 事件里的 `argsRaw` 字符串，也可以是已经解析过的
 * 对象（测试与演进期两种形状都要能接）。
 * @param raw - `argsRaw` 字符串或参数对象。
 * @returns 规范化后的参数；无法解析时给出安全的默认值。
 */
export function parseMediaCallArgs(raw: unknown): MediaCallArgs {
	let value: unknown = raw;
	if (typeof raw === 'string') {
		try {
			value = JSON.parse(raw);
		} catch {
			value = {};
		}
	}
	const o = isObject(value) ? value : {};
	const out: MediaCallArgs = {
		prompt: typeof o.prompt === 'string' ? o.prompt : '',
		kind: isKind(o.kind) ? o.kind : 'image',
	};
	if (typeof o.aspectRatio === 'string' && o.aspectRatio !== '') out.aspectRatio = o.aspectRatio;

	// `reference` 一张写字符串、多张写数组（与工具 schema 的 `oneOf` 对应）。
	const rawRefs = Array.isArray(o.reference) ? o.reference : [o.reference];
	const references: string[] = [];
	for (const item of rawRefs) {
		if (typeof item !== 'string') continue;
		const text = item.trim();
		if (text !== '') references.push(text);
	}
	if (references.length > 0) out.references = references;
	return out;
}

// ─────────────────────── 画布节点几何 ───────────────────────

/** 自动落位的节点基准边长（像素，世界坐标）。 */
export const MEDIA_NODE_BASE = 320;
/** 节点最短边下限。 */
export const MEDIA_NODE_MIN = 140;
/** 节点最长边上限。 */
export const MEDIA_NODE_MAX = 480;

/**
 * 由生成结果推算画布节点的世界尺寸。
 *
 * 优先用供应商回传的像素尺寸，其次是画幅比例，最后退回种类默认
 * （图像 1:1、视频 16:9）。节点尺寸必须在结果到达**之前**就能定下来 ——
 * 否则等待中的节点会先按一个尺寸落位，出图后再跳一下。
 * @param spec - 种类 / 像素尺寸 / 画幅比例。
 * @returns 世界宽高（均为有限正数）。
 */
export function mediaNodeSize(spec: {
	kind?: MediaKind | string;
	width?: number | undefined;
	height?: number | undefined;
	aspectRatio?: string | undefined;
}): { w: number; h: number } {
	let ratio: number | null = null;
	if (isFiniteNumber(spec.width) && isFiniteNumber(spec.height) && spec.height > 0) {
		ratio = spec.width / spec.height;
	}
	if (ratio === null) ratio = parseAspectRatio(spec.aspectRatio);
	if (ratio === null) ratio = spec.kind === 'video' ? 16 / 9 : 1;
	if (!Number.isFinite(ratio) || ratio <= 0) ratio = 1;

	const landscape = ratio >= 1;
	const rawW = landscape ? MEDIA_NODE_BASE : MEDIA_NODE_BASE * ratio;
	const rawH = landscape ? MEDIA_NODE_BASE / ratio : MEDIA_NODE_BASE;
	const clamp = (value: number): number =>
		Math.round(Math.min(MEDIA_NODE_MAX, Math.max(MEDIA_NODE_MIN, value)));
	return { w: clamp(rawW), h: clamp(rawH) };
}

/**
 * 由工具调用 id 派生画布节点 id。
 *
 * 这是整个落图流程的**幂等键**：同一个 callId 永远映射到同一个节点，
 * 因此重复的会话快照不会造出重复节点，用户删掉的节点也不会因为
 * 重放历史而复活。
 * @param callId - `tool/call` 的调用 id。
 * @returns 画布节点 id。
 */
export function mediaNodeId(callId: string): string {
	return `${MEDIA_NODE_PREFIX}${callId}`;
}

/**
 * 由命令的配对 id 派生画布节点 id。
 * @param commandId - `command/run` 的配对 id。
 * @returns 画布节点 id。
 */
export function mediaCommandNodeId(commandId: string): string {
	return `${MEDIA_COMMAND_NODE_PREFIX}${commandId}`;
}

// ─────────────────── `/generate` 的命令行语法 ───────────────────
//
// 语法必须**两半边共用**：宿主用它解析用户敲的那一行，客户端用它从
// `command/run` 事件里还原「这次在画什么」（用于先落 pending 节点）。
// 两边各写一份解析器，迟早会出现「宿主理解了、客户端没理解」的静默错位。

/** `/generate` 的用法说明（也是出错时给用户看的那段文字）。 */
export const GENERATE_USAGE =
	'用法：/generate [--kind image|video] [--ratio 1:1|16:9|4:3|3:4|9:16] ' +
	'[--provider 供应商 id] [--resolution 480p|1080p] [--duration 秒数] ' +
	'[--ref 参考图地址（可重复，按先后顺序都带上）] <提示词>' +
	'（在输入框里附上图片时，那些图自动按顺序当参考图）';

/**
 * 一次生成最多带几张参考图。
 *
 * 上限是**为了报错可读**，不是协议限制：各家网关的张数上限并不统一（多图编辑类
 * 常见 4–16 张），超了由供应商回 400 —— 而那条错误往往看不出是「张数太多」。
 * 因此在这里挡住，并说清是哪一侧超了。
 *
 * ponytail: 一个全局常量，不分供应商、不可配。升级路径：做成供应商级字段
 * （`maxReferenceImages`），真有人撞到再说。
 */
export const REFERENCE_MAX_COUNT = 8;

/**
 * 工具参数 `reference` 里的哨兵值：**用用户在这一轮消息里附的图**。
 *
 * 与宿主 `tool.ts` 的 `REFERENCE_ATTACHED` 必须是同一个字面量（那边是写给模型看的
 * 写法，客户端只用来在「生成信息」里把它读成一句话）。测试钉住两者相等。
 */
export const REFERENCE_ATTACHED_MARKER = 'attached';

/**
 * 命令行里能内联的**参考图地址**长度上限。
 *
 * `data:` 大图（一兆以上）进命令行会连同会话日志一起膨胀，而命令行是它唯一的通路。
 * ponytail: 上限之下的内联地址直接走命令行，超过的（大 data: 图）在画布菜单里禁用；
 * 升级路径是让客户端把字节经附件面上传、宿主用 `ctx.attachments.readImage` 读回。
 */
export const REFERENCE_MAX_INLINE = 8192;

/**
 * 判断一个地址能否当作**参考图句柄**（进得了命令行，宿主那边也取得到内容）。
 *
 * 三种成立：`http(s):` 地址（宿主原样转给供应商，零下载）、足够小的 `data:`
 * 内联地址，以及**本机留档地址**（`/ffc-media/…`，宿主按同一个前缀把它映射回
 * 归档目录里的文件 —— 这是留档之后最稳的参考图来源）。
 * `blob:`（浏览器进程内的地址，宿主取不到）与其它相对路径一律不行 ——
 * 那种情况下宁可禁用入口，也不要发出一个必然失败的生成。
 * @param value - 候选地址（任意类型）。
 * @returns 能否当参考图。
 */
export function isReferenceHandle(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	const text = value.trim();
	if (/^https?:\/\//i.test(text)) return true;
	if (text.startsWith(`${MEDIA_ROUTE_PREFIX}/`)) return true;
	return text.startsWith('data:') && text.length <= REFERENCE_MAX_INLINE;
}

/** 解析后的 `/generate` 参数。 */
export interface GenerateCommandArgs {
	/** 提示词（去掉所有参数后的剩余文字）。 */
	prompt: string;
	/** 媒体种类。 */
	kind: MediaKind;
	/** 画幅比例（给了才有效）。 */
	aspectRatio?: string;
	/** 视频分辨率。 */
	resolution?: string;
	/** 视频时长（秒）。 */
	duration?: number;
	/** 点名供应商。 */
	provider?: string;
	/**
	 * 参考图地址（`http(s)` / `data:` / 本地路径 / 附件 id），**按顺序**。
	 * `--ref` 可重复；只写一个时就是一个元素的数组。
	 */
	references?: string[];
}

/** 解析结果：要么是参数，要么是一句可读的错误（直接回给用户）。 */
export type GenerateCommandParse =
	| { ok: true; args: GenerateCommandArgs }
	| { ok: false; error: string };

/** 需要取值的开关。 */
const VALUE_FLAGS: Record<string, 'kind' | 'ratio' | 'provider' | 'resolution' | 'duration' | 'ref'> = {
	kind: 'kind',
	ratio: 'ratio',
	provider: 'provider',
	resolution: 'resolution',
	duration: 'duration',
	ref: 'ref',
};

/** 合法画幅比例（与工具参数的枚举一致）。 */
const RATIOS = ['1:1', '16:9', '4:3', '3:4', '9:16'];
/** 合法视频分辨率。 */
const RESOLUTIONS = ['480p', '1080p'];

/**
 * 解析 `/generate` 的一行输入。
 *
 * 规则刻意简单可预期：`--flag value` 与 `--flag=value` 等价；`--video` / `--image`
 * 是 `--kind` 的简写；其余**任何**非开关文字都按顺序拼成提示词
 * （因此提示词里可以正常出现短横线与冒号）。第一个未知开关即报错 ——
 * 静默忽略会让人以为参数生效了。
 * @param rawInput - 命令名之后的原文（可能带前导空白）。
 * @returns 参数或错误文案。
 */
export function parseGenerateLine(rawInput: unknown): GenerateCommandParse {
	const text = typeof rawInput === 'string' ? rawInput.trim() : '';
	if (text === '') return { ok: false, error: `缺少提示词。${GENERATE_USAGE}` };

	const tokens = text.split(/\s+/);
	const words: string[] = [];
	const args: GenerateCommandArgs = { prompt: '', kind: 'image' };

	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i] ?? '';
		if (!token.startsWith('--')) {
			words.push(token);
			continue;
		}

		// --flag=value 与 --flag value 两种写法都收
		const eq = token.indexOf('=');
		const name = (eq === -1 ? token.slice(2) : token.slice(2, eq)).toLowerCase();
		const inlineValue = eq === -1 ? undefined : token.slice(eq + 1);

		if (name === 'video' || name === 'image') {
			if (inlineValue !== undefined) return { ok: false, error: `--${name} 不接受取值。${GENERATE_USAGE}` };
			args.kind = name === 'video' ? 'video' : 'image';
			continue;
		}

		const key = VALUE_FLAGS[name];
		if (key === undefined) return { ok: false, error: `未知参数 --${name}。${GENERATE_USAGE}` };

		let value = inlineValue;
		if (value === undefined) {
			const next = tokens[i + 1];
			if (next === undefined || next.startsWith('--')) {
				return { ok: false, error: `--${name} 后面缺少取值。${GENERATE_USAGE}` };
			}
			value = next;
			i += 1;
		}

		if (key === 'kind') {
			if (value !== 'image' && value !== 'video') {
				return { ok: false, error: `--kind 只能是 image 或 video（收到 ${value}）。${GENERATE_USAGE}` };
			}
			args.kind = value;
		} else if (key === 'ratio') {
			if (!RATIOS.includes(value)) {
				return { ok: false, error: `--ratio 只能是 ${RATIOS.join(' / ')}（收到 ${value}）。${GENERATE_USAGE}` };
			}
			args.aspectRatio = value;
		} else if (key === 'resolution') {
			if (!RESOLUTIONS.includes(value)) {
				return { ok: false, error: `--resolution 只能是 ${RESOLUTIONS.join(' / ')}（收到 ${value}）。${GENERATE_USAGE}` };
			}
			args.resolution = value;
		} else if (key === 'duration') {
			const seconds = Number(value);
			if (!Number.isFinite(seconds) || seconds <= 0) {
				return { ok: false, error: `--duration 需要正数秒数（收到 ${value}）。${GENERATE_USAGE}` };
			}
			args.duration = seconds;
		} else if (key === 'ref') {
			// 可重复：多张参考图**按写的先后顺序**发出去（顺序对图生图是有意义的）
			const list = args.references ?? [];
			if (list.length >= REFERENCE_MAX_COUNT) {
				return {
					ok: false,
					error: `一次最多带 ${String(REFERENCE_MAX_COUNT)} 张参考图（--ref 已经写了 ${String(list.length)} 个）。${GENERATE_USAGE}`,
				};
			}
			list.push(value);
			args.references = list;
		} else {
			args.provider = value;
		}
	}

	args.prompt = words.join(' ').trim();
	if (args.prompt === '') return { ok: false, error: `缺少提示词。${GENERATE_USAGE}` };
	return { ok: true, args };
}

/**
 * 命令成功时回给 UI 的正文。
 *
 * **第一行固定是媒体地址** —— 这是宿主的承诺，客户端据此从 `command/done`
 * 的文本里还原出媒体（`mediaUrlFromCommandText`）。第二行才是给人看的小结。
 * 之所以敢用一个文本约定：命令结果本身就只有文本一种载体（见 dsh-commands），
 * 而这个约定极小、可测、且两边共用同一份实现。
 * @param value - 生成结果。
 * @returns 两行正文。
 */
export function formatCommandResult(value: {
	kind: MediaKind;
	url: string;
	model?: string;
	providerId?: string;
	aspectRatio?: string;
	width?: number;
	height?: number;
}): string {
	const label = value.kind === 'video' ? '视频' : '图像';
	const parts = [label];
	if (value.model !== undefined && value.model !== '') parts.push(value.model);
	if (value.aspectRatio !== undefined && value.aspectRatio !== '') parts.push(value.aspectRatio);
	const size =
		value.width !== undefined && value.height !== undefined
			? `${String(value.width)}×${String(value.height)}`
			: '';
	if (size !== '') parts.push(size);
	return `${value.url}\n${parts.join(' · ')}`;
}

/**
 * 从命令结果文本里还原媒体地址。
 * @param text - `command/done` 携带的文本。
 * @returns 媒体地址；不符合约定时 null。
 */
export function mediaUrlFromCommandText(text: unknown): string | null {
	if (typeof text !== 'string') return null;
	const first = text.split('\n')[0]?.trim() ?? '';
	if (first === '') return null;
	const looksLikeUrl =
		first.startsWith('http://') ||
		first.startsWith('https://') ||
		first.startsWith('data:') ||
		first.startsWith('blob:') ||
		first.startsWith('/');
	return looksLikeUrl ? first : null;
}
