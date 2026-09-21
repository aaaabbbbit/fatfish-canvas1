/**
 * 画布节点的右键菜单（P5）。
 *
 * 交互约定（照抄主流白板）：右键先**选中**被点的节点 —— 如果它已经在多选里，
 * 就保留整个选择集，于是「删除 / 带到视野」作用于整组，而「复制提示词 /
 * 重新生成」只在单选时可用。用户的心智模型只有一条：**菜单作用于当前选择**。
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
import { exportWorkflowPng } from './exportImage';
import { pushNotice } from './notice';
import {
	hasRegenerateTarget,
	referenceOf,
	REFERENCE_FALLBACK_PROMPT,
	regenerate,
} from './regenerate';
import { addLinks, addNodes, getBoard, removeNodes } from './store';
import {
	genDurationOf,
	genKindOf,
	genRatioOf,
	genResolutionOf,
	PLACEMENT_SPACING,
	nodeRatio,
	type CanvasNode,
} from './model';
import { runSingleNode } from './run';
import { parseWorkflow, planRestore } from './workflow';

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
 * 「复制为新节点」要带走的字段。
 *
 * 刻意**不带**身份（id/z/createdAt）、**产物**（src/error/workflow）与运行状态：
 * 复制出来的是「同一套参数的新活儿」，不是那张图的副本 —— 带 src 的话新节点
 * 一上来就是 ready 且显示旧图，用户会以为它已经跑过了。
 * @param node - 被复制的节点。
 * @returns `addNodes` 的输入（落在右边一格）。
 */
function copyOf(node: CanvasNode): Omit<CanvasNode, 'id' | 'z' | 'createdAt'> {
	return {
		kind: node.kind,
		x: Math.round(node.x + node.w + PLACEMENT_SPACING),
		y: Math.round(node.y),
		w: node.w,
		h: node.h,
		status: 'ready',
		...(node.prompt === undefined ? {} : { prompt: node.prompt }),
		...(node.title === undefined ? {} : { title: node.title }),
		...(node.genKind === undefined ? {} : { genKind: node.genKind }),
		...(node.ratio === undefined ? {} : { ratio: node.ratio }),
		...(node.duration === undefined ? {} : { duration: node.duration }),
		...(node.resolution === undefined ? {} : { resolution: node.resolution }),
	};
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
	/** 剪贴板被拒绝时的说明。 */
	const [copyFailed, setCopyFailed] = useState(false);

	const targets = selection.length > 0 ? selection : [node.id];
	const single = targets.length === 1;
	const prompt = promptOf(node);
	const canRegenerate = prompt !== '' && hasRegenerateTarget();
	/** 这个节点能不能当参考图（能就把地址写进 `--ref`；见 regenerate.ts）。 */
	const reference = referenceOf(node);
	/**
	 * 「重新生成」用的种类与比例。
	 *
	 * 生成节点读**它自己的参数**（P19 的参数面板）；媒体节点仍旧由节点形状反推
	 * （`nodeRatio`）—— 两者来源不同，因为生成节点的形状是「卡片多大」，
	 * 而它画出来的比例是用户选的。
	 */
	const regenKind = node.kind === 'gen' ? genKindOf(node) : node.kind;
	const regenRatio = node.kind === 'gen' ? genRatioOf(node) : nodeRatio(node);
	/** 视频参数只对生成节点有意义（媒体节点没有这两个字段）。 */
	const regenDuration = node.kind === 'gen' ? genDurationOf(node) : undefined;
	const regenResolution = node.kind === 'gen' ? genResolutionOf(node) : undefined;
	/** 能不能「复制为新节点」：媒体节点的副本没有意义（再拖一张更快）。 */
	const duplicable = node.kind === 'text' || node.kind === 'gen';

	/** 复制一段文字并给出反馈（剪贴板权限可能被拒）。 */
	const copy = useCallback((id: string, text: string) => {
		void writeClipboard(text).then(
			() => {
				setCopyFailed(false);
				setDone(id);
			},
			() => {
				setCopyFailed(true);
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
			// 导出的是**整块画布**的工作流（理由见 exportImage.ts）：
			// 用户要的是「把现在这一屏存下来，回头能原样恢复」。
			id: 'export-png',
			label: '导出带工作流的 PNG',
			disabled: !single || node.src === undefined || node.src === '',
			disabledReason: !single ? '多选时不可用' : '这个节点还没有图像',
			run: async () => {
				try {
					pushNotice(await exportWorkflowPng(node));
				} catch (error) {
					// 取不到字节 / 转码失败都必须说出来（静默失败最难查）
					pushNotice(error instanceof Error ? error.message : String(error));
				}
			},
		},
		{
			// 还原到这张图的右边（不与它自己重叠），id 全部重映射
			id: 'restore',
			label: '还原工作流',
			disabled: node.workflow === undefined || node.workflow === '',
			disabledReason: '这张图里没有本插件的工作流数据',
			run: () => {
				const doc = node.workflow === undefined ? null : parseWorkflow(node.workflow);
				const plan =
					doc === null
						? null
						: planRestore(
								doc,
								{ x: node.x + node.w + PLACEMENT_SPACING, y: node.y },
								getBoard().nodes.filter((item) => item.id !== node.id),
							);
				if (plan === null) {
					pushNotice('这张图里的工作流读不出来');
					return;
				}
				addNodes(plan.nodes);
				addLinks(plan.links);
				pushNotice(`已还原 ${String(plan.nodes.length)} 个节点、${String(plan.links.length)} 条连线`);
			},
		},
		{
			// 只跑这一个（不重跑上游）：改完参数想「换一张」时用，别把整条链再烧一遍
			id: 'run-node',
			label: '运行此节点',
			doneLabel: '已发送给会话',
			disabled: !single || node.kind !== 'gen' || !hasRegenerateTarget(),
			disabledReason: !single
				? '多选时不可用'
				: node.kind !== 'gen'
					? '只有生成节点可以运行'
					: '当前没有会话',
			run: async () => {
				const report = await runSingleNode(node.id);
				if (report.started > 0) {
					setDone('run-node');
					return;
				}
				// 跳过必须说出来（「点不动又不说为什么」是最难查的一类反馈）
				pushNotice(report.skipped[0]?.reason ?? '没能运行这个节点');
			},
		},
		{
			id: 'duplicate',
			label: '复制为新节点',
			disabled: !single || !duplicable,
			disabledReason: !single ? '多选时不可用' : '图片 / 视频节点直接再拖一张更快',
			run: () => {
				addNodes([copyOf(node)]);
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
				const via = await regenerate(prompt, {
					kind: regenKind,
					ratio: regenRatio,
					duration: regenDuration,
					resolution: regenResolution,
				});
				if (via !== null) setDone('regenerate');
				else setCopyFailed(true);
			},
		},
		{
			// 「图生图 / 视频首帧」：**参考图不经过模型** —— 地址直接进 /generate 命令行，
			// 字节由宿主读（模型看不见图，所以让它描述图是行不通的）。
			id: 'reference',
			label: '以此为参考图生成',
			doneLabel: '已发送给会话',
			disabled: !single || reference === null || !hasRegenerateTarget(),
			disabledReason: !single
				? '多选时不可用'
				: reference === null
					? node.src === undefined || node.src === ''
						? '这个节点还没有图像'
						: '这张图不是可复用的地址（内联或本地数据），无法当参考图'
					: '当前没有会话',
			run: async () => {
				const via = await regenerate(prompt === '' ? REFERENCE_FALLBACK_PROMPT : prompt, {
					kind: regenKind,
					ratio: regenRatio,
					reference: reference ?? undefined,
					duration: regenDuration,
					resolution: regenResolution,
				});
				if (via !== null) setDone('reference');
				else setCopyFailed(true);
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
			// 复制这类「无视觉结果」的动作不关菜单（用户可能接着复制另一项）
			if (entry.id !== 'copy-prompt' && entry.id !== 'copy-src') onClose();
		},
		[onClose],
	);

	const nav = useMenuNav({ ids, isDisabled, onChoose: choose, onClose });
	useMenuDismiss({ menuRef, onClose });
	useMenuFocus(menuRef);

	// 量到真实尺寸后把菜单夹进视口：在画布右下角右键最容易把菜单顶到屏幕外
	useEffect(() => {
		const el = menuRef.current;
		if (el === null) return;
		const rect = el.getBoundingClientRect();
		setPos(clampToViewport(at, { w: rect.width, h: rect.height }));
	}, [at]);

	return (
		<div
			ref={menuRef}
			className="ffc-menu ffc-node-menu"
			// 画布视口靠这个属性认「这是菜单自己」（P21：否则 pointerdown 会把菜单
			// 卸载掉，菜单项永远收不到 click）。新菜单记得一起带上。
			data-ffc-menu="true"
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
			{copyFailed ? <div className="ffc-menu-note">操作没成功，请手动重试</div> : null}
		</div>
	);
}
