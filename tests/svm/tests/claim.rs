//! `activate`, `claim_sol` and `claim_token`: who may take what out of a plan, and when.
use heir_svm_tests::*;
use solana_instruction::AccountMeta;
use solana_keypair::Keypair;
use solana_signer::Signer;

const YEAR: i64 = 365 * DAY;
const SOL: u64 = 1_000_000_000;

struct World {
    b: Bench,
    vault: Pubkey,
    plan: Pubkey,
    primary: Keypair,
    contingent: Keypair,
    stranger: Keypair,
}

/// A plan with both heirs named by address and a one-year contingent delay, not yet activated.
fn world() -> World {
    world_with(|vault, p, c| Terms { vault: *vault, primary: HeirRef::address(p), contingent: HeirRef::address(c), contingent_delay_secs: YEAR as u64 })
}

fn world_with(make: impl Fn(&Pubkey, &Pubkey, &Pubkey) -> Terms) -> World {
    let mut b = Bench::new();
    let vault = b.open_vault();
    let (primary, contingent, stranger) = (Keypair::new(), Keypair::new(), Keypair::new());
    for k in [&primary, &contingent, &stranger] {
        b.fund(&k.pubkey(), SOL); // rent for an account that receives a claim, and nothing more
    }
    let t = make(&vault, &primary.pubkey(), &contingent.pubkey());
    let plan = t.plan();
    let mut signers: Vec<&Keypair> = vec![];
    let mut keys = vec![];
    if t.primary.kind == 1 {
        signers.push(&primary);
        keys.push(primary.pubkey());
    }
    if t.contingent.kind == 1 {
        signers.push(&contingent);
        keys.push(contingent.pubkey());
    }
    b.send(&[init_plan_ix(&b.payer.pubkey(), &t, &keys)], &signers).expect("init_plan");
    World { b, vault, plan, primary, contingent, stranger }
}

impl World {
    /// The vault releases `lamports` to the plan and the plan is activated.
    fn release(&mut self, lamports: u64) {
        self.b.release_vault(&self.vault, &self.plan, lamports);
        self.b.send(&[activate_ix(&self.plan, &self.vault)], &[]).expect("activate");
    }
    fn claim_sol(&mut self, who: &Keypair) -> Result<(), u32> {
        self.b.send(&[claim_sol_ix(&self.plan, &who.pubkey(), None)], &[who]).map_err(custom)
    }
    /// What the plan holds above its own rent.
    fn claimable(&self) -> u64 {
        self.b.balance(&self.plan) - self.b.rent(PLAN_SPACE)
    }
}

// ---- activate ----

#[test]
fn activation_needs_the_vaults_own_tombstone_naming_this_plan() {
    let mut w = world();
    let (plan, vault) = (w.plan, w.vault);

    // the vault is still open
    assert_eq!(custom(w.b.send(&[activate_ix(&plan, &vault)], &[]).unwrap_err()), err::VAULT_NOT_CLOSED);

    // another account passed as the vault: a real tombstone naming this plan, at the wrong address
    let other_vault = w.b.open_vault();
    w.b.release_vault(&other_vault, &plan, 0);
    assert_eq!(custom(w.b.send(&[activate_ix(&plan, &other_vault)], &[]).unwrap_err()), err::WRONG_VAULT);

    // the vault closed, but to somebody else
    w.b.release_vault(&vault, &w.stranger.pubkey(), 0);
    assert_eq!(custom(w.b.send(&[activate_ix(&plan, &vault)], &[]).unwrap_err()), err::TOMBSTONE_NAMES_ANOTHER);
    assert!(!w.b.plan(&plan).activated);
}

#[test]
fn a_tombstone_is_believed_only_from_the_vault_program_and_only_whole() {
    let mut w = world();
    let (plan, vault) = (w.plan, w.vault);
    let good = tombstone_data(&[7; 32], 99, &plan);

    // the right bytes, owned by another program
    w.b.put(&vault, &TOKEN_PROGRAM_ID, good.clone(), 0);
    assert_eq!(custom(w.b.send(&[activate_ix(&plan, &vault)], &[]).unwrap_err()), err::NOT_A_TOMBSTONE);
    w.b.put(&vault, &SYSTEM_PROGRAM_ID, good.clone(), 0);
    assert_eq!(custom(w.b.send(&[activate_ix(&plan, &vault)], &[]).unwrap_err()), err::NOT_A_TOMBSTONE);

    // owned by the vault program, but not a tombstone: wrong version, wrong size, another discriminator
    let mut version = good.clone();
    version[8] = 3;
    let mut long = good.clone();
    long.push(0);
    let mut disc = good.clone();
    disc[0] ^= 1;
    for (bytes, what) in [(version, "version"), (good[..80].to_vec(), "short"), (long, "long"), (disc, "discriminator"), (vec![], "empty")] {
        w.b.put(&vault, &VAULT_PROGRAM_ID, bytes, 0);
        assert_eq!(custom(w.b.send(&[activate_ix(&plan, &vault)], &[]).unwrap_err()), err::NOT_A_TOMBSTONE, "{what}");
    }
    assert!(!w.b.plan(&plan).activated);

    // and the real thing
    w.b.put(&vault, &VAULT_PROGRAM_ID, good, 0);
    w.b.send(&[activate_ix(&plan, &vault)], &[]).expect("activate");
    let p = w.b.plan(&plan);
    assert!(p.activated);
    assert_eq!(p.closed_slot, 99);
    assert_eq!(p.activated_ts, w.b.now());
    assert_eq!(p.contingent_clock_ts, w.b.now());
}

#[test]
fn activating_twice_changes_nothing() {
    let mut w = world();
    w.release(SOL);
    let first = w.b.plan(&w.plan);
    w.b.advance(40 * DAY);
    w.b.send(&[activate_ix(&w.plan, &w.vault)], &[]).expect("a second activate succeeds");
    assert_eq!(w.b.plan(&w.plan), first, "and leaves the first activation's time in place");
}

#[test]
fn only_a_plan_account_is_a_plan() {
    let mut w = world();
    let vault = w.vault;
    // an account that is not owned by the claim program
    let fake = Keypair::new().pubkey();
    w.b.put(&fake, &SYSTEM_PROGRAM_ID, w.b.data(&w.plan), 0);
    assert_eq!(custom(w.b.send(&[activate_ix(&fake, &vault)], &[]).unwrap_err()), err::ANCHOR_ACCOUNT_OWNED_BY_WRONG_PROGRAM);
    let who = w.primary.pubkey();
    assert_eq!(custom(w.b.send(&[claim_sol_ix(&fake, &who, None)], &[&w.primary]).unwrap_err()), err::ANCHOR_ACCOUNT_OWNED_BY_WRONG_PROGRAM);
}

// ---- claim_sol ----

#[test]
fn nobody_claims_before_the_vault_has_released() {
    let mut w = world();
    w.b.deposit(&w.plan.clone(), 3 * SOL); // money can reach a plan early; it stays put
    w.b.advance(10 * YEAR);
    let (primary, contingent, stranger) = (w.primary.insecure_clone(), w.contingent.insecure_clone(), w.stranger.insecure_clone());
    for who in [&primary, &contingent, &stranger] {
        assert_eq!(w.claim_sol(who).unwrap_err(), err::NOT_ACTIVATED);
    }
    assert_eq!(w.claimable(), 3 * SOL);
}

#[test]
fn the_primary_heir_claims_everything_and_the_plan_keeps_its_rent() {
    let mut w = world();
    w.release(5 * SOL);
    let primary = w.primary.insecure_clone();
    let before = w.b.balance(&primary.pubkey());
    w.claim_sol(&primary).expect("the primary heir claims");
    assert_eq!(w.b.balance(&primary.pubkey()), before + 5 * SOL);
    assert_eq!(w.b.balance(&w.plan), w.b.rent(PLAN_SPACE), "the plan keeps exactly its rent");

    // nothing left: a second claim says so
    assert_eq!(w.claim_sol(&primary).unwrap_err(), err::NOTHING_TO_CLAIM);

    // SOL that arrives later (a late sweep) is claimed the same way
    w.b.deposit(&w.plan.clone(), 7);
    w.claim_sol(&primary).expect("a late arrival");
    assert_eq!(w.b.balance(&primary.pubkey()), before + 5 * SOL + 7);
}

#[test]
fn every_other_signer_is_refused() {
    let mut w = world();
    w.release(5 * SOL);
    let (contingent, stranger) = (w.contingent.insecure_clone(), w.stranger.insecure_clone());
    assert_eq!(w.claim_sol(&stranger).unwrap_err(), err::NOT_AN_HEIR);
    assert_eq!(w.claim_sol(&contingent).unwrap_err(), err::CONTINGENT_TOO_EARLY);
    // the payer of the transaction is nobody either
    let payer = w.b.payer.insecure_clone();
    assert_eq!(w.claim_sol(&payer).unwrap_err(), err::NOT_AN_HEIR);
    // a salt does not make a stranger an heir of a plan with address heirs
    let r = w.b.send(&[claim_sol_ix(&w.plan, &stranger.pubkey(), Some(&[1; 32]))], &[&stranger]);
    assert_eq!(custom(r.unwrap_err()), err::NOT_AN_HEIR);
    assert_eq!(w.claimable(), 5 * SOL, "nothing moved");
}

#[test]
fn the_heir_must_sign() {
    let mut w = world();
    w.release(5 * SOL);
    // the primary heir's address in the heir position, without their signature
    let mut ix = claim_sol_ix(&w.plan, &w.primary.pubkey(), None);
    ix.accounts[1] = AccountMeta::new(w.primary.pubkey(), false);
    assert_eq!(custom(w.b.send(&[ix], &[]).unwrap_err()), err::ANCHOR_ACCOUNT_NOT_SIGNER);
    assert_eq!(w.claimable(), 5 * SOL);
}

#[test]
fn the_contingent_heir_claims_after_the_delay_and_not_a_second_before() {
    let mut w = world();
    w.release(5 * SOL);
    let contingent = w.contingent.insecure_clone();
    let activated = w.b.now();

    w.b.set_time(activated + YEAR - 1);
    assert_eq!(w.claim_sol(&contingent).unwrap_err(), err::CONTINGENT_TOO_EARLY);
    w.b.set_time(activated + YEAR);
    let before = w.b.balance(&contingent.pubkey());
    w.claim_sol(&contingent).expect("the contingent heir claims at the delay");
    assert_eq!(w.b.balance(&contingent.pubkey()), before + 5 * SOL);

    // the primary is never shut out: what arrives later is still theirs to take
    let primary = w.primary.insecure_clone();
    w.b.deposit(&w.plan.clone(), 2 * SOL);
    w.claim_sol(&primary).expect("the primary heir, late");
}

#[test]
fn a_claim_by_the_primary_restarts_the_contingent_heirs_wait() {
    let mut w = world();
    w.release(5 * SOL);
    let (primary, contingent) = (w.primary.insecure_clone(), w.contingent.insecure_clone());
    let activated = w.b.now();

    // the primary claims eleven months in
    w.b.set_time(activated + 330 * DAY);
    w.claim_sol(&primary).expect("primary");
    assert_eq!(w.b.plan(&w.plan).contingent_clock_ts, activated + 330 * DAY);

    // more arrives; a year after activation the contingent heir is still out
    w.b.deposit(&w.plan.clone(), 2 * SOL);
    w.b.set_time(activated + YEAR + DAY);
    assert_eq!(w.claim_sol(&contingent).unwrap_err(), err::CONTINGENT_TOO_EARLY);

    // a year after the primary's last claim they are in
    w.b.set_time(activated + 330 * DAY + YEAR);
    w.claim_sol(&contingent).expect("contingent, a year after the primary went quiet");
    assert_eq!(w.claimable(), 0);
}

#[test]
fn a_refused_claim_does_not_touch_the_clock() {
    let mut w = world();
    w.release(5 * SOL);
    let (contingent, stranger) = (w.contingent.insecure_clone(), w.stranger.insecure_clone());
    let before = w.b.plan(&w.plan);
    w.b.advance(100 * DAY);
    assert!(w.claim_sol(&stranger).is_err());
    assert!(w.claim_sol(&contingent).is_err());
    assert_eq!(w.b.plan(&w.plan), before);
}

#[test]
fn a_plan_with_no_contingent_heir_pays_only_the_primary_ever() {
    let mut w = world_with(|vault, p, _| Terms { vault: *vault, primary: HeirRef::address(p), contingent: HeirRef::none(), contingent_delay_secs: 0 });
    w.release(5 * SOL);
    w.b.advance(50 * YEAR);
    let (contingent, stranger, primary) = (w.contingent.insecure_clone(), w.stranger.insecure_clone(), w.primary.insecure_clone());
    assert_eq!(w.claim_sol(&contingent).unwrap_err(), err::NOT_AN_HEIR);
    assert_eq!(w.claim_sol(&stranger).unwrap_err(), err::NOT_AN_HEIR);
    w.claim_sol(&primary).expect("primary, fifty years on");
}

#[test]
fn hashed_heirs_claim_with_their_salt_and_only_with_it() {
    let (salt_p, salt_c) = ([11u8; 32], [22u8; 32]);
    let mut w = world_with(|vault, p, c| Terms { vault: *vault, primary: HeirRef::hashed(&salt_p, p), contingent: HeirRef::hashed(&salt_c, c), contingent_delay_secs: YEAR as u64 });
    w.release(5 * SOL);
    let (primary, contingent, stranger) = (w.primary.insecure_clone(), w.contingent.insecure_clone(), w.stranger.insecure_clone());
    let plan = w.plan;
    let claim = |w: &mut World, who: &Keypair, salt: Option<&[u8; 32]>| w.b.send(&[claim_sol_ix(&plan, &who.pubkey(), salt)], &[who]).map_err(custom);

    assert_eq!(claim(&mut w, &primary, None).unwrap_err(), err::NOT_AN_HEIR, "no salt");
    assert_eq!(claim(&mut w, &primary, Some(&salt_c)).unwrap_err(), err::NOT_AN_HEIR, "the other heir's salt");
    assert_eq!(claim(&mut w, &stranger, Some(&salt_p)).unwrap_err(), err::NOT_AN_HEIR, "the right salt, the wrong signer");
    assert_eq!(claim(&mut w, &contingent, Some(&salt_c)).unwrap_err(), err::CONTINGENT_TOO_EARLY);
    claim(&mut w, &primary, Some(&salt_p)).expect("the primary heir with its salt");
    assert_eq!(w.claimable(), 0);

    w.b.deposit(&plan, SOL);
    w.b.advance(YEAR);
    assert_eq!(claim(&mut w, &contingent, Some(&salt_p)).unwrap_err(), err::NOT_AN_HEIR, "the primary's salt, now public, is no use to anyone else");
    claim(&mut w, &contingent, Some(&salt_c)).expect("the contingent heir with its salt, after the delay");
}

#[test]
fn someone_else_may_pay_the_fee() {
    let mut w = world();
    w.release(5 * SOL);
    // the bench's payer is the fee payer in every test: the heir's balance grows by the claim exactly
    let primary = w.primary.insecure_clone();
    let (heir_before, payer_before) = (w.b.balance(&primary.pubkey()), w.b.balance(&w.b.payer.pubkey()));
    w.claim_sol(&primary).unwrap();
    assert_eq!(w.b.balance(&primary.pubkey()), heir_before + 5 * SOL);
    assert_eq!(w.b.balance(&w.b.payer.pubkey()), payer_before - 2 * FEE, "two signatures, both paid by the payer");
}

// ---- claim_token ----

struct Tokens {
    program: Pubkey,
    mint: Pubkey,
    /// the plan's token account, holding 1 000 units
    source: Pubkey,
}

fn tokens(w: &mut World, program: &Pubkey) -> Tokens {
    let mint = w.b.mint(program, 6);
    let source = w.b.token_account(program, &mint, &w.plan.clone(), 1_000);
    Tokens { program: *program, mint, source }
}

fn claim_token(w: &mut World, t: &Tokens, who: &Keypair, destination: &Pubkey, close: bool) -> Result<(), u32> {
    let ix = claim_token_ix(&w.plan, &who.pubkey(), &t.source, destination, &t.mint, &t.program, None, close);
    w.b.send(&[ix], &[who]).map_err(custom)
}

#[test]
fn the_primary_heir_claims_tokens_under_both_token_programs() {
    for program in [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID] {
        let mut w = world();
        w.release(0);
        let t = tokens(&mut w, &program);
        let primary = w.primary.insecure_clone();
        let destination = w.b.token_account(&program, &t.mint, &primary.pubkey(), 5);
        let rent = w.b.balance(&t.source);
        let before = w.b.balance(&primary.pubkey());

        claim_token(&mut w, &t, &primary, &destination, true).expect("claim_token");
        assert_eq!(token_amount(&w.b.data(&destination)), 1_005);
        assert!(!w.b.exists(&t.source), "the plan's token account is closed");
        assert_eq!(w.b.balance(&primary.pubkey()), before + rent, "its rent went to the heir");
    }
}

#[test]
fn tokens_can_be_claimed_without_closing_and_the_account_closed_later() {
    let mut w = world();
    w.release(0);
    let t = tokens(&mut w, &TOKEN_PROGRAM_ID);
    let primary = w.primary.insecure_clone();
    let destination = w.b.token_account(&t.program, &t.mint, &primary.pubkey(), 0);

    claim_token(&mut w, &t, &primary, &destination, false).expect("claim, leave the account open");
    assert_eq!(token_amount(&w.b.data(&destination)), 1_000);
    assert_eq!(token_amount(&w.b.data(&t.source)), 0);
    assert!(w.b.exists(&t.source));

    // nothing to move and nothing to close is an error; closing the empty account is not
    assert_eq!(claim_token(&mut w, &t, &primary, &destination, false).unwrap_err(), err::NOTHING_TO_CLAIM);
    claim_token(&mut w, &t, &primary, &destination, true).expect("close the empty account");
    assert!(!w.b.exists(&t.source));
}

#[test]
fn token_claims_follow_the_same_signing_rules() {
    let mut w = world();
    let t = tokens(&mut w, &TOKEN_PROGRAM_ID);
    let (primary, contingent, stranger) = (w.primary.insecure_clone(), w.contingent.insecure_clone(), w.stranger.insecure_clone());
    let dest_p = w.b.token_account(&t.program, &t.mint, &primary.pubkey(), 0);
    let dest_c = w.b.token_account(&t.program, &t.mint, &contingent.pubkey(), 0);
    let dest_s = w.b.token_account(&t.program, &t.mint, &stranger.pubkey(), 0);

    assert_eq!(claim_token(&mut w, &t, &primary, &dest_p, true).unwrap_err(), err::NOT_ACTIVATED);
    w.release(0);
    let activated = w.b.now();
    assert_eq!(claim_token(&mut w, &t, &stranger, &dest_s, true).unwrap_err(), err::NOT_AN_HEIR);
    assert_eq!(claim_token(&mut w, &t, &contingent, &dest_c, true).unwrap_err(), err::CONTINGENT_TOO_EARLY);
    w.b.set_time(activated + YEAR - 1);
    assert_eq!(claim_token(&mut w, &t, &contingent, &dest_c, true).unwrap_err(), err::CONTINGENT_TOO_EARLY);
    assert_eq!(token_amount(&w.b.data(&t.source)), 1_000, "nothing moved");

    w.b.set_time(activated + YEAR);
    claim_token(&mut w, &t, &contingent, &dest_c, true).expect("the contingent heir after the delay");
    assert_eq!(token_amount(&w.b.data(&dest_c)), 1_000);
}

#[test]
fn a_token_claim_by_the_primary_also_restarts_the_contingent_heirs_wait() {
    let mut w = world();
    w.release(SOL);
    let t = tokens(&mut w, &TOKEN_PROGRAM_ID);
    let (primary, contingent) = (w.primary.insecure_clone(), w.contingent.insecure_clone());
    let dest_p = w.b.token_account(&t.program, &t.mint, &primary.pubkey(), 0);
    let activated = w.b.now();
    w.b.set_time(activated + 200 * DAY);
    claim_token(&mut w, &t, &primary, &dest_p, true).expect("primary claims the tokens, leaves the SOL");
    w.b.set_time(activated + YEAR);
    assert_eq!(w.claim_sol(&contingent).unwrap_err(), err::CONTINGENT_TOO_EARLY);
    w.b.set_time(activated + 200 * DAY + YEAR);
    w.claim_sol(&contingent).expect("a year after the primary's token claim");
}

#[test]
fn tokens_go_only_to_an_account_the_claiming_heir_owns() {
    let mut w = world();
    w.release(0);
    let t = tokens(&mut w, &TOKEN_PROGRAM_ID);
    let primary = w.primary.insecure_clone();
    let strangers = w.b.token_account(&t.program, &t.mint, &w.stranger.pubkey(), 0);
    assert_eq!(claim_token(&mut w, &t, &primary, &strangers, true).unwrap_err(), err::DESTINATION_NOT_HEIRS);
    // not even back into the plan's own account
    let source = t.source;
    assert_eq!(claim_token(&mut w, &t, &primary, &source, true).unwrap_err(), err::DESTINATION_NOT_HEIRS);
    // an account of the heir's for another mint
    let other_mint = w.b.mint(&t.program, 6);
    let wrong_mint = w.b.token_account(&t.program, &other_mint, &primary.pubkey(), 0);
    assert_eq!(claim_token(&mut w, &t, &primary, &wrong_mint, true).unwrap_err(), err::WRONG_MINT);
    assert_eq!(token_amount(&w.b.data(&t.source)), 1_000);
}

#[test]
fn only_the_plans_own_token_accounts_can_be_emptied() {
    let mut w = world();
    w.release(0);
    let t = tokens(&mut w, &TOKEN_PROGRAM_ID);
    let primary = w.primary.insecure_clone();
    let destination = w.b.token_account(&t.program, &t.mint, &primary.pubkey(), 0);

    // someone else's token account as the source
    let victim = w.b.token_account(&t.program, &t.mint, &w.stranger.pubkey(), 500);
    let ix = claim_token_ix(&w.plan, &primary.pubkey(), &victim, &destination, &t.mint, &t.program, None, true);
    assert_eq!(custom(w.b.send(&[ix], &[&primary]).unwrap_err()), err::NOT_PLAN_TOKEN_ACCOUNT);
    assert_eq!(token_amount(&w.b.data(&victim)), 500);

    // the plan's account with the wrong mint named
    let other_mint = w.b.mint(&t.program, 6);
    let ix = claim_token_ix(&w.plan, &primary.pubkey(), &t.source, &destination, &other_mint, &t.program, None, true);
    assert_eq!(custom(w.b.send(&[ix], &[&primary]).unwrap_err()), err::WRONG_MINT);

    // the same, with a destination that really is for that other mint: the plan's account is for
    // another mint than the one named, and the program says so itself before any token CPI
    let other_destination = w.b.token_account(&t.program, &other_mint, &primary.pubkey(), 0);
    let ix = claim_token_ix(&w.plan, &primary.pubkey(), &t.source, &other_destination, &other_mint, &t.program, None, true);
    assert_eq!(custom(w.b.send(&[ix], &[&primary]).unwrap_err()), err::WRONG_MINT);
    assert_eq!(token_amount(&w.b.data(&t.source)), 1_000);
}

#[test]
fn the_token_program_must_be_one_of_the_two_and_own_the_accounts() {
    let mut w = world();
    w.release(0);
    let t = tokens(&mut w, &TOKEN_PROGRAM_ID);
    let primary = w.primary.insecure_clone();
    let destination = w.b.token_account(&t.program, &t.mint, &primary.pubkey(), 0);

    // some other program in the token program's place
    let ix = claim_token_ix(&w.plan, &primary.pubkey(), &t.source, &destination, &t.mint, &SYSTEM_PROGRAM_ID, None, true);
    assert_eq!(custom(w.b.send(&[ix], &[&primary]).unwrap_err()), err::INVALID_TOKEN_PROGRAM);
    // Token-2022 named for accounts that plain Token owns
    let ix = claim_token_ix(&w.plan, &primary.pubkey(), &t.source, &destination, &t.mint, &TOKEN_2022_PROGRAM_ID, None, true);
    assert_eq!(custom(w.b.send(&[ix], &[&primary]).unwrap_err()), err::INVALID_TOKEN_PROGRAM);
    // token-account bytes that no token program owns
    let fake_source = Keypair::new().pubkey();
    w.b.put(&fake_source, &SYSTEM_PROGRAM_ID, token_account_data(&t.mint, &w.plan.clone(), 1_000), 0);
    let ix = claim_token_ix(&w.plan, &primary.pubkey(), &fake_source, &destination, &t.mint, &t.program, None, true);
    assert_eq!(custom(w.b.send(&[ix], &[&primary]).unwrap_err()), err::INVALID_TOKEN_PROGRAM);
    assert_eq!(token_amount(&w.b.data(&t.source)), 1_000);
}

#[test]
fn one_plan_cannot_spend_another_plans_tokens() {
    // two plans for two vaults, the same primary heir; only the first has released
    let mut w = world();
    w.release(0);
    let primary = w.primary.insecure_clone();
    let other_vault = w.b.open_vault();
    let other_terms = Terms { vault: other_vault, primary: HeirRef::address(&primary.pubkey()), contingent: HeirRef::none(), contingent_delay_secs: 0 };
    let other_plan = other_terms.plan();
    w.b.send(&[init_plan_ix(&w.b.payer.pubkey(), &other_terms, &[primary.pubkey()])], &[&primary]).expect("second plan");

    let mint = w.b.mint(&TOKEN_PROGRAM_ID, 6);
    let others_tokens = w.b.token_account(&TOKEN_PROGRAM_ID, &mint, &other_plan, 1_000);
    let destination = w.b.token_account(&TOKEN_PROGRAM_ID, &mint, &primary.pubkey(), 0);

    // through the activated plan: it does not own that account
    let ix = claim_token_ix(&w.plan, &primary.pubkey(), &others_tokens, &destination, &mint, &TOKEN_PROGRAM_ID, None, true);
    assert_eq!(custom(w.b.send(&[ix], &[&primary]).unwrap_err()), err::NOT_PLAN_TOKEN_ACCOUNT);
    // through its own plan: that vault has not released
    let ix = claim_token_ix(&other_plan, &primary.pubkey(), &others_tokens, &destination, &mint, &TOKEN_PROGRAM_ID, None, true);
    assert_eq!(custom(w.b.send(&[ix], &[&primary]).unwrap_err()), err::NOT_ACTIVATED);
    assert_eq!(token_amount(&w.b.data(&others_tokens)), 1_000);
}
