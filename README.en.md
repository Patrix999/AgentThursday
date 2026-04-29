# AgentThursday

[中文版 / Chinese default](./README.md)

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
