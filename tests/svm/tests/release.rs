//! The two real programs together, at their real durations.
//!
//! Everywhere else in this crate the vault is a stand-in: an account the test writes by hand under
//! the vault program's id. Here the Heir-enabled vault program itself runs next to the claim
//! program, in one VM whose clock the test moves by months: a real vault, armed by a real LMS
//! signature, goes quiet for 90 days, waits 30, is released by a stranger, and the claim program
//! reads the tombstone that the vault program wrote.
//!
//! That is the one contract between the two programs: `init_plan` recognises an open vault,
//! `activate` recognises a tombstone and the address in it. Each side tests its own half against a
//! copy of the layout. This tests them against each other.
//!
//! Needs both programs built into target/deploy: `node tools/scripts/build-programs.mjs`.

use heir_svm_tests as claim;
use lamport_vault_svm_tests::succession::{self as vault, Bench, Plan as Succession, DAY};
use lamport_vault_svm_tests::{action, Pubkey, TOKEN_PROGRAM_ID};
use solana_instruction::AccountMeta;
use solana_keypair::Keypair;
use solana_signer::Signer;

const WINDOW: u64 = 90 * 86_400;
const WAIT: u64 = 30 * 86_400;
const YEAR: i64 = 365 * DAY;

struct World {
    b: Bench,
    primary: Keypair,
    contingent: Keypair,
    terms: claim::Terms,
    plan: Pubkey,
}

/// A funded vault of the real vault program, the real claim program beside it, and a plan for the
/// vault with two named heirs who both signed its creation.
fn world() -> World {
    let mut b = Bench::new();
    b.svm.add_program_from_file(claim::CLAIM_PROGRAM_ID, claim::SO).expect("build the claim program first: node tools/scripts/build-programs.mjs");
    let primary = Keypair::new();
    let contingent = Keypair::new();
    for k in [&primary, &contingent] {
        b.svm.airdrop(&k.pubkey(), 1_000_000_000).unwrap();
    }
    let terms = claim::Terms {
        vault: b.vault,
        primary: claim::HeirRef::address(&primary.pubkey()),
        contingent: claim::HeirRef::address(&contingent.pubkey()),
        contingent_delay_secs: YEAR as u64,
    };
    let plan = terms.plan();
    let payer = b.payer.pubkey();
    // init_plan reads the real vault account and must take it for an open vault
    b.send(&[claim::init_plan_ix(&payer, &terms, &[primary.pubkey(), contingent.pubkey()])], &[&primary, &contingent]).expect("init_plan against a real vault");
    World { b, primary, contingent, terms, plan }
}

fn arm(w: &mut World) {
    // SetSuccession shows the claim account to the vault program, which must accept a plan account
    let plan = Succession { claim: w.plan, window_secs: WINDOW, wait_secs: WAIT, checkin_key: Pubkey::default(), contact_key: Pubkey::default() };
    w.b.set_plan(&plan).expect("the vault accepts a plan of the claim program as its claim address");
}

/// Lets the window and the waiting period run out, with a stranger doing what anyone may.
fn release(w: &mut World) {
    w.b.advance(WINDOW as i64 + 1);
    w.b.start().expect("start_succession once the window has passed");
    w.b.advance(WAIT as i64);
    let plan = w.plan;
    w.b.execute(&plan, &[]).expect("execute_succession once the waiting period has passed");
    assert!(w.b.is_tombstone());
}

fn send(w: &mut World, ix: solana_instruction::Instruction, signer: &Keypair) -> Result<(), solana_transaction_error::TransactionError> {
    w.b.send(&[ix], &[signer])
}

#[test]
fn a_vault_goes_quiet_releases_to_its_plan_and_the_primary_heir_claims_everything() {
    let mut w = world();
    let vault = w.b.vault;
    let plan = w.plan;
    // a token the vault holds, in an account nobody will remember to pass to the release
    let mint = w.b.mint(&TOKEN_PROGRAM_ID, 6);
    let vault_tokens = w.b.token_account(&TOKEN_PROGRAM_ID, &mint, &vault, 250_000);
    let vault_tokens_rent = w.b.balance(&vault_tokens);
    arm(&mut w);

    // While the vault is open the plan cannot be activated, and nothing can be claimed from it.
    assert_eq!(claim::custom(w.b.send(&[claim::activate_ix(&plan, &vault)], &[]).unwrap_err()), claim::err::VAULT_NOT_CLOSED);
    let primary = w.primary.insecure_clone();
    assert_eq!(claim::custom(send(&mut w, claim::claim_sol_ix(&plan, &primary.pubkey(), None), &primary).unwrap_err()), claim::err::NOT_ACTIVATED);

    let plan_rent = w.b.balance(&plan);
    let vault_before = w.b.balance(&vault);
    release(&mut w);

    // The vault program paid the plan everything above a tombstone's rent.
    let tombstone_rent = w.b.rent(81);
    assert_eq!(w.b.balance(&vault), tombstone_rent);
    assert_eq!(w.b.balance(&plan), plan_rent + vault_before - tombstone_rent);

    // The claim program reads the tombstone the vault program wrote. Anyone may tell it to.
    w.b.send(&[claim::activate_ix(&plan, &vault)], &[]).expect("activate against a real tombstone");
    let state = claim::decode_plan(&w.b.data(&plan));
    assert!(state.activated);
    assert_eq!(state.activated_ts, w.b.now());
    assert_eq!(state.closed_slot, w.b.slot());
    assert_eq!(state.terms, w.terms);

    // SOL to the primary heir; the plan keeps its own rent.
    let heir_before = w.b.balance(&primary.pubkey());
    send(&mut w, claim::claim_sol_ix(&plan, &primary.pubkey(), None), &primary).expect("claim_sol");
    assert_eq!(w.b.balance(&plan), plan_rent);
    // (the test's own payer pays the fees, so the heir receives the whole amount)
    assert_eq!(w.b.balance(&primary.pubkey()), heir_before + vault_before - tombstone_rent);

    // The token: swept by a stranger to the plan's own token account, then claimed by the heir.
    let plan_tokens = vault::ata(&plan, &mint, &TOKEN_PROGRAM_ID);
    let payer = w.b.payer.pubkey();
    w.b.send(&[vault::sweep_closed_ix(&payer, &vault, &plan, &vault_tokens, &mint, &TOKEN_PROGRAM_ID)], &[]).expect("sweep_closed to a plan");
    assert_eq!(vault::token_amount(&w.b.data(&plan_tokens)), 250_000);
    assert!(w.b.account(&vault_tokens).is_none_or(|a| a.lamports == 0), "the vault's token account is closed");
    // its rent went where the tombstone says everything goes: to the plan, for the heirs
    assert_eq!(w.b.balance(&plan), plan_rent + vault_tokens_rent);
    let heir_tokens = w.b.token_account(&TOKEN_PROGRAM_ID, &mint, &primary.pubkey(), 0);
    send(&mut w, claim::claim_token_ix(&plan, &primary.pubkey(), &plan_tokens, &heir_tokens, &mint, &TOKEN_PROGRAM_ID, None, true), &primary).expect("claim_token");
    assert_eq!(vault::token_amount(&w.b.data(&heir_tokens)), 250_000);
    assert!(w.b.account(&plan_tokens).is_none_or(|a| a.lamports == 0), "the plan's token account is closed");

    // SOL that reaches the vault's old address years later still ends with the heir.
    w.b.advance(3 * YEAR);
    let late = solana_system_interface::instruction::transfer(&payer, &vault, 7_000_000);
    w.b.send(&[late], &[]).unwrap();
    w.b.send(&[vault::sweep_closed_sol_ix(&vault, &plan)], &[]).expect("sweep_closed_sol to a plan");
    let before = w.b.balance(&primary.pubkey());
    send(&mut w, claim::claim_sol_ix(&plan, &primary.pubkey(), None), &primary).expect("claim_sol again");
    // with it comes the rent of the vault's token account, which the sweep had left in the plan
    assert_eq!(w.b.balance(&primary.pubkey()), before + 7_000_000 + vault_tokens_rent);
    assert_eq!(w.b.balance(&plan), plan_rent);
}

#[test]
fn the_contingent_heir_waits_a_year_that_starts_when_the_plan_is_activated() {
    let mut w = world();
    let (vault, plan) = (w.b.vault, w.plan);
    arm(&mut w);
    release(&mut w);
    // Nobody activates for two months: the year has not started.
    w.b.advance(60 * DAY);
    w.b.send(&[claim::activate_ix(&plan, &vault)], &[]).expect("activate");
    let activated = w.b.now();

    let contingent = w.contingent.insecure_clone();
    w.b.set_time(activated + YEAR - 1);
    assert_eq!(claim::custom(send(&mut w, claim::claim_sol_ix(&plan, &contingent.pubkey(), None), &contingent).unwrap_err()), claim::err::CONTINGENT_TOO_EARLY);
    let stranger = Keypair::new();
    w.b.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    assert_eq!(claim::custom(send(&mut w, claim::claim_sol_ix(&plan, &stranger.pubkey(), None), &stranger).unwrap_err()), claim::err::NOT_AN_HEIR);

    w.b.set_time(activated + YEAR);
    let before = w.b.balance(&contingent.pubkey());
    let held = w.b.balance(&plan) - w.b.rent(claim::PLAN_SPACE);
    send(&mut w, claim::claim_sol_ix(&plan, &contingent.pubkey(), None), &contingent).expect("the contingent heir, a year after activation");
    assert_eq!(w.b.balance(&contingent.pubkey()), before + held);
}

#[test]
fn the_owner_coming_back_ends_it_and_the_plan_stays_unactivated() {
    let mut w = world();
    let (vault, plan) = (w.b.vault, w.plan);
    arm(&mut w);
    w.b.advance(WINDOW as i64 + 1);
    w.b.start().expect("start");
    w.b.advance(WAIT as i64 - 1);
    // one second before the release, the owner signs anything at all
    w.b.sign_of_life().expect("a signed action");
    w.b.advance(10);
    assert_eq!(vault::custom(w.b.execute(&plan, &[]).unwrap_err()), vault::err::NO_WAIT_OPEN);
    assert_eq!(claim::custom(w.b.send(&[claim::activate_ix(&plan, &vault)], &[]).unwrap_err()), claim::err::VAULT_NOT_CLOSED);
    assert!(!w.b.is_tombstone());
}

#[test]
fn a_signed_close_to_the_plan_is_a_release_too() {
    // The owner may hand the vault to the plan themselves, without waiting for any clock.
    let mut w = world();
    let (vault, plan) = (w.b.vault, w.plan);
    let (issued, expiry) = w.b.window();
    w.b.signed(&action::close(&plan, issued, expiry), vec![AccountMeta::new(plan, false)]).expect("Close { to: plan }");
    assert!(w.b.is_tombstone());
    w.b.send(&[claim::activate_ix(&plan, &vault)], &[]).expect("activate after a signed Close");
    let primary = w.primary.insecure_clone();
    send(&mut w, claim::claim_sol_ix(&plan, &primary.pubkey(), None), &primary).expect("claim_sol");
}

#[test]
fn a_vault_that_released_elsewhere_never_activates_the_plan() {
    let mut w = world();
    let (vault, plan) = (w.b.vault, w.plan);
    // The owner changed their mind after the plan was made: the vault now names a plain address.
    let other = Keypair::new().pubkey();
    w.b.set_plan(&Succession { claim: other, window_secs: WINDOW, wait_secs: WAIT, checkin_key: Pubkey::default(), contact_key: Pubkey::default() }).unwrap();
    w.b.advance(WINDOW as i64 + 1);
    w.b.start().unwrap();
    w.b.advance(WAIT as i64);
    // not to the plan, whoever asks
    assert_eq!(vault::custom(w.b.execute(&plan, &[]).unwrap_err()), vault::err::WRONG_CLAIM);
    w.b.execute(&other, &[]).expect("release to the address the vault names");
    assert_eq!(claim::custom(w.b.send(&[claim::activate_ix(&plan, &vault)], &[]).unwrap_err()), claim::err::TOMBSTONE_NAMES_ANOTHER);
    let primary = w.primary.insecure_clone();
    assert_eq!(claim::custom(send(&mut w, claim::claim_sol_ix(&plan, &primary.pubkey(), None), &primary).unwrap_err()), claim::err::NOT_ACTIVATED);
}

#[test]
fn a_vault_armed_to_a_plan_nobody_created_can_still_be_claimed() {
    // The vault program accepts a claim address with nothing at it: it cannot tell a plan that was
    // never created from a wallet that was never used. If that happens, the release lands at an
    // address no key controls. The claim program lets the plan be created afterwards, because the
    // vault's tombstone names exactly that address, and only these terms produce it.
    let mut b = Bench::new();
    b.svm.add_program_from_file(claim::CLAIM_PROGRAM_ID, claim::SO).unwrap();
    let primary = Keypair::new();
    b.svm.airdrop(&primary.pubkey(), 1_000_000_000).unwrap();
    let vault = b.vault;
    let terms = claim::Terms { vault, primary: claim::HeirRef::address(&primary.pubkey()), contingent: claim::HeirRef::none(), contingent_delay_secs: 0 };
    let plan = terms.plan();
    assert!(b.account(&plan).is_none(), "the plan was never created");

    b.set_plan(&Succession { claim: plan, window_secs: WINDOW, wait_secs: WAIT, checkin_key: Pubkey::default(), contact_key: Pubkey::default() }).expect("the vault accepts an address with nothing at it");
    b.advance(WINDOW as i64 + 1);
    b.start().unwrap();
    b.advance(WAIT as i64);
    let payout = b.balance(&vault) - b.rent(81);
    b.execute(&plan, &[]).expect("the release goes to the address the owner signed for");
    let landed = b.account(&plan).expect("lamports at the plan's address");
    assert_eq!(landed.lamports, payout);
    assert!(landed.data.is_empty(), "still no plan there");

    // nothing can be activated or claimed yet
    assert!(b.send(&[claim::activate_ix(&plan, &vault)], &[]).is_err());
    assert!(b.send(&[claim::claim_sol_ix(&plan, &primary.pubkey(), None)], &[&primary]).is_err());

    // The plan is created now, by anyone who knows its terms; the heir proves control as always.
    let payer = b.payer.pubkey();
    assert_eq!(claim::custom(b.send(&[claim::init_plan_ix(&payer, &terms, &[])], &[]).unwrap_err()), claim::err::HEIR_NOT_PROVEN);
    b.send(&[claim::init_plan_ix(&payer, &terms, &[primary.pubkey()])], &[&primary]).expect("init_plan after the release");
    // What was released is all still there; the plan's own rent came out of it.
    assert_eq!(b.balance(&plan), payout);

    b.send(&[claim::activate_ix(&plan, &vault)], &[]).expect("activate");
    let before = b.balance(&primary.pubkey());
    b.send(&[claim::claim_sol_ix(&plan, &primary.pubkey(), None)], &[&primary]).expect("claim_sol");
    assert_eq!(b.balance(&primary.pubkey()), before + payout - b.rent(claim::PLAN_SPACE));
}

#[test]
fn a_plan_made_for_another_vault_cannot_be_activated_by_this_one() {
    // A mistake the vault program cannot see: this vault names, as its claim address, a plan whose
    // terms are for a different vault. The release goes there, and the plan can never be activated
    // through this vault, so what it received from it cannot be claimed. Whatever builds a
    // SetSuccession has to refuse this before it is signed (tools: `planNamesAnotherVault`).
    let mut w = world();
    let (vault, plan_for_this_vault) = (w.b.vault, w.plan);
    let other_vault = Bench::with_key(2).vault; // an address only: that vault lives in another VM
    let foreign_terms = claim::Terms { vault: other_vault, ..w.terms.clone() };
    let foreign_plan = foreign_terms.plan();
    assert_ne!(foreign_plan, plan_for_this_vault);
    // The foreign plan cannot even be created here, since its vault does not exist in this VM...
    let payer = w.b.payer.pubkey();
    let (p, c) = (w.primary.insecure_clone(), w.contingent.insecure_clone());
    assert_eq!(claim::custom(w.b.send(&[claim::init_plan_ix(&payer, &foreign_terms, &[p.pubkey(), c.pubkey()])], &[&p, &c]).unwrap_err()), claim::err::NOT_A_LIVE_VAULT);
    // ...and a plan that does exist refuses a vault that is not the one in its terms.
    let wrong = claim::activate_ix(&plan_for_this_vault, &other_vault);
    assert_eq!(claim::custom(w.b.send(&[wrong], &[]).unwrap_err()), claim::err::WRONG_VAULT);
    let _ = vault;
}
