import { PageHeader } from "../nav/PageHeader";
import { ProviderKeysPanel } from "../shared/ProviderKeysPanel";
import { DiscordBotsPanel } from "../shared/DiscordBotsPanel";
import { ApprovalsPanel } from "../shared/ApprovalsPanel";

/**
 * an earlier revision (UX renovation W1) — configuration home. Provider keys and
 * Discord bots previously lived on the Models / Agents pages; the
 * user journey wants one place to "plug things in". Models goes back
 * to being a pure catalog, Agents a pure roster.
 */
export default function SettingsRoute() {
  return (
    <div className="flex flex-col h-full bg-slate-950 text-slate-100">
      <PageHeader title="Settings" />
      <main className="flex-1 min-h-0 overflow-y-auto px-4 py-4 sm:px-6 sm:py-6">
        <p className="mb-4 max-w-3xl text-sm text-slate-400">
          Connect external services. Models from a configured provider become
          selectable when creating an agent; a connected Discord bot serves its
          channels on the next polling sweep.
        </p>
        <ApprovalsPanel />
        <ProviderKeysPanel />
        <DiscordBotsPanel />
      </main>
    </div>
  );
}
