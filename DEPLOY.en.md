# Deploy AgentThursday to Cloudflare

[中文版 / Chinese default](./DEPLOY.md)

This is the short deployment checklist for AgentThursday. The README focuses on capabilities; deployment details live here.

## Requirement: Cloudflare paid Workers Plan ($5/month)

A full deployment uses Workers, Durable Objects, Workers Assets, Workers AI, Browser Rendering, and Containers / Sandbox binding.

Prepare a **Cloudflare paid Workers plan** before deploying the full version. Browser Rendering and Containers may also require account-level access or beta enablement.

## 1. Install dependencies and log in

```bash
npm install
npm --prefix web install
npx wrangler login
npx wrangler whoami
```

## 2. Review `wrangler.toml`

Confirm these settings match your account and demo environment:

- Worker entry: `src/server.ts`
- Assets output: `web/dist`
- Durable Objects: Agent, Channel Hub, Content Hub, Sandbox
- Bindings: Workers AI, Browser Rendering, container sandbox
- Discord bot id, application id, allowed users, allowed channels

If you are not running the Discord demo yet, you can leave Discord secrets unset and still validate the core Web/API/Inspect path.

## 3. Set secrets

Generate a shared API secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Set secrets:

```bash
npx wrangler secret put AGENT_THURSDAY_SHARED_SECRET
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_BOT_TOKEN
```

Notes:

- `AGENT_THURSDAY_SHARED_SECRET`: protects normal `/api/*` routes.
- `GITHUB_TOKEN`: use a read-only token for ContentHub sources.
- `DISCORD_PUBLIC_KEY` / `DISCORD_BOT_TOKEN`: required only for the Discord demo.
- Never commit secrets or paste them into chat, logs, README examples, or task reports.

## 4. Build and deploy

```bash
npm run typecheck
npm run build:web
npm run deploy
```

Or deploy directly:

```bash
npx wrangler deploy
```

A successful deploy prints the Worker URL and Version ID.

## 5. Smoke test

```bash
export AGENT_THURSDAY_URL="https://<your-worker-url>"
export AGENT_THURSDAY_SECRET="<your-shared-secret>"

curl "$AGENT_THURSDAY_URL/health"

curl -H "X-AgentThursday-Secret: $AGENT_THURSDAY_SECRET" \
  "$AGENT_THURSDAY_URL/api/inspect"

curl -H "X-AgentThursday-Secret: $AGENT_THURSDAY_SECRET" \
  "$AGENT_THURSDAY_URL/api/content/sources?includeHealth=false"
```

After your source registry and token are configured, test search:

```bash
curl -H "X-AgentThursday-Secret: $AGENT_THURSDAY_SECRET" \
  -H "Content-Type: application/json" \
  -X POST "$AGENT_THURSDAY_URL/api/content/search" \
  -d '{"sourceId":"agentthursday-github","query":"AgentThursday","maxResults":5}'
```

## 6. Discord demo

1. Create an application and bot in the Discord Developer Portal.
2. Update `wrangler.toml` with bot id, application id, allowed user ids, and allowed channel ids.
3. Set `DISCORD_PUBLIC_KEY` and `DISCORD_BOT_TOKEN` with Wrangler.
4. Deploy again.
5. Invite the bot to the target server/channel and confirm it can send messages.
6. Mention the bot in an allowlisted channel, then use `/api/inspect` to review traces, tool events, and content evidence.

## 7. Common issues

- `401 auth.required`: missing or wrong `X-AgentThursday-Secret`.
- `503 auth.misconfigured`: `AGENT_THURSDAY_SHARED_SECRET` was not set in production.
- Discord message ignored: sender/channel not allowlisted, or bot was not mentioned.
- Content source returns no results: check token, source id, path policy, and provider capability.
- Browser / sandbox errors: confirm the paid plan and account access for Browser Rendering / Containers.
- Durable Object migration errors: do not reorder or edit existing migrations after deployment.
