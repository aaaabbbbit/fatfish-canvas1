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
 * **P39：这个界面按用户给的四张参考图改过三件事**
 *
 *   1. **触发器只剩一枚图标**（鲸鱼尾巴，与右上角那枚入口同一个组件 / 同一个尺寸）：
 *      模型名与「图像」两段文字都**搬进菜单**（菜单第一行 = 当前选中的模型）——
 *      用户要的是「名字点了才看得见，主界面只留一个图标」。触发器没有文字，
 *      语义由 aria-label 与 title 承担。
 *   2. **衍生档位「移上去就跳出来」**：家族行（有分辨率兄弟 / 声明了质量轴的那种）
 *      一悬停就把它那几条档位开成一块**飞出面板**（`.ffc-mp-flyout`）贴在菜单右侧，
 *      不用再点一下。行与面板之间那几像素的缝由一颗 150ms 的定时器兜住
 *      （`holdFly` / `dropFly`）—— 否则指针路过缝的时候面板会闪。键盘仍是 Enter 开关。
 *   3. 家族行悬停时尾巴会摇（纯 CSS，与入口同款）；**选过模型之后尾巴是强调蓝**
 *      （`data-ffc-picked`，见 styles.ts）——「自动」时是次要文字色。
 *
 * **P41：右键 = 开关设计技能**。这一格的尾巴现在还是「设计技能」的开关：
 * 左键选模型不变，右键切换同名的设置开关 —— 开 = 把「肥鱼画布」设置页里那份
 * 设计技能文案注入聊天模型的 system prompt（它按此组织提示词），关 = 不注入，
 * 且尾巴压回默认纯色（关得看得见）。
 * 页面上只有 `data-ffc-skill='false'`（关闭态）一个挂载点：开着时颜色只能由
 * P39 那个 picked 属性决定（默认观感不变），关着时一条 CSS 把它压回次要文字色。
 *
 * 菜单外观照官方 `ModelSelect` 抄（不是「看着像」，是同一批数值）：菜单
 * `--dsw-specific-menu` 底、`--dsw-radius-lg` 圆角、`--dsw-elevation-prominent` 阴影、
 * sticky 分组标题、行高 34px、模型名 13px/400，勾与箭头直接用本体 primitives 的那两个图标。
 * 菜单**挂到 document.body**（官方同款）：composer 在 AppFrame 里，祖先上任何
 * `overflow` / `transform` 都会把 fixed 弹层裁掉或挪位。
 *
 * ⚠️ 菜单与飞出面板渲染在**同一个浮层容器**（`.ffc-mp-layer`）里，那一层也是
 * `role="menu"` / 焦点 / 键盘的挂载点 —— `useMenuDismiss` 只查一个 ref，
 * 于是「点飞出面板里的档位」不算点到外面。否则 pointerdown 会先把面板卸掉、
 * 随后的 click 找不到目标：整块面板看着能点却点不动（NOTES §8.48 那个坑）。
 *
 * 数据与写入口在 `settings/models.ts`：菜单里选一下写的就是设置页那两个默认字段，
 * 两个入口永远一致。
 *
 * @module fatfish-canvas/client/settings/ModelPicker
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { IconCheckOutlineRegular, IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import { WhaleTailIcon } from '../icons';
import { useMenuDismiss, useMenuFocus, useMenuNav, type MenuNav } from '../menu';
import { tierLabel } from '../shared/catalog';
import {
	familyTarget,
	pickRows,
	pickerPartition,
	setDefaultModel,
	setDesignSkill,
	setTier,
	tierTextOf,
	useModelCatalog,
	type ModelOption,
	type PickKind,
	type PickRow,
} from './models';

/** 菜单里「自动」那一项的 id（模型 ref 形如 `供应商::模型`，不会与它撞车）。 */
const AUTO_ID = '__auto__';

/** 家族行的导航 id 前缀（同上：模型 ref 里不会出现这个前缀）。 */
const FAMILY_PREFIX = 'family:';

/** 质量档位 chip 的导航 id 前缀。 */
const TIER_PREFIX = 'tier:';

/** 没有分辨率档位词（词干本身就是一个模型）时，成员行显示的档位名。 */
const BARE_TIER_LABEL = '默认';

/** 两个页签（视觉模型不是产物，不在这里）。 */
const TABS: readonly { kind: PickKind; label: string }[] = [
	{ kind: 'image', label: '图像' },
	{ kind: 'video', label: '视频' },
];

/** 菜单与视口边缘的最小间距（官方 ModelSelect 同款）。 */
const MARGIN = 12;

/** 飞出面板与菜单之间的缝（px）。 */
const FLY_GAP = 4;

/**
 * 指针从家族行挪到飞出面板这段时间里，面板最多还能活多久（ms）。
 *
 * 为什么需要它：行与面板之间隔着 `FLY_GAP` 那几像素，指针路过时行的
 * `mouseleave` 先到、面板的 `mouseenter` 后到 —— 没有这段宽限，面板会在
 * 指针**正要进去**的瞬间收掉（看起来就是「移过去就没了」）。
 * 取 150ms：比一次快速划过的间隔长，又短到「移开就收」不显拖沓。
 */
const FLY_GRACE = 150;

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
 * 展开状态下键盘导航要走过的 id 清单（折叠的家族只算它自己那一行）。
 * @param rows - picker 的行。
 * @param expanded - 当前展开的家族键。
 * @returns 条目 id（显示顺序）。
 */
function navIdsOf(rows: readonly PickRow[], expanded: string | null): string[] {
	const ids: string[] = [AUTO_ID];
	for (const row of rows) {
		if (row.kind === 'one') {
			ids.push(row.option.ref);
			continue;
		}
		ids.push(`${FAMILY_PREFIX}${row.key}`);
		if (expanded !== row.key) continue;
		// 成员行**总是**列出来（哪怕只有一个）：家族行只是展开开关，
		// 「用这个模型」必须有一个自己的按钮（见 familyTarget 的说明）
		for (const member of row.options) ids.push(member.ref);
		if (row.axis !== undefined) {
			for (const value of row.axis.values) ids.push(`${TIER_PREFIX}${row.key}:${value}`);
		}
	}
	return ids;
}

/**
 * 一行属于哪个供应商（分组标题用）。
 *
 * 家族的成员必然同属一个供应商 —— 分组本来就是按供应商做的，`pickRows` 只把
 * 兄弟折起来，不会把两个供应商合成一行。
 * @param row - picker 的行。
 * @returns 供应商 id / 展示名。
 */
function providerOf(row: PickRow): { id: string; label: string } {
	if (row.kind === 'one') return { id: row.option.providerId, label: row.option.providerLabel };
	const first = row.options[0];
	return { id: first?.providerId ?? '', label: first?.providerLabel ?? '' };
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
	label,
	indent,
}: {
	option: ModelOption;
	current: boolean;
	navProps: Record<string, unknown>;
	onPick: () => void;
	/** 左列文案；省略时用模型自己的展示名（家族成员行传档位名）。 */
	label?: string;
	/** 是否是家族展开出来的成员行（缩进 + 小字）。 */
	indent?: boolean;
}): ReactNode {
	return (
		<button
			type="button"
			role="menuitemradio"
			aria-checked={current}
			className="ffc-mp-option"
			data-model-option={option.ref}
			data-indent={indent === true ? 'true' : undefined}
			title={option.ref}
			onClick={onPick}
			{...navProps}
		>
			<span className="ffc-mp-copy">
				<span className="ffc-mp-name">{label ?? option.modelLabel}</span>
			</span>
			<span className="ffc-mp-check">{current ? <IconCheckOutlineRegular /> : null}</span>
		</button>
	);
}

/**
 * 一个**家族行**：有分辨率兄弟（`…-1k / …-2k / …-4k`）或声明了质量轴的那种模型。
 *
 * 它自己**只是那一行**（名字 + 当前档位 + 勾 + 指向右边的箭头）：档位那几条现在
 * 开在它旁边的**飞出面板**里（`FamilyPanel`），鼠标移上来就跳出来（父组件的
 * `onMouseEnter` → 打开），点它也一样（触屏没有悬停，点击是那条路）。
 *
 * 没有兄弟、也没有声明的模型**根本走不到这里**（`pickRows` 给的是平铺行），
 * 所以「档位」这件事对老配置的观感是零影响。
 * @param props - 家族行、当前默认、是否开着、导航与「打开」回调。
 * @returns 一行。
 */
function FamilyRow({
	row,
	current,
	expanded,
	nav,
	onToggle,
}: {
	row: Extract<PickRow, { kind: 'family' }>;
	current: string;
	expanded: boolean;
	nav: MenuNav;
	onToggle: () => void;
}): ReactNode {
	const selected = row.options.find((option) => option.ref === current);
	const axis = row.axis;
	return (
		<button
			type="button"
			role="menuitem"
			aria-expanded={expanded}
			className="ffc-mp-option ffc-mp-family"
			data-model-family={row.key}
			title={row.key}
			onClick={onToggle}
			{...nav.itemProps(`${FAMILY_PREFIX}${row.key}`)}
		>
			<span className="ffc-mp-copy">
				<span className="ffc-mp-name">{row.label}</span>
			</span>
			{row.options.length > 1 && selected !== undefined ? (
				<span className="ffc-mp-tier">{selected.tier === '' ? BARE_TIER_LABEL : selected.tier.toUpperCase()}</span>
			) : null}
			{axis === undefined ? null : <span className="ffc-mp-tier">{tierLabel(row.tier, axis)}</span>}
			<span className="ffc-mp-check">{selected === undefined ? null : <IconCheckOutlineRegular />}</span>
			<span className="ffc-mp-chevron" data-open={expanded ? 'true' : undefined}>
				<IconChevronDownOutlineRegular />
			</span>
		</button>
	);
}

/**
 * 一个家族的档位面板（飞出面板的内容，P39）。
 *
 * 与「家族行」分开是因为它**不在菜单 DOM 里** —— 它挂在浮层容器下的
 * `.ffc-mp-flyout` 上（菜单那个滚动容器有 `overflow`，绝对定位的子节点会被裁掉）。
 * 内容与旧版的行内展开逐字相同：
 *   1. **成员行**（含只有一个成员的那种）：这是「用这个模型、不动档位」的按钮 ——
 *      家族行本身是开关，不列成员行就等于没有选中入口（NOTES §8.51）；
 *   2. **质量档 chip**：写 `defaultTiers`，宿主展开进请求体，选档同时用这个模型。
 * @param props - 家族行、当前默认、导航与两个写入口。
 * @returns 面板内容。
 */
function FamilyPanel({
	row,
	current,
	nav,
	onPick,
	onTier,
}: {
	row: Extract<PickRow, { kind: 'family' }>;
	current: string;
	nav: MenuNav;
	onPick: (ref: string) => void;
	onTier: (value: string) => void;
}): ReactNode {
	const selected = row.options.find((option) => option.ref === current);
	const axis = row.axis;
	return (
		<>
			{/* 成员行（含只有一个成员的那种）：这是「用这个模型、不动档位」的按钮 */}
			{row.options.map((member) => (
				<OptionRow
					key={member.ref}
					option={member}
					indent
					label={member.tier === '' ? BARE_TIER_LABEL : member.tier.toUpperCase()}
					current={current === member.ref}
					navProps={nav.itemProps(member.ref)}
					onPick={() => {
						onPick(member.ref);
					}}
				/>
			))}
			{axis === undefined ? null : (
				<div className="ffc-mp-tierrow">
					{/* 参数名照实显示：不同网关同一件事叫法不同，藏起来反而不好排查 */}
					<span className="ffc-mp-tiername">{axis.param}</span>
					{axis.values.map((value) => (
						<button
							key={value}
							type="button"
							role="menuitemradio"
							aria-checked={row.tier === value}
							className="ffc-mp-chip"
							data-tier-value={value}
							data-active={row.tier === value ? 'true' : undefined}
							title={`选「${tierLabel(value, axis)}」= 用这个模型（${selected?.modelId ?? row.options[0]?.modelId ?? row.label}）+ 这一档`}
							onClick={() => {
								onTier(value);
							}}
							{...nav.itemProps(`${TIER_PREFIX}${row.key}:${value}`)}
						>
							{row.tier === value ? <IconCheckOutlineRegular /> : null}
							{tierLabel(value, axis)}
						</button>
					))}
					{/* 说清楚点档位会发生什么：它同时是「选用这个模型」 */}
					<span className="ffc-mp-tierhint">选档即用此模型</span>
				</div>
			)}
		</>
	);
}

/**
 * 模型选择器（composer 工具行一格）。
 * @returns 图标触发器 + （打开时的）菜单与飞出面板。
 */
export function ModelPicker(): ReactNode {
	const catalog = useModelCatalog();
	const [open, setOpen] = useState(false);
	const [kind, setKind] = useState<PickKind>('image');
	/** 一次失败的一句话说明（菜单底部那行）。 */
	const [note, setNote] = useState('');
	/**
	 * 飞出面板开着的那个家族键（同一时刻只开一个：弹层本来就窄）。
	 *
	 * 三个来源共用它：鼠标悬停家族行、点击家族行（触屏那条路）、键盘 Enter。
	 */
	const [expanded, setExpanded] = useState<string | null>(null);
	/**
	 * 是否展开「其他模型」（没勾过任何常用模型时这一项无意义：那时全都平铺着）。
	 *
	 * 勾过常用之后**默认只显示常用的那几个** —— 这是设置页那一块存在的意义
	 * （把列表收成自己常用的那几个），但没勾过时观感与升级前完全一致。
	 */
	const [showAll, setShowAll] = useState(false);
	/** 菜单左上角（视口坐标）；null = 还没量到尺寸。 */
	const [at, setAt] = useState<{ left: number; top: number } | null>(null);
	/** 飞出面板左上角（视口坐标）；null = 还没量到尺寸（量到之前藏起来参与布局）。 */
	const [flyAt, setFlyAt] = useState<{ left: number; top: number } | null>(null);
	const rootRef = useRef<HTMLDivElement | null>(null);
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const menuRef = useRef<HTMLDivElement | null>(null);
	/** 浮层容器（菜单 + 飞出面板的共同祖先，见文件头那段 ⚠️）。 */
	const layerRef = useRef<HTMLDivElement | null>(null);
	const flyRef = useRef<HTMLDivElement | null>(null);
	/** 「马上收起飞出面板」那颗定时器（指针在行与面板之间穿行时要能取消）。 */
	const flyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	/** 取消待收的定时器（指针回到行 / 面板上时用）。 */
	const holdFly = useCallback(() => {
		if (flyTimer.current !== null) {
			clearTimeout(flyTimer.current);
			flyTimer.current = null;
		}
	}, []);

	/** 立刻收起飞出面板（指针移到别的行上时用）。 */
	const dropFlyNow = useCallback(() => {
		holdFly();
		setExpanded(null);
	}, [holdFly]);

	/** 推迟收起飞出面板：给指针穿过行与面板之间那条缝的时间（见 FLY_GRACE）。 */
	const dropFlySoon = useCallback(() => {
		holdFly();
		flyTimer.current = setTimeout(() => {
			flyTimer.current = null;
			setExpanded(null);
		}, FLY_GRACE);
	}, [holdFly]);

	/** 开某个家族的飞出面板（悬停与点击都走这里；重复调用是幂等的）。 */
	const openFly = useCallback(
		(key: string) => {
			holdFly();
			setExpanded(key);
		},
		[holdFly],
	);

	// 卸载时把待收的定时器清掉：它调的是 setState，落在已卸载的组件上会白报一条警告
	useEffect(() => () => {
		holdFly();
	}, [holdFly]);

	const close = useCallback(() => {
		holdFly();
		setOpen(false);
		setNote('');
		setExpanded(null);
		setShowAll(false);
	}, [holdFly]);

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

	/**
	 * 右键触发器 = 开关**设计技能**（P41）。
	 *
	 * 与左键无关：左键是开菜单，右键在菜单外 —— 必须 `preventDefault()`，否则
	 * 浏览器原生菜单会盖住切换结果（P41 复测真实踩中：e2e 的 CDP 派发不开原生
	 * 菜单，所以测试绿着这个洞也测不出来）。失败时把菜单打开并显示原因：
	 * 菜单底部那行就是这类写入失败的说明位（与选模型失败同一处文案），
	 * 而静默失败的表现「点了没反应」正是这类交互最容易出错的方式。
	 */
	const toggleSkill = useCallback((event: unknown) => {
		(event as { preventDefault(): void }).preventDefault();
		void setDesignSkill(!(catalog?.designSkillOn ?? true)).catch((error: unknown) => {
			setNote(error instanceof Error ? error.message : String(error));
			setOpen(true);
		});
	}, [catalog]);

	const options = catalog === undefined ? [] : catalog[kind];
	const current = catalog === undefined ? '' : catalog.defaults[kind];
	/** 折成行：有分辨率兄弟、或声明了质量轴的模型折叠成一个家族行。 */
	const rows = pickRows(options, catalog?.tiers ?? {});
	/** 设置页勾过「常用」的家族（没勾过时下面的分区不出现，观感与升级前一致）。 */
	const common = catalog?.common ?? {};
	const { pinned: pinnedRows, others: otherRows } = pickerPartition(rows, common);
	/** 真正渲染出来的行（键盘导航也按它走，否则焦点会跑到看不见的条目上）。 */
	const visibleRows = pinnedRows.length === 0 || showAll ? [...pinnedRows, ...otherRows] : pinnedRows;

	/**
	 * 点一个**质量档**：写档位，**并且把默认模型换成这个家族的模型**。
	 *
	 * 为什么必须一起换：家族行本身是展开开关，而只有一个成员的家族展开后没有别的
	 * 入口 —— 点档位是用户在这个家族上唯一的动作，不换模型就等于「点了却没用上它」
	 * （用户报的「展开挡住了选择使用此模型的按键」）。
	 *
	 * 菜单关不关按「是不是换了模型」分：换了就与选模型同款关掉；只是换档则留在原地
	 * —— 档位是「来回比一比」的东西。失败写在底部那一行（不吞掉）。
	 * @param row - 家族行。
	 * @param value - 档位取值。
	 */
	const chooseTier = useCallback(
		(row: Extract<PickRow, { kind: 'family' }>, value: string) => {
			const target = familyTarget(row, current);
			if (target === undefined) return;
			// 已经是这个家族的模型时不必重复写默认字段（少一个 op，也少一次无谓的变更）
			const switching = target.ref !== current;
			void setTier(kind, row.key, value, switching ? target.ref : undefined)
				.then(() => {
					// 上一次失败留在底部的那行说明要跟着消失，否则「已经好了」看起来还像坏的
					setNote('');
					if (switching) close();
				})
				.catch((error: unknown) => {
					setNote(error instanceof Error ? error.message : String(error));
				});
		},
		[close, current, kind],
	);

	/**
	 * 键盘（Enter/Space）与鼠标走同一条路：家族行是「开关飞出面板」，档位 chip 是写设置。
	 * @param id - 导航 id（`自动` / 家族行 / 档位 chip / 模型 ref）。
	 */
	const choose = useCallback(
		(id: string) => {
			if (id === AUTO_ID) {
				pick(AUTO_ID);
				return;
			}
			if (id.startsWith(FAMILY_PREFIX)) {
				const key = id.slice(FAMILY_PREFIX.length);
				holdFly();
				setExpanded((prev) => (prev === key ? null : key));
				return;
			}
			if (id.startsWith(TIER_PREFIX)) {
				// `tier:<家族键>:<取值>`：家族键里有 `::`，所以从**最后一个**冒号切
				const rest = id.slice(TIER_PREFIX.length);
				const cut = rest.lastIndexOf(':');
				if (cut > 0) {
					const key = rest.slice(0, cut);
					const row = visibleRows.find(
						(candidate): candidate is Extract<PickRow, { kind: 'family' }> =>
							candidate.kind === 'family' && candidate.key === key,
					);
					if (row !== undefined) chooseTier(row, rest.slice(cut + 1));
				}
				return;
			}
			pick(id);
		},
		[chooseTier, holdFly, pick, visibleRows],
	);

	const nav = useMenuNav({
		ids: navIdsOf(visibleRows, expanded),
		onChoose: choose,
		onClose: close,
	});

	/**
	 * 渲染一行（家族行或平铺行）。
	 *
	 * 「常用」分区与「其他模型」用的是同一个函数：两处各写一份迟早会漂移成
	 * 「常用里的那行点不开档位」。外面这层 div 挂着**悬停开关**（P39）：
	 * 悬停在家族行上就把它那几条档位开在右边，悬停在别的行上就收掉。
	 * @param row - picker 的行。
	 * @returns 行元素（带悬停开关）。
	 */
	const renderRow = (row: PickRow): ReactNode => (
		<div
			key={row.key}
			onMouseEnter={() => {
				if (row.kind === 'family') openFly(row.key);
				else dropFlyNow();
			}}
		>
			{row.kind === 'one' ? (
				<OptionRow
					option={row.option}
					current={current === row.option.ref}
					navProps={nav.itemProps(row.option.ref)}
					onPick={() => {
						pick(row.option.ref);
					}}
				/>
			) : (
				<FamilyRow
					row={row}
					current={current}
					expanded={expanded === row.key}
					nav={nav}
					// 点一下 = 开（触屏没有悬停，点击是那条路）：此刻鼠标正悬在它上面，
					// 面板**已经**开着，做成 toggle 就会「点一下反而关掉」
					onToggle={() => {
						openFly(row.key);
					}}
				/>
			)}
		</div>
	);
	// 焦点挂在**浮层容器**上：菜单与飞出面板都是它的后代，于是 aria-activedescendant
	// 指向的条目、以及键盘事件，都落在同一棵树里
	useMenuFocus(layerRef, [open]);
	// resize 交给下面的 place()（弹层跟着窗口重排，而不是关掉）
	// ⚠️ 认「点在浮层里」用**容器**那个 ref（不是菜单那个）：飞出面板是它的兄弟节点，
	//    不认它的话，pointerdown 会先把面板卸掉，click 就没有目标了（NOTES §8.48）
	useMenuDismiss({ menuRef: layerRef, buttonRef: triggerRef, onClose: close, watchResize: false });

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

	/** 飞出面板里的那一行（按家族键找；找不到就什么都不开）。 */
	const flyRow =
		expanded === null
			? undefined
			: visibleRows.find(
					(candidate): candidate is Extract<PickRow, { kind: 'family' }> =>
						candidate.kind === 'family' && candidate.key === expanded,
				);

	/**
	 * 定位飞出面板：贴着**菜单右缘**（与那一行的上沿对齐），右边放不下就翻到菜单左边。
	 *
	 * 行的位置每次都现查（按 `data-model-family` 在菜单里找）：悬停与键盘两条路
	 * 都能走到这里，存元素的 ref 会在重渲染 / 收起「其他模型」之后指着已摘掉的节点。
	 */
	useLayoutEffect(() => {
		if (expanded === null) {
			setFlyAt(null);
			return undefined;
		}
		const place = (): void => {
			const panel = menuRef.current;
			const box = flyRef.current;
			if (panel === null || box === null) return;
			const row = Array.from(panel.querySelectorAll<HTMLElement>('[data-model-family]')).find(
				(candidate) => candidate.dataset.modelFamily === expanded,
			);
			if (row === undefined) return;
			const width = box.offsetWidth;
			const height = box.offsetHeight;
			const panelRect = panel.getBoundingClientRect();
			const rowRect = row.getBoundingClientRect();
			let left = panelRect.right + FLY_GAP;
			if (left + width > window.innerWidth - MARGIN) left = panelRect.left - FLY_GAP - width;
			let top = rowRect.top - FLY_GAP;
			left = Math.min(Math.max(left, MARGIN), window.innerWidth - width - MARGIN);
			top = Math.min(Math.max(top, MARGIN), window.innerHeight - height - MARGIN);
			setFlyAt({ left, top });
		};
		place();
		window.addEventListener('scroll', place, true);
		window.addEventListener('resize', place);
		return () => {
			window.removeEventListener('scroll', place, true);
			window.removeEventListener('resize', place);
		};
	}, [expanded]);

	const imageName = catalog === undefined ? '' : shortName(catalog.defaults.image);
	const videoName = catalog === undefined ? '' : shortName(catalog.defaults.video);
	const label = imageName === '' ? '自动' : imageName;
	// 分辨率档位就在模型名里（`…-2k`），因此这里只需要补**质量档**
	const tierText = tierTextOf(rows, current);
	const shown = tierText === '' ? label : `${label} · ${tierText}`;
	/** 菜单顶部那行「当前选中的模型名」—— 触发器上不再显示它，点了才看得见。 */
	const head = kind === 'image' ? imageName : videoName;
	const headName = head === '' ? '自动' : head;
	const headShown = tierText === '' ? headName : `${headName} · ${tierText}`;
	/** 选过模型（不是「自动」）→ 尾巴换成强调蓝（styles.ts 按这个属性上色）。 */
	const picked = imageName !== '' || videoName !== '';
	/** 设计技能开着吗（缺省 = 开）。关闭时尾巴压回默认纯色，因此关得看得见。 */
	const skillOn = catalog?.designSkillOn ?? true;
	const title =
		catalog === undefined
			? '设置服务还没就绪：暂时读不到生成模型'
			: `生成模型（点击切换）· 图像：${imageName === '' ? '自动' : imageName} · 视频：${
					videoName === '' ? '自动' : videoName
				} · 设计技能${skillOn ? '开' : '关'}（右键切换）`;

	return (
		<div ref={rootRef} className="ffc-mp-root">
			<button
				ref={triggerRef}
				type="button"
				className="ffc-mp-trigger"
				data-ffc-ui="model-picker"
				data-ffc-picked={picked ? 'true' : undefined}
				data-ffc-skill={skillOn ? undefined : 'false'}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-label={`选择生成模型，当前图像模型 ${shown}`}
				title={title}
				onClick={() => {
					setNote('');
					if (open) {
						close();
						return;
					}
					// 打开时不预先开任何飞出面板：档位由「悬停在那一行上」或 Enter 打开
					// （右边那个朝右的箭头就是提示），一开菜单就弹一块面板出来太吵
					setExpanded(null);
					setOpen(true);
				}}
				onContextMenu={toggleSkill}
			>
				{/* 只有这一枚图标：与右上角那枚入口**同一个组件、同一个尺寸**，
				    鼠标放上去同样会摇（styles.ts 里与 .ffc-entry 并列的那两条）。
				    语义分工：左键 = 选模型，右键 = 开关设计技能（开=启用，关=压回默认纯色） */}
				<WhaleTailIcon size={17} />
			</button>

			{open
				? createPortal(
						// 一层容器把菜单与飞出面板兜在一起（它们**不是**父子关系，但必须是
						// 「同一块浮层」）：role/键盘/焦点都在这一层上，见文件头那段 ⚠️
						<div
							ref={layerRef}
							className="ffc-mp-layer"
							role="menu"
							aria-label="选择生成模型"
							tabIndex={-1}
							onKeyDown={nav.onKeyDown}
							{...nav.containerProps}
						>
							<div
								ref={menuRef}
								className="ffc-mp-menu"
								style={
									at === null
										? MEASURE_STYLE
										: { left: `${String(at.left)}px`, top: `${String(at.top)}px` }
								}
							>
								{/* 当前选中的模型名 —— 用户要的「点了才看得见」就在这一行 */}
								<div className="ffc-mp-head">
									<span className="ffc-mp-headKind">{kind === 'image' ? '图像模型' : '视频模型'}</span>
									<span className="ffc-mp-headName">{headShown}</span>
								</div>

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
												// 换页签就是换了一批家族，展开状态不能跟着走
												setExpanded(null);
												setShowAll(false);
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
										onMouseEnter={dropFlyNow}
										onClick={() => {
											pick(AUTO_ID);
										}}
										{...nav.itemProps(AUTO_ID)}
									>
										<span className="ffc-mp-copy">
											<span className="ffc-mp-name">自动（第一个配好密钥的）</span>
										</span>
										<span className="ffc-mp-check">
											{current === '' ? <IconCheckOutlineRegular /> : null}
										</span>
									</button>

									{rows.length === 0 ? (
										<div className="ffc-mp-empty">
											还没有配置{kind === 'image' ? '图像' : '视频'}模型 —— 去「设置 → 图像 / 视频模型」添加。
										</div>
									) : (
										<>
											{/* 勾过「常用」的家族排在最前面（设置页「常用模型」那一块勾的） */}
											{pinnedRows.length === 0 ? null : (
												<>
													<div className="ffc-mp-groupTitle">常用</div>
													{pinnedRows.map((row) => renderRow(row))}
												</>
											)}

											{pinnedRows.length === 0 || otherRows.length === 0 ? null : (
												<button
													type="button"
													className="ffc-mp-more"
													data-action="toggle-all"
													data-open={showAll ? 'true' : undefined}
													onMouseEnter={dropFlyNow}
													onClick={() => {
														// 收起「其他模型」会把行搬走，开着的面板不能跟着走
														dropFlyNow();
														setShowAll((prev) => !prev);
													}}
												>
													{showAll ? '收起其他模型' : `其他模型（${String(otherRows.length)}）`}
												</button>
											)}

											{pinnedRows.length === 0 || showAll
												? otherRows.map((row, index) => {
														const provider = providerOf(row);
														const first = index === 0 || providerOf(otherRows[index - 1]!).id !== provider.id;
														return (
															<div key={row.key}>
																{/* 供应商分组标题（官方是 sticky 的）：只在换供应商时出现一次 */}
																{first ? <div className="ffc-mp-groupTitle">{provider.label}</div> : null}
																{renderRow(row)}
															</div>
														);
													})
												: null}
										</>
									)}
								</div>

								<div className="ffc-mp-note" role={note === '' ? undefined : 'alert'}>
									{note !== ''
										? note
										: catalog === undefined
											? '设置服务还没就绪：刷新页面再试'
											: pinnedRows.length === 0
												? '选中的模型用于之后的生成，与设置页是同一份配置'
												: '常用模型来自「设置 → 图像 / 视频模型 → 常用模型」；选中的模型用于之后的生成'}
								</div>
							</div>

							{flyRow === undefined ? null : (
								<div
									ref={flyRef}
									className="ffc-mp-flyout"
									data-flyout={flyRow.key}
									style={
										flyAt === null
											? MEASURE_STYLE
											: { left: `${String(flyAt.left)}px`, top: `${String(flyAt.top)}px` }
									}
									// 指针从那一行挪进面板的这段路不能让面板收掉（见 FLY_GRACE）
									onMouseEnter={holdFly}
									onMouseLeave={dropFlySoon}
								>
									{/* 面板离那一行有段距离，标题得说清它是谁的档位 */}
									<div className="ffc-mp-groupTitle">{flyRow.label}</div>
									<FamilyPanel
										row={flyRow}
										current={current}
										nav={nav}
										onPick={pick}
										onTier={(value) => {
											chooseTier(flyRow, value);
										}}
									/>
								</div>
							)}
						</div>,
						document.body,
					)
				: null}
		</div>
	);
}
