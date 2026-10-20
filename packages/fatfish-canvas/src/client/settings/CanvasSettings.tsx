/**
 * 「肥鱼画布」设置页（P32）—— 插件自己的那一页。
 *
 * 为什么单独开一页：**存储**这类选项与「图像 / 视频模型」不是一回事
 * （那一页是「配供应商与密钥」，用户平时不会去翻），混在里面既难找、
 * 也让那一页越来越长。用户明确要求把存储选项挪到画布自己的页面里。
 *
 * 写入形状与那一页完全一致（深路径 op + 冲突重试，共用 `mutateSettings`）。
 * 文本字段走本地草稿 + 失焦提交：每敲一个字写一次设置 = 每个字符一次磁盘写入，
 * 还会不断撞 revision。**P41 加了「设计技能」**：那份注入聊天模型 system prompt
 * 的设计要求文案在这里直接编辑（清空提交 = unset，回到内置），开关挂在聊天框
 * 那枚鲸鱼尾巴的右键上（见 ModelPicker）。
 *
 * @module fatfish-canvas/client/settings/CanvasSettings
 */

import { useCallback, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import {
	DESIGN_SKILL_BUILTIN,
	FIELD_ARCHIVE_DIR,
	FIELD_DESKILL_TEXT,
} from '../shared/catalog';
import { mutateSettings } from './models';

/** 页面拿到的注入面。 */
export interface CanvasSettingsProps {
	/** 本 entry 的设置表单（`ctx.configForms.get(<Loader entry id>)`）。 */
	scope: DshClientConfigForm<Record<string, unknown>>;
	/**
	 * 宿主写入面。
	 *
	 * 传**取值函数**而不是当时的值：`remote.settings` 是派生服务，页面可能先渲染
	 * 一次、之后它才就绪（与 MediaSettings 的 `getProbe` 同一个理由）。
	 */
	getApi: () => DshHostApi | undefined;
}

/**
 * 「肥鱼画布」设置页。
 * @param props - 注入面。
 * @returns 页面元素。
 */
export function CanvasSettings({ scope, getApi }: CanvasSettingsProps): ReactNode {
	const snapshot = useSyncExternalStore(
		useCallback((listener: () => void) => scope.subscribe(listener), [scope]),
		useCallback(() => scope.getSnapshot(), [scope]),
	);

	/** 留档目录的草稿（null = 没有未提交的编辑）。 */
	const [draft, setDraft] = useState<string | null>(null);
	/** 一次失败说明（成功不写：写成功后设置自己会刷新界面）。 */
	const [note, setNote] = useState('');
	/** 设计技能文案的草稿（null = 没有未提交的编辑）。多行文本，只有失焦提交。 */
	const [skillDraft, setSkillDraft] = useState<string | null>(null);
	/** 设计技能那块自己的失败说明（与留档共用位子但各写各的，错误要落在出错的那张卡上）。 */
	const [skillNote, setSkillNote] = useState('');
	/** 设计技能的放大编辑窗（P45）：settings 那栏窄，改成要看大窗才舒服。 */
	const [skillBig, setSkillBig] = useState(false);

	const value = snapshot.value as Record<string, unknown> | undefined;
	const current = typeof value?.[FIELD_ARCHIVE_DIR] === 'string' ? (value[FIELD_ARCHIVE_DIR] as string) : '';
	const writable = snapshot.writable && snapshot.status === 'ready' && getApi() !== undefined;
	// 设置快照可能不为文本字段补 schema 缺省：缺席就显示内置文案（两边同一份常量）
	const skillCurrent =
		typeof value?.[FIELD_DESKILL_TEXT] === 'string' ? (value[FIELD_DESKILL_TEXT] as string) : DESIGN_SKILL_BUILTIN;
	/** 编辑框正在显示的那份：有未提交草稿用草稿，否则用现值（小窗与大窗同一个来源）。 */
	const skillValue = skillDraft ?? skillCurrent;

	/**
	 * 提交留档目录。
	 * @param text - 输入框里的原文。
	 */
	const commit = useCallback(
		(text: string): void => {
			setDraft(null);
			setNote('');
			const trimmed = text.trim();
			if (trimmed === current) return;
			void mutateSettings(getApi(), scope, [
				trimmed === ''
					? { op: 'unset', path: [FIELD_ARCHIVE_DIR] }
					: { op: 'set', path: [FIELD_ARCHIVE_DIR], value: trimmed },
			]).catch((error: unknown) => {
				setNote(error instanceof Error ? error.message : String(error));
			});
		},
		[current, getApi, scope],
	);

	/**
	 * 提交设计技能文案（与留档同一套：本地草稿 + 失焦提交 + 深路径 op）。
	 *
	 * **清空并提交 = unset**，设置文档回到内置文案 —— 这就是「恢复默认」的入口，
	 * 不必再做一个专门的按钮（改坏了想回去：全选删掉，点一下别处）。
	 * @param text - 文本域里的原文。
	 */
	const commitSkill = useCallback(
		(text: string): void => {
			setSkillDraft(null);
			setSkillNote('');
			const trimmed = text.trim();
			if (trimmed === skillCurrent.trim()) return;
			void mutateSettings(getApi(), scope, [
				trimmed === ''
					? { op: 'unset', path: [FIELD_DESKILL_TEXT] }
					: { op: 'set', path: [FIELD_DESKILL_TEXT], value: trimmed },
			]).catch((error: unknown) => {
				setSkillNote(error instanceof Error ? error.message : String(error));
			});
		},
		[getApi, scope, skillCurrent],
	);

	if (snapshot.status === 'loading') {
		return (
			<div className="ffc-set">
				<div className="ffc-set-status">正在读取设置…</div>
			</div>
		);
	}

	return (
		<div className="ffc-set">
			<div className="ffc-set-intro">
				这里是肥鱼画布自己的设置。生成用的供应商与模型在「图像 / 视频模型」那一页。
			</div>

			{/* ── 存储 ── */}
			<div className="ffc-set-group">存储</div>
			<div className="ffc-set-card">
				<label className="ffc-set-field">
					<span className="ffc-set-label">本地留档目录</span>
					<input
						className="ffc-set-input"
						data-archive-dir="true"
						type="text"
						value={draft ?? current}
						placeholder="例如 D:\肥鱼图库（留空 = 不留档）"
						disabled={!writable}
						onChange={(event) => {
							setDraft((event.target as HTMLInputElement).value);
						}}
						onBlur={(event) => {
							commit((event.target as HTMLInputElement).value);
						}}
						onKeyDown={(event) => {
							if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
						}}
					/>
					<span className="ffc-set-note">
						生成结果会在这里留一份副本（按日期分目录），聊天与画布改用本地副本。
						供应商给的地址是会过期的签名链接 —— 这就是「图放久了加载不出来」的原因；
						留空 = 只保留远端地址。相对路径按会话工作区解析，`~` 会展开成主目录。
					</span>
				</label>
				{note === '' ? null : (
					<div className="ffc-set-msg" data-kind="error" role="alert">
						{note}
					</div>
				)}
			</div>

			{/* ── 设计技能（P41；P45 加放大编辑） ── */}
			<div className="ffc-set-group">设计技能</div>
			<div className="ffc-set-card">
				<div className="ffc-set-labelrow">
					<span className="ffc-set-label">注入聊天模型的设计要求（内置的那份，可以直接改）</span>
					<button
						type="button"
						className="ffc-tbtn"
						data-design-skill-big="true"
						title="放大编辑"
						onClick={() => setSkillBig(true)}
					>
						放大
					</button>
				</div>
				<label className="ffc-set-field">
					<textarea
						className="ffc-set-input ffc-set-textarea"
						data-design-skill="true"
						rows={5}
						spellCheck={false}
						value={skillValue}
						disabled={!writable}
						onChange={(event) => {
							setSkillDraft((event.target as HTMLTextAreaElement).value);
						}}
						onBlur={(event) => {
							commitSkill((event.target as HTMLTextAreaElement).value);
						}}
					/>
					<span className="ffc-set-note">
						设计技能开着时，这段文案会注入聊天模型的 system prompt —— 由它按这些要求
						组织发给生成模型（图像 / 视频）的提示词。出图效果不合意就改这里，下一次
						生成（下一次请求）立即生效，绝不写进发给生成模型的 prompt。
						开关在聊天输入框旁边那枚鲸鱼尾巴上：左键选模型，<b>右键</b>开关
						（开着时尾巴保持选模型的蓝色，关掉后变回默认的纯色）。
						改坏了想回去：清空并点一下别处 = 恢复内置文案。
					</span>
				</label>
				{skillNote === '' ? null : (
					<div className="ffc-set-msg" data-kind="error" role="alert">
						{skillNote}
					</div>
				)}
			</div>

			{/* ── 放大编辑窗（P45）：同一份草稿，失焦 / 收起 / Esc 都提交并收起 ── */}
			{skillBig ? (
				<div
					className="ffc-set-big"
					role="dialog"
					aria-modal="true"
					aria-label="放大编辑设计技能"
					data-design-skill-open="true"
					onKeyDown={(event) => {
						if (event.key === 'Escape') {
							commitSkill(skillValue);
							setSkillBig(false);
						}
					}}
				>
					<div className="ffc-set-big-card">
						<div className="ffc-set-labelrow">
							<span className="ffc-set-label">注入聊天模型的设计要求（内置的那份，可以直接改）</span>
							<button
								type="button"
								className="ffc-tbtn"
								data-design-skill-big-close="true"
								/* 缩下去那一下别先把文本框 blur 掉：让收起按钮的 onClick 一个 commit 打住 */
								onMouseDown={(event) => event.preventDefault()}
								onClick={() => {
									commitSkill(skillValue);
									setSkillBig(false);
								}}
							>
								收起
							</button>
						</div>
						<textarea
							className="ffc-set-input ffc-set-textarea ffc-set-big-text"
							data-design-skill-big-text="true"
							autoFocus
							spellCheck={false}
							value={skillValue}
							disabled={!writable}
							onChange={(event) => {
								setSkillDraft((event.target as HTMLTextAreaElement).value);
							}}
							onBlur={(event) => {
								commitSkill((event.target as HTMLTextAreaElement).value);
							}}
						/>
					</div>
				</div>
			) : null}
		</div>
	);
}
