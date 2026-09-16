/**
 * 画布节点卡片。
 *
 * 尺寸完全由节点自身的 world 宽高决定（外层世界层负责缩放），因此卡片内部
 * 不做任何缩放补偿 —— 边框、圆角、文字都随缩放一起变，这正是画布该有的手感。
 *
 * 视频刻意**不用**原生 `controls`：原生控件需要点击，而整块节点又要能拖拽，
 * 两者会互相抢指针。改为 jaaz 的语义 —— 默认静音、悬停播放、移出暂停并归零，
 * 另给一个独立的播放/暂停按钮（其 pointerdown 阻断冒泡，因此永远不会触发拖拽）。
 *
 * @module fatfish-canvas/client/canvas/NodeCard
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { RiceBowlIcon } from '../icons';
import type { CanvasNode } from './model';

/** 卡片属性。 */
export interface NodeCardProps {
	/** 节点数据。 */
	node: CanvasNode;
	/** 是否处于选中态。 */
	selected: boolean;
	/** 指针按下（由上层据此发起拖拽）。 */
	onPointerDown: (event: unknown, nodeId: string) => void;
	/** 请求删除。 */
	onRemove: (nodeId: string) => void;
}

/**
 * 视频节点视图：静音悬停播放 + 独立播放按钮。
 * @param props - 节点。
 * @returns 视频层。
 */
function VideoView({ node }: { node: CanvasNode }): ReactNode {
	const ref = useRef<HTMLVideoElement | null>(null);
	const [playing, setPlaying] = useState(false);

	// React 对 muted 的 JSX 处理不可靠，直接写 DOM 属性。
	// 不静音的话浏览器的自动播放策略会直接拒绝 play()。
	useEffect(() => {
		const el = ref.current;
		if (el !== null) el.muted = true;
	}, []);

	const play = useCallback(() => {
		const el = ref.current;
		if (el === null) return;
		void el.play().then(
			() => {
				setPlaying(true);
			},
			() => {
				setPlaying(false);
			},
		);
	}, []);

	const pause = useCallback((reset: boolean) => {
		const el = ref.current;
		if (el === null) return;
		el.pause();
		if (reset) el.currentTime = 0;
		setPlaying(false);
	}, []);

	const toggle = useCallback(() => {
		if (playing) pause(false);
		else play();
	}, [pause, play, playing]);

	return (
		<>
			<video
				ref={ref}
				className="ffc-node-el"
				src={node.src}
				poster={node.poster}
				preload="metadata"
				playsInline
				loop
				onPointerEnter={play}
				onPointerLeave={() => {
					pause(true);
				}}
			/>
			<button
				type="button"
				className="ffc-node-play"
				data-playing={playing ? 'true' : undefined}
				title={playing ? '暂停' : '播放'}
				aria-label={playing ? '暂停视频' : '播放视频'}
				onPointerDown={(event) => {
					// 阻断冒泡：否则会被画布当成拖拽起点
					event.stopPropagation();
				}}
				onClick={(event) => {
					event.stopPropagation();
					toggle();
				}}
			>
				{playing ? '❚❚' : '▶'}
			</button>
		</>
	);
}

/**
 * 渲染一个节点。
 * @param props - 节点属性。
 * @returns 卡片元素。
 */
export function NodeCard({ node, selected, onPointerDown, onRemove }: NodeCardProps): ReactNode {
	const style = {
		left: `${String(node.x)}px`,
		top: `${String(node.y)}px`,
		width: `${String(node.w)}px`,
		height: `${String(node.h)}px`,
		zIndex: String(node.z),
	};

	return (
		<div
			className="ffc-node"
			data-node-id={node.id}
			data-selected={selected ? 'true' : undefined}
			data-status={node.status}
			data-kind={node.kind}
			style={style}
			onPointerDown={(event) => {
				onPointerDown(event, node.id);
			}}
		>
			<div className="ffc-node-media">
				{node.status === 'pending' ? (
					<div className="ffc-node-pending" aria-label="生成中">
						<span className="ffc-node-pending-icon">
							<RiceBowlIcon size={28} />
						</span>
						<span className="ffc-node-pending-text">生成中…</span>
					</div>
				) : node.status === 'failed' ? (
					<div className="ffc-node-failed" role="alert">
						<span className="ffc-node-failed-title">生成失败</span>
						<span className="ffc-node-failed-reason">{node.error ?? '未知原因'}</span>
					</div>
				) : node.kind === 'video' ? (
					<VideoView node={node} />
				) : node.kind === 'image' ? (
					<img
						className="ffc-node-el"
						src={node.src}
						alt={node.title ?? '画布图像'}
						draggable={false}
					/>
				) : (
					<div className="ffc-node-text">{node.title ?? node.prompt ?? ''}</div>
				)}
			</div>

			{/* 悬浮操作条：悬停或选中时出现，不干扰拖拽 */}
			<div className="ffc-node-bar">
				{node.title !== undefined && node.title !== '' ? (
					<span className="ffc-node-title" title={node.title}>
						{node.title}
					</span>
				) : node.prompt !== undefined && node.prompt !== '' ? (
					<span className="ffc-node-title" title={node.prompt}>
						{node.prompt}
					</span>
				) : (
					<span className="ffc-node-title ffc-node-title-muted">
						{node.kind === 'video' ? '视频' : node.kind === 'image' ? '图像' : '文字'}
					</span>
				)}
				{node.status === 'failed' ? (
					<span className="ffc-node-flag" title={node.error ?? ''}>
						失败
					</span>
				) : null}
				<span className="ffc-node-spacer" />
				{node.src !== undefined ? (
					<a
						className="ffc-node-act"
						href={node.src}
						target="_blank"
						rel="noreferrer"
						title="在新标签页打开"
						onPointerDown={(event) => {
							event.stopPropagation();
						}}
					>
						↗
					</a>
				) : null}
				<button
					type="button"
					className="ffc-node-act"
					title="从画布删除"
					aria-label="从画布删除"
					onPointerDown={(event) => {
						event.stopPropagation();
					}}
					onClick={(event) => {
						event.stopPropagation();
						onRemove(node.id);
					}}
				>
					×
				</button>
			</div>
		</div>
	);
}
