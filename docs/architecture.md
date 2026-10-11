# 架构与维护开发

## 组件边界

| 文件                        | 职责                                          |
| --------------------------- | --------------------------------------------- |
| `src/index.ts`              | 轻量入口、存活探针、转发到唯一 Durable Object |
| `src/app.ts`                | HTTP 路由、鉴权边界、管理 API、请求大小限制   |
| `src/mcp.ts`                | SDK transport、工具声明、统一工具错误格式     |
| `src/schemas.ts`            | 搜索/提取的参数校验和默认值                   |
| `src/auth.ts` / `config.ts` | Secret 解析和 Token 比较                      |
| `src/providers/tavily.ts`   | 将通用 provider 接口连接到 Tavily Key 池      |
| `src/key-pool/object.ts`    | 持久化事务、Tavily HTTP 调用、状态和管理重置  |
| `src/key-pool/policy.ts`    | 纯函数：轮换选择、冷却和错误分类              |

使用官方 MCP TypeScript SDK v1 的 Web Standards transport，避免手写 JSON-RPC。每次 HTTP 请求创建独立 server/transport，响应完成后关闭。无 MCP session；初始化、工具发现和调用都不依赖上一次请求的内存状态。

## 并发与持久化

所有边缘位置访问 `idFromName("tavily-global-v1")`，避免各地维护不同游标。状态在 `pool-v1` 记录内，使用 SQLite-backed DO 的 storage API 持久化。

每次选择 Key 都在存储事务内完成，并在发起网络调用前提交游标。网络请求不放进事务，避免一个慢请求阻塞其他查询。回写成功/失败时再次在事务内读取最新状态，避免计数丢失。较早的成功请求不会清除较晚失败请求产生的冷却状态。

选择序列按逻辑名称排序，正常为 A、B、A、B。只保证选择的顺序，不保证并发请求到达上游或返回结果的先后。每次工具调用最多尝试两把不同 Key，已尝试过的 Key 不会在同一次调用里重复使用。

配置变化会同步 Key 名单。移除的 Key 状态删除；同名但密钥内容变化时，通过 SHA-256 指纹识别并重置状态。原始 Key 只在 Secret 中。更换逻辑名称也会产生新状态与新计数。

## 数据与错误

请求体限制 32 KiB，上游响应读取限制 2 MiB。超限会取消读取并返回可理解的错误，不在服务器文件系统落地正文。URL 提取只接受不含凭据/自定义端口的公开 HTTP(S) 域名 URL，拒绝 IP 字面量和常见本地域名；实际网页抓取由 Tavily 完成，这不是本服务对所有 DNS/重定向目标的验证。

未知异常统一脱敏，上游错误正文不发送给 Agent。SDK 参数校验错误只包含客户端自己的输入。状态接口仅向管理员返回逻辑名称与计数。项目不主动记录查询、Token、Key 或结果正文；Cloudflare 平台及 Tavily 自身的数据政策仍适用。

没有幂等缓存：重复成功调用会再次消费额度。工具标注为只读，但 `idempotentHint=false`，因为调用存在费用副作用。不要启用代理对 POST 的无条件自动重试。

## 添加搜索提供商

1. 在 `src/providers/` 实现 `SearchProvider`；如果新服务不提供正文提取，应按能力拆分接口，避免假实现。
2. 增加自己的参数 schema、Secret 校验和上游错误映射。
3. 在 `mcp.ts` 注册工具或明确的 provider 参数；只有配置完成的服务才可用。
4. 独立维护各服务 Key 池、超时、费用与冷却策略，避免错误共用 Tavily 的状态码规则。
5. 添加 provider HTTP 模拟测试与协议集成测试，更新部署和客户端文档。

加入 Grok 时应显式使用官方 Responses API 搜索工具，验证返回引用，并区分网页与 X 搜索。普通聊天提示词不能作为联网已启用的证据。

## 检查与升级

```bash
npm ci
npm run check
npm test
npm run build
npm run format:check
npm audit
```

测试在本地 workerd 中运行，不使用真实 Key。不要用 Node 测试中 mock 出来的 DO 代替持久化和并发验证。测试通过不等于生产 CPU 已测量，也不等于 Alma/Hermes 的具体安装版本已联调。

锁文件纳入版本管理。更新 SDK、Wrangler 或 Cloudflare 测试插件时，在独立变更中更新锁文件并完整运行检查；特别关注 transport 和测试 API 的版本变化。迁移至 MCP SDK v2 应作为明确的协议兼容性变更处理。
