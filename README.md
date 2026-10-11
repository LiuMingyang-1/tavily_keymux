# Tavily Keymux

部署在 Cloudflare 的个人搜索 MCP 中枢，让 macOS Alma 和 Linux Hermes 共用 Tavily Key 池。第一版支持网页搜索、正文提取；每次请求最多尝试两个不同的 Key。

```text
Alma / Hermes → HTTPS /mcp → Worker（轻量转发）
                              └→ Durable Object（鉴权、MCP、轮换、Tavily 调用）
                                   ├→ Tavily Key A
                                   └→ Tavily Key B
```

上游 Key 放在 Cloudflare Secrets 中。每个客户端使用独立 Bearer Token，管理接口使用另一个 Token。持久化状态只包含 Key 的逻辑名称、指纹、轮换位置、冷却时间和调用计数，不保存查询或网页正文。

## 功能

| MCP 工具      | 用途                          | 默认参数                                 |
| ------------- | ----------------------------- | ---------------------------------------- |
| `web_search`  | 返回网页标题、来源 URL 和摘要 | `search_depth=basic`，`max_results=5`    |
| `web_extract` | 提取 1–5 个公开网页的正文     | `extract_depth=basic`，`format=markdown` |

两把 Key 各有独立的每月 1,000 credits，可共同使用 2,000 credits。credits 不等于调用次数；以 Tavily 返回的 usage 和账户账单为准。默认关闭搜索的自动参数升级和 AI 答案，避免无意增加开销。

当前没有实现 Grok、爬站、OAuth、跨提供商自动降级或余额查询。后续提供商可通过 `SearchProvider` 接口接入，不需要修改客户端地址。当前状态统计是本服务观察到的累计调用与 credits，不是实时余额。

## 快速开始

需要 Node.js 22+、npm、Cloudflare 账户和两个 Tavily Key。建议使用当前维护的 Node LTS。

```bash
npm ci
cp .dev.vars.example .dev.vars
chmod 600 .dev.vars
```

编辑 `.dev.vars`，替换两个 Tavily Key 和三个独立随机 Token。每个 Token 至少 32 个字符；可分别运行 `openssl rand -hex 32` 生成。不要把密钥写进代码、客户端 URL 或 Git。

```bash
npm run dev
```

本地 MCP 地址为 `http://localhost:8787/mcp`。本地开发使用本地 Durable Object 存储，但**工具调用会访问真实 Tavily 并消耗额度**。`npm test` 全部使用模拟上游，不消耗额度。

```bash
npm run check
npm test
npm run build
npm run format:check
```

`build` 只做部署打包演练，不发布。测试使用真实 Workers 本地运行时，涵盖 SDK 握手、工具发现、搜索/提取、并发轮换、持久化和错误切换。

## 云端部署与客户端

按顺序阅读：

1. [部署与凭据配置](docs/deployment.md)
2. [Alma / Hermes 连接](docs/clients.md)
3. [维护、CPU 限制和故障排查](docs/operations.md)
4. [架构与扩展方式](docs/architecture.md)

## 故障处理

| Tavily 响应                            | 处理                                                      |
| -------------------------------------- | --------------------------------------------------------- |
| `401`                                  | 停用该 Key，换另一把；更换 Key 或管理员重置后恢复         |
| `403`                                  | 冷却 5 分钟后再试，并尝试另一把                           |
| `429`                                  | 使用 `Retry-After` 冷却；缺失时 60 秒，范围 1 秒至 1 小时 |
| `432` / `433`                          | 额度/预算限制，暂停至下一个 UTC 月初；支持手动提前重置    |
| 网络错误、超时、`408`、`5xx`           | 冷却 15 秒，尝试另一把                                    |
| 其他 `4xx`                             | 返回请求错误，不轮换重试                                  |
| 成功但结果不是合法 JSON 或超过大小限制 | 返回错误，不重试，避免重复收费                            |

每把 Key 的单次上游请求限时 20 秒。正常情况下按名称排序轮流选择；发生故障后跳过不可用 Key。已发出的并发请求不能被后来的冷却状态撤销。网络超时后重试可能产生额外收费，因为无法确定上游是否已处理请求。

## 关于免费计划的 10ms CPU 限制

外层 Worker 只转发 Request/Response，不解析 MCP 或结果正文。鉴权、参数校验、JSON 处理和网络请求在 Durable Object 内完成，使用它独立的 CPU 预算。等待网络与存储不计入 CPU 时间。

这降低了外层 Worker 超过 10ms 的风险，**不代表已实测保证免费计划永不超限**。部署后必须检查 CPU 指标及 Durable Object 的每日运行时长配额。详见[维护文档](docs/operations.md#cpu-与免费计划)。

实现依据：[Tavily Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search)、[Tavily Extract API](https://docs.tavily.com/documentation/api-reference/endpoint/extract)、[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)、[Durable Objects 限制](https://developers.cloudflare.com/durable-objects/platform/limits/)。
