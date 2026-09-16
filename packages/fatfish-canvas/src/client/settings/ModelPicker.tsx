/**
 * 生成模型选择：**composer 工具行里、本体模型位左边那一格**（P17）。
 *
 * 为什么从画布工具条搬到这里：画布工具条是这个插件的主界面，但「生成模型」与
 * 本体那个「对话模型」是**同一类东西**，用户找它的时候眼睛在输入框那一行
 * （官方 `conversation.input.model` 就住在那里）。这一格注册进
 * `conversation.input.right` —— ui-conversation 的 composer bar 渲染顺序是
 * `input.right` → `input.model` → 用量环 → 发送，所以它落在官方模型位的**紧左边**，
 * 是「模型的旁边」这句话能落到的最准的位置。
 *
 * **外观照官方 `ModelSelect` 抄**（不是「看着像」，是同一批数值）：触发器
 * 13px/500、胶囊 24px、第二段用 caption 色；菜单 `--dsw-specific-menu` 底、
 * 20px 圆角、`--dsw-elevation-prominent` 阴影、sticky 分组标题、行高 38px、
 * 模型名 14px/500，勾与箭头直接用本体 primitives 的那两个图标。
 * 菜单**挂到 document.body**（官方同款）：composer 在 AppFrame 里，祖先上任何
 * `overflow` / `transform` 都会把 fixed 弹层裁掉或挪位。
 *
 * 数据与写入口在 `settings/models.ts`：菜单里选一下写的就是设置页那两个默认字段，
 * 两个入口永远一致。
 *
 * @module fatfish-canvas/client/settings/ModelPicker
 */

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { IconCheckOutline16, IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives';
import { ModelIcon } from '../icons';
import { useMenuDismiss, useMenuFocus, useMenuNav } from '../menu';
import { setDefaultModel, useModelCatalog, type ModelOption, type PickKind } from './models';

/** 菜单里「自动」那一项的 id（模型 ref 形如 `供应商::模型`，不会与它撞车）。 */
const AUTO_ID = '__auto__';

/** 两个页签（视觉模型不是产物，不在这里）。 */
const TABS: readonly { kind: PickKind; label: string }[] = [
	{ kind: 'image', label: '图像' },
	{ kind: 'video', label: '视频' },
];

/** 菜单与视口边缘的最小间距（官方 ModelSelect 同款）。 */
const MARGIN = 12;

/** 还没量到尺寸之前的位置：藏起来但**参与布局**，否则量出来是 0×0（官方同款做法）。 */
const MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 } as const;

/**
 * 取 `供应商::模型` 里的模型名（触发器上显示它，比分组长）。
 * @param ref - 默认模型取值。
 * @returns 显示名；空取值返回空串。
 */
function shortName(ref: string): string {
	const at = ref.indexOf('::');
	return at < 0 ? ref : ref.slice(at + 2);
}

/**
 * 一个模型行（官方 `.option` 的形状：左列文案 + 右列勾）。
 * @param props - 选项、是否当前、导航 props 与选中回调。
 * @returns 菜单条目。
 */
function OptionRow({
	option,
	current,
	navProps,
	onPick,
}: {
	option: ModelOption;
	current: boolean;
	navProps: Record<string, unknown>;
	onPick: () => void;
}): ReactNode {
	return (
		<button
			type="button"
			role="menuitemradio"
			aria-checked={current}
			className="ffc-mp-option"
			data-model-option={option.ref}
			title={option.ref}
			onClick={onPick}
			{...navProps}
		>
			<span className="ffc-mp-copy">
				<span className="ffc-mp-name">{option.modelLabel}</span>
			</span>
			<span className="ffc-mp-check">{current ? <IconCheckOutline16 /> : null}</span>
		</button>
	);
}

/**
 * 模型选择器（composer 工具行一格）。
 * @returns 触发器 + （打开时的）菜单。
 */
export function ModelPicker(): ReactNode {
	const catalog = useModelCatalog();
	const [open, setOpen] = useState(false);
	const [kind, setKind] = useState<PickKind>('image');
	/** 一次失败的一句话说明（菜单底部那行）。 */
	const [note, setNote] = useState('');
	/** 菜单左上角（视口坐标）；null = 还没量到尺寸。 */
	const [at, setAt] = useState<{ left: number; top: number } | null>(null);
	const rootRef = useRef<HTMLDivElement | null>(null);
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const menuRef = useRef<HTMLDivElement | null>(null);

	const close = useCallback(() => {
		setOpen(false);
		setNote('');
	}, []);

	const pick = useCallback(
		(id: string) => {
			void setDefaultModel(kind, id === AUTO_ID ? '' : id)
				.then(() => {
					close();
				})
				.catch((error: unknown) => {
					// 写不进去（只读设置 / 写入面缺席）时**别把菜单关掉**：
					// 那正是用户要看原因的地方。
					setNote(error instanceof Error ? error.message : String(error));
				});
		},
		[close, kind],
	);

	const options = catalog === undefined ? [] : catalog[kind];
	const current = catalog === undefined ? '' : catalog.defaults[kind];
	const nav = useMenuNav({
		ids: [AUTO_ID, ...options.map((option) => option.ref)],
		onChoose: pick,
		onClose: close,
	});
	useMenuFocus(menuRef, [open]);
	// resize 交给下面的 place()（弹层跟着窗口重排，而不是关掉）
	useMenuDismiss({ menuRef, buttonRef: triggerRef, onClose: close, watchResize: false });

	/**
	 * 定位菜单：贴着触发器**向上**弹（右缘对齐），并夹进视口。
	 *
	 * 与官方 `ModelSelect` 同款 —— 包括「先按 0,0 量一次真实尺寸、再算最终位置」
	 * 这一步：菜单宽度由模型名决定，纯估算会在长名字上贴边。
	 */
	useLayoutEffect(() => {
		if (!open) {
			setAt(null);
			return undefined;
		}
		const place = (): void => {
			const rect = triggerRef.current?.getBoundingClientRect();
			if (rect === undefined) return;
			const width = menuRef.current?.offsetWidth ?? 0;
			const height = menuRef.current?.offsetHeight ?? 0;
			let left = rect.right - width;
			let top = rect.top - 8 - height;
			if (width > 0) left = Math.min(Math.max(left, MARGIN), window.innerWidth - width - MARGIN);
			if (height > 0) top = Math.min(Math.max(top, MARGIN), window.innerHeight - height - MARGIN);
			setAt({ left, top });
		};
		place();
		window.addEventListener('scroll', place, true);
		window.addEventListener('resize', place);
		return () => {
			window.removeEventListener('scroll', place, true);
			window.removeEventListener('resize', place);
		};
	}, [open, kind, catalog]);

	const imageName = catalog === undefined ? '' : shortName(catalog.defaults.image);
	const videoName = catalog === undefined ? '' : shortName(catalog.defaults.video);
	const label = imageName === '' ? '自动' : imageName;
	const title =
		catalog === undefined
			? '设置服务还没就绪：暂时读不到生成模型'
			: `生成模型（点击切换）· 图像：${imageName === '' ? '自动' : imageName} · 视频：${
					videoName === '' ? '自动' : videoName
				}`;

	return (
		<div ref={rootRef} className="ffc-mp-root">
			<button
				ref={triggerRef}
				type="button"
				className="ffc-mp-trigger"
				data-ffc-ui="model-picker"
				aria-haspopup="menu"
				aria-expanded={open}
				aria-label={`选择生成模型，当前图像模型 ${label}`}
				title={title}
				onClick={() => {
					setNote('');
					setOpen((prev) => !prev);
				}}
			>
				<ModelIcon size={16} className="ffc-mp-icon" />
				<span className="ffc-mp-label">图像</span>
				<span className="ffc-mp-value">{label}</span>
				{/* 旋转挂在自己的 span 上：本体那个图标组件是否把 data-* 透传到 svg
				    不由我们决定，包一层就与它无关了。 */}
				<span className="ffc-mp-chevron" data-open={open ? 'true' : undefined}>
					<IconChevronDownOutline14 />
				</span>
			</button>

			{open
				? createPortal(
						<div
							ref={menuRef}
							className="ffc-mp-menu"
							role="menu"
							aria-label="选择生成模型"
							tabIndex={-1}
							style={
								at === null
									? MEASURE_STYLE
									: { left: `${String(at.left)}px`, top: `${String(at.top)}px` }
							}
							onKeyDown={nav.onKeyDown}
							{...nav.containerProps}
						>
							<div className="ffc-mp-tabs" role="tablist" aria-label="模型种类">
								{TABS.map((tab) => (
									<button
										key={tab.kind}
										type="button"
										role="tab"
										aria-selected={tab.kind === kind}
										className="ffc-mp-tab"
										data-tab={tab.kind}
										data-active={tab.kind === kind ? 'true' : undefined}
										onClick={() => {
											setKind(tab.kind);
											setNote('');
										}}
									>
										{tab.label}
									</button>
								))}
							</div>

							<div className="ffc-mp-groups">
								<button
									type="button"
									role="menuitemradio"
									aria-checked={current === ''}
									className="ffc-mp-option"
									data-model-auto="true"
									onClick={() => {
										pick(AUTO_ID);
									}}
									{...nav.itemProps(AUTO_ID)}
								>
									<span className="ffc-mp-copy">
										<span className="ffc-mp-name">自动（第一个配好密钥的）</span>
									</span>
									<span className="ffc-mp-check">
										{current === '' ? <IconCheckOutline16 /> : null}
									</span>
								</button>

								{options.length === 0 ? (
									<div className="ffc-mp-empty">
										还没有配置{kind === 'image' ? '图像' : '视频'}模型 —— 去「设置 → 图像 / 视频模型」添加。
									</div>
								) : (
									options.map((option, index) => {
										const first = index === 0 || options[index - 1]?.providerId !== option.providerId;
										return (
											<div key={option.ref}>
												{/* 供应商分组标题（官方是 sticky 的）：只在换供应商时出现一次 */}
												{first ? <div className="ffc-mp-groupTitle">{option.providerLabel}</div> : null}
												<OptionRow
													option={option}
													current={current === option.ref}
													navProps={nav.itemProps(option.ref)}
													onPick={() => {
														pick(option.ref);
													}}
												/>
											</div>
										);
									})
								)}
							</div>

							<div className="ffc-mp-note" role={note === '' ? undefined : 'alert'}>
								{note !== ''
									? note
									: catalog === undefined
										? '设置服务还没就绪：刷新页面再试'
										: '选中的模型用于之后的生成，与设置页是同一份配置'}
							</div>
						</div>,
						document.body,
					)
				: null}
		</div>
	);
}
