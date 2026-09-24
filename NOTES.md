# 肥鱼画布 · 参考资料（平台事实 / 决策理由 / 坑与教训）

> **交接面在 `STATE.md`** —— 接手时先读那一份，本文件**按需查**。
> 这里三节都是「不知道就会重新踩一遍」的昂贵知识：**§3 平台事实**（读源码核实过的 DSH 行为）·
> **§4 关键决策与理由** · **§8 坑与教训**。小节编号与 `STATE.md` 里的 `NOTES §x.y` 引用一一对应。

## 3. 已核实的平台事实（最贵的知识，别重新发现）

### 3.1 插件体系
DSH 基于 **Cordis**；一个包可**同时**是宿主组合包（`dsh.bundle.patch`）与客户端插件
（`dsh.client: { platform: 'web' }`）。Node 侧扫描**已启用**的 Loader 行，找声明 `dsh.client` 的包，
解析 `exports["./client"]` 写入启动图，经 `/plugins/<id>/client.js?rev=<hash>` 服务。
**扫描是增量式、无全量重扫路径**（响应 cordis 的 `internal/plugin` 事件）。参考实现：`dshmarket`、
`dsh-cost-meter`、`@michengai/dsh-archive-manager`（都在 `C:\Users\pc\.dsh\profiles\web\node_modules\`）。

### 3.2 客户端 bundle 契约
```js
window.__ModuleLoader__.load({ id: "<包名>", factory: (require) => { /* CJS 产物 */ return module.exports; } });
```
- 脚本执行**只注册 factory，不得有副作用**；模块体（含 CSS 注入）在物化时才跑。
- factory 的同步 `require` **只**解析 7 个 specifier（已在前端产物逐字核实）：`react`、`react/jsx-runtime`、
  `react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-ui-slots`、
  `@deepseek-ai/dsh-client-ui-primitives`。其余必须内联打包或经 `dsh.client.external`。
- primitives 的 116 个导出已核实；**没有图像/画布类图标** → 图标自绘。

### 3.3 布局：必须真实重排，不能覆盖
- AppFrame 是 **CSS Grid**，列宽由它**自身实测宽度**经 ResizeObserver → `computeColumns` 求解决定。
  画布模式下把它 `position: fixed; left: var(--ffc-canvas-width); right: 0`，聊天列才会真的重排进右区；
  frame < 1024px 还会触发它自己的 sidebar 自动塌缩。
- **用面板盖住左边是错的**（聊天仍居中于整宽列，左半永久被遮）。
- `root` 槽位是**禁区**（单槽位，动态注册会遮蔽 AppFrame 并带走它的全部席位）。自有浮层走
  `shell.overlay`（加性列表；层本身 `pointer-events: none`，direct child 为 `auto`）。
- AppFrame 用 JS 打点 `data-ffc-frame`（`[data-shell-overlay]` 的父元素），避开哈希类名与 `:has()`。

### 3.4 宿主半边的激活需要重启 dsh web
- 客户端半边：重建即以新哈希重新服务，**刷新页面即生效**。
- 宿主半边：profile patch 重新组合**不会重新导入**宿主模块（行标识未变时 fiber 保留，Node ESM 按 URL 缓存）。
  已实测：改 patch、禁用再启用行、换全新的子路径导出名，**都不会重新求值** → 必须重启 `dsh web`。
- `lib/host-status.json` 是宿主写下的就绪标记（`phase: module-evaluated` = 模块被导入；`host-ready` =
  注册成功；P9 起还带 `models` 与 `command`）。**它是运行中宿主的产物**：`e2e-command.mjs` 靠它判断
  「宿主是否已重启、命令是否已注册」，`post-restart.mjs` 也靠它确认宿主换了新模块。
  ⚠️ 因此**测试绝不能写它**（§8.10）。

### 3.5 settings 写路径只能点名**一个顶层字段**
客户端 `SettingsScope.set(field, value)` 底层是单条 `set` 路径 op → 供应商配置**必须扁平**
（`key_openai_images` 等）。若是数组，客户端只能整体回写，而它的视图是**脱敏的**（`role('secret')` 被剥离）
→ 会**抹掉所有密钥**。`role('secret')` 字段**不能给 `.default()`**（默认值会随 schema 序列化带给每个客户端）。

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
- 从 profile 的 node_modules **解析不到** `schemastery` / `dsh-settings` / `dsh-tools` / `cordis`
  （只有 `dsh-credentials` 可以，因为 dsh-cost-meter 声明了它）。
- 插件是 junction 指向工作区，**装在工作区就能被插件解析**：目前只装了
  `@deepseek-ai/schemastery@3.18.2`（settings schema 需要，是唯一运行时依赖）。
- 其余宿主服务通过 `ctx` + 本地 ambient 声明访问，**不引运行时依赖**。

### 3.9 jaaz 的规格（参考实现的提炼）
画布**就是 Excalidraw**；落位算法在服务端 `find_next_best_element_position`（`max_num_per_row=4`、
`spacing=20`，按垂直重叠分行、末行未满则贴右并与行顶对齐）—— **已移植进 `canvas/model.ts` 的
`nextPlacement()`**。缩放 ±10 **个百分点**（预设 10/50/100/150/200）。图像比例 `1:1/16:9/4:3/3:4/9:16`；
视频 `480p/1080p`、时长 5/10。视频默认静音、悬停播放、移出暂停归零。jaaz **没有**生成中占位 ——
我们**刻意保留** `pending`，是有意改进。

### 3.10 会话快照面（P3 的地基）
```ts
sessions.list            // ObservableSnapshot<SessionListState>：{ current: SessionId | undefined, phase, ids? }
sessions.binding(id)     // → { sessionId, session: SessionFace, ctx } | undefined
// SessionFace = ISession & ObservableSnapshot<ConversationSnapshot>；另有 prompt() / command()
```
四条实测事实：
1. **只有「当前」（staged）会话的事件窗口是打开的** —— 「画布只吃得到当前会话的结果」是平台限制，
   不是偷懒（P7 的按会话隔离正是顺着这条做的）。
2. `sessions.binding(id)` 是纯寻址，但 `list.current` 刚变时可能还解析不到（scope 异步建立）→
   bridge 带有限重试（200ms × 40）。
3. 会话 id 形如 **`session-<uuid>`（带前缀）**；按日志目录名推断时别削掉前缀，否则写进
   `dsh.sessions.current` 的是无效 id（表现为「落图完全不工作」，§8.9）。
4. 会话选择持久化在 localStorage **`dsh.sessions.current`**（`{"sessionId":"session-…"}`），
   但运行时只当**候选**：不在当前工作区列表里会被仲裁掉，全新浏览器 profile 最终落在**空白会话**上
   —— 这是 e2e 采用「自己发提示词/自己敲命令」的原因。

### 3.11 `tool.call.toolview` 是 keyed 席位（key = 线上工具名）
```js
ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
  { name: 'tool.call.toolview', key: 'media_generate' }, MediaToolRow));  // 不需要 id / locale
```
条目 props 是 owner 面 `{ callId, toolName, block, cwd, home, openFile, inspect }`，`block` 是
`RunningToolCall | ToolResultNode`（**一个组件覆盖进行中与已结束**）。命中 key **替换**通用卡片，
未命中**静默回落**成 JSON 卡片 → 有守卫断言。

### 3.12 设置文件的外部编辑会热发布（验证成功路径的关键手段）
`dsh-settings-file` 的 `watch` 默认开：手工改 `C:\Users\pc\.dsh\settings.yaml` 会热发布进 `ctx.settings`。
因此**不需要真实密钥**就能验证成功路径 —— 把 `media-generation` 的 `openai-images` 指向本机
`scripts/fake-media-server.mjs`（假服务自带极简 PNG 编码器、`--delay` 造出可观察的 pending 窗口），
**验证完改回 `media-generation: {}`**。⚠️ 该文件在工作区之外，写入需要一次 `danger-full-access` 升级。

### 3.13 纯画布模式不能靠隐藏 AppFrame 实现
`shell.overlay` 层是 **AppFrame 的子节点**，所以 `[data-ffc-frame] { display: none }` 会把插件自己的
面板与米饭碗按钮一起隐藏 —— **白屏且没有任何可点的出口**（实测：canvas-only 下 `.ffc-rice`/`.ffc-panel`
都是 0×0）。正确做法：
```css
body[data-ffc-mode='canvas-only'] [data-ffc-frame] { position: fixed; inset: 0; width: auto; }
body[data-ffc-mode='canvas-only'] [data-ffc-frame] > *:not([data-shell-overlay]) { display: none; }
```
即 frame 继续当 overlay 的活容器，只隐藏它**除 overlay 以外**的直接子元素。两层安全网：
**刷新自救**（`readMode()` 从存储恢复时把 `canvas-only` 降级成 `canvas`）、**Esc 逃生梯**（`shortcut.ts`）。

### 3.14 程序化移动视口要动画，用户操作绝不能动画
跟焦/适应内容是「跳到别处」（瞬移会丢空间感），拖拽/滚轮必须跟手。`canvas/actions.ts` 改视口时广播原因，
`CanvasStage` 只对 `focus`/`fit` 挂 240ms `transform` 过渡（`data-anim` 驱动 CSS），一有用户输入立刻撤掉。
⚠️ 也影响测试：断言几何前必须等动画结束 —— 现在**轮询到条件成立**而不是读一次（§8.6）。

### 3.15 `pnpm typecheck` 是干净的（94 → 0，已进门禁）
靠补齐手写 ambient 声明：`useRef<T>(initial: T): { current: T }` 的精确语义、`PointerEvent` 的成员、
JSX `IntrinsicElements` 显式列出事件属性 + `JSX.ElementType = any`、以及宿主自带的
`src/host/node-ambient.d.ts`（声明 `node:fs`/`node:path`/`node:url` 用到的那几个函数，**不引 @types/node**）。

### 3.16 主题钩子与 token 的语义坑（对比度复查抓出两处真 bug）
- 切主题的钩子：**`body[data-ds-dark-theme]`**（稳定数据属性，测试里直接 toggle 即可复现两套主题）。
- **`--dsw-alias-label-primary-inverted` 不是「恒为白」，而是「主色的反色」**：深色下是 `#353638`。
  而 `--dsw-alias-bg-mask-*` 两套主题**都是深遮罩** → 「深遮罩 + 反色文字」= 深字压深底（两套都糊）。
- **结论**：压在任意媒体上的浮层（节点悬浮条、失败徽标）用**固定**深遮罩 + 白字，或**不随主题翻转**的
  静态色（`--dsw-static-red-900`）。主题反色只适合「背景也随主题变」。
- `e2e-theme.mjs` 有效背景按祖先链 alpha 合成；**它只读 `background-color`、读不到渐变** ——
  被测元素别只用 `background-image`，否则会得到 1.0 这种假故障。

### 3.17 菜单基础设施（三处菜单共用一套行为）
`client/menu.ts`：`useMenuNav`（↑↓ 跳过禁用项并循环、Home/End、Enter/Space、Esc/Tab；容器 `role="menu"` +
`aria-activedescendant`，条目 `id` 与 `data-nav-active` —— **刻意不叫 `data-active`**，那个属性表示
「当前选中的模式」，两者必须共存）、`useMenuDismiss`（capture 阶段 pointerdown 判「点外面」、Esc、
可选 resize）、`useMenuFocus`、`clampToViewport`（右键菜单夹进视口）。
⚠️ `useMenuFocus` 的 **deps 必须覆盖「菜单真正挂载」那一刻**：条件渲染的菜单（`open && anchor !== null`，
而 anchor 要等一个 effect）只写 `[open]` 会在 ref 还是 null 时聚焦一次、之后再不重跑 ——
现象是「菜单打开了，方向键毫无反应」。
⚠️ 菜单**选完一项保持打开**（有意：用户常接着调），所以「切完模式再点按钮开菜单」实际会把它**关掉**（§8.4）。

### 3.18 直达命令面（P6 的地基）
```ts
ctx.commands.register({ name: 'generate', description, input: { hint, attachments?: true },
  recordInput: true,                       // false 时 command/run 不记 args
  handler: (inv) => CommandResult });      // { kind:'success', text? } | { kind:'error', text }
```
- `inv = { commandId, agent, rawInput, attachments, signal }`；`rawInput` 是命令名之后的**原文**。
- 命令结果**不进模型历史、不产生 token** —— 这是它值得存在的全部理由。
- 客户端派发 `session.command(line)` → `RemoteResult<{ matched: boolean }>`；**未匹配是 `matched: false`
  的普通结算，不是异常** → 「先试命令、未匹配再退回提示词」可行，且不需要事先探测注册表。
- 客户端把 `command/run` ↔ `command/done` 折叠成 `CommandNode` → **自定义命令的结果也能落画布**，
  不需要注册 Conversation Definition：按 `name === 'generate'` 认领、`args` 还原提示词、`outcome.text` 还原媒体。
- 命令结果只有**文本**一种载体 → 约定「成功文本的**第一行**就是媒体地址」（`formatCommandResult` /
  `mediaUrlFromCommandText`，两半边共用同一实现）。
- 命令服务可能缺席（裁剪过的组合）→ 与工具**分开** `inject(['commands'])` 降级（§8.15）。
- ⚠️ **settings namespace 只能注册一次**：结构是「先 `inject(['settings'])` 建 scope 与管线依赖，
  再在回调里 `inject(['tools'])` / `inject(['commands'])`」。嵌套 inject 在 cordis 里成立，
  **测试替身也必须照此建模**（早先的替身只认 `deps.includes('tools')`，改结构后完全打不中）。

### 3.19 画布作用域（P7）：一块画布还是每个会话一块
```ts
type BoardScope = string | null;                 // null = 共用那块；字符串 = 该会话
boardKeyFor(scope)  → 'fatfish-canvas:board' | 'fatfish-canvas:board:<sessionId>'
setBoardScope(next, { adopt })                   // 换键（先 flush 旧键，再读新键）
```
三份知识必须合在一处才对，但天然分居三地 → 接合点单独成模块 `canvas/scope.ts`：**偏好**
（`state.ts` 的 `fatfish-canvas:board-scope` = `shared` | `session`）× **当前会话**（`canvas/bridge.ts`
是唯一知道「当前会话是谁」的地方，`setScopeSession(id)`）→ **换键**（`store.setBoardScope`）。
1. **默认共用**：偏好读不到就是 `shared`。老用户升级后画布不能突然变空。
2. **只有「共用 → 隔离」这一步带画布过去**（`adopt`，且只在新键**从没写过**时）。无条件 adopt 会让
   会话 A → 会话 B 把 A 的画布抄进 B。已经清空过的会话画布是「写过但空」，因此不会被抄
   （用 `getItem !== null` 判，不是判空）。
3. **拿不到会话 id 就退回共用**：作用域是 `null`，画布照常可用。视图读数（工具条 `[data-ffc-scope]`）
   显示实际生效的那块，菜单里偏好那项则显示「待会话」—— 偏好与生效是两件事，不能混成一个读数。
4. **桥里顺序是「先切作用域、再落图」**（`bind()` 里 `setScopeSession` 在 `pump` 之前）：否则切会话的
   第一帧结果会落进上一个会话的画布。
5. 记账账本 `ingested` 随作用域独立 → 切回旧会话时历史快照不会重放节点。
6. ⚠️ **`fatfish-canvas:board-scope` 也以 `fatfish-canvas:board` 开头**：筛会话画布必须用
   `fatfish-canvas:board:`（**带冒号**），否则会把偏好键当成一块画布（§8.16）。

### 3.20 浮层压别人是**做法本身的问题**（P8/P10 两遍同一课）
- 米饭碗原来是 `shell.overlay` 里 `position: fixed; top:10px; right:12px` 的浮层按钮，而视口右上角正是
  `conversation.session.header.utilities` 席位，被 **`dsh-session-log-export`** 占着
  （`.nL4_yW_sessionLogButton`，111×32 @ x=1525,y=12）→ 正好压在它上面。
- **修法不是挪几个像素，而是换一种做法**：入口搬进**实数席位**。P10 最终落在
  `conversation.session.header.utilities` —— **session log 自己住的那个席位**（`order: 10` 明确排在它的 0 右边）。
  同一席位 = 同一个 flex 行（`gap: 8px`），并排摆开，**重叠在结构上不可能发生**。
- 位置「两种模式下不变」的原理：并排画布把 AppFrame 钉在 `left: var(--ffc-canvas-width); right: 0`，
  聊天列右缘就是视口右缘，而这个席位右对齐在聊天列头部。
  **纯画布模式是例外**：整列聊天收起 → 头部与入口一起不可见，那种模式的出口是顶栏那格「纯画布」按钮与 Esc。
> 教训：**能用席位就用席位。** 一个 32×32 的小按钮打进视口角落，等于赌别人不往那儿放东西。

席位的三个必须知道的性质：
1. **这些席位都是会话作用域**：`conversation.input.left` / `.right` / `input.dock` / `composer.dock`，
   以及 `conversation.session.header.utilities` **都在没有当前会话时不渲染**。本体的 composer 在
   hero（新会话）与会话态之间**复用同一棵 DOM**：隐藏的那份仍在文档里，因此
   `document.querySelector('.ffc-entry')` 可能先拿到**隐藏的 0×0 副本** → e2e 里必须按「rect.w > 0」
   挑可见的那一份（§8.20）。（真正没有入口的场景是没有工作区/没有会话时的 hero —— 那时用快捷键。）
2. **席位行都是 nowrap 的 flex 行**：加控件必须 `flex: none`，否则在挤压态会被**压成 0 宽** ——
   元素还在 DOM 里却完全点不到，探针量出来是 0×0，看着像「注册没生效」（§8.22）。
3. **批准等待会接管 composer**：`conversation.composer` 是链式席位，等待审批的会话由审批 UI 接管，
   InputBar 不渲染 → 工具行里的控件一起消失（有意行为）。e2e 挑「真实会话」时要避开这些。

### 3.21 设置：深路径写入 + 凭据库（P9 的地基，比 3.5 更彻底的解法）
**结论先说**：把密钥移出设置，嵌套结构才有地方放。
- **`settingsScope.set(field, value)` 仍然只能写顶层标量**（底层 `path:[field]`，没有点号拆分）。
  写嵌套叶子要直接调 `connection.api.settings.mutate({ ns, ops:[{op:'set', path:['providers', id, 'baseURL'], value}] })`。
- **宿主侧 `applyPathOp` 支持多段路径**（会创建中间对象），但**数组下标不可寻址**
  （`isPlainObject` 挡掉了数组中间层：`set` 会被校验拒掉，`unset` 是静默 no-op）→ **`models` 数组只能整体重写**。
- **密钥进凭据库**：设置里只存**引用名**（`apiKeyEnv`）。这样设置里**没有** `role('secret')` 字段 →
  脱敏视图 = 真实视图 → 任意写入形状都不会抹掉别人的机密（3.5 那条「必须扁平」的约束随之消失，
  这正是「一个供应商挂多个模型 + 每模型一把密钥」能成立的原因）。
- 凭据 API：宿主 `ctx.credentials.resolve(ref)`（**每次操作重新解析，不许缓存**）、`set` / `unset`；
  浏览器 `api.credentials.describe({refs})`（只回 configured/source/writable，**永不回值**）、`set`、`unset`。
  引用名必须匹配 `^[A-Za-z_][A-Za-z0-9_]*$` → 统一 `FFC_<供应商>_API_KEY` / `FFC_<供应商>_<模型>_API_KEY`
  （`shared/catalog.ts`）。
- **旧字段必须 unset，不能只是「不再声明」**：schemastery 非严格解析会保留未知字段，而脱敏遍历器按
  **schema 节点**走 —— 没节点的字段**不会被剥离**，留在文档里的旧明文密钥会被原样下发到浏览器。
  因此旧 `key_*/model_*/baseURL_*` 仍然声明着（`role('secret')`），宿主启动时迁移 + `unset`（`migrateLegacy`）。
- 默认模型的取值用 `供应商::模型`（`::` 而不是 `/`：模型 id 里真的会带斜杠，如硅基流动的 `Kwai-Kolors/Kolors`）。

### 3.22 P10：删掉「视图」菜单之后，每样东西去了哪
- **聊天 ⟷ 画布**：右上角那枚米饭碗（`EntryButton.tsx`）单击 `toggleCanvasMode()` —— 状态机本来就只有
  这一个（`chat ⟷ 上次用的画布模式`）。画布模式下只换 aria-label / title，**图形与位置都不变**。
  按钮里**不放文字**（同一行紧挨着 111px 的 session log，少两个字就是少 42px 挤压）→ 32×32 的**圆形**按钮。
- **纯画布**：画布顶栏独立一格（`aria-label="纯画布模式"`，`aria-pressed` 表达状态）。它不是「多一个入口」
  而是**唯一出口**：纯画布收起了整列聊天，右上角那枚米饭碗跟着不见了 —— 谁把它塞进菜单，谁就制造了
  「白屏且点不到出口」的隐患（§8.26）。
- **画布作用域**：开关落在**工具条那枚读数**上（读数与开关是同一件事的两面，既不新增宽度也不丢功能）。
- **跟焦**：工具条上本来就有图标按钮，菜单里那份随菜单一起消失。
- **画布宽度**：40 / 62 / 80% 预设随菜单移除；右缘拖拽 + 双击重置仍在，`fatfish-canvas:canvas-width`
  这个偏好键没变（所以 e2e 仍可预置 `'40%'` 测窄画布）。
- 删掉的文件：`src/client/ViewMenu.tsx`；随之删掉的样式：`.ffc-view-btn(-text)`、`.ffc-menu-wide`、
  `.ffc-menu-icon`、`.ffc-menu-row`、`.ffc-menu-badge-key`。
  ⚠️ `.ffc-menu-chip` / `.ffc-menu-note` / `.ffc-menu-label` / `.ffc-menu-check` **不能删** ——
  设置页、节点右键菜单、缩放菜单还在用。
- ⚠️ 删菜单会连带打断四个 e2e 套件里「靠菜单切模式 / 翻开关」的断言（§8.25）。

### 3.23 客户端 → 宿主的 RPC（Typert 远程命名空间）
设置页的「测试连接 / 获取模型列表」必须由宿主执行（只有宿主拿得到密钥）。
```ts
// 宿主：注册清单 + 一个带 typertRemote 绑定的服务
ctx.typert.register(PROBE_HOST_MANIFEST);                 // { package, face:'host', schemas, model, invocations }
(probe as any).typertRemote = { service: probe, serviceKey:'mediaProbe', namespace:'mediaProbe' };
ctx.provide('mediaProbe', probe);                          // ← 必须在**插件顶层** ctx
// 客户端：挂贡献，然后按命名空间取服务
await ctx.remote.$mount(PROBE_CLIENT_CONTRIBUTION);         // { package, descriptors:[…] }
const res = await ctx.get('remote.mediaProbe').testConnection(id);   // {ok:true,value} | {ok:false,error}
```
九条必须记住的点：
1. **两侧描述符不互相校验**（宿主只看自己的清单，客户端只看自己的贡献）→ 写歪一个字的症状是
   「点了没反应」或一个含混的网关错误。因此两侧**同源**：都在 `client/shared/probe.ts` 里由同一份
   `METHODS` 生成，测试里断言两者 id / namespace / method / 参数线名完全一致。
2. **服务必须在插件顶层 `ctx.provide`**：网关按名字从应用的服务表解析接收者，嵌套 `inject` scope 里
   provide 的服务不一定对它可见（§8.23）。做法：服务是稳定空壳，行为由一个 holder 在 settings 就绪后接入。
3. **客户端方法返回的是信封**：`{ok:true, value}` / `{ok:false, error:{code,message}}`，不是裸结果。
   忘了拆信封 → `result.ok` 永远是 undefined → 界面把成功当失败（统一走 `unwrapProbeResult`，§3.34）。
4. **编解码器必须 `mode:'strict'` 且带 `parse()`**：本插件**手写 `{parse}`**（不引 zod，profile 里
   `@michengai/dsh-archive-manager` 就是这么干的）。
5. **返回值必须是纯 JSON**（网关会拒绝类实例 / 循环 / 非有限数）。诊断打印绑定对象本身会抛
   「Converting circular structure to JSON」。
6. 密钥**绝不进返回值**（连错误里也不带：供应商的错误体可能回显请求头）。
7. ⚠️ **`connection.api.*` 的响应是两层的**：`callUnary` 返回 `{ rpcId, result }`，成败在 `result` 里
   （`dsh-host-apiproxy/lib/types/fetch/client.js`）。直接读 `response.ok` 永远是 `undefined` →
   **每一次成功都被当成失败**，且「revision 冲突后重试」的分支永不触发；而同一批里不涉及 revision 的
   **凭据写入其实成功了** —— 这种「一半成、一半不成」就是它最典型的指纹。
8. ⚠️ **派生服务必须先声明依赖才读得到**：`remote.<命名空间>` 是 `$mount` 之后才出现的**派生服务**，
   在没声明过该依赖的 context 上访问会**直接抛** `cannot get property "remote.mediaProbe" without inject`。
   若这一抛发生在 `settings.section` 的 `inject` 面里，React 会把整个分节丢掉 → 现象是「设置导航里有这一项，
   点开却是**一片空白**」。正解：在**声明了依赖**的嵌套 `inject` 里捕获服务、存进模块级变量，设置页只读
   那个变量；并且递**取值函数**（`getProbe`）而不是值 —— `$mount` 是异步的。
9. ⚠️ **「测试连接」不能要求供应商已经有模型**：探测目标要**直接读配置里的供应商**（baseURL + apiKeyEnv
   → 凭据），别从 `resolveModels()` 里挑 —— 后者只产出「有模型的供应商」，于是「刚加好供应商、还没加模型」
   这条最自然的使用顺序会报「找不到供应商」。

### 3.24 P12：文本模型看不见图，但参考图**不需要**经过它
**结论先说**：图是字节，模型只需要一个**句柄字符串**。四条已核实的平台事实：
1. **文本模型的图片附件只换来一行占位符，里面没有路径**：
   `[image omitted because this model accepts text only; attachment sha256:xxxxxxxx]`
   （`dsh-llm/lib/types/content.js` 的 `textOnlyImageText`）→ **别指望模型描述参考图**。
   （对普通文件是活的：`fileHandleText` 会给出只读路径。）
2. **命令面收附件**：注册时写 `input: { hint, attachments: true }`，`invocation.attachments` 就是
   `ImageBlock[]`（`dsh-commands`）。这是绕开模型的官方通路。⚠️ 附件标志在 **`input` 里面**（不是顶层），
   写歪了执行器会以「does not accept attachments」拒掉整次调用。
3. **工具面能拿到会话**：`ToolExecution.agent`（`dsh-tools`）—— 工具想自己从会话里捞图片附件是可行的，
   本轮**没用**（用命令行与显式参数就够了，少一条隐式行为）。
4. **读字节的 API 就在那儿**：`ctx.attachments.readImage(ref, signal)` 返回 `{ ref, data: Uint8Array }`
   （真机会回**存下来的**引用，因此 MIME 以它为准）；`imageHostPath(ref)` 是本机后端的宿主路径。
   宿主侧 `scoped.get('attachments')` 直接取，缺席时**必须抛错**，绝不静默出一张无关的图。

**三条通路（谁把图交给供应商）**：

| 参考图从哪来 | 句柄 | 过模型？ |
|---|---|---|
| 输入框里贴的图 | `ImageBlock.attachment` → `attachment:sha256:…` | 否（`/generate` 命令） |
| 用户**本回合**附的图（模型发起的工具调用） | 工具自己去会话里捞（见下「自适应」） | 否（模型全程看不见像素） |
| 画布节点 / 上一张结果 | `http(s)` URL（原样转给供应商，**零下载**） | 否（右键 → `--ref`） |
| 工作区里的图片文件 | 路径 → 读盘 → data URL（MIME 按**字节头**判） | 是（模型本来就看得到路径） |

**自适应：看得见就自己看，看不见就给字符串**（`host/tool.ts` 的 `resolveCallReference`）。
平台**已经**按路由能力切换喂给模型的东西：多模态条目（`deepseek-flash`、`deepseek-v4-flash-vision-exp`）
拿到真图片 + 一段带**只读路径**的说明文字（`requestImageHandleText` + `normalizedAccessText`），
纯文本条目只拿到 `[image omitted …sha256:8 位摘要]`。规则：

| 情形 | 做什么 | 为什么 |
|---|---|---|
| 模型写了 `reference: <地址>` | 用写的 | 显式胜过推断 |
| 模型写了 `reference: "attached"` | 用用户本回合附的图 | 文本模型唯一抄得动的短字符串 |
| 没写 + 路由**明确**支持图像输入 | **不**套用 | 模型自己看得见，参不参考它说了算 |
| 没写 + 路由纯文本 / **未知** | 自动套用用户本回合附的图 | 它手上只有一行摘要，没有别的办法把图交给生成 API |

能力判据：`session.requestContext()` 给出 provider+model，`ctx.llm.listModels(provider)` 给出建议性条目
—— **`inputModalities` 缺席 = 未知**（平台语义），只有明确列出才代表能力。查不到就按未知处理 → 照自动套用办：
**让参考图真的到达生成 API，比让它悄悄丢掉划算**。

「本回合」的边界靠会话日志（`host/session-images.ts`）：从末尾往回走，遇到最近的 `turn/start` 就停；
只看**顶层** `image` 块（`tool-result` 里嵌套的图是别的工具产出的）。上一轮附的图**不会**被套用。
⚠️ 会话事件信封是 `{ type, seq, time, data }`，用户消息是 `type: 'user/message'`，图片在 `data.content[].attachment`。

**为什么两个供应商字段必须可配**（`referenceMode` / `referenceField`）：图像默认把地址塞进
`/images/generations` 的 `image` 字段（new-api 系中转、各家兼容层都收），但 OpenAI 官方的 `gpt-image-1` /
`dall-e-2` **只认** `/images/edits` 的 multipart（`referenceMode: 'edits'`）；视频首帧字段名各家不同
（`image` / `image_url` / `first_frame_image`）。**字段名写歪时网关不报错、直接出一张纯文生图** ——
那是这条链路上最坏的失败模式，所以：默认值取覆盖面最广的写法，可覆盖，并且结果里回一个 `usedReference`
布尔（它只表示**我们发出去了**，供应商有没有采纳探测不到）。

**已知天花板**（都在源码里标了 `ponytail:`）：
- 画布右键只对 `http(s)` 与 ≤8 KiB 的 `data:` 地址可用（`REFERENCE_MAX_INLINE`）—— 兆级的 `data:` 大图
  进命令行会连同会话日志一起膨胀；升级路径是把字节走附件面上传。不合格时菜单项**禁用并写明原因**（title）。
- 不缓存结果字节：中转站的签名 URL 过期后就取不到参考图，那时如实报错。
- `referenceMode` / `referenceField` 只在 schema 里，**设置页还没有控件**；真要改先写 `settings.yaml`（热发布）。

### 3.25 P13：视觉模型当眼睛（看不见图的模型的第二条出路）
参考图解决的是「图怎么到达生成 API」，这一节解决的是「**模型自己不知道图里有什么**」。
**为什么它和图像 / 视频模型挤在同一张设置页**：它只需要一个 OpenAI 兼容的 `POST {base}/chat/completions` +
**同一个供应商的密钥**。另起一套配置意味着用户要为同一家中转站配第二把钥匙、进第二个页面 ——
而 `kind` 本来就是模型级的（P9 的决定），加第三档只是一行 union。所以：`kind: 'vision'` + `defaultVision`，
设置页的「默认模型」区域因此是三个并排的下拉（图像 / 视频 / 视觉）。

**流程**（`host/generate.ts` 的 `describeReference`）：看不见图 + 配了视觉模型 → `POST {base}/chat/completions`
（`VISION_INSTRUCTION` + 用户要求，图以 `image_url` 内联）→ 得到描述 → 生成提示词变成
`参考图内容：<描述>\n\n<用户原文>` → 结果里回带 `referenceDescription`（工具行显示「参考图：…」，
模型自己也能引用它）。

**四条硬规矩**：
1. **只在「模型看不见图」时发生**（判据复用 `routeSeesImages`）；`describeReference` 由**工具那一侧**打开
   （只有它知道当前路由与会话），命令 `/generate` 不带它。
2. **没配视觉模型 = 功能整体关闭**，一次多余请求都不发（`findVisionModel` 没配时返回 undefined 而不是抛错）。
3. **视觉调用失败只记日志、继续生成**。失败时提示词退回原文，**绝不**把半句失败说明塞进提示词，
   也绝不谎报 `referenceDescription`。
4. **描述绝不进 `presentationMeta` 之外的持久结构** —— 提示词里那份注入只存在于供应商请求里。

**已知天花板**：每次「看不见图 + 带参考图」的生成都会多一次视觉调用；`max_tokens: 400` 写死；
视觉模型必须与图像模型是**同一套 OpenAI 兼容协议**（非兼容的视觉服务需要各自适配器）。

### 3.26 P14：会话数据的真来源**不在 `SessionSnapshot` 里**
**症状**：聊天里图好好的、面板与工具条也正常，就是**画布永远一个节点都没有**，**没有任何报错**。
**根因**：`canvas/bridge.ts` 把 `binding.session.getSnapshot()` 当成 `ConversationSnapshot` 在读
（`snapshot.nodes` / `snapshot.runningCalls`）。而真实的 `SessionSnapshot`
（`dsh-api-session-controller` 的 `client/contract/snapshot.d.ts`）**只有生命周期与队列状态**
（`sessionId` / `queue` / `running` / `openState` / `blank` / …），**根本没有 `nodes` 字段** →
两个取数函数永远拿到 `[]`，`syncConversation` 每次都「什么都没发生」，既不写也不报错。

会话数据的**唯一实时来源**是 `binding.eventSource`（`ObservableSnapshot<SessionEventWindow>`），
`entries[]` 里躺着原始的 `tool/call` / `tool/result` / `command/run` / `command/done`。
**修法**：桥里新增纯函数 `conversationOf`，把事件窗口折叠成 `ingest` 认得的会话形状（落图规则一行没动）：
`tool/call` → `runningCalls[]` + `callId → 工具名` 索引；`tool/result` → `nodes[]`
（`data.message.source.callId`、`data.meta`、内层 `isError`）；`command/run` → `nodes[]`（`outcome: null`）；
`command/done` → 回填同一 `commandId` 的 `outcome`。`tool/result` **自己不带工具名**，必须靠索引；
窗口截断把某个 call 挤出窗口时由结果自带的 `meta` 兜底。

**为什么 219 项离线测试全绿却漏掉了它**：`verify-client.mjs` 的 `sessions` 替身**恰好按错误的形状建模**
（`session.getSnapshot: () => ({ nodes: [], runningCalls: [] })`）—— 替身与真机一起漂移。**替身必须只提供
真实存在的成员**：现在 `sessionsWith()` 只给 `SessionSnapshot` 的真实字段，落图用例全走 `eventSource`，
并新增一节「会话数据挂在 `SessionSnapshot` 上时**不**落图」把这个契约钉死。
**顺带修掉一个真 bug**：`ingest.textOfContent` 只扫一层 content，而真实结果是**两层**
（`[{type:'tool-result', content:[{type:'text',text}]}]`）→ 失败节点上永远只能写「宿主没有给出原因」。
> 教训：**「没有报错」不等于「在工作」** —— 这条路径没有任何断言，所以「读到 undefined → 空数组 →
> 什么都不做」能安静地跑很久。纯函数 + **真实形状**的替身，是唯一能在离线阶段抓住它的办法。

### 3.27 P15：画布交互（用户报的 7 件事）
| # | 现象 | 根因 / 修法 |
|---|---|---|
| 1 | 点米饭碗进画布**黑屏** | 真因见 §3.28（`useSyncExternalStore`）；另有独立现象「客户端半边没被加载」（stale rev） |
| 2 | 放大后图片糊，点一下才清晰 | `.ffc-world` 常驻 `will-change: transform` → 世界层成为独立合成层并**沿用旧的栅格化位图**。改为**只在动画期间**加 `will-change` |
| 3 | 半屏模式下图片移到聊天栏被覆盖 | 画布宽度可窄到窗口放不下（`--ffc-canvas-min: 360px`），而 AppFrame 在 DOM 里排在 overlay 之后。给 `.ffc-panel` 明确 `z-index: 10` |
| 4 | 点图片时画布出现白色选框 | `.ffc-viewport:focus-visible` 的 2px 内描边。删掉该规则（键盘可达性由节点选中描边承担） |
| 5 | （新）点空白处取消选择 | `onPointerUp` 增加 `pan` 分支：屏幕位移 ≤5px 才算「点空白」并 `clearSelection()` |
| 6a | （新）输入框聚焦时单击图片 → 送进聊天框 | 判据抽成纯函数 `canvas/clickintent.ts`（真值表测试） |
| 6b | （新）从屏幕外拖图进画布 → 落成画布节点 | 本体的附件 `drop` 挂在 `document`（bubble）；`canvas/dropfiles.ts` 在**捕获阶段**接管「落在 `.ffc-panel` 上」的拖拽，图片读成 data URL。判据 `shouldClaimDrop()` 是纯函数 |
| 7 | 放大上限不够 | `ZOOM_MAX` 4 → **10（1000%）**；预设补 400/800/1000% |

**「图片变成真附件」的通路**（复用平台自己的附件管线，不另造存储）：
```
点画布图片（输入框有焦点）
  ├─ data: 地址          → 浏览器直接还原成 File
  └─ http(s)（多为跨域）  → 宿主 mediaProbe.fetchImage 代取字节（无 CORS 限制）→ data URL → File
  → 在 composer 子树上派发合成 drop（dsh-client-ui-attachment 的 onAddFiles）
  → 平台自己上传、自己渲染附件卡片
取不到字节时退回「把地址插进输入框」并如实说明原因
```
- 宿主侧：`host/probe.ts` 的 `fetchImage`（只收 `image/*`、上限 8MB、错误里带地址不带凭证）。
- 客户端侧：`dom.ts` 的 `attachImageToComposer`（合成 drop）/ `insertIntoComposer`（退路）。
- ⚠️ **等重启**：`fetchImage` 是**宿主**新方法，重启前「跨域 http 图片存成附件」会走退路（插地址）。

**附件通路最初「只插进地址」的两个真 bug**（都在客户端，已修）：
1. **自己的捕获闸拦死了自己的合成 drop**：composer 在画布模式下属同一个面板区域，派发到 composer 的
   合成 `drop` 被自己的闸吃掉。→ `shouldClaimDrop(overCanvas, overComposer)`：**落在聊天输入区
   （`[class*="composer"]` / `[contenteditable]`）一律放行**。
2. **合成 `DataTransfer` 必须带 `Files` 类型、且事件必须冒泡到 `document`**：本体附件插件的 `onDrop`
   挂在 `document` 的**冒泡阶段**，并先做 `dataTransfer.types.includes('Files')` 过滤 —— 缺任何一条都是
   「什么都不发生、也不报错」。`attachImageToComposer` 现在派发在输入框上并断言 `types` 里有 `Files`。
> 教训：跨插件边界用**合成 DOM 事件**时，必须先把对方的**监听阶段（捕获/冒泡）、挂载元素、过滤条件**
> 读一遍再写 —— 三样里错一样都是静默失败。

### 3.28 P16：黑屏真因 —— **`useSyncExternalStore` 在这个运行时不触发重渲染**
**症状**：点米饭碗进画布，**整个左半边纯黑，连顶部工具条都没有**；刷新才正常。
**关键测量**：`body[data-ffc-mode]` 点一次就从 `chat` 翻到 `canvas`（store 是活的）、
`localStorage` 与 body 一致（持久化活着）、但 `document.querySelector('.ffc-panel')` **不存在**、
`[data-shell-overlay]` 的子节点是一个 0×0 的容器、React 树上有 `CanvasPanel` 组件（挂载了但返回 `null`）、
米饭碗自身的 `aria-label` 来回切两次都没变（**它也没重渲染**）。两处组件都卡在**首次渲染**上。
**根因**：`useSyncExternalStore`（`state.ts` / `canvas/store.ts` / `canvas/scope.ts` 里的订阅绑定）
在这个运行环境里**不触发重渲染**。它坏得很隐蔽 —— **首帧是对的**，所以「打开时就是画布模式」不会暴露。
**修法**：三处订阅换成 `useState` + `useEffect` 手写订阅（`useStoreValue`），并且给**模式**再加一条
**不经过 React、也不经过 store 的 DOM 通道**（直接读 `body[data-ffc-mode]` + `MutationObserver`）：
```ts
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
模式是「面板要不要渲染」的开关，它卡住就是整块黑屏 —— 这种要命的东西值得用**最朴素、已验证会动的事实**
（body 属性）兜底。`MutationObserver` 做了能力检测：拿不到它只是少了腿二，不该整块炸。
**回归测试**：`test-model.mjs` 第 10 节（自写 hook 替身）—— 首帧直接读快照 + store 变化后重渲染拿到新值 +
卸载后 setState 是 no-op + `getModeFromDom` 优先读 body 属性。
**⚠️ 这条修复只有离线与代码层面的证据**，真机确认靠用户刷新页面点一次米饭碗。
**顺带修掉的测试基建坑**：`BARE_STUBS` 声明在 `loadTsModule` **之后**而后者会引用它（TDZ）→
已把 `BARE_STUBS` 提到函数之前，并给 `loadTsModule` 加了可选第 3 个参数 `bareStubs`。
> 教训：① **「store 变了」不等于「界面重渲染了」**，这两件事要分别量（body 属性翻转只证明 store 与 CSS
> 生效）。② **首帧正确会掩盖订阅失效**，只在「组件挂载后 store 才变」的路径上暴露 → 端到端验证要
> **在同一个页面生命周期里改动状态**（点一下、再量），而不是「预置 localStorage → 刷新 → 量」。

### 3.29 P17：主界面三件事（模型选择 / 多图落位 / 对齐吸附）
**① 生成模型选择**（`settings/ModelPicker.tsx` + `settings/models.ts`）
- **位置**：注册进 `conversation.input.right`。这是「本体模型位左边那一格」——
  `input.right` → `input.model` → 用量环 → 发送（**以产物里的渲染顺序为准**，文档那句「模型位在它左边」
  与代码相反，§3.30.1）。`input.model` 是**单占位**，被官方 `dsh-client-ui-model-selection` 占着，抢不了也不该抢。
  代价：该席位是**会话作用域**，hero 欢迎页不渲染；纯画布模式下整列聊天被收起，这一格也跟着不可见。
- **外观与字体：照官方 `ModelSelect` 逐值抄**（§3.30）：触发器 `height:28px / border-radius:24px / 13px /
  font-weight:500`，第二段用 `--dsw-alias-label-caption`；菜单 `--dsw-specific-menu` 底、`20px` 圆角、
  `--dsw-elevation-prominent` 阴影、`padding:4px`、`max-height:min(360px,100vh-96px)`；分组标题 `sticky` +
  `12px/500`；行 `min-height:38px / radius:10px / padding:6px 8px`；勾与箭头直接用本体 primitives 的
  `IconCheckOutline16` / `IconChevronDownOutline14`。**「字体质感」没有捷径：只能与本体同一批数值、
  同一批 token、同一批图标。**
- **弹层挂到 `document.body`**（`createPortal`，官方同款）：composer 在 AppFrame 里，祖先上任何
  `overflow` / `transform` 都会把 `position: fixed` 的弹层裁掉或改变定位基准。定位也照官方：贴着触发器
  **向上**弹、右缘对齐、`MARGIN=12` 夹进视口，并且**先按 (0,0) 量一次真实尺寸再算位置**（菜单宽度由
  模型名决定）。打开期间监听 `scroll`(capture)/`resize` 重排，而不是关掉菜单。
- 它读到的是**设置页那一份数据**（`media-generation` 的 `providers` + `defaultImage` / `defaultVideo`），
  选一下写的就是那两个字段 → 两个入口天然一致，**没有第二套状态**（也没有放进 localStorage：宿主生成时
  读的是设置）。
- ⚠️ **组件拿不到分节的 inject 面**：做法与 `probeFace` / `hostApi` 完全一致 —— 在 `apply` 期的
  `ctx.inject(['settingsScope'])` / `(['remote.settings','remote.credentials'])` 里把 scope / 写入面交给
  `models.ts` 的**模块级持有变量**（`setMediaScope` / `setMediaApi`），组件只读那个变量；读不到就是
  undefined（按钮照常渲染、只显示「自动」），**绝不抛**。
- 写入走的是**与设置页同一个** `mutateSettings()`（revision 栅栏 + 冲突退回不带栅栏重试一次）。
- 菜单是「两个页签 + 平铺清单 + 供应商分组标题」：数据本来就是「供应商 × 模型」的平铺结构，做官方那种
  二级 drill-down 只是把同一份数据多点一次。视觉模型不进这两张清单（它不是产物）。
- ⚠️ 曾经放在**画布工具条**上（第一版）：那一格要额外操心「顶栏不溢出、没有控件被压扁」那条 e2e 断言。
  **以后往工具条加控件，仍然先看那两条断言。**

**② 一次拖进多张图**（`dropLayout` + `dropfiles.ts`）：原来一个文件算一次落点、都落在指针那一点 →
N 张完全重叠。现在 `onDrop` 把整批交给 `dropImages()`：全部读进内存 → `dropLayout(anchor, sizes)` 算网格
（一行 4 个、行内按前一个的**宽度**推进、行高取该行**最高者**）→ **一次** `addNodes`。第一张仍以拖放点为
中心。为什么不复用 `nextPlacement`：那个算法的坐标以画布原点为基准，而拖进来的图必须落在**用户松手的地方**。
- ⚠️ **落图之后会跟焦**（P26 实测，与旧注释相反）：`addNodes` 会通知画布的跟焦监听（`CanvasStage` 的
  `subscribeNodeAdditions` → `focusNodes` → `planFocus`），一屏放不下时用 `fitRect` **缩小**把这一批
  全带进视野 —— 实测一次拖 5 张：zoom 1 → **0.766**（视口 1032×860、包围盒 1180×660、padding 64，
  算式 `min((1032-128)/1180, (860-128)/660)` 对得上）；单张已经可见时 `planFocus` 判 `visible`，一动不动。
  **这是刻意保留的行为**（P26 与用户确认：一次拖十几张时「全都看得见」比「视野不动」有用），
  `dropfiles.ts` 里那句「不带过去」的注释已改掉。**写 e2e 的人注意**：节点 `style.left/top` 是世界坐标，
  而 `getBoundingClientRect` 是屏幕像素 —— 落图后两者差一个 zoom，直接比会假红。

**③ 对齐虚线 + 自动吸附**（`snapMove` + `CanvasStage`）
- `snapMove(moving, others, tolerance)`：六条参考线（左/中/右）两两比对，取容差内**偏移最小**的那一对；
  命中后回带辅助线，长度覆盖所有落在那条线上的矩形。两个轴各吸一次。容差是**屏幕**像素
  （`SNAP_TOLERANCE_PX = 6`）÷ zoom；**Alt** 临时关掉吸附。
- ⚠️ **位移必须按「相对按下点的绝对值」算**（`interaction.start` + `interaction.base` + 每帧
  `patchNodes` 写绝对坐标），**不能**沿用原来的「每帧增量 `translateNodes`」：吸附会把位置吸走一段，
  增量式累加会把这截修正留在下一次移动里 —— 现象是节点黏在吸附线上**甩不开**。吸附后偏移没变就**不写 store**。
- 辅助线画在**屏幕层**（`toScreen` 换算）：1px 虚线跟着 `scale(zoom)` 走，放大后会变成一条粗带。
  `data-guide-count` 是给 e2e 读的读数。
- 已知天花板：只做边/中线对齐，**没有**等间距与分布；整组拖动时对齐的是**整组包围盒**（Excalidraw 是
  逐个元素都比）。等真有人抱怨再加。

### 3.30 想「跟本体一模一样」，就去读本体的客户端产物（最省时间的一条路）
不要去截图里量像素：DSH 的每个第一方客户端插件都有**可读的构建产物**，里面照抄着 CSS 字符串、
组件源码逻辑与源码注释：
```
C:\Users\pc\.dsh\profiles\node_modules\@deepseek-ai\<包名>\lib\client.js
（同一份还有嵌套副本：…\profiles\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\<包名>\lib\client.js）
lib\types\**\*.d.ts    ← 类型与**大量设计意图注释**（席位契约就写在这里）
```
四条经验：
1. **席位契约先读 `.d.ts`**：`dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts` 把每个
   composer 席位「住着什么、谁在隔壁、作用域是 root 还是 session」写得明明白白（最终以**产物里的渲染顺序**
   为准 —— 文档那句与代码相反）。
2. **CSS 数值直接抄**：`--dsw-specific-menu` / `--dsw-elevation-prominent` / `--dsw-alias-label-caption`
   这些 token 名与尺寸都在产物里，照抄就是「同一个质感」。
3. **图标也别自绘**：本体 primitives 里有 `IconCheckOutline16` / `IconChevronDownOutline14`。
   往 `ambient.d.ts` 里补两行声明即可用；离线替身是 Proxy，任何成员都拿得到。
4. **弹层挂 body**：官方所有菜单都 `createPortal(..., document.body)` + 手动测量定位。

### 3.31 P18：节点化（连接点 / 连线 / 工作流元数据）
**形态**：每个节点四条边中点各一个**连接点**，进出合一（参考 ComfyUI，但把输入点与输出点合并成一个）。
方向只记在**连线**上（`CanvasLink.fromSide/toSide`）—— 否则会出现「从上面那个点拉、线却从左边冒出来」。
**连接点的可见性纯靠 CSS**（`.ffc-port` 默认 `opacity:0` + `pointer-events:none`，悬停时淡入）：
- 命中区 28px、可见圆点 16px ⇒ **「靠近就出现」不需要任何逐帧判定**；
- `pointer-events:none` 时它不抢指针 ⇒ 悬停节点边缘仍然是拖节点；
- `.ffc-node` 的 `overflow` 因此必须从 `hidden` 改成 `visible`（连接点一半探出卡片外），
  圆角裁剪改由 `.ffc-node-media` / `.ffc-node-bar` 各自负责；
- 尺寸恒定靠**内联 `transform: scale(1/zoom)`** + `margin: -14px` 定位中心 —— 用 `translate(-50%,-50%)`
  会和 scale 的变换原点纠缠，缩放后中心会偏。

**结果怎么回到生成节点上**（最容易踩的一处）：工作流跑的生成走现有 `/generate` 命令，而
`ingest.syncCommands` 原本会给每次命令**造一个 `gencmd_*` 新节点** → 不处理的话「每跑一次工作流，
画布上多一张来源不明的散图」。做法是命令行带 `--wf <节点 id>`（`shared/media.ts` 解析，宿主读到后
**忽略这个字段**、只当它是个合法开关），`ingest` 见到它就**回填那个生成节点**（status/src/prompt），
并照旧记 `gencmd_<commandId>` 的账（重放幂等）；**目标节点已被删除**时退回普通落图，结果不丢。
⚠️ 这一处让 P18 不再是纯客户端改动（`shared/media.ts` 宿主也在用，见 STATE §0 等重启）。

**元数据**：PNG 的 tEXt 块，键名 `workflow`（与 ComfyUI 同名）。三条取舍：
1. **只做 tEXt**，不做 zTXt/iTXt（ComfyUI 写的就是它，工作流文档只有几 KB）；
2. **非 ASCII 转义成 `\uXXXX`**：tEXt 规范里文本是 Latin-1，中文直接按 UTF-8 塞进去，Python 那边按
   Latin-1 解码会得到乱码；转义后整块纯 ASCII —— 与 ComfyUI 完全一致。**读取时不做反转义**，
   由调用方 `JSON.parse` 还原；
3. **CRC32 手写**（15 行查表），不为一个校验和引包。`writePngText` 对同名键**先删后写**，
   否则反复导出会积累同名块、读到的永远是第一个。

**导出的是整块画布**（不是「这个节点所在的子图」）。文档里的 `src` **只留 `http(s)`** —— `data:` 大图会把
文档撑到兆级，而导出的 PNG 本身就带着像素。
**拖回还原不自动执行**：只落节点 + 底部提示「右键 → 还原工作流」。`planRestore` 做三件事：id **全部重映射**、
锚到落点、落点被占时整体让开。文档里带的是**真 ComfyUI 的工作流**时（`app` 字段不是我们的）如实说
「本版本还不能还原」，而不是猜着还原出一堆空节点。
**顺带修的一处**：`isComposerFocused` 现在把 `.ffc-panel` 里的输入控件排除掉 —— 文字节点的编辑框也是
`textarea`，不排除的话「在画布里改提示词时点一下图片」会被当成「引用这张图送进聊天框」。

### 3.32 P19：串联（环 / 拓扑序 / 等上游）与参数面板
**串联**：`canLink` 放开了 `gen → gen`（此前一律拒绝），带来两件必须自己做的事：
1. **环检测** `wouldCycle(links, from, to)`：新边成环当且仅当 `to` 能顺着出边走回 `from`。
   理由文案「这样会绕成一个环，工作流排不出执行顺序」，在**连线那一刻**就拒。
2. **拓扑序** `topoOrder(nodes, links)`：Kahn，但**只把生成节点之间的边算作依赖**（图片 / 文字节点永远就绪，
   让它们参与排序只会让顺序看不懂）；同层按视觉顺序。每轮重扫找入度 0（O(n²)）：生成节点是「一屏几个」
   的量级。存储里若有手工改坏的环，剩下的按视觉顺序收尾 —— 宁可顺序不完美，也不要卡死。

**为什么必须「等上游」**：下游命令行里要的是上游的**产物地址**，而那个地址由宿主异步回填。
`session.command()` 结算时回填**不一定**已经发生。`waitForSettled` 用 `subscribeBoard` 等一次 store 提交
（不是轮询：回填本身就是一次提交），超时 15s 判失败。上游失败 → 下游立刻判失败并**写明上游的原因**。
⚠️ 一个实测到的行为：**`failed` 的节点下一轮会被重跑**（这是对的 —— 用户可以修好配置再点一次）。
写测试时别指望失败节点停在原地。

**参数面板**：生成节点多一条 `.ffc-node-gen-head`（两个原生 `<select>`：产物种类 + 画幅比例）。
- 用**原生 select**：自带键盘与无障碍，而参数只有两三个，弹一层自绘菜单是纯开销。整条 `data-ffc-ui` +
  `pointerdown` 阻断冒泡 —— 不然点下拉框会变成拖节点。
- 改参数时**节点形状跟着变**（`mediaNodeSize({kind, aspectRatio})`）：否则选 16:9 之后卡片还是正方形，
  出图时留一大块空白，看着像出错。
- 字段是 `genKind` / `ratio`，**刻意不复用 `kind`**：`kind` 说「这是个什么节点」（`gen`），`genKind` 说
  「它会画出什么」（图像 / 视频）。
- 三个地方都要带上它们：命令行（`planOf`）、持久化（`reviveNode` 用 `ASPECT_RATIOS` 校验，坏值一律丢掉
  退回缺省）、**工作流文档**（不然还原出来只剩半个工作流）。
- 顺带把 `NodeMenu` 的「重新生成 / 以此为参考图生成」改成读节点参数（此前对生成节点传的是
  `node.kind === 'gen'`，视频节点会被当成图像重跑）。
- 比例清单只有一份：`shared/media.ts` 的 `ASPECT_RATIOS`。
**仍然不做的**（天花板）：并行分支调度（同一层的多个节点也是串行）、上游失败时下游的降级路径。

### 3.33 P20：参数补完 / 运行此节点 / 复制节点
**视频参数**（`duration` / `resolution`）与种类、比例走同一套：进命令行（`planOf`）、进持久化
（`reviveNode` 校验）、进工作流文档。两处刻意取舍：
- **只在产物是视频时才显示这两个下拉框**，命令行里也只对 `--video` 生效；
- **`undefined` 与「0 秒」不是一回事**：没设 = 用生成管线的默认值，因此 `genDurationOf` 只认正数，
  下拉框里那个空选项就是「用默认」。
- 档位清单（`VIDEO_DURATIONS` / `VIDEO_RESOLUTIONS`）与 `ASPECT_RATIOS` 一起放在 `shared/media.ts`。

**`regenerateCommandLine` 改收一个对象**：调用点已经五种组合（重新生成 / 参考图 / 工作流 / 视频 / 叠加），
继续加位置参数就会出现「第 5 个是 ref 还是 wf」这种只有写的人记得住的问题。`regenerate()` 同样收对象，
但**退回提示词只带种类与比例** —— 模型本来就要重新调工具，多写两个参数只会让它抄错。
**「运行此节点」**（`runSingleNode`）：只跑一个，**不重跑上游**。上游还没出图时明确说「上游节点还没有出图」
并**一条命令都不发**。**「复制为新节点」**：只对文字 / 生成节点开放；副本**不带身份、不带产物、不带运行状态**
—— 带 `src` 的话新节点一上来就是 ready 且显示旧图。落在原节点右边一格（`PLACEMENT_SPACING`）。
**顺手修的一处**：`runOne` 现在每一步都**重新读 store 里的自己**（此前用调用方传进来的快照）——
一次运行要跑好几个节点、还可能等上游十几秒，期间用户完全可能改参数或挪线。

### 3.34 P22：本地图当参考图（反向字节通路）
**问题**：参考图从画布到宿主的唯一通路是 `/generate --ref <地址>` 那一行**文本**，而它会进会话日志。
本地拖进来的图 `src` 是一张几兆的 `data:` URL，客户端因此在**连线那一刻**就拒绝
（`REFERENCE_MAX_INLINE = 8192`）—— 用户看到的是「这个节点的地址不能当参考图」，真因他猜不到。
**解法**：加一条**反方向**的字节通路（与 `fetchImage` 正好相反）：
```
客户端  mediaProbe.storeReference(dataUrl)
宿主    decodeDataUrl → ctx.attachments.saveImage({data, mediaType})   ← 校验 + 规范化 + 内容寻址
        ctx.attachments.imageHostPath(ref)                            ← 附件库在磁盘上的绝对路径
客户端  节点的 ref = 那个路径
```
之后 `--ref <路径>` 走的是 `host/reference.ts` 里**本来就有**的那条分支（「其它一律当文件路径」→ 读盘 →
data URL），因此参考图链路一行没改。
**为什么句柄是路径而不是 `attachment:<id>`**：`--ref` 只能带一个字符串，而 `attachment:` 那种写法要
**额外带上 MIME** 才校验得过（`readAttachmentRef` 会拼一个 `mediaType: ''` 的引用），字符串里塞不下。
路径分支不需要 MIME（按字节头嗅探）。
**几个刻意的取舍**：
- **只收 `data:`**（http(s) 地址本来就塞得进命令行）；
- **上限 16MB**（`STORE_REFERENCE_MAX_BYTES`）：字节要经 RPC 过一次页面；
- **在落图之后异步做**（`dropfiles.ts` 的 `attachReferenceHandles`）：拖进来的图必须立刻出现，存句柄是
  加分项；失败**立刻说出来**（否则用户会在连线时撞上一句「重新拖一次」，而真因已经在这一刻发生了）；
- **存进附件库而不是临时文件**：内容寻址，重复拖同一张图不会存两份；代价是附件服务会做**规范化**
  （可能降采样），发出去的参考图不一定与原始字节一致；
- **`ref` 进持久化与工作流文档**（它很短）。
**接线方式**：`dropfiles.ts` 用**注入**拿宿主面（`setReferenceStore(() => getProbeFace())`），
不 `import { getProbeFace } from '../index'` —— 那会把 `index.tsx`（JSX、整个插件体）拖进这个纯逻辑模块，
离线测试一加载就炸（`ts.transpileModule` 不转 JSX），还多一个循环 import。

**补丁一（用户实测「拖了还是那句提示」）**：只在**落图那一刻**存句柄是不够的 —— 已经躺在画布上的节点
（刷新前就在的）和供应商**内联返回**的生成结果（`b64_json` → `src` 是几兆的 `data:`）都不会再经过
`dropImages`，于是它们永远没有句柄，而提示只会让用户「重新拖进画布一次」。现在**连线被拒的那一刻当场补存**
（`CanvasStage` 的 `linkAfterStoringReference`）：`canLink` 判否且 `needsReferenceHandle(from)`
（`graph.ts` 新导出的判据，与提示文案同源）→ 请宿主存一次 → 重跑 `canLink` → 成功就**直接连上**，
失败才说话。判据挂在连线上是**完备**的：画布上的边只有两个来源（拖拽 / 还原工作流，后者自带 `ref`）。
**补丁二（同一处的第二个真 bug，用户实测「存成功了却报没存成」）**：重跑 `canLink` 时读的是
`boardRef.current` —— 那是**渲染快照**，要等下一次渲染才更新，而 `ref` 是 `updateNodes` **同步**写进 store 的
→ 判定拿着「还没有 ref」的旧快照。**凡是「异步做完一件事、紧接着按结果做判定」的地方，读 `getBoard()`，
不要读 `boardRef`。**
**补丁三（真正的根因 —— 前两条修完仍然连不上，就是它）**：`remote.mediaProbe.*` 的回包是**信封** ——
`dsh-api-gateway` 的客户端 `invoke()` 一律返回 `{ok:true,value}` / `{ok:false,error}`，**不是**宿主方法
自己的结果对象。画布侧三个调用点都直接读 `raw.ok` / `raw.ref` / `raw.dataUrl` → 恒为 `undefined`，
而且**静默**：

| 调用点 | 症状 |
|---|---|
| `dropfiles` 的 `storeReference` | 附件**已经存好了**（877 KB 落地为证），但 `ref` 永远写不上 → 连线恒被拒 |
| `CanvasStage` 的 `fetchImage` | 「点画布图片 → 真的图片附件」永远静默退回插地址 |
| `exportImage` 的 `fetchImage` | http 图片「导出带工作流的 PNG」恒失败（返回 null） |

三条都改走 `unwrapProbeResult`（`client/shared/probe.ts`，与描述符同住一个共享契约模块），设置页那份
重复的信封类型并了进去。**替身必须回信封**：`test-model.mjs` 里的 `storeReference` 替身原来直接回宿主
结果对象，留在那儿这个 bug 就永远测不出来。
**天花板**：供应商内联返回的大 `data:` 图要在**连线那一刻**才会被存成句柄 —— 因此「连之前」节点上仍然是
那张几兆的内联图（持久化与内存都带着它）。

### 3.35 P23：浏览器 e2e 一上来就抓出两个「视觉上对、鼠标点不到」的真 bug
`scripts/e2e-graph.mjs`（61 项）第一次真跑，P18 的两处交互当场红了 —— 两条都是**从没被鼠标测过**的功能
（老套件全用方向键 + Enter，与 P21 的成因完全相同）。
**bug 1：连线中点的 × 永远点不到**（`LinkLayer` 的悬停状态）。原设计是「悬停连线中点 → 才出现 ×」。
实测读数：`elementFromPoint(中点)` 是 `path.ffc-link-hit`，而 `.ffc-link-x` **不在 DOM 里**。根因是
**自我拆台的回环**：按钮正好长在指针底下（20×20），把它显示出来的这个动作**把指针从线的命中路径上抢走**
→ 线失去 hover → `pointerleave` → 按钮卸载 → 指针又回到线上 → 再 `pointerenter`……来回抖。
修法是**删掉状态**而不是加定时器：每条连线的 × **常驻**（`opacity: .55`，`:hover` 时实心），`LinkLayer`
因此少了一个 `useState` 与两个事件处理。三条断言钉住「看得见、`linkXHit` 为真、点了就删」。
**bug 2：双击文字节点永远进不了编辑态**（`CanvasStage` 的指针捕获）。`onNodePointerDown` 里按下就
`el.setPointerCapture(e.pointerId)`（视口捕获），而**指针被捕获时，随后的 `click` / `dblclick` 会被改派给
捕获元素** → `NodeCard` 的 `onDoubleClick` 永远收不到事件。更隐蔽的是**同一段代码没影响别的按钮**：
× / 播放键都在自己的 `pointerdown` 里 `stopPropagation`，压根走不到捕获那一步。修法：**真的开始移动时
才捕获**（`onPointerMove` 的 `move` 分支里补 `hasPointerCapture` 判据），原地双击仍归节点，拖拽照样顺滑。
**顺带暴露的一套陈旧断言**：`e2e-canvas.mjs` 的「拖节点 / 框选出现选框」红了，诊断输出指向 P15 的
行为变更 —— **本体输入框默认聚焦**，而「输入框聚焦时点图片 = 引用进聊天框」（`clickintent.ts`）让拖拽
那一下变成「送进聊天框」；框选那条则是起点 `(vp.x+6, vp.y+6)` 落在**压着视口左上角的种子节点**里。
两条都改成了「先点一下空白再拖 / 从右下空白起手」并留了诊断输出，但**改完这一版还没跑**（见 STATE §7.2）。
> 教训：**任何在 `pointerdown` 里做的「接管指针 / 卸载自己」动作，都要先问一句「我自己后续的 click /
> dblclick 还到得了吗」** —— §8.30 与 §8.32 是同一个坑的两个出口。

### 3.36 P25：会话画布的回收（删会话不删画布 → 键会堆到配额满）
**问题**：隔离模式下键是 `fatfish-canvas:board:<sessionId>`，**删掉会话不会删它那块画布** ——
localStorage 没有生命周期钩子，宿主也不通知客户端。后果不只是「不整洁」：画布节点里可能背着几兆的内联图
（§3.34 的天花板），而 localStorage 的配额是**整个 origin 共用**的 —— 堆满之后 `setItem` 抛异常，
`store.ts` 的持久化 catch 掉它，于是**画布从此不再落盘**，用户以为画布还在。
（这条链路值得单独记：**配额错误在我们的代码里是静默的**。）
**判据全部来自平台，一处都不猜**（`canvas/scope.ts` 的 `prunableSessions` / `orphanBoardKeys`）：

| 判据 | 出处 | 为什么必须这样 |
|---|---|---|
| `phase === 'ready'` 才动手 | `SessionListState.phase` | 平台契约原话：「ready + 空表 = 真的没有会话」。`pending` 期间删东西就是拿用户数据赌加载速度 |
| `ids` 缺席就什么都不删 | `SessionListState.ids` | 老宿主 / 裁剪过的组合没有这个字段；**读不到就按「不知道」办** |
| 前缀必须带冒号 | `SESSION_BOARD_PREFIX = 'fatfish-canvas:board:'` | `fatfish-canvas:board-scope` 也以 `fatfish-canvas:board` 开头，不带冒号筛就会**把偏好当画布删掉**（§8.16） |
| 共用画布、`getBoardKey()`、桥最后告知的会话 | `store` / `scope` 自己 | 列表刷新的一瞬间，当前正在看的那块可能还没列出来 |

**「不会误删别的工作区」是查过源码才敢写的**（这条最关键，别改成想当然）：客户端的会话表 =
`ctx.sessions.list` ← 控制器 `list()` ← `sessionQuery.listSessions()` ← `persistence.list()` ←
`dsh-session-persistence-jsonl` 的 `listArtifacts()` —— 它 `for (const project of await this.listProjectDirs(signal))`，
而 `listProjectDirs` 就是 `readdir(this.root)` 后**取每一个目录**：sessions 根目录下的**全部工作区**都在表里。
因此「换成另一个项目目录启动 dsh web」不会让上一个工作区的画布变成孤儿。**如果哪天这条链变了
（例如给 list 加了 cwd 过滤），这个功能会从「回收垃圾」变成「删用户东西」—— 改平台版本时先重查这里。**
**仍然不回收的**（有意留着）：表里排除的「只有面包屑的分支行」（子代理地址行）—— 如果一个子代理会话
曾经被打开过并画过东西，它不在 `ids` 里，会被收掉。代价是「再打开那个子代理会话时画布是空的」，
**媒体本身还在会话日志里**。真要为它加固，得从 `subagentsByParent` 目录里取活着的子会话。
**实现落点**：`store.ts`（前缀常量 + `sessionOfBoardKey`）、`scope.ts`（两个纯判定 + `installBoardGc`）、
`index.tsx` 在 `installBoardScope()` 之后一行装上。判据全是纯函数，`test-model.mjs` 的 8b 节把
「什么时候**允许**删」「哪些键**不许**碰」逐条钉住（14 条），并带一个装上真跑的用例（pending 不删 → ready 才删）。

### 3.37 网关与设置写入面的实测行为（P9–P11，别重新发现）
- **「回的是不是网页」就是「这个地址上有没有这个端点」的判据**：基址漏 `/v1` 时，贞贞工坊
  （`https://ai.t8star.org`）对陌生路径**不返回 404，而是回自家那页 HTML 首页（HTTP 451）**。
- 它的视频端点只有**单数** `/v1/video/generations`（复数那条约 451）；图像 `/v1/images/generations`
  与 `/v1/images/edits` 则与 OpenAI 一致。（所以 `probe.ts` 里视频那条路径不能照抄图像的复数写法。）
- **`ctx.connection` 只有 `rpc` / `generation` / `state`，没有 `api`**：设置页原来读 `ctx.connection.api`，
  于是**每一次写入**都炸在 `Cannot read properties of undefined (reading 'settings')`（改基址失焦即回退、
  删供应商也只报这一句）。写入面走网关派生的 `remote.settings` / `remote.credentials`（§3.23），
  签名是**位置参数**（`mutate(ns, ops, revision)`、`set(ref, value)`）。
- 旧代码写的冲突码 **`settings-conflict` 永远匹配不上**，真名是 `settings/conflict`。

### 3.38 前端的 `layout` 面也改过名（P26 实测，别再用老名字调）
- 插件 `ctx.inject(['layout'])` 拿到的那个面上，**详情栏的两个方法在新版改了名**：
  老版 `openDetails()` / `closeDetails()`（`ambient.d.ts` 里当初就是照它声明的），
  **0.1.5-rc.3 起是 `openRightbar(track, fullscreen)` / `closeRightbar()`**
  （在 `dsh-client-ui-layout/lib/types/client/service.d.ts` 里能看到当前签名；
  全仓搜 `closeDetails` 已经**一个都没有**）。同一个面上还有 `selectPanel` / `beginNavigation` /
  `toggleSidebar` / `dispose`。
- 教训不在「改名」本身，而在**调用点怎么失败**：写死老名字 → 每次 `emit()` 抛 `TypeError`
  → 见 §8.36（一个订阅者抛错冻住后面所有 UI，症状跟这一格毫无关系）。
  **凡是 `ctx.inject` 进来的平台面，调用一律用可选链 + 新老名字都试**，并且
  `ambient.d.ts` 里把成员**声明成可选**（声明成必选 = 让调用点以为它一定存在）。
- 顺带：这类功能（进画布时收起右侧详情栏）在抛错期间是**静默失效**的 —— 用户不会看到任何报错。
  所以「平台面调用」是新版本升级后最值得怀疑的一类代码。

---

## 4. 关键决策与理由（只列理由不显然的）

| 决策 | 理由 |
|---|---|
| **自绘轻量画布**，不用 Excalidraw/tldraw/React Flow | 它们自带外壳与主题会和 DSH 打架；自绘可完全用 DSH token 上色 |
| 键位：**拖拽=平移、滚轮=缩放、Shift+拖拽=框选** | jaaz/Excalidraw 默认相反，用户实测「无法正常使用」 |
| 画布键盘挂在**画布元素自身**（tabIndex=0） | 右侧就是聊天输入框；监听 window 会让用户在聊天里按 Delete 误删节点 |
| 缩放锚点用**视口元素自身 rect** | 面板顶部有 44px 工具条，混用会让锚点纵向偏移一个工具条高 |
| 视频节点不用原生 `controls`（聊天工具行用） | 画布上整块节点要能拖拽，与原生控件抢指针 |
| 自写 TS 打包器；宿主半边**不打包**、按模块图镜像 `lib/` | esbuild 原生二进制在本机被 pnpm 目录重命名反复卡死（EPERM）；Node ESM 原生多文件，打包只会让调试变难 |
| 共享代码放 `src/client/shared/` | 客户端打包器只把 `src/client` 当解析根；宿主用 `../client/shared/*` 反向引用 |
| 画布节点 id = `gen_<callId>` / `gencmd_<commandId>`（**幂等键**） | 重复快照不造重复节点；用户删掉的节点不被历史重放复活；两个 id 空间分开前缀避免撞车 |
| 幂等记账 `ingested` **随画布持久化** | 不持久化的话，刷新页面会把用户删掉的节点造回来 |
| 只吃「seq 越过基线」或「10 分钟内」的结果（`INGEST_FRESH_MS`） | 打开老会话不该把历史生成铺满画布；但刚打开页面时正好完成的那次要补上 |
| 结果只**改状态与 src**，不重新落位 | 占位节点与出图后的节点必须重合，否则出图瞬间跳一下 |
| 新增节点用**事件**通知而不是读状态 | 「刚刚落了什么」不能从「现在有什么」推出（挂载时读一次会把历史当新增） |
| 跟焦用「开关 + 忙碌 + 安静期」三闸，超时放弃 | 自动移动视口有代价：正在拖拽/刚操作过时抢画面很恼火；1.5s 还不安静就宁可不动 |
| 视口动作集中在 `canvas/actions.ts` | 工具条/菜单/快捷键/画布内部必须走同一份 fit/zoom/focus，否则锚点与留白漂移成两套 |
| 右键菜单作用于**当前选择**（右键先把选择收敛到该节点） | 心智模型只有一条；多选时删除/带到视野作用于整组，复制/重新生成只在单选可用 |
| 复制/发送类动作**不关菜单**；危险项常驻淡红底 | 用户常接着复制另一项；危险项一眼可辨且托起深色下的对比度（§3.16） |
| 「重新生成」**优先 `/generate` 命令**，未匹配才退回提示词 | 命令零 token、更快，结果还会以命令节点回客户端并落图 |
| 命令与工具**共用一条生成管线**（`host/generate.ts`） | 否则「没有密钥」这类错误在两处各长一句话 |
| 供应商/模型是**用户数据**，目录降级为「一键添加」的预设 | 「一个供应商挂多个模型」要求结构开放；预设只负责预填 |
| 设置页文本字段**草稿 + 失焦提交**（不是逐键写盘） | 逐键写 = 每个字符一次磁盘写入，还会不断撞 revision |
| 写入带 revision，冲突时**退回不带栅栏重试一次** | 镜像的 revision 有更新延迟，快速连点会撞上自己上一次的写入 |
| 探测走**宿主**（Typert 远程命名空间），不下发密钥 | 见 §3.23；顺带把「测试连接」与「获取模型列表」合成一次请求 |
| 「重启 + 验证」交给独立进程（`post-restart.mjs`） | `dsh web` 就是承载对话的进程：会话里直接 kill 会当场结束自己这一轮（STATE §6.1） |
| `--ref` 优先于顺手附上的图 | 用户**写下来的地址**比「刚贴的那张」更明确；两个都给了要有确定行为，不能靠顺序 |
| 结果只回一个 `usedReference` 布尔 | 参考图地址可能是兆级 `data:`，进会话事件就是灾难；用户需要的只是「这次到底带没带」 |
| 只认**本回合**顶层 `image` 块（`host/session-images.ts`） | 上一轮的图静默套用会产生「和参考图无关的结果」 |
| 视觉模型是**同一个供应商字典里的第三种 `kind`** | 它只需要 `{base}/chat/completions` + 同一把密钥；另起一套配置 = 让用户配第二把钥匙（§3.25） |
| 拖进来的多张图**一次性算网格再落位**（`dropLayout`） | 一张一张落 = 全叠在指针那一点（§3.29②） |
| 吸附的位移按**绝对基准**算；辅助线画在**屏幕层**；容差 = 屏幕像素 ÷ zoom | 见 §3.29③：增量累加会让节点黏住甩不开；世界层的 1px 虚线会变成粗带 |

---

## 8. 坑与教训（避免重犯）

1. **PowerShell 5.1（不是 pwsh 7）**：没有 `-Encoding utf8NoBOM`；命令替换里别用反引号；单引号里的 `\n`
   是字面量。**含中文的源文件只用 `edit`/`write` 工具改** —— `Get-Content -Raw | Set-Content -Encoding UTF8`
   会先按 ANSI/GBK 解码，把整篇中文写成乱码（**有损**，踩过两次，连 STATE.md 自己都中过）。
   控制台显示乱码 ≠ 文件坏了，用 `read` 工具确认。`ReadAllText`/`WriteAllText(UTF8 no BOM)` 这一对是安全的，
   但**优先用 `edit` / `write` 工具**。
   *真坏了怎么救*：每一步都在 `C:\Users\pc\.dsh\sessions\<工作区目录名>\<session-id>\session.v3.jsonl.zstd`
   里（**zstd 多帧**，一帧一条 JSON —— Node 的 `zstdDecompressSync` 只解第一帧，要按 magic `28 B5 2F FD`
   切帧逐帧解）。里面既有 `read` 的结果（= 损坏前的全文，带 `N: ` 行号前缀），也有此后每一次 `edit` 的
   `old_string`/`new_string` → **先按行号拼回原文、再按顺序重放每一次 edit** 即可逐字节还原。
2. **pnpm 的 EPERM**：本机该卷上 pnpm 的原子目录重命名有竞态，带原生二进制的包（如 esbuild）会反复失败；
   `.npmrc` 已设 `package-import-method=copy`。
3. **`insert` 补丁不去重**：bundle 层与 profile 层只能有一处插入（否则插件加载两次、settings namespace 重复注册报错）。
4. **断言写错比代码写错更常见**：多次「测试失败其实是断言错」（`className` 精确相等、围绕中心缩放时原点必然
   变化、禁用态指望环境、按钮点了外接矩形角上、菜单选完不自动关、共享画布上断言绝对节点数）。
   **失败时先怀疑断言 / 先怀疑测试自己。** 数量断言要么按**基线增量**，要么按 **id 存在性**，不要断言绝对个数。
5. **测试替身必须照实建模**：`ctx.inject` 只在依赖齐备时回调（且要支持嵌套 inject）；`instanceof HTMLElement`
   要真实类实例；pointer capture 不能被替身绕过；window 上的监听器要实现；远程调用要回**信封**（§3.34）。
   **替身比被测代码更自由，因此它退化的方式就是测试失真的方式** —— 全局替换（fetch / 定时器 / 存储）的东西
   用完必须还原，且还原点写在替换点旁边（实测：`test-host.mjs` 的探测节把 `globalThis.fetch` 换成自己的替身
   没换回来，于是**后面每一节**的请求都打到那个替身上，症状是「主替身没被调用却收到一个奇怪形状的响应」——
   看着像适配器坏了。现在主替身提成具名函数 `mainFetch`，探测节结束时显式换回。§3.26 与 §3.23.9 同源）。
6. **「读太早」是测试假故障的第一来源**：去抖写盘（画布 400ms，断言持久化前先 sleep 800）、程序化移动的
   240ms 动画、React 异步渲染（同一次求值里 `click()` 后立刻查 DOM 必然查不到）、命令结果异步结算。
   **要么等够时间，要么轮询到条件成立。**
   反向的一条：**被丢下的 store 实例会「迟到写盘」** —— 测试每节用新模块实例，各自带一个 400ms 去抖定时器，
   它会在**后面某一节的 `await` 里**触发，把上一节的画布写回全局键（症状：下一节 load 出来的画布多出几个
   陌生节点，而且是**间歇性**的）。对策：小节省尾 `flushPersist()`，或在 `storage.clear()` 前
   `await drainPersistTimers()`。断言失败时**先怀疑这个**。
7. **点击要落在按钮中心**：圆角按钮的外接矩形左上角**命中不到**（角上那一像素在圆角外，事件穿到父元素）——
   曾表现为「工具条按钮点得动、米饭碗点不动」，看着像组件坏了。
8. **动作会移动视口，旧坐标立刻失效**：e2e 每步之后都要重新读坐标（「带到视野」把节点挪走后，后续的右键就点空了）。
9. **别把会话 id 的 `session-` 前缀削掉**（§3.10.3）：无效 id 不报错，只会静默落到别的会话上，
   表现为「落图完全不工作」。
10. **测试会覆盖宿主的诊断产物 —— 而且「备份+还原」救不了**：导入 `lib/index.js` 就写 `host-status.json`，
    而它的主人是**运行中的 dsh web**。早先的做法是「导入前备份、跑完还原」，但那只在文件**本来是干净的**时候
    成立：一旦某次运行把污染写回去，之后每次「备份」都在保存污染（实测：标记里出现了一个运行中宿主根本没有的
    `command` 字段，`e2e-command` 会以为命令已注册而冲进去跑）。正解：**根本不许写** —— 宿主模块认
    `FFC_NO_STATUS_WRITE=1` 就跳过写盘，`test-host.mjs` 设这个变量。已经污染的文件**删掉**。
11. **JS 模板串里的 CSS / 注释不能写反引号**（`styles.ts` 整张样式表在一个模板串里，探针脚本的 `PROBE` 也是）：
    会提前结束模板串，报错是 `TS1005: ',' expected` / `Invalid character` 之类**指向别处**的语法错
    （甚至报到 `index.tsx` 的 `tag.textContent = CSS` 上）。写 CSS 注释时提到类名/属性请直接写 `foo-bar`。
    改完模板串里的注释，先 `node --check <file>` 再跑。
12. **工作区可能被并行编辑**：动手前先重读文件；发现内容与自己写的不一样时，先理解对方改了什么再决定，
    不要覆盖回去。
13. **主题反色 token 是最容易糊的地方**（§3.16）：`label-primary-inverted` 在深色下是深色。
14. **宿主改动一定要写进交接**（STATE §0 的「等重启」清单）。
15. **命令服务缺席要能降级**：命令在 `ctx.commands`，与工具是两个服务；用独立的 `inject(['commands'])` 挂命令，
    别塞进工具的依赖里（否则裁剪过的组合会让工具一起消失）。
16. **前缀筛选要连分隔符一起匹配**：`fatfish-canvas:board` 是 `fatfish-canvas:board-scope` 的前缀，
    用它筛「画布键」会把偏好键当成一块画布（e2e 因此报过 5 条假故障，而功能其实全对）。
    **键空间里凡是「一个键是另一个键的前缀」的地方，筛选一律带上分隔符。**
    （同类：`gen_` / `gencmd_` 两个节点 id 空间。）
17. **新增一个「会改变 app 读哪份数据」的偏好，等于给所有 e2e 加了一条前置条件**：处理方式是把清理写进公共常量
    （`RESET_BOARD_PREFS`）并在每个自己种状态的脚本里插一句。
18. **加菜单项会动到键盘用例的最后一项**：`e2e-p5` 的「按 End 高亮最后一项」在 P7 加了隔离开关之后必须改成新项。
    加菜单项时**先搜 `End`/`Home`/最后一项这类断言**，别等 CI 红。
19. **PowerShell 的 `>` 重定向会写 UTF-16LE**（含中文的探针结果会变成「二进制文件」，`read` 工具直接拒读）；
    `| Out-File -Encoding utf8` 又会带 BOM。正解：**让 Node 自己写盘**（`probe-gui.mjs --json <path>`）。
20. **探针产物要按「可见的那一份」挑**：本体的 composer 在 hero 与会话态之间复用同一棵 DOM，隐藏副本仍在
    文档里 → `querySelector` 先拿到 0×0 的那份，于是「点入口」点在 (0,0)。凡是量几何，一律 `rect.w > 0` 过滤。
21. **WMI 在受限沙箱里会被拒**：`Get-CimInstance Win32_Process` 报「拒绝访问」→ 找端口占用者要改用
    `netstat -ano` 解析（`post-restart.mjs`）。
22. **往密集的 flex 行里加控件必须 `flex: none`**：composer 工具行是 nowrap，默认 `flex-shrink: 1` 会把新控件
    压成 0 宽 —— 元素在 DOM 里、却完全点不到，看着像「注册没生效」（§3.20.2）。
23. **同一个服务名不要在两处 provide**：Typert 网关按名字从应用服务表解析接收者，嵌套 inject scope 里 provide
    的服务不一定可见（§3.23.2）。
24. **`test-host.mjs` 读的是 `lib/` 产物**：改了 `src/` 不 `node build.mjs` 就测试，你会得到「我明明改了文案，
    测试还报旧文案」的假故障。**改宿主先构建。**
25. **删一个菜单会连带打断多个 e2e 套件**：`e2e-p4` / `e2e-p5` / `e2e-scope` 都靠「点菜单项切模式 / 翻开关」，
    `e2e-theme` 还把菜单里的元素当对比度目标。删菜单不只是删 UI —— 先把 `grep` 跑一遍，把断言改成点**真实控件**。
    另外：`e2e` 里凡点右上角那枚入口的断言，都必须**先真的打开一个会话**（席位是会话作用域），
    否则拿到的是 `null` 而不是「失败」。
26. **「唯一出口」不能住在会被自己收起的子树里**：纯画布收起了整列聊天，右上角那枚米饭碗跟着不可见 ——
    所以纯画布的出口必须是顶栏上那格常驻按钮（或 Esc）。**出口自己不能是会被隐藏的东西。**
27. **`grep` 定位 `[class*="ffc-"]` 时别把子元素算成第二个控件**：`.ffc-entry` 里的
    `<span class="ffc-entry-text">` 也带 `ffc-` 前缀，「右上角只有一个本插件元素」这类断言要**只数顶层**。
28. **改 CSS 时新类名可能与别处撞车**：P17 第一版用的 `.ffc-model-menu` 与设置页的「模型行右键菜单」
    **同名** → 顺手把设置页的菜单改成了 300px/可滚动。改样式前**先 grep 一遍类名**，或者干脆给新功能一整块
    独立前缀（最终用 `.ffc-mp-*`）。
29. **用户说「质感差」时，先问「本体用的是哪一批数值」**（§3.30）：照抄产物一次到位，照截图调字号/字重/圆角是猜。
30. **在 `pointerdown` 里卸载元素 = 那个元素永远收不到 `click`**（P21 抓到的真 bug，从 P5 活到 P20）：
    视口的 `onPointerDown` 里先无条件 `setNodeMenu(null)`，而菜单就渲染在视口**里面** —— 鼠标一按下，
    React 当场把菜单卸载，随后 `click` 落到画布上。症状是**「鼠标点菜单项毫无反应，而键盘一切正常」**。
    为什么 15 个阶段没被发现：`e2e-p5` 全用 `press('Enter')` 选菜单项，鼠标点击从来没被测过；
    `verify-client.mjs` 的替身里 `useRef` 恒为 `{current:null}`，视口的 pointerdown 第一行就 `return`。
    修法：pointerdown 落在 `.ffc-menu` 里时**不**收起菜单。同类还有一条：滚轮落在菜单上时**不**该缩放画布。
31. **一个浮层的显隐不能挂在「被它自己盖住的那个元素」的悬停上**（P23，§3.35）：连线中点的 × 悬停才出现，
    而它 20×20 正好压在指针下 —— 显示它就把指针从线的命中路径上抢走，线失去 hover，按钮卸载，指针又回到线上
    ……来回抖，永远点不到。**删状态**（常驻 + 平时淡）比加定时器/偏移量都短。自查：任何 `hover` 驱动的层，
    都问一句「它出现之后，指针还在触发它的那个元素上吗」。
32. **`pointerdown` 里 `setPointerCapture` 会把随后的 `click` / `dblclick` 改派给捕获元素**（P23，§3.35）：
    文字节点的双击编辑因此从 P18 起就是死的，而同一个卡片里的 × / 播放键却好好的 —— 因为它们在
    `pointerdown` 里 `stopPropagation`，根本走不到捕获。**要拖拽就等到真的动了再捕获。**
33. **种子被 stringify 两次 = 空画布**：`SEED` 在各 e2e 里已经是 `JSON.stringify(...)` 的**字符串**，
    再 `JSON.stringify(SEED)` 就会写进「一个 JSON 字符串」→ store 反序列化出字符串 → 回退成**空画布**。
    `seedBoardExpression()` 现在会顺手拆一层做防御，但调用方请直接传 `SEED`。
34. **无头浏览器 e2e 的令牌只在 `dsh web` 启动那一行里**（P23 解开的死结，见 STATE §0）：令牌是进程内存里的，
    落不了盘 → 「预置 localStorage → 刷新」那种玩法永远拿不到页面。**会话里也不能重启宿主**
    （`taskkill /T` 会连自己的进程树一起杀掉），要重启得由用户在终端跑。
    **补一条 2026-09-24 才发现的**：浏览器 cookie 的**签名密钥是持久的**（`dsh-client-connection` 把它存在
    凭据库 `~/.dsh/.credentials.yaml` 的 `client-connection:browser-session` 记录里，`initializeSecret` 只在
    缺失时生成）—— 所以**宿主重启后用户那个已打开的页面照样能用**（旧 cookie 仍然有效），
    别把「页面没断」当成「宿主没重启」的证据；反过来，无头浏览器没有 cookie，**必须**要那一行令牌。
35. **`detached: true` + `windowsHide: true` 下，`cmd.exe /c <外部命令>` 的输出会凭空消失**（P26 实测，
    Node 24.12 / Windows）：`post-restart.mjs` 用 `spawn('cmd.exe', ['/c','dsh','web'], { detached:true,
    windowsHide:true, stdio:[ignore, logFd, logFd] })` 拉起宿主，结果 `lib/dsh-web.log` **0 字节** ——
    带令牌的地址解析不出来，所有浏览器 e2e 都跑不动（症状：`⚠️ 没能从 lib/dsh-web.log 里解析出带令牌的地址`）。
    实测矩阵（每条都是同一套 stdio 重定向）：

    | 命令 | detached + windowsHide | 抓到的输出 |
    |---|---|---|
    | `cmd /c dsh --version` | 是 | **空** |
    | `cmd /c node --version` | 是 | **空** |
    | `cmd /c echo hello` | 是 | `hello`（cmd **内建**命令反而没事） |
    | `cmd /c dsh --version` | 否 | `0.1.5-rc.3` |
    | `node <dsh 入口> --version` | 是 | `0.1.5-rc.3` ✅ |
    | `node -e "console.log(1)"` | 是 | `direct` ✅ |

    结论：**别让 cmd.exe 当中间人**。`post-restart.mjs` 现在用 `process.execPath` 直接跑
    `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\lib\bin.js`（`dshEntry()`，带两处候选 + 老写法兜底）。
    排查这类「子进程没输出」时，先按这张表**二分**：换掉 cmd、换掉 detached、换掉外部命令，一眼就定位。
36. **一个订阅者抛错会静默冻住「排在它后面」的所有 UI**（P26 抓到的真 bug，症状离根因十万八千里）：
    `state.ts` 的 `emit()` 原来是裸的 `for (const fn of listeners) fn();`。平台把 `layout.closeDetails`
    改名成 **`closeRightbar`**（老名字在 0.1.5-rc.3 里已经不存在），插件在 `index.tsx` 里注册的
    布局协同订阅者因此每次 `emit()` 都抛 `TypeError` —— 而它**注册得最早**，于是：
    - 排在它后面的订阅者一个都收不到通知 → 工具条上的**跟焦开关点了没反应**（`aria-pressed` /
      `data-active` / `title` 全停在初值），**而偏好其实已经写盘、刷新页面就正常**；
    - 异常还顺着 `setXxx` 冒到点击处理器里（没人看得见）；
    - `setMode` 的两条腿没事，因为 mode 的 DOM 事件是在 `emit()` **之前**派发的 —— 所以
      「模式切换一直好好的、只有偏好卡住」这个组合把人往「React 订阅腿又坏了」上带偏了好几轮。

    两条修法**都要**（只修一条都还会再踩）：
    1. **调用点对平台 API 改名免疫**：`(layout.closeRightbar ?? layout.closeDetails)?.()`；
       `ambient.d.ts` 里那几个成员**声明成可选** —— 声明成必选会让调用点「看起来一定存在」。
    2. **`emit()` 逐个订阅者 try/catch + `console.warn`**：谁抛错谁担着，别连坐；且**不要静默**。

    排查这类问题的顺序（这一轮实际走通的路径，省下几小时）：
    ① 先确认**值本身对不对**（localStorage / 刷新后是否正常）→ 排除状态源；
    ② 确认**面板有没有重渲染**（点「清空画布」看徽标与「全选」的 disabled：它们来自另一个 store，
       变了就说明 React 这条链是活的）→ 排除渲染；
    ③ 这时才怀疑订阅链，直接在 `emit()` 里给每个订阅者套 try/catch 并把 `String(error)`
       写进 `document.body.dataset.*`，再读一次就知道**是谁抛的**（比读 bundle / 猜 React 语义快得多）。
37. **e2e 的断言目标会随「平台版本」和「自家 UI 迭代」同时老化**（P26 一次实跑抓出 10 条假红，
    全是这种）：`p5` 七条（菜单项数 6→10、禁用项 4→8、`nodeMenuItems[5]` 当末项、空白处右键「不出菜单」、
    缩放 End 选中 200%→1000%）、`theme` 两条（`.ffc-toolbar .ffc-tbtn` 现在**第一个**匹配到 P18 插在
    最前面的「运行」按钮，而它常年禁用、自身 `opacity: 0.4` → 半透明文字算出的对比度必然 < 3）、
    `entry` 五条（`[class*="sessionLog"]` 在新版 dsh 里**整个控件都没了**）。三类写法上的教训：
    - **数量与索引不要写死**：菜单项从一张表（`NODE_MENU`）取，末项按 `id` 找（`remove`），
      缩放档位取**菜单里实际的末项**；
    - **要量的元素要写清「哪一份」**：可见的那一份（`rect.w > 0`，§8.20）、**可用的**那一份
      （`:not([disabled])` —— 禁用控件的对比度是刻意降级，WCAG 也把它排除在外）；
    - **别把「平台自己的控件」当成插件的不变量**：`entry` 那组断言锚在 session log 上，而那个控件
      是平台的、会随版本消失。**要锚就锚插件自己的东西**（顶栏那格、入口自身的位置/可命中/唯一性）。
      P26 的改法：锚到「`[class*="headerUtilities"]` 里本插件之外的**最后一个**控件」—— 不变量
      （同一行、各占一格、都不被压）与**具体是哪个平台控件**无关，平台再换也不会连累这条 e2e。
