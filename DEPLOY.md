# Deploy AgentThursday to Cloudflare

A short deployment checklist for running AgentThursday on Cloudflare.

## Requirement: Cloudflare paid Workers plan

AgentThursday uses Cloudflare features that are not suitable for the free Workers plan, especially:

- Durable Objects with persistent state
- Worker assets + API in one deployment
- Workers AI binding
- Browser Rendering binding
- Containers / sandbox binding

Use a **paid Cloudflare Workers plan** before deploying the full version. Some optional capabilities, especially Browser Rendering and Containers, may also require account-level access or beta enablement.

## 1. Install dependencies

```bash
npm install
npm --prefix web install
```

Log in to Cloudflare:

```bash
npx wrangler login
npx wrangler whoami
```

## 2. Configure Cloudflare resources

Review `wrangler.toml` before deployment:

- Worker entry: `src/server.ts`
- Assets output: `web/dist`
- Durable Objects: Agent, Channel Hub, Content Hub, Sandbox
- Bindings: Workers AI, Browser Rendering, container sandbox
- Discord allowlist vars under `[vars]`

If using your own Discord bot, update the bot id, application id, allowed user ids, and allowed channel ids.

## 3. Set secrets

Generate a long shared API secret locally:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Set required secrets with Wrangler:

```bash
npx wrangler secret put AGENT_THURSDAY_SHARED_SECRET
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_BOT_TOKEN
```

Notes:

- `AGENT_THURSDAY_SHARED_SECRET` protects normal `/api/*` routes.
- `GITHUB_TOKEN` should be read-only for the source repo/content you want the agent to inspect.
- Discord secrets are only needed for the Discord channel demo.
- Never commit secrets or paste them into chat/logs.

## 4. Build and deploy

```bash
npm run typecheck
npm run build:web
npm run deploy
```

Equivalent deploy command:

```bash
npx wrangler deploy
```

A successful deploy prints the Worker URL and Version ID.

## 5. Smoke test

```bash
export AGENT_THURSDAY_URL="https://<your-worker-url>"
export AGENT_THURSDAY_SECRET="<your-shared-secret>"
```

Health:

```bash
curl "$AGENT_THURSDAY_URL/health"
```

Inspect:

```bash
curl -H "X-AgentThursday-Secret: $AGENT_THURSDAY_SECRET" \
  "$AGENT_THURSDAY_URL/api/inspect"
```

Content sources:

```bash
curl -H "X-AgentThursday-Secret: $AGENT_THURSDAY_SECRET" \
  "$AGENT_THURSDAY_URL/api/content/sources?includeHealth=false"
```

Content search:

```bash
curl -H "X-AgentThursday-Secret: $AGENT_THURSDAY_SECRET" \
  -H "Content-Type: application/json" \
  -X POST "$AGENT_THURSDAY_URL/api/content/search" \
  -d '{"sourceId":"agentthursday-github","query":"AgentThursday","maxResults":5}'
```

## 6. Common issues

- `401 auth.required`: missing or wrong `X-AgentThursday-Secret`.
- `503 auth.misconfigured`: `AGENT_THURSDAY_SHARED_SECRET` was not set in production.
- Discord message ignored: sender/channel not allowlisted or bot was not mentioned.
- Content source returns no results: check token, source id, path policy, and provider capability.
- Browser/sandbox errors: confirm paid plan and account access for Browser Rendering / Containers.
- Durable Object migration errors: do not reorder or edit existing migrations after deployment.

---

# 将 AgentThursday 部署到 Cloudflare

这是 AgentThursday 的简版部署清单。

## 前提：需要 Cloudflare 付费 Workers 计划

AgentThursday 使用了一些不适合免费 Workers 计划完整运行的 Cloudflare 能力，尤其是：

- Durable Objects 持久状态
- 同一个 Worker 中同时提供 Assets + API
- Workers AI binding
- Browser Rendering binding
- Containers / sandbox binding

完整部署前，请准备 **Cloudflare paid Workers plan**。其中 Browser Rendering 和 Containers 也可能需要账号级权限或 beta access。

## 1. 安装依赖

```bash
npm install
npm --prefix web install
```

登录 Cloudflare：

```bash
npx wrangler login
npx wrangler whoami
```

## 2. 配置 Cloudflare 资源

部署前检查 `wrangler.toml`：

- Worker 入口：`src/server.ts`
- Assets 输出目录：`web/dist`
- Durable Objects：Agent、Channel Hub、Content Hub、Sandbox
- Bindings：Workers AI、Browser Rendering、container sandbox
- Discord allowlist vars 在 `[vars]` 里

如果使用自己的 Discord bot，需要更新 bot id、application id、allowed user ids 和 allowed channel ids。

## 3. 设置 secrets

先生成一个长 shared API secret：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

用 Wrangler 设置 secrets：

```bash
npx wrangler secret put AGENT_THURSDAY_SHARED_SECRET
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_BOT_TOKEN
```

说明：

- `AGENT_THURSDAY_SHARED_SECRET` 用于保护普通 `/api/*` 路由。
- `GITHUB_TOKEN` 建议使用只读 token，用于读取/搜索外部内容 source。
- Discord secrets 只在需要 Discord 渠道 demo 时必须设置。
- 不要把 secrets 写进 commit、聊天、日志或 README 示例输出。

## 4. 构建并部署

```bash
npm run typecheck
npm run build:web
npm run deploy
```

等价部署命令：

```bash
npx wrangler deploy
```

部署成功后，Wrangler 会输出 Worker URL 和 Version ID。

## 5. 冒烟测试

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

Content sources：

```bash
curl -H "X-AgentThursday-Secret: $AGENT_THURSDAY_SECRET" \
  "$AGENT_THURSDAY_URL/api/content/sources?includeHealth=false"
```

Content search：

```bash
curl -H "X-AgentThursday-Secret: $AGENT_THURSDAY_SECRET" \
  -H "Content-Type: application/json" \
  -X POST "$AGENT_THURSDAY_URL/api/content/search" \
  -d '{"sourceId":"agentthursday-github","query":"AgentThursday","maxResults":5}'
```

## 6. 常见问题

- `401 auth.required`：缺少或填错 `X-AgentThursday-Secret`。
- `503 auth.misconfigured`：production 没有设置 `AGENT_THURSDAY_SHARED_SECRET`。
- Discord 消息被忽略：sender/channel 不在 allowlist，或没有 mention bot。
- Content source 没结果：检查 token、source id、path policy 和 provider capability。
- Browser/sandbox 报错：确认 paid plan，以及账号是否已开通 Browser Rendering / Containers。
- Durable Object migration 报错：部署后不要重排或改写已有 migrations。
