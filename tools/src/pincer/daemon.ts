/**
 * The part of Pincer1's daemon the Heir link talks to. Three calls, all of them routes the daemon
 * already has and serves only to callers on the robot itself:
 *
 *   GET  /inheritance           what the robot's switch reports
 *   POST /inheritance/arm       ask the robot to arm it; the owner confirms with a three-second hold
 *   POST /offline/nonce/create  have the robot make the durable-nonce account the switch needs
 *
 * There is no call here that clears the switch or releases it, and none is to be added: the
 * timer, the signed transaction and the decision to release stay on the robot's controller.
 * Nothing in Pincer1 is changed for this.
 */

/** What the robot says about its switch. */
export interface RobotSwitch {
  armed: boolean;
  inactivityDays: number;
  daysSinceTouch: number;
  heir: string | null;
}

export interface ArmBody {
  heir: string;
  inactivityDays: number;
  warnDays: number[];
  mints: string[];
  nonceAccount: string;
  /** lamports to pass on; left out, the robot passes on its balance less 0.01 SOL */
  solLamports?: string;
}

export type ArmOutcome = { ok: true; summary: string } | { ok: false; reason: string };

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; json(): Promise<unknown> }>;

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

export class RobotDaemon {
  private readonly base: string;
  private readonly fetchImpl: Fetch;

  /**
   * `base` must be a loopback address: the daemon serves these routes to its own machine only, and
   * this link is meant to run there, next to it.
   */
  constructor(base = "http://127.0.0.1:7401", fetchImpl: Fetch = fetch as unknown as Fetch) {
    const trimmed = base.replace(/\/+$/, "");
    if (!LOOPBACK.test(trimmed)) throw new Error(`the Pincer1 link talks to the daemon on the robot itself (http://127.0.0.1:7401), not to ${base}`);
    this.base = trimmed;
    this.fetchImpl = fetchImpl;
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await this.fetchImpl(`${this.base}${path}`, { method, ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
    const parsed = (await res.json().catch(() => ({}))) as unknown;
    return { status: res.status, body: typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {} };
  }

  /** What the robot reports about its switch, as it reports it. */
  async switchStatus(): Promise<RobotSwitch> {
    const { status, body } = await this.call("GET", "/inheritance");
    if (status !== 200) throw new Error(`the robot did not report its switch (HTTP ${status})`);
    return { armed: body.armed === true, inactivityDays: Number(body.inactivity_days ?? 0), daysSinceTouch: Number(body.days_since_touch ?? 0), heir: typeof body.heir === "string" ? body.heir : null };
  }

  /** Asks the robot to arm its switch. The robot says what it will do and waits for the owner's hold. */
  async arm(req: ArmBody): Promise<ArmOutcome> {
    const { status, body } = await this.call("POST", "/inheritance/arm", req);
    if (status === 200 && body.ok === true) return { ok: true, summary: String(body.summary ?? "") };
    // The robot's answer is passed on as it is. The link does not interpret a refusal.
    return { ok: false, reason: String(body.reason ?? body.error ?? `HTTP ${status}`) };
  }

  /**
   * Has the robot create a durable-nonce account whose authority is the robot's wallet. The daemon
   * offers this only while its `offlinePayments` setting is on; otherwise this throws and says so.
   */
  async createNonceAccount(): Promise<string> {
    const { status, body } = await this.call("POST", "/offline/nonce/create");
    if (status === 200 && typeof body.nonceAccount === "string") return body.nonceAccount;
    if (body.error === "offline_payments_disabled") {
      throw new Error("the robot will not create a nonce account while its offline-payments setting is off: switch it on in the robot's settings, or pass a nonce account made elsewhere");
    }
    throw new Error(`the robot did not create a nonce account: ${String(body.reason ?? body.error ?? `HTTP ${status}`)}`);
  }
}
