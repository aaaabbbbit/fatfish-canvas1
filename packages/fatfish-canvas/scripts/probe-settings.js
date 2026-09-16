// 探针表达式：打开设置 → 点开「图像 / 视频模型」→ 断言页面内容真的渲染。
// 用法：node scripts/probe-gui.mjs --chat --expr-file scripts/probe-settings.js
(async () => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const label = (el) =>
		(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();

	// 1) 打开设置
	const triggers = Array.from(document.querySelectorAll('button, a, [role="button"]'));
	const settingsBtn = triggers.find((el) => label(el) === '设置' || label(el) === 'Settings');
	if (settingsBtn === undefined) return JSON.stringify({ error: '未找到设置入口' });
	settingsBtn.click();
	await sleep(1500);

	// 2) 点开本插件的分节
	const navs = Array.from(document.querySelectorAll('button, a, [role="tab"], [role="menuitem"], li'));
	const mine = navs.find((el) => label(el) === '图像 / 视频模型');
	if (mine === undefined) {
		return JSON.stringify({ error: '导航里没有本插件的分节' });
	}
	mine.click();
	await sleep(1500);

	// 3) 断言页面内容
	const root = document.querySelector('.ffc-set');
	const cards = Array.from(document.querySelectorAll('.ffc-set-card'));
	const keyInputs = Array.from(document.querySelectorAll('.ffc-set-input[type="password"]'));
	const selects = Array.from(document.querySelectorAll('.ffc-set-input'));
	const status = document.querySelector('.ffc-set-status');
	const intro = document.querySelector('.ffc-set-intro');

	return JSON.stringify(
		{
			sectionOpened: root !== null,
			providerCards: cards.length,
			keyInputs: keyInputs.length,
			inputs: selects.length,
			labels: cards.map((c) => (c.querySelector('.ffc-set-title')?.textContent ?? '').trim()),
			introText: intro ? intro.textContent.slice(0, 120) : null,
			statusText: status ? status.textContent.slice(0, 120) : null,
			keyPlaceholders: keyInputs.map((i) => i.getAttribute('placeholder')).slice(0, 3),
			clearButtons: document.querySelectorAll('.ffc-set-clear').length,
			// 页面整体可见性（元素有尺寸才算真的渲染）
			rootSize: root
				? { w: Math.round(root.getBoundingClientRect().width), h: Math.round(root.getBoundingClientRect().height) }
				: null,
		},
		null,
		1,
	);
})()
