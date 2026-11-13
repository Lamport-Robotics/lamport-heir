//! Random sequences of deposits, clock jumps and claim attempts by everyone, against a model of
//! the rules. Whatever the order: only an heir the terms name is ever paid, the contingent heir
//! never before their wait is over, and no lamport or token appears or disappears.
use heir_svm_tests::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

const SOL: u64 = 1_000_000_000;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Who {
    Primary,
    Contingent,
    Stranger,
}

/// What the rules say, restated without the program.
struct Model {
    activated: bool,
    has_contingent: bool,
    delay: i64,
    clock: i64,
}

impl Model {
    /// `Ok(())` when `who` may claim at `now`, else the error the program must give.
    fn may_claim(&self, who: Who, now: i64) -> Result<(), u32> {
        if !self.activated {
            return Err(err::NOT_ACTIVATED);
        }
        match who {
            Who::Primary => Ok(()),
            Who::Contingent if self.has_contingent => {
                if now >= self.clock + self.delay {
                    Ok(())
                } else {
                    Err(err::CONTINGENT_TOO_EARLY)
                }
            }
            _ => Err(err::NOT_AN_HEIR),
        }
    }
}

/// What a run exercised, so the test can check it is not passing by doing nothing.
#[derive(Default)]
struct Seen {
    primary_paid: u32,
    contingent_paid: u32,
    too_early: u32,
    not_an_heir: u32,
    not_activated: u32,
    nothing: u32,
}

fn run(seed: u64, seen: &mut Seen) {
    let mut rng = Rng(seed | 1);
    let mut b = Bench::new();
    let vault = b.open_vault();
    let (primary, contingent, stranger) = (Keypair::new(), Keypair::new(), Keypair::new());
    for k in [&primary, &contingent, &stranger] {
        b.fund(&k.pubkey(), SOL);
    }

    // a random plan: heirs by address or hashed, with or without a contingent heir
    let hashed = rng.below(2) == 0;
    let has_contingent = rng.below(4) != 0;
    let (salt_p, salt_c) = ([rng.next() as u8; 32], [rng.next() as u8 ^ 0x55; 32]);
    let delay_days = *rng.pick(&[30i64, 31, 90, 365, 3650]);
    let heir = |salt: &[u8; 32], k: &Pubkey| if hashed { HeirRef::hashed(salt, k) } else { HeirRef::address(k) };
    let terms = Terms {
        vault,
        primary: heir(&salt_p, &primary.pubkey()),
        contingent: if has_contingent { heir(&salt_c, &contingent.pubkey()) } else { HeirRef::none() },
        contingent_delay_secs: if has_contingent { (delay_days * DAY) as u64 } else { 0 },
    };
    let plan = terms.plan();
    let mut signers: Vec<&Keypair> = vec![];
    if !hashed {
        signers.push(&primary);
        if has_contingent {
            signers.push(&contingent);
        }
    }
    let keys: Vec<Pubkey> = signers.iter().map(|k| k.pubkey()).collect();
    b.send(&[init_plan_ix(&b.payer.pubkey(), &terms, &keys)], &signers).expect("init_plan");

    let mint = b.mint(&TOKEN_PROGRAM_ID, 6);
    let source = b.token_account(&TOKEN_PROGRAM_ID, &mint, &plan, 0);
    let dest = |b: &mut Bench, k: &Keypair| b.token_account(&TOKEN_PROGRAM_ID, &mint, &k.pubkey(), 0);
    let dests = [dest(&mut b, &primary), dest(&mut b, &contingent), dest(&mut b, &stranger)];

    let people = [(Who::Primary, &primary, salt_p), (Who::Contingent, &contingent, salt_c), (Who::Stranger, &stranger, [9u8; 32])];
    let start: Vec<u64> = people.iter().map(|(_, k, _)| b.balance(&k.pubkey())).collect();
    let mut model = Model { activated: false, has_contingent, delay: delay_days * DAY, clock: 0 };
    let (mut sol_in, mut tokens_in) = (0u64, 0u64);
    let mut sol_out = [0u64; 3];
    let mut tokens_out = [0u64; 3];
    let rent = b.rent(PLAN_SPACE);

    // The vault releases at some early step, or (one run in eight) never. The finisher activates
    // the plan in the same breath, as it will in practice; `activate` is also called at random
    // below, before and after.
    let release_at = if rng.below(8) == 0 { u64::MAX } else { rng.below(4) };

    for step in 0..14u64 {
        if step == release_at {
            let released = rng.below(4 * SOL);
            b.release_vault(&vault, &plan, released);
            sol_in += released;
            b.send(&[activate_ix(&plan, &vault)], &[]).expect("activate after the release");
            model.activated = true;
            model.clock = b.now();
        }
        match rng.below(10) {
            // time passes: a little
            0 => b.advance(*rng.pick(&[1, 3_600, DAY, 29 * DAY])),
            // time passes: a lot, or right up to the edge of the contingent heir's wait
            1 => {
                if model.activated && has_contingent && rng.below(3) != 0 {
                    let edge = model.clock + model.delay + *rng.pick(&[-1i64, 0, 1, DAY]);
                    if edge > b.now() {
                        b.set_time(edge);
                    }
                } else {
                    b.advance(*rng.pick(&[30 * DAY, 200 * DAY, 400 * DAY]));
                }
            }
            // money arrives
            2 => {
                let amount = 1 + rng.below(3 * SOL);
                b.deposit(&plan, amount);
                sol_in += amount;
            }
            3 => {
                let amount = 1 + rng.below(1_000_000);
                let mut data = b.data(&source);
                let new = token_amount(&data) + amount;
                data[64..72].copy_from_slice(&new.to_le_bytes());
                b.put(&source, &TOKEN_PROGRAM_ID, data, 0);
                tokens_in += amount;
            }
            // someone calls activate: it works exactly when the vault has released
            4 => {
                let closed = b.data(&vault)[..8] == TOMBSTONE_DISC;
                let r = b.send(&[activate_ix(&plan, &vault)], &[]);
                assert_eq!(r.is_ok(), closed, "seed {seed} step {step}: activate");
                assert_eq!(closed, model.activated, "seed {seed} step {step}: released means activated here");
            }
            // somebody tries to claim, with the right salt, the wrong one, or none
            _ => {
                let i = rng.below(3) as usize;
                let (who, key, salt) = (people[i].0, people[i].1, people[i].2);
                let salt_choice = rng.below(4);
                let salt_arg = match salt_choice {
                    0 => None,
                    1 => Some(&[0xEEu8; 32]),
                    _ => Some(&salt),
                };
                let salt_ok = !hashed || salt_choice >= 2;
                let now = b.now();
                let mut expect = model.may_claim(who, now);
                if expect.is_ok() && !salt_ok {
                    expect = Err(err::NOT_AN_HEIR); // a hashed heir without its salt is nobody
                }
                if expect == Err(err::CONTINGENT_TOO_EARLY) && !salt_ok {
                    expect = Err(err::NOT_AN_HEIR);
                }

                if rng.below(2) == 0 {
                    let available = b.balance(&plan) - rent;
                    if expect.is_ok() && available == 0 {
                        expect = Err(err::NOTHING_TO_CLAIM);
                    }
                    let got = b.send(&[claim_sol_ix(&plan, &key.pubkey(), salt_arg)], &[key]).map_err(custom);
                    assert_eq!(got, expect, "seed {seed} step {step}: claim_sol by {who:?} at {now}");
                    if got.is_ok() {
                        sol_out[i] += available;
                    }
                    note(seen, who, got);
                } else {
                    let available = token_amount(&b.data(&source));
                    if expect.is_ok() && available == 0 {
                        expect = Err(err::NOTHING_TO_CLAIM);
                    }
                    let ix = claim_token_ix(&plan, &key.pubkey(), &source, &dests[i], &mint, &TOKEN_PROGRAM_ID, salt_arg, false);
                    let got = b.send(&[ix], &[key]).map_err(custom);
                    assert_eq!(got, expect, "seed {seed} step {step}: claim_token by {who:?} at {now}");
                    if got.is_ok() {
                        tokens_out[i] += available;
                    }
                    note(seen, who, got);
                }
                // a claim by the primary heir, and only that, moves the contingent heir's clock;
                // "nothing to claim" is refused before the plan is written, so it moves nothing
                if who == Who::Primary && expect.is_ok() {
                    model.clock = now;
                }
            }
        }

        // after every step: the plan agrees with the model, and nothing was created or lost
        let p = b.plan(&plan);
        assert_eq!(p.activated, model.activated, "seed {seed} step {step}");
        if model.activated {
            assert_eq!(p.contingent_clock_ts, model.clock, "seed {seed} step {step}: contingent clock");
        }
        assert_eq!(p.terms, terms, "seed {seed} step {step}: the terms never change");
        assert_eq!(b.balance(&plan), rent + sol_in - sol_out.iter().sum::<u64>(), "seed {seed} step {step}: lamports");
        assert_eq!(token_amount(&b.data(&source)), tokens_in - tokens_out.iter().sum::<u64>(), "seed {seed} step {step}: tokens");
        for (i, (who, key, _)) in people.iter().enumerate() {
            assert_eq!(b.balance(&key.pubkey()), start[i] + sol_out[i], "seed {seed} step {step}: {who:?} lamports");
            assert_eq!(token_amount(&b.data(&dests[i])), tokens_out[i], "seed {seed} step {step}: {who:?} tokens");
        }
        assert_eq!((sol_out[2], tokens_out[2]), (0, 0), "seed {seed} step {step}: a stranger was paid");
        if !has_contingent {
            assert_eq!((sol_out[1], tokens_out[1]), (0, 0), "seed {seed} step {step}: nobody is contingent heir here");
        }
    }
}

fn note(seen: &mut Seen, who: Who, got: Result<(), u32>) {
    match (who, got) {
        (Who::Primary, Ok(())) => seen.primary_paid += 1,
        (Who::Contingent, Ok(())) => seen.contingent_paid += 1,
        (Who::Stranger, Ok(())) => unreachable!("the model never allows it"),
        (_, Err(err::CONTINGENT_TOO_EARLY)) => seen.too_early += 1,
        (_, Err(err::NOT_AN_HEIR)) => seen.not_an_heir += 1,
        (_, Err(err::NOT_ACTIVATED)) => seen.not_activated += 1,
        (_, Err(err::NOTHING_TO_CLAIM)) => seen.nothing += 1,
        (_, Err(other)) => panic!("an error the model does not know: {other}"),
    }
}

#[test]
fn random_sequences_agree_with_the_model() {
    let mut seen = Seen::default();
    for seed in 0..400 {
        run(0x9E37_79B9_7F4A_7C15u64.wrapping_mul(seed + 1), &mut seen);
    }
    println!(
        "paid: primary {} contingent {}; refused: too early {} not an heir {} not activated {} nothing to claim {}",
        seen.primary_paid, seen.contingent_paid, seen.too_early, seen.not_an_heir, seen.not_activated, seen.nothing
    );
    // every outcome was reached often enough to mean something
    for (count, what) in [
        (seen.primary_paid, "primary paid"),
        (seen.contingent_paid, "contingent paid"),
        (seen.too_early, "contingent too early"),
        (seen.not_an_heir, "not an heir"),
        (seen.not_activated, "not activated"),
        (seen.nothing, "nothing to claim"),
    ] {
        assert!(count >= 50, "{what}: only {count} times in 400 runs");
    }
}
