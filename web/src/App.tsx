import { BrowserRouter, Route, Routes } from "react-router-dom";
import { SecretGate } from "./auth/SecretGate";
import { Workspace } from "./routes/Workspace";
import { InspectRoute } from "./routes/InspectRoute";
import { AgentsListRoute } from "./agents/AgentsListRoute";
import { AgentNewRoute } from "./agents/AgentNewRoute";
import { AgentDetailRoute } from "./agents/AgentDetailRoute";
import { AgentRunsListRoute } from "./agentRuns/AgentRunsListRoute";
import { AgentRunDetailRoute } from "./agentRuns/AgentRunDetailRoute";
import { SkillsetsListRoute } from "./skillsets/SkillsetsListRoute";
import { SkillsetDetailRoute } from "./skillsets/SkillsetDetailRoute";
import { DashboardRoute } from "./dashboard/DashboardRoute";
import { WorkflowRunsRoute } from "./workflowRuns/WorkflowRunsRoute";
import { ManualRoute } from "./manual/ManualRoute";
import ModelsRoute from "./models/ModelsRoute";
import SettingsRoute from "./settings/SettingsRoute";
import ActivityRoute from "./activity/ActivityRoute";
import { SharedFileRoute } from "./shared/SharedFileRoute";
import { UsersRoute } from "./users/UsersRoute";

export function App() {
  return (
    <BrowserRouter>
      <SecretGate>
        <Routes>
          {/* 2026-06-15 (the operator) — restore Dashboard as landing (Wave 3 IA reverted). */}
          <Route path="/" element={<DashboardRoute />} />
          <Route path="/dashboard" element={<DashboardRoute />} />
          <Route path="/workspace" element={<Workspace />} />
          <Route path="/inspect" element={<InspectRoute />} />
          <Route path="/agents" element={<AgentsListRoute />} />
          <Route path="/agents/new" element={<AgentNewRoute />} />
          <Route path="/agents/:id" element={<AgentDetailRoute />} />
          <Route path="/agent-runs" element={<AgentRunsListRoute />} />
          <Route path="/agent-runs/:id" element={<AgentRunDetailRoute />} />
          <Route path="/workflow-runs" element={<WorkflowRunsRoute />} />
          <Route path="/manual" element={<ManualRoute />} />
          <Route path="/skillsets" element={<SkillsetsListRoute />} />
          <Route path="/skillsets/:id" element={<SkillsetDetailRoute />} />
          <Route path="/models" element={<ModelsRoute />} />
          <Route path="/settings" element={<SettingsRoute />} />
          {/* 2026-06-22 — console user management (admin-only app_user CRUD). */}
          <Route path="/users" element={<UsersRoute />} />
          {/* an earlier revision (UX W3, D3-C) — unified Activity view (kept reachable by URL). */}
          <Route path="/activity" element={<ActivityRoute />} />
          {/* 2026-06-19 — shared workspace file viewer (share_file link target). */}
          <Route path="/shared/:id" element={<SharedFileRoute />} />
          <Route path="*" element={<DashboardRoute />} />
        </Routes>
      </SecretGate>
    </BrowserRouter>
  );
}
