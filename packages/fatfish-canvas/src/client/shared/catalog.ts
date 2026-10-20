/**
 * 供应商目录（宿主与设置页**共用的一份**）。
 *
 * 放在 `src/client/shared/` 而不是 `src/shared/`，是因为客户端打包器只把
 * `src/client` 当作解析根，跨出这个根目录的 import 无法解析。宿主半边则用
 * `../client/shared/catalog` 反向引用 —— 目录里只有纯数据与纯函数，没有任何
 * schemastery / Node 依赖，因此同时安全地存在于两个半边。
 *
 * ## P9：目录从「可配置清单」变成了**预设**
 *
 * 早期（P2–P8）用户能配的只有目录里那几条固定供应商（每条一个模型）。现在
 * 供应商与模型都是**用户数据**（一个供应商可以挂多个模型，每个模型可单独配
 * 密钥），目录退化成「一键添加」的模板：设置页拿它预填一条供应商记录，之后
 * 一切都是用户自己的数据。
 *
 * 两条因此固定下来的约定：
 *
 * 1. **供应商 id 是用户的 slug**（预填时来自预设 id），只允许小写字母/数字/
 *    短横线 —— 它要能安全地出现在设置字段路径与凭据引用名里。
 * 2. **密钥一律不进设置**：设置里只存凭据**引用名**（`apiKeyEnv`），
 *    值在 DSH 凭据库（`ctx.credentials`）里。这样脱敏视图与真实视图一致，
 *    任何写入形状都不会抹掉别人的机密（旧设计要为此把字段摊平，见 P2 注释）。
 *
 * @module fatfish-canvas/shared/catalog
 */

/**
 * 设置分节的键 = 本插件的 **Loader entry id**（profile patch 里那一行的 `id:`）。
 *
 * 0.2.0 起没有「插件自建 namespace」这回事了：设置服务按 entry id 找到插件
 * 运行时的 `Config`（`dsh-settings` 的 `schema(entry)`），客户端也用同一个
 * 字符串 `ctx.configForms.get(...)`，宿主侧写回则是
 * `ctx.settings.mutate(<entry id>, ops)`。因此它必须与
 * `cordis.patch.yml`（或 profile patch）里那行的 `id:` **逐字相同** ——
 * 宿主半边、设置页与工具条共用这一份常量，就是为了不可能写歪。
 */
export const SETTINGS_ENTRY_ID = 'fatfish-canvas';

/** 媒体种类（一次**生成**的产物）。 */
export type MediaKind = 'image' | 'video';

/**
 * 设置里一个**模型条目**的种类。
 *
 * `vision` 不是产物，而是「眼睛」：文本模型看不见参考图时，由它把图读成一段文字
 * （见 host/vision 与 `defaultVision`）。它和图像 / 视频模型挂在同一个供应商字典下，
 * 因此设置页里它们是并排的一行，用户不必去别处再配一次密钥。
 */
export type ModelKind = MediaKind | 'vision';

/** 适配器种类。三种都按 OpenAI 兼容协议通信。 */
export type MediaApi = 'openai-images' | 'openai-videos' | 'openai-vision';

/**
 * 模型种类 → 适配器。
 *
 * 由**模型**的种类决定，而不是供应商的：同一个 gateway 往往既提供图像模型
 * 也提供视频模型（OpenAI 自己就是 gpt-image-1 + sora），把适配器挂在供应商上
 * 会逼用户为同一个 baseURL 建两条记录。
 * @param kind - 模型种类。
 * @returns 适配器名。
 */
export function apiOf(kind: ModelKind): MediaApi {
	if (kind === 'video') return 'openai-videos';
	return kind === 'vision' ? 'openai-vision' : 'openai-images';
}

/** 预设里的一个模型。 */
export interface PresetModel {
	/** 线上模型名（原样发给供应商）。 */
	id: string;
	/** 图像 / 视频 / 视觉。 */
	kind: ModelKind;
}

/** 目录里的一条供应商预设。 */
export interface ProviderPreset {
	/** 预设 id，同时是新建供应商时的默认 slug。 */
	id: string;
	/** 展示名。 */
	label: string;
	/** 预设接口基址。 */
	baseURL: string;
	/** 去哪里申请密钥（给用户的提示）。 */
	hint: string;
	/** 预设模型清单（至少一个）。 */
	models: readonly PresetModel[];
}

/**
 * 供应商预设目录。
 *
 * 只收录**确定提供 OpenAI 兼容端点**的服务：OpenAI 官方，以及国内常用的
 * 方舟 / 硅基流动 / 智谱。其余服务（Replicate、Runway 等自有协议）需要各自的
 * 适配器，属于目录扩张而非 schema 变更 —— 用户也可以直接「自定义供应商」，
 * 只要对方是 OpenAI 兼容端点。
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
	{
		id: 'openai',
		label: 'OpenAI',
		baseURL: 'https://api.openai.com/v1',
		hint: 'platform.openai.com → API keys',
		models: [
			{ id: 'gpt-image-1', kind: 'image' },
			{ id: 'sora-2', kind: 'video' },
		],
	},
	{
		id: 'volces',
		label: '火山方舟（豆包）',
		baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
		hint: 'console.volcengine.com/ark → API Key',
		models: [
			{ id: 'doubao-seedream-3-0-t2i-250415', kind: 'image' },
			{ id: 'doubao-seedance-1-0-pro-250528', kind: 'video' },
		],
	},
	{
		id: 'siliconflow',
		label: '硅基流动',
		baseURL: 'https://api.siliconflow.cn/v1',
		hint: 'cloud.siliconflow.cn → API 密钥',
		models: [
			{ id: 'Kwai-Kolors/Kolors', kind: 'image' },
			{ id: 'Wan-AI/Wan2.1-T2V-14B', kind: 'video' },
		],
	},
	{
		id: 'zhipu',
		label: '智谱 AI',
		baseURL: 'https://open.bigmodel.cn/api/paas/v4',
		hint: 'open.bigmodel.cn → API Keys',
		models: [{ id: 'cogview-4', kind: 'image' }],
	},
];

// ─────────────────────── 凭据引用名 ───────────────────────

/**
 * 把一段文本收敛成合法的凭据引用名片段。
 *
 * 凭据引用必须匹配 `^[A-Za-z_][A-Za-z0-9_]*$`（POSIX 标识符），因此
 * 大写、非字母数字一律换成下划线。
 * @param text - 原始文本（供应商或模型 id）。
 * @returns 合法片段（可能为空串）。
 */
export function refToken(text: string): string {
	return text.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * 供应商级密钥的凭据引用名。
 * @param providerId - 供应商 id。
 * @returns 形如 `FFC_ACME_API_KEY`。
 */
export function providerKeyRef(providerId: string): string {
	return `FFC_${refToken(providerId)}_API_KEY`;
}

/**
 * 模型级密钥的凭据引用名（覆盖供应商级）。
 * @param providerId - 供应商 id。
 * @param modelId - 模型 id。
 * @returns 形如 `FFC_ACME_ACME_LARGE_API_KEY`。
 */
export function modelKeyRef(providerId: string, modelId: string): string {
	return `FFC_${refToken(providerId)}_${refToken(modelId)}_API_KEY`;
}

// ─────────────────────── 默认模型的取值约定 ───────────────────────

/**
 * 默认模型的取值：`<供应商 id>::<模型 id>`。
 *
 * 刻意不用 `/` 分隔：模型 id 里**真的会**出现斜杠（硅基流动的
 * `Kwai-Kolors/Kolors`），用 `/` 会让「默认值」无法可靠地拆回两段。
 * `::` 出现在 id 里的概率可以忽略，且供应商 id 由我们收成 slug。
 * @param providerId - 供应商 id。
 * @param modelId - 模型 id。
 * @returns 默认值字符串。
 */
export function modelRef(providerId: string, modelId: string): string {
	return `${providerId}::${modelId}`;
}

/**
 * 拆一个默认值。
 * @param value - 形如 `acme::acme-large`（也兼容只写供应商 id 的旧值）。
 * @returns 两段；`model` 为空表示「该供应商下第一个可用模型」。
 */
export function parseModelRef(value: string): { providerId: string; modelId: string } {
	const at = value.indexOf('::');
	if (at < 0) return { providerId: value.trim(), modelId: '' };
	return { providerId: value.slice(0, at).trim(), modelId: value.slice(at + 2).trim() };
}

/**
 * 默认**档位**字段：`{ "供应商::词干": "high" }`。
 *
 * 只承载**质量轴**（请求参数那种档位）；分辨率轴的档位就是模型 id 本身，
 * 记在 `defaultImage` / `defaultVideo` 里，不需要第二个字段。
 */
export const FIELD_DEFAULT_TIERS = 'defaultTiers';

/** 默认图像模型字段。 */
export const FIELD_DEFAULT_IMAGE = 'defaultImage';
/** 默认视频模型字段。 */
export const FIELD_DEFAULT_VIDEO = 'defaultVideo';
/** 默认视觉模型字段（把参考图读成文字用的那个）。 */
export const FIELD_DEFAULT_VISION = 'defaultVision';
/** 单次生成整体超时字段。 */
export const FIELD_TIMEOUT = 'timeoutMs';
/** 供应商字典字段。 */
export const FIELD_PROVIDERS = 'providers';
/**
 * 生成结果**本地留档**目录字段（P32）。
 *
 * 空 = 不留档（默认）：供应商回的是会过期的签名地址，留档就是把字节抓下来
 * 写进这个目录，之后聊天与画布都指向本地副本。
 */
export const FIELD_ARCHIVE_DIR = 'archiveDir';

/**
 * 「设计技能」的**开关**字段（缺省 = 开）。
 *
 * 聊天框那格鲸鱼尾巴的**右键**写的就是它：开 = 把
 * {@link DESIGN_SKILL_BUILTIN}（或用户改过的那份）注入**聊天模型**的 system prompt
 * （由它组织出让生成模型懂、又符合设计要求的提示词），
 * 关 = 注入一段空文本、渲染时被平台滤掉（尾巴也压回默认的纯色）。客户端快照读不到
 * 这个键时同样按开算（与 schema 的缺省一致），因此「关」必须是**显式**写进设置的 false。
 */
export const FIELD_DESKILL_ON = 'designSkillOn';

/**
 * 「设计技能」的**文案**字段：开关开着时注入聊天模型 system prompt 的那段文字。
 *
 * 它是用户数据（「肥鱼画布」设置页里直接编辑）：出图效果不合意时改这里，不用改代码。
 * unset（清空提交）= 回到下面的内置文案。
 */
export const FIELD_DESKILL_TEXT = 'designSkill';

/**
 * 内置的设计技能文案（{@link FIELD_DESKILL_TEXT} 的 schema 缺省值）。
 *
 * 注入的是**写提示词的大语言模型**，不是生成模型 —— 所以写成「给模型的行为要求」：
 * 它按这些要求去为 media_generate 组织 prompt。生成效果不合意时用户在设置页里
 * 改这一份，代码不参与演化。
 */
export const DESIGN_SKILL_BUILTIN = [
	'- 主体清晰、构图有主次，画面干净利落：不要杂乱元素、水印和多余文字。',
	'- 色彩与光影统一协调，对比与留白得当，贴合场景氛围。',
	'- 材质、纹理与细节真实可信，整体有专业设计感与精致质感。',
].join('\n');

// ─────────────────────── 档位（家族 × 两条轴） ───────────────────────
//
// 「档位」在这个插件里是**两条不同的轴**，必须分开解，否则会把一件根本不用
// 动数据的事（分辨率）和一件必须动数据的事（质量）搅在一起：
//
//   1. **分辨率轴 = 网关上的兄弟模型 id**（`…-1k` / `…-2k` / `…-4k`）。
//      它不是新机制：选中那个兄弟 id 就是选中档位，`defaultImage` 一个字段
//      就够了，请求体里的 `model` 自然是对的。因此它**不落盘、不用配置**。
//   2. **质量轴 = 请求参数**（`quality: low|high`）。`GET /models` 只回 id，
//      没有任何「这个模型收哪些 quality」的信号 —— 所以它**只能由用户在设置里
//      声明**（`models[].tiers`）。假装能自动探测是撒谎，这里不干。
//
// 两条轴共用一个概念：**家族**（family）= 供应商 + 词干。词干 = 模型 id 去掉
// 尾部档位词。家族是**派生**的（不落盘），因此「配置完之后自动多出一个档位
// 选择」在没有兄弟、也没有声明的模型上**自然退化成今天的平铺行**。

/**
 * 档位词闭集：只有 id 的**最后一段**命中它才当成档位。
 *
 * 宁可漏分组也不错分组：漏了只是少一层折叠（用户看到的还是完整 id），
 * 错了会把两个不相干的模型塞进同一行。所以这里只收「几乎只可能是档位」的词。
 */
export const TIER_WORDS: readonly string[] = [
	'1k',
	'2k',
	'4k',
	'8k',
	'low',
	'medium',
	'high',
	'xhigh',
	'auto',
	'fast',
	'standard',
	'hd',
	'pro',
	'max',
	'turbo',
	'mini',
	'plus',
	'ultra',
];

/** 查表用（`TIER_WORDS` 的集合形态）。 */
const TIER_WORD_SET = new Set(TIER_WORDS);

/** 档位参数名的合法形状（它要原样进请求体，因此收得比供应商 id 还紧）。 */
export const TIER_PARAM_RE = /^[a-z][a-z0-9_]*$/;

/**
 * 参数键里**不许用**的名字（质量轴与其他参数共用这一份清单）。
 *
 * 这几个键是适配器自己写的（`model` / `prompt` / `n` 与参考图字段），声明它们
 * 等于让用户把请求写坏 —— 而失败还发生在供应商那侧，报错很难看懂。
 *
 * `n` 尤其要紧：网关按 n 出图、而适配器只读 `data[0]`（见 host/providers.ts），
 * 于是 n>1 是**静默丢图**（钱花了、图没了）。多张的正路是并发调用多次。
 *
 * ⚠️ **只有这一份**（`modelPresets.isParamKey` 从这里取）：曾经两处各写一份，
 * 一份漏了 `n`，于是设置页不让声明、宿主却照收 —— 两半边的判断必须同源。
 */
export const RESERVED_PARAM_KEYS: readonly string[] = ['model', 'prompt', 'n', 'image'];

/**
 * 质量轴：一个家族上「哪个参数、有哪些取值、取值怎么显示」的声明。
 *
 * 它是**用户数据**（设置里的 `models[].tiers`），不是目录：不同网关同一件事
 * 的参数名并不统一（`quality` / `resolution` / `hd`…），写死在代码里只能覆盖一家。
 */
export interface TierAxis {
	/** 请求体里的参数名（如 `quality`）。 */
	param: string;
	/** 可选取值（按显示顺序）。 */
	values: readonly string[];
	/** 取值 → 展示名（`low` → `低`）；缺省用取值原文。 */
	labels: Readonly<Record<string, string>>;
	/**
	 * 用户还没选过时用哪个取值（缺省 = `values[0]`）。
	 *
	 * 空串是**有意义**的：表示「没选就不写进请求体」。内置预置表就是这么声明的
	 * （见 `shared/modelPresets.ts`）—— 预置负责把那一排 chip 摆出来，
	 * 要不要发这个参数由用户点那一下决定。
	 */
	fallback?: string;
}

/**
 * 拆一个模型 id 的**尾部档位词**（纯函数）。
 *
 * 只认最后一段，且必须在 `TIER_WORDS` 里：`gpt-image-2.5-sunburst-2k` →
 * `{ stem: 'gpt-image-2.5-sunburst', tier: '2k' }`；`Kwai-Kolors/Kolors` →
 * 原样（词干 = 自己，没有档位）。
 * @param modelId - 线上模型名。
 * @returns 词干（家族的一半）与档位词（没有则为空串）。
 */
export function splitTier(modelId: string): { stem: string; tier: string } {
	const at = modelId.lastIndexOf('-');
	if (at <= 0) return { stem: modelId, tier: '' };
	const tail = modelId.slice(at + 1);
	if (!TIER_WORD_SET.has(tail.toLowerCase())) return { stem: modelId, tier: '' };
	return { stem: modelId.slice(0, at), tier: tail };
}

/**
 * 家族键：`供应商::词干`（`defaultTiers` 的键，也是设置里声明的归属单位）。
 *
 * 词干由 `splitTier` 从模型 id 现拆：`…-2k` / `…-4k` 这类尾缀兄弟因此共用一行
 * （「同一支模型的两种 id 写法」**不**在这里归并 —— 那会改变家族键，
 * 见 `shared/modelPresets.ts` 里 `nano-banana` 那条注释）。
 * @param providerId - 供应商 id。
 * @param modelId - 线上模型名。
 * @returns 家族键。
 */
export function familyRefOf(providerId: string, modelId: string): string {
	return modelRef(providerId, splitTier(modelId).stem);
}

/**
 * 把一个模型条目里的 `tiers` 声明收敛成质量轴（纯函数，形状不可信）。
 *
 * 参数名非法或取值清单为空时返回 undefined —— **不抛错**：设置可能是手工改坏的，
 * 那种情况下「这个家族没有质量轴」是唯一安全的理解（生成照常进行）。
 * @param raw - 设置里的 `tiers` 原始值。
 * @returns 质量轴；不是有效声明时 undefined。
 */
export function parseTierAxis(raw: unknown): TierAxis | undefined {
	if (raw === null || typeof raw !== 'object') return undefined;
	const record = raw as { param?: unknown; values?: unknown; labels?: unknown };
	const param = typeof record.param === 'string' ? record.param.trim() : '';
	if (!TIER_PARAM_RE.test(param) || RESERVED_PARAM_KEYS.includes(param)) return undefined;

	const values: string[] = [];
	for (const entry of Array.isArray(record.values) ? record.values : []) {
		const value = typeof entry === 'string' ? entry.trim() : '';
		if (value !== '' && !values.includes(value)) values.push(value);
	}
	if (values.length === 0) return undefined;

	const labels: Record<string, string> = {};
	if (record.labels !== null && typeof record.labels === 'object') {
		for (const [key, value] of Object.entries(record.labels as Record<string, unknown>)) {
			if (typeof value === 'string' && value.trim() !== '') labels[key] = value.trim();
		}
	}
	return { param, values, labels };
}

/**
 * 一个供应商里「词干 → 质量轴」的表。
 *
 * 同一个词干下**任何一个成员**声明了就算这个家族有这条轴（取第一个有效声明）：
 * 用户在设置页只需要在家族里任意一行上配一次，不必给每个分辨率档都配一遍。
 * @param models - 该供应商的模型清单（形状不可信，逐字段校验）。
 * @returns 词干 → 质量轴。
 */
export function tierAxesOf(models: readonly { id?: unknown; tiers?: unknown }[]): Map<string, TierAxis> {
	const axes = new Map<string, TierAxis>();
	for (const model of models) {
		if (model === null || typeof model !== 'object') continue;
		const modelId = typeof model.id === 'string' ? model.id.trim() : '';
		if (modelId === '') continue;
		const axis = parseTierAxis(model.tiers);
		if (axis === undefined) continue;
		const stem = splitTier(modelId).stem;
		if (!axes.has(stem)) axes.set(stem, axis);
	}
	return axes;
}

/**
 * 家族当前的质量档：存的值合法就用它，否则退回声明的默认值。
 *
 * 默认值 = `fallback`（可能是空串 = 不传）；用户手写的声明没有 `fallback`，
 * 因此行为与 P28 完全一致（取第一个取值）。
 * @param stored - `defaultTiers[家族键]` 的原始值。
 * @param axis - 这个家族的质量轴；没有轴时返回空串。
 * @returns 生效的档位取值。
 */
export function currentTier(stored: unknown, axis: TierAxis | undefined): string {
	if (axis === undefined || axis.values.length === 0) return '';
	const value = typeof stored === 'string' ? stored.trim() : '';
	if (axis.values.includes(value)) return value;
	const fallback = axis.fallback ?? axis.values[0] ?? '';
	return axis.values.includes(fallback) ? fallback : '';
}

/**
 * 一个档位取值的展示名（`low` → `低`）。
 * @param value - 档位取值。
 * @param axis - 质量轴（提供 labels）；没有时用取值原文。
 * @returns 展示名。
 */
export function tierLabel(value: string, axis: TierAxis | undefined): string {
	const label = axis?.labels[value];
	return label === undefined || label === '' ? value : label;
}

/**
 * 一个**家族**（`供应商::词干`）的「常用模型」配置。
 *
 * 键是家族而不是模型 id：这正是「同一类型的模型共用一份配置」的落点 ——
 * 将来网关多出一个 `…-4k` 尾缀的兄弟，它落在同一个词干上，**不用再配一次**。
 */
export interface CommonModelConfig {
	/** 是否进聊天栏那格的「常用」分区。 */
	pinned: boolean;
	/**
	 * 是否使用质量参数（缺省 true）。
	 *
	 * `false` 只对**内置预置**有意义：手写的 `models[].tiers` 声明永远优先，
	 * 它是用户明说过的，不该被一个开关压掉。
	 */
	quality: boolean;
	/** 其他参数：键 → 默认值（空串 = 只声明、默认不传）。 */
	params: Readonly<Record<string, string>>;
}

/** 一个家族都没有配过时的缺省值。 */
export const EMPTY_COMMON: CommonModelConfig = { pinned: false, quality: true, params: {} };

/**
 * 「常用模型」字段：`{ "供应商::词干": { pinned, quality, params } }`。
 */
export const FIELD_COMMON_MODELS = 'commonModels';

/**
 * 把设置里的 `commonModels` 收敛成一张表（纯函数，形状不可信）。
 *
 * 坏数据只让**那一项**退回缺省，不抛错：设置可能被手工改坏，而「这个家族没配过」
 * 是唯一安全的理解（生成照常进行）。
 * @param raw - 设置里的原始值。
 * @returns 家族键 → 配置。
 */
export function parseCommonModels(raw: unknown): Record<string, CommonModelConfig> {
	const out: Record<string, CommonModelConfig> = {};
	if (raw === null || typeof raw !== 'object') return out;
	for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
		if (entry === null || typeof entry !== 'object') continue;
		const record = entry as { pinned?: unknown; quality?: unknown; params?: unknown };
		const params: Record<string, string> = {};
		if (record.params !== null && typeof record.params === 'object') {
			for (const [name, value] of Object.entries(record.params as Record<string, unknown>)) {
				if (typeof value === 'string') params[name] = value.trim();
			}
		}
		out[key] = {
			pinned: record.pinned === true,
			quality: record.quality !== false,
			params,
		};
	}
	return out;
}

/** 供应商 id 的合法形状：小写字母开头，只含小写字母 / 数字 / 短横线。 */
export const PROVIDER_ID_RE = /^[a-z][a-z0-9-]*$/;

/**
 * 供应商 id 是否合法（它要能进设置字段路径与凭据引用名）。
 * @param id - 待检查的 id。
 * @returns 是否合法。
 */
export function isValidProviderId(id: string): boolean {
	return PROVIDER_ID_RE.test(id) && id.length <= 40;
}

// ─────────────────────── 旧字段（P8 及以前） ───────────────────────
//
// 旧设计把每个目录供应商的密钥/模型/基址摊成三个顶层标量字段。P9 之后它们
// 只用于**迁移**：宿主启动时把值搬进 providers 字典与凭据库，然后 unset 掉。
// 仍然在 schema 里声明，是因为「不在 schema 里的字段」不会被脱敏 ——
// 留在文档里的旧密钥会被原样下发给浏览器。

/** 旧：目录 id → 字段名词干（`-` 不能出现在字段名里）。 */
function stemOf(id: string): string {
	return id.replace(/-/g, '_');
}

/**
 * 旧字段名：密钥。
 * @param id - 旧目录 id。
 * @returns 顶层字段名。
 */
export function legacyKeyFieldOf(id: string): string {
	return `key_${stemOf(id)}`;
}

/**
 * 旧字段名：模型覆盖。
 * @param id - 旧目录 id。
 * @returns 顶层字段名。
 */
export function legacyModelFieldOf(id: string): string {
	return `model_${stemOf(id)}`;
}

/**
 * 旧字段名：基址覆盖。
 * @param id - 旧目录 id。
 * @returns 顶层字段名。
 */
export function legacyBaseURLFieldOf(id: string): string {
	return `baseURL_${stemOf(id)}`;
}

/**
 * 旧目录 id 清单（P8 及以前有六条，每条一个模型）。
 *
 * 迁移时要把这些 id 映射到新结构里的 `供应商::模型`。
 */
export const LEGACY_PROVIDER_IDS: readonly { id: string; providerId: string; modelId: string; kind: MediaKind; baseURL: string }[] = [
	{ id: 'openai-images', providerId: 'openai', modelId: 'gpt-image-1', kind: 'image', baseURL: 'https://api.openai.com/v1' },
	{ id: 'openai-videos', providerId: 'openai', modelId: 'sora-2', kind: 'video', baseURL: 'https://api.openai.com/v1' },
	{ id: 'volces-images', providerId: 'volces', modelId: 'doubao-seedream-3-0-t2i-250415', kind: 'image', baseURL: 'https://ark.cn-beijing.volces.com/api/v3' },
	{ id: 'volces-videos', providerId: 'volces', modelId: 'doubao-seedance-1-0-pro-250528', kind: 'video', baseURL: 'https://ark.cn-beijing.volces.com/api/v3' },
	{ id: 'siliconflow-images', providerId: 'siliconflow', modelId: 'Kwai-Kolors/Kolors', kind: 'image', baseURL: 'https://api.siliconflow.cn/v1' },
	{ id: 'zhipu-images', providerId: 'zhipu', modelId: 'cogview-4', kind: 'image', baseURL: 'https://open.bigmodel.cn/api/paas/v4' },
];
