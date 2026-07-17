import { test } from "node:test";
import assert from "node:assert/strict";

import { canAccessSource, tokenPlanForSource } from "./contentSourceAccess";

const U_A = "user-aaaa";
const U_B = "user-bbbb";
const ADMIN = "user-admin";

test("fixture source → everyone (operator, scoped user, even unresolved)", () => {
  for (const c of [
    { callerOwnerId: ADMIN, isOperator: true },
    { callerOwnerId: U_A, isOperator: false },
    { callerOwnerId: null, isOperator: false },
  ]) {
    assert.deepEqual(canAccessSource({ scope: "fixture", sourceOwnerId: null, ...c }), { allow: true });
  }
});

test("project (operator-internal) → operator yes, scoped user no", () => {
  assert.deepEqual(
    canAccessSource({ scope: "project", sourceOwnerId: null, callerOwnerId: ADMIN, isOperator: true }),
    { allow: true },
  );
  assert.deepEqual(
    canAccessSource({ scope: "project", sourceOwnerId: null, callerOwnerId: U_A, isOperator: false }),
    { allow: false, reason: "operator_only" },
  );
});

test("user source → owner can access", () => {
  assert.deepEqual(
    canAccessSource({ scope: "personal", sourceOwnerId: U_A, callerOwnerId: U_A, isOperator: false }),
    { allow: true },
  );
});

test("user source → ANOTHER tenant denied (not_owner) — the cross-tenant guard", () => {
  assert.deepEqual(
    canAccessSource({ scope: "personal", sourceOwnerId: U_A, callerOwnerId: U_B, isOperator: false }),
    { allow: false, reason: "not_owner" },
  );
});

test("user source → operator does NOT auto-access (tenant privacy even from admin)", () => {
  assert.deepEqual(
    canAccessSource({ scope: "personal", sourceOwnerId: U_A, callerOwnerId: ADMIN, isOperator: true }),
    { allow: false, reason: "not_owner" },
  );
});

test("user source → unresolved caller fails closed (owner_unresolved)", () => {
  assert.deepEqual(
    canAccessSource({ scope: "personal", sourceOwnerId: U_A, callerOwnerId: null, isOperator: false }),
    { allow: false, reason: "owner_unresolved" },
  );
});

test("user source with null owner (malformed) → denied, never open", () => {
  assert.equal(
    canAccessSource({ scope: "personal", sourceOwnerId: null, callerOwnerId: U_A, isOperator: false }).allow,
    false,
  );
});

test("unknown/future scope fails closed (operator only)", () => {
  assert.deepEqual(
    canAccessSource({ scope: "tenant-public-future", sourceOwnerId: null, callerOwnerId: U_A, isOperator: false }),
    { allow: false, reason: "operator_only" },
  );
  assert.equal(
    canAccessSource({ scope: "weird", sourceOwnerId: null, callerOwnerId: ADMIN, isOperator: true }).allow,
    true,
  );
});

// ── tokenPlanForSource — THE catastrophic invariant (never env for a user repo) ──

test("token plan: project → env (the ONLY scope that gets the worker token)", () => {
  assert.deepEqual(tokenPlanForSource({ scope: "project", sourceOwnerId: null, callerOwnerId: ADMIN }), { source: "env" });
  // even with no caller owner, a project source still maps to env (operator-internal).
  assert.deepEqual(tokenPlanForSource({ scope: "project", sourceOwnerId: null, callerOwnerId: null }), { source: "env" });
});

test("token plan: personal + caller IS owner → that owner's credential (never env)", () => {
  assert.deepEqual(
    tokenPlanForSource({ scope: "personal", sourceOwnerId: U_A, callerOwnerId: U_A }),
    { source: "owner-credential", ownerUserId: U_A },
  );
});

test("token plan: personal + caller is ANOTHER tenant → none, NEVER env (the leak guard)", () => {
  const plan = tokenPlanForSource({ scope: "personal", sourceOwnerId: U_A, callerOwnerId: U_B });
  assert.equal(plan.source, "none");
  assert.notEqual(plan.source, "env");
});

test("token plan: personal + unresolved caller / null owner → none, never env", () => {
  assert.equal(tokenPlanForSource({ scope: "personal", sourceOwnerId: U_A, callerOwnerId: null }).source, "none");
  assert.equal(tokenPlanForSource({ scope: "personal", sourceOwnerId: null, callerOwnerId: U_A }).source, "none");
});

test("token plan: operator does NOT borrow env for a user repo (admin caller, personal source)", () => {
  // Even the admin/operator, naming a user's personal source, gets none — not env.
  // (canAccessSource already denies this; the token plan is the second guard.)
  const plan = tokenPlanForSource({ scope: "personal", sourceOwnerId: U_A, callerOwnerId: ADMIN });
  assert.equal(plan.source, "none");
});

test("token plan: fixture / unknown scope → none, never env", () => {
  assert.equal(tokenPlanForSource({ scope: "fixture", sourceOwnerId: null, callerOwnerId: U_A }).source, "none");
  assert.equal(tokenPlanForSource({ scope: "tenant-public-future", sourceOwnerId: null, callerOwnerId: ADMIN }).source, "none");
});
