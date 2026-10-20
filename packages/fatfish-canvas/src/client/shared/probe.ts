/**
 * 「探测」远程调用的**共享契约**（宿主半边与设置页共用一份）。
 *
 * 设置页上的「测试连接」「获取模型列表」必须由宿主执行（那里才有密钥），
 * 而客户端插件调宿主代码走的是 Typert 远程命名空间：两边各自声明一份
 * 描述符，**运行时不互相校验**（宿主只看自己的清单，客户端只看自己挂上去的
 * 贡献）。两边写歪一个字，症状是「点了没反应」或者一个含混的网关错误 ——
 * 所以描述符不能各写一份，必须从这一个模块生成。
 *
 * 这里刻意**不引 zod**：Typert 对「手工注册」的编解码器只要求 `create()`
 * 返回一个有 `parse()` 的东西（`dsh-typert-registry` 的 `validateCodec`），
 * profile 里已有插件这么干（`@michengai/dsh-archive-manager` 就是手写 schema +
 * `ctx.typert.register`）。本插件也已经在用 schemastery，再为两个方法引一套
 * zod 不划算。
 *
 * @module fatfish-canvas/shared/probe
 */

import type { MediaKind } from './catalog';

/** 贡献的归属包名（与插件 id、包名一致）。 */
export const PROBE_PKG = 'fatfish-canvas';

/** 远程命名空间名（客户端取服务时为 `remote.<名字>`）。 */
export const PROBE_NAMESPACE = 'mediaProbe';

/** 一个探测方法的声明。 */
interface ProbeMethodSpec {
	/** 方法名。 */
	method: 'testConnection' | 'listModels' | 'fetchImage' | 'fetchMedia';
	/** 一句说明（进描述符，便于诊断）。 */
	summary: string;
	/** 参数线名（`fetchImage` 收的是地址而不是供应商 id）。 */
	param: string;
	/** 参数编解码器。 */
	codec: StrictCodec;
	/** 结果编解码器。 */
	result: StrictCodec;
}

// ─────────────────────── 手写严格编解码器 ───────────────────────

/**
 * 一个严格编解码器：`{ mode: 'strict', typeSymbol, create }`。
 *
 * `mode` 必须是 `'strict'` —— 客户端面只接受严格编解码器（SRC 标记在浏览器侧
 * 没有编解码器），写错的话 `$mount` 会直接抛错。
 *
 * `create` 是**惰性工厂**（0.1.5 的 `schema:` 键已经没有了）：网关在**每一次**
 * 边界解码时都会 `codec.create().parse(value)`，因此工厂必须自己把结果缓存住
 * （`??=`），否则每个参数 / 结果都会把整个 schema 图重建一遍。本模块不引 zod，
 * 手写的 `parse` 对象同样按这个形状交给网关。
 */
interface StrictCodec {
	mode: 'strict';
	typeSymbol: string;
	create: () => { parse(value: unknown): unknown };
}

/**
 * 造一个「非空字符串」编解码器。
 * @param typeSymbol - 类型符号（仅用于诊断）。
 * @returns 编解码器。
 */
function stringCodec(typeSymbol: string): StrictCodec {
	let schema: { parse(value: unknown): unknown } | undefined;
	return {
		mode: 'strict',
		typeSymbol,
		create: () =>
			(schema ??= {
				parse(value: unknown): unknown {
					if (typeof value !== 'string' || value === '') {
						throw new TypeError(`${typeSymbol}: 期望非空字符串，收到 ${JSON.stringify(value)}`);
					}
					return value;
				},
			}),
	};
}

/** 探测结果的编解码器：逐字段校验并**重建**一个纯对象（挡掉类实例与多余字段）。 */
function probeResultCodec(): StrictCodec {
	const typeSymbol = `${PROBE_PKG}/types#ProbeResult`;
	let schema: { parse(value: unknown): unknown } | undefined;
	return {
		mode: 'strict',
		typeSymbol,
		create: () =>
			(schema ??= {
				parse(value: unknown): unknown {
					if (value === null || typeof value !== 'object' || Array.isArray(value)) {
						throw new TypeError(`${typeSymbol}: 期望对象`);
					}
					const o = value as Record<string, unknown>;
					if (typeof o.ok !== 'boolean') throw new TypeError(`${typeSymbol}: ok 必须是布尔`);
					if (typeof o.message !== 'string') throw new TypeError(`${typeSymbol}: message 必须是字符串`);
					const out: Record<string, unknown> = { ok: o.ok, message: o.message };
					if (Array.isArray(o.models)) {
						out.models = o.models.filter((id): id is string => typeof id === 'string');
					}
					if (Array.isArray(o.kinds)) {
						out.kinds = o.kinds.filter((kind): kind is MediaKind => kind === 'image' || kind === 'video');
					}
					if (typeof o.latencyMs === 'number' && Number.isFinite(o.latencyMs)) out.latencyMs = o.latencyMs;
					if (typeof o.status === 'number' && Number.isFinite(o.status)) out.status = o.status;
					return out;
				},
			}),
	};
}

/** 参数的编解码器（`stringCodec` 造一条；**每个参数各一个对象**，见 SPECS）。 */

/**
 * `fetchImage` / `fetchMedia` 的结果编解码器：一段可直接变成 `File` 的内联数据。
 *
 * **为什么让宿主去下载**：画布节点上的图常常是跨域地址（中转站的对象存储），
 * 浏览器直接 fetch 会踩 CORS；而「存成附件」与「导出到本地」都必须拿到字节。
 * 宿主没有这条限制，于是它取回来、以 data URL 交给客户端，客户端再包装成
 * `File` 走本体的附件管线（或直接落盘）。
 *
 * 代价是字节要从宿主进程过一遍浏览器内存（上限见 `fetchImage` / `fetchMedia`
 * 的 8MB 与 64MB）。之所以接受：这是唯一不需要给宿主新增存储/上传通路、
 * 又能复用平台附件管线的做法。
 */
function imageBytesCodec(): StrictCodec {
	const typeSymbol = `${PROBE_PKG}/types#FetchedImage`;
	let schema: { parse(value: unknown): unknown } | undefined;
	return {
		mode: 'strict',
		typeSymbol,
		create: () =>
			(schema ??= {
				parse(value: unknown): unknown {
					if (value === null || typeof value !== 'object' || Array.isArray(value)) {
						throw new TypeError(`${typeSymbol}: 期望对象`);
					}
					const o = value as Record<string, unknown>;
					if (typeof o.ok !== 'boolean') throw new TypeError(`${typeSymbol}: ok 必须是布尔`);
					if (typeof o.message !== 'string') throw new TypeError(`${typeSymbol}: message 必须是字符串`);
					const out: Record<string, unknown> = { ok: o.ok, message: o.message };
					if (typeof o.dataUrl === 'string' && o.dataUrl.startsWith('data:')) out.dataUrl = o.dataUrl;
					if (typeof o.mimeType === 'string') out.mimeType = o.mimeType;
					if (typeof o.name === 'string') out.name = o.name;
					if (typeof o.bytes === 'number' && Number.isFinite(o.bytes)) out.bytes = o.bytes;
					return out;
				},
			}),
	};
}

// ─────────────────────── 两侧描述符 ───────────────────────

/**
 * 四个方法（参数线与结果编解码器都挂在这里，两侧描述符都用它生成）。
 *
 * ⚠️ **每个参数各造一个编解码器对象**（而不是共用一条常量）：0.2.0 起描述符里
 * 挂的是 `create` 工厂，生成器对每个展开点都发一份独立工厂（`$schema` / `$schema2`
 * / …），共用一份会让两个参数在注册表里指向同一个记录来源 —— 形状上没必要冒这个险。
 */
const SPECS: readonly ProbeMethodSpec[] = [
	{
		method: 'testConnection',
		summary: '测试连接（顺带返回模型列表）',
		param: 'providerId',
		codec: stringCodec(`${PROBE_PKG}/types#ProviderId`),
		result: probeResultCodec(),
	},
	{
		method: 'listModels',
		summary: '获取模型列表（OpenAI 兼容 GET {base}/models）',
		param: 'providerId',
		codec: stringCodec(`${PROBE_PKG}/types#ProviderId`),
		result: probeResultCodec(),
	},
	{
		method: 'fetchImage',
		summary: '按地址取图（跨域由宿主代取，返回 data URL 供附件管线使用）',
		param: 'url',
		codec: stringCodec(`${PROBE_PKG}/types#ImageUrl`),
		result: imageBytesCodec(),
	},
	{
		// 导出那条路要的不只是图：生成出来的**视频**也挂在跨域地址上。
		// 单开一个方法而不是给 fetchImage 加开关：附件那条路只该收图片
		// （见 host/probe.ts 的 fetchBytes）。
		method: 'fetchMedia',
		summary: '按地址取媒体字节（图或视频，视频上限 64MB；跨域由宿主代取）',
		param: 'url',
		codec: stringCodec(`${PROBE_PKG}/types#ImageUrl`),
		result: imageBytesCodec(),
	},
];

/**
 * 客户端要挂上去的贡献（`ctx.remote.$mount(...)`）。
 *
 * 挂上之后 `ctx.get('remote.mediaProbe')` 就是可调用的命名空间服务。
 */
export const PROBE_CLIENT_CONTRIBUTION = {
	package: PROBE_PKG,
	descriptors: SPECS.map((spec) => ({
		id: `${PROBE_PKG}#${PROBE_NAMESPACE}/${spec.method}`,
		service: PROBE_NAMESPACE,
		namespace: PROBE_NAMESPACE,
		method: spec.method,
		invocation: { kind: 'direct' as const },
		parameters: [{ name: spec.param, wire: spec.param, source: 'json' as const, codec: spec.codec }],
		result: spec.result,
		sourceLocation: { file: `${PROBE_PKG}/lib/index.js`, line: 1, column: 1 },
	})),
};

/**
 * 宿主要注册的清单（`ctx.typert.register(...)`）。
 *
 * 与客户端的描述符同源：`id` / `namespace` / `method` / 参数线与结果编解码器
 * 都来自上面的 `SPECS`。
 */
export const PROBE_HOST_MANIFEST = {
	package: PROBE_PKG,
	face: 'host' as const,
	schemas: [] as unknown[],
	model: { services: [] as unknown[], events: [] as unknown[], objects: [] as unknown[] },
	invocations: SPECS.map((spec) => ({
		id: `${PROBE_PKG}#${PROBE_NAMESPACE}/${spec.method}`,
		service: PROBE_NAMESPACE,
		namespace: PROBE_NAMESPACE,
		method: spec.method,
		invocation: { kind: 'direct' as const },
		parameters: [{ name: spec.param, wire: spec.param, source: 'json' as const, codec: spec.codec }],
		result: spec.result,
		sourceLocation: { file: `${PROBE_PKG}/lib/index.js`, line: 1, column: 1 },
	})),
};

// ─────────────────── 读结果：先拆远程信封 ───────────────────
//
// ⚠️ **远程方法结算成的是信封，不是宿主方法的返回值本身**：
//
//   { ok: true,  value: <宿主方法的返回值> }
//   { ok: false, error: RemoteError }        // 载体/校验失败，不是业务失败
//
// （`dsh-typert-protocol` 的 `RemoteResult<T>`；「只有装配错误才 reject」。）
// 因此直接读 `result.dataUrl` 永远读不到 —— 症状是**宿主明明取到了图，页面说取不到**：
// P27 的导出压缩包报「取图失败」（`value` 没拆，`dataUrl` 是 undefined，兜底文案上场），
// 而「点画布图 → 送进聊天框」会退化成只插一行地址。设置页那两处一直是对的，
// 因为它们拆了信封（`MediaSettings` 的 `runProbe`）。

/**
 * 宿主取字节方法的**返回值**（信封里的 `value`）。
 *
 * `fetchImage`（只收图）与 `fetchMedia`（图或视频）共这一份形状 —— 字段本来就
 * 与「图 / 视频」无关，差的只有调用方自己怎么用。
 */
export interface FetchedImage {
	/** 是否取到。 */
	ok: boolean;
	/** 一句可展示的说明（成功也是）。 */
	message: string;
	/** 内联数据（`ok` 时才有）。 */
	dataUrl?: string;
	/** MIME。 */
	mimeType?: string;
	/** 猜出来的文件名。 */
	name?: string;
	/** 字节数。 */
	bytes?: number;
}

/** 取图这件事的结论：要么拿到可用的内联数据，要么一句能直接展示的原因。 */
export type FetchedImageOutcome =
	| { ok: true; dataUrl: string; name: string; mimeType: string }
	| { ok: false; message: string };

/** 读一句非空错误文案。 */
function messageOf(value: unknown, fallback: string): string {
	const text = (value as { message?: unknown } | null | undefined)?.message;
	return typeof text === 'string' && text !== '' ? text : fallback;
}

/** 读信封里的值（或裸值）本身。 */
function readFetchedImage(value: unknown): FetchedImageOutcome {
	if (value === null || typeof value !== 'object') return { ok: false, message: '取图服务返回了意外的形状' };
	const image = value as FetchedImage;
	if (image.ok !== true || typeof image.dataUrl !== 'string' || image.dataUrl === '') {
		return { ok: false, message: messageOf(image, '取图失败') };
	}
	return {
		ok: true,
		dataUrl: image.dataUrl,
		name: typeof image.name === 'string' && image.name !== '' ? image.name : 'canvas-image.png',
		mimeType: typeof image.mimeType === 'string' && image.mimeType !== '' ? image.mimeType : 'image/png',
	};
}

/**
 * 拆远程信封，读出一份取回的媒体字节（纯函数）。
 * @param result - `remote.mediaProbe.fetchImage / fetchMedia(...)` 的结算值。
 * @returns 内联数据，或一句可展示的失败原因。
 */
export function unwrapFetchedImage(result: unknown): FetchedImageOutcome {
	const envelope = result as { ok?: unknown; value?: unknown; error?: unknown } | null | undefined;
	// ① 信封（正常形状）：成败看外层的 ok，业务结果在 value 里
	if (envelope !== null && typeof envelope === 'object' && ('value' in envelope || 'error' in envelope)) {
		if (envelope.ok !== true) return { ok: false, message: messageOf(envelope.error, '取图服务调用失败') };
		return readFetchedImage(envelope.value);
	}
	// ② 裸值（万一以后有人把宿主方法直接挂上来，别再让同一处判断分叉）
	return readFetchedImage(result);
}

/**
 * 造一个远程服务的绑定对象。
 *
 * 宿主侧必须这样交给网关注册表：`validateBinding` 要求
 * `service === 服务实例`、`serviceKey === 命名空间名`、`namespace === 命名空间名`。
 * 官方有个 `bindTypertRemote()` 帮手，但那要引 `dsh-typert-protocol`；
 * 本插件一直刻意不引 `@deepseek-ai/*` 运行时依赖，因此照形状手写。
 * @param service - 服务实例。
 * @returns 绑定对象。
 */
export function probeRemoteBinding(service: unknown): {
	service: unknown;
	serviceKey: string;
	namespace: string;
} {
	return { service, serviceKey: PROBE_NAMESPACE, namespace: PROBE_NAMESPACE };
}
