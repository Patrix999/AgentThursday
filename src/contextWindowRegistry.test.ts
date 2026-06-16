import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  pickModelContextProfile,
  MODEL_CONTEXT_REGISTRY,
  DEFAULT_CONTEXT_PROFILE,
} from "./contextWindowRegistry";

describe("pickModelContextProfile — exact match (tier 1)", () => {
  it("returns the registry entry by exact key", () => {
    assert.strictEqual(pickModelContextProfile("kimi-k2.6"), MODEL_CONTEXT_REGISTRY["kimi-k2.6"]);
    assert.strictEqual(pickModelContextProfile("claude-opus-4-7"), MODEL_CONTEXT_REGISTRY["claude-opus-4-7"]);
    assert.strictEqual(pickModelContextProfile("gpt-4.1"), MODEL_CONTEXT_REGISTRY["gpt-4.1"]);
  });
});

describe("pickModelContextProfile — lowercase normalization (tier 2)", () => {
  it("matches case-insensitively when an upper/mixed-case id is provided", () => {
    assert.strictEqual(pickModelContextProfile("KIMI-K2.6"), MODEL_CONTEXT_REGISTRY["kimi-k2.6"]);
    assert.strictEqual(pickModelContextProfile("Claude-Opus-4-7"), MODEL_CONTEXT_REGISTRY["claude-opus-4-7"]);
  });

  it("trims whitespace around the id", () => {
    assert.strictEqual(pickModelContextProfile("  kimi-k2.6  "), MODEL_CONTEXT_REGISTRY["kimi-k2.6"]);
  });
});

describe("pickModelContextProfile — family/prefix patterns (tier 3)", () => {
  it("Kimi K2 vendor-suffixed ids map to the modern K2.6 entry", () => {
    assert.strictEqual(pickModelContextProfile("kimi-k2-something-new"), MODEL_CONTEXT_REGISTRY["kimi-k2.6"]);
  });

  it("Kimi K2.6 / K2.5 suffix variants pin to the specific minor version", () => {
    assert.strictEqual(pickModelContextProfile("kimi-k2.6-1m-context"), MODEL_CONTEXT_REGISTRY["kimi-k2.6"]);
    assert.strictEqual(pickModelContextProfile("kimi-k2.5-experimental"), MODEL_CONTEXT_REGISTRY["kimi-k2.5"]);
  });

  it("more-specific Kimi patterns win over the generic kimi-k2 fallback", () => {
    // kimi-k2-0711 must not get swallowed by the generic kimi-k2 rule (128K vs 256K).
    assert.strictEqual(
      pickModelContextProfile("kimi-k2-0711-preview-rerun"),
      MODEL_CONTEXT_REGISTRY["kimi-k2-0711-preview"],
    );
    assert.equal(pickModelContextProfile("kimi-k2-0711-preview-rerun").modelMaxTokens, 128_000);

    assert.strictEqual(
      pickModelContextProfile("kimi-k2-thinking-preview-rc1"),
      MODEL_CONTEXT_REGISTRY["kimi-k2-thinking"],
    );
  });

  it("Claude family suffixed ids resolve to the right tier", () => {
    assert.strictEqual(
      pickModelContextProfile("claude-opus-4-7@20260201"),
      MODEL_CONTEXT_REGISTRY["claude-opus-4-7"],
    );
    assert.strictEqual(
      pickModelContextProfile("claude-sonnet-4-6-20251022"),
      MODEL_CONTEXT_REGISTRY["claude-sonnet-4-6"],
    );
    assert.strictEqual(
      pickModelContextProfile("claude-haiku-4-5-some-suffix"),
      MODEL_CONTEXT_REGISTRY["claude-haiku-4-5"],
    );
  });

  it("Generic 'claude' id without a known family falls to the sane Sonnet 4.6 default", () => {
    assert.strictEqual(pickModelContextProfile("claude-fancy"), MODEL_CONTEXT_REGISTRY["claude-sonnet-4-6"]);
  });

  it("OpenAI specificity: gpt-4.1-mini must not collapse to gpt-4.1", () => {
    assert.strictEqual(pickModelContextProfile("gpt-4.1-mini-2026"), MODEL_CONTEXT_REGISTRY["gpt-4.1-mini"]);
    assert.strictEqual(pickModelContextProfile("gpt-4.1-nano-rc"), MODEL_CONTEXT_REGISTRY["gpt-4.1-nano"]);
    assert.strictEqual(pickModelContextProfile("gpt-4o-mini-x"), MODEL_CONTEXT_REGISTRY["gpt-4o-mini"]);
  });

  it("Gemini and Llama family fallbacks resolve to documented tier", () => {
    assert.strictEqual(pickModelContextProfile("gemini-2.5-flash-001"), MODEL_CONTEXT_REGISTRY["gemini-2.5-flash"]);
    assert.strictEqual(pickModelContextProfile("gemini-1.5-flash-experimental"), MODEL_CONTEXT_REGISTRY["gemini-1.5-pro"]);
    assert.strictEqual(pickModelContextProfile("llama-3.3-70b-instruct"), MODEL_CONTEXT_REGISTRY["llama-3.3-70b"]);
  });
});

describe("pickModelContextProfile — fallback (tier 4)", () => {
  it("null / undefined / empty / whitespace id returns DEFAULT_CONTEXT_PROFILE", () => {
    assert.strictEqual(pickModelContextProfile(null), DEFAULT_CONTEXT_PROFILE);
    assert.strictEqual(pickModelContextProfile(undefined), DEFAULT_CONTEXT_PROFILE);
    assert.strictEqual(pickModelContextProfile(""), DEFAULT_CONTEXT_PROFILE);
    assert.strictEqual(pickModelContextProfile("   "), DEFAULT_CONTEXT_PROFILE);
  });

  it("an unknown / non-family id falls back to DEFAULT_CONTEXT_PROFILE (not 8K)", () => {
    assert.strictEqual(pickModelContextProfile("some-future-model"), DEFAULT_CONTEXT_PROFILE);
    assert.equal(pickModelContextProfile("some-future-model").modelMaxTokens, 128_000);
    assert.equal(pickModelContextProfile("some-future-model").source, "fallback");
  });
});

describe("registry invariants", () => {
  it("DEFAULT_CONTEXT_PROFILE carries a 'fallback' source so callers can branch on it", () => {
    assert.equal(DEFAULT_CONTEXT_PROFILE.source, "fallback");
  });

  it("every registry entry exposes a positive context window and an ISO lastChecked", () => {
    for (const [id, p] of Object.entries(MODEL_CONTEXT_REGISTRY)) {
      assert.ok(p.modelMaxTokens > 0, `${id} modelMaxTokens must be > 0`);
      assert.match(p.lastChecked, /^\d{4}-\d{2}-\d{2}$/, `${id} lastChecked must be ISO YYYY-MM-DD`);
    }
  });

  it("thresholds are monotonic: soft < hard < danger", () => {
    for (const [id, p] of Object.entries(MODEL_CONTEXT_REGISTRY)) {
      const { softCompactRatio, hardCompactRatio, dangerRatio } = p.thresholds;
      assert.ok(
        softCompactRatio < hardCompactRatio && hardCompactRatio < dangerRatio,
        `${id} thresholds must be monotonic (got soft=${softCompactRatio}, hard=${hardCompactRatio}, danger=${dangerRatio})`,
      );
    }
  });
});
