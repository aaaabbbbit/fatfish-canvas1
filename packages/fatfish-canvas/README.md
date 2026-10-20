# 肥鱼画布 · fatfish-canvas

DeepSeek Harness 无限画布插件：**左侧无限画布、右侧本体原生聊天**，生成结果直接落到画布节点。

> 状态：**P0 ~ P10 全部完成**（宿主半边的改动需要一次 `dsh web` 重启；
> 本轮 P10 只动客户端半边，重建 + 刷新页面即生效）。

## 它做什么

| 能力 | 阶段 | 状态 |
|---|---|---|
| 右上角鲸鱼尾巴入口（只有图形，会话头部与 session log 同一席位）· 单击进画布 | P10 | ✅ |
| 画布模式下同一枚鲸鱼尾巴：单击回聊天（位置不变，无菜单） | P10 | ✅ |
| 画布模式：AppFrame 真实收窄，聊天重排到右侧 | P0 | ✅ |
| 画布面板宽度拖拽 / 双击重置 | P0 + P4 | ✅ |
| 无限画布：平移 / 缩放 / 框选 / 多选 / 拖拽 / 删除 / 持久化 | P1 | ✅ |
| 生成结果自动落位（移植 jaaz 的行列打包算法） | P1 | ✅ |
| `media-generation` settings namespace + 扁平字段密钥存储 | P2 | ✅ |
| OpenAI 兼容图像 / 视频适配器（含视频任务轮询） | P2 | ✅ |
| `media_generate` 工具 | P2 | ✅ |
| 「图像 / 视频模型」设置页（设置导航内，含默认供应商选择） | P2 | ✅ |
| 生成结果双落：聊天消息 + 画布节点（pending → ready/failed） | P3 | ✅ |
| 画布工具条：全选 / 删除选中 / 适应内容 / 跟焦开关 / 清空 | P4 | ✅ |
| 新节点**自动跟焦**（三闸：开关 + 忙碌 + 安静期） | P4 | ✅ |
| 纯画布模式 + 刷新自救 + Esc 逃生梯 | P4 | ✅ |
| 快捷键 `Ctrl/⌘ + Shift + B` 切换聊天 ⟷ 画布 | P4 | ✅ |
| 节点右键菜单（带到视野 / 复制提示词 / 复制地址 / 重新生成 / 删除） | P5 | ✅ |
| 菜单键盘导航 + 无障碍（方向键 / Home / End / Enter / Esc，aria-activedescendant） | P5 | ✅ |
| 浅 / 深两套主题的对比度自动复查 | P5 | ✅ |
| **`/generate` 直达命令**（不经过模型，结果同样落画布） | P6 | ✅ |
| **画布按工作区分隔**（一个工作区一块 ⟷ 全部共用一块，记账独立；老 P7 的「每个会话一块」读作按工作区） | P7 | ✅ |
| **入口搬进输入框行**（不再压住 session log）+ 米饭碗只管进画布 + 视图菜单搬到画布顶栏 | P8 | ✅ |
| **多供应商 / 多模型**（图像·视频标识）+ 密钥进凭据库 + 测试连接 + 获取模型列表 + 模型级密钥 | P9 | ✅ |
| **入口回到右上角**（改住 session log 同一席位，结构上不重叠）+ 画布里单击即回聊天 + 纯画布独立成顶栏一格；视图模式与画布宽度选择移除 | P10 | ✅ |
| **设计技能**：聊天框那枚鲸鱼尾巴**右键 = 开关**（关了尾巴压回默认纯色）；开着时把一份可编辑的文案注入**聊天模型**的 system prompt，由它按此组织发给生成模型的提示词（设置 →「肥鱼画布」里改，清空提交 = 恢复内置） | P41/P42 | ✅ |

## `/generate` 直达命令（P6）

同一个生成，两条入口：**模型决定调用工具**（`media_generate`），或**用户直接敲命令**。
后者不经过模型 —— 零 token、路径更短、行为确定。

```
/generate 一只在飞的肥鱼
/generate --video --ratio 16:9 --duration 5 海浪拍打礁石
/generate --provider volces-images --ratio 3:4 一只戴草帽的猫
```

参数：`--kind image|video`（或简写 `--video` / `--image`）、`--ratio 1:1|16:9|4:3|3:4|9:16`、
`--provider <id>`、`--resolution 480p|1080p`、`--duration <秒>`、
`--ref <参考图地址>`（**可重复，最多 8 张**）；其余文字拼成提示词。
未知参数**明确报错并给出用法**，不静默忽略。

## 参考图：一张或多张（P12 / P31）

模型只递**句柄**，字节由宿主取（文本模型看不见图，见 `host/reference.ts`）。
句柄可以是 `http(s)` 链接、工作区里的文件路径、`data:` 内联地址，
或者会话附件（`"attached"` = 用户这一轮贴的图）。

```
/generate --ref https://x/a.png 换成水彩
/generate --ref https://x/a.png --ref https://x/b.png 把这两张融在一起   # 多张，顺序即语义
```
在输入框里一次贴多张图 + `/generate …` → 那些图**按贴进来的顺序**全部当参考图；
画布上**框选多个节点** → 右键「以此为参考图生成（N 张）」→ 整组按 (y, x) 顺序发出去。

**多张进请求体的两种形状**（字段名由供应商配置的 `referenceField` 决定，默认 `image`）：

| 通路 | 一张 | 多张 |
|---|---|---|
| JSON（`/images/generations`、`/videos/generations`） | `"image": "地址"` | `"image": ["地址1","地址2"]` |
| multipart（`/images/edits`，`referenceMode: edits`） | `image` 一份文件 | `image` **重复多份**（`reference-1.png` / `reference-2.png`…） |

形状参考 [T8-penguin-canvas](https://github.com/T8mars/T8-penguin-canvas)
（`buildImageEditFormData` 逐份 append、`body.images = refs` 收数组）。
**一张时仍是字符串**（老网关照旧收）；上限 8 张，超了在本地就报错。
视觉模型那条路是**一次**调用带多个 `image_url` 块（不是逐张调用）；MJ 系网关
（`mj-describe`）收不了数组，那条路是**每张一个任务**、并发跑完再拼起来。

两条入口共用一条生成管线（`host/generate.ts`），因此供应商选择、比例默认值、
错误文案完全一致；结果也都落到画布上（命令触发的节点用 `gencmd_` 前缀，
与工具触发的 `gen_` 分开记账）。

**结果怎么回到画布**：命令结果只有文本一种载体，因此约定「成功文本的
**第一行**就是媒体地址」—— 客户端从 `command/done` 读回地址，再把
`command/run`↔`command/done` 折叠成的节点当作 pending → 终态来落图，
用的仍是 P3 那套幂等键 / 新鲜度 / 记账规则，不需要任何新的协议面。
右键菜单的**重新生成**现在优先走这条命令，命令不可用时才退回「发一条提示词」。

> ⚠️ 命令由**宿主半边**注册：运行中的 `dsh web` 不会重新导入宿主模块，
> 因此新增命令后要重启一次。`npm run e2e:command` 会先读 `lib/host-status.json`
> 判断宿主是否已带上这条命令，没带就明确报告并跳过。

## 节点右键菜单与键盘（P5）

右键任意节点：**带到视野 · 复制提示词 · 复制地址 · 导出 · 重新生成 ·
以此为参考图生成 · 删除**。
右键会先把选择收敛到该节点（已在多选里则保留整组），因此「菜单作用于当前选择」
是唯一需要记住的规则；复制地址/提示词只在单选时可用，**重新生成**需要当前会话，
而「导出」「以此为参考图生成」在多选时作用于整组（后者 = 多张参考图）。

菜单支持全键盘操作（三处菜单共用 `client/menu.ts` 的同一套行为）：
`↑↓` 在条目间移动并跳过禁用项、`Home`/`End` 跳首尾、`Enter`/`Space` 执行、
`Esc`/`Tab` 关闭；容器用 `aria-activedescendant` 标记当前项，所以 `Tab` 是
「离开菜单」而不是在菜单里跳十几次。

「重新生成」为什么是发一条提示词而不是客户端直接再调工具：工具只在**宿主**执行，
浏览器能发起的只有一条提示词 —— 它等价于用户自己把话再说一遍，只是提示词由我们填好。

## 主题与对比度（P5）

配色全部取自 DSH 设计 token，两套主题自动跟随。`scripts/e2e-theme.mjs` 会在
**浅色与深色**下各遍历 21 处元素，按 WCAG 相对亮度算对比度（正文 ≥ 4.5、
次要文字 ≥ 3.0），并把有效背景按祖先链做 alpha 合成。

它抓出过两处真 bug，都源于同一个 token 语义陷阱：
`--dsw-alias-label-primary-inverted` 不是「恒为白」，而是「主色的**反色**」
（深色主题下它是 `#353638`），而 `--dsw-alias-bg-mask-*` 两套主题都是**深色**遮罩 ——
于是「深遮罩 + 反色文字」在深色下变成深字压深底。
**结论**：压在任意媒体上的浮层（节点悬浮条、失败徽标）用**固定**深遮罩 + 白字，
或改用不随主题翻转的静态色（`--dsw-static-red-900` 等）。

## 三种视图模式（P4 引入，P10 改了入口）

| 模式 | 布局 | 怎么进 / 怎么出 |
|---|---|---|
| 聊天 | 本体默认三栏 | 右上角鲸鱼尾巴单击 / `Ctrl+Shift+B` |
| 画布（并排） | 左侧画布 + 右侧原生聊天 | 同上（鲸鱼尾巴就在右上角原位，单击即回聊天）；宽度可拖右缘 |
| 纯画布 | 画布铺满，聊天列收起 | 画布**顶栏**的「纯画布」按钮；再点一次 / `Esc` 退出 |

P10 把「视图模式选择」这件事整个去掉了：**没有模式菜单**。聊天 ⟷ 画布是一枚
鲸鱼尾巴的双向开关，纯画布是顶栏上独立的一格（因为纯画布收起了聊天列，那一格是
它唯一的出口）。画布宽度的 40 / 62 / 80% 预设也一并移除 —— 宽度由右缘拖拽决定。

**纯画布模式有一处平台陷阱**（写在这里，别再踩）：`shell.overlay` 层是 AppFrame
的**子节点**，所以「把 AppFrame 设成 `display: none`」会把插件自己的画布面板与
入口按钮一起隐藏 —— 白屏，而且没有任何可点的出口。正确做法是隐藏 frame 里
**除 overlay 以外**的直接子元素，并配两层兜底：加载时把 `canvas-only` 降级成
并排画布（`state.ts` 的刷新自救），以及 Esc 逃生梯（`shortcut.ts`）。

## 新节点自动跟焦（P4）

生成结果落到画布上时，用户通常正在读聊天 —— 如果节点落在视野之外，画布看起来
「什么都没发生」。跟焦负责把它带进视野；但自动移动视口是有代价的，所以有三条闸：

1. **开关**（画布顶栏的跟焦图标按钮，偏好持久化）；
2. **忙碌**：正在拖拽 / 框选时绝不抢视口；
3. **安静期**：用户最后一次操作视口之后 700ms 内不抢，排队重试，1.5s 还没安静
   就放弃 —— 宁可不动，也不跟用户拉扯。

几何与策略都是纯函数（`canvas/follow.ts` 的 `planFocus` / `decideFollow`），可完全
离线单测；视口动作集中在 `canvas/actions.ts`，工具条、菜单、缩放条、快捷键走的是
**同一份**实现。程序化移动带 240ms 过渡动画，用户拖拽则绝不加动画。

## 画布按工作区分隔（一个工作区一块）

默认**一个工作区一块画布**：进哪个项目的对话，就看到哪个项目的画布（同一个工作区里的
所有会话共用那一块，不同工作区互不串味）。画布顶栏那枚读数（「共用画布 / 本工作区画布」）
**自己就是开关**，点一下改成**所有工作区共用一块**：

| | 存储键 | 记账账本 | 切会话时 |
|---|---|---|---|
| 按工作区（默认） | `fatfish-canvas:board:<工作区路径>` | **每个工作区一份** | 跟着会话的工作区走 |
| 共用 | `fatfish-canvas:board` | 一份 | 画布不变 |

工作区就是会话的 `cwd`（宿主给的那个已校验的绝对路径），所以「同一个项目里的对话」
天然落在一起，不需要用户先手动指定什么。

四条不变量（都有测试钉住）：

1. **不丢东西**：换作用域先把当前画布落盘到**旧键**，再读新键；切走再切回，
   两边内容都还原。
2. **不抄送**：换到另一个工作区时绝不把上一个工作区的节点带过去 —— 一个工作区一块
   的全部意义就在这里。
3. **从共用切进工作区时按会话拆开**：共用那块是所有项目混在一起的一堆，而每个节点上
   都记着它是哪个会话生成的（`sessionId`），于是它被送回**那个会话所在的工作区**；
   认不出会话的节点留在共用那块。拆分按 id 去重、可以反复跑，共用那块一个字节都不动
   （它仍是「全部内容」的备份，点「共用画布」随时看得到）。
4. **记账账本随作用域独立**：每个工作区记着自己哪些生成已经落过图，因此切回来时历史
   快照不会把节点重放一遍 —— 这正是 `ingested` 必须跟着画布走的原因。

谁决定「读哪个键」是三个地方合起来的事，所以接合点单独成一个模块
（`canvas/scope.ts`）：偏好（`state.ts`，用户想要哪种）× 当前会话的工作区
（`canvas/bridge.ts` 是唯一知道「当前会话是谁」的地方，工作区取自会话列表行上的 `cwd`）
→ `store.setBoardScope`。拿不到工作区（`sessions` 服务缺席、列表还没就绪、会话行上还没有
`cwd`）时**退回共用**：画布照常可用，工具条如实显示「共用画布」，而不是假装已经分开。
工具条上的读数就是这块画布的归属。

> 老偏好兼容：P7 时代留下的 `session`（每个会话一块）读作 `workspace` —— 那次隔离的
> 初衷就是「别把项目 A 的图混进项目 B」，按工作区分正好是它想要的效果。

## 模型配置：多供应商 · 多模型 · 凭据库（P9）

设置 →「图像 / 视频模型」：

| 能力 | 说明 |
|---|---|
| 添加第三方供应商 | 预设一键填好（OpenAI / 火山方舟 / 硅基流动 / 智谱），或「自定义供应商」只填 baseURL —— 只要是 OpenAI 兼容端点 |
| 一个供应商挂多个模型 | 每个模型带**图像 / 视频 / 视觉**标识，决定走哪个适配器（`/images/generations`、`/videos/generations`，或视觉那条把图读成文字） |
| 测试连接 | 宿主拿密钥访问 `{base}/models`，通了就说明地址与密钥都对；401 / 404 各有针对性的提示 |
| 获取模型列表 | 同一次请求的结果，点一下就加进来，并按名字预猜种类（可改） |
| 每个模型单独配密钥 | 右键模型行（或点行尾 ⋯）：可配、可清回「继承供应商密钥」、可改类型、可设为默认 |
| 默认模型 | 图像 / 视频 / 视觉各一个下拉，取值是 `供应商::模型` |
| 常用模型（P29） | 一块按**模型类型**（词干）列出的区域：勾「常用」、改质量参数、定其他参数的默认值 —— 见下 |

**视觉模型（图生文）**只在「当前这条路线的模型看不见图」时出场：把参考图读成一段
文字、拼进提示词前面，并随工具结果回给模型自己。默认走 `{base}/chat/completions`
（图片以 `image_url` 内联），**MJ 系网关**换一个模型名就够 —— 名字命中内置预置
`mj-describe`（`mj-*` / `midjourney*` / `describe*`）时走「提交 + 轮询」：

```
POST {base}/mj/submit/describe  { base64 }        → { code: 1, result: "<任务 id>" }
GET  {base}/mj/task/<任务 id>/fetch               → 轮询到 status 为 SUCCESS
```

⚠️ 描述文字在 `prompt` 里（`description` 是斜杠命令 `/describe`，不是结果）；
端点**只收 base64**，因此这条路上参考图会被下载/解码后内联。基址**不带 `/v1`**
（MJ 端点挂在 `{base}/mj/…` 下，与 OpenAI 兼容端点不同一层）。

**密钥不写进 `settings.yaml`。** 设置里只存**凭据引用名**（`apiKeyEnv`，如
`FFC_ACME_API_KEY`），值进 DSH 凭据库（`ctx.credentials`，也可以用同名环境变量提供）。
因此：

- 设置文件里看不到密钥，**密钥也永远不下发给浏览器**（设置页只显示「已配置 / 未配置」）
- 设置里没有 `role('secret')` 字段 → 脱敏视图与真实视图一致 → 写嵌套结构不会抹掉别人的机密
  （P2 时代之所以必须把字段摊平，正是因为当时密钥就在设置里）
- `settings.yaml` 里长这样：

```yaml
media-generation:
  providers:
    acme:
      label: Acme 网关
      baseURL: https://gw.acme.example/v1
      apiKeyEnv: FFC_ACME_API_KEY
      models:
        - id: acme-large
          kind: image
        - id: acme-video
          kind: video
          apiKeyEnv: FFC_ACME_ACME_VIDEO_API_KEY   # 这个模型用自己的密钥
  defaultImage: acme::acme-large
```

旧版（P8 及以前）的扁平字段（`key_openai_images` 等）会在宿主启动时自动迁移进
新结构并清除 —— 留着不删的话，那些「不在 schema 里」的字段不会被脱敏，会把旧密钥
原样下发给浏览器。

### 常用模型：同一类型的模型共用一份参数（P29）

设置页里多了一块**常用模型**，**一行 = 一个模型类型**：

| 一行上能配 | 落在哪 | 谁在用 |
|---|---|---|
| **常用**（勾选） | `commonModels.<家族>.pinned` | 聊天栏那格的「常用」分区只列勾过的（一个都没勾时全部平铺，与升级前一致） |
| **质量参数**（低 / 高 这种） | `models[].tiers`（家族级声明）或内置预置 | **在聊天栏那格选**；当前值存 `defaultTiers.<家族>` |
| **其他参数**（尺寸 / 背景 / 审核 / 格式 / 种子…） | `commonModels.<家族>.params.<键>` | 这里只是**默认值**；临时要改得在对话里告诉模型，它调 `media_generate` 时带 `params`。**张数不在这里**（一次调用只出一张，多张靠并发调用，见下） |

**「同一类型」= 同一个词干**（`供应商::词干` 是家族键）：`gpt-image-2`、
`gpt-image-2-2k`、`gpt-image-2-4k` 折成一行，将来网关多出别的尾缀也自动共用同一份
配置 —— 不用、也不会重复配。内置预置表（`src/client/shared/modelPresets.ts`）按词干
给出质量取值与其他参数的键，**认不出来的模型一律不猜**（那一行显示「这个类型没有
质量参数」，可以自己声明或自己加参数键）。

```yaml
media-generation:
  commonModels:
    acme::gpt-image-2:            # 键是家族（供应商::词干），不是模型 id
      pinned: true                # 进聊天栏那格的「常用」分区
      params:                     # 其他参数的默认值（空串 = 只声明这个键、默认不传）
        size: 2048x2048
        n: "2"
  defaultTiers:
    acme::gpt-image-2: high       # 质量档：在聊天栏那格里选
```

**本地验证不需要真实密钥**：`node scripts/fake-media-server.mjs --port 8791 --key sk-local-fake`
起一个假服务（带 `GET /v1/models`），在设置页加一家 `baseURL=http://127.0.0.1:8791/v1`
的供应商即可跑通「测试连接 → 获取模型列表 → 生成」。

## 入口（P8 搬走 → P10 搬回来，换了做法；P38 换成鲸鱼尾巴图形）

- **一枚鲸鱼尾巴，双向开关**：会话头部右上角有一个 **32×32 的鲸鱼尾巴圆形按钮**
  （**只有图形，没有文字**），**左键单击**在聊天 ⟷ 画布之间来回切（进画布进的是
  上次用的画布模式，默认并排）。画布模式下它**不消失、也不挪位**：同一个位置、
  同一个图形，只有 `aria-label` / `title` 从「进入肥鱼画布」变成「返回聊天界面」。
- **图形是 DSH 原生那一枚**（P38 起）：`generated/whale.ts` 里是**原生那一套姿态**
  （静止态那条路径的 `d` + 原生 60 帧动画的时序，`npm run art` 从 dsh-client-ui-chat
  的产物里抽 / 推；test-icon 还会拿本机原生重新推一遍、逐字节比）。
  颜色一律 **`currentColor`**（原生就是）—— 深色主题下浅色、浅色主题下深色，两边
  都看得见；**不要写死 `#fff`**（P38 第一版就是那么干的，浅色主题下等于隐形）。
  **静止态与动效都是实心**（用户要「实心纯色」，原生两半都是发丝线）：
  静止态 = 那条路径 `fill="currentColor"` + 同色描边；动图 = 原生那 60 帧**逐帧填成面**
  （`scripts/lib/whale-solid.mjs`）。**鼠标放上去（不用点）就换成会摇的那枚**；
  画布「生成中」那一格与聊天里的工具行也摇
  （`prefers-reduced-motion: reduce` 下压根不切过去，一直是静止态）。
- **为什么 P8 搬走、P10 又能搬回来**：P8 那次它是 `shell.overlay` 里一张
  `position: fixed; top:10px; right:12px` 的**贴纸**，而视口右上角正是聊天头部
  右对齐的 Session utilities 席位（`dsh-session-log-export` 的 session log 占着）
  —— 压住是必然的。P10 不谈像素，改谈**席位**：入口注册进
  `conversation.session.header.utilities`，与 session log **同一个 flex 行**
  （`order: 10` 明确排在它右边）。布局把它们并排摆开，重叠在结构上不可能发生。
- **位置为什么两种模式下不变**：并排画布把 AppFrame 钉在
  `left: var(--ffc-canvas-width); right: 0`，聊天列右缘就是视口右缘，那个席位
  右对齐在聊天列头部 —— 于是两种模式下它的屏幕坐标一模一样（e2e 量出来都是
  `x=1604, y=12`，按钮 32×32）。
- **没有模式菜单了**：视图模式选择与画布宽度预设（P10）已移除；跟焦是工具条上
  的图标按钮，画布作用域就是工具条那枚读数。纯画布是**顶栏独立的一格**。
- 没有当前会话时（新工作区）会话头部不存在，那时用快捷键 `Ctrl/⌘ + Shift + B`。
  纯画布模式整列聊天都收起了，出口是顶栏那格「纯画布」与 `Esc`。

## 生成能力（P2）

`media_generate` 工具让模型发起真实生成，结果同时出现在对话与画布上：

```
用户: 画一只柴犬
  → 模型调用 media_generate { prompt, kind: 'image', aspectRatio: '16:9' }
  → 宿主按 settings 里的密钥调用供应商
  → 返回 { kind, url, model, providerId, ... }
  → 正文给出 URL；presentationMeta 携带富信息供 UI 渲染
```

用户明确提了尺寸 / 背景这类要求时（P29），模型可以带上 `params`：

```
用户: 画一只柴犬，背景透明
  → media_generate { prompt, kind: 'image', params: { background: 'transparent' } }
```

**一次出多张 = 并发调用多次**（P30）：一次调用只出一张（请求体里的 `n` 恒为 1），
用户说「出 4 张」时模型会在**同一条消息里**发 4 个 `media_generate` ——
工具声明了并发安全，宿主真的并行执行（`host/gate.ts` 的闸门默认最多 3 个同时在跑，
其余排队），4 张各自落一个画布节点，**一张失败不影响别张**。

```
用户: 出 4 张：猫 / 狗 / 兔子 / 狐狸
  → media_generate ×4（同一条消息，并行）
```

⚠️ 不要用请求体里的 `n`（张数）凑数：适配器只读响应里的 `data[0]`，网关按 `n` 出
两张而我们只落一张 —— 那是**静默丢图**（钱花了、图没了）。因此 `n` 在保留键清单里
（`model` / `prompt` / `n` / `image`），设置页与预置表里都没有它。

`params` 的键必须是**设置页里为这个模型类型声明过的**（内置预置 + 你自己加的键）。
没声明的键会被忽略，并在工具结果里点名（「忽略了这些参数：style」）—— 整次生成不会
因为一个多余的键失败，但也不会静默地当成成功。**质量档不走这条路**：它归聊天栏那格
的档位 chip 管，模型传 `quality` 时会被告知去那里选。

**供应商目录**（插件常量，随插件升级演进，用户无需迁移）：
OpenAI 图像 / 视频、火山方舟 Seedream / Seedance、硅基流动、智谱 CogView。
两种适配器都按 OpenAI 兼容协议通信：

- `openai-images` → `POST {base}/images/generations`，接受 `data[0].url` 或 `data[0].b64_json`
- `openai-videos` → `POST {base}/videos/generations`。直接出片就返回；只给任务 id 就轮询，
  轮询时同时接受 `data[0].url` / `content.video_url` / `output.url` 三种落点。
  这个路径若在基址上不存在（中转站回的是自家 HTML 首页而不是 JSON），会改试单数写法
  `POST {base}/video/generations` —— new-api 系中转站只有那一条

### 密钥为什么是扁平字段

设置 namespace 里**每个可配置项都是一个顶层标量**（`key_openai_images`、
`model_openai_images`、`baseURL_openai_images`…），而不是一个 `providers` 数组。

原因是浏览器侧的写路径：`SettingsScope.set(field, value)` 一次只能点名**一个顶层字段**
（底层是 settings 的单条 `set` 路径 op）。若供应商是数组，客户端就只能整体回写 ——
而它的视图是**脱敏过的**（`role('secret')` 被协议层剥离），于是每次保存密钥都会
抹掉其它供应商的密钥。settings 文档专门警告过这个陷阱。

扁平化之后，「保存 OpenAI 的密钥」只触碰 `key_openai_images` 一个字段，别的原样不动。
另外密钥字段刻意**不给 `.default()`**：schema 的序列化会把默认值带给每个客户端，
那等于把密钥泄露到线路上。

### 宿主半边的激活需要重启

这是 DSH 的一个平台事实，不是本插件的实现问题：

- **客户端半边**：每次重建都会以新哈希重新服务，**刷新页面即生效**。
- **宿主半边**：profile patch 的重新组合**不会重新导入**宿主模块 —— 行标识未变时
  fiber 被保留，且 Node 的 ESM 按 URL 缓存模块（已实测：禁用再启用、甚至换成全新的
  子路径导出名，都不会重新求值）。

因此改完宿主代码后，需要重启一次 `dsh web`。`lib/host-status.json` 是宿主半边
写下的就绪标记，可用它判定宿主是否真的加载了（`phase` 为 `module-evaluated`
说明模块被导入，为 `host-ready` 说明注册成功）。

## 生成结果落到画布（P3）

生成结果**双落**：一份进对话流（自定义工具行），一份进画布（节点）。

```
media_generate 执行
  → 宿主写 output.presentationMeta { fatfishCanvas: { kind, url, model, prompt, aspectRatio, … } }
  → 随 tool/result 会话事件到达浏览器（会话快照 nodes[].meta）
  → 客户端 canvas/bridge.ts 订阅**当前会话**的快照
  → canvas/ingest.ts：runningCalls → 先落 pending 节点；结果到达 → 只改状态与 src
  → 同一份 meta 由 toolview/MediaToolRow.tsx 渲染成对话里的媒体行
```

三条设计要点（都有测试钉住）：

- **先落 pending，再改状态**：等待中的占位与出图后的节点**重合**（不重新落位），
  所以不会出现「图出来的一瞬间节点跳一下」。
- **幂等**：节点 id 是 `gen_` + callId，且处理过的 callId 记在画布的 `ingested`
  账本里（随画布持久化）。因此重复的会话快照不会造重复节点，**用户删掉的节点
  也不会被历史重放复活**。
- **只吃新结果**：只接受「seq 越过本会话基线」或「10 分钟内」的结果。
  否则每打开一个老会话，它历史上的生成都会重新铺满画布。

⚠️ 落图只跟**当前会话**：客户端只有「当前」（staged）会话的事件窗口是打开的，
别的会话没有实时流 —— 因此隔离模式下切到哪个会话，就只看得到那个会话的结果、
也只往那块画布上落（见上一节）。共用模式下则是「谁在说话就落谁的结果」，
所有会话都落在同一块画布上。

### 不需要真实密钥也能验证成功路径

`scripts/fake-media-server.mjs` 是一个只实现插件认的那一小片协议的假服务
（内部自带极简 PNG 编码器，现画一张「肥鱼在米饭碗里」的图，并刻意慢 2.5 秒 ——
这样「等待中的画布节点」才有可观察的窗口）：

```sh
node scripts/fake-media-server.mjs --port 8791 --delay 2500
```

再把 `~/.dsh/settings.yaml` 的 `media-generation` 指向它（外部编辑会被热发布）：

```yaml
media-generation:
  key_openai_images: sk-local-fake
  baseURL_openai_images: http://127.0.0.1:8791/v1
  model_openai_images: fake-image-1
```

然后：

```sh
node scripts/e2e-ingest.mjs --expect-status ready --require-pending
```

不配任何密钥时，同一条命令配 `--expect-status failed` 也能跑通全链路
（未配置密钥的报错文案会原样落到节点与工具行上）—— 那是最省事的回归方式。

## 画布交互

主流无限画布（Figma / Miro / eagle）的预期映射 —— **拖拽即平移、滚轮即缩放**：

| 操作 | 快捷键 / 手势 |
|---|---|
| 平移 | **左键拖拽空白处** · `Space` + 拖拽 · 中键拖拽 · `Shift` + 滚轮 |
| 缩放 | **滚轮**（以光标为锚点）· `Ctrl(⌘)` + 滚轮 / 触控板捏合 · 左下角 `−` `+`（每次 10 个百分点，以视口中心为锚点） |
| 选择 | 单击 · `Shift` 单击加选/减选 · **`Shift` + 拖拽 = 框选** |
| 移动 | 拖拽节点（多选整组移动）· 方向键微调 1px，`Shift` 为 10px |
| 删除 | `Delete` / `Backspace` · `Esc` 取消选择 · `Ctrl(⌘)+A` 全选 |
| 缩放档位 | 10% / 50% / 100% / 150% / 200% · 「适应内容」· 「1:1」 |

缩放范围夹在 `0.1x – 4x`（jaaz 未声明上下界，由 Excalidraw 内部约束）。

> **与 jaaz 的差异（有意）**：jaaz 的底座是 Excalidraw，其默认是「拖拽 = 框选、
> 滚轮 = 平移」（Figma 键位）。本插件把两者对调成更主流的「拖拽 = 平移、
> 滚轮 = 缩放」，框选移到 `Shift` —— 在只有一块画布 + 一个聊天栏的场景里，
> 平移是最高频操作，不该需要按修饰键。

键盘快捷键刻意挂在**画布元素自身**（`tabIndex=0`）而不是 `window` 上：右侧就是聊天
输入框，若监听 `window`，用户在聊天里按 `Delete` 会误删画布节点。

### 两个只有真实浏览器才能暴露的坑（已修）

1. **视口不能无条件捕获指针。** `.ffc-viewport` 的 `pointerdown` 里若对任何落点都
   `setPointerCapture`，浏览器会把随后的 `pointerup` 与 **`click` 改派给捕获元素**，
   于是视口内所有按钮（缩放条）的 `onClick` 永不触发。现在会先判断落点是否在
   交互控件内（`button / a / input / [data-ffc-ui]`），是则直接让路。
   这个故障在无浏览器替身里**完全测不出来** —— 替身只调用回调，不经过事件派发。
2. **缩放锚点必须用视口元素自己的 rect**（`.ffc-viewport`），而不是外层面板 ——
   面板顶部有 44px 工具条，混用会让所有缩放锚点纵向偏移一个工具条的高度。

## 安装（开发态）

本包同时是宿主组合包与客户端插件，因此一条命令即可接入：

```sh
dsh plugin --profile web add link:D:\agent文件目录\肥鱼画布\packages\fatfish-canvas
```

`dsh plugin` 会把 `link:` 规格锚定到当前目录，pnpm 建立符号链接，
然后 `dsh.plugin.bundles` 会自动接纳这一层。改完代码后：

```sh
pnpm --filter fatfish-canvas build
```

刷新浏览器页面即可生效（客户端 bundle 由 Node 侧按哈希写入启动图）。

**激活行在包内**（`cordis.patch.yml` 里的 `insert`）：`plugin_manager` 的
`install_bundle`、换机器、换 profile **都只认它** —— 所以本包装到别处也能直接起来
（在创作模式里可以直接让 Agent 用 `install_bundle` 指向本目录的绝对路径）。
⚠️ **不要**再在 profile 的 patch 层插一遍：`insert` 不去重，两处同时插入 = 加载两次 =
settings namespace 重名报错。profile 层只放**设置覆盖**（带 `config:` 的那条
`- id: fatfish-canvas`），它按 id 匹配、跟插入来自哪一层无关，改设置实时生效不用重启。

## 架构要点

这个插件建立在四条已核实的 DSH 事实上，全部读自本机安装的产物源码：

1. **一个包可以同时是两半。** 声明 `dsh.bundle.patch` 就是宿主组合包；
   声明 `dsh.client` 就是客户端插件。Node 侧扫描已启用的行，解析
   `exports["./client"]` 并写入启动图。参考实现：`dshmarket`、`dsh-cost-meter`。

2. **客户端 bundle 是惰性 CJS 契约。** 脚本执行只注册 factory，不产生副作用：

   ```js
   window.__ModuleLoader__.load({ id, factory: (require) => { /* … */ return module.exports; } });
   ```

   factory 的同步 `require` **只**解析统一基座里的 7 个 specifier
   （已在前端产物 `assets/index-*.js` 的 `Gd()` 中逐字核实）：
   `react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、
   `@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-ui-slots`、
   `@deepseek-ai/dsh-client-ui-primitives`。
   其余一切要么内联打包，要么经 `dsh.client.external` 登记。

3. **「画布在左、聊天在右」必须靠真实重排，不能靠覆盖。**
   AppFrame 是 CSS Grid，列宽由它**自身实测宽度**经 `ResizeObserver`
   求解决定（`ui-layout` 的 `computeColumns`）。因此画布模式下把 AppFrame
   固定到视口右侧区域，聊天列才会真正重排进右区；顺带 frame 收窄到
   < 1024px 会触发 AppFrame 自己的 sidebar 自动塌缩。若改成「用面板盖住左边」，
   聊天内容仍居中于整宽列，左半会被永久遮住。

4. **`root` 槽位是禁区。** 它的文档明确写着 DO NOT register（单槽位，
   动态注册会遮蔽 AppFrame 并带走它声明的全部席位）。自有浮层走
   `shell.overlay`（加性列表，且条目自身才接收指针事件）。

## 目录

```
packages/fatfish-canvas/
├── cordis.patch.yml          **激活行在这里**（bundle 层：install_bundle / 换机器只认包内 patch）
├── build.mjs                 TypeScript 编译器 API 自写打包器：宿主 ESM + 客户端惰性 CJS 包装
├── scripts/
│   ├── test-model.mjs        画布核心逻辑单元测试（视口 / 落位 / store / 落图 / 跟焦 / 菜单 / 作用域）
│   ├── test-host.mjs         宿主逻辑单元测试（schema / 工具契约 / 适配器，stub fetch）
│   ├── verify-client.mjs     无浏览器冒烟测试（惰性契约 / 物化 / apply / 深度渲染断言）
│   ├── e2e-canvas.mjs        真实浏览器画布交互测试（CDP 派发真实输入）
│   ├── e2e-p4.mjs            工具条 / 纯画布 / 快捷键（视图菜单已移除）
│   ├── e2e-p5.mjs            节点右键菜单 / 菜单键盘导航 / 作用域开关
│   ├── e2e-theme.mjs         浅 / 深两套主题的对比度复查
│   ├── e2e-command.mjs       `/generate` 命令端到端（带宿主重启检测）
│   ├── e2e-scope.mjs         画布按工作区分隔端到端（拆分 → 读数 → 切回去 → 刷新 + 窄宽度布局体检）
│   ├── e2e-entry.mjs         P10 入口端到端（右上角只有鲸鱼尾巴图形 / 不压 session log / 位置不变 / 双向单击 / 纯画布独立成顶栏 / 悬停摇尾巴）
│   ├── e2e-settings.mjs      P9 设置页端到端（第三方供应商 / 测试连接 / 拉模型 / 模型级密钥）
│   ├── post-restart.mjs      重启 dsh web + 自动验证（见 README 末节「改过宿主之后」）
│   ├── e2e-ingest.mjs        端到端：发提示词 → 生成 → 落图 + 双落 + 跟焦
│   ├── fake-media-server.mjs 假 OpenAI 兼容服务（成功路径验证，自带 PNG 编码器）
│   ├── make-whale.mjs        从本机 DSH 产物抽鲸鱼尾巴（路径 d + 60 帧动图）并**逐帧填成实心**
│   ├── lib/whale-solid.mjs   实心化推导 + 手写 PNG / APNG 编解码（纯 Node，只用 zlib）
│   ├── preview-icon.mjs      把图标渲成 PNG（各尺寸 / 两套主题 / 入口按钮实景）
│   └── probe-*.js            GUI 探针表达式（设置页 / 外壳 / 输入框 / 菜单 / token）
├── src/
│   ├── index.ts              宿主半边（服务、设置 namespace、工具与命令在此落地）
│   ├── host/                 宿主实现：schema / 适配器 / 生成管线 / 工具 / 命令
│   └── client/
│       ├── index.tsx         客户端插件体：apply / inject / name
│       ├── ambient.d.ts      统一基座的本地类型声明
│       ├── state.ts          视图模式与画布宽度的外部 store + frame 打点
│       ├── menu.ts           菜单基础设施：键盘导航 / 关闭时机 / 夹进视口
│       ├── shortcut.ts       视图快捷键与 Esc 逃生梯
│       ├── styles.ts         样式表（全部取 DSH 设计 token）
│       ├── icons.tsx         鲸鱼尾巴（原生那条 d **填成实心** + APNG 遮罩，`whaleTailHtml()` + React 壳）+ 其余自绘 SVG
│       ├── generated/whale.ts 自动生成：原生那条路径的 d + 28×28 / 60 帧 APNG（`npm run art`）
│       ├── EntryButton.tsx   右上角鲸鱼尾巴入口（聊天 ⟷ 画布的双向开关）
│       ├── CanvasPanel.tsx   左侧画布面板（工具条 + 纯画布开关 + 宽度拖拽）
│       ├── settings/         设置页「图像 / 视频模型」
│       │   ├── MediaSettings.tsx  供应商 / 模型 / 密钥 / 探测 / 默认模型
│       │   ├── CommonModels.tsx   「常用模型」区：按家族一行（勾选 / 质量 / 其他参数）
│       │   ├── models.ts          模型目录与家族行（纯函数）+ 三个写入口
│       │   └── ModelPicker.tsx    composer 那格「生成模型」（含「常用」分区）
│       ├── toolview/         聊天侧 keyed 工具行（media_generate）
│       ├── shared/           宿主与客户端共用的契约（供应商目录 / 类型预置 / 媒体 meta）
│       └── canvas/
│           ├── model.ts      纯函数：视口数学 + 生成落位算法
│           ├── store.ts      节点表 / 视口 / 选择集 / 落图账本 + 持久化与坏数据防御
│           ├── ingest.ts     会话快照 → 画布动作（工具结果与命令结果两条入口）
│           ├── bridge.ts     订阅 ctx.sessions 的当前会话快照
│           ├── scope.ts      画布作用域策略：偏好 × 当前会话的工作区 → 读哪块画布
│           ├── follow.ts     新节点跟焦：几何 + 策略 + 待跟焦队列（纯函数为主）
│           ├── actions.ts    视图动作：fitAll / zoomToPercent / focusNodes
│           ├── regenerate.ts 「重新生成」：优先 /generate 命令，退回提示词
│           ├── CanvasStage.tsx  视口与交互层（平移 / 缩放 / 框选 / 快捷键 / 右键）
│           ├── NodeCard.tsx     节点卡片（图像 / 视频 / 生成中 / 失败 / 文字）
│           ├── NodeMenu.tsx     节点右键菜单
│           └── ZoomControls.tsx 缩放档位控件
└── tsconfig.json
```

## 命令

```sh
node build.mjs                     # 构建两个半边
npm run check                      # 构建 + typecheck + 无浏览器测试（215 画布 + 136 宿主 + 134 客户端 + 61 图标）

# 需要放宽沙箱（无头 Chrome 要创建命名管道）
npm run art                        # 从本机 DSH 产物里抽出原生鲸鱼尾巴（路径的 d + APNG）→ src/client/generated/whale.ts
npm run preview:icon               # 把鲸鱼尾巴图标渲成 lib/icon-preview.png（各尺寸 / 两套主题 / 入口按钮实景）
npm run e2e                        # 26 项画布交互
npm run e2e:p4                     # 56 项：工具条 / 纯画布 / 快捷键
npm run e2e:p5                     # 45 项：节点右键菜单 / 菜单键盘导航 / 作用域开关
npm run e2e:theme                  # 15 项：浅/深两套主题的对比度复查
npm run e2e:scope                  # 25 项：画布按工作区分隔（拆分 → 读数 → 切回去 → 刷新）
npm run e2e:entry                  # 46 项：入口（只有鲸鱼尾巴图形）在右上角不压 session log / 位置不变 / 双向单击 / 纯画布独立成顶栏 / 悬停摇尾巴
npm run e2e:settings               # 20 项：加第三方供应商 → 测连接 → 拉模型 → 模型级密钥（自起假服务）
npm run e2e:command                # 13 项：/generate 命令端到端
node scripts/e2e-ingest.mjs --expect-status failed   # 落图+跟焦端到端（无需任何密钥）

# 改过宿主半边之后（宿主模块不会热重载）
npm run restart:verify             # 重启 dsh web + 自动跑 e2e:settings / e2e:command
                                   # 报告写在 lib/post-restart-report.txt
```

`pnpm typecheck` 目前是**干净的**（`npm run check` 已把它纳入门禁）。

## 许可

MIT
