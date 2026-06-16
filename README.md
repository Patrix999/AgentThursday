# Agent Thursday

> **Why Thursday?**
>
> Lighter than Friday but way better than Monday.

[English version](./README.en.md)

**AgentThursday** 是构建在 Cloudflare 上的开源云原生 serverless **多-agent** runtime。

它不是一个「套了聊天框的 prompt demo」。一个 Manager agent 可以创建、配置、编排一组专职 sub-agent；每个 agent 都能把一条消息变成可追踪的 durable task、按需加载 skillset 调用真实工具、读取外部资料、管理上下文、归档历史、留下证据链——整套运行由 durable workflow 编排、由可插拔模型驱动。

---

## 🟢 核心亮点

- **⚡️ 边缘运行**：部署在 Cloudflare Workers 上，天然 serverless、低运维、靠近用户。
- **🧠 持久状态**：用 Durable Objects 保存任务、记忆、workspace、channel、content、context 和 archive 状态；一次请求结束后 agent 不会“失忆”。
- **🤝 多-agent & Manager**：Manager agent 负责创建 / 配置 / 列出 / 派发给专职 sub-agent；每个 agent 有显式生命周期（draft / ready / disabled / archived）和自己的 durable 运行时，还能回收 sub-agent 的执行摘要。
- **🧱 Skillset 能力包**：agent 按需加载 skillset（工具 + 技能 + 分级安全策略 + 证据协议）；内置 manager / software-dev / observability / communication，也支持自定义 skillset。
- **⏱️ Durable agent run**：一次多步任务是一个 durable Cloudflare Workflow（`AgentRunWorkflow`），能扛 DO eviction、能为“等人类输入”暂停再恢复。
- **🧰 Orchestration-as-code**：把“phase / agent”声明式 descriptor 当成 durable Workflow 跑（`WorkflowExecutor`），并留下可 inspect 的 run 账本（run → phase → agent 树）。
- **🔌 可插拔模型 / 自带 key**：不锁死 Workers AI——provider-aware 模型解析支持 Workers AI + Anthropic + DeepSeek，可自带 API key、可在线发现模型；任何异常都 fail-soft 回落。
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
| **Durable Objects** | 保存每个 agent 的运行时状态、registry（agent profile / 凭证 / event log）、context 路由、channel 路由、content registry/cache/audit 状态。 |
| **Durable Object SQL storage** | 持久化 event log、inbox/outbox、content audit、conversation archive、retrieval log、agent profile、task 和 memory。 |
| **Workflows** | durable 多步 agent run 与 orchestration-as-code 执行（`AgentRunWorkflow` / `WorkflowExecutor`）；扛 eviction、可暂停恢复。 |
| **Workers AI** | agent 推理循环的默认模型绑定（可插拔到 Anthropic / DeepSeek）。 |
| **Browser Rendering** | 给 agent 提供无头浏览器能力。 |
| **Containers / Sandbox binding** | 提供更重的隔离执行层（代码 gate、沙盒命令）。 |
| **Workers Assets** | 同一部署中托管 Web 工作区 UI。 |
| **Version metadata** | 把当前部署的 version id / tag 暴露给运行时。 |
| **Wrangler** | 本地开发、secret 管理、生产部署。 |
| **Worker secrets / env bindings** | 保存渠道凭据、API secret、模型 provider key、source token 和运行配置。 |

---

## 🚀 能力说明

### 🧠 1. 持久任务循环

AgentThursday 可以把一次聊天消息变成一个可追踪的 durable task。任务状态、记忆、workspace、trace、工具记录和最终回复都会留在 Durable Object 里。

> 这意味着它不是“问一句答一句”的短记忆机器人，而是能持续推进任务、事后复盘过程、跨请求保留上下文的云端 agent。

### 🤝 2. 多-agent 编排（Manager）

AgentThursday 不止一个 agent。一个 Manager 负责把工作拆给专职 sub-agent：

- 创建 / 配置 / 列出 / 更新 agent（名字、模型、skillset、persona）
- 把任务派发给指定 agent，默认异步执行并可查状态
- 回收 sub-agent 的执行摘要，并按来源权限过滤
- 每个 agent 有显式生命周期：draft / ready / disabled / archived

> 单 operator、多 agent：一个人也能像带一个小团队一样指挥。

### ⏱️ 3. Durable agent run 与工作流

一次多步任务不是一个会断的 HTTP 请求，而是一个 durable Cloudflare Workflow：

- `AgentRunWorkflow`：多步 agent run，扛 DO eviction，可为“等人类回复”暂停再恢复
- `WorkflowExecutor`：把声明式的 phase / agent descriptor 当成 durable workflow 编排执行（orchestration-as-code）
- 可观测的 run 账本：run → phase → agent 的树状结构 + 事件，`/api/inspect/workflow-runs` 可回放

> 编排逻辑不再只活在某个 prompt 里，而是有结构、可追踪、能恢复的运行模型。

### 🧱 4. Skillset：可组合的能力包

agent 的能力不是写死的一坨工具，而是按需加载的 skillset：

- 每个 skillset 声明 tools + skills + 分级安全策略（per-tier 审批）+ 证据协议
- 内置：manager（编排）、software-dev（自我开发）、observability、communication
- 支持自定义 skillset，运行时可启用 / 禁用，inspect 可见当前 runtime 能力

> 换 skillset = 换这个 agent 现在“会做什么”，而不用改代码。

### 🔌 5. 可插拔模型 / 自带 key

AgentThursday 不锁死单一模型 provider：

- provider-aware 解析：Workers AI（免 key、默认）、Anthropic（claude-*）、DeepSeek
- 自带 API key（BYO），按 provider 在线发现可用模型
- 任何异常一律 fail-soft 回落 Workers AI，绝不把 agent 卡死

> 用免费的 Workers AI 起步，需要更强时插上自己的 key，不改架构。

### 🧭 6. 单一当前会话

AgentThursday 把多 context 技术对象收敛成更清晰的用户语义：

- 用户看到的是一个当前会话 / active context
- `context_active` 是 canonical source of truth
- header / localStorage 只是 cache 或 debug override
- `/api/workspace`、headerless `/cli/*`、ChannelHub / Discord ingress 都跟随当前 active context

> 技术上可以保留多个 context；产品上不把 session id 管理负担丢给用户。

### 🗄️ 7. Conversation Archive：历史不丢

旧对话不再只是“必须塞进 prompt 或被有损摘要”的上下文，而是持久、可搜索、可审计的 archive。

- `new context` 前归档正在关闭的 context
- `reset` 前先归档再清空 transient message history
- archive chunk 保留 contextId、message id、role、speaker、surface、task 等元数据

> reset/new 是清理当前工作窗口，不是删除历史。

### 🔎 8. Conversation Search：agent 可以搜索自己的过去

AgentThursday 有 agent-facing `conversation_search` 工具。它和另外两类“记忆/资料”严格区分：

- `recall`：搜索 agent_memory，适合稳定事实 / 指令 / 事件
- `conversation_search`：搜索历史 dialog archive，适合“之前我们聊过什么 / 上次那个 bug 怎么定的”
- `content_search`：搜索外部 Content Sources，例如 GitHub repo 或文档 source

每次检索都会写入 retrieval audit。

### 🧹 9. Context Hygiene：持续上下文卫生维护

Compact 不只是“手动救援按钮”，也可以成为保守的上下文卫生维护能力。

- 观察 context pressure / message count / token pressure / truncation
- 归档优先，审计优先
- 低风险范围可以自动 compact
- 高风险范围只提出计划，不自动越过审批、待人类决策、当前任务边界或未归档内容
- Inspect 可看到触发点、原因、前后计数、归档 refs 和 compact 结果

### 🧪 10. Memory Candidate Inspect：先看再写

AgentThursday 有只读 memory candidate inspect：系统先展示“哪些内容可能值得形成记忆”，而不是立刻把所有东西写进长期记忆。

当前策略是 dogfood-first：先观察真实对话、检索和采纳信号，再设计 promote / dismiss 流程。

> 记忆应该是“挣来的”，不是自动灌进去的。

### 📡 11. 真实渠道协作

AgentThursday 不把 Discord 当成简单 webhook，而是当成一个真实工作渠道：

- 识别谁在说话、在哪个 channel 里说话
- 判断消息是否真的在叫 agent
- 把 inbound message 变成 durable inbox 记录
- 忙的时候不乱抢任务，避免并发污染
- 处理完成后从 outbox 回到原始对话

> 这让它可以在真实群聊里工作，而不是只在本地控制台里演示。

### 🛠️ 12. ToolHub：真实工具能力

AgentThursday 的工具调用是可执行、可观察、可复核的。它可以：

- 读写 workspace 文件
- 执行 JS/TS 代码片段
- 进入 sandbox 做更重的隔离执行
- 调用浏览器能力观察网页
- 写入和读取 memory
- 搜索历史对话 archive
- 搜索、读取外部资料 source

> 关键点不是“能列出很多工具”，而是每次重要工具行为都会留下事件。模型如果声称自己做了某件事，用户可以用 trace 和 tool events 去核对。

### 📚 13. ContentHub：带 provenance 的外部资料访问

AgentThursday 可以连接外部资料源，例如 GitHub repository 或本地 fixture source。它会把 agent 自己的 scratch workspace 和外部 source 明确分开，避免“幻读”。

- 列出可用 source 和能力
- 浏览目录
- 读取文件内容
- 搜索 source 内容
- 多 source fan-out 搜索
- 记录每次读取的 provenance

每次成功读取都会带上 source id、provider、path/object id、revision、fetched time、permission scope 和 cache status。对 agent 来说，这是“我真的看过哪里”的证据；对用户来说，这是可验证的链路。

### 🧩 14. 工具感知界面

AgentThursday 的 Web UI 不只是日志面板。它会把 agent 的关键行为转成更容易理解的 activity cards 和 inspect panels：

- 搜索结果：显示 query、source、命中数量和路径预览
- 文件读取：显示 source、path、截断状态和可聚焦路径
- 执行结果：显示执行类型、tier、preview 和 sandbox 信息
- workspace 变更：显示变更对象，并在有安全路径时提供打开入口
- context indicator：显示当前 context / context pressure / compact 相关状态
- 主对话：保持 YOU / AGT 干净，不混入 SUM、tool preview、developer preview 或截断尾巴

这让用户不仅清楚 agent 做了什么，也能方便看到需要的结果。

### 📉 15. 降智感知

现实里的模型能力并不总是稳定：有的模型 tool calling 可靠，有的会退化成文本假装，有的 streaming 或结构化输出不稳定。

AgentThursday 会把这类风险显式暴露出来：

- 模型能力 profile 可见
- harness signal 可被记录和汇总
- 不可靠路径可以被降级或标记
- 对话里直接提示用户
- inspect 里能看到相关 trace

目标不是让 agent 永远显得聪明，而是在它不够可靠时诚实地告诉你。

### 🔎 16. Evidence / Inspect

`/api/inspect` 是 AgentThursday 的黑匣子回放入口。它可以查看：

- agent 做过哪些 trace event
- 模型实际发起过哪些 tool calls
- ContentHub 读过哪些 source
- 每轮 run 触达过哪些资料
- workflow run 的阶段 / agent 账本
- archive / retrieval / hygiene 的审计记录
- 哪些 evidence 来自模型驱动，哪些来自 direct API smoke

### ✅ 17. Truthfulness guard

如果 agent 说“我调用了某工具”，但当前 run 里没有对应 tool event，系统可以标记这种不一致。

> 这是非常关键的一点：不是看它说得像不像，而是看它有没有真的做。AgentThursday 默认站在“可验证”这一边。

### 🧰 18. 自我开发与 gate（进阶）

`software-dev` skillset 让 agent 能在受控边界内参与代码开发：

- repo 读 / grep / glob 定位，最小 patch / write
- 沙盒 gate：typecheck / build / test，保留 stdout / exit 证据
- `patch.validate`：hunk 审计 + `git apply --check` + 隔离 apply + 新文件校验
- 高危动作（commit / push / deploy）走分级审批，留审批证据

> 让 agent 改代码，但每一步都要有 gate 和证据，而不是“我改好了”一句话。

---

## 🧪 上手体验

- 订阅版 https://agentthursday.com/

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
