/**
 * 「图像 / 视频模型」设置页（P9 重做）。
 *
 * ## 这一页能做什么
 *
 *   - **添加第三方供应商**：预设一键填好（OpenAI / 火山 / 硅基 / 智谱），
 *     也可以「自定义供应商」只填一个 baseURL —— 只要是 OpenAI 兼容端点就行。
 *   - **一个供应商挂多个模型**，每个模型带**图像 / 视频**标识（决定走哪个适配器）。
 *   - **测试连接**：宿主拿着密钥去 `GET {base}/models`，通了就说明地址与密钥都对。
 *   - **获取模型列表**：同一次请求的结果，点一下就加进这个供应商。
 *   - **每个模型单独配密钥**（右键模型行，或点行尾的 ⋯）：填了就覆盖供应商级，
 *     也可以清除回到「继承」。
 *
 * ## 写入形状：深路径 op，而不是「一个顶层字段一次 set」
 *
 * 旧版（P2–P8）只能写顶层标量，因为那时密钥字段是 `role('secret')`、
 * 浏览器读不到值，整体回写会把密钥抹掉。P9 把密钥搬进凭据库（设置里只留
 * 引用名 `apiKeyEnv`），脱敏视图与真实视图一致，于是可以放心写嵌套结构：
 *
 *   settings.mutate({ ns, ops: [{ op:'set', path:['providers', id, 'baseURL'], value }] })
 *
 * 随之而来的三条实现约束（都在下面照着做了）：
 *
 *   1. **数组整体替换**：改一个模型就重写整个 `models` 数组 —— 路径无法寻址
 *      数组下标（网关的 `applyPathOp` 只认纯对象中间层）。
 *   2. **文本字段不能逐键写**：每敲一个字写一次设置 = 每个字符一次磁盘写入，
 *      还会不断撞 revision。因此输入框走**本地草稿 + 失焦/回车提交**。
 *   3. **写入带 revision**，撞上冲突退回不带栅栏重试一次：镜像的 revision
 *      有延迟，用户快速连点会撞上自己上一次写入留下的旧栅栏。
 *
 * @module fatfish-canvas/client/settings/MediaSettings
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import {
	FIELD_DEFAULT_IMAGE,
	FIELD_DEFAULT_VIDEO,
	FIELD_DEFAULT_VISION,
	FIELD_PROVIDERS,
	PROVIDER_PRESETS,
	isValidProviderId,
	modelKeyRef,
	modelRef,
	providerKeyRef,
	type MediaKind,
	type ModelKind,
	type ProviderPreset,
} from '../shared/catalog';
import { unwrapProbeResult, type ProbeEnvelope } from '../shared/probe';
import { mutateSettings } from './models';
import { clampToViewport, useMenuDismiss, useMenuFocus, useMenuNav } from '../menu';

/** 一个模型的配置（与宿主 schema 同形）。 */
interface ModelProfile {
	id: string;
	kind: ModelKind;
	apiKeyEnv?: string;
	label?: string;
}

/** 一个供应商的配置（与宿主 schema 同形）。 */
interface ProviderProfile {
	label?: string;
	baseURL: string;
	apiKeyEnv?: string;
	models: ModelProfile[];
}

/** namespace 的解析值。 */
interface MediaValue {
	providers?: Record<string, ProviderProfile>;
	defaultImage?: string;
	defaultVideo?: string;
	/** 默认视觉模型（把参考图读成文字用的那个）。 */
	defaultVision?: string;
	[index: string]: unknown;
}

/** 一次探测的结果（与共享契约同形）。 */
interface ProbeResult {
	ok: boolean;
	message: string;
	models?: string[];
	kinds?: ModelKind[];
	latencyMs?: number;
	status?: number;
}

/** 宿主探测服务（远程命名空间的客户端面）。 */
export interface MediaSettingsProbe {
	/**
	 * 测试连接。
	 * @param providerId - 供应商 id。
	 * @returns 结果信封。
	 */
	testConnection(providerId: string): Promise<ProbeEnvelope<ProbeResult>>;
	/**
	 * 获取模型列表。
	 * @param providerId - 供应商 id。
	 * @returns 结果信封。
	 */
	listModels(providerId: string): Promise<ProbeEnvelope<ProbeResult>>;
}

/** 组件属性（由 apply 的 inject 面注入）。 */
export interface MediaSettingsProps {
	/** 已绑定的 namespace scope（读解析值 / 订阅变化）。 */
	scope: DshClientSettingsScope<MediaValue>;
	/**
	 * 宿主写入面（`remote.settings` / `remote.credentials`）。
	 *
	 * 可能缺席（裁剪过的组合、或派生服务还没就绪）：缺席时页面**只读并说明原因**，
	 * 而不是让每次保存都炸在 `undefined.settings` 上。
	 */
	api?: DshHostApi;
	/**
	 * 取宿主探测服务（可能还没就绪）。
	 *
	 * 传**函数**而不是值：`remote.mediaProbe` 是远程贡献挂载之后才出现的派生服务，
	 * 页面可能先渲染一次、它之后才就绪；而在渲染期去解析那个服务会直接抛
	 * （cordis 对派生服务要求当前 context 声明过依赖）。因此组件自己在 effect 里
	 * 取，取不到就先置灰并短暂重试。
	 * @returns 探测服务；尚未就绪时为 undefined。
	 */
	getProbe?: () => MediaSettingsProbe | undefined;
}

/** 一条路径 op。 */
type PathOp = { op: 'set' | 'unset'; path: string[]; value?: unknown };

/** 模型行的内联编辑器状态。 */
interface RowEditor {
	/** 是新增还是重命名。 */
	mode: 'add' | 'rename';
	/** 原名（重命名时用）。 */
	original: string;
	/** 正在输入的 id。 */
	id: string;
	/** 正在选的种类。 */
	kind: ModelKind;
}

/** 一张卡片的临时状态（UI 态，不进设置）。 */
interface CardState {
	/** 正在跑的异步动作。 */
	busy: string | null;
	/** 一句话结果。 */
	message: { kind: 'ok' | 'error'; text: string } | null;
	/** 「获取模型列表」拉回来的候选。 */
	found: readonly ModelProfile[] | null;
	/** 正在配谁的密钥（'provider' 或模型 id）。 */
	keyTarget: string | null;
	/** 密钥输入草稿。 */
	keyDraft: string;
	/** 模型行内联编辑器。 */
	rowEditor: RowEditor | null;
}

/** 卡片初始状态。 */
const EMPTY_CARD: CardState = {
	busy: null,
	message: null,
	found: null,
	keyTarget: null,
	keyDraft: '',
	rowEditor: null,
};

/**
 * 取配置里的供应商表。
 * @param value - namespace 解析值。
 * @returns 供应商字典（永远是对象）。
 */
function providersOf(value: MediaValue | undefined): Record<string, ProviderProfile> {
	const providers = value?.[FIELD_PROVIDERS];
	return providers !== null && typeof providers === 'object' ? providers : {};
}

/**
 * 生成一个没被占用的供应商 id。
 * @param base - 期望 id。
 * @param taken - 已占用的 id。
 * @returns 合法且唯一的 id。
 */
function freeProviderId(base: string, taken: readonly string[]): string {
	const slug = base
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40);
	const seed = isValidProviderId(slug) ? slug : 'provider';
	if (!taken.includes(seed)) return seed;
	for (let i = 2; i < 200; i += 1) {
		const candidate = `${seed}-${String(i)}`;
		if (!taken.includes(candidate)) return candidate;
	}
	return `${seed}-${String(Date.now() % 100000)}`;
}

/**
 * 按预设造一条供应商配置。
 * @param preset - 预设。
 * @returns 供应商配置。
 */
function profileFromPreset(preset: ProviderPreset): ProviderProfile {
	return {
		label: preset.label,
		baseURL: preset.baseURL,
		apiKeyEnv: providerKeyRef(preset.id),
		models: preset.models.map((model) => ({
			id: model.id,
			kind: model.kind,
			apiKeyEnv: '',
			label: '',
		})),
	};
}

/**
 * 一个模型当前的密钥状态。
 * @param provider - 供应商配置。
 * @param model - 模型配置。
 * @param configured - 已配置的凭据引用集合。
 * @param known - 凭据状态是否已问到（没问到时不谎报「未配置」）。
 * @returns 文案与「是否单独密钥」。
 */
function keyStateOf(
	provider: ProviderProfile,
	model: ModelProfile,
	configured: ReadonlySet<string>,
	known: boolean,
): { text: string; own: boolean } {
	const own = (model.apiKeyEnv ?? '') !== '';
	const providerRef = provider.apiKeyEnv ?? '';
	if (own) {
		return {
			text: known
				? configured.has(model.apiKeyEnv ?? '')
					? '单独密钥 · 已配置'
					: '单独密钥 · 未配置'
				: '单独密钥',
			own: true,
		};
	}
	if (providerRef === '') return { text: '未设置密钥引用', own: false };
	return {
		text: known
			? configured.has(providerRef)
				? '继承供应商密钥 · 已配置'
				: '继承供应商密钥 · 未配置'
			: '继承供应商密钥',
		own: false,
	};
}

/** 模型种类的中文名（设置页里到处用同一份说法）。 */
function kindLabel(kind: ModelKind): string {
	return kind === 'image' ? '图像' : kind === 'video' ? '视频' : '视觉';
}

/** 模型行右键菜单的动作清单（按当前模型裁剪）。 */
function modelActions(model: ModelProfile): readonly { id: string; label: string; danger?: boolean }[] {
	return [
		{ id: 'key', label: (model.apiKeyEnv ?? '') === '' ? '配置这个模型的密钥…' : '修改这个模型的密钥…' },
		...(model.apiKeyEnv ?? '') === ''
			? []
			: [{ id: 'clear-key', label: '清除单独密钥（改回继承）' }],
		{ id: 'rename', label: '重命名模型…' },
		{ id: 'kind', label: '切换种类（图像 → 视频 → 视觉）' },
		{ id: 'default-image', label: '设为默认图像模型' },
		{ id: 'default-video', label: '设为默认视频模型' },
		{ id: 'default-vision', label: '设为默认视觉模型' },
		{ id: 'remove', label: '删除这个模型', danger: true },
	];
}

/**
 * 模型行的右键菜单。
 * @param props - 锚点、目标模型与回调。
 * @returns 菜单元素。
 */
function ModelRowMenu({
	at,
	model,
	onPick,
	onClose,
}: {
	at: { x: number; y: number };
	model: ModelProfile;
	onPick: (action: string) => void;
	onClose: () => void;
}): ReactNode {
	const ref = useRef<HTMLDivElement | null>(null);
	const actions = modelActions(model);
	// 菜单尺寸估算值：夹进视口用（真实尺寸要等布局，估算够用且更简单）。
	const size = { w: 250, h: 44 + actions.length * 30 };
	const spot = clampToViewport(at, size);
	const nav = useMenuNav({
		ids: actions.map((action) => action.id),
		isDisabled: () => false,
		onChoose: (id) => {
			onPick(id);
			onClose();
		},
		onClose,
	});
	useMenuFocus(ref, []);
	useMenuDismiss({ menuRef: ref, onClose, watchResize: true });

	return (
		<div
			ref={ref}
			className="ffc-menu ffc-model-menu"
			role="menu"
			aria-label={`模型 ${model.id} 的操作`}
			tabIndex={-1}
			data-model={model.id}
			style={{ left: `${String(spot.x)}px`, top: `${String(spot.y)}px` }}
			onKeyDown={nav.onKeyDown}
			{...nav.containerProps}
		>
			<div className="ffc-menu-label">模型 {model.id}</div>
			{actions.map((action) => (
				<button
					key={action.id}
					type="button"
					role="menuitem"
					className="ffc-menu-item"
					data-action={action.id}
					data-danger={action.danger === true ? 'true' : undefined}
					onClick={() => {
						onPick(action.id);
						onClose();
					}}
					{...nav.itemProps(action.id)}
				>
					<span className="ffc-menu-check" />
					<span>{action.label}</span>
				</button>
			))}
		</div>
	);
}

/**
 * 设置页主体。
 * @param props - scope / 写入面 / 探测面。
 * @returns 页面元素。
 */
export function MediaSettings({ scope, api, getProbe }: MediaSettingsProps): ReactNode {
	const snapshot = useSyncExternalStore(
		useCallback((listener: () => void) => scope.subscribe(listener), [scope]),
		useCallback(() => scope.getSnapshot(), [scope]),
	);

	/**
	 * 宿主探测服务：挂载后取一次，取不到就短暂重试。
	 *
	 * 为什么需要重试：`remote.mediaProbe` 是**远程贡献挂载之后**才出现的派生服务，
	 * 而用户可能在它出现之前就点开了设置页。取不到时按钮置灰并说明原因，
	 * 但不会一直灰着 —— 最多重试 10 次（每次 500ms）。
	 */
	const [probe, setProbe] = useState<MediaSettingsProbe | undefined>(() => getProbe?.());
	useEffect(() => {
		if (probe !== undefined || getProbe === undefined) return undefined;
		let tries = 0;
		const timer = setInterval(() => {
			tries += 1;
			const found = getProbe();
			if (found !== undefined) {
				setProbe(found);
				clearInterval(timer);
				return;
			}
			if (tries >= 10) clearInterval(timer);
		}, 500);
		return () => {
			clearInterval(timer);
		};
	}, [probe, getProbe]);

	const [cards, setCards] = useState<Record<string, CardState>>({});
	const [presetsOpen, setPresetsOpen] = useState(false);
	const [menu, setMenu] = useState<{ providerId: string; model: ModelProfile; at: { x: number; y: number } } | null>(
		null,
	);
	/** 文本字段草稿（键 = `${providerId}:${field}`）。失焦/回车才写盘。 */
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	/** 已配置的凭据引用。 */
	const [configured, setConfigured] = useState<ReadonlySet<string>>(new Set());
	/** 是否已经问过凭据状态。 */
	const [keysKnown, setKeysKnown] = useState(false);

	const value = snapshot.value;
	const providers = providersOf(value);
	const providerIds = Object.keys(providers);
	const writable = snapshot.writable && snapshot.status === 'ready' && api !== undefined;

	/** 取卡片状态。 */
	const cardOf = (id: string): CardState => cards[id] ?? EMPTY_CARD;
	const patchCard = useCallback((id: string, patch: Partial<CardState>) => {
		setCards((prev) => ({ ...prev, [id]: { ...(prev[id] ?? EMPTY_CARD), ...patch } }));
	}, []);

	/**
	 * 写一批路径 op（实现在 `settings/models.ts` —— 工具条那格切默认模型
	 * 走的是**同一个**函数，冲突重试与错误文案因此不可能漂移）。
	 * @param ops - 路径 op。
	 */
	const mutate = useCallback(
		(ops: PathOp[]): Promise<void> => mutateSettings(api, scope, ops),
		[api, scope],
	);

	/** 当前配置里所有凭据引用。 */
	const allRefs = useMemo(() => {
		const out: string[] = [];
		for (const profile of Object.values(providers)) {
			if ((profile.apiKeyEnv ?? '') !== '') out.push(profile.apiKeyEnv ?? '');
			for (const model of profile.models ?? []) {
				if ((model.apiKeyEnv ?? '') !== '') out.push(model.apiKeyEnv ?? '');
			}
		}
		return [...new Set(out)];
	}, [providers]);

	/**
	 * 问一次凭据状态（只回 configured/source/writable，永不回值）。
	 * @param refs - 要问的引用名。
	 */
	const refreshKeys = useCallback(
		async (refs: readonly string[]): Promise<void> => {
			const list = [...new Set(refs.filter((ref) => ref !== ''))];
			if (list.length === 0) {
				setConfigured(new Set());
				setKeysKnown(true);
				return;
			}
			try {
				const response = await api?.credentials.describe(list);
				if (response === undefined || !response.ok) return;
				const hit = new Set<string>();
				for (const [ref, info] of Object.entries(response.value)) {
					if (info.configured) hit.add(ref);
				}
				setConfigured(hit);
				setKeysKnown(true);
			} catch {
				/* 凭据面缺席：保持「未知」，不谎报「未配置」 */
			}
		},
		[api],
	);

	// 引用集合变化时刷新凭据状态（引用只增不减时也重问，成本极低）
	const refsKey = allRefs.join(',');
	useEffect(() => {
		void refreshKeys(allRefs);
		// eslint-disable-next-line react-hooks/exhaustive-deps -- 用 refsKey 收敛依赖
	}, [refsKey, refreshKeys]);

	/** 保存一整条供应商记录（新增 / 覆盖）。 */
	const putProvider = useCallback(
		async (id: string, profile: ProviderProfile, message: string | null): Promise<void> => {
			await mutate([{ op: 'set', path: [FIELD_PROVIDERS, id], value: profile }]);
			if (message !== null) patchCard(id, { message: { kind: 'ok', text: message } });
		},
		[mutate, patchCard],
	);

	/** 统一的「跑一个异步动作并汇报」包装。 */
	const run = useCallback(
		(id: string, busy: string, fn: () => Promise<string | null>): void => {
			patchCard(id, { busy, message: null });
			void (async () => {
				try {
					const ok = await fn();
					patchCard(id, { busy: null, ...(ok === null ? {} : { message: { kind: 'ok' as const, text: ok } }) });
				} catch (error) {
					patchCard(id, {
						busy: null,
						message: { kind: 'error', text: error instanceof Error ? error.message : String(error) },
					});
				}
			})();
		},
		[patchCard],
	);

	/** 添加一个预设供应商。 */
	const addPreset = useCallback(
		(preset: ProviderPreset) => {
			setPresetsOpen(false);
			const id = freeProviderId(preset.id, providerIds);
			run(id, 'add', async () => {
				await putProvider(id, profileFromPreset(preset), null);
				return `已添加「${preset.label}」：填密钥（或设环境变量 ${providerKeyRef(id)}）就能用`;
			});
		},
		[providerIds, putProvider, run],
	);

	/** 添加一个自定义供应商。 */
	const addCustom = useCallback(() => {
		setPresetsOpen(false);
		const id = freeProviderId('custom', providerIds);
		run(id, 'add', async () => {
			await putProvider(
				id,
				{ label: '自定义供应商', baseURL: '', apiKeyEnv: providerKeyRef(id), models: [] },
				null,
			);
			return '已添加自定义供应商：填接口基址 → 配密钥 → 添加模型';
		});
	}, [providerIds, putProvider, run]);

	/** 写回一个文本字段（草稿提交）。 */
	const commitField = useCallback(
		(id: string, field: 'label' | 'baseURL' | 'apiKeyEnv', text: string) => {
			const key = `${id}:${field}`;
			setDrafts((prev) => {
				const next = { ...prev };
				delete next[key];
				return next;
			});
			run(id, `field:${field}`, async () => {
				const trimmed = text.trim();
				await mutate([
					trimmed === ''
						? { op: 'unset', path: [FIELD_PROVIDERS, id, field] }
						: { op: 'set', path: [FIELD_PROVIDERS, id, field], value: trimmed },
				]);
				return null;
			});
		},
		[mutate, run],
	);

	/** 整体替换 models 数组（数组只能整体写）。 */
	const writeModels = useCallback(
		(id: string, models: readonly ModelProfile[], message: string | null): void => {
			run(id, 'models', async () => {
				await mutate([
					{
						op: 'set',
						path: [FIELD_PROVIDERS, id, 'models'],
						value: models.map((model) => ({
							id: model.id,
							kind: model.kind,
							apiKeyEnv: model.apiKeyEnv ?? '',
							label: model.label ?? '',
						})),
					},
				]);
				return message;
			});
		},
		[mutate, run],
	);

	/** 设置默认模型。 */
	const setDefault = useCallback(
		(kind: ModelKind, ref: string) => {
			const field =
				kind === 'image'
					? FIELD_DEFAULT_IMAGE
					: kind === 'video'
						? FIELD_DEFAULT_VIDEO
						: FIELD_DEFAULT_VISION;
			void mutate([ref === '' ? { op: 'unset', path: [field] } : { op: 'set', path: [field], value: ref }]).catch(
				() => undefined,
			);
		},
		[mutate],
	);

	/** 存一个密钥到凭据库。 */
	const saveKey = useCallback(
		(id: string, ref: string, secret: string): void => {
			run(id, 'key', async () => {
				const response = await api?.credentials.set(ref, secret);
				if (response === undefined || !response.ok) {
					throw new Error(response?.error.message ?? '宿主凭据面还没就绪：刷新页面再试');
				}
				await refreshKeys([...allRefs, ref]);
				patchCard(id, { keyTarget: null, keyDraft: '' });
				return `密钥已保存到凭据库（${ref}），不会写进 settings.yaml`;
			});
		},
		[allRefs, api, patchCard, refreshKeys, run],
	);

	/**
	 * 给**某个模型**配一把专属密钥：先把模型指向自己的引用、再写值。
	 *
	 * 顺序不能反：引用还没挂上就写值，凭据状态刷新时那把钥匙还没有归属。
	 * 两步放在同一个动作里（而不是各跑一次 `run`），否则两个并发动作会互相
	 * 覆盖 `busy` 与消息，用户看到的是随机那一条。
	 * @param id - 供应商 id。
	 * @param modelId - 模型 id。
	 * @param secret - 密钥。
	 */
	const saveModelKey = useCallback(
		(id: string, modelId: string, secret: string): void => {
			const ref = modelKeyRef(id, modelId);
			run(id, 'key', async () => {
				const profile = providersOf(scope.getSnapshot().value)[id];
				const models = profile?.models ?? [];
				await mutate([
					{
						op: 'set',
						path: [FIELD_PROVIDERS, id, 'models'],
						value: models.map((model) =>
							model.id === modelId ? cleanModel({ ...model, apiKeyEnv: ref }) : cleanModel(model),
						),
					},
				]);
				const response = await api?.credentials.set(ref, secret);
				if (response === undefined || !response.ok) {
					throw new Error(response?.error.message ?? '宿主凭据面还没就绪：刷新页面再试');
				}
				await refreshKeys([...allRefs, ref]);
				patchCard(id, { keyTarget: null, keyDraft: '' });
				return `${modelId} 的专属密钥已保存（${ref}）`;
			});
		},
		[allRefs, api, mutate, patchCard, refreshKeys, run, scope],
	);

	/**
	 * 清除一个密钥。
	 * @param id - 供应商 id。
	 * @param ref - 引用名。
	 */
	const clearKey = useCallback(
		(id: string, ref: string): void => {
			run(id, 'key', async () => {
				const response = await api?.credentials.unset(ref);
				if (response === undefined || !response.ok) {
					throw new Error(response?.error.message ?? '宿主凭据面还没就绪：刷新页面再试');
				}
				await refreshKeys([...allRefs, ref]);
				return '密钥已清除';
			});
		},
		[allRefs, api, refreshKeys, run],
	);

	/** 测试连接 / 获取模型列表（同一个宿主调用）。 */
	const runProbe = useCallback(
		(id: string, what: 'test' | 'models'): void => {
			if (probe === undefined) return;
			const profile = providersOf(scope.getSnapshot().value)[id];
			const existing = new Set((profile?.models ?? []).map((model) => model.id));
			run(id, what, async () => {
				// 远程方法返回的是信封，先拆再判成败（拆信封在共享契约里，见 shared/probe.ts）
				const envelope = what === 'test' ? await probe.testConnection(id) : await probe.listModels(id);
				const answer = unwrapProbeResult<ProbeResult>(envelope);
				if (!answer.ok) throw new Error(answer.message);
				const result = answer.value;
				const found =
					result.ok && Array.isArray(result.models)
						? result.models.map((modelId, index) => ({
								id: modelId,
								kind: (result.kinds?.[index] ?? 'image') as ModelKind,
								apiKeyEnv: '',
								label: '',
							}))
						: null;
				patchCard(id, {
					found: found === null ? null : found.filter((model) => !existing.has(model.id)),
				});
				if (!result.ok) throw new Error(result.message);
				return result.message;
			});
		},
		[patchCard, probe, run, scope],
	);

	/** 模型行右键动作。 */
	const onModelAction = useCallback(
		(providerId: string, model: ModelProfile, action: string): void => {
			const profile = providersOf(scope.getSnapshot().value)[providerId];
			const models = profile?.models ?? [];
			const others = models.filter((candidate) => candidate.id !== model.id);

			switch (action) {
				case 'key':
					patchCard(providerId, { keyTarget: model.id, keyDraft: '' });
					return;
				case 'clear-key':
					// 数组整体重写：把这个模型的引用清掉 → 改回继承供应商级密钥；
					// 顺手把凭据也删掉（引用是按「供应商 + 模型」推出来的，不会与别人共用）
					writeModels(
						providerId,
						models.map((candidate) =>
							candidate.id === model.id ? { ...candidate, apiKeyEnv: '' } : candidate,
						),
						`已清除 ${model.id} 的单独密钥，改回继承供应商密钥`,
					);
					if ((model.apiKeyEnv ?? '') !== '') {
						void api?.credentials.unset(model.apiKeyEnv ?? '').catch(() => undefined);
					}
					return;
				case 'rename':
					patchCard(providerId, {
						rowEditor: { mode: 'rename', original: model.id, id: model.id, kind: model.kind },
					});
					return;
				case 'kind': {
					// 三种种类循环：图像 → 视频 → 视觉 → 图像
					const next: ModelKind =
						model.kind === 'image' ? 'video' : model.kind === 'video' ? 'vision' : 'image';
					writeModels(
						providerId,
						models.map((entry) => (entry.id === model.id ? { ...entry, kind: next } : entry)),
						`${model.id} 已改成${kindLabel(next)}模型`,
					);
					return;
				}
				case 'default-image':
					setDefault('image', modelRef(providerId, model.id));
					return;
				case 'default-video':
					setDefault('video', modelRef(providerId, model.id));
					return;
				case 'default-vision':
					setDefault('vision', modelRef(providerId, model.id));
					return;
				default:
					writeModels(providerId, others, `已删除模型 ${model.id}`);
			}
		},
		[api, patchCard, scope, setDefault, writeModels],
	);

	if (snapshot.status === 'loading') {
		return (
			<div className="ffc-set">
				<div className="ffc-set-status">正在读取设置…</div>
			</div>
		);
	}
	if (snapshot.status === 'unavailable') {
		return (
			<div className="ffc-set">
				<div className="ffc-set-status" data-kind="error">
					当前浏览器读不到设置（设置服务仅限回环访问）。请在本机打开的页面里配置。
				</div>
			</div>
		);
	}

	const defaultImage = typeof value?.[FIELD_DEFAULT_IMAGE] === 'string' ? (value[FIELD_DEFAULT_IMAGE] as string) : '';
	const defaultVideo = typeof value?.[FIELD_DEFAULT_VIDEO] === 'string' ? (value[FIELD_DEFAULT_VIDEO] as string) : '';
	const defaultVision =
		typeof value?.[FIELD_DEFAULT_VISION] === 'string' ? (value[FIELD_DEFAULT_VISION] as string) : '';
	const allModels: { ref: string; kind: ModelKind }[] = [];
	for (const [providerId, profile] of Object.entries(providers)) {
		for (const model of profile.models ?? []) {
			allModels.push({ ref: modelRef(providerId, model.id), kind: model.kind });
		}
	}

	return (
		<div className="ffc-set">
			<div className="ffc-set-intro">
				配置图像 / 视频生成模型。一个供应商可以挂多个模型（各自标好图像、视频或视觉），
				每个模型还能单独配一把密钥；填好后在聊天里说「画一张…」或「生成一段视频…」，
				结果会同时出现在对话与左侧画布上。
				<br />
				<b>视觉模型</b>是可选的：文本模型看不见参考图时，由它把图读成一段文字，
				注入生成提示词并回给模型（相当于给文本模型配一双眼睛）。
				<br />
				<b>密钥只进 DSH 凭据库</b>（也可用同名环境变量提供）：不写进 settings.yaml，
				也不会下发给浏览器。
			</div>
			{!writable ? (
				<div className="ffc-set-status" data-kind="error">
					{api === undefined
						? '当前浏览器拿不到宿主写入面（remote.settings）—— 现在保存不了配置，刷新页面再试。'
						: '当前设置文档是只读的，无法保存。'}
				</div>
			) : null}
			{probe === undefined ? (
				<div className="ffc-set-status" data-kind="error">
					宿主没有提供探测服务（mediaProbe）——「测试连接 / 获取模型列表」不可用，
					仍可手工填写基址与模型。
				</div>
			) : null}

			{/* ── 添加供应商 ── */}
			<div className="ffc-set-add">
				<button
					type="button"
					className="ffc-tbtn ffc-set-addbtn"
					data-ffc-ui="settings"
					data-active={presetsOpen ? 'true' : undefined}
					aria-haspopup="menu"
					aria-expanded={presetsOpen}
					aria-label="添加供应商"
					disabled={!writable}
					onClick={() => {
						setPresetsOpen((prev) => !prev);
					}}
				>
					＋ 添加供应商
				</button>
				{presetsOpen ? (
					<div className="ffc-menu ffc-preset-menu" role="menu" aria-label="选择供应商预设">
						<div className="ffc-menu-label">预设（OpenAI 兼容端点）</div>
						{PROVIDER_PRESETS.map((preset) => (
							<button
								key={preset.id}
								type="button"
								role="menuitem"
								className="ffc-menu-item"
								data-preset={preset.id}
								onClick={() => {
									addPreset(preset);
								}}
							>
								<span className="ffc-menu-check" />
								<span>{preset.label}</span>
								<span className="ffc-spacer" />
								<span className="ffc-badge">{preset.models.length} 模型</span>
							</button>
						))}
						<div className="ffc-menu-divider" />
						<button type="button" role="menuitem" className="ffc-menu-item" data-preset="custom" onClick={addCustom}>
							<span className="ffc-menu-check" />
							<span>自定义供应商…</span>
							<span className="ffc-spacer" />
							<span className="ffc-badge">只填基址</span>
						</button>
					</div>
				) : null}
			</div>

			{providerIds.length === 0 ? (
				<div className="ffc-set-empty">
					还没有供应商。点上面的「添加供应商」选一个预设，或自定义一个 OpenAI 兼容端点。
				</div>
			) : null}

			{/* ── 供应商卡片 ── */}
			{providerIds.map((providerId) => {
				const profile = providers[providerId] as ProviderProfile;
				const state = cardOf(providerId);
				const models = profile.models ?? [];
				const draftOf = (field: string, fallback: string): string =>
					drafts[`${providerId}:${field}`] ?? fallback;

				return (
					<div className="ffc-set-card" key={providerId} data-provider={providerId}>
						<div className="ffc-set-head">
							<span className="ffc-set-title">
								{(profile.label ?? '') === '' ? providerId : (profile.label ?? providerId)}
							</span>
							<span className="ffc-badge">{providerId}</span>
							<span className="ffc-spacer" />
							<button
								type="button"
								className="ffc-tbtn"
								data-action="test"
								disabled={!writable || probe === undefined || state.busy !== null}
								title="用已配置的密钥访问 {base}/models，验证地址与密钥"
								onClick={() => {
									runProbe(providerId, 'test');
								}}
							>
								{state.busy === 'test' ? '测试中…' : '测试连接'}
							</button>
							<button
								type="button"
								className="ffc-tbtn"
								data-action="models"
								disabled={!writable || probe === undefined || state.busy !== null}
								title="拉取这个供应商的模型列表，点一下加进来"
								onClick={() => {
									runProbe(providerId, 'models');
								}}
							>
								{state.busy === 'models' ? '获取中…' : '获取模型列表'}
							</button>
							<button
								type="button"
								className="ffc-tbtn ffc-set-danger"
								data-action="remove-provider"
								disabled={!writable || state.busy !== null}
								title="删除这个供应商（凭据本身仍留在凭据库里）"
								onClick={() => {
									run(providerId, 'remove', async () => {
										await mutate([{ op: 'unset', path: [FIELD_PROVIDERS, providerId] }]);
										return `已删除供应商 ${providerId}`;
									});
								}}
							>
								删除
							</button>
						</div>

						<div className="ffc-set-grid">
							<label className="ffc-set-field">
								<span className="ffc-set-label">接口基址</span>
								<input
									className="ffc-set-input"
									type="text"
									spellCheck={false}
									placeholder="https://gateway.example.com/v1"
									data-field="baseURL"
									disabled={!writable}
									value={draftOf('baseURL', profile.baseURL ?? '')}
									onChange={(event) => {
										const text = (event.target as HTMLInputElement).value;
										setDrafts((prev) => ({ ...prev, [`${providerId}:baseURL`]: text }));
									}}
									onBlur={(event) => {
										commitField(providerId, 'baseURL', (event.target as HTMLInputElement).value);
									}}
									onKeyDown={(event) => {
										if ((event as unknown as { key: string }).key === 'Enter') {
											(event.target as unknown as { blur(): void }).blur();
										}
									}}
								/>
							</label>
							<label className="ffc-set-field">
								<span className="ffc-set-label">显示名</span>
								<input
									className="ffc-set-input"
									type="text"
									spellCheck={false}
									placeholder={providerId}
									data-field="label"
									disabled={!writable}
									value={draftOf('label', profile.label ?? '')}
									onChange={(event) => {
										const text = (event.target as HTMLInputElement).value;
										setDrafts((prev) => ({ ...prev, [`${providerId}:label`]: text }));
									}}
									onBlur={(event) => {
										commitField(providerId, 'label', (event.target as HTMLInputElement).value);
									}}
								/>
							</label>
						</div>

						{/* 供应商级密钥 */}
						<div className="ffc-set-keyrow">
							<span className="ffc-set-label">供应商密钥</span>
							<span
								className="ffc-set-keyvalue"
								data-configured={
									(profile.apiKeyEnv ?? '') !== '' && configured.has(profile.apiKeyEnv ?? '')
										? 'true'
										: 'false'
								}
							>
								{!keysKnown
									? '读取中…'
									: (profile.apiKeyEnv ?? '') === ''
										? '未设置引用'
										: configured.has(profile.apiKeyEnv ?? '')
											? `已配置（${profile.apiKeyEnv ?? ''}）`
											: `未配置（${profile.apiKeyEnv ?? ''}）`}
							</span>
							<span className="ffc-spacer" />
							<button
								type="button"
								className="ffc-tbtn"
								data-action="edit-provider-key"
								disabled={!writable || (profile.apiKeyEnv ?? '') === ''}
								onClick={() => {
									patchCard(providerId, {
										keyTarget: state.keyTarget === 'provider' ? null : 'provider',
										keyDraft: '',
									});
								}}
							>
								{state.keyTarget === 'provider' ? '取消' : '配置密钥…'}
							</button>
							<button
								type="button"
								className="ffc-tbtn"
								data-action="clear-provider-key"
								disabled={!writable || (profile.apiKeyEnv ?? '') === ''}
								onClick={() => {
									clearKey(providerId, profile.apiKeyEnv ?? '');
								}}
							>
								清除
							</button>
						</div>

						{state.keyTarget === 'provider' ? (
							<div className="ffc-set-keyeditor">
								<input
									className="ffc-set-input ffc-set-secret"
									type="password"
									autoComplete="off"
									spellCheck={false}
									placeholder={`粘贴密钥 → 存进凭据库 ${profile.apiKeyEnv ?? ''}`}
									data-field="provider-secret"
									value={state.keyDraft}
									onChange={(event) => {
										patchCard(providerId, { keyDraft: (event.target as HTMLInputElement).value });
									}}
								/>
								<button
									type="button"
									className="ffc-tbtn"
									data-action="save-provider-key"
									disabled={state.busy === 'key' || state.keyDraft.trim() === ''}
									onClick={() => {
										saveKey(providerId, profile.apiKeyEnv ?? '', state.keyDraft.trim());
									}}
								>
									保存
								</button>
							</div>
						) : null}

						{/* 模型列表 */}
						<div className="ffc-set-group">模型（{models.length}）</div>
						{models.length === 0 && state.rowEditor === null ? (
							<div className="ffc-set-hint">还没有模型。可以「获取模型列表」一键加，或手工添加。</div>
						) : null}
						<div className="ffc-set-models">
							{models.map((model) => {
								const keyState = keyStateOf(profile, model, configured, keysKnown);
								const editing = state.rowEditor?.mode === 'rename' && state.rowEditor.original === model.id;
								if (editing && state.rowEditor !== null) {
									return (
										<div className="ffc-set-model" key={model.id} data-model={model.id} data-editing="true">
											<select
												className="ffc-set-input ffc-set-kindselect"
												data-field="kind"
												value={state.rowEditor.kind}
												onChange={(event) => {
													const kind = (event.target as HTMLSelectElement).value as ModelKind;
													patchCard(providerId, {
														rowEditor: { ...state.rowEditor!, kind },
													});
												}}
											>
												<option value="image">图像</option>
												<option value="video">视频</option>
												<option value="vision">视觉</option>
											</select>
											<input
												className="ffc-set-input"
												type="text"
												spellCheck={false}
												data-field="model-id"
												value={state.rowEditor.id}
												onChange={(event) => {
													patchCard(providerId, {
														rowEditor: { ...state.rowEditor!, id: (event.target as HTMLInputElement).value },
													});
												}}
											/>
											<button
												type="button"
												className="ffc-tbtn"
												data-action="commit-model"
												disabled={state.rowEditor.id.trim() === ''}
												onClick={() => {
													const next = state.rowEditor;
													if (next === null) return;
													const id = next.id.trim();
													writeModels(
														providerId,
														[
															...models.filter((candidate) => candidate.id !== model.id),
															{ ...model, id, kind: next.kind },
														],
														`模型已更新为 ${id}`,
													);
													patchCard(providerId, { rowEditor: null });
												}}
											>
												确定
											</button>
											<button
												type="button"
												className="ffc-tbtn"
												data-action="cancel-model"
												onClick={() => {
													patchCard(providerId, { rowEditor: null });
												}}
											>
												取消
											</button>
										</div>
									);
								}
								return (
									<div
										className="ffc-set-model"
										key={model.id}
										data-model={model.id}
										data-kind={model.kind}
										onContextMenu={(event) => {
											event.preventDefault();
											const e = event as unknown as { clientX: number; clientY: number };
											setMenu({ providerId, model, at: { x: e.clientX, y: e.clientY } });
										}}
									>
										<span className="ffc-set-kind" data-kind={model.kind}>
											{kindLabel(model.kind)}
										</span>
										<span className="ffc-set-modelid" title={model.id}>
											{model.id}
										</span>
										<span className="ffc-spacer" />
										<span className="ffc-set-keystate" data-own={keyState.own ? 'true' : 'false'}>
											{keyState.text}
										</span>
										<button
											type="button"
											className="ffc-tbtn"
											data-action="model-menu"
											title="模型操作（也可以右键这一行）"
											onClick={(event) => {
												const target = event.target as unknown as {
													getBoundingClientRect(): { left: number; bottom: number };
												};
												const rect = target.getBoundingClientRect();
												setMenu({ providerId, model, at: { x: rect.left, y: rect.bottom + 4 } });
											}}
										>
											⋯
										</button>
									</div>
								);
							})}

							{state.rowEditor?.mode === 'add' ? (
								<div className="ffc-set-model" data-editing="true" data-action="add-row">
									<select
										className="ffc-set-input ffc-set-kindselect"
										data-field="kind"
										value={state.rowEditor.kind}
										onChange={(event) => {
											const kind = (event.target as HTMLSelectElement).value as ModelKind;
											patchCard(providerId, { rowEditor: { ...state.rowEditor!, kind } });
										}}
									>
										<option value="image">图像</option>
										<option value="video">视频</option>
										<option value="vision">视觉</option>
									</select>
									<input
										className="ffc-set-input"
										type="text"
										spellCheck={false}
										data-field="model-id"
										placeholder="供应商那边的模型名，如 acme-large"
										value={state.rowEditor.id}
										onChange={(event) => {
											patchCard(providerId, {
												rowEditor: { ...state.rowEditor!, id: (event.target as HTMLInputElement).value },
											});
										}}
									/>
									<button
										type="button"
										className="ffc-tbtn"
										data-action="commit-model"
										disabled={state.rowEditor.id.trim() === ''}
										onClick={() => {
											const next = state.rowEditor;
											if (next === null) return;
											const id = next.id.trim();
											writeModels(
												providerId,
												[...models, { id, kind: next.kind, apiKeyEnv: '', label: '' }],
												`已添加模型 ${id}`,
											);
											patchCard(providerId, { rowEditor: null });
										}}
									>
										添加
									</button>
									<button
										type="button"
										className="ffc-tbtn"
										data-action="cancel-model"
										onClick={() => {
											patchCard(providerId, { rowEditor: null });
										}}
									>
										取消
									</button>
								</div>
							) : null}
						</div>

						{/* 模型级密钥编辑行 */}
						{state.keyTarget !== null && state.keyTarget !== 'provider' ? (
							<div className="ffc-set-keyeditor">
								<span className="ffc-set-label">模型 {state.keyTarget} 的密钥</span>
								<input
									className="ffc-set-input ffc-set-secret"
									type="password"
									autoComplete="off"
									spellCheck={false}
									placeholder="粘贴这个模型专属的密钥（留空即不设置）"
									data-field="model-secret"
									value={state.keyDraft}
									onChange={(event) => {
										patchCard(providerId, { keyDraft: (event.target as HTMLInputElement).value });
									}}
								/>
								<button
									type="button"
									className="ffc-tbtn"
									data-action="save-model-key"
									disabled={state.busy === 'key' || state.keyDraft.trim() === ''}
									onClick={() => {
										const modelId = state.keyTarget;
										if (modelId === null) return;
										saveModelKey(providerId, modelId, state.keyDraft.trim());
									}}
								>
									保存
								</button>
								<button
									type="button"
									className="ffc-tbtn"
									data-action="cancel-key"
									onClick={() => {
										patchCard(providerId, { keyTarget: null, keyDraft: '' });
									}}
								>
									取消
								</button>
							</div>
						) : null}

						<div className="ffc-set-grid">
							<button
								type="button"
								className="ffc-tbtn"
								data-action="add-model"
								disabled={!writable || state.busy !== null}
								onClick={() => {
									patchCard(providerId, { rowEditor: { mode: 'add', original: '', id: '', kind: 'image' } });
								}}
							>
								＋ 添加模型
							</button>
							<span className="ffc-set-hint">右键模型行（或点 ⋯）可以单独配密钥、改类型、设为默认</span>
						</div>

						{/* 「获取模型列表」的结果 */}
						{state.found !== null && state.found.length > 0 ? (
							<div className="ffc-set-picker" data-picker={providerId}>
								<div className="ffc-set-label">拉到的模型（点一下加进这个供应商）</div>
								<div className="ffc-set-pickerlist">
									{state.found.map((model) => (
										<button
											key={model.id}
											type="button"
											className="ffc-menu-chip"
											data-add-model={model.id}
											disabled={!writable}
											onClick={() => {
												writeModels(providerId, [...models, model], `已添加模型 ${model.id}`);
												patchCard(providerId, {
													found: (state.found ?? []).filter((candidate) => candidate.id !== model.id),
												});
											}}
										>
											{model.kind === 'video' ? '🎬' : '🖼'} {model.id}
										</button>
									))}
								</div>
							</div>
						) : null}

						{state.message !== null ? (
							<div
								className="ffc-set-msg"
								data-kind={state.message.kind}
								role={state.message.kind === 'error' ? 'alert' : 'status'}
							>
								{state.message.text}
							</div>
						) : null}
					</div>
				);
			})}

			{/* ── 默认模型 ── */}
			<div className="ffc-set-group">默认模型</div>
			<div className="ffc-set-card">
				{(
					[
						['图像', 'image', defaultImage] as const,
						['视频', 'video', defaultVideo] as const,
						['视觉', 'vision', defaultVision] as const,
					] as const
				).map(([label, kind, current]) => {
					const options = allModels.filter((model) => model.kind === kind);
					const stale = current !== '' && !options.some((model) => model.ref === current);
					return (
						<label className="ffc-set-field" key={kind}>
							<span className="ffc-set-label">{`默认${label}模型`}</span>
							<select
								className="ffc-set-input"
								data-default={kind}
								value={current}
								disabled={!writable}
								onChange={(event) => {
									setDefault(kind, (event.target as HTMLSelectElement).value);
								}}
							>
								<option value="">自动（第一个配好密钥的）</option>
								{options.map((model) => (
									<option key={model.ref} value={model.ref}>
										{model.ref}
									</option>
								))}
								{/* 默认值指向一个已经删掉的模型时，让用户看得见（否则 select 会显示空白，像是没配） */}
								{stale ? <option value={current}>{current}（已失效）</option> : null}
							</select>
							{kind === 'vision' ? (
								<span className="ffc-set-note">
									文本模型看不见参考图时，由它把图读成一段文字，注入生成提示词并回给模型。
									留空 = 不启用。
								</span>
							) : null}
						</label>
					);
				})}
			</div>

			{menu !== null ? (
				<ModelRowMenu
					at={menu.at}
					model={menu.model}
					onClose={() => {
						setMenu(null);
					}}
					onPick={(action) => {
						onModelAction(menu.providerId, menu.model, action);
					}}
				/>
			) : null}
		</div>
	);
}

/**
 * 把一个模型收敛成 host schema 认识的形状（四个字段，顺序稳定）。
 * @param model - 模型配置。
 * @returns 干净的四字段对象。
 */
function cleanModel(model: ModelProfile): ModelProfile {
	return { id: model.id, kind: model.kind, apiKeyEnv: model.apiKeyEnv ?? '', label: model.label ?? '' };
}
