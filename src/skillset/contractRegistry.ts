/**
 *  tool contract registry.
 *
 * Authority:  (176).
 *
 * v1 covers the 26 tool_ids referenced by `software-dev` v0 manifest.
 * `research-stub`'s `web.search / web.fetch / pdf.read` are
 * intentionally absent so the loader's V2 check rejects research-stub
 * (per 181a + 182 verification path).
 *
 * Every contract here has `implemented: false` for  — registry
 * exists at the contract layer, but no runtime dispatch yet. 184/185/
 * 186 will flip individual tools to `implemented: true` as they ship.
 *
 * Registry is purely data: no skillset_id branching, no task-type
 * branching. New tools added here are immediately referenceable from
 * any future skillset manifest.
 */

import type { Tier } from "./types";

export type SideEffectClass =
  | "none"
  | "local_state"
  | "repo_read"
  | "repo_write"
  | "gate_execution"
  | "vcs_local"
  | "kanban_local"
  | "vcs_remote"
  | "deploy_remote"
  | "network_call"
  | "irreversible";

export type DispatchSurface =
  | "do_method"
  | "fetch_path"
  | "codemode_entry"
  | "mcp_tool"
  | "subagent";

export type EventWhen =
  | "dispatch"
  | "result"
  | "error"
  | "approval_request"
  | "approval_granted"
  | "approval_denied"
  | "dry_run_succeeded";

export interface IdempotencyKeySpec {
  shape: "inputs_hash" | "explicit_key" | "none";
  fields?: string[];
}

export interface EmitEventSpec {
  name: string;
  when: EventWhen;
}

export interface RequiredEvidenceField {
  field: string;
  required: boolean;
}

export interface ToolContract {
  tool_id: string;
  description: string;
  dispatch_path: { surface: DispatchSurface; identifier: string };
  input_schema: unknown;
  output_schema: unknown;
  side_effects: SideEffectClass[];
  idempotency_key?: IdempotencyKeySpec;
  dry_run_supported: boolean;
  tier: Tier;
  emit_events: EmitEventSpec[];
  required_evidence: RequiredEvidenceField[];
  implemented: boolean;
  //  — generic optional declaration that this tool needs a
  // specific env binding to reach `callable_tool_ready`. The downgrade
  // pipeline currently keys off `skill.source_ref.env_binding` (per
  // ), so this field is informational at the contract layer
  // — readers can use it to identify the canonical env binding name
  // without parsing a skill manifest. Must be a non-empty string when
  // present; not provider-specific.
  env_binding?: string;
}

const objectSchema = (props: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties: props,
  ...(required.length ? { required } : {}),
});

const stringField = { type: "string" };
const integerField = { type: "integer" };

function readEvents(toolId: string): EmitEventSpec[] {
  return [
    { name: `tool.${toolId}.dispatch`, when: "dispatch" },
    { name: `tool.${toolId}.result`, when: "result" },
  ];
}

function writeEvents(toolId: string): EmitEventSpec[] {
  return [
    { name: `tool.${toolId}.dispatch`, when: "dispatch" },
    { name: `tool.${toolId}.result`, when: "result" },
    { name: `tool.${toolId}.error`, when: "error" },
  ];
}

function approvalEvents(toolId: string, withDryRun: boolean): EmitEventSpec[] {
  const base: EmitEventSpec[] = [
    { name: `tool.${toolId}.dispatch`, when: "dispatch" },
    { name: `tool.${toolId}.result`, when: "result" },
    { name: `tool.${toolId}.error`, when: "error" },
    { name: `tool.${toolId}.approval_request`, when: "approval_request" },
    { name: `tool.${toolId}.approval_granted`, when: "approval_granted" },
    { name: `tool.${toolId}.approval_denied`, when: "approval_denied" },
  ];
  if (withDryRun) {
    base.push({ name: `tool.${toolId}.dry_run_succeeded`, when: "dry_run_succeeded" });
  }
  return base;
}

const exec = (_s: string) => ({ field: "execution.tool_call", required: true } as const);

const CONTRACTS: ToolContract[] = [
  // --- T2 read tier ---
  {
    tool_id: "repo.read",
    description: "Read a single file from the agentthursday / AT repo working tree",
    dispatch_path: { surface: "do_method", identifier: "WorkspaceDO.repoRead" },
    input_schema: objectSchema(
      { path: stringField, encoding: { type: "string", default: "utf8" } },
      ["path"],
    ),
    output_schema: objectSchema({ content: stringField, size_bytes: integerField }, ["content"]),
    side_effects: ["repo_read"],
    dry_run_supported: false,
    tier: 2,
    emit_events: readEvents("repo.read"),
    required_evidence: [exec("repo.read")],
    implemented: true,
  },
  {
    tool_id: "repo.glob",
    description: "Glob match repo paths against a pattern",
    dispatch_path: { surface: "do_method", identifier: "WorkspaceDO.repoGlob" },
    input_schema: objectSchema({ pattern: stringField, base_path: stringField }, ["pattern"]),
    output_schema: objectSchema({ paths: { type: "array", items: stringField } }),
    side_effects: ["repo_read"],
    dry_run_supported: false,
    tier: 2,
    emit_events: readEvents("repo.glob"),
    required_evidence: [exec("repo.glob")],
    implemented: true,
  },
  {
    tool_id: "repo.grep",
    description: "Grep recursively from a base path",
    dispatch_path: { surface: "do_method", identifier: "WorkspaceDO.repoGrep" },
    input_schema: objectSchema(
      {
        pattern: stringField,
        base_path: { type: "string", default: "." },
        include_glob: stringField,
      },
      ["pattern"],
    ),
    output_schema: objectSchema({
      matches: {
        type: "array",
        items: objectSchema({
          file: stringField,
          line: integerField,
          text: stringField,
        }),
      },
    }),
    side_effects: ["repo_read"],
    dry_run_supported: false,
    tier: 2,
    emit_events: readEvents("repo.grep"),
    required_evidence: [exec("repo.grep")],
    implemented: true,
  },
  {
    tool_id: "kanban.read",
    description: "Read a kanban card body by id",
    dispatch_path: { surface: "do_method", identifier: "KanbanDO.read" },
    input_schema: objectSchema(
      { card_id: { type: "string", pattern: "^[0-9]+[a-z]?$" } },
      ["card_id"],
    ),
    output_schema: objectSchema({
      body: stringField,
      status: { enum: ["todo", "in_progress", "done", "verified"] },
    }),
    side_effects: ["repo_read"],
    dry_run_supported: false,
    tier: 2,
    emit_events: readEvents("kanban.read"),
    required_evidence: [exec("kanban.read")],
    implemented: false,
  },
  {
    tool_id: "kanban.list",
    description: "List kanban cards by filter",
    dispatch_path: { surface: "do_method", identifier: "KanbanDO.list" },
    input_schema: objectSchema({
      filter: { type: "string", description: "todo|in_progress|done|verified|all" },
    }),
    output_schema: objectSchema({
      cards: { type: "array", items: objectSchema({ id: stringField, status: stringField }) },
    }),
    side_effects: ["repo_read"],
    dry_run_supported: false,
    tier: 2,
    emit_events: readEvents("kanban.list"),
    required_evidence: [exec("kanban.list")],
    implemented: false,
  },
  {
    //  A — first-party `repo.prepare` tool. Materializes the
    // sandbox checkout (allowlisted repo only; no token leak; no push)
    // and returns head_sha + branch + worktree_path + git_status so
    // subsequent repo.write / repo.patch / gate.* operate on a known
    // worktree instead of an empty Tier-0 workspace.
    tool_id: "repo.prepare",
    description: "Materialize a controlled worktree of the allowlisted repo. Returns head_sha, branch, worktree_path, and git status. Required before repo.write / repo.patch.",
    dispatch_path: { surface: "do_method", identifier: "WorkspaceDO.repoPrepare" },
    input_schema: objectSchema({
      repo_id: stringField,
      branch: stringField,
      task_id: stringField,
    }),
    output_schema: objectSchema({
      head_sha: stringField,
      branch: stringField,
      worktree_path: stringField,
      git_status: stringField,
    }, ["head_sha", "branch", "worktree_path"]),
    side_effects: ["repo_read"],
    dry_run_supported: false,
    tier: 2,
    emit_events: readEvents("repo.prepare"),
    required_evidence: [exec("repo.prepare")],
    implemented: true,
  },
  {
    tool_id: "git.status",
    description: "git status (porcelain) snapshot of working tree",
    dispatch_path: { surface: "do_method", identifier: "WorkspaceDO.gitStatus" },
    input_schema: objectSchema({}),
    output_schema: objectSchema({ porcelain: stringField }),
    side_effects: ["repo_read"],
    dry_run_supported: false,
    tier: 2,
    emit_events: readEvents("git.status"),
    required_evidence: [exec("git.status")],
    implemented: true,
  },
  {
    tool_id: "git.diff",
    description: "git diff for staged + unstaged changes",
    dispatch_path: { surface: "do_method", identifier: "WorkspaceDO.gitDiff" },
    input_schema: objectSchema({ staged: { type: "boolean" }, base_ref: stringField }),
    output_schema: objectSchema({ unified_diff: stringField }),
    side_effects: ["repo_read"],
    dry_run_supported: false,
    tier: 2,
    emit_events: readEvents("git.diff"),
    required_evidence: [exec("git.diff")],
    implemented: true,
  },
  {
    tool_id: "git.log",
    description: "git log range",
    dispatch_path: { surface: "do_method", identifier: "WorkspaceDO.gitLog" },
    input_schema: objectSchema({
      max_count: integerField,
      base_ref: stringField,
      head_ref: stringField,
    }),
    output_schema: objectSchema({
      commits: {
        type: "array",
        items: objectSchema({ sha: stringField, summary: stringField, ts: stringField }),
      },
    }),
    side_effects: ["repo_read"],
    dry_run_supported: false,
    tier: 2,
    emit_events: readEvents("git.log"),
    required_evidence: [exec("git.log")],
    implemented: true,
  },
  {
    tool_id: "git.show",
    description: "git show a commit / blob",
    dispatch_path: { surface: "do_method", identifier: "WorkspaceDO.gitShow" },
    input_schema: objectSchema({ ref: stringField, path: stringField }, ["ref"]),
    output_schema: objectSchema({ content: stringField }),
    side_effects: ["repo_read"],
    dry_run_supported: false,
    tier: 2,
    emit_events: readEvents("git.show"),
    required_evidence: [exec("git.show")],
    implemented: true,
  },
  {
    tool_id: "inspect.self.task",
    description: "Inspect a specific task's snapshot for the current agent",
    dispatch_path: { surface: "fetch_path", identifier: "/api/inspect/task/{taskId}" },
    input_schema: objectSchema({ task_id: stringField }, ["task_id"]),
    output_schema: objectSchema({ task: { type: "object" } }),
    side_effects: ["none"],
    dry_run_supported: false,
    tier: 2,
    emit_events: readEvents("inspect.self.task"),
    required_evidence: [exec("inspect.self.task")],
    implemented: false,
  },
  {
    tool_id: "inspect.self.events",
    description: "Inspect tool / lifecycle events for the current agent",
    dispatch_path: { surface: "fetch_path", identifier: "/api/inspect.toolEvents" },
    input_schema: objectSchema({ task_id: stringField }),
    output_schema: objectSchema({ events: { type: "array" } }),
    side_effects: ["none"],
    dry_run_supported: false,
    tier: 2,
    emit_events: readEvents("inspect.self.events"),
    required_evidence: [exec("inspect.self.events")],
    implemented: false,
  },
  {
    tool_id: "inspect.self.trace",
    description: "Inspect supplier signal trace for the current agent",
    dispatch_path: { surface: "fetch_path", identifier: "/api/inspect" },
    input_schema: objectSchema({ task_id: stringField }),
    output_schema: objectSchema({ trace: { type: "array" } }),
    side_effects: ["none"],
    dry_run_supported: false,
    tier: 2,
    emit_events: readEvents("inspect.self.trace"),
    required_evidence: [exec("inspect.self.trace")],
    implemented: false,
  },

  // --- T3 write / gate tier ---
  {
    tool_id: "repo.write",
    description: "Write file content within skillset path allowlist",
    dispatch_path: { surface: "do_method", identifier: "WorkspaceDO.repoWrite" },
    input_schema: objectSchema(
      {
        path: stringField,
        content: stringField,
        expected_existing_hash: stringField,
      },
      ["path", "content"],
    ),
    output_schema: objectSchema(
      { applied: { type: "boolean" }, bytes_written: integerField, sha256: stringField },
      ["applied"],
    ),
    side_effects: ["repo_write"],
    idempotency_key: { shape: "inputs_hash", fields: ["path", "content"] },
    dry_run_supported: true,
    tier: 3,
    emit_events: writeEvents("repo.write"),
    required_evidence: [exec("repo.write"), { field: "evidence.diff", required: true }],
    implemented: true,
  },
  {
    tool_id: "repo.patch",
    description: "Apply an exact-match find/replace patch to a file",
    dispatch_path: { surface: "do_method", identifier: "WorkspaceDO.repoPatch" },
    input_schema: objectSchema(
      { path: stringField, old_string: stringField, new_string: stringField },
      ["path", "old_string", "new_string"],
    ),
    output_schema: objectSchema(
      { applied: { type: "boolean" } },
      ["applied"],
    ),
    side_effects: ["repo_write"],
    idempotency_key: { shape: "inputs_hash", fields: ["path", "old_string", "new_string"] },
    dry_run_supported: true,
    tier: 3,
    emit_events: writeEvents("repo.patch"),
    required_evidence: [exec("repo.patch"), { field: "evidence.diff", required: true }],
    implemented: true,
  },
  {
    tool_id: "repo.delete",
    description: "Delete a file (path allowlist enforced; per-call approval)",
    dispatch_path: { surface: "do_method", identifier: "WorkspaceDO.repoDelete" },
    input_schema: objectSchema({ path: stringField }, ["path"]),
    output_schema: objectSchema({ deleted: { type: "boolean" } }, ["deleted"]),
    side_effects: ["repo_write"],
    idempotency_key: { shape: "inputs_hash", fields: ["path"] },
    dry_run_supported: true,
    tier: 3,
    emit_events: writeEvents("repo.delete"),
    required_evidence: [exec("repo.delete")],
    implemented: true,
  },
  {
    tool_id: "gate.typecheck",
    description: "Run npm run typecheck and capture stdout/stderr/exit",
    dispatch_path: { surface: "do_method", identifier: "WorkspaceDO.gateTypecheck" },
    input_schema: objectSchema({ target_dir: { type: "string", default: "." } }),
    output_schema: objectSchema(
      { exit_code: integerField, stdout: stringField, stderr: stringField, duration_ms: integerField },
      ["exit_code", "stdout", "stderr"],
    ),
    side_effects: ["gate_execution"],
    dry_run_supported: false,
    tier: 3,
    emit_events: writeEvents("gate.typecheck"),
    required_evidence: [
      { field: "evidence.gate_log.exit_code", required: true },
      { field: "evidence.gate_log.stdout", required: true },
    ],
    implemented: true,
  },
  {
    tool_id: "gate.build",
    description: "Run npm run build:web and capture artifacts + log",
    dispatch_path: { surface: "do_method", identifier: "WorkspaceDO.gateBuild" },
    input_schema: objectSchema({ target_dir: { type: "string", default: "." } }),
    output_schema: objectSchema(
      { exit_code: integerField, stdout: stringField, stderr: stringField, duration_ms: integerField },
      ["exit_code", "stdout", "stderr"],
    ),
    side_effects: ["gate_execution"],
    dry_run_supported: false,
    tier: 3,
    emit_events: writeEvents("gate.build"),
    required_evidence: [
      { field: "evidence.gate_log.exit_code", required: true },
      { field: "evidence.gate_log.stdout", required: true },
    ],
    implemented: true,
  },
  {
    tool_id: "gate.dry_run",
    description: "Run a wrangler / build dry-run and capture preview",
    dispatch_path: { surface: "do_method", identifier: "WorkspaceDO.gateDryRun" },
    input_schema: objectSchema({ target: { enum: ["wrangler", "vite"] } }, ["target"]),
    output_schema: objectSchema({ exit_code: integerField, stdout: stringField, stderr: stringField }),
    side_effects: ["gate_execution"],
    dry_run_supported: false,
    tier: 3,
    emit_events: writeEvents("gate.dry_run"),
    required_evidence: [
      { field: "evidence.gate_log.exit_code", required: true },
      { field: "evidence.gate_log.stdout", required: true },
    ],
    implemented: true,
  },
  {
    tool_id: "gate.test",
    description: "Run npm test and capture stdout/stderr/exit",
    dispatch_path: { surface: "do_method", identifier: "WorkspaceDO.gateTest" },
    input_schema: objectSchema({ filter: stringField }),
    output_schema: objectSchema(
      { exit_code: integerField, stdout: stringField, stderr: stringField },
      ["exit_code", "stdout", "stderr"],
    ),
    side_effects: ["gate_execution"],
    dry_run_supported: false,
    tier: 3,
    emit_events: writeEvents("gate.test"),
    required_evidence: [
      { field: "evidence.gate_log.exit_code", required: true },
      { field: "evidence.gate_log.stdout", required: true },
    ],
    implemented: true,
  },

  // --- T3 external network callable ---
  //  migrated `localdoc.convert_text` out of this hand-written
  // array into `docs/tools/localdoc.convert_text.0.1.0.yaml`. The YAML
  // is unioned in via `GENERATED_TOOL_CONTRACTS` below; the merge
  // throws on duplicate tool_ids so the YAML and TS surfaces never
  // silently diverge.

  // --- T4 local mutation tier (approval required) ---
  {
    tool_id: "git.add",
    description: "Stage paths (approval required at skillset level)",
    dispatch_path: { surface: "do_method", identifier: "WorkspaceDO.gitAdd" },
    input_schema: objectSchema({ paths: { type: "array", items: stringField } }, ["paths"]),
    output_schema: objectSchema({ staged: { type: "array", items: stringField } }, ["staged"]),
    side_effects: ["vcs_local"],
    idempotency_key: { shape: "inputs_hash", fields: ["paths"] },
    dry_run_supported: true,
    tier: 4,
    emit_events: approvalEvents("git.add", false),
    required_evidence: [exec("git.add"), { field: "evidence.approval_decision", required: true }],
    implemented: false,
  },
  {
    tool_id: "git.commit",
    description: "Create a local commit with staged changes (approval required)",
    dispatch_path: { surface: "do_method", identifier: "WorkspaceDO.gitCommit" },
    input_schema: objectSchema(
      { message: stringField, sign_off: { type: "boolean" } },
      ["message"],
    ),
    output_schema: objectSchema(
      { commit_sha: { type: "string", pattern: "^[0-9a-f]{7,40}$" } },
      ["commit_sha"],
    ),
    side_effects: ["vcs_local"],
    idempotency_key: { shape: "inputs_hash", fields: ["staged_tree_sha", "message"] },
    dry_run_supported: true,
    tier: 4,
    emit_events: approvalEvents("git.commit", false),
    required_evidence: [
      exec("git.commit"),
      { field: "evidence.diff", required: true },
      { field: "evidence.approval_decision", required: true },
    ],
    implemented: false,
  },
  {
    tool_id: "git.branch",
    description: "Create or switch a local branch (approval required)",
    dispatch_path: { surface: "do_method", identifier: "WorkspaceDO.gitBranch" },
    input_schema: objectSchema(
      { name: stringField, action: { enum: ["create", "switch", "delete"] } },
      ["name", "action"],
    ),
    output_schema: objectSchema({ ok: { type: "boolean" } }, ["ok"]),
    side_effects: ["vcs_local"],
    idempotency_key: { shape: "inputs_hash", fields: ["name", "action"] },
    dry_run_supported: true,
    tier: 4,
    emit_events: approvalEvents("git.branch", false),
    required_evidence: [exec("git.branch"), { field: "evidence.approval_decision", required: true }],
    implemented: false,
  },
  {
    tool_id: "kanban.advance",
    description: "Advance a kanban card status (approval required; verified is hard-banned)",
    dispatch_path: { surface: "do_method", identifier: "KanbanDO.advance" },
    input_schema: objectSchema(
      {
        card_id: stringField,
        target_status: { enum: ["in_progress", "done", "ready-for-review"] },
        reason: stringField,
      },
      ["card_id", "target_status"],
    ),
    output_schema: objectSchema({ status: stringField }, ["status"]),
    side_effects: ["kanban_local"],
    idempotency_key: { shape: "inputs_hash", fields: ["card_id", "target_status"] },
    dry_run_supported: true,
    tier: 4,
    emit_events: approvalEvents("kanban.advance", false),
    required_evidence: [exec("kanban.advance"), { field: "evidence.approval_decision", required: true }],
    implemented: false,
  },
  {
    tool_id: "kanban.create",
    description: "Create a new kanban card (approval required)",
    dispatch_path: { surface: "do_method", identifier: "KanbanDO.create" },
    input_schema: objectSchema(
      { id: stringField, title: stringField, body: stringField },
      ["id", "title", "body"],
    ),
    output_schema: objectSchema({ created: { type: "boolean" } }, ["created"]),
    side_effects: ["kanban_local"],
    idempotency_key: { shape: "inputs_hash", fields: ["id"] },
    dry_run_supported: true,
    tier: 4,
    emit_events: approvalEvents("kanban.create", false),
    required_evidence: [exec("kanban.create"), { field: "evidence.approval_decision", required: true }],
    implemented: false,
  },

  //  — internal T4 test tool. No filesystem / VCS / network
  // side effects: returns the canonical input hash so verifier can
  // confirm what the dispatcher executed against. Exists so the
  // approval-consume gate that all real T4/T5 tools share can be
  // smoked end-to-end without external blast radius. Not exposed
  // through any skillset manifest.
  {
    tool_id: "dev.echo.t4",
    description: "Internal T4 noop for approval-gate smoke (no side effect)",
    dispatch_path: { surface: "do_method", identifier: "AgentThursdayAgent.devShellWriteDispatch" },
    input_schema: objectSchema({}, []),
    output_schema: objectSchema(
      { echoed: { type: "boolean" }, input_hash: stringField },
      ["echoed", "input_hash"],
    ),
    side_effects: ["none"],
    idempotency_key: { shape: "inputs_hash" },
    dry_run_supported: false,
    tier: 4,
    emit_events: approvalEvents("dev.echo.t4", false),
    required_evidence: [exec("dev.echo.t4"), { field: "evidence.approval_decision", required: true }],
    implemented: true,
  },

  // --- T5 remote / deploy tier (approval + dry-run required) ---
  {
    tool_id: "git.push",
    description: "Push branch to remote (approval required; dry-run mandatory)",
    dispatch_path: { surface: "do_method", identifier: "WorkspaceDO.gitPush" },
    input_schema: objectSchema(
      { branch: stringField, remote: { type: "string", default: "origin" } },
      ["branch"],
    ),
    output_schema: objectSchema(
      { pushed: { type: "boolean" }, remote_sha: stringField },
      ["pushed"],
    ),
    side_effects: ["vcs_remote"],
    idempotency_key: { shape: "inputs_hash", fields: ["branch", "local_sha", "remote"] },
    dry_run_supported: true,
    tier: 5,
    emit_events: approvalEvents("git.push", true),
    required_evidence: [
      exec("git.push"),
      { field: "evidence.dry_run_log", required: true },
      { field: "evidence.approval_decision", required: true },
    ],
    implemented: false,
  },
  {
    tool_id: "deploy.wrangler",
    description: "Deploy worker via wrangler (approval required; dry-run mandatory)",
    dispatch_path: { surface: "do_method", identifier: "WorkspaceDO.deployWrangler" },
    input_schema: objectSchema({
      env: { enum: ["prod", "staging"] },
      config_path: { type: "string", default: "wrangler.toml" },
    }),
    output_schema: objectSchema(
      { deploy_id: stringField, version: stringField },
      ["deploy_id"],
    ),
    side_effects: ["deploy_remote", "irreversible"],
    idempotency_key: { shape: "inputs_hash", fields: ["config_hash", "code_sha", "env"] },
    dry_run_supported: true,
    tier: 5,
    emit_events: approvalEvents("deploy.wrangler", true),
    required_evidence: [
      exec("deploy.wrangler"),
      { field: "evidence.dry_run_log", required: true },
      { field: "evidence.approval_decision", required: true },
    ],
    implemented: false,
  },
];

import { GENERATED_TOOL_CONTRACTS } from "./generatedToolContracts";

const REGISTRY: Map<string, ToolContract> = new Map();
for (const c of CONTRACTS) {
  if (REGISTRY.has(c.tool_id)) {
    throw new Error(`duplicate tool_id in registry: ${c.tool_id}`);
  }
  REGISTRY.set(c.tool_id, c);
}
//  — merge YAML-sourced contracts on top of the hand-written
// CONTRACTS array. Duplicate ids across sources are a build error so
// the YAML and TS surfaces never silently diverge.
for (const c of GENERATED_TOOL_CONTRACTS) {
  if (REGISTRY.has(c.tool_id)) {
    throw new Error(`duplicate tool_id (yaml vs ts): ${c.tool_id}`);
  }
  REGISTRY.set(c.tool_id, c);
}

export const TOOL_CONTRACTS: ReadonlyMap<string, ToolContract> = REGISTRY;

/**
 * Set of registered tool_ids — used by the loader for V2 validation.
 * 替代  v0 的 STUB_KNOWN_TOOL_IDS hand-list；研究系工具
 * (web.search / web.fetch / pdf.read) 不在此集，确保 research-stub
 * 在 V2 处仍然 load_rejected。
 */
export const STUB_KNOWN_TOOL_IDS: ReadonlySet<string> = new Set(
  Array.from(REGISTRY.keys()),
);

export function getContract(toolId: string): ToolContract | undefined {
  return REGISTRY.get(toolId);
}
