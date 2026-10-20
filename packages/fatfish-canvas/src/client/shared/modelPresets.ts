/**
 * **模型类型预置表**（宿主与客户端**共用的一份**，与 `catalog.ts` 同一层）。
 *
 * 它回答的是「这个模型收哪些参数」——而 `GET /models` **只回 id**，没有任何能力
 * 字段。因此参数只能由人写下来。这份表就是「提前适配好的那一份」：按**词干**
 * 匹配（`splitTier` 已经去掉尾部档位词），所以
 * `gpt-image-2` / `gpt-image-2-2k` / `gpt-image-2-4k` 命中同一条，
 * 将来网关新出一个 `-8k` 尾缀的兄弟**不用改任何配置**就一起被覆盖。
 *
 * ## 三条边界（都是刻意的）
 *
 * 1. **预置是起点，不是承诺**：设置页里每一条都能改（参数名、取值、默认值），
 *    匹配不上的模型也能手写。网关千差万别，写死在代码里只能覆盖一家。
 * 2. **质量参数有默认值，其他参数没有**：质量是「选一个档」的东西，界面上
 *    一列就知道有哪些可选；其他参数（尺寸 / 背景…）**预置只声明有哪些
 *    键**，值默认留空 = 不写进请求体 —— 猜错一个键的代价是整次生成 400，
 *    而「什么都不传」至少是今天的行为。
 * 3. **质量轴默认「未选」**（`fallback: ''`）：预置只让那一排 chip 出现在
 *    聊天栏那格里，**用户点一下才进请求体**。P28 里用户手写的声明仍按老规矩
 *    默认取第一个取值（`fallback` 缺省 = `values[0]`）。
 *
 * @module fatfish-canvas/shared/modelPresets
 */

import { RESERVED_PARAM_KEYS, type ModelKind, type TierAxis } from './catalog';

/** 一个「其他参数」的声明（键 + 展示名 + 可选取值）。 */
export interface ParamSpec {
	/** 请求体里的键名（原样写进去）。 */
	key: string;
	/** 展示名（设置页用；键名对用户没有意义）。 */
	label: string;
	/** 闭集取值（设置页渲染成下拉）；省略 = 自由文本。 */
	values?: readonly string[];
	/** 值的类型：决定写进请求体时的形状。省略 = 字符串。 */
	type?: 'string' | 'number' | 'boolean';
}

/** 一条模型类型的预置。 */
export interface ModelPreset {
	/** 稳定 id（设置页与测试用它认类型）。 */
	id: string;
	/** 展示名。 */
	label: string;
	/** 适用的种类（同一个词干不会既当图像又当视频）。 */
	kinds: readonly ModelKind[];
	/**
	 * 词干前缀（小写比较）：`stem === 前缀` 或 `stem` 以 `前缀-` 开头即命中。
	 *
	 * 表的**顺序**就是匹配优先级，因此更具体的前缀要排在前面
	 * （`gpt-image-2.5` 必须在 `gpt-image-2` 之前，否则它永远匹配不到）。
	 */
	stems: readonly string[];
	/**
	 * 请求体的**形状**（可选）。缺省 = OpenAI 兼容那套平铺体
	 * （`model` / `prompt` / `duration` / `resolution` / `aspect_ratio` / `image`）。
	 *
	 * 声明了它，`host/providers.ts` 里就必须有对应的拼装分支 —— 网关之间连字段名
	 * 都不统一（见那个文件的模块头）。与其在设置页堆一排旋钮，不如把「这一族长
	 * 什么样」在这里写一次。
	 */
	wire?: WireShape;
	/** 质量轴（可选）：有它才能在聊天栏那格里选档。 */
	quality?: { param: string; values: readonly string[]; labels: Readonly<Record<string, string>> };
	/** 其他参数：只声明键与可选值，**不给默认值**（见文件头第 2 条）。 */
	params: readonly ParamSpec[];
}

/**
 * 请求体的形状（网关协议）。
 *
 * - `seedance-nz`：**api.seedance.nz 的视频协议** ——
 *   `{ model, prompt, images[], seconds, metadata: { resolution, ratio, … } }`。
 *   它和缺省那套**每个字段名都不一样**：`duration`→`seconds`（字符串）、
 *   `resolution`→`metadata.resolution`（还要大写）、`aspect_ratio`→`metadata.ratio`、
 *   `image`→`images`（数组）。少对上一个，网关要么 400、要么静默按默认档出片。
 * - `mj-describe`：**Midjourney 系网关的图生文（视觉模型）协议** —— 不是一次
 *   往返：`POST {base}/mj/submit/describe { base64 }` 拿任务 id，再
 *   `GET {base}/mj/task/{id}/fetch` 轮询到出文字。请求体里没有 `model` 这个字段
 *   （端点本身就是一个模型），图片也**只收 base64**（不收地址）。
 * - `mj-imagine`：**同一个网关的出图协议** —— 同样是「提交 + 轮询」，但请求体
 *   更小：`POST {base}/mj/submit/imagine { prompt }`（可选 `base64Array` 垫图，
 *   同样只收 base64），出的是**一张四宫格**。这条 wire 与别处**最大的一处不同**
 *   是：**参数不进请求体，而是拼进提示词的 flag**（`--ar 16:9` / `--stylize 250`
 *   / `--tile`）—— 见 `wirePathOf` 与 `host/providers.ts` 的 `mjPromptWithFlags`。
 * - `kie-jobs`：**kie.ai 的任务式媒体协议**（图与视频同一条） ——
 *   `POST {base}/jobs/createTask { model, input: {...} }` 拿 `data.taskId`，
 *   再 `GET {base}/jobs/recordInfo?taskId=…` 轮询到 `data.state === 'success'`；
 *   结果在 `data.resultJson` 里，而它**是一个 JSON 字符串**（要再解析一次）。
 *   与别处最大的两处不同：**参数在 `input` 里**（见 `wirePathOf`），以及
 *   **错误藏在 HTTP 200 的 `body.code` 里**（401 / 422 / 429 …）。
 *
 * ⚠️ 与另外三条不同，`kie-jobs` **挂不到预置上**：同一个模型名（`nano-banana-2`）
 * 在这家中转与别家中转上是两种协议，按词干匹配会把另一家带沟里。因此它是**供应商
 * 级的 wire**（配置里 `wire: kie-jobs`），见 `host/schema.ts` 的 `resolveModels`。
 */
export const WIRE_SHAPES = ['seedance-nz', 'mj-describe', 'mj-imagine', 'kie-jobs'] as const;

/** 请求体的形状（网关协议）。 */
export type WireShape = (typeof WIRE_SHAPES)[number];

/**
 * 这个字符串是不是一条已知的 wire（配置里的值不可信）。
 * @param value - 供应商配置里的 `wire`。
 * @returns 是已知形状时为 true（可当 `WireShape` 用）。
 */
export function isWireShape(value: string): value is WireShape {
	return (WIRE_SHAPES as readonly string[]).includes(value);
}

/**
 * 一个声明键在这个 wire 下**真正写进请求体的路径**（设置页的提示文案用）。
 *
 * 参数键在设置页与预置里是**平铺**的（好读好写），落到 `seedance-nz` 那种带
 * `metadata` 的协议上才由 `host/providers.ts` 摊进嵌套对象 —— 这个函数是那份
 * 映射的**同一份说法**，免得设置页的 tooltip 与真实请求体各说各话。
 *
 * `mj-imagine` 更进一步：它的参数**根本不在请求体里**，而是拼进提示词的 flag
 * （MJ 的规矩），所以这里给的不是路径而是那个 flag 本身。
 * @param wire - 请求体形状；缺省那套返回键本身。
 * @param key - 参数键。
 * @returns 请求体里的路径（`mj-imagine` 时是提示词里的 flag）。
 */
export function wirePathOf(wire: WireShape | undefined, key: string): string {
	if (wire === 'seedance-nz') return key === 'seconds' ? 'seconds' : `metadata.${key}`;
	if (wire === 'mj-imagine') return `--${key}（拼进提示词，不是请求体字段）`;
	return key;
}

/**
 * 不许当「其他参数」的键 —— 定义在 `catalog.ts`（**只有那一份**：
 * 质量轴与这里的判断必须同源，各写一份曾经漂移出「设置页不让声明、宿主却照收」）。
 */

/** 图像尺寸的常见闭集（几家的并集，够用且不至于写错）。 */
const SIZES_SQUARE = ['1024x1024', '1536x1024', '1024x1536'] as const;
const SIZES_LARGE = ['1024x1024', '1536x1024', '1024x1536', '2048x2048', '2048x1152', '1152x2048'] as const;
const SIZES_4K = [...SIZES_LARGE, '3840x2160', '2160x3840'] as const;
const RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'] as const;
const QUALITY_LABELS: Readonly<Record<string, string>> = {
	auto: '自动',
	low: '低',
	medium: '中',
	high: '高',
	xhigh: '极高',
	max: '最高',
};

/** 尺寸 / 背景这一组在好几条预置里重复出现，抽出来复用。 */
const PARAM_SIZE = { key: 'size', label: '尺寸', values: SIZES_SQUARE } as const;
const PARAM_BACKGROUND = { key: 'background', label: '背景', values: ['auto', 'transparent', 'opaque'] } as const;
const PARAM_MODERATION = { key: 'moderation', label: '审核', values: ['auto', 'low'] } as const;
const PARAM_OUTPUT_FORMAT = { key: 'output_format', label: '格式', values: ['png', 'jpeg', 'webp'] } as const;
const PARAM_COMPRESSION = { key: 'output_compression', label: '压缩率', type: 'number' } as const;

/**
 * 预置表（顺序 = 匹配优先级）。
 *
 * 收录标准：**参数名在官方或主流中转上确实见过**。拿不准的一律不写 ——
 * 猜错一个键会让整次生成失败，比少一个可调参数糟得多。
 */
export const MODEL_PRESETS: readonly ModelPreset[] = [
	{
		id: 'gpt-image-2.5',
		label: 'GPT Image 2.5',
		kinds: ['image'],
		stems: ['gpt-image-2.5'],
		quality: { param: 'quality', values: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'], labels: QUALITY_LABELS },
		params: [
			{ key: 'size', label: '尺寸', values: SIZES_4K },
			PARAM_BACKGROUND,
			PARAM_MODERATION,
			PARAM_OUTPUT_FORMAT,
			PARAM_COMPRESSION,
		],
	},
	{
		id: 'gpt-image-2',
		label: 'GPT Image 2 / 1',
		kinds: ['image'],
		stems: ['gpt-image-2', 'gpt-image-1', 'gpt-image'],
		quality: { param: 'quality', values: ['auto', 'low', 'medium', 'high'], labels: QUALITY_LABELS },
		params: [PARAM_SIZE, PARAM_BACKGROUND, PARAM_MODERATION, PARAM_OUTPUT_FORMAT],
	},
	{
		// `gemini-nano-banana-*`（2.1 起的新 id 写法）与 `nano-banana-*` 是**同一条**：
		// 2.1 不是新系列，只是这一族多了一个模型名，参数与前代逐个相同 ——
		// T8-penguin-canvas 也是这么归的（`gemini-nano-banana-2.1` 只是
		// `nano-banana-2` 这个 family 的 `apiModelOptions` 里的一项，共用
		// `paramKind: 'banana-ratio'` 那一份）。多一个前缀，将来的兄弟自动跟上。
		id: 'nano-banana',
		label: 'Nano Banana / Gemini 图像',
		kinds: ['image'],
		stems: [
			'nano-banana',
			'gemini-nano-banana',
			'gemini-2.5-flash-image',
			'gemini-3-pro-image',
			'gemini-3.1-flash-image',
		],
		// `gemini-nano-banana-2.1` 与 `gemini-3.1-flash-image-preview` 是同一支模型的
		// 两个 id 写法，但**刻意不并成一行**：家族键 = `供应商::词干`，并了之后 2.1 就
		// 没有自己的模型行了——聊天栏那格的「常用」里会找不到它（P43 实测：用户第一
		// 反应是「2.1 不见了」）。行分开，参数共用（就是上面这几个前缀）。
		params: [
			{ key: 'aspect_ratio', label: '比例', values: RATIOS },
			// 分辨率在这一族里是**请求参数**（`image_size`），不是模型 id 的兄弟
			// （`…-2k` / `…-4k`）—— 2.1 起才带这个旋钮，前代香蕉同样收它。
			// 大写的 `K` 是硬要求（官方的 `2k` 会被拒）。
			{ key: 'image_size', label: '分辨率', values: ['1K', '2K', '4K'] },
		],
	},
	{
		id: 'seedream',
		label: 'Seedream（豆包）',
		kinds: ['image'],
		stems: ['seedream', 'doubao-seedream', 'dola-seedream'],
		params: [
			{ key: 'size', label: '尺寸', values: [...SIZES_4K, '4096x4096'] },
			{ key: 'output_format', label: '格式', values: ['png', 'jpeg'] },
			{ key: 'watermark', label: '水印', type: 'boolean' },
		],
	},
	{
		id: 'qwen-image',
		label: 'Qwen Image',
		kinds: ['image'],
		stems: ['qwen-image'],
		params: [
			{ key: 'aspect_ratio', label: '比例', values: RATIOS },
			{ key: 'seed', label: '种子', type: 'number' },
			{ key: 'prompt_extend', label: '提示词扩写', type: 'boolean' },
		],
	},
	{
		id: 'sora',
		label: 'Sora',
		kinds: ['video'],
		stems: ['sora'],
		params: [
			{ key: 'size', label: '尺寸', values: ['1280x720', '720x1280', '1792x1024', '1024x1792'] },
			{ key: 'seconds', label: '时长（秒）', values: ['4', '8', '12'] },
		],
	},
	{
		id: 'veo',
		label: 'Veo',
		kinds: ['video'],
		stems: ['veo'],
		params: [
			{ key: 'aspect_ratio', label: '比例', values: ['16:9', '9:16'] },
			{ key: 'resolution', label: '分辨率', values: ['720p', '1080p', '4k'] },
			{ key: 'negative_prompt', label: '负向提示词' },
		],
	},
	{
		id: 'seedance',
		label: 'Seedance（豆包）',
		kinds: ['video'],
		stems: ['seedance', 'doubao-seedance'],
		params: [
			{ key: 'resolution', label: '分辨率', values: ['480p', '720p', '1080p'] },
			{ key: 'duration', label: '时长（秒）', type: 'number' },
			{ key: 'watermark', label: '水印', type: 'boolean' },
		],
	},
	{
		// 这一族（`minimax-h3-ow-*`）**不是** OpenAI 那套平铺体：照 api.seedance.nz 的
		// 视频协议，字段名逐个不同（见 `WireShape` 的注释）。取值同样抄自那份文档：
		// 时长固定零售档位 5/10/15，分辨率 480P/768P/1080P，比例八种（默认 16:9）。
		//
		// ⚠️ 键是**平铺**的（设置页好读），落到请求体时由 `host/providers.ts` 摊成
		// `seconds` + `metadata.{resolution, ratio, …}`；`wirePathOf` 是那份映射的同一份说法。
		// `metadata.audio_urls` / `metadata.video_url` 不在这里：那是**每次调用给素材**的事
		// （≤3 个音频 / ≤3 个视频），不是「默认档」—— 本插件目前只有图片参考那条路。
		id: 'minimax-h3',
		label: 'MiniMax H3（海螺）',
		kinds: ['video'],
		// `-ow-t2v` / `-ow-r2v` / `…-fast` 与将来的尾缀兄弟共用这一条
		stems: ['minimax-h3'],
		wire: 'seedance-nz',
		params: [
			{ key: 'seconds', label: '时长（秒）', values: ['5', '10', '15'] },
			{ key: 'resolution', label: '分辨率', values: ['480P', '768P', '1080P'] },
			{ key: 'ratio', label: '比例', values: ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9'] },
		],
	},
	{
		// 与下面那条 `mj-describe` 是同一家网关的两条协议，只是这条管**出图**。
		// 参数那一排全是 MJ 的 flag：它们**不进请求体**，而是拼进提示词
		// （`--ar 16:9 --stylize 250`），所以 `wirePathOf` 给的是 flag 而不是路径。
		//
		// ⚠️ 词干**只认 fast 的两种写法**，刻意不写 `mj` / `mj_imagine`：同一族里
		// `mj_relax_imagine` / `mj_turbo_*` 的模式是靠**路径或令牌**选的，而这条路
		// 走的是默认的 `/mj`（文档：默认即 fast）。给它们挂上这条预置，等于**按 fast
		// 计费**悄悄跑一次 —— 宁可让那些模型报「不认识这个模型」，也不要静默换计费档。
		id: 'mj-imagine',
		label: 'Midjourney Imagine',
		kinds: ['image'],
		stems: ['mj_fast_imagine', 'mj-fast-imagine'],
		wire: 'mj-imagine',
		params: [
			{ key: 'ar', label: '比例', values: RATIOS },
			{ key: 'v', label: '版本', values: ['7', '6.1', '6', '5.2'] },
			{ key: 'iw', label: '垫图权重', values: ['0.5', '1', '1.5', '2'], type: 'number' },
			{ key: 'stylize', label: '风格化', values: ['0', '50', '100', '250', '500', '750', '1000'], type: 'number' },
			{ key: 'chaos', label: '变化度', values: ['0', '10', '25', '50', '75', '100'], type: 'number' },
			{ key: 'no', label: '排除' },
			{ key: 'seed', label: '种子', type: 'number' },
			{ key: 'tile', label: '无缝平铺', type: 'boolean' },
		],
	},
	{
		// 这一条存在的唯一理由是**让宿主挑对协议分支**（`wire`）：
		// 视觉模型没有「其他参数」也没有档位，设置页那边一个字都不显示。
		//
		// 图生文在 MJ 系网关上不是一次往返，而是「提交任务 → 轮询」（见 `WireShape`），
		// 与缺省那条 `chat/completions` 毫无共同点 —— 名字撞不上这条预置的模型
		// 就会去 POST `{base}/chat/completions`，报一句「响应里没有 choices…」。
		id: 'mj-describe',
		label: 'Midjourney 图生文',
		kinds: ['vision'],
		// 前缀匹配：`mj-describe` / `mj_describe` 之外，`midjourney-*` 也命中
		stems: ['mj', 'mj-describe', 'midjourney', 'describe'],
		wire: 'mj-describe',
		params: [],
	},
];

/**
 * 按**词干**找一条预置（纯函数）。
 *
 * 词干是 `splitTier` 的产物，因此 `…-2k` / `…-4k` 这类尾缀兄弟自动命中同一条 ——
 * 这就是「常用模型里的配置覆盖将来带 2K / 4K 尾缀的模型」的落点。
 * @param kind - 模型种类。
 * @param stem - 模型 id 去掉尾部档位词。
 * @returns 命中的预置；没有则 undefined。
 */
export function presetOf(kind: ModelKind, stem: string): ModelPreset | undefined {
	const text = stem.trim().toLowerCase();
	if (text === '') return undefined;
	for (const preset of MODEL_PRESETS) {
		if (!preset.kinds.includes(kind)) continue;
		for (const prefix of preset.stems) {
			if (text === prefix || text.startsWith(`${prefix}-`)) return preset;
		}
	}
	return undefined;
}

/**
 * 预置的质量轴（形态与用户手写的声明完全一样，下游只认这一种）。
 *
 * `fallback: ''` 是刻意的：**预置不等于替用户做决定** —— 那一排 chip 出现在
 * 聊天栏里，用户点一下才写进请求体。
 * @param preset - 预置。
 * @returns 质量轴；这条预置没有质量参数时 undefined。
 */
export function presetAxisOf(preset: ModelPreset | undefined): TierAxis | undefined {
	if (preset?.quality === undefined) return undefined;
	return {
		param: preset.quality.param,
		values: preset.quality.values,
		labels: preset.quality.labels,
		fallback: '',
	};
}

/**
 * 把设置里的一个值收敛成请求体里的形状（纯函数，形状不可信）。
 *
 * 两种情形，规则不同是有意的：
 *   - **声明过的键**：按声明里的类型转（`type: 'number'` 的 `"2"` → `2`）；
 *   - **没声明的键**（用户自己加的）：认 `true` / `false` / 纯数字，其余当字符串。
 *
 * `spec.values`（闭集）**不在这里校验**：它只决定设置页渲染成下拉、以及工具
 * 描述里能写出哪些例子。网关的取值集合我们并不真的知道（预置是起点不是承诺），
 * 拿它当校验器会把「用户网关其实支持」的值挡在门外 —— 而挡掉的那个失败，
 * 比让供应商自己回一句「invalid size」更难查。
 * @param spec - 参数声明；用户自加的键没有声明。
 * @param raw - 原始值（设置里是字符串，模型可能直接给数字 / 布尔）。
 * @returns 可写进请求体的值；无法收敛时 undefined（调用方按「不带这个键」处理）。
 */
export function coerceParam(spec: ParamSpec | undefined, raw: unknown): string | number | boolean | undefined {
	if (typeof raw === 'boolean') return spec?.type === 'string' ? String(raw) : raw;
	if (typeof raw === 'number') {
		if (!Number.isFinite(raw)) return undefined;
		return spec?.type === 'string' ? String(raw) : raw;
	}
	if (typeof raw !== 'string') return undefined;
	const text = raw.trim();
	if (text === '') return undefined;

	if (spec?.type === 'number') {
		const num = Number(text);
		return Number.isFinite(num) ? num : undefined;
	}
	if (spec?.type === 'boolean') {
		if (text !== 'true' && text !== 'false') return undefined;
		return text === 'true';
	}
	if (spec !== undefined) return text;
	// 自加的键：`2` 当数字、`true` 当布尔，其余原样（见上面的规则说明）
	if (text === 'true') return true;
	if (text === 'false') return false;
	return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : text;
}

/**
 * 参数键是否能用（保留键与空串一律不行）。
 * @param key - 待检查的键。
 * @returns 是否可用。
 */
export function isParamKey(key: string): boolean {
	const text = key.trim();
	return text !== '' && !RESERVED_PARAM_KEYS.includes(text) && /^[a-z][a-z0-9_]*$/.test(text);
}
