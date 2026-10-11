# 运行与维护

## 管理接口

`GET /admin/status` 返回 Key 的逻辑名称、available/cooldown/disabled 状态、冷却截止时间、最近错误、累计成功/失败数和本服务观察到的 credits。

管理员 Token 只用于管理，不可调用 MCP；客户端 Token 只调用 MCP，不可管理 Key。管理接口从不返回原始 Key 或指纹。

在 Bash 安全读取管理员 Token，再执行请求：

```bash
read -rs -p 'Admin token: ' KEYMUX_ADMIN_TOKEN
export KEYMUX_ADMIN_TOKEN
curl --fail --config - <<EOF
url = "https://tavily-keymux.YOUR-SUBDOMAIN.workers.dev/admin/status"
header = "Authorization: Bearer ${KEYMUX_ADMIN_TOKEN}"
EOF
```

确认上游问题已解决后，恢复一把 Key：

```bash
curl --fail --config - <<EOF
url = "https://tavily-keymux.YOUR-SUBDOMAIN.workers.dev/admin/reset"
header = "Authorization: Bearer ${KEYMUX_ADMIN_TOKEN}"
header = "Content-Type: application/json"
request = "POST"
data = "{\"key_id\":\"primary\"}"
EOF
unset KEYMUX_ADMIN_TOKEN
```

重置清除停用/冷却状态，保留调用计数。不要持续重置仍然限流或耗尽的 Key。

`reported_credits` 是成功响应的 `usage.credits` 累加值，不是余额，不自动按月归零，不包含客户端绕过本服务产生的消耗，也不保证包含超时后上游已计费的请求。实际余额去 Tavily 控制台查看。

## 更换 Key 或 Token

更新 `TAVILY_API_KEYS` Secret 中相应逻辑名称的值，仍保留其他 Key：

```bash
npx wrangler secret put TAVILY_API_KEYS
```

下一次调用自动识别新密钥，清除旧停用状态和该 Key 的累计统计。更换客户端 Token 则更新 `CLIENT_TOKENS`，再只修改相应客户端。管理员 Token 单独用 `ADMIN_TOKEN` 更新。

Secret 更新使用 Wrangler 当前的部署流程生效。若采用版本化部署或 CI，请确认更新实际发布到了活跃版本。

## 月度额度恢复

`432/433` 暂停对应 Key 至下一个 UTC 月初，这是本项目针对月度额度的重试策略，不是从 Tavily 查询到的真实恢复时间。

如果你的账户周期、充值或预算调整导致额度提前恢复，管理员可以手动重置。如果月初仍未恢复额度，下次上游拒绝后会再次暂停，需检查账户而非反复请求。`401` 停用不会因跨月自动恢复。

## CPU 与免费计划

Cloudflare 的 Worker Free HTTP 请求 CPU 上限为 10ms；等待网络、存储等 I/O 不算 CPU。Durable Object 默认每次调用的 CPU 预算为 30 秒。实现将外层 Worker 保持为 Request/Response 转发，把鉴权、MCP SDK、JSON 校验和结果处理放在 DO 中。[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)、[DO 限制](https://developers.cloudflare.com/durable-objects/platform/limits/)

不要靠 `limits.cpu_ms` 配置把免费 Worker 的上限调高。本项目不依赖该做法，也不在服务端运行模型、浏览器或页面渲染。

免费计划还有独立配额。当前 DO 免费额度包含每天 100,000 次请求、13,000 GB-s 时长。DO 时长按对象活跃的墙钟时间和内存计费模型计算，等待上游也可能消耗这个时长配额；“网络等待不计 CPU”不意味着“不计 DO 时长”。以 Cloudflare 账户指标和当前价格页为准。[DO 定价](https://developers.cloudflare.com/durable-objects/platform/pricing/)

生产验证步骤：

1. 运行 `npm run smoke` 测协议连接，再带 `SMOKE_QUERY` 做少量真实搜索。
2. 在 Workers & Pages → 当前 Worker → Metrics 查看 CPU 时间分布与失败数，注意冷启动及多个结果/较长正文的请求。
3. 查看 Durable Objects 的请求量、duration 和存储操作指标。
4. 若出现 CPU 超限错误（通常 Cloudflare 1102 / exceeded CPU time），区分发生在入口 Worker 还是 DO；保留脱敏事件信息排查。
5. 测试普通搜索、advanced 搜索、单页提取和多页提取。SDK 本地测试或 `performance.now()` 的墙钟时间不能证明低于生产 10ms。

本项目没有做过你的 Cloudflare 账户上的 CPU 测量，不承诺所有请求永不超限。单个全局 DO 适合当前两个个人客户端；高并发多用户服务需要另行设计配额和扩容。

## 常见问题

| 现象                                                     | 检查方式                                                                           |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `/health` 正常，MCP 503                                  | Secrets 缺失/格式错误，或 DO 不可用；健康检查不验证这些内容                        |
| 401                                                      | Token 是否匹配 CLIENT_TOKENS，是否误用了管理员 Token，Header 是否有 `Bearer ` 前缀 |
| 403 `ORIGIN_NOT_ALLOWED`                                 | 当前客户端发送了浏览器 Origin；使用 stdio 桥接                                     |
| GET `/mcp` 返回 405                                      | 正常；需要 Streamable HTTP POST，Hermes 可设置 `skip_preflight`                    |
| Agent 找不到工具                                         | 检查工具是否启用、客户端重载及服务地址是否以 `/mcp` 结尾                           |
| `NO_AVAILABLE_KEYS` / `RATE_LIMITED` / `QUOTA_EXHAUSTED` | 管理员查询状态，等待冷却或检查 Tavily 账户                                         |
| `INVALID_UPSTREAM_RESPONSE`                              | 上游结果超 2 MiB 或异常；减少结果/URL 数，不要无限重试                             |
| 工具调用超时                                             | 客户端超时建议至少 60 秒；上游单次 20 秒，最多尝试两把                             |

默认关闭 Workers observability 日志，代码也不会主动打印秘密或查询。排错时可短期开启平台指标/日志；分享日志前确认未包含请求 Header 或正文。已有部署的历史日志不受代码设置影响。
