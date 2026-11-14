/**
 * The owner's form for choosing heirs (app/src/composer.ts), driven through a DOM just big enough
 * for it, with the chain mocked: what ordinary sequences of typing, ticking, reloading and losing
 * stored data do. The harness and most of these sequences come from an independent review of the
 * private-heir flow; each "must not" below is something that review made happen.
 *
 * Every key here is generated for the test.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { Keypair, PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const chain = vi.hoisted(() => ({ accounts: new Map<string, unknown>(), asked: [] as string[], gate: null as Promise<void> | null }));
vi.mock("../../vendor/lamport-vault/web/src/rpc.ts", () => ({
  rpc: { getAccountInfo: async (a: { toBase58(): string }) => { chain.asked.push(a.toBase58()); if (chain.gate) await chain.gate; return chain.accounts.get(a.toBase58()) ?? null; } },
}));

import { encodeTerms, hashedHeir, PLAN_ACCOUNT_SIZE, PLAN_DISCRIMINATOR, planAddress, termsHash, type Terms } from "../../tools/src/claim.ts";
import { acceptanceBytes, writeAcceptance } from "../src/acceptance.ts";
import { readAcceptLink } from "../src/accept-link.ts";
import { claimComposer } from "../src/composer.ts";
import { keptSalt } from "../src/salts.ts";
import { buildPrograms } from "../src/terms.ts";

// ── a DOM just big enough for composer.ts ──
type Kid = FakeEl | string;
class FakeEl {
  tagName: string; attrs = new Map<string, string>(); kids: Kid[] = []; parent: FakeEl | null = null;
  className = ""; readOnly = false; placeholder = "";
  private v: string | undefined; private c = false; private ls = new Map<string, ((e: unknown) => unknown)[]>();
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  setAttribute(k: string, v: string) { this.attrs.set(k, v); }
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  removeAttribute(k: string) { this.attrs.delete(k); }
  get id() { return this.attrs.get("id") ?? ""; }
  get value(): string { if (this.v !== undefined) return this.v; if (this.tagName === "SELECT") { const o = this.kids.find((k) => typeof k !== "string") as FakeEl | undefined; return o?.attrs.get("value") ?? ""; } return this.attrs.get("value") ?? ""; }
  set value(x: string) { this.v = String(x); }
  get checked() { return this.c; } set checked(x: boolean) { this.c = !!x; }
  append(...kids: Kid[]) { for (const k of kids) { if (typeof k !== "string") k.parent = this; this.kids.push(k); } }
  set innerHTML(x: string) { if (x !== "") throw new Error("fake DOM: only clearing"); for (const k of this.kids) if (typeof k !== "string") k.parent = null; this.kids = []; }
  get textContent(): string { return this.kids.map((k) => (typeof k === "string" ? k : k.textContent)).join(""); }
  set textContent(x: string) { this.innerHTML = ""; this.kids = [x]; }
  get classList() {
    const set = () => new Set(this.className.split(/\s+/).filter(Boolean)); const put = (s: Set<string>) => { this.className = [...s].join(" "); };
    return { add: (n: string) => { const s = set(); s.add(n); put(s); }, remove: (n: string) => { const s = set(); s.delete(n); put(s); }, contains: (n: string) => set().has(n),
      toggle: (n: string, force?: boolean) => { const s = set(); const on = force ?? !s.has(n); if (on) s.add(n); else s.delete(n); put(s); return on; } };
  }
  addEventListener(type: string, fn: (e: unknown) => unknown) { this.ls.set(type, [...(this.ls.get(type) ?? []), fn]); }
  fire(type: string) { const e = { type, target: this as FakeEl, currentTarget: this as FakeEl }; for (let n: FakeEl | null = this; n; n = n.parent) for (const fn of n.ls.get(type) ?? []) { e.currentTarget = n; void fn(e); } }
  click() { if (this.attrs.has("disabled")) return; this.fire("click"); }
  all(): FakeEl[] { return this.kids.flatMap((k) => (typeof k === "string" ? [] : [k, ...k.all()])); }
  querySelector(sel: string): FakeEl | null {
    const id = /^#([\w-]+)$/.exec(sel); if (id) return this.all().find((n) => n.id === id[1]) ?? null;
    const at = /^\[([\w-]+)="([^"]*)"\]$/.exec(sel); if (at) return this.all().find((n) => n.attrs.get(at[1]!) === at[2]) ?? null;
    throw new Error(`fake DOM: selector ${sel}`);
  }
  closest(sel: string): FakeEl | null { const id = /^#([\w-]+)$/.exec(sel)![1]; for (let n: FakeEl | null = this; n; n = n.parent) if (n.id === id) return n; return null; }
}
class Mem { m = new Map<string, string>(); getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; } setItem(k: string, v: string) { this.m.set(k, String(v)); } removeItem(k: string) { this.m.delete(k); } clear() { this.m.clear(); } }

const programs = buildPrograms();
const DAY = programs.daySecs;
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
let local: Mem, session: Mem;

beforeEach(() => {
  local = new Mem(); session = new Mem();
  chain.accounts.clear(); chain.asked.length = 0; chain.gate = null;
  vi.stubGlobal("document", { createElement: (t: string) => new FakeEl(t) });
  vi.stubGlobal("localStorage", local);
  vi.stubGlobal("sessionStorage", session);
  vi.stubGlobal("location", { origin: "https://vault.example", hostname: "vault.example" });
});

/** the vault page's plan form, as far as the composer touches it */
function mount(vault: PublicKey, opts: { wallet?: { pubkey: PublicKey; sent: unknown[][]; gate?: Promise<void> }; armedTo?: PublicKey } = {}) {
  const state = { claim: "", terms: undefined as unknown, sets: [] as string[] };
  const wallet = opts.wallet ? { name: "t", pubkey: opts.wallet.pubkey, send: async (ixs: unknown[]) => { opts.wallet!.sent.push(ixs); if (opts.wallet!.gate) await opts.wallet!.gate; return "sig"; }, disconnect: async () => {} } : null;
  const ctx = { vault: { succession: opts.armedTo ? { claim: opts.armedTo } : { claim: PublicKey.default } }, address: vault, lamports: 0, tokens: [], wallet, reload: async () => {} };
  const pclaim = new FakeEl("input"); pclaim.setAttribute("id", "pclaim");
  const node = claimComposer(ctx as never, (a, t) => { state.claim = a; state.terms = t; state.sets.push(a); pclaim.value = a; }) as unknown as FakeEl;
  const pfields = new FakeEl("div"); pfields.setAttribute("id", "pfields"); pfields.append(node, pclaim);
  const $ = (sel: string) => pfields.querySelector(sel)!;
  const type = (id: string, text: string) => { const f = $(id); f.value = text; f.fire("input"); };
  const tick = (id: string, on: boolean) => { const f = $(id); f.checked = on; f.fire("input"); };
  const out = () => $("#hout");
  const has = (sel: string) => pfields.querySelector(sel) !== null;
  /** types the salt's check digits into every slip shown and presses the button */
  const writeDown = () => { for (const who of ["first", "second"]) { const t = pfields.querySelector(`[data-salt-text="${who}"]`); if (t) $(`[data-slip="${who}"]`).value = t.textContent.replace(/\s/g, "").slice(65); } $("#hslipgo").click(); };
  return { state, $, type, tick, out, has, writeDown, pfields };
}

function planAccount(terms: Terms) {
  const data = Buffer.alloc(PLAN_ACCOUNT_SIZE);
  data.set(PLAN_DISCRIMINATOR, 0); data[8] = 1; data[9] = 255; data.set(termsHash(terms), 10); data.set(encodeTerms(terms), 42);
  return { owner: programs.claim, data, executable: false, lamports: 1 };
}
const accept = (heir: Keypair, plan: PublicKey) => { const signed = acceptanceBytes(plan); return writeAcceptance(plan, heir.publicKey, signed, ed25519.sign(signed, heir.secretKey.subarray(0, 32))); };

const linkOf = (page: ReturnType<typeof mount>, who: string) => readAcceptLink(page.$(`[data-link="${who}"]`).textContent.split("#accept=")[1]!);

describe("heirs named by address", () => {
  it("go as they always did: one link, both proofs on chain, nothing stored; an heir who pays is not asked", async () => {
    const vault = Keypair.generate().publicKey, a = Keypair.generate(), b = Keypair.generate();
    const payer = { pubkey: a.publicKey, sent: [] as unknown[][] };
    const other = { pubkey: Keypair.generate().publicKey, sent: [] as unknown[][] };
    for (const wallet of [other, payer]) {
      local.clear(); session.clear(); chain.asked.length = 0;
      const page = mount(vault, { wallet });
      await settle();
      page.type("#hfirst", a.publicKey.toBase58()); page.type("#hsecond", b.publicKey.toBase58()); page.type("#hdelay", "40");
      page.$("#hprep").click(); await settle();
      expect(chain.asked.slice(0, 2)).toEqual([a.publicKey.toBase58(), b.publicKey.toBase58()]);
      expect(local.m.size).toBe(0);
      const waiting = page.pfields.all().filter((n) => n.attrs.has("data-heir")).map((n) => n.attrs.get("data-heir"));
      expect(waiting).toEqual(wallet === payer ? [b.publicKey.toBase58()] : [a.publicKey.toBase58(), b.publicKey.toBase58()]);
      const links = page.pfields.all().filter((n) => n.attrs.has("data-link")).map((n) => n.textContent);
      expect(new Set(links).size).toBe(1);
      const { terms, salt } = readAcceptLink(links[0]!.split("#accept=")[1]!);
      expect(salt).toBeUndefined();
      expect(terms.contingentDelaySecs).toBe(40n * DAY);
      const plan = planAddress(terms, programs.claim);
      for (const k of [a, b]) { const box = page.pfields.querySelector(`[data-heir="${k.publicKey.toBase58()}"]`); if (box) box.value = accept(k, plan); }
      page.$("#hcreate").click(); await settle();
      expect(wallet.sent[0]).toHaveLength(wallet === payer ? 2 : 3);
      expect(page.state.claim).toBe(plan.toBase58());
    }
  });

  it("a plan that is on the chain already is used as it is: its heirs' proofs are there", async () => {
    const vault = Keypair.generate().publicKey, a = Keypair.generate().publicKey;
    const terms: Terms = { vault, primary: { kind: "address", address: a }, contingent: { kind: "none" }, contingentDelaySecs: 0n };
    chain.accounts.set(planAddress(terms, programs.claim).toBase58(), planAccount(terms));
    const page = mount(vault); await settle();
    page.type("#hfirst", a.toBase58());
    page.$("#hprep").click(); await settle();
    expect(page.out().textContent).toMatch(/This plan exists/);
    expect(page.state.claim).toBe(planAddress(terms, programs.claim).toBase58());
  });

  it("the all-zero address, which nobody holds, is refused before anything is asked", async () => {
    const page = mount(Keypair.generate().publicKey); await settle();
    page.type("#hfirst", PublicKey.default.toBase58()); page.tick("#hfirstpriv", true);
    page.$("#hprep").click(); await settle();
    expect(page.out().textContent).toMatch(/all-zero address, which nobody holds/);
    expect(chain.asked).toEqual([]);
  });

  it("fields the tab remembers do not mix with the heirs of the plan the vault releases to", async () => {
    const vault = Keypair.generate().publicKey, a = Keypair.generate().publicKey, x = Keypair.generate().publicKey;
    const terms: Terms = { vault, primary: { kind: "address", address: a }, contingent: { kind: "none" }, contingentDelaySecs: 0n };
    const plan = planAddress(terms, programs.claim);
    chain.accounts.set(plan.toBase58(), planAccount(terms));
    const page = mount(vault, { armedTo: plan }); await settle();
    expect(page.$("#hfirst").value).toBe(a.toBase58());
    page.type("#hfirst", ""); page.type("#hsecond", x.toBase58()); page.tick("#hsecondpriv", true); // the owner starts over, second heir first
    const again = mount(vault, { armedTo: plan }); await settle();                               // any rebuild
    // the plan on the screen has no second heir, and neither do the fields beside it
    expect([again.$("#hfirst").value, again.$("#hsecond").value, again.$("#hsecondpriv").checked]).toEqual([a.toBase58(), "", false]);
    expect(again.state.claim).toBe(plan.toBase58());
  });
});

describe("an heir kept private", () => {
  it("nothing reaches the form or the chain before the salt's check digits; a wrong answer stops; their proof and their address go nowhere", async () => {
    const vault = Keypair.generate().publicKey, a = Keypair.generate(), b = Keypair.generate();
    const payer = { pubkey: Keypair.generate().publicKey, sent: [] as unknown[][] };
    const page = mount(vault, { wallet: payer });
    await settle();
    page.type("#hfirst", a.publicKey.toBase58()); page.type("#hsecond", b.publicKey.toBase58()); page.tick("#hsecondpriv", true);
    page.$("#hprep").click(); await settle();
    expect(chain.asked).toEqual([a.publicKey.toBase58()]);   // the private heir's address is not looked up, nor the plan's yet
    expect(page.has("#hcreate")).toBe(false);
    expect(page.out().textContent).toMatch(/This salt was made just now/);
    expect(page.out().textContent).toMatch(/a convenience and not a safeguard: a private window loses it when it closes/);
    page.$('[data-slip="second"]').value = "zzzz"; page.$("#hslipgo").click(); await settle();
    expect(page.has("#hcreate")).toBe(false);
    expect(keptSalt(vault, b.publicKey)!.written).toBe(false);
    page.writeDown(); await settle();
    expect(keptSalt(vault, b.publicKey)!.written).toBe(true);
    const mine = linkOf(page, "second"), theirs = linkOf(page, "first");
    expect(theirs.salt).toBeUndefined();
    expect(Buffer.from(mine.salt!).equals(Buffer.from(keptSalt(vault, b.publicKey)!.salt))).toBe(true);
    expect(mine.terms.contingent).toEqual(hashedHeir(mine.salt!, b.publicKey));
    const plan = planAddress(mine.terms, programs.claim);
    page.$(`[data-heir="${a.publicKey.toBase58()}"]`).value = accept(a, plan);
    page.$(`[data-heir="${b.publicKey.toBase58()}"]`).value = accept(a, plan).replace(a.publicKey.toBase58(), b.publicKey.toBase58()); // a's signature under b's name
    page.$("#hcreate").click(); await settle();
    expect(payer.sent).toHaveLength(0);
    page.$(`[data-heir="${b.publicKey.toBase58()}"]`).value = accept(b, plan);
    page.$("#hcreate").click(); await settle();
    const wire = Buffer.concat((payer.sent[0] as { data: Uint8Array; keys: { pubkey: PublicKey }[] }[]).flatMap((ix) => [Buffer.from(ix.data), ...ix.keys.map((k) => k.pubkey.toBuffer())]));
    expect(wire.includes(a.publicKey.toBuffer())).toBe(true);
    expect(wire.includes(b.publicKey.toBuffer())).toBe(false);
    expect(JSON.stringify(page.state.terms)).not.toContain(b.publicKey.toBase58());
    expect(chain.asked).not.toContain(b.publicKey.toBase58());
    expect(page.state.claim).toBe(plan.toBase58());
    expect(keptSalt(vault, b.publicKey)!.acceptedFor).toBe(plan.toBase58());
    // the salt and the fingerprint stay on the screen beside the plan, to compare with the signer
    expect(page.$('[data-private="second"]').textContent).toMatch(/Fingerprint/);
  });

  it("two of them: both slips are answered before either counts; each link carries its own salt; neither address goes anywhere", async () => {
    const vault = Keypair.generate().publicKey, a = Keypair.generate(), b = Keypair.generate();
    const payer = { pubkey: Keypair.generate().publicKey, sent: [] as unknown[][] };
    const page = mount(vault, { wallet: payer }); await settle();
    page.type("#hfirst", a.publicKey.toBase58()); page.tick("#hfirstpriv", true); page.type("#hsecond", b.publicKey.toBase58()); page.tick("#hsecondpriv", true);
    page.$("#hprep").click(); await settle();
    page.$('[data-slip="first"]').value = page.$('[data-salt-text="first"]').textContent.replace(/\s/g, "").slice(65);
    page.$("#hslipgo").click(); await settle();
    expect(page.has("#hcreate")).toBe(false);
    expect(keptSalt(vault, a.publicKey)!.written).toBe(false);
    page.writeDown(); await settle();
    const la = linkOf(page, "first"), lb = linkOf(page, "second");
    expect(Buffer.from(la.salt!).equals(Buffer.from(lb.salt!))).toBe(false);
    expect(la.terms.primary).toEqual(hashedHeir(la.salt!, a.publicKey));
    expect(lb.terms.contingent).toEqual(hashedHeir(lb.salt!, b.publicKey));
    const plan = planAddress(la.terms, programs.claim);
    page.$(`[data-heir="${a.publicKey.toBase58()}"]`).value = accept(a, plan); page.$(`[data-heir="${b.publicKey.toBase58()}"]`).value = accept(b, plan);
    page.$("#hcreate").click(); await settle();
    expect(payer.sent[0]).toHaveLength(1);
    expect(chain.asked).toEqual([plan.toBase58()]);
    expect(page.state.claim).toBe(plan.toBase58());
  });

  it("who is also the wallet that pays still gets their link and accepts: that link is how the salt reaches them", async () => {
    const vault = Keypair.generate().publicKey, me = Keypair.generate();
    const payer = { pubkey: me.publicKey, sent: [] as unknown[][] };
    const page = mount(vault, { wallet: payer }); await settle();
    page.type("#hfirst", me.publicKey.toBase58()); page.tick("#hfirstpriv", true);
    page.$("#hprep").click(); await settle();
    page.writeDown(); await settle();
    expect(page.has('[data-link="first"]')).toBe(true);
    expect(linkOf(page, "first").salt).toHaveLength(32);
    page.$("#hcreate").click(); await settle();
    expect(payer.sent).toHaveLength(0);
    expect(page.out().textContent).toMatch(/first heir has not accepted yet/);
  });

  it("a plan somebody else put on the chain is not taken on trust: the private heir still gets their link and accepts", async () => {
    const vault = Keypair.generate().publicKey, heir = Keypair.generate();
    const payer = { pubkey: Keypair.generate().publicKey, sent: [] as unknown[][] };
    const page = mount(vault, { wallet: payer }); await settle();
    page.type("#hfirst", heir.publicKey.toBase58()); page.tick("#hfirstpriv", true);
    page.$("#hprep").click(); await settle();
    page.writeDown(); await settle();
    const { terms } = linkOf(page, "first");
    const plan = planAddress(terms, programs.claim);
    // init_plan asks nothing of a fingerprint and takes any payer: whoever has the terms can create the account
    chain.accounts.set(plan.toBase58(), planAccount(terms));
    page.$("#hprep").click(); await settle();
    expect(page.state.claim).toBe("");
    expect(page.out().textContent).toMatch(/This plan is on the chain already.*that heir still accepts here/);
    expect(page.has('[data-link="first"]')).toBe(true);
    page.$("#hcreate").click(); await settle();
    expect(page.state.claim).toBe("");
    page.$(`[data-heir="${heir.publicKey.toBase58()}"]`).value = accept(heir, plan);
    page.$("#hcreate").click(); await settle();
    expect(page.state.claim).toBe(plan.toBase58());
    expect(payer.sent).toHaveLength(0); // nothing to create
    // accepted once, for this plan: the next time the plan is simply found
    page.$("#hprep").click(); await settle();
    expect(page.out().textContent).toMatch(/This plan exists/);
    expect(page.state.claim).toBe(plan.toBase58());
  });

  it("the box ticked while an earlier Prepare is still asking the chain: that Prepare is dropped, and nothing names the address openly", async () => {
    const vault = Keypair.generate().publicKey, heir = Keypair.generate();
    const payer = { pubkey: Keypair.generate().publicKey, sent: [] as unknown[][] };
    const page = mount(vault, { wallet: payer }); await settle();
    page.type("#hfirst", heir.publicKey.toBase58());
    let open!: () => void; chain.gate = new Promise<void>((r) => { open = r; });
    page.$("#hprep").click(); await settle();              // in flight: the endpoint is being asked about the address
    expect(chain.asked).toContain(heir.publicKey.toBase58());
    page.tick("#hfirstpriv", true);                         // the owner decides to keep the heir private
    open(); chain.gate = null; await settle();
    expect(page.has('[data-link="first"]')).toBe(false);
    expect(page.has("#hcreate")).toBe(false);
    expect(page.state.claim).toBe("");
    expect(page.$("#hprep").attrs.has("disabled")).toBe(false);
    // pressed again, it is a private heir's plan, and the owner is told what the endpoint already saw
    page.$("#hprep").click(); await settle();
    expect(page.has('[data-salt="first"]')).toBe(true);
    expect(page.out().textContent).toMatch(/This page asked the network about this address a moment ago, while the box was clear/);
    expect(chain.asked.filter((x) => x === heir.publicKey.toBase58())).toHaveLength(1);
  });

  it("an address typed and then any rebuild of the form: the network is asked nothing about it, and no salt is made", async () => {
    const vault = Keypair.generate().publicKey, heir = Keypair.generate().publicKey;
    const before = mount(vault); await settle();
    before.type("#hfirst", heir.toBase58());                // typed, nothing pressed
    const after = mount(vault); await settle();             // what the page does on a mode switch: a new form
    expect(after.$("#hfirst").value).toBe(heir.toBase58());
    expect(chain.asked).not.toContain(heir.toBase58());
    after.tick("#hfirstpriv", true);
    const again = mount(vault); await settle();             // and again, with the box ticked and nothing pressed
    expect(again.$("#hfirstpriv").checked).toBe(true);
    expect(keptSalt(vault, heir)).toBeNull();
    expect(local.m.size).toBe(0);
    expect(chain.asked).not.toContain(heir.toBase58());
  });

  it("whose salt left the browser: no rebuild makes another by itself, and the owner is told which salt a new press would make", async () => {
    const vault = Keypair.generate().publicKey, heir = Keypair.generate();
    const page = mount(vault); await settle();
    page.type("#hfirst", heir.publicKey.toBase58()); page.tick("#hfirstpriv", true);
    page.$("#hprep").click(); await settle();
    page.writeDown(); await settle();
    const first = linkOf(page, "first");
    local.clear();                                           // site data cleared, a private window's tab restored, eviction
    const again = mount(vault); await settle();              // no press by the owner
    expect(again.has('[data-salt="first"]')).toBe(false);
    expect(keptSalt(vault, heir.publicKey)).toBeNull();
    expect(again.out().textContent).toMatch(/this browser no longer holds their salt.*makes a new salt, which is a new plan/);
    expect(again.state.claim).toBe("");
    // the owner's own press makes one, and the slip says it is new
    again.$("#hprep").click(); await settle();
    expect(again.out().textContent).toMatch(/This salt was made just now: no earlier paper or link has it/);
    expect(Buffer.from(keptSalt(vault, heir.publicKey)!.salt).equals(Buffer.from(first.salt!))).toBe(false);
  });

  it("whose salt leaves the browser while the page waits for their acceptance: nothing is created and nothing is handed to the form", async () => {
    const vault = Keypair.generate().publicKey, heir = Keypair.generate();
    const payer = { pubkey: Keypair.generate().publicKey, sent: [] as unknown[][] };
    const page = mount(vault, { wallet: payer }); await settle();
    page.type("#hfirst", heir.publicKey.toBase58()); page.tick("#hfirstpriv", true);
    page.$("#hprep").click(); await settle();
    page.writeDown(); await settle();
    const plan = planAddress(linkOf(page, "first").terms, programs.claim);
    local.clear();                                           // the heir takes a day to answer; the browser's copy goes
    page.$(`[data-heir="${heir.publicKey.toBase58()}"]`).value = accept(heir, plan);
    page.$("#hcreate").click(); await settle();
    expect(payer.sent).toHaveLength(0);
    expect(page.state.claim).toBe("");
    expect(page.pfields.textContent).toMatch(/This browser no longer holds the salt of the first heir/);
  });

  it("whose salt leaves the browser while the slip is on the screen: \"written down\" is not taken for a salt that is nowhere", async () => {
    const vault = Keypair.generate().publicKey, heir = Keypair.generate().publicKey;
    const page = mount(vault); await settle();
    page.type("#hfirst", heir.toBase58()); page.tick("#hfirstpriv", true);
    page.$("#hprep").click(); await settle();
    const shown = page.$('[data-salt-text="first"]').textContent.replace(/\s/g, "").slice(0, 64);
    const terms: Terms = { vault, primary: hashedHeir(Uint8Array.from(Buffer.from(shown, "hex")), heir), contingent: { kind: "none" }, contingentDelaySecs: 0n };
    chain.accounts.set(planAddress(terms, programs.claim).toBase58(), planAccount(terms)); // even with the plan's account already there
    local.clear();
    page.writeDown(); await settle();
    expect(page.out().textContent).toMatch(/This browser no longer holds the salt of the first heir/);
    expect(page.state.claim).toBe("");
    expect(page.has("#hcreate")).toBe(false);
  });

  it("whose salt leaves the browser while the page is asking the chain for their plan: the plan it finds is not handed to the form", async () => {
    const vault = Keypair.generate().publicKey, heir = Keypair.generate();
    const page = mount(vault); await settle();
    page.type("#hfirst", heir.publicKey.toBase58()); page.tick("#hfirstpriv", true);
    page.$("#hprep").click(); await settle();
    page.writeDown(); await settle();
    const { terms } = linkOf(page, "first");
    const plan = planAddress(terms, programs.claim);
    chain.accounts.set(plan.toBase58(), planAccount(terms));
    page.$("#hprep").click(); await settle();
    page.$(`[data-heir="${heir.publicKey.toBase58()}"]`).value = accept(heir, plan);
    page.$("#hcreate").click(); await settle();              // accepted, for this plan
    expect(page.state.claim).toBe(plan.toBase58());
    // prepared once more, and this time the browser's copy goes while the chain is being asked
    let open!: () => void; chain.gate = new Promise<void>((r) => { open = r; });
    page.$("#hprep").click(); await settle();
    expect(page.state.claim).toBe("");
    local.clear();
    open(); chain.gate = null; await settle();
    expect(page.state.claim).toBe("");
    expect(page.out().textContent).toMatch(/This browser no longer holds the salt of the first heir/);
  });

  it("is shown their salt and fingerprint again for a later plan: the paper from an abandoned one may be gone", async () => {
    const vault = Keypair.generate().publicKey, heir = Keypair.generate().publicKey, other = Keypair.generate().publicKey;
    const page = mount(vault); await settle();
    page.type("#hfirst", heir.toBase58()); page.tick("#hfirstpriv", true);
    page.$("#hprep").click(); await settle();
    const salt = page.$('[data-salt-text="first"]').textContent;
    page.writeDown(); await settle();
    session.clear();
    const later = mount(vault); await settle();             // another day, other terms: a second heir is added
    later.type("#hfirst", heir.toBase58()); later.tick("#hfirstpriv", true); later.type("#hsecond", other.toBase58());
    later.$("#hprep").click(); await settle();
    expect(later.has('[data-salt="first"]')).toBe(false);   // written down already: no gate
    expect(later.has("#hcreate")).toBe(true);
    expect(later.$('[data-private="first"]').textContent).toContain(salt);
    expect(later.$('[data-private="first"]').textContent).toMatch(/Fingerprint/);
  });

  it("who is named openly by the vault's current plan: the owner is told that this stays public", async () => {
    const vault = Keypair.generate().publicKey, a = Keypair.generate().publicKey;
    const terms: Terms = { vault, primary: { kind: "address", address: a }, contingent: { kind: "none" }, contingentDelaySecs: 0n };
    const plan = planAddress(terms, programs.claim);
    chain.accounts.set(plan.toBase58(), planAccount(terms));
    const page = mount(vault, { armedTo: plan }); await settle();
    expect(page.$("#hfirst").value).toBe(a.toBase58());
    page.tick("#hfirstpriv", true);
    page.$("#hprep").click(); await settle();
    expect(page.$('[data-salt="first"]').textContent).toMatch(/current plan names this address openly, and that plan stays on the chain/);
  });

  it("in a vault armed to their plan: shown again only with this browser's salt, and nothing is asked of the chain about anyone", async () => {
    const vault = Keypair.generate().publicKey, a = Keypair.generate().publicKey, b = Keypair.generate().publicKey;
    const made = mount(vault); await settle();
    made.type("#hfirst", a.toBase58()); made.type("#hsecond", b.toBase58()); made.tick("#hsecondpriv", true);
    made.$("#hprep").click(); await settle(); made.writeDown(); await settle();
    const { terms } = linkOf(made, "second");
    const plan = planAddress(terms, programs.claim);
    chain.accounts.set(plan.toBase58(), planAccount(terms));
    session.clear(); chain.asked.length = 0;
    const here = mount(vault, { armedTo: plan }); await settle();
    expect(here.$("#hfirst").value).toBe(a.toBase58());
    expect(here.$("#hsecond").value).toBe(b.toBase58());
    expect([here.$("#hfirstpriv").checked, here.$("#hsecondpriv").checked]).toEqual([false, true]);
    expect(here.state.claim).toBe(plan.toBase58());
    expect(JSON.stringify(here.state.terms)).not.toContain(b.toBase58());
    expect(chain.asked).toEqual([plan.toBase58()]);
    local.clear(); // another browser
    const elsewhere = mount(vault, { armedTo: plan }); await settle();
    expect(elsewhere.out().textContent).toMatch(/this browser does not hold their salt/);
    expect([elsewhere.$("#hfirst").value, elsewhere.$("#hsecond").value, elsewhere.state.claim]).toEqual(["", "", ""]);
  });

  it("heirs changed while the wallet is asked to pay: the plan that was paid for is not handed to the form", async () => {
    const vault = Keypair.generate().publicKey, a = Keypair.generate();
    let open!: () => void;
    const payer = { pubkey: Keypair.generate().publicKey, sent: [] as unknown[][], gate: new Promise<void>((r) => { open = r; }) };
    const page = mount(vault, { wallet: payer }); await settle();
    page.type("#hfirst", a.publicKey.toBase58());
    page.$("#hprep").click(); await settle();
    const plan = planAddress(linkOf(page, "first").terms, programs.claim);
    page.$(`[data-heir="${a.publicKey.toBase58()}"]`).value = accept(a, plan);
    page.$("#hcreate").click(); await settle();              // the wallet's prompt is open
    expect(payer.sent).toHaveLength(1);
    page.type("#hsecond", Keypair.generate().publicKey.toBase58()); // the owner adds a second heir meanwhile
    open(); await settle();
    expect(page.state.claim).toBe("");
    expect(page.has("#hcreate")).toBe(false);
  });
});
