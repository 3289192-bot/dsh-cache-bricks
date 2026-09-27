**完整版 · 推荐下载**

- 优化棋盘拖动和历史回看，减少重复计算、历史扫描与数据处理。
- 优化落砖及整列平移动画，减少页面布局开销。
- 恢复请求出现、读数结算时的两次落砖反馈，修复虚线位置不同步。
- 修复系统开启“减少动态效果”时落砖动画消失的问题。
- 增加中文使用说明图。

**[下载完整版 v0.1.5](https://github.com/3289192-bot/dsh-cache-bricks/releases/download/v0.1.5/dsh-cache-bricks-0.1.5.tgz)** · [使用说明](https://github.com/3289192-bot/dsh-cache-bricks#readme)

```sh
dsh plugin --profile web add github:3289192-bot/dsh-cache-bricks#v0.1.5
```

**兼容性：** 当前公开测试使用基线为 DSH `0.1.7-rc.2` Web profile；其他版本未经本次兼容性测试，不保证兼容，不限定只能安装在 rc.2。

<details>
<summary>Lite 精简版（可选）</summary>

只需要缓存棋盘时选择。保留缓存读数、滚动和旧会话补载，省去详情、定位、对比与翻面。

本次同步优化落砖和平移动画，修复减少动态效果设置导致的落砖消失，以及虚线位置跟随问题。

[下载 Lite v0.1.5](https://github.com/3289192-bot/dsh-cache-bricks/releases/download/v0.1.5/lite-dsh-cache-bricks-0.1.5.tgz)

```sh
dsh plugin --profile web add github:3289192-bot/dsh-cache-bricks#v0.1.5-lite
```

同一 profile 选择完整版或 Lite 之一。Lite 的其他 DSH 版本同样不保证兼容。

</details>
