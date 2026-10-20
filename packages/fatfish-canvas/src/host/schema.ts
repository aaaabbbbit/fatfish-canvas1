/**
 * 肥鱼画布 · 媒体生成的设置 schema（宿主半边）。
 *
 * ## 形状：`providers` 字典 + 凭据引用（P9）
 *
 * 用户层住在 profile patch 里那一行的 `config:` 下。**键 = 本插件的 Loader
 * entry id**（`fatfish-canvas`）—— 0.2.0 起设置分节就是按 entry id 寻址的，
 * 旧的自定义 namespace（`media-generation`）已经不存在了：
 *
 * ```
 * - id: fatfish-canvas
 *   name: fatfish-canvas
 *   config:
 *     providers:
 *       acme:
 *         label: Acme 网关
 *         baseURL: https://gateway.acme.example/v1
 *         apiKeyEnv: FFC_ACME_API_KEY          ← 引用，不是密钥
 *         models:
 *           - id: acme-large
 *             kind: image
 *             apiKeyEnv: FFC_ACME_ACME_LARGE_API_KEY   ← 可选的按模型覆盖
 *           - id: acme-video
 *             kind: video
 *     defaultImage: acme::acme-large
 *     defaultVideo: acme::acme-video
 *     defaultTiers:                          ← 家族（供应商::词干）→ 当前质量档
 *       acme::acme-large: high
 *     designSkillOn: true                    ← 设计技能开关（尾巴右键切换）
 *     designSkill: - 主体清晰…               ← 开着时注入聊天模型 system prompt 的文案
 * ```
 *
 * ## 档位：两条轴，只有一条需要落盘
 *
 * `models[].tiers` 只是**质量轴**的声明（`{ param: quality, values: [low, high] }`），
 * 它挂在家族上（同一词干的兄弟共用）。**分辨率轴不在设置里** —— `…-2k` / `…-4k`
 * 是不同的模型 id，选中哪个由 `defaultImage` 本身表达。解析时两者合成
 * `ResolvedModel.params`，适配器只负责把它展开进请求体（见 host/providers.ts）。
 *
 * 两件事必须一起成立，缺一件就会踩坑：
 *
 * 1. **密钥只以引用形式进设置**（`ctx.credentials` 存值）。设置里因此**没有**
 *    `role('secret')` 字段 → 脱敏视图与真实视图完全一致 → 「读回来再整体写回」
 *    不会抹掉任何机密。旧设计（P2–P8）之所以必须把字段摊平，就是因为脱敏视图
 *    里读不到密钥；把密钥移出设置之后，这个约束自然消失，于是「一个供应商挂
 *    多个模型 + 每个模型单独配密钥」这种嵌套结构才有地方放。
 *
 * 2. **写路径用深路径 op**。设置页的 `ConfigForm.set(field)` 只会拼出
 *    `path:[field]`（单段），所以它**只能**写顶层标量；嵌套叶子要经
 *    `remote.settings.mutate` 的 `path:['providers', id, 'baseURL']` 写（DSH 自己的
 *    「模型」设置页就是这么做的）。数组（`models`）是**整体替换**语义：
 *    改一个模型就重写整个数组。
 *
 * ## 旧字段仍然声明着，但只为了迁移
 *
 * `key_<id>` / `model_<id>` / `baseURL_<id>`（P8 及以前的六条目录项）继续留在
 * schema 里：不在 schema 里的字段**不会**被脱敏，留在文档里的旧密钥会被原样
 * 下发给浏览器。宿主启动时统一迁移进新结构并 unset 掉（见 `migrateLegacy`）。
 *
 * 它们同样必须 `.volatile()`：设置服务只接受落在 volatile 节点下的写路径
 * （`isVolatilePath`），不标的话那次 `unset` 会被拒 —— 而它正是**唯一**能把
 * 明文旧密钥从文档里清掉的动作。
 *
 * @module fatfish-canvas/host/schema
 */

import Schema from '@deepseek-ai/schemastery';
import {
	apiOf,
	DESIGN_SKILL_BUILTIN,
	EMPTY_COMMON,
	FIELD_ARCHIVE_DIR,
	FIELD_DESKILL_ON,
	FIELD_DESKILL_TEXT,
	FIELD_COMMON_MODELS,
	FIELD_DEFAULT_IMAGE,
	FIELD_DEFAULT_TIERS,
	FIELD_DEFAULT_VIDEO,
	FIELD_DEFAULT_VISION,
	FIELD_PROVIDERS,
	LEGACY_PROVIDER_IDS,
	SETTINGS_ENTRY_ID,
	currentTier,
	familyRefOf,
	legacyBaseURLFieldOf,
	legacyKeyFieldOf,
	legacyModelFieldOf,
	modelRef,
	parseCommonModels,
	parseModelRef,
	providerKeyRef,
	splitTier,
	tierAxesOf,
	type CommonModelConfig,
	type MediaApi,
	type MediaKind,
	type ModelKind,
	type TierAxis,
} from '../client/shared/catalog';
import {
	coerceParam,
	isParamKey,
	isWireShape,
	presetAxisOf,
	presetOf,
	type ParamSpec,
	type WireShape,
} from '../client/shared/modelPresets';

// 共享模块里的常量与工具原样再导出 —— 宿主与设置页引用同一份，不可能漂移。
export {
	FIELD_ARCHIVE_DIR,
	FIELD_COMMON_MODELS,
	FIELD_DEFAULT_IMAGE,
	FIELD_DEFAULT_TIERS,
	FIELD_DEFAULT_VIDEO,
	FIELD_DEFAULT_VISION,
	FIELD_PROVIDERS,
	FIELD_DESKILL_ON,
	FIELD_DESKILL_TEXT,
	SETTINGS_ENTRY_ID,
	type MediaApi,
	type MediaKind,
	type ModelKind,
	type TierAxis,
};

/** 一个模型的用户配置。 */
export interface ModelProfile {
	/** 线上模型名（原样发给供应商）。 */
	id: string;
	/** 图像 / 视频 / **视觉**（视觉模型只在「把参考图读成文字」时用）。 */
	kind: ModelKind;
	/** 该模型专属密钥的凭据引用名；空 = 继承供应商级。 */
	apiKeyEnv?: string;
	/** 展示名（可空，空则用 id）。 */
	label?: string;
	/**
	 * 这个模型的**质量轴**声明（可选）。
	 *
	 * 声明挂在**家族**上：同一个词干（见 `splitTier`）的兄弟模型共用一份，
	 * 写在任意一个成员上都生效。分辨率档位**不在这里** —— 它是模型 id 本身。
	 */
	tiers?: TierAxis;
}

/** 一个供应商的用户配置。 */
export interface ProviderProfile {
	/** 展示名（可空，空则用 id）。 */
	label?: string;
	/** 接口基址（形如 `https://host/v1`）。 */
	baseURL: string;
	/** 供应商级密钥的凭据引用名；空 = 未配置。 */
	apiKeyEnv?: string;
	/** 模型清单。 */
	models: ModelProfile[];
	/**
	 * 参考图怎么发：`field`（默认）把地址塞进 `/images/generations` 的 JSON 字段，
	 * `edits` 走 `/images/edits` 的 multipart（OpenAI 官方那类只认这条）。
	 */
	referenceMode?: string;
	/** 参考图的字段名（默认 `image`；各家视频网关各不相同，如 `image_url`、`first_frame_image`）。 */
	referenceField?: string;
	/**
	 * 请求体的形状（`shared/modelPresets` 的 `WireShape`）；空 = 用模型预置 / 缺省那套。
	 *
	 * 这里是**供应商级**的覆盖，存在的理由只有一个：kie.ai 那种「同一个模型名、
	 * 两种协议」的中转 —— 预置按**词干**匹配，把 `kie-jobs` 挂进预置表会把另一家
	 * 中转的同名模型一起带沟里（协议不同 = 请求体发错 = 400 或静默出废片）。
	 */
	wire?: string;
}

/** 本 entry 配置的完整解析值（`readLiveConfig` 的产物：一份普通对象）。 */
export interface MediaGenerationConfig {
	/** 供应商字典（键是用户起的 slug）。 */
	providers: Record<string, ProviderProfile>;
	/** 默认图像模型，`<供应商>::<模型>`；空 = 自动挑第一个可用的。 */
	defaultImage: string;
	/** 默认视频模型，同上。 */
	defaultVideo: string;
	/**
	 * 默认**视觉**模型，同上。
	 *
	 * 它只在「当前模型看不见参考图」时出场：把参考图读成一段文字，注入生成提示词，
	 * 并随工具结果回给模型（相当于给文本模型配一双眼睛）。空 = 不启用这个功能。
	 */
	defaultVision: string;
	/** 家族（`供应商::词干`）→ 当前质量档；缺省 = 用声明里的默认取值。 */
	defaultTiers?: Record<string, string>;
	/**
	 * 家族（`供应商::词干`）→ 常用模型配置（勾选 / 质量开关 / 其他参数默认值）。
	 *
	 * 键是**家族**，所以「将来带 2K / 4K 尾缀的兄弟」自动共用同一份配置。
	 */
	commonModels?: Record<string, CommonModelConfig>;
	/** 单次生成的整体超时（毫秒）；视频轮询用它。 */
	timeoutMs: number;
	/** 生成结果落到画布时的边长上限（world px）。 */
	maxNodeSize: number;
	/**
	 * 生成结果的**本地留档目录**（P32）；空 = 不留档。
	 *
	 * 供应商回的签名地址会过期（「图放久了加载不出来」的根因），配了这个目录
	 * 之后，宿主在生成成功时把字节写进去，结果地址换成 `/ffc-media/…`
	 * （见 host/archive.ts）。相对路径按宿主进程的工作目录解析，`~` 会展开。
	 */
	archiveDir: string;
	/**
	 * 「设计技能」开关字段（`designSkillOn`，缺省 true）：关 = 不向聊天模型
	 * system prompt 注入这套文案，尾巴也压回默认纯色。聊天框那格鲸鱼尾巴的
	 * 右键写的就是它。
	 */
	designSkillOn: boolean;
	/**
	 * 「设计技能」文案字段（`designSkill`）：开着时注入聊天模型 system prompt
	 * （src/index.ts 的段落注册）。
	 * 缺省 = 内置文案（`DESIGN_SKILL_BUILTIN`）；设置页里清空提交 = unset（回到内置）。
	 */
	designSkill: string;
	/** 旧字段（迁移用），键为字段名。 */
	[index: string]: unknown;
}

/** 一个模型的**质量轴**声明。 */
const TierAxisSchema = Schema.object({
	param: Schema.string().default(''),
	values: Schema.array(Schema.string()).default([]),
	labels: Schema.dict(Schema.string()).default({}),
});

/** 一个家族的**常用模型**配置（键是 `供应商::词干`）。 */
const CommonModelSchema = Schema.object({
	// 勾了「常用」才进聊天栏那格的常用分区
	pinned: Schema.boolean().default(false),
	// 关掉内置预置的质量参数（手写的 tiers 声明不受它影响）
	quality: Schema.boolean().default(true),
	// 其他参数的默认值；键必须在预置或用户自己声明的范围内（host 侧逐项校验）
	params: Schema.dict(Schema.string()).default({}),
});

/** 一个模型条目。 */
const ModelEntrySchema = Schema.object({
	id: Schema.string().required(),
	kind: Schema.union(['image', 'video', 'vision']).default('image'),
	// 凭据**引用名**不是机密，因此照实下发（role('credential-ref') 只是语义标注）
	apiKeyEnv: Schema.string().default(''),
	label: Schema.string().default(''),
	// 质量轴（可选）：不声明 = 这个家族没有参数式档位，请求体里不多任何键
	tiers: TierAxisSchema,
});

/** 一个供应商条目。 */
const ProviderSchema = Schema.object({
	label: Schema.string().default(''),
	baseURL: Schema.string().default(''),
	apiKeyEnv: Schema.string().default(''),
	models: Schema.array(ModelEntrySchema).default([]),
	// 参考图的发送方式与字段名：默认值就是覆盖面最广的那种写法（new-api 系中转、
	// 各家 OpenAI 兼容层都收 `image`）。ponytail: 只声明、暂不做设置页控件 ——
	// 默认值对绝大多数中转站是对的，改它要动设置页（草稿 + 深路径写入 + 客户端断言）。
	// 真遇到字段名不同的网关时，先在 profile patch 那一行的 `config:` 里写
	// （patch 是热发布的），等第二个网关也需要时再把两个输入框加进设置页。
	referenceMode: Schema.string().default('field'),
	referenceField: Schema.string().default(''),
	// 请求体形状的供应商级覆盖（见 ProviderProfile.wire）。与上面两个旋钮同一处境：
	// 只声明、暂不做设置页控件 —— 需要它的那条供应商行由 profile patch 的 `config:` 给。
	wire: Schema.string().default(''),
});

/**
 * 由旧目录字段拼出「仍然要保留的兼容字段」。
 *
 * 这些字段只承载迁移前的值，本插件自己的设置页不显示它们；但它们必须
 * `.volatile()` —— 迁移那一步的 `unset` 走的是设置服务的写路径，而它只接受
 * 落在 volatile 节点下的路径（见模块头）。
 */
const legacyFields = Object.fromEntries(
	LEGACY_PROVIDER_IDS.flatMap((legacy) => [
		[legacyKeyFieldOf(legacy.id), Schema.string().role('secret').volatile()],
		[legacyModelFieldOf(legacy.id), Schema.string().default('').volatile()],
		[legacyBaseURLFieldOf(legacy.id), Schema.string().default('').volatile()],
	]),
);

/**
 * 插件的 **`Config`**（Loader 在激活这一行时用它校验 `config:`）。
 *
 * 三件事必须一起成立，否则设置页整个不出现：
 *
 * 1. **schemastery，不是 zod** —— 设置服务读的是 `runtime.Config` 上的
 *    `"toJSON" in schema`（`dsh-settings` 的 `schema(entry)`），zod 没有
 *    `toJSON()`，于是它会被**静默**当成「这个插件没有 schema」。
 * 2. **每个字段都 `.volatile()`** —— 只有 volatile 字段会进设置分节
 *    （`volatileForm`），也只有它们能经设置服务写（`isVolatilePath`）。
 *    本插件的设置页要读写全部字段（含嵌套叶子），所以整棵树都标上。
 * 3. **字段路径固定** —— schemastery 拒绝「volatile 套 volatile」
 *    （`volatile fields require a fixed object path`），因此只标最外层节点：
 *    `providers` / `commonModels` 这类字典标了之后，它下面的所有叶子都算
 *    volatile，内层不必（也不能）再标。
 */
export const MediaGenerationSchema = Schema.object({
	[FIELD_PROVIDERS]: Schema.dict(ProviderSchema).default({}).volatile(),
	[FIELD_DEFAULT_IMAGE]: Schema.string().default('').volatile(),
	[FIELD_DEFAULT_VIDEO]: Schema.string().default('').volatile(),
	[FIELD_DEFAULT_VISION]: Schema.string().default('').volatile(),
	// 家族键（`供应商::词干`）→ 当前质量档；缺省 = 用声明里的默认取值
	[FIELD_DEFAULT_TIERS]: Schema.dict(Schema.string()).default({}).volatile(),
	// 家族键 → 常用模型配置（勾选 / 质量开关 / 其他参数默认值）
	[FIELD_COMMON_MODELS]: Schema.dict(CommonModelSchema).default({}).volatile(),
	timeoutMs: Schema.number().default(600000).volatile(),
	maxNodeSize: Schema.number().default(512).volatile(),
	// 设计技能（尾巴右键联动的那份：开关 + 文案，都可在设置页里动）
	[FIELD_DESKILL_ON]: Schema.boolean().default(true).volatile(),
	[FIELD_DESKILL_TEXT]: Schema.string().default(DESIGN_SKILL_BUILTIN).volatile(),
	// 本地留档目录（P32）：空 = 关。默认关着 —— 往用户磁盘上写东西必须由用户点头。
	[FIELD_ARCHIVE_DIR]: Schema.string().default('').volatile(),
	...legacyFields,
});

/**
 * 一个 `.volatile()` 字段在 `apply(ctx, config)` 里的形状。
 *
 * 拿到的是**稳定引用**而不是值：Loader 在设置写入后就地更新它，因此读当前值
 * 走 `get()`，不必订阅（见 `dsh-client-ui-theme` 的 `config.preference.get()`）。
 */
export interface LiveField<T> {
	/**
	 * 当前值。
	 * @returns 解析值；字段没有 default 且用户从没配过时是 undefined。
	 */
	get(): T | undefined;
}

/**
 * 插件 `Config` 的**解析结果** —— 也就是 `apply(ctx, config)` 的第二个参数。
 *
 * 每个字段都是 `LiveField`（`Config` 里全都标了 `.volatile()`）。
 */
export interface MediaGenerationLiveConfig {
	[FIELD_PROVIDERS]: LiveField<Record<string, ProviderProfile>>;
	[FIELD_DEFAULT_IMAGE]: LiveField<string>;
	[FIELD_DEFAULT_VIDEO]: LiveField<string>;
	[FIELD_DEFAULT_VISION]: LiveField<string>;
	[FIELD_DEFAULT_TIERS]: LiveField<Record<string, string>>;
	[FIELD_COMMON_MODELS]: LiveField<Record<string, CommonModelConfig>>;
	timeoutMs: LiveField<number>;
	maxNodeSize: LiveField<number>;
	[FIELD_DESKILL_ON]: LiveField<boolean>;
	[FIELD_DESKILL_TEXT]: LiveField<string>;
	[FIELD_ARCHIVE_DIR]: LiveField<string>;
	/** 旧字段（迁移用）：没有 default，因此**可能缺席**（`get()` 回 undefined）。 */
	[index: string]: LiveField<unknown>;
}

/**
 * 把活配置读成一份普通值（每次调用都取当前值）。
 *
 * 为什么要摊平：下游（`resolveModels` / `migrateLegacy` / 工具与命令）读的是
 * 普通对象，而 `config.<字段>` 是引用。**缺席的字段不写进结果** —— 迁移靠
 * 「这个旧字段在不在」判断要不要 unset，塞一个空串进去会让它每次启动都白写一遍。
 * @param live - `apply` 收到的活配置。
 * @returns 一份普通对象（字段缺失 = 用户从没配过、schema 也没有 default）。
 */
export function readLiveConfig(live: MediaGenerationLiveConfig): MediaGenerationConfig {
	const out: Record<string, unknown> = {};
	for (const [field, ref] of Object.entries(live) as [string, LiveField<unknown>][]) {
		const value = ref?.get?.();
		if (value !== undefined) out[field] = value;
	}
	return out as MediaGenerationConfig;
}

/** 一条「已解析」的模型（供应商 × 模型 = 一个可发起生成的目标）。 */
export interface ResolvedModel {
	/** 供应商 id（用户 slug）。 */
	providerId: string;
	/** 供应商展示名。 */
	providerLabel: string;
	/** 模型 id。 */
	modelId: string;
	/** 模型展示名。 */
	modelLabel: string;
	/** 种类（图像 / 视频 / 视觉）。 */
	kind: ModelKind;
	/** 适配器（由种类决定）。 */
	api: MediaApi;
	/** 生效的接口基址。 */
	baseURL: string;
	/** 解析出来的密钥；未配置时为空串。 */
	apiKey: string;
	/** 密钥来自哪个凭据引用（便于设置页显示「继承 / 单独」）。 */
	keyRef: string;
	/** 密钥是否来自模型级覆盖。 */
	keyFromModel: boolean;
	/** 该模型是否就是当前种类的默认。 */
	isDefault: boolean;
	/** 参考图的发送方式：`edits`（multipart 上传）或其它（JSON 字段，默认）。 */
	referenceMode: string;
	/** 参考图的字段名（空 = 用适配器的默认 `image`）。 */
	referenceField: string;
	/**
	 * 这个模型的**质量轴**（家族级；没有则为 undefined）。
	 *
	 * 两条来源，手写的优先：
	 *   1. `models[].tiers` —— 用户明说的（P28）；
	 *   2. 内置预置（`shared/modelPresets.ts`）—— 按词干匹配、**默认不传值**，
	 *      除非这个家族在设置里关掉了质量参数（`commonModels[].quality === false`）。
	 *
	 * 分辨率轴的档位不在这里 —— 它是模型 id 本身。
	 */
	axis?: TierAxis;
	/** 家族键（`供应商::词干`）：档位按它记，也是设置页声明的归属单位。 */
	familyRef: string;
	/** id 尾部的分辨率档位词（`2k` / `low` / `''`）。 */
	tier: string;
	/** 命中的内置预置 id（没有则空串）。设置页用它显示「这是什么类型的模型」。 */
	presetId: string;
	/**
	 * 请求体的**形状**（来自预置；缺省 = OpenAI 兼容那套平铺体）。
	 *
	 * 适配器按它挑拼装分支（见 host/providers.ts 的 `videoBody`）——
	 * `seedance-nz` 那一族的字段名逐个不同，发错了不是 400 就是静默按默认档出片。
	 */
	wire?: WireShape;
	/** 这个家族勾了「常用」（聊天栏那格会把它排到前面）。 */
	pinned: boolean;
	/** 这个家族声明的**其他参数**（键 + 展示名 + 可选取值）；模型调用只能传这些键。 */
	paramSpecs: readonly ParamSpec[];
	/**
	 * 要原样展开进请求体的参数：质量档 + 设置里填了的其他参数。
	 *
	 * 空对象 = 请求体不多任何键（绝大多数模型的常态）。
	 */
	params: Record<string, string | number | boolean>;
	/** 该条目的稳定标识：`<供应商>::<模型>`。 */
	ref: string;
}

/**
 * 把配置解析成「可用的模型清单」。
 *
 * `resolveKey` 由调用方注入（宿主是 `ctx.credentials`，测试是内存表），
 * 因此本模块保持纯函数、可离线单测。
 * @param config - 本 entry 配置的解析值。
 * @param resolveKey - 凭据引用名 → 值（未配置返回空串）。
 * @returns 每个供应商的每个模型一条。
 */
export function resolveModels(
	config: MediaGenerationConfig,
	resolveKey: (ref: string) => string,
): ResolvedModel[] {
	const providers = config[FIELD_PROVIDERS];
	if (providers === null || typeof providers !== 'object') return [];

	const defaultImage = str(config, FIELD_DEFAULT_IMAGE);
	const defaultVideo = str(config, FIELD_DEFAULT_VIDEO);
	const defaultVision = str(config, FIELD_DEFAULT_VISION);
	const wantedOf = (kind: ModelKind): string =>
		kind === 'image' ? defaultImage : kind === 'video' ? defaultVideo : defaultVision;
	// 档位是按家族存的一张表；形状不可信（可能被手工改坏），逐项在下面校验
	const rawTiers = config[FIELD_DEFAULT_TIERS];
	const tierValues: Record<string, unknown> =
		rawTiers !== null && typeof rawTiers === 'object' ? (rawTiers as Record<string, unknown>) : {};
	// 常用模型配置同上：按家族存，坏数据在 parseCommonModels 里就被收敛掉了
	const commonModels = parseCommonModels(config[FIELD_COMMON_MODELS]);

	const out: ResolvedModel[] = [];
	for (const [providerId, raw] of Object.entries(providers)) {
		if (raw === null || typeof raw !== 'object') continue;
		const profile = raw as ProviderProfile;
		const providerLabel = str2(profile.label) === '' ? providerId : str2(profile.label);
		const baseURL = str2(profile.baseURL);
		const providerKeyRef = str2(profile.apiKeyEnv);
		const models = Array.isArray(profile.models) ? profile.models : [];
		// 质量轴按**家族**解析：同一词干的兄弟共用第一次有效声明（用户在任意一行上配一次即可）
		const axes = tierAxesOf(models);
		// 参考图的两个旋钮挂在供应商上（同一家的端点与字段名是一样的）
		const referenceMode = str2(profile.referenceMode) === 'edits' ? 'edits' : 'field';
		const referenceField = str2(profile.referenceField);
		const providerWire = str2(profile.wire);

		for (const model of models) {
			if (model === null || typeof model !== 'object') continue;
			const modelId = str2(model.id);
			if (modelId === '') continue;
			const kind: ModelKind =
				model.kind === 'video' ? 'video' : model.kind === 'vision' ? 'vision' : 'image';
			const { stem, tier } = splitTier(modelId);
			// 内置预置按**词干**匹配：将来多出一个 `…-4k` 尾缀的兄弟自动共用这份配置
			const preset = presetOf(kind, stem);
			// wire：**供应商级优先**（kie 那种「同一模型名、两种协议」的网关只能按供应商
			// 分），它没写才用预置的；`isWireShape` 挡住配置里手写的错字。
			const wire = isWireShape(providerWire) ? providerWire : preset?.wire;
			// 家族键 = `供应商::词干`（客户端那边的 `familyRows` / `mediaCatalog` 走同一条）
			const familyRef = familyRefOf(providerId, modelId);
			const common = commonModels[familyRef] ?? EMPTY_COMMON;
			// 手写的声明永远优先；预置只在没声明、且这个家族没关掉质量参数时补位
			const axis = axes.get(stem) ?? (common.quality ? presetAxisOf(preset) : undefined);
			const tierValue = currentTier(tierValues[familyRef], axis);
			const { params, paramSpecs } = resolveParams(axis, tierValue, preset?.params ?? [], common.params);
			const modelKeyRef = str2(model.apiKeyEnv);
			// 模型级引用优先；它没配（或没填）时回落到供应商级
			const keyFromModel = modelKeyRef !== '' && resolveKey(modelKeyRef) !== '';
			const keyRef = modelKeyRef !== '' ? modelKeyRef : providerKeyRef;
			const apiKey = keyFromModel
				? resolveKey(modelKeyRef)
				: providerKeyRef === ''
					? ''
					: resolveKey(providerKeyRef);

			out.push({
				providerId,
				providerLabel,
				modelId,
				modelLabel: str2(model.label) === '' ? modelId : str2(model.label),
				kind,
				api: apiOf(kind),
				baseURL,
				apiKey,
				keyRef,
				keyFromModel,
				isDefault: wantedOf(kind) === modelRef(providerId, modelId),
				referenceMode,
				referenceField,
				...(axis === undefined ? {} : { axis }),
				familyRef,
				tier,
				presetId: preset?.id ?? '',
				...(wire === undefined ? {} : { wire }),
				pinned: common.pinned,
				paramSpecs,
				params,
				ref: modelRef(providerId, modelId),
			});
		}
	}
	return out;
}

/**
 * 把「质量档 + 设置里填了的其他参数」合成要展开进请求体的那份值。
 *
 * 三条规则，都是为了「不悄悄做用户没说过的事」：
 *   - 质量档**没选就不写**（`tierValue === ''`，预置的常态）；
 *   - 设置里与质量参数**同名**的项被忽略：那个参数归聊天栏那格管，
 *     两处都能写只会得到「我明明选了高，怎么还是低」；
 *   - 其他参数**只认能收敛成合法值的项**，收敛不了就当作没填（不抛错：
 *     设置可能是手工改坏的，而生成本身不该因此失败）。
 * @param axis - 生效的质量轴（手写声明或预置）。
 * @param tierValue - 生效的质量档取值（空串 = 不传）。
 * @param presetSpecs - 预置声明的其他参数。
 * @param configured - 设置里填的其他参数（键 → 值）。
 * @returns 要展开的值，以及这个家族允许模型传的键。
 */
function resolveParams(
	axis: TierAxis | undefined,
	tierValue: string,
	presetSpecs: readonly ParamSpec[],
	configured: Readonly<Record<string, string>>,
): { params: Record<string, string | number | boolean>; paramSpecs: ParamSpec[] } {
	const params: Record<string, string | number | boolean> = {};
	const specs: ParamSpec[] = [...presetSpecs];
	if (axis !== undefined && tierValue !== '') params[axis.param] = tierValue;

	for (const [key, raw] of Object.entries(configured)) {
		if (!isParamKey(key)) continue;
		if (axis !== undefined && key === axis.param) continue;
		const spec = specs.find((entry) => entry.key === key);
		const value = coerceParam(spec, raw);
		if (value === undefined) continue;
		params[key] = value;
		// 用户自己加的键补一条声明：模型调用那条路才知道这个键是允许的
		if (spec === undefined) specs.push({ key, label: key });
	}
	return { params, paramSpecs: specs };
}

/** 取一个字段的非空字符串值。 */
function str(config: MediaGenerationConfig, field: string): string {
	const value = config[field];
	return typeof value === 'string' ? value.trim() : '';
}

/** 取一个任意值的非空字符串。 */
function str2(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

/**
 * 该模型是否可用（密钥、基址、模型 id 三者齐备）。
 * @param model - 已解析的模型。
 * @returns 是否可发起生成。
 */
export function isUsable(model: ResolvedModel): boolean {
	return model.apiKey !== '' && model.baseURL !== '' && model.modelId !== '';
}

/**
 * 挑一个模型来生成。
 *
 * `requested` 接受三种写法（越具体越优先）：
 *   - `供应商::模型`（精确）
 *   - `供应商`         （该供应商下第一个可用模型）
 *   - `模型`           （任意供应商下的同名模型）
 * @param models - 已解析的模型清单。
 * @param kind - 需要的种类。
 * @param requested - 调用方指定的目标（可省略）。
 * @returns 选中的模型。
 * @throws 无可选项时抛出可操作的中文错误。
 */
export function pickModel(
	models: readonly ResolvedModel[],
	kind: MediaKind,
	requested?: string,
): ResolvedModel {
	const label = kind === 'image' ? '图像' : '视频';
	const candidates = models.filter((model) => model.kind === kind);
	if (candidates.length === 0) {
		throw new Error(
			`${label}模型还没有配置。请打开「设置 → 图像 / 视频模型」，` +
				`添加一个供应商与至少一个${label}模型，并填写 API 密钥。`,
		);
	}

	const wanted = typeof requested === 'string' ? requested.trim() : '';
	if (wanted !== '') {
		const exact = candidates.find((model) => model.ref === wanted);
		if (exact !== undefined) return usableOrThrow(exact, label, wanted);
		// 只给了供应商：取它下面第一个可用（没有可用则第一个）
		const byProvider = candidates.filter((model) => model.providerId === wanted);
		const providerPick = byProvider.find(isUsable) ?? byProvider[0];
		if (providerPick !== undefined) return usableOrThrow(providerPick, label, wanted);
		// 只给了模型名
		const modelPick = candidates.find((model) => model.modelId === wanted);
		if (modelPick !== undefined) return usableOrThrow(modelPick, label, wanted);

		throw new Error(
			`找不到${label}模型 "${wanted}"。可用：${candidates.map((model) => model.ref).join(', ')}`,
		);
	}

	// 默认优先，但默认没密钥时不能死在它上面 —— 回落到任一可用项
	const marked = candidates.find((model) => model.isDefault);
	if (marked !== undefined && isUsable(marked)) return marked;

	const usable = candidates.find(isUsable);
	if (usable !== undefined) return usable;

	throw new Error(
		`${label}供应商都还没有配置 API 密钥。` +
			`请打开「设置 → 图像 / 视频模型」，为其中一个模型填写密钥。`,
	);
}

/**
 * 挑一个可用的**视觉模型**（把参考图读成文字用的那双眼睛）。
 *
 * 与 `pickModel` 的区别只有一条：**没配就返回 undefined，不抛错**。
 * 这个功能是可选的 —— 用户没配视觉模型时，生成照常进行，只是提示词里没有图片描述。
 * @param models - 已解析的模型清单。
 * @returns 选中的视觉模型；一个都没配或都没密钥时 undefined。
 */
export function findVisionModel(models: readonly ResolvedModel[]): ResolvedModel | undefined {
	const candidates = models.filter((model) => model.kind === 'vision');
	const marked = candidates.find((model) => model.isDefault);
	if (marked !== undefined && isUsable(marked)) return marked;
	return candidates.find(isUsable);
}

/**
 * 校验挑中的模型可用，否则抛出「差什么」的具体错误。
 * @param model - 候选模型。
 * @param label - 种类的中文名。
 * @param wanted - 调用方给的原始写法（用于错误文案）。
 * @returns 原模型。
 */
function usableOrThrow(model: ResolvedModel, label: string, wanted: string): ResolvedModel {
	if (isUsable(model)) return model;
	const missing: string[] = [];
	if (model.baseURL === '') missing.push('接口基址');
	if (model.modelId === '') missing.push('模型名');
	if (model.apiKey === '') missing.push('API 密钥');
	throw new Error(
		`${label}模型 "${wanted}" 还缺：${missing.join(' / ')}。` +
			`请打开「设置 → 图像 / 视频模型」补全。`,
	);
}

// ─────────────────────────── 迁移（P8 → P9） ───────────────────────────

/** 一次迁移动作：要写进 providers 的条目与要清掉的旧字段。 */
export interface LegacyMigration {
	/** 需要写入的供应商（键为供应商 id；只在用户确实配过东西时出现）。 */
	providers: Record<string, ProviderProfile>;
	/** 需要写入凭据库的引用 → 值。 */
	credentials: Record<string, string>;
	/** 需要 unset 的旧顶层字段名。 */
	dropFields: string[];
	/** 旧默认值 → 新默认值（`供应商::模型`）。 */
	defaultImage?: string;
	defaultVideo?: string;
}

/**
 * 计算旧扁平字段 → 新结构的迁移。
 *
 * 只迁「用户真的配过东西」的那些条目：三个旧字段全空、且没有旧默认值指向它，
 * 就不必新建一条供应商记录（否则每个人的设置里都会凭空多出四条空供应商）。
 * @param config - 本 entry 配置的解析值（含旧字段）。
 * @returns 迁移动作；没有可迁的东西时 `providers` 为空。
 */
export function migrateLegacy(config: MediaGenerationConfig): LegacyMigration {
	const providers: Record<string, ProviderProfile> = {};
	const credentials: Record<string, string> = {};
	const dropFields: string[] = [];

	for (const legacy of LEGACY_PROVIDER_IDS) {
		const keyField = legacyKeyFieldOf(legacy.id);
		const modelField = legacyModelFieldOf(legacy.id);
		const baseField = legacyBaseURLFieldOf(legacy.id);
		const key = str(config, keyField);
		const model = str(config, modelField);
		const base = str(config, baseField);

		// 只清「真的存过值」的旧字段。
		//
		// 原判据是 `config[field] !== undefined`，理由是「旧字段不在 schema 里，
		// 残留值不会被脱敏」。那个理由已经失效：`legacyFields` 现在就并进 Config
		// （见本文件 `...legacyFields`），密钥那三个还带 `role('secret')`，脱敏由
		// schema 负责。而 `config` 是**解析后**的值（含 `.default('')`），
		// `!== undefined` 恒为真 —— 于是迁移每次启动都以为有东西要迁、每次都写一遍
		// profile，与「只做一次」的约定矛盾。
		if (key !== '') dropFields.push(keyField);
		if (model !== '') dropFields.push(modelField);
		if (base !== '') dropFields.push(baseField);

		if (key === '' && model === '' && base === '') continue;

		const provider = providers[legacy.providerId] ?? {
			label: '',
			baseURL: legacy.baseURL,
			apiKeyEnv: providerKeyRef(legacy.providerId),
			models: [],
		};
		if (base !== '') provider.baseURL = base;
		provider.models.push({
			id: model === '' ? legacy.modelId : model,
			kind: legacy.kind,
			apiKeyEnv: '',
			label: '',
		});
		providers[legacy.providerId] = provider;
		if (key !== '') credentials[providerKeyRef(legacy.providerId)] = key;
	}

	// 旧默认值（裸目录 id）→ 新默认值（`供应商::模型`）
	const legacyDefault = (value: string): string | undefined => {
		const found = LEGACY_PROVIDER_IDS.find((entry) => entry.id === value);
		return found === undefined ? undefined : modelRef(found.providerId, found.modelId);
	};
	const rawImage = str(config, FIELD_DEFAULT_IMAGE);
	const rawVideo = str(config, FIELD_DEFAULT_VIDEO);
	const defaultImage = legacyDefault(rawImage);
	const defaultVideo = legacyDefault(rawVideo);

	return {
		providers,
		credentials,
		dropFields,
		...(defaultImage === undefined ? {} : { defaultImage }),
		...(defaultVideo === undefined ? {} : { defaultVideo }),
	};
}

/**
 * 解析一个默认值字段，兼容「只写供应商 id」。
 * @param value - 字段值。
 * @returns 两段；空值返回 null。
 */
export function parseDefault(value: string): { providerId: string; modelId: string } | null {
	const trimmed = value.trim();
	if (trimmed === '') return null;
	return parseModelRef(trimmed);
}
