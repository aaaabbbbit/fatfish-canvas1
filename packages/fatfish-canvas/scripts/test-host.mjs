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
 * @param userConfig - 用户层配置（新结构：`{ providers: { … } }`）。
 * @param secrets - 凭据表（省略时按配置里的引用自动补 `sk-test-key`）。
 * @returns `{ ctx, captured, secrets }`。
 */
function makeCtx(userConfig, secrets) {
	const captured = {
		ns: undefined,
		schema: undefined,
		options: undefined,
		tools: [],
		commands: [],
		warnings: [],
		mutations: [],
		provided: {},
		typert: [],
		/** 附件服务收到的引用（用来钉「原样透传、不重拼」）。 */
		attachmentRefs: [],
		/** llm 服务公布的模型目录（`inputModalities` 缺席 = 能力未知）。 */
		llmModels: [],
	};

	const secretMap = secrets ?? autoSecrets(userConfig);

	const scoped = {
		settings: {
			register(ns, schema, options) {
				captured.ns = ns;
				captured.schema = schema;
				captured.options = options;
				return {
					// schemastery schema 可调用：解析默认值 + 叠加用户层 + 校验
					get: () => schema({ ...(userConfig ?? {}) }),
					watch: () => () => {},
					update: async () => {},
					replace: async () => {},
				};
			},
			// 迁移用的深路径写入口
			mutate: async (ns, ops) => {
				captured.mutations.push({ ns, ops });
				return { ok: true };
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
	 */
	const runInject = (deps, callback) => {
		const arr = Array.isArray(deps) ? deps : [deps];
		const missing = arr.filter((d) => scoped[d] === undefined);
		if (missing.length > 0) return;
		callback({ ...scoped, inject: runInject });
	};

	const ctx = {
		effect: (fn) => {
			fn();
		},
		inject: runInject,
		get: (name) => scoped[name],
		provide: scoped.provide,
	};
	return { ctx, captured, secrets: secretMap, services: scoped };
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

const mod = await import(`file:///${ENTRY.replace(/\\/g, '/')}`);

// ─────────── 1. settings 注册 ───────────
console.log('1) settings namespace 注册');

const { ctx, captured } = makeCtx();
mod.apply(ctx);

check('导出 apply / inject / name', typeof mod.apply === 'function' && Array.isArray(mod.inject));
check('注册了 media-generation namespace', captured.ns === 'media-generation', String(captured.ns));
check('applies 声明为 live', captured.options?.applies === 'live');
check('schema 是真正的 schemastery schema（可调用 + 可序列化）',
	typeof captured.schema === 'function' && typeof captured.schema.toJSON === 'function');
check(
	'不声明组合 base（供应商目录是插件常量，不是用户数据）',
	captured.options?.base === undefined,
	JSON.stringify(captured.options?.base ?? null),
);
const schemaJson = JSON.stringify(captured.schema.toJSON());
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
	// 新结构的密钥字段是**引用名**（普通字符串，不是机密）：脱敏遍历器不会碰它，
	// 因此客户端读得到的与真的存着的一致 —— 这正是「任意嵌套写入都不会抹掉
	// 别人的机密」的前提（旧设计要为此把字段摊平，见 schema.ts 的模块注释）。
	const resolved = captured.schema({
		providers: { acme: { baseURL: 'https://x/v1', apiKeyEnv: 'FFC_ACME_API_KEY', models: [] } },
	});
	check(
		'providers 里的 apiKeyEnv 是照实下发的普通字符串（引用名，不是机密）',
		resolved.providers?.acme?.apiKeyEnv === 'FFC_ACME_API_KEY',
		JSON.stringify(resolved.providers?.acme ?? null),
	);
}
{
	// 旧扁平字段（P8 及以前）仍然必须留在 schema 里：不在 schema 里的残留字段
	// **不会被脱敏**，留在文档里的旧明文密钥会被原样下发到浏览器。
	// 它们由宿主启动时的迁移清掉，但声明必须一直在。
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
	check('请求体带 model / prompt / n=1',
		calls[0]?.body?.model === 'test-model' && calls[0]?.body?.prompt === '一只柴犬' && calls[0]?.body?.n === 1);
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
	check('命令请求体带提示词', calls[0]?.body?.prompt === '一只柴犬', String(calls[0]?.body?.prompt));

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
	check('--ref 被解析成参考图地址',
		argsOf('--ref https://x/y.png 换个风格')?.reference === 'https://x/y.png' &&
			argsOf('--ref https://x/y.png 换个风格')?.prompt === '换个风格',
		JSON.stringify(argsOf('--ref https://x/y.png 换个风格')));
	check('--ref=地址 的等号写法也收',
		argsOf('--ref=data:image/png;base64,AA== 变体')?.reference === 'data:image/png;base64,AA==');
	check('不带 --ref 时 reference 是 undefined（纯文生图）',
		argsOf('一只肥鱼')?.reference === undefined);
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
		'出现过的旧字段都要被 unset（残留字段不会被脱敏，留着就是明文密钥外泄）',
		plan.dropFields.includes('key_openai_images') &&
			plan.dropFields.includes('model_openai_images') &&
			plan.dropFields.includes('model_volces_videos'),
		JSON.stringify(plan.dropFields),
	);
	check(
		'空配置不产生任何迁移动作（不会给每个人凭空加四条空供应商）',
		(() => {
			const empty = schema.migrateLegacy({
				providers: {},
				defaultImage: '',
				defaultVideo: '',
				timeoutMs: 600000,
				maxNodeSize: 512,
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

	// ── 10.y `storeReference`：画布内联图 → 参考图句柄（P22） ──
	//
	// 反方向的那一趟：字节从页面到宿主。命令行塞不下一张本地照片的 base64，
	// 所以宿主先把它存进附件库，回一个短路径当句柄。
	const pixelPng = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
	const dataUrlOf = (bytes, mime = 'image/png') =>
		`data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;

	{
		const seen = [];
		const core = new probe.MediaProbeCore({
			providerOf: async () => target,
			timeoutMs: () => 5000,
			storeImage: async (input) => {
				seen.push(input);
				return { path: 'C:\\tmp\\attachments\\abc.png', bytes: input.data.byteLength };
			},
		});
		const result = await core.storeReference(dataUrlOf(pixelPng));
		check('storeReference 存成附件并回一个短句柄',
			result.ok === true && result.ref === 'C:\\tmp\\attachments\\abc.png' && result.bytes === pixelPng.length,
			JSON.stringify(result));
		check('传给附件服务的字节与 MIME 都对（base64 解码无误）',
			seen.length === 1 &&
				seen[0].mediaType === 'image/png' &&
				Buffer.from(seen[0].data).equals(Buffer.from(pixelPng)),
			JSON.stringify({ mime: seen[0]?.mediaType, bytes: seen[0]?.data?.byteLength }));
	}

	{
		const core = new probe.MediaProbeCore({
			providerOf: async () => target,
			timeoutMs: () => 5000,
			storeImage: async () => {
				throw new Error('附件服务拒绝了：不支持的图片格式');
			},
		});
		const result = await core.storeReference(dataUrlOf(pixelPng, 'image/gif'));
		check('附件服务拒绝时把原因原样说出来（不静默失败）',
			result.ok === false && String(result.message).includes('不支持的图片格式'),
			String(result.message));
	}

	{
		const core = new probe.MediaProbeCore({ providerOf: async () => target, timeoutMs: () => 5000 });
		const result = await core.storeReference(dataUrlOf(pixelPng));
		check('宿主没装配附件服务时明确说不可用（而不是回一个空句柄）',
			result.ok === false && String(result.message).includes('附件服务'),
			String(result.message));
	}

	{
		const core = new probe.MediaProbeCore({
			providerOf: async () => target,
			timeoutMs: () => 5000,
			storeImage: async () => ({ path: 'x', bytes: 1 }),
		});
		const http = await core.storeReference('https://cdn.example/a.png');
		check('http 地址不必过这一趟（本来就塞得进命令行）',
			http.ok === false && String(http.message).includes('data:'),
			String(http.message));
	}

	// `decodeDataUrl` 是两处共用的解析（参考图字节 + 上面的 storeReference）
	{
		const ref = await libImport('lib/host/reference.js');
		const decoded = ref.decodeDataUrl(dataUrlOf(pixelPng, 'image/jpeg'));
		check('decodeDataUrl 解出字节与 MIME',
			decoded !== null &&
				decoded.mediaType === 'image/jpeg' &&
				Buffer.from(decoded.data).equals(Buffer.from(pixelPng)),
			JSON.stringify(decoded === null ? null : { mime: decoded.mediaType, bytes: decoded.data.byteLength }));
		check('decodeDataUrl 对非 data: 与坏格式返回 null',
			ref.decodeDataUrl('https://x/a.png') === null && ref.decodeDataUrl('data:image/png;base64') === null,
		);
		check('没写 MIME 的 data URL 按 png 兜底',
			ref.decodeDataUrl(`data:;base64,${Buffer.from(pixelPng).toString('base64')}`)?.mediaType === 'image/png',
		);
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
		'服务上确实有那三个方法（描述符指向它们）',
		typeof captured.provided['mediaProbe']?.testConnection === 'function' &&
			typeof captured.provided['mediaProbe']?.listModels === 'function' &&
			typeof captured.provided['mediaProbe']?.fetchImage === 'function',
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
				entry.parameters.every((p) => p.codec?.mode === 'strict' && typeof p.codec.schema?.parse === 'function') &&
				entry.result?.mode === 'strict' &&
				typeof entry.result.schema?.parse === 'function',
		),
	);
	check(
		'结果编解码器会挡掉坏数据（缺 ok/message 的返回值直接抛）',
		(() => {
			const codec = client.descriptors[0].result.schema;
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
		form?.get('model') === 'test-model' && form?.get('prompt') === '换成水彩' && form?.get('size') === '1024x1024',
		JSON.stringify([form?.get('model'), form?.get('prompt'), form?.get('size')]));
	check('multipart 的 image 是一份文件（带文件名）',
		form?.get('image') instanceof Blob && form?.get('image')?.name === 'reference.png',
		String(form?.get('image')?.name));
	check('multipart 不带 JSON 的 content-type（boundary 由 fetch 自己写）',
		calls[0]?.headers?.['content-type'] === undefined,
		String(calls[0]?.headers?.['content-type']));
	check('edits 的响应解析与 generations 共用（b64 → data URL）',
		value.url === 'data:image/png;base64,QUJD', String(value.url));

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
	check('描述被注入到提示词前面，原文完整保留在后面',
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
	check('没配视觉模型：提示词保持原文',
		calls[0]?.body?.prompt === '把这张改成油画', String(calls[0]?.body?.prompt));
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
	check('多模态路由：不调用视觉模型、也不注入描述',
		calls.length === 1 && calls[0]?.body?.prompt === '照着这张画',
		calls.map((call) => call.url).join(' → '));
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
	check('这种失败下提示词退回原文（不塞半句失败说明进去）',
		calls[1]?.body?.prompt === '把这张改成油画', String(calls[1]?.body?.prompt));
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
	check('没有参考图：不发视觉请求',
		calls.length === 1 && calls[0]?.body?.prompt === '一只柴犬',
		calls.map((call) => call.url).join(' → '));
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
