# Agent Thursday

> **Why Thursday?**
>
> Lighter than Friday but way better than Monday.

[中文版 / Chinese default](./README.md)

**AgentThursday** is an open-source cloud-native serverless **multi-agent** runtime built on Cloudflare.

It is not a prompt demo with a chat box attached. A Manager agent can create, configure, and orchestrate a team of specialized sub-agents; each agent can turn a message into a trackable durable task, load skillsets to call real tools, read external sources, manage context, archive history, and leave an auditable evidence trail — all orchestrated by durable workflows and driven by pluggable models.

---

## 🟢 Highlights

- **⚡️ Edge-native runtime**: runs on Cloudflare Workers, close to users and with minimal operations overhead.
- **🧠 Durable state**: Durable Objects keep tasks, memory, workspace, channel, content, context, and archive state alive across requests.
- **🤝 Multi-agent & Manager**: a Manager agent creates, configures, lists, and dispatches work to specialized sub-agents; each agent has an explicit lifecycle (draft / ready / disabled / archived), its own durable runtime, and reportable sub-agent execution summaries.
- **🧱 Skillsets**: agents load capability packs on demand (tools + skills + tiered safety policy + evidence protocol); built-ins like manager / software-dev / observability / communication, plus custom skillsets.
- **⏱️ Durable agent runs**: a multi-step run is a durable Cloudflare Workflow (`AgentRunWorkflow`) that survives DO eviction and can pause for human input and resume.
- **🧰 Orchestration-as-code**: a declarative phase / agent descriptor runs as a durable Workflow (`WorkflowExecutor`), with an observable run ledger (run → phase → agent) you can inspect.
- **🔌 Pluggable models / bring-your-own key**: not locked to Workers AI — provider-aware model resolution for Workers AI + Anthropic + DeepSeek, with bring-your-own API keys, live model discovery, and fail-soft fallback.
- **🧭 Single active conversation**: the user-facing model is one current context per agent; old conversations move into archive/search instead of asking users to manage session ids.
- **🗄️ Conversation Archive**: before `new context` or `reset`, old dialog is archived so history is not lost when the active context is cleaned.
- **🔎 Conversation Search**: the agent can use `conversation_search` to retrieve prior cross-session dialog and leave a retrieval audit trail.
- **🧹 Context Hygiene**: context cleanup is not only a manual reset; the system can observe pressure, propose or apply safe compaction, and keep audit evidence.
- **📉 Model degradation awareness**: when model capability becomes unstable, tool calls are missing, or results look unreliable, AgentThursday can surface the risk instead of pretending everything is fine.
- **🧩 Action-aware UI**: the web UI turns search, file reads, execution, workspace changes, and context state into readable action cards and panels.
- **🛠️ ToolHub**: tools are callable, auditable, traceable capabilities — not verbal promises inside a prompt.
- **📡 ChannelHub**: multi-channel messages enter a durable inbox and replies leave through an outbox, with real routing and busy-state protection for group workflows.
- **📚 ContentHub**: agents can read external sources such as GitHub while preserving revision, path, cache, permission, and provenance metadata.
- **🔐 Truthfulness Guard**: if the agent claims it used a tool but the trace shows no matching dispatch, the system can flag the mismatch.
- **More features are under construction..**

---

## ☁️ Cloudflare components used

| Cloudflare component | Purpose |
|---|---|
| **Workers** | Main HTTP/API entrypoint, web app, Discord interactions, tool APIs, and inspect APIs. |
| **Durable Objects** | Per-agent runtime state, the registry (agent profiles / credentials / event log), context routing, channel routing, and content registry/cache/audit state. |
| **Durable Object SQL storage** | Persistent event logs, inbox/outbox rows, content audit rows, conversation archive, retrieval log, agent profiles, task state, and memory. |
| **Workflows** | Durable multi-step agent runs and orchestration-as-code execution (`AgentRunWorkflow` / `WorkflowExecutor`); survive eviction, pause and resume. |
| **Workers AI** | Default model binding for the agent reasoning loop (pluggable to Anthropic / DeepSeek). |
| **Browser Rendering** | Headless browser capability for web inspection tasks. |
| **Containers / Sandbox binding** | Heavier isolated execution layer (code gates, sandboxed commands). |
| **Workers Assets** | Hosts the web workspace UI in the same deployment. |
| **Version metadata** | Surfaces the deployed version id / tag to the runtime. |
| **Wrangler** | Local development, secret management, and production deployment. |
| **Worker secrets / env bindings** | Stores channel credentials, API secrets, model provider keys, source tokens, and runtime config. |

---

## 🚀 Capabilities

### 🧠 1. Durable task loop

AgentThursday can turn a chat message into a durable task. Task state, memory, workspace files, traces, tool records, and final replies remain in Durable Objects.

> That makes it more than a short-memory Q&A bot: it can keep moving tasks forward, preserve context across requests, and let users inspect what happened after the fact.

### 🤝 2. Multi-agent orchestration (Manager)

AgentThursday is more than a single agent. A Manager divides work across specialized sub-agents:

- create / configure / list / update agents (name, model, skillset, persona)
- dispatch a task to a chosen agent, async by default, with status lookup
- collect sub-agent execution summaries, filtered by source permission
- each agent has an explicit lifecycle: draft / ready / disabled / archived

> Single operator, multiple agents: one person can direct what feels like a small team.

### ⏱️ 3. Durable agent runs and workflows

A multi-step task is not a fragile HTTP request — it is a durable Cloudflare Workflow:

- `AgentRunWorkflow`: a multi-step agent run that survives DO eviction and can pause to wait for a human reply, then resume
- `WorkflowExecutor`: runs a declarative phase / agent descriptor as a durable workflow (orchestration-as-code)
- an observable run ledger: a run → phase → agent tree plus events, replayable via `/api/inspect/workflow-runs`

> Orchestration logic no longer lives only inside a prompt; it becomes a structured, trackable, resumable run model.

### 🧱 4. Skillsets: composable capability packs

An agent's abilities are not a hard-wired pile of tools but skillsets loaded on demand:

- each skillset declares tools + skills + a tiered safety policy (per-tier approval) + an evidence protocol
- built-ins: manager (orchestration), software-dev (self-development), observability, communication
- custom skillsets are supported, can be enabled / disabled at runtime, and the current runtime capability is visible in inspect

> Switching skillset changes what this agent "can do" right now — without changing code.

### 🔌 5. Pluggable models / bring-your-own key

AgentThursday is not locked to a single model provider:

- provider-aware resolution: Workers AI (no key, default), Anthropic (claude-*), DeepSeek
- bring your own API key (BYO) and discover available models per provider, live
- any failure fails soft back to Workers AI and never wedges the agent

> Start on free Workers AI; plug in your own key when you need more power — no architecture change.

### 🧭 6. Single active conversation

AgentThursday consolidates multiple technical context objects into a clearer user-facing model:

- the user sees one current conversation / active context
- `context_active` is the canonical source of truth
- headers and localStorage are only cache or debug overrides
- `/api/workspace`, headerless `/cli/*`, and ChannelHub / Discord ingress follow the current active context

> The system can keep multiple technical contexts, but it should not make users manage session ids.

### 🗄️ 7. Conversation Archive: history is not lost

Old dialog becomes a durable, searchable, auditable archive instead of context that must always fit into the prompt or be lossy-summarized.

- archive the closing context before `new context`
- archive before clearing transient message history on `reset`
- archive chunks retain contextId, message id, role, speaker, surface, task metadata, and timestamps
- long histories use a dedicated archive path instead of the last-N limit of the UI inspect view

> reset/new cleans the active working window; it should not delete history.

### 🔎 8. Conversation Search: the agent can search its past

AgentThursday has an agent-facing `conversation_search` tool. It is intentionally distinct from two other retrieval surfaces:

- `recall`: searches agent memory for stable facts, instructions, and events
- `conversation_search`: searches historical dialog archive, for questions like “what did we discuss before?” or “how did we decide that bug?”
- `content_search`: searches external Content Sources such as GitHub repos or document sources

Every retrieval is audited. If there are no hits, the agent should say “archive had no hits” honestly instead of claiming it has no cross-session search capability.

### 🧹 9. Context Hygiene: continuous context cleanup

Compaction can be more than a manual rescue button: it can be a conservative context hygiene capability.

- observe context pressure, message count, token pressure, and truncation
- archive first, audit first
- auto-compact only low-risk ranges
- propose plans instead of crossing approvals, pending human decisions, active task boundaries, or unarchived material
- Inspect can show trigger, reason, before/after counts, archive refs, and compaction result

### 🧪 10. Memory Candidate Inspect: look before writing

AgentThursday has a read-only memory candidate inspect surface. The system first shows which items may deserve memory instead of immediately writing everything into long-term memory.

The current posture is dogfood-first: collect real dialog, retrieval, and acceptance signals before designing promote / dismiss flows.

> Memory should be earned, not automatically dumped in.

### 📡 11. Real channel collaboration

AgentThursday treats Discord as a real work channel, not just a webhook:

- identifies who spoke and where
- checks whether the message is actually addressed to the agent
- records inbound messages in a durable inbox
- avoids routing conflicts when the agent is busy
- sends completed replies back through an outbox

> This lets it work in real group conversations instead of only in a local console.

### 🛠️ 12. ToolHub: real tool capabilities

AgentThursday can actually use tools and leave evidence behind. It can:

- read and write workspace files
- execute JavaScript/TypeScript snippets
- run heavier isolated commands in a sandbox
- use browser capabilities to inspect web pages
- write and recall memory
- search historical conversation archive
- search and read external content sources

> The important part is not the tool list; it is that important tool actions are logged. If the model claims it did something, users can verify it with traces and tool events.

### 📚 13. ContentHub: external content with provenance

AgentThursday can connect to external sources such as GitHub repositories or local fixture sources. It keeps the agent's scratch workspace separate from external sources to avoid “phantom reads”.

- list available sources and capabilities
- browse directories
- read files
- search source content
- run multi-source fan-out search
- record provenance for every read

Each successful read can carry source id, provider, path/object id, revision, fetched time, permission scope, and cache status. For the agent, this is evidence of what it actually saw; for users, it is a verifiable chain.

### 🧩 14. Action-aware UI

AgentThursday's web UI is more than a log panel. It turns key agent actions into readable activity cards and inspect panels:

- search results: query, source, hit count, and path previews
- file reads: source, path, truncation state, and focusable path
- execution results: execution type, tier, preview, and sandbox info
- workspace changes: changed object plus a safe open action when a path is available
- context indicator: current context, context pressure, and compaction-related state
- main dialog: clean YOU / AGT dialog without SUM rows, tool previews, developer previews, or truncation tails

This helps users clearly understand what the agent did and quickly see the results they care about.

### 📉 15. Degradation awareness

Real models are not always equally reliable. Some models call tools cleanly; others degrade into text-only imitation; streaming and structured output can also vary.

AgentThursday can expose those risks:

- model capability profiles are visible
- harness signals can be recorded and summarized
- unreliable paths can be degraded or marked
- warnings can be shown directly in the conversation
- Inspect can show the relevant trace

The goal is not to make the agent look smart at all times. The goal is to be honest when it is not reliable enough.

### 🔎 16. Evidence / Inspect

`/api/inspect` is AgentThursday's black-box replay surface. It can show:

- trace events produced by the agent
- tool calls the model actually made
- content sources read through ContentHub
- which sources each run touched
- the phase / agent ledger of a workflow run
- archive / retrieval / hygiene audit records
- which evidence came from model-driven activity versus direct API smoke tests

### ✅ 17. Truthfulness guard

If the agent says “I called a tool” but the current run has no matching tool event, the system can flag the mismatch.

> This is critical: do not judge only by how convincing the answer sounds; check whether the work actually happened. AgentThursday defaults toward verifiability.

### 🧰 18. Self-development and gates (advanced)

The `software-dev` skillset lets an agent participate in code development within controlled boundaries:

- read / grep / glob the repo to locate code, then minimal patch / write
- sandbox gates: typecheck / build / test, preserving stdout / exit evidence
- `patch.validate`: hunk audit + `git apply --check` + isolated apply + new-file checks
- high-risk actions (commit / push / deploy) go through tiered approval with approval evidence

> Let the agent change code — but every step needs a gate and evidence, not just “I fixed it.”

---

## 🧪 Try it

- Visit https://agentthursday.com/ for subsciption

---

## 🛫 Deployment

Current deployment notes live here:

- [Chinese deployment guide](./DEPLOY.md)
- [Deployment guide](./DEPLOY.en.md)

---

## 📄 License

This project is open-sourced under the [Apache License 2.0](./LICENSE).

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

Secrets are managed through Wrangler and local development var files. Do not paste tokens into chat, logs, README examples, task reports, or commits.
