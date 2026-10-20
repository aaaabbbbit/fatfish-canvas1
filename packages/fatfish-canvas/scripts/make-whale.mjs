/**
 * 把 **DSH 原生那枚「摇尾巴」鲸鱼**抽成能塞进客户端产物的常量。
 *
 * 为什么要「抽」而不是自己画：用户要的就是「和原生一致」。原生那枚其实是**两半**
 * （`dsh-client-ui-chat` 里的 RunningWhaleTail）：
 *   - 静止态：一条**矢量描边** —— `REST_PATH`，`viewBox 0 0 16 16`，
 *     `stroke: currentColor`，`stroke-width: 1`。矢量在任何尺寸都清晰。
 *   - 能动时：`mask:url(data:image/png;base64,…)` —— 一张 **28×28 / 60 帧 /
 *     20fps / 无限循环的 APNG**，本身没有颜色，靠 `background: currentColor` 上色。
 * 姿态与动效**逐帧照抄**，「一致」就是构造事实，不靠对齐参数。
 *
 * 产出两个常量：
 *   WHALE_TAIL_PATH  静止态那条描边的 `d`（使用处填成实心，见 icons.tsx）。
 *   WHALE_TAIL_ANIM  **推导出的实心动画**（约 8.9KB），摇尾巴用。
 *
 * ⚠️ 动图那一半**不是**原件的字节：原生那 60 帧是**发丝线**，用户要「动态也纯色」，
 *    所以这里逐帧把线填成面（`lib/whale-solid.mjs`）—— 帧数 / 尺寸 / 延时 / 循环
 *    全部照抄原生，只有「线 ⟶ 面」这一步是我们加的，且**可复现**
 *    （test-icon 会拿本机原生重新推一遍，逐字节比）。
 * ⚠️ 静止态**不要**拿 APNG 第 0 帧当静帧（P38 第一版就是那么干的）：那是 28×28 的
 *    **位图细线**，缩到 14/17px 之后峰值 alpha 只剩七成上下 —— 屏幕上看着是灰的，
 *    浅色主题下更是等于隐形。原生自己用矢量描边当静止态，照抄它。
 * ⚠️ DSH 升级可能换掉这段资产。本脚本抽不到时**直接炸**（不写产物），
 *    重跑 `npm run art` 即可；产物本身的把关在 scripts/test-icon.mjs。
 * ⚠️ 本脚本不需要 Chrome / ffmpeg —— 纯 Node（读文件 + 正则 + 切 PNG 块 + zlib）。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeApng, encodeApng, solidApng } from './lib/whale-solid.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = resolve(root, 'src/client/generated/whale.ts');

/** 本机 dsh 安装目录（与 build.mjs 的统一基座守卫同一套定位）。 */
function dshInstallRoot() {
	const appData = process.env.APPDATA;
	if (appData === undefined) throw new Error('拿不到 APPDATA，定位不到本机 dsh 安装目录');
	return resolve(appData, 'npm/node_modules/@deepseek-ai/dsh');
}

const CHAT_CLIENT = resolve(
	dshInstallRoot(),
	'node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js',
);

const source = readFileSync(CHAT_CLIENT, 'utf8');

const maskMatch = /mask:url\(data:image\/png;base64,([A-Za-z0-9+/=]+)\)/.exec(source);
if (maskMatch === null || maskMatch[1] === undefined) {
	throw new Error(`${CHAT_CLIENT} 里找不到 mask:url(data:image/png;base64,…) —— DSH 换过资产了`);
}
const apng = Buffer.from(maskMatch[1], 'base64');

const pathMatch = /const REST_PATH = "([^"]+)"/.exec(source);
if (pathMatch === null || pathMatch[1] === undefined) {
	throw new Error(`${CHAT_CLIENT} 里找不到 REST_PATH —— DSH 换过资产了`);
}
const restPath = pathMatch[1];

/** 走一遍 PNG 块，顺带把每块的边界记下来。 */
function chunksOf(buf) {
	const out = [];
	let off = 8;
	while (off + 8 <= buf.length) {
		const len = buf.readUInt32BE(off);
		out.push({ type: buf.subarray(off + 4, off + 8).toString('latin1'), off, len });
		off += 12 + len;
	}
	return out;
}

const chunks = chunksOf(apng);
const ihdr = chunks.find((c) => c.type === 'IHDR');
if (ihdr === undefined) throw new Error('抽到的不是 PNG：没有 IHDR');
const width = apng.readUInt32BE(ihdr.off + 8);
const height = apng.readUInt32BE(ihdr.off + 12);
const frames = chunks.filter((c) => c.type === 'fcTL').length;

// ── 写盘前的自检 ──────────────────────────────────────────────
// 这个脚本会**无条件覆盖** src/client/generated/whale.ts（提交进仓库的产物），
// 所以先验一遍：宁可在这里炸掉，也不要写出一份「看着正常、其实不动 / 画不出来」的产物。
if (apng.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('动图不是 PNG');
if (width !== 28 || height !== 28) throw new Error(`动图不是 28×28：${width}×${height}`);
if (frames < 2 || !chunks.some((c) => c.type === 'fdAT')) {
	throw new Error(`动图是静的（fcTL ${String(frames)} 帧）—— 原生的动画没了`);
}
// 路径要能原样塞进单引号字符串：带引号 / 换行就说明抽错了东西
if (!restPath.startsWith('M') || restPath.length < 200) {
	throw new Error(`REST_PATH 不像一条路径（${String(restPath.length)} 字符）：${restPath.slice(0, 40)}`);
}
if (/[^\dMLA-Za-z.,\s-]/.test(restPath)) throw new Error('REST_PATH 里有路径字符之外的东西，别写进产物');

// ── 把原生那 60 帧细线推导成实心（姿态 / 帧数 / 延时照抄，只把线填成面） ──
const native = decodeApng(apng);
if (native.frames.length !== frames) {
	throw new Error(`解出来的帧数对不上（fcTL ${String(frames)} / 解出 ${String(native.frames.length)}）`);
}
const solid = solidApng(native);
// 自检：每一帧都得**真的**比线稿大出一块（没填上 = 还是细线；灌满整张 = 弦补错了）
const area = (f) => f.alpha.reduce((n, v) => n + (v > 8 ? 1 : 0), 0);
const ratio = solid.frames.map((f, i) => area(f) / area(native.frames[i]));
if (Math.min(...ratio) < 1.2 || Math.max(...ratio) > 3) {
	throw new Error(`实心化不对劲：面积比 ${Math.min(...ratio).toFixed(2)}..${Math.max(...ratio).toFixed(2)}（该在 1.2..3）`);
}
const solidPng = encodeApng(solid);

const body =
	`/**\n` +
	` * 自动生成，别手改：由 scripts/make-whale.mjs 从本机 DSH 原生产物里抽出来\n` +
	` * （dsh-client-ui-chat 的 RunningWhaleTail）。重跑：npm run art。\n` +
	` *\n` +
	` * 为什么要复用同一份资产：用户要的动效是「和 DSH 原生完全一致」。\n` +
	` * 原生的静止态是矢量描边、能动时是 ${String(frames)} 帧 APNG —— 这里两半都照抄，\n` +
	` * 上色一律走 currentColor（跟主题），见 icons.tsx 与 styles.ts。\n` +
	` * ⚠️ 静止态在**使用处**被填成实心（fill="currentColor"，用户要「实心纯色」）：\n` +
	` * 这里存的仍是原生那条**开放路径**，填不填由 icons.tsx 决定。\n` +
	` * ⚠️ 动图那半**不是原件字节**：原生那 60 帧是发丝线，用户要「动态也纯色」，\n` +
	` * 于是逐帧把线填成面（scripts/lib/whale-solid.mjs）。帧数 / 尺寸 / 延时 /\n` +
	` * 循环都照抄原生，只有「线 ⟶ 面」是我们加的 —— test-icon 会重新推一遍比对。\n` +
	` *\n` +
	` * ⚠️ 这个文件里**只有数据**，没有 import / JSX：scripts/preview-icon.mjs 与\n` +
	` * test-icon.mjs 会把它直接执行（不打包），多一行语句就多一处坑。\n` +
	` */\n\n` +
	`/** 静止态：原生那条 d（viewBox 0 0 16 16，stroke-width 1；使用处填成实心）。 */\n` +
	`export const WHALE_TAIL_PATH =\n\t'${restPath}';\n\n` +
	`/** 摇尾巴：由原生那 ${String(frames)} 帧推导的**实心**动画，28×28 / 20fps / 无限循环。 */\n` +
	`export const WHALE_TAIL_ANIM =\n\t'data:image/png;base64,${solidPng.toString('base64')}';\n`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, body, 'utf8');
console.log(
	`whale.ts 已写出：矢量 d ${String(restPath.length)} 字符 / 实心动图 ${String(solidPng.length)}B` +
		`（原生 ${String(apng.length)}B，${String(frames)} 帧，面积比 ${Math.min(...ratio).toFixed(2)}..${Math.max(...ratio).toFixed(2)}）` +
		` ← ${CHAT_CLIENT}`,
);
