/**
 * 最小的 zip 写入器（P27）—— 只装箱，不压缩。
 *
 * 为什么自己写：导出的是一批**已经压过**的图，deflate 省不下什么，却要为此引一个
 * 几十 KB 的依赖进客户端 bundle。这里只用到 PKWARE APPNOTE 4.3.6 的三块结构
 * （local file header / central directory / EOCD），任何解压工具都认。
 *
 * 刻意**不碰 DOM 与宿主**（`exportImages.ts` 负责取字节与触发下载）：这样归档格式
 * 能在离线测试里逐字节验（见 `scripts/test-model.mjs` 第 11 节）。
 *
 * @module fatfish-canvas/client/canvas/zip
 */

/** 一个待打包的文件。 */
export interface ExportFile {
	/** 归档内的文件名（应已安全化并去重）。 */
	name: string;
	/** 字节。 */
	bytes: Uint8Array;
	/** MIME（单选直接下载时用它，zip 本身忽略）。 */
	mime: string;
}

/** 通用位标记第 11 位：文件名按 UTF-8 解 —— 不置这一位，中文标题解压后会乱码。 */
const FLAG_UTF8 = 0x0800;

/** CRC32 查表。 */
const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i += 1) {
		let c = i;
		for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[i] = c >>> 0;
	}
	return table;
})();

/**
 * 算一段字节的 CRC32。
 * @param bytes - 数据。
 * @returns 无符号 32 位校验值。
 */
export function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0);
	return (crc ^ 0xffffffff) >>> 0;
}

/** 把若干段字节拼成一段。 */
function concat(parts: readonly Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

/**
 * 组装一个 zip（STORE：只装箱，不压缩）。
 * @param files - 待打包的文件（名字应已去重）。
 * @returns zip 字节。
 */
export function zipStore(files: readonly ExportFile[]): Uint8Array {
	const encoder = new TextEncoder();
	const body: Uint8Array[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;

	for (const file of files) {
		const name = encoder.encode(file.name);
		const size = file.bytes.length;
		const crc = crc32(file.bytes);

		const local = new Uint8Array(30 + name.length);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true); // 本地文件头签名
		lv.setUint16(4, 20, true); // 解压所需版本 2.0
		lv.setUint16(6, FLAG_UTF8, true);
		lv.setUint16(8, 0, true); // 压缩方法 0 = STORE
		lv.setUint16(10, 0, true); // 修改时间（0 = 不记录，避开时区歧义）
		lv.setUint16(12, 0, true); // 修改日期
		lv.setUint32(14, crc, true);
		lv.setUint32(18, size, true); // 压缩后大小 = 原大小
		lv.setUint32(22, size, true);
		lv.setUint16(26, name.length, true);
		lv.setUint16(28, 0, true); // 扩展字段长度
		local.set(name, 30);

		const dir = new Uint8Array(46 + name.length);
		const dv = new DataView(dir.buffer);
		dv.setUint32(0, 0x02014b50, true); // 中央目录签名
		dv.setUint16(4, 20, true); // 制作版本
		dv.setUint16(6, 20, true); // 所需版本
		dv.setUint16(8, FLAG_UTF8, true);
		dv.setUint16(10, 0, true);
		dv.setUint16(12, 0, true);
		dv.setUint16(14, 0, true);
		dv.setUint32(16, crc, true);
		dv.setUint32(20, size, true);
		dv.setUint32(24, size, true);
		dv.setUint16(28, name.length, true);
		dv.setUint16(30, 0, true); // 扩展字段
		dv.setUint16(32, 0, true); // 注释
		dv.setUint16(34, 0, true); // 起始磁盘号
		dv.setUint16(36, 0, true); // 内部属性
		dv.setUint32(38, 0, true); // 外部属性
		dv.setUint32(42, offset, true); // 本地头偏移
		dir.set(name, 46);

		body.push(local, file.bytes);
		central.push(dir);
		offset += local.length + size;
	}

	const dirSize = central.reduce((sum, part) => sum + part.length, 0);
	const end = new Uint8Array(22);
	const ev = new DataView(end.buffer);
	ev.setUint32(0, 0x06054b50, true); // 中央目录结束记录
	ev.setUint16(4, 0, true);
	ev.setUint16(6, 0, true);
	ev.setUint16(8, files.length, true);
	ev.setUint16(10, files.length, true);
	ev.setUint32(12, dirSize, true);
	ev.setUint32(16, offset, true);
	ev.setUint16(20, 0, true); // 注释长度

	return concat([...body, ...central, end]);
}

/**
 * MIME → 扩展名。
 * @param mime - 媒体的 MIME。
 * @returns 扩展名（不含点）。
 */
export function extOf(mime: string): string {
	const sub = (mime.split('/')[1] ?? '').toLowerCase();
	if (sub === 'jpeg') return 'jpg';
	if (sub === 'svg+xml') return 'svg';
	// 视频那几个 MIME 的子类型不是扩展名（`quicktime` 该落成 .mov）
	if (sub === 'quicktime') return 'mov';
	if (sub === 'x-matroska') return 'mkv';
	return sub === '' ? 'png' : sub;
}

/**
 * 把标题变成安全的文件名。
 *
 * 节点的 `title` 是**提示词**（可能很长、带标点、带路径分隔符），直接当文件名会
 * 在解压时出事，因此去掉非法字符、压掉空白、截断到 24 字符；空标题退回
 * 「画布图-NN / 画布视频-NN」。标题里已经带了扩展名（`海边.mp4`）时**不重复加**
 * —— 图与视频都在一条导出路径上，两种后缀都要认。
 * @param raw - 节点标题。
 * @param fallback - 标题为空时用的名字（不含扩展名）。
 * @param ext - 扩展名（不含点）。
 * @returns 文件名。
 */
export function safeName(raw: string, fallback: string, ext: string): string {
	const cleaned = raw
		.replace(/[\\/:*?"<>|]/g, '_')
		.replace(/[\u0000-\u001f]/g, '')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/\.(png|jpe?g|webp|gif|avif|bmp|svg|mp4|webm|mov|m4v|mkv)$/i, '')
		.slice(0, 24)
		.trim();
	return `${cleaned === '' ? fallback : cleaned}.${ext}`;
}

/**
 * 同名的加 `-2` / `-3` 后缀（一个 zip 里两条同名条目会让解压工具打架）。
 * @param name - 期望的文件名。
 * @param used - 已占用的名字集合（会被就地更新）。
 * @returns 可用的文件名。
 */
export function uniqueName(name: string, used: Set<string>): string {
	if (!used.has(name)) {
		used.add(name);
		return name;
	}
	const dot = name.lastIndexOf('.');
	const base = dot < 0 ? name : name.slice(0, dot);
	const ext = dot < 0 ? '' : name.slice(dot);
	for (let i = 2; ; i += 1) {
		const candidate = `${base}-${String(i)}${ext}`;
		if (!used.has(candidate)) {
			used.add(candidate);
			return candidate;
		}
	}
}
