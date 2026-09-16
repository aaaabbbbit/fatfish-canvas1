/**
 * 一点点 DOM 小工具。
 *
 * @module fatfish-canvas/client/dom
 */

/**
 * 判定「焦点在可编辑控件里」。
 *
 * 键盘快捷键必须让路给输入框：右侧就是本体原生聊天，用户在聊天里按
 * Delete / Ctrl+A / 快捷键时，作用对象必须是输入框，而不是画布。
 * @param target - 事件目标。
 * @returns 是否位于输入类控件中。
 */
export function isEditableTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	const tag = target.tagName;
	if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
	return target.isContentEditable;
}

/**
 * 当前是否正把光标放在聊天输入框里（即将输入）。
 *
 * 判断对象是 **`document.activeElement`**，不是事件目标 —— 用户点画布上的图片时，
 * 事件目标当然是图片，而我们要知道的恰恰是「点之前焦点在哪」。
 * @returns 焦点是否在可编辑控件里。
 */
export function isComposerFocused(): boolean {
	if (typeof document === 'undefined') return false;
	const active = document.activeElement;
	if (!(active instanceof HTMLElement)) return false;
	return isEditableTarget(active) || active.closest('[contenteditable="true"]') !== null;
}

/**
 * 找到聊天输入框（可编辑元素）。
 *
 * 优先用「当前持有焦点的那个」：本体在新会话 hero 与会话态之间复用同一棵 DOM，
 * 隐藏的那份仍在文档里，`querySelector` 可能先拿到 0×0 的副本。
 * @returns 可编辑元素；找不到时为 null。
 */
export function findComposer(): HTMLElement | null {
	if (typeof document === 'undefined') return null;
	const active = document.activeElement;
	if (active instanceof HTMLElement && isEditableTarget(active)) return active;
	const all = [...document.querySelectorAll<HTMLElement>('[contenteditable="true"], textarea')];
	return all.find((el) => el.getBoundingClientRect().width > 0) ?? all[0] ?? null;
}

/**
 * 把一段纯文本追加进聊天输入框（正在编辑的草稿后面）。
 *
 * 这是**退路**：首选是 {@link attachImageToComposer}（把图变成真正的图片附件）。
 * 只有宿主取不到字节（探测服务缺席、地址不可达、图太大）时才退回插地址 ——
 * 用户至少拿到一个可编辑、能删、模型也看得懂的地址，而不是无声失败。
 *
 * 两条插入通路依次尝试：`execCommand`（contenteditable 的常规做法）→
 * 直接写 `value`（原生 textarea，配合 `input` 事件让 React 的受控值跟上）。
 * @param text - 要插入的文本。
 * @returns 是否插入成功。
 */
export function insertIntoComposer(text: string): boolean {
	if (typeof document === 'undefined') return false;
	const editor = findComposer();
	if (editor === null) return false;

	editor.focus({ preventScroll: true });

	if (typeof document.execCommand === 'function') {
		try {
			if (document.execCommand('insertText', false, text)) return true;
		} catch {
			/* 继续走下面的兜底 */
		}
	}

	if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
		const start = editor.selectionStart ?? editor.value.length;
		const end = editor.selectionEnd ?? start;
		editor.setRangeText(text, start, end, 'end');
		editor.dispatchEvent(new Event('input', { bubbles: true }));
		return true;
	}
	return false;
}

/** {@link attachImageToComposer} 的结果。 */
export type AttachOutcome =
	/** 已经作为**图片附件**进入输入框。 */
	| { kind: 'attached' }
	/** 附件通路不可用 / 数据不对，已退化成插入地址文本。 */
	| { kind: 'text' }
	/** 连退路都没走通。 */
	| { kind: 'failed'; message: string };

/**
 * 把一个 data URL 变成真正的**图片附件**送进聊天输入框。
 *
 * 做法：还原成 `File`，再**在 `document` 上**派发一次合成的 `drop` —— 这是
 * **复用平台自己的附件管线**（`dsh-client-ui-attachment` 的 `document` drop 监听
 * → `onAddFiles` → 上传，凭据与存储都在宿主侧），而不是在插件里另造一套。
 * 自己造一套意味着附件预览、上传进度、失败重试、跨会话回收全都要重写。
 *
 * 两个必须照平台实现来做的细节（写错了就「什么都不发生」，不报错）：
 * 1. 监听器挂在 **`document` 的冒泡阶段**，所以事件要**冒泡到 document**——
 *    因此派发在 composer 上（或任意在文档里的元素）即可，不必去找那个监听元素；
 * 2. 它先用 `dataTransfer.types.includes('Files')` 过滤，**只认带 `Files` 的
 *    dataTransfer**。`new DataTransfer()` + `items.add(file)` 在 Chrome 里满足
 *    这一点，但不能改成手写 `{ files: [...] }` 的假对象。
 *
 * ⚠️ 还有一条外部前提：插件的 `canvas/dropfiles.ts` 捕获阶段会 `stopPropagation()`
 * 拦住「落在画布上」的拖拽 —— 它对 composer 上的事件**必须放行**，否则我们
 * 自己派发的这个合成 drop 会被自己拦死（这正是「只能插进地址」那个 bug）。
 * @param dataUrl - `data:image/...;base64,...`。
 * @param name - 文件名（附件卡片上显示它）。
 * @returns 结果。
 */
export function attachImageToComposer(dataUrl: string, name: string): AttachOutcome {
	if (typeof document === 'undefined') return { kind: 'failed', message: '当前没有浏览器文档' };
	const file = dataUrlToFile(dataUrl, name);
	if (file === null) return { kind: 'failed', message: '图片数据无法解析' };

	const composer = findComposer();
	if (composer === null) return { kind: 'failed', message: '找不到聊天输入框' };

	try {
		const transfer = new DataTransfer();
		transfer.items.add(file);
		const event = new DragEvent('drop', {
			bubbles: true,
			cancelable: true,
			dataTransfer: transfer,
		});
		if (event.dataTransfer === null || !event.dataTransfer.types.includes('Files')) {
			return { kind: 'failed', message: '浏览器没有把合成拖放标记成文件' };
		}
		// 派发在输入框上：它一定在文档里，事件会冒泡到 document 的那个监听器。
		composer.dispatchEvent(event);
		composer.focus({ preventScroll: true });
		return { kind: 'attached' };
	} catch {
		return { kind: 'failed', message: '这个页面不接受合成的拖放事件' };
	}
}

/**
 * 把 data URL 还原成 `File`。
 * @param dataUrl - 内联数据地址。
 * @param name - 文件名。
 * @returns 文件；格式不认识时为 null。
 */
function dataUrlToFile(dataUrl: string, name: string): File | null {
	const comma = dataUrl.indexOf(',');
	if (comma < 0) return null;
	const header = dataUrl.slice(0, comma);
	const payload = dataUrl.slice(comma + 1);
	if (!/^data:image\//i.test(header)) return null;
	const mime = header.slice(5).split(';')[0] ?? 'image/png';
	try {
		const binary = atob(payload);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
		return new File([bytes], name === '' ? 'canvas-image.png' : name, { type: mime });
	} catch {
		return null;
	}
}
