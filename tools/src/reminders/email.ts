/**
 * Reminders by email, over SMTP. Any sending account speaks SMTP, so this depends on no provider.
 *
 * A reminder is plain text: no HTML, and so nothing that can be dressed up as a button. The texts
 * themselves contain no link (messages.ts), and nothing here adds one.
 */
import nodemailer from "nodemailer";
import { type Message } from "./messages.ts";
import { type Channel } from "./service.ts";

export interface EmailConfig {
  /**
   * An SMTP URL with its credentials, e.g. `smtps://user:password@smtp.example.com:465`. Never logged.
   * `smtp://` (port 587) must upgrade to TLS before anything is sent, except to this machine itself.
   */
  smtpUrl: string;
  /** the sender, e.g. `Lamport Heir <heir@example.com>` */
  from: string;
}

/** One address and nothing else: no display name, no second recipient, no line break to start a header with. */
export function isEmailAddress(to: string): boolean {
  return to.length <= 254 && /^[^\s@<>,;:"'()\[\]\\]+@[^\s@<>,;:"'()\[\]\\]+\.[^\s@<>,;:"'()\[\]\\]+$/.test(to);
}

/** What goes wrong with a configuration, in words, without repeating the URL (it holds the password). */
export function emailConfigProblem(c: Partial<EmailConfig>): string | undefined {
  if (!c.smtpUrl) return "no SMTP URL is set";
  let url: URL;
  try { url = new URL(c.smtpUrl); } catch { return "the SMTP URL is not a URL"; }
  if (url.protocol !== "smtps:" && url.protocol !== "smtp:") return "the SMTP URL must start with smtps:// or smtp://";
  if (!c.from || !isEmailAddress(c.from.replace(/^.*<([^<>]+)>\s*$/, "$1"))) return "the sender is not an email address";
  return undefined;
}

export function emailChannel(config: EmailConfig): Channel & { close(): void } {
  const problem = emailConfigProblem(config);
  if (problem) throw new Error(`email is not configured: ${problem}`);
  const url = new URL(config.smtpUrl);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  const transport = nodemailer.createTransport({
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port: Number(url.port) || (url.protocol === "smtps:" ? 465 : 587),
    secure: url.protocol === "smtps:",
    // smtp:// starts in the clear and upgrades. Without this a server that does not offer the upgrade, or
    // somebody on the way who removes the offer, would be sent the account's password as plain text.
    requireTLS: url.protocol === "smtp:" && !local,
    ...(url.username ? { auth: { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) } } : {}),
  });
  return {
    async send(to: string, message: Message): Promise<void> {
      if (!isEmailAddress(to)) throw new Error("the recipient is not an email address");
      try {
        await transport.sendMail({
          from: config.from,
          to,
          subject: message.subject,
          text: message.body,
          // an automatic message: mail systems should not answer it with out-of-office replies
          headers: { "Auto-Submitted": "auto-generated", "X-Auto-Response-Suppress": "All" },
          disableFileAccess: true,
          disableUrlAccess: true,
        });
      } catch (e) {
        // a transport error may quote the connection it was using; say what failed, not where
        const code = (e as { code?: string; responseCode?: number }).responseCode ?? (e as { code?: string }).code ?? "error";
        throw new Error(`the mail server did not take the message (${code})`);
      }
    },
    close: () => transport.close(),
  };
}
