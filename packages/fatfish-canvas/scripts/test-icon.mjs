/**
 * 鲸鱼尾巴图标的离线检查。
 *
 * 这枚图标**来自** DSH 原生那一份资产（`generated/whale.ts`：静止态那条路径的
 * `d` + 能动时那张 28×28 APNG，都由 `scripts/make-whale.mjs` 从原生客户端产物里
 * 抽 / 推出来），颜色与状态在 icons.tsx / styles.ts。于是会出错的地方只剩三类，全钉在这里：
 *
 *   1. **资产**：路径得像条路径；动图必须**真的动**（有 acTL / fcTL / fdAT）、
 *      必须**真的实心**（每帧覆盖率 >= 30%，线稿只有 24%）；静止态是矢量路径、
 *      **填成实心**（退回 `fill="none"` 就是用户否掉的空心线稿）。
 *   2. **与原生同源**：拿本机原生那段 mask 重新推一遍实心动图，**逐字节比**；
 *      再逐帧比姿态（剪影盖住原生那条线）、节奏（帧数 / 尺寸 / 延时 / 循环次数）。
 *      DSH 换了资产要立刻知道，而不是等肉眼。
 *   3. **标记 + 样式守卫**：颜色一律 currentColor（**写死颜色 = 浅色主题下隐形**，
 *      P38 第一版就是这么栽的）；静止态不许带动图状态，`generating` 才挂
 *      `data-ffc-generating`；动图那枚默认 display:none、两个动态态（生成中 + 入口悬停）
 *      才切成动图、整段关在 no-preference 里。再顺手拦一下上个版本（米饭碗位图）的残留。
 *
 *   node scripts/test-icon.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { decodeApng, encodeApng, solidApng } from './lib/whale-solid.mjs';

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));

let failed = 0;
const check = (name, ok, detail = '') => {
	console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${ok || detail === '' ? '' : ` — ${detail}`}`);
	if (!ok) failed += 1;
};

/** 用 TS 编译器把 icons.tsx + whale.ts 转成 CJS 再执行：不需要 react。 */
function loadIcons() {
	const ts = require('typescript');
	const source = readFileSync(resolve(root, 'src/client/icons.tsx'), 'utf8');
	// `WhaleTailIcon` 那层 React 壳要 react/jsx-runtime（宿主提供，本包不装），
	// 切掉它和所有 import；whale.ts 只有数据，直接拼进来。
	const body = source
		.replace(/^import .*$/gm, '')
		.slice(0, source.indexOf('export function WhaleTailIcon'));
	const whale = readFileSync(resolve(root, 'src/client/generated/whale.ts'), 'utf8');
	const js = ts.transpileModule(`${whale}\n${body}`, {
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
	}).outputText;
	const module = { exports: {} };
	new Function('module', 'exports', js)(module, module.exports);
	return module.exports;
}

const { whaleTailHtml, WHALE_TAIL_PATH, WHALE_TAIL_ANIM } = loadIcons();
const css = readFileSync(resolve(root, 'src/client/styles.ts'), 'utf8');

/** 把 data URI 还原成字节。 */
const bytesOf = (uri) => Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64');

/** 走一遍 PNG 块：返回 `{ type, off, len }`（够这里用了）。 */
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

/** 读 IHDR 的宽 / 高。 */
function sizeOf(buf, ihdr) {
	return `${String(buf.readUInt32BE(ihdr.off + 8))}x${String(buf.readUInt32BE(ihdr.off + 12))}`;
}

/**
 * 取一条规则体。
 *
 * ⚠️ 不能用 `[^}]*` 或 `.*?}` 收尾：规则体里的 `url(${WHALE_TAIL_ANIM})` 自己带一个
 * `}`，会在那里被截断（这里踩过一次）。CSS 的收尾 `}` 独占一行，按行取。
 * ⚠️ 也不能要求选择器后面紧跟 ` {`：两个动态态写在**同一条规则**里（逗号分行），
 * 逗号前面那个选择器后面跟的是换行 + 第二个选择器。
 */
const ruleBody = (selector) => {
	const at = css.indexOf(selector);
	if (at < 0) return null;
	const open = css.indexOf('{', at);
	if (open < 0) return null;
	const close = /\n\s*\}/.exec(css.slice(open));
	return close === null ? null : css.slice(open + 1, open + close.index);
};

console.log('\n肥鱼画布 · 鲸鱼尾巴图标\n');

// ─────────── 静止态：原生那条 d（填成实心） ───────────
{
	check('静止态是矢量路径（不是位图静帧）', /^M[\d.]/.test(WHALE_TAIL_PATH), WHALE_TAIL_PATH.slice(0, 40));
	check('路径里只有路径字符（要塞进单引号字符串）', !/[^\dMLA-Za-z.,\s-]/.test(WHALE_TAIL_PATH));
	check(
		'路径长度像原生的那条（547 字符上下）',
		WHALE_TAIL_PATH.length > 400 && WHALE_TAIL_PATH.length < 2000,
		String(WHALE_TAIL_PATH.length),
	);
}

// ─────────── 动图：必须是**动**的、而且必须是**实心**的 ───────────
{
	check('动图是 PNG data URI（原生就是 APNG）', /^data:image\/png;base64,/.test(WHALE_TAIL_ANIM));
	const apng = bytesOf(WHALE_TAIL_ANIM);
	check('动图是合法 PNG magic', apng.subarray(0, 8).toString('hex') === '89504e470d0a1a0a');
	const chunks = chunksOf(apng);
	const ihdr = chunks.find((c) => c.type === 'IHDR');
	check('动图是 28×28', ihdr !== undefined && sizeOf(apng, ihdr) === '28x28', ihdr === undefined ? '没有 IHDR' : sizeOf(apng, ihdr));
	const actl = chunks.find((c) => c.type === 'acTL');
	const frames = chunks.filter((c) => c.type === 'fcTL').length;
	check('动图带 acTL（是 APNG，不是被抽成了静图）', actl !== undefined);
	check(
		'acTL 声明的帧数与 fcTL 一致（缺帧 = 播到一半断掉）',
		actl !== undefined && actl.len === 8 && apng.readUInt32BE(actl.off + 8) === frames,
		actl === undefined ? '没有 acTL' : `${String(apng.readUInt32BE(actl.off + 8))} vs ${String(frames)}`,
	);
	check('动图带 fdAT（第 1 帧起真的有数据）', chunks.some((c) => c.type === 'fdAT'));
	check('帧数与原生一致（60 帧 / 20fps / 一圈 3 秒）', frames === 60, String(frames));
	check(
		'acTL 的循环次数是 0（无限循环）',
		actl !== undefined && apng.readUInt32BE(actl.off + 12) === 0,
		actl === undefined ? '没有 acTL' : String(apng.readUInt32BE(actl.off + 12)),
	);
	check('动图体积可控（<= 64KB）', apng.length <= 64 * 1024, `${String(Math.round(apng.length / 1024))}KB`);
	// 每一帧都得是**面**，不是线：线稿帧只占 ~24%，填成面之后是 ~35% 往上
	const decoded = decodeApng(apng);
	const coverage = decoded.frames.map((f) => f.alpha.reduce((n, v) => n + (v > 8 ? 1 : 0), 0) / (decoded.w * decoded.h));
	check(
		'每一帧都是实心（覆盖率 >= 30%：退回线稿只有 24% 上下）',
		Math.min(...coverage) >= 0.3,
		`${(Math.min(...coverage) * 100).toFixed(1)}%..${(Math.max(...coverage) * 100).toFixed(1)}%`,
	);
}

// ─────────── 与本机原生产物逐字节相同 ───────────
// 「和原生一致」是这枚图标唯一的验收标准，所以直接对着原生产物比一遍：
// 它一换（DSH 升级），这里立刻红，而不是等肉眼看出「怎么不太一样」。
{
	const chatClient = resolve(
		process.env.APPDATA ?? '',
		'npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js',
	);
	let native = null;
	try {
		native = readFileSync(chatClient, 'utf8');
	} catch {
		console.log('  [SKIP] 本机找不到 dsh-client-ui-chat 产物 —— 跳过「与原生逐字节相同」两条');
	}
	if (native !== null) {
		const nativePath = /const REST_PATH = "([^"]+)"/.exec(native)?.[1];
		const nativeApng = /mask:url\(data:image\/png;base64,([A-Za-z0-9+/=]+)\)/.exec(native)?.[1];
		check('矢量 d 与本机原生的 REST_PATH 逐字节相同', nativePath === WHALE_TAIL_PATH, nativePath === undefined ? '原生里没有 REST_PATH' : '不一致 —— 重跑 npm run art');
		// 动图那半**不是**原件字节（原生是发丝线，我们要实心）：改成「拿原生重新推一遍，
		// 逐字节比」—— 一样能钉住「DSH 换了资产」与「推导过程被人改坏」两件事。
		const derived =
			nativeApng === undefined
				? null
				: encodeApng(solidApng(decodeApng(Buffer.from(nativeApng, 'base64')))).toString('base64');
		check(
			'实心动图 = 拿本机原生那 60 帧重新推一遍（逐字节相同：推导可复现，且跟着原生走）',
			derived !== null && derived === WHALE_TAIL_ANIM.slice(WHALE_TAIL_ANIM.indexOf(',') + 1),
			nativeApng === undefined ? '原生里没有 mask:url' : '不一致 —— 重跑 npm run art',
		);
		// 姿态与节奏必须与原生**逐帧对齐**：帧数 / 尺寸 / 每帧延时 / 循环次数
		const nat = nativeApng === undefined ? null : decodeApng(Buffer.from(nativeApng, 'base64'));
		const ours = decodeApng(bytesOf(WHALE_TAIL_ANIM));
		check(
			'帧数 / 尺寸 / 循环次数与原生一致',
			nat !== null && ours.frames.length === nat.frames.length && ours.w === nat.w && ours.h === nat.h && ours.plays === nat.plays,
			nat === null ? '没有原生' : `${String(ours.frames.length)} vs ${String(nat.frames.length)} 帧`,
		);
		check(
			'每帧延时与原生逐帧相同（节奏不能自己改）',
			nat !== null && ours.frames.every((f, i) => f.delayNum === nat.frames[i].delayNum && f.delayDen === nat.frames[i].delayDen),
			nat === null ? '没有原生' : `${String(ours.frames[0].delayNum)}/${String(ours.frames[0].delayDen)}`,
		);
		// 每一帧的剪影都得**盖住**原生那一帧的线（线是面的边界，漏出去就是填错了帧）
		const covers = nat === null ? [] : ours.frames.map((f, i) => {
			let miss = 0;
			let line = 0;
			for (let k = 0; k < f.alpha.length; k += 1) {
				if (nat.frames[i].alpha[k] > 8) {
					line += 1;
					if (f.alpha[k] <= 8) miss += 1;
				}
			}
			return line === 0 ? 1 : 1 - miss / line;
		});
		check(
			'实心剪影逐帧盖住原生那条线（>= 98%：帧错位 / 填漏都会掉下来）',
			covers.length > 0 && Math.min(...covers) >= 0.98,
			covers.length === 0 ? '没有原生' : `最低 ${(Math.min(...covers) * 100).toFixed(1)}%`,
		);
	}
}

// ─────────── 渲染细节：状态与尺寸都在标记上 ───────────
{
	const idle = whaleTailHtml({ size: 17 });
	check('静止态不带 data-ffc-generating（不生成时不摇）', !idle.includes('data-ffc-generating'));
	check('静止态是 ffc-whale', idle.includes('class="ffc-whale"'), idle.slice(0, 90));
	check('宽高都落到 style 上（图形是方的，给宽不给高会被拉扁）', idle.includes('width:17px') && idle.includes('height:17px'));
	check(
		'静止态里是原生那条 16×16 的矢量路径',
		idle.includes('class="ffc-whale-still"') && idle.includes('viewBox="0 0 16 16"'),
	);
	check('画的是生成出来的那条 d', idle.includes(`d="${WHALE_TAIL_PATH}"`));
	check(
		'静止态是**实心**（fill 与描边同色；fill=none 就退回空心线稿 —— 用户明确要实心）',
		idle.includes('fill="currentColor"') && idle.includes('stroke="currentColor"'),
		idle.slice(0, 200),
	);
	check('动图那枚是个空 span（图形在 CSS 遮罩里）', idle.includes('<span class="ffc-whale-anim"></span>'));
	check('标记里没有任何写死的颜色', !/#[0-9a-fA-F]{3,6}\b|rgb\(/.test(idle));
	check(
		'外层与 SVG 都挂 aria-hidden（装饰图形不进无障碍树，语义由按钮的 aria-label 承担）',
		(idle.match(/aria-hidden="true"/g) ?? []).length === 2,
	);

	const run = whaleTailHtml({ size: 28, generating: true });
	check('生成态带 data-ffc-generating="true"', run.includes('data-ffc-generating="true"'));
	check('生成态尺寸正确', run.includes('width:28px') && run.includes('height:28px'));
	check('额外类名会并进去（预览脚本靠它加边距）', whaleTailHtml({ className: 'x' }).includes('class="ffc-whale x"'));
	check(
		'任何尺寸都指向同一份动画（不再按尺寸分档：动图是 CSS 里的一份资源）',
		whaleTailHtml({ size: 14, generating: true }).includes('data-ffc-generating="true"'),
	);
}

// ─────────── 样式守卫 ───────────
{
	check(
		'styles.ts 只从 generated/whale 取动图那一份（矢量 d 走 icons.tsx）',
		/import \{ WHALE_TAIL_ANIM \} from '\.\/generated\/whale'/.test(css),
	);
	check('样式里引用了动图常量', css.includes('url(${WHALE_TAIL_ANIM})'));
	check(
		'样式里不再有静帧位图（静止态是矢量；位图静帧是 P38 第一版的坑）',
		!css.includes('WHALE_TAIL_STILL'),
	);

	/** 鲸鱼那一整段（到入口按钮为止）—— 「写死颜色」这类回归按段查最省事。 */
	const whaleSection = css.slice(css.indexOf('.ffc-whale {'), css.indexOf('.ffc-entry {'));
	check('鲸鱼那一段里没有写死的白色（浅色主题下会隐形）', !/#fff|#ffffff|rgb\(255/.test(whaleSection), whaleSection.slice(0, 120));
	check('鲸鱼那一段里上色只有 currentColor', /background:\s*currentColor;/.test(whaleSection));

	/** `.ffc-whale` 那条基础规则：只管几何，不碰颜色。 */
	const base = ruleBody('.ffc-whale');
	check('.ffc-whale 基础规则存在', base !== null);
	if (base !== null) {
		check('flex: none（住在 inline-flex 格子里，否则会被压扁）', /flex:\s*none;/.test(base));
		check('position: relative（会摇的那枚绝对定位盖在描边上）', /position:\s*relative;/.test(base));
		check('基础规则里不掺遮罩 / 颜色（那是两个状态各自的事）', !/mask|background/.test(base));
	}

	const still = ruleBody('.ffc-whale-still');
	check('.ffc-whale-still 规则存在（静止态就是它）', still !== null);
	if (still !== null) {
		check('描边那枚是 block 且铺满格子', /display:\s*block;/.test(still) && /width:\s*100%;/.test(still));
	}

	// 摇尾巴整段：必须在 no-preference 里。帧动画（APNG）压不住 duration，
	// 所以减少动效时**压根不能切过去**，而不是切过去再压。
	const noPrefAt = css.indexOf('@media (prefers-reduced-motion: no-preference)');
	check('摇尾巴整段关在 prefers-reduced-motion: no-preference 里', noPrefAt >= 0);
	const wagSection = noPrefAt < 0 ? '' : css.slice(noPrefAt);
	check(
		'动图那枚的样式只出现在这段里（别处出现 = 静止态也会摇）',
		css.slice(0, noPrefAt < 0 ? css.length : noPrefAt).includes('.ffc-whale-anim {') === false,
	);

	const anim = noPrefAt < 0 ? null : ruleBody('.ffc-whale-anim');
	check('.ffc-whale-anim 规则存在', anim !== null);
	if (anim !== null) {
		check('默认 display:none（不生成、不悬停时不摇）', /display:\s*none;/.test(anim));
		check('绝对定位铺满格子（盖在描边上）', /position:\s*absolute;/.test(anim) && /inset:\s*0;/.test(anim));
		check('上色走 currentColor（跟主题）', /background:\s*currentColor;/.test(anim));
		check('遮罩指向动图', anim.includes('url(${WHALE_TAIL_ANIM})'));
		check('-webkit- 前缀与标准属性都写了（Safari 只认前缀）', /-webkit-mask-image:/.test(anim) && /(?<!-webkit-)mask-image:/.test(anim));
		check('遮罩 contain + 居中（28px 的图塞进 14/17px 的格子）', /mask-size:\s*contain;/.test(anim) && /mask-position:\s*center;/.test(anim));
	}

	// 三个动态态：生成中（JS 打点）+ 两处**悬停**（入口按钮、模型选择那枚图标 ——
	// 都是「放上去就动，不用点」）。第三个是 P39 加的，加进来才算真被守卫看着：
	// 只写在样式里而没有守卫的话，下次改触发器很容易把这条又弄丢。
	const wagSelectors = [
		".ffc-whale[data-ffc-generating='true'] .ffc-whale-anim",
		'.ffc-entry:hover .ffc-whale .ffc-whale-anim',
		'.ffc-mp-trigger:hover .ffc-whale .ffc-whale-anim',
	];
	const hideSelectors = [
		".ffc-whale[data-ffc-generating='true'] .ffc-whale-still",
		'.ffc-entry:hover .ffc-whale .ffc-whale-still',
		'.ffc-mp-trigger:hover .ffc-whale .ffc-whale-still',
	];
	const wag = wagSelectors.map((sel) => ruleBody(sel));
	check(
		'每个动态态都把动图那枚打开（display: block）',
		wag.every((body) => body !== null && /display:\s*block;/.test(body)),
		wag.map((b) => (b === null ? '缺规则' : b.trim())).join(' | '),
	);
	const hide = hideSelectors.map((sel) => ruleBody(sel));
	check(
		'每个动态态都把实心那枚藏掉（不藏就重影：动图盖在上面）',
		hide.every((body) => body !== null && /display:\s*none;/.test(body)),
		hide.map((b) => (b === null ? '缺规则' : b.trim())).join(' | '),
	);
	check(
		'这些开关规则逐条都在 no-preference 那段里（不然减少动效时它们照样生效）',
		[...hideSelectors, ...wagSelectors].every((sel) => wagSection.includes(sel)),
	);

	// reduced-motion（reduce）那段不许再碰鲸鱼尾巴：切不切过去由上面那段负责
	const reduced = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
	check('reduce 那段不再重复处理鲸鱼尾巴（处理了说明有两处在切状态）', !/ffc-whale/.test(reduced));

	// 上个版本（米饭碗位图）的残留：这些名字一旦还留在代码里，说明有两套图标在跑
	const leftovers = [
		['styles.ts', css],
		['icons.tsx', readFileSync(resolve(root, 'src/client/icons.tsx'), 'utf8')],
		['EntryButton.tsx', readFileSync(resolve(root, 'src/client/EntryButton.tsx'), 'utf8')],
		['CanvasPanel.tsx', readFileSync(resolve(root, 'src/client/CanvasPanel.tsx'), 'utf8')],
		['MediaToolRow.tsx', readFileSync(resolve(root, 'src/client/toolview/MediaToolRow.tsx'), 'utf8')],
		['NodeCard.tsx', readFileSync(resolve(root, 'src/client/canvas/NodeCard.tsx'), 'utf8')],
	].filter(([, text]) => /RiceBowl|riceBowl|RICE_BOWL|RICE_ANIM|ffc-rice/.test(text));
	check('米饭碗图标没有残留（旧图标不该还有第二套在跑）', leftovers.length === 0, leftovers.map(([f]) => f).join(' '));

	// ── 圆角与过渡时长的「别写裸值」守卫（P34 把全站这两类收进 token 之后补的）──
	//
	// 为什么值得做成守卫：裸值**不报错、不变色**，只会让插件的控件比本体
	// 「方一点 / 黏一点」—— 人眼很难指认，所以人也不会去修（P34 之前有 15 处
	// 裸圆角：10 / 9 / 7 / 6px，本体那一阶是 8 / 12 / 16 / 20）。散文拦不住复发。
	//
	// 判据跑在**去掉注释后**的正文上，免得注释里的举例把守卫绊红。
	const cssBody = css.slice(css.indexOf('export const CSS = `') + 'export const CSS = `'.length, css.lastIndexOf('`'));
	const cssRules = cssBody.replace(/\/\*[\s\S]*?\*\//g, '');

	// 圆角一律走 --ffc-r-*（照搬本体 --dsw-radius-*）。例外都不是「控件 / 卡片」
	// 语义，而是三类：真圆、框选矩形那 2px，以及两处**必须与本体逐字相同**的
	// 照抄值（用户气泡 22px = UserStyleBubble、消息图标按钮 28px = MessageIconActions）。
	// 那两处改成本地阶就不再「跟本体一模一样」了，所以它们是例外而不是债。
	const RADIUS_OK = new Set(['50%', '2px', '22px', '28px']);
	const bareRadii = [...cssRules.matchAll(/border-radius:\s*([^;]+);/g)]
		.map((m) => m[1].trim())
		.filter((v) => !v.startsWith('var(--ffc-r-') && !RADIUS_OK.has(v));
	check(
		'圆角一律走 --ffc-r-* 阶（裸 px 会与本体那阶悄悄错开）',
		bareRadii.length === 0,
		bareRadii.join(' | '),
	);

	// 过渡时长一律走 --ffc-transition / --ffc-transition-fast：文件末尾那条
	// prefers-reduced-motion 只压这两个变量，凡是写死时长的地方它都盖不住。
	// 例外：世界层与点阵的程序化移动（240ms，与 JS 那边的动画时长配对，
	// 且它自己有一条 @media 把它关成 none），以及显式的 `none` 本身。
	//
	// ⚠️ 模式必须带 (?<![\w-])：否则 `--ffc-transition:` 这条**变量声明**自己
	// 也会被 `transition:` 匹配上（它的尾巴就是 transition:），守卫会假红。
	const bareTransitions = [...cssRules.matchAll(/(?<![\w-])transition:\s*([^;]+);/g)]
		.map((m) => m[1].trim())
		.filter((v) => v !== 'none' && !v.includes('var(--ffc-transition') && !v.includes('240ms'));
	check(
		'过渡时长一律走 --ffc-transition*（否则 reduced-motion 盖不住它）',
		bareTransitions.length === 0,
		bareTransitions.join(' | '),
	);

	// 动画名与 @keyframes 必须对得上：**名字写错是不报错的**，元素就那么硬切出来，
	// 唯一的线索是「这段动画好像没生效」—— 人不会去查，所以守卫来点名。
	// 两个方向都查：引用的名字必须存在，存在的关键帧也必须有人用（死帧 = 债）。
	// reduced-motion 里那句 `animation: none` 被下面的过滤器排除掉。
	const animations = [...cssRules.matchAll(/(?<![\w-])animation:\s*([^;]+);/g)]
		.map((m) => m[1].trim())
		.filter((v) => v !== 'none');
	const keyframes = [...cssRules.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]);
	const danglingAnimations = animations.filter((v) => !keyframes.some((n) => v.includes(n)));
	check(
		'animation 引用的关键帧都存在（名字打错是静默失效）',
		danglingAnimations.length === 0,
		danglingAnimations.join(' | '),
	);
	const unusedKeyframes = keyframes.filter((n) => !new RegExp(`animation:[^;]*${n}`).test(cssRules));
	check('没有没人用的 @keyframes', unusedKeyframes.length === 0, unusedKeyframes.join(' | '));

	// 反引号会提前结束 styles.ts 的模板串（NOTES §8.12）：只看模板串**里面**
	// 有没有，别把开头那个定界符自己数进去
	check('样式表模板串里没有反引号', !cssBody.includes('`'));
}

console.log(failed === 0 ? '\n全部通过 ✅\n' : `\n失败 ${String(failed)} 项 ❌\n`);
process.exit(failed === 0 ? 0 : 1);
