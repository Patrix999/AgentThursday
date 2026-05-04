# Agent Thursday

> **Why Thursday?**
>
> Lighter than Friday but way better than Monday.

[English version](./README.en.md)

**AgentThursday** 是构建在 Cloudflare 上的开源云原生 serverless agent runtime。

它不是一个「套了聊天框的 prompt demo」，而是一套可以长期在线、接入真实渠道、调用真实工具、读取外部资料、管理上下文、归档历史、留下证据链的 agent runtime。

---

## 🟢 核心亮点

- **⚡️ 边缘运行**：部署在 Cloudflare Workers 上，天然 serverless、低运维、靠近用户。
- **🧠 持久状态**：用 Durable Objects 保存任务、记忆、workspace、channel、content、context 和 archive 状态；一次请求结束后 agent 不会“失忆”。
- **🧭 单一当前会话**：用户层收敛为“一个 agent 一个当前 context”；旧会话进入 archive/search，而不是让用户管理一堆 session id。
- **🗄️ Conversation Archive**：`new context` / `reset` 前先归档旧对话，历史不会因为清理上下文而丢失。
- **🔎 Conversation Search**：agent 可以用 `conversation_search` 检索跨 session 的历史对话，并留下 retrieval audit。
- **🧹 Context Hygiene**：上下文不只靠手动 reset；系统能持续观察压力、提议或执行安全 compact，并保留审计轨迹。
- **📉 模型降智感知**：当模型能力不稳定、工具调用缺失或结果不可靠时，系统能把风险显式暴露出来，而不是假装一切正常。
- **🧩 动作感知界面**：Web UI 会把搜索、文件读取、执行、workspace 变更、上下文状态等行为展示成可读的 action cards / panels。
- **🛠️ ToolHub**：工具不是 prompt 里的口头承诺，而是可调用、可审计、可追溯的能力层。
- **📡 ChannelHub**：多渠道消息接入 durable inbox，处理后从 outbox 回复；支持真实群聊里的任务路由和忙碌态保护。
- **📚 ContentHub**：agent 可以读取 GitHub 等外部 source，并保留 revision、path、cache、permission、provenance 信息。
- **🔐 Truthfulness Guard**：如果 agent 声称调用了某工具，但 trace 里没有对应 dispatch，系统会标记这种不一致。
- **更多能力正在建设中..**

---

## ☁️ 使用的 Cloudflare 组件

| Cloudflare 组件 | 用途 |
|---|---|
| **Workers** | 主 HTTP/API 入口、Web app、Discord interaction、工具 API、inspect API。 |
| **Durable Objects** | 保存 agent 状态、context 路由状态、channel 路由状态、content registry/cache/audit 状态。 |
| **Durable Object SQL storage** | 持久化 event log、inbox/outbox、content audit、conversation archive、retrieval log、task 和 memory。 |
| **Workers AI** | agent 推理循环的模型绑定。 |
| **Browser Rendering** | 给 agent 提供无头浏览器能力。 |
| **Containers / Sandbox binding** | 提供更重的隔离执行层。 |
| **Workers Assets** | 同一部署中托管 Web 工作区 UI。 |
| **Wrangler** | 本地开发、secret 管理、生产部署。 |
| **Worker secrets / env bindings** | 保存渠道凭据、API secret、source token 和运行配置。 |

---

## 🚀 能力说明

### 🧠 1. 持久任务循环

AgentThursday 可以把一次聊天消息变成一个可追踪的 durable task。任务状态、记忆、workspace、trace、工具记录和最终回复都会留在 Durable Object 里。

> 这意味着它不是“问一句答一句”的短记忆机器人，而是能持续推进任务、事后复盘过程、跨请求保留上下文的云端 agent。

### 🧭 2. 单一当前会话

AgentThursday 把多 context 技术对象收敛成更清晰的用户语义：

- 用户看到的是一个当前会话 / active context
- `context_active` 是 canonical source of truth
- header / localStorage 只是 cache 或 debug override
- `/api/workspace`、headerless `/cli/*`、ChannelHub / Discord ingress 都跟随当前 active context

> 技术上可以保留多个 context；产品上不把 session id 管理负担丢给用户。

### 🗄️ 3. Conversation Archive：历史不丢

旧对话不再只是“必须塞进 prompt 或被有损摘要”的上下文，而是持久、可搜索、可审计的 archive。

- `new context` 前归档正在关闭的 context
- `reset` 前先归档再清空 transient message history
- archive chunk 保留 contextId、message id、role、speaker、surface、task/card 等元数据

> reset/new 是清理当前工作窗口，不是删除历史。

### 🔎 4. Conversation Search：agent 可以搜索自己的过去

AgentThursday 有 agent-facing `conversation_search` 工具。它和另外两类“记忆/资料”严格区分：

- `recall`：搜索 agent_memory，适合稳定事实 / 指令 / 事件
- `conversation_search`：搜索历史 dialog archive，适合“之前我们聊过什么 / 上次那个 bug 怎么定的”
- `content_search`：搜索外部 Content Sources，例如 GitHub repo 或文档 source

每次检索都会写入 retrieval audit。

### 🧹 5. Context Hygiene：持续上下文卫生维护

Compact 不只是“手动救援按钮”，也可以成为保守的上下文卫生维护能力。

- 观察 context pressure / message count / token pressure / truncation
- 归档优先，审计优先
- 低风险范围可以自动 compact
- 高风险范围只提出计划，不自动越过审批、待人类决策、当前任务边界或未归档内容
- Inspect 可看到触发点、原因、前后计数、归档 refs 和 compact 结果

### 🧪 6. Memory Candidate Inspect：先看再写

AgentThursday 有只读 memory candidate inspect：系统先展示“哪些内容可能值得形成记忆”，而不是立刻把所有东西写进长期记忆。

当前策略是 dogfood-first：先观察真实对话、检索和采纳信号，再设计 promote / dismiss 流程。

> 记忆应该是“挣来的”，不是自动灌进去的。

### 📡 7. 真实渠道协作

AgentThursday 不把 Discord 当成简单 webhook，而是当成一个真实工作渠道：

- 识别谁在说话、在哪个 channel 里说话
- 判断消息是否真的在叫 agent
- 把 inbound message 变成 durable inbox 记录
- 忙的时候不乱抢任务，避免并发污染
- 处理完成后从 outbox 回到原始对话

> 这让它可以在真实群聊里工作，而不是只在本地控制台里演示。

### 🛠️ 8. ToolHub：真实工具能力

AgentThursday 的工具调用是可执行、可观察、可复核的。它可以：

- 读写 workspace 文件
- 执行 JS/TS 代码片段
- 进入 sandbox 做更重的隔离执行
- 调用浏览器能力观察网页
- 写入和读取 memory
- 搜索历史对话 archive
- 搜索、读取外部资料 source

> 关键点不是“能列出很多工具”，而是每次重要工具行为都会留下事件。模型如果声称自己做了某件事，用户可以用 trace 和 tool events 去核对。

### 📚 9. ContentHub：带 provenance 的外部资料访问

AgentThursday 可以连接外部资料源，例如 GitHub repository 或本地 fixture source。它会把 agent 自己的 scratch workspace 和外部 source 明确分开，避免“幻读”。

- 列出可用 source 和能力
- 浏览目录
- 读取文件内容
- 搜索 source 内容
- 多 source fan-out 搜索
- 记录每次读取的 provenance

每次成功读取都会带上 source id、provider、path/object id、revision、fetched time、permission scope 和 cache status。对 agent 来说，这是“我真的看过哪里”的证据；对用户来说，这是可验证的链路。

### 🧩 10. 工具感知界面

AgentThursday 的 Web UI 不只是日志面板。它会把 agent 的关键行为转成更容易理解的 activity cards 和 inspect panels：

- 搜索结果：显示 query、source、命中数量和路径预览
- 文件读取：显示 source、path、截断状态和可聚焦路径
- 执行结果：显示执行类型、tier、preview 和 sandbox 信息
- workspace 变更：显示变更对象，并在有安全路径时提供打开入口
- context indicator：显示当前 context / context pressure / compact 相关状态
- 主对话：保持 YOU / AGT 干净，不混入 SUM、tool preview、developer preview 或截断尾巴

这让用户不仅清楚 agent 做了什么，也能方便看到需要的结果。

### 📉 11. 降智感知

现实里的模型能力并不总是稳定：有的模型 tool calling 可靠，有的会退化成文本假装，有的 streaming 或结构化输出不稳定。

AgentThursday 会把这类风险显式暴露出来：

- 模型能力 profile 可见
- harness signal 可被记录和汇总
- 不可靠路径可以被降级或标记
- 对话里直接提示用户
- inspect 里能看到相关 trace

目标不是让 agent 永远显得聪明，而是在它不够可靠时诚实地告诉你。

### 🔎 12. Evidence / Inspect

`/api/inspect` 是 AgentThursday 的黑匣子回放入口。它可以查看：

- agent 做过哪些 trace event
- 模型实际发起过哪些 tool calls
- ContentHub 读过哪些 source
- 每轮 run 触达过哪些资料
- archive / retrieval / hygiene 的审计记录
- 哪些 evidence 来自模型驱动，哪些来自 direct API smoke

### ✅ 13. Truthfulness guard

如果 agent 说“我调用了某工具”，但当前 run 里没有对应 tool event，系统可以标记这种不一致。

> 这是非常关键的一点：不是看它说得像不像，而是看它有没有真的做。AgentThursday 默认站在“可验证”这一边。

---

## 🧪 上手体验

- https://agent-thursday.domain-4c7.workers.dev/
- 联系我获取 auth key

---

## 🛫 部署

当前部署说明见：

- [部署指南](./DEPLOY.md)
- [English deployment guide](./DEPLOY.en.md)

---

## 📄 开源协议

本项目使用 [Apache License 2.0](./LICENSE) 开源。

---

## 💻 开发

```bash
npm install
npm --prefix web install
npm run typecheck
npm run build:web
npm run dev
npm run deploy
```

Secrets 通过 Wrangler 和本地开发变量文件管理。不要把 token 写进聊天、日志、README 示例、任务报告或 commit。
