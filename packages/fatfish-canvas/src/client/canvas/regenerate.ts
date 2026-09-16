/**
 * 「重新生成」—— 把同一条提示词再生成一次。
 *
 * 两条路，按可用性择一（P6 起优先走直达命令）：
 *
 *   1. **`/generate` 直达命令**（`session.command`）—— 不经过模型，零 token、
 *      路径更短，结果还会以命令节点的形式回到客户端并落图；
 *   2. 退回**发一条提示词**（`session.prompt`）—— 命令不可用时（宿主没装命令
 *      服务、或命令名被占了）仍然能用，代价是要走一次模型往返。
 *
 * 「命令可用吗」不靠事先查询注册表，而是直接试一次：未匹配的命令以
 * `matched: false` 结算，不是异常。
 *
 * @module fatfish-canvas/client/canvas/regenerate
 */

import { isReferenceHandle, MEDIA_COMMAND_NAME } from '../shared/media';

/** 会话面里本模块用到的部分。 */
export interface PromptTarget {
	/** 向会话投递一条提示词。 */
	prompt(
		content: readonly { type: 'text'; text: string }[],
		mode: 'queue' | 'steer',
	): Promise<unknown>;
	/** 在会话里执行一行斜杠命令（未匹配时以 `matched: false` 结算，不抛错）。 */
	command(line: string): Promise<unknown>;
}

/** 当前的重新生成目标（由 bridge 注入）。 */
let target: PromptTarget | null = null;

/**
 * 设置（或清除）重新生成的目标会话。
 * @param session - 当前会话面；null 表示没有可用会话。
 * @returns 撤销函数（只会清掉自己设置的那个目标）。
 */
export function setRegenerateTarget(session: PromptTarget | null): () => void {
	target = session;
	return () => {
		if (target === session) target = null;
	};
}

/** 是否有可用的重新生成目标（菜单据此决定是否禁用）。 */
export function hasRegenerateTarget(): boolean {
	return target !== null;
}

/**
 * 节点上能当**参考图**的地址。
 *
 * 判据在共享模块里（`isReferenceHandle`）：只有 `http(s)` 与足够小的 `data:`
 * 能进命令行 —— 宿主取不到 `blob:` 这类进程内地址，而兆级的 `data:` 大图会把
 * 命令行连同会话日志一起撑爆。不合格时菜单项禁用，而不是发一次注定失败的生成。
 * @param node - 画布节点。
 * @returns 参考图地址；不能当参考图时 null。
 */
export function referenceOf(node: { src?: string | undefined }): string | null {
	const src = node.src;
	return isReferenceHandle(src) ? src.trim() : null;
}

/** 节点没有记录提示词时，「以此为参考图生成」用的兜底提示词。 */
export const REFERENCE_FALLBACK_PROMPT = '参考这张图，生成一张新的变体';

/**
 * 组装「退回提示词」那条路的正文。
 * @param prompt - 原始提示词。
 * @param kind - 媒体种类。
 * @param ratio - 由节点尺寸推出的画幅比例（可省略）。
 * @returns 投递给会话的正文。
 */
export function regeneratePrompt(prompt: string, kind: string, ratio?: string): string {
	const label = kind === 'video' ? '视频' : '图像';
	const ratioPart = ratio === undefined ? '' : `，aspectRatio 填 ${ratio}`;
	return (
		`请再次调用 media_generate 重新生成一张${label}：prompt 填「${prompt}」${ratioPart}。` +
		`直接调用工具，不要问我任何问题。`
	);
}

/**
 * 组装 `/generate` 的那一行（尾部留一个空格，便于用户接着补参数）。
 * @param prompt - 原始提示词。
 * @param kind - 媒体种类。
 * @param ratio - 画幅比例。
 * @param reference - 参考图地址（画布右键那条路用它，见 `referenceOf`）。
 * @returns 完整命令行。
 */
export function regenerateCommandLine(
	prompt: string,
	kind = 'image',
	ratio?: string,
	reference?: string,
): string {
	const parts = [`/${MEDIA_COMMAND_NAME}`];
	if (kind === 'video') parts.push('--video');
	if (ratio !== undefined && ratio !== '') parts.push(`--ratio ${ratio}`);
	if (reference !== undefined && reference !== '') parts.push(`--ref ${reference}`);
	parts.push(prompt);
	return `${parts.join(' ')} `;
}

/** 判断命令返回值是否表示「命令不存在 / 未匹配」。 */
function commandMissed(result: unknown): boolean {
	if (result === null || typeof result !== 'object') return false;
	const o = result as Record<string, unknown>;
	// RemoteResult 的两种形状：`{ ok: true, value: { matched } }` 或失败分支
	if (o.ok === false) return true;
	const value = o.value;
	if (value !== null && typeof value === 'object') {
		return (value as Record<string, unknown>).matched === false;
	}
	return false;
}

/**
 * 触发一次重新生成。
 *
 * 先走 `/generate` 直达命令（零 token），命令不可用再退回提示词
 * （`matched: false` 是「命令不存在」的正常结算，不是异常）。
 *
 * ⚠️ 带参考图时**只有命令这条路**：退回的那条提示词要靠模型把地址抄进工具参数，
 * 而模型看不见图、也没有节点上下文 —— 让它「参考图生成」只会得到一句空话。
 * @param prompt - 原始提示词。
 * @param kind - 媒体种类（默认 image）。
 * @param ratio - 画幅比例。
 * @param reference - 参考图地址（可选）。
 * @returns 实际走通的路径；都失败时 null。
 */
export async function regenerate(
	prompt: string,
	kind = 'image',
	ratio?: string,
	reference?: string,
): Promise<'command' | 'prompt' | null> {
	if (target === null || prompt === '') return null;
	const session = target;

	try {
		const result = await session.command(regenerateCommandLine(prompt, kind, ratio, reference));
		if (!commandMissed(result)) return 'command';
	} catch {
		/* 命令面不可用：退回提示词 */
	}
	if (reference !== undefined && reference !== '') return null;

	try {
		await session.prompt([{ type: 'text', text: regeneratePrompt(prompt, kind, ratio) }], 'queue');
		return 'prompt';
	} catch {
		return null;
	}
}
