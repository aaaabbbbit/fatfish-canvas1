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
 * P18 起还有两样东西长在卡片上：
 *   - **连接点**（`.ffc-port`，四条边的中点，进出合一）：可见性纯靠 CSS 的
 *     `:hover`，见 styles.ts 里那一段的说明；
 *   - **文字节点的内联编辑**（双击进入）：提示词是生成节点的唯一输入来源，
 *     而画布上此前没有任何输入文字的地方。
 *
 * P19 给生成节点加了一条**参数条**（产物种类 + 画幅比例，两个原生 select）：
 * 画布上唯一一处「就地改节点参数」的地方。用原生 select 而不是自绘菜单 ——
 * 它自带键盘与无障碍，而参数只有两三个，弹一层自绘菜单是纯开销。
 *
 * @module fatfish-canvas/client/canvas/NodeCard
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { RiceBowlIcon } from '../icons';
import { ASPECT_RATIOS, mediaNodeSize, VIDEO_DURATIONS, VIDEO_RESOLUTIONS } from '../shared/media';
import {
	genDurationOf,
	genKindOf,
	genRatioOf,
	genResolutionOf,
	type CanvasNode,
	type PortSide,
} from './model';
import { PORT_SIDES } from './ports';
import { updateNodes } from './store';

/** 卡片属性。 */
export interface NodeCardProps {
	/** 节点数据。 */
	node: CanvasNode;
	/** 是否处于选中态。 */
	selected: boolean;
	/**
	 * 当前缩放倍率。
	 *
	 * 连接点要**屏幕尺寸恒定**（缩到 10% 时 16px 的圆点只剩 1.6px，点都点不到），
	 * 因此每个连接点按 1/zoom 反向缩放。端口跟着节点走（在世界层里），
	 * 这样平移缩放时不需要任何额外同步。
	 */
	zoom: number;
	/** 指针按下（由上层据此发起拖拽）。 */
	onPointerDown: (event: unknown, nodeId: string) => void;
	/** 连接点上按下（由上层据此发起连线）。 */
	onPortPointerDown: (event: unknown, nodeId: string, side: PortSide) => void;
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
export function NodeCard({
	node,
	selected,
	zoom,
	onPointerDown,
	onPortPointerDown,
	onRemove,
}: NodeCardProps): ReactNode {
	const style = {
		left: `${String(node.x)}px`,
		top: `${String(node.y)}px`,
		width: `${String(node.w)}px`,
		height: `${String(node.h)}px`,
		zIndex: String(node.z),
	};
	/** 连接点的反向缩放（zoom 为 0/NaN 时退回 1，绝不写进一个坏变换）。 */
	const inverse = Number.isFinite(zoom) && zoom > 0 ? 1 / zoom : 1;

	/** 文字节点的内联编辑（双击进入）。生成节点的提示词不在这里改 —— 它来自连线。 */
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState('');
	const editable = node.kind === 'text';

	const commit = useCallback(() => {
		setEditing(false);
		const text = draft.trim();
		if (text === (node.prompt ?? node.title ?? '')) return;
		// `title` 一起写：节点悬浮条与 `graph.ts` 的兜底读的都是它，
		// 只写 prompt 会让两处显示不一致。
		updateNodes([node.id], { prompt: text, title: text });
	}, [draft, node.id, node.prompt, node.title]);

	/**
	 * 改生成节点的参数。
	 *
	 * 顺带把**节点形状**改成与画幅一致：不然选 16:9 之后卡片还是正方形，
	 * 出图时会留一大块空白，看着像出错了。
	 */
	const setParams = useCallback(
		(patch: {
			genKind?: 'image' | 'video';
			ratio?: string;
			duration?: number | undefined;
			resolution?: string | undefined;
		}) => {
			const kind = patch.genKind ?? genKindOf(node);
			const ratio = patch.ratio ?? genRatioOf(node);
			updateNodes([node.id], { ...patch, ...mediaNodeSize({ kind, aspectRatio: ratio }) });
		},
		[node],
	);

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
			onDoubleClick={(event) => {
				if (!editable) return;
				// 只有双击**内容区**才进编辑：双击悬浮操作条上的按钮不该冒出输入框
				if (!(event.target instanceof Element) || event.target.closest('.ffc-node-bar') !== null) {
					return;
				}
				event.stopPropagation();
				setDraft(node.prompt ?? node.title ?? '');
				setEditing(true);
			}}
		>
			{/* 生成节点的参数条（P19）：产物种类 + 画幅比例。
			    整条 `data-ffc-ui` 且阻断冒泡 —— 不然点下拉框会变成拖节点。 */}
			{node.kind === 'gen' ? (
				<div
					className="ffc-node-gen-head"
					data-ffc-ui="gen-params"
					onPointerDown={(event) => {
						event.stopPropagation();
					}}
				>
					<select
						className="ffc-node-gen-select"
						aria-label="产物种类"
						title="这个生成节点画出图像还是视频"
						value={genKindOf(node)}
						onChange={(event) => {
							setParams({ genKind: event.target.value === 'video' ? 'video' : 'image' });
						}}
					>
						<option value="image">图像</option>
						<option value="video">视频</option>
					</select>
					<select
						className="ffc-node-gen-select"
						aria-label="画幅比例"
						title="画幅比例（会一起调整节点形状）"
						value={genRatioOf(node)}
						onChange={(event) => {
							setParams({ ratio: event.target.value });
						}}
					>
						{ASPECT_RATIOS.map((ratio) => (
							<option key={ratio} value={ratio}>
								{ratio}
							</option>
						))}
					</select>
					{/* 视频参数只在产物是视频时出现：图像节点上多两个没用的下拉框
					    只会让人以为「图像也能设时长」。 */}
					{genKindOf(node) === 'video' ? (
						<>
							<select
								className="ffc-node-gen-select"
								aria-label="视频时长"
								title="视频时长（默认 = 用生成管线的默认值）"
								value={genDurationOf(node) === undefined ? '' : String(genDurationOf(node))}
								onChange={(event) => {
									const raw = event.target.value;
									setParams({ duration: raw === '' ? undefined : Number(raw) });
								}}
							>
								<option value="">时长</option>
								{VIDEO_DURATIONS.map((seconds) => (
									<option key={seconds} value={String(seconds)}>
										{seconds}s
									</option>
								))}
							</select>
							<select
								className="ffc-node-gen-select"
								aria-label="视频分辨率"
								title="视频分辨率（默认 = 用生成管线的默认值）"
								value={genResolutionOf(node) ?? ''}
								onChange={(event) => {
									const raw = event.target.value;
									setParams({ resolution: raw === '' ? undefined : raw });
								}}
							>
								<option value="">清晰度</option>
								{VIDEO_RESOLUTIONS.map((resolution) => (
									<option key={resolution} value={resolution}>
										{resolution}
									</option>
								))}
							</select>
						</>
					) : null}
				</div>
			) : null}

			<div className="ffc-node-media">
				{editing ? (
					<textarea
						className="ffc-node-edit"
						value={draft}
						autoFocus
						aria-label="编辑文字节点"
						placeholder="写提示词，Ctrl/⌘ + Enter 保存，Esc 取消"
						onPointerDown={(event) => {
							// 不然会变成拖节点，输入框根本点不进去
							event.stopPropagation();
						}}
						onChange={(event) => {
							setDraft(event.target.value);
						}}
						onBlur={commit}
						onKeyDown={(event) => {
							// 画布的快捷键挂在视口上，输入框里的一律不许外泄
							event.stopPropagation();
							if (event.key === 'Escape') {
								setEditing(false);
								return;
							}
							if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) commit();
						}}
					/>
				) : node.status === 'pending' ? (
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
				) : node.kind === 'gen' && node.src !== undefined && genKindOf(node) === 'video' ? (
					// 生成节点画出的是视频时用视频视图（悬停播放、独立播放按钮）
					<VideoView node={node} />
				) : node.src !== undefined && (node.kind === 'image' || node.kind === 'gen') ? (
					<img
						className="ffc-node-el"
						src={node.src}
						alt={node.title ?? '画布图像'}
						draggable={false}
					/>
				) : node.kind === 'gen' ? (
					<div className="ffc-node-gen">
						<span className="ffc-node-gen-title">生成节点</span>
						<span className="ffc-node-gen-hint">把文字与图片连过来，再点顶栏「运行」</span>
					</div>
				) : (
					<div className="ffc-node-text">
						{(node.title ?? node.prompt ?? '') === '' ? (
							<span className="ffc-node-text-empty">双击写提示词</span>
						) : (
							(node.title ?? node.prompt ?? '')
						)}
					</div>
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

			{/* 连接点：四条边的中点各一个，进出合一。
			    可见性**全靠 CSS**（`.ffc-port` 默认 opacity 0 + pointer-events none，
			    `.ffc-node:hover` 或端口自己 `:hover` 时淡入）—— 因此不需要任何
			    逐帧的「靠近判定」，也不会在不可见时抢走节点拖拽的指针。
			    反向缩放让它在任何 zoom 下都是屏幕上那么大。 */}
			{PORT_SIDES.map((side) => (
				<span
					key={side}
					className="ffc-port"
					data-ffc-port={side}
					title="拖到另一个节点的连接点，连成一条线"
					style={{ transform: `scale(${String(inverse)})` }}
					onPointerDown={(event) => {
						// 不阻断的话会先变成「拖节点」，连线永远拉不出来
						event.stopPropagation();
						onPortPointerDown(event, node.id, side);
					}}
				/>
			))}
		</div>
	);
}
