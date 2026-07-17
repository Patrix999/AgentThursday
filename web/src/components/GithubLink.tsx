/**
 * an earlier revision §D — GitHub icon link shown in the top status bar (desktop)
 * and mobile status row. The href is configurable via build-time env
 * `VITE_GITHUB_URL`; the default points at the public source repo for
 * the deployed worker so the link is correct without per-deployment
 * Vite env edits. The link opens in a new tab and uses
 * `noreferrer noopener` so the new tab cannot reach back into our
 * window via `window.opener`.
 */
const DEFAULT_GITHUB_URL = "https://github.com/your-org/AgentThursday";

export function getGithubUrl(): string {
  const env = (import.meta.env as Record<string, string | undefined>) ?? {};
  const v = env.VITE_GITHUB_URL;
  if (typeof v === "string" && v.length > 0) return v;
  return DEFAULT_GITHUB_URL;
}

export function GithubLink({ className }: { className?: string }) {
  const href = getGithubUrl();
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      aria-label="GitHub"
      title="GitHub"
      className={className ?? "inline-flex items-center justify-center text-slate-400 hover:text-slate-100 px-2 py-1 rounded"}
    >
      <GithubMark />
    </a>
  );
}

function GithubMark() {
  // Inline SVG — keeps the bundle free of an icon font dependency. Path
  // is the canonical GitHub mark (24x24 viewBox).
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      aria-hidden="true"
      focusable="false"
      fill="currentColor"
    >
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56v-2c-3.2.7-3.88-1.36-3.88-1.36-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.75 1.18 1.75 1.18 1.02 1.74 2.68 1.24 3.33.95.1-.74.4-1.24.73-1.53-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.04 0 0 .96-.31 3.15 1.18.91-.25 1.89-.38 2.86-.38.97 0 1.95.13 2.86.38 2.18-1.49 3.14-1.18 3.14-1.18.62 1.58.23 2.75.11 3.04.74.81 1.18 1.84 1.18 3.1 0 4.42-2.69 5.39-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.68.8.56C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z" />
    </svg>
  );
}
