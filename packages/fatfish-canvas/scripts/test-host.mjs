/**
 * 宿主半边单元测试：settings 注册、工具契约、图像 / 视频适配器、错误路径。
 *
 * 为什么值得单独测：宿主半边的代码在**浏览器里完全看不到**，而它的激活又需要
 * Loader 重建入口（profile 的共享 HMR 在 web 表层是关的）。把 fetch 换成可控替身
 * 之后，适配器的 URL / 请求体 / 鉴权头 / 响应解析 / 错误文案全都能在这里钉死，
 * 不必真的联网、也不必先让它在服务器上跑起来。
 *
 * 用法：node scripts/test-host.mjs
 */

import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = resolve(root, 'lib/index.js');
/** 宿主单元测试会覆盖它就绪标记，跑之前先备份。 */
const STATUS_PATH = resolve(root, 'lib/host-status.json');

let failures = 0;
const results = [];
const check = (label, ok, detail = '') => {
	if (!ok) failures += 1;
	results.push(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail === '' ? '' : ` — ${detail}`}`);
};

// ─────────────────── fetch 替身 ───────────────────

let calls = [];
/** 队列式响应：按顺序取，用完之后回落到默认响应。 */
let responder = () => ({ ok: true, status: 200, body: '{}' });

/**
 * 主 fetch 替身：按 `responder` 出响应并记录每一次调用。
 *
 * ⚠️ 探测服务那一节会**临时**把它换成自己的替身（它要按目标返回不同结果），
 * 用完必须换回来 —— 否则后面每一节的请求都会静默打到那个替身上，
 * 表现为「响应凭空变成 `{}`」（本轮就被这个泄漏咬过一次）。
 */
const mainFetch = async (url, init) => {
	calls.push({
		url: String(url),
		method: init?.method ?? 'GET',
		headers: init?.headers ?? {},
		body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
		// multipart（参考图的 /images/edits）不是字符串体：原样留一份供断言
		rawBody: init?.body,
	});
	const r = responder(String(url), init);
	return {
		ok: r.ok ?? true,
		status: r.status ?? 200,
		headers: { get: (name) => r.headers?.[name] ?? null },
		text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {})),
		arrayBuffer: async () =>
			r.bytes === undefined
				? new TextEncoder().encode(typeof r.body === 'string' ? r.body : '').buffer
				: r.bytes.buffer,
	};
};

globalThis.fetch = mainFetch;

const jsonResponder = (queue) => {
	let i = 0;
	return () => {
		const next = queue[Math.min(i, queue.length - 1)];
		i += 1;
		return next;
	};
};

// ─────────────────── 假 context ───────────────────

/** 最小 PNG 的字节头（参考图用例用它冒充图片内容）。 */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 活配置挂在替身 ctx 上的键。
 *
 * Loader 会把「这一行 `config:` 经插件 `Config` 解析后的结果」当 `apply` 的
 * **第二个参数**递进去（`.volatile()` 字段是 `{ get() }` 引用）。替身照此建模：
 * `makeCtx` 现造一份挂在 ctx 上，下面的 `mod.apply` 包装再把它递进去 ——
 * 于是几十处 `mod.apply(c)` 走的是**真实**签名。
 */
const LIVE_CONFIG = Symbol('fatfish-canvas:live-config');

/**
 * 从配置里推出「这些引用都配好了密钥」的凭据表。
 *
 * 让绝大多数用例不必自己写凭据：只有专门测「缺密钥」的用例才传空表。
 * @param config - 用户层配置。
 * @returns 引用名 → 密钥值。
 */
function autoSecrets(config) {
	const out = {};
	const providers = config?.providers;
	if (providers === null || typeof providers !== 'object') return out;
	for (const profile of Object.values(providers)) {
		if (typeof profile?.apiKeyEnv === 'string' && profile.apiKeyEnv !== '') {
			out[profile.apiKeyEnv] = 'sk-test-key';
		}
		for (const model of profile?.models ?? []) {
			if (typeof model?.apiKeyEnv === 'string' && model.apiKeyEnv !== '') {
				out[model.apiKeyEnv] = 'sk-test-key';
			}
		}
	}
	return out;
}

/**
 * 造一个只实现本插件所需面的 context。
 *
 * 两处平台契约照**当前**形状建模（都是本轮迁移点）：
 *   1. **设置分节不再由插件注册**：`settings.register(ns, schema, opts)` 没有了，
 *      服务自己从 `entry.fiber.runtime.Config` 派生分节，键是 Loader entry id。
 *      替身只留本插件真正用到的那两面：写回 `mutate(entryId, ops)` 与呈现策略
 *      `configure({ auto })`。
 *   2. **配置由 Loader 递给 apply**（第二个参数，`.volatile()` 字段是引用），
 *      不再是「注册 namespace 换一个 scope」。替身用 `mod.Config(userConfig)`
 *      现造一份活配置（与 Loader 走的是同一个 schema），挂在 ctx 上。
 * @param userConfig - 用户层配置（新结构：`{ providers: { … } }`）。
 * @param secrets - 凭据表（省略时按配置里的引用自动补 `sk-test-key`）。
 * @returns `{ ctx, captured, secrets, services, live }`。
 */
function makeCtx(userConfig, secrets) {
	const captured = {
		tools: [],
		commands: [],
		warnings: [],
		mutations: [],
		presentations: [],
		provided: {},
		typert: [],
		/** 附件服务收到的引用（用来钉「原样透传、不重拼」）。 */
		attachmentRefs: [],
		/** llm 服务公布的模型目录（`inputModalities` 缺席 = 能力未知）。 */
		llmModels: [],
		/** `systemPrompt.section()` 收到的段落（设计技能注入的判据）。 */
		promptSections: [],
	};

	const secretMap = secrets ?? autoSecrets(userConfig);

	/** Loader 会交给 `apply` 的那份活配置（字段是 `{ get() }` 引用）。 */
	const live = mod.Config({ ...(userConfig ?? {}) });

	const scoped = {
		settings: {
			// 迁移用的深路径写入口；键是 **entry id**（不再是自建 namespace）。
			mutate: async (ns, ops) => {
				captured.mutations.push({ ns, ops });
				return { ok: true };
			},
			// 呈现策略（`auto: false` = 本插件自己注册了页面，不要自动生成）
			configure: (presentation, owner) => {
				captured.presentations.push({ presentation, owner });
				return () => {};
			},
		},
		// 凭据服务：只实现本插件用到的那三个方法
		credentials: {
			resolve: async (ref) =>
				secretMap[ref] === undefined ? undefined : { value: secretMap[ref], source: 'test' },
			set: async (ref, value) => {
				secretMap[ref] = value;
			},
			unset: async (ref) => {
				delete secretMap[ref];
			},
		},
		// Typert 注册表：只记下注册过什么
		typert: {
			register(manifest) {
				captured.typert.push(manifest);
				return () => {};
			},
		},
		// llm 服务：只实现「读模型目录」这一面 —— 路由能力判据从它来
		llm: {
			listModels: async () => captured.llmModels,
		},
		// systemPrompt 服务：只实现「注册段落」这一面 —— 设计技能注入的判据从它来
		systemPrompt: {
			section(section) {
				captured.promptSections.push(section);
				return () => {};
			},
		},
		// 附件服务：只实现本插件用到的那一个方法
		// （真机返回的是**存下来的**引用，因此 MIME 由它给出，与传进来的句柄无关）
		attachments: {
			readImage: async (ref) => {
				captured.attachmentRefs.push(ref);
				return { ref: { ...ref, mediaType: 'image/png' }, data: PNG_BYTES };
			},
		},
		tools: {
			register(def) {
				captured.tools.push(def);
				return () => {};
			},
		},
		commands: {
			register(def) {
				captured.commands.push(def);
				return () => {};
			},
		},
		get: (name) => scoped[name],
		provide: (name, value) => {
			captured.provided[name] = value;
			return () => {};
		},
	};

	/**
	 * 模拟 cordis 的 `ctx.inject`：**依赖齐备时**才调用回调，回调拿到一个
	 * 「带这些服务、且可以继续 inject」的派生 context。
	 *
	 * 这里必须照实建模：早先只认 `deps.includes('tools')` 的一支，改成
	 * 「先 settings、再在回调里 inject tools/commands」的结构后就完全打不中，
	 * 表现为「什么都没注册」—— 替身比被测代码更简单地退化，是测试失真的一种。
	 *
	 * ⚠️ 派生 context 是**子 ctx**：cordis 里它继承父 ctx 的一切
	 * （`effect` / `on` / `get` / …）再叠加上声明的服务。少了 `effect`，
	 * 插件里 `child.effect(() => child.settings.configure(…))` 会直接炸。
	 */
	const runInject = (deps, callback) => {
		const arr = Array.isArray(deps) ? deps : [deps];
		const missing = arr.filter((d) => scoped[d] === undefined);
		if (missing.length > 0) return;
		callback({ ...ctx, ...scoped, inject: runInject });
	};

	const ctx = {
		effect: (fn) => {
			fn();
		},
		inject: runInject,
		get: (name) => scoped[name],
		provide: scoped.provide,
		/** 本插件的 Loader 行：`entry.options.id` 就是设置分节的键。 */
		fiber: { entry: { options: { id: 'fatfish-canvas' } } },
	};
	ctx[LIVE_CONFIG] = live;
	return { ctx, captured, secrets: secretMap, services: scoped, live };
}

/**
 * 目录 id → 该 id 在旧目录里的种类（新结构里种类挂在模型上）。
 *
 * 保留旧 id 当供应商 id 是有意的：它们是合法 slug，而这样能让「旧字段迁移」
 * 与「新结构」两套用例共用同一个 id 空间，对照起来更直观。
 */
const LEGACY_KIND = {
	'openai-images': 'image',
	'openai-videos': 'video',
	'volces-images': 'image',
	'volces-videos': 'video',
	'siliconflow-images': 'image',
	'zhipu-images': 'image',
};

/**
 * 供应商级密钥的引用名（与 shared/catalog 的推导规则一致）。
 * @param id - 供应商 id。
 * @returns 引用名。
 */
const refOf = (id) => `FFC_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;

/**
 * 造一份「某个供应商已配好基址」的新结构配置。
 *
 * `over.model` 覆盖模型 id；`over.kind` 覆盖种类；`over.provider` 合并进**供应商**
 * 条目（如 `referenceMode` / `referenceField`）；其余键合并到顶层（如 `defaultImage`）。
 * @param id - 供应商 id。
 * @param over - 覆盖项。
 * @returns 用户层配置。
 */
const configured = (id, over = {}) => {
	const { model = 'test-model', kind = LEGACY_KIND[id] ?? 'image', provider = {}, ...rest } = over;
	return {
		providers: {
			[id]: {
				label: '',
				baseURL: 'https://api.example.com/v1',
				apiKeyEnv: refOf(id),
				models: [{ id: model, kind, apiKeyEnv: '', label: '' }],
				...provider,
			},
		},
		...rest,
	};
};

// ─────────────────── 载入宿主半边 ───────────────────

console.log('\n肥鱼画布 · 宿主半边测试\n');

// 导入宿主模块会写 host-status.json，而**那个文件的真正主人是运行中的 dsh web**
// （`e2e-command.mjs` 靠它判断宿主是否已重启、命令是否已注册）。
//
// 早先的做法是「导入前备份、跑完还原」，但那只在文件本来是干净的时候成立：
// 一旦某次运行把污染写回去，之后每次「备份」都在保存污染 —— 本轮就踩到了
// （标记里出现了一个运行中宿主根本没有的 `command` 字段，e2e 会以为命令已注册）。
// 现在改成**根本不许写**：宿主模块认这个环境变量，直接跳过写盘。
process.env['FFC_NO_STATUS_WRITE'] = '1';

// 仍然读一次备份：万一将来有人去掉那个开关，至少还能还原。
let hostStatusBackup = null;
try {
	hostStatusBackup = await readFile(STATUS_PATH, 'utf8');
} catch {
	hostStatusBackup = null;
}

const host = await import(`file:///${ENTRY.replace(/\\/g, '/')}`);

/**
 * 平台契约的替身包装：Loader 把**活配置**当 `apply` 的第二个参数。
 *
 * `makeCtx` 把那份活配置挂在 ctx 上（`LIVE_CONFIG`），这里补上第二个参数 ——
 * 下面几十处 `mod.apply(c)` 因此不用动，走的却是真实签名。行里没写 `config:`
 * 时 Loader 也会给一份完整默认值，所以兜底同样是 `Config({})`。
 */
const mod = {
	...host,
	apply: (ctx, config) => host.apply(ctx, config ?? ctx[LIVE_CONFIG] ?? host.Config({})),
};

/**
 * 内置设计技能文案（schema 缺省值，P41）。
 *
 * P44 修订：它不再拼进生成请求的 prompt（下面的「prompt 全等」断言因此回到了
 * 原文），而是注入**聊天模型**的 system prompt —— 判据改为直接调
 * `systemPrompt.section()` 收到的段落的 text 函数。
 */
const DEFAULT_SKILL = host.Config({}).designSkill.get();

/**
 * 一个顶层字段在 `Config` 里是不是 `.volatile()`。
 *
 * `toJSON()` 是**引用图**（`{ uid, refs }`，`refs` 的键是字符串化的 uid），
 * 因此先找到那个声明了这个字段的对象节点，再按 id 回查它的 meta。
 * @param field - 顶层字段名。
 * @returns 是否带 volatile 标记。
 */
const configFieldIsVolatile = (field) => {
	const refs = mod.Config.toJSON().refs ?? {};
	const owner = Object.values(refs).find((node) => node?.dict && Object.hasOwn(node.dict, field));
	const id = owner?.dict?.[field];
	return id !== undefined && refs[String(id)]?.meta?.volatile === true;
};

// ─────────── 1. settings 注册 ───────────
console.log('1) Config（设置分节按 Loader entry id 派生）');

const { ctx, captured } = makeCtx();
mod.apply(ctx);

check('导出 apply / inject / name', typeof mod.apply === 'function' && Array.isArray(mod.inject));
check(
	'导出 Config（Loader 读的是入口模块的 `plugin.Config`）',
	typeof mod.Config === 'function' && typeof mod.Config.toJSON === 'function',
	typeof mod.Config,
);
check(
	'Config 是真正的 schemastery schema（`"toJSON" in schema` 是设置服务的判据）',
	'toJSON' in mod.Config,
);
const schemaJson = JSON.stringify(mod.Config.toJSON());
check(
	'声明了 providers 字典字段（用户可以随意加供应商，字段不需要预先声明）',
	schemaJson.includes('"type":"dict"'),
	schemaJson.slice(0, 140),
);
check(
	'声明了默认图像 / 视频模型字段',
	schemaJson.includes('defaultImage') && schemaJson.includes('defaultVideo'),
);
{
	// 设置服务只把 **volatile** 字段放进分节（`volatileForm`），也只接受落在
	// volatile 节点下的写路径（`isVolatilePath`）。少标一个，症状分别是
	// 「设置页看不见它」与「写回被拒」——两者都不会在加载期报错。
	const volatileFields = ['providers', 'defaultImage', 'defaultVideo', 'defaultVision', 'defaultTiers', 'commonModels', 'timeoutMs', 'maxNodeSize', 'designSkill', 'designSkillOn', 'archiveDir'];
	const missing = volatileFields.filter((field) => !configFieldIsVolatile(field));
	check(
		`${String(volatileFields.length)} 个业务字段全部 .volatile()（否则设置页读不到、也写不进）`,
		missing.length === 0,
		missing.join(', '),
	);
}
{
	// 活配置：`apply(ctx, config)` 拿到的每个字段都是稳定引用（读当前值走 get()）。
	const live = mod.Config({ providers: { acme: { baseURL: 'https://x/v1', apiKeyEnv: 'FFC_ACME_API_KEY', models: [] } } });
	check(
		'活配置的字段是 `{ get() }` 引用（Loader 就地更新，读值走 get）',
		typeof live.providers?.get === 'function' &&
			typeof live.timeoutMs?.get === 'function' &&
			live.timeoutMs.get() === 600000,
		JSON.stringify(Object.keys(live)),
	);
	check(
		'providers 里的 apiKeyEnv 是照实下发的普通字符串（引用名，不是机密）',
		live.providers.get()?.acme?.apiKeyEnv === 'FFC_ACME_API_KEY',
		JSON.stringify(live.providers.get()?.acme ?? null),
	);
	check(
		'没有 default 的旧字段缺席时 get() 回 undefined（迁移靠这个判断要不要 unset）',
		live.key_openai_images?.get() === undefined,
		String(live.key_openai_images?.get()),
	);
	check(
		'设计技能缺省是开着（尾巴右键的关闭态必须显式写 false，缺席一律按开算）',
		live.designSkillOn?.get() === true,
		String(live.designSkillOn?.get()),
	);
	check(
		'设计技能文案缺省 = 内置那份（非空多行的行为要求，不是【设计要求】式标题）',
		typeof live.designSkill?.get() === 'string' &&
			live.designSkill.get().length >= 40 &&
			live.designSkill.get().startsWith('- 主体清晰'),
		String(live.designSkill?.get()).slice(0, 40),
	);
}
{
	// 旧扁平字段（P8 及以前）仍然必须留在 schema 里：不在 schema 里的残留字段
	// **不会被脱敏**，留在文档里的旧明文密钥会被原样下发到浏览器。
	// 它们由宿主启动时的迁移清掉，但声明必须一直在 —— 而且要 volatile，
	// 否则那次 unset 会被设置服务拒掉（写路径只认 volatile 节点）。
	const catalog = [
		'openai-images',
		'openai-videos',
		'volces-images',
		'volces-videos',
		'siliconflow-images',
		'zhipu-images',
	];
	const missing = catalog.filter((id) => {
		const stem = id.replace(/-/g, '_');
		return (
			!schemaJson.includes(`key_${stem}`) ||
			!schemaJson.includes(`model_${stem}`) ||
			!schemaJson.includes(`baseURL_${stem}`)
		);
	});
	check(
		`旧目录 ${String(catalog.length)} 个 id 的 key_/model_/baseURL_ 字段仍然声明着（迁移用）`,
		missing.length === 0,
		missing.join(', '),
	);
	check(
		'旧密钥字段带 secret 角色且没有 default（否则会随 schema 泄露）',
		schemaJson.includes('"role":"secret"') && !/"role":"secret"[^}]*"default"/.test(schemaJson),
	);
	check(
		'旧字段也是 volatile（迁移的 unset 走设置服务，非 volatile 路径会被拒）',
		configFieldIsVolatile('key_openai_images') && configFieldIsVolatile('model_volces_videos'),
	);
}
{
	// 设置呈现策略：本插件自己注册了 `settings.section`，因此要关掉自动页面。
	const { ctx: c, captured: cap } = makeCtx();
	mod.apply(c);
	check(
		'在 settings 就绪时声明 `auto: false`（本插件自带设置页）',
		cap.presentations.length === 1 && cap.presentations[0]?.presentation?.auto === false,
		JSON.stringify(cap.presentations),
	);
	check(
		'策略挂在**本插件自己的 fiber** 上（服务按 fiber 记住策略）',
		cap.presentations[0]?.owner === c.fiber,
		String(cap.presentations[0]?.owner === c.fiber),
	);
}
{
	// 旧配置迁移：写回要按 **Loader entry id** 寻址（从前是自建 namespace）。
	const legacy = {
		key_openai_images: 'sk-old-openai',
		model_openai_images: 'gpt-image-1',
		baseURL_openai_images: 'https://old.example.com',
		// 空串的旧字段**不再**产生 unset（只清真的存过值的）—— 见下面第二条断言。
		baseURL_volces_images: '',
	};
	const made = makeCtx(legacy);
	mod.apply(made.ctx);
	// 迁移是 `void (async () => …)()`：让微任务跑完再看替身收到了什么
	await new Promise((resolve) => setTimeout(resolve, 0));
	const cap = made.captured;
	check(
		'旧字段迁移：写回用 Loader entry id（不再是 `media-generation`）',
		cap.mutations.length === 1 && cap.mutations[0]?.ns === 'fatfish-canvas',
		JSON.stringify(cap.mutations.map((m) => m.ns)),
	);
	const ops = cap.mutations[0]?.ops ?? [];
	const labels = ops.map((op) => `${op.op}:${op.path.join('.')}`);
	check(
		'旧字段迁移：旧字段 unset + 新结构 set（一次 mutate 里全做完）',
		labels[0] === 'unset:key_openai_images' &&
			labels.includes('unset:model_openai_images') &&
			labels.includes('unset:baseURL_openai_images') &&
			labels.at(-1) === 'set:providers' &&
			ops.at(-1)?.value?.openai?.models?.[0]?.id === 'gpt-image-1',
		JSON.stringify(labels),
	);
	check(
		'旧字段迁移：空串的旧字段不产生 unset（只清真的存过值的 —— 否则 schema 默认值让判据恒真，每次启动都白写一遍 profile）',
		!labels.includes('unset:baseURL_volces_images'),
		JSON.stringify(labels),
	);
	check(
		'旧明文密钥没有留在设置里（unset 掉，值搬进凭据库）',
		labels.includes('unset:key_openai_images') &&
			!labels.some((label) => label.startsWith('set:key_')) &&
			made.secrets['FFC_OPENAI_API_KEY'] === 'sk-old-openai',
		`key=${String(made.secrets['FFC_OPENAI_API_KEY'])}`,
	);
}
{
	// 设置服务缺席（裁剪过的组合）：旧字段留着不动，其余功能照常。
	const legacy = { key_openai_images: 'sk-old-openai', model_openai_images: 'gpt-image-1' };
	const made = makeCtx(legacy);
	delete made.services.settings;
	mod.apply(made.ctx);
	await new Promise((resolve) => setTimeout(resolve, 0));
	check(
		'设置服务缺席时不写回（不抛错，旧字段留在原处）',
		made.captured.mutations.length === 0 && made.captured.tools.length === 1,
		`mutations=${String(made.captured.mutations.length)} tools=${String(made.captured.tools.length)}`,
	);
}

// ─────────── 2. 工具契约 ───────────
console.log('\n2) media_generate 工具契约');

const tool = captured.tools[0];
check('注册了恰好 1 个工具', captured.tools.length === 1, `${String(captured.tools.length)} 个`);
check('工具名正确', tool?.name === 'media_generate', String(tool?.name));
check('description 非空且提示了未配置的情况',
	typeof tool?.description === 'string' && tool.description.includes('配置'));
check('parameters.required 含 prompt', tool?.parameters?.required?.includes('prompt') === true);
check('parameters.properties.kind 是 image/video 枚举',
	JSON.stringify(tool?.parameters?.properties?.kind?.enum) === '["image","video"]');
check('parameters.properties.reference 收**字符串或数组**（一张写字符串、多张写数组）',
	Array.isArray(tool?.parameters?.properties?.reference?.oneOf) &&
		tool.parameters.properties.reference.oneOf.length === 2 &&
		tool.parameters.properties.reference.oneOf[0]?.type === 'string' &&
		tool.parameters.properties.reference.oneOf[1]?.type === 'array' &&
		tool.parameters.properties.reference.oneOf[1]?.items?.type === 'string',
	JSON.stringify(tool?.parameters?.properties?.reference?.oneOf));
check('结果 schema 里声明了 referenceCount（客户端据此显示「参考图 N 张」）',
	tool?.output?.schema?.properties?.referenceCount?.type === 'number');
check('声明了 output.schema', typeof tool?.output?.schema === 'object');
check('声明了 output.render', typeof tool?.output?.render === 'function');
check('声明了 output.presentationMeta', typeof tool?.output?.presentationMeta === 'function');
check('execute 是函数', typeof tool?.execute === 'function');

const sampleValue = {
	kind: 'image',
	url: 'https://cdn.example.com/a.png',
	model: 'm',
	providerId: 'p',
	prompt: '一只柴犬',
	aspectRatio: '16:9',
	width: 1024,
	height: 1024,
};
const rendered = tool.output.render({ prompt: '一只柴犬' }, sampleValue);
check('render 产出单个 text 块',
	Array.isArray(rendered) && rendered.length === 1 && rendered[0].type === 'text');
check('render 的正文包含媒体地址', String(rendered[0].text).includes(sampleValue.url));

const meta = tool.output.presentationMeta({ prompt: '一只柴犬' }, sampleValue);
check('presentationMeta 把结果放在 fatfishCanvas 之下',
	meta?.fatfishCanvas?.url === sampleValue.url && meta.fatfishCanvas.kind === 'image');
check('presentationMeta 带上画幅比例（客户端据此先定节点形状）',
	meta?.fatfishCanvas?.aspectRatio === '16:9', String(meta?.fatfishCanvas?.aspectRatio));
check('presentationMeta 的键名与客户端共享常量一致（不可各写一份字面量）',
	Object.keys(meta ?? {}).join(',') === 'fatfishCanvas', Object.keys(meta ?? {}).join(','));
check('output.schema 要求 aspectRatio（客户端据此断言结果形状）',
	tool?.output?.schema?.required?.includes('aspectRatio') === true,
	JSON.stringify(tool?.output?.schema?.required));
check('presentationMeta 是 JSON 安全的（无函数/循环）',
	(() => {
		try {
			JSON.stringify(meta);
			return true;
		} catch {
			return false;
		}
	})());

// ─────────── 3. 图像适配器 ───────────
console.log('\n3) 图像适配器（openai-images）');

{
	const { ctx: c, captured: cap } = makeCtx(configured('openai-images'));
	mod.apply(c);
	const t = cap.tools[0];
	calls = [];
	responder = () => ({ ok: true, status: 200, body: { data: [{ url: 'https://cdn.example.com/out.png' }] } });

	const value = await t.execute({ prompt: '一只柴犬', aspectRatio: '16:9' }, { signal: undefined });

	check('请求打到 {base}/images/generations',
		calls[0]?.url === 'https://api.example.com/v1/images/generations', String(calls[0]?.url));
	check('使用 POST', calls[0]?.method === 'POST');
	check('带上 Bearer 鉴权头',
		String(calls[0]?.headers?.authorization) === 'Bearer sk-test-key',
		String(calls[0]?.headers?.authorization));
	check('请求体带 model / prompt / n=1（prompt 就是模型给的那句，一字不加）',
		calls[0]?.body?.model === 'test-model' &&
			calls[0]?.body?.prompt === `一只柴犬` &&
			calls[0]?.body?.n === 1,
		JSON.stringify(calls[0]?.body?.prompt).slice(0, 60));
	check('16:9 映射为 1792x1024（jaaz 声明的合法比例）',
		calls[0]?.body?.size === '1792x1024', String(calls[0]?.body?.size));
	check('返回值是 canonical 形状',
		value.kind === 'image' && value.url === 'https://cdn.example.com/out.png' && value.providerId === 'openai-images');
	check('返回值回带本次实际使用的画幅比例',
		value.aspectRatio === '16:9', String(value.aspectRatio));
	check('画幅比例随 presentationMeta 一起到达客户端',
		t.output.presentationMeta({}, value)?.fatfishCanvas?.aspectRatio === '16:9');
}

{
	// 设计技能（P41→P44 修订）：文案不再拼进请求体 —— 它注入**聊天模型**的
	// system prompt，由模型自己组织提示词（见 src/index.ts 的段落注册）。
	const { ctx: c, captured: cap } = makeCtx(configured('openai-images'));
	mod.apply(c);

	const skill = cap.promptSections[0];
	check('设计技能段落注册了恰好一段（名字指向本插件）',
		cap.promptSections.length === 1 && skill?.name === 'fatfish-canvas:design-skill',
		JSON.stringify(cap.promptSections.map((s) => s?.name)));
	check('order 是有限数（平台要求；外部贡献可用任意有限值）', Number.isFinite(skill?.order),
		String(skill?.order));
	check('interpolate 是 false（用户可编辑的文案里出现 {{ 不能被当成变量引用炸掉装配）',
		skill?.interpolate === false, String(skill?.interpolate));

	// ① 缺省（两个字段都没配）= 开，text() 给出「标题 + 内置文案」
	const defText = typeof skill?.text === 'function' ? skill.text() : undefined;
	check('缺省开：text() = 注入语引导语 + 内置文案',
		typeof defText === 'string' &&
			defText.startsWith('【设计技能】') &&
			defText.includes('media_generate') &&
			defText.endsWith(DEFAULT_SKILL),
		String(defText).slice(0, 80));

	// ② 开着但文案被清空 → 空文本段（平台渲染会过滤空段，等于一字不挂）
	const emptyCtx = makeCtx(
		configured('openai-images', { designSkill: '' }),
	);
	mod.apply(emptyCtx.ctx);
	const emptyText = typeof emptyCtx.captured.promptSections[0]?.text === 'function'
		? emptyCtx.captured.promptSections[0].text()
		: undefined;
	check('开着但文案为空：text() 也是空串（渲染时会被平台滤掉）', emptyText === '', JSON.stringify(emptyText));

	// ③ 显式关闭 → 空文本段（这个开关的全部语义就是「一滴也不要」）
	const offCtx = makeCtx(
		configured('openai-images', { designSkillOn: false }),
	);
	mod.apply(offCtx.ctx);
	const offText = typeof offCtx.captured.promptSections[0]?.text === 'function'
		? offCtx.captured.promptSections[0].text()
		: undefined;
	check('显式关闭：text() 是空串（system prompt 里不会再有这段）', offText === '', JSON.stringify(offText));

	// ④ 文案随请求装配现读（text 是函数而不是注册时的字符串快照）
	check('text 是函数（每次装配现读活配置，改设置 / 右键切开关都下一次请求就生效）',
		typeof skill?.text === 'function',
		typeof skill?.text);
}

{
	// b64_json 分支
	const { ctx: c, captured: cap } = makeCtx(configured('openai-images'));
	mod.apply(c);
	const t = cap.tools[0];
	calls = [];
	responder = () => ({ ok: true, status: 200, body: { data: [{ b64_json: 'QUJD', mime_type: 'image/webp' }] } });

	const value = await t.execute({ prompt: 'x' }, {});
	check('b64_json 转成 data URL',
		value.url === 'data:image/webp;base64,QUJD', String(value.url));
	check('同时记录 mimeType', value.mimeType === 'image/webp');
}

{
	// HTTP 错误
	const { ctx: c, captured: cap } = makeCtx(configured('openai-images'));
	mod.apply(c);
	const t = cap.tools[0];
	calls = [];
	responder = () => ({ ok: false, status: 401, body: '{"error":{"message":"invalid key"}}' });

	let message = '';
	try {
		await t.execute({ prompt: 'x' }, {});
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	check('非 2xx 报出可读错误（含状态码与响应片段）',
		message.includes('401') && message.includes('invalid key'), message.slice(0, 120));
}

{
	// 基址漏了 /v1：图像端点回的是中转站的 HTML 首页（实测 451）
	const { ctx: c, captured: cap } = makeCtx(configured('openai-images'));
	mod.apply(c);
	const t = cap.tools[0];
	calls = [];
	responder = () => ({
		ok: false,
		status: 451,
		body: '<!doctype html><html><head><title>某中转站</title></head><body>x</body></html>',
	});

	let message = '';
	try {
		await t.execute({ prompt: 'x' }, {});
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	check('图像端点回 HTML 时点出基址问题（而不是甩一页 doctype）',
		message.includes('网页而不是 API') && !message.includes('doctype'), message.slice(0, 140));
}

// ─────────── 4. 视频适配器 ───────────
console.log('\n4) 视频适配器（openai-videos）');

{
	// 直接出片
	const { ctx: c, captured: cap } = makeCtx(
		configured('openai-videos', { model: 'sora-2' }),
	);
	mod.apply(c);
	const t = cap.tools[0];
	calls = [];
	responder = () => ({ ok: true, status: 200, body: { data: [{ url: 'https://cdn.example.com/v.mp4' }] } });

	const value = await t.execute({ prompt: '一只猫在跑', kind: 'video' }, {});
	check('视频请求打到 {base}/videos/generations',
		calls[0]?.url === 'https://api.example.com/v1/videos/generations');
	check('请求体带 duration / resolution',
		calls[0]?.body?.duration === 5 && calls[0]?.body?.resolution === '480p');
	check('直接出片时立刻返回 url',
		value.kind === 'video' && value.url === 'https://cdn.example.com/v.mp4');
}

{
	// 任务式：先返回 id，再轮询到完成
	const { ctx: c, captured: cap } = makeCtx(configured('openai-videos', { model: 'seedance' }));
	mod.apply(c);
	const t = cap.tools[0];
	calls = [];
	responder = jsonResponder([
		{ ok: true, status: 200, body: { id: 'task-123' } },
		{ ok: true, status: 200, body: { status: 'running' } },
		{ ok: true, status: 200, body: { status: 'succeeded', content: { video_url: 'https://cdn.example.com/done.mp4' } } },
	]);

	const value = await t.execute({ prompt: '一只猫在跑', kind: 'video' }, {});
	check('任务式：轮询地址为 {base}/videos/generations/{id}',
		calls[1]?.url === 'https://api.example.com/v1/videos/generations/task-123', String(calls[1]?.url));
	check('轮询用 GET', calls[1]?.method === 'GET');
	check('从 content.video_url 取到结果',
		value.url === 'https://cdn.example.com/done.mp4', String(value.url));
}

{
	// 换路径：中转站（贞贞工坊实测）只有单数 /video/generations，复数路径回自家 HTML 首页
	const { ctx: c, captured: cap } = makeCtx(configured('openai-videos', { model: 'seedance' }));
	mod.apply(c);
	const t = cap.tools[0];
	calls = [];
	responder = jsonResponder([
		{ ok: false, status: 451, body: '<!doctype html><html><head><title>贞贞的AI工坊</title></head></html>' },
		{ ok: true, status: 200, body: { task_id: 'task-9' } },
		{ ok: true, status: 200, body: { status: 'succeeded', data: [{ url: 'https://cdn.example.com/alt.mp4' }] } },
	]);

	const value = await t.execute({ prompt: '一只猫在跑', kind: 'video' }, {});
	check('复数视频路径回网页时改用单数路径',
		calls[1]?.url === 'https://api.example.com/v1/video/generations', String(calls[1]?.url));
	check('轮询跟着用真正生效的那条路径',
		calls[2]?.url === 'https://api.example.com/v1/video/generations/task-9', String(calls[2]?.url));
	check('换路径后照样拿到视频', value.url === 'https://cdn.example.com/alt.mp4', String(value.url));
}

{
	// 换路径（同一根因的另一种长相）：api.seedance.nz 实测，不存在的路由回的是
	// JSON 404（Invalid URL），不是网页 —— 只看 htmlPage 就会把它当业务错误抛出，
	// 永远试不到单数路径。
	const { ctx: c, captured: cap } = makeCtx(configured('openai-videos', { model: 'seedance' }));
	mod.apply(c);
	const t = cap.tools[0];
	calls = [];
	responder = jsonResponder([
		{
			ok: false,
			status: 404,
			body: {
				error: {
					message: 'Invalid URL (POST /v1/videos/generations)',
					type: 'invalid_request_error',
				},
			},
		},
		{ ok: true, status: 200, body: { data: [{ url: 'https://cdn.example.com/json404.mp4' }] } },
	]);

	const value = await t.execute({ prompt: '一只猫在跑', kind: 'video' }, {});
	check('复数视频路径回 JSON 404 时也改用单数路径',
		calls[1]?.url === 'https://api.example.com/v1/video/generations', String(calls[1]?.url));
	check('JSON 404 换路径后照样拿到视频',
		value.url === 'https://cdn.example.com/json404.mp4', String(value.url));
}

{
	// 轮询落点按形状认：`data` 是**对象**（不是数组）时也要挖得出 video_url，
	// 同时不能把回显的参考图地址（image_url.url）当成视频。
	const { ctx: c, captured: cap } = makeCtx(configured('openai-videos', { model: 'seedance' }));
	mod.apply(c);
	const t = cap.tools[0];
	calls = [];
	responder = jsonResponder([
		{ ok: true, status: 200, body: { id: 'task-shape-1' } },
		{
			ok: true,
			status: 200,
			body: {
				code: 0,
				data: { status: 'completed', video_url: 'https://cdn.example.com/nested.mp4' },
				image_url: { url: 'https://cdn.example.com/reference.jpg' },
			},
		},
	]);

	const value = await t.execute({ prompt: '一只猫在跑', kind: 'video' }, {});
	check('轮询响应里 data 对象嵌套时也认得出 video_url',
		value.url === 'https://cdn.example.com/nested.mp4', String(value.url));
}

{
	// 真实响应形状：api.seedance.nz（new-api 系）2026-10-06 实测原文（已裁剪）。
	// 三条落点里两条不带 "video"（data.result_url / results[].url），
	// 所以 result_url 必须显式列在候选里，不能只靠形状兜底。
	const { ctx: c, captured: cap } = makeCtx(configured('openai-videos', { model: 'seedance' }));
	mod.apply(c);
	const t = cap.tools[0];
	calls = [];
	responder = jsonResponder([
		{ ok: true, status: 200, body: { code: 'success', data: { task_id: 'task_UscRvAq3' } } },
		{
			ok: true,
			status: 200,
			body: {
				code: 'success',
				message: '',
				data: {
					id: 844843,
					task_id: 'task_UscRvAq3',
					action: 'referenceGenerate',
					status: 'SUCCESS',
					fail_reason: '',
					result_url: 'https://cdn.example.com/newapi.mp4',
					progress: '100%',
					data: {
						content: {
							video_url: 'https://cdn.example.com/newapi-nested.mp4',
						},
						status: 'succeeded',
						upstream: { response: { results: [{ outputType: 'mp4', url: 'https://cdn.example.com/newapi-upstream.mp4' }] } },
					},
				},
			},
		},
	]);

	const value = await t.execute({ prompt: '一只猫在跑', kind: 'video' }, {});
	check('new-api 形状：直接认 data.result_url',
		value.url === 'https://cdn.example.com/newapi.mp4', String(value.url));
}

{
	// 失败状态
	const { ctx: c, captured: cap } = makeCtx(configured('openai-videos'));
	mod.apply(c);
	const t = cap.tools[0];
	calls = [];
	responder = jsonResponder([
		{ ok: true, status: 200, body: { task_id: 't1' } },
		{ ok: true, status: 200, body: { status: 'failed', error: 'quota' } },
	]);

	let message = '';
	try {
		await t.execute({ prompt: 'x', kind: 'video' }, {});
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	check('任务失败时报出可读错误', message.includes('failed'), message.slice(0, 120));
}

{
	// seedance-nz 协议（`minimax-h3-ow-*` 那一族）：字段名与缺省那套**逐个不同**，
	// 照 api.seedance.nz 的文档拼 —— 少对上一个，网关要么 400、要么静默用默认档。
	const minimaxCtx = (over = {}) => {
		const { ctx: c, captured: cap } = makeCtx(
			configured('openai-videos', { model: 'minimax-h3-ow-r2v', ...over }),
		);
		mod.apply(c);
		calls = [];
		responder = () => ({ ok: true, status: 200, body: { data: [{ url: 'https://cdn.example.com/m.mp4' }] } });
		return cap.tools[0];
	};

	// 设置里没填 → 由**工具参数**兜底（分辨率要自动大写：协议是 480P，工具给的是 480p）
	const plain = minimaxCtx();
	await plain.execute(
		{ prompt: 'x', kind: 'video', duration: 15, resolution: '1080p', aspectRatio: '9:16' },
		{},
	);
	const fallback = calls[0]?.body ?? {};
	check('seedance-nz：工具参数兜底，分辨率自动大写',
		fallback.seconds === '15' &&
			fallback.metadata?.resolution === '1080P' &&
			fallback.metadata?.ratio === '9:16',
		JSON.stringify(fallback.metadata));

	// 设置里填了默认档 → 以那份为准（与缺省那套同一套规矩：设置里的值排在工具参数之后）
	const tuned = minimaxCtx({
		commonModels: {
			'openai-videos::minimax-h3-ow-r2v': {
				params: { seconds: '10', resolution: '768P', ratio: '2:3' },
			},
		},
	});
	await tuned.execute(
		{
			prompt: '把这两张合成一个镜头',
			kind: 'video',
			reference: ['https://cdn.example.com/a.png', 'https://cdn.example.com/b.png'],
		},
		{},
	);
	const body = calls[0]?.body ?? {};
	check('seedance-nz：体是 { model, prompt, images[], seconds, metadata }（设置里的默认值生效）',
		body.model === 'minimax-h3-ow-r2v' &&
			Array.isArray(body.images) &&
			body.images.length === 2 &&
			body.seconds === '10' &&
			body.metadata?.resolution === '768P' &&
			body.metadata?.ratio === '2:3',
		JSON.stringify(body));
	check('seedance-nz：不夹带缺省那套的字段（duration / resolution / aspect_ratio / image 一个都不发）',
		body.duration === undefined &&
			body.resolution === undefined &&
			body.aspect_ratio === undefined &&
			body.image === undefined,
		JSON.stringify(Object.keys(body)));
}

// ─────────── 5. 未配置与错误路径 ───────────
console.log('\n5) 未配置时的错误路径');

{
	// 有供应商但没有密钥
	const { ctx: c, captured: cap } = makeCtx({});
	mod.apply(c);
	const t = cap.tools[0];
	let message = '';
	try {
		await t.execute({ prompt: 'x' }, {});
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	check('未配置密钥时提示去设置页填写',
		message.includes('设置') && message.includes('密钥'), message.slice(0, 140));
}

{
	// 完全没有图像供应商
	const { ctx: c, captured: cap } = makeCtx({});
	mod.apply(c);
	const t = cap.tools[0];
	let message = '';
	try {
		await t.execute({ prompt: 'x', kind: 'image' }, {});
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	check('完全没有可用供应商时给出可操作提示（指向设置页）',
		message.includes('图像') && message.includes('设置') && message.includes('密钥'), message.slice(0, 140));
}

{
	// 指定了不存在的供应商 id
	const { ctx: c, captured: cap } = makeCtx(configured('openai-images'));
	mod.apply(c);
	const t = cap.tools[0];
	let message = '';
	try {
		await t.execute({ prompt: 'x', provider: 'nope' }, {});
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	check('未知供应商 id 时报错并列出可用项',
		message.includes('nope') && message.includes('openai-images'), message.slice(0, 140));
}

{
	// 默认供应商优先，且跳过没密钥的
	const { ctx: c, captured: cap } = makeCtx(
		configured('openai-images', { defaultImage: 'volces-images::test-model' }),
	);
	mod.apply(c);
	const t = cap.tools[0];
	calls = [];
	responder = () => ({ ok: true, status: 200, body: { data: [{ url: 'https://cdn.example.com/ok.png' }] } });
	const value = await t.execute({ prompt: 'x' }, {});
	check('默认供应商没密钥时自动回落到有密钥的那个',
		value.providerId === 'openai-images', String(value.providerId));
}

// ─────────── 6. 空 prompt ───────────
console.log('\n6) 参数校验');
{
	const { ctx: c, captured: cap } = makeCtx(configured('openai-images'));
	mod.apply(c);
	const t = cap.tools[0];
	let message = '';
	try {
		await t.execute({ prompt: '   ' }, {});
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	check('空 prompt 被拒', message.includes('prompt'), message.slice(0, 80));

	const card = t.presentCall({ prompt: '一只柴犬', kind: 'video' });
	check('presentCall 给出「生成视频」标题',
		String(card?.title).includes('视频'), JSON.stringify(card));
}

// ─────────── 7. `/generate` 直达命令（P6） ───────────
console.log('\n7) /generate 直达命令');
{
	const { ctx: c, captured: cap } = makeCtx(configured('openai-images'));
	mod.apply(c);
	const command = cap.commands[0];

	check('注册了恰好 1 条命令', cap.commands.length === 1, `${String(cap.commands.length)} 条`);
	check('命令名是 generate（不带斜杠、小写）', command?.name === 'generate', String(command?.name));
	check(
		'命令描述非空且说明了「不经过模型」',
		typeof command?.description === 'string' && command.description.includes('不经过模型'),
		String(command?.description),
	);
	check('声明了输入提示（composer 用）', typeof command?.input?.hint === 'string' && command.input.hint !== '');
	check('handler 是函数', typeof command?.handler === 'function');
	check('保留输入原文（recordInput）', command?.recordInput === true);

	// ── 参数语法 ──
	const run = (rawInput) => command.handler({ rawInput, signal: undefined });

	check(
		'空输入 → 错误 + 用法',
		(await run('')).kind === 'error' && (await run('')).text.includes('用法'),
		(await run('')).text?.slice(0, 60),
	);
	check(
		'未知开关 → 明确报错（不静默忽略）',
		(await run('--nope 一只鱼')).text.includes('未知参数 --nope'),
		(await run('--nope 一只鱼')).text,
	);
	check(
		'缺少取值 → 报错',
		(await run('--ratio')).text.includes('缺少取值'),
		(await run('--ratio')).text,
	);
	check(
		'非法比例 → 报错并列出合法值',
		(await run('--ratio 5:4 一只鱼')).text.includes('1:1'),
		(await run('--ratio 5:4 一只鱼')).text,
	);
	check(
		'没有提示词（只有开关）→ 报错',
		(await run('--video')).text.includes('缺少提示词'),
		(await run('--video')).text,
	);

	// ── 成功路径 ──
	calls = [];
	responder = () => ({ ok: true, status: 200, body: { data: [{ url: 'https://cdn.example.com/cmd.png' }] } });
	const ok = await run('--ratio 16:9 一只柴犬');
	check('成功结果是 success', ok.kind === 'success', JSON.stringify(ok));
	check(
		'成功文本的第一行就是媒体地址（客户端据此还原媒体）',
		ok.text.split('\n')[0] === 'https://cdn.example.com/cmd.png',
		JSON.stringify(ok.text),
	);
	check(
		'第二行是给人看的小结（种类 · 模型 · 比例）',
		ok.text.split('\n')[1].includes('图像') &&
			ok.text.split('\n')[1].includes('test-model') &&
			ok.text.split('\n')[1].includes('16:9'),
		ok.text.split('\n')[1],
	);
	check('命令走的是同一条适配器管线（16:9 → 1792x1024）',
		calls[0]?.body?.size === '1792x1024', String(calls[0]?.body?.size));
	check('命令请求体带提示词（与工具同一条管线）', calls[0]?.body?.prompt === `一只柴犬`, String(calls[0]?.body?.prompt));

	// ── 与工具共用管线：同一个错误，两种入口说法一致 ──
	{
		const { ctx: c2, captured: cap2 } = makeCtx();
		mod.apply(c2);
		const tool2 = cap2.tools[0];
		const command2 = cap2.commands[0];
		let toolMessage = '';
		try {
			await tool2.execute({ prompt: 'x' }, {});
		} catch (error) {
			toolMessage = error instanceof Error ? error.message : String(error);
		}
		const cmdResult = await command2.handler({ rawInput: 'x', signal: undefined });
		check(
			'没配置密钥时：命令把它变成 error 结果（而不是抛出去）',
			cmdResult.kind === 'error', JSON.stringify(cmdResult).slice(0, 80),
		);
		check(
			'命令与工具的错误文案**同源**（同一条管线）',
			cmdResult.text.startsWith(toolMessage),
			`command=${cmdResult.text.slice(0, 40)} tool=${toolMessage.slice(0, 40)}`,
		);
		check(
			'错误里也带上用法（用户下一步就是改参数重敲）',
			cmdResult.text.includes('用法'), cmdResult.text.slice(-40),
		);
	}
}

// ─────────── 8. `/generate` 的命令行语法（两半边共用） ───────────
console.log('\n8) /generate 命令行语法');
{
	const media = await import(
		`file:///${resolve(root, 'lib/client/shared/media.js').replace(/\\/g, '/')}`
	);

	/** 成功解析后的参数。 */
	const argsOf = (line) => {
		const parsed = media.parseGenerateLine(line);
		return parsed.ok ? parsed.args : null;
	};

	check('纯提示词 → 图像 + 原文', (() => {
		const a = argsOf('一只肥鱼');
		return a !== null && a.prompt === '一只肥鱼' && a.kind === 'image' && a.aspectRatio === undefined;
	})(), JSON.stringify(argsOf('一只肥鱼')));
	check('--video 简写切到视频', argsOf('--video 海浪')?.kind === 'video');
	check('--kind video 与 --video 等价', argsOf('--kind video 海浪')?.kind === 'video');
	check('--kind=image 的等号写法也收', argsOf('--kind=image 猫')?.kind === 'image');
	check('--ratio 被解析', argsOf('--ratio 9:16 竖图')?.aspectRatio === '9:16');
	check('--duration 被解析成数字', argsOf('--duration 10 视频')?.duration === 10);
	check('--provider 被解析', argsOf('--provider volces-images 猫')?.provider === 'volces-images');
	check('--ref 被解析成参考图地址（单张 = 一个元素的数组）',
		JSON.stringify(argsOf('--ref https://x/y.png 换个风格')?.references) === '["https://x/y.png"]' &&
			argsOf('--ref https://x/y.png 换个风格')?.prompt === '换个风格',
		JSON.stringify(argsOf('--ref https://x/y.png 换个风格')));
	check('--ref 可重复，且**按写的顺序**收集（顺序会一路进请求体）',
		JSON.stringify(argsOf('--ref https://x/a.png --ref https://x/b.png 融合')?.references) ===
			'["https://x/a.png","https://x/b.png"]',
		JSON.stringify(argsOf('--ref https://x/a.png --ref https://x/b.png 融合')?.references));
	check('--ref=地址 的等号写法也收（可重复，两种写法可以混着用）',
		JSON.stringify(argsOf('--ref=data:image/png;base64,AA== 变体')?.references) ===
			'["data:image/png;base64,AA=="]' &&
			JSON.stringify(argsOf('--ref=a.png --ref b.png x')?.references) === '["a.png","b.png"]');
	check('不带 --ref 时 references 是 undefined（纯文生图）',
		argsOf('一只肥鱼')?.references === undefined);
	// `attached` 这个哨兵值两半边各写了一份字面量（宿主写给模型看、客户端读成一句话）：
	// 漂移的后果是「生成信息」把一张真参考图显示成一段生地址，且**不报任何错**。
	const tool = await import(
		`file:///${resolve(root, 'lib/host/tool.js').replace(/\\/g, '/')}`
	);
	check('`attached` 哨兵值在两边是同一个字面量',
		tool.REFERENCE_ATTACHED === media.REFERENCE_ATTACHED_MARKER,
		`宿主 ${String(tool.REFERENCE_ATTACHED)} / 客户端 ${String(media.REFERENCE_ATTACHED_MARKER)}`);
	check('--ref 超过张数上限时直接报错（并说清是上限，不是地址写错）', (() => {
		const line = `--ref ${Array.from({ length: 9 }, (_, i) => `https://x/${String(i)}.png`).join(' --ref ')} x`;
		const parsed = media.parseGenerateLine(line);
		return parsed.ok === false && parsed.error.includes('最多带 8 张');
	})(), String(media.parseGenerateLine(`--ref ${Array.from({ length: 9 }, (_, i) => `https://x/${String(i)}.png`).join(' --ref ')} x`).error).slice(0, 60));
	check(
		'提示词里的短横线与冒号不受影响（只有 -- 开头才算开关）',
		argsOf('画一个 1:1 的 - 符号')?.prompt === '画一个 1:1 的 - 符号',
		String(argsOf('画一个 1:1 的 - 符号')?.prompt),
	);
	check(
		'多个开关与提示词混排',
		(() => {
			const a = argsOf('--video --ratio 16:9 --duration 5 一只在飞的海鸥');
			return (
				a !== null &&
				a.kind === 'video' &&
				a.aspectRatio === '16:9' &&
				a.duration === 5 &&
				a.prompt === '一只在飞的海鸥'
			);
		})(),
		JSON.stringify(argsOf('--video --ratio 16:9 --duration 5 一只在飞的海鸥')),
	);
	check('只有空白 → 缺少提示词', media.parseGenerateLine('   ').ok === false);
	check('-- 开头的未知参数报错', media.parseGenerateLine('--x 猫').ok === false);
	check('--duration 负数被拒', media.parseGenerateLine('--duration -5 猫').ok === false);
	check('--video=yes 被拒（不接受取值）', media.parseGenerateLine('--video=yes 猫').ok === false);
	check(
		'非法 ratio 被拒',
		media.parseGenerateLine('--ratio 21:9 猫').ok === false,
	);

	// ── 结果文本的约定 ──
	const formatted = media.formatCommandResult({
		kind: 'image',
		url: 'https://x/y.png',
		model: 'm',
		aspectRatio: '1:1',
		width: 1024,
		height: 1024,
	});
	check('formatCommandResult 第一行是地址', formatted.split('\n')[0] === 'https://x/y.png', formatted);
	check(
		'mediaUrlFromCommandText 能读回地址',
		media.mediaUrlFromCommandText(formatted) === 'https://x/y.png',
	);
	check(
		'data: URL 也算（b64 图像就是这种）',
		media.mediaUrlFromCommandText('data:image/png;base64,AA==\n图像') === 'data:image/png;base64,AA==',
	);
	check(
		'不符合约定的文本返回 null（宁可判定失败，也不要造一个坏节点）',
		media.mediaUrlFromCommandText('生成失败：没有密钥') === null &&
			media.mediaUrlFromCommandText('') === null &&
			media.mediaUrlFromCommandText(undefined) === null,
	);
}

// ─────────── 9. P9：模型解析 / 选择 / 迁移 ───────────
console.log('\n9) P9：providers 字典的解析与选择');

/** 按路径导入一个 lib 产物模块（宿主测试统一走构建产物，与真实加载路径一致）。 */
const libImport = async (relative) =>
	import(`file:///${resolve(root, relative).replace(/\\/g, '/')}`);

const schema = await libImport('lib/host/schema.js');

{
	// ── 9.1 resolveModels：供应商 × 模型 → 可发起生成的目标 ──
	const config = {
		providers: {
			acme: {
				label: 'Acme 网关',
				baseURL: 'https://gw.acme.example/v1',
				apiKeyEnv: 'FFC_ACME_API_KEY',
				models: [
					{ id: 'acme-large', kind: 'image', apiKeyEnv: '', label: '' },
					{ id: 'acme-video', kind: 'video', apiKeyEnv: 'FFC_ACME_VIDEO_API_KEY', label: '' },
				],
			},
			bare: {
				label: '',
				baseURL: 'https://bare.example/v1',
				apiKeyEnv: '',
				models: [{ id: 'm1', kind: 'image', apiKeyEnv: '', label: '' }],
			},
		},
		defaultImage: 'acme::acme-large',
		defaultVideo: 'acme::acme-video',
		timeoutMs: 1000,
		maxNodeSize: 512,
	};
	const keys = { FFC_ACME_API_KEY: 'sk-acme', FFC_ACME_VIDEO_API_KEY: 'sk-video' };
	const models = schema.resolveModels(config, (ref) => keys[ref] ?? '');
	check('每个模型解析出一条（2 个供应商共 3 条）', models.length === 3, String(models.length));

	const large = models.find((m) => m.modelId === 'acme-large');
	check(
		'图像模型走 openai-images 适配器',
		large?.api === 'openai-images' && large.kind === 'image',
		`${String(large?.api)} / ${String(large?.kind)}`,
	);
	check('视频模型走 openai-videos 适配器',
		models.find((m) => m.modelId === 'acme-video')?.api === 'openai-videos');
	check(
		'没有单独密钥的模型继承供应商级密钥',
		large?.apiKey === 'sk-acme' && large.keyFromModel === false,
		`${String(large?.apiKey)} / own=${String(large?.keyFromModel)}`,
	);
	const video = models.find((m) => m.modelId === 'acme-video');
	check(
		'配了单独密钥的模型用它自己的（并标记 keyFromModel）',
		video?.apiKey === 'sk-video' && video.keyFromModel === true,
		`${String(video?.apiKey)} / own=${String(video?.keyFromModel)}`,
	);
	check(
		'默认标记按 `供应商::模型` 判定',
		large?.isDefault === true && video?.isDefault === true,
		`${String(large?.isDefault)} / ${String(video?.isDefault)}`,
	);
	check(
		'稳定标识是 `供应商::模型`（模型 id 里可以带斜杠，因此不能用 / 分隔）',
		large?.ref === 'acme::acme-large',
		String(large?.ref),
	);
	check(
		'凭据缺席时按空密钥解析（不抛错）',
		schema.resolveModels(config, () => '').every((m) => m.apiKey === ''),
	);
	check(
		'供应商没有 label 时用 id 兜底',
		models.find((m) => m.providerId === 'bare')?.providerLabel === 'bare',
	);
	check(
		'坏数据（providers 不是对象）解析成空表而不是崩掉',
		schema.resolveModels({ providers: null, defaultImage: '', defaultVideo: '', timeoutMs: 1, maxNodeSize: 1 }, () => '').length === 0,
	);
}

{
	// ── 9.1b 档位：分辨率轴是模型 id 本身，质量轴进 ResolvedModel.params ──
	//
	// 这一节钉的是「声明在家族里任何一个成员上都生效」和「展开进请求体的位置」：
	// 前者错了表现为「配了 4K 那一行、选 2K 就没档位」，后者错了表现为
	// 「界面上选了高档，请求里什么都没带」—— 后者最坏，因为网关会静默按默认档出图。
	const tiered = configured('openai-images', {
		model: 'shot-2k',
		provider: {
			models: [
				{ id: 'shot-1k', kind: 'image', apiKeyEnv: '', label: '' },
				{ id: 'shot-2k', kind: 'image', apiKeyEnv: '', label: '' },
				{
					id: 'shot-4k',
					kind: 'image',
					apiKeyEnv: '',
					label: '',
					tiers: { param: 'quality', values: ['low', 'high'], labels: { low: '低', high: '高' } },
				},
			],
		},
		defaultTiers: { 'openai-images::shot': 'high' },
		// 默认模型点名 2k 那一档：不然 pickModel 会取第一个可用的（1k）
		defaultImage: 'openai-images::shot-2k',
	});
	const resolved = schema.resolveModels(tiered, () => 'sk');
	check(
		'档位：兄弟 id 各自一条解析结果，但共用同一个家族键',
		resolved.length === 3 && new Set(resolved.map((m) => m.familyRef)).size === 1,
		resolved.map((m) => `${m.modelId}→${m.familyRef}`).join(','),
	);
	check(
		'档位：声明写在 4k 那一行，1k / 2k 也拿到同一个参数',
		resolved.every((m) => m.params.quality === 'high'),
		JSON.stringify(resolved.map((m) => m.params)),
	);
	check(
		'档位：分辨率档位词单独留一份（界面上显示 2K / 4K 用它）',
		resolved.map((m) => m.tier).join(',') === '1k,2k,4k',
		resolved.map((m) => m.tier).join(','),
	);
	check(
		'档位：没有声明的模型 params 是空对象（请求体不多任何键）',
		schema.resolveModels(configured('openai-images'), () => 'sk')[0]?.params !== undefined &&
			Object.keys(schema.resolveModels(configured('openai-images'), () => 'sk')[0].params).length === 0,
		JSON.stringify(schema.resolveModels(configured('openai-images'), () => 'sk')[0].params),
	);
	check(
		'档位：defaultTiers 指向一个不在取值清单里的值时退回第一个取值',
		schema.resolveModels({ ...tiered, defaultTiers: { 'openai-images::shot': 'ultra' } }, () => 'sk')[0]?.params
			.quality === 'low',
	);
	check(
		'档位：坏声明（保留参数名 / 空取值）当作没有轴（不抛）',
		schema.resolveModels(
			{
				...tiered,
				providers: {
					'openai-images': {
						...tiered.providers['openai-images'],
						models: [{ id: 'shot-2k', kind: 'image', tiers: { param: 'model', values: ['x'] } }],
					},
				},
			},
			() => 'sk',
		)[0]?.params.model === undefined,
	);

	// 走到工具那一层：参数真的进了请求体（这是用户唯一看得见的证据）
	const { ctx: c, captured: cap } = makeCtx(tiered);
	mod.apply(c);
	const tool = cap.tools[0];
	calls = [];
	responder = () => ({ ok: true, status: 200, body: { data: [{ url: 'https://cdn.example.com/out.png' }] } });
	await tool.execute({ prompt: '一只柴犬' }, { signal: undefined });
	check(
		'档位：声明出来的质量档原样出现在请求体里',
		calls[0]?.body?.quality === 'high' && calls[0]?.body?.model === 'shot-2k',
		JSON.stringify(calls[0]?.body),
	);
}

{
	// ── 9.2 pickModel：三种点名写法 + 默认 + 回落 ──
	const mk = (ref, kind, keyed, isDefault = false) => ({
		providerId: ref.split('::')[0],
		providerLabel: ref.split('::')[0],
		modelId: ref.split('::')[1],
		modelLabel: ref,
		kind,
		api: kind === 'video' ? 'openai-videos' : 'openai-images',
		baseURL: 'https://x/v1',
		apiKey: keyed ? 'sk' : '',
		keyRef: 'R',
		keyFromModel: false,
		isDefault,
		ref,
	});
	const list = [
		mk('a::big', 'image', true),
		mk('a::small', 'image', false),
		mk('a::tiny', 'image', true),
		mk('b::pic', 'image', true),
		mk('a::mov', 'video', true),
	];

	check(
		'默认优先：默认有密钥时就用它',
		schema.pickModel(list, 'image', undefined).ref === 'a::big',
	);
	check(
		'默认没密钥时回落到第一个可用的（不死在默认上）',
		schema.pickModel(
			[mk('a::big', 'image', false, true), mk('b::pic', 'image', true)],
			'image',
			undefined,
		).ref === 'b::pic',
	);
	check('精确写法 `供应商::模型` 命中最具体的那条', schema.pickModel(list, 'image', 'a::tiny').ref === 'a::tiny');
	check('只写供应商：取它下面第一个可用', schema.pickModel(list, 'image', 'a').ref === 'a::big');
	check(
		'只写供应商、该供应商第一项没密钥时取下一个可用的',
		schema.pickModel([mk('c::nokey', 'image', false), mk('c::ok', 'image', true)], 'image', 'c').ref === 'c::ok',
	);
	check('只写模型名', schema.pickModel(list, 'image', 'pic').ref === 'b::pic');
	check(
		'以「供应商::模型」写法点名但缺密钥时报「还缺 API 密钥」',
		(() => {
			try {
				schema.pickModel([mk('a::small', 'image', false)], 'image', 'a::small');
				return false;
			} catch (error) {
				return String(error?.message).includes('API 密钥');
			}
		})(),
	);
	check(
		'找不到时报错并列出可用项',
		(() => {
			try {
				schema.pickModel(list, 'image', 'nope');
				return false;
			} catch (error) {
				return String(error?.message).includes('nope') && String(error?.message).includes('a::big');
			}
		})(),
	);
	check(
		'没有该种类的模型时给出可操作提示',
		(() => {
			try {
				schema.pickModel([mk('a::big', 'image', true)], 'video', undefined);
				return false;
			} catch (error) {
				const text = String(error?.message);
				return text.includes('视频') && text.includes('设置') && text.includes('密钥');
			}
		})(),
	);
}

{
	// ── 9.3 旧配置迁移（P8 → P9） ──
	const legacyConfig = {
		key_openai_images: 'sk-old-openai',
		model_openai_images: 'gpt-image-1',
		baseURL_openai_images: '',
		model_volces_videos: 'doubao-x',
		key_volces_videos: '',
		defaultImage: 'openai-images',
		defaultVideo: '',
		timeoutMs: 600000,
		maxNodeSize: 512,
	};
	const plan = schema.migrateLegacy(legacyConfig);
	check(
		'旧密钥被搬进凭据引用（而不是留在设置里）',
		plan.credentials['FFC_OPENAI_API_KEY'] === 'sk-old-openai',
		JSON.stringify(plan.credentials),
	);
	check(
		'只为「真的配过东西」的条目新建供应商（两条）',
		Object.keys(plan.providers).sort().join(',') === 'openai,volces',
		Object.keys(plan.providers).join(','),
	);
	check(
		'旧模型名进了模型清单，且种类来自旧目录',
		plan.providers['openai']?.models[0]?.id === 'gpt-image-1' &&
			plan.providers['openai']?.models[0]?.kind === 'image' &&
			plan.providers['volces']?.models[0]?.kind === 'video',
		JSON.stringify(plan.providers),
	);
	check(
		'旧默认值（裸目录 id）映射成 `供应商::模型`',
		plan.defaultImage === 'openai::gpt-image-1',
		String(plan.defaultImage),
	);
	check(
		'出现过的旧字段都要被 unset（值搬进 providers / 凭据库后，旧布局不再留着）',
		plan.dropFields.includes('key_openai_images') &&
			plan.dropFields.includes('model_openai_images') &&
			plan.dropFields.includes('model_volces_videos'),
		JSON.stringify(plan.dropFields),
	);
	check(
		'空配置不产生任何迁移动作（不会给每个人凭空加四条空供应商）',
		(() => {
			// 必须按**真实运行时**的形状来造：`readConfig()` 给的是解析后的值，而旧字段
			// 带 `.default('')`，因此它们**总是存在**。早先这里把这些键整个省略了，于是
			// 「字段缺席」—— 现实中不会出现的情况 —— 让断言白过：判据写成
			// `!== undefined` 也照样绿，而那正是「每次启动都白写一遍 profile」的根源。
			const blankLegacy = {};
			for (const id of [
				'openai_images',
				'openai_videos',
				'volces_images',
				'volces_videos',
				'siliconflow_images',
				'zhipu_images',
			]) {
				blankLegacy[`key_${id}`] = '';
				blankLegacy[`model_${id}`] = '';
				blankLegacy[`baseURL_${id}`] = '';
			}
			const empty = schema.migrateLegacy({
				providers: {},
				defaultImage: '',
				defaultVideo: '',
				timeoutMs: 600000,
				maxNodeSize: 512,
				...blankLegacy,
			});
			return Object.keys(empty.providers).length === 0 && empty.dropFields.length === 0;
		})(),
	);
	check(
		'迁移后旧字段不再是密钥（值搬走了，字段被清掉）',
		(() => {
			const after = { ...legacyConfig };
			for (const field of plan.dropFields) delete after[field];
			return schema.migrateLegacy({ ...after, providers: plan.providers }).credentials['FFC_OPENAI_API_KEY'] === undefined;
		})(),
	);
}

// ─────────── 10. P9：探测服务（测试连接 / 获取模型列表） ───────────
console.log('\n10) P9：mediaProbe 探测服务');

{
	const probe = await libImport('lib/host/probe.js');
	const target = { baseURL: 'https://gw.example/v1', apiKey: 'sk-test', keyRef: 'R' };

	check('guessKind：视频模型名能被认出来',
		probe.guessKind('sora-2') === 'video' &&
			probe.guessKind('doubao-seedance-1-0-pro') === 'video' &&
			probe.guessKind('gpt-image-1') === 'image' &&
			probe.guessKind('Kwai-Kolors/Kolors') === 'image',
		`${probe.guessKind('sora-2')} / ${probe.guessKind('gpt-image-1')}`,
	);
	check(
		'extractModelIds 认三种形状（data / models / 裸数组）',
		JSON.stringify(probe.extractModelIds({ data: [{ id: 'a' }, { id: 'b' }] })) === '["a","b"]' &&
			JSON.stringify(probe.extractModelIds({ models: ['c'] })) === '["c"]' &&
			JSON.stringify(probe.extractModelIds(['d', { name: 'e' }])) === '["d","e"]',
		JSON.stringify(probe.extractModelIds({ data: [{ id: 'a' }, { id: 'b' }] })),
	);
	check('extractModelIds 去重且忽略空值',
		JSON.stringify(probe.extractModelIds({ data: ['a', 'a', '', null, 42] })) === '["a"]',
		JSON.stringify(probe.extractModelIds({ data: ['a', 'a', '', null, 42] })),
	);

	/** 造一个探测核心 + 记录请求。 */
	const makeProbe = (responder, targetOverride = {}) => {
		const reqs = [];
		globalThis.fetch = async (url, init) => {
			reqs.push({ url: String(url), method: init?.method, headers: init?.headers });
			return responder();
		};
		return {
			reqs,
			core: new probe.MediaProbeCore({
				providerOf: async () => ({ ...target, ...targetOverride }),
				timeoutMs: () => 5000,
			}),
		};
	};

	{
		const { core, reqs } = makeProbe(() => ({
			ok: true,
			status: 200,
			text: async () => JSON.stringify({ data: [{ id: 'gpt-image-1' }, { id: 'sora-2' }] }),
		}));
		const result = await core.listModels('acme');
		check('请求打到 {base}/models 且带 Bearer 头',
			reqs[0]?.url === 'https://gw.example/v1/models' &&
				reqs[0]?.headers?.authorization === 'Bearer sk-test',
			`${String(reqs[0]?.url)} / ${String(reqs[0]?.headers?.authorization)}`);
		check('成功时返回模型 id 与猜测的种类',
			result.ok === true &&
				JSON.stringify(result.models) === '["gpt-image-1","sora-2"]' &&
				JSON.stringify(result.kinds) === '["image","video"]',
			JSON.stringify(result));
		check('成功文案里带耗时', String(result.message).includes('ms'), String(result.message));
	}

	{
		const { core } = makeProbe(() => ({ ok: false, status: 401, text: async () => '{"error":"bad key"}' }));
		const result = await core.listModels('acme');
		check('401 被翻译成「密钥被拒绝」而不是含糊的网络错误',
			result.ok === false && String(result.message).includes('密钥被拒绝'),
			String(result.message));
	}

	{
		const { core } = makeProbe(() => ({ ok: false, status: 404, text: async () => 'not found' }));
		const result = await core.listModels('acme');
		check('404 提示基址可能没写全（最常见的踩坑）',
			result.ok === false && String(result.message).includes('/v1'),
			String(result.message));
	}

	{
		const { core } = makeProbe(() => ({ ok: false, status: 451, text: async () => '<!doctype html><html><head><title>贞贞的AI工坊</title></head><body>x</body></html>' }));
		const result = await core.listModels('acme');
		check('451 + HTML（中转站首页，基址漏了 /v1）被翻成「指向网页」而不是甩 doctype',
			result.ok === false &&
				String(result.message).includes('网页而不是 API') &&
				String(result.message).includes('贞贞的AI工坊') &&
				!String(result.message).includes('doctype'),
			String(result.message));
	}

	{
		const { core } = makeProbe(() => ({ ok: true, status: 200, text: async () => 'oops' }));
		const result = await core.listModels('acme');
		check('响应不是 JSON 时如实说明（而不是抛给调用方）',
			result.ok === false && String(result.message).includes('不是 JSON'),
			String(result.message));
	}

	{
		const { core } = makeProbe(() => {
			throw new Error('fetch failed: ECONNREFUSED');
		});
		const result = await core.listModels('acme');
		check('连不上时给出「无法连接」而不是原始堆栈',
			result.ok === false && String(result.message).includes('无法连接'),
			String(result.message));
	}

	{
		const { core } = makeProbe(() => ({ ok: true, status: 200, text: async () => '{}' }), { apiKey: '' });
		const result = await core.listModels('acme');
		check('没配密钥时不发请求，直接说明还缺什么',
			result.ok === false && String(result.message).includes('还没有配置密钥'),
			String(result.message));
	}

	{
		const { core } = makeProbe(() => ({ ok: true, status: 200, text: async () => '{}' }), { baseURL: '' });
		const result = await core.listModels('acme');
		check('没填基址时直接说明', result.ok === false && String(result.message).includes('接口基址'), String(result.message));
	}

	{
		// 返回值必须能被 JSON 往返（网关注册表会拒绝类实例 / 循环 / 非有限数）
		const { core } = makeProbe(() => ({
			ok: true,
			status: 200,
			text: async () => JSON.stringify({ data: [{ id: 'x' }] }),
		}));
		const result = await core.testConnection('acme');
		check('testConnection 的返回值是纯 JSON（可安全过网关）',
			JSON.parse(JSON.stringify(result)).ok === true &&
				Object.getPrototypeOf(result) === Object.prototype,
			JSON.stringify(result));
		check('testConnection 文案是「连接正常」',
			String(result.message).includes('连接正常'),
			String(result.message));
	}

	// ── 10.x `fetchImage`：画布图片 → 字节（供客户端做附件） ──
	//
	// 为什么必须由宿主取：节点上的图常常是跨域地址，浏览器 fetch 会踩 CORS，
	// 而「存成附件」必须要字节。这一段的替身只造响应头与字节，不碰网络。
	const imageResponse = (bytes, mime = 'image/png') => ({
		ok: true,
		status: 200,
		headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? mime : null) },
		arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
	});

	{
		const pixels = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
		const { core, reqs } = makeProbe(() => imageResponse(pixels));
		const result = await core.fetchImage('https://cdn.example/pics/board.png?v=2');
		check('fetchImage 取到字节并转成 data URL',
			result.ok === true &&
				String(result.dataUrl).startsWith('data:image/png;base64,') &&
				result.bytes === pixels.length &&
				result.mimeType === 'image/png',
			JSON.stringify({ ok: result.ok, bytes: result.bytes, mime: result.mimeType, name: result.name }));
		check('fetchImage 原样 GET 那个地址（不带任何鉴权头）',
			reqs[0]?.url === 'https://cdn.example/pics/board.png?v=2' && reqs[0]?.method === 'GET',
			String(reqs[0]?.url));
		check('文件名从地址里取（附件卡片要显示它）',
			result.name === 'board.png',
			String(result.name));
	}

	{
		const { core } = makeProbe(() => imageResponse(new Uint8Array([1, 2, 3]), 'text/html'));
		const result = await core.fetchImage('https://cdn.example/not-an-image');
		check('返回的不是图片时明确拒绝（不把网页当图塞成附件）',
			result.ok === false && String(result.message).includes('不是图片'),
			String(result.message));
	}

	{
		const huge = new Uint8Array(9 * 1024 * 1024);
		const { core } = makeProbe(() => imageResponse(huge));
		const result = await core.fetchImage('https://cdn.example/huge.png');
		check('超过上限时给出「太大」并说明上限（不是含糊失败）',
			result.ok === false && String(result.message).includes('太大') && String(result.message).includes('8 MB'),
			String(result.message));
	}

	{
		const { core } = makeProbe(() => imageResponse(new Uint8Array([1])));
		const nonHttp = await core.fetchImage('/local/file.png');
		check('非 http(s) 地址直接拒绝（本地文件该走拖进画布那条路）',
			nonHttp.ok === false && String(nonHttp.message).includes('http'),
			String(nonHttp.message));
	}

	// ── 10.y `fetchMedia`：**图或视频**（导出那条路） ──
	//
	// 与 fetchImage 分开的理由：附件那条路只该收图。这一段钉住三件事 ——
	// 视频真能取到、附件那条路**仍然拒视频**、视频的体积上限比图宽（64MB）。
	{
		const mp4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
		const { core } = makeProbe(() => imageResponse(mp4, 'video/mp4'));
		const result = await core.fetchMedia('https://cdn.example/clips/out.mp4');
		check('fetchMedia 收视频并把字节转成 data URL',
			result.ok === true &&
				String(result.dataUrl).startsWith('data:video/mp4;base64,') &&
				result.mimeType === 'video/mp4' &&
				result.bytes === mp4.length,
			JSON.stringify({ ok: result.ok, bytes: result.bytes, mime: result.mimeType, name: result.name }));
		check('视频文件名从地址里取（不带 content-length 也不影响）',
			result.name === 'out.mp4',
			String(result.name));
	}

	{
		const { core } = makeProbe(() => imageResponse(new Uint8Array([1]), 'video/mp4'));
		const result = await core.fetchImage('https://cdn.example/clips/out.mp4');
		check('fetchImage **仍然拒视频**（附件通路不该把视频塞进聊天框）',
			result.ok === false && String(result.message).includes('不是图片'),
			String(result.message));
	}

	{
		// 9MB：超图片上限、远低于视频上限 —— 上限按 **MIME** 分，不按方法分
		const nineMb = new Uint8Array(9 * 1024 * 1024);
		const viaMedia = await makeProbe(() => imageResponse(nineMb, 'video/mp4')).core.fetchMedia(
			'https://cdn.example/clips/big.mp4',
		);
		const imageAsMedia = await makeProbe(() => imageResponse(nineMb, 'image/png')).core.fetchMedia(
			'https://cdn.example/pics/big.png',
		);
		const viaImage = await makeProbe(() => imageResponse(nineMb, 'image/png')).core.fetchImage(
			'https://cdn.example/pics/big.png',
		);
		check(
			'视频上限（64MB）比图（8MB）宽：9MB 的视频取得到，9MB 的图两条路都拒',
			viaMedia.ok === true &&
				imageAsMedia.ok === false &&
				viaImage.ok === false &&
				String(viaImage.message).includes('8 MB'),
			`video=${String(viaMedia.ok)} imageAsMedia=${String(imageAsMedia.ok)} image=${String(viaImage.ok)}`,
		);
	}

	{
		const { core } = makeProbe(() => imageResponse(new Uint8Array(1), 'audio/mpeg'));
		const result = await core.fetchMedia('https://cdn.example/track.mp3');
		check('既不是图也不是视频时明确拒绝（导出不是万能下载器）',
			result.ok === false && String(result.message).includes('不是图片或视频'),
			String(result.message));
	}

	{
		// content-length 谎报超大：**一个字节都不该下**（视频动辄几十兆，白下一遍最亏）
		let read = false;
		const { core } = makeProbe(() => ({
			ok: true,
			status: 200,
			headers: {
				get: (k) => {
					const key = String(k).toLowerCase();
					if (key === 'content-type') return 'video/mp4';
					if (key === 'content-length') return String(80 * 1024 * 1024);
					return null;
				},
			},
			arrayBuffer: async () => {
				read = true;
				return new ArrayBuffer(0);
			},
		}));
		const result = await core.fetchMedia('https://cdn.example/clips/huge.mp4');
		check('按 content-length 提前拒绝（不把 80MB 真下完再报错）',
			result.ok === false && read === false && String(result.message).includes('64 MB'),
			`read=${String(read)} msg=${String(result.message)}`);
		check('太大时给出的下一步是「先配留档目录」（视频那条真能绕开上限）',
			String(result.message).includes('留档'),
			String(result.message));
	}
}

// 探测那一节的替身是**临时**换上去的：换回来，否则后面每一节的请求都会打到它身上
globalThis.fetch = mainFetch;

// ─────────── 11. P9：远程清单与两侧一致（宿主 ↔ 客户端） ───────────
console.log('\n11) P9：mediaProbe 描述符两侧一致');

{
	const shared = await libImport('lib/client/shared/probe.js');
	const host = shared.PROBE_HOST_MANIFEST;
	const client = shared.PROBE_CLIENT_CONTRIBUTION;

	check(
		'注册了 mediaProbe 清单（宿主侧）',
		captured.typert.length === 1 && captured.typert[0]?.package === 'fatfish-canvas',
		JSON.stringify(captured.typert.map((m) => m.package)),
	);
	check(
		'服务本体 provide 在插件顶层（网关按名字解析接收者）',
		captured.provided['mediaProbe'] !== undefined,
		Object.keys(captured.provided).join(','),
	);
	check(
		'绑定形状正确：service 是服务实例 + serviceKey/namespace 都是 mediaProbe',
		(() => {
			const binding = captured.provided['mediaProbe']?.typertRemote;
			return (
				binding !== undefined &&
				binding.service === captured.provided['mediaProbe'] &&
				binding.serviceKey === 'mediaProbe' &&
				binding.namespace === 'mediaProbe'
			);
		})(),
		// ⚠️ 不能直接 JSON.stringify 这个绑定：service 指回服务实例、实例上又挂着绑定，
		// 打印它本身就会抛「Converting circular structure to JSON」。
		(() => {
			const binding = captured.provided['mediaProbe']?.typertRemote;
			if (binding === undefined) return 'undefined';
			return `serviceKey=${String(binding.serviceKey)} namespace=${String(binding.namespace)} serviceIsSelf=${String(
				binding.service === captured.provided['mediaProbe'],
			)}`;
		})(),
	);
	check(
		'服务上确实有那四个方法（描述符指向它们）',
		typeof captured.provided['mediaProbe']?.testConnection === 'function' &&
			typeof captured.provided['mediaProbe']?.listModels === 'function' &&
			typeof captured.provided['mediaProbe']?.fetchImage === 'function' &&
			typeof captured.provided['mediaProbe']?.fetchMedia === 'function',
	);

	const hostCalls = host.invocations.map((i) => `${i.namespace}/${i.method}`).sort();
	const clientCalls = client.descriptors.map((d) => `${d.namespace}/${d.method}`).sort();
	check(
		'两侧声明的调用完全一致（运行时不互相校验，写歪只会「点了没反应」）',
		JSON.stringify(hostCalls) === JSON.stringify(clientCalls),
		`宿主=${hostCalls.join(',')} 客户端=${clientCalls.join(',')}`,
	);
	check(
		'调用 id 也一致（id 是网关认领端点的键）',
		JSON.stringify(host.invocations.map((i) => i.id).sort()) ===
			JSON.stringify(client.descriptors.map((d) => d.id).sort()),
	);
	check(
		'参数线名两侧逐方法一致（探测收 providerId、取图收 url）',
		(() => {
			const clientWire = new Map(client.descriptors.map((d) => [d.method, d.parameters[0]?.wire]));
			const mismatched = host.invocations.filter((i) => clientWire.get(i.method) !== i.parameters[0]?.wire);
			return (
				mismatched.length === 0 &&
				host.invocations.some((i) => i.parameters[0]?.wire === 'providerId') &&
				host.invocations.some((i) => i.parameters[0]?.wire === 'url')
			);
		})(),
		`宿主=${host.invocations.map((i) => `${String(i.method)}:${String(i.parameters[0]?.wire)}`).join(',')}`,
	);
	check(
		'每个参数与结果都用严格编解码器（客户端面只接受 strict）',
		[...host.invocations, ...client.descriptors].every(
			(entry) =>
				entry.parameters.every((p) => p.codec?.mode === 'strict' && typeof p.codec.create === 'function') &&
				entry.result?.mode === 'strict' &&
				typeof entry.result.create === 'function',
		),
	);
	check(
		'编解码器的 `create()` 是**缓存**工厂（网关每次边界解码都调它，见 §1.4）',
		(() => {
			// 0.2.0 的 `TypertCodec` 只有 `create`：从前那个 `schema:` 键已经被忽略，
			// 少了工厂注册表会直接抛（`strict codec has no create() factory`）。
			const codecs = [
				...host.invocations.flatMap((i) => [...i.parameters.map((p) => p.codec), i.result]),
				...client.descriptors.flatMap((d) => [...d.parameters.map((p) => p.codec), d.result]),
			];
			return (
				codecs.length === 16 &&
				codecs.every(
					(codec) =>
						codec.schema === undefined &&
						codec.create() === codec.create() &&
						typeof codec.create().parse === 'function',
				)
			);
		})(),
		(() => {
			const codecs = [
				...host.invocations.flatMap((i) => [...i.parameters.map((p) => p.codec), i.result]),
				...client.descriptors.flatMap((d) => [...d.parameters.map((p) => p.codec), d.result]),
			];
			return `codecs=${String(codecs.length)} cached=${String(codecs.every((c) => c.create() === c.create()))} legacySchemaKey=${String(codecs.some((c) => c.schema !== undefined))}`;
		})(),
	);
	check(
		'每个参数各自一个编解码器对象（生成器对每个展开点发独立工厂，不共用）',
		(() => {
			const codecs = host.invocations.flatMap((i) => [...i.parameters.map((p) => p.codec), i.result]);
			return new Set(codecs).size === codecs.length;
		})(),
	);
	check(
		'结果编解码器会挡掉坏数据（缺 ok/message 的返回值直接抛）',
		(() => {
			const codec = client.descriptors[0].result.create();
			let threw = false;
			try {
				codec.parse({ nope: 1 });
			} catch {
				threw = true;
			}
			const good = codec.parse({ ok: true, message: 'm', models: ['a', 1], latencyMs: 3 });
			return threw && JSON.stringify(good) === '{"ok":true,"message":"m","models":["a"],"latencyMs":3}';
		})(),
	);
}

// ─────────── 12. 参考图（图生图 / 视频首帧） ───────────
//
// 文本模型看不见图：它只递一个**地址**，字节通路必须绕开模型。这一节钉的就是
// 那条通路 —— 地址怎么进请求体、本地文件怎么读、附件怎么取、取不到时怎么报错。
console.log('\n12) 参考图：地址 → 供应商载荷');

{
	// ① 默认写法：地址塞进 /images/generations 的 image 字段
	const { ctx: c, captured: cap } = makeCtx(configured('openai-images'));
	mod.apply(c);
	const t = cap.tools[0];
	calls = [];
	responder = () => ({ ok: true, status: 200, body: { data: [{ url: 'https://cdn.example.com/ref.png' }] } });

	const value = await t.execute(
		{ prompt: '把这张图变成油画', reference: 'https://cdn.example.com/in.png' },
		{},
	);
	check('带参考图仍打同一端点（默认 field 模式）',
		calls[0]?.url === 'https://api.example.com/v1/images/generations', String(calls[0]?.url));
	check('参考图放进 image 字段（原样，不下载）',
		calls[0]?.body?.image === 'https://cdn.example.com/in.png', String(calls[0]?.body?.image));
	check('结果回带 usedReference（客户端据此显示「参考图」徽标）', value.usedReference === true);
	check('presentationMeta 也带 usedReference',
		t.output.presentationMeta({}, value)?.fatfishCanvas?.usedReference === true);
	{
		calls = [];
		await t.execute({ prompt: '一只柴犬' }, {});
		check('纯文生图的请求体里没有 image 字段', calls[0]?.body?.image === undefined, JSON.stringify(calls[0]?.body));
	}
}

{
	// ② 字段名可配：各家视频 / 图像网关叫法不同（字段写歪 = 网关静默忽略参考图）
	const config = configured('custom', { provider: { referenceField: 'image_url' } });
	const { ctx: c, captured: cap } = makeCtx(config);
	mod.apply(c);
	const t = cap.tools[0];
	calls = [];
	responder = () => ({ ok: true, status: 200, body: { data: [{ url: 'https://cdn.example.com/x.png' }] } });

	await t.execute({ prompt: 'x', reference: 'https://cdn.example.com/in.png' }, {});
	check('referenceField 覆盖生效（image_url）',
		calls[0]?.body?.image_url === 'https://cdn.example.com/in.png' &&
			calls[0]?.body?.image === undefined,
		JSON.stringify(calls[0]?.body));
}

{
	// ②b 多张参考图：**字段名不变，值变成数组**（顺序原样保留）
	const { ctx: c, captured: cap } = makeCtx(configured('openai-images'));
	mod.apply(c);
	const t = cap.tools[0];
	calls = [];
	responder = () => ({ ok: true, status: 200, body: { data: [{ url: 'https://cdn.example.com/m.png' }] } });

	await t.execute(
		{ prompt: '融合这两张', reference: ['https://cdn.example.com/a.png', 'https://cdn.example.com/b.png'] },
		{},
	);
	check('JSON 路径多张 = 同一个字段名收数组，顺序与给的顺序一致',
		JSON.stringify(calls[0]?.body?.image) ===
			'["https://cdn.example.com/a.png","https://cdn.example.com/b.png"]',
		JSON.stringify(calls[0]?.body?.image));
	check('多张时不下载任何东西（http 地址原样转给供应商）', calls.length === 1, `${String(calls.length)} 次`);

	// 单张**仍然是字符串**（升级前就是这个形状，老网关照旧收）
	calls = [];
	await t.execute({ prompt: 'x', reference: ['https://cdn.example.com/only.png'] }, {});
	check('单张仍是字符串（不是单元素数组）—— 升级不能改变既有请求形状',
		calls[0]?.body?.image === 'https://cdn.example.com/only.png',
		JSON.stringify(calls[0]?.body?.image));

	// 换字段名也一样（想把数组塞进 images 的网关只要改 referenceField）
	const two = makeCtx(configured('custom', { provider: { referenceField: 'images' } }));
	mod.apply(two.ctx);
	calls = [];
	await two.captured.tools[0].execute(
		{ prompt: 'x', reference: ['https://cdn.example.com/a.png', 'https://cdn.example.com/b.png'] },
		{},
	);
	check('referenceField: images 时多张就是 images: [a, b]（字段名与形状互不绑死）',
		Array.isArray(calls[0]?.body?.images) && calls[0]?.body?.images.length === 2,
		JSON.stringify(calls[0]?.body?.images));
}

{
	// ②c 视频：同一个数组形状（body.images = refs 是 T8-penguin-canvas 的写法）
	const { ctx: c, captured: cap } = makeCtx(configured('openai-videos'));
	mod.apply(c);
	const t = cap.tools[0];
	calls = [];
	responder = () => ({ ok: true, status: 200, body: { data: [{ url: 'https://cdn.example.com/v.mp4' }] } });

	await t.execute(
		{
			prompt: '让这两张动起来',
			kind: 'video',
			reference: ['https://cdn.example.com/a.png', 'https://cdn.example.com/b.png'],
		},
		{},
	);
	check('视频路径多张参考图也是数组（与图像同一条拼装规则）',
		JSON.stringify(calls[0]?.body?.image) ===
			'["https://cdn.example.com/a.png","https://cdn.example.com/b.png"]',
		JSON.stringify(calls[0]?.body?.image));
}

{
	// ③ data: 地址原样透传（b64 结果就是这样）
	const { ctx: c, captured: cap } = makeCtx(configured('openai-images'));
	mod.apply(c);
	const t = cap.tools[0];
	calls = [];
	responder = () => ({ ok: true, status: 200, body: { data: [{ url: 'https://cdn.example.com/y.png' }] } });

	const inline = 'data:image/png;base64,QUJD';
	await t.execute({ prompt: 'x', reference: inline }, {});
	check('data: 地址原样进请求体', calls[0]?.body?.image === inline, String(calls[0]?.body?.image));
}

{
	// ④ 本地文件 → data URL（MIME 按字节头判，不信扩展名）
	const { ctx: c, captured: cap } = makeCtx(configured('openai-images'));
	mod.apply(c);
	const t = cap.tools[0];
	const file = resolve(root, 'lib', 'test-reference.png');
	await writeFile(file, PNG_BYTES);

	calls = [];
	responder = () => ({ ok: true, status: 200, body: { data: [{ url: 'https://cdn.example.com/z.png' }] } });
	await t.execute({ prompt: 'x', reference: file }, {});
	const payload = String(calls[0]?.body?.image ?? '');
	check('本地文件被读成 data URL 且 MIME 按字节头判定',
		payload.startsWith('data:image/png;base64,'), payload.slice(0, 40));
	check('字节确实是那个文件的内容',
		Buffer.from(payload.split(',')[1] ?? '', 'base64').length === PNG_BYTES.length);

	// 文件不存在：必须报错，**绝不能**静默出一张无关的图
	calls = [];
	let message = '';
	try {
		await t.execute({ prompt: 'x', reference: resolve(root, 'lib', 'nope-不存在.png') }, {});
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	check('文件读不到时报可读错误', message.includes('读不到参考图文件'), message.slice(0, 80));
	check('失败时一次请求都没发出去', calls.length === 0, `${String(calls.length)} 次`);
	await rm(file, { force: true });
}

{
	// ⑤ edits 模式：multipart 上传（OpenAI 官方那类只认这条端点）
	const { ctx: c, captured: cap } = makeCtx(configured('custom', { provider: { referenceMode: 'edits' } }));
	mod.apply(c);
	const t = cap.tools[0];
	calls = [];
	responder = () => ({ ok: true, status: 200, body: { data: [{ b64_json: 'QUJD' }] } });

	// 用 data: 参考图，好让「一次请求」这件事本身可断言（http 参考图会先下载一次，见下）
	const value = await t.execute(
		{ prompt: '换成水彩', reference: 'data:image/png;base64,iVBORw0KGgo=' },
		{},
	);
	check('edits 模式打到 /images/edits',
		calls[0]?.url === 'https://api.example.com/v1/images/edits', String(calls[0]?.url));
	check('edits 模式只发一次请求（data: 地址不需要先下载）', calls.length === 1, `${String(calls.length)} 次`);
	check('edits 模式用 multipart 体', calls[0]?.rawBody instanceof FormData);
	const form = calls[0]?.rawBody;
	check('multipart 带 model / prompt / size',
		form?.get('model') === 'test-model' &&
			form?.get('prompt') === `换成水彩` &&
			form?.get('size') === '1024x1024',
		JSON.stringify([form?.get('model'), form?.get('prompt'), form?.get('size')]).slice(0, 120));
	check('multipart 的 image 是一份文件（带文件名，单张时编号也是 1）',
		form?.get('image') instanceof Blob && form?.get('image')?.name === 'reference-1.png',
		String(form?.get('image')?.name));
	check('multipart 不带 JSON 的 content-type（boundary 由 fetch 自己写）',
		calls[0]?.headers?.['content-type'] === undefined,
		String(calls[0]?.headers?.['content-type']));
	check('edits 的响应解析与 generations 共用（b64 → data URL）',
		value.url === 'data:image/png;base64,QUJD', String(value.url));

	// 多张：**同一个字段名重复多份文件**（OpenAI 多图编辑的形状，也是 T8-penguin-canvas 的做法）
	calls = [];
	const multi = await t.execute(
		{
			prompt: '把这两张融在一起',
			reference: ['data:image/png;base64,iVBORw0KGgo=', 'data:image/jpeg;base64,/9j/4AAQ'],
		},
		{},
	);
	const multiForm = calls[0]?.rawBody;
	check('edits 模式多张 = 同一个 image 字段重复多份（不是数组、不是 image[]）',
		Array.isArray(multiForm?.getAll('image')) && multiForm.getAll('image').length === 2,
		`getAll('image').length=${String(multiForm?.getAll('image')?.length)}`);
	check('多份文件各自带序号文件名，且按顺序（供应商那边靠顺序区分主体/背景）',
		multiForm?.getAll('image')?.[0]?.name === 'reference-1.png' &&
			multiForm?.getAll('image')?.[1]?.name === 'reference-2.jpg',
		(multiForm?.getAll('image') ?? []).map((file) => file.name).join(','));
	check('多张也只用一次请求（两张都是 data:，不需要先下载）', calls.length === 1, `${String(calls.length)} 次`);
	check('结果里记下参考图张数（回执与聊天行要显示它）',
		multi.referenceCount === 2 && multi.usedReference === true,
		JSON.stringify({ used: multi.usedReference, count: multi.referenceCount }));
	check('工具正文里写出张数（用户与模型都看得见）',
		String(t.output.render({}, multi)[0]?.text).includes('带 2 张参考图'),
		String(t.output.render({}, multi)[0]?.text).slice(0, 80));

	// http 参考图在 edits 模式下要**先下载**（供应商要的是字节，不是地址）
	calls = [];
	await t.execute({ prompt: 'x', reference: 'https://cdn.example.com/in.png' }, {});
	check('edits 模式：http 参考图先下载、再 multipart 上传',
		calls.length === 2 &&
			calls[0]?.url === 'https://cdn.example.com/in.png' &&
			calls[1]?.url === 'https://api.example.com/v1/images/edits',
		calls.map((call) => call.url).join(' → '));
}

{
	// ⑥ 附件：用户在输入框里贴的图，由命令直接交给供应商（模型全程看不见）
	const { ctx: c, captured: cap } = makeCtx(configured('openai-images'));
	mod.apply(c);
	const command = cap.commands[0];

	check('命令声明了收附件（不声明的话执行器直接拒绝这次调用）',
		command?.input?.attachments === true, JSON.stringify(command?.input));

	calls = [];
	responder = () => ({ ok: true, status: 200, body: { data: [{ url: 'https://cdn.example.com/att.png' }] } });
	const attachment = { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 8, width: 1, height: 1 };
	const result = await command.handler({
		rawInput: '把这张图变成油画',
		signal: undefined,
		attachments: [{ type: 'image', attachment }],
	});
	check('贴图 + /generate 成功', result.kind === 'success', JSON.stringify(result).slice(0, 100));
	check('附件被读成 data URL 并当作参考图发出',
		String(calls[0]?.body?.image ?? '').startsWith('data:image/png;base64,'),
		String(calls[0]?.body?.image ?? '').slice(0, 40));
	check('递给附件服务的是**会话日志里的完整引用**（不重拼残缺对象）',
		cap.attachmentRefs[0] === attachment,
		JSON.stringify(cap.attachmentRefs[0]));

	// 普通文件附件不是参考图（不该被当成图片塞进去）
	calls = [];
	responder = () => ({ ok: true, status: 200, body: { data: [{ url: 'https://cdn.example.com/att2.png' }] } });
	await command.handler({
		rawInput: 'x',
		signal: undefined,
		attachments: [{ type: 'file', attachment: { attachmentId: 'sha256:def' } }],
	});
	check('非图片附件不参与生成（不写 image 字段）',
		calls[0]?.body?.image === undefined, JSON.stringify(calls[0]?.body));

	// 显式 --ref 优先于附件
	calls = [];
	responder = () => ({ ok: true, status: 200, body: { data: [{ url: 'https://cdn.example.com/att3.png' }] } });
	await command.handler({
		rawInput: '--ref https://cdn.example.com/explicit.png 换个风格',
		signal: undefined,
		attachments: [{ type: 'image', attachment: { attachmentId: 'sha256:abc', mediaType: 'image/png' } }],
	});
	check('--ref 优先于顺手附上的那张图',
		calls[0]?.body?.image === 'https://cdn.example.com/explicit.png',
		String(calls[0]?.body?.image));

	// 多张附件：**全部**按顺序当参考图（升级前只取第一张）
	calls = [];
	responder = () => ({ ok: true, status: 200, body: { data: [{ url: 'https://cdn.example.com/att4.png' }] } });
	await command.handler({
		rawInput: '把这两张融在一起',
		signal: undefined,
		attachments: [
			{ type: 'image', attachment: { attachmentId: 'sha256:one', mediaType: 'image/png' } },
			{ type: 'file', attachment: { attachmentId: 'sha256:skip' } },
			{ type: 'image', attachment: { attachmentId: 'sha256:two', mediaType: 'image/jpeg' } },
		],
	});
	check('多张附件全部当参考图（普通文件跳过），按贴进来的顺序',
		Array.isArray(calls[0]?.body?.image) && calls[0].body.image.length === 2,
		JSON.stringify(calls[0]?.body?.image));
	check('两张附件各读一次字节，顺序 = 附件顺序',
		cap.attachmentRefs.slice(-2).map((ref) => ref.attachmentId).join(',') === 'sha256:one,sha256:two',
		cap.attachmentRefs.slice(-2).map((ref) => ref.attachmentId).join(','));

	// --ref 可重复，顺序进请求体
	calls = [];
	await command.handler({
		rawInput: '--ref https://cdn.example.com/a.png --ref https://cdn.example.com/b.png 融合',
		signal: undefined,
	});
	check('命令行多张 --ref 顺序进请求体（数组）',
		JSON.stringify(calls[0]?.body?.image) === '["https://cdn.example.com/a.png","https://cdn.example.com/b.png"]',
		JSON.stringify(calls[0]?.body?.image));
}

{
	// ⑦ 附件服务缺席：明确报错，而不是静默降级成纯文生图
	const { ctx: c, captured: cap, services } = makeCtx(configured('openai-images'));
	mod.apply(c);
	delete services.attachments;
	const command = cap.commands[0];
	calls = [];
	const result = await command.handler({
		rawInput: 'x',
		signal: undefined,
		attachments: [{ type: 'image', attachment: { attachmentId: 'sha256:abc', mediaType: 'image/png' } }],
	});
	check('附件服务缺席时命令报错', result.kind === 'error', JSON.stringify(result).slice(0, 80));
	check('错误里说明是附件读不到（并给了替代做法）',
		result.text.includes('附件服务'), result.text.slice(0, 80));
	check('没有在没拿到参考图的情况下继续发请求', calls.length === 0, `${String(calls.length)} 次`);
}

{
	// ⑧ 视频首帧：同一个 reference 走视频适配器的字段
	const { ctx: c, captured: cap } = makeCtx(configured('openai-videos', { model: 'seedance' }));
	mod.apply(c);
	const t = cap.tools[0];
	calls = [];
	responder = () => ({ ok: true, status: 200, body: { data: [{ url: 'https://cdn.example.com/v.mp4' }] } });

	await t.execute({ prompt: '让这张图动起来', kind: 'video', reference: 'https://cdn.example.com/in.png' }, {});
	check('视频请求体带参考图字段（首帧）',
		calls[0]?.body?.image === 'https://cdn.example.com/in.png', JSON.stringify(calls[0]?.body));
}

// ─────────── 13. 「看得见就自己看，看不见就给字符串」 ───────────
//
// 参考图的**传递**不依赖模型是否识图；但「自动套用用户附的图」这件事必须看路由能力：
// 多模态模型自己看得见图，参不参考它说了算；纯文本模型手上只有一行摘要，只能由宿主代劳。
console.log('\n13) 参考图的自适应：路由能力 × 会话附件');

/** 造一个会话替身：日志事件 + 路由元数据。 */
const fakeSession = (events, context) => ({
	snapshotEvents: () => events,
	requestContext: () => context,
});

/** 一条「用户附了图」的事件。 */
const userImageEvent = (attachmentId = 'sha256:user-pic') => ({
	type: 'user/message',
	seq: 1,
	time: 0,
	data: {
		id: 'm1',
		role: 'user',
		content: [
			{ type: 'text', text: '把这张改成油画' },
			{ type: 'image', attachment: { attachmentId, mediaType: 'image/png', bytes: 8, width: 1, height: 1 } },
		],
	},
});

const CTX = { provider: 'deepseek-official', model: 'test-model' };

{
	// ① 纯文本路由（目录里明确只支持文本）+ 本回合附了图 → 自动当参考图
	const { ctx: c, captured: cap } = makeCtx(configured('openai-images'));
	cap.llmModels = [{ provider: 'deepseek-official', id: 'test-model', name: 'x', inputModalities: ['text'] }];
	mod.apply(c);
	const t = cap.tools[0];
	const session = fakeSession(
		[{ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } }, userImageEvent()],
		CTX,
	);
	calls = [];
	responder = () => ({ ok: true, status: 200, body: { data: [{ url: 'https://cdn.example.com/auto.png' }] } });

	const value = await t.execute({ prompt: '把这张改成油画' }, { signal: undefined, agent: { session } });
	check('文本路由 + 用户附了图 → 自动把那张图当参考图',
		String(calls[0]?.body?.image ?? '').startsWith('data:image/png;base64,'),
		String(calls[0]?.body?.image ?? '').slice(0, 40));
	check('自动套用也如实回带 usedReference', value.usedReference === true);
}

{
	// ② 多模态路由 → **不**自动套用（模型自己看得见图，参不参考它说了算）
	const { ctx: c, captured: cap } = makeCtx(configured('openai-images'));
	cap.llmModels = [
		{ provider: 'deepseek-official', id: 'test-model', name: 'x', inputModalities: ['text', 'image'] },
	];
	mod.apply(c);
	const t = cap.tools[0];
	const session = fakeSession(
		[{ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } }, userImageEvent()],
		CTX,
	);
	calls = [];
	responder = () => ({ ok: true, status: 200, body: { data: [{ url: 'https://cdn.example.com/vision.png' }] } });

	const value = await t.execute({ prompt: '照着这张画一张' }, { signal: undefined, agent: { session } });
	check('多模态路由：不自动套用（请求体里没有参考图）',
		calls[0]?.body?.image === undefined, JSON.stringify(calls[0]?.body));
	check('多模态路由：结果也不声明参考图', value.usedReference === undefined);
}

{
	// ③ 显式 reference:"attached" → 不看能力，一律用用户附的那张
	const { ctx: c, captured: cap } = makeCtx(configured('openai-images'));
	cap.llmModels = [
		{ provider: 'deepseek-official', id: 'test-model', name: 'x', inputModalities: ['text', 'image'] },
	];
	mod.apply(c);
	const t = cap.tools[0];
	const session = fakeSession(
		[{ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } }, userImageEvent()],
		CTX,
	);
	calls = [];
	responder = () => ({ ok: true, status: 200, body: { data: [{ url: 'https://cdn.example.com/att2.png' }] } });

	await t.execute(
		{ prompt: '照着这张画一张', reference: 'attached' },
		{ signal: undefined, agent: { session } },
	);
	check('reference:"attached" 在多模态路由上照样生效（显式胜过推断）',
		String(calls[0]?.body?.image ?? '').startsWith('data:image/png;base64,'),
		String(calls[0]?.body?.image ?? '').slice(0, 40));
}

{
	// ③b 一轮里附了**多张**图：自动套用与 "attached" 都展开成全部（按贴进来的顺序）
	const twoImages = {
		type: 'user/message',
		seq: 1,
		time: 0,
		data: {
			id: 'm1',
			role: 'user',
			content: [
				{ type: 'text', text: '把这两张融在一起' },
				{ type: 'image', attachment: { attachmentId: 'sha256:pic-1', mediaType: 'image/png', bytes: 8, width: 1, height: 1 } },
				{ type: 'image', attachment: { attachmentId: 'sha256:pic-2', mediaType: 'image/jpeg', bytes: 8, width: 1, height: 1 } },
			],
		},
	};

	const auto = makeCtx(configured('openai-images'));
	auto.captured.llmModels = [{ provider: 'deepseek-official', id: 'test-model', name: 'x', inputModalities: ['text'] }];
	mod.apply(auto.ctx);
	const autoSession = fakeSession(
		[{ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } }, twoImages],
		CTX,
	);
	calls = [];
	responder = () => ({ ok: true, status: 200, body: { data: [{ url: 'https://cdn.example.com/two.png' }] } });
	const autoValue = await auto.captured.tools[0].execute(
		{ prompt: '把这两张融在一起' },
		{ signal: undefined, agent: { session: autoSession } },
	);
	check('文本路由 + 一轮附了两张图 → 两张都自动当参考图（升级前只取第一张）',
		Array.isArray(calls[0]?.body?.image) && calls[0].body.image.length === 2,
		JSON.stringify(calls[0]?.body?.image));
	check('两张的顺序 = 贴进来的顺序（附件读取也按这个顺序）',
		auto.captured.attachmentRefs.map((ref) => ref.attachmentId).join(',') === 'sha256:pic-1,sha256:pic-2',
		auto.captured.attachmentRefs.map((ref) => ref.attachmentId).join(','));
	check('自动套用多张时 referenceCount = 2', autoValue.referenceCount === 2, String(autoValue.referenceCount));

	const explicit = makeCtx(configured('openai-images'));
	explicit.captured.llmModels = [
		{ provider: 'deepseek-official', id: 'test-model', name: 'x', inputModalities: ['text', 'image'] },
	];
	mod.apply(explicit.ctx);
	const explicitSession = fakeSession(
		[{ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } }, twoImages],
		CTX,
	);
	calls = [];
	await explicit.captured.tools[0].execute(
		{ prompt: '融合', reference: ['attached', 'https://cdn.example.com/third.png'] },
		{ signal: undefined, agent: { session: explicitSession } },
	);
	check('"attached" 写在数组里就地展开（附的两张 + 显式给的那张，顺序照写）',
		Array.isArray(calls[0]?.body?.image) &&
			calls[0].body.image.length === 3 &&
			String(calls[0].body.image[0]).startsWith('data:image/') &&
			String(calls[0].body.image[1]).startsWith('data:image/') &&
			calls[0].body.image[2] === 'https://cdn.example.com/third.png',
		JSON.stringify(calls[0]?.body?.image)?.slice(0, 90));
}

{
	// ④ 上一回合附的图**不**算这一轮的参考图（静默套用旧图就是错的结果）
	const { ctx: c, captured: cap } = makeCtx(configured('openai-images'));
	cap.llmModels = [{ provider: 'deepseek-official', id: 'test-model', name: 'x', inputModalities: ['text'] }];
	mod.apply(c);
	const t = cap.tools[0];
	const session = fakeSession(
		[
			{ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
			userImageEvent('sha256:old-pic'),
			{ type: 'turn/end', seq: 2, time: 0, data: { turn: 1, reason: { kind: 'completed' } } },
			{ type: 'turn/start', seq: 3, time: 0, data: { turn: 2 } },
			{ type: 'user/message', seq: 4, time: 0, data: { id: 'm2', role: 'user', content: [{ type: 'text', text: '生成一只猫' }] } },
		],
		CTX,
	);
	calls = [];
	responder = () => ({ ok: true, status: 200, body: { data: [{ url: 'https://cdn.example.com/cat.png' }] } });

	await t.execute({ prompt: '生成一只猫' }, { signal: undefined, agent: { session } });
	check('本回合没有图 → 不套用上一回合的图',
		calls[0]?.body?.image === undefined, JSON.stringify(calls[0]?.body));
}

{
	// ⑤ 工具结果里的图（嵌套在 tool-result 里）不是「用户附的图」
	const { ctx: c, captured: cap } = makeCtx(configured('openai-images'));
	cap.llmModels = [{ provider: 'deepseek-official', id: 'test-model', name: 'x', inputModalities: ['text'] }];
	mod.apply(c);
	const t = cap.tools[0];
	const session = fakeSession(
		[
			{ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
			{
				type: 'user/message',
				seq: 1,
				time: 0,
				data: {
					id: 'm1',
					role: 'user',
					content: [
						{
							type: 'tool-result',
							toolCallId: 'call_1',
							content: [{ type: 'image', attachment: { attachmentId: 'sha256:tool-pic' } }],
						},
					],
				},
			},
		],
		CTX,
	);
	calls = [];
	responder = () => ({ ok: true, status: 200, body: { data: [{ url: 'https://cdn.example.com/t.png' }] } });

	await t.execute({ prompt: 'x' }, { signal: undefined, agent: { session } });
	check('别的工具产出的图不会被当作用户附的参考图',
		calls[0]?.body?.image === undefined, JSON.stringify(calls[0]?.body));
}

{
	// ⑥ 没有会话 / 没有目录信息 → 照自动套用办，但不该崩
	const { ctx: c, captured: cap } = makeCtx(configured('openai-images'));
	mod.apply(c);
	const t = cap.tools[0];
	calls = [];
	responder = () => ({ ok: true, status: 200, body: { data: [{ url: 'https://cdn.example.com/noagent.png' }] } });

	const value = await t.execute({ prompt: 'x' }, { signal: undefined });
	check('没有 agent/会话时正常生成（不套用、也不抛错）',
		value.url === 'https://cdn.example.com/noagent.png' && calls[0]?.body?.image === undefined);
}

{
	// ⑦ 明确要"attached"但这一轮没有图 → 可读错误，且一次请求都不发
	const { ctx: c, captured: cap } = makeCtx(configured('openai-images'));
	mod.apply(c);
	const t = cap.tools[0];
	const session = fakeSession(
		[{ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } }],
		CTX,
	);
	calls = [];
	let message = '';
	try {
		await t.execute({ prompt: 'x', reference: 'attached' }, { signal: undefined, agent: { session } });
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	check('要"attached"却没有图 → 报错并说明怎么办', message.includes('没有图片附件'), message.slice(0, 80));
	check('这种失败不会白跑一次生成', calls.length === 0, `${String(calls.length)} 次`);
}

{
	// ⑧ 超过张数上限 → 报错说清是上限（而不是让供应商回一句看不懂的 400）
	const { ctx: c, captured: cap } = makeCtx(configured('openai-images'));
	mod.apply(c);
	const t = cap.tools[0];
	calls = [];
	let message = '';
	try {
		await t.execute(
			{
				prompt: 'x',
				reference: Array.from({ length: 9 }, (_, i) => `https://cdn.example.com/${String(i)}.png`),
			},
			{ signal: undefined },
		);
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	check('9 张参考图被挡在本地（上限 8），文案说清是张数问题',
		message.includes('最多带 8 张') && message.includes('9 张'), message.slice(0, 80));
	check('超限时一次请求都不发', calls.length === 0, `${String(calls.length)} 次`);

	// 正好 8 张：放行
	calls = [];
	responder = () => ({ ok: true, status: 200, body: { data: [{ url: 'https://cdn.example.com/ok8.png' }] } });
	const eight = await t.execute(
		{ prompt: 'x', reference: Array.from({ length: 8 }, (_, i) => `https://cdn.example.com/${String(i)}.png`) },
		{ signal: undefined },
	);
	check('正好 8 张照发（上限不是 7）',
		Array.isArray(calls[0]?.body?.image) && calls[0].body.image.length === 8 && eight.referenceCount === 8,
		String(calls[0]?.body?.image?.length));
}

// ─────────── 14. 视觉模型：给看不见图的模型配一双眼睛 ───────────
//
// 文本模型看不到参考图，于是由**视觉模型**把图读成一段文字：这段文字既拼进生成
// 提示词前面，也随工具结果回给模型自己。配置与图像 / 视频模型并排（同一个
// providers 字典 + defaultVision），因此密钥不必配第二遍。
console.log('\n14) 视觉模型：参考图 → 文字 → 提示词');

/** 一个同时挂了图像模型与视觉模型的供应商。 */
const visionConfig = () => ({
	providers: {
		acme: {
			label: '',
			baseURL: 'https://api.example.com/v1',
			apiKeyEnv: refOf('acme'),
			models: [
				{ id: 'test-model', kind: 'image', apiKeyEnv: '', label: '' },
				{ id: 'vl-model', kind: 'vision', apiKeyEnv: '', label: '' },
			],
		},
	},
	defaultVision: 'acme::vl-model',
});

/** 视觉模型的回答；以及一条「看不见图」的路由会话。 */
const VISION_TEXT = '一只橘猫坐在窗台上，暖色调，浅景深。';
const blindSession = () =>
	fakeSession([{ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } }, userImageEvent()], CTX);

{
	// ① 解析与选择
	const lib = await libImport('lib/host/schema.js');
	const probeLib = await libImport('lib/host/probe.js');
	const models = lib.resolveModels(visionConfig(), () => 'sk');
	const vl = lib.findVisionModel(models);
	check('视觉模型被解析成自己的种类，并被 defaultVision 认成默认',
		vl?.ref === 'acme::vl-model' && vl.kind === 'vision' && vl.api === 'openai-vision',
		JSON.stringify([vl?.ref, vl?.kind, vl?.api]));
	check('findVisionModel 没配时返回 undefined（可选功能，不抛错）',
		lib.findVisionModel(lib.resolveModels(configured('openai-images'), () => 'sk')) === undefined);
	check('图像候选里不会混进视觉模型（pickModel 仍然只挑图像 / 视频）',
		lib.pickModel(models, 'image', '').ref === 'acme::test-model',
		lib.pickModel(models, 'image', '').ref);
	check('guessKind：视觉模型名能被认出来（获取模型列表后的预填）',
		(() => {
			const g = probeLib.guessKind;
			return (
				g('qwen2.5-vl-72b') === 'vision' &&
				g('gpt-4o-mini') === 'vision' &&
				g('sora-2') === 'video' &&
				g('gpt-image-1') === 'image'
			);
		})(),
		`${probeLib.guessKind('qwen2.5-vl-72b')} / ${probeLib.guessKind('gpt-4o-mini')}`);
}

{
	// ② 看不见图 + 配了视觉模型 → 先描述、再把描述拼进提示词
	const { ctx: c, captured: cap } = makeCtx(visionConfig());
	cap.llmModels = [{ provider: 'deepseek-official', id: 'test-model', name: 'x', inputModalities: ['text'] }];
	mod.apply(c);
	const t = cap.tools[0];
	calls = [];
	responder = (url) =>
		String(url).includes('/chat/completions')
			? { ok: true, status: 200, body: { choices: [{ message: { content: VISION_TEXT } }] } }
			: { ok: true, status: 200, body: { data: [{ url: 'https://cdn.example.com/out.png' }] } };

	const value = await t.execute(
		{ prompt: '把这张改成油画' },
		{ signal: undefined, agent: { session: blindSession() } },
	);

	check('第一步：视觉模型收到 chat/completions 请求',
		calls[0]?.url === 'https://api.example.com/v1/chat/completions', String(calls[0]?.url));
	check('视觉请求用的是视觉模型（不是图像模型）',
		calls[0]?.body?.model === 'vl-model', String(calls[0]?.body?.model));
	check('视觉请求把参考图当 image_url 传进去（内联地址，供应商不必去下载）',
		String(calls[0]?.body?.messages?.[0]?.content?.[1]?.image_url?.url ?? '').startsWith('data:image/png;base64,'),
		String(calls[0]?.body?.messages?.[0]?.content?.[1]?.image_url?.url ?? '').slice(0, 32));
	check('视觉请求带上了用户要求（语言与意图的线索）',
		String(calls[0]?.body?.messages?.[0]?.content?.[0]?.text ?? '').includes('把这张改成油画'));

	check('第二步：生成请求打到图像端点', calls[1]?.url === 'https://api.example.com/v1/images/generations');
	check('描述被注入到提示词前面，用户句紧随其后',
		calls[1]?.body?.prompt === `参考图内容：${VISION_TEXT}\n\n把这张改成油画`,
		String(calls[1]?.body?.prompt));
	check('参考图照样发给生成模型（两手都要）',
		String(calls[1]?.body?.image ?? '').startsWith('data:image/png;base64,'));
	check('结果回带 referenceDescription（模型自己也能看到图里有什么）',
		value.referenceDescription === VISION_TEXT, String(value.referenceDescription));
	check('工具结果正文里有那段描述（模型接着讨论 / 改提示词都靠它）',
		String(t.output.render({}, value)?.[0]?.text ?? '').includes(`参考图内容：${VISION_TEXT}`),
		String(t.output.render({}, value)?.[0]?.text ?? '').slice(0, 120));
	check('presentationMeta 也带描述（界面上能核对视觉模型看到了什么）',
		t.output.presentationMeta({}, value)?.fatfishCanvas?.referenceDescription === VISION_TEXT);
}

{
	// ②b 多张参考图：**一次**视觉调用里带多个 image_url 内容块（不是逐张调用）
	const { ctx: c, captured: cap } = makeCtx(visionConfig());
	cap.llmModels = [{ provider: 'deepseek-official', id: 'test-model', name: 'x', inputModalities: ['text'] }];
	mod.apply(c);
	const t = cap.tools[0];
	calls = [];
	responder = (url) =>
		String(url).includes('/chat/completions')
			? { ok: true, status: 200, body: { choices: [{ message: { content: VISION_TEXT } }] } }
			: { ok: true, status: 200, body: { data: [{ url: 'https://cdn.example.com/out2.png' }] } };

	await t.execute(
		{
			prompt: '把这两张融在一起',
			reference: ['data:image/png;base64,iVBORw0KGgo=', 'https://cdn.example.com/second.png'],
		},
		{ signal: undefined, agent: { session: blindSession() } },
	);

	const parts = calls[0]?.body?.messages?.[0]?.content ?? [];
	check('多张参考图只花**一次**视觉调用（content 里多个 image_url 块）',
		calls.filter((call) => String(call.url).includes('/chat/completions')).length === 1 &&
			parts.filter((part) => part?.type === 'image_url').length === 2,
		`视觉调用 ${String(calls.filter((call) => String(call.url).includes('/chat/completions')).length)} 次，image_url 块 ${String(parts.filter((part) => part?.type === 'image_url').length)} 个`);
	check('两个 image_url 块按给的顺序（第一张是 data:，第二张是那个地址）',
		String(parts[1]?.image_url?.url ?? '').startsWith('data:image/png;base64,') &&
			parts[2]?.image_url?.url === 'https://cdn.example.com/second.png',
		String(parts[2]?.image_url?.url ?? ''));
	check('生成请求里也是两张（描述归描述，参考图照发）',
		Array.isArray(calls[1]?.body?.image) && calls[1].body.image.length === 2,
		JSON.stringify(calls[1]?.body?.image)?.slice(0, 80));
}

{
	// ③ 视觉模型返回分块 content 也能读（部分网关用这种形状）
	const { ctx: c, captured: cap } = makeCtx(visionConfig());
	cap.llmModels = [{ provider: 'deepseek-official', id: 'test-model', name: 'x', inputModalities: ['text'] }];
	mod.apply(c);
	const t = cap.tools[0];
	calls = [];
	responder = (url) =>
		String(url).includes('/chat/completions')
			? {
					ok: true,
					status: 200,
					body: {
						choices: [{ message: { content: [{ type: 'text', text: '一只' }, { type: 'text', text: '黑猫' }] } }],
					},
				}
			: { ok: true, status: 200, body: { data: [{ url: 'https://cdn.example.com/out.png' }] } };

	const value = await t.execute({ prompt: 'x' }, { signal: undefined, agent: { session: blindSession() } });
	check('分块 content 被拼成一段文字', value.referenceDescription === '一只黑猫', String(value.referenceDescription));
}

{
	// ④ 没配视觉模型 → 一次多余的请求都不发，行为与从前完全一致
	const { ctx: c, captured: cap } = makeCtx(configured('openai-images'));
	cap.llmModels = [{ provider: 'deepseek-official', id: 'test-model', name: 'x', inputModalities: ['text'] }];
	mod.apply(c);
	const t = cap.tools[0];
	calls = [];
	responder = () => ({ ok: true, status: 200, body: { data: [{ url: 'https://cdn.example.com/out.png' }] } });

	const value = await t.execute(
		{ prompt: '把这张改成油画' },
		{ signal: undefined, agent: { session: blindSession() } },
	);
	check('没配视觉模型：只打生成端点（没有 chat/completions）',
		calls.length === 1 && calls[0]?.url === 'https://api.example.com/v1/images/generations',
		calls.map((call) => call.url).join(' → '));
	check('没配视觉模型：提示词的用户句还是原文（描述没有变进来）',
		calls[0]?.body?.prompt === `把这张改成油画`, String(calls[0]?.body?.prompt));
	check('没配视觉模型：结果里没有描述字段', value.referenceDescription === undefined);
}

{
	// ⑤ 看得见图的路由 → 不做描述（模型自己看得见，不必别人转述）
	const { ctx: c, captured: cap } = makeCtx(visionConfig());
	cap.llmModels = [
		{ provider: 'deepseek-official', id: 'test-model', name: 'x', inputModalities: ['text', 'image'] },
	];
	mod.apply(c);
	const t = cap.tools[0];
	calls = [];
	responder = () => ({ ok: true, status: 200, body: { data: [{ url: 'https://cdn.example.com/out.png' }] } });

	const value = await t.execute(
		{ prompt: '照着这张画', reference: 'https://cdn.example.com/ref.png' },
		{ signal: undefined, agent: { session: blindSession() } },
	);
	check('多模态路由：不调用视觉模型、也不注入描述（用户句原文；缺省技能在尾部）',
		calls.length === 1 && calls[0]?.body?.prompt === `照着这张画`,
		`${String(calls[0]?.body?.prompt).slice(0, 40)} / ${calls.map((call) => call.url).join(' → ')}`);
	check('多模态路由：结果里没有描述字段', value.referenceDescription === undefined);
}

{
	// ⑥ 视觉模型炸了（密钥错 / 端点不通）→ 生成照常进行
	const { ctx: c, captured: cap } = makeCtx(visionConfig());
	cap.llmModels = [{ provider: 'deepseek-official', id: 'test-model', name: 'x', inputModalities: ['text'] }];
	mod.apply(c);
	const t = cap.tools[0];
	calls = [];
	responder = (url) =>
		String(url).includes('/chat/completions')
			? { ok: false, status: 401, body: '{"error":{"message":"bad key"}}' }
			: { ok: true, status: 200, body: { data: [{ url: 'https://cdn.example.com/out.png' }] } };

	const value = await t.execute(
		{ prompt: '把这张改成油画' },
		{ signal: undefined, agent: { session: blindSession() } },
	);
	check('视觉模型失败不打断生成（可选项坏掉不该让整件事做不了）',
		value.url === 'https://cdn.example.com/out.png', String(value.url));
	check('这种失败下提示词退回原文（不塞半句失败说明进去；缺省技能在尾部同上）',
		calls[1]?.body?.prompt === `把这张改成油画`, String(calls[1]?.body?.prompt));
	check('失败也不谎报描述', value.referenceDescription === undefined);
}

{
	// ⑦ 这一轮没有参考图 → 不描述（没有图可读）
	const { ctx: c, captured: cap } = makeCtx(visionConfig());
	cap.llmModels = [{ provider: 'deepseek-official', id: 'test-model', name: 'x', inputModalities: ['text'] }];
	mod.apply(c);
	const t = cap.tools[0];
	calls = [];
	responder = () => ({ ok: true, status: 200, body: { data: [{ url: 'https://cdn.example.com/out.png' }] } });

	// 这一轮只有文字（没有图片附件）→ 连参考图都没有，自然没什么可描述
	const textOnly = fakeSession(
		[
			{ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
			{ type: 'user/message', seq: 1, time: 0, data: { id: 'm1', role: 'user', content: [{ type: 'text', text: '一只柴犬' }] } },
		],
		CTX,
	);
	await t.execute({ prompt: '一只柴犬' }, { signal: undefined, agent: { session: textOnly } });
	check('没有参考图：不发视觉请求（用户句原文；缺省技能在尾部）',
		calls.length === 1 && calls[0]?.body?.prompt === `一只柴犬`,
		`${String(calls[0]?.body?.prompt).slice(0, 40)} / ${calls.map((call) => call.url).join(' → ')}`);
}

// ─────────── 14b. MJ 图生文：提交 + 轮询（`wire: 'mj-describe'`） ───────────
//
// 与缺省那条 `chat/completions` 毫无共同点：**不是一次往返**，而且描述文字
// 落在 `prompt` 里、`description` 是斜杠命令（实测 ai.t8star.org：完成时字面量
// `"/describe"`，刚提交时 `"提交成功"`）—— 照字段名想当然取 `description`，
// 拿到的就是一句 "/describe"。
{
	const MJ_TEXT = '一只橘猫坐在窗台上，暖色调，浅景深。';
	const mjConfig = () => ({
		providers: {
			mj: {
				label: '',
				baseURL: 'https://mj.example.com',
				apiKeyEnv: refOf('mj'),
				models: [{ id: 'mj-describe', kind: 'vision', apiKeyEnv: '', label: '' }],
			},
			acme: {
				label: '',
				baseURL: 'https://api.example.com/v1',
				apiKeyEnv: refOf('acme'),
				models: [{ id: 'test-model', kind: 'image', apiKeyEnv: '', label: '' }],
			},
		},
		defaultVision: 'mj::mj-describe',
	});
	const mjTool = async () => {
		const { ctx: c, captured: cap } = makeCtx(mjConfig());
		cap.llmModels = [
			{ provider: 'deepseek-official', id: 'test-model', name: 'x', inputModalities: ['text'] },
		];
		mod.apply(c);
		calls = [];
		return cap.tools[0];
	};
	const pollCount = () => calls.filter((call) => String(call.url).includes('/mj/task/')).length;

	// ① 提交 → NOT_START（不算结果）→ SUCCESS（文字在 prompt 里）→ 照常生成
	const t = await mjTool();
	responder = jsonResponder([
		{ ok: true, status: 200, body: { code: 1, description: '提交成功', result: 'task-77' } },
		{ ok: true, status: 200, body: { status: 'NOT_START', progress: '0%', prompt: '', description: '提交成功' } },
		{ ok: true, status: 200, body: { status: 'SUCCESS', progress: '100%', prompt: MJ_TEXT, description: '/describe' } },
		{ ok: true, status: 200, body: { data: [{ url: 'https://cdn.example.com/mj-out.png' }] } },
	]);

	const value = await t.execute(
		{ prompt: '把这张改成油画' },
		{ signal: undefined, agent: { session: blindSession() } },
	);
	check('MJ 图生文：模型 id 命中预置后走提交端点（不是 chat/completions）',
		calls[0]?.url === 'https://mj.example.com/mj/submit/describe', String(calls[0]?.url));
	check('MJ 图生文：图片以 base64 内联，且请求体里没有 model（端点自己就是模型）',
		String(calls[0]?.body?.base64 ?? '').startsWith('data:image/png;base64,') &&
			calls[0]?.body?.model === undefined,
		`${String(calls[0]?.body?.base64 ?? '').slice(0, 24)} / model=${String(calls[0]?.body?.model)}`);
	check('MJ 图生文：轮询打到任务地址，任务 id 取自提交响应的 result',
		calls[1]?.url === 'https://mj.example.com/mj/task/task-77/fetch' && calls[1]?.method === 'GET',
		`${String(calls[1]?.method)} ${String(calls[1]?.url)}`);
	check('MJ 图生文：NOT_START 不当结果（接着轮询，第二次才拿到文字）', pollCount() === 2, String(pollCount()));
	check('MJ 图生文：文字取自 prompt（description 是 "/describe"，不是结果）',
		value.referenceDescription === MJ_TEXT, String(value.referenceDescription));
	check('MJ 图生文：描述照样拼进生成提示词（缺省技能缀尾）',
		calls[3]?.body?.prompt === `参考图内容：${MJ_TEXT}\n\n把这张改成油画`,
		String(calls[3]?.body?.prompt));

	// ② 任务失败 → 明确的失败说明（别让它一路等到超时）
	//    失败态**先于**文字判：这个网关别的状态下 `prompt` 也可能有值（命令原文），
	//    所以这里故意给一个非空的 `prompt`，证明失败不会被读成成功。
	const t2 = await mjTool();
	responder = jsonResponder([
		{ ok: true, status: 200, body: { code: 1, description: '提交成功', result: 'task-78' } },
		{
			ok: true,
			status: 200,
			body: { status: 'FAILURE', failReason: '未订阅', prompt: '/describe', description: '' },
		},
		{ ok: true, status: 200, body: { data: [{ url: 'https://cdn.example.com/mj-out2.png' }] } },
	]);
	const value2 = await t2.execute(
		{ prompt: '把这张改成油画' },
		{ signal: undefined, agent: { session: blindSession() } },
	);
	check('MJ 图生文：任务失败不谎报描述、也不打断生成',
		value2.referenceDescription === undefined && value2.url === 'https://cdn.example.com/mj-out2.png',
		`${String(value2.referenceDescription)} / ${String(value2.url)}`);

	// ③ 提交就被拒（没有任务 id）→ 一次轮询都不发
	const t3 = await mjTool();
	responder = jsonResponder([
		{ ok: true, status: 200, body: { code: 4, description: '无可用账号', result: '' } },
		{ ok: true, status: 200, body: { data: [{ url: 'https://cdn.example.com/mj-out3.png' }] } },
	]);
	await t3.execute({ prompt: '把这张改成油画' }, { signal: undefined, agent: { session: blindSession() } });
	check('MJ 图生文：提交没给任务 id 时不轮询（省掉一次必然超时的等待）',
		pollCount() === 0 && calls.length === 2, calls.map((call) => call.url).join(' → '));
}

// ─────────── 14c. MJ 出图：提交 + 轮询，参数进提示词（`wire: 'mj-imagine'`） ───────────
//
// 实测（2026-10-05，ai.t8star.org）：`POST {base}/mj/submit/imagine {prompt}` → `code=1`
// ＋任务 id；轮询到 `status: SUCCESS` 才出图 —— 整个提交到完成约 **105 秒**，
// `imageUrl` 是 **四宫格**（2912×1632，`--ar 16:9` 生效），四张 1456×816 的分图在
// `imageUrls` 里（本插件一次调用 = 一张图，所以只取 `imageUrl`）。
//
// 两处与别家不同，都要在这里钉死：①**参数不是请求体字段，而是提示词里的 flag**；
// ②`imageUrl` 在「执行中」也可能有值 —— 先读它会把一张进度图读成成品（§8.64 同类）。
console.log('\n14c) MJ 出图：提交 + 轮询（wire: mj-imagine）');

{
	const mjImageConfig = (params = { stylize: '250' }) => ({
		providers: {
			mj: {
				label: '',
				baseURL: 'https://mj.example.com',
				apiKeyEnv: refOf('mj'),
				models: [{ id: 'mj_fast_imagine', kind: 'image', apiKeyEnv: '', label: '' }],
			},
		},
		defaultImage: 'mj::mj_fast_imagine',
		commonModels: { 'mj::mj_fast_imagine': { params } },
	});
	const mjImageTool = async (config = mjImageConfig()) => {
		const { ctx: c, captured: cap } = makeCtx(config);
		mod.apply(c);
		calls = [];
		return cap.tools[0];
	};

	// ① 提交 → 执行中（**已经带 imageUrl**）→ 成功
	const t = await mjImageTool();
	responder = jsonResponder([
		{ ok: true, status: 200, body: { code: 1, description: '提交成功', result: 'task-91' } },
		{
			ok: true,
			status: 200,
			body: { status: 'IN_PROGRESS', progress: '81%', imageUrl: 'https://cdn.example.com/progress.png' },
		},
		{ ok: true, status: 200, body: { status: 'SUCCESS', progress: '100%', imageUrl: 'https://cdn.example.com/grid.png' } },
	]);
	const value = await t.execute({ prompt: '一只猫', aspectRatio: '16:9' }, { signal: undefined });

	check(
		'MJ 出图：打到 {base}/mj/submit/imagine',
		calls[0]?.url === 'https://mj.example.com/mj/submit/imagine',
		String(calls[0]?.url),
	);
	check(
		'MJ 出图：请求体只有 prompt（没有 model / n / size 这些别家的字段）',
		Object.keys(calls[0]?.body ?? {}).join(',') === 'prompt',
		JSON.stringify(calls[0]?.body),
	);
	check(
		'MJ 出图：比例与设置里的参数都拼进提示词，而不是摊进请求体（缺省技能文案在用户句后、flag 仍在最后 —— MJ 的 flag 扫描认全句）',
		calls[0]?.body?.prompt === `一只猫 --ar 16:9 --stylize 250`,
		String(calls[0]?.body?.prompt),
	);
	check(
		'MJ 出图：轮询打 /mj/task/<id>/fetch，任务 id 取自 result',
		calls[1]?.url === 'https://mj.example.com/mj/task/task-91/fetch' && calls[1]?.method === 'GET',
		`${String(calls[1]?.method)} ${String(calls[1]?.url)}`,
	);
	check(
		'MJ 出图：执行中就给 imageUrl 也不算结果（继续轮询，第三次才成品）',
		calls.length === 3 && value.url === 'https://cdn.example.com/grid.png',
		`${String(calls.length)} 次 / ${String(value.url)}`,
	);
	check('MJ 出图：比例照旧回带（客户端据此定节点形状）', value.aspectRatio === '16:9', String(value.aspectRatio));

	// ② 用户自己声明了比例 → **不写两个 --ar**（MJ 认最后一个，写两个等于设置没生效）
	const t2 = await mjImageTool(mjImageConfig({ ar: '1:1' }));
	responder = jsonResponder([
		{ ok: true, status: 200, body: { code: 1, description: '提交成功', result: 'task-92' } },
		{ ok: true, status: 200, body: { status: 'SUCCESS', progress: '100%', imageUrl: 'https://cdn.example.com/grid2.png' } },
	]);
	await t2.execute({ prompt: '一只狗', aspectRatio: '16:9' }, { signal: undefined });
	check(
		'MJ 出图：设置里声明了比例时只写一个 --ar（设置赢）',
		calls[0]?.body?.prompt === `一只狗 --ar 1:1`,
		String(calls[0]?.body?.prompt),
	);

	// ③ 无值开关：true 写裸 flag、false 不写（MJ 没有 --no-tile）
	const t3 = await mjImageTool(mjImageConfig({}));
	responder = jsonResponder([
		{ ok: true, status: 200, body: { code: 1, description: '提交成功', result: 'task-93' } },
		{ ok: true, status: 200, body: { status: 'SUCCESS', progress: '100%', imageUrl: 'https://cdn.example.com/grid3.png' } },
	]);
	await t3.execute({ prompt: 'x', params: { tile: true } }, { signal: undefined });
	check('MJ 出图：无值开关（tile）写成裸 --tile', calls[0]?.body?.prompt === `x --ar 1:1 --tile`, String(calls[0]?.body?.prompt));
	// 队列用完会一直回最后一个响应 —— 再跑一次要换一条新队列
	calls = [];
	responder = jsonResponder([
		{ ok: true, status: 200, body: { code: 1, description: '提交成功', result: 'task-93b' } },
		{ ok: true, status: 200, body: { status: 'SUCCESS', progress: '100%', imageUrl: 'https://cdn.example.com/grid3b.png' } },
	]);
	await t3.execute({ prompt: 'x', params: { tile: false } }, { signal: undefined });
	check(
		'MJ 出图：开关传 false = 不写这个 flag',
		calls[0]?.body?.prompt === `x --ar 1:1`,
		String(calls[0]?.body?.prompt),
	);

	// ④ 垫图：参考图进 base64Array（MJ 只收 base64，与 describe 同一条规矩）
	const t4 = await mjImageTool(mjImageConfig());
	responder = jsonResponder([
		{ ok: true, status: 200, body: { code: 1, description: '提交成功', result: 'task-94' } },
		{ ok: true, status: 200, body: { status: 'SUCCESS', progress: '100%', imageUrl: 'https://cdn.example.com/grid4.png' } },
	]);
	await t4.execute({ prompt: '照着这张画', reference: 'data:image/png;base64,QUJD' }, { signal: undefined });
	check(
		'MJ 出图：参考图进 base64Array（data: 内联），请求体里没有 image 字段',
		JSON.stringify(calls[0]?.body?.base64Array) === '["data:image/png;base64,QUJD"]' &&
			calls[0]?.body?.image === undefined,
		JSON.stringify(calls[0]?.body),
	);

	// ⑤ 任务失败：报 failReason，**不是**拿执行中的那张图当结果
	const t5 = await mjImageTool(mjImageConfig());
	responder = jsonResponder([
		{ ok: true, status: 200, body: { code: 1, description: '提交成功', result: 'task-95' } },
		{
			ok: true,
			status: 200,
			body: { status: 'FAILURE', failReason: 'Banned prompt', imageUrl: 'https://cdn.example.com/partial.png' },
		},
	]);
	let message = '';
	try {
		await t5.execute({ prompt: 'x' }, { signal: undefined });
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	check(
		'MJ 出图：任务失败时报出 failReason（带图也不当结果）',
		message.includes('FAILURE') && message.includes('Banned prompt'),
		message.slice(0, 120),
	);

	// ⑥ 提交被拒（没有任务 id）→ 一次轮询都不发
	const t6 = await mjImageTool(mjImageConfig());
	responder = jsonResponder([{ ok: true, status: 200, body: { code: 24, description: '可能包含敏感词', result: '' } }]);
	message = '';
	try {
		await t6.execute({ prompt: 'x' }, { signal: undefined });
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	check(
		'MJ 出图：提交被拒时报出供应商的说法，且不轮询',
		message.includes('可能包含敏感词') && calls.length === 1,
		`${message.slice(0, 60)} / ${String(calls.length)} 次`,
	);
}

// ─────────── 14d. kie.ai 的任务式协议（供应商级 `wire: 'kie-jobs'`） ───────────
//
// 实测（2026-10-13，api.kie.ai）：
//   POST {base}/jobs/createTask { model, input } → { code: 200, data: { taskId } }
//   GET  {base}/jobs/recordInfo?taskId=…         → { code: 200, data: { state, resultJson } }
//
// 三处与别家不同，都要在这里钉死：①参数全在 `input` 里（不是平铺请求体）；
// ②任务 id 走**查询串**，不是 `{提交路径}/{id}`；③失败藏在 HTTP 200 的
// `body.code` 里（这家不看状态码），而结果在 **JSON 字符串** `resultJson` 里。
console.log('\n14d) kie.ai：createTask 提交 + recordInfo 轮询（wire: kie-jobs）');

{
	/** kie 供应商配置：wire 挂在**供应商**上（同一模型名在别家中转是另一种协议）。 */
	const kieConfig = (over = {}) =>
		configured('kie', {
			model: 'seedream/5-pro-image-to-image',
			provider: { wire: 'kie-jobs', ...(over.provider ?? {}) },
			...over,
		});
	const kieTool = async (config = kieConfig()) => {
		const { ctx: c, captured: cap } = makeCtx(config);
		mod.apply(c);
		calls = [];
		return cap.tools[0];
	};
	const kieOk = (state, urls) => ({
		ok: true,
		status: 200,
		body: {
			code: 200,
			msg: 'success',
			data: { state, resultJson: urls === undefined ? null : JSON.stringify({ resultUrls: urls }) },
		},
	});

	// ① 提交 → 执行中 → 成功
	const t = await kieTool();
	responder = jsonResponder([
		{ ok: true, status: 200, body: { code: 200, msg: 'success', data: { taskId: 'task-77' } } },
		{ ok: true, status: 200, body: { code: 200, data: { state: 'generating', resultJson: null } } },
		kieOk('success', ['https://cdn.example.com/kie.png']),
	]);
	const value = await t.execute({ prompt: '一只猫', aspectRatio: '16:9' }, { signal: undefined });

	check(
		'kie：打到 {base}/jobs/createTask',
		calls[0]?.url === 'https://api.example.com/v1/jobs/createTask',
		String(calls[0]?.url),
	);
	check(
		'kie：体是 { model, input }，提示词与比例都在 input 里（不是平铺请求体）',
		calls[0]?.body?.model === 'seedream/5-pro-image-to-image' &&
			calls[0]?.body?.input?.prompt === '一只猫' &&
			calls[0]?.body?.input?.aspect_ratio === '16:9' &&
			calls[0]?.body?.prompt === undefined &&
			calls[0]?.body?.aspect_ratio === undefined,
		JSON.stringify(calls[0]?.body),
	);
	check(
		'kie：轮询打 recordInfo，任务 id 在查询串里（不是 {提交路径}/{id}）',
		calls[1]?.url === 'https://api.example.com/v1/jobs/recordInfo?taskId=task-77' && calls[1]?.method === 'GET',
		`${String(calls[1]?.method)} ${String(calls[1]?.url)}`,
	);
	check(
		'kie：执行中（state=generating）不算结果；resultJson 是字符串，要再解析一次才拿得到 resultUrls',
		calls.length === 3 && value.url === 'https://cdn.example.com/kie.png',
		`${String(calls.length)} 次 / ${String(value.url)}`,
	);

	// ② 参考图：字段名默认 `image_urls`（不是缺省那条路的 `image`），且是数组
	const t2 = await kieTool();
	responder = jsonResponder([
		{ ok: true, status: 200, body: { code: 200, data: { taskId: 'task-78' } } },
		kieOk('success', ['https://cdn.example.com/kie2.png']),
	]);
	await t2.execute({ prompt: '照着这张画', reference: 'data:image/png;base64,QUJD' }, { signal: undefined });
	check(
		'kie：参考图进 input.image_urls（数组），不带缺省那条路的 image 字段',
		JSON.stringify(calls[0]?.body?.input?.image_urls) === '["data:image/png;base64,QUJD"]' &&
			calls[0]?.body?.input?.image === undefined,
		JSON.stringify(calls[0]?.body?.input),
	);

	// ③ 密钥不对：HTTP 200 里藏 code 401 —— 必须当失败，且一次轮询都不发
	const t3 = await kieTool();
	responder = jsonResponder([
		{ ok: true, status: 200, body: { code: 401, msg: 'Unauthorized – Authentication failed', data: null } },
	]);
	let message = '';
	try {
		await t3.execute({ prompt: 'x' }, { signal: undefined });
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	check(
		'kie：HTTP 200 + code 401 也当失败报出来（这家不看状态码），且不轮询',
		message.includes('401') && message.includes('Unauthorized') && calls.length === 1,
		`${message.slice(0, 80)} / ${String(calls.length)} 次`,
	);

	// ④ 任务失败：报 failCode / failMsg
	const t4 = await kieTool();
	responder = jsonResponder([
		{ ok: true, status: 200, body: { code: 200, data: { taskId: 'task-79' } } },
		{ ok: true, status: 200, body: { code: 200, data: { state: 'fail', failCode: 'NSFW', failMsg: '内容不合规' } } },
	]);
	message = '';
	try {
		await t4.execute({ prompt: 'x' }, { signal: undefined });
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	check(
		'kie：任务失败时报出 failCode 与 failMsg',
		message.includes('NSFW') && message.includes('内容不合规'),
		message.slice(0, 120),
	);

	// ⑤ 视频走同一条路；**没传的键一个都不写** —— 与缺省那条视频路不同（那边无条件
	// 补 duration:5 / resolution:'480p'），kie 的 input 校验严，凭空补一个这个模型
	// 不认的键就是 422。
	const t5 = await kieTool(kieConfig({ model: 'kling-3.0/video', kind: 'video' }));
	responder = jsonResponder([
		{ ok: true, status: 200, body: { code: 200, data: { taskId: 'task-80' } } },
		kieOk('success', ['https://cdn.example.com/kie.mp4']),
	]);
	const video = await t5.execute({ prompt: '一只猫在跑', kind: 'video' }, { signal: undefined });
	check(
		'kie：视频也打 createTask，duration / resolution 没传就一个都不写（比例照旧带上）',
		calls[0]?.url === 'https://api.example.com/v1/jobs/createTask' &&
			calls[0]?.body?.input?.duration === undefined &&
			calls[0]?.body?.input?.resolution === undefined &&
			calls[0]?.body?.input?.aspect_ratio === '16:9',
		JSON.stringify(calls[0]?.body?.input),
	);
	check(
		'kie：视频结果照旧从 resultUrls 取，kind 跟着模型走',
		video.kind === 'video' && video.url === 'https://cdn.example.com/kie.mp4',
		`${String(video.kind)} ${String(video.url)}`,
	);

	// ⑥ 真传了 duration 就照传（工具参数 → input.duration，不被吞掉）
	calls = [];
	responder = jsonResponder([
		{ ok: true, status: 200, body: { code: 200, data: { taskId: 'task-81' } } },
		kieOk('success', ['https://cdn.example.com/kie2.mp4']),
	]);
	await t5.execute({ prompt: '一只猫在跑', kind: 'video', duration: 8 }, { signal: undefined });
	check(
		'kie：调用时传的 duration 进 input（不是被吞掉）',
		calls[0]?.body?.input?.duration === 8,
		JSON.stringify(calls[0]?.body?.input),
	);
}

// ─────────── 15. 常用模型：预置 / 其他参数 / 请求体（P29） ───────────
console.log('\n15) 常用模型：类型预置与其他参数');

{
	const { resolveModels } = schema;
	const key = () => 'sk-test-key';
	const configOf = (models, extra = {}) => ({
		providers: {
			acme: {
				label: 'Acme',
				baseURL: 'https://api.example.com/v1',
				apiKeyEnv: 'FFC_ACME_API_KEY',
				models,
			},
		},
		...extra,
	});

	// ── 预置按**词干**匹配：-2k / -4k 尾缀的兄弟自动共用同一份配置 ──
	const family = resolveModels(
		configOf([
			{ id: 'gpt-image-2', kind: 'image', apiKeyEnv: '', label: '' },
			{ id: 'gpt-image-2-2k', kind: 'image', apiKeyEnv: '', label: '' },
			{ id: 'gpt-image-2-4k', kind: 'image', apiKeyEnv: '', label: '' },
		]),
		key,
	);
	check(
		'预置：带 2K / 4K 尾缀的兄弟命中同一条预置（同一类型的模型共用一份配置）',
		family.every((model) => model.presetId === 'gpt-image-2'),
		family.map((model) => `${model.modelId}=${model.presetId}`).join(','),
	);
	check(
		'预置：质量轴摆出来了，但**默认不传**（fallback 空串 = 用户点一下才进请求体）',
		family[0]?.axis?.param === 'quality' && Object.keys(family[0]?.params ?? {}).length === 0,
		JSON.stringify({ axis: family[0]?.axis?.param, params: family[0]?.params }),
	);
	check(
		'预置：声明了其他参数的键（尺寸 / 背景 / 格式…），模型调用时才知道能传什么',
		family[0]?.paramSpecs.some((spec) => spec.key === 'size') === true &&
			family[0]?.paramSpecs.some((spec) => spec.key === 'background') === true,
		(family[0]?.paramSpecs ?? []).map((spec) => spec.key).join(','),
	);
	check(
		'预置：2.5 的取值比 2 多（更具体的前缀优先匹配）',
		resolveModels(configOf([{ id: 'gpt-image-2.5-sunburst-4k', kind: 'image', apiKeyEnv: '', label: '' }]), key)[0]
			?.presetId === 'gpt-image-2.5',
		String(
			resolveModels(configOf([{ id: 'gpt-image-2.5-sunburst-4k', kind: 'image', apiKeyEnv: '', label: '' }]), key)[0]
				?.presetId,
		),
	);

	// ── 质量档：选了才传；手写声明优先于预置 ──
	const picked = resolveModels(
		configOf([{ id: 'gpt-image-2-4k', kind: 'image', apiKeyEnv: '', label: '' }], {
			defaultTiers: { 'acme::gpt-image-2': 'high' },
		}),
		key,
	);
	check(
		'质量档：在聊天栏那格选了 high 之后才写进 params',
		picked[0]?.params.quality === 'high',
		JSON.stringify(picked[0]?.params),
	);
	const declared = resolveModels(
		configOf([
			{
				id: 'gpt-image-2',
				kind: 'image',
				apiKeyEnv: '',
				label: '',
				tiers: { param: 'resolution', values: ['1k', '2k'], labels: {} },
			},
		]),
		key,
	);
	check(
		'手写声明优先于预置（用户明说的参数名不被预置覆盖）',
		declared[0]?.axis?.param === 'resolution' && declared[0]?.params.resolution === '1k',
		JSON.stringify({ axis: declared[0]?.axis?.param, params: declared[0]?.params }),
	);
	const off = resolveModels(
		configOf([{ id: 'gpt-image-2', kind: 'image', apiKeyEnv: '', label: '' }], {
			commonModels: { 'acme::gpt-image-2': { pinned: false, quality: false, params: {} } },
		}),
		key,
	);
	check(
		'设置里关掉质量参数之后，预置的那条轴不再生效（请求体里不带它）',
		off[0]?.axis === undefined && Object.keys(off[0]?.params ?? {}).length === 0,
		JSON.stringify({ axis: off[0]?.axis, params: off[0]?.params }),
	);

	// ── 其他参数：设置里的默认值 + 用户自加的键 ──
	const withParams = resolveModels(
		configOf([{ id: 'gpt-image-2-2k', kind: 'image', apiKeyEnv: '', label: '' }], {
			commonModels: {
				'acme::gpt-image-2': {
					pinned: true,
					quality: true,
					params: { size: '2048x2048', watermark: 'true', quality: 'low' },
				},
			},
		}),
		key,
	);
	check(
		'其他参数：保留键（n）不进请求体 —— 网关按 n 出图、适配器只读 data[0]，' +
			'n>1 是**静默丢图**（钱花了、图没了）；多张走并发调用多次',
		withParams[0]?.params.n === undefined &&
			withParams[0]?.paramSpecs.some((spec) => spec.key === 'n') === false,
		JSON.stringify(withParams[0]?.params),
	);
	check(
		'其他参数：用户自加的键（预置里没有）也生效，并补进声明（模型调用才允许传它）',
		withParams[0]?.params.watermark === true &&
			withParams[0]?.paramSpecs.some((spec) => spec.key === 'watermark') === true,
		JSON.stringify(withParams[0]?.params),
	);
	check(
		'其他参数：与质量参数同名的项被忽略（那个参数归聊天栏那格管，不然「选了却不生效」）',
		withParams[0]?.params.quality === undefined,
		JSON.stringify(withParams[0]?.params),
	);
	check(
		'勾了常用的家族在解析结果里带 pinned（聊天栏那格据此分区）',
		withParams[0]?.pinned === true && off[0]?.pinned === false,
		`${String(withParams[0]?.pinned)}/${String(off[0]?.pinned)}`,
	);

	// ── 请求体：设置里的默认值 + 调用时传的覆盖 ──
	const { ctx: c, captured: cap } = makeCtx(
		configOf([{ id: 'gpt-image-2-2k', kind: 'image', apiKeyEnv: '', label: '' }], {
			commonModels: {
				'acme::gpt-image-2': { pinned: false, quality: true, params: { size: '2048x2048' } },
			},
		}),
	);
	mod.apply(c);
	const t = cap.tools[0];
	calls = [];
	responder = () => ({ ok: true, status: 200, body: { data: [{ url: 'https://cdn.example.com/out.png' }] } });

	check(
		'工具声明了 params 参数包（自由形态对象：键是用户声明的，静态 schema 写不出来）',
		t?.parameters?.properties?.params?.type === 'object' &&
			t?.parameters?.properties?.params?.additionalProperties === true &&
			t?.parameters?.properties?.params?.properties === undefined,
		JSON.stringify(t?.parameters?.properties?.params),
	);

	const value = await t.execute({ prompt: '一只柴犬', params: { size: '3840x2160', seed: '7' } }, {});
	check(
		'请求体：设置里的默认值进了 body，调用时传的**覆盖**它',
		calls[0]?.body?.size === '3840x2160' && calls[0]?.body?.n === 1,
		JSON.stringify(calls[0]?.body),
	);
	check(
		'请求体：没声明的键被忽略，但**不静默**（回执里点名，模型才会告诉用户）',
		calls[0]?.body?.seed === undefined &&
			Array.isArray(value.ignoredParams) &&
			value.ignoredParams.join(',') === 'seed',
		`body.seed=${String(calls[0]?.body?.seed)} ignored=${JSON.stringify(value.ignoredParams)}`,
	);
	check(
		'被忽略的参数出现在工具结果正文里（用户与模型都看得见）',
		String(t.output.render({}, value)[0]?.text).includes('忽略了这些参数：seed'),
		String(t.output.render({}, value)[0]?.text).slice(0, 160),
	);

	// 质量档不走这条路：它归聊天栏那格的 chip 管，模型传了要说清「去哪选」
	calls = [];
	const viaModel = await t.execute({ prompt: '一只柴犬', params: { quality: 'high' } }, {});
	check(
		'模型传质量档时不写进请求体，但回一句「在聊天栏那格里选」（不是默默按别的档出图）',
		calls[0]?.body?.quality === undefined &&
			String(t.output.render({}, viaModel)[0]?.text).includes('质量档在聊天栏那格里选'),
		String(t.output.render({}, viaModel)[0]?.text).slice(0, 160),
	);

	calls = [];
	const wide = await t.execute({ prompt: '一只柴犬', params: { size: '3840x2160' } }, {});
	check(
		'闭集之外的值照样能传（闭集只是设置页的下拉，不是校验器 —— 网关支持什么我们并不知道）',
		calls[0]?.body?.size === '3840x2160' && wide.ignoredParams === undefined,
		String(calls[0]?.body?.size),
	);

	calls = [];
	await t.execute({ prompt: '一只柴犬' }, {});
	check(
		'没传参数包时行为与升级前一致（只有设置里的默认值）',
		calls[0]?.body?.size === '2048x2048' && calls[0]?.body?.n === 1 && calls[0]?.body?.quality === undefined,
		JSON.stringify(calls[0]?.body),
	);
}

// ─────────── 16. 并发批量生成 ───────────
console.log('\n16) 并发批量生成：同一条消息里的多个调用真的并行，且有上限');

{
	const { ctx: c, captured: cap } = makeCtx(configured('openai-images'));
	mod.apply(c);
	const t = cap.tools[0];

	check(
		'工具声明并发安全（不声明 = 调度器按独占跑：批量生成会变成串行）',
		t?.isConcurrencySafe?.({}) === true,
		String(t?.isConcurrencySafe),
	);
	check(
		'工具描述邀请批量：一次调用只出一张 + 同一条消息里并发调用多次（模型才知道可以这么干）',
		String(t?.description).includes('同一条消息里并发调用') &&
			String(t?.description).includes('一次调用只出一张'),
		String(t?.description).slice(0, 60),
	);

	/** 换一个「慢」替身：记录同时在飞的请求数（真并行的唯一证据）。 */
	let inFlight = 0;
	let peak = 0;
	let seq = 0;
	const prompts = [];
	globalThis.fetch = async (url, init) => {
		inFlight += 1;
		peak = Math.max(peak, inFlight);
		seq += 1;
		const mine = seq;
		prompts.push(JSON.parse(init.body).prompt);
		await new Promise((resolve) => setTimeout(resolve, 30));
		inFlight -= 1;
		return {
			ok: true,
			status: 200,
			headers: { get: () => null },
			text: async () => JSON.stringify({ data: [{ url: `https://cdn.example.com/${String(mine)}.png` }] }),
			arrayBuffer: async () => new ArrayBuffer(0),
		};
	};

	const values = await Promise.all(
		['一', '二', '三', '四', '五', '六'].map((prompt) => t.execute({ prompt }, {})),
	);
	check('6 个调用同时发起 → 真的并行（同时在飞 > 1，不是串行排队）', peak > 1, `peak=${String(peak)}`);
	check('并行**有上限**（供应商速率限制靠闸门防，不靠把整批变串行）', peak <= 3, `peak=${String(peak)}`);
	check(
		'6 个调用各自拿到自己的那一张（客户端按 callId 各落一个画布节点）',
		values.length === 6 && new Set(values.map((value) => value.url)).size === 6 && prompts.length === 6,
		values.map((value) => value.url).join(','),
	);

	// 一个失败不该带走整批：批量生成里最要命的失败模式是「一张挂了、其余全没了」
	// （判「坏」用 prompt 全等：技能注在聊天模型 system prompt，请求体 prompt 就是原文）
	globalThis.fetch = async (url, init) => {
		const bad = JSON.parse(init.body).prompt === '坏';
		await new Promise((resolve) => setTimeout(resolve, 5));
		return {
			ok: !bad,
			status: bad ? 500 : 200,
			headers: { get: () => null },
			text: async () => (bad ? '{"error":"boom"}' : JSON.stringify({ data: [{ url: 'https://cdn.example.com/ok.png' }] })),
			arrayBuffer: async () => new ArrayBuffer(0),
		};
	};
	const mixed = await Promise.allSettled(
		['好', '坏', '好'].map((prompt) => t.execute({ prompt }, {})),
	);
	check(
		'一个失败不影响同批的其它调用（各自结算，不是整批失败）',
		mixed.filter((entry) => entry.status === 'fulfilled').length === 2 &&
			mixed.filter((entry) => entry.status === 'rejected').length === 1,
		mixed.map((entry) => entry.status).join(','),
	);

	// 排队期间被取消：那一个报「已取消」，**名额不泄漏**（泄漏会让后续批量永久卡住）
	let slow = 0;
	globalThis.fetch = async () => {
		slow += 1;
		await new Promise((resolve) => setTimeout(resolve, 30));
		return {
			ok: true,
			status: 200,
			headers: { get: () => null },
			text: async () => JSON.stringify({ data: [{ url: `https://cdn.example.com/s${String(slow)}.png` }] }),
			arrayBuffer: async () => new ArrayBuffer(0),
		};
	};
	const controller = new AbortController();
	const queued = ['a', 'b', 'c', 'd', 'e', 'f'].map((prompt, index) =>
		t.execute({ prompt }, index === 5 ? { signal: controller.signal } : {}),
	);
	controller.abort();
	const settled = await Promise.allSettled(queued);
	check(
		'排队中被取消：那一个以「已取消」结算，其余照常出结果（名额交接没漏）',
		settled[5]?.status === 'rejected' &&
			settled.slice(0, 5).every((entry) => entry.status === 'fulfilled'),
		settled.map((entry) => entry.status).join(','),
	);

	globalThis.fetch = mainFetch;
}

// ─────────── 17. 本地留档（P32） ───────────
//
// 这一节回答的是用户报的那个现象：「部分图片放的时间久了加载不出来」。
// 根因是供应商回的**签名地址会过期**，而插件此前把那个地址当成了唯一来源。
// 留档把字节抓回本机、结果地址换成本机路由 —— 因此这里必须钉住三件事：
//   ① 成功时结果地址真的是本机路由，且文件**真的写到了盘上**（字节一致）；
//   ② 失败时**绝不打断生成**（图已经出来了），但要把原因说出来；
//   ③ 取图路由只能服务归档目录（越界一律 404），且要过鉴权闸门。
console.log('\n17) 本地留档：结果落盘 + 取图路由');

{
	const archiveLib = await import('../lib/host/archive.js');
	const { mkdtemp } = await import('node:fs/promises');
	const { tmpdir } = await import('node:os');
	const { join } = await import('node:path');

	/** 一份最小配置（本节的用例共用；`configOf` 是上一节的局部变量，拿不到）。 */
	const cfgOf = (extra = {}) => ({
		providers: {
			acme: {
				label: 'Acme',
				baseURL: 'https://api.example.com/v1',
				apiKeyEnv: 'FFC_ACME_API_KEY',
				models: [{ id: 'gpt-image-1', kind: 'image', apiKeyEnv: '', label: '' }],
			},
		},
		...extra,
	});

	// ── 纯函数：路径与地址 ──
	const at = new Date('2026-09-30T18:08:05').getTime();
	const rel = archiveLib.archiveRelPath({ url: 'https://x/y.png', kind: 'image', at, salt: 'ab12', model: 'gpt-image-1' });
	check(
		'归档路径：按日期分目录 + 时刻 + 模型 + 随机段（同一秒出多张不会互相覆盖）',
		rel === '2026-09-30/180805-gpt-image-1-ab12.png',
		rel,
	);
	check(
		'归档路径：供应商回 application/octet-stream 时退回地址后缀，再退回按种类的默认值',
		archiveLib.archiveRelPath({ url: 'https://x/y.webp', kind: 'image', at, salt: 'z' }).endsWith('.webp') &&
			archiveLib.archiveRelPath({ url: 'https://x/noext', kind: 'video', at, salt: 'z' }).endsWith('.mp4') &&
			archiveLib.archiveRelPath({ url: 'https://x/noext', kind: 'image', at, salt: 'z' }).endsWith('.png'),
		archiveLib.archiveRelPath({ url: 'https://x/y.webp', kind: 'image', at, salt: 'z' }),
	);
	check(
		'归档地址：公开前缀 + 相对路径（浏览器按同源地址取图）',
		archiveLib.archiveUrl('2026-09-30/a.png') === '/ffc-media/2026-09-30/a.png',
		archiveLib.archiveUrl('2026-09-30/a.png'),
	);

	const rootDir = resolve(root, 'lib', '__archive-probe__');
	const inside = archiveLib.archivePathOf(rootDir, '/ffc-media/2026-09-30/a.png');
	check(
		'越界检查：归档目录内的路径放行、`..` 与反斜杠一律拒（这条路由不能变成读任意文件的入口）',
		inside === join(rootDir, '2026-09-30', 'a.png') &&
			archiveLib.archivePathOf(rootDir, '/ffc-media/../../secret.txt') === null &&
			archiveLib.archivePathOf(rootDir, '/ffc-media/..%2f..%2fsecret.txt') === null &&
			archiveLib.archivePathOf(rootDir, '/ffc-media/..\\..\\secret.txt') === null &&
			archiveLib.archivePathOf(rootDir, '/other/a.png') === null &&
			archiveLib.archivePathOf(rootDir, '/ffc-media/') === null,
		String(inside),
	);
	check(
		'`~` 展开：只有开头的 `~` / `~/` / `~\\` 才算主目录（路径中间的 `~` 是普通字符）',
		archiveLib.expandHome('D:/图库') === 'D:/图库' && archiveLib.expandHome('D:/a~b') === 'D:/a~b',
		archiveLib.expandHome('~'),
	);

	// ── 真跑一次：生成 → 留档 → 结果地址换成本机路由 ──
	const tmp = await mkdtemp(join(tmpdir(), 'ffc-archive-'));
	const { ctx: c, captured: cap } = makeCtx(cfgOf({ archiveDir: tmp }));
	mod.apply(c);
	const t = cap.tools[0];
	const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
	calls = [];
	responder = (url) =>
		String(url).includes('cdn.example.com')
			? { ok: true, status: 200, headers: { 'content-type': 'image/png' }, bytes: PNG }
			: { ok: true, status: 200, body: { data: [{ url: 'https://cdn.example.com/out.png' }] } };

	const value = await t.execute({ prompt: '一只柴犬' }, {});
	check(
		'留档成功：结果地址换成本机路由，原始远端地址留在 remoteUrl（排障用）',
		String(value.url).startsWith('/ffc-media/') && value.remoteUrl === 'https://cdn.example.com/out.png',
		`url=${String(value.url)} remote=${String(value.remoteUrl)}`,
	);
	const written = await readFile(resolve(tmp, String(value.url).slice('/ffc-media/'.length))).catch(() => null);
	check(
		'留档成功：字节**真的写到了盘上**，且与供应商回的一致',
		written !== null && Buffer.compare(Buffer.from(written), Buffer.from(PNG)) === 0,
		written === null ? '文件不存在' : `${String(written.length)} 字节`,
	);
	check(
		'留档成功：工具正文里的地址是本机路由（模型据此再拿它当参考图也不会过期）',
		String(t.output.render({}, value)[0]?.text).includes(String(value.url)) &&
			!String(t.output.render({}, value)[0]?.text).includes('本地留档失败'),
		String(t.output.render({}, value)[0]?.text).slice(-60),
	);
	check(
		'留档成功：呈现 meta 里带上 remoteUrl（客户端不读它，但排障时要看得到）',
		t.output.presentationMeta({}, value)?.fatfishCanvas?.remoteUrl === 'https://cdn.example.com/out.png',
		JSON.stringify(t.output.presentationMeta({}, value)?.fatfishCanvas?.url),
	);

	// ── 留档失败：不打断生成，但要说出来 ──
	//
	// 用一个**不可能建成目录**的路径：把目录指到一个已存在的文件下面。
	const blocker = resolve(tmp, 'blocker.txt');
	await writeFile(blocker, 'not a directory', 'utf8');
	const { ctx: c2, captured: cap2 } = makeCtx(cfgOf({ archiveDir: resolve(blocker, 'sub') }));
	mod.apply(c2);
	const t2 = cap2.tools[0];
	calls = [];
	const failed = await t2.execute({ prompt: '一只柴犬' }, {});
	check(
		'留档失败：生成照样成功，地址退回远端地址（图已经出来了，写不进盘不该让它失败）',
		failed.url === 'https://cdn.example.com/out.png' && failed.remoteUrl === undefined,
		String(failed.url),
	);
	check(
		'留档失败：原因随结果回给用户（否则「配了目录却没生效」完全不可见）',
		typeof failed.archiveError === 'string' &&
			failed.archiveError !== '' &&
			String(t2.output.render({}, failed)[0]?.text).includes('本地留档失败'),
		String(failed.archiveError),
	);
	check(
		'没配留档目录时行为与升级前完全一致（默认关着 —— 往用户磁盘写东西必须由用户点头）',
		await (async () => {
			const { ctx: c3, captured: cap3 } = makeCtx(cfgOf());
			mod.apply(c3);
			const plain = await cap3.tools[0].execute({ prompt: '一只柴犬' }, {});
			return plain.url === 'https://cdn.example.com/out.png' && plain.archiveError === undefined;
		})(),
	);

	// ── 取图路由 ──
	const served = [];
	const handler = archiveLib.createArchiveHandler({
		getDir: () => tmp,
		reject: (req) => (req.headers['x-deny'] === 'yes' ? 401 : undefined),
		log: (message) => served.push(message),
	});
	const call = async (url, init = {}) => {
		const res = {
			statusCode: 0,
			headers: {},
			body: undefined,
			setHeader(name, value) {
				this.headers[name] = value;
			},
			end(body) {
				this.body = body;
			},
		};
		await handler({ url, method: init.method ?? 'GET', headers: init.headers ?? {} }, res);
		return res;
	};
	const relPath = String(value.url).slice('/ffc-media/'.length);
	const hit = await call(value.url);
	check(
		'路由：归档目录里的文件 200 + 正确的 content-type + 字节一致',
		hit.statusCode === 200 &&
			hit.headers['content-type'] === 'image/png' &&
			Buffer.compare(Buffer.from(hit.body), Buffer.from(PNG)) === 0,
		`${String(hit.statusCode)} ${String(hit.headers['content-type'])}`,
	);
	check(
		'路由：长缓存（文件名带时间与随机段 → 同一地址的内容永不改变）',
		String(hit.headers['cache-control']).includes('immutable'),
		String(hit.headers['cache-control']),
	);
	const miss = await call('/ffc-media/2026-01-01/nope.png');
	check('路由：文件不在盘上时 404（不静默返回空）', miss.statusCode === 404, String(miss.statusCode));
	const escape = await call('/ffc-media/../../../secret.txt');
	check('路由：越界请求 404（即便文件真的存在也读不到）', escape.statusCode === 404, String(escape.statusCode));
	const denied = await call(value.url, { headers: { 'x-deny': 'yes' } });
	check(
		'路由：鉴权闸门在前（没通过就 401，连路径都不解析）',
		denied.statusCode === 401 && denied.body === undefined,
		String(denied.statusCode),
	);
	const wrongMethod = await call(value.url, { method: 'POST' });
	check('路由：只收 GET / HEAD（其它方法 405）', wrongMethod.statusCode === 405, String(wrongMethod.statusCode));
	const head = await call(value.url, { method: 'HEAD' });
	check(
		'路由：HEAD 只回头不回体（浏览器预检与缓存校验会用到）',
		head.statusCode === 200 && head.body === undefined && head.headers['content-length'] === String(PNG.length),
		String(head.headers['content-length']),
	);
	check('路由：留档目录为空时 404（功能没开就不该有取图入口）', await (async () => {
		const off = archiveLib.createArchiveHandler({ getDir: () => '', log: () => {} });
		const res = {
			statusCode: 0,
			setHeader: () => {},
			end: () => {},
		};
		await off({ url: value.url, method: 'GET', headers: {} }, res);
		return res.statusCode === 404;
	})());

	await rm(tmp, { recursive: true, force: true }).catch(() => {});
}

// ─────────── 结果 ───────────
console.log(results.join('\n'));
console.log('');

// 宿主就绪标记：本轮**根本没写**（FFC_NO_STATUS_WRITE=1），所以不需要还原。
// 只报告它当前是什么，方便判断运行中的宿主是新是旧。
{
	let current = null;
	try {
		current = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
	} catch {
		current = null;
	}
	console.log(
		current === null
			? '宿主就绪标记 host-status.json：（不存在 —— 运行中的宿主还没写过，或已被删除）'
			: `宿主就绪标记 host-status.json：（未改动）${JSON.stringify(current)}`,
	);
	void hostStatusBackup;
}

// 清掉测试期间可能写下的其它痕迹，避免污染下一次真实诊断
await writeFile(resolve(root, 'lib/test-host-ran.txt'), new Date().toISOString(), 'utf8').catch(() => {});
void rm;
void writeFile;

if (failures === 0) {
	console.log(`全部通过 ✅（${String(results.length)} 项）`);
	process.exit(0);
}
console.log(`${String(failures)} 项失败 ❌（共 ${String(results.length)} 项）`);
process.exit(1);
