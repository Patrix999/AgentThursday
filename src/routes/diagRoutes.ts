//  — `/api/diag/dispatch` route + helpers extracted from `server.ts`.
//
// Originally lived under `server.ts:8815-9033` (helpers) + `:10230-10280`
// (inline route branch). Pattern follows  routes (`inspectRoutes`,
// `demoRoutes` etc.): single exported `handleDiagDispatch(...)`; helpers
// stay file-internal. No behavior change — bodies were lifted verbatim,
// only `env` reaches in via the function arg instead of fetch() closure.
//
//  A.2 — diagnostic endpoint helpers. Lets reviewers capture the
// raw `env.AI.run()` output for the four models in the dispatch saga, so we
// can tell whether tool_calls land where workers-ai-provider expects them.

import { z } from "zod";
import { json } from "../httpUtil";

const DIAG_MODEL_ALLOWLIST = [
  "@cf/meta/llama-4-scout-17b-16e-instruct",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/qwen/qwq-32b",
  "@cf/moonshotai/kimi-k2.6",
] as const;

const DiagDispatchRequestSchema = z.object({
  model: z.enum(DIAG_MODEL_ALLOWLIST),
  prompt: z.string().min(1).max(2000),
  //  A.2-stream — opt into streaming mode. When set, the endpoint
  // calls env.AI.run(..., {stream: true}) and returns an SSE-chunk summary.
  stream: z.boolean().optional(),
});

type ToolCallsLocation = "top-level" | "choices.message" | "choices.delta" | "none";
type ResponseShape = "openai-style" | "native" | "unknown";

function summarizeDiagOutput(output: unknown): {
  rawKeys: string[];
  choiceMessageKeys: string[];
  responseShape: ResponseShape;
  toolCallsLocation: ToolCallsLocation;
  finishReason: string | null;
  hasReasoningContent: boolean;
  usage: unknown;
  rawOutputCapped: string;
} {
  const out = (output ?? {}) as Record<string, unknown>;
  const rawKeys = Object.keys(out);
  const choices = (Array.isArray(out.choices) ? out.choices : []) as Record<string, unknown>[];
  const firstChoice = (choices[0] ?? {}) as Record<string, unknown>;
  const message = (firstChoice.message ?? {}) as Record<string, unknown>;
  const delta = (firstChoice.delta ?? {}) as Record<string, unknown>;
  const choiceMessageKeys = Object.keys(message);

  let toolCallsLocation: ToolCallsLocation;
  if (Array.isArray(out.tool_calls)) toolCallsLocation = "top-level";
  else if (Array.isArray(message.tool_calls)) toolCallsLocation = "choices.message";
  else if (Array.isArray(delta.tool_calls)) toolCallsLocation = "choices.delta";
  else toolCallsLocation = "none";

  let responseShape: ResponseShape;
  if (choices.length > 0) responseShape = "openai-style";
  else if ("response" in out) responseShape = "native";
  else responseShape = "unknown";

  const finishReason = typeof out.finish_reason === "string"
    ? (out.finish_reason as string)
    : (typeof firstChoice.finish_reason === "string" ? (firstChoice.finish_reason as string) : null);

  const hasReasoningContent =
    !!(message.reasoning_content || message.reasoning || delta.reasoning_content || delta.reasoning);

  const usage = out.usage ?? null;

  // Cap rawOutput at 4KB. Structural fields above are the primary signal;
  // the dump is for unexpected shapes the structural classifiers miss.
  let stringified: string;
  try { stringified = JSON.stringify(output) ?? "null"; }
  catch { stringified = "[unstringifiable output]"; }
  const rawOutputCapped = stringified.length > 4096
    ? stringified.slice(0, 4096) + "...[truncated]"
    : stringified;

  return {
    rawKeys,
    choiceMessageKeys,
    responseShape,
    toolCallsLocation,
    finishReason,
    hasReasoningContent,
    usage,
    rawOutputCapped,
  };
}

//  A.2-stream — read SSE chunks from a Workers AI streaming response,
// parse line-buffered `data: {...}` events, and return a summary of where
// tool_calls (and content) appear across chunks. Bypasses workers-ai-provider's
// own parser so we can tell whether tool_calls are dropped at the network
// layer (Workers AI doesn't emit them in chunks) or at the parser layer
// (provider drops them after Workers AI emits them).
async function readSSEChunks(stream: ReadableStream<Uint8Array>): Promise<unknown[]> {
  const chunks: unknown[] = [];
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // Hard caps so a runaway stream cannot exhaust memory.
  const MAX_CHUNKS = 200;
  const MAX_BYTES = 256 * 1024;
  let bytesRead = 0;
  try {
    while (chunks.length < MAX_CHUNKS && bytesRead < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let data: string;
        if (trimmed.startsWith("data: ")) data = trimmed.slice(6);
        else if (trimmed.startsWith("data:")) data = trimmed.slice(5);
        else continue;
        if (data === "[DONE]") continue;
        try { chunks.push(JSON.parse(data)); }
        catch { /* skip un-parsable chunks; they're rare and not informative */ }
      }
    }
    // Drain a final flush of any remaining buffered partial line.
    const finalTrimmed = buffer.trim();
    if (finalTrimmed) {
      let data: string | null = null;
      if (finalTrimmed.startsWith("data: ")) data = finalTrimmed.slice(6);
      else if (finalTrimmed.startsWith("data:")) data = finalTrimmed.slice(5);
      if (data && data !== "[DONE]") {
        try { chunks.push(JSON.parse(data)); } catch { /* ignore */ }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  return chunks;
}

function summarizeDiagStreamChunks(chunks: unknown[]): {
  totalChunks: number;
  chunksWithTopLevelToolCalls: number;
  chunksWithChoicesDeltaToolCalls: number;
  chunksWithChoicesMessageToolCalls: number;
  chunksWithNativeResponse: number;
  chunksWithChoicesDeltaContent: number;
  chunksWithFinishReason: number;
  finishReasons: string[];
  firstChunkKeys: string[];
  lastChunkKeys: string[];
  accumulatedContentLen: number;
  accumulatedToolCallsCount: number;
  rawChunksCapped: string;
} {
  let chunksWithTopLevelToolCalls = 0;
  let chunksWithChoicesDeltaToolCalls = 0;
  let chunksWithChoicesMessageToolCalls = 0;
  let chunksWithNativeResponse = 0;
  let chunksWithChoicesDeltaContent = 0;
  let chunksWithFinishReason = 0;
  const finishReasons: string[] = [];
  let accumulatedContent = "";
  const toolCalls: unknown[] = [];

  for (const c of chunks) {
    const ch = (c ?? {}) as Record<string, unknown>;
    const choices = (Array.isArray(ch.choices) ? ch.choices : []) as Record<string, unknown>[];
    const firstChoice = (choices[0] ?? {}) as Record<string, unknown>;
    const delta = (firstChoice.delta ?? {}) as Record<string, unknown>;
    const message = (firstChoice.message ?? {}) as Record<string, unknown>;

    if (Array.isArray(ch.tool_calls)) {
      chunksWithTopLevelToolCalls++;
      for (const tc of ch.tool_calls) toolCalls.push(tc);
    }
    if (Array.isArray(delta.tool_calls)) {
      chunksWithChoicesDeltaToolCalls++;
      for (const tc of delta.tool_calls) toolCalls.push(tc);
    }
    if (Array.isArray(message.tool_calls)) {
      chunksWithChoicesMessageToolCalls++;
      for (const tc of message.tool_calls) toolCalls.push(tc);
    }
    if (typeof ch.response === "string" && ch.response.length > 0) {
      chunksWithNativeResponse++;
      accumulatedContent += ch.response;
    }
    if (typeof delta.content === "string" && delta.content.length > 0) {
      chunksWithChoicesDeltaContent++;
      accumulatedContent += delta.content;
    }
    const fr = ch.finish_reason ?? firstChoice.finish_reason;
    if (typeof fr === "string") {
      chunksWithFinishReason++;
      if (!finishReasons.includes(fr)) finishReasons.push(fr);
    }
  }

  const firstChunk = (chunks[0] ?? {}) as Record<string, unknown>;
  const lastChunk = (chunks[chunks.length - 1] ?? {}) as Record<string, unknown>;

  // Cap raw chunks dump at 4KB across the first N chunks for inspectability.
  let rawChunksCapped = "";
  for (const c of chunks) {
    let s: string;
    try { s = JSON.stringify(c) ?? "null"; } catch { s = "[unstringifiable]"; }
    if (rawChunksCapped.length + s.length + 1 > 4096) break;
    rawChunksCapped += (rawChunksCapped ? "\n" : "") + s;
  }
  if (chunks.length > 0 && rawChunksCapped.length === 0) rawChunksCapped = "[chunks too large to fit cap]";

  return {
    totalChunks: chunks.length,
    chunksWithTopLevelToolCalls,
    chunksWithChoicesDeltaToolCalls,
    chunksWithChoicesMessageToolCalls,
    chunksWithNativeResponse,
    chunksWithChoicesDeltaContent,
    chunksWithFinishReason,
    finishReasons,
    firstChunkKeys: Object.keys(firstChunk),
    lastChunkKeys: Object.keys(lastChunk),
    accumulatedContentLen: accumulatedContent.length,
    accumulatedToolCallsCount: toolCalls.length,
    rawChunksCapped,
  };
}

//  A.2 — diagnostic endpoint for direct env.AI.run() capture.
// Bypasses the workers-ai-provider adapter so we can see the raw shape
// Workers AI returns for an allowlisted model + minimal tool schema.
// Used to determine whether tool_calls land in the structural fields
// the adapter reads from, vs in plain-text content. Auth-gated upstream
// in `server.ts` composition root.
export async function handleDiagDispatch(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const parsed = DiagDispatchRequestSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, 400);
  const { model, prompt, stream } = parsed.data;
  const tools = [{
    type: "function",
    function: {
      name: "echo_test",
      description: "Echo back input. Used only to test tool-call dispatch shape.",
      parameters: {
        type: "object",
        properties: { x: { type: "string", description: "Any string." } },
        required: ["x"],
      },
    },
  }];
  const inputs = {
    messages: [{ role: "user", content: prompt }],
    tools,
    tool_choice: "required",
    ...(stream === true ? { stream: true } : {}),
  };
  let output: unknown;
  try {
    output = await (env.AI as unknown as { run: (m: string, i: unknown) => Promise<unknown> }).run(model, inputs);
  } catch (e) {
    return json({
      error: "ai_run_failed",
      message: String(e instanceof Error ? e.message : e).slice(0, 500),
    }, 502);
  }
  if (stream === true) {
    if (!(output instanceof ReadableStream)) {
      return json({
        error: "expected_stream",
        actualType: typeof output,
        note: "binding returned a non-stream value despite stream:true",
      }, 502);
    }
    const chunks = await readSSEChunks(output as ReadableStream<Uint8Array>);
    return json({ mode: "stream", ...summarizeDiagStreamChunks(chunks) });
  }
  return json({ mode: "non-stream", ...summarizeDiagOutput(output) });
}

// Test surface — re-exported under `__internalForTests` so the
// smoke can drive the helpers directly without going through `env.AI`.
// Not part of the public route module API; do not import from production
// code paths.
export const __internalForTests = {
  summarizeDiagOutput,
  readSSEChunks,
  summarizeDiagStreamChunks,
  DiagDispatchRequestSchema,
};
