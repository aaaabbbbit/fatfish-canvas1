/**
 * 诊断：设置页分节「导航里有、点开后却是空的」。
 *
 * 症状：`e2e-settings.mjs` 走到 `section-missing` —— 说明
 *   ① 入口注册成功（导航里有「图像 / 视频模型」这一项，否则会是 `no-section-nav`）
 *   ② 但点开之后 `.ffc-set` 一个都没渲染出来
 * 这两种事实并存，几乎只有一种解释：**分节组件在渲染期抛错**（React 会把整棵子树
 * 丢掉，页面上什么都不剩，而导航项仍然在）。因此本探针的重点是**抓浏览器异常**
 * （`Runtime.exceptionThrown`）与控制台错误，而不是继续猜。
 *
 * 顺带把可能的原因也量出来：
 *   - 客户端半边到底有没有装上（**有当前会话时**右上角 `.ffc-entry` 在不在 ——
 *     P10 起入口住在会话头部右侧的 utilities 席位里，没有会话就没有那一行）
 *   - 设置容器里剩下什么（innerHTML 长度、可见文本）
 *   - 我们注册的那个分节的 id 有没有出现在导航里
 *
 * 用法：node scripts/probe-gui.mjs --chat --expr-file scripts/probe-settings-p9.js --json lib/probe-settings-p9.json
 * （异常捕获另见 scripts/probe-settings-error.mjs：probe-gui 只求值一次，抓不到事件流）
 */
(async () => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const label = (el) =>
		(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();

	const before = {
		entryButton: document.querySelector('.ffc-entry') !== null,
		panel: document.querySelector('.ffc-panel') !== null,
		mode: document.body.dataset.ffcMode ?? null,
	};

	// 1) 打开设置
	const trigger = Array.from(document.querySelectorAll('button, a, [role="button"]')).find(
		(el) => label(el) === '设置' || label(el) === 'Settings',
	);
	if (trigger === undefined) return JSON.stringify({ error: 'no-settings-trigger', before });
	trigger.click();
	await sleep(1800);

	const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [class*="settings"], [class*="Settings"]'));
	const navLabels = Array.from(document.querySelectorAll('button, a, [role="tab"], [role="menuitem"], li'))
		.map((el) => label(el))
		.filter((text) => text !== '' && text.length < 30);
	const nav = Array.from(document.querySelectorAll('button, a, [role="tab"], [role="menuitem"], li')).find(
		(el) => label(el) === '图像 / 视频模型',
	);
	if (nav === undefined) {
		return JSON.stringify({ error: 'no-section-nav', before, navLabels: navLabels.slice(0, 40) }, null, 1);
	}
	nav.click();
	await sleep(2000);

	// 2) 分节容器
	const containers = Array.from(document.querySelectorAll('[role="dialog"], main, [class*="section"]'));
	const withContent = containers
		.map((el) => ({
			cls: String(el.className || '').slice(0, 50),
			len: (el.textContent || '').trim().length,
			text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
		}))
		.filter((entry) => entry.len > 0)
		.slice(0, 12);

	return JSON.stringify(
		{
			before,
			navFound: true,
			sectionRoot: document.querySelector('.ffc-set') !== null,
			setStatus: document.querySelector('.ffc-set-status')?.textContent ?? null,
			setIntro: document.querySelector('.ffc-set-intro')?.textContent?.slice(0, 80) ?? null,
			anyFfcInSettings: Array.from(document.querySelectorAll('[class*="ffc-"]')).length,
			containers: withContent,
			navLabels: navLabels.slice(0, 40),
		},
		null,
		1,
	);
})();
