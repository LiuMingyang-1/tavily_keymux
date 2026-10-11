# Alma 与 Hermes

服务端使用通用 MCP Streamable HTTP，端点为 `/mcp`。每次请求携带 `Authorization: Bearer <client-token>`。不需要把 Tavily Key 放到客户端。

服务端支持 MCP SDK 的初始化与工具调用，使用无会话 JSON 响应；不提供旧式 `/sse`、OAuth 登录或浏览器 CORS。GET/DELETE `/mcp` 返回 405 是预期行为。

## Alma（macOS，alma.now）

在 Settings → MCP Servers → Add Server 添加 Remote 服务：

| 字段        | 值                                                     |
| ----------- | ------------------------------------------------------ |
| 名称        | `search-hub`                                           |
| 传输        | Streamable HTTP / HTTP                                 |
| URL         | `https://tavily-keymux.YOUR-SUBDOMAIN.workers.dev/mcp` |
| Header 名称 | `Authorization`                                        |
| Header 值   | `Bearer 你的Alma专用Token`                             |

Alma 官方文档确认支持 Remote HTTP/SSE，但未完整说明所有版本的自定义 Header 配置界面。如果你的版本没有 Header 设置，使用下面的 stdio 桥接方法。不要把 Token 填进 URL。

如果客户端发送浏览器 `Origin` 导致 403，也可以使用 stdio 桥接。桥接只负责协议连接，Key 池和业务仍在云端。

在 Alma 添加 Stdio 服务，配置示例：

```json
{
  "name": "search-hub",
  "command": "npx",
  "args": [
    "-y",
    "mcp-remote",
    "https://tavily-keymux.YOUR-SUBDOMAIN.workers.dev/mcp",
    "--header",
    "Authorization:${MCP_AUTH}"
  ],
  "env": {
    "MCP_AUTH": "Bearer 你的Alma专用Token"
  }
}
```

桥接需要本机 Node.js/npm；使用 Alma 的受保护配置保存 Token。不同 Alma 版本可能要求分别填写 command、args、env，而非直接粘贴整个对象。连接后在工具选择器启用 `web_search` 和 `web_extract`。

参考：[Alma MCP 文档](https://alma.now/docs/features/mcp)、[mcp-remote 项目](https://github.com/geelen/mcp-remote)。

## Hermes（Linux）

合并到当前 Hermes profile 的 `config.yaml`（默认 `~/.hermes/config.yaml`），不要覆盖已有配置：

```yaml
mcp_servers:
  search_hub:
    url: "https://tavily-keymux.YOUR-SUBDOMAIN.workers.dev/mcp"
    headers:
      Authorization: "Bearer ${SEARCH_HUB_TOKEN}"
    timeout: 60
    connect_timeout: 30
    supports_parallel_tool_calls: true
    skip_preflight: true
    tools:
      include: [web_search, web_extract]
      resources: false
      prompts: false
```

在当前 profile 的 `.env` 或 Hermes 支持的 secret source 中设置：

```dotenv
SEARCH_HUB_TOKEN=你的Hermes专用Token
```

`skip_preflight: true` 避免 Hermes 将 stateless 端点的 GET/HEAD 405 误判为不可用。服务默认协议协商即可，不要强制旧 SSE。工具超时 60 秒为最多两次各 20 秒的上游尝试留出余量。

在 Hermes 内执行 `/reload-mcp`，或重启 Hermes。工具通常以 `mcp__search_hub__web_search` 和 `mcp__search_hub__web_extract` 显示。

参考：[Hermes MCP 配置](https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference/)。若安装版本没有 `skip_preflight`，先升级 Hermes 或使用 stdio 桥接。

## 调用示例

搜索：

```json
{
  "query": "Cloudflare Durable Objects SQLite documentation",
  "max_results": 5,
  "search_depth": "basic"
}
```

限定域名：

```json
{
  "query": "Durable Objects CPU limits",
  "include_domains": ["developers.cloudflare.com"]
}
```

提取正文：

```json
{
  "urls": [
    "https://developers.cloudflare.com/durable-objects/platform/limits/"
  ],
  "format": "markdown"
}
```

搜索结果和网页内容是外部资料，不应被 Agent 当作系统指令执行。客户端可自行选择原生搜索或本 MCP，不需要禁用内置工具。
