//! `init_plan`: the terms, the plan's address, and how an heir proves control.
use heir_svm_tests::*;
use solana_instruction::AccountMeta;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;

const YEAR: u64 = 365 * 86_400;

fn terms(vault: &Pubkey, primary: HeirRef, contingent: HeirRef, delay: u64) -> Terms {
    Terms { vault: *vault, primary, contingent, contingent_delay_secs: delay }
}

struct World {
    b: Bench,
    vault: Pubkey,
    primary: Keypair,
    contingent: Keypair,
}

fn world() -> World {
    let mut b = Bench::new();
    let vault = b.open_vault();
    World { b, vault, primary: Keypair::new(), contingent: Keypair::new() }
}

impl World {
    fn both(&self) -> Terms {
        terms(&self.vault, HeirRef::address(&self.primary.pubkey()), HeirRef::address(&self.contingent.pubkey()), YEAR)
    }
    fn solo(&self) -> Terms {
        terms(&self.vault, HeirRef::address(&self.primary.pubkey()), HeirRef::none(), 0)
    }
}

// ---- the happy paths ----

#[test]
fn heirs_who_sign_the_transaction_create_the_plan() {
    let mut w = world();
    let t = w.both();
    let plan = t.plan();
    let ix = init_plan_ix(&w.b.payer.pubkey(), &t, &[w.primary.pubkey(), w.contingent.pubkey()]);
    w.b.send(&[ix], &[&w.primary, &w.contingent]).expect("init_plan");

    let p = w.b.plan(&plan);
    assert_eq!(p.version, 1);
    assert_eq!(p.terms, t);
    assert_eq!(p.terms_hash, t.hash());
    assert_eq!(p.created_ts, w.b.now());
    assert!(!p.activated);
    assert_eq!((p.activated_ts, p.closed_slot, p.contingent_clock_ts), (0, 0, 0));
    assert_eq!(w.b.balance(&plan), w.b.rent(PLAN_SPACE), "the plan holds exactly its rent");
    assert_eq!(w.b.svm.get_account(&plan).unwrap().owner, CLAIM_PROGRAM_ID);
}

#[test]
fn a_signed_message_is_proof_too_and_needs_no_heir_online() {
    let mut w = world();
    let t = w.both();
    let plan = t.plan();
    let message = acceptance_message(&plan);
    // each heir signed the text at some earlier time; only the payer signs the transaction
    let ixs = [
        ed25519_ix(&w.primary, message.as_bytes()),
        ed25519_ix(&w.contingent, message.as_bytes()),
        init_plan_ix(&w.b.payer.pubkey(), &t, &[]),
    ];
    w.b.send(&ixs, &[]).expect("init_plan with two signed messages");
    assert_eq!(w.b.plan(&plan).terms, t);
}

#[test]
fn the_two_kinds_of_proof_mix() {
    let mut w = world();
    let t = w.both();
    let message = acceptance_message(&t.plan());
    let ixs = [init_plan_ix(&w.b.payer.pubkey(), &t, &[w.primary.pubkey()]), ed25519_ix(&w.contingent, message.as_bytes())];
    w.b.send(&ixs, &[&w.primary]).expect("one signer, one signed message, the proof after the instruction");
}

#[test]
fn a_message_in_an_offchain_envelope_is_accepted() {
    let mut w = world();
    let t = w.solo();
    let message = acceptance_message(&t.plan());
    let mut enveloped = b"\xffsolana offchain".to_vec();
    enveloped.extend_from_slice(&[0, 0, message.len() as u8, 0]);
    enveloped.extend_from_slice(message.as_bytes());
    w.b.send(&[ed25519_ix(&w.primary, &enveloped), init_plan_ix(&w.b.payer.pubkey(), &t, &[])], &[]).expect("enveloped message");
}

#[test]
fn an_heir_who_pays_has_signed() {
    let mut w = world();
    let payer = w.b.payer.pubkey();
    let t = terms(&w.vault, HeirRef::address(&payer), HeirRef::none(), 0);
    w.b.send(&[init_plan_ix(&payer, &t, &[])], &[]).expect("the payer is the primary heir");
}

#[test]
fn hashed_heirs_need_no_proof_and_stay_off_the_chain() {
    let mut w = world();
    let (salt_p, salt_c) = ([1u8; 32], [2u8; 32]);
    let t = terms(&w.vault, HeirRef::hashed(&salt_p, &w.primary.pubkey()), HeirRef::hashed(&salt_c, &w.contingent.pubkey()), YEAR);
    let plan = t.plan();
    w.b.send(&[init_plan_ix(&w.b.payer.pubkey(), &t, &[])], &[]).expect("hashed heirs");
    let data = w.b.data(&plan);
    for heir in [w.primary.pubkey(), w.contingent.pubkey()] {
        assert!(!data.windows(32).any(|win| win == heir.as_ref()), "an heir's address is in the plan account");
    }
}

#[test]
fn a_plan_address_funded_in_advance_keeps_the_money() {
    let mut w = world();
    let t = w.solo();
    let plan = t.plan();
    w.b.fund(&plan, 5_000_000_000);
    w.b.send(&[init_plan_ix(&w.b.payer.pubkey(), &t, &[w.primary.pubkey()])], &[&w.primary]).expect("init over a funded address");
    assert_eq!(w.b.balance(&plan), 5_000_000_000);
    assert_eq!(w.b.plan(&plan).terms, t);
}

// ---- refusals: proof of control ----

#[test]
fn an_heir_named_by_address_must_prove_control() {
    let mut w = world();
    let t = w.both();
    let payer = w.b.payer.pubkey();
    // nobody proves anything
    assert_eq!(custom(w.b.send(&[init_plan_ix(&payer, &t, &[])], &[]).unwrap_err()), err::HEIR_NOT_PROVEN);
    // only the primary
    assert_eq!(custom(w.b.send(&[init_plan_ix(&payer, &t, &[w.primary.pubkey()])], &[&w.primary]).unwrap_err()), err::HEIR_NOT_PROVEN);
    // only the contingent
    assert_eq!(custom(w.b.send(&[init_plan_ix(&payer, &t, &[w.contingent.pubkey()])], &[&w.contingent]).unwrap_err()), err::HEIR_NOT_PROVEN);
    // a stranger signs in the heirs' place
    let stranger = Keypair::new();
    assert_eq!(custom(w.b.send(&[init_plan_ix(&payer, &t, &[stranger.pubkey()])], &[&stranger]).unwrap_err()), err::HEIR_NOT_PROVEN);
    assert!(!w.b.exists(&t.plan()), "no plan was created");
}

#[test]
fn an_heir_listed_but_not_signing_proves_nothing() {
    let mut w = world();
    let t = w.solo();
    let mut ix = init_plan_ix(&w.b.payer.pubkey(), &t, &[]);
    ix.accounts.push(AccountMeta::new_readonly(w.primary.pubkey(), false)); // present, not a signer
    assert_eq!(custom(w.b.send(&[ix], &[]).unwrap_err()), err::HEIR_NOT_PROVEN);
}

#[test]
fn a_signed_message_must_be_by_the_heir_over_this_plan() {
    let mut w = world();
    let t = w.solo();
    let payer = w.b.payer.pubkey();
    let message = acceptance_message(&t.plan());
    let stranger = Keypair::new();

    // the right text, signed by someone else
    let r = w.b.send(&[ed25519_ix(&stranger, message.as_bytes()), init_plan_ix(&payer, &t, &[])], &[]);
    assert_eq!(custom(r.unwrap_err()), err::HEIR_NOT_PROVEN);

    // the heir's signature over another plan's text
    let other = terms(&w.vault, HeirRef::address(&w.primary.pubkey()), HeirRef::address(&stranger.pubkey()), YEAR);
    let other_message = acceptance_message(&other.plan());
    let r = w.b.send(&[ed25519_ix(&w.primary, other_message.as_bytes()), init_plan_ix(&payer, &t, &[])], &[]);
    assert_eq!(custom(r.unwrap_err()), err::HEIR_NOT_PROVEN);

    // the heir's signature over the text with one character changed
    let mut altered = message.clone().into_bytes();
    let last = altered.len() - 1;
    altered[last] = b'!';
    let r = w.b.send(&[ed25519_ix(&w.primary, &altered), init_plan_ix(&payer, &t, &[])], &[]);
    assert_eq!(custom(r.unwrap_err()), err::HEIR_NOT_PROVEN);

    // the heir's signature over the text with something after it
    let mut longer = message.clone().into_bytes();
    longer.extend_from_slice(b" And every other plan.");
    let r = w.b.send(&[ed25519_ix(&w.primary, &longer), init_plan_ix(&payer, &t, &[])], &[]);
    assert_eq!(custom(r.unwrap_err()), err::HEIR_NOT_PROVEN);

    // the heir's signature over the text with something before it that is not an off-chain envelope
    let mut prefixed = b"I do not agree. ".to_vec();
    prefixed.extend_from_slice(message.as_bytes());
    let r = w.b.send(&[ed25519_ix(&w.primary, &prefixed), init_plan_ix(&payer, &t, &[])], &[]);
    assert_eq!(custom(r.unwrap_err()), err::HEIR_NOT_PROVEN);

    // an envelope with far more in front of the text than an envelope has
    let mut stuffed = b"\xffsolana offchain".to_vec();
    stuffed.extend_from_slice(&[b' '; 200]);
    stuffed.extend_from_slice(message.as_bytes());
    let r = w.b.send(&[ed25519_ix(&w.primary, &stuffed), init_plan_ix(&payer, &t, &[])], &[]);
    assert_eq!(custom(r.unwrap_err()), err::HEIR_NOT_PROVEN);
    assert!(!w.b.exists(&t.plan()));
}

#[test]
fn a_forged_signature_fails_the_whole_transaction() {
    let mut w = world();
    let t = w.solo();
    let message = acceptance_message(&t.plan());
    // the heir's key and the right text, with a signature nobody made
    let forged = ed25519_ix_raw(&w.primary.pubkey().to_bytes(), &[9u8; 64], message.as_bytes(), [u16::MAX; 3]);
    let r = w.b.send(&[forged, init_plan_ix(&w.b.payer.pubkey(), &t, &[])], &[]);
    assert!(r.is_err(), "the Ed25519 program must refuse it");
    assert!(!w.b.exists(&t.plan()));
}

#[test]
fn an_ed25519_entry_that_points_at_another_instruction_proves_nothing() {
    let mut w = world();
    let t = w.solo();
    let payer = w.b.payer.pubkey();
    let message = acceptance_message(&t.plan());
    let stranger = Keypair::new();

    // Instruction 0 holds the stranger's real signature over the text. Instruction 1 is an Ed25519
    // instruction whose own bytes show the heir's key and the text, but whose offsets tell the
    // Ed25519 program to verify the key and signature found in instruction 0. The runtime verifies
    // the stranger's signature and is satisfied; a reader that trusted instruction 1's own bytes
    // would believe the heir had signed.
    let honest = ed25519_ix(&stranger, message.as_bytes());
    let decoy = ed25519_ix_raw(&w.primary.pubkey().to_bytes(), &[0u8; 64], message.as_bytes(), [0, 0, 0]);
    let r = w.b.send(&[honest, decoy, init_plan_ix(&payer, &t, &[])], &[]);
    assert_eq!(custom(r.unwrap_err()), err::HEIR_NOT_PROVEN);
    assert!(!w.b.exists(&t.plan()));
}

// ---- refusals: the terms and the accounts ----

#[test]
fn terms_hash_must_be_the_hash_of_the_terms() {
    let mut w = world();
    let t = w.solo();
    let payer = w.b.payer.pubkey();
    // a hash that is not the terms': the PDA for it is derivable, the terms do not match
    let wrong = [5u8; 32];
    let plan = Pubkey::find_program_address(&[b"plan", &wrong], &CLAIM_PROGRAM_ID).0;
    let ix = init_plan_ix_with(&payer, &plan, &wrong, &t, &w.vault, &INSTRUCTIONS_SYSVAR_ID, &[w.primary.pubkey()]);
    assert_eq!(custom(w.b.send(&[ix], &[&w.primary]).unwrap_err()), err::TERMS_HASH_MISMATCH);
    // the right hash with another account as the plan
    let other = Keypair::new().pubkey();
    let ix = init_plan_ix_with(&payer, &other, &t.hash(), &t, &w.vault, &INSTRUCTIONS_SYSVAR_ID, &[w.primary.pubkey()]);
    assert_eq!(custom(w.b.send(&[ix], &[&w.primary]).unwrap_err()), err::ANCHOR_CONSTRAINT_SEEDS);
}

#[test]
fn invalid_terms_are_refused() {
    let mut w = world();
    let payer = w.b.payer.pubkey();
    let p = HeirRef::address(&w.primary.pubkey());
    let c = HeirRef::address(&w.contingent.pubkey());
    let signers = [w.primary.pubkey(), w.contingent.pubkey()];
    let cases: Vec<(Terms, u32, &str)> = vec![
        (terms(&w.vault, HeirRef::none(), HeirRef::none(), 0), err::INVALID_TERMS, "no primary heir"),
        (terms(&w.vault, HeirRef { kind: 3, value: [1; 32] }, HeirRef::none(), 0), err::INVALID_TERMS, "unknown kind"),
        (terms(&w.vault, p, HeirRef { kind: 0, value: [1; 32] }, 0), err::INVALID_TERMS, "none with a value"),
        (terms(&w.vault, p, HeirRef::none(), 1), err::INVALID_CONTINGENT_DELAY, "delay with nobody to wait"),
        (terms(&w.vault, p, c, 0), err::INVALID_CONTINGENT_DELAY, "no delay"),
        (terms(&w.vault, p, c, MIN_CONTINGENT_DELAY_SECS - 1), err::INVALID_CONTINGENT_DELAY, "below the floor"),
        (terms(&w.vault, p, c, MAX_CONTINGENT_DELAY_SECS + 1), err::INVALID_CONTINGENT_DELAY, "above the cap"),
        (terms(&w.vault, p, p, YEAR), err::SAME_HEIR_TWICE, "the same heir twice"),
    ];
    for (t, code, what) in cases {
        let ix = init_plan_ix(&payer, &t, &signers);
        assert_eq!(custom(w.b.send(&[ix], &[&w.primary, &w.contingent]).unwrap_err()), code, "{what}");
        assert!(!w.b.exists(&t.plan()), "{what}");
    }
    // the floor and the cap themselves are fine
    for delay in [MIN_CONTINGENT_DELAY_SECS, MAX_CONTINGENT_DELAY_SECS] {
        let t = terms(&w.vault, p, c, delay);
        w.b.send(&[init_plan_ix(&payer, &t, &signers)], &[&w.primary, &w.contingent]).expect("a delay at the edge");
    }
}

#[test]
fn the_vault_must_be_an_open_vault_of_the_vault_program() {
    let mut w = world();
    let payer = w.b.payer.pubkey();
    let signers = [w.primary.pubkey()];
    let p = HeirRef::address(&w.primary.pubkey());

    // an address with nothing at it
    let nowhere = Keypair::new().pubkey();
    let t = terms(&nowhere, p, HeirRef::none(), 0);
    assert_eq!(custom(w.b.send(&[init_plan_ix(&payer, &t, &signers)], &[&w.primary]).unwrap_err()), err::NOT_A_LIVE_VAULT);

    // a plain wallet
    let wallet = Keypair::new().pubkey();
    w.b.fund(&wallet, 1_000_000_000);
    let t = terms(&wallet, p, HeirRef::none(), 0);
    assert_eq!(custom(w.b.send(&[init_plan_ix(&payer, &t, &signers)], &[&w.primary]).unwrap_err()), err::NOT_A_LIVE_VAULT);

    // vault-shaped bytes owned by another program
    let lookalike = Keypair::new().pubkey();
    w.b.put(&lookalike, &TOKEN_PROGRAM_ID, live_vault_data(), 0);
    let t = terms(&lookalike, p, HeirRef::none(), 0);
    assert_eq!(custom(w.b.send(&[init_plan_ix(&payer, &t, &signers)], &[&w.primary]).unwrap_err()), err::NOT_A_LIVE_VAULT);

    // a vault that has already closed
    let closed = w.b.open_vault();
    w.b.release_vault(&closed, &Keypair::new().pubkey(), 0);
    let t = terms(&closed, p, HeirRef::none(), 0);
    assert_eq!(custom(w.b.send(&[init_plan_ix(&payer, &t, &signers)], &[&w.primary]).unwrap_err()), err::NOT_A_LIVE_VAULT);

    // a real vault passed for terms that name another
    let t = w.solo();
    let other_vault = w.b.open_vault();
    let ix = init_plan_ix_with(&payer, &t.plan(), &t.hash(), &t, &other_vault, &INSTRUCTIONS_SYSVAR_ID, &signers);
    assert_eq!(custom(w.b.send(&[ix], &[&w.primary]).unwrap_err()), err::WRONG_VAULT);
}

#[test]
fn the_instructions_sysvar_cannot_be_substituted() {
    let mut w = world();
    let t = w.solo();
    let payer = w.b.payer.pubkey();
    let fake = Keypair::new().pubkey();
    w.b.put(&fake, &SYSTEM_PROGRAM_ID, vec![0u8; 64], 0);
    let ix = init_plan_ix_with(&payer, &t.plan(), &t.hash(), &t, &w.vault, &fake, &[w.primary.pubkey()]);
    assert_eq!(custom(w.b.send(&[ix], &[&w.primary]).unwrap_err()), err::WRONG_INSTRUCTIONS_SYSVAR);
}

#[test]
fn a_plan_cannot_be_created_twice_and_other_terms_are_another_plan() {
    let mut w = world();
    let t = w.both();
    let payer = w.b.payer.pubkey();
    let signers = [w.primary.pubkey(), w.contingent.pubkey()];
    w.b.send(&[init_plan_ix(&payer, &t, &signers)], &[&w.primary, &w.contingent]).expect("first");
    let before = w.b.data(&t.plan());
    let again = w.b.send(&[init_plan_ix(&payer, &t, &signers)], &[&w.primary, &w.contingent]);
    assert!(matches!(again, Err(TransactionError::InstructionError(_, _))), "second init of the same terms");
    assert_eq!(w.b.data(&t.plan()), before, "the plan is untouched");

    // a day more of delay: a different address, a separate plan
    let mut t2 = t.clone();
    t2.contingent_delay_secs += 86_400;
    assert_ne!(t2.plan(), t.plan());
    w.b.send(&[init_plan_ix(&payer, &t2, &signers)], &[&w.primary, &w.contingent]).expect("other terms");
    assert_eq!(w.b.data(&t.plan()), before);
}
