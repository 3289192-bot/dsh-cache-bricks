# Cache Bricks · Lite v0.1.5

> **这是可选精简版。默认推荐 [完整版](https://github.com/3289192-bot/dsh-cache-bricks#readme)，包含请求详情、定位、对比和类型翻面。**

Lite 只保留缓存命中率棋盘：每次真实模型请求结算后落一块砖，每轮对话一列。适合只想看缓存读数、希望减少界面和采集开销的用户。

Optional lightweight edition of Cache Bricks for DeepSeek Harness. Settled-request cache hit rates, scrolling and one-time history loading; no inspector, request comparison, conversation navigation or activity face. The default product is the full edition on main.

## 0.1.5 更新

- 优化落砖和整列平移动画，减少页面布局开销。
- 修复“减少动态效果”开启时，落砖动画消失的问题。
- 虚线落砖位置跟随棋盘移动。
- 保留旧会话读数补载和原有缓存配色。

本版整合本地 0.1.4-lite.f 的改进，读取与采集逻辑保持不变。

## 安装与兼容性

**当前公开验证基线为 DSH `0.1.7-rc.2` 的 Web profile。其他版本未经本次兼容性测试，不保证兼容。** 不限定只能安装在 rc.2；开发依赖仍固定为 rc.2，DSH 客户端 peer 声明不再锁死此版本。

历史开发记录包含旧 DSH 实例的使用情况，不作为本次承诺其他版本兼容的依据，见[发布说明](docs/publication.md)。

```sh
dsh plugin --profile web add github:3289192-bot/dsh-cache-bricks#v0.1.5-lite
```

[下载 Lite v0.1.5](https://github.com/3289192-bot/dsh-cache-bricks/releases/download/v0.1.5/lite-dsh-cache-bricks-0.1.5.tgz) · [完整版与使用说明图](https://github.com/3289192-bot/dsh-cache-bricks#使用说明图)

也可下载后安装本地文件：

```sh
dsh plugin --profile web add file:/path/to/lite-dsh-cache-bricks-0.1.5.tgz
```

任务空闲时重启对应 DSH Web 服务并刷新页面。完整版与 Lite 共用包名 `dsh-cache-bricks`，同一 profile 选择一个安装。曾使用旧包 `dsh-cache-badge` 时，请先移除旧包，避免出现两套棋盘。

卸载：

```sh
dsh plugin --profile web remove dsh-cache-bricks
```

## 看懂棋盘

| 颜色 | 含义 |
| --- | --- |
| 绿色 | 命中率 ≥ 90% |
| 黄色 | 70% ≤ 命中率 < 90% |
| 红色 | 命中率 < 70% |
| 灰色 | 未报告缓存字段，或 prompt 小于 1000 token |

读数按缓存读取 token 占 prompt 总量的比例计算，保留一位小数并向下取整。颜色不直接判断缓存变化的原因。

底部和左侧滑条用于回看，点击“最新”回到当前轮。Lite 默认仅在内存保留 1024 块砖；打开旧会话时读取日志补载有限的历史读数，超出保留范围会显示丢弃数量。

Lite 不提供详情弹窗、类型翻面、定位或请求对比；完整版说明图中的这些功能不属于 Lite。

## 数据与文档

插件读取请求结算 usage 和必要的历史事件来生成读数，不保存 prompt、工具内容或请求正文，不主动上传数据，不自行写入磁盘。DSH 原有会话日志由宿主管理。

[砖块契约](docs/cache-brick-contract.md) · [验证记录](docs/verification.md) · [历史开发记录](docs/release-history.md) · [MIT 协议](LICENSE)
