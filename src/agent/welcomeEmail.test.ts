import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import type { AppUser } from "./userOps";
import {
  APP_URL,
  WELCOME_EMAIL_FROM,
  buildWelcomeEmail,
  shouldSendWelcomeEmail,
  sendWelcomeEmail,
  type EmailServiceBinding,
} from "./welcomeEmail";

function mkUser(over: Partial<AppUser> = {}): AppUser {
  return {
    user_id: "user-1",
    provider: "google",
    sub: "sub-1",
    email: "u@example.com",
    status: "approved",
    created_at: "t",
    updated_at: "t",
    ...over,
  };
}

describe("buildWelcomeEmail", () => {
  it("addresses the recipient, sends from the verified domain, links to the app", () => {
    const m = buildWelcomeEmail("new-user@somewhere.com");
    assert.equal(m.to, "new-user@somewhere.com");
    assert.equal(m.from, WELCOME_EMAIL_FROM);
    assert.match(m.from, /@agentthursday\.com$/);
    assert.ok(m.subject.length > 0);
    assert.ok(m.text.includes(APP_URL), "text body links to the app");
    assert.ok(m.html.includes(APP_URL), "html body links to the app");
  });
});

describe("shouldSendWelcomeEmail — fires only on a real pending→approved transition", () => {
  it("pending → approved with an email → true", () => {
    assert.equal(
      shouldSendWelcomeEmail(mkUser({ status: "pending" }), mkUser({ status: "approved" })),
      true,
    );
  });

  it("re-approve (already approved → approved) → false", () => {
    assert.equal(
      shouldSendWelcomeEmail(mkUser({ status: "approved" }), mkUser({ status: "approved" })),
      false,
    );
  });

  it("transition but no email address → false", () => {
    assert.equal(
      shouldSendWelcomeEmail(mkUser({ status: "pending" }), mkUser({ status: "approved", email: "" })),
      false,
    );
  });

  it("user not found before (null) → false", () => {
    assert.equal(shouldSendWelcomeEmail(null, mkUser({ status: "approved" })), false);
  });

  it("approve returned null → false", () => {
    assert.equal(shouldSendWelcomeEmail(mkUser({ status: "pending" }), null), false);
  });
});

describe("sendWelcomeEmail", () => {
  it("hands the built message to the binding's send()", async () => {
    let captured: unknown = null;
    const binding: EmailServiceBinding = {
      send: async (m) => {
        captured = m;
        return { messageId: "mid-1" };
      },
    };
    await sendWelcomeEmail(binding, "x@y.com");
    assert.deepEqual(captured, buildWelcomeEmail("x@y.com"));
  });

  it("propagates a send failure to the caller (which try/catches it)", async () => {
    const binding: EmailServiceBinding = {
      send: async () => {
        throw new Error("E_RECIPIENT_NOT_ALLOWED");
      },
    };
    await assert.rejects(() => sendWelcomeEmail(binding, "x@y.com"), /E_RECIPIENT_NOT_ALLOWED/);
  });
});
