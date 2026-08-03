# AI Usage Dashboard（AI 用量仪表盘）

[![CI](https://github.com/0xBigotry7/ai-usage-dashboard/actions/workflows/ci.yml/badge.svg)](https://github.com/0xBigotry7/ai-usage-dashboard/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/0xBigotry7/ai-usage-dashboard)](https://github.com/0xBigotry7/ai-usage-dashboard/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22.13%2B-5FA04E.svg)](package.json)

**一眼看清你烧掉的每个 AI 订阅：配额窗口、重置倒计时、余额、真实 token
用量 —— 全部在本机采集，按你的方式呈现。**

<img src="public/og.png" alt="AI Usage Dashboard 展示各服务商配额窗口、余额与 token 估算" width="1731">

[English](README.md)

每个 AI 编程工具都把用量藏在不同的地方。本工具在你自己的机器上读取它们，
用三种界面呈现同一份诚实的数据：

- **浏览器仪表盘** —— 配额环、重置倒计时、余额、分层 token 视图、历史趋势；
- **常亮小屏** —— 专为 480×320 / 800×480 副屏设计的 `/display` 视图；
- **macOS 菜单栏** —— 原生常驻应用，让最重要的三个服务商全天可见。

开箱即支持 **OpenAI Codex、Claude Code、Kimi Code、OpenAI API、OpenRouter、
DeepSeek、GitHub Copilot**，并提供文档化的快照协议接入其他任何来源。

数据不出你的机器：采集器只监听 `127.0.0.1`，读取 CLI 自己的文件和官方
计费接口，绝不读取消息内容，凭证也绝不进入仓库或浏览器。

## 你的 key 绝不离开你的机器

担心用量工具偷偷上传凭证？这个工具在结构上就做不到这件事：

- **默认只在本地运行。** 采集器只绑定 `127.0.0.1`，并拒绝非本机 `Host`
  头的请求（`collector/server.mjs`）。没有遥测、没有统计上报、没有更新
  检查 —— 唯一的网络请求就是你自己配置的服务商 API。
- **key 只存在你自己的一个文件里**：`~/.usage-hub/env`，创建即 `0600`
  权限，在仓库之外。凭证绝不会进入浏览器、日志或历史数据库。
- **会话日志只读数字。** Codex/Claude Code 解析器只提取 token 计数、
  模型名和会话关系元数据 —— 提示词和回复内容不会被读取、导出或展示
  （`collector/session-log-estimate.mjs`、`collector/claude-session-log.mjs`）。
- **云同步默认关闭**，即使开启，云端接口也只接受严格字段白名单 ——
  数字用量、重置时间、展示元数据；OAuth token、API key、主机名、文件
  路径、提示词、原始日志都会被 schema 直接拒绝（`lib/remote-usage.ts`，
  有测试守护）。
- **MIT 开源、体量小。** `grep -rn "fetch(" collector/` 就能看到每一个
  对外请求。一个下午就能审计完。

## 快速开始

要求：macOS 或 Linux，Node.js 22.13+。

```bash
git clone https://github.com/0xBigotry7/ai-usage-dashboard.git
cd ai-usage-dashboard
npm ci
npm run local
```

打开 <http://localhost:3000>。如果这台机器已在用 Codex 或 Claude Code
CLI，首屏就是真实数据 —— 零配置。

可选服务商各一条命令：

```bash
npm run configure:kimi                          # Kimi Code API key
npm run configure:provider -- openai-api        # 或 openrouter / deepseek / github-copilot
```

## macOS 菜单栏

```bash
npm run build:menubar
open "dist/AI Usage Dashboard Menu Bar.app"
```

应用自带并启动本地采集器，菜单栏常驻最多三个服务商，弹层里有每个配额
窗口、重置时间和今日观测 token。机器需有 Node.js 22.13+（Homebrew、
nvm、mise、asdf 安装的都能自动发现；`USAGE_HUB_NODE` 可手动指定）。
把应用拖进 `/Applications` 并开启 **Launch at Login** 即可常驻。

本地构建为 ad-hoc 签名，适合个人使用；对外分发前请阅读
[macOS 打包与签名](docs/macos-release.md)。

---

# 细节

## 数字如何保持诚实

四个概念始终分开、分别标注，绝不悄悄混算：

- **配额（quota）** —— 服务商返回的百分比与重置时间；
- **官方 API 用量** —— 文档化计费接口返回的精确 token/积分；
- **观测 token** —— 从本地 CLI 会话日志读出的计数器；
- **token 等价值** —— 你自己配置的容量 × 配额百分比。

总览分三个独立层（今日已记录、本订阅周期已记录、配额换算）。没有观测
来源的服务商显示为"不可用"而不是伪造的零；估算出的重置时间会明确标注
"估算"。

## 内置适配器

| 适配器 | 配额来源 | Token 方式 | 凭证边界 |
| --- | --- | --- | --- |
| OpenAI Codex | 本机 Codex CLI OAuth 会话 | 可选配额换算 + 本地 `token_count` 事件 | 只读 CLI 自己的文件，绝不写凭证 |
| Claude Code | 无（没有文档化配额接口） | 本地逐消息 `usage` 记录的今日 + 近 7 天观测 token | 只读 CLI 会话日志，绝不读消息内容或凭证 |
| Kimi Code | API key 或未过期的 CLI 会话 | 可选配额换算 | 可选 key 存于仓库外，权限 `0600` |
| OpenAI API | 文档化 Organization Usage API | 精确的 7 天分模型 token 与请求数 | Admin key 只存在本地采集器 |
| OpenRouter | 文档化 current-key 接口 | key 花费、上限、重置周期 | API key 只存在本地采集器 |
| DeepSeek API | 文档化余额接口 | 仅余额，不虚构配额窗口 | API key 只存在本地采集器 |
| GitHub Copilot | 文档化 AI Credits 计费接口 | 月度 AI Credits，可对比自定上限 | 细粒度 token（仅 `Plan: read`）只存本地 |
| 自定义快照 | 任何输出规范化 schema 的采集器 | 任意规范化方式 | 云端接收严格字段白名单 |

Codex 与 Kimi 的配额接口是官方客户端在用但未对第三方文档化的接口，其余
直连适配器均使用文档化 API。详见[安全与局限](docs/security.md)。

## Token 与用量方式

**官方 API 用量。** OpenAI Organization Usage 返回按模型分组的精确
token 与请求数；GitHub 返回 AI Credits，OpenRouter 返回 key 花费，
DeepSeek 返回账户余额。这些数值绝不换算成订阅配额。

**配额换算。** `估算 token = 周配额已用百分比 × 你配置的周容量`。
没有内置容量 —— 不校准就只显示百分比：

```bash
npm run configure:capacity -- kimi 10000000   # 或 codex；传 "clear" 清除
```

**本地 CLI 日志。** Codex 与 Claude Code 适配器只读本地 JSONL 里的
token 计数器、模型名和会话关系元数据 —— 绝不读提示词或回复。计数器按
增量累加；fork/续接会话重放祖先历史时会先剔除匹配前缀，子代理的工作
不会把父会话用量翻倍。`totalTokens = inputTokens + outputTokens`；缓存
输入与推理输出作为子集标注，不重复相加。此方式只覆盖本机。可用
`USAGE_HUB_CODEX_LOG_ESTIMATE=off` 或 `USAGE_HUB_CLAUDE_LOG_ESTIMATE=off`
关闭。

## macOS 菜单栏（深入）

应用每 60 秒读一次自带的本地采集器；服务商 API 最多每 5 分钟轮询一次，
带重试与退避。菜单栏常驻三个服务商（`*` 表示数据过期，`ERR` 表示服务商
异常）；弹层展示全部配额窗口、重置时间、余额、新鲜度、今日观测输入+输出
及每服务商最多三个模型的 token 余量。只有存在真实周期与重置时间才显示
用量节奏预测；70/80/90% 提醒需手动开启且每周期去重。节奏与通知的设计
借鉴自 CodexBar —— 见[出处说明](docs/attribution.md)。

## 外接常亮小屏

`/display` 在 480×320 与 800×480 下无需滚动，每 8 秒自动翻页，支持
全屏与屏幕常亮（Wake Lock）。见[外接屏与 kiosk 部署](docs/external-display.md)。

## 可选云端仪表盘

可部署到 Cloudflare Workers + D1：采集器通过 bearer 保护的接口推送
净化后的快照；查看者使用独立访问码。云端 schema 只接受数值用量与展示
元数据 —— 绝不接受 OAuth token、API key、主机名、文件路径、提示词或
原始日志。见[配置与部署](docs/configuration.md)。

## 新增服务商

本地适配器在 `collector/providers/index.mjs` 注册，只需返回一个规范化
provider 对象，所有界面自动适配。动手前请读
[Provider development](docs/provider-development.md) —— 新适配器应带来
可信的新能力，而不只是一个 logo。

## 文档

- [架构与数据流](docs/architecture.md)
- [外接屏与 kiosk 部署](docs/external-display.md)
- [macOS 打包、签名与 Homebrew](docs/macos-release.md)
- [配置与 Cloudflare 部署](docs/configuration.md)
- [Provider 开发](docs/provider-development.md)
- [安全模型与局限](docs/security.md)
- [出处说明](docs/attribution.md) · [第三方声明](THIRD_PARTY_NOTICES.md)
- [路线图](docs/roadmap.md) · [更新日志](CHANGELOG.md) · [参与贡献](CONTRIBUTING.md)

## 状态与商标

早期开源项目，刻意保留诚实的空白：缺失的配额窗口就显示为缺失。内置
服务商图标来自 [`@lobehub/icons-static-svg` 1.94.0](https://github.com/lobehub/lobe-icons)
（MIT），本地存储。产品名称与 logo 归各自所有者。本项目与 OpenAI、
Anthropic、Moonshot AI、Cloudflare、CodexBar、Lobe Icons、ccusage 均无关联。

## 许可证

[MIT](LICENSE)
