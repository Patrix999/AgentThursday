# AgentThursday Agent 操作手册

> **本手册由 AgentThursday 多 agent workflow 生产**（2026-06-10，an earlier revision dogfood）：
> 章节起草与互驳评审由 workflow run `wfr-exec-ca1dc1f8`（v4）与 `wfr-exec-38baea9a`（v3，第 4 章）的 subagents 完成；
> agentC 做了最终事实校订（模型示例名、origin/retention 取值、descriptor 形状、第 4 章访问方式、第 6 章会话语义），并重写第 5 章。
> 全程 ledger 可查：Console → Workflow Runs，或 `GET /api/inspect/workflow-runs/<run_id>`。

---

## 第1章 创建和管理 Agent

面向有一定技术背景的平台操作员。本章覆盖 agent 的查询、创建、更新、状态管理及常见故障排查。

---

### 1.1 查看现有 Agent 列表

在新增或修改 agent 前，应先调用 `manager_agent_list` 获取注册表全量，确认名称占用情况并记录目标标识符。

该工具**无参数**。

**请求示例：**
```json
{}
```

**响应示例：**
```json
{
  "ok": true,
  "count": 2,
  "agents": [
    {
      "id": "agent-f40b8842-f52a-4f04-8174-3b111bbc8fcc",
      "name": "site-copy-hero",
      "model": "kimi-k2.6",
      "channel": "#website",
      "skillset": "site-content",
      "persona": "你是一名网站文案写手……",
      "status": "initialized",
      "origin": "user_created",
      "parent_agent_id": null,
      "retention_policy": "durable",
      "accepts_tasks": true,
      "created_at": "2026-06-01T12:00:00Z",
      "updated_at": "2026-06-05T08:30:00Z"
    }
  ]
}
```

**返回字段说明：**

| 字段 | 说明 |
|------|------|
| `id` | Agent 在注册表中的全局唯一标识。后续调用 `manager_agent_update` 时，该值对应参数 `agent_id` |
| `name` | 可读名称。底层 Durable Object 实例名由该 name 稳定映射，不可通过改名改变 |
| `model` | 当前使用的模型标识 |
| `channel` | 默认消息频道 |
| `skillset` | 绑定的技能集 ID |
| `persona` | 角色描述 |
| `status` | 生命周期状态：`initialized` / `archived` / `deleted_marker` |
| `origin` | 创建来源：`user_created`（操作员创建）或 `spawned`（agent 派生） |
| `parent_agent_id` | 父级 agent ID，无则为 `null` |
| `retention_policy` | 数据保留策略，由系统统一管理 |
| `accepts_tasks` | 当前是否接受任务调度 |
| `created_at` / `updated_at` | ISO-8601 时间戳 |

> **操作提示**：如需查看已归档或已标记删除的 agent，当前注册表定义中包含这些状态，但 `manager_agent_list` 无过滤参数。是否展示全部状态取决于系统实现，请查阅 API 文档确认。

---

### 1.2 创建 Agent

使用 `manager_agent_create` 注册新 agent。该工具为**拒绝式写入**：若 `name` 已存在，直接返回 `name_conflict`，不会覆盖。

#### 1.2.1 字段与约束

| 字段 | 必填 | 约束 |
|------|------|------|
| `name` | 是 | 1–80 字符，全局唯一。将决定底层 DO 实例名 |
| `model` | 是 | 必须为当前构建支持的模型 |
| `skillset` | 是 | 必须已存在于技能集注册表 |
| `channel` | 否 | 默认消息频道 |
| `persona` | 否 | ≤ 2000 字符 |
| `status` | 否 | 枚举：`initialized`（默认）、`archived`、`deleted_marker` |

#### 1.2.2 标准操作流程

1. 执行 `manager_agent_list`，确认拟用的 `name` 未被占用。
2. （建议）执行 `manager_skillset_list`，确认 `skillset` 存在。
3. 调用 `manager_agent_create`，填入必填项与可选配置。
4. 记录返回中的 `id`，供后续更新使用。

#### 1.2.3 请求与响应示例

**创建请求：**
```json
{
  "name": "docs-reviewer",
  "model": "kimi-k2.6",
  "skillset": "doc-review",
  "channel": "#docs",
  "persona": "你是一名技术文档审校员，专注于风格一致性和术语准确性。"
}
```

**成功响应（返回完整记录）：**
```json
{
  "id": "agent-e5f6g7h8-1234-5678-90ab-cdefghijklmn",
  "name": "docs-reviewer",
  "model": "kimi-k2.6",
  "channel": "#docs",
  "skillset": "doc-review",
  "persona": "你是一名技术文档审校员，专注于风格一致性和术语准确性。",
  "status": "initialized",
  "origin": "user_created",
  "parent_agent_id": null,
  "retention_policy": "durable",
  "accepts_tasks": true,
  "created_at": "2026-06-10T14:22:11Z",
  "updated_at": "2026-06-10T14:22:11Z"
}
```

---

### 1.3 修改 Agent 配置

使用 `manager_agent_update` 变更已有 agent 的字段。

**必填参数：** `agent_id`（即 `manager_agent_list` 返回的 `id`）

**可更新字段：** `name`、`model`、`skillset`、`persona`、`channel`、`status`

> **重要约束**：改名不会修改底层 Durable Object 实例名。若新 `name` 与其他 agent 冲突，server 仍会返回 `name_conflict` 并拒绝。

#### 1.3.1 请求示例

**更新配置：**
```json
{
  "agent_id": "agent-e5f6g7h8-1234-5678-90ab-cdefghijklmn",
  "persona": "你是一名专注于 API 文档的结构化审校员。",
  "channel": "#api-docs"
}
```

**归档 agent：**
```json
{
  "agent_id": "agent-e5f6g7h8-1234-5678-90ab-cdefghijklmn",
  "status": "archived"
}
```

**恢复为活跃：**
```json
{
  "agent_id": "agent-e5f6g7h8-1234-5678-90ab-cdefghijklmn",
  "status": "initialized"
}
```

---

### 1.4 Agent 状态与生命周期

系统定义三种互斥状态：

| 状态 | 含义 | 典型使用场景 |
|------|------|--------------|
| `initialized` | 正常服务态 | agent 可接受任务、被 workflow 引用 |
| `archived` | 已归档 | 停止接受新任务，历史记录与配置保留，可随时切回 `initialized` |
| `deleted_marker` | 已标记删除 | 逻辑删除态，等待按 `retention_policy` 执行物理清理 |

#### `archived` 与 `deleted_marker` 的核心区别

- **`archived`**：软下线。数据完整保留，操作员可在需要时直接更新状态恢复服务。适用于临时停用或替换中的 agent。
- **`deleted_marker`**：删除标记。进入该状态后，agent 被视为已删除，系统将根据 `retention_policy` 在后续周期中清理相关持久化数据。恢复操作可能受限或不可行，取决于具体组织策略。

> **注意**：`retention_policy` 与 `accepts_tasks` 是独立的策略字段（an earlier revision 四层生命周期模型），不通过本工具的 `status` 自动联动。

---

### 1.5 常见错误与排查

| 错误码 | 触发场景 | 排查与处理 |
|--------|----------|------------|
| `name_conflict` | 创建或更名时 `name` 已存在 | 先执行 `manager_agent_list` 确认占用情况。若旧 agent 不再需要，可将其更新为 `archived` 或改用其他名称 |
| `unknown_model` | 模型标识无法识别 | 核对 `model` 拼写（区分大小写）；确认该模型是否已在当前 AgentThursday 构建中接入 |
| `unsupported_model` | 模型标识正确但当前环境不支持运行 | 查阅部署配置中的允许模型白名单，更换为已支持模型 |
| `unknown_skillset` | `skillset` 不存在 | 先调用 `manager_skillset_list` 查看已有技能集；如需自定义，先通过 `manager_skillset_create` 创建 |

---

### 1.6 操作速查表

| 目的 | 工具 | 关键要点 |
|------|------|----------|
| 查看全量列表 | `manager_agent_list` | 无参数；返回 `id`、`count`、`agents[]` |
| 新建 agent | `manager_agent_create` | `name`/`model`/`skillset` 必填；`name` 全局唯一且决定 DO 实例名 |
| 修改配置 | `manager_agent_update` | 必须提供 `agent_id`；改名不更换 DO 实例，仍受重名校验 |
| 归档 agent | `manager_agent_update` | 将 `status` 改为 `archived` |
| 删除标记 | `manager_agent_update` | 将 `status` 改为 `deleted_marker`；物理清理由系统策略驱动 |
```

---

## 2. 向 Agent 派发任务

### 2.1 单条消息派发

最简单的任务派发方式是通过 manager 向指定 agent 发送一条工作消息。您需要提供：

- `agent_id`：目标 agent 的唯一标识
- `text`：自然语言描述的任务内容

**示例：通过 Console 或 API 发送**

```json
{
  "agent_id": "agent-bdd58c91-d6bf-4036-8c5e-7346cb4e146c",
  "text": "请审阅 an earlier revision 的风险分析，重点检查 Cloudflare CPU 限制相关部分。"
}
```

**返回结果说明**

| 状态 | 含义 | 操作员下一步 |
|---|---|---|
| `replied` | Agent 已回复可见文本 | 阅读回复内容，决定是否需要进一步交互 |
| `accepted` | Agent 已接收任务但未产生可见回复 | 等待后续通知，或通过 `manager_subagent_summaries` 查询结果 |
| `failed` | 任务注入失败或 Agent 执行出错 | 检查失败原因，重试或转派给其他 Agent |

**重要限制**
- `text` 中严禁 inline 任何 secret、API key 或 persona-private 信息。敏感配置应通过 Console 环境变量或 KV binding 注入，不可出现在消息正文中。
- 如果该 Agent 正在执行其他任务，新消息会进入队列排队，不会直接抢占。

---

### 2.2 结构化任务派发（推荐）

对于复杂任务，应使用 `task_context` 提供结构化上下文，确保 Agent 明确理解目标、边界和交付标准。

**完整结构示例**

```json
{
  "agent_id": "agent-dc4bab52-69a5-49b7-a21d-b3fb4da528e6",
  "text": "完成 an earlier revision 的仓库准备工作",
  "task_context": {
    "id": "task-abc-123",
    "title": "Prepare repo worktree for an earlier revision",
    "objective": "调用 repo_prepare 并返回 head_sha、branch、worktree_path 和 git status",
    "source_agent_id": "agent-bdd58c91-d6bf-4036-8c5e-7346cb4e146c",
    "parent_task_id": "task-parent-789",
    "card_id": "382",
    "expected_outputs": [
      "repo_prepare 的完整返回对象",
      "git status 的 porcelain 输出"
    ],
    "non_goals": [
      "不要修改任何文件",
      "不要执行 repo_write 或 repo_patch"
    ],
    "house_rules": [
      "必须先调用 repo_prepare 才能进行后续写入操作",
      "如果 prepare 失败，立即终止并上报原因"
    ],
    "verification_hint": "确认 head_sha 为非空字符串且 git status 返回 0"
  }
}
```

**字段说明**

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 任务唯一标识，建议与 kanban card 或外部系统 ID 关联 |
| `title` | 是 | 任务标题，1–100 字符，用于快速识别 |
| `objective` | 是 | 目标描述，1–500 字符。当同时存在 `text` 和 `task_context` 时，**以 `objective` 为准** |
| `source_agent_id` | 否 | 发起任务的源 agent ID，用于审计和回传 |
| `parent_task_id` | 否 | 父任务 ID，用于构建任务层级。Manager 完成子任务后会自动推送 summary 到 registry |
| `card_id` | 否 | 关联的 kanban card，便于后续归档和跟踪 |
| `expected_outputs` | 否 | 字符串数组，明确列出期望的交付物 |
| `non_goals` | 否 | 字符串数组，明确排除的范围，防止 Agent 过度执行 |
| `house_rules` | 否 | 字符串数组，执行过程中的硬性约束（如"必须先调 X 才能调 Y"） |
| `verification_hint` | 否 | ≤500 字符，对结果验证方法的提示 |
| `artifact_refs` | 否 | 引用其他 agent 产出的 artifact，用于上下文传递。每个元素包含 `agent_id`、`artifact_id`、`task_id`、`kind` |

---

### 2.3 Artifact 引用传递

当子任务需要依赖其他 Agent 的先前产出时，通过 `artifact_refs` 传递：

```json
{
  "task_context": {
    "id": "task-derive-456",
    "title": "Generate deployment plan",
    "objective": "基于上一阶段架构评审产出部署计划",
    "artifact_refs": [
      {
        "agent_id": "agent-bdd58c91-d6bf-4036-8c5e-7346cb4e146c",
        "artifact_id": "arch-review-env-20250701",
        "task_id": "task-review-123",
        "kind": "summary"
      }
    ]
  }
}
```

**使用场景**
- 多阶段 workflow 中，下游 Agent 需要读取上游 Agent 的 summary、文件或日志
- 避免在 `text` 中大段复制粘贴先前结果，保持消息整洁

---

### 2.4 任务跟踪与结果回收

**查询任务状态**

任务派发后，操作员可通过以下方式跟踪：

1. **subagent_summaries 查询**（适用于 parent task 结构）
   ```json
   // 调用 manager_subagent_summaries
   {
     "parent_task_id": "task-parent-789",
     "limit": 20
   }
   ```
   返回各子任务的 summary、artifact_refs 和完成状态。

2. **workflow_status 查询**（适用于 workflow 编排）
   ```json
   // 调用 manager_workflow_status
   {
     "run_id": "wfr-exec-xxxxxxxx"
   }
   ```

**长时间任务的特别说明**
- 带 gate 的 subagent 工作（如 `gate_build`、`gate_typecheck`）可能需要 **30–60 分钟**
- 在此期间状态可能显示为 `accepted` 或无明显更新
- **不要过早断言失败**。应在提交后至少等待 30 分钟再检查 `manager_workflow_status` 或 `manager_subagent_summaries`

---

### 2.5 常见场景示例

**场景 A：简单问答**
```json
{
  "agent_id": "agent-qa-001",
  "text": "解释 Workers CPU 50ms 限制对 benchmark 的影响"
}
```

**场景 B：结构化开发任务**
```json
{
  "agent_id": "agent-dev-002",
  "text": "在 repo_prepare 后的 worktree 中实现 loop timeout 可观察性",
  "task_context": {
    "id": "task-m91a-001",
    "title": "M9.1a loop timeout observability",
    "objective": "在 managerAsyncTaskController.ts 中添加 10m timeout 检测日志并写入 state.loop_timeout_reason",
    "expected_outputs": ["console.warn 日志", "state 字段更新"],
    "non_goals": ["不实现完整 event emitting", "不修改 schema 之外的字段"],
    "verification_hint": "模拟超时后 GET /api/manager/tasks/:id 应返回 loop_timeout_reason",
    "card_id": "374"
  }
}
```

**场景 C：跨 Agent 依赖任务**
```json
{
  "agent_id": "agent-deploy-003",
  "text": "基于架构师的风险 review 完成部署",
  "task_context": {
    "id": "task-deploy-789",
    "title": "Deploy relay benchmark v0.2",
    "objective": "使用架构评审定稿内容部署 console 页面",
    "artifact_refs": [
      {
        "agent_id": "agent-arch-004",
        "artifact_id": "risk-review-v02",
        "task_id": "task-risk-456",
        "kind": "file"
      }
    ],
    "parent_task_id": "task-parent-999"
  }
}
```

---

### 2.6 最佳实践

**消息内容安全**
- 绝不在 `text` 或 `objective` 中 inline API key、password、或 persona 私有指令
- 若任务涉及敏感资源，在 `house_rules` 中声明权限边界，而非在消息中暴露凭证

**优先使用结构化派发**
- 简单闲聊可用纯 `text`
- 任何涉及交付、验证、多步骤的任务必须使用 `task_context`
- `objective` 与 prose 冲突时，Agent 以 `objective` 为准，因此需确保 `objective` 表述精确

**明确边界与规则**
- `expected_outputs` 和 `non_goals` 成对使用：前者定义"要做什么"，后者定义"不做什么"
- `house_rules` 用于硬性顺序约束（如"必须先 X 后 Y"），不应重复 `expected_outputs` 中的内容

**超时与重试策略**
- 普通任务预期在 5 分钟内响应
- 带 gate 的任务预留 30–60 分钟
- 若 `manager_agent_message` 返回 `failed` 且 `reason` 为 `agent_loop_timeout`，应告知操作员等待下一轮 inspect，而非立即重试

**避免过度分发**
- 每个 `agent_id` 必须真实存在。派发前通过 `manager_agent_list` 确认目标 agent 状态
- 不要为同一任务向多个 agent 重复发送相同消息，应使用 `workflow_execute` 进行正式编排
```

---

## 3. 跟踪 Workflow Run

### 3.1 启动 Run

向 manager 发起 `manager_workflow_execute`，传入完整的 workflow descriptor：

```json
{
  "descriptor": {
    "descriptor_id": "doc-draft-review",
    "name": "文档起草与核查",
    "caps": { "max_agents": 2, "max_concurrency": 1 },
    "phases": [
      {
        "phase_id": "draft",
        "name": "起草",
        "agents": [
          { "agent_id": "agent-aaaaaaaa-….", "prompt": "起草文档初稿……", "role": "writer" }
        ]
      },
      {
        "phase_id": "review",
        "name": "核查",
        "depends_on_phase_ids": ["draft"],
        "agents": [
          { "agent_id": "agent-bbbbbbbb-….", "prompt": "对初稿进行事实核查：{{draft.result}}", "role": "reviewer" }
        ]
      }
    ]
  }
}
```

**成功返回：**

```json
{
  "ok": true,
  "run_id": "wfr-exec-a1b2c3d4",
  "order": ["draft", "review"],
  "total_agents": 2
}
```

- `run_id`：本次运行的唯一标识，后续追踪状态必须使用此值。
- `total_agents`：descriptor 中参与本次运行的 agent 总数。
- `order`：按依赖关系拓扑排序后的 phase 执行顺序。

**失败返回：**

```json
{
  "ok": false,
  "errors": [
    "Phase 'review' 依赖的前置阶段 'draft' 不存在于 phases 列表中",
    "Agent 'agent-xxxxxxxx' 在当前环境中未注册"
  ]
}
```

若返回 `ok: false`，说明 descriptor 未通过校验。此时 **没有生成任何 run**，直接修正 descriptor 中的错误后重新发起 `manager_workflow_execute` 即可。

---

### 3.2 轮询 Run 状态

使用 `manager_workflow_status` 查询运行实况，必填参数只有 `run_id`：

```json
{
  "run_id": "wfr-exec-a1b2c3d4"
}
```

返回的树形状态包含完整的 phase → agents → status 层级。每个 agent 的状态只会是以下四种之一：

| 状态 | 含义 |
|:---|:---|
| `pending` | 等待前置依赖满足或引擎调度 |
| `running` | agent 正在执行指令 |
| `replied` | agent 已完成并返回结果 |
| `failed` | agent 执行失败，该 run 不会自动重试 |

操作员应定期检查 `failed` 状态的 agent，读取其附带错误信息，决定人工介入修复后复跑，还是在下游逻辑中跳过该节点。

---

### 3.3 保存工作流模板

对于需要反复执行的标准流程，先通过 `manager_workflow_save` 固化模板：

```json
{
  "name": "pubsite-release",
  "descriptor": { ... }
}
```

命名约束：

- 使用 `kebab-case`（短横线连接的小写字母与数字）
- 长度上限为 **64 字符**
- 若已存在同名模板，再次保存会自动升级版本号，不会报错

保存后，操作员无需在每次运行时重复粘贴完整 descriptor。

---

### 3.4 复用命名工作流

调用 `manager_workflow_run_named`，传入已保存的 `name` 即可启动：

```json
{
  "name": "pubsite-release"
}
```

若模板中的 prompt 使用了占位符（如 `{{args.env}}`），可通过可选的 `args` 填充：

```json
{
  "name": "pubsite-release",
  "args": {
    "env": "production"
  }
}
```

占位符仅在模板 prompt 字符串中生效；如果缺少对应 key，调用会返回 `missing_args` 列表并拒绝启动（fail-fast），按列表补齐后重试。另外，后续 phase 的 prompt 可用 `{{<前序phase_id>.result}}` 引用该 phase 全部 agent 的产出（执行时注入，上限 24KB）。

---

### 3.5 列出已保存模板

调用 `manager_workflow_list` 查看当前系统中所有已保存的工作流：

```json
{}
```

返回示例：

```json
[
  {
    "name": "pubsite-release",
    "version": 3,
    "phases": 4,
    "agents": 5,
    "updated_at": "2025-06-15T09:42:00Z"
  },
  {
    "name": "fact-review-batch",
    "version": 1,
    "phases": 2,
    "agents": 2,
    "updated_at": "2025-06-14T16:20:00Z"
  }
]
```

操作员可通过此列表确认模板版本、复杂度规模及最后更新时间，再决定调用 `manager_workflow_run_named` 复跑哪一个。

---

### 3.6 操作员速查

| 目标 | 调用 | 必填参数 |
|:---|:---|:---|
| 启动一次性 workflow | `manager_workflow_execute` | `descriptor` |
| 查看 run 实况 | `manager_workflow_status` | `run_id` |
| 保存可复用模板 | `manager_workflow_save` | `name`（≤64 字符，kebab-case）、`descriptor` |
| 复跑已保存模板 | `manager_workflow_run_named` | `name` |
| 列出已保存模板 | `manager_workflow_list` | 无 |

**关键提醒：**
- `manager_workflow_execute` 返回 `ok: false` 时，直接修复 descriptor 重发，无需追踪不存在的 `run_id`。
- `manager_workflow_run_named` 的 `args` 仅负责填充模板字符串中的占位符，不能修改 `descriptor` 结构本身；若需结构性变更，应更新模板后再保存。
```

---

## 4. 用 inspect 查证据

### 4.1 什么是 envelope

envelope（证据信封）是 AgentThursday 中每一次 agent 操作的最小审计单元。它完整记录了 agent 的"声称"与"实际做了什么"之间的对照，是操作员事后核查 agent 行为的唯一可信来源。

一个标准的 envelope 包含四层结构：

| 层次 | 用途 |
|---|---|
| intent | agent 声称要做的事 |
| execution | 实际执行的操作与工具调用痕迹 |
| evidence | 原始产物与中间数据 |
| self_verify | agent 对前三层的自检结论 |

四层数据相互独立，但逻辑上环环相扣。操作员审查时，**不可跳过 execution 直接采信 self_verify 的结论**。

### 4.2 四层结构详解

#### 4.2.1 intent（意图环）

记录 agent 在动作发生前的计划与声称：

- `description`：本次操作的自然语言描述
- `planned_tools`：声称要调用的工具列表
- `expected_params`：声称要传入的参数快照
- `expected_outcome`：对结果的预期描述

#### 4.2.2 execution（执行环）

记录真实发生的执行轨迹，包含不可篡改的时间戳和调用序列：

- `tool_calls[]`：每项包含工具名、精确参数、返回结果或异常
- `timestamp`：每次调用的 UTC 时间
- `call_order`：调用顺序编号，用于排查时序依赖问题

#### 4.2.3 evidence（证据环）

存放操作产生的原始数据，而非 agent 的转述：

- 文件 diff 原文
- 类型检查或构建的完整终端输出
- gate 运行的日志
- API 返回的原始 JSON

#### 4.2.4 self_verify（自验证环）

agent 在完成后对 envelope 的交叉检查：

- `truthfulness.check`：声称调用 vs 实际调用的比对结果
- `degradation`：若存在差异，标记差异级别与类型
- `check_timestamp`：自检完成时间

### 4.3 在 Console / API 查看证据

- Console 的 **Inspect** 面板展示当前 agent 的 envelope 列表、tool 事件流与审批记录。
- API：`GET /api/inspect/evidence`（envelope 列表）、`GET /api/inspect/evidence/:id`（单个 envelope）。默认读取当前活跃 agent 的 DO；要查看指定 agent，请求头加 `X-AgentThursday-Context-Id: <agent_id>`。
- Workflow run 维度：`GET /api/inspect/workflow-runs/:run_id` 返回 run → phases → agents 树（每个 agent 节点含 task_id，可进一步用 `GET /api/manager/tasks/:task_id` 取完整 reply）。

### 4.4 操作员判读要点

- envelope 的 `verdict`（pass/fail）由 seal 时对四环的核验决定；`fail` 常见原因：声称了未发生的工具调用（fabricated claim）、有 mutation 意图但无 mutation 证据、gate 失败。
- reply 前缀出现 "⚠️ Truthfulness gate" 警告时，按未验证处理：以 envelope 的 execution 环和 inspect 的 tool 事件为准，不采信文字声称。

---

## 5. Approvals 审批

> 本章由agentC 重写（agent 草稿与现实偏差过大，已声明于 provenance）。

### 5.1 审批机制概述

AgentThursday 中工具按风险分层（tier）。声明了 `needsApproval` 的高风险工具在 agent 调用时不会立即执行，而是挂起一条审批请求，等待操作员决定。审批由 HMAC token 背书：审批记录只存 `signature_hash` / `signature_ref`，原始签名不落库。

### 5.2 操作员审批流程

1. **看到请求**：Console 的 Inspect → Approvals 区块，或 `GET /api/inspect/approvals`，列出 pending 审批（工具名、参数摘要、发起 agent、时间）。
2. **决定**：`POST /api/inspect/approvals/decide` 批准或拒绝；Discord 出站审批消息也支持经频道回复决定（outbound approval 流）。
3. **执行**：批准后 agent 的下一轮会消费该审批并执行工具；拒绝则工具调用失败，agent 收到结构化拒绝原因。

### 5.3 注意事项

- **pending 审批会阻塞该任务的后续 step**：长时间不决定，任务会停在等待态；重跑取证前先把挂起的 pending 处理掉（deny 不会推进 state，approve 会）。
- 审批是一次性的：replay 消费有防重放校验（`approvals/replay-consume` 仅用于诊断）。
- 审批记录与 envelope 关联，事后可在 evidence 链中追溯"谁批了什么"。

---

## 6. Discord 使用指南

### 6.1 消息格式与交互机制

AgentThursday 通过 Discord channel 与操作员建立实时交互链路。agent 常驻于指定 channel，通过监听消息事件接收外部输入。

消息触发规则如下：

- **@mention 触发**：在 channel 中 `@agent-name` 或回复 agent 的消息，agent 会将其识别为需要响应的输入。
- **reply-to-agent**：若操作员点击 Discord 的"回复"功能回复某条 agent 消息，系统会标记为 `reply-to-agent`，自动保持同一会话线程，无需重复提供 context。
- **普通消息**：未提及 agent 的普通消息不会被 agent 处理，避免误触发。

每条进入系统的消息携带以下元数据：

| 字段 | 说明 |
|---|---|
| `from` | 发送者的 Discord 用户 ID |
| `conversation` | 当前会话 ID，用于串联同一主题的多轮对话 |
| `provider_message_id` | Discord 平台层面的原始消息 ID，用于追溯和引用 |

操作员应养成在回复时点击"回复"的习惯，以确保 conversation 连续性。若新开一条独立消息，系统可能将其视为全新任务，导致上下文丢失。

### 6.2 操作员基本行为

#### 6.2.1 向 manager agent 下达指令

所有任务派发起始于对 manager agent 的 `@mention`。指令应包含以下要素：

- **目标**：明确要做什么（例如："部署生产环境"或"起草操作手册第4章"）
- **约束**（可选）：时间要求、输出格式、必须遵守的规则
- **上下文**（可选）：关联的 task_id、envelope_id 或前期对话的引用

示例：
```
@manager-agent 启动 workflow：为 proof 页添加"证据信封"章节，要求包含真实 JSON 示例。关联 task_id wfr-exec-xxxxxxxx。
```

#### 6.2.2 会话连续性

同一 Discord 频道的对话绑定到同一个 agent 会话（conversation binding）。直接 @mention 或回复 agent 的消息都会进入该会话；agent 长时间无响应时，先确认消息确实形成了 @mention（昵称补全不一定生成真实 mention），再让管理员检查 gateway 轮询状态与 conversation binding。

#### 6.2.3 哪些内容会回到 Discord

- agent 的最终 reply 文本（含 envelope 标记，如 `[envelope: env-…]`）会作为频道消息回复。
- 系统注记（truthfulness 警告、"宣布了行动但未调用工具" 等）会随 reply 一起出现——这些是诚实机制的输出，应当认真对待。
- 附件/截图目前**不可出站**（仅文本）；需要文件类产物时让 agent 提供 artifact 引用或路径。
