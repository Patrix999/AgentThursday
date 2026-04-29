# AgentThursday

> **Why Thursday?**
>
> Lighter than Friday but way better than Monday.

[English version](./README.en.md)


**AgentThursday（AgentThursday）** 是一个构建在 Cloudflare 上的 serverless agent 平台。它能接收真实聊天消息，把任务路由进持久状态，调用真实执行的工具，带 provenance 读取外部资料，并通过 audit / inspect 让评审复盘它到底做了什么。

它不是一次性聊天机器人，而是一个小型云原生 agent runtime：常驻、可持久化、能接渠道、能用工具、能查资料、能留下证据。

---

## 核心亮点

- **边缘运行**：基于 Cloudflare Workers。
- **持久状态**：基于 Durable Objects 保存 agent、channel、content 状态。
- **真实工具调用**：不是 prompt 里假装调用，而是有 tool event 可查。
- **真实渠道接入**：Discord 消息进入 inbox，处理后从 outbox 回复。
- **外部资料访问**：通过 ContentHub connector 读取 source，并保留 revision / path / cache / permission 信息。
- **多 source 搜索**：同一 query 可 fan-out 到多个 source，结果和错误按 source 分组。
- **可复核证据链**：trace、tool events、content audit、content evidence 都能被 inspect。
- **诚实失败**：不支持的 capability 明确返回错误，不假装成功。

---

## 使用的 Cloudflare 组件

| Cloudflare 组件 | 用途 |
|---|---|
| **Workers** | 主 HTTP/API 入口、Web app、Discord interaction、工具 API、inspect API。 |
| **Durable Objects** | 保存 agent 状态、channel 路由状态、content registry/cache/audit 状态。 |
| **Durable Object SQL storage** | 持久化 event log、inbox/outbox、content audit、任务和 memory。 |
| **Workers AI** | agent 推理循环的模型绑定。 |
| **Browser Rendering** | 给 agent 提供无头浏览器能力。 |
| **Containers / Sandbox binding** | 提供更重的隔离执行层。 |
| **Workers Assets** | 同一部署中托管 Web 工作区 UI。 |
| **Wrangler** | 本地开发、secret 管理、生产部署。 |
| **Worker secrets / env bindings** | 保存渠道凭据、API secret、source token 和运行配置。 |

---

## 能力说明

### 持久任务循环

Agent 的 Durable Object 会保存任务生命周期、memory、workspace 文件、trace 事件和 tool dispatch 记录。一次 HTTP 请求结束后，状态不会消失。

### Discord 渠道层

Channel Hub 负责：

- 消息归一化
- trusted sender 过滤
- mention / addressed-message 判断
- inbox/outbox 持久化
- route-pending
- busy-safe routing
- Discord reply delivery

### 工具执行

模型可以调用多层工具：

- workspace 文件工具：`read` / `write` / `list` / `edit`
- 执行工具：JS/TS execution、sandbox command、browser action
- memory 工具：remember / recall
- 外部资料工具：ContentHub 的 sources/list/read/search

所有关键工具调用都会留下事件。模型说自己调用了工具，系统可以用 trace 校验它是否真的调用。

### ContentHub 外部资料层

ContentHub 把 agent 的 scratch workspace 与外部 source 分开，避免“没读过却声称读过”。

已实现：

- `content_sources`：列出 source 和 capability
- `content_list`：列目录
- `content_read`：读取内容，返回 provenance
- `content_search`：literal search，支持 multi-source fan-out

每次成功读取都带：source id、provider、path/object id、revision、fetched time、permission scope、cache status。

### 多 source 搜索

`content_search` 支持 `sourceIds`。结果不是混成一个列表，而是每个 source 单独返回：

- `ok` / `errorCode`
- hits
- latency
- source/provider

如果某个 source 不支持 search，会返回 `capability-not-supported`；其他 source 的结果不受影响。

### Evidence / Inspect

`/api/inspect` 返回：

- `trace`
- `toolEvents`
- `contentAudit`
- `contentEvidence`

`contentEvidence` 会按三种维度聚合：

- `byTraceId`：一轮 agent run 实际碰了哪些 source
- `bySourceId`：每个 source 被怎样使用
- `byOperation`：sources/list/read/search 各发生多少次

它还区分 direct API smoke 与模型驱动的 agent activity，方便比赛评审和调试。

### Truthfulness guard

如果模型说“我调用了某工具”，但当前 run 里没有对应 tool event，系统可以标记这类不诚实输出。这能避免 agent demo 里常见的“说做了但实际没做”。

---

## 评审可以如何验证

1. 在 Discord mention agent。
2. 要求它对两个 source 做搜索。
3. 看回复是否按 source/provider 分组。
4. 打开 `/api/inspect`。
5. 用 trace id 找到该轮任务。
6. 检查 content audit 和 content evidence。
7. 确认 audit 中没有 raw secret 或不该暴露的原始内容。

这条链路覆盖：聊天输入 → durable task → 工具调用 → source provenance → 聊天回复 → inspect 证据。


---

## 从零部署到 Cloudflare

下面假设你有一个全新的 Cloudflare 账号和一份全新的代码 checkout。

### 1. 准备账号和本地环境

1. 注册或登录 Cloudflare。
2. 安装 Node.js 22+ 和 npm。
3. clone 仓库并进入项目目录。
4. 安装依赖：

```bash
npm install
npm --prefix web install
```

5. 登录 Wrangler：

```bash
npx wrangler login
npx wrangler whoami
```

### 2. 确认 Cloudflare 能力

默认完整部署会用到：

- Workers
- Durable Objects + SQLite storage
- Workers Assets
- Workers AI
- Browser Rendering
- Containers / Sandbox binding

如果账号暂时没有 Browser Rendering 或 Containers 权限，可以先关闭相关能力做最小部署；核心路径是 Workers、Durable Objects、Assets 和 Workers AI。

### 3. 检查 `wrangler.toml`

`wrangler.toml` 里定义了：

- Worker 入口：`src/server.ts`
- Web 静态资源目录：`web/dist`
- Durable Objects：Agent、Channel Hub、Content Hub、Sandbox
- AI binding：`AI`
- Browser binding：`BROWSER`
- Container image：`Dockerfile`
- Discord bot id、allowed users、allowed channels 等 vars

正式 demo 前，需要把 `[vars]` 中的 Discord app / bot / allowlist 改成自己的配置。

### 4. 准备外部凭据

完整 demo 需要：

- **Shared API secret**：用于 `/api/*` 的鉴权。
- **Discord application**：在 Discord Developer Portal 创建，拿到 application id、bot id、public key、bot token，并邀请 bot 进目标 server/channel。
- **GitHub token**：只读 token，用于 ContentHub 读取/搜索外部代码 source。

最小非 Discord demo 可以先只设置 shared API secret 和 GitHub token，后续再接 Discord。

生成 shared secret 示例：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### 5. 设置 Worker secrets

用 Wrangler 设置 secrets，不要把 secret 写进 `wrangler.toml`、README、commit、任务报告或聊天记录。

```bash
npx wrangler secret put AGENT_THURSDAY_SHARED_SECRET
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_BOT_TOKEN
```

如果部署启用了 truthfulness gate 或其它运行时 flag，也按项目配置继续设置。

### 6. 本地构建检查

```bash
npm run typecheck
npm run build:web
```

`build:web` 必须生成 `web/dist`，Workers Assets 会从这里服务 Web UI。

### 7. 首次部署

```bash
npm run deploy
```

或直接：

```bash
npx wrangler deploy
```

首次部署时 Wrangler 会按 `wrangler.toml` 应用 Durable Object migrations。如果启用了 Containers，也会构建并上传 sandbox image。

部署成功后会输出 Worker URL 和 Version ID。

### 8. 冒烟测试

本地设置测试变量：

```bash
export AGENT_THURSDAY_URL="https://<your-worker-url>"
export AGENT_THURSDAY_SECRET="<your-shared-secret>"
```

健康检查：

```bash
curl "$AGENT_THURSDAY_URL/health"
```

Inspect：

```bash
curl -H "X-AgentThursday-Secret: $AGENT_THURSDAY_SECRET" \
  "$AGENT_THURSDAY_URL/api/inspect"
```

列 content sources：

```bash
curl -H "X-AgentThursday-Secret: $AGENT_THURSDAY_SECRET" \
  "$AGENT_THURSDAY_URL/api/content/sources?includeHealth=false"
```

配置好 source registry 和 token 后，可测搜索：

```bash
curl -H "X-AgentThursday-Secret: $AGENT_THURSDAY_SECRET" \
  -H "Content-Type: application/json" \
  -X POST "$AGENT_THURSDAY_URL/api/content/search" \
  -d '{"sourceId":"agentthursday-github","query":"AgentThursday","maxResults":5}'
```

### 9. 配置 Discord 演示

1. 在 Discord Developer Portal 创建 application 和 bot。
2. 复制 application id、bot id、public key、bot token。
3. 更新 `wrangler.toml` 的 bot id、application id、allowed users、allowed channels。
4. 用 Wrangler secrets 设置 Discord public key 和 bot token。
5. 重新部署：

```bash
npm run deploy
```

6. 邀请 bot 到 server，并确保它有发消息权限。
7. 在 allowlist channel mention bot，然后通过 `/api/inspect` 查看 trace、tool events、content audit 和 content evidence。

### 10. 常见问题

- **`/api/*` 返回 401**：缺少或填错 `X-AgentThursday-Secret`。
- **返回 503 auth misconfigured**：production 没设置 shared API secret。
- **Discord 消息被 ignored**：sender/channel 不在 allowlist、没 mention bot、或 channel id 不匹配。
- **Content source 没结果**：检查 source token、source id、path policy、provider capability。
- **Browser / sandbox 报错**：确认 Cloudflare 账号已启用 Browser Rendering / Containers。
- **Durable Object migration 报错**：确认 `wrangler.toml` 中 migrations 没在部署后被重排或改写。

---

## 开发

```bash
npm install
npm --prefix web install
npm run typecheck
npm run build:web
npm run dev
npm run deploy
```

Secrets 通过 Wrangler 和本地开发变量管理。不要把 token 放进聊天、日志、README 示例、任务报告或 commit。
