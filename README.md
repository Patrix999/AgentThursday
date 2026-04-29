# Agent Thursday

> **Why Thursday?**
>
> Lighter than Friday but way better than Monday.

[English version](./README.en.md)


**AgentThursday** 是首个构建在 Cloudflare 上的开源云原生 serverless agent 平台。

它不是一个「套了聊天框的 prompt demo」，而是一套可以长期在线、接入真实渠道、调用真实工具、读取外部资料、留下证据链的 agent runtime。

---

## 🟢 核心亮点

- **⚡️ 边缘运行**：部署在 Cloudflare Workers 上，天然 serverless、低运维、靠近用户。
- **🧠 持久状态**：用 Durable Objects 保存任务、记忆、workspace、channel 和 content 状态；一次请求结束后 agent 不会“失忆”。
- **📉 模型降智感知**：当模型能力不稳定、工具调用缺失或结果不可靠时，系统能把风险显式暴露出来，而不是假装一切正常。
- **🧩 动作感知界面**：Web UI 会把搜索、文件读取、执行、workspace 变更等行为展示成可读的 action cards，让人一眼看懂 agent 正在做什么。
- **🛠️ ToolHub**：工具不是 prompt 里的口头承诺，而是可调用、可审计、可追溯的能力层。
- **📡 ChannelHub**：多渠道消息接入 durable inbox，处理后从 outbox 回复；支持真实群聊里的任务路由和忙碌态保护。
- **📚 ContentHub**：agent 可以读取 GitHub 等外部 source，并保留 revision、path、cache、permission、provenance 信息。
- **🔎 Inspect / Audit**：trace、tool events、content audit、evidence summary 都能复盘，适合 demo、评审和调试。
- **更多功能正在建设中..**
---

## ☁️ 使用的 Cloudflare 组件

| Cloudflare 组件 | 用途 |
|---|---|
| **Workers** | 主 HTTP/API 入口、Web app、Discord interaction、工具 API、inspect API。 |
| **Durable Objects** | 保存 agent 状态、channel 路由状态、content registry/cache/audit 状态。 |
| **Durable Object SQL storage** | 持久化 event log、inbox/outbox、content audit、任务和 memory。 |
| **Workers AI** | agent 推理循环的模型绑定。 |
| **Browser Rendering** | 给 agent 提供无头浏览器能力。 |
| **Containers / Sandbox binding** | 提供更重的隔离执行层。 |
| **Workers Assets** | 同一部署中托管 Web 工作区 UI。 |
| **Wrangler** | 本地开发、secret 管理、生产部署。 |
| **Worker secrets / env bindings** | 保存渠道凭据、API secret、source token 和运行配置。 |

---

## 🚀 能力说明

### 🧠 1. 持久任务循环

AgentThursday 可以把一次聊天消息变成一个可追踪的 durable task。任务的状态、记忆、workspace、trace、工具记录和最终回复都会留在 Durable Object 里。

> 这意味着它不是“问一句答一句”的短记忆机器人，而是能持续推进任务、事后复盘过程、跨请求保留上下文的云端 agent。

### 📡 2. 真实渠道协作

AgentThursday 不把 Discord 当成简单 webhook，而是当成一个真实工作渠道：

- 识别谁在说话、在哪个 channel 里说话
- 判断消息是否真的在叫 agent
- 把 inbound message 变成 durable inbox 记录
- 忙的时候不乱抢任务，避免并发污染
- 处理完成后从 outbox 回到原始对话

> 这让它可以在真实群聊里工作，而不是只在本地控制台里演示。

### 🛠️ 3. ToolHub：真实工具能力

AgentThursday 的工具调用是可执行、可观察、可复核的。它可以：

- 读写 workspace 文件
- 执行 JS/TS 代码片段
- 进入 sandbox 做更重的隔离执行
- 调用浏览器能力观察网页
- 写入和读取 memory
- 搜索、读取外部资料 source

> 关键点不是“能列出很多工具”，而是每次重要工具行为都会留下事件。模型如果声称自己做了某件事，用户可以用 trace 和 tool events 去核对。

### 📚 4. ContentHub：带 provenance 的外部资料访问

AgentThursday 可以连接外部资料源，例如 GitHub repository 或本地 fixture source。它会把 agent 自己的 scratch workspace 和外部 source 明确分开，避免“幻读”。

- 列出可用 source 和能力
- 浏览目录
- 读取文件内容
- 搜索 source 内容
- 多 source fan-out 搜索
- 记录每次读取的 provenance

每次成功读取都会带上 source id、provider、path/object id、revision、fetched time、permission scope 和 cache status。对 agent 来说，这是“我真的看过哪里”的证据；对用户来说，这是可验证的链路。

### 🔍 5. 多 source 搜索

AgentThursday 可以用一次 query 同时搜索多个 source，并且不会把结果混成一团。

它会按 source 单独展示：

- 哪个 source 成功
- 哪个 source 不支持 search
- 每个 source 命中了什么
- 每个 source 的延迟和错误码

如果一个 source 失败，其他 source 的结果仍然保留。这比“只返回一个模糊列表”更适合真实场景。

### 🧩 6. 工具感知界面

AgentThursday 的 Web UI 不只是日志面板。它会把 agent 的关键行为转成更容易理解的 activity cards：

- 搜索结果：显示 query、source、命中数量和路径预览
- 文件读取：显示 source、path、截断状态和可聚焦路径
- 执行结果：显示执行类型、tier、preview 和 sandbox 信息
- workspace 变更：显示变更对象，并在有安全路径时提供打开入口
- 高频事件：自动折叠成 group，避免 action feed 被刷屏
- 新 activity：用户滚走时只显示提示，不强行跳回顶部

这让用户不仅清晰的了解到agent做了什么，更能方便的看到需要的结果。

### 📉 7. 降智感知

现实里的模型能力并不总是稳定：有的模型 tool calling 可靠，有的会退化成文本假装，有的 streaming 或结构化输出不稳定。

AgentThursday 会把这类风险显式暴露出来：

- 模型能力 profile 可见
- harness signal 可被记录和汇总
- 不可靠路径可以被降级或标记
- 对话里直接提示用户
- inspect 里能看到相关 trace

目标不是让 agent 永远显得聪明，而是在它不够可靠时诚实地告诉你。

### 🔎 8. Evidence / Inspect

`/api/inspect` 是 AgentThursday 的黑匣子回放入口。它可以查看：

- agent 做过哪些 trace event
- 模型实际发起过哪些 tool calls
- ContentHub 读过哪些 source
- 每轮 run 触达过哪些资料
- 哪些 evidence 来自模型驱动，哪些来自 direct API smoke

### ✅ 9. Truthfulness guard

如果 agent 说“我调用了某工具”，但当前 run 里没有对应 tool event，系统可以标记这种不一致。

> 这是非常关键的一点：不是看它说得像不像，而是看它有没有真的做。AgentThursday 默认站在“可验证”这一边。

---

## 🧪 上手体验

- https://agent-thursday.domain-4c7.workers.dev/
- 联系我获取auth key


---

## 🛫 部署

部署说明已移到独立文档：

- [中文部署指南](./DEPLOY.md)
- [English deployment guide](./DEPLOY.en.md)

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
