# 将 AgentThursday 部署到 Cloudflare

[English version](./DEPLOY.en.md)

这是 AgentThursday 的简版部署清单。README 只介绍项目能力；部署细节集中放在这里。

## 前提：需要 Cloudflare 付费 Workers Plan （$5/月）

完整部署会用到 Workers、Durable Objects、Workers Assets、Workers AI、Browser Rendering 和 Containers / Sandbox binding。

请准备 **Cloudflare paid Workers plan**。其中 Browser Rendering 和 Containers 也可能需要账号级权限或 beta access。

## 1. 安装依赖并登录

```bash
npm install
npm --prefix web install
npx wrangler login
npx wrangler whoami
```

## 2. 检查 `wrangler.toml`

确认这些配置符合你的账号和 demo 环境：

- Worker 入口：`src/server.ts`
- Assets 输出目录：`web/dist`
- Durable Objects：Agent、Channel Hub、Content Hub、Sandbox
- Bindings：Workers AI、Browser Rendering、container sandbox
- Discord bot id、application id、allowed users、allowed channels

如果暂时不做 Discord demo，可以先保留 Discord secrets 未配置；核心 Web/API/Inspect 路径仍可部署验证。

## 3. 设置 secrets

生成 shared API secret：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

设置 secrets：

```bash
npx wrangler secret put AGENT_THURSDAY_SHARED_SECRET
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_BOT_TOKEN
```

说明：

- `AGENT_THURSDAY_SHARED_SECRET`：保护普通 `/api/*` 路由。
- `GITHUB_TOKEN`：建议使用只读 token，用于 ContentHub source。
- `DISCORD_PUBLIC_KEY` / `DISCORD_BOT_TOKEN`：只在 Discord demo 时必须。
- 不要把 secrets 写进 commit、聊天、日志、README 或任务报告。

## 4. 构建并部署

```bash
npm run typecheck
npm run build:web
npm run deploy
```

也可以直接部署：

```bash
npx wrangler deploy
```

部署成功后，Wrangler 会输出 Worker URL 和 Version ID。

## 5. 冒烟测试

```bash
export AGENT_THURSDAY_URL="https://<your-worker-url>"
export AGENT_THURSDAY_SECRET="<your-shared-secret>"

curl "$AGENT_THURSDAY_URL/health"

curl -H "X-AgentThursday-Secret: $AGENT_THURSDAY_SECRET" \
  "$AGENT_THURSDAY_URL/api/inspect"

curl -H "X-AgentThursday-Secret: $AGENT_THURSDAY_SECRET" \
  "$AGENT_THURSDAY_URL/api/content/sources?includeHealth=false"
```

配置好 source registry 和 token 后，可再测搜索：

```bash
curl -H "X-AgentThursday-Secret: $AGENT_THURSDAY_SECRET" \
  -H "Content-Type: application/json" \
  -X POST "$AGENT_THURSDAY_URL/api/content/search" \
  -d '{"sourceId":"agentthursday-github","query":"AgentThursday","maxResults":5}'
```

## 6. Discord demo

1. 在 Discord Developer Portal 创建 application 和 bot。
2. 更新 `wrangler.toml` 里的 bot id、application id、allowed user ids、allowed channel ids。
3. 用 Wrangler 设置 `DISCORD_PUBLIC_KEY` 和 `DISCORD_BOT_TOKEN`。
4. 重新部署。
5. 邀请 bot 到目标 server/channel，并确认它有发消息权限。
6. 在 allowlist channel mention bot，再用 `/api/inspect` 查看 trace、tool events 和 content evidence。

## 7. 常见问题

- `401 auth.required`：缺少或填错 `X-AgentThursday-Secret`。
- `503 auth.misconfigured`：production 没有设置 `AGENT_THURSDAY_SHARED_SECRET`。
- Discord 消息被忽略：sender/channel 不在 allowlist，或没有 mention bot。
- Content source 没结果：检查 token、source id、path policy 和 provider capability。
- Browser / sandbox 报错：确认 paid plan，以及账号是否已开通 Browser Rendering / Containers。
- Durable Object migration 报错：部署后不要重排或改写已有 migrations。
