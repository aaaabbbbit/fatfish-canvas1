/**
 * 肥鱼画布 · 浏览器半边。
 *
 * 这个包同时是**宿主组合包**与**客户端插件**：`cordis.patch.yml` 插入一行
 * `fatfish-canvas`，Node 侧扫描到该行声明的 `dsh.client` 后解析
 * `exports["./client"]`（lib/client.js）并写入启动图，浏览器内核把它作为
 * 一个 Cordis 插件物化 —— 本文件导出的 `apply` / `inject` / `name` 就是插件体。
 *
 * 本半边只使用统一基座（React / cordis / ui-slots / ui-primitives），
 * 不请求任何额外外部模块，因此无需 `dsh.client.external`。
 *
 * 与布局的关系（这是「画布在左、聊天在右」的实现核心）：
 *   AppFrame 是 CSS Grid，其列宽由**自身实测宽度**求解决定。
 *   因此本插件不覆盖、不替换 `root`，而是：
 *     1. 用 JS 给 AppFrame 打上 `data-ffc-frame`（避开哈希类名与 `:has()`）；
 *     2. 画布模式下用一条 CSS 规则把 AppFrame 固定到视口右侧区域；
 *     3. 右侧随之收窄到 < 1024px，触发 AppFrame 自己的 sidebar 自动塌缩，
 *        同时列求解器把聊天列重排进右区。
 *   `shell.overlay` 只承载「左侧画布面板」这一个盒子；「进入画布 / 返回聊天」
 *   入口走会话头部右上角的实数席位（`conversation.session.header.utilities`，
 *   与 session log 同一个席位，见 P10 注释）。
 *
 * @module fatfish-canvas/client
 */

import type { Context } from '@deepseek-ai/cordis';
import { CSS, STYLE_TAG_ID } from './styles';
import { applyToDocument, ensureFrameTag, getMode, subscribe } from './state';
import { CanvasPanel } from './CanvasPanel';
import { CanvasEntryButton } from './EntryButton';
import { MediaSettings } from './settings/MediaSettings';
import { CanvasSettings } from './settings/CanvasSettings';
import { ModelPicker } from './settings/ModelPicker';
import { MediaToolRow } from './toolview/MediaToolRow';
import { UserMessageCopy } from './chat/UserMessageCopy';
import { installCanvasIngest } from './canvas/bridge';
import { installCanvasDrop } from './canvas/dropfiles';
import { installBoardScope } from './canvas/scope';
import { installViewShortcut } from './shortcut';
import { SETTINGS_ENTRY_ID } from './shared/catalog';
import { setMediaApi, setMediaScope } from './settings/models';
import { MEDIA_TOOL_NAME } from './shared/media';
import {
	PROBE_CLIENT_CONTRIBUTION,
	PROBE_NAMESPACE,
	unwrapFetchedImage,
	type FetchedImageOutcome,
} from './shared/probe';

/** cordis 插件名。 */
export const name = 'fatfish-canvas';

/**
 * 必需服务：插槽注册表（由 dsh-client-runtime 提供）与设置表单
 * （`configForms`，由 @deepseek-ai/dsh-client-ui-settings 提供）。
 *
 * `configForms` 是**必需**的（而不是像布局那样走嵌套 inject）：本插件的两个
 * 设置分节都要它，且 `ctx.configForms` 是服务属性访问 —— cordis 要求当前
 * fiber 声明过该依赖，否则直接抛。package.json 的 `dsh.client.inject` 同时
 * 声明了 `@deepseek-ai/dsh-client-ui-settings`，浏览器侧的装载次序才是对的。
 */
export const inject = ['slots', 'configForms'];

/** 画布面板条目的稳定 id。 */
const OVERLAY_PANEL = 'fatfish-canvas-panel';

/** 宿主探测服务在本插件用到的那一面（远程命名空间 `mediaProbe`）。 */
export interface MediaProbeFace {
	/**
	 * 测试连接（顺带返回模型列表）。
	 * @param providerId - 供应商 id。
	 */
	testConnection(providerId: string): Promise<unknown>;
	/**
	 * 获取模型列表。
	 * @param providerId - 供应商 id。
	 */
	listModels(providerId: string): Promise<unknown>;
	/**
	 * 按地址取图（跨域由宿主代取），返回 data URL —— 客户端据此包装成 `File`
	 * 走本体的附件管线（「点画布图片 → 聊天框里出现真正的图片附件」）。
	 * @param url - 图片地址。
	 */
	fetchImage(url: string): Promise<unknown>;
	/**
	 * 按地址取**媒体**字节（图或视频）—— 画布右键「导出」用。
	 *
	 * 与 {@link fetchImage} 分开：那条附件通路只该收图片，导出要的是原样落盘。
	 * @param url - 媒体地址。
	 */
	fetchMedia(url: string): Promise<unknown>;
}

/**
 * 设置页要用的宿主写入面（`remote.settings` / `remote.credentials`）。
 *
 * ⚠️ 必须**先捕获、再由设置页读**，不能在渲染期去解析服务：理由同下面探测服务那段
 * （派生服务在当前 context 没声明过依赖时，属性访问会直接抛）。
 * 读不到就是 undefined —— 设置页会明说「写入面还没就绪」，而不是让每次写入都炸在
 * `undefined.settings` 上。
 */
let hostApi: DshHostApi | undefined;
/** 探测服务的派生服务键（`remote.<命名空间>`）。 */
const PROBE_SERVICE_KEY = `remote.${PROBE_NAMESPACE}`;

/**
 * 宿主探测服务（`remote.mediaProbe`）。
 *
 * ⚠️ 与写入面一样必须**先捕获、再由设置页读**，不能在渲染期去解析服务：
 * cordis 对**派生服务**（`$mount` 之后才出现的 `remote.mediaProbe` 就是）
 * 要求当前 context 声明过该依赖，否则直接抛
 * `cannot get property "remote.mediaProbe" without inject`。
 * 那次抛错发生在分节的 inject 面里 → React 把整棵子树丢掉 →
 * 现象是「设置导航里有这一项，点开却是空白」（本轮真实踩到，靠抓浏览器异常定位）。
 * 因此读的是模块级持有变量，读不到就是 undefined，绝不抛。
 */
let probeFace: MediaProbeFace | undefined;

/**
 * 取当前的宿主探测服务面（可能还没 `$mount` 好）。
 *
 * 导出给画布用：节点上的图是跨域地址，要「存成附件」必须由宿主代取字节
 * （见 `host/probe.ts` 的 `fetchImage` 与 `dom.ts` 的 `attachImageToComposer`）。
 * @returns 服务面；未就绪时为 undefined。
 */
export function getProbeFace(): MediaProbeFace | undefined {
	return probeFace;
}

/**
 * 请宿主按地址取一份媒体字节（图或视频），**并把远程信封拆开**。
 *
 * 取字节的调用点有三个（点图送进聊天框、画布右键导出、导出时的视频），
 * 三者要的判断完全一样，因此信封只在这里拆一次：漏拆的症状是「宿主明明取到了，
 * 页面说取不到」（见 `shared/probe.ts` 的 `unwrapFetchedImage`）。
 * @param method - 走哪个宿主方法（`fetchImage` 只收图 / `fetchMedia` 还收视频）。
 * @param url - 媒体地址（http/https）。
 * @returns 内联数据，或一句可直接展示的失败原因。
 */
async function viaHost(method: 'fetchImage' | 'fetchMedia', url: string): Promise<FetchedImageOutcome> {
	const probe = getProbeFace();
	if (probe === undefined) {
		return { ok: false, message: '取图服务还没就绪（宿主半边没加载完），稍后再试' };
	}
	try {
		return unwrapFetchedImage(await probe[method](url));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { ok: false, message: `取图服务调用失败（${reason}）` };
	}
}

/**
 * 请宿主按地址取一张图（附件通路的入口）。
 * @param url - 图片地址（http/https）。
 * @returns 内联数据，或一句可直接展示的失败原因。
 */
export async function fetchImageViaHost(url: string): Promise<FetchedImageOutcome> {
	return viaHost('fetchImage', url);
}

/**
 * 请宿主按地址取一份媒体字节（图或视频）—— 导出用（视频上限 64MB）。
 * @param url - 媒体地址（http/https）。
 * @returns 内联数据，或一句可直接展示的失败原因。
 */
export async function fetchMediaViaHost(url: string): Promise<FetchedImageOutcome> {
	return viaHost('fetchMedia', url);
}

/**
 * 客户端插件体。
 * @param ctx - 客户端根 context。
 */
export function apply(ctx: Context): void {
	// ── 1. 样式：随 fiber 生命周期安装 / 回收 ──────────────────────────
	ctx.effect(() => {
		const tag = document.createElement('style');
		tag.dataset.plugin = name;
		tag.dataset.pluginCss = STYLE_TAG_ID;
		tag.textContent = CSS;
		document.head.appendChild(tag);
		return () => {
			tag.remove();
		};
	}, 'fatfish-canvas: stylesheet');

	// ── 2. 模式与宽度的文档投影 ────────────────────────────────────────
	ctx.effect(() => {
		applyToDocument();

		// AppFrame 可能晚于本插件挂载（渲染器挂载顺序），也可能热重载换元素。
		// 观察器只做一次命中即停的 querySelector，已打点则立即返回 —— 聊天流式
		// 输出会高频触发本回调，这里必须廉价。
		let raf = 0;
		const schedule = (): void => {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(() => {
				ensureFrameTag();
			});
		};
		const observer = new MutationObserver(schedule);
		observer.observe(document.body, { childList: true, subtree: true });
		schedule();

		return () => {
			observer.disconnect();
			cancelAnimationFrame(raf);
			// 回收本插件写下的全局状态：模式属性、frame 标记、宽度变量。
			delete document.body.dataset.ffcMode;
			document.documentElement.style.removeProperty('--ffc-canvas-width');
			for (const el of document.querySelectorAll('[data-ffc-frame]')) {
				el.removeAttribute('data-ffc-frame');
			}
		};
	}, 'fatfish-canvas: document projection');

	// ── 3. 与面板布局的协同 ────────────────────────────────────────────
	// 用 ctx.inject 而不是顶层 inject：布局缺失（如无头场景）时画布仍可工作。
	ctx.inject(['layout'], (scoped) => {
		const off = subscribe(() => {
			if (getMode() !== 'canvas') return;
			// 右侧详情栏会挤占聊天区，进入画布模式时收起它。
			// 侧边栏交给 AppFrame 自己的窄屏自动塌缩（frame 收窄后 < 1024px），
			// 此处刻意不 toggleSidebar —— 窄屏下 toggle 会翻 narrowExpanded，
			// 反而把侧边栏展开到被挤压的中间列上。
			scoped.layout.closeDetails();
		});
		scoped.effect(() => off, 'fatfish-canvas: layout coordination');
	});

	// ── 4. 设置页「图像 / 视频模型」 ───────────────────────────────────
	// 注册进 ui-settings 声明的 `settings.section` 席位，与本体的「模型」页并列。
	//
	// spec 形状照抄一个已经在用的第三方分节（dsh-cost-meter 的「费用」页）：
	// `id` 唯一标识、`order` 决定导航次序、`label` 是**纯字符串**（不需要 locale
	// 绑定 —— 这一点是读它的产物确认的，早期版本我曾按 `key`/`locale` 写，结果
	// 分节注册成功但导航里不出现）。
	//
	// P9 起这个页面要三样东西：读配置的表单、写嵌套叶子的 `connection.api`、
	// 以及宿主探测服务（测试连接 / 获取模型列表）。
	//
	// ⚠️ 后两样必须**先捕获再递进去**，绝不在这个 inject 面里现解析：
	// cordis 的派生服务（`remote.mediaProbe` 就是，它在 `$mount` 之后才出现）
	// 要求当前 context **声明过**该依赖，否则 `ctx.get` / 属性访问会直接抛
	// `cannot get property "remote.mediaProbe" without inject`。
	// 那一抛发生在分节的 inject 面里 → React 把整棵子树丢掉 →
	// 现象是「设置导航里有这一项，点开却一片空白」（本轮真实踩到，靠抓浏览器异常定位）。
	// 现在读的是模块级持有变量：读不到就是 undefined（按钮置灰并说明原因），不抛。
	//
	// 读配置那一半换过一次形状：0.1.5 是 `settingsScope.bind({ namespace })`，
	// 0.2.0 起是 `ctx.configForms.get(<Loader entry id>)`（`settingsScope` 这个
	// 服务整个没有了）。同一个 entry id 上拿到的是**同一份**表单实例，因此
	// 下面两处 get 共用它。
	const mediaForm = ctx.configForms.get<Record<string, unknown>>(SETTINGS_ENTRY_ID);
	// P17：画布工具条那格「生成模型」读的是同一份设置，但它拿不到分节的 inject 面
	// （它在 shell.overlay 里），只能读模块级持有变量 —— 在这里接上。
	setMediaScope(mediaForm);
	ctx.effect(
		() => () => {
			setMediaScope(undefined);
		},
		'fatfish-canvas: media model scope',
	);
	ctx.slots.inject('settings.section', () =>
		ctx.slots.register(
			{
				name: 'settings.section',
				id: 'fatfish-canvas-media',
				order: 40,
				label: '图像 / 视频模型',
				inject: () => ({
					scope: mediaForm,
					api: hostApi,
					// 传**取值函数**而不是当时的值：`$mount` 是异步的，
					// 页面可能先渲染一次、之后探测服务才就绪。
					getProbe: () => probeFace,
				}),
			},
			MediaSettings,
		),
	);

	// ── 4b. 宿主写入面（remote.settings / remote.credentials） ──────────
	//
	// P11：这里原来读 `ctx.connection.api`，而 `ctx.connection` 上早就没有 `api`
	// 了（它的成员是 rpc / generation / state）—— 于是每一次写入都炸在
	// `Cannot read properties of undefined (reading 'settings')`：改基址失焦即回退
	// （写入失败 → 草稿被丢掉 → 回显旧值），删除供应商也只报这一句。
	// 现在的写入面是网关派生的两个命名空间，签名与信封见 ambient.d.ts。
	ctx.inject(['remote.settings', 'remote.credentials'], (scoped) => {
		const settings = scoped.get('remote.settings') as DshRemoteSettings | undefined;
		const credentials = scoped.get('remote.credentials') as DshRemoteCredentials | undefined;
		hostApi = settings === undefined || credentials === undefined ? undefined : { settings, credentials };
		// P17：工具条那格切默认模型也要写这份设置（同一个写入面，同一套冲突重试）。
		setMediaApi(hostApi);
		scoped.effect(
			() => () => {
				setMediaApi(undefined);
			},
			'fatfish-canvas: media model write face',
		);
	});

	// ── 4c. 「肥鱼画布」自己的设置页（P32） ─────────────────────────────
	//
	// 与「图像 / 视频模型」同一个席位、同一份表单与写入面，只是**另开一页**：
	// 存储这类选项混在供应商配置里既难找，也让那一页越来越长（用户明确要求）。
	// order 45 = 排在图像 / 视频模型（40）后面、紧挨着。
	ctx.slots.inject('settings.section', () =>
		ctx.slots.register(
			{
				name: 'settings.section',
				id: 'fatfish-canvas',
				order: 45,
				label: '肥鱼画布',
				inject: () => ({
					// 同一个 entry id → 与上面那一页拿到的是同一份表单实例
					scope: ctx.configForms.get<Record<string, unknown>>(SETTINGS_ENTRY_ID),
					// 取值函数而不是当时的值：`remote.settings` 是异步就绪的派生服务
					getApi: () => hostApi,
				}),
			},
			CanvasSettings,
		),
	);

	// ── 4c. 挂上远程贡献（客户端 → 宿主的调用面） ────────────────────────
	//
	// 设置页的「测试连接 / 获取模型列表」由宿主执行（密钥不下发浏览器），
	// 客户端要先把描述符挂上，`remote.mediaProbe` 才存在。
	// `$mount` 是异步的，因此这里用 effect 装上、卸载时撤掉；
	// 服务本身用**嵌套 inject** 等它出现（声明过才读得到）。
	ctx.inject(['remote'], (scoped) => {
		const remote = scoped.remote;
		scoped.effect(() => {
			let dispose: (() => void) | null = null;
			let cancelled = false;
			void remote
				.$mount(PROBE_CLIENT_CONTRIBUTION)
				.then((off) => {
					if (cancelled) off();
					else dispose = off;
				})
				.catch((error: unknown) => {
					// 挂不上不影响画布与生成：只有设置页那两个按钮会不可用
					console.warn(
						`[${name}] mediaProbe 远程贡献挂载失败：${error instanceof Error ? error.message : String(error)}`,
					);
				});
			return () => {
				cancelled = true;
				dispose?.();
				probeFace = undefined;
			};
		}, 'fatfish-canvas: mediaProbe remote contribution');

		scoped.inject([PROBE_SERVICE_KEY], (withProbe) => {
			try {
				probeFace = withProbe.get(PROBE_SERVICE_KEY) as MediaProbeFace | undefined;
			} catch {
				probeFace = undefined;
			}
			withProbe.effect(
				() => () => {
					probeFace = undefined;
				},
				'fatfish-canvas: mediaProbe handle',
			);
		});
	});

	// ── 5. 视图快捷键（P4） ────────────────────────────────────────────
	// Ctrl/⌘ + Shift + B 在聊天与上一次用的画布模式之间来回切。
	installViewShortcut(ctx);

	// ── 6. 生成结果落图（P3） ──────────────────────────────────────────
	// 只订阅 `ctx.sessions` 的当前会话快照：宿主已经把结果写进
	// `tool/result` 的 presentationMeta，而快照本来就折叠好了这条事件。
	// 详见 canvas/bridge.ts 与 canvas/ingest.ts。
	//
	// 画布作用域（P7）必须**先**装上：桥一旦报来会话 id，作用域就要换好键，
	// 结果才落得进正确的那块画布。
	ctx.effect(() => installBoardScope(), 'fatfish-canvas: board scope');
	installCanvasIngest(ctx);

	// ── 6b. 拖进画布的本地图片 → 画布节点 ────────────────────────────
	// 本体把附件 drop 挂在 document 上，捕获阶段先接管「落在画布上」的那些，
	// 否则从屏幕外拖进来的图会被塞进聊天输入框。见 canvas/dropfiles.ts。
	ctx.effect(() => installCanvasDrop(), 'fatfish-canvas: canvas file drop');

	// ── 7. 聊天侧：`media_generate` 的工具行 ───────────────────────────
	// `tool.call.toolview` 是 keyed 席位（key = 线上工具名）。登记自己那个工具
	// 是**加性**的 —— 只替换本工具原本会走的通用 JSON 卡片。
	//
	// 刻意不声明 `locale`：本插件自带中文字面量，不参与 DSH 的 i18n 分节，
	// 声明了反而要求一个并不存在的 namespace 词条。
	ctx.slots.inject('tool.call.toolview', () =>
		ctx.slots.register(
			{
				name: 'tool.call.toolview',
				key: MEDIA_TOOL_NAME,
			},
			MediaToolRow,
		),
	);

	// ── 7b. 聊天侧：用户消息上的「复制（含图）」 ────────────────────────
	//
	// 平台**没有**「用户消息操作」席位（`conversation.chat.assistant-actions`
	// 只给 assistant 的回合尾），而插槽注册表按 priority 升序取第一个同 key 的
	// 条目 —— 因此这里用 `priority: -1` **顶替** ui-chat 自己那条 `user` 渲染器。
	// 不写 priority 会直接撞上「keyed slot … already has an entry for key "user"」
	// 而注册失败（那条报错自己就写着 register at a different priority to shadow it）。
	//
	// 顶替的代价与边界写在 `chat/UserMessageCopy.tsx` 文件头：图片仍走本体的
	// `renderMessageImages`，只有样式是自己的一套。
	ctx.slots.inject('conversation.chat.node', () =>
		ctx.slots.register(
			{
				name: 'conversation.chat.node',
				key: 'user',
				priority: -1,
			},
			UserMessageCopy,
		),
	);

	// ── 8. 米饭碗入口（P10：会话头部右上角，与 session log 同席位） ──────
	//
	// 席位是 `conversation.session.header.utilities` —— 聊天区头部**右对齐**的
	// Session utilities 行，`dsh-session-log-export` 的 session log 按钮就在里面。
	// 同一个席位意味着同一个 flex 行：布局把它们并排摆开，**结构上不可能重叠**
	// （P8 的浮层之所以压住 session log，是因为它压根不在任何席位里）。
	//
	// order: 10 明确排在 session log（未写 order = 0）右边，也就是视口最右上角；
	// 不写 order 的话两者同为 0，次序取决于插件装载先后 —— 那不是设计，是巧合。
	//
	// ⚠️ 该席位是**会话作用域**：没有当前会话时（新会话欢迎页）它不渲染。
	// 那种情况下进入画布靠快捷键 Ctrl/⌘ + Shift + B（按钮 title 里写着），
	// **退出**靠画布顶栏那格常驻的「返回聊天」（P49 —— 出口不能只住在会话
	// 作用域的席位上：画布模式是记住的，刷新会直接落回画布）。
	// 纯画布模式（canvas-only）收起了整列聊天，头部跟着不存在 —— 那种模式下的
	// 出口是顶栏的「纯画布」与「返回聊天」两格，见 CanvasPanel。
	ctx.slots.inject('conversation.session.header.utilities', () =>
		ctx.slots.register(
			{
				name: 'conversation.session.header.utilities',
				id: 'fatfish-canvas-entry',
				order: 10,
			},
			CanvasEntryButton,
		),
	);

	// ── 8b. 生成模型选择（P17：composer 工具行里，本体模型位的紧左边） ──────
	//
	// `conversation.input.right` 就是「本体模型位左边那一格」：ui-conversation 的
	// composer bar 渲染顺序是 `input.right` → `input.model` → 用量环 → 发送
	// （已在其产物 `dsh-client-ui-conversation/lib/client.js` 里核实）。
	// 因此注册进去 = 生成模型选择紧挨着本体的对话模型 —— 两者是同一类东西，
	// 用户找它的时候眼睛就在那一行。
	//
	// ⚠️ 该席位是**会话作用域**：没有当前会话（hero 欢迎页）时不渲染；纯画布模式下
	// 整列聊天被收起，这一格也跟着不可见 —— 那两种情况下改模型只能去设置页。
	ctx.slots.inject('conversation.input.right', () =>
		ctx.slots.register(
			{
				name: 'conversation.input.right',
				id: 'fatfish-canvas-model',
				order: 10,
			},
			ModelPicker,
		),
	);

	// ── 9. 画布面板（`shell.overlay` 里唯一的条目） ─────────────────────
	// shell.overlay 是文档推荐的「浮在整页之上的自有界面」加性席位：
	// 条目之间互不遮蔽，且只有条目自身接收指针事件。
	ctx.slots.inject('shell.overlay', () =>
		ctx.slots.register(
			{
				name: 'shell.overlay',
				id: OVERLAY_PANEL,
				label: () => '肥鱼画布 · 画布',
			},
			CanvasPanel,
		),
	);
}
