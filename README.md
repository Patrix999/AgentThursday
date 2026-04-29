# AgentThursday

**AgentThursday** is a serverless agent platform built on Cloudflare. It receives real chat messages, routes them through durable state, dispatches tools that actually execute, reads external sources with revision-pinned provenance, and exposes audit evidence so reviewers can reconstruct what happened.

AgentThursday is not a one-shot chatbot demo. It is a small cloud-native agent runtime: always reachable, stateful, tool-grounded, channel-aware, and inspectable.

---

## Why AgentThursday is interesting

AgentThursday demonstrates what a practical serverless agent can do when the platform is more than a prompt wrapper:

- **Runs at the edge** with Cloudflare Workers.
- **Keeps durable state** with Durable Objects.
- **Uses real model/tool dispatch** instead of simulated tool claims.
- **Talks through real channels** such as Discord, with inbox/outbox routing.
- **Reads external content safely** through a typed ContentHub layer.
- **Searches multiple sources** while preserving per-source success/failure.
- **Leaves evidence behind** through trace, audit, and inspect endpoints.
- **Fails honestly** when a capability is unsupported instead of pretending.

The result is an agent that can be evaluated by behavior, not vibes: every important claim can be checked against tool events, content provenance, or audit rows.

---

## Cloudflare components used

AgentThursday is intentionally Cloudflare-native.

| Cloudflare component | How AgentThursday uses it |
|---|---|
| **Workers** | Main HTTP/API entrypoint, web app serving, Discord interaction routes, tool and inspect APIs. |
| **Durable Objects** | Long-lived agent state, channel routing state, content-source registry/cache/audit state. |
| **Durable Object SQL storage** | Persistent event logs, inbox/outbox rows, content audit rows, task and memory state. |
| **Workers AI** | Model inference binding for the agent reasoning loop. |
| **Browser Rendering** | Headless browser capability for web inspection tasks. |
| **Containers / Sandbox binding** | Isolated execution tier for heavier command/sandbox work. |
| **Workers Assets** | Serves the web workspace UI from the same deployment. |
| **Wrangler** | Local development, secret management, and production deployment. |
| **Worker secrets / environment bindings** | Stores channel credentials, shared API secret, source tokens, and runtime config without committing them. |

This architecture keeps the agent deployable as a single serverless application while still giving it persistent memory, real tool use, external content access, and observable operations.

---

## Runtime architecture

AgentThursday is organized around three Durable Objects on one Worker.

```text
Discord / Web / API
        │
        ▼
Cloudflare Worker
        │
        ├── Agent DO
        │     ├── task lifecycle
        │     ├── model + tool dispatch
        │     ├── durable memory and workspace files
        │     ├── event_log as canonical trace
        │     └── truthfulness gate for outgoing text
        │
        ├── Channel Hub DO
        │     ├── inbox / outbox
        │     ├── addressed-message detection
        │     ├── busy-safe routing
        │     └── Discord bridge normalization and replies
        │
        ├── Content Hub DO
        │     ├── source registry
        │     ├── GitHub and local fixture connectors
        │     ├── revision-pinned cache
        │     ├── content audit log
        │     └── evidence summary aggregation
        │
        └── Cloudflare AI / Browser / Sandbox bindings
```

---

## Agent capabilities

### 1. Durable task loop

The agent does not forget everything between HTTP requests. Its Durable Object stores:

- task lifecycle
- memory snapshots
- workspace files
- trace events
- tool dispatch records
- final assistant replies

This makes it possible to inspect a run after the fact and ask, “What did the agent actually do?”

### 2. Real chat-channel operation

AgentThursday includes a channel layer instead of treating Discord as a simple webhook:

- inbound message normalization
- trusted sender filtering
- mention / addressed-message detection
- durable inbox rows
- route-pending flow
- busy-safe handling
- outbound reply queue
- Discord reply delivery

A real Discord message can become a durable task, produce a model/tool run, and then return a reply to the same channel.

### 3. Tool-grounded execution

The model can dispatch tools across several tiers:

- workspace file tools: `read`, `write`, `list`, `edit`
- control/execution tools: JavaScript/TypeScript execution, sandbox command execution, browser actions
- memory tools: remember / recall
- external content tools through ContentHub

The important part: tool calls are logged. If a model claims it used a tool but no matching tool event exists, the system can flag that mismatch.

### 4. ContentHub: external source access with provenance

ContentHub separates the agent’s scratch workspace from external sources. The agent should not claim it read a repository or document unless the read came from a real content tool result.

Implemented content tools:

- `content_sources` — list available sources and declared capabilities
- `content_list` — list files/directories from a source
- `content_read` — read a file with provenance and redaction
- `content_search` — literal search, including multi-source fan-out

Implemented source providers:

- **GitHub connector** — read/list/search with path policy, revision labels, cache metadata, and secret redaction.
- **Local fixture connector** — a non-network provider used to validate the connector abstraction and capability declarations.

Every successful content result carries a `ContentRef` with:

- source id
- provider
- path or object id
- revision
- fetched time
- permission scope
- cache status

### 5. Multi-source search fan-out

AgentThursday can run one literal query across multiple sources via `sourceIds`.

The response is intentionally grouped per source:

- each source has its own `ok` / `errorCode`
- each source has its own hits and latency
- one source failing does not hide another source’s results
- unsupported search capability returns `capability-not-supported`

This matters for honest agent behavior. A local fixture source that cannot search is reported as unsupported; it is not silently skipped or mislabeled as a repository result.

### 6. Inspectable evidence trail

`/api/inspect` exposes both raw and aggregated evidence:

- `trace` — agent event trace
- `toolEvents` — model tool dispatch records
- `contentAudit` — raw ContentHub audit rows
- `contentEvidence` — aggregated evidence summary

`contentEvidence` groups audit rows three ways:

- **by trace id** — what sources did one agent run touch?
- **by source id** — how was each source used?
- **by operation** — how many `sources/list/read/search` operations happened?

It also distinguishes direct API smoke tests from model-driven activity, which is useful during judging and debugging.

### 7. Truthfulness guard

AgentThursday includes an outgoing-text truthfulness gate. If the assistant says it called a tool but the trace shows no matching tool event in that run, the reply can be annotated.

This is a practical guard against one of the most common agent-demo failures: claiming work that never actually happened.

---

## Example evaluation flow

A judge can test AgentThursday like this:

1. Mention the agent in Discord.
2. Ask it to search two content sources.
3. Confirm the Discord reply groups results by source.
4. Open `/api/inspect`.
5. Check the trace id for that run.
6. Verify the content audit rows and evidence summary.
7. Confirm no raw secrets or private raw content were exposed in the audit surface.

This makes the demo auditable end to end: channel input → durable task → tool calls → source provenance → channel reply → inspect evidence.

---

## Development

Requirements:

- Node.js 22+
- npm
- Cloudflare account
- Wrangler via project dependencies

Install:

```bash
npm install
npm --prefix web install
```

Check and build:

```bash
npm run typecheck
npm run build:web
```

Run locally:

```bash
npm run dev
```

Deploy:

```bash
npm run deploy
```

Secrets are managed through Wrangler and local development var files. Do not paste tokens into chat, logs, README examples, task reports, or commits.


## Deploy from zero to Cloudflare

This section assumes you are starting from a fresh Cloudflare account and a fresh checkout of this repository.

### 1. Prepare accounts and local tools

1. Create or log in to a Cloudflare account.
2. Install Node.js 22+ and npm.
3. Clone the repository and enter the project directory.
4. Install dependencies:

```bash
npm install
npm --prefix web install
```

5. Log in to Cloudflare from Wrangler:

```bash
npx wrangler login
npx wrangler whoami
```

### 2. Confirm Cloudflare capabilities

The default deployment uses these Cloudflare capabilities:

- Workers
- Durable Objects with SQLite storage
- Workers Assets
- Workers AI
- Browser Rendering
- Containers / Sandbox binding

If your Cloudflare account does not have Browser Rendering or Containers enabled, first deploy with those features disabled or request/enable access in the Cloudflare dashboard. Workers, Durable Objects, Assets, and Workers AI are the core path.

### 3. Review `wrangler.toml`

The deployment is defined in `wrangler.toml`:

- Worker entrypoint: `src/server.ts`
- Static assets: `web/dist`
- Durable Objects: Agent, Channel Hub, Content Hub, Sandbox
- AI binding: `AI`
- Browser binding: `BROWSER`
- Container image: `Dockerfile`
- Discord and channel allowlist variables under `[vars]`

Before a public demo, update the `[vars]` values for your own Discord app, allowed users, and allowed channels.

### 4. Create external credentials

For the full demo, prepare:

- **Shared API secret** — any long random string used by the web/API auth gate.
- **Discord application** — from the Discord Developer Portal:
  - application id
  - bot user id
  - public key
  - bot token
  - invite the bot to the target server/channel
- **GitHub token** — read-only token for the repository/content source you want the agent to inspect.

For a minimal non-Discord demo, you can start with only the shared API secret and GitHub token, then add Discord later.

Generate a shared secret locally, for example:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### 5. Set Worker secrets

Use Wrangler secrets. Do not write secret values into `wrangler.toml`, README examples, commits, or chat logs.

```bash
npx wrangler secret put AGENT_THURSDAY_SHARED_SECRET
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_BOT_TOKEN
```

Optional truthfulness-gate/runtime flags can also be set as secrets or vars if your deployment enables them.

### 6. Build locally

```bash
npm run typecheck
npm run build:web
```

The web build must produce `web/dist`, because Workers Assets serves the UI from that directory.

### 7. First deploy

```bash
npm run deploy
```

or directly:

```bash
npx wrangler deploy
```

On first deploy, Wrangler applies Durable Object migrations from `wrangler.toml`. If Containers are enabled, Wrangler also builds and uploads the sandbox image.

A successful deploy prints a Worker URL and a Version ID.

### 8. Smoke test the deployment

Set your shared secret locally for curl tests:

```bash
export AGENT_THURSDAY_URL="https://<your-worker-url>"
export AGENT_THURSDAY_SECRET="<your-shared-secret>"
```

Health check:

```bash
curl "$AGENT_THURSDAY_URL/health"
```

Inspect endpoint:

```bash
curl -H "X-AgentThursday-Secret: $AGENT_THURSDAY_SECRET" \
  "$AGENT_THURSDAY_URL/api/inspect"
```

List content sources:

```bash
curl -H "X-AgentThursday-Secret: $AGENT_THURSDAY_SECRET" \
  "$AGENT_THURSDAY_URL/api/content/sources?includeHealth=false"
```

Run a content read/search smoke after your source registry and token are configured:

```bash
curl -H "X-AgentThursday-Secret: $AGENT_THURSDAY_SECRET" \
  -H "Content-Type: application/json" \
  -X POST "$AGENT_THURSDAY_URL/api/content/search" \
  -d '{"sourceId":"agentthursday-github","query":"AgentThursday","maxResults":5}'
```

### 9. Configure Discord for channel demo

1. In the Discord Developer Portal, create an application and bot.
2. Copy the application id, bot id, public key, and bot token.
3. Update `wrangler.toml` `[vars]` for:
   - bot id
   - application id
   - allowed user ids
   - allowed channel ids
4. Set the Discord public key and bot token with Wrangler secrets.
5. Deploy again:

```bash
npm run deploy
```

6. Invite the bot to your server with the needed bot permissions.
7. Mention the bot in the allowed channel and then check `/api/inspect` for trace/tool/content evidence.

### 10. Common deployment issues

- **401 on `/api/*`**: missing or wrong `X-AgentThursday-Secret` header.
- **503 auth misconfigured**: shared API secret was not set in production.
- **Discord message ignored**: sender/channel not in allowlist, bot not mentioned, or channel id mismatch.
- **Content source has zero results**: check source token, source id, path policy, and provider capability.
- **Browser or sandbox errors**: verify your Cloudflare account has Browser Rendering / Containers enabled.
- **Durable Object migration errors**: confirm migrations in `wrangler.toml` have not been reordered or edited after deployment.

---

# AgentThursday / AgentThursday

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
