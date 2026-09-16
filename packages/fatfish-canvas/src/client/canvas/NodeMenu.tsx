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
import {
	hasRegenerateTarget,
	referenceOf,
	REFERENCE_FALLBACK_PROMPT,
	regenerate,
} from './regenerate';
import { removeNodes } from './store';
import { nodeRatio, type CanvasNode } from './model';

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
				const via = await regenerate(
					prompt === '' ? REFERENCE_FALLBACK_PROMPT : prompt,
					node.kind,
					nodeRatio(node),
					reference ?? undefined,
				);
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
