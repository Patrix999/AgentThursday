/**
 * 2026-06-22 — welcome email on end-user account approval (an earlier revision follow-up).
 *
 * When the operator approves a pending end-user from the secret-protected
 * console, send a one-time welcome email via the Cloudflare Email Service
 * `[[send_email]]` binding (env.EMAIL). agentthursday.com is a verified sender
 * domain.
 *
 * Fail-soft is the caller's contract: `appUserApprove` flips the DB status
 * FIRST and only then attempts the email inside try/catch, so a send failure
 * never blocks or reverses an approval. Logs carry `user_id` only — never the
 * recipient address.
 */
import type { AppUser } from "./userOps";

/**
 * The installed @cloudflare/workers-types (2023-07-01) types `SendEmail.send()`
 * as accepting only the legacy MIME `EmailMessage`. The runtime (compat
 * 2026-04-20) supports the modern structured EmailMessageBuilder form — the
 * only form that can send transactional mail to an arbitrary recipient. We
 * declare exactly the shape we use and cast the binding to it at the call site.
 */
export interface EmailServiceBinding {
  send(message: {
    to: string;
    from: string;
    subject: string;
    text?: string;
    html?: string;
    replyTo?: string;
  }): Promise<unknown>;
}

/** Verified sender on the agentthursday.com domain. */
export const WELCOME_EMAIL_FROM = "welcome@agentthursday.com";
/** Sign-in destination the welcome email points to. */
export const APP_URL = "https://agentthursday.com";

export interface WelcomeEmailMessage {
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
}

export function buildWelcomeEmail(to: string): WelcomeEmailMessage {
  const subject = "Your Agent Thursday account is approved";
  const text = [
    "Welcome to Agent Thursday!",
    "",
    "Your account has been approved. You can now sign in and start working with",
    "your personal AI agent:",
    APP_URL,
    "",
    "Once you're in, just say hello — your agent will introduce itself and show",
    "you what it can do.",
    "",
    "— The Agent Thursday team",
  ].join("\n");
  const html =
    `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.6;color:#1a1a1a;max-width:480px;margin:0 auto;padding:24px">` +
    `<h2 style="margin:0 0 16px">Welcome to Agent Thursday 👋</h2>` +
    `<p>Your account has been <strong>approved</strong>. You can now sign in and start working with your personal AI agent.</p>` +
    `<p style="margin:24px 0"><a href="${APP_URL}" style="background:#1a1a1a;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block">Open Agent Thursday</a></p>` +
    `<p style="color:#555">Once you're in, just say hello — your agent will introduce itself and show you what it can do.</p>` +
    `<p style="color:#888;font-size:13px;margin-top:32px">— The Agent Thursday team</p>` +
    `</body></html>`;
  return { to, from: WELCOME_EMAIL_FROM, subject, text, html };
}

/**
 * True only on a genuine pending→approved transition with a recipient address,
 * so a re-approve (idempotent) never re-sends and a row without an email is
 * skipped.
 */
export function shouldSendWelcomeEmail(before: AppUser | null, after: AppUser | null): boolean {
  return !!(
    after &&
    after.status === "approved" &&
    !!after.email &&
    before &&
    before.status === "pending"
  );
}

export async function sendWelcomeEmail(binding: EmailServiceBinding, to: string): Promise<void> {
  await binding.send(buildWelcomeEmail(to));
}
