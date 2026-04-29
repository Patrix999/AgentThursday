# Deploy AgentThursday to Cloudflare

[中文版 / Chinese default](./DEPLOY.md)

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
