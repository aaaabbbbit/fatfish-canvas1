/**
 * 肥鱼画布 · 宿主半边（Node）。
 *
 * 由 profile 的 cordis.patch.yml 行加载（本包 package.json 的 `main`）。
 * 职责：
 *
 *   1. 声明 `Config`（settings schema）—— 供应商 / 模型配置的唯一持久化位置。
 *      0.2.0 起设置分节按 **Loader entry id** 寻址（本插件 = `fatfish-canvas`），
 *      值从 `apply(ctx, config)` 的 `config` 参数**活读**（见 `readLiveConfig`）；
 *      设置页、工具、命令、探测服务读的是同一份解析值。
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
	FIELD_ARCHIVE_DIR,
	FIELD_DESKILL_ON,
	FIELD_DESKILL_TEXT,
	FIELD_DEFAULT_IMAGE,
	FIELD_DEFAULT_VIDEO,
	FIELD_PROVIDERS,
	MediaGenerationSchema,
	SETTINGS_ENTRY_ID,
	isUsable,
	migrateLegacy,
	readLiveConfig,
	resolveModels,
	type MediaGenerationConfig,
	type MediaGenerationLiveConfig,
	type ResolvedModel,
} from './host/schema';
import { MEDIA_TOOL_NAME, createMediaTool, type MediaToolDeps } from './host/tool';
import { ARCHIVE_ROUTE_PREFIX, createArchiveHandler } from './host/archive';
import { createGenerateCommand } from './host/command';
import { MediaProbeCore, type ProbeTarget } from './host/probe';
import { MEDIA_COMMAND_NAME } from './client/shared/media';
import { PROBE_HOST_MANIFEST, PROBE_NAMESPACE, probeRemoteBinding } from './client/shared/probe';

/** cordis 插件名。 */
export const name = 'fatfish-canvas';

/**
 * 插件的设置 schema（Loader 用它校验 profile 那一行的 `config:`）。
 *
 * 必须从**入口模块**导出：`registry.plugin()` 读的是 `plugin.Config`
 * （`runtime.Config = plugin.Config`），设置服务再从 `entry.fiber.runtime.Config`
 * 取它。定义在 host/schema.ts，这里只做再导出。
 */
export { MediaGenerationSchema as Config };

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
 * 探测服务的行为经这个 holder 接到读取面上。
 *
 * 服务本体必须在**插件顶层** provide（网关从应用的服务表里按名字找它），而它的
 * 行为每次调用都要读**当前**配置与凭据 —— 因此服务是稳定的空壳，行为放在这个
 * holder 里、由下面的管线接上。0.2.0 起配置由 Loader 直接交给 `apply`（不再等
 * settings scope），所以接上这一步就在 `apply` 开头；「服务身份」与「行为实现」
 * 分开这件事本身仍然是刻意的。
 */
const probeHolder: {
	target: (providerId: string) => Promise<ProbeTarget | undefined>;
	timeoutMs: () => number;
} = {
	target: () => Promise.resolve(undefined),
	timeoutMs: () => 30000,
};

/**
 * 本地留档目录的读取面（模块级持有，P32）。
 *
 * 与 `probeHolder` 同一个理由：取图路由在**插件顶层**注册（它只依赖
 * webServer），而目录值来自活配置 —— 路由那边始终调这一个函数，每次请求都读
 * 最新值（空串 = 不留档，路由也会 404）。
 */
const archiveDirHolder: { get: () => string } = { get: () => '' };

/**
 * 宿主插件体。
 * @param ctx - 宿主插件 context。
 * @param config - Loader 解析好的 `Config`；每个字段都是 `.volatile()` 引用
 *   （读当前值走 `get()`，见 `readLiveConfig`）。行里没写 `config:` 时它仍然
 *   是完整的一份默认值，因此这里可以无条件读。
 */
export function apply(ctx: Context, config: MediaGenerationLiveConfig): void {
	ctx.effect(() => {
		// 生命周期锚点：下面的注册各自持有自己的 effect。
		return () => {};
	}, 'fatfish-canvas: host bootstrap');

	// ── 探测服务：注册为 `mediaProbe`（Typert 远程命名空间） ──
	//
	// 必须在**顶层 ctx** 上 provide：网关按名字从应用的服务表里解析接收者
	// （`resolveReceiverContext().get('mediaProbe')`），在嵌套的 inject scope 里
	// provide 的服务不一定对它可见。行为由下面的读取面经 `probeHolder` 接入。
	const probe = new MediaProbeCore({
		providerOf: (providerId) => probeHolder.target(providerId),
		timeoutMs: () => probeHolder.timeoutMs(),
	});
	(probe as unknown as { typertRemote: unknown }).typertRemote = probeRemoteBinding(probe);

	ctx.effect(
		() => ctx.provide(PROBE_SERVICE, probe),
		'fatfish-canvas: mediaProbe service',
	);

	// ── 配置管线（工具 / 命令 / 探测服务共用） ──
	//
	// 从前这里是一个 `ctx.inject(['settings'], …)` 作用域：配置值只有拿到
	// settings 的 owner scope 才读得到，于是工具与命令也跟着被关在里面。
	// 0.2.0 起配置由 Loader 直接交给 apply（第二个参数 `config`，字段都是
	// `.volatile()` 引用），**不再需要任何服务** —— 因此管线在插件顶层建好，
	// 工具、命令与探测服务在没有设置服务的组合里也照常工作。
	//
	// 本插件的设置分节按 **Loader entry id** 寻址（= profile 里那一行的 `id:`）。
	// 宿主自己那份从 fiber 上读（行被改名也跟得上）；客户端只能写死同一个常量
	// （见 shared/catalog 的 SETTINGS_ENTRY_ID），两者必须一致。
	const settingsEntryId = ctx.fiber.entry?.options.id ?? SETTINGS_ENTRY_ID;

	/**
	 * 当前的普通配置值。
	 *
	 * 每次读都取 `config` 里的当前值：Loader 在设置写入后**就地**更新那些引用，
	 * 因此既不需要订阅、也不需要缓存（见 schema.ts 的 readLiveConfig）。
	 * @returns 解析值（schema 默认 → 用户层）。
	 */
	const readConfig = (): MediaGenerationConfig => readLiveConfig(config);

	// 本地留档目录接上读取面（P32）：取图路由与生成管线读的是同一个值。
	archiveDirHolder.get = (): string => readConfig()[FIELD_ARCHIVE_DIR] ?? '';

	/**
	 * 解析当前配置里所有凭据引用。
	 *
	 * 每次都重新解析（见模块头的第二条规矩）。凭据服务缺席时（裁剪过的
	 * 组合）一律按未配置处理 —— 工具与命令会给出可操作的提示而不是崩掉。
	 * @returns 引用名 → 值。
	 */
	const resolveKeys = async (): Promise<Map<string, string>> => {
		const credentials = ctx.get('credentials') as CredentialService | undefined;
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
	//
	// 写回要经设置服务（`settings.mutate`，按 **entry id** 寻址）。它只在自己那套
	// 依赖（configEditor / profileContext）齐备时才存在，因此这里**按需解析**
	// 而不是声明成必需依赖：缺席的组合里旧字段留着不动，其余功能照常。
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

		// 两处写回都要**等服务就绪**，因此用 `ctx.inject` 而不是在这里直接 `ctx.get`：
		// `apply` 执行的时刻服务可能还没起来，`ctx.get('settings')` 会拿到 undefined，
		// 迁移就静默跳过了。`inject` 的回调在服务就绪后执行（已就绪则立即执行），
		// 缺席的组合里不执行 —— 正是「可选依赖」的语义。
		ctx.inject(['settings'], () => {
			void (async () => {
				const settings = ctx.get('settings') as DshSettings | undefined;
				if (settings === undefined || typeof settings.mutate !== 'function') {
					console.log(`[${name}] 没有设置服务，旧的扁平媒体配置留在原处未迁移`);
					return;
				}
				try {
					// 深路径 op：`unset` 只能经 mutate 表达（update 只会合并、删不掉字段）
					await settings.mutate(settingsEntryId, ops);
					console.log(
						`[${name}] 已迁移旧的扁平媒体配置 → providers 字典（${Object.keys(plan.providers).join(', ') || '无' }）`,
					);
				} catch (error) {
					console.log(
						`[${name}] 迁移旧配置失败（继续用新结构）：${error instanceof Error ? error.message : String(error)}`,
					);
				}
			})();
		});

		ctx.inject(['credentials'], () => {
			void (async () => {
				const credentials = ctx.get('credentials') as CredentialService | undefined;
				if (credentials === undefined || typeof credentials.set !== 'function') return;
				for (const [ref, value] of Object.entries(plan.credentials)) {
					try {
						await credentials.set(ref, value);
					} catch (error) {
						console.log(
							`[${name}] 迁移凭据 ${ref} 失败：${error instanceof Error ? error.message : String(error)}`,
						);
					}
				}
			})();
		});
	})();

	const deps: MediaToolDeps = {
		getModels: readModels,
		getTimeoutMs: () => readConfig().timeoutMs,
		// 本地留档目录（P32）：空 = 关。每次生成都重新读，设置改了立刻生效。
		getArchiveDir: () => archiveDirHolder.get(),
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
			const store = ctx.get('attachments') as AttachmentService | undefined;
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
			const llm = ctx.get('llm') as LlmCatalogService | undefined;
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
					namespace: settingsEntryId,
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

	// ── 设计技能段落（P41→P44 修订）：注入**聊天模型**的 system prompt ──
	//
	// 与原方案的差别（用户修订）：文案不再拼接进发给生成模型的提示词（那会让
	// 画布节点回显的 prompt 混进与画面无关的整段要求），而是作为一段
	// `systemPrompt.section()` 注入**写提示词的那个大语言模型**的 system prompt
	// —— 由它自己组织出让生成模型懂、又符合设计要求的 prompt。
	//
	// 文本用**每次装配时求值的函数**现读活配置：右键切开关、设置页改文案都在下
	// 一次请求里生效（平台的 in-history 合并会跟住提示词变化，见 NOTES §3.44）。
	// **开着但文案为空串**时返回空段 —— 平台渲染会过滤空文本段，等于一字不挂；
	// `interpolate: false` 是必须的：用户可编辑的文案里出现 `{{` 不该被当成变量引用。
	// 服务缺席（裁剪过的组合）时跳过，生成管线照常。
	ctx.inject(['systemPrompt'], (withPrompt) => {
		const prompt = withPrompt.get('systemPrompt') as
			| { section(section: unknown): unknown }
			| undefined;
		if (prompt === undefined || typeof prompt.section !== 'function') {
			console.log(`[${name}] 没有 systemPrompt 服务，设计技能段落未注入（生成管线照常）`);
			return;
		}
		prompt.section({
			name: 'fatfish-canvas:design-skill',
			// 外部贡献可用任意有限 order（平台不枚举它）；放在工具类段落区
			// （1000..5000）里靠近 TOOL_GOAL 的位置，语义上牵着一个具体工具。
			order: 2401,
			interpolate: false,
			text: () => {
				const current = readConfig();
				if (current[FIELD_DESKILL_ON] === false) return '';
				const body = String(current[FIELD_DESKILL_TEXT] ?? '').trim();
				if (body === '') return '';
				return (
					'【设计技能】在你为 media_generate 工具撰写 prompt 参数时，遵循以下设计要求：\n\n' +
					body
				);
			},
		});
		console.log(`[${name}] 设计技能段落已注入 systemPrompt（fatfish-canvas:design-skill）`);
	});

	// ── 生成工具（agent 可见） ──
	ctx.inject(['tools'], (withTools) => {
		withTools.tools.register(createMediaTool(deps));
		markReady({ tool: MEDIA_TOOL_NAME });
	});

	// ── `/generate` 直达命令（不经过模型） ──
	// 与工具共用同一份管线依赖，因此两条路的模型选择与错误文案完全一致。
	ctx.inject(['commands'], (withCommands) => {
		withCommands.commands.register(createGenerateCommand(deps));
		markReady({ tool: MEDIA_TOOL_NAME, command: MEDIA_COMMAND_NAME });
	});

	// ── 设置呈现策略 ──
	//
	// 本插件自己注册了两个 `settings.section` 页面，因此关掉「自动生成页面」。
	// 走**可选子作用域**：设置服务只在自己那套依赖齐备时存在，缺席的组合里
	// 插件其余部分照常（策略也只是不生效）。
	ctx.inject(['settings'], (child) => {
		child.effect(
			() => child.settings.configure({ auto: false }, ctx.fiber),
			'fatfish-canvas: settings presentation',
		);
	});

	// ── 本地留档的取图路由（P32） ──
	//
	// 留档把生成结果写进用户指定的目录，浏览器要显示它就得有个同源地址：
	// 这一条 prefix 路由把 `/ffc-media/<相对路径>` 映射回那个目录里的文件
	// （越界一律 404，见 host/archive.ts 的 archivePathOf）。
	//
	// 为什么在**顶层**注册：它只依赖 webServer，而目录值走模块级持有
	// （`archiveDirHolder`，理由与 `probeHolder` 相同 —— 路由要在插件顶层
	// 建好，值从活配置里读，两者互不依赖）。
	//
	// ⚠️ 鉴权**必须**挂上：没有 `connection.requestRejection` 这道 Host/Origin
	// 栅栏，浏览器里任何一个恶意页面都能靠 DNS rebinding 读这个目录。
	// `connection` 缺席（无头 / 裁剪过的组合）时按放行处理 —— 那种组合里
	// 根本没有浏览器路由流量，而目录本身是用户自己的图库。
	ctx.inject(['webServer'], (withServer) => {
		const server = withServer.get('webServer') as DshWebServer | undefined;
		if (server === undefined || typeof server.register !== 'function') {
			console.log(`[${name}] 没有 webServer 服务，本地留档的取图路由未注册（画布会回退到远端地址）`);
			return;
		}
		const connection = withServer.get('connection') as DshConnection | undefined;
		const handler = createArchiveHandler({
			getDir: archiveDirHolder.get,
			...(connection === undefined || typeof connection.requestRejection !== 'function'
				? {}
				: { reject: (req: DshHttpRequest) => connection.requestRejection(req) }),
			log: (message: string): void => {
				console.log(`[${name}] ${message}`);
			},
		});
		ctx.effect(
			() =>
				server.register({
					kind: 'prefix',
					path: ARCHIVE_ROUTE_PREFIX,
					handler,
				}),
			`fatfish-canvas: GET ${ARCHIVE_ROUTE_PREFIX}/<路径>`,
		);
		console.log(`[${name}] 本地留档取图路由就绪：${ARCHIVE_ROUTE_PREFIX}/…`);
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
		writeStatus({ phase: 'host-ready', ok: false, reason: 'tools service absent', namespace: settingsEntryId });
	});
}

/** 宿主侧附件服务在本插件用到的那一面（`dsh-attachment` 的 `AttachmentStore`）。 */interface AttachmentService {
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
 * @param config - 本 entry 配置的解析值。
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
