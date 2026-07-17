/**
 * grep --include glob portability tests.
 *
 * The sandbox grep (busybox/musl pathname fnmatch) can't recurse with
 * `**` / `*` across `/`; `**\/*.tsx` must normalize to basename-level
 * `*.tsx` before landing in `--include`.
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { normalizeGrepIncludeGlob } from "./devShell";

describe("normalizeGrepIncludeGlob", () => {
  it("strips a leading **/ down to a basename glob (the task-mq7vh4cc defect)", () => {
    assert.equal(normalizeGrepIncludeGlob("**/*.tsx"), "*.tsx");
  });

  it("strips repeated leading **/ segments", () => {
    assert.equal(normalizeGrepIncludeGlob("**/**/*.ts"), "*.ts");
  });

  it("leaves a plain basename glob unchanged", () => {
    assert.equal(normalizeGrepIncludeGlob("*.ts"), "*.ts");
  });

  it("leaves a directory-anchored glob unchanged", () => {
    assert.equal(normalizeGrepIncludeGlob("web/**/*.ts"), "web/**/*.ts");
  });

  it("treats match-everything globs as no include filter", () => {
    assert.equal(normalizeGrepIncludeGlob("**/*"), "");
    assert.equal(normalizeGrepIncludeGlob("**"), "");
    assert.equal(normalizeGrepIncludeGlob("*"), "");
    assert.equal(normalizeGrepIncludeGlob(""), "");
  });

  it("drops a leading ./ prefix", () => {
    assert.equal(normalizeGrepIncludeGlob("./**/*.tsx"), "*.tsx");
  });
});
