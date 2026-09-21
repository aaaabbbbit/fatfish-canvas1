/**
 * 空白处右键菜单 —— 新建节点。
 *
 * 为什么是右键而不是顶栏再塞两个按钮：顶栏已经满了（全选 / 删除 / 适应 / 跟焦 /
 * 清空 / 宽度 / 纯画布），而「在画布的**这个位置**放一个节点」本来就该从画布上发起
 * —— 菜单开在指针处，新节点就落在指针处。行为、外观与键盘导航都复用节点右键菜单
 * 那一套（`menu.ts`）。
 *
 * @module fatfish-canvas/client/canvas/CanvasMenu
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { clampToViewport, useMenuDismiss, useMenuFocus, useMenuNav } from '../menu';
import type { Point } from './model';
import { addNodes } from './store';

/** 新建文字节点的默认尺寸（世界坐标）。 */
export const NEW_TEXT_SIZE = { w: 260, h: 120 };
/** 新建生成节点的默认尺寸（世界坐标）。生成节点是正方形：比例跟着节点形状走。 */
export const NEW_GEN_SIZE = { w: 280, h: 280 };

/** 菜单属性。 */
export interface CanvasMenuProps {
	/** 打开位置（视口坐标，`position: fixed` 用的就是它）。 */
	at: { x: number; y: number };
	/** 打开位置对应的世界坐标（新节点落在这里）。 */
	world: Point;
	/** 关闭。 */
	onClose: () => void;
}

/** 一个菜单条目。 */
interface Entry {
	id: string;
	label: string;
	/** 一句说明（新用户不知道这两个节点是干什么的）。 */
	note: string;
	run: () => void;
}

/**
 * 空白处右键菜单。
 * @param props - 位置与关闭回调。
 * @returns 浮层菜单。
 */
export function CanvasMenu({ at, world, onClose }: CanvasMenuProps): ReactNode {
	const menuRef = useRef<HTMLDivElement | null>(null);
	const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

	/** 以世界坐标为中心落一个节点。 */
	const place = useCallback(
		(size: { w: number; h: number }) => ({
			x: Math.round(world.x - size.w / 2),
			y: Math.round(world.y - size.h / 2),
			...size,
		}),
		[world.x, world.y],
	);

	const entries: Entry[] = useMemo(
		() => [
			{
				id: 'text',
				label: '新建文字节点',
				note: '双击可以写内容，写完连到生成节点上当提示词',
				run: () => {
					addNodes([{ kind: 'text', status: 'ready', title: '', prompt: '', ...place(NEW_TEXT_SIZE) }]);
				},
			},
			{
				id: 'gen',
				label: '新建生成节点',
				note: '把文字与图片连过来，再点顶栏「运行」',
				run: () => {
					addNodes([{ kind: 'gen', status: 'ready', title: '生成节点', ...place(NEW_GEN_SIZE) }]);
				},
			},
		],
		[place],
	);

	const entriesRef = useRef(entries);
	entriesRef.current = entries;
	const ids = useMemo(() => entries.map((entry) => entry.id), [entries]);
	const choose = useCallback(
		(id: string) => {
			const entry = entriesRef.current.find((item) => item.id === id);
			if (entry === undefined) return;
			entry.run();
			onClose();
		},
		[onClose],
	);
	const noneDisabled = useCallback(() => false, []);

	const nav = useMenuNav({ ids, isDisabled: noneDisabled, onChoose: choose, onClose });
	useMenuDismiss({ menuRef, onClose });
	useMenuFocus(menuRef);

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
			// 见 NodeMenu 里的说明：画布视口靠这个属性认「这是菜单自己」
			data-ffc-menu="true"
			role="menu"
			aria-label="新建节点"
			tabIndex={-1}
			style={{ left: `${String((pos ?? at).x)}px`, top: `${String((pos ?? at).y)}px` }}
			onKeyDown={nav.onKeyDown}
			{...nav.containerProps}
		>
			<div className="ffc-menu-label">新建节点</div>
			{entries.map((entry) => (
				<button
					key={entry.id}
					type="button"
					role="menuitem"
					className="ffc-menu-item"
					title={entry.note}
					onClick={() => {
						choose(entry.id);
					}}
					{...nav.itemProps(entry.id)}
				>
					<span className="ffc-menu-check" />
					<span>{entry.label}</span>
				</button>
			))}
			<div className="ffc-menu-note">
				{entries.map((entry) => entry.note).join('；')}
			</div>
		</div>
	);
}
