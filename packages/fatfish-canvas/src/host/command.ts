/**
 * `/generate` 直达命令（宿主半边，P6）。
 *
 * 与 `media_generate` 工具的区别只有**谁发起**：
 *
 *   工具   模型决定要不要调（要看上下文、要花一次模型往返）
 *   命令   用户直接敲（确定性、零 token、路径更短）
 *
 * 两者走**同一条生成管线**（`host/generate.ts`），因此错误文案、供应商选择、
 * 比例默认值完全一致 —— 这是把管线抽出来的唯一理由。
 *
 * ## 参考图：这条命令是「模型看不见图」的官方绕行方案
 *
 * 声明 `input.attachments: true` 之后，用户在输入框里附的图片会以
 * `invocation.attachments`（`ImageBlock[]`）到达这里 —— **不经过模型**。
 * 于是「贴一张参考图 + 敲 /generate」= 图生图，文本模型全程不需要看见任何像素
 * （它对图片附件只会收到一行 `[image omitted …]` 占位符，见 dsh-llm 的
 * `textOnlyImageText`）。`--ref <地址>` 是同一个能力的显式写法（画布右键就走它）。
 *
 * 结果怎么回到界面：命令只有文本一种载体（见 dsh-commands），因此这里
 * 遵守共享模块里那条约定 —— **成功文本的第一行永远是媒体地址**
 * （`formatCommandResult`）。客户端据此从 `command/done` 还原媒体并落图，
 * `parseGenerateLine` 则让两边用同一套命令行语法（见 `shared/media.ts`）。
 *
 * 命令结果**不进模型历史**，也不产生 token —— 这正是它值得存在的原因。
 *
 * @module fatfish-canvas/host/command
 */

import {
	formatCommandResult,
	GENERATE_USAGE,
	MEDIA_COMMAND_NAME,
	parseGenerateLine,
} from '../client/shared/media';
import { runGeneration, type GenerationDeps } from './generate';
import type { MediaAttachmentRef } from './reference';

/** 命令的输入提示（composer 在用户敲下 `/generate ` 之后显示）。 */
const INPUT_HINT =
	'提示词，前面可加 --video / --ratio 16:9 / --duration 5 / --ref 参考图地址（可重复）等参数；' +
	'在输入框里附上图片时，那些图按顺序自动当参考图';

/** 命令调用里本模块用到的部分（附件是图片块）。 */
interface GenerateInvocation {
	/** 命令名之后的原文。 */
	rawInput: string;
	/** 取消信号。 */
	signal: AbortSignal;
	/** 随命令一起提交的附件（声明了 `input.attachments` 才有）。 */
	attachments?: readonly { type?: string; attachment?: MediaAttachmentRef }[];
}

/**
 * 从附件里挑出**所有**图片，按贴进来的顺序当参考图。
 *
 * 只认图片块：命令行这里能拿到的还有普通文件（`FileBlock`），那些不是参考图。
 * 递出去的是**附件自己的持久引用**（不重拼一个残缺对象）—— 附件服务要拿它
 * 去核对记录的字节数与尺寸，拼出来的引用会被判成无效。
 * @param invocation - 命令调用。
 * @returns 附件引用列表（按顺序）；没有图片附件时是空数组。
 */
function referencesFromAttachments(invocation: GenerateInvocation): MediaAttachmentRef[] {
	const out: MediaAttachmentRef[] = [];
	for (const block of invocation.attachments ?? []) {
		if (block.type !== 'image') continue;
		const ref = block.attachment;
		if (ref !== undefined && typeof ref.attachmentId === 'string' && ref.attachmentId !== '') out.push(ref);
	}
	return out;
}

/**
 * 造出命令定义。
 *
 * 刻意用对象字面量满足 `CommandDefinition` 契约（与工具同理）：结构匹配即可，
 * 不为此多引一个类型包。
 * @param deps - 生成管线依赖。
 * @returns `ctx.commands.register` 可直接接受的定义。
 */
export function createGenerateCommand(deps: GenerationDeps): Record<string, unknown> {
	return {
		name: MEDIA_COMMAND_NAME,
		description: '不经过模型直接生成图像或视频（结果同样落到左侧画布上）',
		// `attachments: true` = 允许带附件调用；附带的那些图自动按顺序当参考图
		input: { hint: INPUT_HINT, attachments: true },
		// 参数就是载荷本身，保留在会话日志里便于回溯「这一张是怎么来的」
		recordInput: true,

		/**
		 * 执行一次生成。
		 * @param invocation - 命令调用（原文、附件与取消信号）。
		 * @returns 命令结果（成功带媒体地址，失败带可读原因）。
		 */
		async handler(
			invocation: GenerateInvocation,
		): Promise<{ kind: 'success'; text: string } | { kind: 'error'; text: string }> {
			const parsed = parseGenerateLine(invocation.rawInput);
			if (!parsed.ok) return { kind: 'error', text: parsed.error };

			// 显式 `--ref` 优先：用户写下来的地址比「顺手附上的那些图」更明确
			// （两条都给了就用 `--ref`，不混着来 —— 混着来没人说得清顺序）
			const attached = referencesFromAttachments(invocation);
			const references =
				parsed.args.references ?? (attached.length === 0 ? undefined : attached);

			try {
				const value = await runGeneration(
					deps,
					{ ...parsed.args, ...(references === undefined ? {} : { references }) },
					invocation.signal,
				);
				return { kind: 'success', text: formatCommandResult(value) };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				// 错误也带上用法：命令敲错参数时，用户下一步就是改参数重敲
				return {
					kind: 'error',
					text: `${message}\n${GENERATE_USAGE}`,
				};
			}
		},
	};
}
