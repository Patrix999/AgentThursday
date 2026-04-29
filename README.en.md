# Agent Thursday

> **Why Thursday?**
>
> Lighter than Friday but way better than Monday.

[中文版 / Chinese default](./README.md)

**AgentThursday** is the first open-source cloud-native serverless agent platform built on Cloudflare.

It is not a prompt demo with a chat box attached. It is an agent runtime that can stay online, connect to real channels, call real tools, read external sources, and leave an auditable evidence trail.

---

## 🟢 Highlights

- **⚡️ Edge-native runtime**: runs on Cloudflare Workers, close to users and with minimal operations overhead.
- **🧠 Durable state**: Durable Objects keep tasks, memory, workspace, channel, and content state alive across requests.
- **📉 Model degradation awareness**: when model capability becomes unstable, tool calls are missing, or results look unreliable, AgentThursday can surface the risk instead of pretending everything is fine.
- **🧩 Action-aware UI**: the web UI turns search, file reads, execution, and workspace changes into readable action cards so users can quickly understand what the agent is doing.
- **🛠️ ToolHub**: tools are callable, auditable, traceable capabilities — not verbal promises inside a prompt.
- **📡 ChannelHub**: multi-channel messages enter a durable inbox and replies leave through an outbox, with real routing and busy-state protection for group workflows.
- **📚 ContentHub**: agents can read external sources such as GitHub while preserving revision, path, cache, permission, and provenance metadata.
- **🔎 Inspect / Audit**: traces, tool events, content audit rows, and evidence summaries make behavior reviewable for demos, debugging, and evaluation.
- **More features are under construction..**

---

## ☁️ Cloudflare components used

| Cloudflare component | Purpose |
|---|---|
| **Workers** | Main HTTP/API entrypoint, web app, Discord interactions, tool APIs, and inspect APIs. |
| **Durable Objects** | Agent state, channel routing state, content registry/cache/audit state. |
| **Durable Object SQL storage** | Persistent event logs, inbox/outbox rows, content audit rows, task state, and memory. |
| **Workers AI** | Model binding for the agent reasoning loop. |
| **Browser Rendering** | Headless browser capability for web inspection tasks. |
| **Containers / Sandbox binding** | Heavier isolated execution layer. |
| **Workers Assets** | Hosts the web workspace UI in the same deployment. |
| **Wrangler** | Local development, secret management, and production deployment. |
| **Worker secrets / env bindings** | Stores channel credentials, API secrets, source tokens, and runtime config. |

---

## 🚀 Capabilities

### 🧠 1. Durable task loop

AgentThursday can turn a chat message into a durable task. Task state, memory, workspace files, traces, tool records, and final replies remain in Durable Objects.

> That makes it more than a short-memory Q&A bot: it can keep moving tasks forward, preserve context across requests, and let users inspect what happened after the fact.

### 📡 2. Real channel collaboration

AgentThursday treats Discord as a real work channel, not just a webhook:

- identifies who spoke and where
- checks whether the message is actually addressed to the agent
- records inbound messages in a durable inbox
- avoids routing conflicts when the agent is busy
- sends completed replies back through an outbox

> This lets it work in real group conversations instead of only in a local console.

### 🛠️ 3. ToolHub: real tool capabilities

AgentThursday can actually use tools and leave evidence behind. It can:

- read and write workspace files
- execute JavaScript/TypeScript snippets
- run heavier isolated commands in a sandbox
- use browser capabilities to inspect web pages
- write and recall memory
- search and read external content sources

> The important part is not the tool list; it is that important tool actions are logged. If the model claims it did something, users can verify it with traces and tool events.

### 📚 4. ContentHub: external content with provenance

AgentThursday can connect to external sources such as GitHub repositories or local fixture sources. It keeps the agent's scratch workspace separate from external sources to avoid “phantom reads”.

- list available sources and capabilities
- browse directories
- read files
- search source content
- run multi-source fan-out search
- record provenance for every read

Each successful read can carry source id, provider, path/object id, revision, fetched time, permission scope, and cache status. For the agent, this is evidence of what it actually saw; for users, it is a verifiable chain.

### 🔍 5. Multi-source search

AgentThursday can run one query across multiple sources without mixing everything into a vague flat list.

It keeps results grouped by source:

- which source succeeded
- which source does not support search
- what each source matched
- latency and error code per source

If one source fails, the others still return. That makes the result more useful in real scenarios.

### 🧩 6. Action-aware UI

AgentThursday's web UI is more than a log panel. It turns key agent actions into readable activity cards:

- search results: query, source, hit count, and path previews
- file reads: source, path, truncation state, and focusable path
- execution results: execution type, tier, preview, and sandbox info
- workspace changes: changed object plus a safe open action when a path is available
- repeated events: folded groups to prevent feed spam
- new activity: a non-intrusive badge when the user has scrolled away

This helps users clearly understand what the agent did and quickly see the results they care about.

### 📉 7. Degradation awareness

Real models are not always equally reliable. Some models call tools cleanly; others degrade into text-only imitation; streaming and structured output can also vary.

AgentThursday can expose those risks:

- model capability profiles are visible
- harness signals can be recorded and summarized
- unreliable paths can be degraded or marked
- warnings can be shown directly in the conversation
- Inspect can show the relevant trace

The goal is not to make the agent look smart at all times. The goal is to be honest when it is not reliable enough.

### 🔎 8. Evidence / Inspect

`/api/inspect` is AgentThursday's black-box replay surface. It can show:

- trace events produced by the agent
- tool calls the model actually made
- content sources read through ContentHub
- which sources each run touched
- which evidence came from model-driven activity versus direct API smoke tests

### ✅ 9. Truthfulness guard

If the agent says “I called a tool” but the current run has no matching tool event, the system can flag the mismatch.

> This is critical: do not judge only by how convincing the answer sounds; check whether the work actually happened. AgentThursday defaults toward verifiability.

---

## 🧪 Try it

- https://agent-thursday.domain-4c7.workers.dev/
- Contact me for an auth key.

---

## 🛫 Deployment

Deployment instructions live in separate docs:

- [Chinese deployment guide](./DEPLOY.md)
- [English deployment guide](./DEPLOY.en.md)

---

## 💻 Development

```bash
npm install
npm --prefix web install
npm run typecheck
npm run build:web
npm run dev
npm run deploy
```
