/**
 * 鲸鱼尾巴图标预览 —— 把 `whaleTailHtml()` 渲成一张 PNG 供肉眼验收。
 *
 * 为什么需要它：这枚图标**读代码看不出好坏** —— 少一个 -webkit- 前缀、小尺寸下
 * 糊成一团、颜色不跟主题（浅色主题下隐形），都要真渲染出来才知道。这里用系统里
 * 已有的无头 Chrome 截图，不引第三方渲染器。
 *
 *   node scripts/preview-icon.mjs [--out lib/icon-preview.png]
 *
 * 图里并排放：浅色底上的 17px 入口 / 14px 工具行 / 28px 画布「生成中」/ 96px 放大，
 * 深色底上同样三枚 + 入口按钮实景两枚（静止 ⟷ 悬停那个动态态）。
 * **两排都该看得见** —— 这就是「跟主题」的验收点。
 *
 * ⚠️ 动图是**帧序列**，而截图只能停在某一刻（--virtual-time-budget 也推不动
 *    APNG 的帧 —— 实测 12 个预算的截图**逐字节相同**）。所以这里给不出胶片条：
 *    要看它真在摇，跑 `npm run e2e:entry`（悬停后按真实时钟比对两帧像素），
 *    或者直接在 GUI 里把鼠标放上去。
 * ⚠️ 无头 Chrome 需要命名管道，必须在 `danger-full-access` 下跑。
 * ⚠️ `src/client/icons.tsx` 是 TSX，不能直接 import —— 这里只用 TypeScript
 *    编译器 API 把它转成 JS（与 build.mjs 同一套配置），不落盘。
 * ⚠️ styles.ts 里的遮罩地址是模板串插值（`url(${WHALE_TAIL_ANIM})`），预览这份
 *    CSS 必须**换成真 data URI**：不换的话浏览器解析不出 url()，
 *    整条 mask 声明作废，图上就只剩一个实心方块。
 * ⚠️ 无头 Chrome 有两个静默陷阱（都踩过）：`--screenshot` 不覆盖已存在的
 *    文件、`file://` 页面会被缓存 —— 所以页面与截图都用带时间戳的新文件名。
 */

import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const args = process.argv.slice(2);
const argOf = (name, fallback) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const OUT = resolve(root, argOf('--out', 'lib/icon-preview.png'));
/** 截图先落到带时间戳的临时名：Chrome 不覆盖已存在的 --screenshot 目标（踩过）。 */
const SHOT = OUT.replace(/\.png$/, `-${String(Date.now())}.png`);

/** 用 TS 编译器把 icons.tsx + whale.ts 转成 CJS，再执行取出 whaleTailHtml 与两个地址。 */
async function loadIcon() {
	const ts = require('typescript');
	const source = await readFile(resolve(root, 'src/client/icons.tsx'), 'utf8');
	// 只取到 whaleTailHtml 为止，把 React 壳与所有 import 切掉 —— 于是预览脚本零
	// 依赖，也不必为了截图去装 react。whale.ts 只有数据，直接拼在同一次转译里。
	const body = source
		.replace(/^import .*$/gm, '')
		.slice(0, source.indexOf('export function WhaleTailIcon'));
	const whale = await readFile(resolve(root, 'src/client/generated/whale.ts'), 'utf8');
	// jsx 目标留在默认值：这一段里没有 JSX，TS 就不会补 require('react/jsx-runtime')
	const js = ts.transpileModule(`${whale}\n${body}`, {
		compilerOptions: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.CommonJS,
		},
	}).outputText;
	const module = { exports: {} };
	// 只喂一个会喊的 require：真冒出 import 就是切错了，别静默
	new Function('module', 'exports', 'require', js)(module, module.exports, (name) => {
		throw new Error(`icons.tsx 里还有运行时 import 没切掉：${name}`);
	});
	return module.exports;
}

/** 一枚带说明的格子。 */
const cell = (html, label, slot = 'width:96px;height:96px') =>
	`<figure><div class="slot" style="${slot}">${html}</div><figcaption>${label}</figcaption></figure>`;

/** 把样式里的 `${CONST}` 换成真 data URI（见文件头那条警告）。 */
const fillIn = (css, constants) =>
	css.replace(/\$\{(\w+)\}/g, (whole, name) => constants[name] ?? whole);

const main = async () => {
	const { whaleTailHtml, ...constants } = await loadIcon();
	const css = await readFile(resolve(root, 'src/client/styles.ts'), 'utf8');
	// 两段要用的规则：鲸鱼尾巴自己那两条（静止 / 动态），以及入口按钮那一整段
	// （预览里放真按钮，好确认边框、热区、悬停态都没跑掉）
	const whaleCss = fillIn(css.slice(css.indexOf('.ffc-whale {'), css.indexOf('.ffc-entry {')), constants);
	const entryCss = fillIn(css.slice(css.indexOf('.ffc-entry {'), css.indexOf('.ffc-badge-btn')), constants);

	const html = `<!doctype html><meta charset="utf-8"><style>
		body { margin: 0; padding: 24px; background: #f7f7f8; color: #1a1a1a;
			font: 12px/1.6 system-ui, sans-serif; }
		figure { margin: 0; text-align: center; }
		.row { display: flex; gap: 28px; align-items: flex-end; }
		.slot { display: flex; align-items: center; justify-content: center;
			background: #fff; border: 1px solid #e5e5e7; border-radius: 10px; }
		figcaption { margin-top: 6px; color: #666; }
		.note { margin-top: 10px; color: #888; }
		.dark { background: #17171a; color: #f2f2f3; padding: 16px; border-radius: 10px; margin-top: 20px; }
		.dark .slot { background: #17171a; border-color: #333; }
		.dark figcaption { color: #999; }
		.hdr { display: flex; align-items: center; gap: 10px; margin-top: 16px; padding: 8px 12px;
			background: #202027; border: 1px solid #333; border-radius: 10px; width: max-content; }
		.hdr span { color: #999; font-size: 11px; }
		.hdr-light { background: #f4f4f6; border-color: #ddd; }
		.hdr-light span { color: #666; }
		${whaleCss}
		${entryCss}
	</style>
	<div class="row">
		${cell(whaleTailHtml({ size: 17 }), '17px 入口（静止）', 'width:64px;height:64px')}
		${cell(whaleTailHtml({ size: 14 }), '14px 工具行（静止）', 'width:56px;height:56px')}
		${cell(whaleTailHtml({ size: 28, generating: true }), '28px 画布「生成中」（动态遮罩，截图只停一帧）', 'width:64px;height:64px')}
		${cell(whaleTailHtml({ size: 96 }), '96px 放大看造型', 'width:120px;height:120px')}
	</div>
	<div class="hdr hdr-light">
		<span>浅色主题 · 入口按钮实景（深色实心压在浅底上，看得见才算数）：</span>
		<button type="button" class="ffc-entry">${whaleTailHtml({ size: 17 })}</button>
		<button type="button" class="ffc-entry">${whaleTailHtml({ size: 17, generating: true })}</button>
	</div>
	<div class="note">颜色一律走 currentColor（跟主题）：上面这排落在浅色底上就是深色，
		下面那排落在深色底上是浅色。静止 = 那条 d <b>填成实心</b>（fill 与描边同色，
		14/17px 下也清晰、满不透明度；空心线稿在浅色主题下几乎看不见）；
		动态 = 原生那 60 帧<b>逐帧填成实心</b>的动画在摇（20fps，一圈 3 秒）。</div>
	<div class="dark">
		<div class="row">
			${cell(whaleTailHtml({ size: 17 }), '深色主题 · 入口（静止）', 'width:64px;height:64px')}
			${cell(whaleTailHtml({ size: 28, generating: true }), '深色主题 · 生成中（动态）', 'width:64px;height:64px')}
			${cell(whaleTailHtml({ size: 48 }), '深色主题 · 48px 放大', 'width:80px;height:80px')}
		</div>
		<div class="hdr">
			<span>入口按钮实景（深色头部条；应无边框、无圆环，32×32 热区里只有一枚鲸鱼尾巴）：</span>
			<button type="button" class="ffc-entry">${whaleTailHtml({ size: 17 })}</button>
			<button type="button" class="ffc-entry">${whaleTailHtml({ size: 17, generating: true })}</button>
			<span>← 右边那枚就是鼠标悬停时的样子（悬停把静止态换成那份实心动画，
				见 styles.ts 的 .ffc-entry:hover 那两条）</span>
		</div>
	</div>`;

	await mkdir(dirname(OUT), { recursive: true });
	const page = resolve(root, `lib/icon-preview-${String(Date.now())}.html`);
	await writeFile(page, html, 'utf8');
	await run(CHROME, [
		'--headless=new',
		'--disable-gpu',
		'--hide-scrollbars',
		'--force-device-scale-factor=2',
		'--window-size=1180,520',
		'--virtual-time-budget=1500',
		`--screenshot=${SHOT}`,
		page,
	]);
	// 再落成固定名字：图是拿来跟人讨论的，路径得稳定
	await copyFile(SHOT, OUT);
	await rm(SHOT, { force: true });
	console.log(`预览图 -> ${OUT}`);
};

// ⚠️ 不能写顶层 await：Node 24 见到「顶层 await + require」会判成歧义模块
// （ERR_AMBIGUOUS_MODULE_SYNTAX）。包一层 async 再调用。
main().catch((error) => {
	console.error(error);
	process.exit(1);
});
