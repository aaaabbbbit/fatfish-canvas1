/**
 * 探针：纯画布模式下 AppFrame 为什么没有真的收起。
 *
 * 需要回答两件事：
 *   1. frame 的 `display` 是**内联样式**（inline style 优先级高于普通选择器）还是 CSS 规则？
 *   2. 我们那条 `body[data-ffc-mode='canvas-only'] [data-ffc-frame] { display: none }`
 *      到底有没有匹配上（用 position 是否变成 fixed 来交叉验证）。
 *
 * P10 起纯画布是画布顶栏上**独立的一个按钮**（原来的「视图」菜单已整块移除），
 * 因此这里直接点那个按钮，不再走菜单。
 *
 * 用法：node scripts/probe-gui.mjs --expr-file scripts/probe-frame.js
 */
(async () => {
	const wait = (ms) => new Promise((r) => setTimeout(r, ms));
	const onlyBtn = () => document.querySelector('.ffc-toolbar button[aria-label="纯画布模式"]');
	const rect = (el) => {
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
	};
	const snap = (tag) => {
		const f = document.querySelector('[data-ffc-frame]');
		const cs = f ? getComputedStyle(f) : null;
		return {
			tag,
			mode: document.body.dataset.ffcMode ?? null,
			frameClass: f ? f.className : null,
			inlineStyle: f ? f.getAttribute('style') : null,
			display: cs ? cs.display : null,
			position: cs ? cs.position : null,
			left: cs ? cs.left : null,
			rect: rect(f),
			onlyPressed: onlyBtn()?.getAttribute('aria-pressed') ?? null,
		};
	};

	const out = [snap('初始')];

	// 点一次 = 进纯画布
	onlyBtn()?.click();
	await wait(500);
	out.push(snap('纯画布模式'));

	// 反面验证：再点一次回到并排，position 必须变成 fixed（证明选择器确实命中 frame）
	onlyBtn()?.click();
	await wait(500);
	out.push(snap('并排模式'));

	return JSON.stringify(
		{
			steps: out,
			bodyMode: document.body.dataset.ffcMode,
			rootVar: document.documentElement.style.getPropertyValue('--ffc-canvas-width'),
		},
		null,
		1,
	);
})();
