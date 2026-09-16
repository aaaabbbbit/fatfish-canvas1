/**
 * 诊断：设置页分节渲染期抛的错到底是什么（抓浏览器异常流）。
 *
 * `probe-gui.mjs` 只求值一次表达式，抓不到**事件**。分节「导航里有、点开是空的」
 * 几乎一定是组件在渲染期抛错被 React 丢掉，而错误本身只在
 * `Runtime.exceptionThrown` / 控制台里出现 —— 因此这个脚本自己驱动 CDP：
 * 订上异常与控制台事件，再打开设置、点开分节，最后把抓到的原始错误打出来。
 *
 * 用法（需放宽沙箱）：
 *   node scripts/probe-settings-error.mjs
 */

import { launch, sleep } from './lib/cdp.mjs';

const URL_TARGET = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080/';

const browser = await launch();
const { cdp } = browser;

/** 抓到的异常与控制台输出。 */
const exceptions = [];
const consoleMessages = [];

cdp.on('Runtime.exceptionThrown', (params) => {
	const d = params?.exceptionDetails;
	exceptions.push({
		text: d?.exception?.description ?? d?.text ?? '(no description)',
		url: d?.url ?? null,
		line: d?.lineNumber ?? null,
	});
});
cdp.on('Runtime.consoleAPICalled', (params) => {
	consoleMessages.push({
		type: params?.type,
		text: (params?.args ?? [])
			.map((arg) => arg?.description ?? arg?.value ?? '')
			.join(' ')
			.slice(0, 400),
	});
});

/** 在页面里求值。 */
async function evaluate(expression) {
	const result = await cdp.send('Runtime.evaluate', {
		expression,
		returnByValue: true,
		awaitPromise: true,
	});
	if (result.exceptionDetails !== undefined) {
		return { __error: result.exceptionDetails.exception?.description ?? 'evaluate failed' };
	}
	return result.result?.value;
}

console.log(`\n诊断：设置页分节为什么是空的\n目标：${URL_TARGET}\n`);

try {
	// 聊天模式（设置入口要在侧边栏里）
	let loaded = cdp.once('Page.loadEventFired');
	await cdp.send('Page.navigate', { url: URL_TARGET });
	await loaded;
	await evaluate(
		`(() => { window.localStorage.setItem('fatfish-canvas:view-mode','chat'); window.localStorage.removeItem('fatfish-canvas:board-scope'); return true; })()`,
	);
	loaded = cdp.once('Page.loadEventFired');
	await cdp.send('Page.reload', { ignoreCache: false });
	await loaded;
	await sleep(9000);

	console.log(
		'客户端半边是否装上（有当前会话时右上角应有入口按钮）：',
		await evaluate(`document.querySelector('.ffc-entry') !== null`),
	);

	// 打开设置
	await evaluate(
		`(() => {
			const label = (el) => (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();
			const t = Array.from(document.querySelectorAll('button, a, [role="button"]')).find((el) => label(el) === '设置' || label(el) === 'Settings');
			if (t) t.click();
			return t !== undefined;
		})()`,
	);
	await sleep(2000);

	// 点开本插件的分节
	const clicked = await evaluate(
		`(() => {
			const label = (el) => (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();
			const nav = Array.from(document.querySelectorAll('button, a, [role="tab"], [role="menuitem"], li')).find((el) => label(el) === '图像 / 视频模型');
			if (!nav) return false;
			nav.click();
			return true;
		})()`,
	);
	console.log('找到并点了分节导航项：', clicked);
	await sleep(2500);

	console.log(
		'分节是否渲染出内容：',
		await evaluate(`document.querySelector('.ffc-set') !== null`),
	);
} catch (error) {
	console.log('脚本失败：', error instanceof Error ? error.message : String(error));
} finally {
	await browser.close();
}

console.log('\n===== 浏览器异常 =====');
if (exceptions.length === 0) console.log('（没有）');
for (const entry of exceptions) {
	console.log(`- ${entry.text}`);
	if (entry.url !== null) console.log(`  at ${entry.url}:${String(entry.line)}`);
}

console.log('\n===== 控制台输出（只留 error/warning）=====');
const noisy = consoleMessages.filter((m) => m.type === 'error' || m.type === 'warning');
if (noisy.length === 0) console.log('（没有）');
for (const entry of noisy.slice(0, 20)) console.log(`[${String(entry.type)}] ${entry.text}`);
