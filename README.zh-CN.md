# AI Usage Dashboard

一个本地优先、可扩展的 AI 用量 Dashboard，适合放在桌面浏览器或外接常亮小屏上。

[English](README.md)

## 为什么做这个项目

不同 AI 编程工具把配额、重置时间和 Token 记录放在不同位置。本项目把它们归一化到同一个界面，同时避免把平台凭证或对话正文发送到浏览器。

项目明确区分三个概念：

- **平台配额**：平台返回的已用百分比和重置时间；
- **本机日志 Token**：本地 CLI 会话日志中记录到的 Token 计数；
- **Token 等效估算**：配额百分比乘以可配置的周容量。

后两种口径会同时显示，但永远不会相加。

## 当前内置接入

| 接入 | 配额来源 | Token 口径 | 凭证边界 |
| --- | --- | --- | --- |
| OpenAI Codex | 已有 Codex CLI OAuth 登录态 | 配额换算 + 本机 `token_count` 日志 | 只读 CLI 文件，不改写凭证 |
| Kimi Code | API Key 或尚未过期的 CLI 登录态 | 配额换算 | Key 保存在仓库外的 `0600` 文件 |
| 自定义快照 | 任意实现归一化协议的采集器 | 两种口径均可 | 云端只接受严格白名单字段 |

内置配额接入使用官方客户端正在使用、但没有承诺为稳定第三方 API 的端点，平台改版后可能需要更新。

## 快速开始

需要 macOS 或 Linux，以及 Node.js 22.13 或更高版本。

```bash
git clone https://github.com/0xBigotry7/ai-usage-dashboard.git
cd ai-usage-dashboard
npm ci
npm run local
```

打开 <http://localhost:3000>。本地采集器只监听 `127.0.0.1:4317`。

Codex 会读取已有 CLI 登录。Kimi 为可选接入：

```bash
npm run configure:kimi
```

输入过程不会回显。Key 保存在 `~/.usage-hub/env`，不会进入 Git、浏览器或历史数据库。

## 两种 Token 算法

### 配额百分比换算

```text
Token 等效估算 = 本周已用百分比 × 配置的周容量
```

这个数字适合观察整个账户在不同设备上的订阅压力，但周容量只是校准参数，不是平台公布的官方 Token 上限。

### 本机 CLI 日志

Codex 适配器只读取本地 JSONL 中的 `token_count` 和模型元数据，按累计计数的增量汇总过去 7 天。提示词和回复正文不会被导出或上传。其他设备、已删除日志和没有写入日志的调用不会被统计。

可通过以下方式关闭：

```bash
USAGE_HUB_CODEX_LOG_ESTIMATE=off npm run local
```

## 云端与自定义 Provider

项目可部署到 Cloudflare Workers + D1。采集器通过独立写入令牌上传脱敏快照，查看者使用另一个查看码换取安全 Cookie。

公开仓库不内置任何特定远程机器、私有账号或平台专用的远端采集脚本。私有采集器可以保留在自己的机器上，只向本项目发送归一化快照。这也是未来扩展 Gemini、Copilot、Cursor 等平台的统一接口。

## 文档

- [架构与数据流](docs/architecture.md)
- [配置与 Cloudflare 部署](docs/configuration.md)
- [开发新的 Provider](docs/provider-development.md)
- [安全模型与限制](docs/security.md)
- [引用与实现来源](docs/attribution.md)
- [Roadmap](docs/roadmap.md)
- [参与贡献](CONTRIBUTING.md)

## 项目状态

项目仍处于早期版本。平台没有返回的配额窗口会保持“未提供”；只有历史数据真实出现过百分比归零或下降时，才会推算下一次重置，并在页面明确标为“预计”。

本项目与 OpenAI、Moonshot AI、Cloudflare、CodexBar、ccusage 均无隶属或合作关系。

## 许可证

[MIT](LICENSE)
