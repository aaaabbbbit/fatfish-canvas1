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
 *
 * 参数收成一个对象而不是继续加位置参数：调用点已经有五种组合（重新生成 /
 * 参考图 / 工作流 / 视频…），再往下加位置参数就会出现「第 5 个参数是 ref 还是 wf」
 * 这种只有写的人记得住的问题。
 * @param prompt - 原始提示词。
 * @param options - 种类、比例、参考图、工作流节点 id、视频参数。
 * @returns 完整命令行。
 */
export function regenerateCommandLine(
	prompt: string,
	options: {
		/** 媒体种类（`video` 会带上 `--video`）。 */
		kind?: string;
		/** 画幅比例。 */
		ratio?: string | undefined;
		/** 参考图地址（画布右键那条路用它，见 `referenceOf`）。 */
		reference?: string | undefined;
		/** 画布生成节点 id（工作流那条路用它，见 `canvas/run.ts`）。 */
		wf?: string | undefined;
		/** 视频时长（秒）。 */
		duration?: number | undefined;
		/** 视频分辨率。 */
		resolution?: string | undefined;
	} = {},
): string {
	const parts = [`/${MEDIA_COMMAND_NAME}`];
	if (options.kind === 'video') parts.push('--video');
	if (options.ratio !== undefined && options.ratio !== '') parts.push(`--ratio ${options.ratio}`);
	if (options.reference !== undefined && options.reference !== '') {
		parts.push(`--ref ${options.reference}`);
	}
	if (options.wf !== undefined && options.wf !== '') parts.push(`--wf ${options.wf}`);
	// 视频参数只对视频有意义：图像那边带上它们只会让命令行变长
	if (options.kind === 'video') {
		if (options.duration !== undefined && options.duration > 0) {
			parts.push(`--duration ${String(options.duration)}`);
		}
		if (options.resolution !== undefined && options.resolution !== '') {
			parts.push(`--resolution ${options.resolution}`);
		}
	}
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
 * 直接把一行命令投给当前会话（**不**退回提示词那条路）。
 *
 * 工作流必须用这条：退回提示词是「让模型再调一次工具」，那条路带不上 `--wf`，
 * 结果就回不到生成节点上（会变成一张散图）。
 * @param line - 完整命令行。
 * @returns 命令是否真的被执行（`matched: false` 与异常都算没执行）。
 */
export async function runCommandLine(line: string): Promise<boolean> {
	if (target === null) return false;
	try {
		return !commandMissed(await target.command(line));
	} catch {
		return false;
	}
}

/**
 * 触发一次重新生成。
 *
 * 先走 `/generate` 直达命令（零 token），命令不可用再退回提示词
 * （`matched: false` 是「命令不存在」的正常结算，不是异常）。
 *
 * ⚠️ 带参考图时**只有命令这条路**：退回的那条提示词要靠模型把地址抄进工具参数，
 * 而模型看不见图、也没有节点上下文 —— 让它「参考图生成」只会得到一句空话。
 *
 * 退回提示词那条路只带**种类与比例**（视频时长 / 分辨率不进那句自然语言）——
 * 模型本来就要重新调工具，多写两个参数只会让它更容易抄错。
 * @param prompt - 原始提示词。
 * @param options - 种类、比例、参考图（与 `regenerateCommandLine` 同一套）。
 * @returns 实际走通的路径；都失败时 null。
 */
export async function regenerate(
	prompt: string,
	options: {
		kind?: string;
		ratio?: string | undefined;
		reference?: string | undefined;
		duration?: number | undefined;
		resolution?: string | undefined;
	} = {},
): Promise<'command' | 'prompt' | null> {
	if (target === null || prompt === '') return null;
	const session = target;

	try {
		const result = await session.command(regenerateCommandLine(prompt, options));
		if (!commandMissed(result)) return 'command';
	} catch {
		/* 命令面不可用：退回提示词 */
	}
	if (options.reference !== undefined && options.reference !== '') return null;

	try {
		await session.prompt(
			[{ type: 'text', text: regeneratePrompt(prompt, options.kind ?? 'image', options.ratio) }],
			'queue',
		);
		return 'prompt';
	} catch {
		return null;
	}
}
