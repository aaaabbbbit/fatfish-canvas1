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
 * 视频还要**能自己从一次失败的加载里恢复**：元素加载失败后不会自愈，卡片会一直
 * 空着（连 `play()` 都静默失败），见 {@link VideoView} 的 `reload`。
 *
 * @module fatfish-canvas/client/canvas/NodeCard
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { WhaleTailIcon } from '../icons';
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
	const [dead, setDead] = useState(false);
	/** 是否已经自动补过一次请求（见 `onError`）。 */
	const retried = useRef(false);

	// React 对 muted 的 JSX 处理不可靠，直接写 DOM 属性。
	// 不静音的话浏览器的自动播放策略会直接拒绝 play()。
	useEffect(() => {
		const el = ref.current;
		if (el !== null) el.muted = true;
	}, []);

	/**
	 * 重新发一次请求。
	 *
	 * `<video>` 一旦加载失败（网络抖动、标签页被冻结、请求被掐断）就会**一直空着**：
	 * 元素自己不会重试，`play()` 也只会静默失败 —— 在此之前唯一的出路是刷新整个
	 * 页面（实测刷新即恢复）。而且失败时元素画不出任何东西，卡片看上去和「还没
	 * 加载完」一模一样，所以下面还要把失败**说出来**。
	 */
	const reload = useCallback(() => {
		const el = ref.current;
		if (el !== null) el.load();
	}, []);

	const play = useCallback(() => {
		const el = ref.current;
		if (el === null) return;
		// `readyState === 0` = 一个字节都没拿到（下载早就断了）：先重新拉再播。
		// 用户主动点播不受「只自动补一次」的限制 —— 他知道自己在等什么。
		if (el.readyState === 0) reload();
		void el.play().then(
			() => {
				setPlaying(true);
				setDead(false);
			},
			() => {
				setPlaying(false);
			},
		);
	}, [reload]);

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
				onError={() => {
					// 失败了自动补一次；网络一直不通时不再反复重发（那只是白打请求），
					// 改成在播放按钮上说明情况，让用户自己决定要不要再试。
					if (retried.current) {
						setDead(true);
						return;
					}
					retried.current = true;
					reload();
				}}
				onPointerEnter={play}
				onPointerLeave={() => {
					pause(true);
				}}
			/>
			<button
				type="button"
				className="ffc-node-play"
				data-playing={playing ? 'true' : undefined}
				title={dead ? '加载失败，点这里重试' : playing ? '暂停' : '播放'}
				aria-label={dead ? '视频加载失败，点击重试' : playing ? '暂停视频' : '播放视频'}
				onPointerDown={(event) => {
					// 阻断冒泡：否则会被画布当成拖拽起点
					event.stopPropagation();
				}}
				onClick={(event) => {
					event.stopPropagation();
					// 记账一起清掉：用户这次重试如果再失败，还应该能自动补一次
					if (dead) {
						setDead(false);
						retried.current = false;
					}
					toggle();
				}}
			>
				{dead ? '⚠' : playing ? '❚❚' : '▶'}
			</button>
		</>
	);
}

/**
 * 图像节点视图：加载失败时要说出来，而不是留一块空白。
 *
 * 生成结果的地址可能是**供应商的临时链接**（留档目录没配 / 那次留档失败时），
 * 过期后 `<img>` 只会静默失败 —— 用户看到的是一块「没加载出来」的空白，
 * 无从判断是网络慢、画布坏了，还是原图没了。这里把它变成一句明确的状态。
 * @param node - 节点。
 * @returns 图像层或失败说明。
 */
function ImageView({ node }: { node: CanvasNode }): ReactNode {
	const [dead, setDead] = useState(false);

	// 节点换了地址（重新生成后复用同一个节点 id）要重新试一次
	useEffect(() => {
		setDead(false);
	}, [node.src]);

	if (dead) {
		return (
			<div className="ffc-node-failed" role="alert">
				<span className="ffc-node-failed-title">图片加载失败</span>
				<span className="ffc-node-failed-reason">原图链接可能已过期，右键 → 重新生成</span>
			</div>
		);
	}

	return (
		<img
			className="ffc-node-el"
			src={node.src}
			alt={node.title ?? '画布图像'}
			draggable={false}
			onError={() => {
				setDead(true);
			}}
		/>
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
							<WhaleTailIcon size={28} generating />
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
					<ImageView node={node} />
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
