/**
 * 肥鱼画布 · 宿主半边（Node）。
 *
 * 由 profile 的 cordis.patch.yml 行加载（本包 package.json 的 `main`）。
 * 职责：
 *
 *   1. 注册 `media-generation` settings namespace —— 供应商 / 模型配置的
 *      唯一持久化位置；设置页、工具、命令、探测服务读同一份解析值。
 *   2. **把旧配置迁移到新结构**（P8 → P9，见 schema.ts 的 migrateLegacy）。
 *   3. 注册 `media_generate` 工具 —— 模型据此发起真实生成。
 *   4. 注册 `/generate` 直达命令。
 *   5. 注册 `mediaProbe` 远程命名空间（测试连接 / 获取模型列表）——
 *      只有宿主能拿着密钥去访问供应商，浏览器拿到的只是结果。
 *
 * 全部用 `ctx.inject` 而不是顶层 `inject`：浏览器半边不经过宿主半边中转，
 * 因此某个服务缺席时（无头组合、裁剪过的 profile）其余部分仍应可用。
 *
 * ## 两条贯穿全文件的规矩
 *
 * - **密钥不在设置里**：设置只存凭据引用名（`apiKeyEnv`），值在
 *   `ctx.credentials`。这是 P9 能支持「一个供应商多个模型 + 每个模型单独密钥」
 *   的前提 —— 设置里没有 `role('secret')` 字段，脱敏视图与真实视图一致，
 *   因此任意嵌套写入都不会抹掉别人的机密。
 * - **密钥不做长期缓存**：凭据服务明确要求「每次操作重新解析」。因此
 *   `getModels()` 与探测服务都是异步的，每次调用都重新解析引用
 *   （用户刚填完密钥就该立刻生效，而不是等下一次配置变更）。
 *
 * @module fatfish-canvas
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from '@deepseek-ai/cordis';
import {
	FIELD_DEFAULT_IMAGE,
	FIELD_DEFAULT_VIDEO,
	FIELD_PROVIDERS,
	MEDIA_NS,
	MediaGenerationSchema,
	isUsable,
	migrateLegacy,
	resolveModels,
	type MediaGenerationConfig,
	type ResolvedModel,
} from './host/schema';
import { MEDIA_TOOL_NAME, createMediaTool, type MediaToolDeps } from './host/tool';
import { createGenerateCommand } from './host/command';
import { MediaProbeCore, type ProbeTarget, type StoreImageBytes } from './host/probe';
import { MEDIA_COMMAND_NAME } from './client/shared/media';
import { PROBE_HOST_MANIFEST, PROBE_NAMESPACE, probeRemoteBinding } from './client/shared/probe';

/** cordis 插件名。 */
export const name = 'fatfish-canvas';

/** 必需服务：无 —— 全部走 `ctx.inject`，缺服务时优雅降级。 */
export const inject: string[] = [];

/** 远程服务名（客户端取用时的 `remote.<名字>`）。 */
const PROBE_SERVICE = PROBE_NAMESPACE;

/**
 * 模块级就绪标记。
 *
 * 放在模块作用域而不是 `apply` 里，是为了区分两件事：
 *   phase=module-evaluated → 模块确实被重新导入了
 *   phase=host-ready       → apply 跑到了注册那一步（settings + tools 都在）
 * 只有前者时说明 `ctx.inject` 没触发；两者都没有时说明入口根本没重建。
 *
 * ⚠️ **这个文件的真正主人是「正在运行的 dsh web」**：`e2e-command.mjs` 靠它判断
 * 「宿主是否已重启、命令是否已注册」。测试导入本模块也会写它 → 测试期间必须
 * 置 `FFC_NO_STATUS_WRITE=1` 把它关掉（见 `scripts/test-host.mjs`）。
 * 早先的做法是「导入前备份、跑完还原」，但那**一旦文件已经被污染就只会把污染
 * 保存下来**（本轮就踩到了：标记里出现了一个运行中宿主根本没有的 command 字段，
 * e2e 会以为命令已注册而冲进去跑）。
 * @param payload - 要记录的事实。
 */
function writeStatus(payload: Record<string, unknown>): void {
	if (process.env['FFC_NO_STATUS_WRITE'] === '1') return;
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		writeFileSync(
			join(here, 'host-status.json'),
			JSON.stringify({ ...payload, at: new Date().toISOString() }, null, 2),
			'utf8',
		);
	} catch {
		/* 只读文件系统等场景：忽略 */
	}
}

writeStatus({ phase: 'module-evaluated', name: 'fatfish-canvas' });

/**
 * 探测服务的行为由 settings scope 在就绪后装上。
 *
 * 服务本体必须在**插件顶层** provide（网关从应用的服务表里按名字找它），
 * 而它需要的东西（配置、凭据）只有 settings scope 就绪后才有 —— 因此
 * 服务是稳定的空壳，行为通过这个 holder 在 settings 就绪后接入。
 */
const probeHolder: {
	target: (providerId: string) => Promise<ProbeTarget | undefined>;
	timeoutMs: () => number;
	storeImage: StoreImageBytes;
} = {
	target: () => Promise.resolve(undefined),
	timeoutMs: () => 30000,
	storeImage: () => Promise.reject(new Error('附件服务还没就绪')),
};

/** 宿主插件体。 */
export function apply(ctx: Context): void {
	ctx.effect(() => {
		// 生命周期锚点：下面的注册各自持有自己的 effect。
		return () => {};
	}, 'fatfish-canvas: host bootstrap');

	// ── 探测服务：注册为 `mediaProbe`（Typert 远程命名空间） ──
	//
	// 必须在**顶层 ctx** 上 provide：网关按名字从应用的服务表里解析接收者
	// （`resolveReceiverContext().get('mediaProbe')`），在嵌套的 inject scope 里
	// provide 的服务不一定对它可见。行为稍后由 settings 分支接入。
	const probe = new MediaProbeCore({
		providerOf: (providerId) => probeHolder.target(providerId),
		timeoutMs: () => probeHolder.timeoutMs(),
		// 附件写入面同样只有 settings scope 才拿得到（它才持有 scoped），
		// 因此走 holder 在就绪后接入
		storeImage: (input, signal) => probeHolder.storeImage(input, signal),
	});
	(probe as unknown as { typertRemote: unknown }).typertRemote = probeRemoteBinding(probe);

	ctx.effect(
		() => ctx.provide(PROBE_SERVICE, probe),
		'fatfish-canvas: mediaProbe service',
	);

	// ── 设置 namespace ──
	//
	// 这一个 namespace 只能注册**一次**（同名重复注册会直接报错），而工具、
	// 命令与探测服务都读同一份配置，因此先在这里建好 scope 与管线依赖，
	// 再让各个服务在就绪时挂上自己的入口。
	ctx.inject(['settings'], (scoped) => {
		const scope = scoped.settings.register<MediaGenerationConfig>(
			MEDIA_NS,
			MediaGenerationSchema,
			{
				// 不声明组合 base：供应商与模型都是用户数据（预设只是设置页的
				// 「一键添加」模板），因此没有「组合默认值」需要参与解析分层。
				applies: 'live',
			},
		);

		const readConfig = (): MediaGenerationConfig => scope.get();

		/**
		 * 解析当前配置里所有凭据引用。
		 *
		 * 每次都重新解析（见模块头的第二条规矩）。凭据服务缺席时（裁剪过的
		 * 组合）一律按未配置处理 —— 工具与命令会给出可操作的提示而不是崩掉。
		 * @returns 引用名 → 值。
		 */
		const resolveKeys = async (): Promise<Map<string, string>> => {
			const credentials = scoped.get('credentials') as CredentialService | undefined;
			const refs = collectKeyRefs(readConfig());
			if (credentials === undefined || typeof credentials.resolve !== 'function' || refs.length === 0) {
				return new Map();
			}
			const entries = await Promise.all(
				refs.map(async (ref): Promise<readonly [string, string]> => {
					try {
						const hit = await credentials.resolve(ref);
						return [ref, hit?.value ?? ''] as const;
					} catch {
						return [ref, ''] as const;
					}
				}),
			);
			return new Map(entries);
		};

		/**
		 * 读出「已解析的模型清单」（密钥每次都新鲜）。
		 * @returns 每个供应商的每个模型一条。
		 */
		const readModels = async (): Promise<ResolvedModel[]> => {
			const keys = await resolveKeys();
			return resolveModels(readConfig(), (ref) => keys.get(ref) ?? '');
		};

		// 探测服务接上行为。
		//
		// ⚠️ 目标**直接读配置里的供应商**，而不是从 `readModels()` 里挑：
		// `resolveModels` 只产出「有模型的供应商」，用它会把
		// **刚添加、还没加模型的供应商**判成「不存在」——
		// 而那恰恰是最自然的使用顺序（填基址 → 配密钥 → 测试连接 → 拉模型列表）。
		// 实测踩到：界面报「找不到供应商 custom」，用户只会以为配置没保存上。
		probeHolder.timeoutMs = (): number => Math.min(readConfig().timeoutMs, 30000);
		/**
		 * 把画布上的内联图存进附件库，回一个宿主文件路径（P22）。
		 *
		 * 与下面的 `readAttachment` 是同一条字节通路的两端：那个把附件读成字节，
		 * 这个把字节写成附件。**服务缺席时抛可读错误** —— 让「本地图不能当参考图」
		 * 有一个明确的原因，而不是一个空句柄。
		 */
		probeHolder.storeImage = async (input) => {
			const store = scoped.get('attachments') as AttachmentService | undefined;
			if (store === undefined || typeof store.saveImage !== 'function') {
				throw new Error('宿主没有装配附件服务');
			}
			const ref = await store.saveImage(input);
			const path = typeof store.imageHostPath === 'function' ? store.imageHostPath(ref) : undefined;
			if (path === undefined || path === '') {
				throw new Error('这个附件后端不提供本地文件路径');
			}
			return { path, bytes: input.data.byteLength };
		};
		probeHolder.target = async (providerId): Promise<ProbeTarget | undefined> => {
			const providers = readConfig()[FIELD_PROVIDERS];
			if (providers === null || typeof providers !== 'object') return undefined;
			const raw = (providers as Record<string, unknown>)[providerId];
			if (raw === null || typeof raw !== 'object') return undefined;
			const profile = raw as { baseURL?: unknown; apiKeyEnv?: unknown };
			const keyRef = typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv.trim() : '';
			const keys = await resolveKeys();
			return {
				baseURL: typeof profile.baseURL === 'string' ? profile.baseURL.trim() : '',
				apiKey: keyRef === '' ? '' : (keys.get(keyRef) ?? ''),
				keyRef,
			};
		};

		// ── 旧配置迁移（P8 → P9） ──
		//
		// 只做一次：把旧扁平字段搬进 providers 字典 + 凭据库，然后把旧字段 unset。
		// 为什么必须 unset：不在 schema 里的残留字段**不会被脱敏**，
		// 留着就是把明文密钥原样下发到浏览器。
		void (async () => {
			const plan = migrateLegacy(readConfig());
			if (plan.dropFields.length === 0 && Object.keys(plan.providers).length === 0) return;

			const ops: { op: 'set' | 'unset'; path: string[]; value?: unknown }[] = [];
			for (const field of plan.dropFields) ops.push({ op: 'unset', path: [field] });

			const providers = { ...(readConfig()[FIELD_PROVIDERS] ?? {}) };
			for (const [providerId, profile] of Object.entries(plan.providers)) {
				providers[providerId] = profile;
			}
			ops.push({ op: 'set', path: [FIELD_PROVIDERS], value: providers });
			if (plan.defaultImage !== undefined) {
				ops.push({ op: 'set', path: [FIELD_DEFAULT_IMAGE], value: plan.defaultImage });
			}
			if (plan.defaultVideo !== undefined) {
				ops.push({ op: 'set', path: [FIELD_DEFAULT_VIDEO], value: plan.defaultVideo });
			}

			try {
				// 深路径 op：`unset` 只能经 mutate 表达（update 只会合并、删不掉字段）
				await scoped.settings.mutate(MEDIA_NS, ops);
				console.log(
					`[${name}] 已迁移旧的扁平媒体配置 → providers 字典（${Object.keys(plan.providers).join(', ') || '无' }）`,
				);
			} catch (error) {
				console.log(
					`[${name}] 迁移旧配置失败（继续用新结构）：${error instanceof Error ? error.message : String(error)}`,
				);
			}

			const credentials = scoped.get('credentials') as CredentialService | undefined;
			if (credentials !== undefined && typeof credentials.set === 'function') {
				for (const [ref, value] of Object.entries(plan.credentials)) {
					try {
						await credentials.set(ref, value);
					} catch (error) {
						console.log(
							`[${name}] 迁移凭据 ${ref} 失败：${error instanceof Error ? error.message : String(error)}`,
						);
					}
				}
			}
		})();

		const deps: MediaToolDeps = {
			getModels: readModels,
			getTimeoutMs: () => readConfig().timeoutMs,
			log: (message: string): void => {
				console.log(`[${name}] ${message}`);
			},
			/**
			 * 读一个会话附件的字节。
			 *
			 * 这是「文本模型看不见图」的**字节通路**：用户在输入框里附的图、或画布上传来的
			 * 附件句柄，由宿主自己去取内容再交给图像 / 视频模型（见 host/reference.ts）。
			 * 服务缺席时抛可读错误 —— 绝不静默降级成纯文生图。
			 * @param ref - 持久附件引用。
			 * @param signal - 取消信号。
			 * @returns 校验过的字节与 MIME。
			 */
			readAttachment: async (ref, signal) => {
				const store = scoped.get('attachments') as AttachmentService | undefined;
				if (store === undefined || typeof store.readImage !== 'function') {
					throw new Error(
						'宿主没有装配附件服务，读不到这张参考图；可以改用图片地址（--ref https://…）或本地文件路径。',
					);
				}
				const stored = await store.readImage(ref, signal);
				const mediaType = stored.ref?.mediaType;
				return {
					data: stored.data,
					// 附件服务说不出 MIME 时不硬塞空串：交给参考图层按字节头判
					...(mediaType === undefined || mediaType === '' ? {} : { mediaType }),
				};
			},
			/**
			 * 这条路由看不看得见图 —— 决定「自动套用用户附的图」该不该发生。
			 *
			 * 平台语义（`dsh-llm` 的 `LlmModelInfo`）：`inputModalities` **缺席 = 未知**，
			 * 明确列出才代表能力。因此只有**明确**含 `image` 时才回 true（工具据此
			 * 不自动套用：多模态模型自己看得见，参不参考它说了算）；纯文本回 false、
			 * 查不到回 undefined —— 后两者都会让工具自动套用用户附的图。
			 * @param session - 当前会话（路由元数据从它读）。
			 * @returns 是否支持图像输入；查不到时 undefined。
			 */
			routeSeesImages: async (session) => {
				const info = session?.requestContext?.();
				if (info === undefined || typeof info.provider !== 'string' || typeof info.model !== 'string') {
					return undefined;
				}
				const llm = scoped.get('llm') as LlmCatalogService | undefined;
				if (llm === undefined || typeof llm.listModels !== 'function') return undefined;
				try {
					const entries = await llm.listModels(info.provider);
					const entry = entries.find((candidate) => candidate.id === info.model);
					if (entry?.inputModalities === undefined) return undefined;
					return entry.inputModalities.includes('image');
				} catch (error) {
					console.log(
						`[${name}] 查不到 ${info.provider}/${info.model} 的输入模态（按未知处理）：` +
							`${error instanceof Error ? error.message : String(error)}`,
					);
					return undefined;
				}
			},
		};

		/** 写诊断标记（异步读模型，失败就当没有模型）。 */
		const markReady = (extra: Record<string, unknown>): void => {
			void readModels()
				.then((models) => {
					writeStatus({
						phase: 'host-ready',
						ok: true,
						namespace: MEDIA_NS,
						models: models.map((model) => ({
							ref: model.ref,
							kind: model.kind,
							keyed: isUsable(model),
						})),
						...extra,
					});
					console.log(
						`[${name}] ready: ${String(models.length)} 个模型（${String(models.filter(isUsable).length)} 个已配密钥）` +
							(typeof extra['command'] === 'string' ? ` · /${String(extra['command'])}` : ''),
					);
				})
				.catch(() => undefined);
		};

		// ── 生成工具（agent 可见） ──
		scoped.inject(['tools'], (withTools) => {
			withTools.tools.register(createMediaTool(deps));
			markReady({ tool: MEDIA_TOOL_NAME });
		});

		// ── `/generate` 直达命令（不经过模型） ──
		// 与工具共用同一份管线依赖，因此两条路的模型选择与错误文案完全一致。
		scoped.inject(['commands'], (withCommands) => {
			withCommands.commands.register(createGenerateCommand(deps));
			markReady({ tool: MEDIA_TOOL_NAME, command: MEDIA_COMMAND_NAME });
		});
	});

	// ── Typert 远程清单 ──
	//
	// 声明 `mediaProbe` 命名空间的两个方法，客户端才能 `remote.mediaProbe.*`。
	// 手工注册（不引 zod）是本插件一贯的零依赖做法，profile 里已有先例。
	ctx.inject(['typert'], (withTypert) => {
		const typert = withTypert.get('typert') as { register(manifest: unknown): unknown } | undefined;
		if (typert === undefined || typeof typert.register !== 'function') return;
		typert.register(PROBE_HOST_MANIFEST);
		console.log(`[${name}] remote namespace ready: "${PROBE_NAMESPACE}"（testConnection / listModels）`);
	});

	// 服务缺席时（裁剪过的组合）也要留下痕迹，否则「工具没出现」无从判断是
	// 注册失败还是没走到这一步。
	//
	// 注意这里的 `get('tools')` 守卫：正常情况下上面的注册已经写过成功标记，
	// 若无条件写就会把它覆盖成失败 —— 诊断代码自己制造假故障。
	ctx.inject(['settings'], (scoped) => {
		if (scoped.get('tools') !== undefined) return;
		writeStatus({ phase: 'host-ready', ok: false, reason: 'tools service absent', namespace: MEDIA_NS });
	});
}

/** 宿主侧附件服务在本插件用到的那一面（`dsh-attachment` 的 `AttachmentStore`）。 */
interface AttachmentService {
	/**
	 * 读一张图片并校验它与引用一致。
	 * @param ref - 持久引用。
	 * @param signal - 取消信号。
	 * @returns 引用（含被校验的 MIME）与字节。
	 */
	readImage(
		ref: { attachmentId: string; mediaType: string },
		signal?: AbortSignal,
	): Promise<{ ref?: { mediaType?: string }; data: Uint8Array }>;
	/**
	 * 校验并**持久保存**一张图片（内容寻址）。
	 * @param input - 字节、声明的 MIME 与可选的显示名。
	 * @returns 持久引用。
	 */
	saveImage(input: {
		data: Uint8Array;
		mediaType: string;
		name?: string;
	}): Promise<{ attachmentId: string; mediaType?: string }>;
	/**
	 * 取这个持久引用在宿主文件系统里的**绝对路径**（非文件后端的实现返回 undefined）。
	 * @param ref - 持久引用。
	 * @returns 绝对路径；后端不提供时 undefined。
	 */
	imageHostPath(ref: { attachmentId: string; mediaType?: string }): string | undefined;
}

/** 宿主侧 llm 服务在本插件用到的那一面（只读模型目录，用来判断路由能力）。 */
interface LlmCatalogService {
	/**
	 * 读某个路由公布的模型条目。
	 * @param provider - 路由名（如 `deepseek-official`）。
	 * @returns 建议性条目；`inputModalities` 缺席表示能力未知。
	 */
	listModels(provider: string): Promise<readonly { id?: string; inputModalities?: readonly string[] }[]>;
}

/** 宿主侧凭据服务在本插件用到的那一面。 */
interface CredentialService {
	/**
	 * 解析一个凭据引用。
	 * @param ref - 引用名。
	 * @returns 值与来源；未配置时为 undefined。
	 */
	resolve(ref: string): Promise<{ value: string; source: string } | undefined>;
	/**
	 * 写入一个凭据（迁移用）。
	 * @param ref - 引用名。
	 * @param value - 非空密钥。
	 */
	set(ref: string, value: string): Promise<void>;
}

/**
 * 收集配置里出现过的所有凭据引用名。
 * @param config - namespace 解析值。
 * @returns 去重后的引用名。
 */
function collectKeyRefs(config: MediaGenerationConfig): string[] {
	const providers = config[FIELD_PROVIDERS];
	if (providers === null || typeof providers !== 'object') return [];
	const out = new Set<string>();
	for (const raw of Object.values(providers)) {
		if (raw === null || typeof raw !== 'object') continue;
		const profile = raw as { apiKeyEnv?: unknown; models?: unknown };
		if (typeof profile.apiKeyEnv === 'string' && profile.apiKeyEnv !== '') out.add(profile.apiKeyEnv);
		if (!Array.isArray(profile.models)) continue;
		for (const model of profile.models) {
			if (model === null || typeof model !== 'object') continue;
			const ref = (model as { apiKeyEnv?: unknown }).apiKeyEnv;
			if (typeof ref === 'string' && ref !== '') out.add(ref);
		}
	}
	return [...out];
}
