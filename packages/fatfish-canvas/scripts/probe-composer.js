/**
 * 探针表达式：找出「输入框」与「侧边栏会话行」的真实 DOM 形状。
 *
 * 用途：P3 的 e2e 需要在**探针浏览器自己的会话**里发一条提示词，
 * 从而让生成在探针眼皮底下发生（pending → 终态的迁移只有这样才能观察到）。
 * 与其猜输入框是 textarea 还是 contenteditable，不如直接问页面。
 *
 * 用法：node scripts/probe-gui.mjs --expr-file scripts/probe-composer.js
 */
(() => {
	const qa = (s) => Array.from(document.querySelectorAll(s));
	const rect = (el) => {
		const r = el.getBoundingClientRect();
		return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
	};
	const describe = (el) => ({
		tag: el.tagName.toLowerCase(),
		cls: typeof el.className === 'string' ? el.className : '',
		role: el.getAttribute('role'),
		aria: el.getAttribute('aria-label'),
		placeholder: el.getAttribute('placeholder') ?? el.getAttribute('data-placeholder'),
		editable: el.getAttribute('contenteditable'),
		rect: rect(el),
		text: (el.textContent || '').trim().slice(0, 40),
	});

	const buttons = qa('button').map((b) => ({
		label: (b.getAttribute('aria-label') ?? b.textContent ?? '').trim().slice(0, 24),
		title: b.getAttribute('title'),
		rect: rect(b),
	}));

	return JSON.stringify(
		{
			inputs: qa('input, textarea, [contenteditable="true"]').map(describe),
			editables: qa('[contenteditable]').length,
			sendishButtons: buttons.filter((b) => /发送|send/i.test(`${String(b.label)} ${String(b.title)}`)),
			firstButtons: buttons.slice(0, 14),
			// 会话行的可达标识（e2e 需要点中目标会话时用）
			sidebarItems: qa('[role="option"], [role="listitem"], [data-session-id]').slice(0, 12).map((el) => ({
				role: el.getAttribute('role'),
				sessionId: el.getAttribute('data-session-id'),
				text: (el.textContent || '').trim().slice(0, 40),
				rect: rect(el),
			})),
			seed: (() => {
				try {
					return window.localStorage.getItem('dsh.sessions.current');
				} catch (error) {
					return String(error);
				}
			})(),
			url: location.href,
		},
		null,
		1,
	);
})();
