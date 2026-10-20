/**
 * 用户消息的**影子渲染器**：本体那条气泡 + 一个「复制（含图）」按钮。
 *
 * ## 为什么要顶替整条消息
 *
 * 平台没有「用户消息操作」席位（`conversation.chat.assistant-actions` 只给
 * assistant 的回合尾），而插槽注册表**按 priority 升序取第一个同 key 的条目**
 * —— 因此用 `priority: -1` 注册 `conversation.chat.node` 的 `user` 键，
 * 就顶替了 ui-chat 自己的 `UserMessageNodeView`（注册表的报错文案原话：
 * `register at a different priority to shadow it (lowest renders)`）。
 *
 * 代价与边界（接手时先看这三条）：
 *
 *   1. **图片仍然用本体的渲染器**：props 里的 `renderMessageImages` 就是
 *      ui-chat 传给本体气泡的同一个函数（`conversation.message.images` 席位 →
 *      ui-attachment 的图片组 + 大图预览）。因此这里**不重写图片**，只加按钮。
 *   2. **样式是自己的一套**（`.ffc-msg-*`，见 styles.ts）：本体的 CSS 类是
 *      哈希类名，插件拿不到。用的是同一批 DSH 变量，所以观感接近，但**不是像素级相同**。
 *   3. **本体以后给用户消息加的东西**（新的装饰行、新的块类型）不会自动出现在这里。
 *      兜底策略是「不静默丢」：不认识的块渲染成一段 JSON。
 *
 * @module fatfish-canvas/client/chat/UserMessageCopy
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { IconCheckOutlineRegular, IconCopyOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import { SendToComposerIcon } from '../icons';
import {
	copyMessageWithImages,
	copyPartsOf,
	sendMessageToComposerOutcome,
	type CopyOutcome,
	type ImageLoader,
	type MessageAttachment,
} from './messageCopy';

/** 会话节点里本组件读取的那一面。 */
interface UserMessageNodeLike {
	/** 消息负载。 */
	data?: {
		/** 内容块。 */
		content?: unknown;
		/** 事件时间戳（毫秒）。 */
		time?: number;
		/** 引用标签（本体的引用小结行）。 */
		referenceLabels?: readonly string[];
		/** 技能名（本体的技能小结行）。 */
		skillNames?: readonly string[];
	};
}

/** 本体 `renderMessageImages` 的入参（只用到这三个字段）。 */
interface MessageImagesOwner {
	images: { attachment: MessageAttachment }[];
	align?: string;
	compact?: boolean;
}

/** 两个按钮：富文本复制 / 送到输入框。 */
type CopyKind = 'rich' | 'compose';

/** 影子渲染器收到的 owner 面（只声明用到的字段）。 */
interface UserMessageProps {
	/** 会话节点。 */
	node?: UserMessageNodeLike;
	/** 附件 → 显示地址（本体注入）。 */
	loadImage?: ImageLoader;
	/** 本体的图片组渲染（含大图预览）。 */
	renderMessageImages?: (owner: MessageImagesOwner) => ReactNode;
}

/**
 * 把时间戳格式化成 `18:08`。
 * @param time - 毫秒时间戳；缺席时返回空串。
 * @returns 时刻文本。
 */
function clockOf(time: number | undefined): string {
	if (time === undefined || !Number.isFinite(time) || time <= 0) return '';
	const at = new Date(time);
	const hh = String(at.getHours()).padStart(2, '0');
	const mm = String(at.getMinutes()).padStart(2, '0');
	return `${hh}:${mm}`;
}

/**
 * 用户消息（影子席位）。
 *
 * 两个按钮而不是一个，因为「拿去用」有两种去处（详见 `messageCopy.ts` 文件头）：
 *   - **复制（含图）** → 富文本剪贴板，给微信 / 飞书 / 文档（已实测可用）；
 *   - **送到输入框** → 文字插进聊天输入框 + 每张图变成真附件，**给 DSH 自己用**。
 *
 * 第二条**不走剪贴板**是有原因的：DSH 的粘贴面只认文件 item，而 Chrome 不支持
 * 一次写多个 `ClipboardItem`（实测 `Support for multiple ClipboardItems is not
 * implemented.`），且系统剪贴板只能放一张图 —— 「图 + 字」根本粘不进来。
 * @param props - 席位 owner 面。
 * @returns 消息元素。
 */
export function UserMessageCopy(props: UserMessageProps): ReactNode {
	const data = props.node?.data;
	const content = data?.content;
	const parts = useMemo(() => copyPartsOf(content), [content]);

	/** 正在跑的那一个按钮（`''` = 空闲）。 */
	const [busy, setBusy] = useState<CopyKind | ''>('');
	/** 刚成功的那一个按钮（按钮上显示「已复制」）。 */
	const [done, setDone] = useState<CopyKind | ''>('');
	/** 结论（成功也写一句：用户要知道带上了几张、有没有漏）。 */
	const [note, setNote] = useState('');
	/** 卸载后不要再 setState（复制是异步的，用户可能已经切走）。 */
	const live = useRef(true);
	const timer = useRef<number | null>(null);
	useEffect(() => {
		live.current = true;
		return () => {
			live.current = false;
			if (timer.current !== null) window.clearTimeout(timer.current);
		};
	}, []);

	const run = useCallback(
		(kind: CopyKind, fn: () => Promise<CopyOutcome>): void => {
			if (busy !== '') return;
			setBusy(kind);
			setDone('');
			setNote('');
			void fn().then((outcome) => {
				if (!live.current) return;
				setBusy('');
				setNote(outcome.message);
				if (outcome.ok) setDone(kind);
				if (timer.current !== null) window.clearTimeout(timer.current);
				timer.current = window.setTimeout(() => {
					timer.current = null;
					if (!live.current) return;
					setDone('');
					setNote('');
				}, outcome.ok ? 2000 : 5000);
			});
		},
		[busy],
	);

	const time = clockOf(data?.time);
	const referenceLabels = data?.referenceLabels ?? [];
	const skillNames = data?.skillNames ?? [];
	const imageCount = parts.images.length;
	// 图标按钮没有文字，无障碍名与 hover 提示都要自己给（本体那条复制按钮同理）
	const richLabel =
		done === 'rich' ? '已复制' : imageCount === 0 ? '复制这条消息' : `复制这条消息（含 ${String(imageCount)} 张图）`;
	const composeLabel =
		done === 'compose'
			? '已送进输入框'
			: imageCount === 0
				? '把文字送进输入框'
				: `把文字与 ${String(imageCount)} 张图送进输入框`;

	return (
		<div className="ffc-msg" data-ffc-user-message="true">
			<div className="ffc-msg-stack">
				{imageCount > 0 && props.renderMessageImages !== undefined ? (
					<div className="ffc-msg-images" data-message-attachments="true">
						{parts.images.map((image, index) => (
							// 同一张图贴两次时 attachmentId 会重复 → 键里带上序号
							<span className="ffc-msg-image" key={`${String(image.attachment.attachmentId)}:${String(index)}`}>
								{props.renderMessageImages?.({
									images: [{ attachment: image.attachment }],
									align: 'end',
									compact: imageCount > 1,
								})}
							</span>
						))}
					</div>
				) : null}

				{parts.text !== '' ? <div className="ffc-msg-bubble">{parts.text}</div> : null}

				{parts.fileNames.length > 0 ? (
					<div className="ffc-msg-note">{parts.fileNames.map((name) => `[附件] ${name}`).join('　')}</div>
				) : null}

				{referenceLabels.length > 0 ? (
					<div className="ffc-msg-note">引用：{referenceLabels.join('、')}</div>
				) : null}

				{skillNames.length > 0 ? <div className="ffc-msg-note">技能：{skillNames.join('、')}</div> : null}

				{/* 不认识的块不静默丢：本体把它渲染成 JSON 卡片，这里退一步给原文 */}
				{parts.rest.length > 0 ? (
					<pre className="ffc-msg-extra">{JSON.stringify(parts.rest, null, 2)}</pre>
				) : null}
			</div>

			<div className="ffc-msg-actions">
				{time === '' ? null : <span className="ffc-msg-time">{time}</span>}
				<button
					type="button"
					className="ffc-msg-action"
					data-state={done === 'rich' ? 'done' : busy === 'rich' ? 'busy' : 'idle'}
					disabled={busy !== ''}
					aria-label={richLabel}
					title={
						imageCount === 0
							? '复制这条消息'
							: `复制这条消息（文字 + ${String(imageCount)} 张图，图内联成富文本）—— 粘到微信 / 飞书 / 文档里`
					}
					onClick={() => {
						run('rich', () => copyMessageWithImages(parts, props.loadImage));
					}}
				>
					{done === 'rich' ? <IconCheckOutlineRegular /> : <IconCopyOutlineRegular />}
				</button>
				<button
					type="button"
					className="ffc-msg-action"
					data-state={done === 'compose' ? 'done' : busy === 'compose' ? 'busy' : 'idle'}
					disabled={busy !== ''}
					aria-label={composeLabel}
					title={
						imageCount === 0
							? '把这段文字放进聊天输入框'
							: `把文字 + ${String(imageCount)} 张图放进聊天输入框（图会变成真附件，可直接当参考图）`
					}
					onClick={() => {
						run('compose', () => sendMessageToComposerOutcome(parts, props.loadImage));
					}}
				>
					{done === 'compose' ? <IconCheckOutlineRegular /> : <SendToComposerIcon size={15} />}
				</button>
				{note === '' ? null : <span className="ffc-msg-note">{note}</span>}
			</div>
		</div>
	);
}
