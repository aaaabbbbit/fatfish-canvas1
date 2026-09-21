# 肥鱼画布 · 状态交接

> **跨上下文压缩的唯一记忆。新会话只读这一份，不要依赖对话历史。**
> 最后更新：**P25**（会话画布的回收）。
>
> **配套文件**：平台事实（§3）· 关键决策理由（§4）· 坑与教训（§8）已拆到 **`NOTES.md`** ——
> 那是「动手时按需查」的参考资料，**接手时不用读**。本文件里写的 `NOTES §x.y` 就是指向它。
>
> **维护规则**：这里只写「接手这个工作区必须知道的」—— 现状、下一步、怎么跑、待验证清单。
> 平台事实进 `NOTES.md` 的 §3、决策理由进 §4、坑进 §8。**不要再往上堆 Pxx 变更日志。**
> 2026 年做过一次压缩：原文（1955 行）在 `.reference/STATE.full-backup.md`。

## 0. 30 秒恢复

**这是什么**：DeepSeek Harness 的「肥鱼画布」无限画布插件 —— 画布在左、**本体原生聊天**在右
（不复制聊天 UI），生成结果（图像/视频）**同时**落到聊天与画布节点。

**在哪**：`D:\agent文件目录\肥鱼画布\packages\fatfish-canvas\`（本工作区）。已
`dsh plugin --profile web add link:…` 装进 web profile；`node_modules\fatfish-canvas` 是指向本工作区的 junction。

**存档须知**：
1. **检查点已入库**：标签 `checkpoint-p25` = P11–P25 的实现（`fafb415` 只是初始提交）。它是**地板**，
   不是「已经提交完了」—— 之后的新改动默认还在工作树里，`git status` 是唯一权威，
   `git diff checkpoint-p25` 是「检查点之后做了什么」的进度视图。
   ⚠️ **`git checkout .` / `reset --hard` / `git clean` 仍然危险**：抹掉的是检查点之后的全部改动
   （可能已是好几轮的工作）；要丢之前先 `git stash -u` 或提交一次。它**未经真机验证，不是完工标志**。
2. **动手前先跑** `cd packages/fatfish-canvas && npm run check`（构建 + typecheck + 430 画布逻辑 +
   221 宿主 + 客户端冒烟，无需额外权限），确认拿到的是绿色的工作区。数字随每轮增长，别当契约。
3. **下一步**：① 在**用户自己的终端**跑 `node scripts/post-restart.mjs --delay 20000 --e2e e2e-canvas.mjs`，
   把 P23 改过的 3 条陈旧断言验掉（§7.2）；② §7.13（P17 三件事的浏览器 e2e，照 `e2e-graph.mjs` 写）。
   （§7.1 的 i18n 仍然是**有意不做**。）

**怎么跑**（从便宜到贵）：

```sh
cd packages/fatfish-canvas
npm run check          # 构建 + typecheck + 430 画布逻辑 + 221 宿主 + 客户端冒烟（无需额外权限）
npm run typecheck      # 只跑 tsc
# 以下都要 danger-full-access（无头 Chrome 要命名管道）
npm run e2e            # 26 项画布交互（**3 条断言待重跑**，见 §7.2）
npm run e2e:p4 / e2e:p5 / e2e:theme / e2e:scope / e2e:entry / e2e:settings
npm run e2e:command / e2e:ingest
npm run e2e:graph      # P18 连线 / 连接点 / 鼠标点菜单 / 双击编辑（61 项，需带令牌的 DSH_WEB_URL）
npm run restart:verify # 重启 dsh web + 自动跑 e2e:settings / e2e:command / e2e:graph（§6.1）
node scripts/post-restart.mjs --delay 20000 --e2e <脚本>   # 只跑一条（会先重启宿主）
```

**当前状态**：P0–P23、P25 完成（P24「输入框旁生成按钮」做过一版被用户否掉、已整套回退，见 §7.6）。
浏览器证据：`e2e-graph` **61/61 实跑全绿**，并当场修掉两个真 bug（NOTES §3.35）。**P17–P22 仍然只有离线证据**。
离线：430 画布 + 221 宿主 + 客户端全套（`npm run check` 全绿）。
浏览器：canvas 26（**待重跑**）/ p4 56 / p5 45（P12 起 48）/ theme 15 / scope 26 / entry 38 /
settings 19 / command 13 / **graph 61（P23 实跑）**。
⚠️ `p4 / p5` 是 P10–P12 时代的数字，**P19/P20 往节点菜单加了四项**（NOTES §8.18），所以 `e2e-p5` 的
「菜单有 6 个动作」这类断言**现在多半是红的**，重跑前先按新菜单项改。
宿主最后一次重启是 **2026-09-20 09:29**（`lib/host-status.json` 里 `command` + `models` 都在）。

**⚠️ 等重启**：宿主半边有**五批**改动没生效（`lib/` 已重建，运行中的 dsh web 还是旧模块）：

- **P11**：供应商报错文案 + 视频端点换路径（`host/probe.ts` / `host/providers.ts`）。
- **P12**：**参考图**（新模块 `host/reference.ts` + `host/session-images.ts`、`host/providers.ts`
  的新请求形状、`host/command.ts` 收附件、`host/schema.ts` 两个新字段、`host/generate.ts` 解析参考图、
  `host/tool.ts` 的自适应套用）。
- **P13**：**视觉模型**（`providers.ts` 的 `describeImage`、`generate.ts` 的描述流程与提示词注入、
  `schema.ts` 的 `kind:'vision'` + `defaultVision`、`probe.ts` 的 `guessKind` 认视觉模型名）。
- **P18**（只有一处，但很关键）：`src/client/shared/media.ts` 的 `parseGenerateLine` 多认一个
  `--wf <节点 id>`。**这个文件宿主也在用**（`host/command.ts` 反向引用它）→ 旧宿主会把 `--wf`
  当成「未知参数」直接报错，症状是点「运行」之后生成节点立刻失败。重启之前，画布上的
  连线 / 节点 / 导出 / 还原**都能用**，只有「运行工作流」走不通。
- **P22**：`mediaProbe` 多一个 `storeReference` 方法（`host/probe.ts` + `index.ts` 的附件写入面接线 +
  `shared/probe.ts` 的共享描述符）。不重启则本地拖进来的图仍然连不上生成节点，其余功能不受影响
  （客户端已能优雅降级：调用失败只留一句提示，不会崩）。

下次改宿主仍然必须重启（NOTES §3.4），用 `npm run restart:verify` 一条命令完成「重启 + 验证」，见 §6.1。

**P17–P22 待真机验证**（刷新页面后走一遍；P23 已把它自己那两条验掉）：

- **P22 本地图当参考图**：① 从资源管理器拖一张本地照片进画布 → 等一两秒 → 从它的连接点拉线到
  生成节点 → **应该连得上**；② 点「运行」→ 会话里那行命令的 `--ref` 是**一条短路径**（不是几万字符的
  base64）；③ 拖一张 GIF（附件服务不收的格式）→ 底部立刻提示存不成参考图，再拉线会明确说原因；
  ④ 导出带工作流的 PNG → 清空 → 拖回 → 还原 → 本地图的连线**仍然在**。
  **补丁那条路**（刷新即生效）：拿一个**不会**经过拖放的节点（生成节点出的内联图，或刷新前就在
  画布上的老节点）拉线 → 底部闪「正在请宿主把这张图存成参考图…」→ **线自己连上了**。
- **P21 菜单鼠标点击**（10 秒）：空白处右键「新建生成节点」、节点右键「运行此节点 / 复制为新节点 /
  导出带工作流的 PNG」、左下缩放档位 —— **鼠标点**都生效（键盘路径一直是好的）。
- **P20 参数补完**：种类切「视频」→ 多出**时长 / 清晰度**（图像时不出现）→ 选 5s + 1080p → 运行 →
  命令应带 `--duration 5 --resolution 1080p`；右键「运行此节点」→ **只有它**变「生成中…」；
  「复制为新节点」**不带旧图**；上游从没跑过时「运行此节点」→ 提示「上游节点还没有出图」且
  **一条命令都不发**。
- **P19 串联**：串 `文字→生成A→生成B` → A 先「生成中…」，A 出图**之后** B 才开始（B 的命令行带
  `--ref A 的图`）；参数条切视频 + 16:9 → 卡片形状跟着变；把 B 的线拉回 A → 提示「会绕成一个环」；
  生成中拉线 → 提示「还在生成中」；导出 → 清空 → 还原后参数条仍是视频 · 16:9。
- **P18 节点化**：悬停节点 → 四条边中点各冒一个加号（10% 缩放下仍是屏幕上那么大、仍点得到）；
  拖加号成连线、中点 × 删除、非法组合在底部说明理由；空白处右键新建节点、双击文字节点写提示词
  （Ctrl+Enter 保存 / Esc 取消，编辑时按 Delete / 方向键**不会**动节点）；顶栏「运行」→ 出图**回填该节点**
  （不多出 `gencmd_*` 散图）；导出 → 清空 → 拖回 → 还原工作流。
- **P17 主界面三件事**：本体模型名**左边**那格「✦ 图像 acme-large」（朝上弹的菜单、两页签、选中带勾）
  → 选一个会写进设置（设置页下拉同步变）；一次拖 5 张图 → 一行 4 个 + 第二行 1 个，互不重叠；
  拖节点靠近另一个 → 出现虚线并「啪」地贴上去，按住 **Alt** 拖 = 不吸附。

**三条硬约束**（违反会浪费大量时间）：
- **无头 Chrome 需要命名管道**：所有 `e2e` / `probe` 必须在 `danger-full-access` 下运行，否则以
  `mojo/platform_channel.cc: Check failed: 拒绝访问 (0x05)` 失败。
- **含中文的源文件只用 `edit` / `write` 工具改**：PowerShell 5.1 会把 UTF-8 无 BOM 文件按 ANSI 解码 /
  `>` 重定向写成 UTF-16 → 全文变乱码（NOTES §8.1）。PowerShell 只用来跑命令。
- **宿主改动必须写进本文件的「等重启」清单**，否则下个会话会以为它已生效。

**⚠️ 浏览器 e2e 现在怎么跑**（四条硬事实，别再踩）：
1. **不能在会话里重启宿主**：`taskkill /PID <dsh web> /T /F` 会把**我自己的进程树**一起杀掉
   （实测 `post-restart.mjs` 就死在 taskkill 那一行，宿主 PID 反而活着）→「重启 + 验证」必须由
   **用户在自己的终端**跑。
2. 会话内的替代办法是**再起一个临时实例**（`dsh --profile web --port 3099 --no-open`，跑完 taskkill）：
   确实能跑通（61/61 就是这么来的），但它与运行中的宿主**共用同一个 profile**（会重写
   `~/.dsh/profiles/web/cordis.yml`）并顺手重写 `lib/host-status.json`。**要用先问用户。**
3. 无头 Chrome 与「抓子进程输出」都要 **danger-full-access**（实测 workspace-write 下
   `spawnSync netstat.exe EPERM`）。
4. **令牌只在 `dsh web` 启动那一行里**（进程内存、落不了盘）→ `post-restart.mjs` 把宿主输出写
   `lib/dsh-web.log`、解析出**带令牌的地址**写 `lib/web-url.txt`、经 `DSH_WEB_URL` 回灌给 e2e 子进程
   （`--e2e <脚本>` 可只跑一条）。「无头浏览器一律 401」这个结了五轮的死结就是这里解开的。

---

## 1. 阶段与验收

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 骨架、双半边插件（宿主组合包 + 客户端插件），**客户端半边**免重启热激活 | ✅ |
| P1 | 无限画布：平移/缩放/框选/多选/拖拽/删除/持久化 + jaaz 落位算法 | ✅ |
| P2 | `media-generation` settings namespace、图像/视频适配器、`media_generate` 工具、设置页 | ✅ |
| P3 | 生成结果 → 画布节点（`presentationMeta` → 落图）+ 聊天侧 keyed 工具行 | ✅ |
| P4 | 画布工具条、视图菜单、新节点自动跟焦 | ✅ |
| P5 | 节点右键菜单、菜单键盘导航与无障碍、浅深主题对比度复查 | ✅ |
| P6 | `/generate` 直达命令（不过模型）+ 命令结果落图 + 重新生成升级 | ✅ |
| P7 | 画布按会话隔离：共用一块 ⟷ 每个会话一块（记账独立、切换不丢东西） | ✅ |
| P8 | 入口搬进 composer 工具行（修掉压住 session log）、视图菜单搬到画布顶栏 | ✅（P10 已改回去） |
| P9 | 多供应商 / 一供应商多模型 / 密钥进凭据库 / 测试连接 / 获取模型列表 / 模型级密钥 | ✅ |
| P10 | 入口回**右上角**（与 session log 同席位）+ 画布里单击即回聊天 + 纯画布独立成顶栏一格；**删掉整个「视图」菜单** | ✅ |
| P11 | 设置页写入面修好（`remote.settings` / `remote.credentials`，一层信封、位置参数、冲突码 `settings/conflict`） | ✅（等重启） |
| P12 | **参考图**：模型只递地址、宿主取字节；`media_generate.reference` + `/generate --ref` + 命令收附件 + 右键「以此为参考图生成」+ 供应商级 `referenceMode`/`referenceField` + **自适应** | ✅（等重启） |
| P13 | **视觉模型当眼睛**：`kind:'vision'` 与图像/视频同处一个供应商字典，`defaultVision`；看不见图时先由它把图读成文字、注入提示词并回给模型自己 | ✅（等重启） |
| P17 | **主界面三件事**：生成模型选择进 composer 工具行（本体模型位**紧左边**一格）、多图网格落位（`dropLayout`）、拖动对齐虚线 + 自动吸附（Alt 关闭） | ✅（待真机） |
| P18 | **画布节点化**：四条边中点连接点（纯 CSS）、拖拽连线（`LinkLayer` SVG）、`gen` 节点 + 空白处新建 + 文字节点双击编辑、顶栏「运行」+ `--wf` 回填、导出/还原工作流 PNG | ✅（等重启；待真机） |
| P19 | **串联 + 参数条**：`gen→gen` 连线（A 的图当 B 的参考图）→ 环检测 `wouldCycle` + 拓扑序 `topoOrder`、`runWorkflow` 等上游出图、参数条（产物种类 + 画幅比例） | ✅（待真机） |
| P20 | **参数补完 + 单节点运行 + 复制节点**：视频时长/清晰度、右键「运行此节点」「复制为新节点」、`regenerateCommandLine` 改收对象 | ✅（待真机） |
| P21 | **修一个从 P5 就有的真 bug**：画布菜单**鼠标点菜单项毫无反应**（视口 `onPointerDown` 在 `click` 之前就卸载了菜单）；判据改用 `data-ffc-menu`；顺带让菜单能滚 | ✅（待真机） |
| P22 | **本地图当参考图**：新增反向字节通路 `mediaProbe.storeReference`（客户端交字节 → 宿主 `ctx.attachments.saveImage` → 回宿主路径 → 存在节点 `ref` 上） | ✅（等重启；待真机） |
| P23 | P18 的浏览器 e2e（`e2e-graph.mjs`，61 项，**实跑全绿**）+ 它抓出的两个真 bug（NOTES §3.35） | ✅（已真机验证） |
| P25 | **会话画布的回收**：删会话不删画布 → 键堆到配额满、`setItem` 抛异常、**画布从此静默不落盘**；按平台判据 `phase==='ready'` + `ids` 回收孤儿键 | ✅（刷新即生效） |

**仍然有效的验收读数**（都是真实 GUI 跑出来的；历史明细已删，旧版本见备份）：
- `e2e-entry`（39 项，P10 重写）：入口 `32×32 @ (1604,12)`（**只有米饭碗图形**、`textContent === ''`）
  在 session log 右边（order 10 > 0）且**不相交**、log 自己仍可命中、在同一个 `headerUtilities` 容器里、
  不在 `shell.overlay` 里；进画布后位移 0、aria-label 变成「返回聊天界面」而图形一个字没变；
  顶栏**没有**「视图」而有「纯画布」，纯画布下那一格**仍可命中**（唯一出口）；40% 窄画布下顶栏不溢出。
- `e2e-settings`（19 项）：加自定义供应商 → 真实输入 + 真实失焦 → 密钥进凭据库（「已配置」）→
  「测试连接」打到本机假服务（**连接正常 7 ms**）→ 拉回 3 个模型并自动标好种类 → 模型级密钥 →
  设为默认图像模型 → 清理痕迹。
- `e2e-command`（13 项）：命令真被适配器接受、`gencmd_*` 落图、提示词与画幅来自命令行原文
  （**世界尺寸 320×180**，屏幕尺寸被 zoom 缩放，断言要用世界尺寸）、`(无) → pending → failed` 迁移可见、
  记账持久化、重载幂等；失败文案就是共用管线那条提示（证明宿主是新模块）。
- `e2e-scope`（26 项）：点开关后 `data-ffc-scope` 由 `shared` 变 `session`、出现且仅出现一个
  `fatfish-canvas:board:session-<uuid>` 键、**键后缀与页面记的当前会话一致**（证明会话 id 没被削前缀）、
  原画布被 adopt 且共用那块原样保留、刷新后偏好与内容都在、关开关后回到共用。
- `e2e-theme`（15 项）：两套主题 × 21 处元素算 WCAG 对比度（正文 ≥4.5、次要 ≥3.0），抓出两处真 bug（NOTES §3.16）。

---

## 2. 目录与安装

```
packages\fatfish-canvas\
├── package.json         双半边声明（dsh.bundle.patch + dsh.client）
├── cordis.patch.yml     **刻意留空**（激活行在 profile 层，见下）
├── build.mjs            TypeScript 编译器 API 自写打包器（零原生依赖）
├── src\index.ts         宿主半边入口：settings namespace + 迁移 + 工具 + 命令 + mediaProbe
├── src\host\            schema（providers 字典 / 解析 / 选择 / 迁移）· providers（适配器，
│                        含 describeImage：视觉模型读图）· generate（共用管线 + 参考图描述注入）·
│                        tool · command · probe（测试连接/模型列表，guessKind 认视觉模型名）·
│                        reference（参考图句柄 → 供应商载荷 / multipart 字节）·
│                        session-images（本回合用户附的图 → 持久附件引用）
├── src\client\
│   ├── index.tsx        插件体：apply / inject / name（含 $mount 远程贡献）
│   ├── ambient.d.ts     统一基座 + 宿主/客户端服务面的本地类型声明（typecheck 靠它）
│   ├── state.ts         视图模式 + 宽度 + 跟焦偏好 + 画布作用域偏好（外部 store）+ AppFrame 打点
│   ├── menu.ts          菜单基础设施：useMenuNav / useMenuDismiss / useMenuFocus / clampToViewport
│   ├── shortcut.ts      Ctrl/⌘+Shift+B 切视图（VIEW_SHORTCUT_LABEL 在这里）；Esc 退出纯画布
│   ├── styles.ts / icons.tsx / CanvasPanel.tsx / dom.ts
│   ├── EntryButton.tsx  入口按钮（会话头部右上角，与 session log 同席位）：单击 = 聊天 ⟷ 画布，
│   │                    **只有米饭碗图形**（无文字），位置一律不变，语义在 aria-label / title 里
│   ├── settings/MediaSettings.tsx  设置页（供应商/模型/密钥/探测；模型种类三档 + 默认视觉模型下拉）
│   ├── settings/models.ts          主界面读的模型目录（纯函数解析）+ 默认模型写入
│   │                               （与设置页**共用同一个** mutateSettings）
│   ├── settings/ModelPicker.tsx    composer 工具行那格「生成模型」（官方同款触发器 + 朝上弹的菜单）
│   ├── toolview/MediaToolRow.tsx   聊天侧 keyed 工具行
│   ├── shared/catalog.ts           供应商**预设**目录 + 凭据引用名推导 + modelRef
│   ├── shared/media.ts             **共享契约**：工具名/命令名/meta 键/尺寸/幂等 id/命令行语法
│   │                               （`--ref` 与 isReferenceHandle 也在这里：两半边共用同一判据）
│   ├── shared/probe.ts             **探测的远程契约**（宿主清单与客户端贡献同源）+ unwrapProbeResult
│   └── canvas/          model（视口数学+落位+连线类型）· store（节点+连线+记账+持久化+作用域换键）·
│                        ingest（会话快照→画布，工具与命令两条入口 + `--wf` 回填）· bridge（ctx.sessions 订阅）·
│                        scope（偏好 × 当前会话 → 读哪块画布 + 孤儿键回收）· follow（跟焦）·
│                        actions（视图动作）· regenerate（重新生成 / 以此为参考图生成 / runCommandLine）·
│                        ports（连接点几何）· graph（连线规则 / 输入取值）· run（运行工作流）·
│                        pngmeta（PNG tEXt 读写 + CRC32）· workflow（工作流文档序列化 / 还原计划）·
│                        exportImage（导出带元数据的 PNG）· notice（底部提示，跨模块）·
│                        LinkLayer（连线层）· CanvasMenu（空白处右键新建）·
│                        CanvasStage / NodeCard / NodeMenu / ZoomControls
└── scripts\             lib/cdp.mjs（CDP 基建 + RESET_BOARD_PREFS）· test-model / test-host /
                         verify-client · e2e-canvas / e2e-p4 / e2e-p5 / e2e-theme / e2e-scope /
                         e2e-entry / e2e-settings / e2e-command / e2e-ingest / e2e-graph ·
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
`data.push(...insert)`、**不去重**；重复插入会让插件加载两次，注册 settings namespace 时
以「重复 namespace」报错。

---

## 5. 测试与验证

```sh
cd packages/fatfish-canvas
npm run check        # 构建 + typecheck + 430 画布逻辑 + 221 宿主 + 客户端冒烟（无需额外权限）
npm run e2e          # 26 项画布交互（真实浏览器，danger-full-access）
npm run e2e:p4 / e2e:p5 / e2e:theme / e2e:scope / e2e:entry / e2e:settings
npm run e2e:command / e2e:ingest / e2e:graph
npm run restart:verify   # 重启 dsh web + 自动跑 e2e:settings / e2e:command / e2e:graph（§6.1）
node scripts/e2e-ingest.mjs --expect-status failed                  # 无密钥：pending → failed
node scripts/e2e-ingest.mjs --expect-status ready --require-pending # 配假供应商：pending → ready

# 成功路径不需要真实密钥：
node scripts/fake-media-server.mjs --port 8791 --delay 2500 --key sk-local-fake
# ↑ 也实现 GET /v1/models（P9 的「测试连接 / 获取模型列表」打它）
node scripts/probe-gui.mjs --expr-file scripts/probe-composer.js --json lib/probe.json   # 任意 DOM 查询
```

**每个套件抓什么**（数量与「已跑/待跑」见 §0）：

| 手段 | 抓什么 |
|---|---|
| `test-model.mjs` | 纯逻辑：视口数学与锚点、落位算法、store 动作/持久化/坏数据防御、落图计划（幂等/新鲜度/不跳位/不复活）、命令落图、跟焦、视图动作与模式、菜单纯逻辑、命令行语法、画布作用域（键映射/adopt/策略层）、参考图句柄判据、`dropLayout` / `snapMove` / `mediaCatalog`、**会话画布回收的判据（8b 节 14 条）** |
| `test-host.mjs` | schema 形状与脱敏、工具契约、适配器 URL/头/体、错误文案、命令契约与结果文本约定、参考图（地址→载荷 / `referenceField` 覆盖 / `data:` 透传 / 本地文件→data URL / `edits` multipart / 命令收附件 / `--ref` 优先）、视觉模型（解析与选择、请求形状、描述注入、四种「不该发请求」的情形） |
| `verify-client.mjs` | 惰性契约、factory 物化、apply 不抛错、深度渲染（工具行三态 + 参考图徽标与描述行 / 工具条 / 纯画布 / 快捷键与 Esc / 刷新自救 / composer 生成模型格）、作用域 × 桥 × 工具条读数、设置页三个模型下拉 |
| `e2e-canvas.mjs` | 只有真实浏览器能暴露的：事件派发、指针捕获、锚点几何（**P23 起 3 条断言按 P15 语义重写，待重跑**） |
| `e2e-graph.mjs` | 连接点纯 CSS 悬停淡入 / 拖出连线（端点落在**用户拉的那个点**上）/ 10% 缩放下连接点仍 28px / 非法连线逐条理由 / **鼠标点菜单项**（P21 回归）/ 双击文字节点内联编辑 |
| `e2e-p4.mjs` | 按钮真的可点、纯画布下 overlay 仍可命中、布局真的重排与恢复、作用域读数真的点得动、模式切换走真实控件 |
| `e2e-p5.mjs` | `contextmenu` 与光标坐标、菜单命中测试、按键真的到达菜单、`aria-activedescendant`、剪贴板、作用域读数开关、「以此为参考图生成」的可用性与禁用原因 |
| `e2e-theme.mjs` | 设计 token 在两套主题下的真实取值与对比度（CSS 变量解析、alpha 合成、渐变盲区） |
| `e2e-scope.mjs` | 读数开关真的换键、**键名带完整 `session-<uuid>`**、adopt、刷新后仍在会话画布、再点回到共用 |
| `e2e-entry.mjs` | 入口与 session log 的矩形（不相交、在它右边、log 仍可命中）、进画布后位移 ≤6px、aria-label 双向切换而图形没有文字、顶栏没有视图菜单而有「纯画布」且它是唯一出口、窄画布下顶栏不溢出 |
| `e2e-settings.mjs` | 加供应商 → 保存 baseURL → 密钥进凭据库 → 测试连接打到本机假服务 → 拉模型列表并按种类标识加进来 → 模型级密钥 → 设为默认 → 清理（自起假服务） |
| `e2e-command.mjs` | 斜杠命令真被适配器接受并派发、`command/run↔done` 真的折叠成客户端节点、结果真的落图 |
| `e2e-ingest.mjs` | `ctx.sessions` 能否注入、订阅是否被真实事件流驱动、pending→终态迁移、跟焦、媒体是否**真的加载**（`naturalWidth>0`） |
| `probe-gui.mjs` | 任意 DOM 事实查询；`--json <path>` 让 Node 自己写盘（**别用 PowerShell 重定向**，NOTES §8.19） |

**横切注意**：
- 无浏览器替身**测不出**指针捕获偷点击、`contextmenu` 坐标、按键是否到达、媒体是否加载。
- **每个 e2e 必须自己种状态**：探针 profile 是复用的，上一次运行留在 localStorage 的画布会污染下一次。
- **种画布的脚本还必须清掉画布作用域偏好**（残留 `board-scope=session` 会让「种下的节点一个都没渲染」）。
  公共前置常量在 `scripts/lib/cdp.mjs` 的 `RESET_BOARD_PREFS`（`goto()` 已内建）。
- **种画布必须用 `seedBoardExpression()`**：它把**当前账本原样带进新种子**。因为落图有一条有意为之的规则
  —— **结果够新就补落**（`INGEST_FRESH_MS` = 10 分钟）→ 把 `ingested` 写成 `[]` 会让刚跑过的命令节点
  **又落回画布**。**这不是 bug，是设计**；e2e 必须保住账本。
- **用真实事件驱动 UI，不要合成事件**：React 把 `onBlur` 委托在原生 **focusout** 上，
  `dispatchEvent(new Event('blur'))` 不会触发它（原生 blur 不冒泡）。症状特别阴：界面回显是对的
  （那是**组件草稿**），宿主读到的却是空值。正解：`el.focus()` + `Input.insertText` + 点别处造成**真实失焦**。
- `e2e-ingest` / `e2e-command` 每次运行会**在宿主里新建一个会话**（真实链路的代价）；
  `e2e-scope` 会在探针 profile 里留下一个会话画布键（无害）。

---

## 6. 开发回路

```sh
# 改客户端代码
node build.mjs && 刷新浏览器          # 客户端 bundle 以新哈希重新服务，立即生效
# 改宿主代码
node build.mjs && 重启 dsh web        # 宿主半边不会重新导入（NOTES §3.4）
```

**当前 profile**：`dsh web` 在 http://127.0.0.1:3080 运行，插件已激活。

### 6.1 重启宿主为什么需要一个脚本（P9 加的 `post-restart.mjs`）
**`dsh web` 就是承载当前对话的那个进程**：谁在会话里直接 `kill` 它，自己这一轮就当场结束，
用户看到页面断开、没有任何解释，验证也做不成。
```sh
npm run restart:verify      # = node scripts/post-restart.mjs --delay 5000 --verify
```
它做五件事，全程**增量**写 `lib/post-restart-report.txt`：
1. 延迟 `--delay` 毫秒（留给当前这一轮把话说完）
2. `netstat -ano` 找监听 3080 的 PID → `taskkill /PID <pid> /T /F`（**不用 WMI**：受限环境下
   `Get-CimInstance` 会「拒绝访问」，NOTES §8.21）
3. `spawn('cmd.exe', ['/c','dsh','web'], { detached: true, stdio: 'ignore' })` + `unref()`
   —— detached 才能在自己父进程（也就是被 kill 的宿主）死后继续活着
4. 等端口恢复 → 等 12 秒让插件加载 → 读 `lib/host-status.json`，断言里面有 `command` 与 `models`
   （= 宿主确实是新模块）
5. `--verify`：跑 `e2e-settings.mjs` 与 `e2e-command.mjs`，把结论行写进报告

**下一步会话怎么用**：读 `lib/post-restart-report.txt` 就知道重启成没成、两条 e2e 过没过。
报告里 `✅ 宿主是新模块（command + models 字段都在）` 是宿主半生效的铁证。
（P23 起它还会抓 `dsh web` 的带令牌地址喂给 e2e，见 §0。）

---

## 7. 剩余工作

**未做但有价值（按价值排序）**
1. **i18n**：文案目前内联中文。落地需接 DSH 的 locale 面（`slots.installLocale` / 组件 `t` 座位）
   并集中到 `shared/strings.ts`。**有意不做**（只面向中文用户）。
2. **`e2e-canvas.mjs` 的 3 条陈旧断言**（P15 的输入框聚焦语义 + 框选起点落在种子节点里）：已按诊断改好，
   但**改完这一版还没跑过** —— 在用户终端跑 `node scripts/post-restart.mjs --delay 20000 --e2e e2e-canvas.mjs`。
3. **接真 ComfyUI 后端**（用户最初问的另一条路）：节点类型从 `GET /object_info` 动态渲染 + `POST /prompt` +
   轮询 `/history`。元数据那半边（`pngmeta.ts`）已就绪、`workflow` 键名与结构就是照它做的；缺的是通用节点
   渲染与「一个连接点怎么选多个插槽」。
4. **并行调度**（P19/P20 的天花板）：同一层的多个生成节点也是**串行**跑。要并行得自己限流，
   而供应商的并发额度各家不同 —— 先知道额度再谈并行。
5. **供应商内联返回的大图存句柄** —— 已在**连线那一刻**补上（NOTES §3.34）；`ingest` 那边**不必**再补一次；
   真正还缺的只是「连上之前」节点上仍然背着几兆的内联图。
6. **输入框旁的生成入口按钮**（**P24 做过一版，用户说「一般用不到」，已整套回退**）：
   **除非用户明确要，不要再提第二遍。** 真要做，两个当时的坑：① 反馈不能走 `pushNotice`
   （画布那条提示渲染在画布面板里，而画布面板在聊天模式下是 `null`），只能长在按钮自己身上；
   ② 读输入框要排除 `.ffc-panel` 里的编辑控件并跳过 0 宽的隐藏副本。
7. **一次生成多张（`n>1`）批量落图** —— `addNodes` 已支持，需适配器层支持 `n`。
   ⚠️ 与 `--wf` 的「一条命令回填一个节点」冲突：一条命令出 N 张要落成 N 个节点，得先想清楚它们与
   生成节点的关系（父节点 + N 个子节点？）。
8. **会话画布的回收** ✅ P25 已做完（NOTES §3.36）。还留着的口子：**子代理会话**曾经被打开过的话，
   它那块画布会被收掉（媒体还在会话日志里）—— 要补就从 `subagentsByParent` 取活着的子会话。
9. **设置页的收尾**：模型行不能拖拽排序；供应商不能改 id（只能删了重建）；「获取模型列表」目前是
   「点一下加一个」，没有多选面板。
10. **节点右键菜单还差一项**：在聊天里定位到生成它的那条消息。
11. **`/generate` 补充语法**：`--n 4`（配合第 7 项）、`--from <节点 id>`（以节点为参考图）。
12. **模型级密钥的「测试连接」**：现在探测按**供应商**做，模型级密钥只在生成时生效。
    要做「用这个模型的密钥测一次」得让探测接受可选的 `modelId`。
13. **P17 的三件事还没有浏览器 e2e**（只有离线证据）：① composer 那格点开 → 菜单真的挂在 `document.body`
    上、位置在触发器**上方**且不出视口 → 页签切换 → 选中 → **宿主设置里真的变了**（照 `e2e-settings.mjs`
    自起假服务、自己清理的路子）；② 造一个多文件的合成 `drop`（`DataTransfer` 里塞 3–5 个 `File`）
    断言落点各不相同；③ 拖一个节点靠近另一个，读 `data-guide-count` 与吸附后的坐标。
    ⚠️ 量这一格时必须按「可见的那一份」挑（`rect.w > 0`，NOTES §8.20）。三条都需要带令牌的 `DSH_WEB_URL` +
    danger-full-access —— P23 起有现成办法：`node scripts/post-restart.mjs --delay 20000 --e2e <脚本>`。
14. **对齐吸附的下一步**（只有真有人抱怨才做）：等间距 / 分布对齐、逐个元素对齐（现在是整组包围盒）、
    把吸附做成可关的偏好（现在只有 Alt 临时关）。
15. **一个独立的 `describe_image` 工具**：现在「看图」只在生成流程里顺带产出（NOTES §3.25），
    让模型能单独看图是同一套机械的下一个出口。

**已知小瑕疵**
- 纯画布下按 Esc 会同时关菜单并退出纯画布（逃生梯的代价，可接受）。
- 命令触发的节点没有 `model` 字段（结果文本第二行没被解析）—— 右键菜单标题少一段模型名。
- 两个 e2e 会往宿主里塞测试会话（§5）。
- 等待审批的会话里 composer 被审批 UI 接管 → 那一行的控件一起消失（有意行为，那时只剩快捷键可进画布）。
- 纯画布模式下右上角那枚米饭碗**不可见** —— 出口是顶栏那格「纯画布」与 Esc。
- 生成模型那格显示的**始终是图像模型**（菜单里两个页签都能改）；title 里同时写着图像与视频两个当前值。
  做成「跟着页签变」会让按钮显示上一次点过的种类，而那次生成用的可能还是另一个 —— 显示与事实不符比少显示更糟。
- 生成模型那格住在 composer 工具行 ⇒ **hero 欢迎页与纯画布模式下它不渲染**（官方席位的作用域决定的）。
- 对齐吸附只在**拖动整组**时按整组包围盒算（NOTES §3.29③）。
- **同层的生成节点也是串行跑**；**上游失败 = 下游直接判失败**，没有降级路径。
- **「运行此节点」不重跑上游**：上游还没出图时它会明确拒绝（刻意，NOTES §3.33）。
- **连线那一刻才给内联图补句柄**（NOTES §3.34）：连上之前，那种节点在内存与持久化里都还背着整张几兆的内联图。
- **参考图句柄是宿主文件路径**：它会进会话日志，且在**换机器/清理附件库之后失效**。
- **导出只写 PNG 的 tEXt**：JPEG/WebP 的 EXIF/XMP 不写；非 PNG 的图会先解码再用 PNG 存一遍。
- **拖回带工作流的图不会自动还原**，只给一条提示；真 ComfyUI 导出的图会被认出来并如实说明不能还原。
- 连线**只有一种方向**（四个连接点等价，方向由拖拽的起点决定）：合法的边只有「产物 → 生成」，
  其余组合在连线那一刻就被拒并说明原因。
