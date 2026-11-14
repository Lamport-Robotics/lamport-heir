import { type AddressInfo } from "node:net";
import { SMTPServer } from "smtp-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emailChannel, emailConfigProblem, isEmailAddress } from "../src/reminders/email.ts";
import { renderNotice } from "../src/reminders/messages.ts";

/** a mail server on this machine that keeps what it is given */
const received: { from: string; to: string[]; raw: string }[] = [];
let server: SMTPServer;
let port = 0;

beforeAll(async () => {
  server = new SMTPServer({
    disabledCommands: ["STARTTLS", "AUTH"],
    onData(stream, session, done) {
      let raw = "";
      stream.on("data", (c: Buffer) => (raw += c.toString("utf8")));
      stream.on("end", () => { received.push({ from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "", to: session.envelope.rcptTo.map((r) => r.address), raw }); done(); });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const notice = renderNotice({ key: "k", kind: "deadline_ahead", audience: ["owner"], vault: "7PXPNg9xV5JQRCyN3xi14hdZE6qAkTedp2MytauZySeh", days: 7, at: 1_800_000_000n }, "owner", "savings");

describe("reminders by email", () => {
  it("sends the notice as plain text, to one address, marked as automatic", async () => {
    const channel = emailChannel({ smtpUrl: `smtp://127.0.0.1:${port}`, from: "Lamport Heir <heir@example.org>" });
    await channel.send("owner@example.org", notice);
    channel.close();
    expect(received).toHaveLength(1);
    const m = received[0]!;
    expect(m.from).toBe("heir@example.org");
    expect(m.to).toEqual(["owner@example.org"]);
    expect(m.raw).toMatch(/^Subject: Lamport Heir: 7 days left to check in\r?$/m);
    expect(m.raw).toMatch(/^Auto-Submitted: auto-generated\r?$/m);
    expect(m.raw).toMatch(/^Content-Type: text\/plain/m);
    expect(m.raw).not.toMatch(/text\/html|multipart/i);
    // nothing in it to click, in any spelling a mail program would turn into a link
    const body = m.raw.split(/\r?\n\r?\n/).slice(1).join("\n\n");
    expect(body).not.toMatch(/https?:\/\/|www\.|href/i);
    expect(body).toContain("savings");
  });

  it("refuses anything that is not exactly one address", async () => {
    for (const ok of ["owner@example.org", "first.last+heir@mail.example.co.uk"]) expect(isEmailAddress(ok), ok).toBe(true);
    for (const bad of ["", "owner", "owner@example", "A <a@example.org>", "a@example.org, b@example.org", "a@example.org\r\nBcc: b@example.org", "a@example.org\nSubject: hello", "a b@example.org", `${"x".repeat(250)}@example.org`]) expect(isEmailAddress(bad), JSON.stringify(bad)).toBe(false);
    const channel = emailChannel({ smtpUrl: `smtp://127.0.0.1:${port}`, from: "heir@example.org" });
    const before = received.length;
    await expect(channel.send("a@example.org\r\nBcc: b@example.org", notice)).rejects.toThrow(/not an email address/);
    channel.close();
    expect(received.length).toBe(before);
  });

  it("says what is wrong with a configuration without repeating the password", () => {
    expect(emailConfigProblem({})).toMatch(/no SMTP URL/);
    expect(emailConfigProblem({ smtpUrl: "not a url", from: "heir@example.org" })).toMatch(/not a URL/);
    expect(emailConfigProblem({ smtpUrl: "https://user:hunter2@example.org", from: "heir@example.org" })).toMatch(/smtps:\/\/ or smtp:\/\//);
    expect(emailConfigProblem({ smtpUrl: "smtps://user:hunter2@smtp.example.org:465", from: "nobody" })).toMatch(/sender is not an email address/);
    expect(emailConfigProblem({ smtpUrl: "smtps://user:hunter2@smtp.example.org:465", from: "Lamport Heir <heir@example.org>" })).toBeUndefined();
    for (const c of [{ smtpUrl: "https://user:hunter2@example.org", from: "x" }, { smtpUrl: "smtps://user:hunter2@smtp.example.org:465", from: "nobody" }]) {
      expect(emailConfigProblem(c)).not.toContain("hunter2");
      expect(() => emailChannel(c)).toThrow(/email is not configured/);
    }
  });

  it("reports a server that cannot be reached without quoting where it tried", async () => {
    const channel = emailChannel({ smtpUrl: "smtp://user:hunter2@127.0.0.1:1", from: "heir@example.org" });
    const error = await channel.send("owner@example.org", notice).then(() => undefined, (e: Error) => e);
    channel.close();
    expect(error?.message).toMatch(/the mail server did not take the message/);
    expect(error?.message).not.toMatch(/hunter2|127\.0\.0\.1/);
  });
});
