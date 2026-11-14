/**
 * The pages, in a browser, from an empty wallet to an heir holding the vault's SOL.
 *
 * Everything under /heir/ is built as it is shipped (app/build.mjs), as a test build: for the
 * `short-clocks` programs, in which a day lasts a second, and pointed at the local validator. A
 * headless Chromium then does what an owner and an heir would do, by clicking:
 *
 *   owner   creates a vault; names an heir; pastes back the heir's acceptance; creates the plan;
 *           makes a check-in key in the browser; signs the plan on this device
 *   heir    opens the owner's link, signs the sentence, sends the line back
 *   signer  the offline signer shows the heir by name for the real request, refuses a forged one,
 *           and its signature for a changed plan is accepted by the chain
 *   owner   checks in with the browser's key
 *   heir    waits out the owner's silence, opens the waiting period, releases, collects
 *
 * What only a browser can show is tested here and nowhere else: that the bundler's aliases give
 * the pages the Heir program's id, message and encoder, and that the three pages work together.
 */
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RPC_URL } from "../../tools/e2e/validator.ts";

const appDir = fileURLToPath(new URL("../", import.meta.url));
const dist = join(appDir, "dist");
const connection = new Connection(RPC_URL, "confirmed");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".ttf": "font/ttf" };

let server: Server;
let browser: Browser;
let base = "";

/** the key a page keeps in sessionStorage for a local test wallet: its address, never its secret */
async function addressOf(page: Page, storageKey: string): Promise<PublicKey> {
  const bytes = await page.evaluate((k) => (JSON.parse(sessionStorage.getItem(k) ?? "[]") as number[]).slice(32), storageKey);
  return new PublicKey(Uint8Array.from(bytes));
}

async function airdrop(to: PublicKey, sol: number): Promise<void> {
  const signature = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction({ signature, ...(await connection.getLatestBlockhash()) });
}

/** presses the heirs' page's "Look it up" until `selector` shows: the chain's clock decides when */
async function lookUpUntil(page: Page, selector: string, seconds: number): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    await page.click("#sgo");
    try { await page.waitForSelector(selector, { timeout: 4_000 }); return; } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error(`${selector} did not appear within ${seconds} seconds; the page says: ${await page.locator("#spanel").innerText()}`);
  }
}

beforeAll(async () => {
  // the test build: the short-clocks programs, and the validator in place of devnet
  execFileSync(process.execPath, ["build.mjs"], { cwd: appDir, env: { ...process.env, HEIR_CLOCK: "short", HEIR_RPC: RPC_URL }, stdio: "inherit" });
  server = createServer((req, res) => {
    const path = normalize(decodeURIComponent((req.url ?? "/").split(/[?#]/)[0]!)).replace(/^(\.\.[/\\])+/, "");
    let file = join(dist, path);
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!file.startsWith(dist) || !existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  // the full browser in its headless mode, not the cut-down "headless shell": it is the one people use
  browser = await chromium.launch({ channel: "chromium" });
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

describe("the pages, in a browser, on a local validator", () => {
  it("an owner names an heir and signs the plan; the heir accepts, and after the owner's silence collects the vault", async () => {
    const context = await browser.newContext();
    context.setDefaultTimeout(180_000); // deriving a vault key takes a browser many seconds, more on a loaded machine
    const problems: string[] = [];
    const watch = (page: Page, who: string) => page.on("pageerror", (e) => problems.push(`${who}: ${e.message}`));

    // ── the owner: a wallet for fees, and a new vault ──
    const owner = await context.newPage(); watch(owner, "owner");
    await owner.goto(`${base}/heir/`);
    expect(await owner.title()).toBe("Lamport Heir");
    await owner.click("text=Connect wallet");
    await owner.click('.wrow:has-text("Local test key")');
    await owner.waitForSelector("#disc");
    const ownerWallet = await addressOf(owner, "lamport-vault-local-payer");
    await airdrop(ownerWallet, 5);

    await owner.click("#new");
    await owner.waitForSelector("#mk:not([disabled])");
    const words = await owner.$$eval("#newbox .words > div", (cells) => cells.map((c) => (c.lastChild?.textContent ?? "").trim()).join(" "));
    expect(words.split(" ")).toHaveLength(24);
    await owner.click("#mk");
    await owner.waitForFunction(() => location.hash.length > 30);
    const vault = new PublicKey((await owner.evaluate(() => location.hash.slice(1))));
    await owner.waitForSelector('.seg button[data-t="inheritance"]');
    await owner.click('.seg button[data-t="inheritance"]');
    await owner.waitForSelector("text=No plan. Nothing in this vault is released to anyone.");

    // ── the heir: their own wallet, on their own page ──
    const heir = await context.newPage(); watch(heir, "heir");
    await heir.goto(`${base}/heir/claim.html`);
    await heir.click("text=Connect wallet");
    await heir.click("#wlocal");
    await heir.waitForSelector("text=Disconnect");
    const heirWallet = await addressOf(heir, "lamport-heir-local-heir");
    await airdrop(heirWallet, 1);

    // ── the owner names the heir; nothing can be created before the heir accepts ──
    await owner.click('.switch button[data-m="hot"]');
    await owner.fill("#hfirst", heirWallet.toBase58());
    await owner.click("#hprep");
    await owner.waitForSelector("#hcreate");
    expect(await owner.inputValue("#pclaim")).toBe("");
    await owner.click("#hcreate");
    await owner.waitForSelector("#hout .err:not(.hidden)");
    expect(await owner.locator("#hout .err").innerText()).toMatch(/first heir has not accepted yet/);
    const link = (await owner.locator("#hout .notice .mono").innerText()).trim();
    expect(link).toContain("/heir/claim.html#accept=");

    // ── the heir accepts ──
    await heir.goto(link);
    await heir.waitForSelector("#asign");
    expect(await heir.locator(".panel").innerText()).toMatch(/You are the first heir/);
    expect(await heir.locator("dl.spec").innerText()).toContain(vault.toBase58());
    await heir.click("#asign");
    await heir.waitForSelector("#atext");
    const acceptance = await heir.inputValue("#atext");
    expect(JSON.parse(acceptance)).toMatchObject({ v: 1, heir: heirWallet.toBase58() });

    // ── the owner creates the plan, makes a check-in key, and signs ──
    await owner.fill("#hout textarea", `${acceptance.slice(0, -4)}AAA"}`); // a damaged line is refused, and nothing is paid for
    await owner.click("#hcreate");
    await owner.waitForSelector("#hout .err:not(.hidden)");
    await owner.fill("#hout textarea", acceptance);
    await owner.click("#hcreate");
    await owner.waitForSelector("#hout .ok");
    const plan = await owner.inputValue("#pclaim");
    expect(plan).toBe(JSON.parse(acceptance).plan);
    expect((await connection.getAccountInfo(new PublicKey(plan)))?.owner.toBase58()).toBe("HxMZSdKeFP2zJzhYUVNHefqEEz3B87EdTRjKwwPG6UhE");

    await owner.click("#hmakekey");
    await owner.click("#husekey");
    const checkinKey = await owner.inputValue("#pcheckin");
    expect(checkinKey.length).toBeGreaterThan(30);
    await owner.fill("#pwin", "90");
    await owner.fill("#pwait", "30");
    await owner.click("#pcheck");
    await owner.waitForSelector("#pout dl");
    const shown = await owner.locator("#pout dl").innerText();
    expect(shown).toMatch(/a Lamport Heir plan/);
    expect(shown).toContain(heirWallet.toBase58());
    expect(shown).toMatch(/TEST BUILD: one day lasts 1 second/);

    await owner.fill("#hwords", words);
    await owner.click("#hrun");
    await owner.click("#cf-yes");
    await owner.waitForSelector(".result");
    expect(await owner.locator(".result").innerText()).toMatch(/SetSuccession · key 0 spent/);
    await owner.waitForSelector("text=A plan is armed.");

    // ── the offline signer: who inherits, a forged request, and a signature the chain takes ──
    await owner.click('.switch button[data-m="cold"]');
    await owner.waitForSelector("#hout .ok"); // the heirs typed before come back, and their plan is found
    await owner.fill("#pwait", "45");
    await owner.click("#pcheck");
    await owner.waitForSelector("#pout dl");
    await owner.click("#mkreq");
    await owner.waitForFunction(() => (document.querySelector("#reqtxt") as HTMLTextAreaElement).value.length > 100);
    const request = await owner.inputValue("#reqtxt");
    expect(JSON.parse(request).action).toMatchObject({ kind: "SetSuccession", claim: plan });

    const signer = await context.newPage(); watch(signer, "signer");
    await signer.goto(`${base}/heir/signer.html`);
    expect(await signer.title()).toBe("Lamport Heir · cold signer");
    const forged = JSON.parse(request);
    forged.action.terms.primary.address = ownerWallet.toBase58(); // the heirs shown would be someone else's
    await signer.fill("#req", JSON.stringify(forged));
    await signer.waitForSelector("#reqview .err");
    expect(await signer.locator("#reqview .err").innerText()).toMatch(/give the plan address .* but the request releases to/);
    expect(await signer.locator("#reqview dl").count()).toBe(0);
    await signer.fill("#words", words);
    await signer.click("#sign");
    await signer.waitForSelector("#err:not(.hidden)");
    expect(await signer.locator("#err").innerText()).toMatch(/paste a valid request first/);

    await signer.fill("#req", request);
    await signer.waitForSelector("#reqview dl");
    const onSigner = await signer.locator("#reqview dl").innerText();
    expect(onSigner).toMatch(/set the inheritance plan of this vault/);
    expect(onSigner).not.toMatch(/close the vault/);
    expect(onSigner).toMatch(/a Lamport Heir plan/);
    expect(onSigner).toContain(heirWallet.toBase58());
    expect(onSigner).toMatch(/45 days\./);
    await signer.fill("#words", words);
    await signer.click("#sign");
    await signer.waitForSelector("#out:not(.hidden)");
    const signature = await signer.inputValue("#sig");
    expect(await signer.inputValue("#words")).toBe(""); // the words are gone from the page once used

    await owner.fill("#sigtxt", signature);
    await owner.click("#run");
    await owner.waitForSelector("text=/SetSuccession · key [1-9]\\d* spent/");
    await owner.waitForFunction(() => [...document.querySelectorAll(".seg + div dl.spec dd")].some((d) => d.textContent === "45 days"));

    // ── a check-in, with the key this browser made ──
    await owner.click("#hfund");
    await owner.click("#hcheckinnow");
    await owner.waitForFunction(() => { const dt = [...document.querySelectorAll(".seg + div dl.spec dt")].find((d) => d.textContent === "Last check-in"); return !!dt && dt.nextElementSibling?.textContent !== "none"; });

    // ── the owner goes quiet; something worth inheriting arrives in the vault ──
    await airdrop(vault, 2);
    const before = await connection.getBalance(heirWallet);
    await heir.goto(`${base}/heir/claim.html#${vault.toBase58()}`);
    await heir.waitForSelector("#spanel h3");
    expect(await heir.locator("#spanel").innerText()).toMatch(/You are the first heir of this vault's plan/);
    expect(await heir.locator("#sstart").count()).toBe(0); // within the owner's time there is nothing to press

    await lookUpUntil(heir, "#sstart", 240);
    await heir.click("#sstart");
    expect(await heir.locator("#spanel .notice.warn").innerText()).toMatch(/only if you believe the owner has died/);
    await heir.click("#sstartyes");
    await heir.waitForSelector("text=The waiting period is running.");

    await lookUpUntil(heir, "#scollect", 180);
    await heir.click("#scollect");
    await heir.waitForSelector("#sdone:not(.hidden)");
    expect(await heir.locator("#sdone").innerText()).toMatch(/Collected, as the first heir/);
    expect(await heir.locator("#ssteps").innerText()).toMatch(/Release the vault[\s\S]*Withdraw the SOL/);

    // the vault's 2 SOL, and its rent, are in the heir's wallet; the fees of claiming came out of it
    expect((await connection.getBalance(heirWallet)) - before).toBeGreaterThan(1.99 * LAMPORTS_PER_SOL);
    expect(problems).toEqual([]);
    await context.close();
  });
});
