/**
 *  — pure tests for `selectTypecheckPhases` /
 * `classifyTypecheckPath`. These drive the gate.typecheck fast path:
 * given the worktree's changed paths, run only the relevant phases and
 * skip the slow full-repo `root` phase for localized mutations, while
 * never masquerading a scoped run as a full-repo PASS.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  selectTypecheckPhases,
  classifyTypecheckPath,
} from "./gateConstants";

const phaseNames = (sel: ReturnType<typeof selectTypecheckPhases>) =>
  sel.phases.map((p) => p.phase);
const skippedNames = (sel: ReturnType<typeof selectTypecheckPhases>) =>
  sel.skipped.map((s) => s.phase);

describe("classifyTypecheckPath", () => {
  it("classifies by top-level package", () => {
    assert.equal(classifyTypecheckPath("web/src/shell/PrimaryNav.tsx"), "web");
    assert.equal(classifyTypecheckPath("tui/index.tsx"), "tui");
    assert.equal(classifyTypecheckPath("scripts/foo.ts"), "scripts");
    assert.equal(classifyTypecheckPath("src/server.ts"), "src");
    assert.equal(classifyTypecheckPath("worker-configuration.d.ts"), "src");
  });
  it("treats config / lockfiles / unknown top-level paths as shared", () => {
    assert.equal(classifyTypecheckPath("package.json"), "shared");
    assert.equal(classifyTypecheckPath("tsconfig.json"), "shared");
    assert.equal(classifyTypecheckPath("tsconfig.test.json"), "shared");
    assert.equal(classifyTypecheckPath("package-lock.json"), "shared");
    assert.equal(classifyTypecheckPath("README.md"), "shared");
  });
});

describe("selectTypecheckPhases", () => {
  it("web-only changes → run web phase, skip diag/root/tui/scripts", () => {
    const sel = selectTypecheckPhases([
      "web/src/shell/PrimaryNav.tsx",
      "web/src/dashboard/DashboardRoute.tsx",
    ]);
    assert.equal(sel.scoped, true);
    assert.deepEqual(phaseNames(sel), ["web"]);
    assert.deepEqual(skippedNames(sel).sort(), ["diag", "root", "scripts", "tui"]);
    assert.ok(sel.skipped.every((s) => s.reason === "scoped_fast_path"));
    //  — web phase also needs the ROOT prewarm (../src zod).
    assert.deepEqual(sel.depSubdirs.sort(), ["", "web"]);
    assert.deepEqual(sel.scopes, ["web"]);
  });

  it("src-only changes → diag + root, skip tui/scripts (root tsbin only)", () => {
    const sel = selectTypecheckPhases(["src/server.ts"]);
    assert.equal(sel.scoped, true);
    assert.deepEqual(phaseNames(sel), ["diag", "root"]);
    assert.deepEqual(skippedNames(sel).sort(), ["scripts", "tui"]);
    assert.deepEqual(sel.depSubdirs, [""]);
  });

  it("tui-only changes → tui phase only", () => {
    const sel = selectTypecheckPhases(["tui/index.tsx"]);
    assert.deepEqual(phaseNames(sel), ["tui"]);
    assert.deepEqual(skippedNames(sel).sort(), ["diag", "root", "scripts"]);
    assert.deepEqual(sel.depSubdirs, [""]);
  });

  it("scripts-only changes → scripts phase only", () => {
    const sel = selectTypecheckPhases(["scripts/generate-x.ts"]);
    assert.deepEqual(phaseNames(sel), ["scripts"]);
    assert.deepEqual(skippedNames(sel).sort(), ["diag", "root", "tui"]);
  });

  it("mixed web + src → diag, root, web; both subdirs warmed", () => {
    const sel = selectTypecheckPhases(["src/server.ts", "web/src/x.tsx"]);
    assert.equal(sel.scoped, true);
    assert.deepEqual(phaseNames(sel).sort(), ["diag", "root", "web"]);
    assert.deepEqual(skippedNames(sel).sort(), ["scripts", "tui"]);
    assert.deepEqual(sel.depSubdirs.sort(), ["", "web"]);
  });

  it("shared config change → FULL fallback (no scoping, no skip, web not added)", () => {
    const sel = selectTypecheckPhases(["package.json", "web/src/x.tsx"]);
    assert.equal(sel.scoped, false);
    assert.deepEqual(phaseNames(sel), ["diag", "root", "tui", "scripts"]);
    assert.deepEqual(sel.skipped, []);
    assert.deepEqual(sel.depSubdirs, [""]);
  });

  it("no detected changes → FULL fallback (never a scoped pass on empty)", () => {
    const sel = selectTypecheckPhases([]);
    assert.equal(sel.scoped, false);
    assert.deepEqual(phaseNames(sel), ["diag", "root", "tui", "scripts"]);
    assert.deepEqual(sel.skipped, []);
  });

  it("unknown top-level path → shared → FULL fallback", () => {
    const sel = selectTypecheckPhases(["Dockerfile"]);
    assert.equal(sel.scoped, false);
    assert.deepEqual(phaseNames(sel), ["diag", "root", "tui", "scripts"]);
  });
});
