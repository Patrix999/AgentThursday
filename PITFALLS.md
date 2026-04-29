# AgentThursday Migration Pitfalls

Notes from the first orgOS-derived AgentThursday dry run on 2026-04-29.

## Cleanup / rebrand

- Remove internal working folders before publishing: `meeting/`, `docs/kanban/`, `docs/tests/`, design/milestone scratch docs, local `.dev.vars`, local `.env*`, MCP session files, and generated build outputs.
- Do not keep `.mcp.json`: it can reference a private local session name/path.
- Rebrand all visible names consistently. In the first pass, code had mostly become `AgentThursday`, but README/DEPLOY still said `CloudPilot`; grep for all old public placeholder names before publishing.
- Regenerate `package-lock.json` after renaming `package.json`; otherwise the lockfile can still expose the old package name.
- Keep lockfiles in the public repo for reproducible demo installs; do not ignore `package-lock.json`.

## Scripts / build

- If `scripts/` test utilities are intentionally removed, update root `package.json` scripts. The first pass kept `tsc --noEmit -p scripts/tsconfig.json`, which broke `npm run typecheck` after cleanup.
- Always run:

```bash
npm run typecheck
npm run build:web
npx wrangler deploy --dry-run
```

## Secrets / public repo

- Never commit `.dev.vars`, `web/.env`, `.env`, bot tokens, shared secrets, or GitHub tokens.
- Run a token-pattern scan over candidate committed files before push.
- Production `/api/*` requires `X-AgentThursday-Secret`; create `AGENT_THURSDAY_SHARED_SECRET` with `wrangler secret put`, not `wrangler.toml`.

## Discord demo

- Use a new Discord bot for AgentThursday. Do not reuse the orgOS bot id/token; two workers sharing one gateway bot can conflict.
- Until the new bot exists, keep these vars blank in `wrangler.toml`:
  - `AGENT_THURSDAY_DISCORD_BOT_ID`
  - `DISCORD_APPLICATION_ID`
  - `DISCORD_ALLOWED_USERS`
  - `DISCORD_ALLOWED_CHANNELS`
- Set `DISCORD_PUBLIC_KEY` and `DISCORD_BOT_TOKEN` only via `wrangler secret put` when the new bot is ready.

## Cloudflare deployment

- `wrangler secret put AGENT_THURSDAY_SHARED_SECRET` can create the Worker before the first deploy if it does not exist yet.
- The first container deploy may be slow because Cloudflare pushes the sandbox image and creates the container application.
- If `workers_dev` and `preview_urls` are not explicit in `wrangler.toml`, Wrangler enables them by default and prints warnings. This is okay for the demo URL, but document it if the competition submission needs a custom domain or previews disabled.
- Browser Rendering / Containers require the correct paid account/beta access. `wrangler deploy --dry-run` is the quickest config sanity check before a real deploy.

## Verification smoke

After deploy:

```bash
curl https://agent-thursday.domain-4c7.workers.dev/health
curl -H "X-AgentThursday-Secret: $AGENT_THURSDAY_SHARED_SECRET" \
  https://agent-thursday.domain-4c7.workers.dev/api/inspect
```

Expected current state before Discord bot setup:

- Web page loads.
- `/health` returns `ok: true`.
- `/api/inspect` works with the shared secret.
- Discord routes/bot gateway are not ready until the new bot vars/secrets are set.
