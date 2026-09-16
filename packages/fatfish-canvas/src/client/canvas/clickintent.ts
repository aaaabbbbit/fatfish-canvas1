/**
 * 「点画布上的图片时，用户到底想干什么」—— 一处判据，可离线测。
 *
 * 画布上的单击有两种截然不同的意图，靠**聊天输入框有没有焦点**区分：
 *
 *   光标在输入框里（正在打字）  → 用户想把这张图**引用到对话里**（插入地址）
 *   其它情况                    → 常规语义：选中 / 拖动这个节点
 *
 * 为什么判据不放在组件里：这是本轮最容易写反的一条规则（写反了就是「想拖节点
 * 却被塞了一行地址」），而组件里的分支要起浏览器才能验。抽成纯函数之后，
 * `test-model.mjs` 用真值表把它钉死。
 *
 * @module fatfish-canvas/client/canvas/clickintent
 */

/** 一次节点单击要做的事。 */
export type NodeClickIntent =
	/** 把媒体地址插入聊天输入框。 */
	| { kind: 'send-to-composer' }
	/** 常规：选中并允许拖动。 */
	| { kind: 'select' };

/**
 * 判断这次节点单击的意图。
 * @param options - `mediaUrl`：节点有没有可用的媒体地址（没有就无从「发送」）；
 *   `composerFocused`：点击发生时聊天输入框是否持有焦点。
 * @returns 意图。
 */
export function nodeClickIntent(options: {
	mediaUrl: string | null;
	composerFocused: boolean;
}): NodeClickIntent {
	// 没有地址（pending / failed / 文字节点）时「发送」无从谈起 —— 退回常规选中，
	// 否则用户点了半天什么也没发生。
	if (options.mediaUrl === null || options.mediaUrl === '') return { kind: 'select' };
	return options.composerFocused ? { kind: 'send-to-composer' } : { kind: 'select' };
}
