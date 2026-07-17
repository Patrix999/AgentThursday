import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { AgentProfileCreateInput } from "../../shared/schema";
import {
  createAgentProfile,
  getAgentProfileOptions,
  listAgentProfiles,
  type AgentProfileOptions,
} from "../api/agentProfiles";
import { setConversationBinding } from "../api/channelBinding";
import {
  listRecentConversations,
  type RecentConversation,
} from "../api/channelConversations";
import { setActiveAgentPin } from "../auth/secret";
import { AgentsLayout } from "./AgentsLayout";

/**
 * create form at `/agents/new`.
 * UI copy reads "Create cloud agent instance"; the form
 * persists a new cloud agent. The backing API route is still
 * `/api/agent-profiles` (legacy persistence; see
 * docs/design/2026-05-24-m9.0-agent-centric-correction.md).
 *
 * Fields per an earlier revision §3:
 *   - name              required, 1-80
 *   - model             single-select from `/api/agent-profiles/options`
 *   - channel           free-form string, required (live channel binding
 *                       is a later card)
 *   - skillset          single-select. an earlier revision wording: the selected
 *                       skillset defines the runtime dynamic tool
 *                       palette for the next session/run (selection +
 *                       loaded, non-disabled dependencies).
 *   - persona           free-form ≤ 2000 chars; read at session-init and
 *                       woven into the agent prompt (an earlier revision D-2 Option A)
 * On 201 we navigate to `/agents/:id` so refresh-persistence is directly
 * verifiable per the card's acceptance line.
 */
export function AgentNewRoute() {
  const navigate = useNavigate();
  const [options, setOptions] = useState<AgentProfileOptions | null>(null);
  const [optionsErr, setOptionsErr] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  // channel picker. `channelChoice` is "manager", "custom",
  // or a conversationId from the recent-conversations list; the old
  // free-text value lives in `customChannel` (kept for local:dev flows).
  const [channelChoice, setChannelChoice] = useState("manager");
  const [customChannel, setCustomChannel] = useState("");
  const [conversations, setConversations] = useState<RecentConversation[]>([]);
  const [agentNames, setAgentNames] = useState<Record<string, string>>({});
  const [skillset, setSkillset] = useState("");
  const [persona, setPersona] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getAgentProfileOptions()
      .then(r => {
        if (cancelled || r === null) return;
        setOptions(r);
        // default-pick the first runnable model. If nothing
        // is runnable in this build, leave empty and let the submit
        // gate / server return a helpful error.
        const firstAvailable = r.models.find(m => m.runtimeStatus === "available");
        if (firstAvailable) setModel(firstAvailable.id);
        if (r.skillsets.length > 0) setSkillset(r.skillsets[0].id);
      })
      .catch(e => {
        if (cancelled) return;
        setOptionsErr(String(e));
      });
    // picker data: recent conversations + agent names for
    // the "already bound to X" warning. Both fail-soft to empty.
    listRecentConversations()
      .then(rows => { if (!cancelled) setConversations(rows); })
      .catch(() => {});
    listAgentProfiles()
      .then(rows => {
        if (cancelled || rows === null) return;
        const names: Record<string, string> = {};
        for (const a of rows) names[a.id] = a.name;
        setAgentNames(names);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedConversation =
    conversations.find(c => c.conversationId === channelChoice) ?? null;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitErr(null);
    setSubmitting(true);
    const channel =
      channelChoice === "custom" ? customChannel.trim() : channelChoice;
    const input: AgentProfileCreateInput = {
      name: name.trim(),
      model,
      channel,
      skillset,
      persona,
      status: "initialized",
    };
    const res = await createAgentProfile(input);
    if (res.ok && res.profile) {
      // when a real conversation was picked, bind it to the
      // new agent so channel messages actually route here. On failure,
      // stay on the page and say so — the agent exists but is unbound.
      if (selectedConversation !== null) {
        const bind = await setConversationBinding(
          selectedConversation.conversationId,
          res.profile.id,
        );
        if (!bind.ok) {
          setSubmitting(false);
          setSubmitErr(
            `agent ${res.profile.id} was created, but binding conversation `
            + `${selectedConversation.conversationId} failed: `
            + `${bind.error?.code ?? "error"} ${bind.error?.message ?? ""} — `
            + `the agent exists but is not receiving channel messages.`,
          );
          return;
        }
      }
      setSubmitting(false);
      // land in the workspace console with the new cloud
      // agent active. The pin both keeps the user's pick across
      // `useWorkspace` reconcile and writes `agentthursday.contextId` so the
      // next `/api/workspace` poll routes to this agent's DO (Card
      // 354: DO name == agent_id).
      setActiveAgentPin(res.profile.id);
      navigate("/workspace");
      return;
    }
    setSubmitting(false);
    if (res.error) {
      setSubmitErr(`${res.error.code}: ${res.error.message}`);
    } else {
      setSubmitErr("create failed");
    }
  }

  const selectedSkillset =
    options?.skillsets.find(s => s.id === skillset) ?? null;

  return (
    <AgentsLayout label="New" backTo="/agents" backLabel="← Agents">
      <div className="text-sm text-slate-300 mb-4">
        Create a cloud agent instance — a long-lived agent running in the
        cloud that you can address from any bound channel.
      </div>
      {optionsErr && (
        <div className="text-sm text-rose-400 mb-3">options: {optionsErr}</div>
      )}
      {options === null && !optionsErr && (
        <div className="text-sm text-slate-500">Loading options…</div>
      )}
      {options !== null && (
        <form onSubmit={onSubmit} className="space-y-5">
          <Field label="Name" hint="1–80 chars; shown in lists and headers.">
            <input
              type="text"
              required
              minLength={1}
              maxLength={80}
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-sky-600"
              placeholder="e.g. dogfood-1"
            />
          </Field>

          <Field
            label="Model"
            hint="Which inference model this agent runs on. Greyed-out entries are known but not wired to a provider adapter in this build — selecting them is rejected by the API."
          >
            <select
              required
              value={model}
              onChange={e => setModel(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-sky-600"
            >
              {/* an earlier revision (UX W5) — group by provider so a long mixed
                  model list (workers-ai + deepseek + anthropic) reads as
                  buckets instead of a flat dump. */}
              {groupModelsByProvider(options.models).map(group => (
                <optgroup key={group.provider} label={providerLabel(group.provider)}>
                  {group.models.map(m => (
                    <option
                      key={m.id}
                      value={m.id}
                      disabled={m.runtimeStatus !== "available"}
                    >
                      {m.label}
                      {m.runtimeStatus === "available" ? "" : "  (not configured)"}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </Field>

          <Field
            label="Channel"
            hint="Pick a live conversation to bind — messages from that channel will route to this agent (one agent per conversation; binding replaces the current owner). 'manager' leaves the agent reachable via manager dispatch only."
          >
            <select
              value={channelChoice}
              onChange={e => setChannelChoice(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-sky-600"
            >
              <option value="manager">manager (not bound to a channel)</option>
              {conversations.map(c => (
                <option key={c.conversationId} value={c.conversationId}>
                  {c.provider}/{c.chatType} · {c.conversationId}
                  {c.activeAgentId
                    ? ` — bound to ${agentNames[c.activeAgentId] ?? c.activeAgentId}`
                    : " — unbound"}
                </option>
              ))}
              <option value="custom">Custom… (free-form, no binding)</option>
            </select>
            {channelChoice === "custom" && (
              <input
                type="text"
                required
                value={customChannel}
                onChange={e => setCustomChannel(e.target.value)}
                className="mt-2 w-full bg-slate-900 border border-slate-700 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-sky-600"
                placeholder="local:dogfood-1"
              />
            )}
            {selectedConversation?.activeAgentId && (
              <div className="mt-1 text-xs text-amber-400">
                ⚠ This conversation is currently bound to{" "}
                <span className="font-mono">
                  {agentNames[selectedConversation.activeAgentId]
                    ?? selectedConversation.activeAgentId}
                </span>
                . Creating will rebind it to the new agent — the current
                owner stops receiving messages from this channel.
              </div>
            )}
          </Field>

          <Field
            label="Starting skillset"
            hint="The selected skillset defines the runtime dynamic tool palette for the next session/run. The agent will only see callable tools from this skillset and its loaded, non-operator-disabled dependencies — unrelated skillsets are filtered out at the agent tool surface ."
          >
            <select
              required
              value={skillset}
              onChange={e => setSkillset(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-sky-600"
            >
              {options.skillsets.map(s => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.id})
                </option>
              ))}
            </select>
            {selectedSkillset && (
              <div className="mt-1 text-xs text-slate-500">
                {selectedSkillset.description}
              </div>
            )}
            {/* an earlier revision (UX W5) — plain-language use case under the
                developer-facing description. */}
            {SKILLSET_USE_CASES[skillset] && (
              <div className="mt-0.5 text-xs text-sky-300/80">
                典型用途：{SKILLSET_USE_CASES[skillset]}
              </div>
            )}
          </Field>

          <Field
            label="Persona (optional)"
            hint="Free-form notes about how this agent should behave. Read at session-init and woven into the agent prompt; live edits apply to the next session / run."
          >
            {/* an earlier revision (UX W5) — starter templates so the persona box
                isn't a blank intimidating field. */}
            <div className="mb-1.5 flex flex-wrap gap-1.5">
              {PERSONA_TEMPLATES.map(t => (
                <button
                  key={t.label}
                  type="button"
                  onClick={() => setPersona(t.text)}
                  className="text-xs px-2 py-0.5 rounded border border-slate-700 text-slate-300 hover:bg-slate-800"
                >
                  {t.label}
                </button>
              ))}
            </div>
            <textarea
              maxLength={2000}
              value={persona}
              onChange={e => setPersona(e.target.value)}
              rows={6}
              className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-sky-600 font-mono"
              placeholder="(read at session-init)"
            />
            <div className="text-xs text-slate-600 mt-1">{persona.length} / 2000</div>
          </Field>

          {submitErr && <div className="text-sm text-rose-400">{submitErr}</div>}
          <div className="flex gap-2 justify-end pt-2">
            <button
              type="button"
              onClick={() => navigate("/agents")}
              className="text-sm px-3 py-1.5 rounded border border-slate-700 text-slate-300 hover:bg-slate-900"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="text-sm px-3 py-1.5 rounded bg-sky-700 hover:bg-sky-600 text-sky-50 disabled:opacity-50"
            >
              {submitting ? "Creating…" : "Create cloud agent instance"}
            </button>
          </div>
        </form>
      )}
    </AgentsLayout>
  );
}

// an earlier revision (UX W5) — plain-language skillset use cases (operator-facing).
const SKILLSET_USE_CASES: Record<string, string> = {
  "software-dev": "让 agent 读源码、改代码、跑测试、产出 patch 工件",
  manager: "让 agent 管理其他云上 agent（建/派活/汇总）",
  "qa-reviewer-basic": "轻量代码评审，不外发、不调度",
  "directed-validation": "对受控只读端点做定向验证（生产中通常是agentD）",
  "runtime-inspector-basic": "按需返回一份非敏感的 skillset 运行时概览",
  "artifact-delivery": "把 patch / 测试文档 / 完成报告写入当前 agent 工作区",
  "external-publishing": "通过外部工具把产出转成可分享的非敏感链接",
  "research-stub": "网络研究 / 引用占位能力包",
};

// an earlier revision (UX W5) — persona starter templates.
const PERSONA_TEMPLATES: Array<{ label: string; text: string }> = [
  { label: "严谨代码审查者", text: "你是一位严谨的代码审查者。优先指出正确性 bug 与边界条件，给出可复现的最小例子；对风格问题保持克制。每条结论都要能落到具体文件和行。" },
  { label: "简洁高效执行者", text: "你是一位简洁高效的执行者。先用一句话确认目标，再动手；只做被要求的事，不擅自扩大范围；完成后用要点汇报改了什么、如何验证。" },
  { label: "耐心讲解者", text: "你是一位耐心的讲解者。回答时先给结论，再用通俗语言解释原因；面对不熟悉的概念，给一个简短的类比；避免行话堆砌。" },
];

function providerLabel(provider: string): string {
  const map: Record<string, string> = {
    "workers-ai": "Workers AI",
    deepseek: "DeepSeek",
    anthropic: "Anthropic",
    openai: "OpenAI",
    google: "Google",
  };
  return map[provider] ?? provider;
}

function groupModelsByProvider(
  models: AgentProfileOptions["models"],
): Array<{ provider: string; models: AgentProfileOptions["models"] }> {
  const order = ["workers-ai", "deepseek", "anthropic", "openai", "google"];
  const byProvider = new Map<string, AgentProfileOptions["models"]>();
  for (const m of models) {
    const list = byProvider.get(m.provider) ?? [];
    list.push(m);
    byProvider.set(m.provider, list);
  }
  // available-first within each group, then known providers in order,
  // then any others.
  for (const list of byProvider.values()) {
    list.sort((a, b) => (a.runtimeStatus === "available" ? 0 : 1) - (b.runtimeStatus === "available" ? 0 : 1));
  }
  const providers = [...byProvider.keys()].sort(
    (a, b) => (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 99 : order.indexOf(b)),
  );
  return providers.map(p => ({ provider: p, models: byProvider.get(p) ?? [] }));
}

function Field(props: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-xs uppercase tracking-wide text-slate-400 mb-1">{props.label}</div>
      {props.children}
      {props.hint && <div className="text-xs text-slate-500 mt-1">{props.hint}</div>}
    </label>
  );
}
