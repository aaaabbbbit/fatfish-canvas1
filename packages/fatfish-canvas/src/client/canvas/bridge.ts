/**
 * 会话 → 画布 的订阅桥。
 *
 * 为什么订阅 `ctx.sessions` 而不是自己注册一个会话节点定义：
 * 宿主已经把生成结果写进了 `tool/result` 的 `presentationMeta`，而会话**事件窗口**
 * 本来就把这条事件带着（连同配对的 `tool/call`）。再往 `ctx.conversationEvents`
 * 里注册一个 Definition 只会把同一份数据在客户端再折叠一遍，并且还得自带一个
 * view target。这里只订阅、不定义。
 *
 * ⚠️ **订阅的是 `binding.eventSource`（会话事件窗口），绝不是 `session.getSnapshot()`。**
 * `SessionSnapshot` 里**没有** `nodes` / `runningCalls` —— 那是 Conversation 目标
 * 投影出来的产物，不属于 Session 快照（见 dsh-api-session-controller 的
 * `client/contract/snapshot.d.ts`）。这里曾经读错过一次：拿到的永远是 `undefined`，
 * 于是 `syncConversation` 每次都看到「一次生成都没有」——**一个节点不落、记账不写、
 * 也不报任何错**（症状是画布永远空，而聊天里图好好的）。当时没被发现，是因为
 * 离线测试的 `sessions` 替身**恰好按错误的形状**建模（替身里给了
 * `getSnapshot: () => ({ nodes, runningCalls })`），两边一起漂移，测试全绿。
 * 现在数据来源是真实事件形状，折叠逻辑是纯函数 `conversationOf`（可单测）。
 *
 * 两个必须自己管好的生命周期问题：
 *
 *   1. **只跟当前会话**：只有「当前」（staged）会话的事件窗口是打开的，
 *      其它会话根本没有实时流 —— 这也是画布只吃得到当前会话生成结果的原因。
 *      顺带这里也是**唯一知道「当前会话是谁、属于哪个工作区」**的地方，所以画布
 *      按工作区分隔（作用域）由它告知 `canvas/scope.ts`：工作区 = 会话行上的 `cwd`。
 *      「当前」的判据是列表行上的 `retainedBy.mainView`（见 `currentSessionId`）——
 *      **不是** `list.current`：真机的列表快照里没有那个字段，按它写会让桥
 *      永远拿到 `undefined`、从不订阅、一个节点都不落（而且不报错）。
 *   2. **基线**：事件窗口一打开就带着整段历史。首次观察某个会话时记下它的
 *      最大 seq，之后只把「比基线新」或「时间戳很新」的结果落到画布上，
 *      否则每打开一个老会话都会把它历史上的生成重新铺一遍。
 *
 * `sessions.binding(id)` 是纯寻址，但**不保证**在列表通知的那一刻就已经可解析
 * （scope 的开始是异步的），因此这里带一个有限次的重试。
 *
 * @module fatfish-canvas/client/canvas/bridge
 */

import type { Context } from '@deepseek-ai/cordis';
import { syncConversation, type ConversationLike, type ConversationNodeLike } from './ingest';
import { setRegenerateTarget, type PromptTarget } from './regenerate';
import { setScopeSession, setWorkspaceLookup } from './scope';

/** 绑定重试的间隔与次数（scope 的开始是异步的）。 */
const BIND_RETRY_MS = 200;
const BIND_RETRY_MAX = 40;

/** 「列表里有会话却认不出当前会话」要忍多久才喊一声（启动时行比持有关系先到是正常的）。 */
const DRIFT_WARN_MS = 5000;

/** 事件窗口里本模块读取的那一面（`SessionEventWindow` 的窄化）。 */
export interface EventWindowLike {
	/** 窗口内的条目（`{ type: 'event', event }` 或 transient）。 */
	entries?: readonly unknown[] | undefined;
}

/** 事件窗口快照（`binding.eventSource.getSnapshot()`）。 */
export interface EventSourceLike {
	/** 取当前窗口。 */
	getSnapshot(): EventWindowLike;
	/** 订阅窗口更新（同步发布）。 */
	subscribe(listener: () => void): () => void;
}

/** 事件里的 `data.turn` 等字段都按 unknown 取，这里只做最小宽度收窄。 */
const asRecord = (value: unknown): Record<string, unknown> | null =>
	value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

/** 取数字序号（拿不到就 0，与 `ingest` 的默认一致）。 */
const numOr = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/**
 * 从 `tool/result` 的内容块里拼出文字（失败原因就藏在这里）。
 *
 * 真实形状是两层：`content: [{ type:'tool-result', content:[{ type:'text', text }] }]`
 * —— 外层是「这条消息里的工具结果块」，内层才是文本块。只扫一层会永远得到空串，
 * 于是失败节点上写不出原因。
 * @param content - `message.content`。
 * @returns 拼接后的文本。
 */
function textOfResultContent(content: unknown): string {
	const parts: string[] = [];
	for (const block of Array.isArray(content) ? content : []) {
		const b = asRecord(block);
		if (b === null) continue;
		if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
		const inner = b.content;
		if (Array.isArray(inner)) {
			for (const item of inner) {
				const t = asRecord(item);
				if (t !== null && t.type === 'text' && typeof t.text === 'string') parts.push(t.text);
			}
		}
	}
	return parts.join('\n').replace(/^Error:\s*/, '').trim();
}

/**
 * 把会话事件窗口折叠成 `ingest` 需要的会话形状。
 *
 * 四个来源（都是**实测过的真实 wire 形状**，见 `scripts/verify-client.mjs` 的用例）：
 *
 *   `tool/call`     → `runningCalls`（进行中）+ 给 `tool/result` 补工具名
 *   `tool/result`   → `nodes[]`（`data.message.source.callId` / `data.meta`）
 *   `command/run`   → `nodes[]`（未结束的用 `outcome: null` 表达）
 *   `command/done`  → 回填同一个 `commandId` 的 `outcome`
 *
 * 为什么要 `tool/call`：`tool/result` 自己**不带工具名**（只有 callId），而
 * `ingest` 需要按名字认领。窗口截断让某个 call 落在窗口外时名字就拿不到 ——
 * 那种情况下 `ingest` 会用结果自带的 `meta` 兜底，因此仍然认得出。
 * @param window - 事件窗口快照。
 * @returns 会话形状（`nodes` + `runningCalls`）。
 */
export function conversationOf(window: EventWindowLike): ConversationLike {
	const nodes: ConversationNodeLike[] = [];
	const runningCalls: { callId: string; name: string; argsRaw: string }[] = [];
	/** callId → 工具名与原始参数（`tool/result` 靠它认领；参数供落图读出参考图）。 */
	const callNames = new Map<string, { name: string; argsRaw: string }>();
	/** commandId → 已折叠的命令节点下标（`command/done` 回填用）。 */
	const commandIndex = new Map<string, number>();

	for (const entry of window.entries ?? []) {
		const e = asRecord(entry);
		if (e === null || e.type !== 'event') continue; // transient（流式分片）与落图无关
		const ev = asRecord(e.event);
		if (ev === null) continue;
		const type = ev.type;
		const seq = numOr(ev.seq);
		const time = numOr(ev.time);
		const data = asRecord(ev.data) ?? {};

		if (type === 'tool/call') {
			const callId = typeof data.callId === 'string' ? data.callId : '';
			const name = typeof data.name === 'string' ? data.name : '';
			if (callId === '') continue;
			callNames.set(callId, { name, argsRaw: typeof data.arguments === 'string' ? data.arguments : '' });
			runningCalls.push({ callId, name, argsRaw: typeof data.arguments === 'string' ? data.arguments : '' });
			continue;
		}

		if (type === 'tool/result') {
			const message = asRecord(data.message) ?? {};
			const source = asRecord(message.source) ?? {};
			const callId = typeof source.callId === 'string' ? source.callId : '';
			if (callId === '') continue;
			const content = Array.isArray(message.content) ? message.content : [];
			// 结束的调用不再是「进行中」：同一个 callId 只可能有一次结果。
			const at = runningCalls.findIndex((call) => call.callId === callId);
			if (at >= 0) runningCalls.splice(at, 1);
			const inner = asRecord(content[0]);
			const isError = inner !== null && inner.isError === true;
			const call = callNames.get(callId);
			nodes.push({
				kind: 'tool-result',
				seq,
				time,
				callId,
				// 参数原文一起带上：结果自己的 meta 里没有参考图地址，而右键的
				// 「生成信息」要显示「当时参考了哪几张」—— 只留工具名的话，
				// 页面在生成之后才打开的那些节点就永远查不出来了。
				...(call === undefined ? {} : { call }),
				isError,
				meta: data.meta,
				content,
			});
			continue;
		}

		if (type === 'command/run') {
			const commandId = typeof data.commandId === 'string' ? data.commandId : '';
			if (commandId === '') continue;
			commandIndex.set(commandId, nodes.length);
			nodes.push({
				kind: 'command',
				seq,
				time,
				commandId,
				name: typeof data.name === 'string' ? data.name : null,
				args: typeof data.args === 'string' ? data.args : null,
				outcome: null,
			});
			continue;
		}

		if (type === 'command/done') {
			const commandId = typeof data.commandId === 'string' ? data.commandId : '';
			const at = commandIndex.get(commandId);
			if (at === undefined) continue;
			const node = nodes[at];
			if (node === undefined) continue;
			const kind = data.kind === 'success' ? 'success' : 'error';
			nodes[at] = {
				...node,
				seq, // 结果那一刻的序号：判「够不够新」要用它
				time,
				outcome: { kind, ...(typeof data.text === 'string' ? { text: data.text } : {}) },
			};
		}
	}

	return { nodes, runningCalls };
}

/** 事件窗口里的最大日志序号（基线用）。 */
export function maxSeqOf(window: EventWindowLike): number {
	const conversation = conversationOf(window);
	let max = 0;
	for (const node of conversation.nodes ?? []) {
		if (typeof node.seq === 'number' && node.seq > max) max = node.seq;
	}
	return max;
}

/**
 * 从列表快照里找出「主视图正持有的那个会话」。
 *
 * 判据是行的本地引用计数，不是某个 `current` 字段（真机没有它，
 * 见 `ambient.d.ts` 的 `DshSessionListState`）：`dsh-client-ui-session`
 * 判定「谁是主会话」用的也是这条规则。
 *
 * 保留上一次的 id 直到它的计数归零：切换会话途中两行可能同时（或都不）被持有，
 * 跟着「第一个被持有的行」走会在两块画布之间来回改绑。
 * @param state - 列表快照。
 * @param previous - 上一次绑定的会话 id（没有时 null）。
 * @returns 当前会话 id；认不出来时 undefined。
 */
export function currentSessionId(
	state: DshSessionListState | undefined,
	previous: string | null = null,
): string | undefined {
	const rows = state?.byId ?? {};
	if (previous !== null && ((rows[previous]?.retainedBy?.mainView ?? 0) > 0)) return previous;
	return Object.values(rows).find((row) => (row.retainedBy?.mainView ?? 0) > 0)?.id;
}

/**
 * 装上「生成结果 → 画布」的订阅。
 *
 * 用 `ctx.inject` 而不是顶层 inject：`sessions` 缺席时（无头组合、裁剪过的
 * 前端图）画布本体仍应可用。
 * @param ctx - 客户端根 context。
 */
export function installCanvasIngest(ctx: Context): void {
	ctx.inject(['sessions'], (scoped) => {
		const sessions = scoped.sessions;

		scoped.effect(() => {
			/** 每个会话首次被观察时的 seq 基线。 */
			const baselines = new Map<string, number>();

			let boundId: string | null = null;
			let offEvents: (() => void) | null = null;
			let offRegenerate: (() => void) | null = null;
			let retry: ReturnType<typeof setTimeout> | null = null;
			let drift: ReturnType<typeof setTimeout> | null = null;
			let attempts = 0;

			const unbind = (): void => {
				if (retry !== null) {
					clearTimeout(retry);
					retry = null;
				}
				if (drift !== null) {
					clearTimeout(drift);
					drift = null;
				}
				if (offEvents !== null) {
					offEvents();
					offEvents = null;
				}
				if (offRegenerate !== null) {
					// 「重新生成」只在当前会话可用：解绑时必须一起撤掉，
					// 否则切走之后菜单还点得动，提示词会发到已经不看的会话里。
					offRegenerate();
					offRegenerate = null;
				}
				boundId = null;
			};

			/**
			 * 把当前事件窗口同步一次。
			 *
			 * 折成 `ConversationLike` 再交给 `syncConversation` —— 落图规则（幂等、
			 * 先 pending 后改状态、新鲜度门槛）全在 `ingest` 里，这里只负责把
			 * **平台的事件形状**翻译成它认得的会话形状。
			 */
			const pump = (id: string, source: EventSourceLike): void => {
				const window = source.getSnapshot();
				if (window === null || typeof window !== 'object') return;
				let baseline = baselines.get(id);
				if (baseline === undefined) {
					// 首次观察：此刻已经在窗口里的东西都算「历史」，
					// 只有新鲜窗口内的结果例外（syncConversation 里判）。
					baseline = maxSeqOf(window);
					baselines.set(id, baseline);
				}
				syncConversation(conversationOf(window), id, { baselineSeq: baseline });
			};

			const bind = (id: string | undefined): void => {
				if (id === boundId && offEvents !== null) return;
				unbind();
				if (id === undefined) return;

				const binding = sessions.binding(id);
				if (binding === undefined) {
					// scope 还没建好：有限次重试，避免「切过去什么都没发生」。
					// 已经在重试就别再排一个 —— 列表通知会反复把我们叫醒。
					if (attempts < BIND_RETRY_MAX && retry === null) {
						attempts += 1;
						retry = setTimeout(() => {
							retry = null;
							bind(id);
						}, BIND_RETRY_MS);
					}
					return;
				}

				attempts = 0;
				boundId = id;
				// 事件窗口是**唯一**的实时来源（见模块头：SessionSnapshot 里没有会话数据）。
				const source = binding.eventSource as EventSourceLike | undefined;
				if (source === undefined || typeof source.getSnapshot !== 'function') return;
				offEvents = source.subscribe(() => {
					pump(id, source);
				});
				// 右键菜单的「重新生成」需要一个能把提示词投出去的目标会话
				offRegenerate = setRegenerateTarget(binding.session as PromptTarget);
				pump(id, source);
			};

			const list = sessions.list;
			// 画布挂在**工作区**上，而工作区就是会话行上的 `cwd`（`SessionSummary`）。
			// 拆分共用画布（把节点按它属于哪个会话送回各自工作区）也要用它，
			// 因此顺手把查询口交给 `scope.ts` —— 会话 → 工作区只有这里知道。
			setWorkspaceLookup((ask) => list.getSnapshot()?.byId?.[ask]?.cwd);
			const onChange = (): void => {
				const state = list.getSnapshot();
				const id = currentSessionId(state, boundId);
				// 画布作用域**先切、结果再落**：结果必须落进当前会话所在工作区那块
				// 画布。反过来会让第一帧结果落进上一个工作区的画布里。
				// 也正因为如此，这里每次列表变动都报一次（不只在换绑时）：
				// 会话行上的 `cwd` 比行本身晚到一步，漏报就等于画布停在上一个工作区。
				setScopeSession(
					id ?? null,
					id === undefined ? null : (state?.byId?.[id]?.cwd ?? null),
				);
				// 列表里有会话却认不出当前会话：先忍着（启动时行比「谁被持有」先到是正常的），
				// 一直认不出才喊一声 —— 这条线静默失效过一次，代价是画布永远空。
				if (id === undefined && drift === null && Object.keys(state?.byId ?? {}).length > 0) {
					drift = setTimeout(() => {
						drift = null;
						if (boundId !== null) return;
						console.warn(
							'[fatfish-canvas] 会话列表里有会话，却认不出主视图持有的那一个' +
								'（行上没有 retainedBy.mainView）—— 生成结果不会落到画布上。' +
								'多半是 dsh 的会话列表契约变了，见 client/ambient.d.ts 的 DshSessionListState。',
						);
					}, DRIFT_WARN_MS);
				}
				bind(id);
			};
			const offList = list.subscribe(onChange);
			onChange();

			return () => {
				offList();
				unbind();
				// 插件卸载后不该继续把画布钉在某个工作区的键上。
				setScopeSession(null, null);
				setWorkspaceLookup(() => undefined);
			};
		}, 'fatfish-canvas: media ingest');
	});
}
