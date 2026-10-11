# 部署

## 1. 安装并验证

```bash
npm ci
npm run check
npm test
npm run build
```

依赖版本通过 `package-lock.json` 锁定。`wrangler.jsonc` 已配置 SQLite-backed Durable Object，支持 Workers Free 计划，不需要 KV、D1 或独立服务器。

## 2. 配置三个 Secret

在 Cloudflare 登录：

```bash
npx wrangler login
```

交互输入下面三个 Secret。值均从自己的密码管理器或本地安全文件复制，不要直接写在命令行参数中。

```bash
npx wrangler secret put TAVILY_API_KEYS
npx wrangler secret put CLIENT_TOKENS
npx wrangler secret put ADMIN_TOKEN
```

第一次设置 Secret 时，如果 Wrangler 提示创建 Worker，按提示创建与配置同名的 `tavily-keymux`。随后部署完整代码。

| Secret            | 内容格式                                                    |
| ----------------- | ----------------------------------------------------------- |
| `TAVILY_API_KEYS` | `{"primary":"tvly-第一把Key","secondary":"tvly-第二把Key"}` |
| `CLIENT_TOKENS`   | `{"alma":"独立随机Token","hermes":"另一个独立随机Token"}`   |
| `ADMIN_TOKEN`     | 第三个独立随机 Token，纯文本                                |

用 `openssl rand -hex 32` 分别生成三个 Token。Token 不得重复，不包含空白，长度 32–512 字符。Key/客户端的逻辑名称只允许字母、数字、下划线、连字符，最长 40 字符。Key 池允许 1–20 把不同 Key；两个独立额度的 Key 是当前目标配置。

`.dev.vars` 只用于本地，不会自动上传为生产 Secrets。Secret 中的 JSON 是原始 JSON，不要在交互输入时再加外围单引号。

## 3. 发布

```bash
npm run deploy
```

记下 Wrangler 输出的地址，例如：

```text
https://tavily-keymux.YOUR-SUBDOMAIN.workers.dev/mcp
```

可直接使用 workers.dev HTTPS，不必购买域名。以后需要自定义域名时，在 Cloudflare 为这个 Worker 添加域名即可。迁移标签 `v1` 会自动创建 Durable Object 类。

## 4. 验证

```bash
curl --fail https://tavily-keymux.YOUR-SUBDOMAIN.workers.dev/health
```

`/health` 只验证进程存活，不验证 Key、Secret 或 Tavily 连通性。随后用 SDK 冒烟脚本验证握手和工具列表：

```bash
export MCP_URL='https://tavily-keymux.YOUR-SUBDOMAIN.workers.dev/mcp'
read -rs -p 'Client token: ' MCP_TOKEN
export MCP_TOKEN
npm run smoke
unset MCP_TOKEN
```

默认只连接和列出工具，不消耗 Tavily credits。需要一次真实搜索验证时，设置 `SMOKE_QUERY`：

```bash
SMOKE_QUERY='Cloudflare Durable Objects documentation' npm run smoke
```

这会调用 `web_search`，消耗 Tavily credits。脚本只输出成功状态、工具名和结果数量，不打印正文或 Token。测试结束后可在 Tavily 控制台检查实际消耗。

## 5. 接入两端与运行指标

按[客户端文档](clients.md)分别配置 Alma Token 和 Hermes Token。两端地址相同。

查看 Cloudflare 的 Worker CPU 时间、错误数，以及 Durable Object 时长和请求数。不要用本地测试耗时替代线上 CPU 指标。详见[运行维护](operations.md)。

## 环境隔离与回滚

首次部署仅创建这个 Worker 及其 Durable Object，不需要修改其他服务。建议测试部署使用单独 Worker 名称，并独立设置 Secrets，避免和生产共享状态。

代码更新前运行验证命令。发布异常时使用 Cloudflare 控制台的部署回滚或 `npx wrangler rollback`。代码回滚不会还原 Secrets 或 Durable Object 数据；调整状态格式应新增版本和明确迁移，不能直接删已有 migration 标签。
