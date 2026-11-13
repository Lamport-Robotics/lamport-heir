"""Does queueing plan changes for 30 days change any outcome?  (design note, section 4.4)

Two variants of how a plan change (`SetSuccession`) applies, under the spec's clock rules:

  Q  queued     a new claim address or a shorter window or wait takes effect 30 days later; longer
                durations, key changes and clearing apply at once; restating the plan in force
                cancels a queued change
  I  immediate  every change applies at once

The script drives both with the same random sequence of plan changes, other signed actions,
check-ins, contact extensions, starts and executes, and compares after every event: the result of
the event, and the earliest (start, execute, recipient) reachable if nobody acts again.

    python3 queue_vs_immediate.py [sequences per configuration, default 200000]

Configurations 1 and 1b are the spec as written: 0 differences. 2 to 4 are ways the queue's rules
could be read or implemented where the spec is silent; each one differs. 5 and 6 are controls that
break the floors on purpose (a window shorter than the queue, a queue longer than the shortest
window): thousands of differences, which shows the comparison can see one.

Time unit: days. This is a model of the rules, not the program.
"""
import random, sys, copy

Y2 = 730

class Cfg:
    def __init__(self, queued, delay=30, keys_ride=False, arm_queued=False, clear_keeps_pending=False, keep_timer=False):
        self.queued = queued; self.delay = delay; self.keys_ride = keys_ride
        self.arm_queued = arm_queued; self.clear_keeps_pending = clear_keeps_pending; self.keep_timer = keep_timer

def new_state(plan):
    # plan = (claim, W, wait, kc, kx) or None
    return dict(plan=plan, pend=None, eff=None, S=0, C=0, E=0, ext_used=False, ws=None, released=None)

def mature(st, t):
    if st["pend"] is not None and t >= st["eff"]:
        st["plan"] = st["pend"]; st["pend"] = None; st["eff"] = None

def step(st, ev, t, cfg):
    """Apply event at time t. Returns a result string (compared across variants)."""
    if st["released"] is not None:
        return "done"
    mature(st, t)
    kind = ev[0]
    if kind == "SET":
        new = ev[1]
        st["S"] = t; st["ws"] = None
        if not cfg.queued:
            st["plan"] = new; return "ok"
        if new is None:
            st["plan"] = None
            if not cfg.clear_keeps_pending:
                st["pend"] = None; st["eff"] = None
            return "ok"
        old = st["plan"]
        if old is None:
            if cfg.arm_queued:
                st["pend"] = new; st["eff"] = t + cfg.delay
            else:
                st["plan"] = new; st["pend"] = None; st["eff"] = None
            return "ok"
        claim = old[0] if new[0] != old[0] else new[0]
        W = new[1] if new[1] >= old[1] else old[1]
        wait = new[2] if new[2] >= old[2] else old[2]
        anyq = (claim, W, wait) != (new[0], new[1], new[2])
        if cfg.keys_ride and anyq:
            kc, kx = old[3], old[4]
        else:
            kc, kx = new[3], new[4]
        inforce = (claim, W, wait, kc, kx)
        st["plan"] = inforce
        if inforce == new:
            st["pend"] = None; st["eff"] = None  # restating the plan in force cancels the queue
        else:
            if cfg.keep_timer and st["pend"] == new and st["eff"] is not None:
                pass
            else:
                st["pend"] = new; st["eff"] = t + cfg.delay
        return "ok"
    if kind == "OTHER":
        st["S"] = t; st["ws"] = None; return "ok"
    if kind == "CHECKIN":
        p = st["plan"]
        if p is None or ev[1] != p[3] or t > st["S"] + Y2: return "fail"
        st["C"] = t; st["ws"] = None; return "ok"
    if kind == "EXTEND":
        p = st["plan"]
        if p is None or ev[1] != p[4] or st["ext_used"]: return "fail"
        st["E"] += 90; st["ext_used"] = True; st["ws"] = None; return "ok"
    if kind == "START":
        p = st["plan"]
        if p is None or st["ws"] is not None: return "fail"
        A = max(st["S"], min(st["C"], st["S"] + Y2))
        if not (t > A + p[1] + st["E"]): return "fail"
        st["ws"] = t; return "ok"
    if kind == "EXEC":
        p = st["plan"]
        if p is None or st["ws"] is None or t < st["ws"] + p[2]: return "fail"
        st["released"] = p[0]; return "released:" + p[0]
    raise ValueError(kind)

def earliest(st, ev, t, cfg, extra):
    """Earliest t' >= t at which ev succeeds if nothing else happens (success is monotone in t')."""
    cands = {t}
    if st["eff"] is not None: cands.add(max(t, st["eff"]))
    for c in extra: cands.add(max(t, c))
    if st["eff"] is not None:
        for c in list(extra): cands.add(max(t, c, st["eff"]))
    for c in sorted(cands):
        s2 = dict(st)
        r = step(s2, ev, c, cfg)
        if r != "fail" and r != "done":
            return c, r, s2
    return None, None, None

def asap_release(st, t, cfg):
    """From this state, with no further owner/weak-key action: (start time, execute time, recipient)."""
    if st["released"] is not None: return ("done",)
    s = dict(st)
    ts = None
    if s["ws"] is None:
        A = max(s["S"], min(s["C"], s["S"] + Y2))
        ws_c = set()
        for p in (s["plan"], s["pend"]):
            if p is not None: ws_c.add(A + p[1] + s["E"] + 1)
        ts, r, s = earliest(s, ("START",), t, cfg, ws_c)
        if ts is None: return ("never",)
    t2 = ts if ts is not None else t
    ex_c = set()
    for p in (s["plan"], s["pend"]):
        if p is not None: ex_c.add(s["ws"] + p[2])
    te, r, s3 = earliest(s, ("EXEC",), t2, cfg, ex_c)
    if te is None: return ("never-exec", ts)
    return (ts, te, r)

GAPS = [0, 0, 1, 1, 5, 10, 29, 30, 31, 45, 59, 60, 61, 89, 90, 91, 119, 120, 121, 150, 180, 365, 400, 729, 730, 731]

def rand_plan(rng, Ws, waits):
    return (rng.choice("ABC"), rng.choice(Ws), rng.choice(waits), rng.choice(["k1", "k2"]), rng.choice(["x1", "x2"]))

def rand_event(rng, Ws, waits):
    r = rng.random()
    if r < 0.30:
        return ("SET", None) if rng.random() < 0.15 else ("SET", rand_plan(rng, Ws, waits))
    if r < 0.38: return ("OTHER",)
    if r < 0.53: return ("CHECKIN", rng.choice(["k1", "k2"]))
    if r < 0.63: return ("EXTEND", rng.choice(["x1", "x2"]))
    if r < 0.83: return ("START",)
    return ("EXEC",)

def run(name, cfgQ, cfgI, n, seed, Ws=(90, 91, 120, 365, 1000), waits=(30, 31, 60, 200)):
    rng = random.Random(seed)
    diffs = 0; first = None; releases = 0; starts = 0
    for i in range(n):
        p0 = None if rng.random() < 0.15 else rand_plan(rng, Ws, waits)
        sq, si = new_state(p0), new_state(p0)
        t = 0; trace = [("init", p0)]
        bad = None
        for _ in range(rng.randint(2, 10)):
            t += rng.choice(GAPS)
            ev = rand_event(rng, Ws, waits)
            rq = step(sq, ev, t, cfgQ); ri = step(si, ev, t, cfgI)
            trace.append((t, ev, rq, ri))
            if ev[0] == "START" and ri == "ok": starts += 1
            if ri.startswith("released"): releases += 1
            if rq != ri: bad = ("event result differs", rq, ri); break
            aq = asap_release(sq, t, cfgQ); ai = asap_release(si, t, cfgI)
            if aq != ai: bad = ("ASAP release path differs (start, execute, recipient)", aq, ai); break
            if sq["released"] is not None: break
        if bad:
            diffs += 1
            if first is None: first = (bad, trace)
    print(f"[{name}] sequences={n} diffs={diffs} (successful starts in I={starts}, releases in I={releases})")
    if first:
        print("   first counterexample:", first[0])
        for row in first[1]: print("     ", row)

if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 200000
    I = Cfg(False)
    run("1 literal rules (keys/arm/clear at once)", Cfg(True), I, n, 1)
    run("1b literal, queue timer kept on re-statement of pending", Cfg(True, keep_timer=True), I, n, 2)
    run("2 weak-key changes ride the queue", Cfg(True, keys_ride=True), I, n, 3)
    run("3 arm-from-cleared is queued too", Cfg(True, arm_queued=True), I, n, 4)
    run("4 BUG: clear does not drop the queued change", Cfg(True, clear_keeps_pending=True), I, n, 5)
    run("5 CONTROL: window floor below queue delay (W may be 10/20 days)", Cfg(True), I, n, 6, Ws=(10, 20, 90, 365))
    run("6 CONTROL: queue delay 100 days > window floor 90", Cfg(True, delay=100), I, n, 7)
