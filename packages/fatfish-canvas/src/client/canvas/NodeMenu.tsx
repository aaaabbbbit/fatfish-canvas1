/**
 * 画布节点的右键菜单（P5）。
 *
 * 交互约定（照抄主流白板）：右键先**选中**被点的节点 —— 如果它已经在多选里，
 * 就保留整个选择集，于是「删除 / 带到视野 / 导出 / 以此为参考图生成」作用于整组，
 * 而「复制提示词 / 重新生成」只在单选时可用。用户的心智模型只有一条：
 * **菜单作用于当前选择**。
 *
 * 两个动作需要外部能力，都做了降级而不是静默失败：
 *   - 「复制」走统一基座的 `writeClipboard`，被拒绝时在菜单里明说「剪贴板不可用」；
 *   - 「重新生成」需要**当前会话**（见 canvas/regenerate.ts），没有会话时直接禁用。
 *
 * @module fatfish-canvas/client/canvas/NodeMenu
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives';
import { CheckIcon } from '../icons';
import { clampToViewport, useMenuDismiss, useMenuFocus, useMenuNav } from '../menu';
import { focusNodes } from './actions';
import { exportNodes } from './exportImages';
import {
	hasRegenerateTarget,
	referenceOf,
	referencesOf,
	REFERENCE_FALLBACK_PROMPT,
	regenerate,
} from './regenerate';
import { getBoard, removeNodes } from './store';
import { mediaCounts, mediaCountsText, nodeRatio, referenceViews, type CanvasNode } from './model';

/** 菜单属性。 */
export interface NodeMenuProps {
	/** 被右键的节点。 */
	node: CanvasNode;
	/** 当前选择集（调用方保证已包含 node.id）。 */
	selection: readonly string[];
	/** 打开位置（视口坐标）。 */
	at: { x: number; y: number };
	/** 关闭。 */
	onClose: () => void;
}

/** 一个菜单条目。 */
interface Entry {
	id: string;
	label: string;
	/** 动作完成后的短暂反馈文案（复制/发送这类无视觉结果的动作需要它）。 */
	doneLabel?: string;
	disabled?: boolean;
	/** 禁用原因（显示成 title）—— 「点不动又不说为什么」是最难查的一类反馈。 */
	disabledReason?: string;
	danger?: boolean;
	run: () => void | Promise<void>;
}

/** 复制提示词时用哪一段文字。 */
function promptOf(node: CanvasNode): string {
	const prompt = node.prompt ?? '';
	return prompt !== '' ? prompt : (node.title ?? '');
}

/**
 * 「生成信息」卡片：这张图/视频当时是**用什么提示词、带哪些参考图**生成的。
 *
 * 为什么值得有：提示词是长文本，节点上根本放不下，而「三天后回看这张图是怎么来的」
 * 是画布最常见的用途之一。参考图句柄只在生成的那一刻看得到（见 `canvas/ingest.ts`），
 * 因此更早的节点上会照实写「没有记录」—— 宁可说不知道，也不要显示一张错的图。
 * @param props - 目标节点。
 * @returns 信息卡片。
 */
function InfoCard({ node }: { node: CanvasNode }): ReactNode {
	const prompt = node.prompt ?? '';
	const refs = referenceViews(node.references);
	const model = node.model ?? '';
	const ratio = nodeRatio(node);
	return (
		<div className="ffc-node-info">
			<div className="ffc-node-info-head">提示词</div>
			<div className="ffc-node-info-prompt">{prompt === '' ? '（没有记录）' : prompt}</div>
			<div className="ffc-node-info-head">
				参考图{refs.length === 0 ? '' : `（${String(refs.length)} 张）`}
			</div>
			{refs.length === 0 ? (
				<div className="ffc-node-info-empty">（没有记录）</div>
			) : (
				<div className="ffc-node-info-refs">
					{refs.map((ref, index) => (
						<div className="ffc-node-info-ref" key={`${String(index)}:${ref.handle}`}>
							{ref.loadable ? (
								// 只有真地址能当 src：附件 id / 本地路径渲染出来只会是一个裂图
								<img className="ffc-node-info-thumb" src={ref.handle} alt="" loading="lazy" />
							) : (
								// 占位里放一个「?」：空白方块在深色菜单里读起来像「没加载出来」
								<span className="ffc-node-info-thumb" data-empty="true" aria-hidden="true">
									?
								</span>
							)}
							<span className="ffc-node-info-reftext" title={ref.handle}>
								{ref.note ?? ref.handle}
							</span>
						</div>
					))}
				</div>
			)}
			<div className="ffc-node-info-foot">
				{model === '' ? '模型未记录' : model}
				{ratio === undefined ? '' : ` · ${ratio}`}
			</div>
		</div>
	);
}

/**
 * 节点右键菜单。
 * @param props - 目标节点、选择集、位置与关闭回调。
 * @returns 浮层菜单。
 */
export function NodeMenu({ node, selection, at, onClose }: NodeMenuProps): ReactNode {
	const menuRef = useRef<HTMLDivElement | null>(null);
	const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
	/** 某个动作刚完成（用于「已复制 / 已发送」的短暂反馈）。 */
	const [done, setDone] = useState<string | null>(null);
	/** 菜单底部的说明行（剪贴板被拒、导出进度与结论都写这儿）。 */
	const [note, setNote] = useState<string | null>(null);
	/** 是否展开「生成信息」卡片（展开时菜单不关，用户还要接着复制提示词）。 */
	const [info, setInfo] = useState(false);

	const targets = selection.length > 0 ? selection : [node.id];
	const single = targets.length === 1;
	const prompt = promptOf(node);
	const canRegenerate = prompt !== '' && hasRegenerateTarget();
	/**
	 * 选择集里**真的有地址**的节点，按 (y, x) 排 —— 导出的顺序就是人看画的顺序。
	 * 菜单只拿到被右键的那一个节点，整组的得回 store 取。
	 *
	 * 这是**媒体**（图与视频一起）而不是只有图：导出是复合动作，两者都收。
	 */
	const exportable = getBoard()
		.nodes.filter((item) => targets.includes(item.id) && (item.src ?? '') !== '')
		.sort((a, b) => a.y - b.y || a.x - b.x);
	/** 导出条目要说清「这一次会导出些什么」。 */
	const exportCounts = mediaCounts(exportable);
	const exportLabel =
		exportable.length === 0
			? '导出'
			: exportable.length === 1
				? exportable[0]?.kind === 'video'
					? '导出视频'
					: '导出图片'
				: `导出压缩包（${mediaCountsText(exportCounts)}）`;
	/**
	 * 能当**参考图**的那几个（判据见 `referenceOf`），顺序同上 —— 多选时整组一起
	 * 当参考图发给供应商，顺序就是它在请求体里的顺序。
	 */
	const referenceNodes = exportable.filter((item) => referenceOf(item) !== null);
	const references = referencesOf(referenceNodes);

	/** 复制一段文字并给出反馈（剪贴板权限可能被拒）。 */
	const copy = useCallback((id: string, text: string) => {
		void writeClipboard(text).then(
			() => {
				setNote(null);
				setDone(id);
			},
			() => {
				setNote('剪贴板不可用，请手动重试');
				setDone(null);
			},
		);
	}, []);

	const entries: Entry[] = [
		{
			id: 'focus',
			label: targets.length > 1 ? `带到视野（${String(targets.length)} 个）` : '带到视野',
			run: () => {
				focusNodes(targets, { force: true });
			},
		},
		{
			id: 'copy-prompt',
			label: '复制提示词',
			doneLabel: '已复制提示词',
			disabled: !single || prompt === '',
			run: () => {
				copy('copy-prompt', prompt);
			},
		},
		{
			id: 'copy-src',
			label: '复制地址',
			doneLabel: '已复制地址',
			disabled: node.src === undefined || node.src === '',
			run: () => {
				copy('copy-src', node.src ?? '');
			},
		},
		{
			// 展开式卡片而不是跳转弹窗：读提示词时多半还要顺手「复制提示词 / 重新生成」，
			// 换一个浮层就会把那些动作挡在后面（菜单里的动作全都还在手边）。
			id: 'info',
			label: info ? '收起生成信息' : '生成信息',
			run: () => {
				setInfo((prev) => !prev);
			},
		},
		{
			id: 'export',
			label: exportLabel,
			doneLabel: '已导出',
			disabled: exportable.length === 0,
			disabledReason: '选中的节点里没有可导出的媒体',
			run: async () => {
				// 导出要逐项取字节（跨域的还得过一次宿主），因此先给一行进度 ——
				// 否则点了之后几秒钟里菜单毫无反应，看着像没点上。
				setNote('正在导出…');
				const outcome = await exportNodes(exportable);
				setNote(outcome.message);
				setDone(outcome.ok ? 'export' : null);
			},
		},
		{
			id: 'regenerate',
			label: '重新生成',
			doneLabel: '已发送给会话',
			disabled: !single || !canRegenerate,
			disabledReason: !single
				? '多选时不可用'
				: hasRegenerateTarget()
					? '这个节点没有提示词'
					: '当前没有会话',
			run: async () => {
				// 优先走 /generate 直达命令（零 token），不可用时退回提示词
				const via = await regenerate(prompt, node.kind, nodeRatio(node));
				if (via !== null) setDone('regenerate');
				else setNote('没能发送给会话，请手动重试');
			},
		},
		{
			// 「图生图 / 视频首帧」：**参考图不经过模型** —— 地址直接进 /generate 命令行，
			// 字节由宿主读（模型看不见图，所以让它描述图是行不通的）。
			// 多选时**整组一起当参考图**（多图编辑 / 多张参考）：顺序按 (y, x)，
			// 与导出同一套规矩 —— 供应商那边「先主体、后背景」靠的就是这个顺序。
			id: 'reference',
			label:
				references.length > 1
					? `以此为参考图生成（${String(references.length)} 张）`
					: '以此为参考图生成',
			doneLabel: '已发送给会话',
			disabled: references.length === 0 || !hasRegenerateTarget(),
			disabledReason:
				references.length === 0
					? exportable.length === 0
						? '选中的节点里没有图'
						: '这些图不是可复用的地址（内联或本地数据），无法当参考图'
					: '当前没有会话',
			run: async () => {
				const via = await regenerate(
					prompt === '' ? REFERENCE_FALLBACK_PROMPT : prompt,
					node.kind,
					nodeRatio(node),
					references,
				);
				if (via !== null) setDone('reference');
				else setNote('没能发送给会话，请手动重试');
			},
		},
		{
			id: 'remove',
			label: targets.length > 1 ? `删除（${String(targets.length)} 个）` : '删除',
			danger: true,
			run: () => {
				removeNodes(targets);
			},
		},
	];

	// 条目每次渲染都是新数组，但**顺序与禁用态**只在依赖变化时变；
	// 用 ref + 稳定 id 列表，让菜单回调保持稳定（否则监听器会随每次渲染重装）。
	const entriesRef = useRef(entries);
	entriesRef.current = entries;
	const disabledRef = useRef<Record<string, boolean>>({});
	disabledRef.current = Object.fromEntries(entries.map((entry) => [entry.id, entry.disabled === true]));

	const idKey = entries.map((entry) => entry.id).join(',');
	const ids = useMemo(() => idKey.split(','), [idKey]);
	const isDisabled = useCallback((id: string) => disabledRef.current[id] === true, []);

	const choose = useCallback(
		(id: string) => {
			const entry = entriesRef.current.find((item) => item.id === id);
			if (entry === undefined) return;
			void entry.run();
			// 复制这类「无视觉结果」的动作不关菜单（用户可能接着复制另一项）；
			// 导出同理：结论（导了几张、哪张没取到）就写在这行说明里。
			// 「生成信息」是**开关**：关了菜单就等于刚打开就被收起来，那它就永远看不见。
			if (
				entry.id !== 'copy-prompt' &&
				entry.id !== 'copy-src' &&
				entry.id !== 'export' &&
				entry.id !== 'info'
			) {
				onClose();
			}
		},
		[onClose],
	);

	const nav = useMenuNav({ ids, isDisabled, onChoose: choose, onClose });
	useMenuDismiss({ menuRef, onClose });
	useMenuFocus(menuRef);

	// 量到真实尺寸后把菜单夹进视口：在画布右下角右键最容易把菜单顶到屏幕外。
	// ⚠️ `info` 也必须在依赖里：展开信息卡会把菜单撑高，不再夹一次就会顶出屏幕。
	useEffect(() => {
		const el = menuRef.current;
		if (el === null) return;
		const rect = el.getBoundingClientRect();
		setPos(clampToViewport(at, { w: rect.width, h: rect.height }));
	}, [at, info]);

	return (
		<div
			ref={menuRef}
			className="ffc-menu ffc-node-menu"
			role="menu"
			aria-label="节点操作"
			tabIndex={-1}
			style={{ left: `${String((pos ?? at).x)}px`, top: `${String((pos ?? at).y)}px` }}
			onKeyDown={nav.onKeyDown}
			{...nav.containerProps}
		>
			<div className="ffc-menu-label">
				{node.kind === 'video' ? '视频节点' : node.kind === 'image' ? '图像节点' : '文字节点'}
				{node.model !== undefined && node.model !== '' ? ` · ${node.model}` : ''}
			</div>
			{entries.map((entry) => (
				<button
					key={entry.id}
					type="button"
					role="menuitem"
					className="ffc-menu-item"
					data-danger={entry.danger === true ? 'true' : undefined}
					disabled={entry.disabled === true}
					title={entry.disabled === true ? (entry.disabledReason ?? '当前不可用') : entry.label}
					onClick={() => {
						choose(entry.id);
					}}
					{...nav.itemProps(entry.id)}
				>
					<span className="ffc-menu-check">{done === entry.id ? <CheckIcon size={13} /> : null}</span>
					<span>{done === entry.id ? (entry.doneLabel ?? entry.label) : entry.label}</span>
				</button>
			))}
			{info ? <InfoCard node={node} /> : null}
			{note !== null ? <div className="ffc-menu-note">{note}</div> : null}
		</div>
	);
}
