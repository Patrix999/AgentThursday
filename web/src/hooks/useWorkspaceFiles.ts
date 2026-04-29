import { useEffect, useState } from "react";
import type { WorkspaceFileList, WorkspaceFileContent } from "../../shared/schema";
import { authHeaders, clearSecret } from "../auth/secret";

type ListState = {
  data: WorkspaceFileList | null;
  loading: boolean;
  error: string | null;
};

/**
 * workspace file directory listing.
 *
 * Pulls `/api/workspace/files?path=<path>` once per `path` change. No polling
 * (file system changes are infrequent and the user navigates manually). On
 * 401 mirrors `useWorkspace`: clearSecret + dispatch `agent-thursday:unauthorized`.
 */
export function useWorkspaceFiles(path: string): ListState {
  const [state, setState] = useState<ListState>({ data: null, loading: true, error: null });

  useEffect(() => {
    let active = true;
    setState({ data: null, loading: true, error: null });

    (async () => {
      try {
        const url = `/api/workspace/files?path=${encodeURIComponent(path)}`;
        const res = await fetch(url, { headers: authHeaders() });
        if (res.status === 401) {
          clearSecret();
          window.dispatchEvent(new Event("agent-thursday:unauthorized"));
          return;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({})) as { code?: string };
          throw new Error(body.code ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as WorkspaceFileList;
        if (active) setState({ data, loading: false, error: null });
      } catch (e) {
        if (active) setState({ data: null, loading: false, error: String(e) });
      }
    })();

    return () => { active = false; };
  }, [path]);

  return state;
}

type ContentState = {
  data: WorkspaceFileContent | null;
  loading: boolean;
  error: string | null;
};

/**
 * Fetches one text file. `path === null` → idle (nothing fetched).
 */
export function useWorkspaceFileContent(path: string | null): ContentState {
  const [state, setState] = useState<ContentState>({ data: null, loading: false, error: null });

  useEffect(() => {
    if (path === null) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    let active = true;
    setState({ data: null, loading: true, error: null });

    (async () => {
      try {
        const url = `/api/workspace/file?path=${encodeURIComponent(path)}`;
        const res = await fetch(url, { headers: authHeaders() });
        if (res.status === 401) {
          clearSecret();
          window.dispatchEvent(new Event("agent-thursday:unauthorized"));
          return;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({})) as { code?: string };
          // Pass through the error code so the UI can render targeted copy
          // (file.binary, file.not-found, file.is-dir, path.*).
          throw new Error(body.code ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as WorkspaceFileContent;
        if (active) setState({ data, loading: false, error: null });
      } catch (e) {
        if (active) setState({ data: null, loading: false, error: String(e) });
      }
    })();

    return () => { active = false; };
  }, [path]);

  return state;
}
