/**
 * 设置页的**常用模型**区（P29）。
 *
 * ## 它是什么
 *
 * 「图像 / 视频模型」页里加的一块：把**配置里已有的模型按家族（`供应商::词干`）
 * 列出来**，一个家族一行。一行上能配三件事：
 *
 *   1. **常用** —— 勾上就进聊天栏那格（composer 的生成模型选择器）的「常用」分区；
 *   2. **质量参数** —— 那一排 chip 的取值（内置预置已经按模型类型备好了，
 *      也可以自己改参数名 / 取值，或者关掉）；
 *   3. **其他参数** —— 尺寸 / 背景 / 审核 / 格式 / 种子…的**默认值**。
 *      这里只声明「有哪些键」和默认值；**临时要改，就在对话里告诉模型**
 *      （它调 `media_generate` 时会带上，宿主按这里的声明过滤后展开进请求体）。
 *      **张数不在这里**：一次调用只出一张，多张靠模型在同一条消息里并发调用多次。
 *
 * ## 为什么按家族而不是按模型
 *
 * 「同一类型的模型共用一份配置」正是这一块存在的理由：网关上一个模型常常有
 * `gpt-image-2` / `gpt-image-2-2k` / `gpt-image-2-4k` 三个 id，将来还会多出
 * 别的尾缀。按**词干**归并之后，新出现的兄弟自动落进同一行、共用同一份参数 ——
 * 不需要（也不可能）为每个 id 各配一次。
 *
 * ## 写入
 *
 * 三件事写两个地方，都是深路径 op：
 *   - 勾选 / 质量开关 / 其他参数 → `commonModels[家族][…]`（`setCommonField`）；
 *   - 质量**声明**（参数名 + 取值）→ 家族里**第一个成员**那行的 `tiers`
 *     （家族级语义：同一词干谁声明都算，见 `shared/catalog.ts` 的 `tierAxesOf`）。
 *
 * @module fatfish-canvas/client/settings/CommonModels
 */

import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { tierLabel, type CommonModelConfig, type ModelKind, type TierAxis } from '../shared/catalog';
import { isParamKey, wirePathOf, type ParamSpec } from '../shared/modelPresets';
import { parseTierDraft, setCommonField, tierDraftOf, type FamilyRow } from './models';

/** 设置页里一个模型的形状（只声明这一块读的字段）。 */
export interface CommonModelEntry {
	id: string;
	kind: ModelKind;
	apiKeyEnv?: string;
	label?: string;
	tiers?: TierAxis;
}

/** 一个供应商的形状。 */
export interface CommonProviderEntry {
	label?: string;
	baseURL: string;
	apiKeyEnv?: string;
	models: CommonModelEntry[];
}

/** 组件属性（由 MediaSettings 传下来：数据与写入口都只有一份）。 */
export interface CommonModelsProps {
	/** 配置里的供应商表（配质量声明要整体重写某个供应商的 models）。 */
	providers: Readonly<Record<string, CommonProviderEntry>>;
	/** 家族清单（`familyRows` 的产物）。 */
	rows: readonly FamilyRow[];
	/** 能不能写（只读文档 / 写入面缺席时置灰）。 */
	writable: boolean;
	/** 整体替换某个供应商的 models 数组。 */
	onWriteModels: (providerId: string, models: readonly CommonModelEntry[], message: string | null) => void;
	/** 一次失败的说明（写在块顶部）。 */
	onError: (text: string) => void;
}

/**
 * 一个家族要显示的其他参数：预置声明的 + 用户自己加的。
 * @param preset - 预置声明的键。
 * @param params - 设置里已有的键值。
 * @returns 声明清单（预置在前，自定义在后）。
 */
function specsOf(preset: readonly ParamSpec[] | undefined, params: Readonly<Record<string, string>>): ParamSpec[] {
	const specs: ParamSpec[] = [...(preset ?? [])];
	for (const key of Object.keys(params)) {
		// 保留键（n / image / model / prompt）永远不会进请求体，别摆一个「填了不生效」的框
		if (!isParamKey(key)) continue;
		if (!specs.some((spec) => spec.key === key)) specs.push({ key, label: key });
	}
	return specs;
}

/**
 * 一个家族的配置行。
 *
 * 自己持有草稿（每个家族一份），提交时才写盘 —— 与设置页其它文本字段同一套规矩：
 * 逐键写盘 = 每敲一个字写一次设置，还会不断撞 revision。
 * @param props - 家族行、供应商表、能否写与两个回调。
 * @returns 一行。
 */
function FamilyLine({
	row,
	providers,
	writable,
	onWriteModels,
	onError,
}: {
	row: FamilyRow;
	providers: CommonModelsProps['providers'];
	writable: boolean;
	onWriteModels: CommonModelsProps['onWriteModels'];
	onError: CommonModelsProps['onError'];
}): ReactNode {
	const cfg: CommonModelConfig = row.common;
	/** 质量声明编辑器的草稿；null = 没在编辑。 */
	const [draft, setDraft] = useState<{ param: string; values: string } | null>(null);
	/** 其他参数的输入草稿（键 → 原文）。 */
	const [edits, setEdits] = useState<Record<string, string>>({});
	/** 正在输入的新键。 */
	const [newKey, setNewKey] = useState('');

	/** 跑一个写动作，失败就写在块顶部（不吞掉）。 */
	const write = useCallback(
		(fn: () => Promise<void>) => {
			void fn().catch((error: unknown) => {
				onError(error instanceof Error ? error.message : String(error));
			});
		},
		[onError],
	);

	/** 写这个家族的一个字段。 */
	const put = useCallback(
		(path: readonly string[], value: string | boolean | undefined) => {
			write(() => setCommonField(row.familyRef, path, value));
		},
		[write, row.familyRef],
	);

	const axis = row.axis;
	const specs = specsOf(row.preset?.params, cfg.params);
	/** 质量声明写在家族的第一个成员上（家族级语义，见模块头）。 */
	const target = row.members[0] ?? '';
	const models = providers[row.providerId]?.models ?? [];
	/** 重写家族里那一行的 tiers。 */
	const writeTiers = (tiers: TierAxis | undefined, message: string): void => {
		onWriteModels(
			row.providerId,
			models.map((model) => (model.id === target ? { ...model, tiers } : model)),
			message,
		);
	};

	return (
		<div className="ffc-cm-row" data-family={row.familyRef} data-preset={row.preset?.id ?? ''}>
			<div className="ffc-cm-head">
				<label className="ffc-cm-pin" title="勾上就进聊天栏那格的「常用」分区">
					<input
						type="checkbox"
						data-action="pin-common"
						checked={cfg.pinned}
						disabled={!writable}
						onChange={(event) => {
							const on = (event.target as HTMLInputElement).checked;
							put(['pinned'], on ? true : undefined);
						}}
					/>
					<span>常用</span>
				</label>
				<span className="ffc-cm-name">{row.preset?.label ?? row.stem}</span>
				<span className="ffc-badge">{row.providerLabel}</span>
				<span className="ffc-cm-kind" data-kind={row.kind}>
					{row.kind === 'video' ? '视频' : '图像'}
				</span>
				<span className="ffc-spacer" />
				{/* 成员照实列出来：这是「-2k / -4k 兄弟共用这一行」唯一看得见的地方 */}
				<span className="ffc-cm-members" title={row.members.join('、')}>
					{row.members.join(' / ')}
				</span>
			</div>

			<div className="ffc-cm-line">
				<span className="ffc-cm-key">质量</span>
				{draft === null ? (
					<>
						<span
							className="ffc-cm-axis"
							data-tier-param={axis?.param ?? ''}
							title="在聊天栏那格里选；选中的值会随请求发给供应商"
						>
							{axis === undefined
								? '这个类型没有质量参数'
								: `${axis.param}：${axis.values.map((value) => tierLabel(value, axis)).join(' / ')}`}
						</span>
						<button
							type="button"
							className="ffc-tbtn"
							data-action="edit-tiers"
							disabled={!writable}
							title="改这个家族的质量参数（参数名 + 取值）"
							onClick={() => {
								setDraft({ param: axis?.param ?? '', values: tierDraftOf(axis) });
							}}
						>
							{row.declared ? '改声明…' : '声明…'}
						</button>
						{/* 只有「预置顶上来」的那种轴才有关掉的必要：手写声明是用户明说的 */}
						{row.declared || row.preset === undefined ? null : (
							<button
								type="button"
								className="ffc-tbtn"
								data-action="toggle-quality"
								disabled={!writable}
								title={cfg.quality ? '关掉内置预置的质量参数（请求体里就不带它了）' : '重新启用内置预置的质量参数'}
								onClick={() => {
									put(['quality'], cfg.quality ? false : undefined);
								}}
							>
								{cfg.quality ? '不用预置' : '用预置'}
							</button>
						)}
					</>
				) : (
					<>
						<input
							className="ffc-set-input ffc-cm-paramname"
							type="text"
							spellCheck={false}
							data-field="tier-param"
							placeholder="参数名"
							title="请求体里的参数名，例如 quality"
							value={draft.param}
							onChange={(event) => {
								setDraft({ ...draft, param: (event.target as HTMLInputElement).value });
							}}
						/>
						<input
							className="ffc-set-input ffc-cm-paramvalues"
							type="text"
							spellCheck={false}
							data-field="tier-values"
							placeholder="取值，如 low=低, high=高"
							title="逗号分隔；用 = 给中文展示名"
							value={draft.values}
							onChange={(event) => {
								setDraft({ ...draft, values: (event.target as HTMLInputElement).value });
							}}
						/>
						<button
							type="button"
							className="ffc-tbtn"
							data-action="commit-tiers"
							disabled={!writable}
							onClick={() => {
								const parsed = parseTierDraft(draft.param, draft.values);
								if (parsed.axis === undefined) {
									onError(parsed.error);
									return;
								}
								writeTiers(
									parsed.axis,
									`${row.stem} 的质量参数已保存（${parsed.axis.param}：${parsed.axis.values.join('/')}）`,
								);
								setDraft(null);
							}}
						>
							保存
						</button>
						<button
							type="button"
							className="ffc-tbtn"
							data-action="cancel-tiers"
							onClick={() => {
								setDraft(null);
							}}
						>
							取消
						</button>
						{row.declared ? (
							<button
								type="button"
								className="ffc-tbtn"
								data-action="clear-tiers"
								disabled={!writable}
								title="清掉手写声明（有内置预置的话就回到预置）"
								onClick={() => {
									writeTiers(undefined, `已清除 ${row.stem} 的质量声明`);
									setDraft(null);
								}}
							>
								清除声明
							</button>
						) : null}
					</>
				)}
			</div>

			<div className="ffc-cm-line ffc-cm-other">
				<span className="ffc-cm-key">其他</span>
				{specs.length === 0 ? (
					<span className="ffc-cm-axis">这个类型没有备好的其他参数 —— 可以自己加键</span>
				) : null}
				{specs.map((spec) => {
					const stored = cfg.params[spec.key];
					const custom = !(row.preset?.params ?? []).some((entry) => entry.key === spec.key);
					return (
						<label
							className="ffc-cm-param"
							key={spec.key}
							// 键在设置页是平铺的，落到请求体可能被摊进嵌套对象（`metadata.resolution`）
							title={`请求体里的键：${wirePathOf(row.preset?.wire, spec.key)}`}
						>
							<span className="ffc-cm-paramlabel">{spec.label}</span>
							{spec.values === undefined ? (
								<input
									className="ffc-set-input ffc-cm-paraminput"
									type="text"
									spellCheck={false}
									data-param={spec.key}
									disabled={!writable}
									placeholder="不传"
									value={edits[spec.key] ?? stored ?? ''}
									onChange={(event) => {
										setEdits((prev) => ({ ...prev, [spec.key]: (event.target as HTMLInputElement).value }));
									}}
									onBlur={(event) => {
										const text = (event.target as HTMLInputElement).value;
										setEdits((prev) => {
											const next = { ...prev };
											delete next[spec.key];
											return next;
										});
										put(['params', spec.key], text.trim() === '' ? undefined : text.trim());
									}}
								/>
							) : (
								<select
									className="ffc-set-input ffc-cm-paraminput"
									data-param={spec.key}
									disabled={!writable}
									value={stored ?? ''}
									onChange={(event) => {
										const text = (event.target as HTMLSelectElement).value;
										put(['params', spec.key], text === '' ? undefined : text);
									}}
								>
									<option value="">不传</option>
									{spec.values.map((value) => (
										<option key={value} value={value}>
											{value}
										</option>
									))}
								</select>
							)}
							{custom ? (
								<button
									type="button"
									className="ffc-tbtn ffc-cm-drop"
									data-action="remove-param"
									disabled={!writable}
									title="删掉这个自定义键"
									onClick={() => {
										put(['params', spec.key], undefined);
									}}
								>
									×
								</button>
							) : null}
						</label>
					);
				})}
				<span className="ffc-cm-addkey">
					<input
						className="ffc-set-input ffc-cm-paraminput"
						type="text"
						spellCheck={false}
						data-field="new-param"
						disabled={!writable}
						placeholder="自定义键"
						title="预置里没有的键（网关自己的参数）—— 小写字母开头，只含小写字母数字下划线"
						value={newKey}
						onChange={(event) => {
							setNewKey((event.target as HTMLInputElement).value);
						}}
					/>
					<button
						type="button"
						className="ffc-tbtn"
						data-action="add-param"
						disabled={!writable || newKey.trim() === ''}
						onClick={() => {
							const key = newKey.trim();
							if (!/^[a-z][a-z0-9_]*$/.test(key)) {
								onError(`参数键 "${key}" 不能这么写：要小写字母开头，只含小写字母数字与下划线`);
								return;
							}
							// 空串 = 只声明这个键（默认不传），这样模型调用时才允许传它
							put(['params', key], '');
							setNewKey('');
						}}
					>
						＋
					</button>
				</span>
			</div>
		</div>
	);
}

/**
 * 「常用模型」整块。
 * @param props - 供应商表、家族行与写入口。
 * @returns 一块（没有模型时只给一句下一步提示）。
 */
export function CommonModels({ providers, rows, writable, onWriteModels, onError }: CommonModelsProps): ReactNode {
	return (
		<>
			<div className="ffc-set-group">常用模型（{rows.length}）</div>
			<div className="ffc-set-card" data-ffc-common="true">
				<div className="ffc-set-hint">
					一行 = 一个模型类型（同一词干的 -2k / -4k 兄弟共用这一行，以后新出现的尾缀自动一起覆盖）。
					勾「常用」的会排在聊天栏那格的前面；<b>质量</b>参数在聊天栏那格里选；
					<b>其他</b>参数这里只定默认值 —— 临时要改就在对话里说（例如「背景透明」），
					模型会带着这些参数发起生成。要一次出多张就直接说（例如「出 4 张」）：
					模型会在同一条消息里**并发**调用多次，每张各落一个画布节点。
				</div>
				{rows.length === 0 ? (
					<div className="ffc-set-hint">还没有模型 —— 先在上面添加供应商与模型，这里就会按类型列出来。</div>
				) : (
					rows.map((row) => (
						<FamilyLine
							key={row.familyRef}
							row={row}
							providers={providers}
							writable={writable}
							onWriteModels={onWriteModels}
							onError={onError}
						/>
					))
				)}
			</div>
		</>
	);
}
