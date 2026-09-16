/**
 * 主界面（画布工具条）用的**生成模型清单与切换**。
 *
 * 设置页与画布工具条看的是**同一份设置**（`media-generation` namespace），
 * 但两者的入口不同：设置页拿的是注册时注入的 scope，工具条那格拿不到注入面，
 * 只能读模块级持有变量 —— 与 `probeFace` / `hostApi` 同一个模式
 * （见 `index.tsx` 与 §3.23.8：派生服务不能在渲染期现解析）。
 *
 * 因此这个模块只做三件事：
 *   1. 保存 `apply` 期捕获的 scope（读）与宿主写入面（写）；
 *   2. 把 namespace 的值解析成「图像 / 视频模型清单 + 当前默认」（纯函数，可离线单测）；
 *   3. 暴露一个订阅（外部 store 模式，与 `state.ts` / `canvas/store.ts` 一致）。
 *
 * ⚠️ 读不到 scope 不是错误：插件可以在没有设置服务的组合里跑（只是这一格点不动），
 * 因此所有入口都返回 undefined 而不是抛。
 *
 * @module fatfish-canvas/client/settings/models
 */

import { useEffect, useState } from 'react';
import {
	FIELD_DEFAULT_IMAGE,
	FIELD_DEFAULT_VIDEO,
	FIELD_PROVIDERS,
	MEDIA_NS,
	modelRef,
} from '../shared/catalog';

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
}

/** 主界面要用的一份模型目录。 */
export interface ModelCatalog {
	/** 图像模型（按供应商分组前的顺序 = 设置里的顺序）。 */
	image: readonly ModelOption[];
	/** 视频模型。 */
	video: readonly ModelOption[];
	/** 当前默认（`供应商::模型`；空 = 自动挑第一个可用的）。 */
	defaults: Record<PickKind, string>;
}

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
 * 解析 namespace 的值 → 模型目录。
 *
 * 纯函数：不碰 DOM、不碰服务，离线可测（`scripts/test-model.mjs` 第 3b 节）。
 * @param value - `media-generation` 的解析值（形状不可信，逐字段校验）。
 * @returns 目录；没有任何供应商时两个清单都为空。
 */
export function mediaCatalog(value: unknown): ModelCatalog {
	const empty: ModelCatalog = { image: [], video: [], defaults: { image: '', video: '' } };
	if (value === null || typeof value !== 'object') return empty;
	const config = value as Record<string, unknown>;

	const raw = config[FIELD_PROVIDERS];
	const providers = raw !== null && typeof raw === 'object' ? (raw as Record<string, ProviderLike>) : {};

	const image: ModelOption[] = [];
	const video: ModelOption[] = [];
	for (const [providerId, profile] of Object.entries(providers)) {
		if (profile === null || typeof profile !== 'object') continue;
		const providerLabel =
			typeof profile.label === 'string' && profile.label.trim() !== '' ? profile.label.trim() : providerId;
		const models = Array.isArray(profile.models) ? (profile.models as ModelLike[]) : [];
		for (const model of models) {
			if (model === null || typeof model !== 'object') continue;
			const modelId = typeof model.id === 'string' ? model.id.trim() : '';
			if (modelId === '') continue;
			const kind = kindOf(model.kind);
			if (kind === 'vision') continue; // 视觉模型不是产物，不进这两个清单
			const option: ModelOption = {
				ref: modelRef(providerId, modelId),
				providerId,
				providerLabel,
				modelId,
				modelLabel: typeof model.label === 'string' && model.label.trim() !== '' ? model.label.trim() : modelId,
			};
			(kind === 'video' ? video : image).push(option);
		}
	}

	const str = (field: string): string =>
		typeof config[field] === 'string' ? (config[field] as string).trim() : '';

	return { image, video, defaults: { image: str(FIELD_DEFAULT_IMAGE), video: str(FIELD_DEFAULT_VIDEO) } };
}

// ─────────────────────────── 服务持有 ───────────────────────────

/** 设置的客户端 scope（`apply` 期捕获，见 index.tsx）。 */
type MediaScope = DshClientSettingsScope<Record<string, unknown>>;

let scope: MediaScope | undefined;
let api: DshHostApi | undefined;
/** scope 变化的订阅（换 scope 时先撤旧的，避免越挂越多）。 */
let detach: (() => void) | null = null;
const listeners = new Set<() => void>();

function emit(): void {
	for (const fn of listeners) fn();
}

/**
 * 接入设置 scope（读）。
 * @param next - 绑定好 `media-generation` 的 scope；服务缺席时传 undefined。
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
 * @param settings - 宿主写入面。
 * @param target - 设置 scope。
 * @param ops - 路径 op。
 */
export async function mutateSettings<T>(
	settings: DshHostApi | undefined,
	target: DshClientSettingsScope<T> | undefined,
	ops: readonly DshSettingsPathOp[],
): Promise<void> {
	if (settings === undefined || target === undefined) {
		throw new Error('宿主写入面（remote.settings）还没就绪：刷新页面再试');
	}
	const first = await settings.settings.mutate(MEDIA_NS, ops, target.getSnapshot().revision);
	if (first.ok) return;
	// 镜像的 revision 有更新延迟：刚写完再写会撞上自己上一次留下的旧栅栏，
	// 因此冲突时**不带栅栏重试一次**（设置页同款处理）。
	if (first.error.code === 'settings/conflict') {
		const retry = await settings.settings.mutate(MEDIA_NS, ops);
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
