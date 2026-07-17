// GENERATED — DO NOT EDIT BY HAND.
// Source: docs/skillsets/*.yaml
// Regenerate via: npm run skillset:generate
// CI guard:        npm run skillset:check
//
// an earlier revision M8.7 — yaml → embedded manifest codegen.
// This file is BUILD-TIME reload, not production hot reload. To
// pick up a yaml change, regenerate and redeploy the Worker.

/* eslint-disable */
// prettier-ignore

import type { SkillsetManifest } from "./types";
import type { EmbeddedManifest } from "./manifests";

const ARTIFACT_DELIVERY_YAML: string = "# Artifact Delivery skillset v0.1.0\n#\n# an earlier revision M8.8 — wraps the an earlier revision workspace artifact share API\n# as agent-callable dynamic tools. Lets agentD (and agentC / agentP) deliver\n# patch / test_doc / smoke_json / completion_report artifacts via a\n# stable tool surface instead of fyi.md relay or Discord paste.\n#\n# Tools are all backed by DO callables on `AgentThursdayAgent`:\n#   - artifact.write → AgentThursdayAgent.writeArtifact (validation, secret\n#     scan, size cap, envelope build in `src/artifactShare.ts`)\n#   - artifact.read  → AgentThursdayAgent.readArtifact\n#   - artifact.list  → AgentThursdayAgent.listArtifacts\n#\n# Scope constraints (from 245e card body):\n#   - no github.pr.create / branch / push;\n#   - no envelope signing;\n#   - no arbitrary repo file read/write — paths are bounded to\n#     `tmp/artifact/<card_id>/<filename>`;\n#   - no `AGENT_THURSDAY_SHARED_SECRET` leak: this skillset is reachable via\n#     the agent tool surface, not via HTTP, so no secret handling\n#     lives here.\n\nid: artifact-delivery\nname: Artifact Delivery\ndescription: 让 agent 把 patch / test_doc / smoke_json / completion_report 工件写入当前 agent workspace 并回读 / 列出。仅访问 tmp/artifact/<card_id>/<filename>，不写仓库、不发 PR、不暴露 secret。\nversion: 0.1.0\npurpose: expose artifact.write / artifact.read / artifact.list as callable dynamic tools so producer agents can deliver verifiable artifacts without fyi.md relay\n\ntools:\n  - artifact.write\n  - artifact.read\n  - artifact.list\n\nskills:\n  - id: artifact.deliver.write\n    name: Write artifact\n    description: 调用 artifact.write 把一段 UTF-8 文本（patch / test_doc / smoke_json / completion_report）写入当前 card 的 artifact 目录，得到 envelope（sha256 + size_bytes + transport_uri）。\n    tier: 3\n    tools:\n      - artifact.write\n    prompt_segment: |\n      当卡片要求\"交付 patch / test doc / smoke json / completion report\"且 verifier 需要可下载 artifact 时，优先调用 artifact.write，不要走 fyi.md relay 或 Discord paste。\n      必须字段：cardId、filename、type、sourceAgent、content。type 只能是 patch / test_doc / smoke_json / completion_report；directory_bundle v1 不支持。\n      写之前自检 content：不放 secret（AKIA / ghp_ / sk- / Bearer / PRIVATE KEY 等），超过类型 size cap 时先拆分。\n      调用成功后把 envelope.transport_uri 写进通知 / 测试文档，让 verifier 用 /api/artifact/<card_id>/<filename> 复核。\n    capability_class: callable_tool_ready\n    source_ref:\n      provider: internal\n      reference: docs/tools/artifact.write.0.1.0.yaml\n    evidence_requirements:\n      - envelope.sha256\n      - envelope.size_bytes\n      - envelope.transport_uri\n\n  - id: artifact.deliver.read\n    name: Read artifact\n    description: 调用 artifact.read 把先前写入的 envelope + UTF-8 body 读回。常用于自检 sha / size 一致或者复用 artifact 当 prompt 上下文。\n    tier: 2\n    tools:\n      - artifact.read\n    prompt_segment: |\n      需要复核刚 artifact.write 的内容、或者引用某张 card 上已存在的 artifact 作为后续推理输入时，调用 artifact.read（cardId + filename）。\n      返回的 envelope.sha256 / size_bytes 应该和 write 阶段一致，不一致说明 workspace 被改过，记为可疑。\n    capability_class: callable_tool_ready\n    source_ref:\n      provider: internal\n      reference: docs/tools/artifact.read.0.1.0.yaml\n    evidence_requirements:\n      - envelope.sha256\n      - envelope.size_bytes\n\n  - id: artifact.deliver.list\n    name: List artifacts\n    description: 调用 artifact.list 列出当前 card 已经写入的所有 envelope（不含 body 内容）。\n    tier: 2\n    tools:\n      - artifact.list\n    prompt_segment: |\n      verifier / 操作员问\"这张 card 已经交付了哪些 artifact\"时调用 artifact.list（仅 cardId），返回 envelopes[]，把 filename / type / sha256 / size_bytes 总结成清单。\n      card 目录不存在时会返回 envelopes=[]，这表示尚未交付任何 artifact，不是错误。\n    capability_class: callable_tool_ready\n    source_ref:\n      provider: internal\n      reference: docs/tools/artifact.list.0.1.0.yaml\n    evidence_requirements:\n      - envelopes\n\nworkflow_patterns:\n  - name: deliver-then-notify\n    when: 卡片要求agentD / agentC 把 patch / test_doc / smoke 落地为 artifact 供 verifier 复核\n    steps:\n      - 调用 artifact.write 把内容写入 tmp/artifact/<card_id>/<filename>\n      - 把返回 envelope 的 sha256 / size_bytes / transport_uri 抄进通知 / 测试文档\n      - verifier 用 /api/artifact/<card_id>/<filename> 拉回比对（属于 verifier 侧动作）\n    completion_signal: artifact.write 返回 ok=true 且 envelope.sha256 与本地计算一致\n\n  - name: self-check-before-handoff\n    when: 在交接给 verifier 之前确认 artifact 已落地且未被改写\n    steps:\n      - 调用 artifact.list 看 envelope 是否齐全\n      - 必要时再 artifact.read 比对 sha256 / size_bytes\n      - 不一致时重写或回报问题，不要默认通过\n    completion_signal: list 中包含期望的 filename 且 read 出来的 sha256 与 write 阶段返回一致\n\nreasoning_protocol:\n  principles:\n    - artifact 写入会进 DO workspace 并持久化，不要往里塞口令 / token / private key\n    - filename 必须匹配 [A-Za-z0-9._-]+；不允许 ../ 或 .env / .git / secrets 前缀\n    - 超过 size cap 时拆分，不要试图压缩绕过\n  anti_patterns:\n    - 不要再用 fyi.md relay 交付 patch；artifact.write 才是正路\n    - 不要把 content 直接贴到 Discord 当通知正文（超 2000 char、信息密度低）\n    - 不要把 envelope 的 producer_user_id / sha256 用 redact / fake 值充数\n\nevidence_protocol:\n  protocol_version: \"0.1.0\"\n\nsafety_policy:\n  policy_version: \"0.1.0\"\n  path_allowlist: []\n  path_denylist:\n    - \"**\"\n  cross_repo_writes: denied\n\nobservability:\n  emit_events:\n    - skillset.artifact-delivery.load\n    - skillset.artifact-delivery.unload\n  inspect_surfaces:\n    - /api/inspect/skillset/artifact-delivery\n\npolicy:\n  surface_modes: [enable, readonly]\n  default_tier_cap: 3\n  load_priority: 30\n";
const ARTIFACT_DELIVERY_MANIFEST = ({
  "id": "artifact-delivery",
  "name": "Artifact Delivery",
  "description": "让 agent 把 patch / test_doc / smoke_json / completion_report 工件写入当前 agent workspace 并回读 / 列出。仅访问 tmp/artifact/<card_id>/<filename>，不写仓库、不发 PR、不暴露 secret。",
  "version": "0.1.0",
  "purpose": "expose artifact.write / artifact.read / artifact.list as callable dynamic tools so producer agents can deliver verifiable artifacts without fyi.md relay",
  "tools": [
    "artifact.write",
    "artifact.read",
    "artifact.list"
  ],
  "skills": [
    {
      "id": "artifact.deliver.write",
      "name": "Write artifact",
      "description": "调用 artifact.write 把一段 UTF-8 文本（patch / test_doc / smoke_json / completion_report）写入当前 card 的 artifact 目录，得到 envelope（sha256 + size_bytes + transport_uri）。",
      "tier": 3,
      "tools": [
        "artifact.write"
      ],
      "prompt_segment": "当卡片要求\"交付 patch / test doc / smoke json / completion report\"且 verifier 需要可下载 artifact 时，优先调用 artifact.write，不要走 fyi.md relay 或 Discord paste。\n必须字段：cardId、filename、type、sourceAgent、content。type 只能是 patch / test_doc / smoke_json / completion_report；directory_bundle v1 不支持。\n写之前自检 content：不放 secret（AKIA / ghp_ / sk- / Bearer / PRIVATE KEY 等），超过类型 size cap 时先拆分。\n调用成功后把 envelope.transport_uri 写进通知 / 测试文档，让 verifier 用 /api/artifact/<card_id>/<filename> 复核。",
      "capability_class": "callable_tool_ready",
      "source_ref": {
        "provider": "internal",
        "reference": "docs/tools/artifact.write.0.1.0.yaml"
      },
      "evidence_requirements": [
        "envelope.sha256",
        "envelope.size_bytes",
        "envelope.transport_uri"
      ]
    },
    {
      "id": "artifact.deliver.read",
      "name": "Read artifact",
      "description": "调用 artifact.read 把先前写入的 envelope + UTF-8 body 读回。常用于自检 sha / size 一致或者复用 artifact 当 prompt 上下文。",
      "tier": 2,
      "tools": [
        "artifact.read"
      ],
      "prompt_segment": "需要复核刚 artifact.write 的内容、或者引用某张 card 上已存在的 artifact 作为后续推理输入时，调用 artifact.read（cardId + filename）。\n返回的 envelope.sha256 / size_bytes 应该和 write 阶段一致，不一致说明 workspace 被改过，记为可疑。",
      "capability_class": "callable_tool_ready",
      "source_ref": {
        "provider": "internal",
        "reference": "docs/tools/artifact.read.0.1.0.yaml"
      },
      "evidence_requirements": [
        "envelope.sha256",
        "envelope.size_bytes"
      ]
    },
    {
      "id": "artifact.deliver.list",
      "name": "List artifacts",
      "description": "调用 artifact.list 列出当前 card 已经写入的所有 envelope（不含 body 内容）。",
      "tier": 2,
      "tools": [
        "artifact.list"
      ],
      "prompt_segment": "verifier / 操作员问\"这张 card 已经交付了哪些 artifact\"时调用 artifact.list（仅 cardId），返回 envelopes[]，把 filename / type / sha256 / size_bytes 总结成清单。\ncard 目录不存在时会返回 envelopes=[]，这表示尚未交付任何 artifact，不是错误。",
      "capability_class": "callable_tool_ready",
      "source_ref": {
        "provider": "internal",
        "reference": "docs/tools/artifact.list.0.1.0.yaml"
      },
      "evidence_requirements": [
        "envelopes"
      ]
    }
  ],
  "workflow_patterns": [
    {
      "name": "deliver-then-notify",
      "when": "卡片要求agentD / agentC 把 patch / test_doc / smoke 落地为 artifact 供 verifier 复核",
      "steps": [
        "调用 artifact.write 把内容写入 tmp/artifact/<card_id>/<filename>",
        "把返回 envelope 的 sha256 / size_bytes / transport_uri 抄进通知 / 测试文档",
        "verifier 用 /api/artifact/<card_id>/<filename> 拉回比对（属于 verifier 侧动作）"
      ],
      "completion_signal": "artifact.write 返回 ok=true 且 envelope.sha256 与本地计算一致"
    },
    {
      "name": "self-check-before-handoff",
      "when": "在交接给 verifier 之前确认 artifact 已落地且未被改写",
      "steps": [
        "调用 artifact.list 看 envelope 是否齐全",
        "必要时再 artifact.read 比对 sha256 / size_bytes",
        "不一致时重写或回报问题，不要默认通过"
      ],
      "completion_signal": "list 中包含期望的 filename 且 read 出来的 sha256 与 write 阶段返回一致"
    }
  ],
  "reasoning_protocol": {
    "principles": [
      "artifact 写入会进 DO workspace 并持久化，不要往里塞口令 / token / private key",
      "filename 必须匹配 [A-Za-z0-9._-]+；不允许 ../ 或 .env / .git / secrets 前缀",
      "超过 size cap 时拆分，不要试图压缩绕过"
    ],
    "anti_patterns": [
      "不要再用 fyi.md relay 交付 patch；artifact.write 才是正路",
      "不要把 content 直接贴到 Discord 当通知正文（超 2000 char、信息密度低）",
      "不要把 envelope 的 producer_user_id / sha256 用 redact / fake 值充数"
    ]
  },
  "evidence_protocol": {
    "protocol_version": "0.1.0"
  },
  "safety_policy": {
    "policy_version": "0.1.0",
    "path_allowlist": [],
    "path_denylist": [
      "**"
    ],
    "cross_repo_writes": "denied"
  },
  "observability": {
    "emit_events": [
      "skillset.artifact-delivery.load",
      "skillset.artifact-delivery.unload"
    ],
    "inspect_surfaces": [
      "/api/inspect/skillset/artifact-delivery"
    ]
  },
  "policy": {
    "surface_modes": [
      "enable",
      "readonly"
    ],
    "default_tier_cap": 3,
    "load_priority": 30
  }
}) as unknown as SkillsetManifest;

const MANAGER_YAML: string = "# Manager skillset v0.1.0\n#\n# an earlier revision M9.0 — the first \"管理者\" skillset. Bundles three\n# capabilities so a manager agent can perform the audited management\n# actions the operator's M9.0 hypothesis depends on, without leaking secrets,\n# bypassing validation, or smuggling in arbitrary code execution:\n#\n#   1. manager.agent.lifecycle  — create / update / list cloud agents\n#   2. manager.skillset.author  — create / update / read / list skillsets\n#   3. manager.agent.communicate — message a target agent by agent_id\n#\n# Hard scope (an earlier revision explicit non-goals):\n#   - never expose git.push / deploy.wrangler / secret-bearing tools\n#   - never permit inline tool implementation (custom skillsets\n#     compose existing tool contracts only)\n#   - never fall back to a global \"active\" agent for messaging —\n#     agent_message MUST take an explicit agent_id (an earlier revision\n#     agent-centric routing invariant)\n\nid: manager\nname: Manager\ndescription: 让 manager agent 通过受控的 first-party tools 管理其他 cloud agents：lifecycle（新建/修改 agent）、skillset authoring（新建/修改 custom skillset）、agent-to-agent communication。所有动作可审计；不暴露 secret、不能执行任意代码。\nversion: 0.4.0\npurpose: equip a manager agent with audited tools for cloud agent lifecycle, custom skillset authoring, and direct agent-to-agent messaging\n\ntools:\n  - manager.agent_list\n  - manager.agent_create\n  - manager.agent_update\n  - manager.skillset_list\n  - manager.skillset_read\n  - manager.skillset_create\n  - manager.skillset_update\n  - manager.agent_message\n  - manager.subagent_summaries\n  - manager.task_merge\n  - manager.task_complete\n  - manager.workflow_execute\n  - manager.workflow_status\n  - manager.workflow_save\n  - manager.workflow_list\n  - manager.workflow_run_named\n  - manager.schedule_create\n  - manager.schedule_list\n  - manager.schedule_cancel\n\nskills:\n  - id: manager.agent.lifecycle\n    name: Agent lifecycle\n    description: 创建新 cloud agent 或修改 name / model / skillset / persona / status。任何写操作前必须先 manager.agent_list 确认当前状态。\n    tier: 2\n    tools:\n      - manager.agent_list\n      - manager.agent_create\n      - manager.agent_update\n    prompt_segment: |\n      管理 agent 生命周期前一定要先调用 manager.agent_list 拿到现状；不要凭记忆操作。\n      创建 agent 必须显式给出 name / model / skillset；persona 可空。\n      修改 agent 必须明确指定 agent_id，不能根据 name 模糊匹配。\n      不要尝试物理改 agent_id；DO instance name 在 an earlier revision 之后是稳定主键。\n      遇到 name_conflict / unknown_model / unsupported_model / unknown_skillset 时把原始错误码透传给操作员，不要静默重试。\n    capability_class: callable_tool_ready\n    source_ref:\n      provider: internal\n      reference: docs/tools/manager.agent_list.0.1.0.yaml\n    evidence_requirements:\n      - agent_id\n\n  - id: manager.skillset.author\n    name: Skillset authoring\n    description: 创建 / 修改 / 读取 / 列出 custom skillsets。custom skillset 只能组合已注册的 tool contracts；embedded skillset 不可修改。\n    tier: 2\n    tools:\n      - manager.skillset_list\n      - manager.skillset_read\n      - manager.skillset_create\n      - manager.skillset_update\n    prompt_segment: |\n      创建 / 修改 custom skillset 前先 manager.skillset_list 看一遍已有 id，避免和 embedded 撞名。\n      manifest 里的 tools 字段只能写已存在的 tool_id；不能在 manifest 里发明新工具实现。\n      尝试修改 embedded skillset 会被 server 用 embedded_skillset_readonly 拒绝；不要绕。\n      manifest 必须含 id / name / description / version / purpose / tools / skills；每个 skill 至少有 id / name / tier(1-5) / tools。\n      不要把 secret / env binding 值写进 manifest。\n    capability_class: callable_tool_ready\n    source_ref:\n      provider: internal\n      reference: docs/tools/manager.skillset_create.0.1.0.yaml\n    evidence_requirements:\n      - skillset_id\n\n  - id: manager.agent.communicate\n    name: Agent communication\n    description: 向指定 agent_id 发送一条工作消息 / 指令。返回 task_id + envelope + visible reply 或 accepted/failed 状态。\n    tier: 3\n    tools:\n      - manager.agent_message\n    prompt_segment: |\n      发消息必须指定 target agent_id；没有 agent_id 时先 manager.agent_list 拿到。\n      不要替对方 agent 编造 reply；返回 evidence 区分 replied / accepted / failed 三态。\n      status == \"failed\" 且 reason == \"agent_loop_timeout\" 时不要假装消息没送出 —— 任务已注入对方 DO；告诉操作员等下一轮 inspect 查实际 reply。\n      不要在消息文本里 inline 任何 AGENT_THURSDAY_SHARED_SECRET / API key / persona-private 信息。\n      派活给 subagent 时尽量同时填 `task_context`（结构化的 id/title/objective；可选 expected_outputs/non_goals/verification_hint 等）。subagent 第一轮会看到 `<task-context>` JSON 块；objective 与 prose 冲突时以 objective 为准。`text` 自然语言部分保留不变。\n      `task_context.parent_task_id` / `source_agent_id` 一般不用手填：除非你要跨 manager / 跨链 dispatch，否则默认继承你当前外层 `manager_task_id`（见你 first turn 里的 `<manager-context>` 块）与你自己的 agent_id；显式传入仍然生效（用于覆盖）。\n    capability_class: callable_tool_ready\n    source_ref:\n      provider: internal\n      reference: docs/tools/manager.agent_message.0.1.0.yaml\n    evidence_requirements:\n      - agent_id\n      - task_id\n\n  - id: manager.schedule.automation\n    name: Schedule management\n    description: 给自己 owner 编队里的 agent（含子代理）创建 / 列出 / 取消定时任务。用户要求\"每天/每周/定期让某个 agent 做 X\"时用这组工具，不要用消息中转或 memory 模拟定时。\n    tier: 2\n    tools:\n      - manager.schedule_create\n      - manager.schedule_list\n      - manager.schedule_cancel\n    prompt_segment: |\n      用户要求某个 agent 定期做事时，用 manager.schedule_create 直接给目标 agent 建排程（agent_id 必填）；给自己建用 base 的 schedule_create 即可。\n      daily/weekly 必须带 utc_offset_minutes（不知道用户时区就先问）；建完把返回的 next_run_at 复述给用户核对。\n      建新排程前先 manager.schedule_list 查重；取消用 schedule_id 精确指定。\n      平台安全阀（每 owner 上限 / 最小间隔 15 分钟 / 连续失败自动停）由服务端强制，遇到 schedule_cap_exceeded / interval_too_short 把错误码透传给用户。\n    capability_class: callable_tool_ready\n    source_ref:\n      provider: internal\n      reference: docs/tools/manager.schedule_create.0.1.0.yaml\n    evidence_requirements:\n      - schedule_id\n\n  - id: manager.subagent.review\n    name: Subagent summary review\n    description: 读取本 manager 派出去的 subagent 完成情况摘要（bounded reply_excerpt + 自报 artifact_refs + completed_at）。仅能读自己派的工作（按 source_agent_id 隔离，跨 manager 查询返回空 list）。\n    tier: 1\n    tools:\n      - manager.subagent_summaries\n    prompt_segment: |\n      派活时若用了 task_context.parent_task_id，subagent 完成后会自动 push 一份 summary 到 registry，可以用 manager.subagent_summaries 查回。\n      过滤可用 parent_task_id（一般就是你自己的 outer task_id）或 source_agent_id；limit 默认 20，最大 50。\n      跨 manager 查询会得到 empty list 而不是 error —— 不要把空 list 当成 subagent 没完成，要结合 task status 一起判断。\n      summary.reply_excerpt 是 bounded 截断（≤500 UTF-8 bytes），不要把它当完整 reply；完整 reply 仍在 subagent 自己的 inspect / envelope 里。\n      summary.artifact_refs 是 subagent 自报的；v1 不跨 DO 拉内容，要核实 artifact 内容请用 subagent 的 artifact.* tools。\n    capability_class: callable_tool_ready\n    source_ref:\n      provider: internal\n      reference: docs/tools/manager.subagent_summaries.0.1.0.yaml\n    evidence_requirements:\n      - parent_task_id\n\n  - id: manager.task.merge\n    name: Audit-grade task merge\n    description: 读完 subagent summaries 之后，把结构化 merge verdict 写进 parent task 的 event_log，形成可审计的 `manager.task.merged` 事件。与 `manager.task.replied` 并存；事件存在才算 audit-grade merge。\n    tier: 2\n    tools:\n      - manager.task_merge\n    prompt_segment: |\n      调用顺序：先 manager.subagent_summaries 读到本 manager 自己的 subagent 摘要，再用 manager.task_merge 落 merge event；不要在没看 summary 的情况下乱填 refs。\n      每个 subagent_task_refs 元素必填 task_id / agent_id / summary_id / verdict；verdict ∈ {success, partial, failed, ignored}；summary_id v1 语义上等同于 subagent 自己的 task_id（与 manager.subagent.summary 一致）。\n      merge_verdict ∈ {success, partial, failed}，反映 manager 对整个 parent task 的 merge 判断；它不会替代 manager.task.replied 的最终 reply 文本。\n      不要把别的 manager 的 summary 塞进 refs；server 会按 source_agent_id 边界拒绝并返回 permission_denied。\n      summary_id 与 ref.task_id / agent_id 必须匹配，否则会返回 ref_mismatch；不要凭记忆瞎写。\n      zero-ref merge 是允许的（明确记录 \"我没并任何 subagent 工作\"），但请在 note 里说明原因，否则审计时分不清是逻辑还是漏看。\n      不要手填 merged_at（除非你在跑测试需要 deterministic 时间）；不要试图改 manager_agent_id，server 会用 calling agent_id 覆盖。\n    capability_class: callable_tool_ready\n    source_ref:\n      provider: internal\n      reference: docs/tools/manager.task_merge.0.1.0.yaml\n    evidence_requirements:\n      - parent_task_id\n      - merge_verdict\n\n  - id: manager.task.complete\n    name: Task completion report\n    description: 在 manager 完成一张 parent task（通常先 task_merge → task.replied）之后，调用 manager.task_complete 记录结构化的 completion report（verdict、summary、可选 evidence / next_step / card_ref）。这是 report/归档 evidence，不替代 replied/failed 终态，也不改 an earlier revision status derivation。\n    tier: 2\n    tools:\n      - manager.task_complete\n    prompt_segment: |\n      调用顺序：先 manager.task_merge 落 audit-grade merge，再 manager.task_complete 写 completion report；不要在没 merge 的情况下直接 success complete（server 会以 validation_failed 拒绝，message 会点名 allow_without_merge）。\n      completion_verdict ∈ {success, partial, failed}；success 默认要有同 parent_task_id 的 manager.task.merged 事件，否则 server 返回 validation_failed（message 包含 allow_without_merge）。\n      如果确实没有 merge（例如纯 advisory 任务、纯 doc 卡），可以显式 allow_without_merge=true 并在 allow_without_merge_reason 里写明原因；空 reason 会被 validation_failed 拒绝。\n      summary 写 120-500 字范围的完成摘要即可，server 会按 2000 UTF-8 bytes 上限校验；不要把整段 subagent reply、prompt、secret 抄进 summary。\n      evidence.merge_event_id 来自 manager.subagent_summaries / merge reader 的 event_id；subagent_task_ids 来自实际 subagent 的 task_id；envelope_id 来自 manager.task.replied 的 envelope_id。这些字段都是可选的，但有就尽量填。\n      next_step 写一句操作员下一步行动（\"操作员需要把 PR 提交到 main\" 之类），不要写多段。\n      card_ref 用来反指 kanban 卡，例如 {card_id: \"377\", path: \"docs/kanban/377-....md.done.verified\"}。\n      不要试图改 manager_agent_id，server 会用 calling agent_id 覆盖。\n      多次 complete 是允许的（修正报告 / 补 evidence），reader 会取 latest 并返回 completion_count。\n    capability_class: callable_tool_ready\n    source_ref:\n      provider: internal\n      reference: docs/tools/manager.task_complete.0.1.0.yaml\n    evidence_requirements:\n      - parent_task_id\n      - completion_verdict\n\n  - id: manager.workflow.orchestrate\n    name: Workflow orchestration\n    description: 把目标固化为声明式 workflow descriptor（phases / agents / deps / caps），交给 durable executor 执行，并用 run_id 观察 run → phases → agents 树。这是\"plan 活在数据里\"的派活方式：比逐条 agent_message 更可观察、可复跑、可审计。\n    tier: 3\n    tools:\n      - manager.workflow_execute\n      - manager.workflow_status\n      - manager.workflow_save\n      - manager.workflow_list\n      - manager.workflow_run_named\n    prompt_segment: |\n      多步/多 agent 的目标优先用 workflow descriptor 固化，而不是在对话里逐条 agent_message 派活。\n      descriptor 形状：{descriptor_id, name, caps?{max_agents, max_concurrency}, phases[]{phase_id, name, depends_on_phase_ids?, agents[]{agent_id, prompt, role?}}}。\n      每个 agent_id 必须真实存在（先 manager.agent_list 确认）；prompt 必须自包含——v1 没有 phase 间结果管道，后续 phase 的 prompt 不能引用前面 phase 的输出变量。\n      manager.workflow_execute 校验失败会返回 errors 数组（重复 phase_id、依赖环、超 max_agents 等）；按 errors 修 descriptor 重试，不要硬编造。\n      执行是异步的，两段式回复：workflow_execute 成功会同步返回 {run_id, total_agents, order}——这就是\"已派发成功\"的确认。收到后【第一段：立刻给用户回一句简短同步确认】，例如「已派发工作流 run_id=xxx，N 个 subagent 运行中，完成后汇报结果」，然后【结束本轮】。executor 在 run 终态会自动用结果唤醒你（notify-origin 回调）；【第二段：被唤醒后】再用【一次】manager.workflow_status 取各 agent 结果、汇总并继续后续阶段（评审/定稿/汇报）。\n      ⚠️ 拿到 run_id 就是成功、不是\"未就绪\"。【绝对不要】因为\"工作流还没出结果\"就 fallback 到手动逐个 agent_message 派活——那样既重复劳动、又制造\"工作流未就绪→其实完成了\"的双回复混乱（这正是要避免的）。也不要在本轮里循环调 workflow_status 死等/轮询（会烧光本轮 step 预算、还出不了 synthesis）。agent 终态是 replied/failed、run 终态是 completed/failed；带 gates 的 subagent 工作可能要几十分钟，耐心等唤醒、不要过早断言失败。\n      一个 phase 内的多个 agent 现在【并行】执行（受 caps.max_concurrency 限制；不填则全并行），所以同 phase 放多个独立维度的 agent 是划算的；有先后依赖的放不同 phase 用 depends_on_phase_ids。\n      不要把 secret / env binding 值写进任何 phase prompt。\n      caps.max_agents 写实际需要的数量；不要为了\"以防万一\"开大。\n      跑通且值得复用的 workflow 用 manager.workflow_save 固化（kebab-case 命名）；agent prompt 里可写 {{args.key}} 占位符，run 时由 manager.workflow_run_named 的 args 填充。\n      复跑前先 manager.workflow_list 确认名字和版本；run_named 缺 args 会返回 missing_args 列表，按列表补齐重试。\n      同名重存会自动升版本；不要为小改动另起新名字造成名字泛滥。\n    capability_class: callable_tool_ready\n    source_ref:\n      provider: internal\n      reference: docs/tools/manager.workflow_execute.0.1.0.yaml\n    evidence_requirements:\n      - run_id\n\nworkflow_patterns:\n  - name: create-and-message\n    when: 操作员要求让 manager 起一个新的 cloud agent 并立刻给它派活\n    steps:\n      - 调用 manager.agent_list 检查是否已有同名 agent\n      - 调用 manager.skillset_list 确认 target skillset id 存在\n      - 调用 manager.agent_create 拿到新 agent_id\n      - 用新 agent_id 调 manager.agent_message\n      - 把 task_id + envelope + reply/status 作为 evidence 回操作员\n    completion_signal: manager.agent_message 返回 status ∈ {replied, accepted} 且 agent_id / task_id 非空\n\n  - name: compose-custom-skillset\n    when: 操作员要求把现有 tool contracts 组合成一个新的 custom skillset\n    steps:\n      - 调用 manager.skillset_list 看现有 id 防撞\n      - 调用 manager.skillset_read 拿一个相似 embedded skillset 作为 shape 参考\n      - 用 manager.skillset_create 写入 custom skillset\n      - 如需进一步调整，再用 manager.skillset_update 修订（不要新建第二个）\n      - 把新 skillset 暴露给 manager.agent_update 选择\n    completion_signal: manager.skillset_create / update 返回 ok:true 且 skillset.source == \"custom\"\n\nreasoning_protocol:\n  principles:\n    - 先观察后写入：任何 create/update 之前必须先 list/read\n    - 把错误码原样透传给操作员；不要替 server 解释 \"应该没事\"\n    - agent_message 的 status 必须真实反映对方 DO 的执行结果；replied / accepted / failed 三态有明确语义，不能混\n    - custom skillset 永远不能影子化 embedded id\n  anti_patterns:\n    - 不要凭记忆 / 凭聊天历史推断 agent_id；必须实时 list\n    - 不要在 manifest tools 字段写不存在的 tool_id 期待服务端兜底创建\n    - 不要把 AGENT_THURSDAY_SHARED_SECRET / FYIMD_API_KEY / 任何 env binding 值写进 prompt / persona / message text\n    - 不要尝试 deploy / push / 改 wrangler.toml；本 skillset 不暴露这些工具\n    - 不要替对方 agent 伪造已完成 reply\n\nevidence_protocol:\n  protocol_version: \"0.1.0\"\n\nsafety_policy:\n  policy_version: \"0.1.0\"\n  path_allowlist: []\n  path_denylist:\n    - \"**\"\n  cross_repo_writes: denied\n\nobservability:\n  emit_events:\n    - skillset.manager.load\n    - skillset.manager.unload\n  inspect_surfaces:\n    - /api/inspect/skillset/manager\n\npolicy:\n  surface_modes: [enable]\n  default_tier_cap: 3\n  load_priority: 35\n";
const MANAGER_MANIFEST = ({
  "id": "manager",
  "name": "Manager",
  "description": "让 manager agent 通过受控的 first-party tools 管理其他 cloud agents：lifecycle（新建/修改 agent）、skillset authoring（新建/修改 custom skillset）、agent-to-agent communication。所有动作可审计；不暴露 secret、不能执行任意代码。",
  "version": "0.4.0",
  "purpose": "equip a manager agent with audited tools for cloud agent lifecycle, custom skillset authoring, and direct agent-to-agent messaging",
  "tools": [
    "manager.agent_list",
    "manager.agent_create",
    "manager.agent_update",
    "manager.skillset_list",
    "manager.skillset_read",
    "manager.skillset_create",
    "manager.skillset_update",
    "manager.agent_message",
    "manager.subagent_summaries",
    "manager.task_merge",
    "manager.task_complete",
    "manager.workflow_execute",
    "manager.workflow_status",
    "manager.workflow_save",
    "manager.workflow_list",
    "manager.workflow_run_named",
    "manager.schedule_create",
    "manager.schedule_list",
    "manager.schedule_cancel"
  ],
  "skills": [
    {
      "id": "manager.agent.lifecycle",
      "name": "Agent lifecycle",
      "description": "创建新 cloud agent 或修改 name / model / skillset / persona / status。任何写操作前必须先 manager.agent_list 确认当前状态。",
      "tier": 2,
      "tools": [
        "manager.agent_list",
        "manager.agent_create",
        "manager.agent_update"
      ],
      "prompt_segment": "管理 agent 生命周期前一定要先调用 manager.agent_list 拿到现状；不要凭记忆操作。\n创建 agent 必须显式给出 name / model / skillset；persona 可空。\n修改 agent 必须明确指定 agent_id，不能根据 name 模糊匹配。\n不要尝试物理改 agent_id；DO instance name 在 an earlier revision 之后是稳定主键。\n遇到 name_conflict / unknown_model / unsupported_model / unknown_skillset 时把原始错误码透传给操作员，不要静默重试。",
      "capability_class": "callable_tool_ready",
      "source_ref": {
        "provider": "internal",
        "reference": "docs/tools/manager.agent_list.0.1.0.yaml"
      },
      "evidence_requirements": [
        "agent_id"
      ]
    },
    {
      "id": "manager.skillset.author",
      "name": "Skillset authoring",
      "description": "创建 / 修改 / 读取 / 列出 custom skillsets。custom skillset 只能组合已注册的 tool contracts；embedded skillset 不可修改。",
      "tier": 2,
      "tools": [
        "manager.skillset_list",
        "manager.skillset_read",
        "manager.skillset_create",
        "manager.skillset_update"
      ],
      "prompt_segment": "创建 / 修改 custom skillset 前先 manager.skillset_list 看一遍已有 id，避免和 embedded 撞名。\nmanifest 里的 tools 字段只能写已存在的 tool_id；不能在 manifest 里发明新工具实现。\n尝试修改 embedded skillset 会被 server 用 embedded_skillset_readonly 拒绝；不要绕。\nmanifest 必须含 id / name / description / version / purpose / tools / skills；每个 skill 至少有 id / name / tier(1-5) / tools。\n不要把 secret / env binding 值写进 manifest。",
      "capability_class": "callable_tool_ready",
      "source_ref": {
        "provider": "internal",
        "reference": "docs/tools/manager.skillset_create.0.1.0.yaml"
      },
      "evidence_requirements": [
        "skillset_id"
      ]
    },
    {
      "id": "manager.agent.communicate",
      "name": "Agent communication",
      "description": "向指定 agent_id 发送一条工作消息 / 指令。返回 task_id + envelope + visible reply 或 accepted/failed 状态。",
      "tier": 3,
      "tools": [
        "manager.agent_message"
      ],
      "prompt_segment": "发消息必须指定 target agent_id；没有 agent_id 时先 manager.agent_list 拿到。\n不要替对方 agent 编造 reply；返回 evidence 区分 replied / accepted / failed 三态。\nstatus == \"failed\" 且 reason == \"agent_loop_timeout\" 时不要假装消息没送出 —— 任务已注入对方 DO；告诉操作员等下一轮 inspect 查实际 reply。\n不要在消息文本里 inline 任何 AGENT_THURSDAY_SHARED_SECRET / API key / persona-private 信息。\n派活给 subagent 时尽量同时填 `task_context`（结构化的 id/title/objective；可选 expected_outputs/non_goals/verification_hint 等）。subagent 第一轮会看到 `<task-context>` JSON 块；objective 与 prose 冲突时以 objective 为准。`text` 自然语言部分保留不变。\n`task_context.parent_task_id` / `source_agent_id` 一般不用手填：除非你要跨 manager / 跨链 dispatch，否则默认继承你当前外层 `manager_task_id`（见你 first turn 里的 `<manager-context>` 块）与你自己的 agent_id；显式传入仍然生效（用于覆盖）。",
      "capability_class": "callable_tool_ready",
      "source_ref": {
        "provider": "internal",
        "reference": "docs/tools/manager.agent_message.0.1.0.yaml"
      },
      "evidence_requirements": [
        "agent_id",
        "task_id"
      ]
    },
    {
      "id": "manager.schedule.automation",
      "name": "Schedule management",
      "description": "给自己 owner 编队里的 agent（含子代理）创建 / 列出 / 取消定时任务。用户要求\"每天/每周/定期让某个 agent 做 X\"时用这组工具，不要用消息中转或 memory 模拟定时。",
      "tier": 2,
      "tools": [
        "manager.schedule_create",
        "manager.schedule_list",
        "manager.schedule_cancel"
      ],
      "prompt_segment": "用户要求某个 agent 定期做事时，用 manager.schedule_create 直接给目标 agent 建排程（agent_id 必填）；给自己建用 base 的 schedule_create 即可。\ndaily/weekly 必须带 utc_offset_minutes（不知道用户时区就先问）；建完把返回的 next_run_at 复述给用户核对。\n建新排程前先 manager.schedule_list 查重；取消用 schedule_id 精确指定。\n平台安全阀（每 owner 上限 / 最小间隔 15 分钟 / 连续失败自动停）由服务端强制，遇到 schedule_cap_exceeded / interval_too_short 把错误码透传给用户。",
      "capability_class": "callable_tool_ready",
      "source_ref": {
        "provider": "internal",
        "reference": "docs/tools/manager.schedule_create.0.1.0.yaml"
      },
      "evidence_requirements": [
        "schedule_id"
      ]
    },
    {
      "id": "manager.subagent.review",
      "name": "Subagent summary review",
      "description": "读取本 manager 派出去的 subagent 完成情况摘要（bounded reply_excerpt + 自报 artifact_refs + completed_at）。仅能读自己派的工作（按 source_agent_id 隔离，跨 manager 查询返回空 list）。",
      "tier": 1,
      "tools": [
        "manager.subagent_summaries"
      ],
      "prompt_segment": "派活时若用了 task_context.parent_task_id，subagent 完成后会自动 push 一份 summary 到 registry，可以用 manager.subagent_summaries 查回。\n过滤可用 parent_task_id（一般就是你自己的 outer task_id）或 source_agent_id；limit 默认 20，最大 50。\n跨 manager 查询会得到 empty list 而不是 error —— 不要把空 list 当成 subagent 没完成，要结合 task status 一起判断。\nsummary.reply_excerpt 是 bounded 截断（≤500 UTF-8 bytes），不要把它当完整 reply；完整 reply 仍在 subagent 自己的 inspect / envelope 里。\nsummary.artifact_refs 是 subagent 自报的；v1 不跨 DO 拉内容，要核实 artifact 内容请用 subagent 的 artifact.* tools。",
      "capability_class": "callable_tool_ready",
      "source_ref": {
        "provider": "internal",
        "reference": "docs/tools/manager.subagent_summaries.0.1.0.yaml"
      },
      "evidence_requirements": [
        "parent_task_id"
      ]
    },
    {
      "id": "manager.task.merge",
      "name": "Audit-grade task merge",
      "description": "读完 subagent summaries 之后，把结构化 merge verdict 写进 parent task 的 event_log，形成可审计的 `manager.task.merged` 事件。与 `manager.task.replied` 并存；事件存在才算 audit-grade merge。",
      "tier": 2,
      "tools": [
        "manager.task_merge"
      ],
      "prompt_segment": "调用顺序：先 manager.subagent_summaries 读到本 manager 自己的 subagent 摘要，再用 manager.task_merge 落 merge event；不要在没看 summary 的情况下乱填 refs。\n每个 subagent_task_refs 元素必填 task_id / agent_id / summary_id / verdict；verdict ∈ {success, partial, failed, ignored}；summary_id v1 语义上等同于 subagent 自己的 task_id（与 manager.subagent.summary 一致）。\nmerge_verdict ∈ {success, partial, failed}，反映 manager 对整个 parent task 的 merge 判断；它不会替代 manager.task.replied 的最终 reply 文本。\n不要把别的 manager 的 summary 塞进 refs；server 会按 source_agent_id 边界拒绝并返回 permission_denied。\nsummary_id 与 ref.task_id / agent_id 必须匹配，否则会返回 ref_mismatch；不要凭记忆瞎写。\nzero-ref merge 是允许的（明确记录 \"我没并任何 subagent 工作\"），但请在 note 里说明原因，否则审计时分不清是逻辑还是漏看。\n不要手填 merged_at（除非你在跑测试需要 deterministic 时间）；不要试图改 manager_agent_id，server 会用 calling agent_id 覆盖。",
      "capability_class": "callable_tool_ready",
      "source_ref": {
        "provider": "internal",
        "reference": "docs/tools/manager.task_merge.0.1.0.yaml"
      },
      "evidence_requirements": [
        "parent_task_id",
        "merge_verdict"
      ]
    },
    {
      "id": "manager.task.complete",
      "name": "Task completion report",
      "description": "在 manager 完成一张 parent task（通常先 task_merge → task.replied）之后，调用 manager.task_complete 记录结构化的 completion report（verdict、summary、可选 evidence / next_step / card_ref）。这是 report/归档 evidence，不替代 replied/failed 终态，也不改 an earlier revision status derivation。",
      "tier": 2,
      "tools": [
        "manager.task_complete"
      ],
      "prompt_segment": "调用顺序：先 manager.task_merge 落 audit-grade merge，再 manager.task_complete 写 completion report；不要在没 merge 的情况下直接 success complete（server 会以 validation_failed 拒绝，message 会点名 allow_without_merge）。\ncompletion_verdict ∈ {success, partial, failed}；success 默认要有同 parent_task_id 的 manager.task.merged 事件，否则 server 返回 validation_failed（message 包含 allow_without_merge）。\n如果确实没有 merge（例如纯 advisory 任务、纯 doc 卡），可以显式 allow_without_merge=true 并在 allow_without_merge_reason 里写明原因；空 reason 会被 validation_failed 拒绝。\nsummary 写 120-500 字范围的完成摘要即可，server 会按 2000 UTF-8 bytes 上限校验；不要把整段 subagent reply、prompt、secret 抄进 summary。\nevidence.merge_event_id 来自 manager.subagent_summaries / merge reader 的 event_id；subagent_task_ids 来自实际 subagent 的 task_id；envelope_id 来自 manager.task.replied 的 envelope_id。这些字段都是可选的，但有就尽量填。\nnext_step 写一句操作员下一步行动（\"操作员需要把 PR 提交到 main\" 之类），不要写多段。\ncard_ref 用来反指 kanban 卡，例如 {card_id: \"377\", path: \"docs/kanban/377-....md.done.verified\"}。\n不要试图改 manager_agent_id，server 会用 calling agent_id 覆盖。\n多次 complete 是允许的（修正报告 / 补 evidence），reader 会取 latest 并返回 completion_count。",
      "capability_class": "callable_tool_ready",
      "source_ref": {
        "provider": "internal",
        "reference": "docs/tools/manager.task_complete.0.1.0.yaml"
      },
      "evidence_requirements": [
        "parent_task_id",
        "completion_verdict"
      ]
    },
    {
      "id": "manager.workflow.orchestrate",
      "name": "Workflow orchestration",
      "description": "把目标固化为声明式 workflow descriptor（phases / agents / deps / caps），交给 durable executor 执行，并用 run_id 观察 run → phases → agents 树。这是\"plan 活在数据里\"的派活方式：比逐条 agent_message 更可观察、可复跑、可审计。",
      "tier": 3,
      "tools": [
        "manager.workflow_execute",
        "manager.workflow_status",
        "manager.workflow_save",
        "manager.workflow_list",
        "manager.workflow_run_named"
      ],
      "prompt_segment": "多步/多 agent 的目标优先用 workflow descriptor 固化，而不是在对话里逐条 agent_message 派活。\ndescriptor 形状：{descriptor_id, name, caps?{max_agents, max_concurrency}, phases[]{phase_id, name, depends_on_phase_ids?, agents[]{agent_id, prompt, role?}}}。\n每个 agent_id 必须真实存在（先 manager.agent_list 确认）；prompt 必须自包含——v1 没有 phase 间结果管道，后续 phase 的 prompt 不能引用前面 phase 的输出变量。\nmanager.workflow_execute 校验失败会返回 errors 数组（重复 phase_id、依赖环、超 max_agents 等）；按 errors 修 descriptor 重试，不要硬编造。\n执行是异步的，两段式回复：workflow_execute 成功会同步返回 {run_id, total_agents, order}——这就是\"已派发成功\"的确认。收到后【第一段：立刻给用户回一句简短同步确认】，例如「已派发工作流 run_id=xxx，N 个 subagent 运行中，完成后汇报结果」，然后【结束本轮】。executor 在 run 终态会自动用结果唤醒你（notify-origin 回调）；【第二段：被唤醒后】再用【一次】manager.workflow_status 取各 agent 结果、汇总并继续后续阶段（评审/定稿/汇报）。\n⚠️ 拿到 run_id 就是成功、不是\"未就绪\"。【绝对不要】因为\"工作流还没出结果\"就 fallback 到手动逐个 agent_message 派活——那样既重复劳动、又制造\"工作流未就绪→其实完成了\"的双回复混乱（这正是要避免的）。也不要在本轮里循环调 workflow_status 死等/轮询（会烧光本轮 step 预算、还出不了 synthesis）。agent 终态是 replied/failed、run 终态是 completed/failed；带 gates 的 subagent 工作可能要几十分钟，耐心等唤醒、不要过早断言失败。\n一个 phase 内的多个 agent 现在【并行】执行（受 caps.max_concurrency 限制；不填则全并行），所以同 phase 放多个独立维度的 agent 是划算的；有先后依赖的放不同 phase 用 depends_on_phase_ids。\n不要把 secret / env binding 值写进任何 phase prompt。\ncaps.max_agents 写实际需要的数量；不要为了\"以防万一\"开大。\n跑通且值得复用的 workflow 用 manager.workflow_save 固化（kebab-case 命名）；agent prompt 里可写 {{args.key}} 占位符，run 时由 manager.workflow_run_named 的 args 填充。\n复跑前先 manager.workflow_list 确认名字和版本；run_named 缺 args 会返回 missing_args 列表，按列表补齐重试。\n同名重存会自动升版本；不要为小改动另起新名字造成名字泛滥。",
      "capability_class": "callable_tool_ready",
      "source_ref": {
        "provider": "internal",
        "reference": "docs/tools/manager.workflow_execute.0.1.0.yaml"
      },
      "evidence_requirements": [
        "run_id"
      ]
    }
  ],
  "workflow_patterns": [
    {
      "name": "create-and-message",
      "when": "操作员要求让 manager 起一个新的 cloud agent 并立刻给它派活",
      "steps": [
        "调用 manager.agent_list 检查是否已有同名 agent",
        "调用 manager.skillset_list 确认 target skillset id 存在",
        "调用 manager.agent_create 拿到新 agent_id",
        "用新 agent_id 调 manager.agent_message",
        "把 task_id + envelope + reply/status 作为 evidence 回操作员"
      ],
      "completion_signal": "manager.agent_message 返回 status ∈ {replied, accepted} 且 agent_id / task_id 非空"
    },
    {
      "name": "compose-custom-skillset",
      "when": "操作员要求把现有 tool contracts 组合成一个新的 custom skillset",
      "steps": [
        "调用 manager.skillset_list 看现有 id 防撞",
        "调用 manager.skillset_read 拿一个相似 embedded skillset 作为 shape 参考",
        "用 manager.skillset_create 写入 custom skillset",
        "如需进一步调整，再用 manager.skillset_update 修订（不要新建第二个）",
        "把新 skillset 暴露给 manager.agent_update 选择"
      ],
      "completion_signal": "manager.skillset_create / update 返回 ok:true 且 skillset.source == \"custom\""
    }
  ],
  "reasoning_protocol": {
    "principles": [
      "先观察后写入：任何 create/update 之前必须先 list/read",
      "把错误码原样透传给操作员；不要替 server 解释 \"应该没事\"",
      "agent_message 的 status 必须真实反映对方 DO 的执行结果；replied / accepted / failed 三态有明确语义，不能混",
      "custom skillset 永远不能影子化 embedded id"
    ],
    "anti_patterns": [
      "不要凭记忆 / 凭聊天历史推断 agent_id；必须实时 list",
      "不要在 manifest tools 字段写不存在的 tool_id 期待服务端兜底创建",
      "不要把 AGENT_THURSDAY_SHARED_SECRET / FYIMD_API_KEY / 任何 env binding 值写进 prompt / persona / message text",
      "不要尝试 deploy / push / 改 wrangler.toml；本 skillset 不暴露这些工具",
      "不要替对方 agent 伪造已完成 reply"
    ]
  },
  "evidence_protocol": {
    "protocol_version": "0.1.0"
  },
  "safety_policy": {
    "policy_version": "0.1.0",
    "path_allowlist": [],
    "path_denylist": [
      "**"
    ],
    "cross_repo_writes": "denied"
  },
  "observability": {
    "emit_events": [
      "skillset.manager.load",
      "skillset.manager.unload"
    ],
    "inspect_surfaces": [
      "/api/inspect/skillset/manager"
    ]
  },
  "policy": {
    "surface_modes": [
      "enable"
    ],
    "default_tier_cap": 3,
    "load_priority": 35
  }
}) as unknown as SkillsetManifest;

const QA_REVIEWER_BASIC_YAML: string = "# QA Reviewer Basic skillset v0.1.0\n#\n# an earlier revision M8.7 — second non-software-dev skillset proof.\n#\n# Goal: prove the YAML → codegen → loader → runtime → inspect pipeline\n# does not assume `software-dev` is the only non-publishing skillset.\n# This skillset is intentionally instruction-only / declared-tool-\n# disabled — it exercises every generic field (capability_class,\n# prompt_segment, source_ref, evidence_requirements) without introducing\n# a new secret or a new external provider.\n\nid: qa-reviewer-basic\nname: QA Reviewer Basic\ndescription: lightweight review heuristics for code changes; no external dispatch, only structural sanity checks an LLM can apply against an already-fetched diff.\nversion: 0.1.0\npurpose: provide reviewer-style sanity prompts and a declared-but-disabled diff-inspect placeholder without dispatching any callable tool\n\ntools:\n  - git.diff\n\nskills:\n  - id: qa.review.scope-check\n    name: Scope sanity\n    description: ensure changes trace to the stated task; flag drift before deeper review\n    tier: 1\n    tools: []\n    prompt_segment: 在写任何 review 评论前先列出本次改动的 user-facing 目标；如果 diff 里出现与目标无关的文件，先标注 scope-drift 再继续。\n    capability_class: instruction_only\n    evidence_requirements:\n      - stated_goal\n      - touched_paths\n      - drift_flag\n  - id: qa.review.diff-inspect\n    name: Diff inspect (declared-disabled)\n    description: 占位：未来可能挂 git.diff dispatch；当前阶段保持 declared_tool_disabled\n    tier: 2\n    tools:\n      - git.diff\n    prompt_segment: 这一步不要真正调用 git.diff；只在 prompt 层声明已经手动 review 过 diff 文本即可。\n    capability_class: declared_tool_disabled\n    source_ref:\n      provider: internal\n      reference: docs/skillsets/qa-reviewer-basic.0.1.0.yaml#qa.review.diff-inspect\n    evidence_requirements:\n      - diff_summary\n      - reviewer_note\n  - id: qa.review.escalate-human\n    name: Escalate to human reviewer\n    description: 当 reviewer LLM 无法自信判断时，明确把决策权交回给 human / verifier\n    tier: 1\n    tools: []\n    prompt_segment: 看到不确定的安全 / 合规问题时不要猜，直接返回 escalate=true 并写下不确定点；不要伪装成 PASS。\n    capability_class: human_or_verifier_relay\n    evidence_requirements:\n      - uncertainty_reason\n      - escalation_target\n\nworkflow_patterns:\n  - name: scope-then-detail\n    when: 收到一个 diff 需要 review\n    steps:\n      - 先跑 qa.review.scope-check 验证 scope\n      - 对每个 touched_path 写一行结构性 note\n      - 任何不确定项触发 qa.review.escalate-human\n    completion_signal: 所有 touched_path 都有 note，且没有未解的 escalation\n\nreasoning_protocol:\n  principles:\n    - review 不能凭空猜测 diff 内容；必须基于已经看到的文本\n    - 任何不确定都要 escalate，而不是给一个含糊的 PASS\n  anti_patterns:\n    - 不要把 qa.review.diff-inspect 当成真正的 callable tool 调用\n    - 不要替 human reviewer 做安全 / 合规的最终决定\n\nevidence_protocol:\n  protocol_version: \"0.1.0\"\n\nsafety_policy:\n  policy_version: \"0.1.0\"\n  path_allowlist: []\n  path_denylist:\n    - \"**\"\n  cross_repo_writes: denied\n\nobservability:\n  emit_events:\n    - skillset.qa-reviewer-basic.load\n    - skillset.qa-reviewer-basic.unload\n  inspect_surfaces:\n    - /api/inspect/skillset/qa-reviewer-basic\n\npolicy:\n  surface_modes: [enable, readonly]\n  default_tier_cap: 2\n  load_priority: 20\n";
const QA_REVIEWER_BASIC_MANIFEST = ({
  "id": "qa-reviewer-basic",
  "name": "QA Reviewer Basic",
  "description": "lightweight review heuristics for code changes; no external dispatch, only structural sanity checks an LLM can apply against an already-fetched diff.",
  "version": "0.1.0",
  "purpose": "provide reviewer-style sanity prompts and a declared-but-disabled diff-inspect placeholder without dispatching any callable tool",
  "tools": [
    "git.diff"
  ],
  "skills": [
    {
      "id": "qa.review.scope-check",
      "name": "Scope sanity",
      "description": "ensure changes trace to the stated task; flag drift before deeper review",
      "tier": 1,
      "tools": [],
      "prompt_segment": "在写任何 review 评论前先列出本次改动的 user-facing 目标；如果 diff 里出现与目标无关的文件，先标注 scope-drift 再继续。",
      "capability_class": "instruction_only",
      "evidence_requirements": [
        "stated_goal",
        "touched_paths",
        "drift_flag"
      ]
    },
    {
      "id": "qa.review.diff-inspect",
      "name": "Diff inspect (declared-disabled)",
      "description": "占位：未来可能挂 git.diff dispatch；当前阶段保持 declared_tool_disabled",
      "tier": 2,
      "tools": [
        "git.diff"
      ],
      "prompt_segment": "这一步不要真正调用 git.diff；只在 prompt 层声明已经手动 review 过 diff 文本即可。",
      "capability_class": "declared_tool_disabled",
      "source_ref": {
        "provider": "internal",
        "reference": "docs/skillsets/qa-reviewer-basic.0.1.0.yaml#qa.review.diff-inspect"
      },
      "evidence_requirements": [
        "diff_summary",
        "reviewer_note"
      ]
    },
    {
      "id": "qa.review.escalate-human",
      "name": "Escalate to human reviewer",
      "description": "当 reviewer LLM 无法自信判断时，明确把决策权交回给 human / verifier",
      "tier": 1,
      "tools": [],
      "prompt_segment": "看到不确定的安全 / 合规问题时不要猜，直接返回 escalate=true 并写下不确定点；不要伪装成 PASS。",
      "capability_class": "human_or_verifier_relay",
      "evidence_requirements": [
        "uncertainty_reason",
        "escalation_target"
      ]
    }
  ],
  "workflow_patterns": [
    {
      "name": "scope-then-detail",
      "when": "收到一个 diff 需要 review",
      "steps": [
        "先跑 qa.review.scope-check 验证 scope",
        "对每个 touched_path 写一行结构性 note",
        "任何不确定项触发 qa.review.escalate-human"
      ],
      "completion_signal": "所有 touched_path 都有 note，且没有未解的 escalation"
    }
  ],
  "reasoning_protocol": {
    "principles": [
      "review 不能凭空猜测 diff 内容；必须基于已经看到的文本",
      "任何不确定都要 escalate，而不是给一个含糊的 PASS"
    ],
    "anti_patterns": [
      "不要把 qa.review.diff-inspect 当成真正的 callable tool 调用",
      "不要替 human reviewer 做安全 / 合规的最终决定"
    ]
  },
  "evidence_protocol": {
    "protocol_version": "0.1.0"
  },
  "safety_policy": {
    "policy_version": "0.1.0",
    "path_allowlist": [],
    "path_denylist": [
      "**"
    ],
    "cross_repo_writes": "denied"
  },
  "observability": {
    "emit_events": [
      "skillset.qa-reviewer-basic.load",
      "skillset.qa-reviewer-basic.unload"
    ],
    "inspect_surfaces": [
      "/api/inspect/skillset/qa-reviewer-basic"
    ]
  },
  "policy": {
    "surface_modes": [
      "enable",
      "readonly"
    ],
    "default_tier_cap": 2,
    "load_priority": 20
  }
}) as unknown as SkillsetManifest;

const SOFTWARE_DEV_YAML: string = "# Software Development skillset v0.1.0\n#\n# Canonical manifest per ADR 2026-05-07 IM-1.\n# Validate against 175 schema (docs/design/m8-skillset-manifest-schema-v0.md).\n# tool_ids must resolve via 176 contracts (docs/design/m8-tool-contract-tier-policy-v0.md).\n# safety_policy / approval references are 177 schema-compliant.\n# evidence_protocol reference is 178 schema-compliant.\n\nid: software-dev\nname: Software Development\ndescription: AgentThursday agent 参与 AgentThursday / AgentThursday 自身代码开发的能力包；可以读源码、改代码、跑 gate、产 evidence、把 working-tree/patch artifact 交给agentP verifier 验收；commit/push/deploy 由 verifier 收口，操作员 负责指挥/裁决。\nversion: 0.1.0\npurpose: let agent participate in AgentThursday self-development under controlled boundaries\n\ndependencies:\n  - observability\n  - communication\n\ntools:\n  - repo.read\n  - repo.glob\n  - repo.grep\n  - kanban.read\n  - kanban.list\n  - git.status\n  - git.diff\n  - git.log\n  - git.show\n  - inspect.self.task\n  - inspect.self.events\n  - inspect.self.trace\n  - repo.write\n  - repo.patch\n  - repo.delete\n  - gate.typecheck\n  - gate.build\n  - gate.dry_run\n  - gate.test\n  - git.add\n  - git.commit\n  - git.branch\n  - kanban.advance\n  - kanban.create\n  - git.push\n  - deploy.wrangler\n  - patch.validate\n\nskills:\n  - id: code.read\n    name: Read Repository Source\n    description: 读 repo 文件、grep / glob 定位代码\n    tier: 2\n    tools: [repo.read, repo.glob, repo.grep]\n    prompt_segment: |\n      读源码前必须 repo.glob 或 repo.grep 定位，不基于记忆假设路径。优先读命中\n      snippet / 小范围上下文，避免一次性读取大文件；确需读大文件时先说明原因并设置\n      明确 maxBytes。读到内容后保留上下文 3-5 行，避免误判 surrounding context。\n      若任务来自 Discord/外部协作，不要假设能看到agentP host 文件系统；以 GitHub repo\n      / base commit / patch handoff 为准，并在 completion 中写清楚产物如何交回。\n      声称“已读/已搜/已改”必须可被 trace 证明；报告时带 tool/event、path、行范围\n      或结果摘要。truthfulness gate 标红时，先降级为未验证并检查 inspect.self.events。\n\n      行范围验证规则：验证任务要求“check line range N..M”时，必须用\n      repo.read 的行范围参数（offset/limit）或 repo.grep 抓命中行附近 snippet。\n      如果只有 whole-file repo.read 可用且结果出现 truncated=true，**必须**把对应\n      line-range claim 标为 CONDITIONAL 或 UNVERIFIED，不能写 PASS；truncated read\n      只能证明“看到前缀”，不能证明任意行号内容。\n    input_contract:\n      type: object\n      properties:\n        path: { type: string }\n        pattern: { type: string }\n      oneOf:\n        - required: [path]\n        - required: [pattern]\n    output_contract:\n      type: object\n      properties:\n        files: { type: array, items: { type: object } }\n\n  - id: kanban.lookup\n    name: Read Kanban Cards\n    description: 读 kanban 卡 body / list todo 卡\n    tier: 2\n    tools: [kanban.read, kanban.list]\n    prompt_segment: |\n      推进任何卡前必须先 kanban.read 看 spec；不基于卡名猜内容。\n    input_contract:\n      type: object\n      oneOf:\n        - required: [card_id]\n          properties: { card_id: { type: string } }\n        - required: [filter]\n          properties: { filter: { type: string } }\n\n  - id: vcs.inspect\n    name: Inspect Git State\n    description: git status / diff / log / show 只读查询\n    tier: 2\n    tools: [git.status, git.diff, git.log, git.show]\n    prompt_segment: |\n      改动前看一眼 git.status / git.diff，确认起点干净；commit 前用 git.diff --staged\n      review 自己将要 commit 的内容。\n\n  - id: inspect.self\n    name: Inspect Own Runtime\n    description: 查 agent 自己的 task / event / trace\n    tier: 2\n    tools: [inspect.self.task, inspect.self.events, inspect.self.trace]\n    prompt_segment: |\n      想知道 \"我刚才用了什么工具\" 时查 inspect.self.events，不要靠记忆 reconstruct。\n\n  - id: code.edit\n    name: Edit Repository Source\n    description: 在 path allowlist 内做最小 patch / write\n    tier: 3\n    tools: [repo.write, repo.patch, repo.delete]\n    prompt_segment: |\n      最小 patch 优先：repo.patch 改一行能解决就不 repo.write 全文。每次改完后必须\n      gate.typecheck（post-patch-gate-check verification_hook 强制）。\n      an earlier revision：只要本轮调用过 repo.write 或 repo.patch，结束前**必须真实调用**\n      至少一个 gate（默认顺序 gate.typecheck → gate.build）。只在回复里说\"我会跑/\n      已跑 typecheck\"不算数——没有真实 gate tool call，envelope 会 seal 成\n      missing_gate_evidence。若因明确 blocker 不能跑 gate，必须在回复和 trace 里写清\n      具体原因。\n\n  - id: gate.run\n    name: Run Build / Test Gates\n    description: typecheck / build / test / dry_run；保留 stdout/stderr/exit\n    tier: 3\n    tools: [gate.typecheck, gate.build, gate.dry_run, gate.test]\n    prompt_segment: |\n      gate 失败不是 retry 借口，是 stop signal。exit_code != 0 必须停下读 stderr，\n      理解后再继续。\n\n  - id: patch.sandbox\n    name: Validate Patch Candidate (Sandbox)\n    description: 把 patch artifact 提交给 validate-only sandbox，返回结构化 evidence；不暴露 commit/push/deploy\n    tier: 2\n    tools: [patch.validate]\n    prompt_segment: |\n      在把 patch artifact 交给agentP 之前，先用 patch.validate 跑一遍：hunk-count\n      audit + git apply --check + 隔离 apply + 新文件 EOF 校验，可选 node --check\n      lightweight gate。输入用 artifact.write 后的 cardId + filename 引用，或\n      直接传 patchText（前者带 sha256 evidence，优先用 ref）。\n      failureReason='hunk_count_mismatch' 是 243 类缺陷的强信号，不要重交；先\n      重新生成 patch 再 validate。这条 surface 只读写 ephemeral /tmp 沙盒，不\n      会触 commit/push/deploy。\n    capability_class: callable_tool_ready\n    source_ref:\n      provider: internal\n      reference: docs/tools/patch.validate.0.1.0.yaml\n    evidence_requirements:\n      - result.ok\n      - result.baseRevision\n      - result.changedPaths\n      - result.hunkAudit\n      - result.gitApplyCheckOk\n      - result.newFileEofOk\n\n  - id: vcs.mutate\n    name: Local VCS Mutation\n    description: stage / commit / branch（必须 approval）\n    tier: 4\n    tools: [git.add, git.commit, git.branch]\n    requires_approval:\n      required: true\n      scope: per_call\n      reason_required: true\n      reviewer: operator\n      token_lifetime_seconds: 1800\n    prompt_segment: |\n      commit 前必须 git.diff --staged review；commit message 写明卡号 + 一句话改动。\n      不要 squash 多卡。\n\n  - id: kanban.mutate\n    name: Kanban State Mutation\n    description: advance card / create new card（必须 approval）\n    tier: 4\n    tools: [kanban.advance, kanban.create]\n    requires_approval:\n      required: true\n      scope: per_call\n      reason_required: true\n      reviewer: operator\n      token_lifetime_seconds: 1800\n    prompt_segment: |\n      kanban.advance 不允许 target_status='verified'（hard ban，verifier 专用）。\n      只能推到 ready-for-review / done。\n\n  - id: vcs.publish\n    name: Push Branch to Remote\n    description: git.push（必须 approval；不暴露 force-push）\n    tier: 5\n    tools: [git.push]\n    requires_approval:\n      required: true\n      scope: per_call\n      reason_required: true\n      reviewer: operator\n      token_lifetime_seconds: 900\n    prompt_segment: |\n      push 前必须 git.push 的 dry-run PASS；reason 必填，写明本次 push 的卡号 + 影响范围。\n\n  - id: deploy.workers\n    name: Deploy Cloudflare Worker\n    description: wrangler deploy（必须 approval + 强制 dry-run）\n    tier: 5\n    tools: [deploy.wrangler]\n    requires_approval:\n      required: true\n      scope: per_call\n      reason_required: true\n      reviewer: operator\n      token_lifetime_seconds: 900\n    prompt_segment: |\n      deploy 前必须有 wrangler dry-run PASS evidence；reason 必填，写明部署目标\n      version + 期望 effect + rollback 路径。\n\nworkflow_patterns:\n  - name: minimum-change-loop\n    when: \"面对 bug fix / 小型 feature card\"\n    steps:\n      - \"kanban.read 卡 spec 确认 scope\"\n      - \"repo.grep / repo.glob 定位代码\"\n      - \"repo.read 读上下文\"\n      - \"repo.patch 做最小改动\"\n      - \"gate.typecheck（必须）+ gate.build / gate.test（视卡）\"\n      - \"git.diff 查看产出 diff\"\n      - \"卡 body 写 completion report\"\n      - \"kanban.advance 到 ready-for-review（approval）\"\n    completion_signal: \"completion report 在卡 body + .md.done + test doc\"\n\n  - name: search-first-edit\n    when: \"需要修改但不确定具体位置\"\n    steps:\n      - \"repo.grep 定位所有相关位置\"\n      - \"repo.read 读所有命中位置上下文\"\n      - \"再决定改哪一处 / 多处\"\n\n  - name: fail-fast-stop\n    when: \"gate 失败 / approval denied / 工具 error\"\n    steps:\n      - \"停止当前 step，不要 retry\"\n      - \"inspect.self.events 看 error 详情\"\n      - \"在卡 body 记录失败原因 + 建议下一步\"\n      - \"等人类 unblock\"\n\nreasoning_protocol:\n  principles:\n    - \"先检索再修改：不基于记忆假设代码位置\"\n    - \"读源码要有预算：grep/glob 定位后读 snippet；大文件必须说明原因并限制 maxBytes\"\n    - \"外部协作要写清 handoff：GitHub repo、base commit、patch/PR/附件交付方式\"\n    - \"最小 patch 优先：改一行能解决不改十行\"\n    - \"先验证再汇报：跑完 gate 才声称完成\"\n    - \"证据先行：没有 trace/diff/test log 的 claim 不可信\"\n  anti_patterns:\n    - \"不要基于记忆假设文件路径，必须 grep/glob\"\n    - \"不要全文读取大文件来找位置；先搜索，再读命中行附近 snippet\"\n    - \"不要把agentP host 路径当作外部 agent 可见文件系统；外部交付必须用 repo/patch/PR/附件\"\n    - \"不要在 trace 没有对应 dispatch 时声称已读/已搜/已改\"\n    - \"不要跳过测试直接写 completion report\"\n    - \"不要在没有 diff 的情况下声称已修改\"\n    - \"不要一边 patch 一边 commit；默认交 working-tree / patch artifact 给agentP verifier，由 verifier 验收后 commit/push\"\n    - \"不要声称 操作员 会手动 merge；操作员 负责指挥/裁决，verifier 负责验收和收口\"\n    - \"不要 squash 多卡；一卡一 commit\"\n  verification_hooks:\n    - name: post-patch-gate-check\n      trigger: \"after any code.edit invocation\"\n      action: \"run gate.typecheck before claiming completion\"\n    - name: pre-commit-diff-review\n      trigger: \"before any vcs.mutate(git.commit) invocation\"\n      action: \"run git.diff --staged and verify scope matches card\"\n\nevidence_protocol:\n  protocol_version: \"0.1.0\"\n  required_envelope: [intent, execution, evidence, self_verify]\n  per_tool_emit:\n    repo.write:\n      emit_events: [tool.repo.write.dispatch, tool.repo.write.result]\n      required_evidence: [evidence.diff]\n    repo.patch:\n      emit_events: [tool.repo.patch.dispatch, tool.repo.patch.result]\n      required_evidence: [evidence.diff]\n    gate.typecheck:\n      emit_events: [tool.gate.typecheck.dispatch, tool.gate.typecheck.result]\n      required_evidence: [evidence.gate_logs]\n    gate.build:\n      emit_events: [tool.gate.build.dispatch, tool.gate.build.result]\n      required_evidence: [evidence.gate_logs]\n    gate.test:\n      emit_events: [tool.gate.test.dispatch, tool.gate.test.result]\n      required_evidence: [evidence.gate_logs]\n    patch.validate:\n      emit_events:\n        - tool.patch.validate.dispatch\n        - tool.patch.validate.result\n        - tool.patch.validate.error\n      required_evidence: [execution.tool_call]\n    git.commit:\n      emit_events:\n        - tool.git.commit.dispatch\n        - tool.git.commit.result\n        - tool.git.commit.approval_request\n        - tool.git.commit.approval_granted\n        - tool.git.commit.approval_denied\n      required_evidence: [evidence.diff, evidence.approval_decisions]\n    git.push:\n      emit_events:\n        - tool.git.push.dispatch\n        - tool.git.push.result\n        - tool.git.push.approval_request\n        - tool.git.push.approval_granted\n        - tool.git.push.approval_denied\n        - tool.git.push.dry_run_succeeded\n      required_evidence: [evidence.dry_run_logs, evidence.approval_decisions]\n    deploy.wrangler:\n      emit_events:\n        - tool.deploy.wrangler.dispatch\n        - tool.deploy.wrangler.result\n        - tool.deploy.wrangler.approval_request\n        - tool.deploy.wrangler.approval_granted\n        - tool.deploy.wrangler.approval_denied\n        - tool.deploy.wrangler.dry_run_succeeded\n      required_evidence: [evidence.dry_run_logs, evidence.approval_decisions]\n\nsafety_policy:\n  policy_version: \"0.1.0\"\n  path_allowlist:\n    - \"src/**\"\n    - \"web/src/**\"\n    - \"docs/**\"\n    - \"scripts/**\"\n    - \"tests/**\"\n    - \".learnings/**\"\n    - \"meeting/**\"\n  path_denylist:\n    - \"wrangler.toml\"\n    - \"package.json\"\n    - \"package-lock.json\"\n    - \"*.lock\"\n    - \"yarn.lock\"\n    - \"pnpm-lock.yaml\"\n  cross_repo_writes: denied_with_explicit_skillset\n  # global hard ban (force_push, secret put|delete, .git/, .env*, secrets/, kanban.advance(verified))\n  # is enforced by 177 fabric-level policy and not repeated here.\n\nobservability:\n  emit_events:\n    - skillset.software-dev.load\n    - skillset.software-dev.unload\n    - skillset.software-dev.switch_in\n    - skillset.software-dev.switch_out\n  inspect_surfaces:\n    - /api/inspect/skillset/software-dev\n  trace_correlation_id: software_dev_session_id\n\n# source-read budget harness v1.\n# Machine-readable mirror of the runtime thresholds in src/server.ts\n# `content_read` execute(). Drift between YAML and code is caught by\n# scripts/card247-source-read-budget-smoke.ts (asserts both sides).\n# Mode is warning_only: the runtime emits a `read_budget.warning`\n# event but does not block the read.\nsource_read_policy:\n  policy_version: \"0.1.0\"\n  default_max_bytes: 8192\n  large_read_threshold_bytes: 15360\n  mode: warning_only\n  warning_event: read_budget.warning\n\n# agentD git/diff/apply sandbox capability v1.\n# Declares the validate-only patch sandbox surface that backs agentD's\n# patch artifact deliveries. Implementation lives in\n# `scripts/sandbox/agentdPatchSandbox.ts`; failure-case reproduction is\n# `scripts/card248-agentd-patch-sandbox-smoke.ts --case=corrupt-hunk`.\n# The forbidden_ops list is hard policy: nothing in this surface\n# commits, pushes, or deploys.\nagentd_patch_sandbox_policy:\n  policy_version: \"0.1.0\"\n  surface: validate_only\n  permitted_ops:\n    - git_status_read\n    - git_diff_read\n    - git_apply_check\n    - git_apply_isolated\n    - lightweight_gate_run\n  forbidden_ops:\n    - git_commit\n    - git_push\n    - deploy\n    - cross_repo_write\n  required_checks:\n    - hunk_count_audit\n    - git_apply_check\n    - new_file_line_count_check\n    - lightweight_gate\n  evidence_payload_fields:\n    - baseRevision\n    - changedPaths\n    - hunkAudit\n    - gitApplyCheckOk\n    - gitApplyCheckStderr\n    - newFileEofOk\n    - newFileEofDetails\n    - gateCommand\n    - gateExitCode\n    - failureReason\n  failure_reasons:\n    - hunk_count_mismatch\n    - git_apply_check_failed\n    - new_file_truncated\n    - gate_failed\n  smoke: scripts/card248-agentd-patch-sandbox-smoke.ts\n  # an earlier revision: agentD-accessible dispatch surface around the same loop.\n  # Exposed as the `patch.validate` dynamic tool; failure-case\n  # reproduction through the agent surface is\n  # `scripts/card248a-agentd-patch-sandbox-tool-surface-smoke.ts`.\n  tool_surface:\n    tool_id: patch.validate\n    contract: docs/tools/patch.validate.0.1.0.yaml\n    smoke: scripts/card248a-agentd-patch-sandbox-tool-surface-smoke.ts\n\npolicy:\n  surface_modes: [enable]\n  default_tier_cap: 5\n  per_tier_approval:\n    \"4\": { required: true, scope: per_call, reason_required: true, reviewer: operator, token_lifetime_seconds: 1800 }\n    \"5\": { required: true, scope: per_call, reason_required: true, reviewer: operator, token_lifetime_seconds: 900 }\n  load_priority: 100\n";
const SOFTWARE_DEV_MANIFEST = ({
  "id": "software-dev",
  "name": "Software Development",
  "description": "AgentThursday agent 参与 AgentThursday / AgentThursday 自身代码开发的能力包；可以读源码、改代码、跑 gate、产 evidence、把 working-tree/patch artifact 交给agentP verifier 验收；commit/push/deploy 由 verifier 收口，操作员 负责指挥/裁决。",
  "version": "0.1.0",
  "purpose": "let agent participate in AgentThursday self-development under controlled boundaries",
  "dependencies": [
    "observability",
    "communication"
  ],
  "tools": [
    "repo.read",
    "repo.glob",
    "repo.grep",
    "kanban.read",
    "kanban.list",
    "git.status",
    "git.diff",
    "git.log",
    "git.show",
    "inspect.self.task",
    "inspect.self.events",
    "inspect.self.trace",
    "repo.write",
    "repo.patch",
    "repo.delete",
    "gate.typecheck",
    "gate.build",
    "gate.dry_run",
    "gate.test",
    "git.add",
    "git.commit",
    "git.branch",
    "kanban.advance",
    "kanban.create",
    "git.push",
    "deploy.wrangler",
    "patch.validate"
  ],
  "skills": [
    {
      "id": "code.read",
      "name": "Read Repository Source",
      "description": "读 repo 文件、grep / glob 定位代码",
      "tier": 2,
      "tools": [
        "repo.read",
        "repo.glob",
        "repo.grep"
      ],
      "prompt_segment": "读源码前必须 repo.glob 或 repo.grep 定位，不基于记忆假设路径。优先读命中\nsnippet / 小范围上下文，避免一次性读取大文件；确需读大文件时先说明原因并设置\n明确 maxBytes。读到内容后保留上下文 3-5 行，避免误判 surrounding context。\n若任务来自 Discord/外部协作，不要假设能看到agentP host 文件系统；以 GitHub repo\n/ base commit / patch handoff 为准，并在 completion 中写清楚产物如何交回。\n声称“已读/已搜/已改”必须可被 trace 证明；报告时带 tool/event、path、行范围\n或结果摘要。truthfulness gate 标红时，先降级为未验证并检查 inspect.self.events。\n\n行范围验证规则：验证任务要求“check line range N..M”时，必须用\nrepo.read 的行范围参数（offset/limit）或 repo.grep 抓命中行附近 snippet。\n如果只有 whole-file repo.read 可用且结果出现 truncated=true，**必须**把对应\nline-range claim 标为 CONDITIONAL 或 UNVERIFIED，不能写 PASS；truncated read\n只能证明“看到前缀”，不能证明任意行号内容。",
      "input_contract": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string"
          },
          "pattern": {
            "type": "string"
          }
        },
        "oneOf": [
          {
            "required": [
              "path"
            ]
          },
          {
            "required": [
              "pattern"
            ]
          }
        ]
      },
      "output_contract": {
        "type": "object",
        "properties": {
          "files": {
            "type": "array",
            "items": {
              "type": "object"
            }
          }
        }
      }
    },
    {
      "id": "kanban.lookup",
      "name": "Read Kanban Cards",
      "description": "读 kanban 卡 body / list todo 卡",
      "tier": 2,
      "tools": [
        "kanban.read",
        "kanban.list"
      ],
      "prompt_segment": "推进任何卡前必须先 kanban.read 看 spec；不基于卡名猜内容。",
      "input_contract": {
        "type": "object",
        "oneOf": [
          {
            "required": [
              "card_id"
            ],
            "properties": {
              "card_id": {
                "type": "string"
              }
            }
          },
          {
            "required": [
              "filter"
            ],
            "properties": {
              "filter": {
                "type": "string"
              }
            }
          }
        ]
      }
    },
    {
      "id": "vcs.inspect",
      "name": "Inspect Git State",
      "description": "git status / diff / log / show 只读查询",
      "tier": 2,
      "tools": [
        "git.status",
        "git.diff",
        "git.log",
        "git.show"
      ],
      "prompt_segment": "改动前看一眼 git.status / git.diff，确认起点干净；commit 前用 git.diff --staged\nreview 自己将要 commit 的内容。"
    },
    {
      "id": "inspect.self",
      "name": "Inspect Own Runtime",
      "description": "查 agent 自己的 task / event / trace",
      "tier": 2,
      "tools": [
        "inspect.self.task",
        "inspect.self.events",
        "inspect.self.trace"
      ],
      "prompt_segment": "想知道 \"我刚才用了什么工具\" 时查 inspect.self.events，不要靠记忆 reconstruct。"
    },
    {
      "id": "code.edit",
      "name": "Edit Repository Source",
      "description": "在 path allowlist 内做最小 patch / write",
      "tier": 3,
      "tools": [
        "repo.write",
        "repo.patch",
        "repo.delete"
      ],
      "prompt_segment": "最小 patch 优先：repo.patch 改一行能解决就不 repo.write 全文。每次改完后必须\ngate.typecheck（post-patch-gate-check verification_hook 强制）。\nan earlier revision：只要本轮调用过 repo.write 或 repo.patch，结束前**必须真实调用**\n至少一个 gate（默认顺序 gate.typecheck → gate.build）。只在回复里说\"我会跑/\n已跑 typecheck\"不算数——没有真实 gate tool call，envelope 会 seal 成\nmissing_gate_evidence。若因明确 blocker 不能跑 gate，必须在回复和 trace 里写清\n具体原因。"
    },
    {
      "id": "gate.run",
      "name": "Run Build / Test Gates",
      "description": "typecheck / build / test / dry_run；保留 stdout/stderr/exit",
      "tier": 3,
      "tools": [
        "gate.typecheck",
        "gate.build",
        "gate.dry_run",
        "gate.test"
      ],
      "prompt_segment": "gate 失败不是 retry 借口，是 stop signal。exit_code != 0 必须停下读 stderr，\n理解后再继续。"
    },
    {
      "id": "patch.sandbox",
      "name": "Validate Patch Candidate (Sandbox)",
      "description": "把 patch artifact 提交给 validate-only sandbox，返回结构化 evidence；不暴露 commit/push/deploy",
      "tier": 2,
      "tools": [
        "patch.validate"
      ],
      "prompt_segment": "在把 patch artifact 交给agentP 之前，先用 patch.validate 跑一遍：hunk-count\naudit + git apply --check + 隔离 apply + 新文件 EOF 校验，可选 node --check\nlightweight gate。输入用 artifact.write 后的 cardId + filename 引用，或\n直接传 patchText（前者带 sha256 evidence，优先用 ref）。\nfailureReason='hunk_count_mismatch' 是 243 类缺陷的强信号，不要重交；先\n重新生成 patch 再 validate。这条 surface 只读写 ephemeral /tmp 沙盒，不\n会触 commit/push/deploy。",
      "capability_class": "callable_tool_ready",
      "source_ref": {
        "provider": "internal",
        "reference": "docs/tools/patch.validate.0.1.0.yaml"
      },
      "evidence_requirements": [
        "result.ok",
        "result.baseRevision",
        "result.changedPaths",
        "result.hunkAudit",
        "result.gitApplyCheckOk",
        "result.newFileEofOk"
      ]
    },
    {
      "id": "vcs.mutate",
      "name": "Local VCS Mutation",
      "description": "stage / commit / branch（必须 approval）",
      "tier": 4,
      "tools": [
        "git.add",
        "git.commit",
        "git.branch"
      ],
      "requires_approval": {
        "required": true,
        "scope": "per_call",
        "reason_required": true,
        "reviewer": "operator",
        "token_lifetime_seconds": 1800
      },
      "prompt_segment": "commit 前必须 git.diff --staged review；commit message 写明卡号 + 一句话改动。\n不要 squash 多卡。"
    },
    {
      "id": "kanban.mutate",
      "name": "Kanban State Mutation",
      "description": "advance card / create new card（必须 approval）",
      "tier": 4,
      "tools": [
        "kanban.advance",
        "kanban.create"
      ],
      "requires_approval": {
        "required": true,
        "scope": "per_call",
        "reason_required": true,
        "reviewer": "operator",
        "token_lifetime_seconds": 1800
      },
      "prompt_segment": "kanban.advance 不允许 target_status='verified'（hard ban，verifier 专用）。\n只能推到 ready-for-review / done。"
    },
    {
      "id": "vcs.publish",
      "name": "Push Branch to Remote",
      "description": "git.push（必须 approval；不暴露 force-push）",
      "tier": 5,
      "tools": [
        "git.push"
      ],
      "requires_approval": {
        "required": true,
        "scope": "per_call",
        "reason_required": true,
        "reviewer": "operator",
        "token_lifetime_seconds": 900
      },
      "prompt_segment": "push 前必须 git.push 的 dry-run PASS；reason 必填，写明本次 push 的卡号 + 影响范围。"
    },
    {
      "id": "deploy.workers",
      "name": "Deploy Cloudflare Worker",
      "description": "wrangler deploy（必须 approval + 强制 dry-run）",
      "tier": 5,
      "tools": [
        "deploy.wrangler"
      ],
      "requires_approval": {
        "required": true,
        "scope": "per_call",
        "reason_required": true,
        "reviewer": "operator",
        "token_lifetime_seconds": 900
      },
      "prompt_segment": "deploy 前必须有 wrangler dry-run PASS evidence；reason 必填，写明部署目标\nversion + 期望 effect + rollback 路径。"
    }
  ],
  "workflow_patterns": [
    {
      "name": "minimum-change-loop",
      "when": "面对 bug fix / 小型 feature card",
      "steps": [
        "kanban.read 卡 spec 确认 scope",
        "repo.grep / repo.glob 定位代码",
        "repo.read 读上下文",
        "repo.patch 做最小改动",
        "gate.typecheck（必须）+ gate.build / gate.test（视卡）",
        "git.diff 查看产出 diff",
        "卡 body 写 completion report",
        "kanban.advance 到 ready-for-review（approval）"
      ],
      "completion_signal": "completion report 在卡 body + .md.done + test doc"
    },
    {
      "name": "search-first-edit",
      "when": "需要修改但不确定具体位置",
      "steps": [
        "repo.grep 定位所有相关位置",
        "repo.read 读所有命中位置上下文",
        "再决定改哪一处 / 多处"
      ]
    },
    {
      "name": "fail-fast-stop",
      "when": "gate 失败 / approval denied / 工具 error",
      "steps": [
        "停止当前 step，不要 retry",
        "inspect.self.events 看 error 详情",
        "在卡 body 记录失败原因 + 建议下一步",
        "等人类 unblock"
      ]
    }
  ],
  "reasoning_protocol": {
    "principles": [
      "先检索再修改：不基于记忆假设代码位置",
      "读源码要有预算：grep/glob 定位后读 snippet；大文件必须说明原因并限制 maxBytes",
      "外部协作要写清 handoff：GitHub repo、base commit、patch/PR/附件交付方式",
      "最小 patch 优先：改一行能解决不改十行",
      "先验证再汇报：跑完 gate 才声称完成",
      "证据先行：没有 trace/diff/test log 的 claim 不可信"
    ],
    "anti_patterns": [
      "不要基于记忆假设文件路径，必须 grep/glob",
      "不要全文读取大文件来找位置；先搜索，再读命中行附近 snippet",
      "不要把agentP host 路径当作外部 agent 可见文件系统；外部交付必须用 repo/patch/PR/附件",
      "不要在 trace 没有对应 dispatch 时声称已读/已搜/已改",
      "不要跳过测试直接写 completion report",
      "不要在没有 diff 的情况下声称已修改",
      "不要一边 patch 一边 commit；默认交 working-tree / patch artifact 给agentP verifier，由 verifier 验收后 commit/push",
      "不要声称 操作员 会手动 merge；操作员 负责指挥/裁决，verifier 负责验收和收口",
      "不要 squash 多卡；一卡一 commit"
    ],
    "verification_hooks": [
      {
        "name": "post-patch-gate-check",
        "trigger": "after any code.edit invocation",
        "action": "run gate.typecheck before claiming completion"
      },
      {
        "name": "pre-commit-diff-review",
        "trigger": "before any vcs.mutate(git.commit) invocation",
        "action": "run git.diff --staged and verify scope matches card"
      }
    ]
  },
  "evidence_protocol": {
    "protocol_version": "0.1.0",
    "required_envelope": [
      "intent",
      "execution",
      "evidence",
      "self_verify"
    ],
    "per_tool_emit": {
      "repo.write": {
        "emit_events": [
          "tool.repo.write.dispatch",
          "tool.repo.write.result"
        ],
        "required_evidence": [
          "evidence.diff"
        ]
      },
      "repo.patch": {
        "emit_events": [
          "tool.repo.patch.dispatch",
          "tool.repo.patch.result"
        ],
        "required_evidence": [
          "evidence.diff"
        ]
      },
      "gate.typecheck": {
        "emit_events": [
          "tool.gate.typecheck.dispatch",
          "tool.gate.typecheck.result"
        ],
        "required_evidence": [
          "evidence.gate_logs"
        ]
      },
      "gate.build": {
        "emit_events": [
          "tool.gate.build.dispatch",
          "tool.gate.build.result"
        ],
        "required_evidence": [
          "evidence.gate_logs"
        ]
      },
      "gate.test": {
        "emit_events": [
          "tool.gate.test.dispatch",
          "tool.gate.test.result"
        ],
        "required_evidence": [
          "evidence.gate_logs"
        ]
      },
      "patch.validate": {
        "emit_events": [
          "tool.patch.validate.dispatch",
          "tool.patch.validate.result",
          "tool.patch.validate.error"
        ],
        "required_evidence": [
          "execution.tool_call"
        ]
      },
      "git.commit": {
        "emit_events": [
          "tool.git.commit.dispatch",
          "tool.git.commit.result",
          "tool.git.commit.approval_request",
          "tool.git.commit.approval_granted",
          "tool.git.commit.approval_denied"
        ],
        "required_evidence": [
          "evidence.diff",
          "evidence.approval_decisions"
        ]
      },
      "git.push": {
        "emit_events": [
          "tool.git.push.dispatch",
          "tool.git.push.result",
          "tool.git.push.approval_request",
          "tool.git.push.approval_granted",
          "tool.git.push.approval_denied",
          "tool.git.push.dry_run_succeeded"
        ],
        "required_evidence": [
          "evidence.dry_run_logs",
          "evidence.approval_decisions"
        ]
      },
      "deploy.wrangler": {
        "emit_events": [
          "tool.deploy.wrangler.dispatch",
          "tool.deploy.wrangler.result",
          "tool.deploy.wrangler.approval_request",
          "tool.deploy.wrangler.approval_granted",
          "tool.deploy.wrangler.approval_denied",
          "tool.deploy.wrangler.dry_run_succeeded"
        ],
        "required_evidence": [
          "evidence.dry_run_logs",
          "evidence.approval_decisions"
        ]
      }
    }
  },
  "safety_policy": {
    "policy_version": "0.1.0",
    "path_allowlist": [
      "src/**",
      "web/src/**",
      "docs/**",
      "scripts/**",
      "tests/**",
      ".learnings/**",
      "meeting/**"
    ],
    "path_denylist": [
      "wrangler.toml",
      "package.json",
      "package-lock.json",
      "*.lock",
      "yarn.lock",
      "pnpm-lock.yaml"
    ],
    "cross_repo_writes": "denied_with_explicit_skillset"
  },
  "observability": {
    "emit_events": [
      "skillset.software-dev.load",
      "skillset.software-dev.unload",
      "skillset.software-dev.switch_in",
      "skillset.software-dev.switch_out"
    ],
    "inspect_surfaces": [
      "/api/inspect/skillset/software-dev"
    ],
    "trace_correlation_id": "software_dev_session_id"
  },
  "source_read_policy": {
    "policy_version": "0.1.0",
    "default_max_bytes": 8192,
    "large_read_threshold_bytes": 15360,
    "mode": "warning_only",
    "warning_event": "read_budget.warning"
  },
  "agentd_patch_sandbox_policy": {
    "policy_version": "0.1.0",
    "surface": "validate_only",
    "permitted_ops": [
      "git_status_read",
      "git_diff_read",
      "git_apply_check",
      "git_apply_isolated",
      "lightweight_gate_run"
    ],
    "forbidden_ops": [
      "git_commit",
      "git_push",
      "deploy",
      "cross_repo_write"
    ],
    "required_checks": [
      "hunk_count_audit",
      "git_apply_check",
      "new_file_line_count_check",
      "lightweight_gate"
    ],
    "evidence_payload_fields": [
      "baseRevision",
      "changedPaths",
      "hunkAudit",
      "gitApplyCheckOk",
      "gitApplyCheckStderr",
      "newFileEofOk",
      "newFileEofDetails",
      "gateCommand",
      "gateExitCode",
      "failureReason"
    ],
    "failure_reasons": [
      "hunk_count_mismatch",
      "git_apply_check_failed",
      "new_file_truncated",
      "gate_failed"
    ],
    "smoke": "scripts/card248-agentd-patch-sandbox-smoke.ts",
    "tool_surface": {
      "tool_id": "patch.validate",
      "contract": "docs/tools/patch.validate.0.1.0.yaml",
      "smoke": "scripts/card248a-agentd-patch-sandbox-tool-surface-smoke.ts"
    }
  },
  "policy": {
    "surface_modes": [
      "enable"
    ],
    "default_tier_cap": 5,
    "per_tier_approval": {
      "4": {
        "required": true,
        "scope": "per_call",
        "reason_required": true,
        "reviewer": "operator",
        "token_lifetime_seconds": 1800
      },
      "5": {
        "required": true,
        "scope": "per_call",
        "reason_required": true,
        "reviewer": "operator",
        "token_lifetime_seconds": 900
      }
    },
    "load_priority": 100
  }
}) as unknown as SkillsetManifest;

export const EMBEDDED_MANIFESTS: EmbeddedManifest[] = [
  { id: "artifact-delivery", source_yaml: ARTIFACT_DELIVERY_YAML, manifest: ARTIFACT_DELIVERY_MANIFEST },
  { id: "manager", source_yaml: MANAGER_YAML, manifest: MANAGER_MANIFEST },
  { id: "qa-reviewer-basic", source_yaml: QA_REVIEWER_BASIC_YAML, manifest: QA_REVIEWER_BASIC_MANIFEST },
  { id: "software-dev", source_yaml: SOFTWARE_DEV_YAML, manifest: SOFTWARE_DEV_MANIFEST },
];
