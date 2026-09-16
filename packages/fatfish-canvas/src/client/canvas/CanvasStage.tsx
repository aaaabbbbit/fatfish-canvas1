/**
 * 画布视口与交互层 —— P1 的核心。
 *
 * 交互语义参照 jaaz（其画布建立在 Excalidraw 之上），并保持一致的映射：
 *
 *   平移   Space + 拖拽 ／ 中键拖拽
 *   缩放   Ctrl(⌘) + 滚轮（以光标为锚点）／ 左下角 − + 与百分比按钮
 *   滚动   滚轮 = 纵向平移，Shift + 滚轮 = 横向平移（Excalidraw 同款）
 *   选择   单击选中 · Shift 单击加选/减选 · 空白处拖拽 = 框选
 *   移动   拖拽节点（多选时整组移动）· 方向键微调 1px，Shift 为 10px
 *   删除   Delete / Backspace · Esc 取消选择 · Ctrl(⌘)+A 全选
 *
 * 键盘处理刻意挂在**画布元素自身**（tabIndex=0）而不是 window 上：
 * 右侧就是聊天输入框，若监听 window，用户在聊天里按 Delete 会误删画布节点。
 * 点一下画布即获得焦点，之后键盘才作用于画布。
 *
 * @module fatfish-canvas/client/canvas/CanvasStage
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import {
	boundsOf,
	rectFromPoints,
	rectsIntersect,
	snapMove,
	SNAP_TOLERANCE_PX,
	toScreen,
	toWorld,
	zoomAround,
	type Guide,
	type Point,
	type Rect,
	type Viewport,
} from './model';
import {
	bringToFront,
	clearSelection,
	nodeRect,
	patchNodes,
	removeNodes,
	setSelection,
	setViewport,
	subscribeNodeAdditions,
	translateNodes,
	useBoard,
} from './store';
import {
	fitAll as fitAllAction,
	focusNodes,
	reportViewportSize,
	subscribeViewportActions,
	zoomByPoints,
	zoomToPercent,
} from './actions';
import {
	clearFocus,
	decideFollow,
	FOLLOW_RETRY_STEP_MS,
	peekFocus,
	queueFocus,
} from './follow';
import { getFollowNewNodes, useViewMode } from '../state';
import { attachImageToComposer, insertIntoComposer, isComposerFocused, isEditableTarget } from '../dom';
import { getProbeFace } from '../index';
import { nodeClickIntent } from './clickintent';

/**
 * 把画布上的一张图送到聊天框：**优先做成真正的图片附件**，取不到字节才退回插地址。
 *
 * 三条分支：
 *   1. `data:` 地址（拖进画布的本地图）→ 浏览器直接还原成 File，不需要任何宿主往返；
 *   2. `http(s)` 地址（生成结果，常常跨域）→ 请**宿主**代取字节（无 CORS 限制），
 *      拿回 data URL 再还原成 File；
 *   3. 取不到（探测服务还没就绪 / 地址不可达 / 图超过 8MB）→ 把地址当文本插进输入框，
 *      并如实说明原因（用户至少拿到一个模型看得懂的地址，而不是无声失败）。
 *
 * 为什么第 2 步绕一趟宿主：见 `client/dom.ts` 的 `attachImageToComposer` 与
 * `host/probe.ts` 的 `fetchImage` —— 复用平台附件管线的前提是手里有**字节**。
 * @param url - 节点的媒体地址。
 * @returns 给用户看的一句提示。
 */
async function sendImageToComposer(url: string): Promise<string> {
	const attach = async (dataUrl: string, name: string): Promise<string | null> => {
		const outcome = attachImageToComposer(dataUrl, name);
		if (outcome.kind === 'attached') return '图片已作为附件放入聊天输入框';
		if (outcome.kind === 'failed') return null;
		return null;
	};

	if (url.startsWith('data:')) {
		// data URL（拖进画布的本地图、供应商回的内联图）：字节就在手上，
		// **不走宿主**。但只有真是图片才认——否则宿主那边至少会给出「这不是图片」
		// 的解释，而这里只会得到一个空失败。
		if (/^data:image\//i.test(url)) {
			const done = await attach(url, 'canvas-image.png');
			if (done !== null) return done;
		}
	} else if (/^https?:\/\//i.test(url)) {
		const probe = getProbeFace();
		if (probe !== undefined) {
			try {
				const raw = (await probe.fetchImage(url)) as {
					ok?: boolean;
					message?: string;
					dataUrl?: string;
					name?: string;
				};
				if (raw !== undefined && raw.ok === true && typeof raw.dataUrl === 'string') {
					const done = await attach(raw.dataUrl, raw.name ?? 'canvas-image.png');
					if (done !== null) return done;
				} else if (raw !== undefined && typeof raw.message === 'string') {
					// 宿主明确说了取不到（太大 / 不是图片 / 连不上）：退化成地址并转述原因
					if (insertIntoComposer(`${url}\n`)) return `${raw.message}（已插入图片地址）`;
					return raw.message;
				}
			} catch {
				/* 探针不可用：走下面的地址退路 */
			}
		}
	}

	if (insertIntoComposer(`${url}\n`)) return '图片地址已插入聊天输入框';
	return '没能送进聊天框（找不到输入框）';
}
import { NodeCard } from './NodeCard';
import { NodeMenu } from './NodeMenu';
import { ZoomControls } from './ZoomControls';

/** 当前正在进行的指针交互。 */
type Interaction =
	| { kind: 'idle' }
	| {
			kind: 'pan';
			start: Point;
			/** 按下时的屏幕坐标（判断「点空白」还是「拖拽平移」用它，不能用世界坐标）。 */
			startScreen: Point;
			origin: Viewport;
			moved: boolean;
	  }
	| { kind: 'box'; start: Point; current: Point; base: readonly string[]; additive: boolean }
	| {
			kind: 'move';
			/** 按下时的世界坐标（位移的**绝对**基准，见 onPointerMove）。 */
			start: Point;
			/** 按下时各节点自己的位置。 */
			base: readonly { id: string; x: number; y: number }[];
			/** 按下时整组的包围盒（吸附按整组算，组内相对位置不变）。 */
			rect: Rect;
			ids: readonly string[];
			/** 上一次真正写回的偏移（吸附后常常没有新变化，据此避免空提交）。 */
			offset: Point;
			moved: boolean;
	  };

/** 右键菜单的打开状态。 */
interface NodeMenuState {
	/** 目标节点 id。 */
	nodeId: string;
	/** 打开位置（视口坐标，`position: fixed` 用的就是它）。 */
	at: { x: number; y: number };
}

/**
 * 画布舞台。
 * @returns 视口元素（含世界层与屏幕层）。
 */
export function CanvasStage(): ReactNode {
	const board = useBoard();
	const viewportRef = useRef<HTMLDivElement | null>(null);
	const [size, setSize] = useState({ w: 0, h: 0 });
	const [interaction, setInteraction] = useState<Interaction>({ kind: 'idle' });
	const [spaceHeld, setSpaceHeld] = useState(false);
	/** 程序化移动视口期间的过渡动画开关（用户拖拽时绝不动画）。 */
	const [animating, setAnimating] = useState(false);
	/** 节点右键菜单（打开时才有值）。 */
	const [nodeMenu, setNodeMenu] = useState<NodeMenuState | null>(null);
	/** 「图片送聊天框」的即时提示文案（空 = 不显示；每次设置都会重播动画）。 */
	const [sentNotice, setSentNotice] = useState('');
	/** 拖动时命中的对齐辅助线（世界坐标，渲染时换算成屏幕坐标）。 */
	const [guides, setGuides] = useState<readonly Guide[]>([]);

	// 交互过程中要读最新值，但不应让回调因它们重建，因此放 ref。
	const viewportValue = useRef(board.viewport);
	viewportValue.current = board.viewport;
	const boardRef = useRef(board);
	boardRef.current = board;
	const interactionRef = useRef(interaction);
	interactionRef.current = interaction;
	/** 用户最后一次主动操作视口的时刻（自动跟焦的安静期用它判定）。 */
	const lastUserAt = useRef(0);

	/** 标记「用户刚刚操作过视口」，并立刻停掉过渡动画（拖拽必须跟手）。 */
	const noteUserInput = useCallback(() => {
		lastUserAt.current = Date.now();
		setAnimating((prev) => (prev ? false : prev));
	}, []);

	/**
	 * 右键：在节点上打开操作菜单，在空白处只吞掉浏览器默认菜单。
	 *
	 * 选中语义与拖拽一致 —— 右键目标是当前选择的一部分就保留整组，
	 * 否则先把选择收敛到这一个（这样「删除」永远符合直觉）。
	 */
	const onContextMenu = useCallback((event: unknown) => {
		const e = event as MouseEvent & { target: EventTarget; preventDefault(): void };
		e.preventDefault();
		const target = e.target;
		const el = target instanceof Element ? target.closest('.ffc-node') : null;
		if (el === null) {
			setNodeMenu(null);
			return;
		}
		const nodeId = el.getAttribute('data-node-id');
		if (nodeId === null || nodeId === '') return;
		const selection = boardRef.current.selection;
		if (!selection.includes(nodeId)) setSelection([nodeId]);
		setNodeMenu({ nodeId, at: { x: e.clientX, y: e.clientY } });
	}, []);

	/** 视口元素的屏幕原点（指针坐标要减掉它才落进画布坐标系）。 */
	const screenOf = useCallback((clientX: number, clientY: number): Point => {
		const rect = viewportRef.current?.getBoundingClientRect();
		if (rect === undefined) return { x: clientX, y: clientY };
		return { x: clientX - rect.left, y: clientY - rect.top };
	}, []);

	// ── 尺寸观测：fit / 缩放锚点 / 居中都需要真实尺寸 ──
	//
	// ⚠️ 除了 ResizeObserver，还要**跟着模式变化主动补测一次**（下一帧）。
	//
	// 为什么：画布面板的宽度由 `body[data-ffc-mode]` 上的 CSS 决定，而切模式是
	// 「先改字节属性、再等浏览器重排」—— ResizeObserver 的回调有可能在重排
	// **之前**的那一帧就用旧几何量了一次（元素刚挂载时尤其容易），于是
	// `reportViewportSize` / `size` 里留着 0 或旧宽度，画布看起来「空的」，
	// 刷新（重新走一遍完整布局）才恢复正常 —— 正是用户报的那个现象。
	// 主动补测一次的成本是一次 getBoundingClientRect，代价可以忽略。
	const measure = useCallback((): void => {
		const el = viewportRef.current;
		if (el === null) return;
		const rect = el.getBoundingClientRect();
		// 同步上报给视图动作模块：工具条/菜单的「适应内容」用的就是这份尺寸，
		// 否则它们只能自己再测一遍（或拿不到尺寸而静默失效）。
		reportViewportSize({ w: rect.width, h: rect.height });
		setSize((prev) =>
			prev.w === rect.width && prev.h === rect.height ? prev : { w: rect.width, h: rect.height },
		);
	}, []);

	useEffect(() => {
		const el = viewportRef.current;
		if (el === null) return undefined;
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => {
			observer.disconnect();
			reportViewportSize({ w: 0, h: 0 });
		};
	}, [measure]);

	/** 当前视图模式：切模式会改面板宽度（CSS 属性），需要重测。 */
	const viewMode = useViewMode();
	useEffect(() => {
		const raf = requestAnimationFrame(measure);
		return () => {
			cancelAnimationFrame(raf);
		};
	}, [viewMode, measure]);

	// ── 程序化移动 → 一小段过渡动画 ──
	// 跟焦与适应内容是「跳到别处」，瞬移会让人丢失空间感；用户自己拖拽/滚轮
	// 则必须跟手，因此动画只挂在程序化移动上，且一有用户输入就立刻撤掉。
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | null = null;
		const off = subscribeViewportActions((reason) => {
			if (reason === 'zoom') return;
			setAnimating(true);
			if (timer !== null) clearTimeout(timer);
			timer = setTimeout(() => {
				setAnimating(false);
			}, 260);
		});
		return () => {
			off();
			if (timer !== null) clearTimeout(timer);
		};
	}, []);

	// ── 自动跟焦：新落下的节点带进视野 ──
	// 策略见 follow.ts：开关、忙碌、安静期三闸；这里只负责「什么时候试」。
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | null = null;
		const attempt = (): void => {
			const pending = peekFocus();
			if (pending === null) return;
			const now = Date.now();
			const action = decideFollow({
				enabled: getFollowNewNodes(),
				busy: interactionRef.current.kind !== 'idle',
				sinceUserMs: now - lastUserAt.current,
				queuedMs: now - pending.at,
			});
			if (action === 'skip') {
				clearFocus();
				return;
			}
			if (action === 'queue') {
				timer = setTimeout(attempt, FOLLOW_RETRY_STEP_MS);
				return;
			}
			clearFocus();
			focusNodes([...pending.ids]);
		};
		const schedule = (): void => {
			if (timer !== null) clearTimeout(timer);
			timer = setTimeout(attempt, 0);
		};
		const off = subscribeNodeAdditions((created) => {
			queueFocus(created.map((node) => node.id));
			schedule();
		});
		// 挂载时消费一次：进入画布模式**之前**落下的节点也算「新」的，
		// 否则用户切过来只会看到一块空画布，还得自己找。
		schedule();
		return () => {
			off();
			if (timer !== null) clearTimeout(timer);
		};
	}, []);

	// ── 滚轮：必须非被动监听才能 preventDefault，因此手工挂原生事件 ──
	useEffect(() => {
		const el = viewportRef.current;
		if (el === null) return undefined;

		const onWheel = (event: WheelEvent): void => {
			event.preventDefault();
			noteUserInput();
			setNodeMenu(null);
			setGuides([]);
			const anchor = screenOf(event.clientX, event.clientY);
			const vp = viewportValue.current;

			// Shift + 滚轮 = 横向平移（唯一保留给平移的滚轮分支）
			if (event.shiftKey && !event.ctrlKey && !event.metaKey) {
				setViewport({ ...vp, x: vp.x + event.deltaY / vp.zoom });
				return;
			}

			// 默认：以光标为锚点缩放。
			// Ctrl(⌘) + 滚轮走同一条路 —— 触控板捏合手势正是以此形式到达的。
			const factor = Math.exp(-event.deltaY * 0.0015);
			setViewport(zoomAround(vp, anchor, vp.zoom * factor));
		};

		el.addEventListener('wheel', onWheel, { passive: false });
		return () => {
			el.removeEventListener('wheel', onWheel);
		};
	}, [screenOf, noteUserInput]);

	// ── Space 键：平移修饰键。挂在 window 上但只在画布聚焦时生效 ──
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.code !== 'Space') return;
			const el = viewportRef.current;
			if (el === null || document.activeElement !== el) return;
			if (isEditableTarget(event.target)) return;
			event.preventDefault();
			setSpaceHeld(true);
		};
		const onKeyUp = (event: KeyboardEvent): void => {
			if (event.code === 'Space') setSpaceHeld(false);
		};
		// 失焦/切窗口时必须复位，否则会卡在平移态
		const onBlur = (): void => {
			setSpaceHeld(false);
		};
		window.addEventListener('keydown', onKeyDown);
		window.addEventListener('keyup', onKeyUp);
		window.addEventListener('blur', onBlur);
		return () => {
			window.removeEventListener('keydown', onKeyDown);
			window.removeEventListener('keyup', onKeyUp);
			window.removeEventListener('blur', onBlur);
		};
	}, []);

	// ── 指针交互 ──

	const onPointerDown = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			const el = viewportRef.current;
			if (el === null) return;
			// 任何指针交互都先收起右键菜单（右键本身也会走到这里）
			setNodeMenu(null);
			setGuides([]);
			// 只处理左键与中键
			if (event.button !== 0 && event.button !== 1) return;

			// 视口内的交互控件（缩放条按钮、播放按钮、链接…）自己处理指针，视口不得抢。
			// 这是必须的一道闸：下面的 setPointerCapture 会把后续 pointerup 与
			// 随之而来的 click 全部改派给「捕获元素」，于是按钮的 onClick 永不触发。
			const target = event.target;
			if (
				target instanceof Element &&
				target.closest('button, a, input, select, textarea, [data-ffc-ui]') !== null
			) {
				return;
			}

			el.focus({ preventScroll: true });
			noteUserInput();

			const point = screenOf(event.clientX, event.clientY);
			event.currentTarget.setPointerCapture(event.pointerId);

			// Shift + 左键 = 框选。
			// 选择必须带修饰键，否则会与「拖拽 = 平移」这个主手势抢指针。
			const boxSelect = event.button === 0 && event.shiftKey && !spaceHeld;
			if (boxSelect) {
				setInteraction({
					kind: 'box',
					start: point,
					current: point,
					base: boardRef.current.selection,
					additive: true,
				});
				return;
			}

			// 默认：左键拖拽 = 平移（无限画布的主流预期）；中键 / Space + 拖拽同理。
			setInteraction({
				kind: 'pan',
				start: point,
				startScreen: { x: event.clientX, y: event.clientY },
				origin: viewportValue.current,
				moved: false,
			});
		},
		[screenOf, spaceHeld, noteUserInput],
	);

	const onPointerMove = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			if (interaction.kind === 'idle') return;
			const point = screenOf(event.clientX, event.clientY);

			if (interaction.kind === 'pan') {
				const zoom = interaction.origin.zoom;
				setViewport({
					...interaction.origin,
					x: interaction.origin.x - (point.x - interaction.start.x) / zoom,
					y: interaction.origin.y - (point.y - interaction.start.y) / zoom,
				});
				if (!interaction.moved) setInteraction({ ...interaction, moved: true });
				return;
			}

			if (interaction.kind === 'box') {
				const next: Interaction = { ...interaction, current: point };
				setInteraction(next);
				const worldRect = rectFromPoints(
					toWorld(interaction.start, viewportValue.current),
					toWorld(point, viewportValue.current),
				);
				const hits = boardRef.current.nodes
					.filter((node) => rectsIntersect(worldRect, { x: node.x, y: node.y, w: node.w, h: node.h }))
					.map((node) => node.id);
				setSelection(
					interaction.additive
						? [...new Set([...interaction.base, ...hits])]
						: hits,
				);
				return;
			}

			if (interaction.kind === 'move') {
				const vp = viewportValue.current;
				const world = toWorld(point, vp);
				// 位移按「相对按下点的绝对值」算，而不是按上一帧的增量累加 ——
				// 吸附会把位置吸走一段，增量式累加会让这段修正留在下一次移动里
				// （表现为节点黏在吸附线上、甩不开）。
				let dx = world.x - interaction.start.x;
				let dy = world.y - interaction.start.y;
				const moving: Rect = {
					x: interaction.rect.x + dx,
					y: interaction.rect.y + dy,
					w: interaction.rect.w,
					h: interaction.rect.h,
				};
				const mine = new Set(interaction.ids);
				const others = boardRef.current.nodes
					.filter((node) => !mine.has(node.id))
					.map(nodeRect);
				// Alt = 临时关掉吸附（要精确挪几像素时用）。容差用屏幕像素折算，
				// 这样「差一点点」的手感不随缩放变化。
				const snap = event.altKey
					? { dx: 0, dy: 0, guides: [] as readonly Guide[] }
					: snapMove(moving, others, SNAP_TOLERANCE_PX / vp.zoom);

				if (dx + snap.dx === interaction.offset.x && dy + snap.dy === interaction.offset.y) {
					return; // 位置没变（吸附住了）：不要再写一次 store
				}
				dx += snap.dx;
				dy += snap.dy;

				const updates = new Map<string, { x: number; y: number }>();
				for (const item of interaction.base) {
					updates.set(item.id, { x: item.x + dx, y: item.y + dy });
				}
				patchNodes(updates);
				setGuides(snap.guides);
				setInteraction({ ...interaction, offset: { x: dx, y: dy }, moved: true });
			}
		},
		[interaction, screenOf],
	);

	const onPointerUp = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			if (event.currentTarget.hasPointerCapture(event.pointerId)) {
				event.currentTarget.releasePointerCapture(event.pointerId);
			}
			if (interaction.kind === 'box') {
				const moved =
					Math.abs(interaction.current.x - interaction.start.x) > 3 ||
					Math.abs(interaction.current.y - interaction.start.y) > 3;
				// 没真的拖出框 = 点空白，等价于取消选择
				if (!moved && !interaction.additive) clearSelection();
			} else if (
				interaction.kind === 'pan' &&
				// 点空白（平移手势里没真的移动）= 取消选择。
				// 门槛比框选的 3px 宽一点：拖拽平移会先产生一两像素的抖动，
				// 那不该被当成「点空白」而清掉用户刚选好的一组节点。
				Math.abs(event.clientX - interaction.startScreen.x) <= 5 &&
				Math.abs(event.clientY - interaction.startScreen.y) <= 5
			) {
				clearSelection();
			}
			setInteraction({ kind: 'idle' });
			setGuides([]);
		},
		[interaction],
	);

	/** 节点上的按下：负责选中语义并发起整组移动。 */
	const onNodePointerDown = useCallback(
		(event: unknown, nodeId: string) => {
			const e = event as ReactPointerEvent<HTMLDivElement>;
			if (e.button !== 0) return;
			// 阻止冒泡，否则会同时在空白层开始框选
			e.stopPropagation();

			// 「正在往聊天框里打字」时点图片 = 把这张图送到聊天框（用户明确要的手感：
			// 光标已经在输入框里，此时点图不该是搬运节点，而是引用它）。
			// 判据见 clickintent.ts（纯函数，有真值表测试）。
			const node = boardRef.current.nodes.find((item) => item.id === nodeId);
			const url = node?.src === undefined || node.src === '' ? null : node.src;
			const intent = nodeClickIntent({
				mediaUrl: url,
				composerFocused: isComposerFocused(),
			});
			if (intent.kind === 'send-to-composer' && url !== null) {
				setSentNotice('正在取图…');
				void sendImageToComposer(url).then((text) => {
					setSentNotice(text);
				});
				return;
			}

			const el = viewportRef.current;
			if (el === null) return;
			el.focus({ preventScroll: true });
			noteUserInput();

			const current = boardRef.current.selection;
			let next: readonly string[];
			if (e.shiftKey) {
				next = current.includes(nodeId)
					? current.filter((id) => id !== nodeId)
					: [...current, nodeId];
				setSelection(next);
				if (!next.includes(nodeId)) return; // Shift 取消选中后不进入拖拽
			} else if (!current.includes(nodeId)) {
				next = [nodeId];
				setSelection(next);
			} else {
				next = current;
			}

			bringToFront(next);
			const group = boardRef.current.nodes.filter((node) => next.includes(node.id));
			const bounds = boundsOf(group);
			if (bounds === null) return;
			el.setPointerCapture(e.pointerId);
			setInteraction({
				kind: 'move',
				start: toWorld(screenOf(e.clientX, e.clientY), viewportValue.current),
				base: group.map((node) => ({ id: node.id, x: node.x, y: node.y })),
				rect: bounds,
				ids: next,
				offset: { x: 0, y: 0 },
				moved: false,
			});
		},
		[screenOf, noteUserInput],
	);

	// ── 键盘快捷键（只在画布聚焦时） ──

	const onKeyDown = useCallback(
		(event: unknown) => {
			const e = event as KeyboardEvent & { preventDefault: () => void };
			if (isEditableTarget(e.target)) return;
			const selection = boardRef.current.selection;
			const mod = e.ctrlKey || e.metaKey;

			if (e.key === 'Escape') {
				clearSelection();
				return;
			}
			if (mod && (e.key === 'a' || e.key === 'A')) {
				e.preventDefault();
				setSelection(boardRef.current.nodes.map((node) => node.id));
				return;
			}
			if (e.key === 'Delete' || e.key === 'Backspace') {
				if (selection.length === 0) return;
				e.preventDefault();
				removeNodes(selection);
				return;
			}
			const step = e.shiftKey ? 10 : 1;
			const nudges: Record<string, Point> = {
				ArrowLeft: { x: -step, y: 0 },
				ArrowRight: { x: step, y: 0 },
				ArrowUp: { x: 0, y: -step },
				ArrowDown: { x: 0, y: step },
			};
			const nudge = nudges[e.key];
			if (nudge !== undefined && selection.length > 0) {
				e.preventDefault();
				translateNodes(selection, nudge.x, nudge.y);
			}
		},
		[],
	);

	// ── 缩放控件动作 ──
	// jaaz 的 CanvasViewMenu 用 10 个百分点的加法步进（100% → 110% → 120%），
	// 而不是乘法步进；这里保持一致。锚点取视口中心，避免按钮缩放时内容漂移。
	//
	// 实现放在 `actions.ts`：工具条里的「适应内容」按钮与这里的缩放条必须走
	// **同一份**算法，否则留白/锚点会悄悄漂移成两套。

	/** 一档 = 10 个百分点。 */
	const ZOOM_STEP_POINTS = 0.1;

	const zoomStep = useCallback((delta: number) => {
		noteUserInput();
		zoomByPoints(delta);
	}, [noteUserInput]);

	const zoomToPercentAndNotify = useCallback(
		(percent: number) => {
			noteUserInput();
			zoomToPercent(percent);
		},
		[noteUserInput],
	);

	const fitAll = useCallback(() => {
		noteUserInput();
		fitAllAction();
	}, [noteUserInput]);

	// 首次挂载且画布为空时，把世界原点放到视口中心附近，避免新节点落在角落
	const initialised = useRef(false);
	useEffect(() => {
		if (initialised.current || size.w === 0) return;
		initialised.current = true;
		if (boardRef.current.nodes.length === 0) {
			setViewport({ x: -size.w / 3, y: -size.h / 3, zoom: 1 });
		}
	}, [size.w]);

	const selected = new Set(board.selection);
	const boxRect: Rect | null =
		interaction.kind === 'box' && interaction.current !== interaction.start
			? rectFromPoints(interaction.start, interaction.current)
			: null;

	const cursor = spaceHeld || interaction.kind === 'pan' ? 'grab' : 'default';
	const worldTransform = `translate(${String(-board.viewport.x * board.viewport.zoom)}px, ${String(
		-board.viewport.y * board.viewport.zoom,
	)}px) scale(${String(board.viewport.zoom)})`;

	return (
		<div
			ref={viewportRef}
			className="ffc-viewport"
			tabIndex={0}
			role="application"
			aria-label="无限画布"
			style={{ cursor }}
			data-interaction={interaction.kind}
			data-anim={animating ? 'true' : undefined}
			data-node-count={String(board.nodes.length)}
			data-guide-count={String(guides.length)}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerUp}
			onKeyDown={onKeyDown}
			onContextMenu={onContextMenu}
		>
			<div className="ffc-world" style={{ transform: worldTransform }}>
				{board.nodes.map((node) => (
					<NodeCard
						key={node.id}
						node={node}
						selected={selected.has(node.id)}
						onPointerDown={onNodePointerDown}
						onRemove={(id) => {
							removeNodes([id]);
						}}
					/>
				))}
			</div>

			{boxRect !== null ? (
				<div
					className="ffc-marquee"
					style={{
						left: `${String(boxRect.x)}px`,
						top: `${String(boxRect.y)}px`,
						width: `${String(boxRect.w)}px`,
						height: `${String(boxRect.h)}px`,
					}}
				/>
			) : null}

			{/* 对齐辅助线：画在**屏幕层**而不是世界层 —— 1px 的虚线若跟着
			    scale(zoom) 走，放大后会变成一条 4px 的粗带（虚线本身也会被拉伸）。
			    这里把世界坐标换算成屏幕坐标，线宽与虚线间距始终是屏幕上的那一份。 */}
			{guides.map((guide) => {
				const vp = board.viewport;
				const start = toScreen(
					guide.axis === 'x' ? { x: guide.position, y: guide.from } : { x: guide.from, y: guide.position },
					vp,
				);
				const length = (guide.to - guide.from) * vp.zoom;
				return (
					<div
						key={`${guide.axis}:${String(guide.position)}`}
						className={`ffc-guide ffc-guide-${guide.axis}`}
						data-guide={guide.axis}
						style={
							guide.axis === 'x'
								? { left: `${String(start.x)}px`, top: `${String(start.y)}px`, height: `${String(length)}px` }
								: { left: `${String(start.x)}px`, top: `${String(start.y)}px`, width: `${String(length)}px` }
						}
					/>
				);
			})}

			{board.nodes.length === 0 ? (
				<div className="ffc-placeholder">
					<span className="ffc-placeholder-title">画布已就绪</span>
					<span className="ffc-placeholder-hint">
						拖拽平移 · 滚轮缩放 · Shift + 拖拽框选 · 点节点选中、拖动可移动。
						生成结果会作为节点落到这里。
					</span>
					{/* 空态是唯一「用户还没东西可点」的时刻，正好用来教右键菜单 */}
					<span className="ffc-placeholder-hint ffc-node-hint">
						节点上点右键：带到视野 · 复制提示词 · 重新生成 · 删除
					</span>
				</div>
			) : null}

			{/* 「图片已送进聊天框」的即时反馈：光标在输入框里时点图会把地址插进去，
			    没有这条提示的话用户只看得到输入框里多了一行字，不知道是画布干的。
			    用 aria-live 而不是 toast 系统：一行文字就够，不值得为它引一套浮层。 */}
			{sentNotice !== '' ? (
				<div className="ffc-sent-notice" role="status" aria-live="polite" key={sentNotice}>
					{sentNotice}
				</div>
			) : null}

			<ZoomControls				zoom={board.viewport.zoom}
				nodeCount={board.nodes.length}
				selectedCount={board.selection.length}
				onZoomIn={() => {
					zoomStep(ZOOM_STEP_POINTS);
				}}
				onZoomOut={() => {
					zoomStep(-ZOOM_STEP_POINTS);
				}}
				onZoomTo={zoomToPercentAndNotify}
				onReset={() => {
					zoomToPercentAndNotify(100);
				}}
				onFit={fitAll}
			/>

			{/* 节点右键菜单：`position: fixed` + 视口夹紧，因此不会被视口的
			    overflow 裁掉（fixed 的包含块是视口，不是这个 overflow 容器）。 */}
			{nodeMenu !== null
				? (() => {
						const node = board.nodes.find((item) => item.id === nodeMenu.nodeId);
						if (node === undefined) return null;
						return (
							<NodeMenu
								key={`${nodeMenu.nodeId}@${String(nodeMenu.at.x)},${String(nodeMenu.at.y)}`}
								node={node}
								selection={board.selection}
								at={nodeMenu.at}
								onClose={() => {
									setNodeMenu(null);
								}}
							/>
						);
					})()
				: null}
		</div>
	);
}
