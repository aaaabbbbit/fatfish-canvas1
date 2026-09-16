/**
 * 探针：两套主题下的关键设计 token 实际取值。
 *
 * P5 的对比度复查发现「画布节点悬浮条」的文字在深色下几乎与背景同色。在动手改
 * 样式之前，先把用到的几个 token 在两个主题下的**真实取值**打出来 ——
 * `label-primary-inverted` 到底是「恒为白」还是「主色的反色」，决定了修法。
 *
 * 用法：node scripts/probe-gui.mjs --expr-file scripts/probe-tokens.js
 */
(() => {
	const NAMES = [
		'--dsw-alias-bg-base',
		'--dsw-alias-bg-layer-1',
		'--dsw-alias-bg-layer-2',
		'--dsw-alias-bg-layer-3',
		'--dsw-alias-label-primary',
		'--dsw-alias-label-secondary',
		'--dsw-alias-label-tertiary',
		'--dsw-alias-label-dimmed',
		'--dsw-alias-label-primary-inverted',
		'--dsw-alias-bg-mask-1',
		'--dsw-alias-bg-mask-2',
		'--dsw-alias-bg-mask-photo',
		'--dsw-alias-state-error-primary',
		'--dsw-alias-interactive-bg-hover-danger',
		'--dsw-alias-border-l1',
		'--dsw-alias-border-l2',
	];

	const read = () => {
		const cs = getComputedStyle(document.body);
		return Object.fromEntries(NAMES.map((n) => [n, cs.getPropertyValue(n).trim()]));
	};

	const dark = read();
	document.body.removeAttribute('data-ds-dark-theme');
	const light = read();
	document.body.setAttribute('data-ds-dark-theme', '');

	// 顺便把「错误色系」里所有可用的 token 都列出来，便于挑一个对比度够的
	const errorish = Object.keys(document.body.computedStyleMap ? {} : {});

	return JSON.stringify({ dark, light, errorish }, null, 1);
})();
