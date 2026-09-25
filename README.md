# dsh-cache-bricks

> ## 0.1.2 · GitHub 发布版
>
> 基于 **0.1.1 稳定版**发布。`stable` 与 `v0.1.1` 标签保留在冻结基线；0.1.2 沿用其砖契约、数据模型、渲染规则与配色。
> 本次只调整公开分发：预构建文件、安装说明、发布流程和精确的 DSH 版本限制。
>
> 代码自 `dsh-cache-badge` 1.7.2 起算（名字、包名与版本线是新开的），继承三个修复：
> **续聊不再吞掉历史砖**、**历史砖可导航**、**历史砖有类型**（会话日志回放，`src/core/replay.ts`）；
> 配色在 0.1.0.a 改过并进入本稳定版：**< 90% 黄、< 70% 红**。

**支持环境：仅 DSH `0.1.7-rc.2` 的 Web profile。**

One brick represents one real model request attempt. The front shows its prompt-cache hit rate; the reverse shows request activity. Click to inspect the attempt, or double-click to locate its conversation row.

## 截图 / Screenshots

以下两张图由 **0.1.2 构建产物**在 Chromium 中用合成请求渲染，演示 99% / 85% / 60% 三档缓存率；没有真实会话文字。

![缓存率棋盘：绿色、黄色和红色请求砖](docs/assets/cache-board-demo.png)

![翻面后的请求活动类型棋盘](docs/assets/activity-board-demo.png)

> **砖的契约已冻结：一块砖 = 一次真实执行过的模型请求 attempt。** 完整定义与扩展规则见
> [docs/brick-contract.md](docs/brick-contract.md)——以后加成本/TTFT/TPS/路由/子代理等，都只是给
> `BrickRecord` 加字段，**不许再改"什么才算一块砖"**。

DSH 插件：把**每一次真实模型请求**（attempt）变成一块砖——不是"每一步"：同一个 `(turn, step)` 因重试可以
有两次真实请求、两份计费、两种缓存结局，合并就把最该看的情况吞掉了。**唯一的例外是降级路径**：没有宿主半边时，
客户端只能从会话事件流按 step 折叠，那种砖是 step 级的、且不声称对应任何一行对话（见下）。砖落在对话窗口左侧的空白区，**自下而上叠成一列**，
颜色是这次请求的提示缓存健康度（**< 90% 黄、< 70% 红**，0.1.0.a 起）；**一轮任务做完，整叠左移一格**，下一轮继续掉砖。
**整块棋盘可以翻面**：正面是缓存读数，背面是同一张棋盘的另一层读法——每块砖**只用颜色**说明它在对话里
干了什么（灰=输出 · 紫=思考 · 青=工具 · **紫青双色=又思考又调工具** · 洋红=辅助调用），失败/重试/中断/超限
只做右上角的小角标，不占类型。**背面不印字**（靠颜色读，字放在悬停、无障碍标签和面板里）；
**正面印一位小数的读数**（1.7.2-b 起，移植自 1.7.1.c）：`99.9%` 这样五个字符，字号 12px —— 36×15 的砖去掉 1px 描边
还剩 34×13，等宽字体一个字符 0.55em，所以 `34 / (5 × 0.55) = 12.4px` 是宽度上限、13px 是高度上限，
**12px 是能放下的最大整数字号**（9px 是当年只印 `99%` 四个字符时的尺寸，多出来的三位像素是小数位换来的）。
正好 100% 印 `100%`（精确值不需要小数位，也省下第六个字符）；其余一律保留一位小数。
**点一下砖 = 直接读这次请求的对话**（默认落到「对话」Tab 并自动读取本砖对应的日志，8 个 Tab：
对话 / Overview / Request / Context / Stream / Tools / Retry / Raw），**主对话不动**——记录本来就在手上，
看一眼不该把页面拽走；**双击砖**（或按面板里的「在主对话中定位」）才去**定位原文**：先让官方
`loadThrough(seq)` 把那一行需要的史料加载进来（必要时往前补读到本轮开头），再滚到它、染强调色。
再点一下 `compare`，就能把两次真实请求逐字段对比。

**棋盘是一扇窗**（1.7.2-b 起，移植自 1.7.1.a）：框的大小不变，里面的内容可以上下左右平移。**左侧一条上下滑动条**
（看更高的砖：某一轮 step 太多、一屏叠不下），**底部一条左右滑动条**（看更早的轮次：轮次比窗口宽），
滑块位置就是你在历史里的位置，右端/下端＝最新。两条轨道是从边框里**让出来**的，不是盖在砖上——
没有任何一块砖会被滑块压住，也就没有一块砖的点击会被滑块吃掉。不碰滑动条时棋盘和以前**一模一样**
（最新一轮贴右边缘、地板在下、做完一轮整叠左移一格、虚线格子预告下一块砖）；一旦往回看，控制条会亮出
`⤓ 最新` 一键回到最新，左右/上方的**暗角**说明那个方向还有内容，顶部控制条上的按钮说明"回看中"，
砖上按方向键也能逐格走——走到窗口边上会自动平移过去。回看期间新轮次照常落进棋盘，但**不会把你正在看的
窗口推走**；回到最新（或一键回最新）才恢复跟随。

```
   ┌─┬────────────────────┐
   │∙│ 类型      ⤓ 最新    │  ← 控制条：翻面 / 回看时的一键回最新 / 估算提示
   │∙├────────────────────┤
   │∙│ 99%  43%  n/a  99% │
   │∙│ 97%  8.7% 99%  97% │  ∙ = 上下滑动条（在左边缘：外侧留白，不挤对话正文）
   │∙│ ↑ 再往上是同一轮更早看不到的砖
   ├─┴────────────────────┤
   │ ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬     │  ← 左右滑动条：▬ 滑块在最右 = 显示的是最新的轮次
   └──────────────────────┘
```

滑动条自己也是正经控件：可以拖（拖到尽头就是最早的轮次）、点轨道翻页、滚轮滚它（只在这 6px 上生效，
板面其余部分仍是 `pointer-events: none`，滚轮照旧滚对话正文）、`Tab` 聚焦后方向键/Home/End 也能走；
`role="scrollbar"` + `aria-valuenow/max` + 一句中文 `aria-valuetext`（"右侧还有 N 轮未显示"）。
装不下时它是惰性的：滑块满格、变暗、不进 Tab 顺序。

```
正面（缓存读数）                     背面（ACTIVITY，点左上角「类型」翻过来）

  ┌────┐┌────┐┌────┐                ┌────┐┌────┐┌────────┬─┐
  │ 99%││ 43%││n/a │                │灰  ││紫  ││  青    │紫│
  ├────┤├────┤├────┤                ├────┤├────┤├────────┼─┤
  │ 97%││8.7%││99% │                │青  ││青  ││  青    │紫│
  └────┘└────┘└────┘                └────┘└────┘└────────┴─┘
   旧 ←        → 新                   同一张棋盘，同一批位置
```

## 一块砖 = 一次 attempt，不是一步

这是整个设计的地基。DSH 同一个 `(turn, step)` **可能发生重试**：两次真实请求、两份 token 计费、
两种缓存结局。如果按 step 合并成一块砖，最值得排查的情况恰好会被吞掉：

```
99.4%  99.3%  0.0%[红]  0.1%[红]  99.2%
              └─ 第一次请求缓存炸了 → 失败 → 重试正常
```

所以：

- `llm/stream` 是**每一次** streaming 模型调用（含 retry、replay、routing）的 waterfall —— 我在这里拿**完整请求**；
- 但它的 payload **没有** turn/step/attemptId，而 attempt 身份只出现在 `agent/assistant-stream` 的 `start` frame 上；
- 两者靠**每会话 FIFO 配对**：谁先到都行，第二者到达时配对完成，于是重试自然成为同一 step 的第二块砖。

**归属（哪条记录算在哪块砖上）是一条明确的优先级链**，不是"谁最新算谁"：

| 记录 | 归属依据 |
|---|---|
| durable settlement（`assistant/message` / `assistant/attempt`） | ① **`seq`**——live `end` frame 已经报了它提交到哪个事件，seq 唯一，直接命中；② 没有 seq 时按 `(turn, step)` **FIFO**（日志按 attempt 启动顺序结算）；③ 都没有才退到"最新" |
| `llm/retry` | **retry ordinal**：`retry = n` 替换的是 ordinal `n-1` 那次 |
| `tool/call` / `tool/result` | **callId**（精确） |
| `compaction/start` | 挂到最近一个尚未认领的 `purpose='compaction'` 辅助调用上 |

一个名字对不上的 settlement 会被**丢弃**而不是塞给别人（少一份 usage 比穿错别人的 usage 好），并且有测试直接构造
"同一 step 两次 attempt 同时在飞"与"前一次没有被日志结算"两种交错。

## 每块砖里有什么

| Tab | 内容 |
|---|---|
| **Overview** | 缓存（命中率 / 读 / 未缓存 / 写入 / prompt 总量）、token（输出 / 推理）、耗时（**TTFT** / 总时长 / TPS）、路由（provider / model / reasoning effort / max output，**adapter 自动补的值会标注**）、结局（finish / 工具数 / 重试次数 / 是否 interrupted） |
| **Request** | `request/header` 事件序号与原因（`initial`/`resume`/`change`/`series`）、是否开新 series、header/system/tools/messages 各自的内容哈希、消息条数、**与上一次请求共享的前缀条数**、工具 schema 数（rc.2 起若声明表是**历史相对**的，会写成 `N (M declared +K in history)`，另有 deferred / tool updates / developer 消息三行） |
| **Context** | **派发那一刻**冻结的上下文：pressure / projected / window / 占用率 / surface / Δsurface；启发式构成（`≈` System / Tools / Messages，**明确标注为估算**）；TokenMeter 快照（baseline 类型与 token、surface nodes 数） |
| **Stream** | 由 durable 紧凑流展开的时间线：每个 delta run 一条（起点、由 `dt` 还原的**精确跨度**、fragment 数、字符数），usage / finish 各一条，附首 token / usage / finish 时刻 |
| **Tools** | 每次工具调用：名称、原始入参字符数与引用、调用与返回时刻、时长、错误码、结果引用 |
| **Retry / Errors** | 重试链（retryId / 第几次 / 上限 / 模式 / 延迟）、失败详情（code / status / providerRetryAfterMs / requestId）、结算状态 |
| **Raw** | 所有大对象的**内容引用**（可点开按需加载）+ 存储用量。不假装自己已经持有内容 |

命中率口径：DSH 的三个 prompt 桶是**互斥**的（`inputTokens` 是未缓存输入，cache read/write 各自单列），
所以 `promptTokens = input + cacheRead + cacheWrite`，`hitRatio = cacheRead / promptTokens`。

**诚实性规则**（贯穿砖面、面板与对比）：

- provider 从未报过任何 cache 字段 → 显示 `n/a`，**不会算成 0%**；
- 部分命中**永远不会**被四舍五入成 `100%`：打印精度内的取整一律向下 —— `99.95%` 印 `99.9%`，
  `8.75%` 印 `8.7%`（而不是 `8.8%`）；正好 100% 印 `100%`；
- 启发式估算处处带 `≈`，provider 锚定的数字不带。

## 大对象只存一份

第 274 次请求基本等于第 273 次加上几千 token。如果每块砖都存一份完整 messages，
一个缓存监控插件自己就会变成**巨型复制机**。所以：

```
砖（小字段：身份/路由/usage/指标/哈希/引用）
      │
      └─→ 内容寻址存储（blob-store）
          请求 · header · 流 · replay · TokenMeter 快照 · 工具入参/结果
          SHA-256 去重（同一内容只存一份）· LRU 淘汰 · 超限拒绝并上报
```

关键是**消息逐条存储**，而不是把整个 messages 数组按请求存一份：请求 274 与 273 只差几条消息，
按请求存就会每次复制一兆多——一个缓存监控插件自己变成复制机，正是要避免的荒谬。
实测数据支持这一点：修复前 6 次 42 万 token 的请求让存储涨到 10.2MB；修复后同一场景只增加
**2 条新消息 + 1 个引用列表 + 1 个信封**（有单测钉住这个算式）。

哈希同样**逐条记忆化**（键含结构指纹，长度变化必然重算），所以"与上次共享前缀 N 条"这个结论顺带就有了
——那正是判断"前缀从哪里断掉"的关键。Request Tab 里也会显示这次请求**新增存了几条消息**。

## 不改变模型请求

这是硬约束，也是三层保证：

1. **结构上**：唯一的接触点是 `llm/stream` 的 observer，它**原样返回 `next()`**
   （waterfall 里返回别的就等于替掉模型的流，不调用 `next()` 更是直接取消这次调用）。
   宿主产物里**没有任何 `@deepseek-ai/*` 运行时导入**，也不注册工具、不写提示词、不 append 日志。
2. **测试上**：用标记流断言返回的是**同一个对象**；断言 observation 自己抛异常时仍返回 `next()`；
   断言 deep-frozen 的请求被观察时不会写入（严格模式下赋值会抛）。
3. **落地上**：`pnpm run verify:host` 把**构建产物**装上假 ctx，回放一轮含重试的会话，
   再从它注册的路由把 feed 取回来核对；`pnpm run verify:live` 则对着**运行中的实例**核对真实流量
   （路由是否 200、砖块是否带 usage/请求引用/哈希/共享前缀/TTFT/context 快照、blob 能否按 ref 读回、
   未走过的 ref 是否老实报 404）。

顺带一个架构事实：读取发生在**适配器投影之前**，所以 Request Tab 展示的是 loop 推导出的请求
（文件/图片投影发生在这之后）。这条写在面板语义里，不装作是 wire 字节。

## 两个半边，生效方式不同

| 半边 | 内容 | 生效方式 |
|---|---|---|
| 宿主（Node） | 只读采集器 + 内容寻址存储 + `/cache-bricks` 路由与 SSE | **必须重启 `dsh web`**（`link:` 安装省掉重装，但换 JS 模块要新进程） |
| 客户端（浏览器） | 砖块棋盘 + **8** Tab 面板 + Diff | HMR 轮询产物，重建后自动热替换；必要时刷新页面 |

**两个数据源是合并的，不是二选一的**（1.7.2-a 修）：宿主采集器知道的是**本进程**观察到的 attempt
——它不知道进程启动之前发生过什么，也不知道 LRU 已经淘汰掉的会话；而 durable 会话日志知道**对话里**
的每一步，但只有 step 粒度、没有 attempt 身份。所以 `boardFromSources(feed, readings)` 按
**`(turn, step)`** 合并：**采集器有的 step 用采集器**（只有它带 attempt 身份、重试、请求/流/context 引用），
其余 step 用客户端的 per-step 折叠补齐。

这条修的是一个很具体的断层：以前只要 feed 非空就**整张换掉**折叠源，于是"打开旧对话（历史砖齐全）→
续聊一句（feed 里出现第一块新砖）→ 历史砖全部消失，棋盘只剩这一轮"。采集器**重启**（内存态，重启即清零）、
**中途启动**、或会话被 `MAX_SESSIONS` LRU 淘汰之后再续聊，都会触发。

合并后**精确性按砖标注**（不是按整张棋盘）：历史补齐的砖保留 `estimated: true` 与 `observedBy: 'client'`
的缩减记录，画成虚线、降低不透明度，无障碍标签写明"折叠自客户端，本采集器进程没有它的 attempt"；
采集器过来的砖照常是实心、可定位、可开完整记录。

**降级路径**：没有宿主半边（或旧版本）时，`/cache-bricks/*` 返回 404，客户端**回退到自己的 per-step 折叠**，
砖块照常显示，面板也能打开——只是记录是缩减版（`observedBy: 'client'`），没有请求哈希、流时间线与 context
快照，面板按字段说明而不是把空行当成测量值。采集器是增强，不是依赖。

**路由鉴权**：`/cache-bricks/*` 先走 **Harness 自己的请求策略**（`ctx.connection.requestRejection`，
与 `/api` 同一套 host/origin/browser-auth 检查）；该服务不存在时才退回到本机的 loopback + 同源兜底，
且**对端地址不可识别时一律拒绝**（`/blob` 能取完整请求、工具入参与流，不是普通 UI 路由）。

**实时推送的成本**：token 级 delta **不触发**推送（砖上没有任何字段会因此变化），其余事件合并到
最多 100ms 一次；长回答的 1500 个 chunk 不会变成 1500 次全量 feed。

## 定位：两次手势、一个加载器、几种明确结局

```text
单击  →  对话预览（自动读日志；需要时加载历史，主对话不滚动）
双击  →  关闭预览 → 定位并染色（面板「在主对话中定位」走同一条路径）
            └→ navigation.ensureBrickTargetLoaded(face, { seq, turn })
                   └→ ctx.sessions.binding(sessionId).session.loadThrough(seq)   ← 官方定点加载器
                          └→ 若本轮开头还不在窗口里，继续往前补读（上限 24 页）
```

`loadSeq` 取自这次 attempt **自己的结算事件 seq**，所以"要加载多少历史"由这次请求回答，不靠点几次
"加载更早"。历史上那套做法（点官方轮次导航器 + 连点 "load older"、最多 8 页、退而求其次落"就近行"）
**已经整段删除**：它点的是别人组件的状态机，落不到就只能假装成功。

每次定位只会有下面几种结局之一，面板会三行说清楚（`Transcript loaded` / `Chat projection` / `Reason`）：

| 结局 | 含义 |
|---|---|
| `exact` | 落到这块砖**自己**的行上，并已滚动、染色 |
| `step-other-half` | 本步骤在屏幕上，但**砖起始的那一半**没有渲染行，于是落到同一步骤的另一半——如实上报，**不染色** |
| `loaded-awaiting-render` | 窗口已覆盖、仍然没有那一行：**成因未定**（React 迟到提交、被视图关住的子树、过期目标，与"宿主没投影"从这里看一模一样） |
| `target-unavailable` | 对话里没有任何东西能代表它（`nothing-to-load` / `no-seq` / `no-loader` / `timeout`） |
| `host-projection-blocked` | 类型保留兼容，**不再自动报出**：仅凭"加载器确认覆盖了、却没有行"不足以断定是宿主故障 |

宿主那个故障本身是**真实且已复现**的：0.1.7 上 `system-message` 这个内建 Definition 会把自己
**已经物化过**的节点重新判成 `null`，assembler 因此抛错、整次 flush（也就是刚加载进来的那一页）
全部丢弃——**官方自己的轮次导航器同样跳不过去**（rc.2 已复测：Definition 与 assembler 守卫逐字节未变）。
但"少了一个 DOM 行"分不出这件事和"React 还没挂载"或"这半被视图关着"，所以插件只报可观测的事实，
不凭一次"没有"给宿主定罪；取证与复现见 [运行时契约记录](docs/runtime-contract.md)。历史上曾在本地验证过
一个宿主补丁，但补丁不随本仓库或插件包发布；第三方 Definition 无权替换内建的，宿主的问题归宿主。

**Transcript Tab** 是同一套能力的另一半：它按需读取 `ISession.eventSource` 的**连续事件窗口**
（`user/message` / `assistant/message` / `tool/call|result`），所以哪怕对话视图画不出来，它也能把
那一轮的**用户输入、助手正文、工具调用与结果**原文摊开。**全程不滚动主对话。**

## 安装

仅支持 **DSH `0.1.7-rc.2` Web profile**。从 GitHub 安装已构建的 `0.1.2`：

```sh
dsh plugin --profile web add github:3289192-bot/dsh-cache-bricks#v0.1.2
```

卸载：

```sh
dsh plugin --profile web remove dsh-cache-bricks
```

若曾在同一 profile 安装旧包 `dsh-cache-badge`，先卸载旧包，避免两套棋盘同时显示。
仓库随源码包含已构建的 `lib/`，GitHub 安装无需执行构建脚本。也可从 [v0.1.2 Release](https://github.com/3289192-bot/dsh-cache-bricks/releases/tag/v0.1.2) 下载 tarball 安装。

## 数据与权限

插件在 DSH 进程内存中保存请求、流与工具事件的观测记录，并通过受保护的本机路由提供给界面；插件自身不把这些记录写入磁盘，也没有第三方上传或分析端点。请求和工具内容可能含隐私信息，请只在自己信任的 DSH 环境中安装。

## 开发

```sh
pnpm install
pnpm run typecheck        # tsc --noEmit
pnpm run test             # vitest：21 个文件，含构建产物测试
pnpm run build            # rimraf lib && tsc -p tsconfig.build.json && tsdown
pnpm run check:contracts  # 比对两个 runtime 的客户端契约
pnpm run verify:host      # 构建产物级端到端：装到假 ctx，回放一轮，经路由取回 feed
pnpm run verify:live      # 对着运行中的实例核对真实流量（--port/--home 可指定另一个实例）
pnpm run verify:ui        # 真浏览器：翻面 + 点砖跳转（需要 playwright-core，缺了会自动跳过）
pnpm run bench            # 用一条真实请求实测采集开销（冷启动 / 普通一步）
#   验证记录（含真实数字）见 docs/verification.md
```

| 目录 | 内容 |
|---|---|
| `src/shared/` | 纯逻辑：记录模型、派生指标、Diff、SHA-256、流时间线 |
| `src/host/` | 采集器、内容寻址存储、运行时事件到 observation 的映射、HTTP 路由 |
| `src/client/` | 棋盘（几何 + 双层 DOM 覆盖层 + 翻面）、砖源映射与类型判定、8 Tab 面板、feed 客户端 |
| `docs/brick-contract.md` | **冻结的砖契约**（砖是什么、身份/记录/目标三层、扩展规则） |
| `docs/runtime-contract.md` | **本插件依赖的每一条官方事实及其 file:line 证据**（改代码前先读它） |
| `docs/verification.md` | 五层验证的现场记录与数字（单测/产物/实时采集/实时面板/真浏览器） |

### 测试分层

1. `logic` / `metrics` / `sha256` / `stream-timeline` —— 口径、派生指标、哈希（对上 FIPS 向量）、时间线展开。
2. `blob-store` / `brick-ledger` / `observe` —— 去重与淘汰、attempt 折叠（含重试成对）、事件映射。
3. `collect` / `routes` —— **只读性**（标记流 + 抛异常的观测 + 冻结请求）与路由守卫（非本机 403、跨源 403、405）。
4. `diff` / `bricks` / `tetris` / `panel` —— 归因措辞、两路砖源映射、**类型判定优先级与九色唯一性**、
   翻面状态与文案、面板 SSR（含 `≈` 标注、类型徽章与失败重试展示）。
   `board-scroll` 专测**窗口**：平移 0 时与 1.7.1 逐格等价（直接对 `visibleColumns` 断言，不是抄一遍算术）、
   夹取、车道让行、轨道滑块的像素几何，以及"窗口外的砖一块都不许画"。
5. `client-bundle` / `manifest` —— 真跑 `lib/client.js`：模块请求白名单、hidden 节点、座位不渲染内容、
   宿主产物无 DSH 导入、无工具/提示词/日志写入。
6. `panel-live` —— **对着运行中的实例闭环**：从 HTTP 取一块真实砖，用真实组件渲染 8 个 Tab 并核对
   真实数字（哈希、TTFT、派发期 context、工具调用），再与上一块砖做 Diff 打印一句结论。
   实例不在线时自动跳过，所以离线也能跑全量测试（`DSH_LIVE_PORT` 可指向另一个实例）。
7. `scripts/ui-verify.mjs` —— **真浏览器**：棋盘是 React 之外的 DOM 覆盖层、两面是 CSS 3D 翻面、
   "点砖跳转"要动真实布局，这三件事只有真浏览器能证明。`--rails` 只跑棋盘自己的检查
   （轨道"让位"、滑块像素与 `aria-valuenow` 一致、拖拽真的换页、一键回最新），**不导航对话**。
8. `scripts/test-scroll.mjs`（`pnpm run test:scroll`）—— **真浏览器 + 真 React 18 + 真构建产物**，
   DSH 服务与采集流是 fixture：43 项检查覆盖拖拽/滚轮/键盘/边界夹取/跟随语义（直播时新轮次不掉队、
   回看时窗口不被推走）/翻面镜像/SYS 车道钉住不动，并顺手出图。

### 跨两代 core（现为三代：0.1.6-alpha.1 / 0.1.7-rc.1 / 0.1.7-rc.2）

`pnpm run check:contracts` 逐成员比对 0.1.6-alpha.1 与 0.1.7-rc.2 的客户端契约，结论一致；
采集器用到的 surface（`llm/stream`、`agent/assistant-stream`、`session/event`、`llm/retry`、`tokenMeter`、
`sessionProjections`、`webServer`、`request/header`、`tool/call`）三代都在，且 `AssistantStreamFrame`
联合体**逐字段相同**，所以一套代码同时服务这些实例。宿主半边只讲结构化类型，这条才可测。

rc.1→rc.2 的接口复核（逐文件字节级 diff + 编译产物 grep，取证在
[`docs/runtime-contract.md`](docs/runtime-contract.md)）只发现两处变化，都已进代码：

1. **工具声明表变成历史相对**（rc.2 新启用 `toolHistory` / `ToolUpdate` / `deferLoading`）：`llm/stream`
   观测到的 `tools` 是历史起点的那一份，后续 `developer/message` 的 `tool-addition` 由适配器在
   **waterfall 之后**才折进去。所以 `toolsHash` 改为覆盖**有效声明集**（基础 + 历史新增）——
   否则"中途加了个工具"会被读成 tools 没变。没有新增时哈希与旧版逐字节一致。
2. **客户端实时事件名是 `assistant/live-chunk`**（`assistant/chunk` 只存在于会话格式迁移包里）：
   降级折叠原先监听的是后者，等于从不接收流式 usage。现在两个名字都收，且**只把整数 seq 记为日志位**
   ——瞬态行的 seq 是 `durableCursor + 1 - 1/(k+1)` 这样的排序用小数，交给 `loadThrough()` 会问日志要一个不存在的位点。

## 已知边界

- **TTFT 含适配器准备时间**：起点是 dispatch 观测（`start` frame 边界，官方该 frame 无时间戳），
  终点是首个 token chunk。适配器在真正 fetch 之前还要做凭据/文件/图片准备，所以这个数字略大于
  "wire 发出到首 token"。面板与文档都按这个口径说明。
- **读取发生在适配器投影之前**（见上）：文件/图片投影与 rc.2 的工具声明投影都发生在这之后，
  所以 Request Tab 展示的是 loop 推导出的请求，不是 wire 字节。
- **存储在内存里**：进程重启后采集层清零（durable 历史仍在 session log 里）；LRU 与容量上限保证不会无限增长。
- **历史砖的宽度 = 客户端手上那段会话日志的宽度**：回放读的是浏览器已经持有的 durable 事件窗口，
  所以能补到多远取决于它加载了多少轮。**导航与类型不受这条限制**：回放砖带自己的结算 seq 与
  attempt 身份，跳转直接走官方 `loadThrough(seq)`；只有连日志都没覆盖到的 step 才退化成 per-step
  折叠砖（虚线 + `~` + `historical-step`，跳转时现场解析）。要"旧砖也带请求原文与 context 快照"
  则需要宿主半边回放（那部分日志里确实没有），不在这一版里。
- **辅助调用**（`purpose: 'compaction' | 'session-title'`）会产生砖，但它们不属于任何 turn：身份记为
  `turn 0`，**不进正常 attempt 的配对队列**，也不占棋盘列（面板仍可打开它们的记录）。它们的 chunk 由
  一个**原样转发**的流包装观察（辅助调用不产生 `agent/assistant-stream` 帧）。
- 棋盘依赖对话 DOM 锚点（`[data-conversation-scroll]` / `[data-chat-turn]`），空白区不足 2 列 x 3 行时整体隐藏。
- **能否落到"还没加载的旧轮"取决于宿主**：0.1.7-rc.1 / rc.2 的 `system-message` Definition 会在 prepend 重建时
  撤回已物化节点，让整页加载结果被 assembler 丢掉（`docs/runtime-contract.md` 有 file:line 取证与复现步骤）。
  插件侧不做任何 monkey-patch，只如实报告可观测的加载与渲染状态；历史本地宿主补丁验证曾测得**加载+落点 0.5 秒、exact**
  （rc.2 上复测：`[2,3] → [1,2,3]`、turn 1 画出 18 行、`jump: exact`）。
- 砖面只放数值与颜色：详情、时间线、工具、Diff 都在点击之后。
- **滑动只吃自己那 6px**：滚轮与拖拽在轨道条带上生效，板面其余部分仍是 `pointer-events: none`——
  滚轮照旧滚对话正文，砖只吃单击/双击。
- **平移是整格的**：单位是一块砖（36×15 + 3px 缝），滑块永远停在格子上，不会卡在两块砖中间。
- **辅助调用（SYS 车道）钉在窗口顶行**：它不属于任何一轮，也就不在时间轴上占位置，横向平移时不动；
  车道出现时列可用行少一行（与 1.7.1 相同）。
- **跟随的唯一定义变了**：正在跑的那一轮比窗口还高时，窗口抬到"最新那块砖可见"（1.7.1 会把最新砖切在
  屏外），此时地板可能不在屏上；这一轮一结束，窗口回到地板。其余情况与 1.7.1 逐像素一致。
- **回看时窗口锚定内容**：新轮次照常落进棋盘，但不会把你正在看的那几列推走；滚回（或一键回）最新才恢复跟随。
- 背面那层砖只在你翻过去时才建（`buildTypeLayer`），**从不翻面的棋盘不会为第二份 DOM 付账**；翻过去之后
  它跟着直播更新，新砖在背面照常掉进来。

**砖的正反两面（一次撤回的记录 + 一次改向）**：正面只有**一层**视觉——填充=缓存命中率（绿 ≥ 90%、黄 70–90%、红 < 70%，
未上报=灰），外框取同一色调作细描边。曾经实现过一套"四边编码内容通道"的语法（上=reasoning 紫、
下=tool-call 青、右=输出冰白、左=输入变化蓝、外圈=retry/失败、整圈=compaction 洋红），**实测后撤回**：

> 这套 harness 里几乎每一步都同时有 reasoning、工具调用和文本，于是**每块砖都是"富"的**，
> 颜色不再区分任何东西，屏幕反而变吵。**在"大多数砖都相同"的分布里，给共同特征上色等于没上色。**

通道数据仍在计算（`contentOf` / `brickEdges` / `CHANNEL`，并有测试断言这套色板与缓存色板不相交），
只是改为写进**悬停摘要**：

```
turn 26 · step 8 · 工具 tool call, no reasoning · cache 99.9% · ttft 1.99s · tool-calls · tools + text
```

**同一份教训又教训了背面两次。** 第一次是交互：最初的做法是"每块砖 hover 时翻面"，很快改成**整块棋盘翻面**——
背面回答的是关于**整个会话**的问题（"这轮任务是由什么构成的"），一次手势全换才看得见分布，也就没有
"四十块砖各自翻各自的"那种噪声。第二次是分类粒度：第一版背面分了 9 类，结果实测下来**几乎整面都是"工具"**
（202/211 块砖调过工具），等于又造了一面彩虹墙。

所以背面**上限定死在 4 + 1**，而且**砖上一律不印字**（36×15 靠颜色读；字放在悬停摘要、`aria-label`
和面板头部那枚芯片里，那里有地方写字）：

| 类型 | 砖面 | **官方 lane**（配色） | 什么时候 |
|---|---|---|---|
| reasoning | 纯色 | **Model 紫** | 有 reasoning，没调工具 |
| output | 纯色 | **Model 紫** | text / image / file —— 普通可见产出 |
| tool | 纯色 | **Tool 橙** | 调了工具，没有 reasoning |
| **mixed** | 左右切分 | **紫/橙按比例** | 又思考又调工具（建模 + 用工具） |
| auxiliary | 纯色 | **System 灰** | `compaction` / `session-title`，不属于任何 turn |

**砖面不印字，颜色就是读数。** lane 名（`MODEL`/`TOOL`/`SYS`）、更细的类型（思考/答复/工具）、以及"具体是什么"
（工具名 / 模型名 / 用途）都写在**悬停摘要、无障碍标签和面板**里——那里有地方写字：
`turn 18 · step 3 · TOOL 工具 tool call, no reasoning · bash · cache 99.9% · …`。

**配色不是自己挑的，是复用官方轨迹的 token**（`--dsw-alias-*`），所以：

- 色相 = **官方 lane**（Input 蓝 / Model 紫 / Tool 橙 / Context 绿 / System 灰），读者在"轨迹"页已经建立了
  这套肌肉记忆；`input` / `context` 两个 lane 也照样定义好，只是**没有任何请求会落进去**（砖是派发出去的模型
  调用，不是用户输入也不是注入），并有测试钉住这一点；
- 因为读的是 token 而不是解析后的色值，**DSH 切深色/浅色主题时砖会跟着变**，官方改设计系统色值也自动跟；
- 常态是"官方色按 50% 混入页底"的沉稳版，**指针悬停/打开记录的那一块回到纯官方色**（实测证明中间那一档就是
  `rgb(221,134,41)` = `--dsw-alias-state-warn-label`）。

**类型面的外观就是官方 span 本身**，不是另一套自己发明的材质：扁平填充（无高光、无内阴影、无投影）、
**1px 圆角**、官方的 lane 透明度（背景 lane `.78`，model/tool `1`），以及官方的 **model lane TTFT 横向渐变**——
一块模型砖的左侧 `ttftMs / durationMs` 那一段用"等待色"（官方 = 解码色 54% 混入 `--dsw-alias-bg-layer-2`），
其余用解码色。实测官方 `.span` 就是 `height: 8px; border-radius: 1px; opacity: .78`，没有边框也没有阴影。

（历史：这一面先后试过"高光 + 内阴影斜面"（两百块砖变塑料按钮，撤）和"自推导材质"（比官方多一层，
也撤）。现在的规则是：**外观照抄官方 span，只有承载信息的差异才自己加**——TTFT 渐变是官方本来就有的。）

**缝的方向是固定的：左右。** 左 = 模型（紫，其**左端那一段是等首 token 的时间**，官方让它退向背景），
右 = 工具（橙）。砖**永远不会上下分层**——单色面为了排两行文字会临时设成纵向，而 running 的砖会从"只有思考"
变成"又思考又调工具"，所以每次重绘都会显式把方向写回 `row`（曾经漏掉这一步，就出现了上下分层的砖；
`verify:ui` 现在有一条断言盯着它）。

**正面（缓存面）保持插件自己的材质**：半透明色调填充 + 略强的同色描边 + 上沿发丝线，那是这块棋盘"阅读缓存"
的语汇，不与官方冲突。

**为什么不直接整面用官方原色**：一面墙上有一两百块砖，官方那套是给"一行时间轴"当扫描色用的，整面铺开就是
电竞灯板。所以常态把官方色混入页底（`color-mix`），只有被读到的那一块回到原色——观感上仍然是同一套色相，
主题跟随也仍然成立。聚焦/选中的亮度（`brightness(1.45)` / `1.18`）两面都生效。

**状态永远不抢类型的颜色**（这是硬规则）：失败是**红边 + `!`**，重试是 `↻`，中断 `⏹`，超限 `⌁`。
一块失败的工具砖仍然是**橙色的工具砖**，只是多了一圈红边——"它是工具调用，而且失败了"，而不是"它是一个失败"。

**MIXED 不发明第三个颜色，而是把砖按实际比例切成紫/青两段**（`reasoningShare`：以"一次工具调用 ≈ 120
字符推理"折算，属启发式，只移动那道缝、不生产任何被当作实测的数字，且左右各留至少 5px 保证两种颜色都看得见）。
给它一个橙色，就得让读者额外记住"橙=紫+青"；双色砖自己会说话：

```
思考很多 + 一次工具          一次工具 + 一点思考
┌──────────────┬──┐        ┌──┬──────────────┐
│      紫      │青│        │紫│      青      │
└──────────────┴──┘        └──┴──────────────┘
```

**失败 / 重试 / 中断 / 超限不是类型，是角标**（`↻` 重试、`!` 失败、`■` 中断、`⌁` 超限），画在砖的右上角，
**两面都画**：生命周期是另一个问题，所以它用一个字形而不是一种颜色——一次失败的工具调用仍然是工具调用，
不该因此变成第六种砖。悬停摘要会把角标拼出来（`· ! failed`）。

翻面手势有三个入口：棋盘左上角的**「类型」小控件**（翻过去后它变成「缓存」，位置不变），
**聚焦任一砖后按 F**，以及触屏/键盘用户走**面板头部那枚类型徽章**——不必翻面也能读到当前这块砖的类型
（mixed 在面板里是「思考」「工具」两枚相邻的芯片，就是同一道缝）。

**输入类事件不做类型砖。** `request/header`、context、system prompt 是"进入这次请求的东西"，不是这次
attempt 做出来的东西，所以它们只出现在悬停摘要与面板里，不占一个类型——否则棋盘就得覆盖官方那 59 种
会话事件，退化成需要先背图例的图表。

安静的步骤不会罗列它没做过的事。若将来重新上色，应该只标**稀有**通道（写操作、失败），而不是每块砖都有的形状。

**点一块砖 = 跳到**这次请求自己的那一行** + 打开它的记录**。这里有两个此前的根本错误，都已修掉：

**① 砖的身份 ≠ 它在对话里的位置（`砖:行` 不是 1:1，`砖:target` 才是）。** 砖是 **attempt** 级（缓存本来就是 request 级数据），而官方 Chat 视图的行是
**step** 级，且重试时官方会 `resetForRetry` **复用同一个 `assistant-step` 节点**（`client.js:7338`）——所以
"一块砖 = 一行对话"在重试时根本不存在。映射是 **N:1**，现在写成显式的 `BrickTarget`（`src/client/target.ts`），
不再在用到的地方临时拼锚点：

**原则一句话：`砖 : 对话行` 不要求 1:1；`砖 : 导航目标` 要求 1:1。** 所以"exact"的定义是
**命中了这块砖声明的 target**，不是"它独占了一行"——重试的两个 attempt 共享 retry 行，两者都 exact。

| 砖是什么 | target | 落到哪一行 |
|---|---|---|
| 属于一条重试链（失败那次 + 重试那次） | `retry-chain` | 官方 `model-retry{retryId}`——**只有这一行把这对 attempt 放在一起**（N:1） |
| 产出过 assistant 内容 | `assistant-step` + `part` | 该 step 节点的**它开始时所在的那一半**：想过 → `reasoning`，只答 → `response`（**没有 reasoning 半的 attempt 不会去猜那一半**） |
| 没产出 assistant 内容（只调工具） | `tool-call` | **它自己第一个** tool call 的行 |
| compaction 辅助调用 | `compaction` | `compaction{compactionId}`——**不是 seq**：官方那张表锚在它自己的 checkpoint seq 上，与这次辅助调用的 settlement 是两个事件 |
| session-title 辅助调用 | `none`（`session-title`） | **不跳**：它根本不进对话流，如实声明不可达 |
| 折叠砖（无宿主半边 / 采集器重启前的历史，按 step 折叠） | `historical-step` | **等到那一步的行上**：先 `loadThrough(loadSeq)`，再按 durable log 现场判定这一步是什么（`assistant-step` / `tool-call` / `retry-chain`），落到它实际成为的那一行；log 里没有具体行时落到**轮首**并如实报 `context`——**绝不落到邻近的 step** |

判定用**内容**而不是"是否提交了 message"：实测有一块砖 `settlement=message` 但 reasoning/text 都是 0，
官方视图里根本没有它的 `assistant-step` 行，而它自己的 tool-call 行在——这条是缺陷修完才对的（有测试钉住）。

**历史不是"较差的砖"，只是以前读得差**（1.7.2-c）：旧会话的砖现在由**会话自己的日志回放**而来——
和实时采集**同一套 observation、同一个 fold**（`src/core/`，两半共用）。日志里本来就有的都会还原：
usage 与缓存三桶、reasoning/text/tool 计数（因此**类型面是真的**）、工具 callId 与参数、retry 链与
attempt 序号、结算事件序号（因此**双击能落到那一次 attempt 的行上**）。日志里从来没有的才留空并说明：
出站请求原文与 message 哈希、派发时刻的 context 快照、provider 原始请求、以及 dispatch 时刻本身
（所以回放砖的 TTFT 以 `step/start` 为起点）。面板上的来源芯片写三种：`host feed` / `log replay` /
`client fold`，砖面也分三种画法：实心（live）、**略淡的实心（回放，因为它背后没有请求捕获）**、
虚线 + `~`（只有连 session face 都拿不到时才会出现的那种 per-step 折叠）。

**折叠砖也走同一条路，只是精度不同**（1.7.2-a 修）：`historical-step` 在**跳转时**用同一份 durable log
现场解析——重试优先（只有那条链把两个 attempt 放在一起）、其次 message 自己那一半、再次第一个 tool call、
都没有就落到轮首报 `context`。判定规则与 `targetOf()` 故意写成一致的两份，否则两条路会对同一个 step 给出
不同答案。它**不会**因此变成精确砖：砖面仍是虚线 + `≈`，落地提示写"历史折叠砖：step 级，不含 attempt"。
换句话说，"没有 attempt 身份"从来不该等于"不能导航"——它只该等于"不能声称是哪一次 attempt"。

**② 跳转结果分三级，而且只有 exact 才算成功。** 以前是布尔 `revealed`，于是"落在附近某一行"也报成功、
也染蓝、控制台也说"jumped"——这就是它反复改都感觉不对的原因。

| accuracy | 含义 | UI |
|---|---|---|
| `exact` | 落在**这块砖自己**的行上（上表四种之一） | 滚动 + 淡蓝高亮 + 行上打 `data-cache-bricks-landed="<row>"` |
| `context` | 只到轮首（某块砖的行确实没渲染出来） | 可以滚，但**绝不染色**，面板与控制台如实说明"只到轮，不是这一请求" |
| `none` | 什么都没找到 | **不移动**，只打开记录并说明 |

`nearest`（"最近的前一步"）**已删除**：向后跳会展示比这块砖更晚的内容，向前跳会把别人的行标成它的。删掉之后
验收立刻变得诚实——`ui-verify` 现在做了两件事：对**全部已结算砖**做一次可定位性普查（每块砖至少要有**属于它自己**
的行），再抽样点击要求 `exact`；达不到就红。

**加载 ≠ 落地。** 官方确实有 `loadThrough(seq)`，但它是 `ChatViewSlotProps` 成员，而插件能坐的座位
（`conversation.composer.dock` 是空 props、`conversation.chat.node` 只给 `entryKey/hookContext/fallback`）
都拿不到它（证据见 `docs/runtime-contract.md`）。所以加载只能走官方轮次导航器的按钮与 "load older" 控件——
**它们只是过程**：加载完必须重新找到 exact 行，找不到就是 `none`。

折叠的过程组用两条官方通道打开：轮自己的 `button[data-turn-process]`（点它，走 React 状态），以及官方给
`hidden="until-found"` 注册的 `beforematch` 事件（发事件，而不是 `removeAttribute('hidden')` 去和 React 打架）。

真机验证：`pnpm run verify:ui` 用 Playwright 打开运行中的实例，普查 + 抽样点击，全部要求 exact。

**键盘可达**：每块砖是可聚焦的 `role="button"`（`aria-label` 含 turn/step/类型/缓存读数），**Enter / 空格**打开记录并跳转，
**方向键**按棋盘的读法移动焦点（左右=同一 step 的相邻轮次，上下=同一轮的相邻 step），**F** 把整块棋盘翻面。
翻面时键盘焦点会跟着过到同名的另一面砖上，隐藏的那一面设了 `aria-hidden` 与 `tabIndex=-1`——藏在卡片背后的砖不该还能被 Tab 到。

**焦点与选中都用亮度表示，不画框**（聚焦 `brightness(1.45)`，选中 `brightness(1.18)`）。曾经用过描边：
问题在于浏览器**一点击就会给可聚焦元素加焦点框**，于是整个空白栏看起来像被选中了，而 36×15 的砖上框是最响的视觉元素。
跳转的落点提示同样从"2px 蓝框"改成**淡蓝晕染**（`rgba(56,189,248,.10)` 背景、260ms 渐入、1.1s 后复原）。
