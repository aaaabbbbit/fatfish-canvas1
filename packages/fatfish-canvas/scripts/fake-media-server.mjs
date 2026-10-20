/**
 * 假的 OpenAI 兼容媒体服务 —— 只服务于本插件的端到端验证。
 *
 * 为什么需要它：`media_generate` 的成功路径需要一个**能被控制耗时**的供应商，
 * 否则「先落 pending 占位、结果到了再改状态」这条最核心的设计在本地无法观察
 * （没配密钥时生成瞬间就失败，pending 阶段短到看不见），而且真实密钥不该
 * 出现在测试里。
 *
 * 它实现的就是插件适配器认的那一小片协议：
 *
 *   POST /v1/images/generations   → 等 DELAY_MS 毫秒 → { data: [{ url }] }
 *   GET  /out/<n>.png             → 一张现画的小图（渐变背景 + 一条肥鱼）
 *   POST /v1/videos/generations   → 直接出片（返回 404 时插件会去轮询，这里不考）
 *   GET  /v1/models               → OpenAI 形状的模型列表（P9 的探测用；校验 --key）
 *
 * 用法（配合设置页，或在 profile patch 那一行的 `config:` 里直接写）：
 *   node scripts/fake-media-server.mjs --port 8791 --delay 2500 --key sk-local-fake
 *
 * P9 的新形状长这样（密钥也可以直接写进凭据库）。0.2.0 起设置分节按 **Loader
 * entry id** 寻址，因此它是那一行的 `config:`，不再是 `settings.yaml` 里的
 * 自定义 namespace：
 *   - id: fatfish-canvas
 *     name: fatfish-canvas
 *     config:
 *       providers:
 *         local:
 *           baseURL: http://127.0.0.1:8791/v1
 *           apiKeyEnv: FFC_LOCAL_API_KEY
 *           models:
 *             - id: fake-image-1
 *               kind: image
 *       defaultImage: local::fake-image-1
 *
 * ⚠️ 只用于本地验证：图是现画的，除了（可选的）密钥之外什么都不校验。
 */

import { createServer } from 'node:http';
import { deflateSync } from 'node:zlib';

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
	const i = argv.indexOf(name);
	return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

const PORT = Number(argOf('--port', '8791'));
/** 故意慢：给「等待中的画布节点」留出可观察的窗口。 */
const DELAY_MS = Number(argOf('--delay', '2500'));
/** 期望的密钥（`--key` 给出时 `/models` 会校验它，用来验证 401 分支）。 */
const WANT_KEY = argOf('--key', null);
const SIZE = 256;

// ─────────────────────── 极简 PNG 编码器 ───────────────────────
// 只为造一张能一眼看出「这是生成结果」的图，不引任何依赖。

const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let n = 0; n < 256; n += 1) {
		let c = n;
		for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c;
	}
	return table;
})();

/**
 * 计算 PNG 分块的 CRC32。
 * @param buf - 分块数据（类型 + 内容）。
 * @returns CRC32 值。
 */
function crc32(buf) {
	let c = 0xffffffff;
	for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/**
 * 组装一个 PNG 分块。
 * @param type - 四字符类型。
 * @param data - 内容。
 * @returns 分块缓冲。
 */
function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length, 0);
	const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body), 0);
	return Buffer.concat([len, body, crc]);
}

/**
 * 把 RGBA 像素编码成 PNG。
 * @param width - 宽。
 * @param height - 高。
 * @param rgba - 长度 width*height*4 的像素。
 * @returns PNG 缓冲。
 */
function encodePng(width, height, rgba) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // RGBA
	// 每行前置一个 filter 字节（0 = None）
	const raw = Buffer.alloc((width * 4 + 1) * height);
	for (let y = 0; y < height; y += 1) {
		raw[y * (width * 4 + 1)] = 0;
		rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(raw, { level: 9 })),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

/**
 * 画一张「肥鱼在米饭碗里」的示意图。
 * @param seed - 用于让每次生成的图略有不同。
 * @returns PNG 缓冲。
 */
function makeImage(seed) {
	const px = Buffer.alloc(SIZE * SIZE * 4);
	const cx = SIZE / 2;
	const cy = SIZE / 2;
	/** 一条肥鱼：椭圆身体 + 三角尾巴 + 一只眼。 */
	const fish = (x, y) => {
		const bx = (x - cx) / 76;
		const by = (y - cy) / 46;
		if (bx * bx + by * by <= 1) return true;
		// 尾巴
		if (x > cx + 70 && x < cx + 118 && Math.abs(y - cy) < (118 - (x - cx - 70)) * 0.45) return true;
		return false;
	};
	const eyeX = cx - 30;
	const eyeY = cy - 12;

	for (let y = 0; y < SIZE; y += 1) {
		for (let x = 0; x < SIZE; x += 1) {
			const i = (y * SIZE + x) * 4;
			// 背景：随 seed 微变的蓝绿渐变
			const t = (x + y) / (SIZE * 2);
			let r = 24 + t * 20 + (seed % 7);
			let g = 92 + t * 60;
			let b = 132 + t * 70;
			// 碗底的一圈暖色
			const d = Math.hypot(x - cx, y - cy - 30);
			if (d > 84 && d < 104) {
				r = 214;
				g = 178;
				b = 120;
			}
			if (fish(x, y)) {
				r = 246;
				g = 176 + (seed % 20);
				b = 96;
			}
			if (Math.hypot(x - eyeX, y - eyeY) < 7) {
				r = 32;
				g = 32;
				b = 40;
			}
			px[i] = r;
			px[i + 1] = g;
			px[i + 2] = b;
			px[i + 3] = 255;
		}
	}
	return encodePng(SIZE, SIZE, px);
}

// ─────────────────────── 服务 ───────────────────────

let served = 0;

const server = createServer((req, res) => {
	const url = new URL(req.url ?? '/', `http://127.0.0.1:${String(PORT)}`);
	const json = (status, body) => {
		res.writeHead(status, { 'content-type': 'application/json' });
		res.end(JSON.stringify(body));
	};

	if (req.method === 'POST' && url.pathname.endsWith('/images/generations')) {
		let raw = '';
		req.on('data', (part) => {
			raw += String(part);
		});
		req.on('end', () => {
			served += 1;
			const n = served;
			let body = {};
			try {
				body = JSON.parse(raw);
			} catch {
				/* 提示词解析失败不影响出图 */
			}
			console.log(
				`[fake-media] #${String(n)} images/generations model=${String(body.model)} prompt=${String(body.prompt).slice(0, 40)} size=${String(body.size)} → 延迟 ${String(DELAY_MS)}ms`,
			);
			setTimeout(() => {
				json(200, {
					created: Math.floor(Date.now() / 1000),
					data: [{ url: `http://127.0.0.1:${String(PORT)}/out/${String(n)}.png` }],
				});
			}, DELAY_MS);
		});
		return;
	}

	if (req.method === 'GET' && url.pathname.startsWith('/out/')) {
		const seed = Number(url.pathname.replace(/^\/out\//, '').replace(/\.png$/, '')) || 1;
		const png = makeImage(seed);
		res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length });
		res.end(png);
		return;
	}

	// 视频：直接出片（这个假服务不提供真实视频文件，够用来验证 URL 落图）
	if (req.method === 'POST' && url.pathname.endsWith('/videos/generations')) {
		json(200, { data: [{ url: `http://127.0.0.1:${String(PORT)}/out/1.png` }] });
		return;
	}

	// 模型列表：给 P9 的「测试连接 / 获取模型列表」用。
	//
	// 刻意照 OpenAI 官方的形状返回（`{ data: [{ id }] }`），并**校验鉴权头**：
	// 那样「密钥配错了」才会以 401 的形式被 e2e 看见，而不是一路绿灯。
	if (req.method === 'GET' && url.pathname.endsWith('/models')) {
		const auth = String(req.headers.authorization ?? '');
		if (WANT_KEY !== null && auth !== `Bearer ${WANT_KEY}`) {
			json(401, { error: { message: 'fake-media: 密钥不对（请检查测试用的 key）' } });
			return;
		}
		console.log(`[fake-media] GET /models（auth=${auth === '' ? '无' : '有'}）`);
		json(200, {
			object: 'list',
			data: [
				{ id: 'fake-image-large', object: 'model' },
				{ id: 'fake-video-sora', object: 'model' },
				{ id: 'plain-model', object: 'model' },
			],
		});
		return;
	}

	json(404, { error: { message: `fake-media: 没有这个路由 ${url.pathname}` } });
});

server.listen(PORT, '127.0.0.1', () => {
	console.log(`[fake-media] 已监听 http://127.0.0.1:${String(PORT)}（延迟 ${String(DELAY_MS)}ms）`);
});
