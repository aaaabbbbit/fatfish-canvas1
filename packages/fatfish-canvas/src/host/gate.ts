/**
 * 生成并发闸门（宿主半边）。
 *
 * `media_generate` 声明了**并发安全**，因此模型在**同一条消息里**发起的多个调用
 * 会真的并行跑 —— 这就是「一次出 4 张」的实现方式：一次调用出一张，客户端按
 * callId 各落一个画布节点（见 client/canvas/ingest.ts）。在此之前工具是**独占**的，
 * 同一条消息里的多个调用会被调度器排成一队，批量生成实际上是串行。
 *
 * 但并行不能没边：同一个供应商通常有速率限制，十个请求一起打过去只会换回一串
 * 429，用户看到的是「批量生成失败」。因此第 4 个之后的调用在这里排队，出一个进一个。
 *
 * ponytail: 全局一个闸门，上限写死，不分供应商、不分图像/视频。
 * 升级路径：上限做成设置项、按供应商 id 各一个闸门 —— 真有人抱怨再说。
 *
 * @module fatfish-canvas/host/gate
 */

/** 同时进行的生成数上限（超出的排队）。 */
export const GENERATION_MAX_CONCURRENT = 3;

/** 正在跑的任务数。 */
let active = 0;

/** 排队中的「放行」回调（先进先出）。 */
const waiters: (() => void)[] = [];

/**
 * 取一个名额：没满就立刻拿到，满了就排队。
 * @param signal - 取消信号；排队期间被取消则抛错，且不占位。
 * @returns 拿到名额时结算。
 */
function acquire(signal?: AbortSignal): Promise<void> {
	if (active < GENERATION_MAX_CONCURRENT) {
		active += 1;
		return Promise.resolve();
	}
	return new Promise<void>((resolve, reject) => {
		/** 被放行：撤掉取消监听后结算。 */
		const grant = (): void => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		};
		/** 排队期间被取消：把自己从队里摘掉（名额留给别人）。 */
		const onAbort = (): void => {
			const at = waiters.indexOf(grant);
			if (at !== -1) waiters.splice(at, 1);
			reject(new Error('已取消'));
		};
		if (signal?.aborted === true) {
			onAbort();
			return;
		}
		waiters.push(grant);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

/**
 * 在名额内跑一个生成任务。
 * @param task - 任务（真正发起生成的那段）。
 * @param signal - 取消信号。
 * @returns 任务结果。
 */
export async function withGenerationSlot<T>(
	task: () => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	await acquire(signal);
	try {
		return await task();
	} finally {
		// 名额**交接**给下一个排队的（而不是先减后加）：否则两个等待者会被同时唤醒，
		// 上限就成了摆设。
		const next = waiters.shift();
		if (next === undefined) active -= 1;
		else next();
	}
}
