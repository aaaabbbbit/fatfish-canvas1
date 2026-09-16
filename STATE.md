# 肥鱼画布 · 状态交接（压缩记忆）

> **这是跨上下文压缩的唯一记忆。新会话只读这一份，不要依赖对话历史。**
> 最后更新：P17 —— **画布交互与主界面三件事**（**只改客户端**，宿主一行没动）：
> ① 生成模型选择在 **composer 工具行里、本体「对话模型」位的紧左边那一格**
> （`conversation.input.right`）；外观与字体**照官方 `ModelSelect` 逐值抄**
> （读的是它的产物，不是截图估的，见 §3.30①）；
> ② 从屏幕外一次拖进**多张**图时按网格排开、互不重叠（`dropLayout`）；
> ③ 拖动节点时的**对齐虚线 + 自动吸附**（Alt 关掉吸附）。
> 客户端半边重建后**刷新页面**即生效，**本轮不需要重启 dsh web**。
>
> P13 —— **视觉模型当眼睛**：文本模型看不见参考图时，由用户配的**视觉模型**
> 把图读成一段文字，**注入生成提示词**并随工具结果回给模型自己。视觉模型与图像 / 视频
> 模型**挤在同一张设置页的同一个区域**（同一个 providers 字典 + `defaultVision`），
> 密钥因此只配一遍（详见 §3.26）。
>
> P12（参考图，已完成）：图**不经过模型**，模型只递一个地址、字节由宿主取（§3.24）；
> 顺带做了「看得见就自己看、看不见就自动套用用户附的图」（§3.24 里的自适应表）。
> P11（设置页写入面）也已完成。
>
> **宿主半边的 P11–P13 改动仍然「等重启」**（见下面的清单）；P17 只改客户端半边。

---

## 0. 30 秒恢复

**这是什么**：DeepSeek Harness 的「肥鱼画布」无限画布插件 —— 画布在左、**本体原生
聊天**在右（不复制聊天 UI），生成结果（图像/视频）**同时**落到聊天与画布节点。

**在哪**：`D:\agent文件目录\肥鱼画布\packages\fatfish-canvas\`（本工作区）。
已 `dsh plugin --profile web add link:…` 装进 web profile，`node_modules\fatfish-canvas`
是指向本工作区的 junction。

**怎么跑**（四档，从便宜到贵）：

```sh
cd packages/fatfish-canvas
npm run check          # 构建 + typecheck + 266 画布逻辑 + 213 宿主 + 客户端冒烟（无需额外权限）
npm run typecheck      # 只跑 tsc
# 以下都要 danger-full-access（无头 Chrome 要命名管道）
npm run e2e            # 26 项画布交互
npm run e2e:p4 / e2e:p5 / e2e:theme / e2e:scope / e2e:entry / e2e:settings   # 见 §5
npm run e2e:command / e2e:ingest
npm run restart:verify # 重启 dsh web + 自动跑 e2e:settings / e2e:command（见 §6）
```

**当前状态**：P0–P13 全部完成，并且**每一项都在真实 GUI 验证过**（P12/P13 的宿主半边除外，
见下面的「等重启」）；**P17（本轮）只有离线证据**（浏览器 e2e 需要带令牌的
`DSH_WEB_URL` + danger-full-access，本轮没有跑）—— 见下面「P17 待真机验证」。
离线：266 画布 + 213 宿主 + 客户端全套；浏览器 canvas 26 / p4 56 /
p5 45（**P12 起 48**：新增「以此为参考图生成」的可用性与禁用原因断言，需刷新后的新 bundle） /
theme 15 / scope 26 / entry 38 / **settings 19** / **command 13**。
宿主已于 2026-09-12 重启（`post-restart.mjs` 跑了两次；`lib/host-status.json` 里
`command` + `models` 字段都在 = 宿主确实是新模块）。

**P17 待真机验证（三条，刷新页面后各点一次即可）**：
1. **输入框那一行**：本体模型名（如「DeepSeek V4.1 Flash High」）**左边**多了一格
   「✦ 图像 acme-large ⌄」；点开是一张**朝上弹**的菜单（20px 圆角、sticky 供应商标题、
   行高 38px）→ 两个页签（图像 / 视频）→ 选中项带勾 → 选一个会写进设置
   （设置页的「默认图像模型」下拉应同步变化）；
2. 从资源管理器一次拖 5 张图进画布 → 一行 4 个 + 第二行 1 个，互不重叠；
3. 拖动一个节点靠近另一个 → 出现虚线并「啪」地贴上去；按住 **Alt** 拖 = 不吸附。

**⚠️ 等重启**：宿主半边有**两批**改动没生效（`lib/` 已重建，但运行中的 dsh web 还是旧模块）：

- P11 那批：供应商报错文案 + 视频端点换路径（`src/host/probe.ts` / `src/host/providers.ts`）。
  本轮实测到两条中转站事实：① 基址漏 `/v1` 时，贞贞工坊（`https://ai.t8star.org`）对陌生
  路径**不返回 404，而是回自家那页 HTML 首页（HTTP 451）** —— 所以「回的是不是网页」就是
  「这个地址上有没有这个端点」的判据；② 它的视频端点只有**单数** `/v1/video/generations`
  （复数那条约 451），图像 `/v1/images/generations` 与 `/v1/images/edits` 则与 OpenAI 一致。
- P12 那批：**参考图**（新模块 `host/reference.ts` + `host/session-images.ts`、
  `host/providers.ts` 的新请求形状、`host/command.ts` 收附件、`host/schema.ts` 两个新字段、
  `host/generate.ts` 解析参考图、**`host/tool.ts` 的自适应套用**）。
  重启后 `/generate` 才会接受附件、`media_generate` 才会认 `reference`（含 `"attached"`）
  与「本回合附的图自动当参考图」。
- P13 那批：**视觉模型**（`host/providers.ts` 的 `describeImage`、`host/generate.ts` 的
  描述流程与提示词注入、`host/schema.ts` 的 `kind:'vision'` + `defaultVision`、
  `host/probe.ts` 的 `guessKind` 认视觉模型名；客户端那半是设置页的第三档与第三个默认下拉）。
  重启后设置里才会认「视觉」这一档，`media_generate` 才会在看不见图时请它读图。

**P17（本轮）不需要重启**：新增/改动的文件全在客户端半边
（`canvas/model.ts` · `canvas/dropfiles.ts` · `canvas/CanvasStage.tsx` · `CanvasPanel.tsx` ·
`index.tsx` 的 `conversation.input.right` 注册 · `settings/models.ts` ·
`settings/ModelPicker.tsx` · `icons.tsx` · `styles.ts` · `ambient.d.ts`（两个图标 + createPortal）·
`settings/MediaSettings.tsx` 里只把写入函数换成共用的那份）——重建 `lib/client.js` 后刷新页面即生效。

下次改宿主仍然必须重启（3.4），用 `npm run restart:verify` 一条命令完成「重启 + 验证」，见 §6.1。

**P11（客户端写入面）**：设置页原来读 `ctx.connection.api` —— 那个面早就没有了
（`ctx.connection` 只有 rpc / generation / state），于是**每一次写入**都炸在
`Cannot read properties of undefined (reading 'settings')`：改基址失焦即回退（写入失败 →
草稿被丢掉 → 回显旧值），删除供应商也只报这一句。现在走网关派生的 `remote.settings` /
`remote.credentials`：签名是**位置参数**（`mutate(ns, ops, revision)`、`set(ref, value)`），
信封是**一层** `{ ok, value }` / `{ ok, error }`，冲突码 `settings/conflict`
（旧代码写的 `settings-conflict` 永远匹配不上）。写入面缺席时页面只读并说明原因。

⚠️ 这条整整一轮没被发现，因为 `verify-client.mjs` 当时只断言「渲染出来了、按钮没置灰」，
而且替身按**旧两层信封** `{ result }` + 对象参数建模 —— 替身与真机一起漂移。现在 10.4 会
真改一次字段、真点一次测试连接，并断言替身看到的调用形状（已实测：故意写回旧形状会 FAIL 两项）。

**e2e 现在为什么跑不动**：`dsh web` 要**签名 cookie**（authority 绑定），无头 Chrome 直接开
`http://127.0.0.1:3080` 只会拿到 401 `dsh web authentication required` → 页面全空 →
`e2e-settings.mjs` 报 `no-settings-trigger`。跑 e2e 必须把 `DSH_WEB_URL` 设成**dsh web 打印
出来那条带令牌的 URL**，否则那不是插件的问题。

**P12（参考图）**：DeepSeek V4.1 是文本模型，**它看不见图** —— 但生成 API 要的参考图
根本不需要经过它。做法是「模型只递地址、宿主取字节」：`media_generate` 多一个
`reference` 参数（地址 / 路径 / 上一张结果的 URL），`/generate` 多一个 `--ref`，
**并且命令开始收附件**（`input.attachments: true` → 用户在输入框里贴的图直接到宿主，
模型全程不知道有这张图）；画布节点右键多一项「以此为参考图生成」。两个供应商级旋钮
（`referenceMode` / `referenceField`）为什么必须可配，见 §3.24。

**P13（视觉模型当眼睛）**：文本模型看不见图，于是一段**文字版的参考图**由用户配置的
视觉模型产出：它先读图（`/chat/completions`，`image_url` 内联参考图），把描述**拼进生成
提示词前面**（`参考图内容：…`），并随工具结果回给模型自己（模型因此能接着讨论、改提示词、
回答「图里有什么」）。两种「眼睛」各管一段：看得见图的模型自己看（不描述），看不见（或
能力未知）的才由视觉模型代劳 —— 见 §3.26。**没配视觉模型 = 这个功能整体关闭**，一次多余
请求都不发。

**P17（主界面三件事，本轮）**：① 生成模型选择在 composer 工具行里、本体「对话模型」位的
**紧左边**那一格（`conversation.input.right`，外观与字体照官方 `ModelSelect` 逐值抄）；
② 从屏幕外一次拖进多张图时先算网格再落位（`dropLayout`），不再叠在指针那一点；
③ 拖动节点时出现**对齐虚线与自动吸附**（Alt 临时关掉）。全部是客户端改动，详见 §3.30。

**下一步（按价值）**：① P17 的浏览器 e2e（见 §7.9，本轮只有离线证据）② i18n
③ 生成入口按钮（现在生成只靠聊天里的模型调用与 `/generate` 命令，加一个输入框旁的
按钮仍是最省事的增值项 —— 模型选择已经在输入框那一行了，按钮是它的下一步）
④ 一次生成多张（`n>1`）⑤ 会话画布的回收 ⑥ 右键菜单扩展（详见 §7）⑦ 参考图的设置页
控件（见 §3.24 的 `ponytail:` 注）⑧ 一个独立的 `describe_image` 工具（现在描述只在生成
流程里顺带产出，让模型能单独「看图」是同一套机械的下一个出口）。

**三条硬约束**（违反会浪费大量时间）：
- **无头 Chrome 需要命名管道**：所有 `e2e` / `probe` 必须在 `danger-full-access`
  下运行，否则以 `mojo/platform_channel.cc: Check failed: 拒绝访问 (0x05)` 失败。
- **含中文的源文件只用 `edit` / `write` 工具改**：PowerShell 5.1 会把 UTF-8 无 BOM
  文件按 ANSI 解码 / `>` 重定向写成 UTF-16 → 全文变乱码。PowerShell 只用来跑命令。
- **宿主改动必须写进本文件的「等重启」清单**，否则下个会话会以为它已生效。

---

## 1. 阶段与验收

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 骨架、双半边插件（宿主组合包 + 客户端插件）、**客户端半边**免重启热激活 | ✅ |
| P1 | 无限画布：平移/缩放/框选/多选/拖拽/删除/持久化 + jaaz 落位算法 | ✅ |
| P2 | `media-generation` settings namespace、图像/视频适配器、`media_generate` 工具、设置页 | ✅ |
| P3 | 生成结果 → 画布节点（工具结果 `presentationMeta` → 落图）+ 聊天侧 keyed 工具行 | ✅ |
| P4 | 画布工具条、视图菜单（聊天/并排/纯画布）、新节点自动跟焦 | ✅ |
| P5 | 节点右键菜单、菜单键盘导航与无障碍、浅深主题对比度复查 | ✅ |
| P6 | `/generate` 直达命令（不经过模型）+ 命令结果同样落图 + 重新生成升级 | ✅ |
| P7 | 画布按会话隔离：共用一块 ⟷ 每个会话一块（记账独立、切换不丢东西） | ✅ |
| P8 | 入口搬进 composer 工具行（修掉压住 session log）、米饭碗只管进画布、视图菜单搬到画布顶栏 | ✅（P10 已改回去，见下） |
| P9 | 多供应商 / 一供应商多模型（图像·视频标识）/ 密钥进凭据库 / 测试连接 / 获取模型列表 / 模型级密钥 | ✅ |
| P10 | 入口回到**右上角**（改住 `conversation.session.header.utilities`，与 session log 同一席位 → 结构上不重叠、两种模式下位置不变）+ 画布里单击即回聊天 + 纯画布独立成顶栏一格；**移除视图模式与画布宽度选择**（删除 `ViewMenu.tsx`） | ✅ |
| P11 | 设置页写入面修好（`remote.settings` / `remote.credentials`，一层信封、位置参数、冲突码 `settings/conflict`） | ✅ |
| P12 | **参考图**（图生图 / 视频首帧）：模型只递地址、宿主取字节。`media_generate.reference` + `/generate --ref` + 命令收附件（贴图即参考图）+ 画布右键「以此为参考图生成」+ 供应商级 `referenceMode` / `referenceField` + **自适应**（看得见就自己看，看不见就自动套用用户附的图） | ✅（宿主半边**等重启**） |
| P13 | **视觉模型当眼睛**：`kind: 'vision'` 的模型与图像 / 视频模型同处一个供应商字典，`defaultVision` 与另两个默认模型并排在下拉里；当前模型看不见参考图时，先由它把图读成文字（`/chat/completions`），**注入生成提示词**并回给模型自己 | ✅（宿主半边**等重启**） |
| P17 | **主界面三件事**：① 生成模型选择在 composer 工具行、**本体对话模型位的紧左边那一格**（`conversation.input.right`；外观 / 字体 / 图标照官方 `ModelSelect` **逐值抄**），直接切默认模型（写的就是设置页那两个字段）；② 一次拖进多张图按网格排开（`dropLayout`，互不重叠）；③ 拖动节点的**对齐虚线 + 自动吸附**（Alt 关闭） | ✅（客户端；**待真机验证**，见 §0） |

**验收证据（都是真实 GUI 跑出来的）**：
- P3/P4：`e2e-ingest.mjs` 观察到 `(无) → pending → ready`、媒体 `naturalWidth>0`、
  拖走的视口被跟焦带回（`nodeScreen=(187,279)`，视口宽 665）、重载不重复落图。
- P4：`e2e-p4.mjs` 56 项；P5：`e2e-p5.mjs` 45 项；主题：`e2e-theme.mjs` 15 项
  （抓出并修掉两处真 bug，见 3.16）。
- P6：`npm run check` 含命令契约与「命令/工具同一条管线、同一句错误」；
  `e2e-command.mjs` 待宿主重启后跑。
- P7：`e2e-scope.mjs` 26 项 —— 在真实 GUI 里点菜单开关，观察到
  `data-ffc-scope` 由 `shared` 变 `session`、出现且仅出现一个
  `fatfish-canvas:board:session-<uuid>` 键、**键后缀与页面记的当前会话一致**
  （证明会话 id 没被削前缀）、原画布被采用（adopt）且共用那块原样保留、
  刷新后偏好与内容都还在、关开关后回到共用且会话那块仍留在存储里；
  外加**最窄宽度（40%）下的工具条布局体检**（常驻徽标没把控件挤出去 / 压扁，
  读数可命中）。
- P8：`e2e-entry.mjs` 35 项 —— 打开**真实会话**后量出 session log 按钮
  （`.nL4_yW_sessionLogButton`，111×32 @ (1525,12)）**没有被任何本插件元素覆盖**
  （`logHit=true`、右上角 200×84 区域里本插件元素数为 0）、入口在 composer 工具行里
  且可命中、单击进画布、进画布后入口消失、顶栏「视图」菜单项齐全且能切三种模式、
  窄画布下顶栏不溢出。（该套件已按 P10 重写，见下条。）
- **P10：`e2e-entry.mjs` 39 项**（本轮重写）—— 打开真实会话后量出：入口
  `32×32 @ (1604,12)`（**只有米饭碗图形**，`textContent === ''`）就在**右上角**、
  在 session log（`111×32 @ (1443,12)`）**右边**（order 10 > 0）、两者**不相交**
  且 session log 自己仍可命中（`logHit=true`）、入口就在
  `[class*="headerUtilities"]` 容器里（同席位）、不在 `shell.overlay` 里、
  右上角只有它**一个**顶层本插件元素；单击进画布后入口**仍在原位**
  （chat `x=1604,y=12` → canvas `x=1604,y=12`，位移 0）、aria-label 与 title 变成
  「返回聊天界面」，图形一个字都没变；顶栏**没有**「视图」按钮与宽菜单、
  多了一个「纯画布」按钮；40% 窄画布下顶栏不溢出；点「纯画布」进纯画布
  （聊天列收起、面板铺满 1664）时那一格**仍可命中**（唯一出口）且按下态为 true，
  再点一次回到并排。
  另有 `e2e-p4 56`（重写菜单段：模式切换改走「纯画布」按钮与快捷键，作用域读数
  当开关点）、`e2e-p5 45`（作用域开关改点读数）、`e2e-scope 26`（开关换成点读数）、
  `e2e-theme 15`（`ffc-menu-chip` / `ffc-menu-note` 两个目标随菜单一起移除）。
- P9：`e2e-settings.mjs` **19 项** —— 在真实 GUI 里：加自定义供应商 →
  填基址与显示名（**真实输入 + 真实失焦**）→ 密钥进凭据库（状态显示「已配置」）→
  「测试连接」打到本机假服务（**连接正常 7 ms**）→ 「获取模型列表」拉回 3 个模型
  并自动标好种类 → 右键模型行配**模型级密钥**（状态变「单独密钥 · 已配置」）→
  设为默认图像模型 → 清理测试痕迹。
  离线另有 136 项宿主（含解析 / 选择 / 迁移 / 探测全分支）与 134 项客户端
  （含设置页渲染结构、描述符两侧一致、渲染期零副作用）。
- P6：`e2e-command.mjs` **13 项** —— 宿主重启后跑通：命令真的被适配器接受、
  节点 `gencmd_*` 落图、提示词与画幅都来自命令行原文（**世界尺寸 320×180**，
  屏幕尺寸被 zoom 缩放，断言要用世界尺寸）、`(无) → pending → failed` 迁移可见、
  记账持久化、重载幂等；失败文案就是 P9 那条共用管线的提示（证明宿主是新模块）。

---

## 2. 目录与安装

```
packages\fatfish-canvas\
├── package.json         双半边声明（dsh.bundle.patch + dsh.client）
├── cordis.patch.yml     **刻意留空**（激活行在 profile 层，见下）
├── build.mjs            TypeScript 编译器 API 自写打包器（零原生依赖）
├── src\index.ts         宿主半边入口：settings namespace + 迁移 + 工具 + 命令 + mediaProbe
├── src\host\            schema（providers 字典 / 解析 / 选择 / 迁移）· providers（适配器，
│                        含 **describeImage**：视觉模型读图）· generate（共用管线 + 参考图描述注入）·
│                        tool · command · probe（测试连接/模型列表，**guessKind 会认视觉模型名**）·
│                        **reference（P12：参考图句柄 → 供应商载荷 / multipart 字节）**·
│                        **session-images（本回合用户附的图 → 持久附件引用）**
├── src\client\
│   ├── index.tsx        插件体：apply / inject / name（含 $mount 远程贡献）
│   ├── ambient.d.ts     统一基座 + 宿主/客户端服务面的本地类型声明（typecheck 靠它）
│   ├── state.ts         视图模式 + 宽度 + 跟焦偏好 + **画布作用域偏好**（外部 store）+ AppFrame 打点
│   ├── menu.ts          菜单基础设施：useMenuNav / useMenuDismiss / useMenuFocus / clampToViewport
│   ├── shortcut.ts      Ctrl/⌘+Shift+B 切视图（**VIEW_SHORTCUT_LABEL 在这里**）；Esc 退出纯画布
│   ├── styles.ts / icons.tsx / CanvasPanel.tsx / dom.ts
│   ├── EntryButton.tsx  **入口按钮**（P10：会话头部右上角，与 session log 同席位）：
│   │                    单击 = 聊天 ⟷ 画布；**只有米饭碗图形**（无文字），
│   │                    位置一律不变，语义在 aria-label / title 里
│   ├── settings/MediaSettings.tsx       设置页（P9 重做：供应商/模型/密钥/探测；
│   │                                    P13：模型种类三档 + 默认视觉模型下拉）
│   ├── settings/models.ts              **P17**：主界面读的模型目录（纯函数解析）+ 默认
│   │                                    模型写入（与设置页**共用同一个** mutateSettings）
│   ├── settings/ModelPicker.tsx        **P17**：composer 工具行那格「生成模型」（官方同款
│   │                                    触发器 + 朝上弹的菜单 / 两页签 / 勾）
│   ├── toolview/MediaToolRow.tsx        聊天侧 keyed 工具行
│   ├── shared/catalog.ts                供应商**预设**目录 + 凭据引用名推导 + `modelRef`
│   ├── shared/media.ts                  **共享契约**：工具名/命令名/meta 键/尺寸/幂等 id/命令行语法
│   │                                    （`--ref` 与 `isReferenceHandle` 也在这里：两半边共用同一判据）
│   ├── shared/probe.ts                  **探测的远程契约**（宿主清单与客户端贡献同源）
│   └── canvas/          model（视口数学+落位）· store（节点+记账+持久化+**作用域换键**）·
│                        ingest（会话快照→画布，工具与命令两条入口）· bridge（ctx.sessions 订阅）·
│                        scope（**偏好 × 当前会话 → 读哪块画布**）· follow（跟焦）·
│                        actions（视图动作）· regenerate（重新生成 / **以此为参考图生成**：
│                        `--ref` 只有命令那条路，退回提示词对参考图无意义）·
│                        CanvasStage / NodeCard / NodeMenu / ZoomControls
└── scripts\             lib/cdp.mjs（CDP 基建 + RESET_BOARD_PREFS）· test-model / test-host /
                         verify-client · e2e-canvas / e2e-p4 / e2e-p5 / e2e-theme / e2e-scope /
                         e2e-entry / e2e-settings / e2e-command / e2e-ingest ·
                         fake-media-server（含 /models）· probe-gui + probe-*.js ·
                         post-restart.mjs（重启宿主 + 自动验证，见 §6）
```

**激活行**：`C:\Users\pc\.dsh\profiles\web\cordis.patch.yml`

```yaml
- insert:
    - id: fatfish-canvas
      name: fatfish-canvas
```

⚠️ **bundle 层与 profile 层不能同时插入同一 id**：`applyEntryPatches` 的插入是
`data.push(...insert)`、**不去重**；重复插入会让插件加载两次，注册 settings
namespace 时以「重复 namespace」报错。

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
   的结果」是平台限制，不是偷懒（P7 的按会话隔离正是顺着这条限制做的：既然只看得到
   当前会话，那就让每个会话各有一块画布）。
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

### 3.19 画布作用域（P7）：一块画布还是每个会话一块
```ts
type BoardScope = string | null;                 // null = 共用那块；字符串 = 该会话
boardKeyFor(scope)  → 'fatfish-canvas:board' | 'fatfish-canvas:board:<sessionId>'
setBoardScope(next, { adopt })                   // 换键（先 flush 旧键，再读新键）
```
三份知识必须合在一处才对，但天然分居三地 → 接合点单独成模块 `canvas/scope.ts`：
**偏好**（`state.ts` 的 `fatfish-canvas:board-scope` = `shared` | `session`）×
**当前会话**（`canvas/bridge.ts` 是唯一知道「当前会话是谁」的地方，`setScopeSession(id)`）
→ **换键**（`store.setBoardScope`）。六条实测/设计事实：

1. **默认共用**：偏好读不到就是 `shared`。老用户升级后画布不能突然变空。
2. **只有「共用 → 隔离」这一步带画布过去**（`adopt`，且只在新键**从没写过**时）。
   无条件 adopt 会让会话 A → 会话 B 把 A 的画布抄进 B —— 隔离当场失效。
   已经清空过的会话画布是「写过但空」，因此不会被抄（用 `getItem !== null` 判，不是判空）。
3. **拿不到会话 id 就退回共用**：无会话 / `sessions` 服务缺席 / 列表还没就绪时，
   作用域是 `null`，画布照常可用。视图读数（工具条 `[data-ffc-scope]`）显示实际生效的
   那块，菜单里偏好那项则显示「待会话」—— 偏好与生效是两件事，不能混成一个读数。
4. **桥里顺序是「先切作用域、再落图」**（`bind()` 里 `setScopeSession` 在 `pump` 之前）：
   否则切会话的第一帧结果会落进上一个会话的画布。
5. 记账账本 `ingested` 随作用域独立 → 切回旧会话时历史快照不会重放节点
   （§3.10 的「打开老会话不铺满画布」在多画布下依然成立）。
6. ⚠️ **`fatfish-canvas:board-scope` 也以 `fatfish-canvas:board` 开头**：按
   `startsWith('fatfish-canvas:board')` 筛「画布键」会把偏好键当成一块画布
   （本轮就这么写错过一次断言）。筛会话画布必须用 `fatfish-canvas:board:`（带冒号）。

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
- **画布作用域**（P7 的功能，用户没让删）：开关落在**工具条那枚读数**上
  （「共用画布 / 本会话画布」自己就是 `<button>` + `aria-pressed`）。读数与开关本来
  就是同一件事的两面，这样既不新增宽度也不丢功能。
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
   不是裸结果。忘了拆信封 → `result.ok` 永远是 undefined → 界面把成功当失败。
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
| 画布作用域**默认共用**，隔离是显式开关 | 升级不能改变已有行为；「我的画布怎么空了」是最贵的一类反馈 |
| 换作用域**先落旧键再读新键**，只在「共用 → 隔离」时采用当前画布 | 见 3.19.2：既不许丢东西，也不许把 A 的画布抄给 B |
| 作用域策略单独成 `canvas/scope.ts` | 偏好、当前会话、换键分居三地，任何一方自己改另两方都会让「谁决定画布键」变成口头约定 |
| 工具条常驻一块**作用域读数**，P10 起它**自己就是开关** | 隔离打开后画布会随会话切换而变，不写明白就是灵异事件；读数与开关是同一件事的两面，因此既省宽度也不丢功能（3.22） |
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

---

## 5. 测试与验证

```sh
cd packages/fatfish-canvas
npm run check        # 构建 + typecheck + 266 画布逻辑 + 213 宿主 + 客户端冒烟（无需额外权限）
npm run e2e          # 26 项画布交互（真实浏览器，danger-full-access）
npm run e2e:p4       # 56 项：工具条 / 纯画布 / 快捷键 / Esc / 刷新自救（视图菜单段已按 P10 重写）
npm run e2e:p5       # 45 项：右键菜单 / 菜单键盘导航 / 剪贴板 / 作用域读数开关
npm run e2e:theme    # 15 项：浅深两套主题 × 19 处元素的对比度
npm run e2e:scope    # 26 项：画布按会话隔离（开关 → 换键 → 采用 → 刷新 → 关回去 + 布局体检）
npm run e2e:entry    # 39 项：P10 入口在右上角（只有米饭碗图形）不压 session log / 位置不变 / 双向单击 / 纯画布独立成顶栏
npm run e2e:settings # P9：加第三方供应商 → 测试连接 → 拉模型 → 模型级密钥（自起假服务、自清理）
npm run e2e:command  # /generate 端到端（宿主重启前会自己跳过）
npm run restart:verify   # 重启 dsh web + 自动跑上面两条（见 §6）
node scripts/e2e-ingest.mjs --expect-status failed                  # 无密钥：pending → failed
node scripts/e2e-ingest.mjs --expect-status ready --require-pending # 配假供应商：pending → ready

# 成功路径不需要真实密钥：
node scripts/fake-media-server.mjs --port 8791 --delay 2500 --key sk-local-fake
# ↑ 现在也实现 GET /v1/models（P9 的「测试连接 / 获取模型列表」打它）
# 假服务 + 设置页：直接在 GUI 里加一家 baseURL=http://127.0.0.1:8791/v1 的供应商即可
node scripts/probe-gui.mjs --expr-file scripts/probe-composer.js --json lib/probe.json   # 任意 DOM 查询
```

**验证分层**（每层抓不同类别的故障）：

| 手段 | 抓什么 |
|---|---|
| `test-model.mjs` | 纯逻辑：视口数学、锚点不漂移、落位算法、store 动作/持久化/坏数据防御、落图计划（幂等/新鲜度/不跳位/不复活）、**命令落图**、跟焦几何与策略、视图动作、视图模式、菜单纯逻辑（`seekEnabled`/`clampToViewport`）、命令行语法、**画布作用域（键映射/切换还原/adopt 规则/策略层）**、**参考图句柄判据（`isReferenceHandle`）与 `usedReference` 的严格解析**、**P17：`dropLayout`（锚点/行内推进/换行高度/一批互不重叠）、`snapMove`（边与中线/超容差不吸/两轴各一次/零偏移也回线）、`mediaCatalog`（分组/默认值/坏数据剔除）** |
| `test-host.mjs` | schema 形状与脱敏、工具契约、适配器 URL/头/体、错误文案、**命令契约 + 命令行语法 + 结果文本约定 + 与工具同源错误**（stub fetch）、**参考图：地址→载荷、`referenceField` 覆盖、`data:` 透传、本地文件→data URL（含读不到时**零请求**）、`edits` 的 multipart、命令收附件 / 非图片附件 / `--ref` 优先 / 附件面缺席报错、视频首帧字段**、**视觉模型：解析与选择、`chat/completions` 请求形状、描述注入提示词、`referenceDescription` 回带、分块 content、没配模型 / 看得见图 / 视觉失败 / 没有参考图四种「不该发请求」的情形** |
| `verify-client.mjs` | 惰性契约、factory 物化、apply 不抛错、**深度渲染**（工具行三态 + 参考图徽标 + **参考图描述那行** / 画布工具条 / 纯画布 / 快捷键与 Esc / 刷新自救 / **P17 的 composer 生成模型格**：席位名 `conversation.input.right`、席位 id、两段式触发器（种类 + 模型名）、aria 与 title、读不到设置时显示「自动」、点一下记下展开态）、**作用域 × 桥 × 工具条读数（含 `sessions` 缺席降级）**、**设置页三个模型下拉（图像 / 视频 / 视觉）与视觉模型那一档的说明** |
| `e2e-canvas.mjs` | 只有真实浏览器能暴露的：事件派发、指针捕获、锚点几何 |
| `e2e-p4.mjs` | 按钮真的可点、纯画布下 overlay 仍可命中、布局真的重排与恢复、**作用域读数真的点得动**、模式切换走真实控件（纯画布按钮 + 快捷键） |
| `e2e-p5.mjs` | `contextmenu` 与光标坐标、菜单命中测试、**按键真的到达菜单**（焦点）、`aria-activedescendant`、剪贴板写入、**作用域读数开关真的翻得动**、**「以此为参考图生成」的可用性与禁用原因（P12 起 6 个动作）** |
| `e2e-theme.mjs` | 设计 token 在两套主题下的真实取值与对比度（CSS 变量解析、alpha 合成、渐变盲区） |
| `e2e-scope.mjs` | 读数开关真的换键：`data-ffc-scope`、**键名带完整 `session-<uuid>`**、adopt 采用、刷新后仍在会话画布、再点回到共用 |
| `e2e-entry.mjs` | **P10**：打开真实会话后量入口与 session log 的矩形（**不相交**、入口在它右边、log 自己仍可命中、入口在同一 utilities 容器里）、**进画布后位置位移 ≤ 6px**、aria-label 双向切换而**图形没有文字**、顶栏没有视图菜单而有「纯画布」且纯画布下它是唯一出口、窄画布下顶栏不溢出 |
| `e2e-settings.mjs` | **P9**：加自定义供应商 → 保存 baseURL → 密钥进凭据库（状态显示「已配置」）→ 测试连接打到本机假服务 → 拉模型列表并按种类标识加进来 → 右键模型行配**模型级密钥** → 设为默认 → 清理测试痕迹（自起假服务） |
| `e2e-command.mjs` | 斜杠命令真的被适配器接受并派发、`command/run↔done` 真的折叠成客户端节点、命令结果真的落图 |
| `e2e-ingest.mjs` | `ctx.sessions` 能否注入、订阅是否被真实事件流驱动、pending→终态迁移、跟焦是否真的把节点带回视野、媒体是否**真的加载**（`naturalWidth>0`） |
| `probe-gui.mjs` | 任意 DOM 事实查询（元素位置、命中测试、渲染尺寸、导航内容、输入框形状、token 取值）；`--json <path>` 让 Node 自己写盘（**别用 PowerShell 重定向**，见 §8.21） |

**横切注意**：
- 无浏览器替身**测不出**指针捕获偷点击、`contextmenu` 坐标、按键是否到达、媒体是否加载
  —— 这些只能靠真实浏览器。
- **每个 e2e 必须自己种状态**：探针 profile 是复用的，上一次运行留在 localStorage 的
  画布会污染下一次（`e2e-canvas` 曾因此「平移失效」——空白处的点落在残留节点上）。
- **种画布的脚本还必须清掉画布作用域偏好**（P7 起）：残留的
  `fatfish-canvas:board-scope=session` 会让 app 去读**会话那块**画布，
  于是「种下的节点一个都没渲染」，看着像组件坏了。公共前置常量在
  `scripts/lib/cdp.mjs` 的 `RESET_BOARD_PREFS`（`goto()` 已内建，手写种状态的脚本要自己插）。
- **种画布的脚本必须用 `seedBoardExpression()` 种**（`scripts/lib/cdp.mjs`）：
  它会把**当前账本原样带进新种子**。原因是落图有一条有意为之的规则 ——
  **结果够新就补落**（`INGEST_FRESH_MS` = 10 分钟）。于是「同一个会话里刚跑过
  `/generate`」之后，任何把 `ingested` 写成 `[]` 的脚本都会让那个命令节点
  **又落回画布**：`e2e-canvas` 报「重载后复原，实际 5 个」、`e2e-theme` 的空态占位
  根本没渲染、`e2e-p4` 数到 7 个而不是 3 个。**这不是 bug，是设计**；
  e2e 必须保住账本（`e2e-scope` 那种「删掉所有画布键」的隔离也要先读出账本再删）。
- **用真实事件驱动 UI，不要合成事件**：React 把 `onBlur` 委托在原生 **focusout** 上，
  `dispatchEvent(new Event('blur', {bubbles:true}))` 不会触发它（原生 blur 不冒泡）。
  症状特别阴：界面回显是对的（那是**组件草稿**），宿主读到的却是空值 ——
  设置页的「测试连接」因此报「这个供应商还没有填接口基址」。
  正解：`el.focus()` + `Input.insertText`（真 input 事件）+ 点别处造成**真实失焦**。
- `e2e-ingest` / `e2e-command` 每次运行会**在宿主里新建一个会话**（真实链路的代价，
  可在侧边栏删掉）；`e2e-scope` 会在探针 profile 里留下一个会话画布键（无害）。

---

## 6. 开发回路

```sh
# 改客户端代码
node build.mjs && 刷新浏览器          # 客户端 bundle 以新哈希重新服务，立即生效
# 改宿主代码
node build.mjs && 重启 dsh web        # 宿主半边不会重新导入（3.4）
```

**当前 profile**：`dsh web` 在 http://127.0.0.1:3080 运行，插件已激活。

### 6.1 重启宿主为什么需要一个脚本（P9 加的 `post-restart.mjs`）

**`dsh web` 就是承载当前对话的那个进程**。谁在会话里直接 `kill` 它，自己这一轮就
当场结束：用户看到页面断开、没有任何解释，验证也做不成（本轮就卡在这件事上，
所以才有了这个脚本）。

```sh
npm run restart:verify      # = node scripts/post-restart.mjs --delay 5000 --verify
```

它做五件事，全程**增量**写 `lib/post-restart-report.txt`：
1. 延迟 `--delay` 毫秒（留给当前这一轮把话说完）
2. `netstat -ano` 找监听 3080 的 PID → `taskkill /PID <pid> /T /F`
   （**不用 WMI**：受限环境下 `Get-CimInstance` 会「拒绝访问」）
3. `spawn('cmd.exe', ['/c','dsh','web'], { detached: true, stdio: 'ignore' })` + `unref()`
   —— detached 才能在自己父进程（也就是被 kill 的宿主）死后继续活着
4. 等端口恢复 → 等 12 秒让插件加载 → 读 `lib/host-status.json`，断言里面有
   `command` 与 `models` 字段（= 宿主确实是新模块，不是旧模块）
5. `--verify`：跑 `e2e-settings.mjs` 与 `e2e-command.mjs`，把结论行写进报告

**下一步会话怎么用**：读 `lib/post-restart-report.txt` 就知道重启成没成、两条 e2e
过没过。报告里 `✅ 宿主是新模块（command + models 字段都在）` 是宿主半生效的铁证。

**等重启的宿主改动（本期一次重启全部生效）**：
1. `/generate` 命令（P6）
2. `presentationMeta.aspectRatio`（P3）
3. P9 的整套：`providers` 字典 schema、凭据引用、旧字段迁移、`mediaProbe` 远程命名空间

---

## 7. 剩余工作

**未做但有价值（按价值排序）**
1. **i18n**：文案目前内联中文。落地需接 DSH 的 locale 面（`slots.installLocale` /
   组件 `t` 座位）并集中到 `shared/strings.ts`。**有意不做**（只面向中文用户，
   集中化的收益要等真要做多语言才兑现）。
2. **输入框旁的生成入口按钮**：生成入口现在只有两条（模型调工具、`/generate` 命令），
   在 composer 工具行加一个「生成」按钮仍是最省事的增值项（命令已就绪，只差
   `session.command()` 调用点）。⚠️ P10 之后那一行**空出来了**（「进入画布」已搬走）。
3. **一次生成多张（`n>1`）批量落图** —— `addNodes` 已支持，需适配器层支持 `n`。
4. **会话画布的回收**：删掉会话不会删它的 `fatfish-canvas:board:<id>` 键，
   localStorage 会慢慢积累。可做：启动时清理「不在会话列表里」的键 ——
   但**必须等会话列表就绪**再动手，否则会误删还没加载出来的会话的画布。
5. **设置页的收尾**：模型行不能拖拽排序；供应商不能改 id（只能删了重建）；
   「获取模型列表」目前是「点一下加一个」，没有多选面板。
6. **节点右键菜单扩展**：复制为新节点 / 导出原图 / 在聊天里定位到生成它的那条消息。
7. **`/generate` 补充语法**：`--n 4`（配合第 3 项）、`--from <节点 id>`（以节点为参考图）。
8. **模型级密钥的「测试连接」**：现在探测按**供应商**做（用供应商级密钥），
   模型级密钥只在生成时生效。要做「用这个模型的密钥测一次」得让探测接受可选的
   `modelId`。
9. **P17 的三件事还没有浏览器 e2e**（本轮只有离线证据）：值得补的是
   ① composer 那格点开 → 菜单真的挂在 `document.body` 上、位置在触发器**上方**且不出视口 →
   页签切换 → 选中 → **宿主设置里真的变了**（照 `e2e-settings.mjs` 自起假服务、自己清理的路子）。
   ⚠️ 量这一格时必须按「可见的那一份」挑（`rect.w > 0`）：本体的 composer 在 hero 与会话态
   之间复用同一棵 DOM，隐藏副本仍在文档里（§8.22）。
   ② 造一个多文件的合成 `drop`（`DataTransfer` 里塞 3–5 个 `File`）断言落点各不相同；
   ③ 拖一个节点靠近另一个，读 `data-guide-count` 与吸附后的坐标。
   三条都需要带令牌的 `DSH_WEB_URL` + danger-full-access。
10. **对齐吸附的下一步**（只有真有人抱怨才做）：等间距 / 分布对齐、逐个元素对齐
    （现在是整组包围盒）、以及把吸附做成可关的偏好（现在只有 Alt 临时关）。

**已知小瑕疵**
- 纯画布下按 Esc 会同时关菜单并退出纯画布（逃生梯的代价，可接受）。
- 命令触发的节点没有 `model` 字段（结果文本第二行没被解析）—— 右键菜单标题少一段模型名。
- 两个 e2e 会往宿主里塞测试会话（见 §5）。
- 隔离模式下删掉会话不会回收它那块画布（见 §7.4）。
- 等待审批的会话里，composer 被审批 UI 接管 → 那一行的控件一起消失（有意行为，
  但那时只剩快捷键可进画布）。
- 纯画布模式下右上角那枚米饭碗**不可见**（整列聊天被收起）——出口是顶栏那格
  「纯画布」与 Esc，已在 `e2e-entry` 里钉住「那一格必须还点得到」。
- 生成模型那格显示的**始终是图像模型**（菜单里两个页签都能改）；title 里
  同时写着图像与视频两个当前值。做成「跟着页签变」会让按钮在关掉菜单后显示上一次
  点过的种类，而那次生成用的可能还是另一个 —— 显示与事实不符比少显示更糟。
- 生成模型那格住在 composer 工具行 ⇒ **hero 欢迎页与纯画布模式下它不渲染**
  （前者没有会话，后者整列聊天被收起）。那两种情况下改模型去设置页
  —— 这是官方席位的作用域决定的，不是可以绕过的实现细节。
- 对齐吸附只在**拖动整组**时按整组包围盒算（见 §3.30③ 的天花板）。

---

## 8. 坑与教训（避免重犯）

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
6. **「读太早」是测试假故障的第一来源**：去抖写盘（画布 400ms，断言持久化前先 sleep
   800）、程序化移动的 240ms 动画、React 异步渲染（探针在同一次求值里 `click()` 后
   立刻查 DOM 必然查不到）、命令结果是异步结算。**要么等够时间，要么轮询到条件成立。**
7. **点击要落在按钮中心**：圆角按钮的外接矩形左上角**命中不到**（角上那一像素在圆角外，
   事件穿到父元素）—— 曾表现为「工具条按钮点得动、米饭碗点不动」，看着像组件坏了。
8. **动作会移动视口，旧坐标立刻失效**：e2e 每步之后都要重新读坐标（「带到视野」把节点
   挪走后，后续的右键就点空了）。
9. **别把会话 id 的 `session-` 前缀削掉**（3.10.3）：无效 id 不报错，只会静默落到别的
   会话上，表现为「落图完全不工作」。
10. **复用 profile 的 e2e 必须自己种状态**（见 §5 横切注意）。
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
    **本轮又踩了三次**（`e2e-scope.mjs` 与 `e2e-entry.mjs` 的 PROBE 注释、
    `styles.ts` 的新样式注释里都写过反引号）。改完模板串里的注释，先
    `node --check <file>` 再跑。
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
18. **新增一个「会改变 app 读哪份数据」的偏好，等于给所有 e2e 加了一条前置条件**：
    画布作用域偏好一被留在 `session`，别的 e2e 种的全局画布就再也读不到。
    处理方式是把清理写进公共常量（`scripts/lib/cdp.mjs` 的 `RESET_BOARD_PREFS`）
    并在每个自己种状态的脚本里插一句 —— 与「每个 e2e 必须自己种状态」是同一条规矩的延伸。
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
36. **用户说「质感差」时，先问「本体用的是哪一批数值」**：见 §3.31 —— 第一方客户端的
    `lib/client.js` 里连 CSS 字符串都是可读的，照抄一遍就与本体现成的一致；
    照着截图调字号/字重/圆角是**猜**，猜错的代价是再来一轮。
