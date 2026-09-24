# 砖块交互修补：1.7.1-clickfix.1

## 使用后的操作

| 操作 | 结果 |
|---|---|
| 单击砖块 | 约 300 ms 的单双击判别后，直接打开「对话」预览，并自动读取本砖块对应的日志内容；不再默认显示 Overview，也不再要求再点一次读取。 |
| 双击砖块 | 取消待执行的单击，关闭预览，展开目标的折叠层，在主对话中滚动到该步骤/调用自己的行。 |
| 定位成功 | 滚动稳定后显示主题强调色底和左侧细色条，保留约 6 秒；新选择或插件卸载立即清理。 |
| 键盘 | Enter / 空格预览，Shift+Enter 定位，Esc 在预览内关闭。 |
| 预览中的「在主对话中定位」 | 与双击使用同一条路径。 |
| 找不到真实目标行 | 显示可见的失败提示，不把同轮开头或邻近步骤涂成成功。 |

单击读取缺失日志时，宿主的事件窗口可能扩大；本插件不会为预览主动调用滚动或展开动作。真实宿主在 prepend 过程中的视口保持行为仍需在使用者实例检查。

## 修到的具体问题

1. `src/client/index.tsx`：单击写入 `overview`，对话读取是手动触发；现改为默认对话并自动加载，保留其他统计 Tab。
2. `src/client/tetris-view.ts`：双击链路调用了 `open()`，而原生双击此前已经触发两次 click；现将预览与定位分开，取消单击计时器，定位开始关闭预览。
3. `src/client/reveal.ts`：原版使用 `element.dispatch(...)`，真实 HTMLElement 接口是 `dispatchEvent(...)`，因此 beforematch 实际未派发；同时补上隐藏祖先的展开。
4. 同文件：加载结束时只检查一次折叠按钮，随后只是被动等行。现持续重新查找迟到的折叠控件与目标行。目标 reasoning 尚未挂载或隐藏时，不用可见 response 冒充起点。
5. 控制器与棋盘：增加过期结果隔离；新砖选择或 session 切换后，旧预览/旧定位不得覆盖当前结果。棋盘按 session 重建绑定，不捕获首次 sessionId 永久使用。
6. `src/client/navigation.ts`：读取具体宿主 attempt 时以 settlement seq 和该 attempt 的 call IDs 为边界，不再把成功重试的内容显示在失败砖上。缺轮首时向前读取，已加载片段不因没有 turn/start 被整个丢弃。后续才注入的用户消息不回填进更早 attempt。
7. 缺少目标 DOM 行只说明定位尚未完成，不足以独立证明宿主投影故障；本版不再自动将此情况归咎为 `host-projection-blocked`。

## 本次实际执行的验证

- **29 项真实 Chromium + React 18 浏览器检查全部通过**。DSH sessions、feed 与日志由测试替身提供，不是连接使用者正在运行的 DSH。
- 覆盖单击自动预览、主对话不动、双击关闭预览、精确行高亮、键盘、定位按钮、原生 beforematch、迟到 850 ms 的折叠控件、较晚挂载的 reasoning、连续选砖竞态、迟到日志、session 切换、失败/重试隔离、轮首补载，以及 tool-call / retry-chain / compaction 定位。
- `scripts/verify-host-artifact.mjs`：**31 项宿主产物检查通过**。
- 导航、目标映射、棋盘等非 React 源码通过 TypeScript strict 检查；完整客户端通过 TypeScript 转译与 `node --check`，并在真实 React 测试页面执行。
- `lib/index.js` 与上传包 **SHA-256 完全相同**：

```text
58ad4ffa67bc4869710cc90cf4843942eea762c256e326f7a95fa4b1bed91cea
```

没有改宿主采集器、模型请求、提示词、工具注入或缓存统计口径。

完整逐项结果保存在 `docs/clickfix-results.json`。原包文档中的 312 项旧单测及旧版真机数字是历史记录，不是本次测试结果；上传包未附带那套测试文件。

## 包内容与使用

本修补包包含已生成的 `lib/client.js`、更新后的客户端源代码、类型声明及新增的构建/回归脚本。它不是只改 src 的源码包。按当前 DSH 实例原有的本地包安装方式替换这份 `.tgz`，再重新加载对应插件客户端/刷新页面；不要误装到另一个实例。

若使用的是 link 安装，也可在确认目录正确后替换该插件的 `lib/client.js`，刷新页面检查新版交互。修改 src 而不重建 lib 不会生效。是否需要重启宿主取决于当前实例的插件加载方式；本次宿主产物本身未变。替换前保留原包或原 client bundle 便于回滚。

## 开发者复跑

已有 TypeScript 开发依赖时：

```sh
npm run build:hotfix
node --check lib/client.js
npm run verify:host
```

安装 `playwright-core` 并设置可用 Chromium 的路径后：

```sh
npm run test:clickfix
```

`PLAYWRIGHT_CHROMIUM` 可指定本机 Chromium；React / ReactDOM 使用本项目的 18.x 开发依赖。`PLAYWRIGHT_CORE`、`TYPESCRIPT_PATH` 可指定现有安装路径。`DSH_TEST_REPORT` 可指定 JSON 报告输出路径。

`build:hotfix` 只重建浏览器 bundle 与相应声明，不重编译宿主。原上传 tarball 没有原工程的 tsconfig/tsdown 配置，所以增加这个可独立复跑的入口；未宣称原 `npm run build` 已获得完整工程配置。

## 尚需在实际实例验收的边界

如果宿主本身没有为已加载日志生成任何对应聊天行，插件不能把不存在的行滚动出来。本版不补造原对话行、不自动修改宿主，也不以邻近行冒充成功；会给出明确失败提示，小窗口仍可读取已拿到的日志。

原包文档提到的 `host-patches/system-message-never-withdraw` 不在上传的 tgz 内，本包没有暗中包含或执行它。浏览器夹具测试通过不能代替使用者实例的这项验收。
