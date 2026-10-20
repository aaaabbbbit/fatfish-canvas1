/**
 * 把用户给的米饭碗素材压成能塞进客户端产物的 base64。
 *
 * 为什么要压：客户端半边是一个 JS 模块（`lib/client.js`），图片要么内联成
 * data URI，要么让插件去服务静态文件 —— 后者在 DSH 里没有现成的口子。
 * 素材是 1152×976 的 PNG（1.0MB）与 400×300 / 78 帧的 GIF（1.8MB），而图标
 * 最大用法是 28px：直接内联等于每次加载多背 3MB。
 *
 * 产出两个常量（都是 data URI）：
 *   RICE_BOWL_PNG  静图，256 宽，约 90KB base64
 *   RICE_BOWL_ANIM 动图（生成中用），200 宽 / 透明底，约 630KB base64
 *
 * ⚠️ 动图必须转格式：GIF 的白底是**不透明**的，直接把 GIF 内联上去会在深色
 *    主题下糊一块白方块。这里用 ffmpeg 的 colorkey 把白底抠成透明，再编码成
 *    **动图 WebP**（体积也更小）。转换要 ffmpeg（本机 `D:\FFmpeg\...`）。
 *
 * ⚠️ 素材换了就重跑这一条（`npm run art`）。产物把关在**离线**测试里
 *    （scripts/test-icon.mjs 查格式 / 尺寸 / 体积），别把校验塞回这个必须
 *    Chrome + ffmpeg 的脚本里 —— 否则门禁要么跑不了、要么每次都得放宽沙箱。
 *
 * ⚠️ 无头 Chrome 要命名管道：必须 danger-full-access。
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC_PNG = resolve(root, 'assets/rice-bowl.png');
const SRC_GIF = resolve(root, 'assets/rice-bowl.gif');
const OUT = resolve(root, 'src/client/generated/art.ts');
const PNG_WIDTH = 256;
const ANIM_WIDTH = 200;

/** 让 Chrome 缩静图并转成 base64（本机没有 sharp/jimp，也不该为这个装一个）。 */
function encodePng(width) {
	const tag = String(Date.now());
	const page = resolve(root, `lib/art-${tag}.html`);
	writeFileSync(
		page,
		`<!doctype html><meta charset="utf-8"><body><script>
		const img = new Image();
		img.onload = () => {
			const c = document.createElement('canvas');
			c.width = ${String(width)};
			c.height = Math.round(img.naturalHeight * (${String(width)} / img.naturalWidth));
			const g = c.getContext('2d');
			g.drawImage(img, 0, 0, c.width, c.height);
			document.body.insertAdjacentHTML('beforeend', '<pre id="r">' + c.toDataURL('image/png') + '</pre>');
		};
		img.src = '../assets/rice-bowl.png';
		</script></body>`,
		'utf8',
	);
	const dom = execFileSync(
		'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
		[
			'--headless=new',
			'--disable-gpu',
			'--user-data-dir=' + mkdtempSync(resolve(tmpdir(), 'ffc-art-')),
			'--allow-file-access-from-files',
			'--virtual-time-budget=8000',
			'--dump-dom',
			page,
		],
		{ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
	);
	const m = dom.match(/<pre id="r">(data:image\/png;base64,[A-Za-z0-9+/=]+)<\/pre>/);
	if (m === null) throw new Error('没能从无头 Chrome 里拿到缩放后的静图');
	return m[1];
}

/** GIF → 透明底动图 WebP（ffmpeg）。白底抠掉，帧率与时长照原样。 */
function encodeAnim(width) {
	const out = resolve(root, 'lib/art-anim.webp');
	execFileSync(
		'ffmpeg',
		[
			'-y',
			'-v',
			'error',
			'-i',
			SRC_GIF,
			'-vf',
			`colorkey=0xFFFFFF:0.30:0.10,scale=${String(width)}:-1:flags=lanczos`,
			'-c:v',
			'libwebp_anim',
			'-q:v',
			'35',
			'-loop',
			'0',
			'-an',
			out,
		],
		{ stdio: ['ignore', 'ignore', 'pipe'] },
	);
	return `data:image/webp;base64,${readFileSync(out).toString('base64')}`;
}

const png = encodePng(PNG_WIDTH);
const anim = encodeAnim(ANIM_WIDTH);

// ── 写盘前的自检 ──────────────────────────────────────────────
// 这个脚本会**无条件覆盖** src/client/generated/art.ts（那是提交进仓库的产物），
// 所以先把两头都验一遍：转换中途出岔（Chrome 截到空白页、ffmpeg 转成了静图），
// 宁可在这里炸掉，也不要写出一份「看起来正常、其实不能用」的产物。
const bytesOf = (uri) => Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64');
{
	const p = bytesOf(png);
	const okPng = p.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
	const w = okPng ? p.readUInt32BE(16) : 0;
	const h = okPng ? p.readUInt32BE(20) : 0;
	if (!okPng || Math.abs(w / h - 1152 / 976) > 0.02 || p.length > 200 * 1024) {
		throw new Error(`静图不合规：magic=${String(okPng)} ${String(w)}x${String(h)} ${String(p.length)}B`);
	}
	const a = bytesOf(anim);
	const text = a.toString('latin1');
	if (a.subarray(0, 4).toString() !== 'RIFF' || !text.includes('ANIM') || !text.includes('ANMF') || !text.includes('ALPH')) {
		throw new Error('动图不合规：不是带透明的动图 WebP（缺 RIFF/ANIM/ANMF/ALPH）');
	}
	if (a.length > 800 * 1024) throw new Error(`动图太大：${String(Math.round(a.length / 1024))}KB`);
}

const body =
	`/**\n` +
	` * 自动生成，别手改：由 scripts/make-art.mjs 从 assets/ 里的素材压出来。\n` +
	` *\n` +
	` * 为什么压：客户端半边是单个 JS 模块，图片只能内联 data URI；而素材是\n` +
	` * 1152×976 的 PNG（1.0MB）与 400×300 / 78 帧的 GIF（1.8MB），图标最大用法\n` +
	` * 只有 28px —— 不压等于每次加载多背 3MB。动图还要把 GIF 的白底抠成透明\n` +
	` * 再转 WebP，否则深色主题下会糊一块白方块。改素材请改 assets/ 后重跑脚本。\n` +
	` *\n` +
	` * ⚠️ 这个文件里**只有数据**，没有 import / JSX：scripts/preview-icon.mjs 与\n` +
	` * test-icon.mjs 会把它连同 icons.tsx 一起直接执行（不打包），多一行语句就多一处坑。\n` +
	` */\n\n` +
	`/** 米饭碗静图（PNG data URI，${String(PNG_WIDTH)} 宽）。 */\n` +
	`export const RICE_BOWL_PNG =\n\t'${png}';\n\n` +
	`/** 米饭碗动图（动图 WebP data URI，${String(ANIM_WIDTH)} 宽、透明底）。 */\n` +
	`export const RICE_BOWL_ANIM =\n\t'${anim}';\n`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, body, 'utf8');
console.log(
	`art.ts 已写出：静图 ${String(Math.round(png.length / 1024))}KB base64 / ` +
		`动图 ${String(Math.round(anim.length / 1024))}KB base64`,
);
