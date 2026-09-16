/**
 * 聊天侧的工具行：`media_generate` 的 keyed tool view。
 *
 * 这是「结果双落」里**聊天那一半**。默认的通用工具卡片会把结果渲染成一段
 * JSON / 文本，而生成结果本来就带 `presentationMeta`，直接渲染媒体才是它该有的样子。
 *
 * 注册进 `tool.call.toolview` 的 key 域（key = 线上工具名）后会**替换**通用行，
 * 因此这里必须自己覆盖三种形态：
 *
 *   进行中（`RunningToolCall`）、成功（`ToolResultNode` + meta）、失败（`isError`）。
 *
 * 画布节点那一半在 `canvas/bridge.ts`：同一个 `presentationMeta`，
 * 一个落到对话流，一个落到画布。
 *
 * @module fatfish-canvas/client/toolview/MediaToolRow
 */

import type { ReactNode } from 'react';
import { RiceBowlIcon } from '../icons';
import {
	parseMediaCallArgs,
	readMediaPresentation,
	type MediaCallArgs,
	type MediaPresentation,
} from '../shared/media';
import { textOfContent } from '../canvas/ingest';

/** keyed tool view 收到的 owner 面（只声明本组件用到的字段）。 */
interface ToolRowProps {
	/** 冻结的「进行中调用」或「已结束结果」。 */
	block?: {
		kind?: string;
		argsRaw?: string;
		call?: { name: string; argsRaw: string } | null;
		meta?: unknown;
		isError?: boolean;
		content?: readonly unknown[];
	};
}

/**
 * 渲染媒体本身。
 * @param meta - 生成结果。
 * @param alt - 无障碍替代文本。
 * @returns 媒体元素；地址缺失时给出提示。
 */
function MediaView({ meta, alt }: { meta: MediaPresentation; alt: string }): ReactNode {
	if (meta.url === '') {
		return <div className="ffc-tool-note">结果里没有可用的地址</div>;
	}
	if (meta.kind === 'video') {
		return (
			<video
				className="ffc-tool-video"
				src={meta.url}
				controls
				muted
				loop
				playsInline
				preload="metadata"
			/>
		);
	}
	return <img className="ffc-tool-img" src={meta.url} alt={alt} />;
}

/**
 * `media_generate` 的工具行。
 * @param props - keyed tool view 的 owner 面。
 * @returns 工具行元素。
 */
export function MediaToolRow(props: ToolRowProps): ReactNode {
	const block = props.block;
	const settled = block !== undefined && block.kind === 'tool-result';
	const args: MediaCallArgs = parseMediaCallArgs(settled ? block?.call?.argsRaw : block?.argsRaw);
	const meta = settled ? readMediaPresentation(block?.meta) : null;
	const failed = settled && (block?.isError === true || meta === null);
	// 结果里的 kind 是权威的：窗口截断会把配对的调用头留成 null，
	// 那时参数只剩默认值，只有 meta 知道这次画的到底是图像还是视频。
	const kind = meta?.kind ?? args.kind;
	const label = kind === 'video' ? '视频' : '图像';
	const prompt = meta?.prompt ?? args.prompt;

	const state = !settled ? 'running' : failed ? 'error' : 'ready';
	const title = !settled ? `正在生成${label}…` : failed ? `生成${label}失败` : `已生成${label}`;

	return (
		<div className="ffc-tool" data-state={state}>
			<div className="ffc-tool-head">
				<span className="ffc-tool-icon" aria-hidden="true">
					<RiceBowlIcon size={14} />
				</span>
				<span className="ffc-tool-title">{title}</span>
				{meta?.model !== undefined && meta.model !== '' ? (
					<span className="ffc-tool-badge" title={meta.providerId ?? ''}>
						{meta.model}
					</span>
				) : null}
				{meta?.usedReference === true ? (
					<span className="ffc-tool-badge" title="这次生成带上了参考图（供应商是否采纳无法探测）">
						参考图
					</span>
				) : null}
				<span className="ffc-tool-spacer" />
				{meta !== null && meta.url !== '' ? (
					<a
						className="ffc-tool-link"
						href={meta.url}
						target="_blank"
						rel="noreferrer"
						title="在新标签页打开"
					>
						↗
					</a>
				) : null}
			</div>

			{prompt !== '' ? (
				<div className="ffc-tool-prompt" title={prompt}>
					{prompt}
				</div>
			) : null}

			{/* 视觉模型替看不见图的模型读出来的那段文字：让用户能核对「它看到了什么」 */}
			{meta?.referenceDescription !== undefined ? (
				<div className="ffc-tool-note" title={meta.referenceDescription}>
					参考图：{meta.referenceDescription}
				</div>
			) : null}

			{meta !== null ? <MediaView meta={meta} alt={prompt === '' ? label : prompt} /> : null}

			{failed ? (
				<div className="ffc-tool-error" role="alert">
					{textOfContent(block?.content) || '生成失败（宿主没有给出原因）'}
				</div>
			) : null}

			{!settled ? <div className="ffc-tool-note">结果会同时出现在这里与左侧画布上</div> : null}
		</div>
	);
}
