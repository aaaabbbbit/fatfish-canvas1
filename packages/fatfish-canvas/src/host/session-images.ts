/**
 * 从会话里找出「用户在这一回合附的图片」（宿主半边）。
 *
 * ## 为什么需要它
 *
 * 文本模型对图片附件只会收到一行 `[image omitted because this model accepts text
 * only; attachment sha256:xxxxxxxx]` —— **没有路径**（见 dsh-llm 的
 * `textOnlyImageText`）。于是「用户贴了图 + 让模型基于它生成」这条路里，模型手上
 * 只有一个 8 位摘要，它**没法**把图交给生成 API，我们也**不能**指望它编出一个地址。
 *
 * 解法不是改平台，而是让工具自己去会话里把那张图捞出来：会话日志里图片是
 * **持久附件引用**（`{ type:'image', attachment: { attachmentId, mediaType, bytes, … } }`），
 * 宿主拿它去 `ctx.attachments.readImage()` 就能取到字节。模型全程不需要看见任何像素。
 *
 * ## 两条边界
 *
 * 1. **只认顶层的图片块**。`tool-result` 里嵌套的图是别的工具产出的，不是用户附的；
 *    顶层的 `image` 块只可能来自用户上传。
 * 2. **只认本回合**。往回走到最近的 `turn/start` 就停 —— 上一轮附的图不该被当成本次
 *    的参考图（「用户贴图问完，下一轮让画点无关的东西」时，静默套用旧图就是错的结果）。
 *
 * @module fatfish-canvas/host/session-images
 */

import type { MediaAttachmentRef } from './reference';

/** 会话里本模块用到的那一面（`dsh-session` 的 `Session`）。 */
export interface SessionLike {
	/**
	 * 追加日志的不可变快照。
	 * @returns 事件数组（老的在前）。
	 */
	snapshotEvents(): readonly { type?: string; data?: unknown }[];
	/**
	 * 最近一次请求的路由元数据（`request/context` 事件折叠而来）。
	 * @returns 供应商与模型 id；还没有过请求时为 undefined。
	 */
	requestContext?(): { provider?: string; model?: string } | undefined;
}

/**
 * 从一条消息的 `content` 里取第一张顶层图片的引用。
 * @param data - 事件负载（`user/message` 的 `UserMessage`）。
 * @returns 图片引用；没有顶层图片时 undefined。
 */
function imageRefOf(data: unknown): MediaAttachmentRef | undefined {
	if (data === null || typeof data !== 'object') return undefined;
	const content = (data as { content?: unknown }).content;
	if (!Array.isArray(content)) return undefined;
	for (const block of content) {
		if (block === null || typeof block !== 'object') continue;
		const typed = block as { type?: unknown; attachment?: unknown };
		if (typed.type !== 'image') continue;
		const ref = typed.attachment as MediaAttachmentRef | undefined;
		if (ref !== undefined && typeof ref.attachmentId === 'string' && ref.attachmentId !== '') return ref;
	}
	return undefined;
}

/**
 * 用户**在这一回合**附的最新一张图片。
 *
 * 从日志末尾往回走：遇到 `turn/start` 说明已经走出本回合 → 没有；遇到带顶层图片的
 * `user/message` → 就是它。工具结果那些 `tool/result` 事件天然被跳过（没有顶层图片块）。
 * @param session - 会话面（缺席时返回 undefined）。
 * @returns 图片的持久附件引用；没有时 undefined。
 */
export function attachedImageRef(session: SessionLike | undefined): MediaAttachmentRef | undefined {
	if (session === undefined || typeof session.snapshotEvents !== 'function') return undefined;
	const events = session.snapshotEvents();
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event === undefined) continue;
		if (event.type === 'turn/start') return undefined;
		if (event.type !== 'user/message') continue;
		const ref = imageRefOf(event.data);
		if (ref !== undefined) return ref;
	}
	return undefined;
}
