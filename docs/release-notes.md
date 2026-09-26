**完整版 · 推荐安装** · 仅支持 DeepSeek Harness `0.1.7-rc.2` 的 Web profile。

- 修复长会话回看时，历史砖的请求类型丢失、被显示成普通输出的问题。
- 回看更早记录时按需加载历史，减少重复处理整段会话。
- 修复补载历史后棋盘位置跳动，保持当前阅读位置。
- 优化长会话的棋盘渲染，减少屏幕外砖块带来的开销。
- 更正安装说明：主页、版本标签和下载包内的 README 统一指向 `v0.1.4`。

**[下载完整版 v0.1.4](https://github.com/3289192-bot/dsh-cache-bricks/releases/download/v0.1.4/dsh-cache-bricks-0.1.4.tgz)** · [功能与使用说明](https://github.com/3289192-bot/dsh-cache-bricks#readme)

```sh
dsh plugin --profile web add github:3289192-bot/dsh-cache-bricks#v0.1.4
```

<details>
<summary>Lite 精简版（可选）</summary>

适合只需要缓存命中率棋盘的用户。保留缓存读数、颜色提示和棋盘滚动，省去请求详情面板、对话定位、对比和类型翻面。

- 修复打开旧会话时棋盘为空的问题。
- 恢复黄色提示：低于 90% 为黄，低于 70% 为红；小于 1000 token 的请求显示为灰色。

[下载 Lite v0.1.4](https://github.com/3289192-bot/dsh-cache-bricks/releases/download/v0.1.4/lite-dsh-cache-bricks-0.1.4.tgz)

```sh
dsh plugin --profile web add github:3289192-bot/dsh-cache-bricks#v0.1.4-lite
```

Lite 同样仅支持 DSH `0.1.7-rc.2` Web profile。两个版本共用包名 `dsh-cache-bricks`，同一 profile 选择一个安装。

</details>
