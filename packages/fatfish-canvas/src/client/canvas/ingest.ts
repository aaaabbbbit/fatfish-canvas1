/**
 * 生成结果 → 画布节点（P3 的核心连线）。
 *
 * 数据的来路：宿主 `tool.ts` 把结果写进 `output.presentationMeta`，
 * 它随 `tool/result` 会话事件到达浏览器，落在会话快照的
 * `nodes[].meta` 上；一次生成的**开始**则体现在快照的 `runningCalls` 里。
 * 因此这里不需要任何新的 RPC 面 —— 只是把一个已经存在的只读快照
 * 翻译成画布动作。
 *
 * 三条不变量（都有测试钉住）：
 *
 * 1. **先落 pending，再改状态**：结果到达前就有节点，用户等待时看得见
 *    「在画什么」；结果到达时只改状态与 src，节点不跳位。
 * 2. **幂等**：节点 id 由 callId 派生，且处理过的 callId 记在 store 里，
 *    因此重复快照不会造重复节点、用户删掉的节点也不会被历史重放复活。
 * 3. **只吃新的**：快照里躺着整段会话历史，因此只接受
 *    「seq 比本会话基线新」或「时间戳在新鲜窗口内」的结果 ——
 *    否则每次打开一个老会话都会把它的历史生成重新铺到画布上。
 *
 * 本模块的纯计划部分是**可单测的**（无 DOM、无 React），
 * 真正改 store 的只有 `syncConversation` 一个函数。
 *
 * @module fatfish-canvas/client/canvas/ingest
 */

import {
	MEDIA_COMMAND_NAME,
	MEDIA_TOOL_NAME,
	mediaCommandNodeId,
	mediaNodeId,
	mediaNodeSize,
	mediaUrlFromCommandText,
	parseGenerateLine,
	parseMediaCallArgs,
	readMediaPresentation,
	type MediaPresentation,
} from '../shared/media';
import { nextPlacement, type CanvasNode, type NodeKind } from './model';
import { addNodes, getBoard, markIngested, patchNodes } from './store';

// ─────────────────── 会话快照的结构面 ───────────────────
//
// 刻意只声明**用得到的那几个字段**，而不是导入 dsh-client-runtime 的类型包：
// 本插件对客户端运行时零依赖（统一基座之外没有 external），而这两个类型
// 也不在统一基座里。

/** `tool/result` 折叠出来的会话节点（只声明本模块读取的字段）。 */
export interface ConversationNodeLike {
	/** 节点种类；只有 `tool-result` 关心。 */
	kind?: string | undefined;
	/** 日志序号（用于判定「这是新事件」）。 */
	seq?: number | undefined;
	/** 事件时间戳（毫秒）。 */
	time?: number | undefined;
	/** 工具调用 id。 */
	callId?: string | undefined;
	/** 配对的调用头（窗口截断时可能为 null）。 */
	call?: { name: string; argsRaw: string } | null | undefined;
	/** 结果是否为失败。 */
	isError?: boolean | undefined;
	/** 宿主写下的呈现 meta。 */
	meta?: unknown;
	/** 结果内容块。 */
	content?: readonly unknown[] | undefined;
	/** 命令的配对 id（`command/run` ↔ `command/done`）。 */
	commandId?: string | undefined;
	/** 命令名（不带斜杠）；窗口截断时为 null。 */
	name?: string | null | undefined;
	/** 命令的原文参数（`command/run` 的 `args`）。 */
	args?: string | null | undefined;
	/** 命令结果；null = 还在执行。 */
	outcome?: { kind: 'success' | 'error'; text?: string } | null | undefined;
}

/** 仍在进行中的工具调用。 */
export interface RunningCallLike {
	/** 调用 id。 */
	callId: string;
	/** 工具名。 */
	name: string;
	/** 原始参数 JSON。 */
	argsRaw: string;
}

/** 会话快照里本模块读取的那一面。 */
export interface ConversationLike {
	/** 已完成的会话节点。 */
	nodes?: readonly ConversationNodeLike[] | undefined;
	/** 进行中的工具调用。 */
	runningCalls?: readonly RunningCallLike[] | undefined;
}

/** 视为「刚刚发生」的时间窗口：超出它的历史结果不再落图。 */
export const INGEST_FRESH_MS = 10 * 60 * 1000;

/** `markIngested` 的记账上限（只保留最近的一批 callId）。 */
export const INGEST_LEDGER_MAX = 400;

/** 一次同步的结果（诊断与测试用）。 */
export interface IngestReport {
	/** 新建的节点数。 */
	created: number;
	/** 从 pending 改成 ready / failed 的节点数。 */
	resolved: number;
	/** 其中失败的数量。 */
	failed: number;
}

/** 空报告（无变化时复用，避免每次快照都分配）。 */
const NO_CHANGE: IngestReport = { created: 0, resolved: 0, failed: 0 };

// ─────────────────────── 快照筛选 ───────────────────────

/**
 * 挑出进行中的媒体生成调用。
 * @param snapshot - 会话快照。
 * @returns 工具名为 `media_generate` 的进行中调用。
 */
export function runningMediaCalls(snapshot: ConversationLike): RunningCallLike[] {
	const list = snapshot.runningCalls ?? [];
	return list.filter((call) => call.name === MEDIA_TOOL_NAME);
}

/**
 * 把结果的内容块拼成一段文字（失败原因就藏在这里）。
 *
 * 真实形状是**两层**：`[{ type:'tool-result', content:[{ type:'text', text }] }]`
 * —— 外层是「这条消息里的工具结果块」，内层才是文本块。只扫一层会永远得到空串，
 * 于是失败节点上只能写「宿主没有给出原因」（本轮实测到的）。
 * 顺手剥掉宿主 `Error:` 前缀：那是 RPC 层的序列化痕迹，画在节点上只会占地方。
 * @param content - 结果消息的 `content`。
 * @returns 拼接后的文本（已裁剪长度）。
 */
export function textOfContent(content: readonly unknown[] | undefined): string {
	if (!Array.isArray(content)) return '';
	const parts: string[] = [];
	const take = (block: unknown): void => {
		if (block === null || typeof block !== 'object') return;
		const o = block as Record<string, unknown>;
		if (o.type === 'text' && typeof o.text === 'string') parts.push(o.text);
		// 内层：tool-result 块自己的 content
		if (Array.isArray(o.content)) for (const inner of o.content) take(inner);
	};
	for (const block of content) take(block);
	return parts.join('\n').replace(/^Error:\s*/, '').trim().slice(0, 300);
}

/** 一个已结束的媒体生成结果。 */
export interface SettledResult {
	/** 工具调用 id。 */
	callId: string;
	/** 日志序号。 */
	seq: number;
	/** 事件时间戳。 */
	time: number;
	/** 成功时的呈现负载。 */
	meta: MediaPresentation | null;
	/** 是否失败。 */
	isError: boolean;
	/** 失败原因（失败时）。 */
	error: string;
}

/**
 * 挑出已经出结果的媒体生成调用。
 * @param snapshot - 会话快照。
 * @returns 结果列表（按快照顺序）。
 */
export function settledMediaResults(snapshot: ConversationLike): SettledResult[] {
	const out: SettledResult[] = [];
	for (const node of snapshot.nodes ?? []) {
		if (node.kind !== 'tool-result') continue;
		// 工具名可能来自配对的调用头（正常情况），必要时用 meta 兜底 ——
		// 窗口截断会把 call 留成 null，而 meta 是结果自带的，一定在。
		const meta = readMediaPresentation(node.meta);
		const name = node.call?.name;
		if (name !== MEDIA_TOOL_NAME && meta === null) continue;
		if (typeof node.callId !== 'string' || node.callId === '') continue;

		const text = textOfContent(node.content);
		out.push({
			callId: node.callId,
			seq: typeof node.seq === 'number' ? node.seq : 0,
			time: typeof node.time === 'number' ? node.time : 0,
			meta,
			isError: node.isError === true || meta === null,
			error: text === '' ? '生成失败（宿主没有给出原因）' : text,
		});
	}
	return out;
}

// ─────────────────── `/generate` 命令（P6） ───────────────────
//
// 命令与工具是**两条入口、一条管线**（见 host/generate.ts）。落到客户端时，
// 它们折叠成两种不同的会话节点：
//   工具 → `tool-result`（结果带 presentationMeta）
//   命令 → `command`（run/done 折叠成 node，结果只有文本）
// 因此这里也读第二种，并把文本里的第一行当媒体地址 —— 那条约定写在
// `shared/media.ts`，两半边共用同一份实现，不是「客户端猜宿主的格式」。

/** 一个正在执行中的 `/generate` 命令。 */
export interface RunningCommand {
	/** 命令配对 id（幂等键）。 */
	commandId: string;
	/** 原文参数（含提示词与开关）。 */
	args: string;
}

/** 一个已结束的 `/generate` 命令。 */
export interface SettledCommand {
	/** 命令配对 id（幂等键）。 */
	commandId: string;
	/** 日志序号。 */
	seq: number;
	/** 事件时间戳。 */
	time: number;
	/** 原文参数。 */
	args: string;
	/** 是否成功。 */
	ok: boolean;
	/** 成功时的媒体地址。 */
	url: string | null;
	/** 失败原因（失败时）。 */
	error: string;
}

/**
 * 挑出属于本插件的命令节点。
 * @param snapshot - 会话快照。
 * @returns `name === generate` 的命令节点。
 */
function mediaCommandNodes(snapshot: ConversationLike): ConversationNodeLike[] {
	const out: ConversationNodeLike[] = [];
	for (const node of snapshot.nodes ?? []) {
		if (node.kind !== 'command') continue;
		// 名字可能因窗口截断缺失（只留下 done 事件）；拿不到名字就认不出是不是我们的
		if (node.name !== MEDIA_COMMAND_NAME) continue;
		if (typeof node.commandId !== 'string' || node.commandId === '') continue;
		out.push(node);
	}
	return out;
}

/**
 * 正在执行的 `/generate`（还没出结果）。
 * @param snapshot - 会话快照。
 * @returns 进行中的命令列表。
 */
export function runningMediaCommands(snapshot: ConversationLike): RunningCommand[] {
	const out: RunningCommand[] = [];
	for (const node of mediaCommandNodes(snapshot)) {
		if (node.outcome !== null && node.outcome !== undefined) continue;
		out.push({ commandId: node.commandId ?? '', args: typeof node.args === 'string' ? node.args : '' });
	}
	return out;
}

/**
 * 已结束的 `/generate`。
 * @param snapshot - 会话快照。
 * @returns 结果列表。
 */
export function settledMediaCommands(snapshot: ConversationLike): SettledCommand[] {
	const out: SettledCommand[] = [];
	for (const node of mediaCommandNodes(snapshot)) {
		const outcome = node.outcome;
		if (outcome === null || outcome === undefined) continue;
		const args = typeof node.args === 'string' ? node.args : '';
		const url = outcome.kind === 'success' ? mediaUrlFromCommandText(outcome.text) : null;
		const text = typeof outcome.text === 'string' ? outcome.text.replace(/^Error:\s*/, '').trim() : '';
		const ok = outcome.kind === 'success' && url !== null;
		// 失败原因分两种：命令自己报了错（原样转述），或命令"成功"但结果里
		// 取不到地址（那说明约定没被遵守 —— 说明白比只显示原文更有用）。
		const error = ok
			? ''
			: text === ''
				? '命令没有返回可用的媒体地址'
				: outcome.kind === 'success'
					? `命令没有返回可用的媒体地址：${text}`.slice(0, 300)
					: text.slice(0, 300);
		out.push({
			commandId: node.commandId ?? '',
			seq: typeof node.seq === 'number' ? node.seq : 0,
			time: typeof node.time === 'number' ? node.time : 0,
			args,
			ok,
			url,
			error,
		});
	}
	return out;
}

/**
 * 判定一个结果是否「够新」，值得落图。
 *
 * 两个通道任一成立即可：日志序号越过本会话基线（**实时到达**），
 * 或者时间戳落在新鲜窗口内（**刚打开页面**时补上刚刚完成的那一次）。
 * @param result - 已结束的结果（工具结果或命令结果都同形）。
 * @param baselineSeq - 首次观察该会话时的最大 seq。
 * @param now - 当前时间戳。
 * @param freshMs - 新鲜窗口。
 * @returns 是否落图。
 */
export function isFreshResult(
	result: Pick<SettledResult, 'seq' | 'time'>,
	baselineSeq: number,
	now: number,
	freshMs: number = INGEST_FRESH_MS,
): boolean {
	if (result.seq > baselineSeq) return true;
	if (result.time > 0 && now - result.time <= freshMs) return true;
	return false;
}

// ─────────────────────── 计划 → 动作 ───────────────────────

/** 待新建的节点（坐标已算好）。 */
type NodeSeed = Omit<CanvasNode, 'z' | 'createdAt'>;

/**
 * 计算 pending 节点要落在哪里：沿用 jaaz 的排布算法，
 * 并把本次**已经计划**的节点一起纳入（否则同一次同步里的多个节点会重叠）。
 * @param placed - 现有节点。
 * @param size - 新节点尺寸。
 * @returns 世界坐标左上角。
 */
function placeAmong(placed: readonly CanvasNode[], size: { w: number; h: number }): { x: number; y: number } {
	return nextPlacement(placed, size);
}

/**
 * 把一次会话的生成结果同步到画布上（工具与命令两条入口）。
 *
 * 两条入口各自读自己那类会话节点，但共用同一套落图规则与同一份记账：
 * 先跑工具，再跑命令；第二步重新读 board，因此**不会**把第一步刚落的节点
 * 再落一遍（`ingested` 已经记下了）。
 * @param snapshot - 会话快照。
 * @param sessionId - 会话 id（写到节点上，便于以后按会话隔离画布）。
 * @param options - `baselineSeq`（首次观察该会话时的最大 seq）与 `now`。
 * @returns 本次同步报告（两条入口的合计）。
 */
export function syncConversation(
	snapshot: ConversationLike,
	sessionId: string | undefined,
	options: { baselineSeq?: number; now?: number } = {},
): IngestReport {
	const tools = syncToolResults(snapshot, sessionId, options);
	const commands = syncCommands(snapshot, sessionId, options);
	return {
		created: tools.created + commands.created,
		resolved: tools.resolved + commands.resolved,
		failed: tools.failed + commands.failed,
	};
}

/**
 * 工具触发的生成（`media_generate`）→ 画布。
 *
 * 这是本模块**唯一**有副作用的函数：其余部分都是纯函数，可脱离浏览器单测。
 * @param snapshot - 会话快照。
 * @param sessionId - 会话 id（写到节点上，便于以后按会话隔离画布）。
 * @param options - `baselineSeq`（首次观察该会话时的最大 seq）与 `now`。
 * @returns 本次同步报告。
 */
function syncToolResults(
	snapshot: ConversationLike,
	sessionId: string | undefined,
	options: { baselineSeq?: number; now?: number } = {},
): IngestReport {
	if (snapshot === null || typeof snapshot !== 'object') return NO_CHANGE;
	const baselineSeq = options.baselineSeq ?? 0;
	const now = options.now ?? Date.now();

	const board = getBoard();
	const ingested = new Set(board.ingested);
	const known = new Set(board.nodes.map((node) => node.id));
	/** 本次同步中已经被占位的节点（含新建与将要新建的）。 */
	const placed: CanvasNode[] = [...board.nodes];

	const seeds: NodeSeed[] = [];
	const patches = new Map<string, Partial<Omit<CanvasNode, 'id'>>>();

	// ── 1. 进行中的调用 → pending 节点 ──
	for (const call of runningMediaCalls(snapshot)) {
		const id = mediaNodeId(call.callId);
		if (known.has(id) || ingested.has(id)) continue;
		const args = parseMediaCallArgs(call.argsRaw);
		const size = mediaNodeSize({ kind: args.kind, aspectRatio: args.aspectRatio });
		const at = placeAmong(placed, size);
		const seed: NodeSeed = {
			id,
			kind: args.kind as NodeKind,
			status: 'pending',
			...size,
			...at,
			title: args.prompt === '' ? '生成中' : args.prompt,
			...(args.prompt === '' ? {} : { prompt: args.prompt }),
			...(sessionId === undefined ? {} : { sessionId }),
		};
		seeds.push(seed);
		// 让后续节点能看见它，避免同批节点叠在一起
		placed.push({ ...seed, z: 0, createdAt: now });
		known.add(id);
		ingested.add(id);
	}

	// ── 2. 已结束的结果 → 改状态（必要时直接落地） ──
	let failed = 0;
	for (const result of settledMediaResults(snapshot)) {
		if (!isFreshResult(result, baselineSeq, now)) continue;
		const id = mediaNodeId(result.callId);
		const patch: Partial<Omit<CanvasNode, 'id'>> = result.isError
			? { status: 'failed', error: result.error }
			: {
					status: 'ready',
					...((result.meta?.url ?? '') === '' ? {} : { src: result.meta?.url as string }),
					...((result.meta?.prompt ?? '') === '' ? {} : { prompt: result.meta?.prompt as string }),
					...((result.meta?.prompt ?? '') === '' ? {} : { title: result.meta?.prompt as string }),
					...((result.meta?.model ?? '') === '' ? {} : { model: result.meta?.model as string }),
				};
		if (result.isError) failed += 1;

		const current = placed.find((node) => node.id === id);
		if (current !== undefined) {
			// 已经落过位：只改状态与媒体地址，节点不跳位。
			// 值没变就什么都不做 —— 会话快照每次流式输出都会刷新。
			if (sameFields(current, patch)) continue;
			patches.set(id, { ...(patches.get(id) ?? {}), ...patch });
			ingested.add(id);
			continue;
		}
		if (ingested.has(id)) continue; // 用户删过 / 已经处理过：不复活

		// 页面是在调用开始之后才打开的：直接落一个终态节点。
		const size = mediaNodeSize({
			kind: result.meta?.kind ?? 'image',
			width: result.meta?.width,
			height: result.meta?.height,
			aspectRatio: result.meta?.aspectRatio,
		});
		const at = placeAmong(placed, size);
		const seed: NodeSeed = {
			id,
			kind: (result.meta?.kind ?? 'image') as NodeKind,
			status: result.isError ? 'failed' : 'ready',
			...size,
			...at,
			...(result.isError ? { error: result.error } : {}),
			...((result.meta?.url ?? '') === '' ? {} : { src: result.meta?.url as string }),
			...((result.meta?.prompt ?? '') === '' ? {} : { prompt: result.meta?.prompt as string, title: result.meta?.prompt as string }),
			...((result.meta?.model ?? '') === '' ? {} : { model: result.meta?.model as string }),
			...(sessionId === undefined ? {} : { sessionId }),
		};
		seeds.push(seed);
		placed.push({ ...seed, z: 0, createdAt: now });
		known.add(id);
		ingested.add(id);
	}

	if (seeds.length === 0 && patches.size === 0) return NO_CHANGE;

	if (seeds.length > 0) addNodes(seeds);
	if (patches.size > 0) patchNodes(patches);
	markIngested(pruneLedger([...ingested]));

	return {
		created: seeds.length,
		resolved: patches.size,
		failed,
	};
}

/**
 * 命令触发的生成（`/generate`）与工具触发的生成共用**同一套落图规则**：
 * 同样的幂等键、同样的「先 pending 再改状态」、同样的新鲜度门槛、同样的记账。
 *
 * 唯一的差别是输入从哪来：
 *   - 提示词与种类来自命令行原文（`parseGenerateLine`，两半边共用）；
 *   - 媒体地址来自命令结果文本的第一行（`mediaUrlFromCommandText`）。
 *
 * 命令节点一个细节：窗口截断可能让 `name` 缺失，那时我们认不出它是不是
 * 自己的命令，宁可**不落图**也不要猜 —— 猜错会在画布上留下一个来源不明的节点。
 * @param snapshot - 会话快照。
 * @param sessionId - 会话 id。
 * @param options - `baselineSeq` 与 `now`。
 * @returns 本次同步报告。
 */
export function syncCommands(
	snapshot: ConversationLike,
	sessionId: string | undefined,
	options: { baselineSeq?: number; now?: number } = {},
): IngestReport {
	if (snapshot === null || typeof snapshot !== 'object') return NO_CHANGE;
	const baselineSeq = options.baselineSeq ?? 0;
	const now = options.now ?? Date.now();

	const board = getBoard();
	const ingested = new Set(board.ingested);
	const known = new Set(board.nodes.map((node) => node.id));
	const placed: CanvasNode[] = [...board.nodes];
	const seeds: NodeSeed[] = [];
	const patches = new Map<string, Partial<Omit<CanvasNode, 'id'>>>();
	let failed = 0;

	/** 命令行原文 → 提示词与形状（解析失败时退回一个安全的默认值）。 */
	const shapeOf = (args: string): { prompt: string; kind: NodeKind; size: { w: number; h: number } } => {
		const parsed = parseGenerateLine(args);
		if (!parsed.ok) return { prompt: '', kind: 'image', size: mediaNodeSize({ kind: 'image' }) };
		return {
			prompt: parsed.args.prompt,
			kind: parsed.args.kind as NodeKind,
			size: mediaNodeSize({ kind: parsed.args.kind, aspectRatio: parsed.args.aspectRatio }),
		};
	};

	// ── 1. 正在执行的命令 → pending 节点 ──
	for (const command of runningMediaCommands(snapshot)) {
		const id = mediaCommandNodeId(command.commandId);
		if (known.has(id) || ingested.has(id)) continue;
		const shape = shapeOf(command.args);
		const at = placeAmong(placed, shape.size);
		const seed: NodeSeed = {
			id,
			kind: shape.kind,
			status: 'pending',
			...shape.size,
			...at,
			title: shape.prompt === '' ? '生成中' : shape.prompt,
			...(shape.prompt === '' ? {} : { prompt: shape.prompt }),
			...(sessionId === undefined ? {} : { sessionId }),
		};
		seeds.push(seed);
		placed.push({ ...seed, z: 0, createdAt: now });
		known.add(id);
		ingested.add(id);
	}

	// ── 2. 已结束的命令 → 改状态（必要时直接落地） ──
	for (const command of settledMediaCommands(snapshot)) {
		if (!isFreshResult(command, baselineSeq, now)) continue;
		const id = mediaCommandNodeId(command.commandId);
		const shape = shapeOf(command.args);
		const patch: Partial<Omit<CanvasNode, 'id'>> = command.ok
			? {
					status: 'ready',
					src: command.url ?? '',
					...((shape.prompt === '' ? {} : { prompt: shape.prompt, title: shape.prompt })),
				}
			: { status: 'failed', error: command.error };
		if (!command.ok) failed += 1;

		const current = placed.find((node) => node.id === id);
		if (current !== undefined) {
			if (sameFields(current, patch)) continue;
			patches.set(id, { ...(patches.get(id) ?? {}), ...patch });
			ingested.add(id);
			continue;
		}
		if (ingested.has(id)) continue;

		const at = placeAmong(placed, shape.size);
		const seed: NodeSeed = {
			id,
			kind: shape.kind,
			status: command.ok ? 'ready' : 'failed',
			...shape.size,
			...at,
			...(command.ok ? { src: command.url ?? '' } : { error: command.error }),
			...(shape.prompt === '' ? {} : { prompt: shape.prompt, title: shape.prompt }),
			...(sessionId === undefined ? {} : { sessionId }),
		};
		seeds.push(seed);
		placed.push({ ...seed, z: 0, createdAt: now });
		known.add(id);
		ingested.add(id);
	}

	if (seeds.length === 0 && patches.size === 0) return NO_CHANGE;
	if (seeds.length > 0) addNodes(seeds);
	if (patches.size > 0) patchNodes(patches);
	markIngested(pruneLedger([...ingested]));
	return { created: seeds.length, resolved: patches.size, failed };
}

/**
 * 判断节点是否已经处于目标形状（逐字段比较，避免无谓的 store 提交）。
 * @param node - 当前节点。
 * @param patch - 目标字段。
 * @returns 是否完全一致。
 */
function sameFields(node: CanvasNode, patch: Partial<Omit<CanvasNode, 'id'>>): boolean {
	const current = node as unknown as Record<string, unknown>;
	return Object.entries(patch).every(([key, value]) => current[key] === value);
}

/**
 * 修剪记账表：只保留最近的一批。
 * @param ids - 当前记账表。
 * @returns 修剪后的记账表。
 */
function pruneLedger(ids: readonly string[]): string[] {
	return ids.length <= INGEST_LEDGER_MAX ? [...ids] : ids.slice(ids.length - INGEST_LEDGER_MAX);
}
