import type { getAgentByName } from "agents";
import { json } from "../httpUtil";
import { AgentProfileCreateInputSchema, type AgentProfile } from "../schema";
import { listAgentRuntimeModelOptions, mergeRuntimeModelOptions } from "../agent/agentModelRuntime";
import { resolveEffectiveSkillset } from "../agent/agentSkillsetRuntime";
import { EMBEDDED_MANIFESTS } from "../skillset/manifests";
import { loadSkillsets } from "../skillset/loader";
import { STUB_KNOWN_TOOL_IDS } from "../skillset/contractRegistry";
import {
  loadMergedManifests,
  validateAgentProfileInput,
} from "../agent/agentProfileValidation";
import {
  resolveAgentLifecycle,
  type AgentLifecycleView,
  type LifecycleTaskEvidence,
} from "../agent/agentLifecycleView";
import type { AgentThursdayAgent } from "../server";
import { scopeOwnerIdFor, type RequestIdentity } from "../agent/requestIdentity";

/**
 * AgentProfile create / list / read routes.
 *
 * Storage is on the DEMO_INSTANCE registry DO (global config); the
 * composition root resolves it via `deps.getRegistryStub()` so this
 * module never imports `DEMO_INSTANCE`. Auth is gated by the umbrella
 * `/api/*` `requireSecret` check in `src/server.ts` — never re-checked
 * here.
 *
 * Routes:
 *   POST /api/agent-profiles            create — body validated by Zod,
 *                                       model must resolve to an
 *                                       `available` runtime entry
 *                                       (an earlier revision; see
 *                                       `src/agent/agentModelRuntime.ts`),
 *                                       skillset ∈ EMBEDDED_MANIFESTS.
 *                                       409 on duplicate name.
 *   GET  /api/agent-profiles            list — default = active roster
 *                                       (excludes `archived` and
 *                                       `deleted_marker` per ADR §2.1);
 *                                       `?includeArchived=1` for the
 *                                       operator/inspect escape hatch
 *                                       which returns both tombstone
 *                                       states alongside live rows.
 *   GET  /api/agent-profiles/options    closed-list options for the
 *                                       create form: `{models, skillsets}`.
 *                                       an earlier revision UI source — avoids
 *                                       bundling YAML manifests in the
 *                                       browser bundle.
 *   GET  /api/agent-profiles/<id>       read — 404 if not found.
 *
 * Mismatched path / method returns `null` so the composition root can
 * fall through to other route families.
 */

type AgentThursdayAgentStub = Awaited<ReturnType<typeof getAgentByName<Env, AgentThursdayAgent>>>;

export interface AgentProfileRoutesDeps {
  getRegistryStub: () => Promise<AgentThursdayAgentStub>;
  /** gateway-verified tenant identity (admin when header absent). */
  identity: RequestIdentity;
}

const ROUTE_PREFIX = "/api/agent-profiles";

function nowIso(): string {
  return new Date().toISOString();
}

function mintId(): string {
  return `agent-${crypto.randomUUID()}`;
}

// fail-soft lifecycle attachment. A failure to fetch
// per-agent task evidence (cold DO, transient binding) must not break
// the profile list/detail read. The UI treats `lifecycle` as optional;
// missing block degrades to a `Draft`/`Active` badge with no derived
// indicator, which is acceptable for v1.
async function resolveLifecycleForProfile(
  profile: AgentProfile,
  stub: AgentThursdayAgentStub,
): Promise<AgentLifecycleView | undefined> {
  try {
    const evidence: LifecycleTaskEvidence[] = await stub.getAgentLifecycleEvidence(profile.id, 500);
    return resolveAgentLifecycle({
      profile: { id: profile.id, status: profile.status, updated_at: profile.updated_at },
      tasks: evidence,
      now: new Date(),
    });
  } catch (err) {
    console.warn(
      `[agent-profiles] lifecycle augmentation failed for ${profile.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

function summarizeAgentProfile(
  profile: AgentProfile,
  lifecycle: AgentLifecycleView | undefined,
): Record<string, unknown> {
  return {
    id: profile.id,
    agent_id: profile.id,
    name: profile.name,
    model: profile.model,
    channel: profile.channel,
    skillset: profile.skillset,
    status: profile.status,
    created_at: profile.created_at,
    updated_at: profile.updated_at,
    ...(lifecycle === undefined ? {} : { lifecycle }),
  };
}

export async function handleAgentProfileRoutes(
  request: Request,
  url: URL,
  deps: AgentProfileRoutesDeps,
): Promise<Response | null> {
  const { pathname } = url;
  if (!pathname.startsWith(ROUTE_PREFIX)) return null;

  // POST /api/agent-profiles
  if (pathname === ROUTE_PREFIX && request.method === "POST") {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return json({ code: "invalid_json", message: "request body is not valid JSON" }, 400);
    }
    const parsed = AgentProfileCreateInputSchema.safeParse(raw);
    if (!parsed.success) {
      return json(
        { code: "validation_failed", message: "input shape rejected", issues: parsed.error.issues },
        400,
      );
    }
    const input = parsed.data;
    // an earlier revision — model + skillset validation extracted to
    // `agentProfileValidation.ts` so the manager surface
    // (`/api/manager/agents` + `manager.agent_create` dispatch tool)
    // shares the same path; error codes line up 1:1 with the YAML
    // tool contracts. UI also disables unrunnable models, but the
    // API gate is the source of truth.
    const stub = await deps.getRegistryStub();
    // same credential/dynamic-model awareness as
    // managerCreateAgent (an earlier revision). Without this, the dropdown
    // offers a live-discovered model (e.g. deepseek-v4-pro) that this
    // route then rejects as unknown_model. Fail-soft: registry errors
    // leave both empty → static-registry behavior.
    let configuredProviders: string[] = [];
    let dynamicModelOk = false;
    try {
      configuredProviders = await stub.listConfiguredProviders(deps.identity);
      const dyn = await stub.resolveProviderForModel({ model: input.model }, deps.identity);
      dynamicModelOk = dyn !== null && configuredProviders.includes(dyn.provider);
    } catch { /* static behavior */ }
    const validation = await validateAgentProfileInput(
      { model: input.model, skillset: input.skillset },
      stub,
      { configuredProviders, dynamicModelOk },
      scopeOwnerIdFor(deps.identity),
    );
    if (!validation.ok) {
      return json({ code: validation.error.code, message: validation.error.message }, 400);
    }
    const now = nowIso();
    const result = await stub.createAgentProfile({
      id: mintId(),
      name: input.name,
      model: input.model,
      channel: input.channel,
      skillset: input.skillset,
      persona: input.persona,
      status: input.status,
      createdAt: now,
      updatedAt: now,
    }, deps.identity);
    if (!result.ok) {
      if (result.error.code === "name_conflict") {
        return json({ code: "name_conflict", message: result.error.message }, 409);
      }
      return json({ code: "internal", message: result.error.message }, 500);
    }
    // surface `agent_id` alongside the legacy `id` so new
    // clients can speak the corrected vocabulary. Same value.
    return json({ ...result.profile, agent_id: result.profile.id }, 201);
  }

  // GET /api/agent-profiles
  if (pathname === ROUTE_PREFIX && request.method === "GET") {
    const includeArchived = url.searchParams.get("includeArchived") === "1";
    const view = url.searchParams.get("view");
    const stub = await deps.getRegistryStub();
    const profiles = await stub.listAgentProfiles({ includeArchived }, deps.identity);
    // per-row lifecycle resolution (advisor: one callable
    // shape, called N times via Promise.all). Fail-soft per row so a
    // single bad agent doesn't take down the whole list.
    const lifecycles = await Promise.all(
      profiles.map(p => resolveLifecycleForProfile(p, stub)),
    );
    // summary view for list/select/dashboard surfaces.
    // It intentionally omits persona and the legacy duplicate
    // `profiles` array. Detail reads still return the full profile.
    if (view === "summary") {
      // 2026-06-23 — owner labels for the operator console (multi-tenant
      // visibility: tell whose agent each row is). Join app_user emails;
      // fail-soft so a registry hiccup still returns owner_user_id.
      const emailByOwner: Record<string, string> = {};
      try {
        for (const u of await stub.appUserListAll()) {
          if (u.email) emailByOwner[u.user_id] = u.email;
        }
      } catch {
        /* no emails — the UI falls back to the owner id / "operator" label */
      }
      return json({
        agents: profiles.map((p, i) => {
          const owner = (p as { owner_user_id?: string }).owner_user_id ?? null;
          return {
            ...summarizeAgentProfile(p, lifecycles[i]),
            owner_user_id: owner,
            owner_email: owner ? emailByOwner[owner] ?? null : null,
          };
        }),
      });
    }
    // surface `agent_id` alias on every row. Also include
    // top-level `agents` field so new clients don't have to remap. Both
    // arrays point at the same rows; backward-compat field `profiles`
    // stays for legacy callers.
    const annotated = profiles.map((p, i) => {
      const lifecycle = lifecycles[i];
      return lifecycle === undefined
        ? { ...p, agent_id: p.id }
        : { ...p, agent_id: p.id, lifecycle };
    });
    return json({ profiles: annotated, agents: annotated });
  }

  // GET /api/agent-profiles/options — must run before the /:id handler,
  // otherwise `pathname.startsWith("${ROUTE_PREFIX}/")` swallows "options"
  // and the registry rejects it as an unknown id.
  if (pathname === `${ROUTE_PREFIX}/options` && request.method === "GET") {
    // structured options. `models` items now carry
    // `runtimeStatus` so `/agents/new` can render not_configured
    // entries disabled instead of misleading the operator that they are
    // runnable. The executable `target` string is intentionally not
    // included — server-side only.
    //
    // merge in live-discovered provider models (and flip
    // credential-gated static entries to available) so the dropdown
    // matches what create actually accepts. Fail-soft: a registry
    // hiccup falls back to the static list rather than 500ing options.
    let models = listAgentRuntimeModelOptions();
    try {
      const stub = await deps.getRegistryStub();
      const [configuredProviders, discovered] = await Promise.all([
        stub.listConfiguredProviders(deps.identity),
        stub.listDiscoveredModels(deps.identity),
      ]);
      models = mergeRuntimeModelOptions(models, configuredProviders, discovered);
    } catch { /* static list */ }
    // Create-agent picker options = embedded ∪ the viewer's OWN custom
    // skillsets (owner-scoped; admin sees all custom). Fail-soft to embedded
    // if the registry is unreachable.
    let skillsetManifests = [...EMBEDDED_MANIFESTS];
    try {
      const stub = await deps.getRegistryStub();
      skillsetManifests = await loadMergedManifests(stub, scopeOwnerIdFor(deps.identity));
    } catch { /* embedded only */ }
    const skillsets = skillsetManifests.map(m => ({
      id: m.id,
      name: m.manifest.name,
      description: m.manifest.description,
    }));
    return json({ models, skillsets });
  }

  // GET /api/agent-profiles/<id>
  if (pathname.startsWith(`${ROUTE_PREFIX}/`) && request.method === "GET") {
    const id = pathname.slice(ROUTE_PREFIX.length + 1);
    if (id.length === 0 || id.includes("/")) {
      return json({ code: "invalid_id", message: "agent profile id required" }, 400);
    }
    const stub = await deps.getRegistryStub();
    const profile = await stub.readAgentProfile(id, deps.identity);
    if (profile === null) {
      return json({ code: "not_found", message: `agent profile not found: ${id}` }, 404);
    }
    // 2026-06-23 — owner email label for the operator console detail page
    // (mirrors the summary view). Fail-soft: a registry hiccup leaves the
    // UI to label off the owner id / "operator".
    let ownerEmail: string | null = null;
    const ownerId = (profile as { owner_user_id?: string }).owner_user_id ?? null;
    if (ownerId) {
      try {
        const u = (await stub.appUserListAll()).find(x => x.user_id === ownerId);
        ownerEmail = u?.email ?? null;
      } catch { /* label off id */ }
    }
    // runtime-truth view of `AgentProfile.skillset`. Pure
    // resolver over a fresh LoaderState + the registry DO's
    // operator-disabled set. We use the registry DO's disabled set
    // because that's the only DO this route already speaks to;
    // operator disable is typically global across DOs anyway, and the
    // per-profile DO will re-run the resolver and re-emit
    // `agent.skillset.effective` on the next session init, so any
    // per-DO mismatch self-heals on the next run.
    //
    // Fail-soft: a failure in this augmentation must NOT break the
    // profile read. The web client treats `skillset_runtime` as
    // optional (SkillsetRuntimeRow renders "— (resolving)" on
    // undefined). If RPC / loader throws (e.g. DO cold start, registry
    // DO eviction, transient binding), log a warning and return the
    // bare profile.
    // lifecycle resolved in parallel with skillset runtime
    // so cold-start latency doesn't compound. Both are fail-soft.
    const lifecyclePromise = resolveLifecycleForProfile(profile, stub);
    try {
      const runtimeSummary = await stub.getSkillsetRuntimeSummary();
      const merged = await loadMergedManifests(stub, scopeOwnerIdFor(deps.identity));
      const state = loadSkillsets(merged, { knownToolIds: STUB_KNOWN_TOOL_IDS });
      const manifestsById = new Map(merged.map(m => [m.id, m.manifest] as const));
      const disabledMap = new Map<string, true>(
        runtimeSummary.skillset_ids.disabled.map(d => [d, true] as const),
      );
      const resolved = resolveEffectiveSkillset({
        profileSkillset: profile.skillset,
        state,
        manifestsById,
        disabledMap,
      });
      const lifecycle = await lifecyclePromise;
      // `agent_id` alias on the augmented row too.
      return json({
        ...profile,
        agent_id: profile.id,
        owner_email: ownerEmail,
        skillset_runtime: {
          status: resolved.status,
          effective_ids: resolved.effectiveIds,
          reason: resolved.reason,
        },
        ...(lifecycle === undefined ? {} : { lifecycle }),
      });
    } catch (err) {
      console.warn(
        `[agent-profiles] skillset_runtime augmentation failed for ${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      const lifecycle = await lifecyclePromise;
      // `agent_id` alias on the bare-profile fallback too.
      return json({
        ...profile,
        agent_id: profile.id,
        owner_email: ownerEmail,
        ...(lifecycle === undefined ? {} : { lifecycle }),
      });
    }
  }

  return null;
}
