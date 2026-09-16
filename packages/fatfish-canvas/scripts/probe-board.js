/**
 * 探针：探针 profile 里那块画布到底是什么内容（节点 id + 落图账本）。
 *
 * 用途：查「某个 e2e 数到的节点比种下的多」这类污染 —— 到底是
 *   ① 种子写坏了（seed 变成字符串 → store 回退空画布，另一种症状），还是
 *   ② 账本里没有这些 id，于是「最近结果补落」把它们又造了回来。
 *
 * 用法：node scripts/probe-gui.mjs --json lib/probe-board.json --expr-file scripts/probe-board.js
 */
(() => {
	const read = (key) => {
		try {
			return JSON.parse(window.localStorage.getItem(key) || 'null');
		} catch (error) {
			return { __parseError: String(error) };
		}
	};
	const board = read('fatfish-canvas:board');
	return JSON.stringify(
		{
			mode: document.body.dataset.ffcMode ?? null,
			renderedNodeIds: Array.from(document.querySelectorAll('.ffc-node')).map((n) => n.dataset.nodeId),
			boardType: typeof board,
			isArray: Array.isArray(board),
			keys: board !== null && typeof board === 'object' ? Object.keys(board) : null,
			nodeIds: board !== null && Array.isArray(board.nodes) ? board.nodes.map((n) => n.id) : null,
			ingested: board !== null && Array.isArray(board.ingested) ? board.ingested : null,
			allBoardKeys: Object.keys(window.localStorage).filter((k) => k.indexOf('fatfish-canvas') === 0).sort(),
		},
		null,
		1,
	);
})();
