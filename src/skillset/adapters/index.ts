/**
 * adapter index.
 *
 * Side-effect imports of every adapter module. Each adapter registers
 * its handler at top-level via `registerDispatchHandler()`. Code that
 * needs adapter-sourced handlers to be present in
 * `AGENT_DISPATCH_HANDLERS` imports this module once at composition
 * root (currently `src/server.ts` + smokes).
 *
 * Adding a new YAML-sourced tool:
 *   1. Add `docs/tools/<id>.<version>.yaml`.
 *   2. Run `npm run tools:generate`.
 *   3. Add an adapter file in this directory that calls
 *      `registerDispatchHandler({...})` at top level.
 *   4. Add a side-effect `import "./<adapter>";` line below.
 *
 * No edits to `dispatchRegistry.ts`, `agentDynamicTools.ts`,
 * `runtimeSnapshot.ts`, the loader, or `AgentThursdayAgent.getTools()` are
 * required.
 *
 * first stateful adapter family (`artifact.*`) added the
 * optional 3rd `ctx` arg to `DispatchHandler.execute`; stateless
 * adapters (localdoc, runtime_summary) ignore it. Adding more stateless
 * tools still does not require touching dispatchRegistry /
 * agentDynamicTools.
 */

import "./skillsetRuntimeSummary";
import "./artifactWrite";
import "./artifactRead";
import "./artifactList";
import "./patchValidate";
import "./adminSmoke";
// manager skillset adapters. Each self-registers a YAML-sourced
// `manager.*` tool. The HTTP route (`/api/manager/*`) shares the same
// validation + persistence + audit-event path via `src/agent/managerOps.ts`.
import "./managerAgentList";
import "./managerAgentCreate";
import "./managerAgentUpdate";
import "./managerSkillsetList";
import "./managerSkillsetRead";
import "./managerSkillsetCreate";
import "./managerSkillsetUpdate";
import "./managerAgentMessage";
// manager subagent summary read surface.
import "./managerSubagentSummaries";
// cross-agent schedule tools (create / list / cancel).
import "./managerScheduleCreate";
import "./managerScheduleList";
import "./managerScheduleCancel";
// manager.task.merged emitter (audit-grade merge event).
import "./managerTaskMerge";
// manager.task.completed emitter (post-merge completion report).
import "./managerTaskComplete";
// agent-side workflow executor entry + run-tree read.
import "./managerWorkflowExecute";
import "./managerWorkflowStatus";
// named workflow store: save / list / run-named.
import "./managerWorkflowSave";
import "./managerWorkflowList";
import "./managerWorkflowRunNamed";
