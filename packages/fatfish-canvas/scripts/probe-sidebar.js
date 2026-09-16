/**
 * 探针：侧边栏里的「会话行」到底是哪个元素？（怎么在无头浏览器里打开一个真实会话）
 *
 * 为什么需要：会话头部的 Session utilities 席位
 * （`conversation.session.header.utilities`，P10 的入口按钮就住在那里，与 session log
 * 同一行）是**会话作用域**席位 —— 没有当前会话时整块不渲染。所以任何要量入口按钮或
 * session log 的 e2e/probe 都必须先真的打开一个会话。
 *
 * 上一次尝试用 `button, a, [role=button]` + 类名含 `session` 去找，只命中了一个
 * 「展开其余 N 个会话」按钮 —— 会话行本身要么是虚拟列表里的 div，要么类名里
 * 没有 session。这个探针把侧边栏的候选元素整个列出来，好挑出稳定的选择器。
 *
 * 用法：node scripts/probe-gui.mjs --chat --expr-file scripts/probe-sidebar.js --json lib/probe-sidebar.json
 */
(() => {
	const qa = (s) => Array.from(document.querySelectorAll(s));
	const rect = (el) => {
		const r = el.getBoundingClientRect();
		return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
	};
	const cls = (el) => (typeof el.className === 'string' ? el.className.trim() : '');
	const text = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 70);

	const frame = document.querySelector('[data-ffc-frame]');
	const sidebar = frame?.children?.[0] ?? null;
	const sidebarRect = sidebar ? rect(sidebar) : null;

	/** 侧边栏里所有「类名含 session（不分大小写）」的元素。 */
	const byClass = qa('*')
		.filter((el) => /session/i.test(cls(el)))
		.filter((el) => {
			const r = rect(el);
			return r.w > 40 && r.h > 8 && r.x < 320;
		})
		.map((el) => ({
			tag: el.tagName.toLowerCase(),
			cls: cls(el).slice(0, 60),
			role: el.getAttribute('role'),
			text: text(el),
			rect: rect(el),
			childCount: el.children.length,
		}))
		.slice(0, 25);

	/** 侧边栏里所有「可点」（有 tabindex / role / 是 button|a）且带文案的元素。 */
	const clickish = qa('button, a, [role="button"], [role="option"], [role="treeitem"], [tabindex]')
		.filter((el) => {
			const r = rect(el);
			return r.x < 320 && r.w > 40 && r.h > 12 && r.h < 80 && text(el) !== '';
		})
		.map((el) => ({
			tag: el.tagName.toLowerCase(),
			cls: cls(el).slice(0, 60),
			role: el.getAttribute('role'),
			text: text(el),
			rect: rect(el),
		}))
		.slice(0, 30);

	return JSON.stringify(
		{
			mode: document.body.dataset.ffcMode ?? null,
			viewport: { w: window.innerWidth, h: window.innerHeight },
			sidebarRect,
			sidebarChildClasses: Array.from(sidebar?.children ?? []).map((el) => cls(el).slice(0, 50)),
			byClassCount: byClass.length,
			byClass,
			clickishCount: clickish.length,
			clickish,
			hasEntryButton: document.querySelector('.ffc-entry') !== null,
			hasComposer: document.querySelector('textarea') !== null,
		},
		null,
		1,
	);
})();
