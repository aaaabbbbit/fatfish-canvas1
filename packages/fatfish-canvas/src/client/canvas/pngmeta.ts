/**
 * PNG 的 tEXt 元数据读写 —— 纯字节操作，无 DOM、无依赖。
 *
 * 这就是 ComfyUI 存工作流的方式（`comfy_extras/nodes_images.py` 的
 * `inject_png_metadata`）：在 IHDR 之后插入若干 tEXt 块，键名 `prompt` / `workflow`。
 * 照它的形状做，是为了以后接真 ComfyUI 时**读的那半边不用重写**，两边也能互相打开。
 *
 * 三个刻意的实现选择：
 *
 * 1. **只做 tEXt，不做 zTXt / iTXt**。ComfyUI 写的就是 tEXt；压缩变体在这里
 *    只增加代码量（要引 zlib 或手写 inflate），而工作流文档本身只有几 KB。
 * 2. **非 ASCII 一律转义成 `\uXXXX`**。tEXt 规范里文本是 Latin-1，直接把中文
 *    按 UTF-8 塞进去，Python 那边（PngImagePlugin 按 Latin-1 解码）会得到乱码；
 *    转义之后整块是纯 ASCII，任何解码器都能还原 —— Python 的 `json.dumps` 默认
 *    就是这么干的，所以这与 ComfyUI 完全一致。
 * 3. **CRC32 手写**（15 行查表）。为了一个校验和引一个包不值得。
 *
 * @module fatfish-canvas/client/canvas/pngmeta
 */

/** PNG 文件头（8 字节）。 */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/**
 * 这段字节是不是一个 PNG。
 * @param bytes - 文件字节。
 * @returns 是否是 PNG。
 */
export function isPng(bytes: Uint8Array): boolean {
	if (bytes.length < 8) return false;
	return PNG_SIGNATURE.every((value, index) => bytes[index] === value);
}

/** CRC32 查表（惰性构造一次）。 */
let crcTable: Uint32Array | null = null;

/** 取 CRC32 表。 */
function table(): Uint32Array {
	if (crcTable !== null) return crcTable;
	const out = new Uint32Array(256);
	for (let i = 0; i < 256; i += 1) {
		let c = i;
		for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		out[i] = c >>> 0;
	}
	crcTable = out;
	return out;
}

/**
 * 算一段字节的 CRC32（PNG 块尾部要的那个）。
 * @param bytes - 数据。
 * @param start - 起始下标。
 * @param end - 结束下标（不含）。
 * @returns 无符号 32 位校验和。
 */
function crc32(bytes: Uint8Array, start: number, end: number): number {
	const t = table();
	let c = 0xffffffff;
	for (let i = start; i < end; i += 1) {
		const byte = bytes[i] ?? 0;
		c = (t[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
	}
	return (c ^ 0xffffffff) >>> 0;
}

/** 读大端 32 位。 */
function readU32(bytes: Uint8Array, at: number): number {
	return (
		((bytes[at] ?? 0) << 24) |
		((bytes[at + 1] ?? 0) << 16) |
		((bytes[at + 2] ?? 0) << 8) |
		(bytes[at + 3] ?? 0)
	) >>> 0;
}

/** 写大端 32 位。 */
function writeU32(target: Uint8Array, at: number, value: number): void {
	target[at] = (value >>> 24) & 0xff;
	target[at + 1] = (value >>> 16) & 0xff;
	target[at + 2] = (value >>> 8) & 0xff;
	target[at + 3] = value & 0xff;
}

/** 一个 PNG 块在字节里的位置。 */
interface Chunk {
	/** 块类型（4 个 ASCII 字符）。 */
	type: string;
	/** 数据起点。 */
	start: number;
	/** 数据终点（不含）。 */
	end: number;
	/** 整个块的起点（含长度字段）。 */
	head: number;
	/** 整个块的终点（含 CRC）。 */
	tail: number;
}

/**
 * 遍历 PNG 的块。
 * @param bytes - PNG 字节。
 * @returns 块列表；遇到截断就停下（坏文件不该让调用方抛错）。
 */
function chunksOf(bytes: Uint8Array): Chunk[] {
	const out: Chunk[] = [];
	let offset = 8;
	while (offset + 8 <= bytes.length) {
		const length = readU32(bytes, offset);
		const type = String.fromCharCode(
			bytes[offset + 4] ?? 0,
			bytes[offset + 5] ?? 0,
			bytes[offset + 6] ?? 0,
			bytes[offset + 7] ?? 0,
		);
		const start = offset + 8;
		const end = start + length;
		const tail = end + 4;
		if (end < start || tail > bytes.length) break; // 截断
		out.push({ type, start, end, head: offset, tail });
		if (type === 'IEND') break;
		offset = tail;
	}
	return out;
}

/** Latin-1 / UTF-8 都能读的解码器（我们自己写的是纯 ASCII，别人写的可能不是）。 */
function decodeText(bytes: Uint8Array): string {
	let out = '';
	for (const byte of bytes) out += String.fromCharCode(byte);
	try {
		return decodeURIComponent(escape(out));
	} catch {
		return out;
	}
}

/**
 * 读出 PNG 里全部的 tEXt 块。
 *
 * ⚠️ 返回的文本**保持字节里的原样**：非 ASCII 是以 `\uXXXX` 形态存的（见模块头），
 * 这里不做反转义 —— 字节层不该猜内容是什么格式。调用方拿到 JSON 之后
 * `JSON.parse` 会把转义还原（ComfyUI 那边也是这么一条链）。
 * @param bytes - 文件字节。
 * @returns 键 → 文本；不是 PNG 或没有 tEXt 时是空对象。
 */
export function readPngText(bytes: Uint8Array): Record<string, string> {
	const out: Record<string, string> = {};
	if (!isPng(bytes)) return out;
	for (const chunk of chunksOf(bytes)) {
		if (chunk.type !== 'tEXt') continue;
		let zero = chunk.start;
		while (zero < chunk.end && bytes[zero] !== 0) zero += 1;
		if (zero >= chunk.end) continue;
		const keyword = decodeText(bytes.subarray(chunk.start, zero));
		if (keyword === '') continue;
		out[keyword] = decodeText(bytes.subarray(zero + 1, chunk.end));
	}
	return out;
}

/** 把一段文本编成 tEXt 的字节（非 ASCII 转义成 `\uXXXX`，见模块头）。 */
function encodeText(text: string): Uint8Array {
	const ascii = text.replace(
		/[\u0080-\uffff]/g,
		(ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
	);
	const out = new Uint8Array(ascii.length);
	for (let i = 0; i < ascii.length; i += 1) out[i] = ascii.charCodeAt(i) & 0xff;
	return out;
}

/** 造一个 tEXt 块（含长度与 CRC）。 */
function textChunk(keyword: string, text: string): Uint8Array {
	const key = encodeText(keyword);
	const body = encodeText(text);
	const data = new Uint8Array(key.length + 1 + body.length);
	data.set(key, 0);
	data[key.length] = 0;
	data.set(body, key.length + 1);

	const chunk = new Uint8Array(12 + data.length);
	writeU32(chunk, 0, data.length);
	chunk[4] = 0x74; // 't'
	chunk[5] = 0x45; // 'E'
	chunk[6] = 0x58; // 'X'
	chunk[7] = 0x74; // 't'
	chunk.set(data, 8);
	writeU32(chunk, 8 + data.length, crc32(chunk, 4, 8 + data.length));
	return chunk;
}

/**
 * 写入 tEXt 元数据（插在 IHDR 之后，与 ComfyUI 的做法一致）。
 *
 * 同名键**先删后写**：否则反复导出同一个文件会积累一串同名块，而读的时候
 * 只有第一个生效 —— 表现为「改了工作流但还原出来还是老的」。
 * @param bytes - 原始 PNG 字节。
 * @param entries - 键 → 文本。
 * @returns 新的 PNG 字节。
 * @throws 不是 PNG 时抛错（调用方负责先转码，见 `exportImage`）。
 */
export function writePngText(bytes: Uint8Array, entries: Record<string, string>): Uint8Array {
	if (!isPng(bytes)) throw new Error('不是 PNG，写不了元数据');
	const keys = new Set(Object.keys(entries));
	const parts: Uint8Array[] = [bytes.subarray(0, 8)];
	const added: Uint8Array[] = Object.entries(entries).map(([key, text]) => textChunk(key, text));

	let inserted = false;
	for (const chunk of chunksOf(bytes)) {
		// 同名的旧块丢掉（见上面的「先删后写」）
		if (chunk.type === 'tEXt') {
			let zero = chunk.start;
			while (zero < chunk.end && bytes[zero] !== 0) zero += 1;
			const keyword = decodeText(bytes.subarray(chunk.start, zero));
			if (keys.has(keyword)) continue;
		}
		parts.push(bytes.subarray(chunk.head, chunk.tail));
		if (chunk.type === 'IHDR' && !inserted) {
			parts.push(...added);
			inserted = true;
		}
	}
	// 极端情况：连 IHDR 都没有（chunksOf 空）——那就接在文件头后面，总比丢掉强
	if (!inserted) parts.push(...added);

	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}
