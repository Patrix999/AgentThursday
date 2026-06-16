/**
 *  —  artifactOps extraction.
 *
 * Three artifact-share callable bodies moved verbatim from
 * `AgentThursdayAgent` (`src/server.ts:4489-4783`). No validation policy,
 * event name, event payload field, error code, size cap, secret
 * pattern, body/envelope path, or missing-dir semantic changed —
 * only the location of the calls moved. `server.ts` keeps the
 * `@callable()` `writeArtifact` / `readArtifact` / `listArtifacts`
 * methods as thin delegates so the RPC surface is unchanged.
 *
 * Host shape is narrow on purpose — two capabilities only:
 *   - `workspace` — file API binding (mkdir / writeFile / readFile /
 *                    readDir). The `mime` arg to `writeFile` is
 *                    forwarded because `cardDir`-scoped artifact
 *                    bodies carry their own `mime` (set in
 *                    `artifactShare.DEFAULT_MIME`) and envelopes use
 *                    `application/json`.
 *   - `logEvent`  — emits the artifact.* event log entries the
 *                    inspect / observability surface already
 *                    consumes.
 *
 * Both Worker-internal Sandbox.exec and the workspace SDK binding
 * stay at the composition root (`AgentThursdayAgent.sandboxExec` /
 * `this.workspace`) so this module never touches the agent's `env`
 * or DO ctx directly.
 *
 * See:
 *   - ``
 *   - `src/artifactShare.ts` (validation rules + envelope schema)
 */

import * as A from "../artifactShare";

export interface ArtifactOpsWorkspace {
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  writeFile(path: string, content: string, mime?: string): Promise<void>;
  readFile(path: string): Promise<string | null>;
  readDir(
    dir: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<Array<{ name: string; type: string }>>;
}

export interface ArtifactOpsHost {
  workspace: ArtifactOpsWorkspace;
  logEvent: (type: string, payload: unknown) => void;
}

export type WriteArtifactInput = {
  cardId: string;
  filename: string;
  type: string;
  sourceAgent: string;
  producerUserId?: string;
  mime?: string;
  notes?: string;
  content: string;
};

export type WriteArtifactResult =
  | { ok: true; envelope: A.ArtifactEnvelope }
  | { ok: false; error: { code: string; message: string; pattern?: string; cap?: number; size?: number } };

export type ReadArtifactInput = {
  cardId: string;
  filename: string;
};

export type ReadArtifactResult =
  | { ok: true; envelope: A.ArtifactEnvelope; content: string }
  | { ok: false; error: { code: string; message: string } };

export type ListArtifactsInput = {
  cardId: string;
};

export type ListArtifactsResult =
  | { ok: true; card_id: string; envelopes: A.ArtifactEnvelope[] }
  | { ok: false; error: { code: string; message: string } };

export async function writeArtifactFree(
  host: ArtifactOpsHost,
  input: WriteArtifactInput,
): Promise<WriteArtifactResult> {
  const cardV = A.validateCardId(input.cardId);
  if ("code" in cardV) {
    host.logEvent("artifact.write.denied", { reason: cardV.code, card_id: input.cardId });
    return { ok: false, error: cardV };
  }
  const fileV = A.validateFilename(input.filename);
  if ("code" in fileV) {
    host.logEvent("artifact.write.denied", {
      reason: fileV.code,
      card_id: cardV.cardId,
      filename: input.filename,
    });
    return { ok: false, error: fileV };
  }
  const typeV = A.validateType(input.type);
  if ("code" in typeV) {
    host.logEvent("artifact.write.denied", {
      reason: typeV.code,
      card_id: cardV.cardId,
      filename: fileV.filename,
    });
    return { ok: false, error: typeV };
  }
  if (A.TYPES_REJECTED_IN_V1.has(typeV.type)) {
    host.logEvent("artifact.write.denied", {
      reason: "type_not_supported_in_v1",
      card_id: cardV.cardId,
      filename: fileV.filename,
      type: typeV.type,
    });
    return {
      ok: false,
      error: {
        code: "type_not_supported_in_v1",
        message: `type ${typeV.type} is not supported in v1 (binary directory bundles are out of scope)`,
      },
    };
  }
  if (input.mime !== undefined && !A.ALLOWED_MIMES.has(input.mime)) {
    host.logEvent("artifact.write.denied", {
      reason: "invalid_mime",
      card_id: cardV.cardId,
      filename: fileV.filename,
      mime: input.mime,
    });
    return {
      ok: false,
      error: {
        code: "invalid_mime",
        message: `mime ${input.mime} is not on the v1 allowlist`,
      },
    };
  }
  if (input.notes !== undefined) {
    if (typeof input.notes !== "string") {
      host.logEvent("artifact.write.denied", {
        reason: "invalid_notes",
        card_id: cardV.cardId,
        filename: fileV.filename,
      });
      return {
        ok: false,
        error: { code: "invalid_notes", message: "notes must be a string" },
      };
    }
    if (input.notes.length > A.NOTES_MAX_LENGTH) {
      host.logEvent("artifact.write.denied", {
        reason: "invalid_notes",
        card_id: cardV.cardId,
        filename: fileV.filename,
        notes_length: input.notes.length,
      });
      return {
        ok: false,
        error: {
          code: "invalid_notes",
          message: `notes length ${input.notes.length} exceeds ${A.NOTES_MAX_LENGTH}`,
        },
      };
    }
    const notesScan = A.scanSecrets(input.notes);
    if ("code" in notesScan) {
      host.logEvent("artifact.write.denied", {
        reason: notesScan.code,
        card_id: cardV.cardId,
        filename: fileV.filename,
        pattern: notesScan.pattern,
        field: "notes",
      });
      return { ok: false, error: notesScan };
    }
  }
  const agentV = A.validateSourceAgent(input.sourceAgent);
  if ("code" in agentV) {
    host.logEvent("artifact.write.denied", {
      reason: agentV.code,
      card_id: cardV.cardId,
      filename: fileV.filename,
    });
    return { ok: false, error: agentV };
  }
  if (typeof input.content !== "string" || input.content.length === 0) {
    host.logEvent("artifact.write.denied", {
      reason: "content_required",
      card_id: cardV.cardId,
      filename: fileV.filename,
    });
    return {
      ok: false,
      error: { code: "content_required", message: "content is required and must be a non-empty UTF-8 string" },
    };
  }
  const sizeBytes = new TextEncoder().encode(input.content).length;
  const sizeV = A.checkSize(typeV.type, sizeBytes);
  if ("code" in sizeV) {
    host.logEvent("artifact.write.denied", {
      reason: sizeV.code,
      card_id: cardV.cardId,
      filename: fileV.filename,
      size: sizeBytes,
      cap: sizeV.cap,
    });
    return { ok: false, error: sizeV };
  }
  const scanV = A.scanSecrets(input.content);
  if ("code" in scanV) {
    host.logEvent("artifact.write.denied", {
      reason: scanV.code,
      card_id: cardV.cardId,
      filename: fileV.filename,
      pattern: scanV.pattern,
    });
    return { ok: false, error: scanV };
  }
  const sha = await A.sha256Hex(input.content);
  const envelope = A.buildEnvelope({
    cardId: cardV.cardId,
    filename: fileV.filename,
    type: typeV.type,
    sourceAgent: agentV.sourceAgent,
    ...(input.producerUserId ? { producerUserId: input.producerUserId } : {}),
    ...(input.mime ? { mime: input.mime } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
    sha256: sha,
    sizeBytes,
  });
  await host.workspace.mkdir(A.cardDir(cardV.cardId), { recursive: true });
  await host.workspace.writeFile(
    A.bodyPath(cardV.cardId, fileV.filename),
    input.content,
    envelope.mime,
  );
  await host.workspace.writeFile(
    A.envelopePath(cardV.cardId, fileV.filename),
    JSON.stringify(envelope, null, 2),
    "application/json",
  );
  host.logEvent("artifact.write.ok", {
    card_id: cardV.cardId,
    filename: fileV.filename,
    type: typeV.type,
    sha256: sha,
    bytes: sizeBytes,
    transport: "workspace_share",
    source_agent: agentV.sourceAgent,
  });
  return { ok: true, envelope };
}

export async function readArtifactFree(
  host: ArtifactOpsHost,
  input: ReadArtifactInput,
): Promise<ReadArtifactResult> {
  const cardV = A.validateCardId(input.cardId);
  if ("code" in cardV) return { ok: false, error: cardV };
  const fileV = A.validateFilename(input.filename);
  if ("code" in fileV) return { ok: false, error: fileV };

  const envText = await host.workspace.readFile(A.envelopePath(cardV.cardId, fileV.filename));
  if (envText === null) {
    host.logEvent("artifact.read.not_found", {
      card_id: cardV.cardId,
      filename: fileV.filename,
    });
    return { ok: false, error: { code: "not_found", message: "artifact not found" } };
  }
  const body = await host.workspace.readFile(A.bodyPath(cardV.cardId, fileV.filename));
  if (body === null) {
    host.logEvent("artifact.read.envelope_orphan", {
      card_id: cardV.cardId,
      filename: fileV.filename,
    });
    return { ok: false, error: { code: "not_found", message: "artifact body missing" } };
  }
  let envelope: A.ArtifactEnvelope;
  try {
    envelope = JSON.parse(envText) as A.ArtifactEnvelope;
  } catch {
    host.logEvent("artifact.read.envelope_parse_err", {
      card_id: cardV.cardId,
      filename: fileV.filename,
    });
    return { ok: false, error: { code: "envelope_corrupt", message: "envelope JSON parse error" } };
  }
  host.logEvent("artifact.read.ok", {
    card_id: cardV.cardId,
    filename: fileV.filename,
    sha256: envelope.sha256,
    bytes: envelope.size_bytes,
    transport: "workspace_share",
  });
  return { ok: true, envelope, content: body };
}

export async function listArtifactsFree(
  host: ArtifactOpsHost,
  input: ListArtifactsInput,
): Promise<ListArtifactsResult> {
  const cardV = A.validateCardId(input.cardId);
  if ("code" in cardV) return { ok: false, error: cardV };

  const dir = A.cardDir(cardV.cardId);
  let entries: { name: string; type: string }[] = [];
  try {
    const raw = await host.workspace.readDir(dir, { limit: 500 });
    entries = raw.map(e => ({ name: e.name, type: e.type }));
  } catch {
    // Empty / missing directory → treat as no artifacts (200 with []).
    entries = [];
  }
  const envelopes: A.ArtifactEnvelope[] = [];
  for (const entry of entries) {
    if (entry.type !== "file") continue;
    if (!entry.name.endsWith(".envelope.json")) continue;
    const envText = await host.workspace.readFile(`${dir}/${entry.name}`);
    if (envText === null) continue;
    try {
      envelopes.push(JSON.parse(envText) as A.ArtifactEnvelope);
    } catch {
      // Skip corrupt envelopes; don't fail the whole list.
    }
  }
  host.logEvent("artifact.list.ok", {
    card_id: cardV.cardId,
    count: envelopes.length,
  });
  return { ok: true, card_id: cardV.cardId, envelopes };
}
