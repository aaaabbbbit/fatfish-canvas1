/**
 * 宿主半边用到的 Node 内置模块的最小类型声明。
 *
 * 和 `client/ambient.d.ts` 同一个思路：本包刻意**不引 @types/node**（out-of-tree
 * 插件每多一个依赖就多一处版本漂移面），而宿主半边只用到三个模块的四个函数。
 * 与其为了 `tsc` 装一个几十兆的类型包，不如把用到的这一点点面写清楚 ——
 * 声明窄，写错的调用反而更容易被发现。
 */

declare module 'node:fs' {
	/**
	 * 同步写文件。
	 * @param path - 路径。
	 * @param data - 内容。
	 * @param encoding - 编码。
	 */
	export function writeFileSync(path: string, data: string, encoding?: string): void;
}

declare module 'node:fs/promises' {
	/**
	 * 读一个文件（参考图从本地路径来时要读字节）。
	 * @param path - 路径。
	 * @param options - 取消信号。
	 * @returns 文件字节。
	 */
	export function readFile(path: string, options?: { signal?: AbortSignal }): Promise<Uint8Array>;
	/**
	 * 建目录（归档留档时按日期建子目录）。
	 * @param path - 路径。
	 * @param options - `recursive` 建整条链且已存在不报错。
	 */
	export function mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
	/**
	 * 写一个文件（归档留档写字节）。
	 * @param path - 路径。
	 * @param data - 字节。
	 * @param options - 取消信号。
	 */
	export function writeFile(
		path: string,
		data: Uint8Array,
		options?: { signal?: AbortSignal },
	): Promise<void>;
}

declare module 'node:path' {
	/**
	 * 取目录名。
	 * @param path - 路径。
	 * @returns 目录部分。
	 */
	export function dirname(path: string): string;
	/**
	 * 拼接路径。
	 * @param parts - 片段。
	 * @returns 拼好的路径。
	 */
	export function join(...parts: string[]): string;
	/**
	 * 解析成绝对路径（相对路径按进程工作目录，即会话工作区）。
	 * @param parts - 片段。
	 * @returns 绝对路径。
	 */
	export function resolve(...parts: string[]): string;
	/**
	 * 本平台的分隔符（归档路由的越界检查要用它拼前缀）。
	 */
	export const sep: string;
}

declare module 'node:url' {
	/**
	 * 把 file: URL 转成本地路径。
	 * @param url - URL 或字符串。
	 * @returns 本地路径。
	 */
	export function fileURLToPath(url: string | URL): string;
}

/**
 * 全局 `process`（宿主半边只用到环境变量）。
 *
 * 声明成**只读的窄面**而不是照抄 @types/node：本包只在「测试期间关掉诊断写盘」
 * 这件事上读它，写错用法反而应该报错。
 */
declare const process: {
	/** 环境变量表。 */
	readonly env: Record<string, string | undefined>;
};

/**
 * 全局 `Buffer`（只用到 base64 两个方向）。
 *
 * 参考图变成 `data:` 地址、以及 multipart 端点要的上传字节都要经过它；
 * 同样只声明用到的那一面，而不是引入整个 @types/node。
 */
declare const Buffer: {
	/**
	 * 从字节或字符串造一个 Buffer。
	 * @param data - 字节或（按 encoding 解码的）字符串。
	 * @param encoding - 字符串的编码。
	 * @returns 既能当字节用、也能按编码转成字符串的 Buffer。
	 */
	from(
		data: Uint8Array | string,
		encoding?: string,
	): Uint8Array & { toString(encoding?: string): string };
};
