/**
 * 肥鱼画布 · 媒体生成的设置 schema（宿主半边）。
 *
 * ## 形状：`providers` 字典 + 凭据引用（P9）
 *
 * ```
 * media-generation:
 *   providers:
 *     acme:
 *       label: Acme 网关
 *       baseURL: https://gateway.acme.example/v1
 *       apiKeyEnv: FFC_ACME_API_KEY          ← 引用，不是密钥
 *       models:
 *         - id: acme-large
 *           kind: image
 *           apiKeyEnv: FFC_ACME_ACME_LARGE_API_KEY   ← 可选的按模型覆盖
 *         - id: acme-video
 *           kind: video
 *   defaultImage: acme::acme-large
 *   defaultVideo: acme::acme-video
 * ```
 *
 * 两件事必须一起成立，缺一件就会踩坑：
 *
 * 1. **密钥只以引用形式进设置**（`ctx.credentials` 存值）。设置里因此**没有**
 *    `role('secret')` 字段 → 脱敏视图与真实视图完全一致 → 「读回来再整体写回」
 *    不会抹掉任何机密。旧设计（P2–P8）之所以必须把字段摊平，就是因为脱敏视图
 *    里读不到密钥；把密钥移出设置之后，这个约束自然消失，于是「一个供应商挂
 *    多个模型 + 每个模型单独配密钥」这种嵌套结构才有地方放。
 *
 * 2. **写路径用深路径 op**。客户端 `SettingsScope.set(field)` 只会拼出
 *    `path:[field]`（单段），所以它**只能**写顶层标量；嵌套叶子要经
 *    `settings.mutate` 的 `path:['providers', id, 'baseURL']` 写（DSH 自己的
 *    「模型」设置页就是这么做的）。数组（`models`）是**整体替换**语义：
 *    改一个模型就重写整个数组。
 *
 * ## 旧字段仍然声明着，但只为了迁移
 *
 * `key_<id>` / `model_<id>` / `baseURL_<id>`（P8 及以前的六条目录项）继续留在
 * schema 里：不在 schema 里的字段**不会**被脱敏，留在文档里的旧密钥会被原样
 * 下发给浏览器。宿主启动时统一迁移进新结构并 unset 掉（见 `migrateLegacy`）。
 *
 * @module fatfish-canvas/host/schema
 */

import Schema from '@deepseek-ai/schemastery';
import {
	apiOf,
	FIELD_DEFAULT_IMAGE,
	FIELD_DEFAULT_VIDEO,
	FIELD_DEFAULT_VISION,
	FIELD_PROVIDERS,
	LEGACY_PROVIDER_IDS,
	MEDIA_NS,
	legacyBaseURLFieldOf,
	legacyKeyFieldOf,
	legacyModelFieldOf,
	modelRef,
	parseModelRef,
	providerKeyRef,
	type MediaApi,
	type MediaKind,
	type ModelKind,
} from '../client/shared/catalog';

// 共享模块里的常量与工具原样再导出 —— 宿主与设置页引用同一份，不可能漂移。
export {
	FIELD_DEFAULT_IMAGE,
	FIELD_DEFAULT_VIDEO,
	FIELD_DEFAULT_VISION,
	FIELD_PROVIDERS,
	MEDIA_NS,
	type MediaApi,
	type MediaKind,
	type ModelKind,
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
}

/** namespace 的完整解析值。 */
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
	/** 单次生成的整体超时（毫秒）；视频轮询用它。 */
	timeoutMs: number;
	/** 生成结果落到画布时的边长上限（world px）。 */
	maxNodeSize: number;
	/** 旧字段（迁移用），键为字段名。 */
	[index: string]: unknown;
}

/** 一个模型条目。 */
const ModelEntrySchema = Schema.object({
	id: Schema.string().required(),
	kind: Schema.union(['image', 'video', 'vision']).default('image'),
	// 凭据**引用名**不是机密，因此照实下发（role('credential-ref') 只是语义标注）
	apiKeyEnv: Schema.string().default(''),
	label: Schema.string().default(''),
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
	// 真遇到字段名不同的网关时，先在 settings.yaml 里写（设置文件是热发布的），
	// 等第二个网关也需要时再把两个输入框加进设置页。
	referenceMode: Schema.string().default('field'),
	referenceField: Schema.string().default(''),
});

/**
 * 由旧目录字段拼出「仍然要保留的兼容字段」。
 *
 * 这些字段只承载迁移前的值，设置页不显示它们。
 */
const legacyFields = Object.fromEntries(
	LEGACY_PROVIDER_IDS.flatMap((legacy) => [
		[legacyKeyFieldOf(legacy.id), Schema.string().role('secret')],
		[legacyModelFieldOf(legacy.id), Schema.string().default('')],
		[legacyBaseURLFieldOf(legacy.id), Schema.string().default('')],
	]),
);

/** namespace schema。 */
export const MediaGenerationSchema = Schema.object({
	[FIELD_PROVIDERS]: Schema.dict(ProviderSchema).default({}),
	[FIELD_DEFAULT_IMAGE]: Schema.string().default(''),
	[FIELD_DEFAULT_VIDEO]: Schema.string().default(''),
	[FIELD_DEFAULT_VISION]: Schema.string().default(''),
	timeoutMs: Schema.number().default(600000),
	maxNodeSize: Schema.number().default(512),
	...legacyFields,
});

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
	/** 该条目的稳定标识：`<供应商>::<模型>`。 */
	ref: string;
}

/**
 * 把配置解析成「可用的模型清单」。
 *
 * `resolveKey` 由调用方注入（宿主是 `ctx.credentials`，测试是内存表），
 * 因此本模块保持纯函数、可离线单测。
 * @param config - namespace 解析值。
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

	const out: ResolvedModel[] = [];
	for (const [providerId, raw] of Object.entries(providers)) {
		if (raw === null || typeof raw !== 'object') continue;
		const profile = raw as ProviderProfile;
		const providerLabel = str2(profile.label) === '' ? providerId : str2(profile.label);
		const baseURL = str2(profile.baseURL);
		const providerKeyRef = str2(profile.apiKeyEnv);
		const models = Array.isArray(profile.models) ? profile.models : [];
		// 参考图的两个旋钮挂在供应商上（同一家的端点与字段名是一样的）
		const referenceMode = str2(profile.referenceMode) === 'edits' ? 'edits' : 'field';
		const referenceField = str2(profile.referenceField);

		for (const model of models) {
			if (model === null || typeof model !== 'object') continue;
			const modelId = str2(model.id);
			if (modelId === '') continue;
			const kind: ModelKind =
				model.kind === 'video' ? 'video' : model.kind === 'vision' ? 'vision' : 'image';
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
				ref: modelRef(providerId, modelId),
			});
		}
	}
	return out;
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
 * @param config - namespace 解析值（含旧字段）。
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

		// 只要旧字段还留在文档里就清掉它（哪怕是空串）：不在 schema 里的残留字段
		// 不会被脱敏，留着就是一条会下发到浏览器的明文密钥。
		if (config[keyField] !== undefined) dropFields.push(keyField);
		if (config[modelField] !== undefined) dropFields.push(modelField);
		if (config[baseField] !== undefined) dropFields.push(baseField);

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
