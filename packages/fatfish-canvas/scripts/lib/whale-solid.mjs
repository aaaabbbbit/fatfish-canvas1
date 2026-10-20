/**
 * 把原生那枚鲸鱼尾巴 APNG（**细线**动画）推导成**实心**动画。
 *
 * 为什么需要它：用户要「动态图标也纯色」，可原生那 60 帧是一圈发丝线（§3.42），
 * 光换颜色只会得到一条更亮的线。于是**逐帧把它填成面**：姿态 / 帧数 / 时序 / 尺寸
 * 全部照抄原生，只有「线 ⟶ 面」这一步是我们加的（因此仍可复现、可回归）。
 *
 * 填法（原生那条路径是**开放**的，收笔处没画闭合弦，所以内部与外界是通的）：
 *   ① 阈值取轮廓（alpha > 8）；
 *   ② 在**最低一行**把左右两端连起来 = 补上原生没画的那条闭合弦（尾柄底边）；
 *   ③ 从画布边框洪水填充「外面」，填不到的就是剪影内部；
 *   ④ 外面 0 / 其余 255。
 * 这样得到的面**外缘与那条线的外缘重合**，和静止态（fill + 同色描边）的剪影对齐。
 *
 * 纯 Node：`zlib` 解 / 压 + 手写 PNG 块。不引依赖、不碰 Chrome。
 *
 * @module fatfish-canvas/scripts/lib/whale-solid
 */

import { deflateSync, inflateSync } from 'node:zlib';

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** CRC32（PNG 每个块都要）。 */
const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let n = 0; n < 256; n += 1) {
		let c = n;
		for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c;
	}
	return table;
})();

/**
 * 拼一个 PNG 块。
 * @param type - 4 字符块名。
 * @param data - 块体。
 * @returns 完整块（长度 + 类型 + 体 + CRC）。
 */
const chunk = (type, data) => {
	const out = Buffer.alloc(12 + data.length);
	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, 'latin1');
	data.copy(out, 8);
	let c = -1;
	for (const byte of out.subarray(4, 8 + data.length)) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	out.writeUInt32BE((c ^ -1) >>> 0, 8 + data.length);
	return out;
};

/**
 * 还原 PNG 的逐行滤波。
 * @param raw - 解压后的原始字节（每行前面一个滤波字节）。
 * @param w - 宽。
 * @param h - 高。
 * @param bpp - 每像素字节数。
 * @returns 像素缓冲（`h * w * bpp`）。
 */
function unfilter(raw, w, h, bpp) {
	const stride = w * bpp;
	const px = Buffer.alloc(h * stride);
	let p = 0;
	for (let y = 0; y < h; y += 1) {
		const f = raw[p];
		p += 1;
		const line = raw.subarray(p, p + stride);
		p += stride;
		const cur = px.subarray(y * stride, (y + 1) * stride);
		const prev = y === 0 ? Buffer.alloc(stride) : px.subarray((y - 1) * stride, y * stride);
		for (let x = 0; x < stride; x += 1) {
			const a = x >= bpp ? cur[x - bpp] : 0;
			const b = prev[x];
			const c = x >= bpp ? prev[x - bpp] : 0;
			let v = line[x];
			if (f === 1) v += a;
			else if (f === 2) v += b;
			else if (f === 3) v += (a + b) >> 1;
			else if (f === 4) {
				const pp = a + b - c;
				const pa = Math.abs(pp - a);
				const pb = Math.abs(pp - b);
				const pc = Math.abs(pp - c);
				v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
			}
			cur[x] = v & 0xff;
		}
	}
	return px;
}

/**
 * 解一个（A）PNG：逐帧合成出 **alpha 通道**。
 *
 * 合成照 APNG 规范做（blend OVER / SOURCE、dispose NONE / BACKGROUND / PREVIOUS），
 * 这样即使原生哪天改成「局部帧」也不会解错。
 *
 * @param buf - PNG / APNG 字节。
 * @returns `{ w, h, colorType, plays, frames: [{ alpha, delayNum, delayDen }] }`。
 */
export function decodeApng(buf) {
	if (!buf.subarray(0, 8).equals(SIG)) throw new Error('不是 PNG（签名不对）');
	let off = 8;
	let ihdr = null;
	let actl = null;
	const raw = [];
	let pending = null;
	while (off + 12 <= buf.length) {
		const len = buf.readUInt32BE(off);
		const type = buf.subarray(off + 4, off + 8).toString('latin1');
		const data = buf.subarray(off + 8, off + 8 + len);
		off += 12 + len;
		if (type === 'IHDR') {
			ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], colorType: data[9] };
		} else if (type === 'acTL') {
			actl = { count: data.readUInt32BE(0), plays: data.readUInt32BE(4) };
		} else if (type === 'fcTL') {
			if (pending !== null) raw.push(pending);
			pending = {
				w: data.readUInt32BE(4),
				h: data.readUInt32BE(8),
				x: data.readUInt32BE(12),
				y: data.readUInt32BE(16),
				delayNum: data.readUInt16BE(20),
				delayDen: data.readUInt16BE(22),
				dispose: data[24],
				blend: data[25],
				parts: [],
			};
		} else if (type === 'IDAT' || type === 'fdAT') {
			if (pending === null) throw new Error(`${type} 出现在 fcTL 之前`);
			pending.parts.push(type === 'fdAT' ? data.subarray(4) : data);
		}
	}
	if (pending !== null) raw.push(pending);
	if (ihdr === null) throw new Error('没有 IHDR');
	if (raw.length === 0) throw new Error('没有任何帧（不是动图？）');

	const { w, h, colorType } = ihdr;
	if (colorType !== 4 && colorType !== 6) throw new Error(`只认带 alpha 的 colorType 4 / 6（这个是 ${String(colorType)}）`);
	const bpp = colorType === 4 ? 2 : 4;
	let canvas = new Uint8Array(w * h);
	const frames = [];
	for (const f of raw) {
		const px = unfilter(inflateSync(Buffer.concat(f.parts)), f.w, f.h, bpp);
		const before = canvas.slice();
		for (let y = 0; y < f.h; y += 1) {
			for (let x = 0; x < f.w; x += 1) {
				const src = px[(y * f.w + x) * bpp + bpp - 1];
				const i = (f.y + y) * w + (f.x + x);
				// alpha 合成：SOURCE 直接替换，OVER 按 out = src + dst * (1 - src)
				canvas[i] = f.blend === 1 ? Math.round(src + (canvas[i] * (255 - src)) / 255) : src;
			}
		}
		frames.push({ alpha: canvas.slice(), delayNum: f.delayNum, delayDen: f.delayDen });
		if (f.dispose === 2) {
			for (let y = 0; y < f.h; y += 1) for (let x = 0; x < f.w; x += 1) canvas[(f.y + y) * w + f.x + x] = 0;
		} else if (f.dispose === 1) {
			canvas = before;
		}
	}
	return { w, h, colorType, plays: actl === null ? 1 : actl.plays, frames };
}

/**
 * 把一帧的**细线** alpha 填成**实心剪影**（做法见模块头）。
 * @param alpha - 该帧的 alpha 通道（`w * h`）。
 * @param w - 宽。
 * @param h - 高。
 * @returns 实心 alpha（同尺寸）。
 */
export function solidOf(alpha, w, h) {
	const wall = new Uint8Array(w * h);
	for (let i = 0; i < w * h; i += 1) wall[i] = alpha[i] > 8 ? 1 : 0;

	// 补上原生没画的那条闭合弦：最低两行里的轮廓，把左右两端连起来。
	// ⚠️ 取两行而不是一行：尾柄两侧的收笔不在同一行（实测左边到 y=24、右边到 y=23），
	//    只看最低一行会连不上，弦补了个寂寞、洪水照样从开口灌进去（第一版就栽在这）。
	let yMax = -1;
	for (let i = 0; i < w * h; i += 1) if (wall[i] === 1 && Math.floor(i / w) > yMax) yMax = Math.floor(i / w);
	if (yMax >= 0) {
		let x0 = w;
		let x1 = -1;
		for (let y = Math.max(0, yMax - 1); y <= yMax; y += 1) {
			for (let x = 0; x < w; x += 1) {
				if (wall[y * w + x] === 1) {
					if (x < x0) x0 = x;
					if (x > x1) x1 = x;
				}
			}
		}
		for (let x = x0; x <= x1; x += 1) wall[yMax * w + x] = 1;
	}

	const outside = new Uint8Array(w * h);
	const stack = [];
	for (let x = 0; x < w; x += 1) stack.push(x, (h - 1) * w + x);
	for (let y = 0; y < h; y += 1) stack.push(y * w, y * w + w - 1);
	while (stack.length > 0) {
		const i = stack.pop();
		if (i < 0 || i >= w * h || outside[i] === 1 || wall[i] === 1) continue;
		outside[i] = 1;
		const x = i % w;
		if (x > 0) stack.push(i - 1);
		if (x < w - 1) stack.push(i + 1);
		stack.push(i - w, i + w);
	}

	const solid = new Uint8Array(w * h);
	for (let i = 0; i < w * h; i += 1) solid[i] = outside[i] === 1 ? 0 : 255;
	return solid;
}

/**
 * 逐帧填实心。
 * @param decoded - {@link decodeApng} 的结果。
 * @returns 同样形状的结果（alpha 已换成实心）。
 */
export function solidApng(decoded) {
	return { ...decoded, frames: decoded.frames.map((f) => ({ ...f, alpha: solidOf(f.alpha, decoded.w, decoded.h) })) };
}

/** 一帧的原始扫描线（灰度恒 255，图形全在 alpha 上；滤波字节 0）。 */
const rawOf = (alpha, w, h) => {
	const stride = 1 + w * 2;
	const out = Buffer.alloc(h * stride);
	for (let y = 0; y < h; y += 1) {
		const row = y * stride;
		out[row] = 0;
		for (let x = 0; x < w; x += 1) {
			out[row + 1 + x * 2] = 255;
			out[row + 2 + x * 2] = alpha[y * w + x];
		}
	}
	return out;
};

/** 灰度 + alpha、8bit 的 IHDR。 */
const ihdrOf = (w, h) => {
	const d = Buffer.alloc(13);
	d.writeUInt32BE(w, 0);
	d.writeUInt32BE(h, 4);
	d[8] = 8;
	d[9] = 4;
	return chunk('IHDR', d);
};

/**
 * 编一张单帧 PNG（胶片条预览用）。
 * @param alpha - alpha 通道。
 * @param w - 宽。
 * @param h - 高。
 * @returns PNG 字节。
 */
export function encodePng(alpha, w, h) {
	return Buffer.concat([SIG, ihdrOf(w, h), chunk('IDAT', deflateSync(rawOf(alpha, w, h), { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * 编一张 APNG（逐帧全画布、blend SOURCE、dispose NONE、无限循环）。
 * @param decoded - `{ w, h, frames }`（`plays` 为 0 表示无限）。
 * @returns APNG 字节。
 */
export function encodeApng(decoded) {
	const { w, h, frames } = decoded;
	const actl = Buffer.alloc(8);
	actl.writeUInt32BE(frames.length, 0);
	actl.writeUInt32BE(decoded.plays ?? 0, 4);
	const parts = [SIG, ihdrOf(w, h), chunk('acTL', actl)];
	let seq = 0;
	frames.forEach((f, i) => {
		const fctl = Buffer.alloc(26);
		fctl.writeUInt32BE(seq, 0);
		seq += 1;
		fctl.writeUInt32BE(w, 4);
		fctl.writeUInt32BE(h, 8);
		fctl.writeUInt16BE(f.delayNum, 20);
		fctl.writeUInt16BE(f.delayDen, 22);
		// dispose = 0（NONE）、blend = 0（SOURCE）：每帧都铺满画布，直接替换
		parts.push(chunk('fcTL', fctl));
		const data = deflateSync(rawOf(f.alpha, w, h), { level: 9 });
		if (i === 0) parts.push(chunk('IDAT', data));
		else {
			const head = Buffer.alloc(4);
			head.writeUInt32BE(seq, 0);
			seq += 1;
			parts.push(chunk('fdAT', Buffer.concat([head, data])));
		}
	});
	parts.push(chunk('IEND', Buffer.alloc(0)));
	return Buffer.concat(parts);
}
