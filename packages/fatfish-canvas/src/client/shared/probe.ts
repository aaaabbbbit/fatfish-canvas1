/**
 * 「探测」远程调用的**共享契约**（宿主半边与设置页共用一份）。
 *
 * 设置页上的「测试连接」「获取模型列表」必须由宿主执行（那里才有密钥），
 * 而客户端插件调宿主代码走的是 Typert 远程命名空间：两边各自声明一份
 * 描述符，**运行时不互相校验**（宿主只看自己的清单，客户端只看自己挂上去的
 * 贡献）。两边写歪一个字，症状是「点了没反应」或者一个含混的网关错误 ——
 * 所以描述符不能各写一份，必须从这一个模块生成。
 *
 * 这里刻意**不引 zod**：Typert 对「手工注册」的编解码器只要求有 `parse()`
 * （`dsh-typert-registry` 的 `validateCodec`），profile 里已有插件这么干
 * （`@michengai/dsh-archive-manager` 就是手写 schema + `ctx.typert.register`）。
 * 本插件也已经在用 schemastery，再为两个方法引一套 zod 不划算。
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
	method: 'testConnection' | 'listModels' | 'fetchImage';
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
 * 一个严格编解码器：`{ mode: 'strict', typeSymbol, schema: { parse } }`。
 *
 * `mode` 必须是 `'strict'` —— 客户端面只接受严格编解码器（SRC 标记在浏览器侧
 * 没有编解码器），写错的话 `$mount` 会直接抛错。
 */
interface StrictCodec {
	mode: 'strict';
	typeSymbol: string;
	schema: { parse(value: unknown): unknown };
}

/**
 * 造一个「非空字符串」编解码器。
 * @param typeSymbol - 类型符号（仅用于诊断）。
 * @returns 编解码器。
 */
function stringCodec(typeSymbol: string): StrictCodec {
	return {
		mode: 'strict',
		typeSymbol,
		schema: {
			parse(value: unknown): unknown {
				if (typeof value !== 'string' || value === '') {
					throw new TypeError(`${typeSymbol}: 期望非空字符串，收到 ${JSON.stringify(value)}`);
				}
				return value;
			},
		},
	};
}

/** 探测结果的编解码器：逐字段校验并**重建**一个纯对象（挡掉类实例与多余字段）。 */
function probeResultCodec(): StrictCodec {
	const typeSymbol = `${PROBE_PKG}/types#ProbeResult`;
	return {
		mode: 'strict',
		typeSymbol,
		schema: {
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
		},
	};
}

/** 参数的编解码器（三个方法各自一条）。 */
const providerIdCodec = stringCodec(`${PROBE_PKG}/types#ProviderId`);
const imageUrlCodec = stringCodec(`${PROBE_PKG}/types#ImageUrl`);

/**
 * `fetchImage` 的结果编解码器：一段可直接变成 `File` 的内联数据。
 *
 * **为什么让宿主去下载**：画布节点上的图常常是跨域地址（中转站的对象存储），
 * 浏览器直接 fetch 会踩 CORS；而「存成附件」必须拿到字节。宿主没有这条限制，
 * 于是它取回来、以 data URL 交给客户端，客户端再包装成 `File` 走本体的附件管线。
 *
 * 代价是字节要从宿主进程过一遍浏览器内存（上限见 `fetchImage` 的 8MB）。
 * 之所以接受：这是唯一不需要给宿主新增存储/上传通路、又能复用平台附件管线的做法。
 */
function imageBytesCodec(): StrictCodec {
	const typeSymbol = `${PROBE_PKG}/types#FetchedImage`;
	return {
		mode: 'strict',
		typeSymbol,
		schema: {
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
		},
	};
}

// ─────────────────────── 两侧描述符 ───────────────────────

/** 三个方法（参数线与结果编解码器都挂在这里，两侧描述符都用它生成）。 */
const SPECS: readonly ProbeMethodSpec[] = [
	{
		method: 'testConnection',
		summary: '测试连接（顺带返回模型列表）',
		param: 'providerId',
		codec: providerIdCodec,
		result: probeResultCodec(),
	},
	{
		method: 'listModels',
		summary: '获取模型列表（OpenAI 兼容 GET {base}/models）',
		param: 'providerId',
		codec: providerIdCodec,
		result: probeResultCodec(),
	},
	{
		method: 'fetchImage',
		summary: '按地址取图（跨域由宿主代取，返回 data URL 供附件管线使用）',
		param: 'url',
		codec: imageUrlCodec,
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
