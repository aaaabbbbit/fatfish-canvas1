// 探针表达式：在**聊天模式**（侧边栏展开）下找出设置入口，并把外壳控件列出来。
// 用法：node scripts/probe-gui.mjs --chat --expr-file scripts/probe-shell.js
(async () => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const label = (el) =>
		(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();

	const all = Array.from(document.querySelectorAll('button, a, [role="button"], [role="tab"]'));
	const labels = all
		.map((el, i) => ({ i, tag: el.tagName.toLowerCase(), t: label(el).slice(0, 40) }))
		.filter((x) => x.t !== '');

	// 试试点开设置（多种候选）
	const cands = all.filter((el) => {
		const t = label(el);
		return t === '设置' || t === 'Settings' || t.includes('设置') || t.includes('ettings');
	});
	let clicked = null;
	if (cands.length > 0) {
		clicked = label(cands[0]);
		cands[0].click();
		await sleep(1500);
	}

	// 打开后再看一次导航
	const navAfter = Array.from(
		document.querySelectorAll('[role="tab"], [role="menuitem"], nav button, aside button, li button'),
	)
		.map(label)
		.filter((t) => t !== '')
		.slice(0, 40);

	const cards = document.querySelectorAll('.ffc-set-card');
	return JSON.stringify(
		{
			totalControls: all.length,
			labels: labels.slice(0, 60),
			settingsCandidates: cands.map(label),
			clicked,
			navAfter,
			ffcSetRoots: document.querySelectorAll('.ffc-set').length,
			providerCards: cards.length,
			keyInputs: document.querySelectorAll('.ffc-set-input[type="password"]').length,
			firstCardText: cards[0] ? cards[0].textContent.slice(0, 200) : null,
		},
		null,
		1,
	);
})()
