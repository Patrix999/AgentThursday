import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ADMIN_USER_ID,
  resolveRequestIdentity,
  isAdminIdentity,
  ownerUserIdFor,
  type RequestIdentity,
} from "./requestIdentity";

test("no header resolves to admin", () => {
  assert.deepEqual(resolveRequestIdentity(null), { kind: "admin" });
  assert.deepEqual(resolveRequestIdentity(undefined), { kind: "admin" });
  assert.deepEqual(resolveRequestIdentity(""), { kind: "admin" });
  assert.deepEqual(resolveRequestIdentity("   "), { kind: "admin" });
});

test("admin sentinel resolves to admin", () => {
  assert.deepEqual(resolveRequestIdentity(ADMIN_USER_ID), { kind: "admin" });
  assert.deepEqual(resolveRequestIdentity("  user-admin  "), { kind: "admin" });
});

test("a scoped user id resolves to that user (trimmed)", () => {
  assert.deepEqual(resolveRequestIdentity("user-abc"), { kind: "user", userId: "user-abc" });
  assert.deepEqual(resolveRequestIdentity("  user-xyz  "), { kind: "user", userId: "user-xyz" });
});

test("isAdminIdentity reflects kind", () => {
  assert.equal(isAdminIdentity({ kind: "admin" }), true);
  assert.equal(isAdminIdentity({ kind: "user", userId: "user-1" }), false);
});

test("ownerUserIdFor stamps admin sentinel or the user's own id", () => {
  const admin: RequestIdentity = { kind: "admin" };
  const user: RequestIdentity = { kind: "user", userId: "user-7" };
  assert.equal(ownerUserIdFor(admin), ADMIN_USER_ID);
  assert.equal(ownerUserIdFor(user), "user-7");
});
