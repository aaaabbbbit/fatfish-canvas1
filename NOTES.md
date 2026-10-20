# 肥鱼画布 · 平台事实 / 决策理由 / 坑

> **「动手时按需查」的参考资料 —— 接手时不用读。**
> 这三节原本和 `STATE.md` 在同一份文件里，2026-09-25 拆出来，**编号保持不变**：
> **§3 已核实的平台事实**（最贵的知识，别重新发现）· **§4 关键实现决策（理由）** ·
> **§8 坑与教训（避免重犯）**。
> `STATE.md` 里写的 `NOTES §x.y` 就是指向这里的某一条；本文件里单独写的 `§0` / `§5` / `§6` / `§7`
> 指向 `STATE.md` 的同名小节。
>
> **维护规则**：新的平台事实进 §3、决策理由进 §4、坑进 §8。**不要往上堆 Pxx 变更日志。**

---

## 3. 已核实的平台事实（最贵的知识，别重新发现）

### 3.1 插件体系
DSH 基于 **Cordis**；一个包可**同时**是宿主组合包（`dsh.bundle.patch`）与客户端插件
（`dsh.client: { platform: 'web' }`）。Node 侧扫描**已启用**的 Loader 行，找声明
`dsh.client` 的包，解析 `exports["./client"]` 写入启动图，经
`/plugins/<id>/client.js?rev=<hash>` 服务。**扫描是增量式、无全量重扫路径**
（响应 cordis 的 `internal/plugin` 事件）。参考实现：`dshmarket`、`dsh-cost-meter`、
`@michengai/dsh-archive-manager`（都在 `C:\Users\pc\.dsh\profiles\web\node_modules\`）。

### 3.2 客户端 bundle 契约
```js
window.__ModuleLoader__.load({ id: "<包名>", factory: (require) => { /* CJS 产物 */ return module.exports; } });
```
- 脚本执行**只注册 factory，不得有副作用**；模块体（含 CSS 注入）在物化时才跑。
- factory 的同步 `require` **只**解析 7 个 specifier（已在前端产物逐字核实）：
  `react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、
  `@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-ui-slots`、
  `@deepseek-ai/dsh-client-ui-primitives`。其余必须内联打包或经 `dsh.client.external`。
- primitives 的 116 个导出已核实；**没有图像/画布类图标** → 图标自绘。

### 3.3 布局：必须真实重排，不能覆盖
- AppFrame 是 **CSS Grid**，列宽由它**自身实测宽度**经 ResizeObserver →
  `computeColumns` 求解决定。画布模式下把它 `position: fixed; left: var(--ffc-canvas-width); right: 0`，
  聊天列才会真的重排进右区；frame < 1024px 还会触发它自己的 sidebar 自动塌缩。
- **用面板盖住左边是错的**（聊天仍居中于整宽列，左半永久被遮）。
- `root` 槽位是**禁区**（单槽位，动态注册会遮蔽 AppFrame 并带走它的全部席位）。
  自有浮层走 `shell.overlay`（加性列表；层本身 `pointer-events: none`，
  direct child 为 `auto`）。
- AppFrame 用 JS 打点 `data-ffc-frame`（`[data-shell-overlay]` 的父元素），
  避开哈希类名与 `:has()`。

### 3.4 宿主半边的激活需要重启 dsh web
- 客户端半边：重建即以新哈希重新服务，**刷新页面即生效**。
- 宿主半边：profile patch 重新组合**不会重新导入**宿主模块（行标识未变时 fiber 保留，
  Node ESM 按 URL 缓存）。已实测：改 patch、禁用再启用行、换全新的子路径导出名，
  **都不会重新求值** → 必须重启 `dsh web`。
- **激活行放哪一层（2026-10-08 改正）**：包内 `cordis.patch.yml`（bundle 层）才是
  「装上就能用」的位置 —— `plugin_manager install_bundle <包目录>`（以及换机器、换
  profile）只做「装包 + 选 bundle」，行来自**包内 patch**；空 patch = 装了也不出现。
  profile 层（`$DSH_HOME/profiles/<名字>/cordis.patch.yml`）换来的只有「改动实时重放、
  加新插件不用重启」，而且**它是增量重放、不是重建**：把 `insert` 从本层摘掉，
  运行中的宿主**不会**卸下那一行（实测：摘完 `Config.listConfigs` 照样查得到
  `include:fatfish-canvas`），要等重启才按新组合来 —— 所以这个改动**不制造空窗**，
  但也别指望不重启就能看到效果。设置本体（带 `config:` 的那条 `- id: fatfish-canvas`）
  是**覆盖**，按 id 匹配、跟插入来自哪一层无关，继续留在 profile 层。
- 判据：`dsh --profile web --dump-config`（只组合、不挂载、不监听）里那个 id 应当
  **恰好一条**，并带 `# == <id>, patched by …\profiles\web\cordis.patch.yml`。
  ⚠️ 跑之前设 `FFC_NO_STATUS_WRITE=1`（否则它会把 `lib/host-status.json` 写成
  「测试跑过」的样子，见 §8.11）。
- `lib/host-status.json` 是宿主写下的就绪标记（`phase: module-evaluated` = 模块被导入；
  `host-ready` = 注册成功；P9 起还带 `models` 与 `command`）。**它是运行中宿主的产物**：
  `e2e-command.mjs` 靠它判断「宿主是否已重启、命令是否已注册」，`post-restart.mjs`
  也靠它确认宿主换了新模块。
  ⚠️ 因此**测试绝不能写它**：宿主模块认 `FFC_NO_STATUS_WRITE=1` 就跳过写盘，
  `test-host.mjs` 会设这个变量。早先的「导入前备份、跑完还原」是**不够的** ——
  一旦某次运行把污染写回去，之后每次「备份」都在保存污染（本轮实测：标记里出现了一个
  运行中宿主根本没有的 `command` 字段，`e2e-command` 会以为命令已注册而冲进去跑，
  见 §8.11）。**当前值不存在**时按「未重启」处理是安全的（e2e 会自己跳过）。

### 3.5 settings 写路径只能点名**一个顶层字段**
客户端 `SettingsScope.set(field, value)` 底层是单条 `set` 路径 op → 供应商配置**必须
扁平**（`key_openai_images` 等）。若是数组，客户端只能整体回写，而它的视图是**脱敏的**
（`role('secret')` 被剥离）→ 会**抹掉所有密钥**。
`role('secret')` 字段**不能给 `.default()`**（默认值会随 schema 序列化带给每个客户端）。

### 3.6 `settings.section` 的 spec 形状（照抄 dsh-cost-meter 的「费用」页）
```js
ctx.slots.register({ name: 'settings.section', id: 'fatfish-canvas-media', order: 40,
  label: '图像 / 视频模型',          // **纯字符串**，不需要 locale 绑定
  inject: () => ({ scope }) }, Component);
```
⚠️ 早期按 `key`/`locale` 写 → 分节注册成功但**导航里不出现**（已加回归断言）。

### 3.7 工具注册不需要导入 dsh-tools
`ctx.tools.register(def)` 只读结构、不检查原型。工具定义用**对象字面量**：
`{ name, description, parameters(JSON Schema), output: { schema, render, presentationMeta }, execute, presentCall }`。
全局注册的工具**对 agent 可见**。

### 3.8 依赖解析
- 从 profile 的 node_modules **解析不到** `schemastery` / `dsh-settings` / `dsh-tools` /
  `cordis`（只有 `dsh-credentials` 可以，因为 dsh-cost-meter 声明了它）。
- 插件是 junction 指向工作区，**装在工作区就能被插件解析**：目前只装了
  `@deepseek-ai/schemastery@3.18.2`（settings schema 需要，是唯一运行时依赖）。
- 其余宿主服务通过 `ctx` + 本地 ambient 声明访问，**不引运行时依赖**。

### 3.9 jaaz 的规格（参考实现的提炼）
画布**就是 Excalidraw**；落位算法在服务端 `find_next_best_element_position`
（`max_num_per_row=4`、`spacing=20`，按垂直重叠分行、末行未满则贴右并与行顶对齐）
—— **已移植进 `canvas/model.ts` 的 `nextPlacement()`**。缩放 ±10 **个百分点**
（预设 10/50/100/150/200）。图像比例 `1:1/16:9/4:3/3:4/9:16`；视频 `480p/1080p`、
时长 5/10。视频默认静音、悬停播放、移出暂停归零。jaaz **没有**生成中占位 ——
我们**刻意保留** `pending`，是有意改进。

### 3.10 会话快照面（P3 的地基）
```ts
sessions.list            // ObservableSnapshot<SessionListState>：{ current: SessionId | undefined }
sessions.binding(id)     // → { sessionId, session: SessionFace, ctx } | undefined
// SessionFace = ISession & ObservableSnapshot<ConversationSnapshot>；另有 prompt() / command()
```
`ConversationSnapshot` 的两条通路：`runningCalls`（工具刚开始跑就有）与
`nodes[]` 里的 `tool-result`（`meta` 就是宿主 `presentationMeta` 的返回值）。
四条实测事实：
1. **只有「当前」（staged）会话的事件窗口是打开的** —— 所以「画布只吃得到当前会话
   的结果」是平台限制，不是偷懒（画布作用域正是顺着这条限制做的：既然只看得到
   当前会话，那画布就跟着**当前会话所在的工作区**走 —— 一个工作区一块，见 §3.19）。
2. `sessions.binding(id)` 是纯寻址，但 `list.current` 刚变时可能还解析不到
   （scope 异步建立）→ bridge 带有限重试（200ms × 40）。
3. 会话 id 形如 **`session-<uuid>`（带前缀）**；按日志目录名推断时别削掉前缀，
   否则写进 `dsh.sessions.current` 的是无效 id（表现为「落图完全不工作」）。
4. 会话选择持久化在 localStorage **`dsh.sessions.current`**（`{"sessionId":"session-…"}`），
   但运行时只当**候选**：不在当前工作区列表里会被仲裁掉，全新浏览器 profile 最终落在
   **空白会话**上 —— 这是 e2e 采用「自己发提示词/自己敲命令」的原因。

### 3.11 `tool.call.toolview` 是 keyed 席位（key = 线上工具名）
```js
ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
  { name: 'tool.call.toolview', key: 'media_generate' }, MediaToolRow));  // 不需要 id / locale
```
条目 props 是 owner 面 `{ callId, toolName, block, cwd, home, openFile, inspect }`，
`block` 是 `RunningToolCall | ToolResultNode`（**一个组件覆盖进行中与已结束**）。
命中 key **替换**通用卡片，未命中**静默回落**成 JSON 卡片 → 有守卫断言。

### 3.12 设置文件的外部编辑会热发布（验证成功路径的关键手段）
`dsh-settings-file` 的 `watch` 默认开：手工改 `C:\Users\pc\.dsh\settings.yaml`
会热发布进 `ctx.settings`。因此**不需要真实密钥**就能验证成功路径 —— 把
`media-generation` 的 `openai-images` 指向本机 `scripts/fake-media-server.mjs`
（假服务自带极简 PNG 编码器、`--delay` 造出可观察的 pending 窗口），
**验证完改回 `media-generation: {}`**。⚠️ 该文件在工作区之外，写入需要一次
`danger-full-access` 升级。

### 3.13 纯画布模式不能靠隐藏 AppFrame 实现
`shell.overlay` 层是 **AppFrame 的子节点**，所以
`[data-ffc-frame] { display: none }` 会把插件自己的面板与米饭碗按钮一起隐藏 ——
**白屏且没有任何可点的出口**（实测：canvas-only 下 `.ffc-rice`/`.ffc-panel` 都是 0×0）。
正确做法：
```css
body[data-ffc-mode='canvas-only'] [data-ffc-frame] { position: fixed; inset: 0; width: auto; }
body[data-ffc-mode='canvas-only'] [data-ffc-frame] > *:not([data-shell-overlay]) { display: none; }
```
即 frame 继续当 overlay 的活容器，只隐藏它**除 overlay 以外**的直接子元素。
两层安全网：**刷新自救**（`readMode()` 从存储恢复时把 `canvas-only` 降级成 `canvas`）、
**Esc 逃生梯**（`shortcut.ts`）。

### 3.14 程序化移动视口要动画，用户操作绝不能动画
跟焦/适应内容是「跳到别处」（瞬移会丢空间感），拖拽/滚轮必须跟手。
`canvas/actions.ts` 改视口时广播原因，`CanvasStage` 只对 `focus`/`fit` 挂 240ms
`transform` 过渡（`data-anim` 驱动 CSS），一有用户输入立刻撤掉。
⚠️ 也影响测试：断言几何前必须等动画结束（否则读到中途矩阵）—— 现在**轮询到
条件成立**而不是读一次。

### 3.15 `pnpm typecheck` 是干净的（94 → 0，已进门禁）
靠补齐手写 ambient 声明：① `useRef<T>(initial: T): { current: T }`（精确语义，
`current` 不是 `T | null`，消掉 ~20 条）；② `PointerEvent` 补
`button`/`shiftKey`/`target`/`stopPropagation` 等成员；③ JSX `IntrinsicElements`
显式列出事件属性（否则箭头参数拿不到上下文类型、处处 `noImplicitAny`）+ 
`JSX.ElementType = any` 消掉 16 条误报；④ 宿主自带 `src/host/node-ambient.d.ts`
声明 `node:fs`/`node:path`/`node:url` 用到的那几个函数（**不引 @types/node**）。

### 3.16 主题钩子与 token 的语义坑（对比度复查抓出两处真 bug）
- 切主题的钩子：**`body[data-ds-dark-theme]`**（稳定数据属性，测试里直接 toggle
  即可复现两套主题）。
- **`--dsw-alias-label-primary-inverted` 不是「恒为白」，而是「主色的反色」**：
  深色下是 `#353638`。而 `--dsw-alias-bg-mask-*` 两套主题**都是深遮罩** →
  「深遮罩 + 反色文字」= 深字压深底（两套主题都糊）。
- **结论**：压在任意媒体上的浮层（节点悬浮条、失败徽标）用**固定**深遮罩 + 白字，
  或**不随主题翻转**的静态色（`--dsw-static-red-900`）。主题反色只适合「背景也随主题变」。
- `e2e-theme.mjs` 在两套主题下遍历 21 处元素算 WCAG 对比度（正文 ≥4.5、次要 ≥3.0），
  有效背景按祖先链 alpha 合成；**它只读 `background-color`、读不到渐变** ——
  被测元素别只用 `background-image`，否则会得到 1.0 这种假故障。

### 3.17 菜单基础设施（三处菜单共用一套行为）
`client/menu.ts`：`useMenuNav`（↑↓ 跳过禁用项并循环、Home/End、Enter/Space、
Esc/Tab；容器 `role="menu"` + `aria-activedescendant`，条目 `id` 与 `data-nav-active`
—— **刻意不叫 `data-active`**，那个属性表示「当前选中的模式」，两者必须共存）、
`useMenuDismiss`（capture 阶段 pointerdown 判「点外面」、Esc、可选 resize）、
`useMenuFocus`、`clampToViewport`（右键菜单夹进视口）。
⚠️ `useMenuFocus` 的 **deps 必须覆盖「菜单真正挂载」那一刻**：条件渲染的菜单
（`open && anchor !== null`，而 anchor 要等一个 effect）只写 `[open]` 会在 ref 还是
null 时聚焦一次、之后再不重跑 —— 现象是「菜单打开了，方向键毫无反应」。

### 3.18 直达命令面（P6 的地基）
```ts
ctx.commands.register({ name: 'generate', description, input: { hint },
  recordInput: true,                       // false 时 command/run 不记 args
  handler: (inv) => CommandResult });      // { kind:'success', text? } | { kind:'error', text }
```
- `inv = { commandId, agent, rawInput, attachments, signal }`；`rawInput` 是命令名之后的
  **原文**（含分隔空白），语法由命令自己定。
- 命令结果**不进模型历史、不产生 token** —— 这是它值得存在的全部理由。
- 客户端派发 `session.command(line)` → `RemoteResult<{ matched: boolean }>`；
  **未匹配是 `matched: false` 的普通结算，不是异常** → 「先试命令、未匹配再退回提示词」
  可行（P6 的重新生成就这么做），且不需要事先探测注册表。
- 客户端把 `command/run` ↔ `command/done` 折叠成 `CommandNode`
  （`{ name, args, outcome: { kind, text?, sourceEventSeq? } | null }`）→
  **自定义命令的结果也能落画布**，不需要注册 Conversation Definition：
  按 `name === 'generate'` 认领、`args` 还原提示词、`outcome.text` 还原媒体。
- 命令结果只有**文本**一种载体 → 约定「成功文本的**第一行**就是媒体地址」
  （`formatCommandResult` / `mediaUrlFromCommandText`，两半边共用同一实现）。
- 命令服务可能缺席（裁剪过的组合）→ 与工具**分开** `inject(['commands'])` 降级。
- ⚠️ **settings namespace 只能注册一次**：结构是「先 `inject(['settings'])` 建 scope
  与管线依赖，再在回调里 `inject(['tools'])` / `inject(['commands'])`」。嵌套 inject
  在 cordis 里成立，**测试替身也必须照此建模**（早先的替身只认
  `deps.includes('tools')`，改结构后完全打不中 → 「什么都没注册」）。

### 3.19 画布作用域：一个工作区一块画布（P7 起，2026-10-14 从「按会话」改成「按工作区」）
```ts
type BoardScope = string | null;                 // null = 共用那块；字符串 = 那个工作区
boardKeyFor(scope)  → 'fatfish-canvas:board' | 'fatfish-canvas:board:<工作区路径>'
setBoardScope(next)                              // 换键（先 flush 旧键，再读新键），不搬运
rehomeSharedBoard(workspaceOf)                   // 把共用那块按「节点属于哪个会话」拆到各工作区
```
工作区 = **会话行上的 `cwd`**（`SessionSummary.cwd`，宿主给的已校验绝对路径）。
三份知识必须合在一处才对，但天然分居三地 → 接合点单独成模块 `canvas/scope.ts`：
**偏好**（`state.ts` 的 `fatfish-canvas:board-scope` = `shared` | `workspace`）×
**当前会话的工作区**（`canvas/bridge.ts` 是唯一知道「当前会话是谁」的地方，
`setScopeSession(id, cwd)`；同时把「会话 → 工作区」查询口 `setWorkspaceLookup` 交给它）
→ **换键**（`store.setBoardScope`）。八条实测/设计事实：

1. **默认 `workspace`**（一个工作区一块）。P7 时默认是 `shared`，因为那时隔离是显式开关；
   现在默认值必须跟着功能走 —— 用户要的就是「进哪个项目的对话看哪个项目的画布」。
   老值 `session` 读作 `workspace`（同样意图、更粗粒度），明文 `shared` 仍认。
2. **拆分（`rehomeSharedBoard`）取代了原来的 `adopt`**：从共用切进工作区时，不是把
   那堆节点整块抄过来（那会把别的项目也搬进来），而是**按每个节点的 `sessionId`** 查
   「那个会话在哪个工作区」，送到各自那块去。三条性质：
   - **认不出的留在原地**（无 `sessionId`、或会话已不在列表里）→ 留在共用那块；
   - **按 id 去重**，因此可以每次「共用 → 工作区」都跑一遍（幂等）；
   - **共用那块一个字节都不动**（它是「全部内容」的备份），`ingested` 一并带过去
     （否则 10 分钟内的结果会被「最近结果补落」重放回来）。
   ⚠️ 拆到**空画布**上时视口要对准这批节点的包围盒（`boundsOf` + 40px 边距）：
   默认视口停在世界原点，而这些节点可能在几千像素外 —— 用户看到的是「画布是空的」。
3. **只有「共用 → 工作区」这一步拆**：工作区之间绝不互相抄送（拿不到 `cwd` 时退回共用，
   而不是记着一块不存在的工作区）。会话 A → 会话 B 同属一个工作区时画布**不变**。
4. **拿不到 `cwd` 就退回共用**：无会话 / `sessions` 服务缺席 / 列表行上还没有 `cwd` 时
   作用域是 `null`，画布照常可用。视图读数（工具条 `[data-ffc-scope]`）显示实际生效的
   那块（`data-ffc-scope-path` 带工作区路径），而不是假装已经分开。
5. **桥里顺序是「先切作用域、再落图」**（`onChange()` 里 `setScopeSession` 在 `bind` 之前）：
   否则切工作区的第一帧结果会落进上一个工作区的画布。
6. **`onChange` 每次列表变动都报一次**（不只在换绑时）：`cwd` 可能比行本身晚到一步，
   而 `bind()` 对同一个 id 会早退 —— 只在换绑时报，就等于「第一个没有 cwd 的会话
   永远停在上一个工作区」。
7. 记账账本 `ingested` 随作用域独立 → 切回旧工作区时历史快照不会重放节点
   （§3.10 的「打开老会话不铺满画布」在多画布下依然成立）。
8. ⚠️ **`fatfish-canvas:board-scope` 也以 `fatfish-canvas:board` 开头**：按
   `startsWith('fatfish-canvas:board')` 筛「画布键」会把偏好键当成一块画布
   （P7 就这么写错过一次断言）。筛按工作区的画布必须用 `fatfish-canvas:board:`（带冒号）。

### 3.20 浮层压别人是**做法本身的问题**（P8 修的重叠 bug）
用户报告「白米饭碗图标压在聊天界面的 session log 上」。查明：
- 米饭碗原来是 `shell.overlay` 里 `position: fixed; top:10px; right:12px` 的浮层按钮
- 视口右上角正是 `conversation.session.header.utilities` 席位，被
  **`dsh-session-log-export`** 占着（`.nL4_yW_sessionLogButton`，111×32 @ x=1525,y=12）
- 于是浮层按钮正好压在它上面（探针实测：命中栈里 session log 就在米饭碗下面）

**修法不是挪几个像素，而是换一种做法**：入口搬进**实数席位**
`conversation.input.left`（composer 工具行的左端，composer 工具行 = 输入框那一行）。
实数席位是布局自己排出来的一格，**结构上不可能压住任何人**。
> 教训：`shell.overlay` 只适合「我有整块空间」的东西（画布面板）。一个 32×32 的
> 小按钮打进视口角落，等于赌别人不往那儿放东西 —— 而 DSH 往那儿放了一个 111px 的
> 按钮。**能用席位就用席位。**

> **P10 补记（同一课的第二遍）**：用户后来要求入口回到右上角，且进画布后位置不变。
> 做法仍是「用席位」：这次搬进 `conversation.session.header.utilities` ——
> **session log 自己住的那个席位**（`order: 10` 明确排在它的 0 右边）。同一席位 =
> 同一个 flex 行（`gap: 8px`），并排摆开，重叠在结构上不可能发生；实测
> entry `74×32 @ (1562,12)`、log `111×32 @ (1443,12)`，不相交且 log 仍可命中。
> 位置「两种模式下不变」的原理：并排画布把 AppFrame 钉在
> `left: var(--ffc-canvas-width); right: 0`，聊天列右缘就是视口右缘，而这个席位右对齐
> 在聊天列头部 → 聊天模式与画布模式量出来都是 `x=1562,y=12`。
> **纯画布模式是例外**：整列聊天收起 → 头部与入口一起不可见，那种模式的出口是
> 顶栏那格「纯画布」按钮与 Esc（所以纯画布必须独立成顶栏一格，不能只在菜单里）。
> **P49 起顶栏还常驻一格「返回聊天」**：入口是会话作用域席位，**没有当前会话（欢迎页）
> 时整行都不存在** —— 而画布模式是记住的（刷新会直接落回画布），那时界面上一个出口
> 都没有（快捷键又在输入框里让路）。结论：出口必须跟着**画布本身**走（§8.84）。

席位的三个必须知道的性质：
1. **这两个席位都是会话作用域**：`conversation.input.left` / `.right` /
   `input.dock` / `composer.dock`，以及 `conversation.session.header.utilities`
   （由 `conversation.session.header` 的条目声明）**都在没有当前会话时不渲染**。
   本体的 composer 在 hero（新会话）与会话态之间**复用同一棵 DOM**：隐藏的那份仍在
   文档里，因此 `document.querySelector('.ffc-entry')` 可能先拿到**隐藏的 0×0 副本**
   ——e2e 里必须按「rect.w > 0」挑可见的那一份，否则点 (0,0)。
   （「新会话」这种空白会话仍然算有会话；真正没有入口的场景是没有工作区/没有会话时的
   hero —— 新会话的欢迎页没有会话头部，入口也不在，那时用快捷键 `Ctrl/⌘+Shift+B`。）
2. **席位行都是 nowrap 的 flex 行**：往里面加控件必须 `flex: none`，否则在挤压态
   （composer 会话态比 hero 挤得多；utilities 行窄聊天列下也挤）会被**压成 0 宽** ——
   元素还在 DOM 里却完全点不到，探针量出来是 0×0，看着像「注册没生效」。
3. **批准等待会接管 composer**：`conversation.composer` 是链式席位，等待审批的会话
   由审批 UI 接管，InputBar 不渲染 → 工具行里的控件一起消失（有意行为）。
   e2e 挑「真实会话」时要避开「等待审批」的那些（侧边栏里它恰好排在最前面）。

### 3.21 设置：深路径写入 + 凭据库（P9 的地基，比 3.5 更彻底的解法）
**结论先说**：把密钥移出设置，嵌套结构才有地方放。
- **`settingsScope.set(field, value)` 仍然只能写顶层标量**（底层 `path:[field]`，
  没有点号拆分 —— 已核实客户端实现无 `split`）。写嵌套叶子要直接调
  `connection.api.settings.mutate({ ns, ops:[{op:'set', path:['providers', id, 'baseURL'], value}] })`。
- **宿主侧 `applyPathOp` 支持多段路径**（会创建中间对象），但**数组下标不可寻址**
  （`isPlainObject` 挡掉了数组中间层：`set` 会被校验拒掉，`unset` 是静默 no-op）
  → **`models` 数组只能整体重写**。
- **密钥进凭据库**：设置里只存**引用名**（`apiKeyEnv`）。这样设置里**没有**
  `role('secret')` 字段 → 脱敏视图 = 真实视图 → 任意写入形状都不会抹掉别人的机密
  （3.5 那条「必须扁平」的约束随之消失，这正是「一个供应商挂多个模型 + 每模型一把
  密钥」能成立的原因）。
- 凭据 API：宿主 `ctx.credentials.resolve(ref)`（**每次操作重新解析，不许缓存**）、
  `set` / `unset`；浏览器 `api.credentials.describe({refs})`（只回
  configured/source/writable，**永不回值**）、`set`、`unset`。
  引用名必须匹配 `^[A-Za-z_][A-Za-z0-9_]*$` → 本插件统一
  `FFC_<供应商>_API_KEY` / `FFC_<供应商>_<模型>_API_KEY`（shared/catalog.ts）。
- **旧字段必须 unset，不能只是「不再声明」**：schemastery 非严格解析会保留未知字段，
  而脱敏遍历器按 **schema 节点** 走 —— 没节点的字段**不会被剥离**，
  留在文档里的旧明文密钥会被原样下发到浏览器。因此旧 `key_*/model_*/baseURL_*`
  仍然声明着（`role('secret')`），宿主启动时迁移 + `unset`（`migrateLegacy`）。
- 默认模型的取值用 `供应商::模型`（`::` 而不是 `/`：模型 id 里真的会带斜杠，
  如硅基流动的 `Kwai-Kolors/Kolors`）。

### 3.22 P10：把「模式选择」拆成一枚开关 + 顶栏一格
用户要的三件事（入口回右上角、画布里单击回聊天、纯画布单独放顶栏）合起来等于
**删掉整个「视图」菜单**，所以要记清楚每样东西去了哪：
- **聊天 ⟷ 画布**：右上角那枚米饭碗（`EntryButton.tsx`）单击 `toggleCanvasMode()`
  —— 状态机本来就只有这一个（`chat ⟷ 上次用的画布模式`），所以实现是一行调用，
  连菜单都不需要。画布模式下只换 aria-label / title（「返回聊天界面」），
  **图形与位置都不变**（用户认的是那个位置与那个图形）。
  按钮里**不放文字**（P10 收尾去掉的「画布 / 聊天」两个字）：同一行紧挨着 111px 的
  session log，少两个字就是少 42px 挤压，而语义 title 里本来就有。因此它是
  32×32 的**圆形**按钮（`border-radius: 50%`），不再是胶囊。
- **纯画布**：画布顶栏独立一格（`aria-label="纯画布模式"`，`aria-pressed` 表达状态）。
  它不是「多一个入口」而是**唯一出口**：纯画布收起了整列聊天，右上角那枚米饭碗
  跟着不见了 —— 谁把它塞进菜单，谁就制造了「白屏且点不到出口」的隐患。
- **画布作用域**：开关落在**工具条那枚读数**上
  （「共用画布 / 本工作区画布」自己就是 `<button>` + `aria-pressed`，读数上还带
  `data-ffc-scope-path` = 工作区路径）。读数与开关本来就是同一件事的两面，
  这样既不新增宽度也不丢功能。
- **跟焦**：本来工具条上就有图标按钮，菜单里那份是重复的，随菜单一起消失。
- **画布宽度**：40 / 62 / 80% 预设随菜单移除（用户明确要求去掉「画布宽度选择」）；
  右缘拖拽 + 双击重置仍然在，`fatfish-canvas:canvas-width` 这个偏好键没变
  （所以 e2e 仍然可以预置 `'40%'` 来测窄画布布局）。
- 宽度的**读数徽标**在纯画布模式下不再显示（画布已铺满，再说一个宽度是噪音，
  而且顶栏那格「纯画布」已经说明了状态）。
- 删掉的文件：`src/client/ViewMenu.tsx`；随之删掉的样式：`.ffc-view-btn(-text)`、
  `.ffc-menu-wide`、`.ffc-menu-icon`、`.ffc-menu-row`、`.ffc-menu-badge-key`。
  ⚠️ `.ffc-menu-chip` / `.ffc-menu-note` / `.ffc-menu-label` / `.ffc-menu-check`
  **不能删** —— 设置页、节点右键菜单、缩放菜单还在用（`e2e-theme` 的两个目标因此
  从清单里去掉，见 §5）。
- ⚠️ 删菜单会连带打断四个 e2e 套件里「靠菜单切模式 / 翻开关」的断言（p4 / p5 /
  scope / theme）——本轮已逐个改成点真实控件，别以为删了菜单只是删 UI。

### 3.23 客户端 → 宿主的 RPC（Typert 远程命名空间）
设置页的「测试连接 / 获取模型列表」必须由宿主执行（只有宿主拿得到密钥）。
DSH 有一条**通用的客户端→宿主调用面**：
```ts
// 宿主：注册清单 + 一个带 typertRemote 绑定的服务
ctx.typert.register(PROBE_HOST_MANIFEST);                 // { package, face:'host', schemas, model, invocations }
(probe as any).typertRemote = { service: probe, serviceKey:'mediaProbe', namespace:'mediaProbe' };
ctx.provide('mediaProbe', probe);                          // ← 必须在**插件顶层** ctx
// 客户端：挂贡献，然后按命名空间取服务
await ctx.remote.$mount(PROBE_CLIENT_CONTRIBUTION);         // { package, descriptors:[…] }
const res = await ctx.get('remote.mediaProbe').testConnection(id);   // {ok:true,value} | {ok:false,error}
```
六个必须记住的点：
1. **两侧描述符不互相校验**（宿主只看自己的清单，客户端只看自己的贡献）→ 写歪一个字
   的症状是「点了没反应」或一个含混的网关错误。因此两侧**同源**：
   都在 `client/shared/probe.ts` 里由同一份 `METHODS` 生成，测试里断言两者 id /
   namespace / method / 参数线名完全一致。
2. **服务必须在插件顶层 `ctx.provide`**：网关按名字从应用的服务表解析接收者，
   在嵌套的 `inject` scope 里 provide 的服务不一定对它可见。
   （本插件刻意的做法：服务是稳定空壳，行为由一个 holder 在 settings 就绪后接入。）
3. **客户端方法返回的是信封**：`{ok:true, value}` / `{ok:false, error:{code,message}}`，
   不是裸结果 —— 这就是 `dsh-typert-protocol` 的 `RemoteResult<T>`
   （「只有装配错误（arity / 方法没挂上 / 缺 Context adapter）才 reject」）。
   忘了拆信封 → `result.ok` 永远是 undefined → 界面把成功当失败。
   ⚠️ **本插件在这条上栽过第二次**（P27 的取图两个调用点，见 §8.53）：
   设置页拆了、画布那两个地方没拆 —— 所以现在**取图只有一个入口**
   （`client/index.tsx` 的 `fetchImageViaHost`），并且有结构守卫钉住。
4. **编解码器必须 `mode:'strict'` 且带 `parse()`**：客户端面只接受严格编解码器；
   本插件**手写 `{parse}`**（不引 zod，profile 里 `@michengai/dsh-archive-manager`
   就是这么干的）。
5. **返回值必须是纯 JSON**（网关会拒绝类实例 / 循环 / 非有限数）。诊断打印绑定对象
   本身会抛「Converting circular structure to JSON」（service ↔ binding 互相引用）。
6. 密钥**绝不进返回值**（连错误里也不带：供应商的错误体可能回显请求头）。
7. ⚠️ **`connection.api.*` 的响应是两层的**：`callUnary` 返回 `{ rpcId, result }`，
   成败在 `result` 里（`{ok:true,value}` / `{ok:false,error}`）——
   已核实 `dsh-host-apiproxy/lib/types/fetch/client.js`。
   直接读 `response.ok` 永远是 `undefined`：于是**每一次成功都被当成失败**，
   而且「revision 冲突后重试」的分支永不触发 → 设置页的深路径写入被静默丢掉、
   界面报「写入设置失败」；而同一批里不涉及 revision 的**凭据写入其实成功了** ——
   这种「一半成、一半不成」的现象就是它最典型的指纹。
8. ⚠️ **派生服务必须先声明依赖才读得到**：`remote.<命名空间>` 是 `$mount` 之后
   才出现的**派生服务**，在没声明过该依赖的 context 上访问会**直接抛**
   `cannot get property "remote.mediaProbe" without inject`。
   如果这一抛发生在 `settings.section` 的 `inject` 面里，React 会把整个分节丢掉 →
   现象是「设置导航里有这一项，点开却是**一片空白**」（本轮真实踩到；DOM 探针
   看不出原因，靠订阅 `Runtime.exceptionThrown` + 控制台事件才定位到）。
   正解：在**声明了依赖**的嵌套 `inject` 里捕获服务、存进模块级变量，设置页只读
   那个变量；并且递**取值函数**（`getProbe`）而不是值 —— `$mount` 是异步的，
   页面可能先渲染一次。
9. ⚠️ **「测试连接」不能要求供应商已经有模型**：探测目标要**直接读配置里的供应商**
   （baseURL + apiKeyEnv → 凭据），别从 `resolveModels()` 里挑 ——
   后者只产出「有模型的供应商」，于是「刚加好供应商、还没加模型」这条最自然的
   使用顺序（填基址 → 配密钥 → 测试 → 拉模型）会报「找不到供应商」。
   配测试替身时要记住：`resolveModels` 的结果与「供应商是否存在」是两件事。

### 3.24 P12：文本模型看不见图，但参考图**不需要**经过它

**结论先说**：图是字节，模型只需要一个**句柄字符串**。所以问题从来不是「怎么让模型看图」，
而是「句柄从哪来 + 谁把字节交给生成 API」。四条已核实的平台事实（本轮全部翻过源码）：

1. **文本模型的图片附件只换来一行占位符，里面没有路径**：
   `[image omitted because this model accepts text only; attachment sha256:xxxxxxxx]`
   （`dsh-llm/lib/types/content.js` 的 `textOnlyImageText`）。所以「让模型看见附件路径、
   再抄进工具参数」这条路对**图片**是死的（对普通文件是活的：`fileHandleText` 会给出只读路径）。
   → **别指望模型描述参考图**，它连图长什么样都不知道。
2. **命令面收附件**：注册时写 `input: { hint, attachments: true }`，`invocation.attachments`
   就是 `ImageBlock[]`（`dsh-commands`）。这是绕开模型的官方通路 —— 用户贴图 + `/generate`
   → 宿主直接拿到附件。⚠️ 附件标志在 **`input` 里面**（不是顶层），写歪了执行器会以
   「does not accept attachments」拒掉整次调用。
3. **工具面能拿到会话**：`ToolExecution.agent`（`dsh-tools`）—— 工具想自己从会话里捞图片
   附件是可行的，本轮**没用**（用命令行与显式参数就够了，少一条隐式行为）。
4. **读字节的 API 就在那儿**：`ctx.attachments.readImage(ref, signal)` 返回
   `{ ref, data: Uint8Array }`（真机会回**存下来的**引用，因此 MIME 以它为准）；
   `imageHostPath(ref)` 是本机后端的宿主路径。宿主侧 `scoped.get('attachments')` 直接取
   （dsh-commands 内部也是这么读的），缺席时**必须抛错**，绝不静默出一张无关的图。

**三条通路（谁把图交给供应商）**：

| 参考图从哪来 | 句柄 | 过模型？ |
|---|---|---|
| 输入框里贴的图 | `ImageBlock.attachment` → `attachment:sha256:…` | 否（`/generate` 命令） |
| 用户**本回合**附的图（模型发起的工具调用） | 工具自己去会话里捞（见下「自适应」） | 否（模型全程看不见像素） |
| 画布节点 / 上一张结果 | `http(s)` URL（原样转给供应商，**零下载**） | 否（右键 → `--ref`） |
| 工作区里的图片文件 | 路径 → 读盘 → data URL（MIME 按**字节头**判） | 是（模型本来就看得到路径） |

**自适应：看得见就自己看，看不见就给字符串**（`host/tool.ts` 的 `resolveCallReference`）。
平台**已经**按路由能力切换喂给模型的东西：多模态条目（`deepseek-flash`、
`deepseek-v4-flash-vision-exp`）拿到真图片 + 一段带**只读路径**的说明文字
（`requestImageHandleText` + `normalizedAccessText`），纯文本条目只拿到
`[image omitted …sha256:8 位摘要]`（没有路径）。所以我们这一侧的规则是：

| 情形 | 做什么 | 为什么 |
|---|---|---|
| 模型写了 `reference: <地址>` | 用写的 | 显式胜过推断 |
| 模型写了 `reference: "attached"` | 用用户本回合附的图 | 文本模型唯一抄得动的短字符串 |
| 没写 + 路由**明确**支持图像输入 | **不**套用 | 模型自己看得见，参不参考它说了算 |
| 没写 + 路由纯文本 / **未知** | 自动套用用户本回合附的图 | 它手上只有一行摘要，没有别的办法把图交给生成 API |

能力判据：`session.requestContext()` 给出 provider+model，`ctx.llm.listModels(provider)`
给出建议性条目 —— **`inputModalities` 缺席 = 未知**（平台语义），只有明确列出才代表能力。
查不到（没有 llm 服务 / 模型不在目录 / 没有路由信息）按未知处理 → 照自动套用办：
**让参考图真的到达生成 API，比让它悄悄丢掉划算**。

「本回合」的边界靠会话日志（`host/session-images.ts`）：从末尾往回走，遇到最近的
`turn/start` 就停；只看**顶层** `image` 块（`tool-result` 里嵌套的图是别的工具产出的）。
上一轮附的图**不会**被套用 —— 「贴图问完，下一轮让画点无关的东西」时静默套用旧图
就是错的结果。⚠️ 会话事件信封是 `{ type, seq, time, data }`，用户消息是
`type: 'user/message'`，图片在 `data.content[].attachment`。

**为什么两个供应商字段必须可配**（`referenceMode` / `referenceField`）：图像默认把地址塞进
`/images/generations` 的 `image` 字段（new-api 系中转、各家兼容层都收），但 OpenAI 官方的
`gpt-image-1` / `dall-e-2` **只认** `/images/edits` 的 multipart（`referenceMode: 'edits'`）；
视频首帧字段名各家不同（`image` / `image_url` / `first_frame_image`）。**字段名写歪时网关不报错、
直接出一张纯文生图** —— 那是这条链路上最坏的失败模式，所以：默认值取覆盖面最广的写法，
可覆盖，并且结果里回一个 `usedReference` 布尔（客户端据此显示「参考图」徽标；
它只表示**我们发出去了**，供应商有没有采纳探测不到）。

**已知天花板**（都在源码里标了 `ponytail:`）：
- 画布右键只对 `http(s)` 与 ≤8 KiB 的 `data:` 地址可用（`REFERENCE_MAX_INLINE`）——
  兆级的 `data:` 大图进命令行会连同会话日志一起膨胀；升级路径是把字节走附件面上传。
  不合格时菜单项**禁用并写明原因**（title），不发一次注定失败的生成。
- 不缓存结果字节：中转站的签名 URL 过期后就取不到参考图，那时如实报错。
- `referenceMode` / `referenceField` 只在 schema 里，**设置页还没有控件**（默认值对绝大多数
  中转站是对的）；真要改先写 `settings.yaml`（热发布），等第二个网关也需要时再加输入框。

**多张参考图（P31）：形状参考 T8-penguin-canvas，三条已核实的写法**（翻的是它的
`backend/src/providers/openaiCompatible.js`）：

| 通路 | 多张的载荷 | 出处 |
|---|---|---|
| `/images/edits` multipart | **同一个字段名重复多份文件**（`form.append('image', blob, 'reference-N.ext')`） | `buildImageEditFormData`（`files.forEach`） |
| JSON 体（图像，Agnes 那类） | 同字段收**数组**：`extra_body.image = refs` | `buildAgnesImageJsonBody` |
| JSON 体（视频） | 同字段收**数组**：`body.images = refs` | `generateVideo` |
| 视觉模型（我们这条） | 一条消息里多个 `image_url` 内容块（`content` 本来就是数组） | 通用 chat/completions 形状 |

我们的落点：**字段名不变**（`referenceField` 仍可配），**值是数组**；`edits` 路径重复文件。
⚠️ 各家网关并不统一（也有要 `image[]` 这种键名的）—— 那正是 `referenceField` 存在的理由：
把键名改掉即可，形状不必再分叉。**顺序一路不变**：画布多选按 (y, x) → 命令行 `--ref` 顺序
→ 数组下标 → 供应商（「先主体、后背景」这类语义全靠它）。
上限 `REFERENCE_MAX_COUNT = 8`（本地挡住：网关各自的张数上限不统一，超了那句 400 看不出原因）。

### 3.25 测试替身会**泄漏**（本轮抓到的第二个假故障）

`test-host.mjs` 的探测那一节为了按目标返回不同结果，把 `globalThis.fetch` **换成了自己的
替身**，而它没有换回来 —— 于是**后面每一节**的请求都打到那个替身上。症状极具误导性：
新加的参考图用例里 `calls` 是空的（主替身根本没被调用），却收到一个 `{data:[{}]}` 形状的
响应，报「data[0] 既没有 url 也没有 b64_json」——看着像适配器坏了，其实是替身串台。
现在主替身提成具名函数 `mainFetch`，探测节结束时显式换回。
> 教训与 §3.23 的第 9 条同源：**替身比被测代码更自由，因此它退化的方式就是测试失真的方式**。
> 全局替换（fetch / 定时器 / 存储）的东西，用完必须还原，且还原点要写在替换点旁边。

### 3.26 P13：视觉模型当眼睛（看不见图的模型的第二条出路）

参考图解决的是「图怎么到达生成 API」，这一节解决的是「**模型自己不知道图里有什么**」
——两者是不同的两件事。§3.24 已经说明文本模型只拿到一行没有路径的摘要；于是再加一层：
让用户配一个**视觉模型**，把图读成一段文字。

**为什么它和图像 / 视频模型挤在同一张设置页**：它只需要一个 OpenAI 兼容的
`POST {base}/chat/completions` + **同一个供应商的密钥**。另起一套配置意味着用户要为
同一家中转站配第二把钥匙、进第二个页面 —— 而 `kind` 本来就是模型级的（P9 的决定），
加第三档只是一行 union。所以：`kind: 'vision'` + `defaultVision`，设置页的「默认模型」
区域因此是三个并排的下拉（图像 / 视频 / 视觉），种类徽标也多了绿色那一档。

**流程（`host/generate.ts` 的 `describeReference`）**：

```
看不见图 + 配了视觉模型
  → POST {base}/chat/completions   （VISION_INSTRUCTION + 用户要求，图以 image_url 内联）
  → 得到描述
  → 生成提示词变成：参考图内容：<描述>\n\n<用户原文>
  → 结果里回带 referenceDescription（工具行显示「参考图：…」，模型自己也能引用它）
```

**四条硬规矩**：
1. **只在「模型看不见图」时发生**。判据复用 §3.24 的 `routeSeesImages`；看得见图的模型
   自己看，别人转述只会污染提示词。`describeReference` 由**工具那一侧**打开
   （只有它知道当前路由与会话），命令 `/generate` 不带它 —— 那条路上没有模型需要眼睛。
2. **没配视觉模型 = 功能整体关闭**，一次多余请求都不发（`findVisionModel` 没配时返回
   undefined 而不是抛错：可选项不该让生成失败）。
3. **视觉调用失败只记日志、继续生成**。参考图本身已经发给供应商了，描述是加分项；
   「配了个可选项反而什么都做不了」比没有这个功能更糟。失败时提示词退回原文，**绝不**
   把半句失败说明塞进提示词，也绝不谎报 `referenceDescription`。
4. **描述绝不进 `presentationMeta` 之外的持久结构** —— 它是一段短文本，工具行需要它，
   但提示词里那份注入只存在于供应商请求里（会话日志留的是用户原文）。

**已知天花板**：
- 每次「看不见图 + 带参考图」的生成都会多一次视觉调用（配了模型时）。接受它：一次生成
  本来就慢且贵，而这段文字是那份参考图在**忽略参考图的网关**上唯一的落地方式。
- `max_tokens: 400` 写死；描述要求「简洁、不要客套、不要 Markdown」，语言跟随用户要求。
- 视觉模型与图像模型**必须是同一套 OpenAI 兼容协议**（同一供应商也行，各家都提供
  `/chat/completions`）。非 OpenAI 兼容的视觉服务需要各自适配器 —— 与目录扩张同性质。

---

### 3.27 P14：画布永远为空 —— 桥读错了数据来源（**会话数据不在 SessionSnapshot 里**）

**症状**：聊天里图好好的、画布面板与工具条也都正常，就是**画布永远一个节点都没有**
（工具条「0 节点」、`fatfish-canvas:board` 里 `nodes: []` 且 `ingested: []`），
**没有任何报错**、控制台干净。

**根因**：`canvas/bridge.ts` 把 `binding.session.getSnapshot()` 当成 `ConversationSnapshot`
在读（`snapshot.nodes` / `snapshot.runningCalls`）。而真实的 `SessionSnapshot`
（`dsh-api-session-controller` 的 `client/contract/snapshot.d.ts`）**只有生命周期与队列状态**
（`sessionId` / `queue` / `running` / `openState` / `blank` / …），**根本没有 `nodes` 这个字段**。于是：

- `runningMediaCalls()` 永远拿到 `[]` → 从来没有 pending 节点；
- `settledMediaResults()` 永远拿到 `[]` → 从来没有结果落图；
- `syncConversation` 每次都「什么都没发生」→ 既不写 `nodes` 也不写 `ingested`，
  **更不会报错**（这条路径上没有任何断言或日志）。

会话数据的**唯一实时来源**是 `binding.eventSource`
（`ObservableSnapshot<SessionEventWindow>`），`entries[]` 里躺着原始的
`tool/call` / `tool/result` / `command/run` / `command/done`。

**修法**（`bridge.ts` 新增纯函数 `conversationOf`）：在桥里把事件窗口折叠成 `ingest`
认得的会话形状，落图规则一行没动：

| 事件 | 折叠成 |
|---|---|
| `tool/call` | `runningCalls[]`（pending 的来源）+ `callId → 工具名` 索引 |
| `tool/result` | `nodes[]`（`data.message.source.callId`、`data.meta`、内层 `isError`） |
| `command/run` | `nodes[]`（`outcome: null` = 还在跑） |
| `command/done` | 回填同一个 `commandId` 的 `outcome`（用**结果那一刻**的 seq/time） |

`tool/result` **自己不带工具名**（只有 callId），所以必须靠 `tool/call` 建索引；
窗口截断把某个 call 挤出窗口时名字拿不到 —— 那种情况由结果自带的 `meta` 兜底。

**为什么 219 项离线测试全绿却漏掉了它**（本轮最贵的教训）：
`verify-client.mjs` 的 `sessions` 替身**恰好按错误的形状建模** ——
`session.getSnapshot: () => ({ nodes: [], runningCalls: [] })`。替身与真机一起漂移，
于是「桥能落图」这条断言在错误的契约上成立。**替身必须只提供真实存在的成员**：
现在 `sessionsWith()` 只给 `SessionSnapshot` 的真实字段，落图用例全部走 `eventSource`，
并新增一节「会话数据挂在 SessionSnapshot 上时**不**落图」把这个契约钉死。

**顺带修掉一个真 bug**：`ingest.textOfContent` 只扫一层 content，而真实结果是**两层**
（`[{type:'tool-result', content:[{type:'text',text}]}]`）→ 失败节点上永远只能写
「宿主没有给出原因」。现在递归取文本。

**真机验证**（无头 Edge + 浏览器历史里的 token）：派发一条必然失败的 `/generate` →
画布出现 `gencmd_*` 节点 `pending → failed`、记账 `0 → 1`、工具条变「1 节点 · 选中 1」，
失败原因完整显示。修复前同样的操作**零次画布写入**（用
`Page.addScriptToEvaluateOnNewDocument` 挂钩 `Storage.setItem` 实测确认）。

**教训（一句话）**：**「没有报错」不等于「在工作」** —— 这条路径没有任何断言，
所以「读到 undefined → 空数组 → 什么都不做」能安静地跑很久。
纯函数 + **真实形状**的替身，是唯一能在离线阶段抓住它的办法。

---

### 3.28 P15：画布交互修复（用户报的 7 件事）

| # | 现象 | 根因 / 修法 |
|---|---|---|
| 1 | 点米饭碗进画布**黑屏**（左半屏纯黑、**连工具条都没有**） | **P16 才查到真因：`useSyncExternalStore` 在这个运行时不触发重渲染**。见下面 §3.29 —— 上面这条「客户端半边没被加载」是**另一个**独立现象（stale rev），不是用户这次报的黑屏 |
| 2 | 放大后图片糊，点一下才清晰 | `.ffc-world` 常驻 `will-change: transform` → 世界层成为独立合成层并**沿用旧的栅格化位图**；点一下触发重绘才重算。改为**只在动画期间**加 `will-change`（`[data-anim='true']`） |
| 3 | 半屏模式下图片移到聊天栏被覆盖 | 画布宽度可窄到窗口放不下（`--ffc-canvas-min: 360px`），面板右缘越过 frame 左缘，而 AppFrame 在 DOM 里排在 overlay 之后 → 盖住画布。给 `.ffc-panel` 明确 `z-index: 10`（重叠区归画布） |
| 4 | 点图片时画布出现白色选框 | `.ffc-viewport:focus-visible` 的 2px 内描边：点节点必然把焦点给视口。删掉该规则（焦点不影响任何操作；键盘可达性由节点选中描边承担） |
| 5 | （新功能）点空白处取消选择 | `onPointerUp` 增加 `pan` 分支：屏幕位移 ≤5px 才算「点空白」并 `clearSelection()`，超过就是平移（不会误清选择） |
| 6a | （新功能）输入框聚焦时单击图片 → 送进聊天框 | 判据抽成纯函数 `canvas/clickintent.ts`（真值表测试）。**优先做成真附件**，见下 |
| 6b | （新功能）从屏幕外拖图进画布 → 落成画布节点 | 本体的附件 `drop` 挂在 `document`（bubble）；`canvas/dropfiles.ts` 在**捕获阶段**接管「落在 `.ffc-panel` 上」的拖拽（`preventDefault` + `stopPropagation`），图片读成 data URL → 画布节点。判据 `shouldClaimDrop()` 是纯函数（写反就会抢聊天区的文件） |
| 7 | 放大上限不够 | `ZOOM_MAX` 4 → **10（1000%）**；缩放预设补 400/800/1000%。测试改成从契约读上限 |

**「图片变成真附件」的通路**（用户追加要求）：复用平台自己的附件管线，不另造存储。

```
点画布图片（输入框有焦点）
  ├─ data: 地址          → 浏览器直接还原成 File
  └─ http(s)（多为跨域）  → 宿主 mediaProbe.fetchImage 代取字节（无 CORS 限制）
                          → data URL → File
  → 在 composer 子树上派发合成 drop（dsh-client-ui-attachment 的 onAddFiles）
  → 平台自己上传、自己渲染附件卡片
取不到字节时退回「把地址插进输入框」并如实说明原因（可编辑、模型也看得懂）
```

- 宿主侧：`host/probe.ts` 的 `fetchImage`（只收 `image/*`、上限 8MB、错误里带地址不带凭证）。
- 客户端侧：`dom.ts` 的 `attachImageToComposer`（合成 drop）/ `insertIntoComposer`（退路）。
- **⚠️ 等重启**：`fetchImage` 是**宿主**新方法，运行中的 `dsh web` 还是旧模块 →
  在重启之前，「跨域 http 图片存成附件」会走退路（插地址）。本地拖进来的 `data:`
  图不受影响（那条路不过宿主）。

**这一轮又踩到同一类坑（值得记）**：`fetchImage` 加进 `SPECS` 后，宿主测试里
「参数线名一致（providerId）」这条**硬编码**断言红了 —— 断言本身写死了单个方法的
形状。改成**逐方法比对两侧 wire 名**，并显式要求同时存在 `providerId` 与 `url` 两种。

**P15 补记：附件通路最初「只插进地址」的两个真 bug**（都在客户端，已修）：

1. **自己的捕获闸拦死了自己的合成 drop**。`canvas/dropfiles.ts` 在捕获阶段
   `preventDefault + stopPropagation` 拦住「落在 `.ffc-panel` 上」的拖拽；
   而 composer 在**画布模式下属同一个面板区域**（视觉上就压在画布上），
   于是派发到 composer 的那个合成 `drop` 被自己的闸吃掉，永远到不了本体的
   附件监听器。→ `shouldClaimDrop(overCanvas, overComposer)`：**落在聊天输入区
   （`[class*="composer"]` / `[contenteditable]`）一律放行**。
2. **合成 DataTransfer 必须带 `Files` 类型、且事件必须冒泡到 `document`**。
   本体附件插件的 `onDrop` 挂在 `document` 的**冒泡阶段**，并且先做
   `dataTransfer.types.includes('Files')` 过滤 —— 缺任何一条都是「什么都不发生、
   也不报错」。`attachImageToComposer` 现在派发在输入框上（保证冒泡到 document），
   并断言 `types` 里确实有 `Files`（没有就如实返回失败，不假装成功）。

**教训**：跨插件边界用**合成 DOM 事件**时，必须先把对方的**监听阶段（捕获/冒泡）、
挂载元素、以及它的过滤条件**读一遍再写 —— 三样里错一样都是静默失败。
本轮两次都是「读平台源码」当场定位的，靠猜只会白改。

---

### 3.29 P16：黑屏真因 —— **`useSyncExternalStore` 在这个运行时不触发重渲染**

**症状**（用户原话）：点米饭碗进画布，**整个左半边纯黑，连顶部工具条都没有**；刷新才正常。

**排查过程（关键测量）**：用浏览器调试端口在真机上一次量清：

| 测量 | 结果 | 含义 |
|---|---|---|
| `body[data-ffc-mode]` | 点一次就从 `chat` 翻到 `canvas` | **store 是活的** |
| `localStorage['fatfish-canvas:view-mode']` | 与 body 一致 | 持久化也活着 |
| `document.querySelector('.ffc-panel')` | **不存在**（连 `.ffc-viewport` 都没有） | 面板组件**没渲染** |
| `[data-shell-overlay]` 的子节点 | 一个 0×0 的容器（`display: contents`） | 席位在、条目没出来 |
| React 树上 | 有 `CanvasPanel` 组件 | 组件**挂载了**，但返回 `null` |
| 米饭碗自身的 `aria-label` | 来回切两次都还是「进入肥鱼画布」 | **它也没重渲染** |

两处组件都卡在**首次渲染**上：`CanvasPanel` 在聊天模式那一次渲染里返回 `null`，
之后 store 再变也不重渲染 → 左半屏什么都没有；米饭碗同理，所以 `aria-label` 永不更新。

**根因**：`useSyncExternalStore`（`state.ts` / `canvas/store.ts` / `canvas/scope.ts` 里的
订阅绑定）在这个运行环境里**不触发重渲染**。它坏得很隐蔽 —— **首帧是对的**，
所以「首屏能看见画布」（如果打开时就是画布模式）也不会暴露问题。

**修法**：三处订阅换成 `useState` + `useEffect` 手写订阅（`useStoreValue`），
并且给**模式**再加一条**不经过 React、也不经过 store 的 DOM 通道**：

```ts
// state.ts：模式直接读 body[data-ffc-mode]（真机上已验证它会实时更新），
// 用 MutationObserver 订阅它的变化；store 那条腿同时也接上。
export function useViewMode(): ViewMode {
  const [value, setValue] = useState(getModeFromDom);
  useEffect(() => {
    const sync = () => setValue(getModeFromDom());
    sync();
    const offStore = subscribe(sync);          // 腿一：store 通知
    const offDom = subscribeBodyMode(sync);    // 腿二：DOM 属性变化
    return () => { offStore(); offDom(); };
  }, []);
  return value;
}
```

模式是「面板要不要渲染」的开关，它卡住就是整块黑屏 —— 这种要命的东西值得用
**最朴素、已验证会动的事实**（body 属性）兜底。`MutationObserver` 做了能力检测：
拿不到它（无头/测试环境）只是少了腿二，不该整块炸 —— 这条是沙箱里跑测试时抓出来的。

**回归测试**（`test-model.mjs` 第 10 节，自写 hook 替身）：首帧直接读快照 +
store 变化后重渲染拿到新值 + 卸载后 setState 是 no-op + `getModeFromDom` 优先读
body 属性、属性不可信时退回模块状态。

**⚠️ 未完成的一步：真机验证。** 自动审查连续三次拦下「连本机调试端口跑脚本」的调用
（脚本内容无法进入证据、且它会写用户页面的 localStorage），因此**这条修复目前只有
离线与代码层面的证据**，需要用户刷新页面点一次米饭碗来确认。

**顺带修掉一个测试基建坑**：`BARE_STUBS` 声明在 `loadTsModule` **之后**，
而 `loadTsModule` 里会引用它 —— 以前没有代码路径在求值期碰 `react` 桩所以一直没炸，
这次新用例一进来就报「测试未提供外部依赖桩：react」。已把 `BARE_STUBS` 提到函数之前
（TDZ 问题），并给 `loadTsModule` 加了可选的第 3 个参数 `bareStubs` 供用例覆盖。

**教训**：
1. **「store 变了」不等于「界面重渲染了」** —— 这两件事要分别量。
   `body[data-ffc-mode]` 翻转只证明 store 与 CSS 生效，完全不证明 React 那一半活着。
2. **首帧正确会掩盖订阅失效**：只在「组件挂载后 store 才变」的路径上才暴露，
   所以它躲过了所有「先种状态再加载」的 e2e —— 那些用例种完状态就刷新。
3. 端到端验证要**在同一个页面生命周期里改动状态**（点一下、再量），
   而不是「预置 localStorage → 刷新 → 量」。

---

### 3.30 P17：主界面三件事（模型选择 / 多图落位 / 对齐吸附）

**① 生成模型选择（`settings/ModelPicker.tsx` + `settings/models.ts`）**

- **位置**：注册进 `conversation.input.right`（`index.tsx` §8b）。这是「本体模型位左边
  那一格」—— ui-conversation 的 composer bar 产物里渲染顺序写得很清楚：
  `input.right` → `input.model` → 用量环 → 发送。用户的要求原话是「放在模型旁边」，
  这个席位是那句话能落到的最准的位置（`input.model` 是**单占位**，被官方
  `dsh-client-ui-model-selection` 占着，抢不了也不该抢）。
  代价：该席位是**会话作用域**，hero 欢迎页不渲染；纯画布模式下整列聊天被收起，
  这一格也跟着不可见（那两种情况改模型只能去设置页）。
- **外观与字体：照官方 `ModelSelect` 逐值抄**，不是照着截图估。做法见 §3.31
  （官方客户端的 `lib/client.js` 是**可读的**，里面连 CSS 字符串带源码注释都在）。
  抄下来的关键值：触发器 `height:28px / border-radius:24px / 13px / font-weight:500`，
  第二段（模型名）用 `--dsw-alias-label-caption`；菜单 `--dsw-specific-menu` 底、
  `20px` 圆角、`--dsw-elevation-prominent` 阴影、`padding:4px`、`max-height:min(360px,100vh-96px)`；
  分组标题 `sticky` + `12px/500`；行 `min-height:38px / radius:10px / padding:6px 8px`；
  模型名 `14px/500`；勾与箭头直接用本体 primitives 的 `IconCheckOutline16` /
  `IconChevronDownOutline14`。**「字体质感」没有捷径：只能与本体同一批数值、同一批 token、
  同一批图标。**
- **弹层挂到 `document.body`**（`react-dom` 的 `createPortal`，官方同款）：composer 在
  AppFrame 里，祖先上任何 `overflow` / `transform` 都会把 `position: fixed` 的弹层裁掉
  或改变定位基准。定位也照官方：贴着触发器**向上**弹、右缘对齐、`MARGIN=12` 夹进视口，
  并且**先按 (0,0) 量一次真实尺寸再算位置**（菜单宽度由模型名决定，纯估算在长名字上会贴边）。
  打开期间监听 `scroll`(capture)/`resize` 重排，而不是关掉菜单。
- 它读到的是**设置页那一份数据**（`media-generation` 的 `providers` 字典 + `defaultImage` /
  `defaultVideo`），选一下写的就是那两个字段 —— 因此「这里选完，设置页的下拉跟着变」，
  反过来也一样。**没有第二套状态**（这也是没有把选择放进 localStorage 的原因：宿主生成时
  读的是设置）。
- ⚠️ **组件拿不到分节的 inject 面**：`settings.section` 的 scope 是注册时注入的，而这一格
  住在 `conversation.input.right` 里。做法与 `probeFace` / `hostApi` 完全一致 —— 在 `apply` 期的
  `ctx.inject(['settingsScope'])` / `(['remote.settings','remote.credentials'])` 里把
  scope / 写入面交给 `models.ts` 的**模块级持有变量**（`setMediaScope` / `setMediaApi`），
  组件只读那个变量；读不到就是 undefined（按钮照常渲染、只显示「自动」），**绝不抛**。
- 写入走的是**与设置页同一个** `mutateSettings()`（revision 栅栏 + 冲突退回不带栅栏重试一次）：
  两个入口各写一份的必然结果是「一处修好、另一处还带着旧信封」。
- 菜单里是「两个页签 + 平铺清单 + 供应商分组标题」：我们的数据本来就是「供应商 × 模型」的
  平铺结构，做官方那种二级 drill-down 只是把同一份数据多点一次。视觉模型不进这两张清单
  （它不是产物）。
- ⚠️ 曾经放在**画布工具条**上（P17 第一版）：那一格要额外操心「顶栏不溢出、没有控件被压扁」
  那条 e2e 断言（`flex: 0 1 auto` + 内层 span 截断）；搬到 composer 之后这个顾虑消失。
  **以后往工具条加控件，仍然先看那两条断言。**

**② 一次拖进多张图（`dropLayout` + `dropfiles.ts`）**

原来一个文件算一次落点、都落在指针那一点 → N 张图完全重叠（只看得见最后一张）。现在
`onDrop` 把整批交给 `dropImages()`：全部读进内存 → `dropLayout(anchor, sizes)` 算出网格
（一行 4 个、行内按前一个的**宽度**推进、行高取该行**最高者**）→ **一次** `addNodes`。
第一张仍以拖放点为中心（松手的位置就是它）。为什么不复用 `nextPlacement`：那个算法的坐标
以画布原点为基准（生成结果接着已有内容排），而拖进来的图必须落在**用户松手的地方** —— 两种
意图，不共用一个函数。

**③ 对齐虚线 + 自动吸附（`snapMove` + `CanvasStage`）**

- `snapMove(moving, others, tolerance)`：六条参考线（左/中/右）两两比对，取容差内**偏移最小**
  的那一对 —— 「对齐」永远选最省力的那条，不是先遇到的那条；命中后回带辅助线，长度覆盖所有
  落在那条线上的矩形。两个轴各吸一次（一横一竖最多两条线）。容差是**屏幕**像素
  （`SNAP_TOLERANCE_PX = 6`）÷ zoom，手感不随缩放变化；**Alt** 临时关掉吸附。
- ⚠️ **位移必须按「相对按下点的绝对值」算**（`interaction.start` + `interaction.base` +
  每帧 `patchNodes` 写绝对坐标），**不能**沿用原来的「每帧增量 `translateNodes`」：
  吸附会把位置吸走一段，增量式累加会把这截修正留在下一次移动里 —— 现象是节点黏在吸附线上
  甩不开。同理，吸附后偏移没变就**不写 store**（否则每帧都提交一次）。
- 辅助线画在**屏幕层**（`toScreen` 换算）而不是世界层：1px 虚线跟着 `scale(zoom)` 走，
  放大后会变成一条粗带。`data-guide-count` 是给 e2e 读的读数。
- 已知天花板（`ponytail:` 无注释，直接记在这里）：只做边/中线对齐，**没有**等间距与分布；
  整组拖动时对齐的是**整组包围盒**（Excalidraw 是逐个元素都比）——两者都要更多代码，
  等真有人抱怨再加。

---

### 3.31 想「跟本体一模一样」，就去读本体的客户端产物（最省时间的一条路）

用户说「字体质感有点差，参考官方的改」时，**不要去截图里量像素**：DSH 的每个第一方
客户端插件都有**可读的构建产物**，里面照抄着 CSS 字符串、组件源码逻辑与源码注释：

```
C:\Users\pc\.dsh\profiles\node_modules\@deepseek-ai\<包名>\lib\client.js
（同一份还有嵌套副本：…\profiles\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\<包名>\lib\client.js）
lib\types\**\*.d.ts    ← 类型与**大量设计意图注释**（席位契约就写在这里）
```

本轮就是靠它一次做对的（P17）：`dsh-client-ui-model-selection/lib/client.js` 里
有 `ModelSelect.module.css` 的**完整 CSS 字符串**（触发器/菜单/分组标题/行的每一个数值）、
`createPortal` + 「先量后定位」的算法、以及 composer 的席位名。

四条经验：
1. **席位契约先读 `.d.ts`**：`dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts`
   把每个 composer 席位「住着什么、谁在隔壁、作用域是 root 还是 session」写得明明白白
   （`input.right` 与 `input.model` 的左右关系，最终以**产物里的渲染顺序**为准 ——
   文档那句「模型位在它左边」与代码相反）。
2. **CSS 数值直接抄**：`--dsw-specific-menu` / `--dsw-elevation-prominent` /
   `--dsw-alias-label-caption` 这些 token 名与尺寸（13px/500、20px 圆角、38px 行高）
   都在产物里，照抄就是「同一个质感」。
3. **图标也别自绘**：本体 primitives 里有 `IconCheckOutline16` / `IconChevronDownOutline14`
   （官方菜单用的就是它们）。往 `ambient.d.ts` 里补两行声明即可用；离线替身是 Proxy，
   任何成员都拿得到，测试不会因此红。
4. **弹层挂 body**：官方所有菜单都 `createPortal(..., document.body)` + 手动测量定位。
   composer 在 AppFrame 里，祖先的 `overflow` / `transform` 会把就地渲染的 `fixed` 弹层
   裁掉或挪位 —— 这一条照抄比自己试错便宜。

### 3.32 P28：档位有**两条轴**，只有一条能自动发现

用户要「给有档位选择的模型加档位选择，像官方那样」。先把「档位」拆成两条轴，
否则会把一件根本不用动数据的事（分辨率）和一件必须动数据的事（质量）搅在一起：

1. **分辨率档位（`…-1k / …-2k / …-4k`）= 网关上的兄弟模型 id**。它不是参数，是
   **另一个模型** —— 因此**不需要任何新机制**：选中兄弟 id 就是选中档位，请求体里的
   `model` 自然是对的，`defaultImage` 一个字段就够。**能自动发现**，检测方式就是名字：
   `splitTier()` 去掉尾部档位词（闭集 `TIER_WORDS`）得到词干，同一词干 ≥2 个成员 =
   一个家族。用户加一个 `-4k`，界面上自动多出档位 —— 这正是用户要的「配置完自行添加」。
2. **质量档位（低/高）= 请求参数**（`quality: low|high`）。`GET {base}/models`
   **只回 id**，没有任何「这个模型收哪些 quality」的字段。实测 `ai.t8star.org`
   （new-api 系中转）：无密钥一口 401 `{"type":"new_api_error"}`，形状是标准的
   OpenAI `/models`。**因此质量轴没有任何可探信号** —— 只能由用户在设置里声明
   （`models[].tiers = { param, values, labels }`）。假装能自动探测就是撒谎。

两条轴共用一个概念：**家族** = `供应商::词干`（派生、不落盘）。质量档的当前值按
**家族**存（`defaultTiers`），所以从 2K 换到 4K 时质量档不会丢；声明写在家族里
**任何一个成员**上都对全家生效（用户不必给每个分辨率档配一遍）。

另外两条实测事实（都会**静默**改变行为，因此写在这里）：

- **schemastery 会给缺省的嵌套对象填出空壳**：`tiers` 用 `Schema.object({...})` 声明后，
  输入里没有它的模型，解析结果里也会出现 `{ param:'', values:[], labels:{} }`（实测）。
  读取方必须按「解析不动 = 没有这条轴」处理（`parseTierAxis` 就是这么写的），
  设置页的写出口（`cleanModel`）必须把空壳丢掉 —— 否则每存一次模型就多一坨空对象。
- **`--dsw-alias-bg-layer-1` 在浅色主题下与 `layer-3` 是同一个白**（实测 token 值：
  light 两者都是 `neutral-bluish-00`；dark 是 `875` / `800`）。菜单底色是 layer-3，
  所以**别拿 layer-1 给「选中态」做填充**：浅色主题下选中的那个 chip 完全看不见。

### 3.33 P29：模型类型预置（常用模型）—— 参数只能由人写下来

用户要「常用模型界面：同一类型的模型提前备好可选的质量参数与其他参数」。动手前先把
**参考项目 T8-PenguinCanvas 里「模型可配参数」的真实形状**挖出来（它只有安装产物，
没有源码；见下面的读法），因为「同一类型」这四个字的落点全在那里。

**怎么读一个 Electron 安装产物里的前端代码**（可复用）：

- 应用代码不在 `app.asar`（那是 278MB 的 `node_modules`，用 16 字节头 + JSON 目录能列出来：
  偏移 12 是 JSON 长度，从 16 开始就是文件树）；后端在 `resources/backend-enc/*.t8c`（加密）。
- **前端是明文 Vite 产物**：`resources/frontend/assets/*.js`。中文文案一部分是字面量、
  一部分走 i18n key，因此直接 grep 中文常常找不到 —— 找**模型目录**要按结构化字段找
  （`paramKind` / `apiModelOptions` / `sizes` / `aspectRatios`），不要按界面文案找。
- 一次性脚手架（`lib/` 是 gitignore 的）：`lib/_refscan.mjs`（在产物里按子串找上下文）、
  `lib/_asar.mjs`（列 asar 文件树）、`lib/_slice.mjs`（导出字节区间，便于按行读）。
  **导出的文本切片不留在库里**（几十 KB 的第三方 dump）：要用就现跑一条命令重新生成。

**T8 的模型目录形状**（`Canvas-*.js` 里的 `Gd`，导出给图像节点当模型 TAB 用）：

```js
{ id:'gpt-image-2', apiModel:'gpt-image-2', label:'GPT Image 2', tabLabel:'GPT2',
  paramKind:'gpt-size',                       // → 渲染哪一套参数面板
  apiModelOptions:[ {value:'gpt-image-2-2K'}, {value:'gpt-image-2-4K'}, … ],  // ← 2K/4K 在这里
  aspectRatios:[…], defaultAspectRatio, sizes:['1K','2K','4K'], defaultSize,
  maxReferenceImages, capabilities:[…] }
```

两条可搬运的事实：

1. **`-2K` / `-4K` 是同一个模型条目下的 `apiModelOptions`**，不是另一条模型 ——
   这正是用户那句「同一类型的模型配置要覆盖之后出现的 2K / 4K 尾缀」的原始出处。
   我们的等价物是 P28 的**词干**（`splitTier`）：`gpt-image-2-2k` 与 `gpt-image-2-4k`
   与 `gpt-image-2` 落在同一家族，因此**按词干匹配的预置天然覆盖将来的尾缀**。
2. 它的质量取值是**按模型类型写死的数组**（如 `['auto','low','medium','high','xhigh','max']`，
   2.5 与 2 的取值个数不同）。这就是「提前适配」的全部含义：**有人把参数写下来了**。
   `GET /models` 只回 id（§3.32 已核实），没有第二种来源。

**DSH 工具参数里的「自由形态对象」怎么写**（`media_generate.params` 用的）：

- 校验子集只认 `type / oneOf / properties / required / additionalProperties / items / enum / const`，
  且 **`additionalProperties` 必须是布尔**（不能是 schema）—— 写 `{ additionalProperties: {…} }`
  会被 `assertSupportedJsonSchema` 直接拒掉。
- 「键由用户运行时声明、静态 schema 写不出来」的写法是 `{ type:'object', additionalProperties:true }`
  （`dsh-tool-workflow` 的 `meta` 就是这么写的，第一方同款）。不写 `additionalProperties`
  时默认也允许额外键，但显式写出来更清楚，也不容易被后来人误改成 `false`。

**设置里两张按家族存的表**（`defaultTiers` / `commonModels`）：键都是 `供应商::词干`，
里面带 `::` 也能正常作为路径段写（P28 的 `setTier` 已实证，P29 的
`setCommonField` 直接沿用）。`Schema.dict(对象)` **不会**给不存在的键填空壳
（与 §8.50 的「可选嵌套对象」不同）—— 只有用户真的写过那个家族才有条目。

### 3.34 P30：工具调用的并发由 `isConcurrencySafe` 决定（读了 dsh-tools 的源码）

「模型一条消息里发多个工具调用」与「它们真的并行」是两件事：

- `ToolRegistry.executionMode(exec)`（`dsh-tools/lib/index.js`）：**没有**
  `isConcurrencySafe` → `exclusive`；有则调它，**只有严格 `=== true`** 才算
  `parallel`（抛异常按独占兜底）。
- 调度器（同一个文件里那个单车道 `drive()`）：`exclusive` 的调用必须
  **`inFlight.size === 0`** 才能起步，且起步后 `exclusiveActive = true`，
  直到它**提交**（不是结算）才放开 —— 因此独占工具的「批量」= 串行，
  顺带也把别的工具挡在外面。
- `parallel` 的并发上限是 `maxParallel`（= 配置里的 `maxParallelSubCalls`，
  默认 **10**）。它是**全局**的，不能按工具配 —— 想给某个工具单独设上限，
  只能自己在工具内部排队（P30 的 `host/gate.ts` 就是干这个的）。
- **`tools.register(def)` 把定义对象原样插进层里**（`layer.tools.insert(name, definition)`），
  不做字段白名单归一化 —— 所以对象字面量上多写一个 `isConcurrencySafe` 就够了，
  不必为了它去引 `dsh-tools` 的 `defineTool`。
- 工具**没有默认超时**：不写 `timeoutMs` 就不会被截断，因此「在闸门里排队」
  不会把排在后面的调用排死。

### 3.35 P32：席位的 priority 顶替、宿主 HTTP 路由、以及图片到底存在哪

三件这一轮才核实的事（细节与踩法见 §8.55 / §8.56）：

1. **客户端席位可以顶替本体条目**：注册表按 `priority` **升序**排，keyed / single
   席位取同 key（同 id）的**第一个** → 更小的值盖住别人；同优先级撞车会抛
   `already has an entry for key …`。这是**平台承认**的做法（报错文案自己就写着
   `register at a different priority to shadow it (lowest renders)`）。
   席位 owner 面里带着本体的 `renderMessageImages` / `loadImage`，因此顶替
   「用户消息」时图片仍可用本体渲染器，只有外壳要自己写。
2. **宿主能注册同源 HTTP 路由**：`ctx.webServer.register({ kind:'exact'|'prefix', path, handler })`
   （`dsh-host-webserver`；同名路由重复注册会抛）。**必须**用
   `ctx.connection.requestRejection(req)` 过一遍 Host/Origin 栅栏 + 会话 cookie
   ——`dsh-host-open-in-app` 的 `/apps`、图标 prefix 路由就是照抄样板。
   响应对象只用到 `statusCode` / `setHeader` / `end`（本包不引 @types/node，
   照用到的面自己声明）。
3. **图片的两个去处**（用户问「存在哪」时的标准答案）：
   - 用户附的图 → `DSH_HOME/attachments/v1/`（内容寻址、永不过期；`DSH_HOME`
     默认 `~/.dsh`，改它 = 搬整个家目录）；
   - 生成结果 → **以前不落盘**，只有供应商那个会过期的签名 URL；P32 起配
     `archiveDir` 会留一份本地副本，地址换成 `/ffc-media/…`（同源路由）。

### 3.36 P32：剪贴板写图片这条路是**堵死的** —— DSH 那条改走「送到输入框」

这一条是**无头 Chrome 探针实测**出来的（`.tmp-clipboard-probe.mjs` 的做法：
127.0.0.1 起个 http 页 + `Browser.grantPermissions` + `Page.bringToFront`，
把几种写法逐个试、把真实异常打出来），别再靠猜：

| 写法 | 结果 |
|---|---|
| 一个 item、`text/html` + `text/plain` | **OK**（微信那条路就是这么工作的） |
| 一个 item、`image/png` | **OK** |
| **两个 item**（文字 + 图片，任意顺序） | `NotAllowedError: Support for multiple ClipboardItems is not implemented.` |
| `ClipboardItem.supports('image/jpeg')` | **false**（写 jpeg 必抛；要写图就得先转 PNG） |

再加上系统剪贴板**只能放一张图**（Windows 的 CF_DIB 就一格），于是：

- **DSH 自己的输入框**（`dsh-client-ui-conversation` 的 `PASTE_COMMAND`）只读
  `clipboardData.items` 里 `kind === 'file'` 的那些，**HTML 里的 `<img>` 它完全不看**
  —— 想让「图 + 字」粘进 DSH，就得往剪贴板放图片文件 item，而上面两条把它堵死了
  （多张图更不可能）。
- 所以 DSH 那条**不走剪贴板**：`sendMessageToComposer` 直接把文字插进输入框、
  把每张图经 `attachImageToComposer`（合成 drop，复用平台附件管线）变成**真附件**。
  顺带更好：**张数不限、动图不会被拍成静帧**。
- 富文本复制那条（微信 / 飞书 / 文档）保持不变，它本来就是对的。
- **设置页可以并存多个 `settings.section`**：同一席位注册多条（`id` 不同、`order`
  决定导航次序）是正常用法；「图像 / 视频模型」（40）与「肥鱼画布」（45）就是这么并排的。
  ⚠️ 断言里别再用「最后一个 section」定位某一页（P32 就这么红过一次）。

### 3.37 P33：MiniMax H3（海螺）那一族 —— 参数、以及它**不是** OpenAI 那套平铺体

用户配的视频模型是 `minimax-h3-ow-r2v`（供应商 `custom`，网关 `https://ai.t8star.org/v1`）。
`GET /models` **只回 id**、没有任何能力字段，所以「这个模型收哪些参数」只能由人写下来。
来源有两个，**第二个才是权威**（第一个是参考项目 T8-penguin-canvas 的模型注册表
`src/providers/models.ts`，抓法见 §8.54）：

| 参数 | 类型 | 取值 | 说明 |
|---|---|---|---|
| `prompt` | string | — | **必填** |
| `images` | array | ≤9 个 URL | 参考图（**数组**，一张也是数组） |
| `seconds` | string | `5` / `10` / `15` | **必填**；固定零售档位 |
| `metadata.resolution` | string | `480P` / `768P` / `1080P` | **必填**；**大写** |
| `metadata.ratio` | string | 1:1 2:3 3:2 3:4 4:3 9:16 16:9 21:9 | 默认 `16:9` |
| `metadata.audio_urls` / `metadata.video_url` | array | ≤3 个 URL | 音频 / 视频参考 |

调用示例（`POST {base}/video/generations`，**单数**路径 —— 正是 `submitVideo` 的兜底那条）：

```json
{ "model": "minimax-h3-ow-r2v", "prompt": "…", "images": ["https://…/a.jpg"],
  "seconds": "5", "metadata": { "resolution": "480P", "ratio": "16:9" } }
```

⚠️ **它和本插件缺省那套（OpenAI 兼容平铺体）每个字段名都不一样**：
`duration`→`seconds`（还要是**字符串**）、`resolution`→`metadata.resolution`（还要**大写**）、
`aspect_ratio`→`metadata.ratio`、`image`→`images`（**数组**）。少对上一个，网关要么 400、
要么静默按默认档出片 —— 这就是「常用参数栏填了不生效」的另一种长相（§8.52 末尾）。

所以 P33 不是往预置表里加两个键，而是给视频请求体加了**第二种形状**：
`modelPresets.ts` 的 `wire: 'seedance-nz'` → `host/schema.ts` 的 `ResolvedModel.wire`
→ `host/providers.ts` 的 `videoBody` 分支。设置页里那三个键仍是**平铺**的
（`seconds` / `resolution` / `ratio`，好读好写），由 `videoBody` 摊成 `metadata.*`；
`wirePathOf` 是这份映射的**同一份说法**（设置页 tooltip 用它，免得两处各说各话）。

- **优先级**：设置里的默认值 > 工具参数 > 协议默认（与缺省那套同一套规矩：工具参数算
  「内置字段」，排在 `...model.params` 之前）。要临时改，走 `params`（声明过的键）。
- **参考图字段**：这个 wire 默认发 `images`（数组）；供应商显式配了 `referenceField`
  就用它的 —— 复用既有旋钮，不为这一族新加开关。
- ⚠️ **两份来源对不上时以文档为准**：T8 的注册表把这一族写成 480p / 720p，
  官方文档是 **480P / 768P / 1080P**（用户给的截图）。预置取后者。
- **比例那一轴**：工具参数的闭集仍是五个（1:1 / 16:9 / 4:3 / 3:4 / 9:16）——
  2:3 / 3:2 / 21:9 只能定成设置默认，或让模型走 `params`。要全放开得改
  `host/tool.ts` 的 `aspectRatio` 闭集（本轮没做）。
- **没做**：`metadata.audio_urls` / `metadata.video_url`（音频 / 视频参考）——
  本插件只有「图片参考」那条路，要加得先加素材通路。
- **另一条线**：`MiniMax-H3`（V2 多模态）不是这一族：4–60 秒、480P/768P、
  含 `adaptive` / `auto` / `api_default` 比例与音频模式（`lock_source` / `remix_source` /
  `reference_only` / `native`），最多 11 图 / 3 视频 / 4 音频。用户没配它，**没有预置**。

---

### 3.38 无头浏览器 / e2e 的两条硬门槛（跑不动 e2e 时先看这里）
- **命名管道**：受限模式（`workspace-write` / `read-only`）下程序**不能打开命名管道**，
  无头 Chrome 因此起不来，报 `mojo/platform_channel.cc: Check failed: 拒绝访问 (0x05)`。
  所有 `e2e` / `probe-gui` / `preview:icon` 都要在**完全权限**下跑。
  同族的受限模式限制（别绕，直接换模式）：PowerShell 退化成 ConstrainedLanguage
  （`.NET` 静态调用 / `Add-Type` / 反射全失败）；Node 用 `stdio:'pipe'` 收子进程输出会 `EPERM`；
  写盘另有一条**完整性标签**的门槛，见 **§8.58**。
- **3080 要签名 cookie**：`dsh web` 的页面带签名 cookie 才认，无头浏览器直接开
  `http://127.0.0.1:3080` 一律 **401、页面全空**（不是页面坏了）。令牌**只在
  `dsh web` 启动那一行**打印 → e2e 必须带令牌的 `DSH_WEB_URL`。
  - `lib/web-url.txt` 里那份**会过期**（实测 9/24 的令牌 9/25 就 401）；
    `fafb415` 版 `post-restart.mjs` 用 `spawn(..., {stdio:'ignore'})` 起宿主，
    **令牌不落盘**。
  - 拿到新令牌的唯一办法：**手动在终端起一次 `dsh web`**，从那一行抄。
    （P26 修过这件事，修复在分支 `节点功能` 上，主线 `fafb415` 里没有。）
  - ⚠️ **但「令牌过期」≠「必须重启宿主」**：认证其实是**签名 cookie**
    （`dsh-client-connection` 的 `BrowserAuth`：URL 里的令牌只做一次交换，之后靠 cookie，
    签名密钥存在凭据里、**重启宿主也不换**，默认寿命 `cookieMaxAgeDays: 30` 天）。
    而 `lib/probe-profile` 里那颗 cookie **通常还在** —— 2026-10-05 实测：三份令牌全 401，
    无头浏览器用这个 profile 直接开 `http://127.0.0.1:3080/`（**不带令牌**）照样登录成功。
    **判据**：`lib/probe-profile\Default\Network\Cookies` 里有没有 `dsh-auth-*`。
    所以顺序是：先不带 `DSH_WEB_URL` 跑一条 e2e（脚本默认就是 `http://127.0.0.1:3080/`），
    401 了再去手动起宿主抄令牌。**别一上来就重启宿主**（那会把用户正在用的会话掐断）。

---

## 4. 关键实现决策（理由）
| 决策 | 理由 |
|---|---|
| **自绘轻量画布**，不用 Excalidraw/tldraw/React Flow | 它们自带外壳与主题会和 DSH 打架；自绘可完全用 DSH token 上色 |
| 键位：**拖拽=平移、滚轮=缩放、Shift+拖拽=框选** | jaaz/Excalidraw 默认相反，用户实测「无法正常使用」 |
| 画布键盘挂在**画布元素自身**（tabIndex=0） | 右侧就是聊天输入框；监听 window 会让用户在聊天里按 Delete 误删节点 |
| 缩放锚点用**视口元素自身 rect** | 面板顶部有 44px 工具条，混用会让锚点纵向偏移一个工具条高 |
| 视频节点不用原生 `controls`（聊天工具行用） | 画布上整块节点要能拖拽，与原生控件抢指针；聊天里没这个约束 |
| 保留 `pending` 节点 | jaaz 没有；等待体验更好（有意改进） |
| 自写 TS 打包器；宿主半边**不打包**、按模块图镜像 `lib/` | esbuild 原生二进制在本机被 pnpm 目录重命名反复卡死（EPERM）；Node ESM 原生多文件，打包只会让调试变难 |
| 共享代码放 `src/client/shared/` | 客户端打包器只把 `src/client` 当解析根；宿主用 `../client/shared/*` 反向引用 |
| P3 用**订阅会话快照**而不是注册 `conversationEvents` Definition | 宿主已把结果写进 `presentationMeta`，快照本来就折叠好了这条事件；再注册 Definition 等于把同一份数据再折叠一遍 |
| 画布节点 id = `gen_<callId>` / `gencmd_<commandId>`（**幂等键**） | 重复快照不造重复节点；用户删掉的节点不被历史重放复活；两个 id 空间分开前缀避免撞车 |
| 幂等记账 `ingested` **随画布持久化**（board v2） | 不持久化的话，刷新页面会把用户删掉的节点造回来 |
| 只吃「seq 越过基线」或「10 分钟内」的结果 | 打开老会话不该把历史生成铺满画布；但刚打开页面时正好完成的那次要补上 |
| 结果只**改状态与 src**，不重新落位 | 占位节点与出图后的节点必须重合，否则出图瞬间跳一下 |
| 画幅比例由宿主 `presentationMeta` 回传 | 客户端要在结果到达**之前**定好节点形状 |
| 聊天侧登记 `tool.call.toolview`（key = 工具名） | 否则结果渲染成 JSON 卡片；key 写歪会静默回落，故有守卫断言 |
| 跟焦用「开关 + 忙碌 + 安静期」三闸，超时放弃 | 自动移动视口有代价：正在拖拽/刚操作过时抢画面很恼火；1.5s 还不安静就宁可不动 |
| 视口动作集中在 `canvas/actions.ts` | 工具条/菜单/快捷键/画布内部必须走同一份 fit/zoom/focus，否则锚点与留白漂移成两套 |
| 新增节点用**事件**通知而不是读状态 | 「刚刚落了什么」不能从「现在有什么」推出（挂载时读一次会把历史当新增） |
| 纯画布只隐藏「除 overlay 以外的列」+ 刷新自救 + Esc 逃生梯 | 见 3.13；这是唯一「界面自己收起自己入口」的模式，必须两层兜底 |
| 快捷键 `Ctrl/⌘ + Shift + B` | B = Board，浏览器无默认绑定（`Ctrl+Shift+C` 撞 DevTools）；输入框里让路 |
| 右键菜单作用于**当前选择**（右键先把选择收敛到该节点） | 心智模型只有一条；多选时删除/带到视野作用于整组，复制/重新生成只在单选可用 |
| 复制/发送类动作**不关菜单**；危险项常驻淡红底 | 用户常接着复制另一项；危险项一眼可辨且托起深色下的对比度（3.16） |
| 菜单键盘用 `aria-activedescendant` 而非每项 tabIndex | Tab 应当是「离开菜单」 |
| 「重新生成」**优先 `/generate` 命令**，未匹配才退回提示词 | 命令零 token、更快，结果还会以命令节点回客户端并落图 |
| 命令与工具**共用一条生成管线**（`host/generate.ts`） | 否则「没有密钥」这类错误在两处各长一句话 |
| 命令成功文本第一行固定是媒体地址 | 命令结果只有文本；把「机器读的那一行」放第一行最小、最可测、不引入新协议面 |
| 画布作用域**默认按工作区**（一个工作区一块），「全部共用一块」是显式开关 | 2026-10-14 用户要求：「一个工作区共用一个画布」。进哪个项目的对话就看哪个项目的画布，才是他打开画布时期待的东西；默认关着的开关等于没改 |
| 工作区 = 会话行上的 `cwd`，画布键就是工作区路径 | 这是平台上「这个会话属于哪个项目」的权威字段（会话列表 RPC 带出来），不必再引 `ctx.workspaces` 服务（那会让 e2e 探针 profile 多一个可能缺席的依赖） |
| 换作用域**先落旧键再读新键**，不搬运 | 见 3.19.2：既不许丢东西，也不许把别的工作区的节点抄过来 |
| 「共用 → 工作区」时**按节点的 `sessionId` 拆**，不整块抄 | 共用那块是所有项目混在一起的一堆；拆开才是「一个工作区一块」的本意。拆不动（认不出会话）的留在原地当备份 |
| 拆分**幂等**（按 id 去重）+ 共用那块只读 | 于是它可以在每次「共用 → 工作区」时都跑一遍，不必记「迁移过没有」的标志位 —— 标志位是又一处会与真实状态不一致的状态 |
| 作用域策略单独成 `canvas/scope.ts` | 偏好、当前会话的工作区、换键/拆分分居三地，任何一方自己改另两方都会让「谁决定画布键」变成口头约定 |
| 工具条常驻一块**作用域读数**，它**自己就是开关** | 画布会随所在工作区变化，不写明白就是灵异事件；读数与开关是同一件事的两面，因此既省宽度也不丢功能（3.22）。读数上还带 `data-ffc-scope-path`（工作区路径），e2e 与排查都靠它 |
| 入口（米饭碗）P8 搬进 composer 工具行、**P10 搬回右上角** —— 两次都靠「用实数席位」 | 见 3.20：浮层压别人是做法本身的问题，挪像素治不了。P10 用的是 session log 自己那个席位（`conversation.session.header.utilities`），同席位 = 同一 flex 行 = 结构上不可能重叠 |
| 一枚米饭碗 = 聊天 ⟷ 画布的**双向开关**，画布里位置与图标都不变 | 用户认的是那个位置；「进去一个入口、出来另一个入口」才是要猜的东西（P10） |
| 纯画布**独立成顶栏一格**，不再挂在菜单里 | 纯画布收起整列聊天，右上角入口跟着消失 —— 它必须是常驻、可点、状态可读的**唯一出口**（3.22） |
| 「视图」菜单整块删除（模式选择与宽度预设随之消失） | 用户明确要求去掉；剩下的两样（跟焦、作用域）本来在工具条上就有家，删除比留一个只剩两项的菜单更省（3.22） |
| 供应商/模型是**用户数据**，目录降级为「一键添加」的预设 | 「一个供应商挂多个模型」要求结构开放；预设只负责预填 |
| 密钥只以**引用名**进设置，值进凭据库 | 见 3.21：脱敏面与真实面一致后，嵌套写入不再有抹掉机密的可能 |
| 写嵌套叶子用 `settings.mutate` 深路径 op；`models` 数组整体重写 | `scope.set` 只能写顶层标量；数组下标不可寻址（3.21） |
| 设置页文本字段**草稿 + 失焦提交**（不是逐键写盘） | 逐键写 = 每个字符一次磁盘写入，还会不断撞 revision |
| 写入带 revision，冲突时**退回不带栅栏重试一次** | 镜像的 revision 有更新延迟，快速连点会撞上自己上一次的写入 |
| 探测走**宿主**（Typert 远程命名空间），不下发密钥 | 见 3.23；顺带把「测试连接」与「获取模型列表」合成一次请求（能列出模型就证明连通与鉴权都对） |
| 迁移旧扁平字段而不是留着不管 | 不在 schema 里的字段不会被脱敏 → 旧明文密钥会被下发到浏览器 |
| 「重启 + 验证」交给独立进程（`post-restart.mjs`） | `dsh web` 就是承载对话的进程：会话里直接 kill 会当场结束自己这一轮，用户什么解释都看不到（§6） |
| 参考图**不经过模型**，只递地址、宿主取字节（P12） | 文本模型对图片附件只收到一行没有路径的占位符（§3.24.1），让它描述或转手参考图必然瞎编；地址是唯一它能可靠搬运的东西 |
| `/generate` 声明 `input.attachments: true`，贴的图自动当参考图 | 这是「用户贴图 + 生成」的**零模型**通路：附件直接到宿主（§3.24.2）。附件标志在 `input` 里，写歪会被执行器整次拒掉 |
| `--ref` 优先于顺手附上的图 | 用户**写下来的地址**比「刚贴的那张」更明确；两个都给了要有确定行为，不能靠顺序 |
| 画布右键「以此为参考图生成」只递 `http(s)` / 小 `data:`，其余禁用并写明原因 | 宿主取不到 `blob:` 这类进程内地址，兆级 `data:` 会撑爆命令行与会话日志（§3.24 天花板）；禁用比「点了没反应」或「发一次必然失败的生成」都便宜 |
| 参考图的端点与字段名做成供应商级两个字段（默认 `field` + `image`） | 字段名写歪时网关**不报错、直接出纯文生图** —— 最坏的失败模式必须有解，但只有两家网关真的不一致时才值得加设置页控件 |
| 结果只回一个 `usedReference` 布尔 | 参考图地址可能是兆级 `data:`，进会话事件就是灾难；用户需要的只是「这次到底带没带」 |
| 「自动套用用户附的图」**只在路由看不见图时**发生（`routeSeesImages`） | 多模态模型自己看得见图，参不参考它说了算；纯文本模型手上只有一行没有路径的摘要，宿主不代劳就永远用不上参考图。判据查不到时按「不知道」办 = 照套用，因为丢掉参考图比多发一张更糟 |
| `reference: "attached"` 这个哨兵字符串 | 文本模型唯一**抄得动**的句柄；让它写路径=让它编地址 |
| 档位拆成**分辨率轴**（兄弟 id）与**质量轴**（声明式参数）两条 | 见 3.32：分辨率档位本来就是另一个模型 id，把两条轴混成一个「档位」概念会逼所有模型都走声明制，纯属多写一套配置 |
| 家族（`供应商::词干`）**派生、不落盘** | 用户加一个 `-4k` 兄弟就自动成组，没有分组表要维护；名字命中不了闭集就不分组，观感退化成升级前——**误判代价≈0**，因为分组只是显示层 |
| 质量轴**只能声明**，不做「自动探测」 | `/models` 没有能力字段，没有信号可探；唯一诚实的做法是让用户写一次参数名与取值。草稿解析与读取共用同一个 `parseTierAxis`，写坏当场报错而不是静默失效 |
| 声明的参数展开进请求体时放在内置字段**之后** | 有意允许覆盖 `size` / `resolution`（有的网关用 size 分档）；`model`/`prompt`/`n`/`image` 进 `RESERVED_PARAM_KEYS` 被拒（一份清单，见 §8.52），写不坏请求 |
| 网关协议不同的那一族，给请求体加**第二种形状**（`wire: 'seedance-nz'` + `videoBody` 分支），而不是把字段名硬塞进预置 | 这一族每个字段名都不同（`seconds` / `metadata.resolution` / `images[]`），只加预置键会得到「设置页填了、请求体里没有」；形状在预置里写一次，设置页那三个键仍是平铺的（§3.37） |
| picker 用**家族行展开**，不把每个档位平铺 | 弹层本来就窄（`max-height: min(360px, 100vh-96px)`）；平铺会把别的模型挤下去，而展开式让「没有档位的模型」保持原样 |
| 「当前档位」按家族存 `defaultTiers`，与 `defaultImage` 分开 | 两条轴各存各的，换分辨率不会把质量档弄丢（反过来也一样）；渲染层再合成 `ResolvedModel.params` |
| 只认**本回合**顶层 `image` 块（`host/session-images.ts`） | 上一轮的图静默套用会产生「和参考图无关的结果」；`tool-result` 里嵌套的图是别的工具产出的，不是用户附的 |
| 视觉模型是**同一个供应商字典里的第三种 `kind`**，默认项与图像 / 视频并排 | 它只需要 `{base}/chat/completions` + 同一把密钥；另起一套配置 = 让用户为同一家中转站配第二把钥匙、进第二个页面（§3.26） |
| 描述**只在「模型看不见图」时**注入提示词 | 看得见图的模型自己看，别人转述只是污染提示词；`describeReference` 由工具那侧打开，命令 `/generate` 不带它（那条路上没有模型的「眼睛」问题） |
| 视觉调用失败**只记日志、继续生成**（提示词退回原文） | 参考图本身已经发给供应商，描述是加分项；「配了个可选项反而什么都做不了」比没有这个功能更糟。但也绝不把失败说明塞进提示词、不谎报描述 |
| 描述同时**回给模型自己**（工具结果 + `referenceDescription`） | 文本模型的收益不止于这一次生成：它知道了图里有什么，才能接着讨论、改提示词、回答用户关于图的问题 |
| 生成模型的**选择放主界面（composer 工具行、本体模型位旁边）**，而不是另造一份「当前模型」状态 | 宿主生成时读的是设置里的 `defaultImage` / `defaultVideo`，所以选择只能是「写设置」这一条路；这样一来两个入口天然一致，没有第二份真相（3.30①） |
| 外观与字体**照第一方客户端的产物逐值抄**（而不是照截图估） | 见 §3.31：官方 `lib/client.js` 里有完整 CSS 字符串与组件逻辑，照抄一次到位；照截图调数值是猜 |
| 弹层 `createPortal` 到 `document.body` + 先量尺寸再定位 | composer 在 AppFrame 里，祖先的 `overflow` / `transform` 会裁掉或挪位就地渲染的 `fixed` 弹层（官方 ModelSelect 同款做法，§3.31.4） |
| 模型清单/写入面从 `apply` 期**捕获进模块级持有变量**，组件只读取值函数 | 画布面板住在 `shell.overlay`，拿不到 `settings.section` 的 inject 面；而派生服务在渲染期现解析会直接抛（3.23.8）。这是本插件第四次用同一个模式 |
| 菜单做成**平铺清单 + 供应商分组标题**，不做截图里的二级子菜单 | 数据是「供应商 × 模型」的平铺结构，二级只是把同一份数据点两次（3.30①） |
| 拖进来的多张图**一次性算网格再落位**（`dropLayout`） | 一张一张落 = 全叠在指针那一点；先全部读进内存才能算「这一批」的排布，顺带一次选中（3.30②） |
| 吸附的位移按**绝对基准**算（按下点 + 原始坐标 → 每帧写绝对位置） | 增量累加会把吸附的修正留到下一次移动里（节点黏住甩不开），这是吸附与「增量平移」唯一不兼容的地方（3.30③） |
| 辅助线画在**屏幕层** | 1px 虚线在世界层会跟着 `scale(zoom)` 变成粗带（3.30③） |
| 吸附容差用**屏幕像素 ÷ zoom**，Alt 关闭 | 手感不随缩放变化；精确摆放时总得有个不改数据的出口（3.30③） |
| 模型参数**按「类型预置」备好**，不要求用户从零手写（P29） | 「同一类型的模型提前适配」= 有人把参数写下来。预置表按**词干**匹配，因此 `gpt-image-2` 与将来出现的 `-2k`/`-4k`/`-8k` 兄弟自动共用同一份（参考项目的等价物是 `apiModelOptions`，见 3.33） |
| 预置的质量轴**默认不传值**（`fallback: ''`），手写声明仍取第一个取值 | 预置负责把那一排 chip 摆出来，「发不发这个参数」由用户点那一下决定 —— 猜错一个键的代价是整次生成 400，而 P28 手写声明的语义（用户明说过）不该被预置改掉 |
| `spec.values`（闭集）**只做设置页的下拉，不做校验** | 网关真实支持的取值集合我们并不知道（预置是起点不是承诺）；拿它当校验器会把「用户网关其实支持」的值挡在门外，而那个失败比供应商回一句 `invalid size` 更难查 |
| 模型调用传了没声明的键 → **忽略 + 回执里点名**，不抛错 | 一个没声明过的键不该让整次生成失败；但也不能静默丢掉（否则用户拿到一张不符合要求的图还以为是成功）。回执让模型自己说得清「这个模型不吃这个参数」 |
| **质量档不走工具参数那条路**（模型传 `quality` 会被忽略，并回一句「在聊天栏那格里选」） | 用户明确要求质量参数在聊天栏的图像界面选；两处都能写只会得到「我明明选了高，怎么还是低」。回执里带原因，模型才有话可回用户 |
| 其他参数**只写非空值**（空 = 只声明这个键、默认不传） | 声明与取值是两件事：用户想允许模型临时传某个键，不该因此让每次生成都带上一个我们自己猜的默认值 |
| 常用模型界面**按家族一行**（不是按模型一行） | 用户要的「同一类型共用配置」：一个网关上一个模型常有 `-1k/-2k/-4k` 三个 id，按模型列会逼用户配三遍，而新尾缀出现时又会漏配一次 |
| 家族行**只负责展开**，成员行才是「选用」；点质量档 = **同时选用这个模型** | 用户报的「展开挡住了选择使用此模型的按键」：只有一个成员的家族展开后没有成员行，点档位就成了唯一动作 —— 它必须真的用上这个模型（`setTier(kind, family, value, ref)` 两个 op 一次写）。见 §8.51 |
| 「一次出多张」= 模型在**同一条消息里并发调用多次**，不是请求体里的 `n` | 适配器只读 `data[0]`（`n>1` 是**静默丢图**：钱花了、图没了）。并发调用还天然给出「每张一个节点、一张失败不影响别张」。因此 `n` 进了保留键清单，工具描述也明说「一次调用只出一张」 |
| 并发**有上限**（`host/gate.ts`，默认 3），但工具声明 `isConcurrencySafe` | 独占（原状）会把批量变串行；完全不限又会把供应商打成 429。上限放在工具自己的闸门里 —— 调度器那个 `maxParallel` 是全局的，按工具配不了（§3.34） |
| 保留键清单**只留一份**（`catalog.RESERVED_PARAM_KEYS`） | 曾经两处各写一份（`modelPresets` 那份漏了 `n`）：设置页不让声明、宿主却照收 —— 两半边的判断必须同源，否则「用户填了、我们发了、结果丢了」 |
| 取图**只有一个入口**（`client/index.tsx` 的 `fetchImageViaHost`），信封在那里拆一次 | 两个调用点（导出、送聊天框）各自读 remote 结果的字段 = 各自漏拆一次（§8.53）。平台契约是「每个远程方法都返回 `RemoteResult`」，这种判断不该有第二个副本 |
| 多张参考图：**同一个字段名**，值是数组（JSON）/ 重复多份文件（multipart） | 参考 T8-penguin-canvas 的两条通路（§3.24 的表）。不发明 `image[]` 这类新键名：网关之间连字段名都不统一，`referenceField` 已经能改键名，形状再分叉只会让「哪个网关要哪种」变成口头约定 |
| 参考图**永远是一个有序列表**（内部 `references: string[]`，单张就是长度 1） | 「一张」与「多张」走两条代码路径 = 两处都要记得改（P30 的 `n` 与 §8.53 的信封都是这个形状的坑）。入口处（工具 / 命令 / 附件 / 画布）收成数组，后面全是一条路 |
| 参考图上限 8 张，**在本地挡住** | 网关的张数上限不统一（多图编辑类常见 4–16），超了那句 400 看不出是「张数太多」。本地报错能说清是哪一侧超了，还省一次白跑 |
| 「复制（含图）」写**富文本 HTML（图内联成 `data:`）+ 纯文本**，不写图片文件 item | 网页能表达「图 + 字一起」的唯一载体是 HTML；写成 `image/png` item 的话多数软件一次只取一个（图与字二选一）。已知天花板：Word 桌面版不吃 `data:` 图（§8.55 那条的代价清单里） |
| 复制**两个图标按钮**（复制 / 送到输入框），而不是都走剪贴板 | 用户实测：只写富文本时微信正常、DSH 输入框里只有文字。而 Chrome **不支持一次写多个 ClipboardItem**、系统剪贴板又只能放一张图 —— 「图 + 字」根本粘不进 DSH。第二条因此改走平台自己的附件管线（合成 drop），张数不限（§3.36） |
| 复制那枚图标**直接用本体的 `IconCopyOutline16`**，按钮尺寸/配色照抄 `MessageIconActions.module.css`（28px 圆、15px 图标） | 用户明确要求「按原版的复制按钮来」；自绘的复制图标总有细微差别，而它就在统一基座里（`@deepseek-ai/dsh-client-ui-primitives`）。「送到输入框」那一枚才是自绘的 `SendToComposerIcon`（向下箭头落进托盘；不用纸飞机 —— 那读作「发送」，而这一步并不发送） |
| 图标按钮**必须自带 `aria-label` 与 `title`** | 图标没有文字，无障碍名与 hover 提示只能自己给（本体那条复制按钮也是这么做的）；成功态换成勾 + 灰字结论，避免「点完没反应」的错觉 |
| 剪贴板写入失败时**把真实异常带出来**（`writeClipboardRich` 返回一句原因而不是 `false`） | 上一版 `catch {}` 吞掉异常，用户只看到一句我猜的「浏览器不允许写剪贴板」——而真因是 `Support for multiple ClipboardItems is not implemented.`。**兜底文案不能替代真因**，否则下一轮还得靠探针重新发现 |
| 存储选项**另开一页**（「肥鱼画布」分节），不从「图像 / 视频模型」里长出来 | 用户明确要求：那一页是「配供应商与密钥」，存储混在里面既难找又让页面越来越长。同一席位注册两条是正常用法（§3.36 末） |
| 聊天按钮走**影子席位**（`priority: -1` 顶替 `user` 渲染器），不往 DOM 里插按钮 | 平台没有「用户消息操作」席位，但注册表的 priority 顶替是**承认的机制**；DOM 注入失效是静默的（按钮不出现、不报错），而影子渲染器至少会抛一条可读的注册错误。图片仍用本体的 `renderMessageImages`，只多写一个外壳（§3.35①） |
| 留档地址**替换** `url`（而不是并列一个 `localUrl` 让客户端挑） | 每个消费者（聊天行 / 画布落图 / 命令文本 / 导出 / 参考图）都读 `url`；并列一个字段 = 五处都要记得优先读它，漏一处就是「有的地方还会过期」。远端地址留在 `remoteUrl` 里备查 |
| 留档**等写完再返回**，且失败**不打断生成** | 这些字节浏览器要显示时反正也得下载一遍，让宿主下完再本地供图，比「先给一个会死的地址、之后再补」简单得多；而写不进盘只是「这次没留档」——图已经出来了，不该把成功的生成变成失败（原因随 `archiveError` 回给用户） |
| 留档目录**默认空 = 关** | 往用户磁盘上写东西必须由用户点头；关着时行为与升级前逐字节一致（测试里钉了这条） |
| 取图路由**必须**过 `connection.requestRejection` | 少了那道 Host/Origin 栅栏 + 会话 cookie，浏览器里任何页面都能靠 DNS rebinding 读这个目录；只有 `connection` 缺席的组合（无头）才放行（§3.35②） |
| 图标用**用户给的真实素材**（静图缩到 256 宽内联；动图 ffmpeg colorkey 抠白底 → 动图 WebP，200 宽内联），**只在 ≥24px 的「生成中」占位用动图**（`RICE_ANIM_MIN`） | 上一版自绘 + CSS 演动画「几乎看不出来」（§8.40），而用户手里就有素材。动图约 470KB / base64 639KB —— 工具行 14px、入口 17px 那些尺寸根本看不出动，不值得为它们多背这 639KB（内联的代价见 §8.43：`lib/client.js` 464KB → 1.12MB）。**⚠️ P38 起这条已作废**：图标换成原生鲸鱼尾巴（下一行），尺寸分档也随之取消 |
| **图标换成 DSH 原生那枚鲸鱼尾巴**：姿态与节奏**逐帧照抄原生**（静止态 `REST_PATH` + 原生那 60 帧 APNG 的时序），颜色一律 `currentColor`；**两处都填成实心**（静止态 `fill="currentColor"` + 同色描边；动图逐帧把线填成面，`scripts/lib/whale-solid.mjs`） | 用户要「跟原生一致 + 外形不变」：**同一套姿态**让「一致」成为构造事实，而不是去对齐帧率 / 缓动。第一版把静止态做成 APNG 第 0 帧 + `background: #fff`（他当时明确要「实心纯白」），第二轮他回来说「看着还不是纯色 / 改成像浅色主题那样适配」—— 实测那条位图细线缩到 17px 峰值 alpha 只有七成（§3.42 / §8.72），**灰是分辨率问题，不是颜色问题**；于是静止态换回原生那条**矢量**描边、颜色换成原生那个 `currentColor`（浅深主题都成立）。第三轮他又说「**把目前的空心改成实纯色的**」—— 矢量描边仍然是他不要的**空心线稿**，于是同一条 d 加上 `fill="currentColor"`（开放路径自动闭合，弦落在尾柄底边，剪影干净）；**留同色描边**是为了悬停切动画时轮廓线位置不跳。第四轮「**动态图标也改为纯色**」—— 动图那 60 帧也是线，于是逐帧补弦 + 洪水填充把线填成面（帧数 / 延时 / 循环照抄，推导可复现、拿原生重新推一遍逐字节比）。**只有悬停 / 生成中才切动图**（静止时一直摇是纯噪点）。顺带把 723KB 的米饭碗 data URI 请出产物：`lib/client.js` 1.27MB → 470KB → **454KB**（推导版比原生 APNG 小一半多） |
| MJ 图生文（视觉模型）按**模型 id 命中预置**分派（`wire: 'mj-describe'`），不给供应商加设置页旋钮 | 与 `wire: 'seedance-nz'` 同一条既有决策（上一段）：协议差异写在**预置**里、适配器加一个分支。加旋钮要多动 schema / 设置页写入面 / 客户端断言四处，而这个旋钮的**默认值不可能对**（选错就必然失败）——那就不是旋钮，是模式。代价：用户自己起的模型名要命中 `mj-*` / `midjourney*` / `describe*`，否则退回 `chat/completions` 并报一句可读的错（§8.64 的判据） |
| 视觉模型的描述文字取 `prompt`、`properties.finalPrompt` 兜底，**不取 `description`** | 实测 `description` 是斜杠命令（完成时字面量 `/describe`）—— 这个字段名**看起来**最像结果，值得在代码里留一句注释挡下一次「顺手改成 description」（§3.40、§8.64） |
| 动效只分**两档**（P37）：100ms 快出给「状态色」（hover / 选中 / 聚焦 / 按下），200ms 给卡片阴影与媒体淡入 | 苹果那条「东西越大越慢」不是随口定的：100ms 的灰底在指针扫过一排按钮时不会拖尾巴，而卡片抬起走 100ms 会像抽搐。两档都从 `--ds-transition-duration*` 来，于是 reduced-motion 压两个变量就全关（§3.39） |
| **按下缩放（`scale(.96)`）只给两个方向都是一个按钮量级的控件**，菜单行 / 360px 的模型触发器 / 卡片一律只做颜色反馈 | `transform` 会把**热区**一起缩掉：按下期间的 `pointerup` 一旦落到元素外，`click` 就不派发到它身上（「点了没反应」）。28px 按钮缩掉的是 0.56px 边缘，没人碰得上；360px 触发器缩掉 **7px**，菜单行缩了更直接 —— 同一个属性在两个尺寸上一个免费、一个致命 |
| 入场动画**从锚点那个角长出来**（`transform-origin: top left` / 缩放菜单用 `bottom left`），只做 opacity + 2px 位移 + 4% 缩放 | 凭空在原地淡入读作「贴纸」，从锚点长出来才读作「这个菜单是从那个按钮来的」—— 菜单的 `left/top` 本来就是锚点（触发器左下 / 右键那一点），所以只是把语义写进 CSS |
| **跟着指针走的东西一律不加动效**：框选矩形、对齐辅助线、拖拽中的面板宽度 | 直接操纵的反馈延迟一帧就是不跟手，那比缺一段动画难看得多。同理**没有**给并排 ⟷ 纯画布的切换做宽度过渡：本体那一侧是 `display: none` 瞬间收起的，动画只做一半会露出一次「空白右栏被擦掉」的闪烁 |
| reduced-motion 里用 `[class*='ffc-']` 一条通配压掉**全部**入场动画（而不是逐条列举选择器） | 与「所有 transition 必须走两个变量」是同一个思路：**新加的东西自动被盖住**，不依赖下一个人记得回来补一行。压 `animation-duration` 而不是 `animation: none`，保留「放完 = 回到自然状态」的语义（元素不会停在透明的第一帧） |
| **模型选择触发器只剩一枚图标**（鲸鱼尾巴，与右上角入口同组件同尺寸），模型名搬进菜单顶部那一行 | 用户要「名字点了才看得见，主界面只留一个图标」（P39）。那一格从此没有文字，语义由 `aria-label` / `title` 承担 —— 也因此它是这排图标格里唯一「外形即全部信息」的控件（§3.43⑤） |
| 家族行的档位改**悬停飞出**（`onMouseEnter` 开一块贴菜单右侧的面板），不再行内展开 | 行内展开会在指针扫过时把下面的行**顶下去**（目标从指针底下跑掉）；飞出面板不动菜单布局。这也正是用户给的四张参考图里的交互（P39） |
| 家族行**点击 = 只开不收**（幂等），开关留给键盘 Enter | 鼠标点它的时候指针正悬在它上面、面板**已经**开着，做成 toggle 就是「点一下反而关掉」（§8.74②） |
| 悬停行与飞出面板之间留 **150ms 宽限**（`FLY_GRACE`），不是立刻收 | 两者之间那 4px 的缝里 `mouseleave` 先到、面板的 `mouseenter` 后到 —— 没有这段宽限，指针正要进面板它就收了（§8.74①） |
| 触发器颜色：**选过模型 = 强调蓝**（`state-business-primary`），「自动」= 次要文字色 | 用户要「选择之后小鱼尾巴变蓝」（P39）。用 `state-business-primary` 而不是 `brand-primary` —— 后者是对比色（§8.62）。一个 `color` 就够：静止那半是 `fill`/`stroke`、会摇那半是 `background` |
| 设计技能：缺省**开**；「关闭」必须**显式写 false**，缺席一律按开算（P41） | 两边语义要一致：宿主读 schema 解析值（unset 会被缺省填回 true），客户端读快照（缺席时只能默认算开）。把「关」做成显式写入，开关在文档里自说明，避免「缺席到底是关还是没配」这种只能读代码回答的问题 |
| 设计技能文案经 `systemPrompt.section()` 注入**聊天模型**的 system prompt，**不进**发给生成模型的请求体；MJ 系（`wire: 'mj-imagine'`）flag 仍拼整句最后（P41，P44 按用户标注改向） | 原方案把文案拼进生成请求，画布节点回显的 prompt 混进与画面无关的一整段要求，且用户改文案改的是「给聊天模型的行为」。改注入到「写提示词的那个模型」后，由它组织又懂生成模型又符合设计要求的 prompt，请求体保持干净。实现要点都在 §3.44：text 是**每次装配现读活配置**的函数、`interpolate: false` 必须设、开的空文案 / 显式关都返回空串（渲染层自动滤掉） |
| 右键尾巴的**关闭态**只渲染 `data-ffc-skill='false'`，开时不写属性 | 开着时颜色语义还是 P39 那条 picked（**默认观感零变化**，老用户与老断言都不动）；关闭才需要一条压灰的 CSS。颜色因此有唯一因果：蓝要看两个独立读数，灰只有关闭一个来源 |
| 「同一支模型的两种 id 写法」**不**归成一行，哪怕它们是同一支模型（P43） | 家族键 = `供应商::词干`，而网关给同一支模型铺的两个 id 可能毫无共同词干（`gemini-3.1-flash-image-preview` vs `gemini-nano-banana-2.1`）。P43 试过用预置声明（`familyStems`）把它们并成一行，**用户看到后立刻要求回退**：行是「常用」的**入口**，2.1 没有自己的行之后，聊天栏那格的下拉里就找不到它了——第一反应是「模型不见了 / 是不是 bug」。并行的代价（两行同名、要配两份）远小于「模型在 UI 里没有入口」的代价。**别为了「看着整齐」再合一次**；要合就先问用户 |
| 导出做成**复合**的：一个「导出」动作收图**也收视频**，多选时混在同一个 zip 里（P46） | 用户要的就是「一个动作，选中什么导什么」。另一种做法（拆成「导出图片 / 导出视频」两个入口）要先给菜单加**二级结构**，而这份菜单一直是一层（交互约定：菜单作用于当前选择）；按类型拆成两个 zip 又多一次点击、多一个文件。zip 是 STORE 只装箱，视频不会被二次压缩 —— 混装没有代价 |
| 宿主把取字节分成**两个**远程方法（`fetchImage` 只收图 8MB / `fetchMedia` 图或视频、视频 64MB），而不是给一个方法加开关参数 | 附件那条通路（点画布图 → 聊天框）**只该收图**：同一份字节在那里会被包成 `File` 走本体附件管线，收视频是另一种（更贵也没意义）的行为。分成两个方法让「谁能收什么」写在名字上；加开关参数要动 `ProbeMethodSpec`（一处参数 = 一条参数线）与两侧描述符生成器，动静大得多 |
| 视频上限定 **64MB**，超限的提示直接指向「留档目录」 | 字节要经 RPC 过一次页面（base64 ≈ 原体积 1.34 倍），64MB 已经会顿一下；而留档目录那条路（`/ffc-media/…` 同源）**不经 RPC、没有上限** —— 把用户引到那儿，比在这里继续加码便宜。天花板写在 `host/probe.ts` 的 `FETCH_VIDEO_MAX_BYTES` 上（带 `ponytail:` 注释） |
| 导出模块**不改名**（仍叫 `exportImages.ts`，行为已复合） | 改名的收益只是名字诚实，成本是 import / 两条结构守卫 / STATE 与 NOTES 的多处引用一起动；改成在模块头写明「文件名照旧、行为已复合」，代价是每个读它的人多读一行注释 |
| 节点上的参考图存**句柄**（原样的地址 / 附件 id / `attached`），不存解析后的地址 | 解析后的参考图常常是兆级 `data:`（读本地文件 / 会话附件的结果），存进节点会把 `localStorage` 与（若走 meta）会话日志一起撑爆。句柄短、稳定、够用：能直接渲染的（`isReferenceHandle`）给缩略图，其余的照实说明它是什么 |
| 「生成信息」做成右键菜单里**展开的卡片**，不做独立弹窗 | 看提示词的时候多半接着要「复制提示词 / 重新生成」，换一个浮层就把那些动作挡在后面；菜单里的条目全都还在手边。代价是菜单会长高 → 展开时**要重新夹一次视口**（`clampToViewport` 的依赖里加了 `info`） |
| 参考图「查不到」时显示「（没有记录）」，**不猜** | 句柄只在生成的那一刻看得到（§3.46），这个功能上线之前生成的节点必然查不到。显示一张猜来的图 = 用户以后按着一张错的参考图去复现 |
| 滚轮归属由**视口在 `wheel` 里现问一句**决定（往上找工作滚的元素），不在浮层上逐个挂 `stopPropagation` | 浮层是视口的 DOM 后代，事件拦在**深层**才对（React 的 `onWheel` 在根容器上被动监听，视口那个原生监听早就跑完了）。拦在视口这一处 = 以后任何新的可滚浮层自动正确；按类名白名单拦则每加一个浮层要补一次，漏了就是「文字滚不动、画布乱缩放」这个用户实测到的坑（§3.47 / §8.83） |
| 撤销用**快照式**挂在 `commit()` 一个口子上，不给每个动作写逆运算 | store 已经把全部节点变更收敛到 `commit()`，判别式 `next.nodes !== state.nodes` 是零成本的：视口与选择集都走 `...state` 展开，`nodes` 引用原样保留，于是它们天然不进历史 —— **不需要**给每个动作挨个打标记。逆运算则要给增删改移各写一份，还得自己还原 z / 顺序 / 落图记账，那才是会写错的地方。快照是浅的（节点按引用共享），50 步也就几百个引用 |
| 撤销的合并判据是**「id 集合没变」**，不只是时间窗 | 拖拽每帧都在 `patchNodes`（`CanvasStage.onPointerMove`），必须并成一步；但「600ms 内连删两个节点」是两件事，撤一步只该回来一个。时间窗只用来挡帧，集合变了就各记一步（`test-model.mjs` §2 两条判据分别钉这两半） |
| 撤回还原**整份快照**（含视口）；换工作区**清空**撤销栈 | 连视口一起还原，撤掉删除时视野正好落回那个节点还在的地方。清空那一半是**数据隔离**不是整洁：不清的话在工作区 B 按一下 Ctrl+Z 会把 A 的节点搬进来（§3.19 的「一个工作区一块」） |

---

### 3.39 设计 token 的取值与四条规则（P34 从 `dsh-client-ui-theme` 里挖出来的）

调 UI 之前先读这一节。token 的**定义**只有一处，全在
`…\node_modules\@deepseek-ai\dsh-client-ui-theme\lib\client.js` 的那几个 CSS 字符串里
（`base_css_default` / `design_platform_css_default` / `gradient_shadow_text_css_default` /
`focus_css_default` / `corner_shape_css_default`），浅深两套 alias 各在一段 `body{...}` /
`body[data-ds-dark-theme]{...}` 里。把这两段抠出来按 `;` 换行就是一份完整色板
（抠法：`IndexOf('body{--dsw-static-amber-100')` 到 `IndexOf('background-color:var(--dsw-alias-bg-base)}')`）。

**① 圆角 / 时长 / 缓动是一套有名字的阶，别写裸值**
（`--dsw-radius-*` 与 `--ds-*` 都挂在 `:root` 上，所以 `:root` 里能直接引用）：

| token | 值 | 用途 |
|---|---|---|
| `--dsw-radius-xs / sm / md / lg / xl / panel` | 4 / 8 / 12 / 16 / 20 / 28 px | 小徽标 / ≤30px 控件 / 卡片·菜单行 / 浮层·菜单面 / 大卡 / 设置面板 |
| `--ds-transition-duration` | `.2s` | 本体的**基准**档（按钮态用它） |
| `--ds-transition-duration-fast` / `-slow` | `.1s` / `.3s` | 箭头翻转一类 / 长动作 |
| `--ds-ease-in-out` | `cubic-bezier(.4, 0, .2, 1)` | 本体唯一的缓动 |

**② 焦点环有专门的 token，别自己写 `2px solid`**

```css
/* focus.css：宽度在 :root，**颜色是个可重绑的钩子**（没有默认声明） */
:root { --dsw-focus-ring-width: 2px }
/* 本体每个组件都是这么用的： */
outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
```
`--dsw-focus-ring-color` 平时没人声明 → 实际永远回落到 `state-business-primary`（deepseek 蓝）。
**别拿 `--dsw-alias-brand-primary` 当焦点色**（它等于 `label-primary`，见 §8.62）。

**③ `corner-shape` 被全局设成了苹果那种连续曲率 —— 圆形必须自己圆回来**

```css
@supports (corner-shape:superellipse(1.5)){
  :root{--dsw-corner-shape:superellipse(1.5)}
  *,:before,:after{corner-shape:var(--dsw-corner-shape)}
}
```
所以**我们的元素自动继承**超椭圆圆角（这是白拿的苹果质感，不用自己写）。
但 `border-radius: 50%` 的圆会被它改成「方一点的圆」→ 必须显式 `corner-shape: round`
（本体的 `Pill` / `Tag` / `Switch` / `StateDot` / `ImageLightbox` 都这么做，共 10 处）。

**④ 高层级表面是 `border: 0` + `--dsw-elevation-*`，而且描边色**逐元素**生效**

```css
body, body * {           /* ← 注意是「每个元素」都重声明一遍 */
  --dsw-elevation-stroke: 0 0 0 .5px var(--dsw-elevation-stroke-color);
  --dsw-elevation-panel:      var(--dsw-elevation-stroke), 0 3px 8px 0 #00000008, 0 0 16px 0 #00000005;
  --dsw-elevation-prominent:  var(--dsw-elevation-stroke), 0 3px 8px 0 #0000000a, 0 0 20px 0 #0000000d;
  --dsw-elevation-soft:       var(--dsw-elevation-stroke), 0 4px 16px 0 #00000008, 0 0 24px 0 #00000008;
}
body[data-ds-dark-theme] [data-menu-material]{ --dsw-elevation-stroke-color: var(--dsw-alias-border-l3) }
```
`--dsw-elevation-stroke-color` 默认是 `--dsw-alias-border-l4`（浅 16% / 深 20%）。
因为派生 token 是**逐元素**重声明的，在某个元素上重绑描边色**当场生效**（本体菜单都这么干：
`--dsw-elevation-stroke-color: var(--dsw-alias-border-l1)`，我们照做）。
⚠️ 推论：**别把 `--dsw-elevation-*` 快照进自己的 `--ffc-*` 变量**（在 `body` 上求值会被烘焙死，
后代再重绑描边色就传不进去了）—— 直接在用处写 `var(--dsw-elevation-prominent, <回退>)`。

**⑤ 两套主题的实际取值（做「分层」时看这张表，别猜）**

| 用途 token | 浅色 | 深色 |
|---|---|---|
| `--dsw-alias-bg-base`（页面底） | `#fff` | `#151517` |
| `--dsw-alias-bg-layer-1 / 2 / 3` | **`#fff` / `#fff` / `#fff`**（全白！） | `#232324` / `#2c2c2e` / `#353638` |
| `--dsw-specific-sidebar-fill`（凹陷面） | `#f9fafb` | `#1b1b1c` |
| `--dsw-alias-interactive-bg-hover` | `#2631480f`（**深色**叠加） | `#ffffff14`（白色叠加） |
| `--dsw-specific-menu`（= `--dsw-menu-surface-fill`） | `#f8f9fa` + **58% alpha** | `#43454a` + **45% alpha** |
| `--dsw-alias-menu-group-header-fill`（吸顶标题） | `#f8f9fa` + 94% | `#303136` + 94% |
| `--dsw-menu-backdrop-filter` | `blur(40px) saturate(150%)`（两套相同） | 同左 |
| `--dsw-alias-state-business-primary`（真正的强调色） | `#4176e6` | `#7aaaff` |
| `--dsw-alias-brand-primary`（**对比色**，= `label-primary`） | `#0f1115` | `#f9fafb` |
| `--dsw-alias-label-primary / secondary / tertiary / caption / dimmed` | `#0f1115` / `#61666b` / `#81858c` / `#adb2b8` / `#e1e5ee` | `#f9fafb` / `#cfd3d6` / `#adb2b8` / `#81858c` / `#43454a` |
| `--dsw-alias-border-l1 / l2 / l3 / l4` | 4% / 10% / 12% / 16% 黑 | 6% / 12% / 16% / 20% 白 |

两条由这张表直接推出来的结论：**浅色下 `bg-layer-1/2/3` 分不出层**（§8.49、§8.62 的根源）；
**菜单底色是半透明的，缺了 `backdrop-filter` 就是一张塑料膜**（§8.59 末尾）。

**⑥ 哪些 token 能在 `:root` 里引用，哪些不能**（这条决定 CSS 写在哪）

| 组 | 挂在哪 | 能不能在 `:root` 求值 |
|---|---|---|
| `--dsw-radius-*`、`--ds-*`、`--dsw-focus-ring-width`、`--dsw-shadow-lv*` | `:root` | ✅ |
| `--dsw-alias-*`、`--dsw-specific-*`、`--dsw-menu-*`、`--dsw-elevation-*`、`--dsw-static-*` | `body` / `body[data-ds-dark-theme]` | ❌（写在 `:root` 整条失效） |

这就是 `styles.ts` 把 token 层**拆成 `:root` 与 `body` 两段**的原因（不是排版习惯）。
判据：在 `:root` 里写了一个 `--ffc-x: var(--dsw-alias-…)`，它会静默失效 →
拿 `getComputedStyle(document.documentElement).getPropertyValue('--ffc-x')` 一测就知道是空的。

---

### 3.40 MJ 系网关的图生文协议（2026-10-05 实测 `ai.t8star.org`，一次真调用问出来的）

文档站点（apifox / crazyrouter / yutoo 那些）在这个网络里全部打不开
（`web_fetch` 报 `resolves to a non-public IP address`）。**别照着字段名猜** ——
拿用户已有的那把 new-api 密钥真发一次，10 秒就问清楚了（比读文档还省事）：

```
POST {base}/mj/submit/describe   { base64: "data:image/png;base64,…" }
  → { code: 1, description: "提交成功", result: "1791171447030956" }   ← 任务 id 在 result
GET  {base}/mj/task/<任务 id>/fetch
  → { id, action: "DESCRIBE", status: "NOT_START" | "SUCCESS" | "FAILURE",
      prompt, promptEn, description, properties: { finalPrompt, botType },
      progress: "0%" | "100%", failReason, imageUrl, … }
```

四条实测结论（每条都值一次试错）：

1. **描述文字在 `prompt` 里**（`properties.finalPrompt` 是同一份）。`description`
   是斜杠命令：刚提交时 `"提交成功"`、完成时字面量 `"/describe"` —— **照字段名
   取 `description` 会拿到一句 "/describe"**（§8.64）。
2. **只收 base64**（文档示例就带 `data:image/png;base64,` 前缀），不收图片地址；
   请求体里**没有 `model`** 这个字段 —— 端点本身就是一个模型。
   因此这条路必须先取字节（`referenceBytes`）再内联。
3. **基址不带 `/v1`**：MJ 端点挂在 `{base}/mj/…` 下，与同一家的 OpenAI 兼容端点
   （`{base}/v1/…`）不同层。同一台机器因此会有**两条供应商记录**（`custom` 与 `mj`），
   这不是重复配置。
4. **耗时约 15 秒**（1791171447 → 1791171464），3 秒一问足够；未就绪时任务是
   `200 + NOT_START`（不是 404），所以一提交就能开始轮询。
   `code` 里 21/22 是「已存在 / 排队中」，**都不是错误**：拿到 `result` 就照轮询。

**同一把密钥能用**：`/mj/*` 与 `/v1/*` 都是 new-api 的一套鉴权（实测 `custom` 那把
`FFC_CUSTOM_API_KEY` 直接打通了 describe）。给 MJ 单开一条供应商只是为了让基址
对得上（第 3 条），**不是**要用户再买一把密钥。

**设置页的一个形状约束**：供应商的「配置密钥…」按钮在 `apiKeyEnv` 为**空串**时是
灰的（那一行显示「未设置引用」）。所以「密钥先空着、等用户填」要写成
`apiKeyEnv: FFC_XXX_API_KEY`（**有引用名、凭据库里没值**）—— 界面显示
「未配置（FFC_XXX_API_KEY）」，按钮可点。写空串等于把填密钥的唯一入口关掉。

### 3.41 MJ 出图协议（`mj_fast_imagine`），以及**文档站点现在怎么读**（2026-10-05 实测）

出图那条协议与 §3.40 的图生文同源（同一家网关、同一把 new-api 密钥、同样「提交 +
轮询」），但形状不同。以下全部来自**一次真调用**（提交 → 每 5 秒轮询到完成）
＋ 官方 apifox 文档（[api-139393505](https://gpt-best.apifox.cn/api-139393505)、
[Midjourney 接入向导](https://gpt-best.apifox.cn/doc-6172523)、
[补充 其他参数以及回调](https://gpt-best.apifox.cn/doc-3530863)）：

```
POST {base}/mj/submit/imagine   { prompt }        （可选 base64Array 垫图，只收 base64）
  → { code: 1, description: "提交成功", result: "1791179477894437" }
GET  {base}/mj/task/<任务 id>/fetch
  → status: NOT_START | SUBMITTED | MODAL | IN_PROGRESS | FAILURE | CANCEL | SUCCESS
    imageUrl（**四宫格**，2912×1632）· imageUrls[4]（四张分图，各 1456×816）
    progress / failReason / promptEn / buttons[]
```

七条实测结论（每条都值一次试错）：

1. **参数不进请求体，而是提示词里的 flag**：`--ar 16:9` 发出去，回来的图确实是
   16:9（`properties.finalPrompt` 里还多了一个网关自己补的 `--fast`）。请求体里
   **没有 `model`** —— 与 describe 同一条规矩。
2. **默认就是 fast**：`/mj/submit/imagine` 与 `/v1/mj/submit/imagine` 在这个网关上
   **两条都路由**（都进了 MJ 处理器）。模式按**令牌 > 路径 > 系统默认**选，路径写法是
   `{base}/mj-fast|mj-turbo|mj-relax/mj/submit/imagine`。`mj_fast_imagine` 这个名字本身
   只是**计费用的模型名**（`/v1/models` 里 `mj_fast_*` / `mj_relax_*` 一大串）。
3. **一次约 105 秒**（提交 05:51:18 → 完成 05:53:03），3~5 秒一问足够；整体默认超时
   600 秒，够用。
4. **`imageUrl` 是四宫格，`imageUrls` 才是四张分图**。本插件一次调用落一个节点，
   所以只取 `imageUrl`（要拆成四张得让一次调用投影多个节点）。
5. **`imageUrl` 在「执行中」也可能有值**（文档原话「成功或执行中时有值」）——
   先读它会把一张进度图读成成品（§8.67）。
6. **两个图片地址都不需要鉴权**（网关自己的 `/mj/image/<任务 id>` 与 youchuan CDN
   都是 200 + `image/png`），所以 P32 的留档照常抓得下来。
7. **提交响应的 `code` 只有 1 / 21 / 22 带任务 id**（1 成功、21 已存在或窗口等待、
   22 排队中、23 队列已满、24 敏感词）—— 判据该是**「有没有 `result`」**，不是
   `code === 1`。

**文档站点怎么读（这条能省一整轮）**：`web_fetch` 报 `resolves to a non-public IP
address`、pwsh 里的 `curl` / `Invoke-RestMethod` 一律 TLS 握手失败
（schannel `SEC_E_NO_CREDENTIALS`）—— 但**本机有代理**（Clash 系，
`127.0.0.1:7897`，DNS 是 fake-ip `198.18.x.x`），而 **node 自带的 TLS 不吃 schannel**。
这件事已经做成**常驻脚本**：**`node scripts/fetch-doc.mjs <url>`**（源码里写着
怎么手写 `CONNECT` + 用 HTTP/1.0 免掉 chunked；`--auth FFC_XXX` 自动从凭据库取密钥、
`--body <文件>` 发 POST、`--head` 只看响应头）。**别再手搓一次性探针**。
apifox 站点还有**整站目录** `{站点}/llms.txt` 与**每页的 `.md`**
（本页就是 `/api-139393505.md`），比抓 HTML 省事得多。

---

### 3.42 原生那枚「摇尾巴」鲸鱼：它在哪、长什么样、怎么复用（P38 换了图标）

**位置**：`<dsh 安装目录>/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js`
—— 规则 `.EvIC1a_runningWhaleAnimated` 里那段 `mask:url(data:image/png;base64,…)`。
全文**只有这一份** PNG data URI，正则一抓就准（`scripts/make-whale.mjs` 就是干这个）。
同文件的 `RunningWhaleTail()` 由两部分组成，**这就是原生那套的全部**：

- 静止那半：一条内联 SVG 路径 `REST_PATH`（`viewBox 0 0 16 16`，`stroke: currentColor;
  stroke-width: 1`）—— 原生**是描边，不是实心色块**。遮罩可用且允许动效时，原生靠
  **绝对定位的动画 span 盖在它上面**（定位元素压住行内 SVG），遮罩不可用 / 减少动效时
  才轮到它露出来。**我们这边把它填成实心**（`fill="currentColor"` + 同色描边，第三轮
  用户明确要求「把空心改成实纯色」）：填的是同一条 d，外形不变。
- 动画那半：一个空 span，`background: currentColor` + `mask: url(APNG)` —— 图形只有
  **alpha**，颜色全靠 background 露出来；**它也是描边**（见下）。
- 外框 `.runningIcon` 是 **14px** 见方 + `contain:strict; overflow:hidden`。

**资产本身**（**姿态与时序**逐帧照抄，别自己重画）：28×28、8bit **灰度 + alpha**
（colorType 4）、**60 帧 / 每帧 1/20 s（50ms）/ 一圈 3 秒**、`acTL.plays = 0`（无限循环）、
21,631B。⚠️ 我们产物里那份**不是原件字节**：它是**推导出的实心版**（见下），8,925B。

**⚠️ 三个实测出来的形状事实（P38 第二版才搞清，第一版全踩了）**：

1. **它是细线，不是实心剪影**：第 0 帧只有 46 px 到 alpha 255、159 px 半透明，而且
   **一个封闭空洞都没有**（洪水填充从边框能灌进所有「内部」—— 尾柄底部是敞开的）。
   位图上「直接填内部」做不到（`_probe-fill.mjs` 试过）—— 得先**补上那条闭合弦**（见下）。
2. **28px 位图细线缩到 14/17px = 一条灰线**：细线宽约 1 个源像素，缩到 0.6 倍后峰值
   alpha 只剩七成上下 —— 屏幕上看着像「不是纯色」。**要清晰就得用矢量那半。**
3. **原生那个 `mask: url(...)` 简写没给 `mask-size`** → 默认 `auto` = **28 CSS px**，
   而盒子只有 14px、还带 `overflow:hidden` —— 也就是**原生是按 DPR=2 调的**（28 设备
   像素 = 14 CSS px 正好铺满）。我们这边**显式写 `mask-size: contain`**，免得 1× 屏上
   只露左上角那四分之一。

**复用它 = 两处颜色 + 两处填充 + 一处状态**：静止态那半的 `fill` 与 `stroke`、动画那半的
`background` 都走 `currentColor`（**跟主题**；写死 `#fff` 在浅色主题下等于隐形，P38 第一版
就是那么干的），状态切换靠动图那枚的 `display`（默认 none，生成中 / 入口悬停才 block）。
**姿态与节奏逐帧照抄原生**（同一条 `d`、同 60 帧、同 50ms、同无限循环），只有「线 ⟶ 面」
这一步是我们加的 —— `test-icon.mjs` 会拿本机原生重新推一遍、逐字节比。做法落在
`icons.tsx` 的 `whaleTailHtml()`、`styles.ts` 的 `.ffc-whale*` 三条规则、以及
`scripts/lib/whale-solid.mjs`（推导）。

**静止态是实心剪影（P38 第三轮）**：`REST_PATH` 是一条**开放路径**（起点与终点都在尾柄
底部），SVG 的 `fill` 会自动闭合它 —— 那条闭合弦正好是尾柄的底边，所以填出来是一个干净的
鲸鱼尾剪影，没有尖刺 / 缺口（96px 下逐个渲染对比过四种画法：只填 / 填+描边 / 填+粗描边）。
现在的做法是 **`<svg fill="currentColor">` + `<path stroke="currentColor" stroke-width="1">`**：
留着那条**同色描边**是有意的 —— 悬停切成动画时**轮廓线位置不变，只有内部空掉**。

**动画也是实心（P38 第四轮，`scripts/lib/whale-solid.mjs`）**：原生那 60 帧是发丝线，
用户要「动态也纯色」，于是**逐帧把线填成面**，姿态 / 帧数 / 延时 / 循环全部照抄：
① 阈值取轮廓（alpha > 8）；② 在**最低两行**里把轮廓左右两端连起来 —— 补的正是原生
没画的那条闭合弦；③ 从画布边框洪水填充「外面」，填不到的就是剪影内部；④ 外面 0 / 其余 255。
结果：每帧面积从 24% 涨到 35–38%（线 ⟶ 面），**逐帧盖住原生那条线 >= 98%**（帧错位会掉下来），
重新编码成 60 帧 APNG（colorType 4、blend SOURCE、dispose NONE、`plays=0`）。
两个坑都在 §8.73：忘了 inflate、以及**尾柄两侧收笔不在同一行**（只看最低一行补不上弦）。
好处不止好看：这份比原件**小一半多**（8.9KB vs 21.6KB），`lib/client.js` 跟着从 471KB 掉到 454KB。

**抽取脚本**：`npm run art` → `scripts/make-whale.mjs` → `src/client/generated/whale.ts`
（纯 Node：读文件 + 正则 + 切 PNG 块 + `zlib`，不碰 Chrome / ffmpeg；抽不到 / 推不对
**直接抛错、不写产物**，比如实心化的面积比不在 1.2..3 就炸）。
`test-icon.mjs` 会拿本机原生**重新推一遍实心动图逐字节比**，并逐帧比姿态与节奏
（DSH 升级换资产立刻红）。

**P39 补充**：这枚图标现在有**两处悬停**会摇 —— 右上角入口（`.ffc-entry:hover`）与
composer 那格模型选择触发器（`.ffc-mp-trigger:hover`）。两条选择器并排写在同一段
`@media (prefers-reduced-motion: no-preference)` 里，`test-icon.mjs` 的守卫逐条点名
（加第三处悬停时必须同时进那个数组，否则新那处没人看着）。

### 3.43 浮层里的「飞出面板」：为什么它只能和菜单做**兄弟**，以及悬停开关的两个时序事实（P39 实测）

**① `position: fixed` 的后代放不进菜单里面**。`.ffc-mp-menu` 有 `overflow: hidden`
（圆角要裁）+ `backdrop-filter`（材质模糊）—— 后者与 `transform` / `filter` 同类，
会把菜单变成 **fixed 后代的包含块**，于是「菜单里的 fixed 面板」既被菜单裁掉、
坐标也跟着菜单算。

**② 绝对定位也躲不过滚动容器的裁剪**：菜单里滚动的是 `.ffc-mp-groups`
（`overflow-y: auto`）。`position: absolute` 的后代只有在**包含块落在滚动容器之外**时
才不被裁（把行设成 `position: static`、让面板的包含块是菜单就能做到）—— 但那要求面板与
菜单同父、且菜单自己 `overflow: visible`（圆角裁切跟着没了）。两条路都不划算。

**结论（现在的做法）**：飞出面板与菜单做**兄弟**，各自 `position: fixed`（坐标由 JS 量、
夹进视口，右边放不下就翻到菜单左边），共用一个 `position: fixed; inset: 0;
pointer-events: none` 的容器 `.ffc-mp-layer`（`pointer-events: auto` 只给两个面板）。
那一层**同时**是 `useMenuDismiss` 查的那个 ref —— 不然「点面板里的档位」会被当成
点到外面（细节与代价见 §8.48 的 P39 补充）。

**③ 悬停开面板必须有「宽限定时器」**：面板与那一行之间隔着 4px，指针穿过去时
行的 `mouseleave` 先到、面板的 `mouseenter` 后到。实测 **150ms** 够用（`FLY_GRACE`）：
比一次快速划过的间隔长，又短到「移开就收」不显拖沓。

**④ 悬停已经打开的东西，点击不能再做 toggle**：鼠标点在家族行上时指针正悬在它上面、
面板已经开着 —— 点击若还是 toggle 就是「点一下反而关掉」。现在的分工：
鼠标悬停 / 点击 = **只开**（幂等，触屏没有悬停，点击是那条路），键盘 Enter = 开关。

**⑤ 触发器那枚鲸鱼尾巴的颜色**：选过模型 = `--dsw-alias-state-business-primary`
（浅 `#4176e6` / 深 `#7aaaff`，真机量到 `rgb(122,170,255)`），「自动」时是次要文字色
（深色主题 `rgb(207,211,214)`）。判据落在 `data-ffc-picked` 上（`e2e:picker` 拿页面里
临时插的元素把 token 求值成具体色值来比，不写死颜色）。
收割收益：`lib/client.js` 1.27MB → **454KB**（旧米饭碗那份 723KB 的内联 data URI 不再进包）。

---

### 3.44 Nano Banana 2.1 的「常用参数」以及它算不算新系列（2026-10-11，读 T8-penguin-canvas 得出的）

**结论：`gemini-nano-banana-2.1` 不是新系列。** T8 的 `src/providers/models.ts`（85 KB，唯一的
权威模型注册表）把它放在既有 family **`nano-banana-2`**（tab「香蕉2」）的 `apiModelOptions` 里，
与前代香蕉**共用同一份参数**：同一 `paramKind: 'banana-ratio'`、同一 sizes / 比例闭集、
同一默认（`1:1` / `2K`）。Pro 是**另一个** family（`nano-banana-pro`）。全仓只有 1 个 family
含这个 id，平价小屋那条通道的下拉里没有它。

**香蕉通道的参数一共只有三个**（其余键一律不存在，别凭想象加）：

| 键 | 取值 | 备注 |
|---|---|---|
| `aspect_ratio` | 香蕉2 16 项（含 `Auto` 与大写极端比 `1:4`/`4:1`/`1:8`/`8:1`）；Pro 12 项 | 2.1 在小屋通道走的是 **11 项小写**（含 `auto`，无极端比） |
| `image_size` | `1K` / `2K` / `4K`，默认 `2K` | **大写的 `K` 是硬要求**（小写会被官方拒） |
| `images` | ≤14（上游契约）/ 画布 UI 限 5 / FAL 通道 8 | 本插件走自己的 `image` 字段（见 §3.28） |

**没有**：`seed`（只有 FAL 通道有）、`negative_prompt`（只有 Qwen 通道）、`watermark`、
`response_format`、`temperature`、`safety`、`number_of_images`。请求体是
**OpenAI-*images* 形状、参数平铺**（`POST {base}/v1/images/generations`，带参考图走
`/v1/images/edits` multipart）—— 不是 `chat/completions`，也不是 Gemini 原生
`:generateContent` / `interactions`（T8 的测试显式断言 `body.generationConfig === undefined`）。
**所以它和本插件缺省那条 wire 是同一形状**，不需要新 `wire` 分支。

→ 落到本项目：`shared/modelPresets.ts` 的 `nano-banana` 预置**加一个词干**
（`gemini-nano-banana`）+ **加一个参数**（`image_size`）就够，见 STATE P43。
**只合参数，不合行**：T8 那边它们同属一个 family，但本插件的「行」是「常用」的入口，
2.1 并进 3.1-preview 那行之后用户就找不到它了（见 §4 那条，P43 试过又回退）。

**调研产物与抓取通路（下次读外部仓库省一半时间）**：完整报告在
`.t8research/T8-gemini-banana-参数报告.md`。本机网络**只认这两条路**：
`api.github.com/.../contents/<path>`（返回 base64）与
`fastly.jsdelivr.net/gh/<user>/<repo>@main/<path>`（**返回纯文本，首选**）——
`raw.githubusercontent.com`、jsdelivr 主域、`github.com/.../raw`、`git clone`、
pwsh 的 `Invoke-RestMethod` 打 GitHub（匿名限流）**全部不通**。
超过 ~50 KB 的响应会被截断并**整段落盘**到 `%LOCALAPPDATA%\Temp\dsh-spill-*\`，
可以用 grep 免费本地检索（T8 那份 85 KB 的 `models.ts` 就是这么读全的）。

---

### 3.45 `ctx.systemPrompt.section()`：插件向聊天模型 system prompt 注入段落（P44 实测形状）

服务是 `dsh-system-prompt` 提供的 `ctx.systemPrompt`（缺席的组合里 `ctx.inject(['systemPrompt'], …)`
不会执行 —— 按可选依赖处理，不要声明成必需注入）。要点：

- **形状**：`section({ name, order, text, interpolate? })`。`order` 要有限数
  （中心分配的见源码 `SECTION_ORDERS`：`HARNESS_IDENTITY: -1000` 到 `TOOLS_SDK: 5000`；
  **外部贡献可用任意有限值**）；`name` 在同一 scope 内唯一，重了会抛
  `prompt section "X" is already registered`。
- **动态文本**：`text` 可以是**函数**，每次装配（`assemble()`）现算 —— 本插件就靠它
  现读 volatile 活配置（改设置 / 右键切开关下一次请求生效，不用订阅也不用重建）。
  注册时求值的是它是**字符串**，两种都能用，别把「动态」理解成必须重建注册。
- **空串没问题**：渲染（`renderPrompt`）里 `.filter((text) => text.length > 0)` 把空段
  **过滤掉** —— 「开关关了」可以直接在 text 里返回空串，不必摘除注册。
- **`interpolate: false` 要紧**：文本默认被 `{{name}}` 变量插值，**引用不存在的变量或
  只有 `{{` 没有 `}}` 会直接抛错炸掉装配**。凡是放**用户可编辑文案**的段落一律设 false
  （P44 的设计技能文案就是这种）。
- **改动模型的提示词带来的前缀缓存冲击**：平台的 in-history 合并
  （`systemPromptUpdate: 'in-history'`）会跟住段落文本变化，续聊里不炸前缀复用；
  但每改一次文案都算一次提示词变化 —— 这是语义使然，别当成 bug 修。

### 3.46 「这次生成参考了哪几张图」在两条入口上的可得性不同（P47 实测）

结论：**参考图句柄只在生成的那一刻看得到**，事后回看必须当时就记下来。三条通路：

- `tool/result` 的 `presentationMeta` 里**只有 `usedReference` / `referenceCount`
  （有没有、几张），没有任何地址** —— 宿主是故意不写的：解析后的参考图常常是兆级
  `data:`（读本地文件 / 读会话附件的结果），抄进 meta 会把会话日志撑爆。
- **工具这条路的唯一来源是 `tool/call` 的 `arguments`**（`argsRaw`），因为参数里
  带了 `reference`（一张写字符串、多张写数组，可能含哨兵值 `attached`）。而
  `tool/result` 自己**只有 callId**（§3.10），所以窗口折叠时必须把配对的调用参数
  一起带下来 —— `canvas/bridge.ts` 原先只留了工具名（`argsRaw: ''`），于是「页面在
  生成之后才打开」的那些节点永远查不出参考图（P47 修的就是这条）。
- **命令这条路的来源是 `command/run` 的 `args` 原文**（`/generate … --ref <url>`），
  它一直在命令节点上，因此命令触发生成的参考图**连事后打开也记得下来**。
- 浏览器能直接渲染的句柄只有 `http(s)` / `/ffc-media/…` / 小 `data:`（判据 =
  `isReferenceHandle`）；`attached`、`sha256:…`、本地路径都只有宿主取得到字节，
  界面只能说清它是什么（判据与文案在 `canvas/model.ts` 的 `referenceViews`）。

### 3.47 `position: fixed` 的浮层仍是视口的 DOM 后代，滚轮会冒泡上来（P48 实测）

画布的节点右键菜单是 `.ffc-viewport` 的**子元素**（虽然 `fixed` 定位、看着像另一层）。
由此推出三条：

- **事件照样按 DOM 树冒泡**，与 `fixed` / `absolute` / `transform` 无关；视口上挂的
  `wheel` 监听会收到「用户其实在滚浮层」的那些滚轮。
- **默认滚动动作只有一处**：浏览器在派发结束时按事件目标链决定滚谁。祖先监听里
  调一次 `preventDefault()`，浮层内那个元素的原生滚动**一并被取消** —— 表现就是
  「里面的文字滚不动，外面的画布跟着缩放」。
- 判断「这记滚轮归谁」用**能不能滚**这条浏览器语义（往上找第一个
  `scrollHeight > clientHeight` 且 `overflow-y` 是 `auto`/`scroll` 的祖先，走到视口为止），
  不要用「属不属于某个浮层类名」—— 前者对任何新浮层都成立，后者每加一个浮层就要补一次。
  只判断 `scrollHeight > clientHeight` 不够：`overflow: visible` 的元素内容溢出时
  这个差值也大于 0，但它**滚不动**。

## 8. 坑与教训（避免重犯）

> **症状索引 —— 先查这里，再往下翻。** 左边是「你会看到什么」，右边是该读的条目号。
> 盯着一个假故障时**不要**从第 1 条往下读四十多条：这张表就是 §8 的检索入口。
>
> | 你会看到什么 | 读 |
> |---|---|
> | 构建报 `',' expected` / `Invalid character`，**不指行号** | **12**（`styles.ts` 模板串里混进反引号；`build.mjs` 现在会直接点出行号） |
> | 构建报「引入了 X，既不在统一基座内」/「检测到 require 环」 | 报错本身 + §3.2 |
> | 改了 `src/`，测试还报**旧文案** | **29**（`test-host.mjs` 读 `lib/` 产物，先 `node build.mjs`） |
> | 测试**间歇性**红、画布上多出陌生节点 | **20**（废弃 store 实例的 400ms 去抖写盘） |
> | 测试红了但功能其实是对的（假故障） | **4**、**6**、**31** |
> | 「种下的节点一个都不见」/ 画布是空的 | **30**（种子被 stringify 两次）、**18**（作用域没钉成「共用那块」—— 默认是按工作区分） |
> | 某个按钮点不动 / 点了没反应 | **7**（要落在按钮中心）、**25**（flex 被压成 0 宽） |
> | 量出来的元素是 0×0、点在 (0,0) | **22**（隐藏副本仍在文档里） |
> | 测试替身「装上了却不生效」 | **5** |
> | e2e 一次报好几条假故障，功能全对 | **17**（前缀筛选）、**4**（先怀疑断言） |
> | `e2e-p4` 只剩「点一下跟焦按钮」一条红（偏好真的改了、按钮按下态不刷新，也没有浮层遮挡） | **60** 末尾（P34 补充 + 2026-10-14 复测：`useFollowNewNodes` 那条订阅腿的值卡住） |
> | `e2e-entry` 固定红 11 项（顶栏「可命中」+ 纯画布 + session log 那几簇） | **60**（欢迎提示浮层压在顶栏上；session-log 插件在本 profile 里是关的） |
> | e2e 读到空画布 / 读到别的工作区的画布 | **10**、**18** |
> | e2e 重载后多出陌生节点 / 空态占位没渲染 | **10**（种子必须走 `seedBoardExpression()` 保住账本 —— 10 分钟内的结果会重新落回来） |
> | 设置页填了值、宿主读到空（界面回显却是对的） | **48** 末尾（React 把 `onBlur` 委托在 focusout 上，合成 `blur` 不冒泡） |
> | 无头 Chrome 起不来（`mojo/platform_channel.cc: 拒绝访问 (0x05)`） | **§3.38**（受限模式开不了命名管道 → 要完全权限） |
> | e2e 全 401、页面全空 | **§3.38**（令牌只在 `dsh web` 启动那一行；`lib/web-url.txt` 会过期） |
> | 命令**根本起不来**：`SetNamedSecurityInfoW failed (Win32 5): grantWrite(<工作区根>)` | **58**（DSH 自己 provision 写权限那一步失败，不是你的命令） |
> | 根目录能写、`packages/**` 一律写不进（`EPERM: open '…\lib\index.js'`） | **58**（低完整性标签只挂在工作区根、子目录不继承 —— **别去修 ACL**） |
> | `git add / commit / push` 报 `.git/index.lock: Permission denied`（读命令却都正常） | **58** 症状 C（`.git/` 同样不继承标签 —— 那条 git 命令用完全权限跑，别删锁） |
> | 截图「改了代码，图一模一样」 | **38**（不覆盖同名文件 / `file://` 缓存） |
> | 右上角那枚入口量到 `null` | **32** 末尾（席位是会话作用域，先真的开会话） |
> | 改了宿主但没生效 | §3.4 + **15**（写进「等重启」清单） |
> | 改了 `src/client/shared/*.ts`（宿主与客户端**共用**的一份）：刷新页面设置页已经变了，但模型传的参数被当成「没声明过」忽略掉 | §3.4 + **§3.44**（共用文件的两个半边不同步：客户端刷新即生效、宿主**要重启**才换掉启动时载入的那份表） |
> | 「两个 id 明明是一支模型，为什么设置页 / 聊天栏里是两行」——**是故意的**，别再合 | §4 末尾（家族键 = `供应商::词干`；P43 试过合并，2.1 因此在「常用」里没了入口，用户要求回退） |
> | 给节点加了**数组**字段之后，「重复快照不再产生变更（幂等）」红了 / `resolved` 不为 0 | **81**（`sameFields` 用 `===` 比数组 = 永远「有变化」） |
> | 右键「生成信息」里参考图永远「（没有记录）」 | **82** + §3.46（参考图句柄只在生成那一刻看得到；老节点显示「没有记录」是正确的） |
> | 动了「家族键怎么算」的改动（`catalog.familyRefOf` / 词干 / 曾经的 `familyStems`）之后：设置页里某些行的「常用」勾选掉了 / 质量档不生效了 | §4 末尾（家族键 = `commonModels` / `defaultTiers` 的**存储键**，换名 = 老配置成孤儿且**静默**） |
> | 重启后宿主**再也起不来** | **37**（脚本要在宿主进程树之外） |
> | 右键出现的是**浏览器原生菜单**（自定义行为没生效 / e2e 却全绿） | **77**（contextmenu 漏 `preventDefault`；CDP 派发不开原生菜单，只能假事件守卫） |
> | 重启后 e2e 里动输入框的判据整排红（输入框可达 / 敲不进 / 大图加载不出） | **78**（本体 composer 从 textarea 变成 contenteditable DIV；顺带「落定即查大图」的时序假故障） |
> | settings namespace 重复注册报错 | **3**（`insert` 补丁不去重） |
> | 新的 JSX 事件回调报 `TS7006: implicitly has an 'any'`（事件名补上就绿） | **79**（ambient shim 的 `FfcEventProps` 没列这个事件；别给它硬注 `$types`，手写 shim 的 `MouseEvent` 非泛型） |
> | 嵌套 scope 里取不到服务 | **28** |
> | 命令在裁剪过的组合里消失 | **16** |
> | 宿主的诊断产物（`host-status.json`）被写坏 | **11** |
> | 颜色 / 对比度不对，token 名与字面意思不符 | §3.16、**14** |
> | 自己的 `--ffc-*` 变量**不生效**（整条被丢掉） | **41**（`--dsw-alias-*` 挂在 `body` 上）、**§3.39⑥**（哪些 token 能在 `:root` 求值的那张表） |
> | 要调 UI / 想知道某个 `--dsw-*` 到底是多少 / 圆形怎么被压成了方角 | **§3.39**（token 取值表 + 圆角阶 + 焦点环 + `corner-shape` 超椭圆 + elevation） |
> | 浮层压住了别人的控件 | **24**、§3.20 |
> | 改一处 CSS 却动了别处 / **复用旧类名后「按类名计数」的断言跟着红** | **35**（类名撞车：新 UI 也用新类名） |
> | 用户说「质感差 / 跟本体不一样」 | **36**、§3.31 |
> | 动画做了但「几乎看不出来」 | **40** |
> | 图标 / 细线「看着不是纯色」「发灰」「浅色主题下看不见」/ 要「实心纯色」而不是空心线稿（**静止的和动的都要**） | **72**（① 位图细线被缩没了 —— 只改颜色治不了；② 「纯色」= 实心填充，矢量化只是第一步；③ 动图那半要逐帧填面 → **73**） |
> | 解出来的 APNG 帧是**噪声**（面积还挺像）/ 填实心填完还是线稿 | **73**（忘了 inflate；补弦只看最低一行 —— 尾柄两侧收笔不在同一行） |
> | 用户给的是「动图」但播不起来 / 判断不了它是不是真动图 | **42**（先扫帧块，再决定要不要转格式） |
> | 动图内联进客户端产物后太大 / 深色主题下糊一块白底 | **43**（GIF 白底要 colorkey、按尺寸分档用动图） |
> | 无头 Chrome 里「截图两次一模一样」，怀疑动图没动 | **44**（虚拟时间不推帧动画；用真实等待 + 两次截图比对） |
> | 同一份页面，换个采样方式就得出「动了 / 没动」两个相反结论 | **70**（连采 ≥5 张、要求 ≥2 种画面，别拿两张比对下结论） |
> | 守卫改坏了还是绿的 / 文本守卫形同虚设 | **71**（reduced-motion 里抄了同名规则；`[^}]*` 撞上 `${}` 插值） |
> | SVG 图形被裁光 / 中间成了个洞 | **39**（`clipPath` 的填充规则） |
> | 中文源文件变乱码 | **1**、**27** |
> | 存下来的 JSON 读不了（UTF-16 / BOM） | **21** |
> | `Get-CimInstance` 报「拒绝访问」 | **23** |
> | 拆到某个工作区的画布「看着是空的」（节点其实在，只是不在视口里） | **85**（拆分没把视口对准这批节点的包围盒） |
> | 拆完画布上出现两块一模一样的图 / 节点重复 | **85**（拆分没按 id 去重，或从共用整块抄了一遍） |
> | 用户说「图怎么跑到别的项目里去了 / 各个项目的图混在一起」 | §3.19（作用域与拆分；共用那块永远是全部内容的备份） |
> | pnpm 装带原生二进制的包反复 EPERM | **2** |
> | 文件内容与我记得的不一样 | **13**（工作区可能被并行编辑） |
> | 视口动作之后旧坐标立刻失效 | **8** |
> | 会话 id 的 `session-` 前缀被削掉 | **9** |
> | 说「出 4 张」，模型也调了 4 次，但一张一张慢慢出（批量不并发） | **52**（工具没声明 `isConcurrencySafe`） |
> | 设置里填了张数 > 1，只落第一张图 | **52**（`n>1` 静默丢图；多张走并发调用） |
> | 设置页某个参数框填了却不生效（请求体里没有） | **52** 末尾（`specsOf` 给保留键也摆了框；P33 补第二种：预置声明了 `aspect_ratio` 这类**适配器恒定覆盖**的键） |
> | 某个模型的视频请求发出去却 400 / 静默按默认档出片 | §3.37 + **52** 末尾（那一族是 `seedance-nz` 协议：`seconds` + `metadata.{resolution, ratio}` + `images[]`，**不是**缺省那套平铺体；形状要在 `videoBody` 里加分支，不是在预置里堆键） |
> | 导出压缩包报**光秃秃的「取图失败」**（没有 HTTP 状态码）/ 点图送聊天框只插了一行地址 | **53**（远程信封没拆：`RemoteResult.value`） |
> | 导出 / 取字节报「取图服务调用失败（… `is not a function`）」 | **80**（新加的**远程方法**在运行中的旧宿主里不存在：客户端刷新即换新、宿主要重启） |
> | 导出视频被拒：「视频太大（上限 64 MB）—— 先配留档目录」 | **80** 末尾（那是**故意的天花板**：字节要 base64 过一遍 RPC；留档过的媒体是同源地址，没有这个上限） |
> | 会话日志「没有生成记录」（每个会话只解出 2 行） | **53** 末尾（多帧 zstd，只解了第一帧） |
> | `edit` 报 `file changed since it was read`（改的是 profile 的 `cordis.patch.yml`），重读再改还是报 | **75**（宿主在周期性整体重写它；用 node 同进程读改写） |
> | 摘掉 profile 层的 `insert` 后，宿主里那个插件**没有**当场消失 | **75** ① + §3.4（那一层是**增量重放**不是重建；等重启才按新组合来） |
> | `plugin_manager install_bundle` 装完，「插件不在」/ 画布不出现 | §3.4（行来自**包内** `cordis.patch.yml`；patch 空 = 装了也不出现） |
> | GitHub 的文件抓不下来（`fetch failed`），怀疑地址写错 | **54**（raw.githubusercontent 不通，走 contents API） |
> | `web_fetch` 报 `unsupported content type "application/javascript"` / 抓回来的 JSON 明显缺一截 | **54**（jsdelivr 只吃文本类；大文件改抓「带同样事实的小兄弟文件」） |
> | 测试间歇性红，红的还不是同一条（`ingested` / 账本相关） | **20**（废弃 store 的去抖写盘；新小节开头 `await drainPersistTimers()`） |
> | 「唯一出口」点不到 | **33** |
> | 用户给的「动图」看不出在动 | **42**（先扫 chunk id 验，多半是静图） |
> | 动画 / 遮罩的位置整个跑偏，造型对不上 | **42**（遮罩百分比按**元素**算，PNG 有透明边距） |
> | 要给客户端半边内联图片（或想为此装 sharp/jimp） | **43**（产物是单个 JS 模块；用无头 Chrome canvas 缩，校验放离线测试） |
> | Node 报 `ERR_AMBIGUOUS_MODULE_SYNTAX`，看着像「谁偷偷 import 了 react」 | **44**（同一 `.mjs` 里顶层 `await` 与 `require` 不能共存） |
> | **浮层 / 菜单每一项都点不动**（键盘 Enter 却是好的） | **48**（`pointerdown` 把菜单自己卸载了） |
> | MJ 图生文把一句 **`/describe`**（或「提交成功」）当描述拼进了提示词 | **64**（结果是 `prompt`，不是 `description`；判据在 `test-host.mjs` 第 14b 节） |
> | 视觉模型报「响应里没有 `choices[0].message.content`」，但配的是 MJ 端点 | **64** + §3.40（模型名要命中预置 `mj-*` / `midjourney*` / `describe*`，否则走的是 `chat/completions`；基址也别带 `/v1`） |
> | 设置页「配置密钥…」按钮是**灰的**、密钥填不进去（那行写着「未设置引用」） | §3.40 末（`apiKeyEnv` 写成空串了 —— 要有**引用名**、凭据库里没值，才是「密钥空着等你填」） |
> | 想读 apifox / 第三方 API 文档：`web_fetch` 报 `resolves to a non-public IP address`，pwsh 里 `curl` / `Invoke-RestMethod` 又全部 TLS 失败 | **§3.41** 末（本机有 Clash 代理 `127.0.0.1:7897` + node 手写 CONNECT；apifox 有 `llms.txt` 整站目录与每页 `.md`） |
> | MJ 出图「成功」了，落下来的却是一张跑到一半的**进度图** | **67**（`imageUrl` 在执行中也有值，只认 `status === 'SUCCESS'`） |
> | 第二个用例把上一条的**轮询响应**当成了提交响应（报错里「提交失败」但括号里是 `status: SUCCESS`） | **68**（`jsonResponder` 队列用完会一直回最后一条；换新队列再跑） |
> | 跑完 e2e（`e2e:settings` / `restart:verify`）**供应商少了几家、密钥变成「未配置」** | **66**（测试按 id 前缀认自己的卡片，而用户建的就叫 `custom` / `custom-2`；2026-10-05 真删过两家 + 两个密钥） |
> | e2e **全绿**，但它动的其实是你的配置（不是它自己建的供应商） | **66**（`generatedId` 也按前缀取 → 每步都在操作用户那张卡片，断言照样 PASS） |
> | e2e 全绿，但鼠标点了某个东西没反应 | **48**、**22**（合成 `click()` 与 `elementFromPoint` 都会骗过你：前者不产生 pointerdown，后者不看祖先链上的处理器） |
> | 鼠标移向「飞出来」的子面板，面板**立刻收掉**（像点不到） | **74**①（行与面板之间那条缝：`mouseleave` 先到，要用定时器留 150ms 宽限） |
> | 点一下可展开的那一行，面板**反而关掉**（悬停已经把它开了） | **74**②（悬停开的开关，点击只能「只开」，不能再做 toggle） |
> | 用户给的「动图」看不出在动 / 拿到的附件是静图 | **45**、**42**（先验帧，再决定做法） |
> | `--virtual-time-budget` 截图三张一模一样 | **47**（虚拟时间不推动画帧，先分辨是不是缓存） |
> | 自绘的「选中 / 高亮」态在**浅色主题下看不见**（深色下正常） | **49**（`bg-layer-1` 在浅色下与菜单底同为白；选中态改用勾 + 描边） |
> | settings.yaml 里慢慢多出一堆空对象（`{param:'',values:[],labels:{}}`） | **50**（schemastery 给可选嵌套对象填的默认壳；写出口要丢掉） |
> | 某个模型「看着能点却永远选不中」/ 展开之后没有「选用」按钮 | **51**（可展开的行只有一个子项 = 没有选中入口） |
> | 想在聊天消息上加按钮，但找不到「用户消息操作」席位 | **55**（keyed 席位按 priority 顶替：`priority: -1`；不带就会抛 already has an entry） |
> | 客户端的 `apply` 直接抛 `keyed slot … already has an entry for key …` | **55**（同 priority 撞车；影子条目必须写更小的 priority） |
> | 生成的图**放久了加载不出来** / 画布上的图某天变成裂图（现在会显示「图片加载失败」占位） | **56**（供应商签名地址过期，本地从没有过字节；P32 的 `archiveDir` 留档） |
> | 想改图片存储位置 / 想知道图存在哪 | **56**（附件库在 `DSH_HOME/attachments/v1`；生成结果以前不落盘） |
> | `/ffc-media/…` 的图 404 / 留档后图打不开 | **56** 末尾 + `host/archive.ts`（路由只在配了 `archiveDir` 时服务，越界一律 404） |
> | 「复制（含图）」粘到微信正常，**粘进 DSH 输入框只有文字没有图** | **57**（剪贴板写图片这条路被浏览器堵死；DSH 用「送到输入框」） |
> | `clipboard.write` 抛 `Support for multiple ClipboardItems is not implemented.` | **57**（Chrome 一次只能写一个 ClipboardItem；别再写「文字项 + 图片项」） |
> | 写剪贴板抛 `Type image/jpeg not supported on write` | **57**（可写类型白名单；`ClipboardItem.supports('image/jpeg') === false`） |
> | 点了按钮只看到「浏览器不允许写剪贴板」这类**猜的**文案 | **57**（`catch {}` 把真因吞了；失败要把异常名与原文带出来） |
> | 客户端冒烟报「设置页的 inject 面…」/ 找不到某一页 | **57** 末尾（`settings.section` 现在有两条，断言要按 `id` 找，别取「最后一个」） |
> | 测试替身算出来的字节数是 0（`File` / `Blob` 那条） | **5**（替身只认 `length`、真实 BlobPart 还有 `size`） |
> | 某个席位（聊天栏那格 / 用户消息…）**整个不见**，控制台 `slot entry crashed … React error #130` | **59**（`ambient.d.ts` 手写的导出名与真机不一致 → 图标是 `undefined`；DSH 升级改过图标名） |
> | 改了 `ambient.d.ts` 里的名字 / 想从统一基座再导入一个符号 | **59**（`build.mjs` 的 `assertBaseExports()` 会拿真机导出清单核对，构建期就报） |
> | 菜单看着像一层能看见底下正文的塑料膜（字糊在一起） | **59** 末尾（少了 `backdrop-filter: var(--dsw-menu-backdrop-filter)`） |
> | 「令牌过期了」→ 以为必须重启宿主抄令牌 | **§3.38** 末（`lib/probe-profile` 里的签名 cookie 通常还在，直接跑 e2e 就行） |
> | **某个 e2e 套件固定红、而且红的总是同一簇** | **61**（环境三件套：composer 抢焦点 / 欢迎浮层压顶栏 / profile 里没有会话。**先读这条再怀疑自己** —— P34 实测 46 条红全是环境，代码一行没坏） |
> | 点了图片节点，图被送进聊天输入框、节点纹丝不动 | **61**（composer 有焦点 = 设计如此：「光标在输入框里时点图 = 引用它」，见 `clickintent.ts`） |
> | 想给「选中 / 焦点 / 强调」挑个颜色，看着 `--dsw-alias-brand-primary` 最像 | **62**（它**逐字等于** `label-primary`，是对比色不是强调色；强调色是 `state-business-primary`） |
> | 浅色主题下小徽标 / 药丸「只剩几个字飘着」（看不出有底） | **49** 末尾（浅色下 `bg-layer-2` 也是白的；徽标底要用 `interactive-bg-hover`） |
> | 改了一处背景色，某条文字的对比度悄悄掉到门限以下 | **63**（`--ffc-well-surface` 那一档是**按对比度算过**的；唯一会喊的是 `e2e:theme`） |
> | 想动圆角 / 过渡时长，怕哪天又冒出裸值 | **63** 末尾（`test-icon.mjs` 里两条守卫会拦，已做负例验证） |
> | 给按钮加了按下缩放，结果「点了没反应」（尤其是宽控件 / 靠边缘点） | **69**①（`transform` 会把热区一起缩掉，`click` 落到祖先上） |
> | 强制 `:active` 后探针读到 `matrix(1,0,0,1,0,0)`，看着像「CSS 没命中」 | **69**②（`transform` 自己在过渡里，立刻读到的是起点；sleep 250ms 再读。`transformOrigin` 也返回 px 而不是 `left top`） |
> | 动画「好像没生效」/ 元素硬切出来，控制台却没有任何报错 | **69** 末尾（动画名打错是静默失效；`test-icon.mjs` 双向守卫会点名） |
> | 右键 / 设置**新字段写入被拒**：`Config field "X" is not volatile` | **76**（跑着的宿主还是旧 schema；重启才换模块，别去改客户端） |
> | 菜单 / 卡片里的**长文字滚不动**，一滚整个画布就缩放 | **83**（视口的 `wheel` 监听 `preventDefault` 把浮层内的原生滚动一起取消了；机制见 §3.47） |
> | 进了画布**退不出去**：右上角那枚鲸鱼尾巴不在 / 看不见 | **84**（入口是**会话作用域**席位，欢迎页整行不渲染，而画布模式是记住的；出口改成画布顶栏常驻的「返回聊天」） |
> | **所有工具全灭**，每条都回 `cannot get required service "sessionProjections" in inactive context`（重启也不一定好，一阵通一阵不通） | **86**（profile 的插件树没装全：`dsh-ops` 那个 GitHub 源的原生依赖在 npm 上不存在，pnpm install 每次都在半途失败） |
> | 画布上删错了东西想退回来 | **87**（P51 的撤销：Ctrl/⌘ + Z，或工具条那枚「撤销」；跨工作区会清空） |
>
> **维护规则**：往 §8 加条目时，**必须**同时在这张表里加一行（现象 → 条目号）。
> 表格是唯一的检索入口；缺了它，下个会话在盯着一个假故障时**不知道该读哪一条**
> —— P27 实测：§8.20 与 §8.12 都因为没有指针而白花了时间（前者约 15 分钟，
> 而修法本来已经写在文件里）。**加条目 = 加条目 + 加索引行，一步不能省。**

1. **PowerShell 5.1（不是 pwsh 7）**：没有 `-Encoding utf8NoBOM`；命令替换里别用反引号；
   单引号里的 `\n` 是字面量。**含中文的源文件只用 `edit`/`write` 工具改** ——
   `Get-Content -Raw | Set-Content -Encoding UTF8` 会先按 ANSI 解码，把整篇中文写成乱码
   （踩过一次，只能整篇重写）。控制台显示乱码 ≠ 文件坏了，用 `read` 工具确认。
2. **pnpm 的 EPERM**：本机该卷上 pnpm 的原子目录重命名有竞态，带原生二进制的包
   （如 esbuild）会反复失败；`.npmrc` 已设 `package-import-method=copy`。
3. **`insert` 补丁不去重**：bundle 层与 profile 层只能有一处插入（否则插件加载两次、
   settings namespace 重复注册报错）。
4. **断言写错比代码写错更常见**：多次「测试失败其实是断言错」（`className` 精确相等、
   围绕中心缩放时原点必然变化、共享列表累积注册、禁用态指望环境、按钮点了外接矩形角上）。
   失败时先怀疑断言 / 先怀疑测试自己。
5. **测试替身必须照实建模**：`ctx.inject` 只在依赖齐备时回调（且要支持嵌套 inject）；
   `instanceof HTMLElement` 要真实类实例；pointer capture 不能被替身绕过；
   window 上的监听器要实现（否则「装上了但没生效」不可见）。
   P32 又踩到一次同款：替身 `File` 算字节数只认 `part.length ?? part.byteLength`，
   而**真实的 BlobPart 可以是 Blob**（它只有 `size`）—— 于是「字节数」静默变成 0，
   断言报 `board.png image/png 0B`，看着像编码坏了，其实是替身少认一种形状。
   判据：**替身里每多一个「我猜的形状」，就多一处会骗你的地方**。
6. **「读太早」是测试假故障的第一来源**：去抖写盘（画布 400ms，断言持久化前先 sleep
   800）、程序化移动的 240ms 动画、React 异步渲染（探针在同一次求值里 `click()` 后
   立刻查 DOM 必然查不到）、命令结果是异步结算。**要么等够时间，要么轮询到条件成立。**
7. **点击要落在按钮中心**：圆角按钮的外接矩形左上角**命中不到**（角上那一像素在圆角外，
   事件穿到父元素）—— 曾表现为「工具条按钮点得动、米饭碗点不动」，看着像组件坏了。
8. **动作会移动视口，旧坐标立刻失效**：e2e 每步之后都要重新读坐标（「带到视野」把节点
   挪走后，后续的右键就点空了）。
9. **别把会话 id 的 `session-` 前缀削掉**（3.10.3）：无效 id 不报错，只会静默落到别的
   会话上，表现为「落图完全不工作」。
10. **复用 profile 的 e2e 必须自己种状态**：探针 profile 是复用的，上一次运行留在
    localStorage 的画布会污染下一次（`e2e-canvas` 曾因此「平移失效」——空白处的点落在
    残留节点上）。两条硬规矩：
    - **先钉住画布作用域**（2026-10-14 起默认按工作区）：不钉的话 app 去读
      **当前工作区那块**画布，于是「种下的节点一个都没渲染」，看着像组件坏了。
      公共前置常量是 `scripts/lib/cdp.mjs` 的 `PIN_SHARED_BOARD`（`goto()` 已内建，
      手写种状态的脚本要自己插），见 §8.18。
    - **用 `seedBoardExpression()` 种，别自己写 `localStorage`**：它会把**当前账本原样带进
      新种子**。因为落图有一条有意为之的规则 —— **结果够新就补落**（`INGEST_FRESH_MS` = 10
      分钟）。「同一个会话里刚跑过 `/generate`」之后，任何把 `ingested` 写成 `[]` 的脚本都会让
      那个命令节点**又落回画布**：`e2e-canvas` 报「重载后复原，实际 5 个」、`e2e-theme` 的空态
      占位根本没渲染、`e2e-p4` 数到 7 个而不是 3 个。**这不是 bug，是设计**；`e2e-scope` 那种
      「删掉所有画布键」的隔离也要**先读出账本再删**。
11. **测试会覆盖宿主的诊断产物 —— 而且「备份+还原」救不了**：导入 `lib/index.js` 就写
    `host-status.json`，而它的主人是**运行中的 dsh web**（`e2e-command` 靠它判断宿主
    是否重启、`post-restart.mjs` 靠它确认宿主换了新模块）。
    早先的做法是「导入前备份、跑完还原」，但那只在文件**本来是干净的**时候成立：
    一旦某次运行把污染写回去，之后每次「备份」都在保存污染。本轮实测踩到：
    标记里出现 `command: generate`（运行中的旧宿主根本没有命令），
    `e2e-command` 会以为命令已注册而冲进浏览器跑。
    正解：**根本不许写** —— 宿主模块认 `FFC_NO_STATUS_WRITE=1` 就跳过写盘，
    `test-host.mjs` 设这个变量。已经污染的文件**删掉**（宁可缺席，也不要错的）。
12. **JS 模板串里的 CSS / 注释不能写反引号**（`styles.ts` 整张样式表在一个模板串里，
    探针脚本的 `PROBE` 也是）：会提前结束模板串，构建报 `Invalid character` /
    `',' expected`，或 ESM 直接 `SyntaxError: Unexpected token ':'`，且不指向具体行。
    **P0–P17 期间踩过三次**（`e2e-scope.mjs` 与 `e2e-entry.mjs` 的 PROBE 注释、
    `styles.ts` 的新样式注释里都写过反引号），**P27 又踩一次**（CSS 注释里写
    `--dsw-alias-*`）。改完模板串里的注释，先 `node --check <file>` 再跑
    （`styles.ts` 用 `node build.mjs` 验）。
    **P27 起这件事有机器守卫了**：`build.mjs` 的 `assertTemplateClean` 会检查
    `styles.ts` 的模板串内部有没有反引号，**并点出行号**（探针脚本那类多模板串的
    文件不适用，仍然只能靠 `node --check`）。
    **P28 第五次复发，守卫当场接住**：新写的档位 chip 注释里带了
    `` `--dsw-alias-bg-layer-*` ``，`node build.mjs` 直接报「1574 行×2」并停下 ——
    这一次没花时间找行号（前四次都是靠肉眼翻）。**结论：改动模板串里的任何注释后，
    第一个动作就是 `node build.mjs`。**
13. **工作区可能被并行编辑**：动手前先重读文件；发现内容与自己写的不一样时，
    先理解对方改了什么再决定，不要覆盖回去（本轮就保留过别处对「白屏」的更好修法）。
14. **主题反色 token 是最容易糊的地方**（3.16）：`label-primary-inverted` 在深色下是深色。
15. **宿主改动一定要写进交接**（见 §0 的「等重启」清单）。
16. **命令服务缺席要能降级**：命令在 `ctx.commands`，与工具是两个服务；用独立的
    `inject(['commands'])` 挂命令，别塞进工具的依赖里（否则裁剪过的组合会让工具一起消失）。
17. **前缀筛选要连分隔符一起匹配**：`fatfish-canvas:board` 是
    `fatfish-canvas:board-scope`（偏好）的前缀，用它筛「画布键」会把偏好键当成一块画布
    —— 本轮 e2e 就因此报了 5 条假故障，而功能其实全对。**键空间里凡是「一个键是另一个键
    的前缀」的地方，筛选一律带上分隔符。**（同类：`gen_` / `gencmd_` 两个节点 id 空间。）
18. **一个「决定 app 读哪份数据」的偏好，等于给所有 e2e 加了一条前置条件**（两个方向都成立）：
    P7 时默认是共用，于是残留的 `board-scope=session` 让别的 e2e 种的共用画布读不到；
    2026-10-14 默认翻成**按工作区**之后，方向反过来了 —— 不钉的话 app 会去读
    `fatfish-canvas:board:<工作区>`，同样「种下的节点一个都不见」。
    处理方式不变：把前置写进公共常量（`scripts/lib/cdp.mjs` 的 `PIN_SHARED_BOARD`，
    由 `goto()` 内建，手写种状态的脚本自己插一句）。**改默认值时必须回来改这个名字**——
    它叫 `RESET` 还是 `PIN` 恰好说明了当时默认是哪一边。
19. **加菜单项会动到键盘用例的最后一项**：`e2e-p5` 的「按 End 高亮最后一项（跟焦开关）」
    在 P7 加了隔离开关之后必须改成新项（并顺手补上「Enter 真的翻开、再翻回去」）。
    加菜单项时**先搜 `End`/`Home`/最后一项这类断言**，别等 CI 红。
20. **被丢下的 store 实例不会安静**：`test-model.mjs` 每小节用新模块实例，各自带一个
    400ms 去抖写盘定时器；废弃实例的定时器会在**后面的 `await` 里**照样触发，
    把那一节的旧画布写回全局键 → 下一节 load 出来的画布莫名多出几个陌生节点
    （本轮真的出现了：3 个节点里混进两个 `n_…`，而且**间歇性**通过，最难查）。
    修法：测试自己清时间轴 —— `await drainPersistTimers()`（600ms）→ `clear()` → `load()`。
    这条属于「读太早」家族（§8.6）的**写太晚**版本。
21. **PowerShell 的 `>` 重定向会写 UTF-16LE**：把含中文的探针结果 `> x.json` 存下来
    会得到一个「二进制文件」（`read` 工具直接拒读）。`| Out-File -Encoding utf8` 又会带
    BOM。正解：**让 Node 自己写盘**（`probe-gui.mjs --json <path>`）。
22. **探针产物要按「可见的那一份」挑**：本体的 composer 在 hero 与会话态之间复用同一棵
    DOM，隐藏副本仍在文档里 → `querySelector` 先拿到 0×0 的那份，于是「点入口」点在
    (0,0)。凡是量几何，一律 `rect.w > 0` 过滤（§8.22 与 3.20.1 是同一件事）。
23. **WMI 在受限沙箱里会被拒**：`Get-CimInstance Win32_Process` 报「拒绝访问」，
    所以找端口占用者的进程要改用 `netstat -ano` 解析（`post-restart.mjs`）。
24. **加一个「常驻浮层」之前先问：这块地方是不是别人的席位？** 见 3.20：
    视口右上角是 `conversation.session.header.utilities`，被 session log 占着；
    我们钉了一个 32×32 的按钮上去，正好压住它。**能用席位（实数布局格）就别用浮层。**
25. **往密集的 flex 行里加控件必须 `flex: none`**：composer 工具行是 nowrap，
    默认 `flex-shrink: 1` 会把新控件压成 0 宽 —— 元素在 DOM 里、却完全点不到，
    探针量出来是 0×0，看着像「注册没生效」（§3.20.2）。
26. **断言「菜单开关」时要记得菜单本来就不自动关**：本插件的菜单选完一项**保持打开**
    （有意：用户常接着调），因此「切完模式再点按钮打开菜单」实际会把它**关掉**，
    那条断言就红了 —— 而按钮本身完全正常（§8.4「断言写错比代码写错更常见」）。
27. **不要用 PowerShell 读写含中文的源码**，哪怕是「只是改个字符串」：
    `ReadAllText`/`WriteAllText(UTF8 no BOM)` 这一对是安全的，但 `Get-Content | Set-Content`
    不是。本轮用前者做过一次机械替换（成功），但**优先用 `edit` / `write` 工具**。
28. **同一个服务名不要在两处 provide**：Typert 网关按名字从应用服务表解析接收者，
    嵌套 inject scope 里 provide 的服务不一定可见（§3.23.2）。做法：服务在**插件顶层**
    provide，行为用 holder 在依赖就绪后接入。
29. **`test-host.mjs` 读的是 `lib/` 产物**：改了 `src/` 不 `node build.mjs` 就测试，
    你会得到「我明明改了文案，测试还报旧文案」的假故障。**改宿主先构建**。
30. **种子被 stringify 两次 = 空画布**：`SEED` 在各 e2e 里已经是 `JSON.stringify(...)`
    的**字符串**，再 `JSON.stringify(SEED)` 就会写进「一个 JSON 字符串」→ store 反序列化
    出字符串（`typeof !== 'object'`）→ 回退成**空画布**，症状是「种下的节点一个都不见」。
    本轮在 `e2e-theme` 与 `e2e-scope` 各踩一次。`seedBoardExpression()` 现在会顺手
    拆一层做防御，但调用方请直接传 `SEED`。
31. **`nodeCount` 那种「读一次就算数」的断言在共享画布上必然翻车**：e2e 复用同一个
    探针 profile、同一个宿主会话，画布内容会随上一个套件与最近生成漂移。
    要么按**基线增量**断言（本轮 `e2e-command` 改成「新增 ≥1 个」），
    要么按 **id 存在性**断言（`includes('kept')`），**不要**断言绝对个数。
32. **删一个菜单会连带打断多个 e2e 套件**（P10 实测）：`e2e-p4` / `e2e-p5` /
    `e2e-scope` 都靠「点菜单项切模式 / 翻开关」，`e2e-theme` 还把菜单里的元素
    当对比度目标。删菜单不只是删 UI —— 先把 `grep` 跑一遍（`.ffc-view-btn`、
    `.ffc-menu-wide`、`.ffc-menu-chip`），把断言改成点**真实控件**，并重跑。
    另外：`e2e` 里凡点右上角那枚入口的断言，都必须**先真的打开一个会话**
    （席位是会话作用域），否则拿到的是 `null` 而不是「失败」。
33. **「唯一出口」不能住在会被自己收起的子树里**：纯画布收起了整列聊天，
    右上角那枚米饭碗跟着不可见 —— 所以纯画布的出口必须是顶栏上那格常驻按钮
    （或 Esc）。这条与 §8.24 / 3.13 是同一个道理：**出口自己不能是会被隐藏的东西**。
34. **`grep` 定位 `[class*="ffc-"]` 时别把子元素算成第二个控件**：`.ffc-entry`
    里的 `<span class="ffc-entry-text">` 也带 `ffc-` 前缀，「右上角只有一个本插件
    元素」这类断言要**只数顶层**（祖先里没有 `ffc-` 的那些），否则一个按钮被数成两个。
35. **改 CSS 时新类名可能与别处撞车**：P17 第一版往工具条加的那格用了
    `.ffc-model-menu`，而设置页的「模型行右键菜单」用的**就是**这个名字（`.ffc-menu
    .ffc-model-menu`）—— 于是顺手把设置页的菜单改成了 300px/可滚动。改样式前
    **先 grep 一遍类名**（`Select-String -Path src\client\styles.ts -Pattern 'ffc-x'`），
    或者干脆给新功能一整块独立前缀（本轮最终用 `.ffc-mp-*`）。
    **P29 又踩了同一条的另一半：复用「看起来一样」的类名会连带撞掉按类名计数的断言。**
    常用模型那一行的种类徽标本来直接用了 `.ffc-set-kind`（配色确实一样），
    于是 `verify-client` 里那句「种类以中文徽标呈现」由 3 个变成 5 个 —— 断言红，
    而功能完全正常（属于 §8.4 的假故障）。判据：**给新 UI 用新类名，哪怕样式完全一样**
    （`ffc-cm-kind` 复制那几条规则，代价是三行 CSS，收益是别人的断言不被你改动）。
36. **用户说「质感差」时，先问「本体用的是哪一批数值」**：见 §3.31 —— 第一方客户端的
    `lib/client.js` 里连 CSS 字符串都是可读的，照抄一遍就与本体现成的一致；
    照着截图调字号/字重/圆角是**猜**，猜错的代价是再来一轮。

    **P34 补充：照抄是一次性的，本体升级后你那份「抄来的数值」会悄悄过期。**
    本轮对着 `dsh-client-ui-model-selection/lib/client.js` 复核，发现插件里三处
    「抄自本体」的数值已经不是本体现在那一版了：

    | 位置 | 插件里（抄写当时） | 本体现在 |
    |---|---|---|
    | `composer` 触发器形状 | `border-radius: 24px` 胶囊 + `font-weight: 500` | `--dsw-radius-sm`（8px）+ `font-weight: 400` |
    | 菜单行 | `min-height: 38px` / `padding: 6px 8px` / 圆角 10px | `34px` / `5px 7px` / `--dsw-radius-md` |
    | 模型名 | `14px / 500 / 20px` | `13px / 400 / 18px` |

    代价正是最难指认的那种：**两者并排挂在同一个 composer 行上**（本体的「对话模型」
    就在这个菜单左侧一格），一个圆一个方、一个粗一个细 —— 用户说不出哪里不对，
    只会说「质感差」。而且 tsc / 单测 / e2e 全绿，没有任何判据会喊。
    **判据（什么时候该复核）**：① 本体升级过（尤其改了 `dsh-client-ui-*` 版本）；
    ② 用户说「跟本体不一样」；③ 动过 `ambient.d.ts`（§8.59 同一类：手抄本体接口）。
    复核方式就是重读那份 `client.js` 里的 CSS 字符串，逐个数对齐 —— 十分钟的事。
37. **在会话里重启宿主，脚本必须脱离宿主的进程树**（2026-09-25 实测）：`post-restart.mjs`
    靠 `taskkill /PID <宿主> /T /F` 收掉旧宿主，而 `/T` 杀的是**整棵树** —— 脚本自己如果是
    宿主的后代，会被自己那一下一起带走，`spawn('cmd.exe', …'dsh web')` 永远执行不到。
    后果是最坏的组合：**宿主被杀、没人把它拉起来**（页面直接断，只能人工开终端救）。
    正解：用 `Start-Process` 起它 —— 父进程 `pwsh` 立刻退场 → 脚本被孤儿化 → 不在树里：

    ```powershell
    Start-Process -FilePath (Get-Command node).Source `
      -ArgumentList @($script, '--delay', '30000') -WorkingDirectory $pkg -PassThru
    ```

    实测：脚本 PID 与宿主 PID 不是父子关系（宿主 18016 / 脚本 25696，脚本父进程是那个
    已经退场的 `pwsh`），30 秒后 `taskkill` 成功、端口自行恢复，`lib/host-status.json` 的
    `at` 变成重启后的时间 = 新宿主确实上任了。

    连带事实：`fafb415` 版脚本用 `spawn(..., {stdio: 'ignore'})` 起宿主，**令牌不会落盘** ——
    重启后 `lib/web-url.txt` 仍是旧的（实测 401），必须手动在终端起一次 `dsh web`
    才能从它的输出里拿到带令牌的 URL。
38. **无头 Chrome 截图有两个静默陷阱**（做 `preview:icon` 时连踩两次，症状都是
    「改了代码，截出来的图一模一样」）：
    - **`--screenshot=<path>` 不覆盖已存在的文件**。同一个目标路径第二次跑会安静地
      留着上一张图。做法：每次写到带时间戳的新名字，再 `copyFile` 成固定名。
    - **`file://` 页面会被缓存**，连 `?时间戳` 查询串也不一定绕开（实测无效）。
      做法：**页面文件名也带时间戳**。
    排查口诀：图没变时先量 **PNG 的哈希 / 修改时间**，别怀疑自己的 CSS ——
    本轮为此白查了半小时「米饭为什么不见了」，其实一直是看的旧图。
39. **SVG `clipPath` 的填充规则与 `evenodd`**：把一条 **evenodd 双线**的路径（比如
    「碗壁」：外轮廓 + 内腔）直接当 `clipPath` 用，会被 clip 的 **nonzero** 规则读成
    「中间是洞」，**把碗里的一切裁光**。要么给 `clipPath` 里的路径也加
    `clip-rule="evenodd"`，要么（更省事）**单独留一条单闭合的内腔路径**给裁剪用。
    另一头：一个形状要「被容器装住」，得**真的落在容器的裁剪区里** —— 把冒尖的米饭
    整个画在碗沿**以上**，看着没问题，实际全在裁剪区外（见 §8.38 的假故障）。
40. **动画要「看得见」，得先确认变化量落在肉眼能分辨的范围内**：给米饭碗做「饭逐渐
    减少」时，先做的是「米堆下沉、`clipPath` 露出碗沿以下的部分」——读代码很对，跑起来
    几乎不动。原因是米堆的弧远宽于碗口，**被裁成一个定宽横条**，下沉时露出的宽度不变；
    真正变的只有「弧顶离开碗沿」的最后一小段。改成「整碗内容物（饭 + 浮在饭上的鲸鱼）
    一起下沉」才一眼看得见。教训：**动画参数好不好，只能靠逐帧图（胶片条）判断** ——
    `npm run preview:icon` 就是干这个的（把一整循环铺成一条）。
41. **`--dsw-alias-*` 挂在 `body` 上，不是 `:root`**：自己的别名变量若写成
    `:root { --ffc-x: var(--dsw-alias-…) }`，它会在 `html` 上求值 —— 那时 `body` 上的
    token 还不存在 → 整条 custom property 变成「保证无效值」→ 用它声明的一切
    （border-color / background…）**静默**退回 initial（border-color 就是 currentColor）。
    根因：**自定义属性里的 var() 是在「声明它的那个元素」上替换的**，不是在使用处。
    所以这类别名要声明在 `body` 的**后代**上（P27 把 `--ffc-select-line` 放在
    `.ffc-viewport` 上）。
    顺带一条同源事实：`--dsw-alias-bg-multi-select` 在**深色**主题下是**不透明**的
    `neutral-850`（浅色主题才是半透明色）—— 拿它当框选填充会把底下的图整个盖住
    （P27 用户报的「选框挡住图片」就是它）。
42. **用户给的「动图」可能是静态的，先验再动手**：用户给了一张 `.gif` 与一张 `.png`，
    说「用这两张图替换动画和图标」。「动图」那份经规范化后是 **WebP**，而它的 RIFF
    chunk 列表里**只有 VP8X / ALPH / VP8，没有 ANIM / ANMF**；PNG 里也没有
    acTL / fcTL —— **两张都是静图**。判断只要十行代码（扫 chunk id），比猜快得多。
    于是「渐进动画」只能由 CSS 做：造型来自成图，就用 `clip-path: inset(top 0 0 0)`
    从上往下吃掉。**别用 `mask` 从下往上抹**：遮罩的百分比是按**元素**算的，而 PNG
    上下各有约 12% 透明边距，算出来的位置整个跑偏（实测把碗身抹掉了，看着像碗碎了）。
43. **给客户端半边内联图片资源，本机没有现成的工具链**：DSH 客户端插件的产物是一个
    JS 模块，图片要么内联 data URI、要么自己去服务静态文件（没有这个口子）。原图
    1152×976 / 1.0MB，而图标最大用法 28px —— 直接内联等于每次加载多背 1MB。
    做法：**用无头 Chrome 的 canvas 缩放**（本机没有 sharp/jimp，也不该为这个装一个），
    缩到 256 宽约 50KB，`scripts/make-art.mjs` 把结果写成 `src/client/generated/art.ts`。
    产物把关放在**离线**测试里（`test-icon.mjs` 查 PNG magic / 宽高比 / 体积），
    这样 `npm run check` 不需要 Chrome 也能守住这条线 —— 别把校验塞回那个必须
    Chrome 的生成脚本里（否则门禁要么跑不了、要么每次都得放宽沙箱）。
44. **Node 24：一个 `.mjs` 里同时出现顶层 `await` 与 `require()` 会直接报
    `ERR_AMBIGUOUS_MODULE_SYNTAX`**（`require` 由 `createRequire` 来也算）。症状是
    报错指向 `require("react/jsx-runtime")` 那行，看着像「谁偷偷 import 了 react」，
    其实是模块格式判定失败。做法：把主流程包进 `async function main()` 再调用。
    顺带两条同源的转译坑（`scripts/preview-icon.mjs` / `test-icon.mjs` 直接执行
    `.tsx` 源码取字符串函数时会撞上）：
    - `ts.transpileModule` 只要给了 `jsx: ReactJSX`，**即使代码里没有 JSX** 也会补一行
      `require("react/jsx-runtime")` —— 本包不装 react，于是当场炸。别给这个选项。
    - 执行时喂一个「会喊的 `require`」（抛异常并带上模块名），比让它在别处静默失败好查。
45. **用户给的「动图」先验帧，再决定做法**（承接 §8.42：那次附件被规范化成了**静**
    WebP，于是我以为他手里也是静图）。这次用户把**原始 GIF 放进工作区**，一验就是
    **78 帧 / 70ms / 5.46s / 无限循环**的真动图 —— 演的就是「饭被一口口吃掉」。
    验帧只要看 GIF 的块结构：`0x21 0xF9`（GCE，一帧一个）、`NETSCAPE2.0`（无限循环）、
    第 10 字节的 packed 位（有无全局色表 + 色表大小）。**别靠猜、也别只靠附件的规范化
    产物**：它会把动画压成静图，让你对着一个不会动的东西设计动画。
46. **GIF 内联进客户端产物：白底必须抠掉，而且别在小尺寸上用**
    （`scripts/make-art.mjs`）：
    - **白底不透明**：GIF 没有 alpha，直接内联会在深色主题下糊一块白方块。
      做法：`ffmpeg -vf colorkey=0xFFFFFF:0.30:0.10,scale=200:-1` → `libwebp_anim`
      （动图 WebP 支持真透明，体积也比 GIF 小）。**先在一张棋盘格背景上截图确认**，
      别只看白底页面上的效果 —— 白底页面上抠没抠掉根本看不出来。
    - **体积**：400×300 / 78 帧的 GIF 是 1.8MB，转 200 宽 / q35 后仍有 470KB
      （base64 639KB）。所以 **只有 `generating` 且 ≥ 24px 才用动图**（`RICE_ANIM_MIN`）：
      工具行 14px 那枚看不出动的细节，为它背 639KB 不值。尺子：
      `lib/client.js` 因此从 464KB 长到 1.12MB。
    - **格式守卫**：动图 WebP 合法时会带 `ANIM`（全局参数）+ `ANMF`（每帧）+
      `ALPH`（透明）块；转成静图就只剩 `VP8X/VP8`。把这三条写进离线测试
      （`test-icon.mjs`），比肉眼看「它怎么不动」快得多。
47. **无头 Chrome 的 `--virtual-time-budget` 不推动画帧**：验证「动图到底动没动」时，
    同一个页面用 200ms / 3000ms / 5000ms 三个虚拟时间预算截图，**三张字节完全相同**
    —— 差点误判成「转换失败、出来是静图」。帧动画（GIF / 动图 WebP）等的是**墙钟**，
    虚拟时间只推定时器与网络。做法：`--timeout=<ms>` 真实等待，然后**比对两次截图的
    哈希**（不同就是在动）。这条与 §8.38 是一对：那两条讲「截图没变可能是缓存」，
    这条讲「截图没变可能是虚拟时间不动画」—— 先分辨是哪一种，再改代码。
48. **`pointerdown` 里卸载掉「自己的后代」的浮层 = 那个浮层的每一项都点不动**
    （P5 起潜伏到 P27，用户报「这个页面的功能键都用不了」才暴露）：
    `<NodeMenu>` 是 `.ffc-viewport` 的 **DOM 后代**，而视口的 `onPointerDown` 第一件事
    就是 `setNodeMenu(null)` —— 它在「这是不是控件」那道闸**之前**执行。于是真按下鼠标
    时菜单在 **pointerdown 阶段就被卸载**，随后的 `click` 没有可派发的目标（浏览器会把
    click 派给最近的、仍在文档里的祖先）→ **所有菜单项的 `onClick` 都不触发**；
    而 ↑↓ + Enter 完全正常（键盘不经过指针事件）。
    修法：控件判定里加上 `.ffc-menu`，**只在「不是控件」时才收起菜单**。
    ⚠️ 这条真正贵的地方是**为什么 45 项 e2e 全绿却没抓到**：`e2e-p5` 执行菜单项用的是
    合成 `b.click()` 与键盘 Enter —— 两者**都不产生 pointerdown**。
    教训：**「用户靠鼠标点」的路径，e2e 就必须真的发鼠标事件**
    （`Input.dispatchMouseEvent`；本轮补了 `5b` 一节）。合成 `el.click()`
    能过只证明 `onClick` 绑对了，**证明不了这条路径真的可达**。
    **同一族的另一半**（P9 就踩过，最容易忘）：合成事件不只漏 `pointerdown`，也漏**失焦** ——
    React 把 `onBlur` 委托在原生 **focusout** 上，而
    `dispatchEvent(new Event('blur', {bubbles:true}))` **不会**触发它（原生 blur 不冒泡）。
    症状特别阴：**界面回显是对的**（那是组件草稿），宿主读到的却是空值 ——
    设置页的「测试连接」因此报「这个供应商还没有填接口基址」。
    正解：`el.focus()` + `Input.insertText`（真 input 事件）+ 点别处造成**真实失焦**。

     **P39 补充（同一个坑的第三种长相：飞出面板）**：模型选择那格的档位面板是
     **独立的一块浮层**（跟菜单做兄弟，理由见 §3.43①②）—— 它不在菜单 DOM 里，于是
     `useMenuDismiss` 若只认菜单那个 ref，**点面板里的档位就会被判成「点到外面」**：
     pointerdown 先卸面板、click 没有目标，整块面板看着能点却点不动。
     修法不是给面板开例外，而是**让两者共用一层容器**（`.ffc-mp-layer`）并让
     `useMenuDismiss` 认那一层（`role="menu"` / 焦点 / 键盘也一起挂在那一层，
     `aria-activedescendant` 因此仍指向同一棵树里的条目）。
     判据落在 `e2e-picker.mjs` 第 7 节：**在面板里真按下鼠标**
     （`Input.dispatchMouseEvent`）→ 菜单关上 + 设置没被改动。这条判据是必需的 ——
     本轮若只断言「面板出现了 / 每行都命中」，这个坑照样漏过去（§8.22：
     合成 `click()` 与 `elementFromPoint` 都会骗过你）。
49. **别拿 `--dsw-alias-bg-layer-1` 给「选中态」做填充**（P28 写档位 chip 时躲掉的）：
    浅色主题下 `bg-layer-1` 与 `bg-layer-3` 是**同一个白**（实测 token：
    light 两者都指向 `neutral-bluish-00`；dark 才是 `875` / `800`）。菜单的底色是
    `--dsw-specific-menu`（缺省回落 layer-3），于是深色下看起来「内凹、像选中」，
    浅色下**整个看不见** —— 而开发时多半只在一个主题里看，所以这是最容易漏的一类。
    做法：选中态用**勾 + 亮字 + 一圈 `--dsw-alias-border-l3`**（描边在两种主题下都
    与底色有差），填充只保留 `interactive-bg-hover` 这一种（半透明叠加，两头都安全）。
    同类坑见 §3.16 与 §8.14；**新写一个「选中/高亮」样式时，两种主题都要过一眼**。

    **P34 补充（同一个坑的第二个面：不只是「选中态」，凡是拿 layer 当「底」的地方都中）**：
    清点全站时发现**六处**拿 `bg-layer-2` 当小徽标 / 药丸的底（`.ffc-badge`、`.ffc-set-kind`、
    `.ffc-cm-kind`、`.ffc-set-tierstate`、`.ffc-tool-badge`、`.ffc-msg-extra`）——
    浅色下那全是白，于是「4 节点 · 选中 1」「共用画布」这些读数在工具条上**只剩几个字在飘**，
    深色下却看着挺正常（layer-2 比 bg-base 亮一档）。同一个文件里 `.ffc-mp-chip` 早就写过
    这条教训，但只修了那一处。做法：小底一律用 `--ffc-chip-surface`（= `interactive-bg-hover`，
    半透明叠加，两套主题都有底）。**判据：只看浅色主题截图，凡是「徽标/药丸看不出有底」就是它。**
    另外「压在深色遮罩（`.ffc-node-bar` 那种）上的按钮」也属于这一类：主题的
    `interactive-bg-hover` 在浅色下是**深色**叠加（`#2631480f`），压在黑遮罩上等于没反馈 ——
    挂在遮罩上的 hover 一律用白色叠加（`--ffc-scrim-hover`）。
50. **schemastery 的可选嵌套对象会解析出「空壳」而不是 `undefined`**（P28 实测）：
    `tiers: Schema.object({ param: Schema.string().default(''), values: Schema.array(...).default([]), labels: Schema.dict(...).default({}) })`
    这样声明之后，**没有配 `tiers` 的模型读出来也是** `{ param:'', values:[], labels:{} }`。
    两头都要防：读取方按「解析不动 = 没有这条轴」判（`parseTierAxis` 见空 `param` 就
    返回 undefined），**写入方必须把空壳丢掉**（设置页的 `cleanModel`），否则每存一次
    模型就往 `settings.yaml` 里塞一坨空对象 —— 而且它不会被任何断言抓住，只会慢慢变脏。
    判据：**凡是在 schema 里新增嵌套对象字段，先 `MediaGenerationSchema({...})` 打一次
    真实解析结果**（本轮就是这么发现的），别照着字段名想当然。
51. **「可展开的行」只有一个子项时，等于没有选中入口**（P29 用户报的「展开挡住了选择
    使用此模型的按键」）：家族行（`ffc-mp-family`）是**展开开关**（点它=展开，不是选用），
    成员行才是「用这个模型」。而 P28 写过一条优化 —— `row.options.length > 1` 才渲染
    成员行（理由「只有一个成员时不必再列，家族行本身就是它」）—— 于是**带质量轴的
    单一成员家族**（内置预置匹配上的模型大多如此）展开后只剩一排质量 chip：
    模型永远选不中，chip 点了也只写 `defaultTiers`。
    修法两处一起（缺一条都还是半截）：① 成员行**总是**渲染，只有一个成员时那一行
    「默认」就是「用这个模型、不动档位」；② 点档位 = 同时写档位**和** `defaultImage`
    （`setTier(kind, family, value, ref)` 两个 op **一次** mutate —— 分两次写会在中间
    失败时留下「档位换了、模型没换」）。哪一档选哪个成员由纯函数 `familyTarget` 定
    （当前默认在家族里就用它 → 否则不带尾缀的基名 → 否则第一个），4 条用例钉着。
    教训：**一个控件不能既是开关又是选择器**；做「省一行」的渲染优化前先问
    「省掉的那一行，是不是某个动作的唯一入口」。这类缺陷**离线渲染测不出来**
    （菜单在 portal 里、替身渲染不到），所以判据要落在纯函数与真实 GUI 上。
52. **「批量生成」串行、以及 `n>1` 静默丢图**（P30 把这两件事一起收掉）：
    - **串行的原因不在我们的代码里**：工具没声明 `isConcurrencySafe`，调度器按
      `exclusive` 跑（起步要求 `inFlight.size === 0`）—— 模型一条消息里发 4 个
      `media_generate`，实际是一个接一个。判据：离线测试里用「慢 fetch + 同时在飞
      计数」，`peak` 必须 > 1 且 ≤ 闸门上限。**只断言「4 个调用都成功」是抓不到的**
      （串行也会全成功）。
    - **`n>1` 是静默丢图**：请求体里 `n:2` 会让网关出两张，而适配器只读
      `data[0]` —— 另一张**花了钱、没进画布、没有任何提示**。两处各写一份保留键
      清单（`modelPresets` 那份漏了 `n`）正是它活下来的原因：设置页的质量轴不让声明
      `n`，宿主那条「其他参数」的路却照收。现在只有一份清单（`catalog.RESERVED_PARAM_KEYS`），
      `n` 在设置页与请求体里都不再出现，多张只走并发调用。
    - 顺带：设置页原来会给「存过的保留键」也渲染一个输入框（`specsOf` 不看合法性）
      —— 一个**填了永远不生效**的框。同类「UI 摆出一个到不了后端的控件」都要按这条查。
      P33 又撞上这个形状的第二种：**声明了一个宿主恒定会覆盖的键**。缺省那套视频请求体是
      `{…, ...model.params, ...request.params, aspect_ratio}` —— `aspect_ratio` 排在
      **最后**，而工具参数默认就有值（视频 `16:9`），所以在预置里声明它只会多一个
      填了不生效的下拉。判据是**这个键在适配器里排第几**：排在 `...model.params` 之后的，
      预置声明它都是白搭（`duration` / `resolution` 排在它前面，才值得声明）。
      P33 的 `minimax-h3` 走的是另一条出路：它的网关协议**本来就**不一样，于是给
      `videoBody` 加了 `wire: 'seedance-nz'` 分支 —— **形状不对时改形状，别在预置里堆键**
      （比例在那个分支里就真的生效了，见 §3.37）。
    - ⚠️ 反过来说：**别为了让 `n` 生效去改适配器返回多张**。一条调用对应一个
      `callId`、一个画布节点（幂等键），多结果要改节点 id 方案 + meta 形状 + 命令文本
      格式；而并发调用已经把这件事做完了，两套机制并存必然漂移。
53. **取图失败：远程结果的字段读在了信封上**（用户报的「批量导出 4 张，压缩包显示
    取图失败」；P27 起潜伏，P30 才被用户撞上）：
    - **现象与判据**：菜单里那句提示是**光秃秃的「取图失败」**（没有 HTTP 状态码）。
      这一句只在 `raw.message` 为 undefined 时才会出现 —— 而宿主那条路成功时
      `message` 一定有值。**「取不到」和「读错了」由这一点区分**：
      带状态码 = 宿主真去取了、失败了；光秃秃 = 我们根本没读到宿主的结论。
    - **根因**：`remote.mediaProbe.fetchImage()` 结算的是 `RemoteResult`
      `{ok:true, value:{ok,message,dataUrl}}`（§3.23 第 3 条），而 `exportImages.ts`
      与 `CanvasStage.tsx` 直接读 `result.dataUrl` → undefined → 落到兜底文案。
      同一个 bug 的第二个症状：**「点画布图 → 送进聊天框」不会变成附件**，
      只会插一行地址（那条 `else if (typeof raw.message === 'string')` 也永远不成立）。
      设置页的 `runProbe` 一直是对的（它拆了信封），所以「测试连接能用、导出不能用」
      这个组合本身就是判据。
    - **怎么一次定位**（比读代码快）：先证明**宿主那边没问题** —— 从工作区直接
      `fetch` 那几个图片地址（`host/probe.ts` 就是纯 GET、不带任何头）：
      实测 4 张全是 `200 / image/jpeg / ~700KB`，于是「取不到」被排除，只剩「读错了」。
      图片地址从哪来：会话日志里有（`~/.dsh/sessions/<工作区>/session-*.jsonl.zstd`）。
    - ⚠️ **读会话日志的坑**：它是**多帧** zstd（一次追加一帧，686KB 里有几千帧），
      `zstdDecompressSync` 与 `createZstdDecompress()` **都只解第一帧** ——
      每个会话都只剩 2 行（会话头），看起来像「日志里没有生成记录」。
      做法：按帧魔数 `28 B5 2F FD` 切候选起点，对每个起点解它那一帧
      （解不出来就是撞上压缩数据里的假魔数，跳过）。
    - **修法与守卫**：拆信封的逻辑收进纯函数 `unwrapFetchedImage`
      （`client/shared/probe.ts`），调用点只剩 `fetchImageViaHost`
      （`client/index.tsx`）；`test-model.mjs` 里既钉纯函数（信封成功 / 信封失败 /
      业务失败 / 裸值 / 坏形状），又钉**结构守卫**（两个调用点必须走那个入口、
      不许出现 `probe.fetchImage(`）。教训与 §8.52 同一条：
      **一个判断有两份副本，就一定会有一份是旧的**。
54. **raw.githubusercontent.com 在本机不通，但 api.github.com 通**（P31 查参考项目时踩的）：
    `web_fetch` 与 `node fetch` 打 `raw.githubusercontent.com/...` 都是
    `TypeError: fetch failed`（DNS / 代理层挡掉了），而 `api.github.com` 正常 200。
    因此「读一个 GitHub 仓库的文件」要改走 **contents API**：
    `GET https://api.github.com/repos/<owner>/<repo>/contents/<path>` →
    返回 JSON 里的 `content` 是 **base64**，本地 `Buffer.from(content,'base64')` 解回来即可。
    目录树用 `.../git/trees/<branch>?recursive=1`（注意：大仓库的响应会被截断，
    要按路径前缀挑，别指望一次拿到全部）。
    同类判据：**「工具抓不下来」不等于「这个地址不存在」** —— 换一条通路再试一次，
    比回头怀疑自己写的 URL 划算（本轮就是这样才拿到参考实现的请求格式）。
    P33 又补了三条（同一个仓库、同一类问题）：
    - **jsdelivr 能当镜像**：`https://cdn.jsdelivr.net/gh/<owner>/<repo>@<branch>/<path>`
      对 `.md` / `.json` 一律 200（README、`docs/workflows/*.json` 都是这么读到的），
      **但 `.js` / `.ts` 会被拒**：`unsupported content type "application/javascript"`。
    - **contents API 有体量上限**：抓 `backend/src/providers/seedanceNz.js`（283KB →
      base64 377KB）只回来约 100KB 就截断了（`ConvertFrom-Json` 当场失败）。
      **大文件不要硬抓**，去找「带同样事实的小兄弟」：这轮要的是 `minimax-h3-ow-*`
      的参数表，它既在 283KB 的 provider 里、也在 83KB 的 `src/providers/models.ts`
      里，抓后者一次就够（`git/trees?recursive=1` 同理，只回来了前 361 个 blob）。
    - **别用 PowerShell 读这些临时 JSON**：`Invoke-WebRequest` 与 `curl.exe` 在本机
      都栽在 schannel 上（`SEC_E_NO_CREDENTIALS`），`Get-Content` 读 UTF-8 又是 GBK
      乱码（§8.1）。抓取一律走 `web_fetch`，落地的临时文件用 `read` / `grep` 工具看。
55. **聊天席位可以「按 priority 顶替」本体条目 —— 这是平台承认的机制，不是 hack**（P32 加
    「复制（含图）」时挖出来的）：
    用户要的按钮长在**用户消息**上，而平台**没有**「用户消息操作」席位
    （`conversation.chat.assistant-actions` 只喂 assistant 的回合尾）。真正的出路在
    插槽注册表本身（`dsh-web-frontend/dist/assets/index-*.js` 里的注册表实现）：
    - 注册表按 **priority 升序**排序（`entries.sort((a,b)=>priority(a)-priority(b))`），
      而 keyed / single 席位取**同 key 的第一个**（`entriesOfSlot`）→ **更小的 priority
      盖住别人的条目**。注册表自己的报错文案就写着：
      `register at a different priority to shadow it (lowest renders)`。
    - 不写 priority（= 0）与本体撞车时**直接抛**：`keyed slot "…" already has an entry
      for key "user"` —— 那会让整个客户端插件的 `apply` 失败，所以 `test-model.mjs`
      里钉了一条结构守卫（`index.tsx` 的 user 条目必须带 `priority: -1`）。
    - 顶替**不等于**要重写全部：席位 owner 面里带着本体的 `renderMessageImages`
      （图片组 + 大图预览）与 `loadImage`（附件 → 显示 URL，带 `peek` 同步缓存），
      因此我们只写「文字气泡 + 调它 + 自己的按钮」，图片仍走本体的渲染器。
    - 代价写在 `client/chat/UserMessageCopy.tsx` 文件头：本体的哈希类名拿不到，样式
      是自己的一套（同一批 DSH 变量，观感接近但非像素级相同）；本体以后给用户消息
      加的新装饰不会自动出现在影子渲染器里。
56. **生成结果此前**没有任何**本地副本 —— 供应商的签名地址是唯一来源**（P32 回答用户
    「图放久了加载不出来」时核实的事实）：
    - **用户附的图**（贴进输入框 / 拖进画布）走平台附件库：`DSH_HOME/attachments/v1/`
      （`objects/<sha 前 2 位>/<sha256>` 是图像、`files/`+`file-objects/` 是原样文件、
      `request-images/` 是给模型请求用的缓存）。**内容寻址、只读、不会过期**。
      `DSH_HOME` 默认 `~/.dsh`，可用环境变量或 attachment-local 的 `dshHome` 改 ——
      但那是**整个家目录**（会话 / 凭据 / 设置一起搬），旧对象不迁移就 404。
    - **生成结果**（`media_generate` / `/generate`）此前**一个字节都不落盘**：宿主把
      供应商回的 URL 原样写进 `presentationMeta`，聊天与画布都拿它当 `<img src>`。
      中转站回的是签名 OSS 地址（TTL 常见 24 小时～几天）→ 到期后浏览器加载不出来，
      而本地从来没存过。**这不是浏览器缓存问题，是源头地址死了。**
    - P32 的修法：设置里配 `archiveDir`（空 = 关）→ 宿主在生成成功那一刻把字节抓到
      本地、结果地址换成 `/ffc-media/<日期>/<时刻>-<模型>-<随机>.<ext>`，聊天 / 画布 /
      导出 / 参考图全部指向本地副本；远端地址留在 `remoteUrl` 里备查。
    - 浏览器要显示本机文件，就得有个**同源地址**：`ctx.webServer.register({kind:'prefix'})`
      注册 `/ffc-media/…`，并用 `ctx.connection.requestRejection(req)` 过
      Host/Origin 栅栏 + 会话 cookie（`dsh-host-open-in-app` 就是这条写法的现成样板）。
      少了那道闸门，浏览器里任何页面都能靠 DNS rebinding 读这个目录。
    - **2026-10-20 复验（P52）**：10-18 那批 `webstatic.aiproxy.vip/...` 现在**全部 404**；
      留档目录只有 **10-18 13:07 之后**的 8 张，`/ffc-media/…` 在 Node 与无头浏览器里
      都是 `200 image/png`。这两条对照就是判据 —— 别再怀疑画布或浏览器缓存。
      画布对失败的 `<img>` 现在显示「图片加载失败 / 原图链接可能已过期」（`NodeCard`
      的 `ImageView`），不再是一块空白；**留档之前生成的图救不回来，只能重新生成**。
57. **「复制（含图）」微信能粘、DSH 输入框粘不到图 —— 而且这条路根本走不通**（P32 用户实测 + 探针）：
    - **微信 / 飞书正常** → 说明写出去的 `text/html`（图内联成 `data:`）是对的；
    - **DSH 输入框里只有文字** → DSH 的粘贴处理器只认文件 item（读了
      `dsh-client-ui-conversation` 的 `PASTE_COMMAND` 源码才确认）。
    - 第一版修法是「加一个按钮，往剪贴板写 `text/plain` + 每张图一个 `image/png`」，
      **用户点了直接报错**。我当时的兜底文案是「浏览器不允许写剪贴板（需要 https /
      127.0.0.1 且页面在前台）」—— **猜的，而且猜错了**。
    - 真因靠**无头 Chrome 探针**逼出来（写法：127.0.0.1 起个 http 页 +
      `Browser.grantPermissions` + `Page.bringToFront`，把几种写法的真实异常逐个打出来）：
      `NotAllowedError: Support for multiple ClipboardItems is not implemented.`
      —— **Chrome 一次只能写一个 `ClipboardItem`**；而且系统剪贴板只能放一张图。
      顺带证实 `ClipboardItem.supports('image/jpeg') === false`（写 jpeg 必抛）。
    - 修法：DSH 那条**不走剪贴板**，改 `sendMessageToComposer` —— 文字插进输入框、
      每张图经合成 drop 变成真附件（复用平台附件管线）。张数不限、动图不掉帧。
    - 三条教训：① **兜底文案不能替代真因**（`catch {}` 把异常吞了，等于把下一次
      诊断的成本留给自己）；② 「在我们这边看起来成功了」不等于「对面收得到」；
      ③ **能探就探**：一个 30 行的探针比两轮猜测便宜得多（这次一次就问出了原文）。
    - 另一处同轮踩到的：客户端冒烟里「取最后一个 `settings.section`」的断言，
      在新增「肥鱼画布」分节之后**指向了错的那一页** —— 断言要按 `id` 定位，
      别依赖注册顺序（`settings.section` 允许并存多条，§3.36 末）。
58. **受限模式下「写不进工作区」不是 ACL 问题，是强制完整性标签**（2026-10-04 实测，
    前后约 40 分钟，最后是靠「每一步修复都成功、症状却一点没变」才反应过来）：
    受限命令跑在 **Low 完整性令牌**下（`whoami /groups` 里明写着
    `Mandatory Label\Low Mandatory Level`），而**低完整性进程写不了 Medium 的对象** ——
    这一关**先于 ACL**，所以把 ACL 加到 `FullControl` 也一点用都没有。
    - **症状 A（开场就撞上）**：命令**根本起不来**，
      `SetNamedSecurityInfoW failed (Win32 5): grantWrite(<工作区根>)`。这是 **DSH 自己**
      provision 写权限那一步失败了（缺 `WRITE_OWNER`），不是你的命令有问题。
    - **症状 B（修完 A 之后）**：根目录能写了，**`packages/**` 一律不能** ——
      `node build.mjs` → `EPERM: open '…\lib\index.js'`；`Set-Content` 报
      「Access to the path … is denied」。
    - **机制**：DSH 只给**工作区根**打低完整性标签，**已有的子目录不会继承**。
      ACL 修复脚本的报告里看得最清楚：根 `LOW_LABEL=True`，而 `packages` /
      `packages\fatfish-canvas` 都是空的。ACL 本身一直是好的（子目录把根上的
      `Authenticated Users: Modify` 之类继承得好好的），**卡住的只有标签**。
    - **修法**：别修 ACL。需要写子树时把那条命令用**完全权限**跑一次即可 ——
      非受限进程是 Medium 完整性，不需要标签。（本机跑过一次 ACL 修复，它只解决症状 A：
      补上的 `WRITE_OWNER` 是 DSH provision 的前提；报告与备份在
      `D:\agent文件目录\acl-recovery\`。）
    - **症状 C（2026-10-20 踩到）**：读命令（`git status/diff/log`）都正常，一到动 `.git`
      就 `fatal: Unable to create '…/.git/index.lock': Permission denied` ——
      `git add` / `commit` / `push` 全废，看着像仓库坏了或有个残留锁。**同一个机制**：
      `.git/` 是子目录、不继承低完整性标签。修法同上 —— 把**那条 git 命令**用完全权限跑一次，
      不要删锁文件、不要改 ACL。
    - **判据**：`whoami /groups` 里有没有 `Low Mandatory Level` —— 有就是受限模式，
      写盘问题先查标签，再考虑 ACL。
59. **`ambient.d.ts` 是手写的 —— 它写错名字时 tsc 全绿、浏览器里整个席位崩掉**
    （2026-10-05 实测。用户报的是「聊天框显示不了图片 / 视频模型选择」）：
    - **症状**：聊天栏那格（`conversation.input.right`）与用户消息（`conversation.chat.node`）
      **一起不见**，控制台两行 `slot entry crashed in '…': Error: Minified React error #130`。
      React #130 = 「Element type is invalid … got: undefined」= 某个 JSX 元素是 `undefined`。
      席位注册本身完全正常（`verify-client` / `npm run check` 全绿），所以看着像「注册没生效」。
    - **真因**：DSH 升到 0.2.0-rc.2 后 `@deepseek-ai/dsh-client-ui-primitives` **改了图标名**：
      `IconCheckOutline16` / `IconChevronDownOutline14` / `IconCopyOutline16` 现在是
      `IconCheckOutlineRegular` / `IconChevronDownOutlineRegular` / `IconCopyOutlineRegular`
      （`Regular` = 16px + 描边 1，`Medium` = 16px + 描边 1.3，`size` 可覆盖）。
      命名空间导入一个**不存在**的导出**不报错**，值就是 `undefined`。
      本体 `ModelSelect` 用的正是那两个 `Regular` —— 照抄即对。
    - **为什么 tsc 没拦住**：`src/client/ambient.d.ts` 手写了一份
      `declare module '@deepseek-ai/dsh-client-ui-primitives'`，**tsc 看到的只有它**
      （工作区里没有真包：`node_modules/@deepseek-ai` 只有 schemastery）。手写的合同一过期，
      编译期与运行期的一致性就整个消失了。
    - **判据（一条命令）**：真机的导出清单在
      `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-client-ui-primitives\lib\index.js`
      末尾那个平铺的 `export { … }`。凡是「席位整个不见 + React #130」，先来这里比对名字。
    - **修法**：改名字 + 同步 `ambient.d.ts`；`build.mjs` 新增构建期守卫
      `assertBaseExports()` —— 从统一基座命名导入的每一个符号都在真机那份清单里核对，
      缺一个就**构建失败并点名文件与符号**（找不到 dsh 安装目录时降级成一行提示，不让构建挂）。
      **实测有效**：故意把名字改回旧名 → 构建当场报 `IconCheckOutline16（来自 …primitives）`。
    - **教训**：**手写的 ambient 声明是一份会过期的合同**。要么给它配守卫（已配），
      要么把真包装进工作区让 tsc 读真类型 —— 否则这类错只能在浏览器里现形。
    - 同轮补的一条**质感**缺口：菜单底用的是 `--dsw-specific-menu`（`#43454a73`，**45% 半透明**），
      本体每个菜单都配 `backdrop-filter: var(--dsw-menu-backdrop-filter)`
      （ui-conversation 的 panel / ui-chat 的浮层同款），我们漏了那颗模糊 ——
      少了它就是一张能看见底下正文的塑料膜。判据：`getComputedStyle(菜单).backdropFilter`
      应与本体一致（`blur(40px) saturate(1.5)`）。
60. **`e2e-entry` 在探针 profile 里会固定红 11 项 —— 是环境，不是回归**（2026-10-05 实测，
    修图标名那轮顺手跑的，差点被当成自己改坏的）：
    - 根因一：**顶栏被「试试更轻巧的侧栏」那条欢迎提示盖住**（`ui-settings-general` 的
      `welcomeNoticeVersion`，探针 profile 里没关过）。它是一张固定浮层，正好压在
      「纯画布」按钮（约 `621,22`）上 → `elementFromPoint` 拿到的是提示框，
      「可命中」断言全 false，后面「点进纯画布 → 聊天列收起 / 画布铺满」整串**连锁红**。
    - 根因二：**`session-log-deepseek` 在本 profile 里是 `enabled: false`**
      （profile patch 里明写着）→ 「画布模式下 session log 仍可命中 — null」必然红。
    - **判据**：失败项若集中在「顶栏可命中 / 纯画布模式」+「session log」这两簇，
      且 `document.body.innerText` 里能找到那句欢迎提示，就是本条，**别去查代码**。
      想让它真绿：先把提示关掉（点「保留当前显示」）、再把 session-log 插件打开。
    - 顺带：**这一轮能跑 e2e 是因为探针 profile 的 cookie 还在**（§3.38 末），
      `DSH_WEB_URL` 根本没设 —— 页面正常加载，28/39 项照常 PASS。
    - **P34 补充：同一个浮层也把 `e2e-p4` 打成固定红 16 项**（全是「纯画布」那一簇：
      `点一下跟焦按钮`、`「纯画布」按钮可命中 — false`，之后 `切到纯画布模式` /
      `画布铺满整个视口宽度` / `没有宽度拖拽条` / `重置宽度按钮` / `Esc 与刷新自救` 整串连锁）。
      本轮实测坐实了机制（不是猜）：命中点 `621,22` 上拿到的是 **`div.cm-qguide`**，
      `coveredByHost: true`；点一次欢迎框上的「保留当前显示」之后，**同一个点**变成
      `button.ffc-tbtn`、`coveredByHost: false`。顺带量到 `toolbarOverflow: false` ——
      工具条本身没有溢出，所以「可命中」失败**只能是遮挡**，与样式宽度无关。
      判据：`e2e-p4` 的红若全落在「纯画布」那一簇，先关欢迎提示再跑，**别去查 CSS**。
    - **2026-10-14 复测（改画布作用域那一轮）：这一簇只剩 `点一下跟焦按钮 → 变为未按下`
      一条红，而且机制不是遮挡** —— 探针实测：命中测试 `hitIsButton: true`、页面上
      `div.cm-qguide` 一个都没有（欢迎浮层已被点掉），可 `aria-pressed` 与 `title` 点完
      1.5 秒都不动，工具条的 `MutationObserver` 计数是 **0**；而同一枚点击**确实改了偏好**
      （`fatfish-canvas:follow-new` 由 `on` 变 `off`，所以紧随其后的「偏好写进 localStorage」
      那条是绿的）。对照：点作用域读数（同一条工具条）5 次变更、点「清空画布」6 次变更
      —— **面板本身是活的**，只有 `useFollowNewNodes()`（`state.ts` 的
      `useStoreValue(subscribe, …)`）这一条订阅腿的值停在 `true`。
      **这不是作用域改动带出来的**（那条路一个字符都没碰：`CanvasPanel` 里
      `aria-pressed={follow}` 的写法没动过），但**机制与 §8.60 原文写的不一样**，
      下次要修的话从这里开始查（离线冒烟只测「初次渲染的按下态」与「偏好为 off 时重挂载」，
      两条都绿 —— 所以这个洞只在真实 GUI 里、且只在「点了之后」出现）。
61. **跑 e2e 之前先确认「环境三件套」—— 不然 46 条红会让你怀疑自己改坏了**（P34 实测，
    改完 CSS 顺手跑全套 e2e，五个套件一片红，差点回滚一个其实全对的改动）。
    这一条是**入口条目**：红了先来这里点名，逐条排除，再去读代码。三条互相独立，
    而且都不看代码就能验证：

    | # | 环境条件 | 中招的现象 | 怎么验 / 怎么解 |
    |---|---|---|---|
    | 1 | **本体的欢迎提示浮层（`div.cm-qguide`）压在顶栏上** | `e2e-entry` 固定红 11 项；`e2e-p4` 固定红 16 项（「纯画布」整簇） | 见 §8.60：在页面上点一次「保留当前显示」 |
    | 2 | **composer 自动获得焦点**（页面加载后 `document.activeElement` 就是那个 `contentEditable` 输入框） | `e2e-canvas` 固定红 3 项：`拖拽节点真的移动了它 — left 0 -> 0 (Δ=0)`、`拖拽后节点被选中`、`框选过程中出现选框` | 见下面「机制」 |
    | 3 | **profile 里没有活着的会话** | `e2e-p5` 9 项（菜单项 title 全是 `当前没有会话`）、`e2e-scope` 7 项（全是会话画布键那一簇，`键后缀…` 的候选有值而键为空） | 先在 GUI 里真的开一个会话（§8.32 末尾同款：席位是会话作用域） |

    - **第 2 条的机制（值得单独记住，因为它是一条**设计如此**的功能，不是 bug）**：
      `CanvasStage` 的 `onNodePointerDown` 会先问 `nodeClickIntent({ mediaUrl, composerFocused })`
      （见 `clickintent.ts`，有真值表测试）：**光标已经在输入框里时点图片 = 把这张图引用进输入框**，
      于是它 `setSentNotice` 之后**直接 return** —— 不选中、不拖拽。
      实测判据（本轮跑的）：拖拽前 `activeElement` = `div.uV2eYG_input`（`role=textbox`，
      `contentEditable=true`），拖完 `notice` 变成 **`图片已作为附件放入聊天输入框`**、`left` 仍是 `0px`；
      手动 `blur()` 之后**同一个拖拽**立刻 `left: 0 -> 120px`、`selected: true`。
      e2e 里从没 blur 过输入框，所以这一簇在探针 profile 里**必然红**。
    - **判据**：失败项若**成簇**（都挂在同一个功能上：「纯画布」/「节点拖拽」/「会话画布」），
      且你在同一轮里没碰过那个功能相关的代码 —— **先点这三条名，别读代码**。
      P34 的实测结论：46 条红**全部**由这三条解释，`e2e:theme`（唯一真正检查配色的套件）15/15 全绿。
    - 反面教训：**改样式之前先把这套 e2e 的基线跑一遍存下来**。本轮是先改后跑，
      于是必须额外花一轮做诊断实验（probe + A/B）才能自证清白 —— 那比提前跑一遍贵得多。
62. **`--dsw-alias-brand-primary` 不是强调色 —— 它逐字等于 `label-primary`**（P34 清点配色时实测）：
    两套主题下这两个 token 指向**同一个静态值**（light 都是 `neutral-bluish-1000` = `#0f1115`；
    dark 都是 `neutral-bluish-50` = `#f9fafb`）。所以：

    - 拿它当「选中 / 焦点 / 强调」色，得到的是**一圈黑或一圈白** —— 不是一个能被认出来的强调色。
      浅色下像加粗的描边、深色下像发光的边，用户只会说「有点扎眼」或者「看不见」。
      `styles.ts` 里旧注释写的「亮色下太扎眼、深色下又发白」，其实是**同一个颜色的两种抱怨**。
    - 真正的强调色是 **`--dsw-alias-state-business-primary`**（light `#4176e6` / dark `#7aaaff`，
      deepseek 蓝）：两套主题下都是同一个中间调，本体的代码里它也正是干这个的 ——
      输入框 `:focus` 的边框（`border-color: var(--dsw-alias-state-business-primary)`）、
      以及每个组件的聚焦环 `var(--dsw-focus-ring-color, …-business-primary)`。
    - 做法：插件的 `--ffc-accent` / `--ffc-select-line` / `--ffc-focus-ring` 全指到它；
      焦点环一律用 `--dsw-focus-ring-width` + `--dsw-focus-ring-color`（**别自己写 `2px solid`**，
      本体是集中在 `focus.css` 里定的）。判据：`grep 'brand-primary'` 的结果里
      不应该再出现「焦点 / 选中 / 描边」语义的用法。
63. **画布那几档底色是「算过对比度」的，别看着顺眼就换档**（P34 实测，被 `e2e:theme` 抓住一次）：
    - 起因：把 `.ffc-node-media`（媒体槽，也是**待生成 / 失败 / 文字**三类节点的整块底）
      从 `bg-layer-1` 改成卡片面 `bg-layer-2`，看着更统一 —— 深色下
      `深色：失败标题(4.24 < 4.5)` 立刻红：`.ffc-node-failed-title` 用的是
      `state-error-primary`（深色 `#f25a5a`），它在 `#232324` 上有 **4.77**、在 `#2c2c2e` 上只有 **4.24**。
    - 所以这两档现在是**命名过的**：`--ffc-card-surface`（卡片面）
      与 `--ffc-well-surface`（卡片里的凹陷槽，深色下比卡片暗一档），
      `.ffc-node-media` / `.ffc-set-model` 用后者。**改这两个变量等于改对比度**。
    - 顺带两个数字记在这里，省得下次再算：浅色下失败标题是 **4.50**（贴着 4.5 的门限，
      设计系统里没有比 `#ec1313` 更深的可用红），深色下它是 4.77 —— 两侧都没有余量。
    - **为什么只有 `e2e:theme` 会喊**：单测 / tsc / 其它 e2e 都不看颜色。
      所以「改了背景 / 底色 / 前景」之后，**`npm run e2e:theme` 是必跑的那一条**，
      它同时出浅深两张截图（`lib/e2e-theme-{light,dark}.png`），可以顺眼看一下。
    - 同轮补的两条**机器判据**（写在 `test-icon.mjs` 的样式守卫里，散文拦不住复发）：
      ① **圆角一律走 `--ffc-r-*`**（裸 px 会与本体那一阶悄悄错开：此前全站有 15 处
      10/9/7/6px 的裸圆角，本体那阶是 8/12/16/20）；
      ② **过渡时长一律走 `--ffc-transition*`**（末尾那条 `prefers-reduced-motion`
      只压这两个变量，写死 `0.12s` 的地方它盖不住 —— 两处照抄本体、必须逐字相同的取值
      在守卫里是显式例外）。两条都做过**负例验证**：往 `styles.ts` 里注入
      `border-radius: 9px` 与 `transition: left 123ms`，守卫会分别点名报红。
64. **MJ 图生文：结果是 `/describe`，不是描述**（2026-10-05 实测，P35）：
    `GET /mj/task/{id}/fetch` 回来的对象里，`description` 是**斜杠命令**——
    刚提交时 `"提交成功"`、完成时字面量 `"/describe"`；**描述文字在 `prompt` 里**
    （`properties.finalPrompt` 是同一份）。这个字段名恰恰是「看起来最像结果」的那个
    （`description` 也是提交响应里那句状态文案），所以照名字取字段的实现会
    **静默把一句 "/describe" 当描述拼进提示词** —— 生成照常出图，只是带着一句废话，
    比报错难查得多。修法与判据：

    - 取值顺序：`prompt` → `properties.finalPrompt`，**永不取 `description`**
      （`host/providers.ts` 的 `mjTextOf`，注释里写着这条实测结论）；
    - 判据留在 `scripts/test-host.mjs` 第 14b 节：假响应里 `description: '/describe'`、
      `prompt` 是真描述，断言拿到的必须是后者 —— 将来谁「顺手改成 description」当场红。

    同一条协议上另外两个坑（细节见 §3.40）：**只收 base64**（不收地址，
    所以参考图要自己取字节）、**基址不带 `/v1`**（MJ 挂在 `{base}/mj/…`）。
    这类「文档站点打不开」的第三方协议，**别照字段名猜、也别等文档** ——
    拿用户已有的密钥真发一次（10 秒），比读文档还省事。
66. **`e2e:settings` 删掉了用户的真实供应商 —— 测试按 id 前缀认自己的东西**（2026-10-05 实测，
    代价是两个密钥）：脚本开头「清掉上次残留的测试供应商」用的判据是 `/^(custom|e2e-local)/`，
    而用户在界面里点「自定义供应商」建出来的真实供应商 id **正好就叫 `custom` / `custom-2`**
    （同一个 `freeProviderId('custom')` 生成的，连默认显示名都一样）。于是那次清理：

    - 先对两张**真实**卡片各点一次「清除」→ **凭据库里的 `FFC_CUSTOM_API_KEY` /
      `FFC_CUSTOM_2_API_KEY` 被删掉**（值不可恢复，只能重新填）；
    - 再删掉这两家供应商（配置块没了，`defaultVideo` 当场变成「（已失效）」）；
    - 收尾还把 `defaultImage` 清成「自动」，用户自己选的默认图像模型也没了。

    更阴的是它**全绿通过**：`generatedId` 也是按前缀取的，抓到的是用户那张卡片 ——
    后面每一步「操作测试自己建的供应商」其实都在动用户的数据，断言照样 PASS。
    **判据不可能从名字上看出来**（用户建的与测试建的逐字相同），只能换标记：

    | 动作 | 现在认什么 |
    |---|---|
    | 清理残留 / 认自己的卡片 | **基址指向本机假服务**（`IS_TEST_CARD`）—— 只有这个脚本会这么写 |
    | 取新供应商的 id | 创建前后的 **id diff**（`beforeIds`），并记成页内 `window.__ffcE2eId` 供后续 PROBE 只看这一张 |
    | 收尾恢复默认图像模型 | 恢复成**跑之前那个值**（不是一律清成「自动」—— 那同样是在改用户的设置） |

    代价清单（本轮）：两个 provider 级密钥要用户重新填；**模型级**的那几个
    `FFC_CUSTOM_GEMINI_*` 没被动到，那两个 gemini 模型照常可用。
    教训一句话：**测试要删东西时，判据必须是「只有我能造出来的标记」，
    不能是「名字看起来像我的」** —— 同理，`npm run restart:verify` 会连着跑这个脚本，
    所以这条不是「跑测试时小心点」，而是必须改代码。
67. **MJ 出图：`imageUrl` 在「执行中」就有值，先读它 = 把进度图当成品**（2026-10-05 实测，
    P36）：文档对 `imageUrl` 的原话是「生成图片的 url, **成功或执行中时有值**」——
    与 §8.64（`prompt` 在别的状态下也有值）是**同一个形状的坑**，只是换了字段。
    轮询里一旦「看到图就返回」，用户拿到的是一张跑到 81% 的半成品，而任务其实是成功的。

    - 修法：**只认 `status === 'SUCCESS'` 时的 `imageUrl`**，失败态（FAILURE / CANCEL）
      先判并抛出 `failReason`（`host/providers.ts` 的 `generateImageViaMj`）；
    - 判据留在 `scripts/test-host.mjs` 第 14c 节：假响应里第二条是
      `IN_PROGRESS` **且带 imageUrl**，断言必须还继续轮询、拿到的第三节那张图；
      另一条把 `FAILURE` 与 `imageUrl` 一起给，断言必须抛错而不是出图。
    - 推论（对任何任务式协议都成立）：**「有值」不等于「有结果」**，
      状态字段才是判据。
68. **测试里的 `jsonResponder` 队列用完会一直回最后一个响应**（2026-10-05，P36 本轮踩到）：
    `Math.min(i, queue.length - 1)` 的语义是「不够就重复最后一条」。同一个工具实例
    **跑第二次**时忘了换新队列，第二个用例的**提交请求**拿到的就是上一条
    「成功」响应 —— 现象是 `MJ 出图提交失败：（{"status":"SUCCESS",…imageUrl…}）`，
    看起来像协议的锅，其实是测试没换弹药。修法：复用实例前 `responder = jsonResponder([…])`
    重来一条（`scripts/test-host.mjs` 第 14c 节 ③ 有注释点明）。
    判据：报错里出现「提交失败」但括号里是**轮询形状**的响应（有 `status` 没 `result`）。
69. **动效层两个「看着像没生效」的坑**（P37 实测，各花掉几分钟）：
    **①`transform: scale()` 会把热区一起缩掉 —— 而这不是观感问题，是「点了没反应」。**
    按下时元素缩了 4%，若指针原本落在边缘那 4% 里，`pointerup` 就落到元素外，
    浏览器按「共同祖先」派发 `click` → **按钮的 onClick 根本不执行**。
    同一个属性在 28px 的按钮上是 0.56px 边缘（碰不到），在 360px 的模型触发器上是 7px
    （真会点到）。所以缩放只给「两个方向都是一个按钮量级」的控件，宽控件只做颜色反馈
    （判据写在 `styles.ts` 动效层第 2 条 + `--ffc-press` 注释里）。
    **②强制 `:active` 之后立刻读 `getComputedStyle(el).transform`，读到的是过渡的起点值。**
    CDP 的 `CSS.forcePseudoState({forcedPseudoClasses:['active']})` 是对的，但 `transform`
    自己也在这条过渡里 —— 立刻读会拿到 `matrix(1, 0, 0, 1, 0, 0)`（= 没缩），
    看起来像「规则没写对 / 没命中」。**必须 `await sleep(250)` 再读**（P37 的探针第一版
    就是这么误判的，差点去改一条本来就正确的 CSS）。
    连带一条：`getComputedStyle().transformOrigin` 返回的是**解析后的 px**（`0px 0px`），
    不是 `left top` —— 断言里比字符串要按 px 写。
    另：动画名与 `@keyframes` 对不上是**静默失效**（元素硬切出来，不报错），
    所以 `scripts/test-icon.mjs` 里加了双向守卫（引用必须存在 / 关键帧必须有人用，
    已做负例验证：把 `ffc-fade-in` 改名会同时点红两条）。
70. **CSS 遮罩里的 APNG：无头里「截图两次一模一样」大多数时候是你采样太稀，不是它没动**
    （P38 实测，两个方向的误判都踩到了）。背景：图标换成原生那枚鲸鱼尾巴
    （`mask: url(60 帧 APNG)` + `background: currentColor`，见 §3.42）。
    - **虚拟时间推不动它**：`--virtual-time-budget` 取 60ms…2990ms 十二档，
      截图**逐字节相同**（把 §8.44 那条在 APNG 上又验了一遍）。要看它动只能**真实时钟**。
    - **采样密度会翻转结论**：同一份页面，**单元素 + 每 100ms 截一张（30 张，覆盖 3 秒一圈）**
      → 30 张**全一样**（看着像「根本没动」）；**三个元素（或每轮多截几张）** → 20 张里
      16–18 张不同。机制没查清（像是页面有没有持续产帧），**所以判据别写成「两张不同」**：
      连采 ≥5 张、要求 **≥2 种画面**，才既不会假红也不会假绿。
    - **`getComputedStyle(el).maskImage` 是解析后的完整 data URI**（原生那份 28873 字符、
      推导出的实心版 **11929 字符**）—— 断言与日志一律**比长度**，别把几十 KB 字符串搬来
      搬去。⚠️ 但它**分不出状态**（P38 第二版起遮罩一直挂在动图那枚身上，两种状态下长度
      一样）：状态判据看那枚的 `display`（none ⟷ block）。⚠️ 阈值也别卡死在旧数字上：
      资产一换（比如第三 / 四轮把线填成面）长度就变，写 `> 5000` 这种量级判据就够。
    - 落点：`e2e:entry` 第 6 节（真实 GUI 里悬停 → 动图那枚 display:block + 5 张截图 ≥2 种）、
      `e2e:p5` 第 0 节与 `e2e:command`（画布「生成中」占位 = display:block + 遮罩长度 >5000）。
71. **文本守卫本身也会假绿：同一段 CSS 在 `prefers-reduced-motion` 里被抄了第二遍，
    正则从全文找就会匹配到那份抄件**（P38 做负例时抓到）。
    - 现象：`test-icon.mjs` 那条「两个动态态都指向动图」的守卫，把**主动态规则整条删掉**
      之后**仍然是绿的** —— 它匹配到了文件末尾 reduced-motion 块里「同名选择器 + 静帧」那份。
      断言因此守的是空气，而这类守卫正是「散文拦不住复发」的最后一道。
    - 两条修法（择一，别都不做）：① 匹配范围**锚定到 reduced-motion 之前的那半张表**；
      ② 把「匹配到几处」也做成判据（0 处或 ≥2 处都算红）。
    - 同理另一条同源的截断：用 `[^}]*` 匹配 CSS 规则体会在 **`${…}` 插值里的那个 `}`**
      处提前结束（本轮的 data URI 正好是插值）—— 规则体要按「收尾 `}` 独占一行」取。
    - **规矩：新守卫一律做一次负例验证（改坏 → 必须红）。** 本轮两条新守卫都做了
      （`#fff` → `currentColor`、删掉悬停那条选择器），第二条正是靠负例才发现假绿。
72. **「图标不是纯色」：一半是分辨率（位图细线被缩没了），另一半是「空心 vs 实心」**
    （P38 第二 / 第三轮实测；用户原话先是「目前鱼尾巴似乎还是不是纯色的」，
    再是「把目前的空心改成实纯色的」）。背景：图标静止态
    原本用原生 APNG 的**第 0 帧**。`_probe-whale-pixels.mjs` 把它解开数了一遍：
    28×28 里只有 **46 px** 到 alpha 255、159 px 半透明，且**没有封闭空洞** —— 它是一条细线。

    - 机制：`mask-size: contain` 把 28px 缩到 17px（0.6 倍），细线峰值 alpha 掉到七成上下
      —— 深色主题下是灰线，浅色主题下配 `#fff` 直接隐形。**这不是颜色写错了，是位图细线
      被缩没了**；只改颜色（`#fff` ⟷ `currentColor`）治不了它。
    - 修法：静止态换成**矢量**（原生本来就有：`REST_PATH`，`stroke: currentColor`），
      动效那半保持原生 APNG 不动。矢量在 14/17px 下是满不透明度 + 抗锯齿，两边主题都成立。
    - **但「矢量化」只解决了一半**：第三轮用户又说「**把目前的空心改成实纯色的**」——
      他要的「纯色」是**实心填充**，而矢量描边仍然是**空心线稿**。判据是
      `<svg … fill="currentColor">`（+ 同色描边），`fill="none"` 就是退回线稿。
      开放路径填充时自动闭合，那条弦正好落在尾柄底边 —— 剪影干净、无尖刺（§3.42 末尾）。
      **教训：用户说「颜色不对」时，先分清他要的是「不透明的线」还是「实心的面」。**
    - **第四轮他又说「动态图标也改为纯色」**：动图那 60 帧同样是发丝线，于是**逐帧填面**
      （`scripts/lib/whale-solid.mjs`，做法与两个坑见 §8.73）。判据：每帧覆盖率 >= 30%
      （线稿只有 24%）+ 逐帧盖住原生那条线 >= 98% + 帧数 / 延时 / 循环与原生一致。
    - **判据**：`test-icon.mjs` 钉「静止态是矢量路径」「静止态是实心（fill 与描边同色）」
      「每一帧都是实心」「实心动图 = 拿本机原生重新推一遍（逐字节）」；
      `e2e:entry` 钉「填充与描边色都 === 按钮的 color」（换主题它必须跟着变）。
    - 负例：本轮 9 处改坏全部被抓到（写死 `#fff` ×2 / **退回 `fill="none"`** /
      动图默认 `display:block` / 悬停不藏静止态 / 整段挂到 `reduce` / 换回位图静帧 /
      **补弦只看一行** / **实心化整个没做**）——
      脚本 `scripts/_probe-negatives.mjs`
      （临时，未进 npm scripts；它自己踩过一个坑：源文件是 **CRLF**，多行锚点要先折行尾再比）。
    - 顺带作废一条旧判据：**别再用 `maskImage` 长度分辨状态**（见 §8.70 末尾）。
    - 更一般的形状：**「看着不对」先量像素，别先改颜色**。同源的坑还有 §8.40
      （动画做了但几乎看不出来）—— 都是「图形本身的物理尺寸/覆盖率」问题，不是样式没写对。
73. **把一张细线 APNG「填成实心」：两个坑都出在「以为形状是理想的」**
    （P38 第四轮实测，`scripts/lib/whale-solid.mjs`；用户要「动态图标也改为纯色」）。
    - **坑 ①：解 APNG 时忘了 inflate** —— `unfilter()` 吃的是**解压后**的扫描线，
      直接把 IDAT / fdAT 的压缩字节喂进去，得到的是**噪声**（还不报错：行数不够时
      `subarray` 静默截短）。现象极具迷惑性：解出来的「第 0 帧」是**顶上一块噪点**，
      面积还挺像那么回事（~200 px，与真细线的 187 px 撞在一起），
      于是实心化的统计看着「正常」，只是图形完全不对。**判据：先渲染出来看一眼**
      （`_probe-solid-anim.mjs` 的胶片条），别只看数字。
    - **坑 ②：补闭合弦只看「最低一行」补不上** —— 尾柄两侧的收笔**不在同一行**
      （实测左侧到 y=24、右侧到 y=23）。只在最低一行把左右两端连起来，弦落在半空中，
      洪水照样从开口灌进内部 → 填完还是线稿（面积 188 vs 线 187，一眼假）。
      **改成取最低两行**的轮廓算 x 范围，再在最低一行补弦 —— 8 连通即可封住。
    - 落地判据（`make-whale.mjs` 自检 + `test-icon.mjs`）：面积比必须在 **1.2..3**
      （没填上 = 1.0；弦补错 / 灌满 = 远超）；每帧覆盖率 >= 30%；
      逐帧**盖住**原生那条线 >= 98%；帧数 / 尺寸 / 延时 / 循环次数与原生逐项一致；
      再拿本机原生**重新推一遍逐字节比**（推导可复现 = DSH 换资产时立刻红）。
    - 顺带：推导版比原件**小一半多**（8.9KB vs 21.6KB），`lib/client.js` 471KB → 454KB。
      手写 APNG 编码只要 `zlib` + CRC32 + 块拼装，**不需要任何依赖**。
74. **「鼠标移上去就跳出来」的面板：两个坑都不是样式问题，是时序与语义**
    （P39 实测，`ModelPicker.tsx` + `e2e-picker.mjs`；用户要「衍生档位移上去自动跳出，
    不用再点一下」）：
    - **坑 ①：面板与那一行之间那条 4px 的缝会把面板关掉。** 指针从行挪进面板时，
      行的 `mouseleave` **先**到、面板的 `mouseenter` **后**到 —— 立刻关的话，现象是
      「指针正要进面板，面板就收了」，看着像面板根本点不到。做法：`mouseleave` 只
      **排一颗定时器**（`dropFlySoon`，150ms），面板自己的 `mouseenter` 把它取消
      （`holdFly`）。⚠️ 定时器必须在卸载时清掉，否则它调的是已卸载组件的 setState。
    - **坑 ②：悬停已经把面板打开了，点击就不能再是 toggle。** 鼠标点在家族行上时
      指针正悬在它上面、面板**已经**开着 —— 点击若还是 `prev === key ? null : key`，
      用户看到的就是「点一下反而关掉」。分工写成：鼠标悬停 / 点击 = **只开**（幂等；
      触屏没有悬停，点击是那条路），键盘 Enter = 开关（`choose` 那条路保留 toggle）。
    - 判据都在 `e2e-picker.mjs`：第 5 节「悬停就开出面板」、同节末「指针挪进面板后
      它还开着」、第 6 节「换一行悬停面板跟着换」（证明是**悬停**在驱动，不是点击）、
      第 7 节在面板里真按鼠标。**这些判据只能真派发鼠标事件** —— 合成 `mouseenter` /
      `el.click()` 都不产生指针路径（§8.48 末那条教训的又一次应用）。
    - 顺带作废一条旧行为：**打开菜单时不再预先展开「当前模型所在的那个家族」**。
      那时行内展开没有别的提示，只好预展开；现在家族行右边有一个**朝右的箭头**
      （`.ffc-mp-chevron`，开着时转朝下），「这里还能展开」明摆着，一开菜单就弹一块
      面板出来反而吵（`e2e-picker` 第 4 节钉了「还没悬停时没有面板」）。

75. **profile 的 `cordis.patch.yml` 用编辑工具改不动：运行中的宿主在周期性整体重写它**
    （2026-10-08 实测，搬激活行时连撞三次；文件已被重写三次以上：19:56 → 20:00 → 20:05）：
    - **现象**：`edit`（一切「读后写」的工具）报
      `cannot edit "…cordis.patch.yml": file changed since it was read`，
      **重读一次再改还是同样报**；两次相邻命令看到的行数 / 字节数甚至互相矛盾
      （242 行 vs 275 行、11818 vs 9499 字节）—— 中间有别的进程写过它。
      写它的多半是 `dsh-big-workspace`（它要把自己的 `state:` 那一节写回去）。
    - **做法**：用 **node 同进程读改写** —— `readFileSync` → 断言旧块**只出现一次**
      （`content.split(OLD).length - 1 === 1`，不是 1 就 `exit 1` 什么都不写）→
      `replace` → `writeFileSync` → **立刻** `readFileSync` 复核。窗口是毫秒级，
      能躲开那个周期；中文用 node 读写是 UTF-8 无损的（**别**走 PowerShell，§8.1）。
      复核里要包含「别的条目还在」：自己那条覆盖行、下一个 `- insert:`、文件末尾那几条。
    - **为什么不怕被覆盖回去**：那份重写是**外科式文本替换**，不是整篇 YAML 重序列化
      （重序列化会把满篇注释抹掉，而注释一直在）→ 手写的注释与条目都活得下来。
    - **判据**：`dsh --profile web --dump-config`（只组合、不挂载、不监听）里
      `fatfish-canvas` 应当**恰好一条**，且带
      `# == fatfish-canvas, patched by …\profiles\web\cordis.patch.yml`（那句说明它被
      **设置覆盖**改过；插入来自包内 patch）。别忘了 `FFC_NO_STATUS_WRITE=1`。
      端到端的判据仍在重启之后：`cordis_inspect_query Config.listConfigs(name=…)`
      + 页面上画布入口在不在（**创作模式**下这是最便宜的第一跳，见 §3.4）。

76. **右键开关一类的新设置字段被拒：`Config field "X" is not volatile`（说它不存在）
    —— 病根是「正在跑的宿主还是旧 schema」，要重启，不是改客户端**（2026-10-10 P41 实测）：
    - **现象**：尾巴右键切 `designSkillOn`，菜单弹出这条原因，属性一直不变。易误判为
      「客户端写错了路径」或「右键事件没到 React」。
    - **机制**：设置服务按**运行中宿主的 schema** 校验写路径——宿主是重启才换新模块的
      （§3.4），新字段在它眼里不存在 / 不 volatile。lib 重建只是文件换了，旧 fiber 还挂着旧模块。
    - **判据**：拿这条报错原文搜（它在菜单说明位 / 设置页 msg 里）；探针
      `scripts/_probe-rc.mjs` 顺带证明 contextmenu 真的到了 React（doc capture/bubble
      都录到右键按下）——事件路径没坏，别再往防抖/委托上挖。
    - **做法**：宿主半边有 schema 变更 → 进 STATE §0「等重启」清单 → 重启后红项自绿。
      顺带认下一个观感**设计**：写入失败时**打开菜单显示原因**（ModelPicker 的
      `toggleSkill` 失败分支就是这么写的）——静默失败「点了没反应」比这条报错更贵。
    - **守卫**：`e2e:picker` 第 10 节 4 条判据会盯着「右键→翻转→二次右键回原样」；
      单测侧 `test-host` 的 schema 缺省断言盯「缺省开 / 显式 false」。

77. **右键弹的是**浏览器原生菜单**而不是自定义行为（preventDefault 漏了）—— e2e 的
    CDP 派发不开原生菜单，这种洞测试永远绿着**（2026-10-11 P42 实测，`ModelPicker.tsx`）：
    - **现象**：真机右键尾巴，弹出的不是切换设计技能而是 Chrome 的原生菜单
      （返回 / 刷新 / 检查…）。P41 的 `toggleSkill` 注释写着「必须 preventDefault()」，
      **代码里却没有**（handler 不接事件、不阻止默认）—— 文档与实现脱节。
    - **为什么测试没拦住**：`e2e-picker` 用 CDP `Input.dispatchMouseEvent` 断言翻转 /
      属性 / 颜色全对，但 **CDP 派发的事件不会打开原生菜单**，`preventDefault`
      有没有做在 e2e 里**零差别**。同类对照：`MediaSettings` 的右键菜单早就写对了。
    - **守卫**：`verify-client` 8c 加一条**假事件**断言 —— 直接调
      `trigger.props.onContextMenu({ preventDefault(){…} })`，断言被调
      （渲染树替换身能拿到 handler 本体，一行假事件就能钉住这种洞）。
      凡是「右键 / 双击 / 拖拽要 `preventDefault` 才成立」的交互，e2e 靠不住，要靠这一手。

78. **e2e 里盯着 `querySelector('textarea')` 的 composer 判据整排爆红 —— 本体 composer
    换成了 `contenteditable` DIV（dsh 升级随之而来，不是插件回归）**（2026-10-12 P44 重启验证实测）：
    - **现象**：重启宿主后 `e2e:command` 三条红（输入框可达 / 命令行已敲进输入框 /
      媒体加载），且**重跑同样红**；探针（`scripts/_probe-textarea.mjs`，一次保留）
      显示 chat 与 canvas 两种模式下页面里 **0 个 `textarea`**，composer 是
      `div.uV2eYG_input[contenteditable][aria-label*=发消息][role=textbox]`。
    - **判据**：`querySelector('textarea, [contenteditable="true"]')` 两种都收（旧页面
      仍是 textarea 时向后兼容）；读值用 `el.value ?? el.textContent`。插车的通路
      `dom.ts` 的 `findComposer()` 本来就先查 contenteditable —— 插件零改动。
      宿主侧命令通路完全没坏：红的同时真实生成照常成功（ready 节点带真机地址）。
    - **顺带一条时序假故障**：「媒体真的加载成功」在节点一落定就查 `img.complete`，
      而真机图能到 **2.1 MB**（webstatic 网关直连 200）—— 落定即查传输还没完，必然红。
      改成轮询等加载（≤15s，每 300ms 一次）。
    - **本体的版本翻新会一次性波及所有「动输入框」的测试** —— 升级后先跑一条
      `e2e:command`，红的先想这一条，别去插件代码里找回归。

79. **新增 JSX 事件回调（`onMouseDown` 这类）报 `TS7006: implicitly has an 'any'` ——
    `ambient.d.ts` 的 `FfcEventProps` 没列那个属性**（2026-10-12 P45 实测，CanvasSettings）：
    - **机制**：本包没有官方 @types/react，`src/client/ambient.d.ts` 手写了 react shim；
      JSX 属性面在 `react/jsx-runtime` 的 `JSX.FfcEventProps` 里**逐一列举**事件名，
      没列的属性落进宽松索引签名 —— 该属性的回调参数拿不到上下文类型 → `noImplicitAny`。
      给参数硬注 `$types` 也不行（那个手动 shim 里 `MouseEvent` 非泛型，注成
      `ReactMouseEvent<HTMLButtonElement>` 反而报 TS2315）。
    - **修法**：在 `FfcEventProps` 里补 `onMouseDown?: FfcHandler;` 一行即可，回调照旧
      裸 `(event) =>`。**下一个新事件回调**（`onWheel` / `onMouseUp` / …）踩同样的坑，
      先到这张清单面前添一行。

80. **新加一个远程方法之后，客户端会**先于**宿主上线：页面报「取图服务调用失败
    （`probe.fetchMedia` is not a function）」—— 宿主还没重启**（2026-10-14 P46 实测）：
    - **机制**：双半边的更新时机本来就不同 —— 客户端半边**刷新页面就换新**
      （`lib/client.js` 重新载入），宿主半边要重启才换模块（§3.4）。而远程面是按
      **宿主启动时注册的 manifest** 建出来的：新方法在旧宿主里根本不存在，
      `probe.fetchMedia` 是 `undefined` → 调用直接抛 TypeError，**连信封
      （`RemoteResult`）都没走到**。所以看到的不是宿主写好的中文业务文案（对比 §8.53：
      那条是「信封没拆」，这里是「方法压根没有」），而是一句 `is not a function`。
    - **判据**：错误里带 `is not a function` = 这一条。`test-host` 第 11 节那两条
      「两侧声明的调用完全一致 / 服务上确实有那四个方法」盯的是**同一份产物**
      （`lib/` 里宿主与客户端是一起重建的），**抓不到「产物新、进程旧」** ——
      这个洞只能靠「写进等重启清单」来防。
    - **做法**：宿主加了远程方法 / schema 字段（§8.76 是同一类）之后，先写 STATE §0
      「等重启」，**不要**在客户端加兼容分支（那是为几秒钟的中间态长期留一份死代码）。
      重启后同一条操作自证，红项自绿。
    - **顺带一条分界线（P46 的复合导出就是靠它才验得动）**：**本地 / 内联 / 留档过的**
      媒体不经过宿主（`data:` 自己解 base64、`/ffc-media/…` 走同源 fetch），所以
      「图 + 视频混选 → 一个 zip」这段在**重启前**就能用真机探针
      `scripts/_probe-export.mjs` 验完（种 `data:` 节点 → 框选 → 右键 → 点导出 →
      读结论与下载下来的 zip）；只有**跨域远程**媒体要等重启。**视频的 64MB 天花板**
      （`FETCH_VIDEO_MAX_BYTES`）也在这里：超了会明说「先配留档目录」，留档后同源、
      不经 RPC、无上限 —— 那是给用户的下一步，不是含糊的失败。

81. **给节点加了**数组**字段之后，「幂等」那两条测试红了：`{"resolved":1}`、
    重复快照（2026-10-14 P47 实测）**：
    - **机制**：`canvas/ingest.ts` 的 `sameFields` 用 `===` 逐字段比，用来避免
      「值没变也提交一次 store」。数组字段每次解析都是**新数组**（`parseMediaCallArgs`
      / `parseGenerateLine` 各造一个），`===` 永远 false → 每来一次会话快照都算一次
      「变化」。而会话快照在**流式输出期间每秒来好几次** —— 画布上什么都没变，
      store 却在被反复提交（真机上表现为白重渲染 + 写盘去抖一直被推后）。
    - **判据**：`resolved` 不为 0 的重复快照 / 「重复快照不再产生变更（幂等）」变红。
      凡是往 `patch` 里加**引用型**字段（数组 / 对象），先回来改 `sameFields`。
    - **修法**：`sameFields` 里对数组做**一层浅比较**（长度 + 逐项 `===`）。句柄是字符串，
      顺序也是语义（先主体、后背景），逐项相等就算相等。别图省事改成 `JSON.stringify`
      —— 那对对象字段会静默变成「键序敏感」。

82. **右键「生成信息」里参考图永远显示「（没有记录）」—— 不是 UI 坏了，是数据当时
    就没记**（2026-10-14 P47）：先读 **§3.46**（`tool/result` 的 meta 里没有地址；
    工具这条路只有窗口里的 `tool/call` 参数能给出参考图，命令那路看 `command/run`
    的 `--ref`）。判据：老节点（这个功能上线之前生成的）必然显示「没有记录」——
    这是**正确**行为，别去「修」成猜一个地址。

83. **浮层里的长文字滚不动，一滚滚的是整张画布**（2026-10-14 P48，用户实测
    「生成信息」卡片）：
    - **机制**见 §3.47：视口（`.ffc-viewport`）上的 `wheel` 监听**先**吃事件并
      `preventDefault()`，卡片那点原生滚动在同一处被取消 —— 卡片一动不动、
      画布以光标为锚点缩放（观感就是「整个画布在动」）。滚轮在浮层上时，
      视口还会顺手把菜单关掉（`setNodeMenu(null)`），所以「滚一下菜单没了」
      也是同一个原因。
    - **修法**（一处，`CanvasStage.tsx`）：`onWheel` 进来先问一句
      `scrollableWithin(event.target, el)`，命中就**直接 return**（既不
      `preventDefault`、也不 `setNodeMenu(null)`），把默认滚动还给那个元素。
      修在视口这**一个**咽喉点，而不是在卡片上挂 `stopPropagation`：
      后者要求每个新浮层自己记得挂，且 React 的 `onWheel` 到不了
      （React 在根容器上被动监听，视口那个**原生**监听在它之前就跑完了）。
    - **判据**：`npm run e2e:p5` 5c 一节（真鼠标开卡片 → 真滚轮 → `card.scrollTop`
      从 0 变到 `scrollHeight - clientHeight`，**且**缩放读数没变、菜单还开着）。
      这一条必须在**卡片内容高过 46vh** 时才有意义 —— 夹具里的提示词因此是长文本
      （`LONG_PROMPT`）；短提示词时卡片根本不会滚，视口照旧拿走滚轮是**对的**。

84. **进了画布「退不出去」：右上角那枚鲸鱼尾巴根本不在**（2026-10-14 P49，用户实测
    「没有选择一个对话的时候它不出现，导致进入画布了没法退出」）：
    - **机制**（平台事实在 §3.20）：入口注册进 `conversation.session.header.utilities`，
      那是**会话作用域**席位 —— 没有当前会话（欢迎页）时整行都不渲染。而画布模式是
      **记住的**（`localStorage['fatfish-canvas:view-mode']`，刷新直接落回画布），
      于是「开页面 → 已经在画布里 → 右上角什么都没有」。剩下的键盘出口
      `Ctrl/⌘+Shift+B` 又在输入框里**刻意让路**，而欢迎页的 composer 会自己抢焦点
      —— 用户看到的就是「进来了，出不去」。纯画布模式是同一个洞的另一半：
      整列聊天收起，入口跟着不可见。
    - **修法**：出口跟着**画布本身**走 —— `CanvasPanel` 顶栏常驻一格「返回聊天」
      （`setMode('chat')`）。刻意**不**做「入口在不在」的检测：那要盯会话 id 或
      隐藏副本（§3.20 性质 1），而画布面板本来就在每个画布模式里渲染 ——
      常驻一格是零检测、零状态。代价是并排模式下它与右上角那枚入口重复；
      重复的出口不是 bug，出口消失才是。
    - **判据**：`npm run check` 里客户端冒烟两条（工具条有「返回聊天界面」按钮、
      纯画布下点它真的落到 `body[data-ffc-mode=chat]`）+ `npm run e2e:entry`
      第 4 节（纯画布下**入口按钮不可见**时那一格仍可命中）与第 7 节
      （真鼠标点一次就回聊天）。
    - **别再往回退**：不要把出口只留在会话作用域的席位上 —— 那个席位在欢迎页
      整行都不存在（§3.20 的三条性质）。

85. **把「共用画布」拆成按工作区之后，某块画布看着是空的**（2026-10-14 改作用域时
    一次踩到两半，都在 `store.rehomeSharedBoard` 里）：
    - **一半是视口**：拆分只搬节点、不动视口。共用那块里的节点坐标是历次 `dropLayout`
      累积出来的（可能在几千像素外），而新那块画布的视口是 `DEFAULT_VIEWPORT`（世界原点）
      —— 用户打开就只看到一片空白，以为「图没了」（其实节点都在）。
      **修法**：拆到**空画布**上时把视口对准这批节点的包围盒（`boundsOf` + 40px 边距）；
      那块本来就有内容时**不碰**它的视口（别把用户自己摆好的视角拽走）。
    - **另一半是重复**：拆分必须**按节点 id 去重**。否则「共用 → 工作区」走两遍
      （用户来回点那枚读数就会）会把同一张图写进去两次，画布上出现两块一模一样的图。
      去重之后拆分就是幂等的，于是**不需要**「迁移过没有」的标志位 ——
      那类标志位正是最容易与真实状态不一致的状态（§3.19.2）。
    - **判据**：`test-model.mjs` §8.4（视口 3960/-40、再拆一遍字节不变）+
      `verify-client.mjs` §9.1 + `e2e-scope.mjs` 第 4 节（`boardNodesUnique`）。

86. **重启之后「所有工具都死了」**：`read` / `glob` / `pwsh` / `job_list` …… 每一条都回
    `cannot get required service "sessionProjections" in inactive context`（2026-10-15
    实测，整整一轮会话卡在这上面；重启一次能好一阵，然后又坏）。**别再从现象一层层猜**，
    照下面的顺序查：
    - **这句话的字面意思是**：某个 fiber 把 `sessionProjections` 声明在 `inject` 里
      （「我需要它」），但它的 store 里**没有值** —— 也就是**提供者那颗插件没激活**。
      出处：cordis 的 `reflect.ts`（`node_modules/@deepseek-ai/cordis/src/reflect.ts:160`）。
      依赖投影面的一切（权限 / todo / 统计 / 沙箱升级 / 工具派发）于是全部当场失败。
    - **它跟「宿主死了 / 多开了」无关**：当时 `node.exe` 只有一个，`Get-NetTCPConnection
      -LocalPort 3080` 的 OwningProcess 就是它。工具报错 ≠ 宿主不在。
    - **真凶在 profile 的插件树**：`profiles\web\package.json` 里有
      `"dsh-ops": "github:T-Auto/dsh-ops"`，而 dsh-ops@0.3.0 的原生依赖
      `@dsh-ops/bash-win32-x64@0.2.1` **在 npm 上根本不存在**（只有 `0.0.0-stage`）。
      于是每一次 `pnpm install` 都以 `ERR_PNPM_NO_MATCHING_VERSION` 半途失败
      （证据：`profiles\web\.plugin-manager\logs\operation-*\pnpm.log`），`node_modules`
      停在半写状态 → **这次启动能挂上的插件就少一颗**。
      「装得上装不上全看这次 install 停在哪儿」，所以现象是间歇性的。
    - **⚠️ 宿主日志不在这里**：`DSH_HOME\logs\` 只有 `startup-*.log`（与前几次启动的
      preflight），本次故障的堆栈**不在里面** —— 别再花时间翻它，直接看上面那份 pnpm 日志。
    - **修法**：把 dsh-ops 关掉（或从依赖里摘掉）再重启。想要 `bash` 工具就得等它发布带
      原生二进制的版本；**命令执行用 `pwsh`**（走 `dsh-subprocess-local`，不依赖 dsh-ops）。
    - **判据**：工具能通就是判据本身。本轮 `npm run check` / `npm run e2e` 都跑通了。
    - 顺带确认一件事：**`lib\web-url.txt` 里的令牌过期不影响 e2e** —— 不设 `DSH_WEB_URL`
      时 e2e 直接打裸 `http://127.0.0.1:3080/`，本轮就是这么跑通的（26/29）。哪天真的全 401
      了，再按 §3.38 去抓新令牌。

87. **画布上的操作撤不回来**（P51 做的撤销，2026-10-15，用户要求「删除或者什么操作可以
    撤回」）：
    - **做法**：撤销栈挂在 `client/canvas/store.ts` 的 `commit()` 这**一个口子**上，
      快照式 —— 记的是「那次改动**之前**」的整份 `BoardState`。
    - **两条不变量，写反了都是真 bug，不是优化**：
      ① **换作用域必须清空撤销栈**（`setBoardScope` 里 `past = []`）。不清的话，在工作区 B
         按一下 Ctrl+Z 会把工作区 A 的节点搬进去 —— 那是**数据串味**，不只是显示问题。
      ② **合并判据必须是「id 集合没变」**，光靠时间窗会把「600ms 内连删两个节点」并成一步。
         拖拽每帧都在 `patchNodes`，所以时间窗还是要有（`UNDO_MERGE_MS = 600`），但集合变了
         就各记一步。`test-model.mjs` §2 末尾两条判据分别钉这两半。
    - **入口两个**：画布聚焦时 `Ctrl/⌘ + Z`（**挂在视口元素上、不监听 window**，理由同 §4
      「画布键盘挂在画布元素自身」）+ 工具条「删除选中」右侧那枚「撤销」按钮 —— 按钮是给
      「点完删除、焦点还在按钮上」这条路的，那时视口的 keydown 收不到。
    - **刻意只做撤回、不做重做**：用户要的是「删错了能退回来」。要加重做就是再存一个 future
      栈、`undo()` 里两行；**现在不做，别自己加**。
    - **判据**：`npm run check`（画布逻辑 420 项，其中 20 项是撤销）+ `npm run e2e` 第 8b 节
      （真按一次 Ctrl+Z，删掉的节点回来）。
