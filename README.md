# Cache Bricks Lite（可选精简版）

> 本页介绍可选的 Lite 分支。**默认推荐 [Cache Bricks 完整版](https://github.com/3289192-bot/dsh-cache-bricks#readme)**，提供请求详情、对话定位、对比和活动翻面。
>
> Lite 适合只需要缓存棋盘的用户。[下载入口位于完整版发布页面底部](https://github.com/3289192-bot/dsh-cache-bricks/releases/tag/v0.1.4)。两个版本均限定 DSH `0.1.7-rc.2` Web profile。

> **一句话产品定义：一次真实模型请求结束 → 落一块砖；砖的颜色只表示这次请求的 prompt cache 命中情况。**
>
> One settled real model request is one brick, and a brick's colour is one thing: how much of that
> request's prompt came out of the cache.

这就是全部。这是一个**极低开销的 prompt-cache 可视化**：观察 → 算命中率 → 落砖。它不是 DSH
调试器，不是会话浏览器，不是请求审计库。

## 它长什么样

砖落在对话窗口左侧的空白区，**一轮任务一列**，砖从地板往上叠，最新一轮贴右边缘；一轮做完整叠左移一格，
下一轮就掉进让出来的那一格——所以它读起来像俄罗斯方块，而它其实是**缓存心电图**：

```
      ┌──────────────────────┐
      │ 99.0%          ⤓ 最新│  ← 回看时才出现的"回到最新"
      │ 12.3%  99.9%  ┄┄┄┄┄┄ │  ← 虚线格：正在跑的这一轮，下一块砖落这里
      │ n/a    99.9%  99.9%  │  ← 灰：provider 没给 cache 字段，不做判断
      ├──────────────────────┤  ← 地板线
      │▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬ │  ← 横向滑条：一列 = 一轮，往左拖看更早的
      └──────────────────────┘
       第 3 轮  第 4 轮  第 5 轮
```

**美术与动画沿用 0.1.3**，一整套：

- 砖是**安静的平板**：绿 18% 填充 + 75% 字色 + 28% 描边，顶上一条 `inset 0 1px 0` 高光；红色才用实心
  `#dc2626` 加粗——一面墙的绿砖不该抢眼，抢眼的应该是那块红的；
- 数字是 **12px tabular monospace**，只印五位（`99.9%`），**向下取整**；
- 落砖用 `bottom 420ms cubic-bezier(.45,.02,.95,.55)`（重力），一轮结束整叠左移用 `right 260ms ease-out`；
- **两把滑条**：下面一把横向（一列 = 一轮），左边一把纵向（一行 = 一块砖），滑块锚在"最新"那一端；
  拖滑块、点轨道翻页、滚轮只在滑条上生效（别处滚轮照常滚对话）、双击回最新、方向键/Home/End 都能用；
- **暗角**说明哪个方向还有内容，**`⤓ 最新`** 只在回看时出现（不是变灰，是不存在）；
- **正在跑的一轮**脚下有虚线落砖格，回看时不画（那是过去，不该假装还有砖要落）；
- 拖拽时砖的动画全部关掉（平移不该像橡皮筋），`prefers-reduced-motion` 下永久关掉。

- **绿**（`≥ 90%` 命中）：这次 prompt 的缓存被复用了。
- **琥珀**（`70%–90%`）：**有一成的前缀被重新计费了**——不健康，但也不到报警的程度。
- **红**（`< 70%`）：这次 prompt 大部分重新计费了。
- **灰**：provider 没报 cache 字段（`n/a`），或者 prompt 小于 1000 token——太小的调用不是缓存信号，
  涂红只会把噪声放到信号该在的地方。

砖上印一位小数（`99.9%`），**永远向下取整**：`0.9999` 印 `99.9%`，只有全部命中才印 `100%`。
缓存读数往上取整就是说谎，而且是在最要命的方向上说谎。

## 一次真实请求 = 一块砖（而不是一步）

同一个 `(turn, step)` 因为重试可以有**两次真实请求**、两份计费、两种缓存结局。合并它们就会把最该看的
情况吞掉，所以：

- 一块砖 = 一次 **attempt**；重试是**另一块砖**，就叠在它替换掉的那块上面；
- **请求进行中不落砖**：等 settlement 带来真正计费的 usage 再落，一次落定——不猜、不闪、不先画一个待更新的数；
- 失败的 attempt（传输错误、被重试替换掉的那次）也落砖：它没有 cache 字段，所以是**灰的**，不是红的
  ——没人测量过一次 miss，就不能报一次 miss。

## 它不做什么

这些不是"还没做"，是**这一版的定义**（完整理由见 [docs/cache-brick-contract.md](docs/cache-brick-contract.md)）：

- 不保存 prompt、消息、system prompt；
- 不保存工具调用、工具 schema、工具结果；
- 不保存 request body、header、hash、context 快照；
- 不保存 stream、reasoning 计数、TTFT、TPS、时间线；
- 不做类型砖、不做正反面、不做 Inspector、不做双击定位、不做 request diff；
- 不做历史 catalog、不建索引、**不落盘**（唯一读历史的地方是上面那一次日志读取，只为把砖填进内存环）。

内存里只有一个**环形缓冲**（默认 1024 块砖），满了就丢最老的，并且**把丢了多少块写在棋盘上**——
免得一段只剩尾巴的运行看起来像刚开的会话。刷新页面就是新的一圈。这是实时读数，不是审计日志。

## 开销

| | 0.1.3（full） | 0.1.4（lite） |
|---|---|---|
| client bundle | 125,235 B | **21.7 kB**（6.1×，含两把滑条、暗角与全部动画） |
| host half | 78,049 B | **30.9 kB**（2.5×） |
| 每个 token delta 的工作 | 观察 + 折叠 | **零**（delta 连读都不读） |
| 每块砖存的东西 | request/tools/stream/refs | 11 个字段 |
| 每次推送的报文 | 222 kB | **47 kB**（4.7×） |
| 每次请求的插件开销 | 0.256 ms | **0.093 ms**（4.7×） |

## 安装

```sh
dsh plugin --profile web add github:3289192-bot/dsh-cache-bricks#v0.1.4-lite
```

支持环境：**DSH `0.1.7-rc.2` 的 Web profile**。宿主半边负责观察（浏览器看不到模型调用），
浏览器半边只负责画。

## 验证

```
pnpm run typecheck        # 干净
pnpm test                 # 94 个单测
pnpm run test:board       # 47 项浏览器 fixture（真实布局、真实颜色像素、真实拖拽）
pnpm run verify:host      # 构建产物的宿主半边检查
pnpm run verify:live      # 对运行中的实例：真实请求 → 真实砖
node scripts/benchmark-overhead.mjs   # 与 0.1.3 / 0.1.4 full-scene 的开销对比
```

数字与证据记录在 [docs/verification.md](docs/verification.md)；与 0.1.3、0.1.4 full/scene 的性能对比
（含方法与注意事项）在 [docs/0.1.4-performance.md](docs/0.1.4-performance.md)；依赖的 runtime 事实
（三条 tap、settlement 的 usage、seat 契约）在 [docs/runtime-contract.md](docs/runtime-contract.md)。

## 版本线

- **`lite`（本分支）= `0.1.4-lite`（已冻结，标记 `v0.1.4-lite`）**：这条线就是上面那句话，`main` 将跟随它。
- **`release/0.1.4`（full/scene）**：0.1.3 线上继续做的数据层虚拟化（场景重放、历史分页），
  功能更全但更重；它保留在分支与 tarball 里，不影响这条线。
- **`codex/session-workbench`（`0.2.1-frozen`）**：完整诊断实验（catalog、独立工作台），已冻结归档。
