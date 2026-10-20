/**
 * 主界面（画布工具条）用的**生成模型清单与切换**。
 *
 * 设置页与画布工具条看的是**同一份设置**（本插件那个 Loader entry 的 `Config`，
 * 键 = `SETTINGS_ENTRY_ID`），
 * 但两者的入口不同：设置页拿的是注册时注入的表单，工具条那格拿不到注入面，
 * 只能读模块级持有变量 —— 与 `probeFace` / `hostApi` 同一个模式
 * （见 `index.tsx` 与 §3.23.8：派生服务不能在渲染期现解析）。
 *
 * 因此这个模块只做三件事：
 *   1. 保存 `apply` 期捕获的 scope（读）与宿主写入面（写）；
 *   2. 把设置分节的值解析成「图像 / 视频模型清单 + 当前默认 + 当前档位」（纯函数，可离线单测）；
 *   3. 暴露一个订阅（外部 store 模式，与 `state.ts` / `canvas/store.ts` 一致）。
 *
 * **档位**（P28）：分辨率档位是模型 id 本身（兄弟 id，见 `pickRows` 的家族折叠），
 * 质量档位是用户声明的请求参数（`setTier` 写 `defaultTiers`，宿主展开进请求体）。
 * 两条轴共用「家族 = 供应商::词干」这一个概念，规则都在 `shared/catalog.ts`。
 *
 * ⚠️ 读不到 scope 不是错误：插件可以在没有设置服务的组合里跑（只是这一格点不动），
 * 因此所有入口都返回 undefined 而不是抛。
 *
 * @module fatfish-canvas/client/settings/models
 */

import { useEffect, useState } from 'react';
import {
	EMPTY_COMMON,
	FIELD_COMMON_MODELS,
	FIELD_DEFAULT_IMAGE,
	FIELD_DEFAULT_TIERS,
	FIELD_DEFAULT_VIDEO,
	FIELD_DESKILL_ON,
	FIELD_PROVIDERS,
	SETTINGS_ENTRY_ID,
	currentTier,
	familyRefOf,
	modelRef,
	parseCommonModels,
	parseTierAxis,
	splitTier,
	tierAxesOf,
	tierLabel,
	type CommonModelConfig,
	type TierAxis,
} from '../shared/catalog';
import { presetAxisOf, presetOf, type ModelPreset } from '../shared/modelPresets';

/** 能从主界面挑的种类。视觉模型不在这里（它不是产物，且只在生成时被间接用到）。 */
export type PickKind = 'image' | 'video';

/** 一个可选的生成模型。 */
export interface ModelOption {
	/** 稳定标识：`供应商::模型` —— 与 `defaultImage` / `defaultVideo` 的取值同形。 */
	ref: string;
	/** 供应商 id（用户 slug）。 */
	providerId: string;
	/** 供应商展示名（空则用 id）。 */
	providerLabel: string;
	/** 模型在供应商那边的名字。 */
	modelId: string;
	/** 模型展示名（可空，空则用 id）。 */
	modelLabel: string;
	/** 词干：模型 id 去掉尾部档位词（家族的键的一半）。 */
	stem: string;
	/** id 尾部的**分辨率档位词**（`2k` / `''`）。分辨率轴不需要任何配置。 */
	tier: string;
	/** 家族键：`供应商::词干`。 */
	familyRef: string;
	/**
	 * 这个家族的**质量轴**（可选 = 没有参数式档位）。
	 *
	 * 手写的 `models[].tiers` 优先；没有声明时用**内置预置**（按词干匹配，
	 * 因此 `…-2k` / `…-4k` 尾缀的兄弟共用同一条）。
	 */
	axis?: TierAxis;
}

/** 主界面要用的一份模型目录。 */
export interface ModelCatalog {
	/** 图像模型（按供应商分组前的顺序 = 设置里的顺序）。 */
	image: readonly ModelOption[];
	/** 视频模型。 */
	video: readonly ModelOption[];
	/** 当前默认（`供应商::模型`；空 = 自动挑第一个可用的）。 */
	defaults: Record<PickKind, string>;
	/** 家族键 → 当前质量档（缺省 = 用声明里的默认取值）。 */
	tiers: Record<string, string>;
	/** 家族键 → 常用模型配置（勾选 / 质量开关 / 其他参数默认值）。 */
	common: Record<string, CommonModelConfig>;
	/**
	 * 设计技能是否开着（尾巴右键切换的那个；没有显式 false 就按开算）。
	 *
	 * 为什么由目录捎带而不是单独一个 hook：模型格要跟着它变尾巴的颜色，
	 * 订阅路径（设置快照变化 → emit）是现成的，单独再开一条是重复。
	 */
	designSkillOn: boolean;
}

/**
 * picker 里的一行。
 *
 * 有兄弟（同名干的多个分辨率档）或声明了质量轴的家族折叠成一行 `family`，
 * 点开才展开；其余仍是今天的平铺行 —— 这就是「没有档位的模型 UI 完全不变」。
 */
export type PickRow =
	| { kind: 'one'; key: string; option: ModelOption }
	| {
			kind: 'family';
			key: string;
			/** 家族展示名（= 词干）。 */
			label: string;
			/** 家族成员（按设置里的顺序）。 */
			options: readonly ModelOption[];
			/** 当前质量档（没有质量轴时为空串）。 */
			tier: string;
			axis?: TierAxis;
	  };

/** 一个供应商在设置里的形状（只声明这个模块读的字段）。 */
interface ProviderLike {
	label?: unknown;
	models?: unknown;
}

/** 一个模型条目在设置里的形状。 */
interface ModelLike {
	id?: unknown;
	kind?: unknown;
	label?: unknown;
	tiers?: unknown;
}

/**
 * 把一个模型条目的种类收敛成可挑的那两种（其余返回 null）。
 * @param value - 设置里的 kind 原始值。
 * @returns `image` / `video` / `vision`；非法值按 `image` 处理（与宿主解析一致）。
 */
function kindOf(value: unknown): PickKind | 'vision' {
	return value === 'video' ? 'video' : value === 'vision' ? 'vision' : 'image';
}

/**
 * 解析设置分节的值 → 模型目录。
 *
 * 纯函数：不碰 DOM、不碰服务，离线可测（`scripts/test-model.mjs` 第 3b 节）。
 * @param value - 本插件那个 entry 的解析值（形状不可信，逐字段校验）。
 * @returns 目录；没有任何供应商时两个清单都为空。
 */
export function mediaCatalog(value: unknown): ModelCatalog {
	const empty: ModelCatalog = {
		image: [],
		video: [],
		defaults: { image: '', video: '' },
		tiers: {},
		common: {},
		designSkillOn: true,
	};
	if (value === null || typeof value !== 'object') return empty;
	const config = value as Record<string, unknown>;

	const raw = config[FIELD_PROVIDERS];
	const providers = raw !== null && typeof raw === 'object' ? (raw as Record<string, ProviderLike>) : {};
	// 常用模型配置：与宿主 resolveModels 读的是同一个字段、同一套收敛规则
	const common = parseCommonModels(config[FIELD_COMMON_MODELS]);

	const image: ModelOption[] = [];
	const video: ModelOption[] = [];
	for (const [providerId, profile] of Object.entries(providers)) {
		if (profile === null || typeof profile !== 'object') continue;
		const providerLabel =
			typeof profile.label === 'string' && profile.label.trim() !== '' ? profile.label.trim() : providerId;
		const models = Array.isArray(profile.models) ? (profile.models as ModelLike[]) : [];
		// 质量轴是**家族级**的声明：同一词干里谁声明都算（与宿主 resolveModels 同一份规则）
		const axes = tierAxesOf(models);
		for (const model of models) {
			if (model === null || typeof model !== 'object') continue;
			const modelId = typeof model.id === 'string' ? model.id.trim() : '';
			if (modelId === '') continue;
			const kind = kindOf(model.kind);
			if (kind === 'vision') continue; // 视觉模型不是产物，不进这两个清单
			const { stem, tier } = splitTier(modelId);
			// 手写声明优先；没有声明时用内置预置（可按家族关掉）
			const preset = presetOf(kind, stem);
			const familyRef = familyRefOf(providerId, modelId);
			const axis =
				axes.get(stem) ??
				((common[familyRef] ?? EMPTY_COMMON).quality ? presetAxisOf(preset) : undefined);
			const option: ModelOption = {
				ref: modelRef(providerId, modelId),
				providerId,
				providerLabel,
				modelId,
				modelLabel: typeof model.label === 'string' && model.label.trim() !== '' ? model.label.trim() : modelId,
				stem,
				tier,
				familyRef,
				...(axis === undefined ? {} : { axis }),
			};
			(kind === 'video' ? video : image).push(option);
		}
	}

	const str = (field: string): string =>
		typeof config[field] === 'string' ? (config[field] as string).trim() : '';

	const tiers: Record<string, string> = {};
	const rawTiers = config[FIELD_DEFAULT_TIERS];
	if (rawTiers !== null && typeof rawTiers === 'object') {
		for (const [key, entry] of Object.entries(rawTiers as Record<string, unknown>)) {
			if (typeof entry === 'string' && entry.trim() !== '') tiers[key] = entry.trim();
		}
	}

	return {
		image,
		video,
		defaults: { image: str(FIELD_DEFAULT_IMAGE), video: str(FIELD_DEFAULT_VIDEO) },
		tiers,
		common,
		// 只有显式写了 false 才算关 —— 与宿主 schema 的缺省（true）同一语义
		designSkillOn: config[FIELD_DESKILL_ON] !== false,
	};
}

/**
 * 把模型清单折成 picker 的行（纯函数，可离线单测）。
 *
 * 折叠规则只有一条：**同名干 ≥2 个成员，或这个家族声明了质量轴**。两者都不满足
 * 就是今天的平铺行 —— 因此老配置（没有兄弟、没有声明）看到的 UI 与升级前一致。
 * @param options - 某个种类的模型清单（已按设置顺序）。
 * @param tiers - 家族键 → 当前质量档。
 * @returns 行（顺序 = 首次出现顺序）。
 */
export function pickRows(
	options: readonly ModelOption[],
	tiers: Readonly<Record<string, string>> = {},
): PickRow[] {
	const order: string[] = [];
	const groups = new Map<string, ModelOption[]>();
	for (const option of options) {
		const bucket = groups.get(option.familyRef);
		if (bucket === undefined) {
			groups.set(option.familyRef, [option]);
			order.push(option.familyRef);
		} else {
			bucket.push(option);
		}
	}

	const rows: PickRow[] = [];
	for (const key of order) {
		const members = groups.get(key) ?? [];
		if (members.length === 0) continue;
		// 家族里任何成员声明的轴都算这个家族的（与宿主的解析保持一致）
		const axis = members.find((member) => member.axis !== undefined)?.axis;
		if (members.length > 1 || axis !== undefined) {
			rows.push({
				kind: 'family',
				key,
				label: members[0]?.stem ?? key,
				options: members,
				tier: currentTier(tiers[key], axis),
				...(axis === undefined ? {} : { axis }),
			});
			continue;
		}
		const one = members[0];
		if (one !== undefined) rows.push({ kind: 'one', key, option: one });
	}
	return rows;
}

/**
 * 在家族里挑一个「点档位时要顺带选中的」成员（纯函数）。
 *
 * 规则：已经是当前默认的那个 → 不带分辨率尾缀的那个（基名）→ 第一个。
 *
 * 为什么需要它：家族行本身是**展开开关**（点它是展开，不是选用），而只有一个成员的
 * 家族展开后没有成员行 —— 于是「用这个模型」这个动作就只剩质量 chip 一条路。
 * 点档位时必须真的用上这个模型，否则那一行看着能点、却永远选不中
 * （用户报的「展开挡住了选择使用此模型的按键」）。
 * @param row - 家族行。
 * @param current - 这个种类当前的默认模型取值。
 * @returns 要选中的成员；家族为空时 undefined。
 */
export function familyTarget(
	row: Extract<PickRow, { kind: 'family' }>,
	current: string,
): ModelOption | undefined {
	const selected = row.options.find((option) => option.ref === current);
	if (selected !== undefined) return selected;
	return row.options.find((option) => option.tier === '') ?? row.options[0];
}

/**
 * 把 picker 的行分成「常用」与「其他」（纯函数）。
 *
 * 勾过常用的家族排到前面；一个都没勾时两块的分法与升级前**观感一致**
 * （那时 `pinned` 为空，组件把 `others` 原样铺开）。
 * @param rows - `pickRows` 的结果。
 * @param common - 家族键 → 常用配置。
 * @returns 两段行（各自保持原顺序）。
 */
export function pickerPartition(
	rows: readonly PickRow[],
	common: Readonly<Record<string, CommonModelConfig>> = {},
): { pinned: PickRow[]; others: PickRow[] } {
	const pinned: PickRow[] = [];
	const others: PickRow[] = [];
	for (const row of rows) {
		// 两种行都有家族键（`PickRow.key` 就是 `供应商::词干`），平铺行也能勾常用
		if (common[row.key]?.pinned === true) pinned.push(row);
		else others.push(row);
	}
	return { pinned, others };
}

/**
 * 当前选中模型落在哪个家族、档位显示成什么（给触发器那一格用）。
 * @param rows - `pickRows` 的结果。
 * @param ref - 当前默认模型取值。
 * @returns 档位展示名；没有质量轴时为空串。
 */
export function tierTextOf(rows: readonly PickRow[], ref: string): string {
	for (const row of rows) {
		if (row.kind !== 'family' || row.axis === undefined) continue;
		if (row.options.some((option) => option.ref === ref)) return tierLabel(row.tier, row.axis);
	}
	return '';
}

/**
 * 把设置页草稿解析成质量轴声明（`low=低, high=高`，`，` 也认）。
 *
 * 与读取路径**共用同一个校验**（`parseTierAxis`）：草稿里写坏了，点保存时就报错，
 * 而不是写进去之后静默失效。
 * @param param - 参数名（如 `quality`）。
 * @param valuesText - 取值原文。
 * @returns 轴或一句可展示的错误。
 */
export function parseTierDraft(param: string, valuesText: string): { axis?: TierAxis; error: string } {
	const values: string[] = [];
	const labels: Record<string, string> = {};
	for (const part of valuesText.split(/[,，]/)) {
		const text = part.trim();
		if (text === '') continue;
		const eq = text.indexOf('=');
		const value = (eq < 0 ? text : text.slice(0, eq)).trim();
		const label = eq < 0 ? '' : text.slice(eq + 1).trim();
		if (value === '') continue;
		if (!values.includes(value)) values.push(value);
		if (label !== '') labels[value] = label;
	}
	if (values.length === 0) return { error: '至少写一个取值（例如 low, high）' };
	const axis = parseTierAxis({ param, values, labels });
	if (axis === undefined) {
		return {
			error: `参数名 "${param.trim()}" 不能这么写：要小写字母开头、只含小写字母数字与下划线，且不能叫 model / prompt / n / image`,
		};
	}
	return { axis, error: '' };
}

/**
 * 把已存的质量轴还原成草稿原文（打开「档位参数…」时预填）。
 * @param axis - 已解析的轴。
 * @returns 形如 `low=低, high=高` 的原文。
 */
export function tierDraftOf(axis: TierAxis | undefined): string {
	if (axis === undefined) return '';
	return axis.values.map((value) => (axis.labels[value] === undefined ? value : `${value}=${axis.labels[value]}`)).join(', ');
}

// ─────────────────────────── 服务持有 ───────────────────────────

/** 设置的客户端表单（`apply` 期从 `ctx.configForms.get(<entry id>)` 取，见 index.tsx）。 */
type MediaScope = DshClientConfigForm<Record<string, unknown>>;

let scope: MediaScope | undefined;
let api: DshHostApi | undefined;
/** scope 变化的订阅（换 scope 时先撤旧的，避免越挂越多）。 */
let detach: (() => void) | null = null;
const listeners = new Set<() => void>();

function emit(): void {
	for (const fn of listeners) fn();
}

/**
 * 接入设置表单（读）。
 * @param next - 本 entry 的设置表单；服务缺席时传 undefined。
 */
export function setMediaScope(next: MediaScope | undefined): void {
	if (detach !== null) {
		detach();
		detach = null;
	}
	scope = next;
	if (next !== undefined && typeof next.subscribe === 'function') {
		detach = next.subscribe(emit);
	}
	emit();
}

/**
 * 接入宿主写入面（写默认模型）。
 * @param next - `remote.settings` / `remote.credentials`；缺席时传 undefined。
 */
export function setMediaApi(next: DshHostApi | undefined): void {
	api = next;
	emit();
}

/**
 * 取当前模型目录。
 *
 * 每次调用都重新解析（设置很小，一次遍历供应商字典而已）；重渲染只由
 * `subscribeModels` 触发，因此不需要为了引用稳定去缓存。
 * @returns 目录；设置 scope 还没就绪时为 undefined。
 */
export function getModelCatalog(): ModelCatalog | undefined {
	if (scope === undefined) return undefined;
	return mediaCatalog(scope.getSnapshot().value);
}

/**
 * 订阅设置变化。
 * @param fn - 回调。
 * @returns 取消订阅。
 */
export function subscribeModels(fn: () => void): () => void {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
}

/**
 * 写一批路径 op（**与设置页同一套**：带 revision，冲突时退回不带栅栏重试一次）。
 *
 * 走宿主写入面 `remote.settings.mutate` 而不是表单自己的 `mutate`：这一条能带
 * revision 栅栏、并把拒绝变成可读错误（表单那套 `set` / `unset` / `mutate` 在
 * 被拒时只返回 `false`，设置页要显示原因，见 `MediaSettings` 的写入处理）。
 * 键是 **Loader entry id**（= 设置分节），不再是旧的自定义 namespace。
 * @param settings - 宿主写入面。
 * @param target - 本 entry 的设置表单（只用来读 revision）。
 * @param ops - 路径 op。
 */
export async function mutateSettings<T>(
	settings: DshHostApi | undefined,
	target: DshClientConfigForm<T> | undefined,
	ops: readonly DshSettingsPathOp[],
): Promise<void> {
	if (settings === undefined || target === undefined) {
		throw new Error('宿主写入面（remote.settings）还没就绪：刷新页面再试');
	}
	const first = await settings.settings.mutate(SETTINGS_ENTRY_ID, ops, target.getSnapshot().revision);
	if (first.ok) return;
	// 镜像的 revision 有更新延迟：刚写完再写会撞上自己上一次留下的旧栅栏，
	// 因此冲突时**不带栅栏重试一次**（设置页同款处理）。
	if (first.error.code === 'settings/conflict') {
		const retry = await settings.settings.mutate(SETTINGS_ENTRY_ID, ops);
		if (retry.ok) return;
		throw new Error(retry.error.message);
	}
	throw new Error(first.error.message);
}

/**
 * 切换某个种类的默认模型（`''` = 恢复「自动」）。
 * @param kind - 图像 / 视频。
 * @param ref - `供应商::模型`，或空串。
 */
export async function setDefaultModel(kind: PickKind, ref: string): Promise<void> {
	const field = kind === 'image' ? FIELD_DEFAULT_IMAGE : FIELD_DEFAULT_VIDEO;
	await mutateSettings(
		api,
		scope,
		ref === '' ? [{ op: 'unset', path: [field] }] : [{ op: 'set', path: [field], value: ref }],
	);
}

/**
 * 切换某个**家族**的质量档（写 `defaultTiers[家族键]`）。
 *
 * 分辨率档位不走这里：`…-2k` → `…-4k` 就是换一个模型 id，那是 `setDefaultModel`。
 * 两条轴分开存正是为了让它们互不打扰 —— 换分辨率不会把质量档弄丢。
 *
 * `ref` 给了就**顺带把默认模型也换成它**（两个 op 一次写）：点档位等于选用这个模型，
 * 而分两次写会在中间失败时留下「档位换了、模型没换」的半截状态。
 * @param kind - 图像 / 视频（决定写哪个默认字段）。
 * @param familyRef - 家族键（`供应商::词干`）。
 * @param value - 档位取值（空串 = 清掉，回到声明里的默认）。
 * @param ref - 顺带要选用的模型（`供应商::模型`）；省略 = 只写档位。
 */
export async function setTier(kind: PickKind, familyRef: string, value: string, ref?: string): Promise<void> {
	const field = kind === 'image' ? FIELD_DEFAULT_IMAGE : FIELD_DEFAULT_VIDEO;
	const ops: DshSettingsPathOp[] = [];
	if (ref !== undefined) ops.push({ op: 'set', path: [field], value: ref });
	ops.push(
		value === ''
			? { op: 'unset', path: [FIELD_DEFAULT_TIERS, familyRef] }
			: { op: 'set', path: [FIELD_DEFAULT_TIERS, familyRef], value },
	);
	await mutateSettings(api, scope, ops);
}

/**
 * 开关设计技能（聊天框那格鲸鱼尾巴**右键**走的就是它）。
 *
 * 写**显式布尔**而不是 unset：开关的关闭态必须两边同时看得见 —— 宿主读的
 * schema 解析值会把 unset 还原成缺省（开），只有写进 false 才是「关」。
 * 打开也照写 true：让设置文档自己说明当前状态，避免「缺席到底是开还是没配」
 * 这种只有读代码才能回答的问题。
 * @param on - 是否启用设计技能。
 */
export async function setDesignSkill(on: boolean): Promise<void> {
	await mutateSettings(api, scope, [{ op: 'set', path: [FIELD_DESKILL_ON], value: on }]);
}

/**
 * 把设置里的**家族**（`供应商::词干`）列出来 —— 设置页「常用模型」那一块读的就是它。
 *
 * 为什么按家族而不是按模型：一个家族的成员共用一份配置，因此
 * `gpt-image-2` / `gpt-image-2-2k` / `gpt-image-2-4k` 是**一行**，
 * 将来多出来的 `-8k` 兄弟也自动落进这一行，不需要再配一次。
 */
export interface FamilyRow {
	/** 家族键（`供应商::词干`）。 */
	familyRef: string;
	/** 供应商 id。 */
	providerId: string;
	/** 供应商展示名。 */
	providerLabel: string;
	/** 词干（家族名）。 */
	stem: string;
	/** 种类（家族里不会混种类）。 */
	kind: PickKind;
	/** 成员模型 id（含分辨率兄弟），按设置里的顺序。 */
	members: readonly string[];
	/** 命中的内置预置（没有则 undefined = 这个类型没有预置）。 */
	preset?: ModelPreset;
	/** 生效的质量轴（手写声明优先，其次预置）。 */
	axis?: TierAxis;
	/** 质量轴是**手写声明**的（清除声明就回到预置）。 */
	declared: boolean;
	/** 这个家族的常用配置。 */
	common: CommonModelConfig;
}

/**
 * 把设置值解析成家族清单（纯函数，形状不可信）。
 * @param value - 本插件那个 entry 的解析值。
 * @returns 家族行（顺序 = 供应商顺序 × 首次出现顺序）。
 */
export function familyRows(value: unknown): FamilyRow[] {
	if (value === null || typeof value !== 'object') return [];
	const config = value as Record<string, unknown>;
	const raw = config[FIELD_PROVIDERS];
	const providers = raw !== null && typeof raw === 'object' ? (raw as Record<string, ProviderLike>) : {};
	const common = parseCommonModels(config[FIELD_COMMON_MODELS]);

	const out: FamilyRow[] = [];
	const seen = new Map<string, FamilyRow & { members: string[] }>();
	for (const [providerId, profile] of Object.entries(providers)) {
		if (profile === null || typeof profile !== 'object') continue;
		const providerLabel =
			typeof profile.label === 'string' && profile.label.trim() !== '' ? profile.label.trim() : providerId;
		const models = Array.isArray(profile.models) ? (profile.models as ModelLike[]) : [];
		const axes = tierAxesOf(models);
		for (const model of models) {
			if (model === null || typeof model !== 'object') continue;
			const modelId = typeof model.id === 'string' ? model.id.trim() : '';
			if (modelId === '') continue;
			const kind = kindOf(model.kind);
			if (kind === 'vision') continue; // 视觉模型不是产物，没有档位也没有常用之说
			const { stem } = splitTier(modelId);
			const preset = presetOf(kind, stem);
			const familyRef = familyRefOf(providerId, modelId);
			const hit = seen.get(familyRef);
			if (hit !== undefined) {
				hit.members.push(modelId);
				continue;
			}
			const config0 = common[familyRef] ?? EMPTY_COMMON;
			const declared = axes.get(stem);
			const row: FamilyRow & { members: string[] } = {
				familyRef,
				providerId,
				providerLabel,
				// 家族名 = 词干（同一支模型的另一种 id 写法**不会**并进来，见 modelPresets）
				stem,
				kind,
				members: [modelId],
				declared: declared !== undefined,
				axis: declared ?? (config0.quality ? presetAxisOf(preset) : undefined),
				common: config0,
				...(preset === undefined ? {} : { preset }),
			};
			seen.set(familyRef, row);
			out.push(row);
		}
	}
	return out;
}

/**
 * 写一个家族的「常用模型」配置（勾选 / 质量开关 / 其他参数默认值）。
 *
 * 与 `setTier` 同一套写入口（`mutateSettings`：带 revision，冲突重试一次）。
 * @param familyRef - 家族键。
 * @param path - 家族内的路径（`['pinned']`、`['quality']`、`['params', 'size']`）。
 * @param value - 值；`undefined` = 清掉这一项（回到 schema 的缺省）。
 */
export async function setCommonField(
	familyRef: string,
	path: readonly string[],
	value: string | boolean | undefined,
): Promise<void> {
	const full = [FIELD_COMMON_MODELS, familyRef, ...path];
	await mutateSettings(
		api,
		scope,
		value === undefined ? [{ op: 'unset', path: full }] : [{ op: 'set', path: full, value }],
	);
}

/**
 * 主界面订阅模型目录。
 * @returns 目录；设置服务缺席时为 undefined。
 */
export function useModelCatalog(): ModelCatalog | undefined {
	const [value, setValue] = useState<ModelCatalog | undefined>(getModelCatalog);
	useEffect(() => {
		// 与 state.ts 的 useStoreValue 同款：首帧直接读快照，effect 里再对齐一次 +
		// 订阅（刻意不用 useSyncExternalStore，理由见 §3.29）。
		setValue(getModelCatalog());
		return subscribeModels(() => {
			setValue(getModelCatalog());
		});
	}, []);
	return value;
}
