# AI Usage Dashboard

<img src="public/og.png" alt="AI Usage Dashboard 展示多个平台的配额窗口、余额与 Token 估算" width="1731">

一个本地优先、可扩展的 AI 用量 Dashboard，可同时展示配额窗口、官方 API
用量、余额和 Token 估算。适合桌面浏览器、外接常亮小屏，也附带原生 macOS
顶栏预览。

[English](README.md)

## 为什么做这个项目

不同 AI 编程工具把配额、重置时间和 Token 记录放在不同位置。本项目把它们归一化到同一个界面，同时避免把平台凭证或对话正文发送到浏览器。

项目明确区分这些概念：

- **平台配额**：平台返回的已用百分比和重置时间；
- **官方 API 用量**：文档化计费接口返回的真实 Token 或 Credits；
- **本机日志 Token**：本地 CLI 会话日志中记录到的 Token 计数；
- **Token 等效估算**：配额百分比乘以可配置的周容量。

几种口径覆盖范围不同，会分开显示，永远不会相加。

## 主要功能

- 采集器只监听 `127.0.0.1`，单个平台异常不会拖垮整个 Dashboard；
- 展示真实配额窗口、重置时间、余额及可获得的官方 API 用量；
- 可隐藏平台、设置 60% / 70% / 80% 关注阈值，并显示风险状态；
- 使用随应用保存的真实平台图标，自定义 Provider 会回退到文字缩写；
- 独立 `/display` 常亮屏，适配 480×320 和 800×480，支持自动分页、全屏和
  Screen Wake Lock；
- 原生 macOS 顶栏最多直接显示 3 个平台，展开后可看全部配额窗口、陈旧警告
  和可获得的逐模型 Token；
- 可选 Cloudflare 多设备汇总，云端只接受严格白名单快照。

## 当前内置接入

| 接入 | 配额来源 | Token 口径 | 凭证边界 |
| --- | --- | --- | --- |
| OpenAI Codex | 已有 Codex CLI OAuth 登录态 | 可选配额换算 + 本机 `token_count` 日志 | 只读 CLI 文件，不改写凭证 |
| Kimi Code | API Key 或尚未过期的 CLI 登录态 | 可选配额换算 | Key 保存在仓库外的 `0600` 文件 |
| OpenAI API | 官方 Organization Usage API | 过去 7 天真实模型 Token 与请求数 | Admin Key 只留在本机采集器 |
| OpenRouter | 官方当前 Key 用量接口 | Key 消费、上限和重置周期 | API Key 只留在本机采集器 |
| DeepSeek API | 官方余额接口 | 只显示余额，不虚构配额窗口 | API Key 只留在本机采集器 |
| GitHub Copilot | 官方用户 AI Credits 计费接口 | 本月 Credits，可选配置上限后显示百分比 | 仅需 `Plan: read` 的 Fine-grained Token |
| 自定义快照 | 任意实现归一化协议的采集器 | 任意归一化口径 | 云端只接受严格白名单字段 |

Codex 和 Kimi 的订阅配额来自官方客户端正在使用、但没有承诺为稳定第三方
API 的端点；其余直接接入均使用平台文档化 API。

## 快速开始

需要 macOS 或 Linux，以及 Node.js 22.13 或更高版本。

```bash
git clone https://github.com/0xBigotry7/ai-usage-dashboard.git
cd ai-usage-dashboard
npm ci
npm run local
```

打开 <http://localhost:3000>。本地采集器只监听 `127.0.0.1:4317`。

外接显示器或 HDMI 小屏可直接打开 <http://localhost:3000/display>。常亮和
kiosk 配置见[外接屏指南](docs/external-display.md)。

Codex 会读取已有 CLI 登录。Kimi 为可选接入：

```bash
npm run configure:kimi
```

输入过程不会回显。Key 保存在 `~/.usage-hub/env`，不会进入 Git、浏览器或历史数据库。

其他平台可按需逐个配置：

```bash
npm run configure:provider -- openai-api
npm run configure:provider -- openrouter
npm run configure:provider -- deepseek
npm run configure:provider -- github-copilot
```

可选平台只有在本机配置完整后才会出现，不会用一排“等待配置”卡片干扰日常使用。

## 用量与 Token 口径

### 官方 API 用量

OpenAI Organization Usage 会按模型返回真实 Token 和请求数；GitHub 返回
AI Credits，OpenRouter 返回 Key 消费，DeepSeek 返回账户余额。这些数据不会被
强行换算成订阅配额。

### 配额百分比换算

```text
Token 等效估算 = 本周已用百分比 × 配置的周容量
```

容量没有内置默认值。只有当你配置了 `USAGE_HUB_CODEX_WEEKLY_TOKEN_CAPACITY`
等校准值后才会产出换算 Token 估算；未配置时只显示配额百分比。该容量是你自己的
校准估算值，不是平台公布的官方 Token 上限。

### 本机 CLI 日志

Codex 适配器只读取本地 JSONL 中的 `token_count` 和模型元数据，按累计计数的
增量去重汇总。统计窗口与订阅配额周期对齐（取自日志事件内嵌的周配额窗口信息，
取不到时回退为最近 7 天），resume / fork 出的会话不会重复计数。输出的
`totalTokens` 包含缓存读取，其中的缓存读部分单独拆分为 `cachedInputTokens`。
提示词和回复正文不会被导出或上传。该口径仅覆盖本机，其他设备、已删除日志和
没有写入日志的调用不会被统计。

可通过以下方式关闭：

```bash
USAGE_HUB_CODEX_LOG_ESTIMATE=off npm run local
```

这些口径回答的是不同问题，会带着各自标签并排展示，永远不会相加，也不会被
当作可直接比较的总量。

## macOS 顶栏

原生顶栏程序每 60 秒读取同一个本机采集器。菜单栏会直接显示最多 3 个平台的
主要配额百分比；陈旧快照会在对应平台后明确标成 `旧`，平台错误会标成 `异常`，
不再使用含义模糊的尾部感叹号。展开后可以看到每个平台返回的全部配额窗口和
重置时间、余额、数据新鲜度，以及最多 3 个逐模型 Token。官方 API、本机日志和
按配额换算的估算会继续使用不同标签，不会混成一个数字。顶栏程序不会直接访问
平台，也不保存凭证。

### 从源码本地构建使用

目前正式支持的安装方式就是从源码本地构建；仓库暂不发布经过 Apple 公证的
`.app`、DMG 或 Homebrew cask。需要 macOS 14 或更新版本、Node.js 22.13 或更新
版本，以及包含 Swift 6 的 Xcode 16 或更新版本。

先启动 Dashboard 和只监听本机的采集器，并保持这个终端窗口运行：

```bash
npm ci
npm run local
```

另开一个终端构建并启动顶栏应用：

```bash
npm run build:menubar
open "dist/AI Usage Dashboard Menu Bar.app"
```

顶栏应用只是本机显示客户端，运行时需要采集器持续监听
`127.0.0.1:4317`。如果只想进行 Swift 开发而不组装独立 `.app`，可运行
`npm run menubar`。确认构建可用后，再把 `dist/` 里的应用拖进
`/Applications`，然后才能稳定使用“登录时启动”。

本地构建使用 ad-hoc 签名，适合在完成构建的这台电脑上开发和个人安装，但不等于
已经公证的公开发行版，也不应以“Apple 已验证开发者”的形式二次分发。
手动运行 **macOS package proof** 工作流可以在不配置证书的情况下构建同样的
临时测试包；它只会上传短期 workflow artifact，不会创建 GitHub Release。
公开分发前请阅读
[macOS 打包、签名与 Homebrew 指南](docs/macos-release.md)。

顶栏现在会固定显示 3 个平台的用量摘要；只有平台同时提供真实周期长度和重置时间
时才会计算周期末用量趋势；用户主动开启后，还可以发送去重的 70% / 80% / 90%
额度提醒。pace 与通知行为借鉴并改写自 CodexBar 的实现思路，具体参考文件和复用
边界见
[CodexBar 实现审阅](docs/attribution.md#codexbar-implementation-review)。

## 外接常亮屏

`/display` 是专门为外接屏设计的信息面，不是把完整 Dashboard 强行压缩。它在
480×320 和 800×480 下无需滚动；窄屏每页显示 3 个平台，宽屏每页显示 4 个，
平台更多时每 8 秒自动翻页。页面提供手动全屏与 Screen Wake Lock 开关；能否
真正阻止休眠仍取决于浏览器和操作系统支持。

完整接线和 kiosk 设置见[外接屏指南](docs/external-display.md)。

## 云端与自定义 Provider

项目可部署到 Cloudflare Workers + D1。采集器通过独立写入令牌上传脱敏快照，查看者使用另一个查看码换取安全 Cookie。

公开仓库不内置任何特定远程机器、私有账号或平台专用的远端采集脚本。私有采集器可以保留在自己的机器上，只向本项目发送归一化快照。

新增 Provider 应当优先补充一个可信、可验证且当前 schema 尚不能表达的能力，
而不是单纯增加平台数量。适配规则见
[Provider 开发指南](docs/provider-development.md)。

## 文档

- [架构与数据流](docs/architecture.md)
- [外接屏与 kiosk 配置](docs/external-display.md)
- [macOS 打包、签名与 Homebrew](docs/macos-release.md)
- [配置与 Cloudflare 部署](docs/configuration.md)
- [开发新的 Provider](docs/provider-development.md)
- [安全模型与限制](docs/security.md)
- [引用与实现来源](docs/attribution.md)
- [第三方声明](THIRD_PARTY_NOTICES.md)
- [Roadmap](docs/roadmap.md)
- [变更日志](CHANGELOG.md)
- [参与贡献](CONTRIBUTING.md)

## 项目状态

项目仍处于早期版本。平台没有返回的配额窗口会保持“未提供”；只有历史数据真实出现过百分比归零或下降时，才会推算下一次重置，并在页面明确标为“预计”。

内置平台图标来自 MIT 许可的
[`@lobehub/icons-static-svg` 1.94.0](https://github.com/lobehub/lobe-icons)，
文件随应用保存在本地，不会访问图标 CDN。产品名称、Logo 和商标归各自权利人
所有，详见[第三方声明](THIRD_PARTY_NOTICES.md)。

本项目与 OpenAI、Moonshot AI、Cloudflare、CodexBar、Lobe Icons、ccusage
均无隶属或合作关系。

## 许可证

[MIT](LICENSE)
