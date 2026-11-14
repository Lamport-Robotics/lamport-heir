#!/usr/bin/env node
/**
 * The reminder service, as a program to run on a server:
 *
 *   node src/reminders/cli.ts keys --out FILE           make the service's own keys, into a file only its user can read
 *   node src/reminders/cli.ts add <vault> --email A [--contact A]... [--push-file FILE] [--label NAME]
 *   node src/reminders/cli.ts remove <vault>
 *   node src/reminders/cli.ts list
 *   node src/reminders/cli.ts run [--interval SECONDS] [--once]
 *
 * It reads the chain and sends reminders. It holds no key that the vault or the claim program
 * listens to, so the worst it can do is stay silent or send a reminder too many.
 *
 * Everything it needs comes from the environment:
 *
 *   LAMPORT_HEIR_RPC                 a Solana RPC endpoint (default: devnet's public one)
 *   LAMPORT_HEIR_STORE               the file that holds subscriptions and what was sent, encrypted
 *   LAMPORT_HEIR_STORE_KEY           its key: 64 hex digits
 *   LAMPORT_HEIR_SMTP_URL            for email: smtps://user:password@host:465
 *   LAMPORT_HEIR_MAIL_FROM           for email: the sender's address
 *   LAMPORT_HEIR_PUSH_PUBLIC_KEY     for browser notifications: the service's own key pair
 *   LAMPORT_HEIR_PUSH_PRIVATE_KEY
 *   LAMPORT_HEIR_PUSH_CONTACT        for browser notifications: mailto: or https: address of whoever runs this
 *
 * A channel that is not configured is left out, and reminders for it wait in the outbox.
 * This file is not part of the single-file tool heirs download (scripts/bundle.mjs).
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { type Chain, COMMITMENT } from "../chain.ts";
import { emailChannel, emailConfigProblem, isEmailAddress } from "./email.ts";
import { FileStore, storeKey } from "./file-store.ts";
import { generatePushKeys, parsePushSubscription, pushChannel } from "./push.ts";
import { type Channel, type ChannelKind, type Recipient, ReminderService, type TickReport } from "./service.ts";

class UsageError extends Error {}

export interface Io {
  out: (line: string) => void;
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
  /** for tests: the chain to read instead of the endpoint in the environment */
  chain?: Chain;
}

function openStore(env: Io["env"]): FileStore {
  if (!env.LAMPORT_HEIR_STORE) throw new UsageError("LAMPORT_HEIR_STORE is not set: the file that holds the subscriptions");
  let key: Buffer;
  try { key = storeKey(env.LAMPORT_HEIR_STORE_KEY); } catch (e) { throw new UsageError(`LAMPORT_HEIR_STORE_KEY: ${(e as Error).message}`); }
  return FileStore.open(env.LAMPORT_HEIR_STORE, key);
}

/** The channels the environment configures, and a line about each one it does not. */
export function channelsFrom(env: Io["env"]): { channels: Partial<Record<ChannelKind, Channel>>; notes: string[]; close: () => void } {
  const channels: Partial<Record<ChannelKind, Channel>> = {};
  const notes: string[] = [];
  let close = () => {};
  const mail = { smtpUrl: env.LAMPORT_HEIR_SMTP_URL ?? "", from: env.LAMPORT_HEIR_MAIL_FROM ?? "" };
  const mailProblem = emailConfigProblem(mail);
  if (mailProblem) notes.push(`email is off: ${mailProblem}`);
  else { const c = emailChannel(mail); channels.email = c; close = () => c.close(); notes.push(`email is on, from ${mail.from}`); }
  if (env.LAMPORT_HEIR_PUSH_PUBLIC_KEY && env.LAMPORT_HEIR_PUSH_PRIVATE_KEY && env.LAMPORT_HEIR_PUSH_CONTACT) {
    channels.push = pushChannel({ publicKey: env.LAMPORT_HEIR_PUSH_PUBLIC_KEY, privateKey: env.LAMPORT_HEIR_PUSH_PRIVATE_KEY, subject: env.LAMPORT_HEIR_PUSH_CONTACT });
    notes.push("browser notifications are on");
  } else notes.push("browser notifications are off: the push key pair or the contact address is not set");
  return { channels, notes, close };
}

function reportLine(r: TickReport): string {
  const parts = [`${r.vaultsRead} vault(s) read`, `${r.queued} queued`, `${r.sent} sent`];
  if (r.failed.length) parts.push(`${r.failed.length} not delivered (${[...new Set(r.failed.map((f) => f.error))].join("; ")})`);
  if (r.expired) parts.push(`${r.expired} given up on`);
  if (r.unread.length) parts.push(`${r.unread.length} vault(s) unreadable (${r.unread.map((u) => `${u.vault}: ${u.error}`).join("; ")})`);
  return parts.join(", ");
}

function parse(argv: string[]): { command: string; positional: string[]; flags: Map<string, string[]> } {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [], flags = new Map<string, string[]>();
  const VALUE = new Set(["email", "contact", "push-file", "label", "out", "interval"]), BOOLEAN = new Set(["once", "help"]);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const name = arg.slice(2);
    if (BOOLEAN.has(name)) flags.set(name, []);
    else if (VALUE.has(name)) { const v = rest[++i]; if (v === undefined) throw new UsageError(`--${name} needs a value`); flags.set(name, [...(flags.get(name) ?? []), v]); }
    else throw new UsageError(`unknown option --${name}`);
  }
  return { command, positional, flags };
}

const HELP = `lamport-heir reminders: reads the chain, sends reminders, can move nothing

  keys --out FILE          make the store key and the notification key pair, into a file only you can read
  add <vault> --email ADDRESS [--contact ADDRESS]... [--push-file FILE] [--label NAME]
                           remind about a vault (replaces what was there for it)
  remove <vault>           stop
  list                     the vaults, and how many people each one reaches (no addresses)
  run [--interval SECONDS] [--once]

Configuration comes from the environment; the top of src/reminders/cli.ts lists it.`;

export async function main(argv: string[], io: Io): Promise<number> {
  const args = parse(argv);
  const one = (name: string) => args.flags.get(name)?.at(-1);
  switch (args.command) {
    case "help":
      io.out(HELP);
      return 0;
    case "keys": {
      const out = one("out");
      if (!out) throw new UsageError("keys needs --out FILE: the keys are written to a file, never shown");
      if (existsSync(out)) throw new UsageError(`${out} exists already. Keys are not overwritten: a store cannot be opened without the key it was made with`);
      const push = generatePushKeys();
      writeFileSync(out, [`LAMPORT_HEIR_STORE_KEY=${randomBytes(32).toString("hex")}`, `LAMPORT_HEIR_PUSH_PUBLIC_KEY=${push.publicKey}`, `LAMPORT_HEIR_PUSH_PRIVATE_KEY=${push.privateKey}`, ""].join("\n"), { mode: 0o600, flag: "wx" });
      io.out(`wrote ${out} (readable by you alone). It holds the store's key and the notification key pair. Keep a copy: without the store key the subscriptions cannot be read.`);
      io.out(`the page needs the public half: ${push.publicKey}`);
      return 0;
    }
    case "add": {
      let vault: string;
      try { vault = new PublicKey(args.positional[0] ?? "").toBase58(); } catch { throw new UsageError("add needs the vault's address"); }
      const emails = args.flags.get("email") ?? [], contacts = args.flags.get("contact") ?? [];
      for (const a of [...emails, ...contacts]) if (!isEmailAddress(a)) throw new UsageError(`not an email address: ${a}`);
      const owner: Recipient[] = emails.map((to) => ({ channel: "email", to }));
      const pushFile = one("push-file");
      if (pushFile) {
        let text: string;
        try { text = readFileSync(pushFile, "utf8"); } catch { throw new UsageError(`could not read ${pushFile}`); }
        try { owner.push({ channel: "push", to: JSON.stringify(parsePushSubscription(text)) }); } catch (e) { throw new UsageError((e as Error).message); }
      }
      if (owner.length === 0) throw new UsageError("add needs somewhere to reach the owner: --email or --push-file");
      const label = one("label");
      openStore(io.env).subscribe({ vault, ...(label ? { label } : {}), owner, contacts: contacts.map((to) => ({ channel: "email", to })) });
      io.out(`reminding about ${vault}: the owner on ${owner.length} channel(s), ${contacts.length} trusted contact(s)`);
      return 0;
    }
    case "remove": {
      let vault: string;
      try { vault = new PublicKey(args.positional[0] ?? "").toBase58(); } catch { throw new UsageError("remove needs the vault's address"); }
      openStore(io.env).unsubscribe(vault);
      io.out(`no longer reminding about ${vault}`);
      return 0;
    }
    case "list": {
      const subs = await openStore(io.env).subscriptions();
      if (subs.length === 0) io.out("no vaults");
      for (const s of subs) io.out(`${s.vault}  ${s.label ? `"${s.label}"  ` : ""}owner on ${s.owner.length} channel(s), ${s.contacts.length} contact(s)`);
      return 0;
    }
    case "run": {
      const interval = one("interval");
      const seconds = interval === undefined ? 600 : Number(interval);
      if (!Number.isFinite(seconds) || seconds < 1) throw new UsageError("--interval takes a number of seconds, 1 or more");
      const store = openStore(io.env);
      const chain: Chain = io.chain ?? new Connection(io.env.LAMPORT_HEIR_RPC ?? "https://api.devnet.solana.com", COMMITMENT);
      const { channels, notes, close } = channelsFrom(io.env);
      for (const n of notes) io.out(n);
      const service = new ReminderService(chain, store, channels);
      const once = async () => {
        try { io.out(`${new Date().toISOString()}  ${reportLine(await service.tick())}`); return true; }
        catch (e) { io.out(`${new Date().toISOString()}  this round failed: ${(e as Error).message}`); return false; }
      };
      try {
        if (args.flags.has("once")) return (await once()) ? 0 : 1;
        const signal = io.signal ?? new AbortController().signal;
        while (!signal.aborted) {
          await once();
          await new Promise<void>((resolve) => { const t = setTimeout(resolve, seconds * 1000); signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true }); });
        }
        return 0;
      } finally { close(); }
    }
    default:
      throw new UsageError(`unknown command: ${args.command}`);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const stop = new AbortController();
  process.on("SIGINT", () => stop.abort());
  process.on("SIGTERM", () => stop.abort());
  main(process.argv.slice(2), { out: (line) => console.log(line), env: process.env, signal: stop.signal }).then(
    (code) => process.exit(code),
    (e: unknown) => {
      if (e instanceof UsageError) { console.error(`${e.message}\n\n${HELP}`); process.exit(64); }
      console.error((e as Error).message);
      process.exit(1);
    },
  );
}
