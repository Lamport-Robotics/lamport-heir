//! `claim_token` for a mint with a Token-2022 transfer hook.
//!
//! The mint, the token accounts and the transfers are the real Token-2022 program's. The hook is
//! lamport-vault's test fixture (`vendor/lamport-vault/tests/hook-fixture`): it wants one account of
//! its own, counts the transfers it lets through, and refuses any transfer in which an account
//! reaches it as a signer; told to, it refuses, tries to take the SOL of an account it was handed,
//! or calls another program. Loaded at Token-2022's own address, the same program records what a
//! caller hands the token program.
//!
//! What is pinned here:
//! - with the hook's accounts after `claim_token`'s own, an heir collects the token, and the hook
//!   has run: named heirs and private ones, with and without closing the plan's account;
//! - a hook that refuses fails the claim and nothing moves, not even the contingent heir's clock;
//! - missing or wrong hook accounts fail the same way;
//! - nobody's signature reaches a hook through the claim program. The heir signs every claim and
//!   usually pays for it, so the heir is the one a hostile hook would name. The claim program's
//!   call to the token program is read directly for this, with the fixture standing in for it;
//! - a hook cannot call back into the claim program;
//! - a mint without a hook, and a plain SPL Token mint, are claimed as before, with or without
//!   accounts that nobody needs;
//! - and once with both real programs: a hook mint in a real vault, released, swept into the plan
//!   and claimed.
//!
//! Needs the fixture built: `cargo build-sbf --manifest-path vendor/lamport-vault/tests/hook-fixture/Cargo.toml`.
use heir_svm_tests::*;
use lamport_vault_svm_tests::hook::{self, Listed};
use lamport_vault_svm_tests::succession as vault;
use litesvm::LiteSVM;
use solana_instruction::{AccountMeta, Instruction};
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_system_interface::instruction as system_instruction;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;
use spl_associated_token_account_interface::instruction::create_associated_token_account_idempotent;
use spl_token_2022_interface as t22;
use t22::extension::ExtensionType;
use t22::state::Mint;

const HOOK_SO: &str = "../../vendor/lamport-vault/tests/hook-fixture/target/deploy/hook_fixture.so";
const BUILD_IT: &str = "build the fixture first: cargo build-sbf --manifest-path vendor/lamport-vault/tests/hook-fixture/Cargo.toml";
const T22: Pubkey = TOKEN_2022_PROGRAM_ID;
const DECIMALS: u8 = 6;
const YEAR: i64 = 365 * DAY;
const SOL: u64 = 1_000_000_000;

fn kind(e: TransactionError) -> InstructionError {
    match e {
        TransactionError::InstructionError(_, kind) => kind,
        other => panic!("not an instruction error: {other:?}"),
    }
}

/// Signs with `payer` (who pays the fee) and `extra`, sends, and moves to a fresh blockhash.
fn send_as(svm: &mut LiteSVM, payer: &Keypair, ixs: &[Instruction], extra: &[&Keypair]) -> Result<(), TransactionError> {
    let bh = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&payer.pubkey()), &bh);
    let mut signers: Vec<&Keypair> = vec![payer];
    signers.extend_from_slice(extra);
    let r = svm.send_transaction(Transaction::new(&signers, msg, bh)).map(|_| ()).map_err(|e| e.err);
    svm.expire_blockhash();
    r
}

// ---- mints and token accounts, made by the token programs themselves ----

fn rent(svm: &LiteSVM, len: usize) -> u64 {
    svm.minimum_balance_for_rent_exemption(len)
}

/// A mint under `program` with `extensions`, each initialised by `init` before the mint itself.
/// `payer` is the mint authority.
fn mint(svm: &mut LiteSVM, payer: &Keypair, program: &Pubkey, extensions: &[ExtensionType], init: impl Fn(&Pubkey) -> Vec<Instruction>) -> Pubkey {
    let mint = Keypair::new();
    let space = ExtensionType::try_calculate_account_len::<Mint>(extensions).unwrap();
    let mut ixs = vec![system_instruction::create_account(&payer.pubkey(), &mint.pubkey(), rent(svm, space), space as u64, program)];
    ixs.extend(init(&mint.pubkey()));
    ixs.push(t22::instruction::initialize_mint2(program, &mint.pubkey(), &payer.pubkey(), None, DECIMALS).unwrap());
    send_as(svm, payer, &ixs, &[&mint]).expect("create the mint");
    mint.pubkey()
}

/// A Token-2022 mint whose transfer hook is the fixture, with the hook's accounts written: what it
/// should do (`mode`) and the accounts it lists.
fn hook_mint(svm: &mut LiteSVM, payer: &Keypair, mode: u8, list: &[Listed]) -> Pubkey {
    let authority = payer.pubkey();
    let mint = mint(svm, payer, &T22, &[ExtensionType::TransferHook], |mint| {
        vec![t22::extension::transfer_hook::instruction::initialize(&T22, mint, Some(authority), Some(hook::HOOK_PROGRAM_ID)).unwrap()]
    });
    hook::install(svm, &mint, mode, list);
    mint
}

fn ata_of(program: &Pubkey, owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    vault::ata(owner, mint, program)
}

/// `owner`'s associated token account for `mint` under `program`, created if missing.
fn ata(svm: &mut LiteSVM, payer: &Keypair, program: &Pubkey, owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    let ix = create_associated_token_account_idempotent(&payer.pubkey(), owner, mint, program);
    send_as(svm, payer, &[ix], &[]).expect("create the associated token account");
    ata_of(program, owner, mint)
}

fn mint_to(svm: &mut LiteSVM, payer: &Keypair, program: &Pubkey, mint: &Pubkey, account: &Pubkey, amount: u64) {
    let ix = t22::instruction::mint_to(program, mint, account, &payer.pubkey(), &[], amount).unwrap();
    send_as(svm, payer, &[ix], &[]).expect("mint_to");
}

fn amount(svm: &LiteSVM, account: &Pubkey) -> u64 {
    token_amount(&svm.get_account(account).expect("the token account").data)
}

// ---- a plan whose vault has released ----

struct World {
    b: Bench,
    plan: Pubkey,
    /// the primary heir, named by address unless `salt` is set
    heir: Keypair,
    contingent: Keypair,
    /// set when the primary heir is a private one: named by a hash of this salt and the address
    salt: Option<[u8; 32]>,
}

fn world_with(salt: Option<[u8; 32]>) -> World {
    let mut b = Bench::new();
    b.svm.add_program_from_file(hook::HOOK_PROGRAM_ID, HOOK_SO).expect(BUILD_IT);
    let vault = b.open_vault();
    let (heir, contingent) = (Keypair::new(), Keypair::new());
    for k in [&heir, &contingent] {
        b.fund(&k.pubkey(), 10 * SOL);
    }
    let primary = match &salt {
        Some(s) => HeirRef::hashed(s, &heir.pubkey()),
        None => HeirRef::address(&heir.pubkey()),
    };
    let terms = Terms { vault, primary, contingent: HeirRef::address(&contingent.pubkey()), contingent_delay_secs: YEAR as u64 };
    let plan = terms.plan();
    let mut signers: Vec<&Keypair> = vec![&contingent];
    let mut keys = vec![contingent.pubkey()];
    if salt.is_none() {
        signers.push(&heir);
        keys.push(heir.pubkey());
    }
    b.send(&[init_plan_ix(&b.payer.pubkey(), &terms, &keys)], &signers).expect("init_plan");
    b.release_vault(&vault, &plan, 0);
    b.send(&[activate_ix(&plan, &vault)], &[]).expect("activate");
    World { b, plan, heir, contingent, salt }
}

/// The primary heir named by address.
fn world() -> World {
    world_with(None)
}

/// One hook mint in a plan: the plan's token account holding 1 000, and the heir's own account.
struct Tokens {
    mint: Pubkey,
    source: Pubkey,
    destination: Pubkey,
}

impl World {
    fn tokens(&mut self, mode: u8, list: &[Listed]) -> Tokens {
        let payer = self.b.payer.insecure_clone();
        let mint = hook_mint(&mut self.b.svm, &payer, mode, list);
        self.holding(&T22, mint)
    }

    /// 1 000 of `mint` in the plan's associated account, and the heir's associated account for it.
    fn holding(&mut self, program: &Pubkey, mint: Pubkey) -> Tokens {
        let payer = self.b.payer.insecure_clone();
        let source = ata(&mut self.b.svm, &payer, program, &self.plan, &mint);
        mint_to(&mut self.b.svm, &payer, program, &mint, &source, 1_000);
        let destination = ata(&mut self.b.svm, &payer, program, &self.heir.pubkey(), &mint);
        Tokens { mint, source, destination }
    }

    /// `claim_token` by the primary heir, who also pays the fee, with `extra` after its own accounts.
    fn claim(&mut self, t: &Tokens, close: bool, extra: Vec<AccountMeta>) -> Result<(), TransactionError> {
        self.claim_under(&T22, t, close, extra, &[])
    }

    fn claim_under(&mut self, program: &Pubkey, t: &Tokens, close: bool, extra: Vec<AccountMeta>, cosigners: &[&Keypair]) -> Result<(), TransactionError> {
        let mut ix = claim_token_ix(&self.plan, &self.heir.pubkey(), &t.source, &t.destination, &t.mint, program, self.salt.as_ref(), close);
        ix.accounts.extend(extra);
        let heir = self.heir.insecure_clone();
        send_as(&mut self.b.svm, &heir, &[ix], cosigners)
    }

    fn held(&self, t: &Tokens) -> (u64, u64) {
        (amount(&self.b.svm, &t.source), amount(&self.b.svm, &t.destination))
    }
}

/// What a claim that went through the hook must look like from inside it: the plan as the
/// authority, read-only and unsigned like the three token accounts, and no signer anywhere.
fn hook_ran_once_for(w: &World, mint: &Pubkey, amount: u64) -> hook::Seen {
    let seen = hook::seen(&w.b.svm, mint);
    assert_eq!(seen.calls, 1, "the hook ran once");
    assert_eq!(seen.amount, amount);
    assert_eq!(seen.authority, w.plan, "the hook was told the plan is the authority");
    assert!(!seen.authority_signer && !seen.authority_writable, "the plan reaches the hook read-only and unsigned");
    assert!(!seen.token_accounts_writable, "so do the token accounts and the mint");
    assert_eq!(seen.signers, 0, "no account reaches the hook as a signer");
    seen
}

// ---- the token is collected, and the hook has run ----

#[test]
fn an_heir_claims_a_hook_mint_and_the_hook_runs() {
    let mut w = world();
    let t = w.tokens(hook::ALLOW, &[Listed::Counter]);
    let before = w.b.balance(&w.heir.pubkey());

    // without the hook's accounts the token program cannot call the hook
    assert!(w.claim(&t, false, vec![]).is_err());
    assert_eq!(w.held(&t), (1_000, 0));

    w.claim(&t, false, hook::accounts(&t.mint)).expect("claim_token of a hook mint");
    assert_eq!(w.held(&t), (0, 1_000));
    assert_eq!(w.b.balance(&w.heir.pubkey()), before - 2 * FEE, "the heir paid two fees and nothing else");
    let seen = hook_ran_once_for(&w, &t.mint, 1_000);
    assert_eq!(seen.accounts, 6, "source, mint, destination, authority, validation account, counter");

    // the emptied account is closed by a later call; nothing is transferred, so the hook is not asked
    let rent = w.b.balance(&t.source);
    let before = w.b.balance(&w.heir.pubkey());
    w.claim(&t, true, vec![]).expect("close the empty account");
    assert!(!w.b.exists(&t.source));
    assert_eq!(w.b.balance(&w.heir.pubkey()), before + rent - FEE, "its rent went to the heir");
    assert_eq!(hook::seen(&w.b.svm, &t.mint).calls, 1);
}

#[test]
fn a_hook_mint_is_claimed_and_its_account_closed_in_one_instruction() {
    let mut w = world();
    let t = w.tokens(hook::ALLOW, &[Listed::Counter]);
    let rent = w.b.balance(&t.source);
    let before = w.b.balance(&w.heir.pubkey());
    w.claim(&t, true, hook::accounts(&t.mint)).expect("claim_token with close_account");
    assert_eq!(amount(&w.b.svm, &t.destination), 1_000);
    assert!(!w.b.exists(&t.source), "the plan's token account is closed");
    assert_eq!(w.b.balance(&w.heir.pubkey()), before + rent - FEE, "its rent went to the heir");
    hook_ran_once_for(&w, &t.mint, 1_000);
}

#[test]
fn a_private_heir_claims_a_hook_mint_with_the_salt_and_only_with_it() {
    let salt = [0x5a; 32];
    let mut w = world_with(Some(salt));
    let t = w.tokens(hook::ALLOW, &[Listed::Counter]);

    // the same claim without the salt, or with another: nobody the plan names
    for wrong in [None, Some([0x5b; 32])] {
        w.salt = wrong;
        assert_eq!(custom(w.claim(&t, true, hook::accounts(&t.mint)).unwrap_err()), err::NOT_AN_HEIR);
        assert_eq!(w.held(&t), (1_000, 0));
    }
    assert_eq!(hook::seen(&w.b.svm, &t.mint).calls, 0, "the hook is not reached before the heir is known");

    w.salt = Some(salt);
    w.claim(&t, true, hook::accounts(&t.mint)).expect("claim_token by a private heir");
    assert_eq!(amount(&w.b.svm, &t.destination), 1_000);
    assert!(!w.b.exists(&t.source));
    hook_ran_once_for(&w, &t.mint, 1_000);
}

#[test]
fn the_contingent_heir_claims_a_hook_mint_once_the_delay_has_passed() {
    let mut w = world();
    let t = w.tokens(hook::ALLOW, &[Listed::Counter]);
    let contingent = w.contingent.insecure_clone();
    let payer = w.b.payer.insecure_clone();
    let destination = ata(&mut w.b.svm, &payer, &T22, &contingent.pubkey(), &t.mint);
    let mut ix = claim_token_ix(&w.plan, &contingent.pubkey(), &t.source, &destination, &t.mint, &T22, None, true);
    ix.accounts.extend(hook::accounts(&t.mint));

    assert_eq!(custom(send_as(&mut w.b.svm, &contingent, &[ix.clone()], &[]).unwrap_err()), err::CONTINGENT_TOO_EARLY);
    assert_eq!(hook::seen(&w.b.svm, &t.mint).calls, 0);
    w.b.advance(YEAR);
    send_as(&mut w.b.svm, &contingent, &[ix], &[]).expect("claim_token by the contingent heir");
    assert_eq!(amount(&w.b.svm, &destination), 1_000);
    hook_ran_once_for(&w, &t.mint, 1_000);
}

#[test]
fn the_order_of_the_hooks_accounts_does_not_matter_and_strangers_are_not_handed_to_the_hook() {
    let mut w = world();
    let t = w.tokens(hook::ALLOW, &[Listed::Counter]);
    let mut extra = hook::accounts(&t.mint);
    extra.reverse();
    extra.insert(1, AccountMeta::new(Keypair::new().pubkey(), false));
    extra.push(AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false));
    w.claim(&t, true, extra).expect("the hook's accounts in another order, among strangers");
    assert_eq!(amount(&w.b.svm, &t.destination), 1_000);
    // the token program picked the hook's accounts out by address; the two strangers went no further
    assert_eq!(hook_ran_once_for(&w, &t.mint, 1_000).accounts, 6);
}

// ---- a hook that refuses ----

#[test]
fn a_hook_that_refuses_fails_the_claim_and_nothing_moves() {
    let mut w = world();
    let t = w.tokens(hook::REFUSE, &[Listed::Counter]);
    w.b.advance(100 * DAY);
    let plan_before = w.b.plan(&w.plan);
    let before = w.b.balance(&w.heir.pubkey());

    for close in [false, true] {
        let e = w.claim(&t, close, hook::accounts(&t.mint)).unwrap_err();
        assert_eq!(custom(e), hook::ERR_REFUSED, "the hook's own error comes back");
        assert_eq!(w.held(&t), (1_000, 0), "no token moved");
        assert!(w.b.exists(&t.source), "and the account was not closed");
    }
    assert_eq!(w.b.plan(&w.plan), plan_before, "the refused claim did not restart the contingent heir's wait");
    assert_eq!(w.b.balance(&w.heir.pubkey()), before - 2 * FEE, "the heir lost two fees and nothing else");
    assert_eq!(hook::seen(&w.b.svm, &t.mint).calls, 0);

    // the same claim goes through once the hook allows it
    hook::set_mode(&mut w.b.svm, &t.mint, hook::ALLOW);
    w.claim(&t, true, hook::accounts(&t.mint)).expect("the hook allows it now");
    assert_eq!(amount(&w.b.svm, &t.destination), 1_000);
    assert_eq!(w.b.plan(&w.plan).contingent_clock_ts, w.b.now(), "and that claim does restart it");
}

#[test]
fn a_hook_that_burns_the_compute_budget_fails_the_same_way() {
    let mut w = world();
    let t = w.tokens(hook::BURN_COMPUTE, &[Listed::Counter]);
    let before = w.b.balance(&w.heir.pubkey());
    let e = w.claim(&t, true, hook::accounts(&t.mint)).unwrap_err();
    assert!(matches!(kind(e), InstructionError::ProgramFailedToComplete | InstructionError::ComputationalBudgetExceeded));
    assert_eq!(w.held(&t), (1_000, 0));
    assert_eq!(w.b.balance(&w.heir.pubkey()), before - FEE);
}

// ---- missing or wrong hook accounts ----

// `NotEnoughAccountKeys` is the name the fixture's own refusal comes back under; the crate has since
// folded it into `MissingAccount` for new code.
#[test]
#[allow(deprecated)]
fn missing_or_wrong_hook_accounts_fail_the_claim_and_nothing_moves() {
    let mut w = world();
    let t = w.tokens(hook::ALLOW, &[Listed::Counter]);
    let other = w.tokens(hook::ALLOW, &[Listed::Counter]);

    let counter = AccountMeta::new(hook::counter_address(&t.mint), false);
    let validation = AccountMeta::new_readonly(hook::validation_address(&t.mint), false);
    let program = AccountMeta::new_readonly(hook::HOOK_PROGRAM_ID, false);
    let stranger = AccountMeta::new(Keypair::new().pubkey(), false);
    let cases: Vec<(&str, Vec<AccountMeta>, InstructionError)> = vec![
        // Token-2022 cannot call a program it was not given
        ("no hook accounts at all", vec![], InstructionError::MissingAccount),
        ("the counter and the validation account, without the hook program", vec![counter.clone(), validation.clone()], InstructionError::MissingAccount),
        // without its validation account the hook is called with the four token accounts only, and refuses
        ("the hook program alone", vec![program.clone()], InstructionError::NotEnoughAccountKeys),
        ("the hook program and the counter, without the validation account", vec![program.clone(), counter.clone()], InstructionError::NotEnoughAccountKeys),
        ("another mint's hook accounts", hook::accounts(&other.mint), InstructionError::NotEnoughAccountKeys),
        // Token-2022 reads the list and does not find what it names
        ("the hook program and the validation account, without the counter", vec![program.clone(), validation.clone()], InstructionError::Custom(hook::ERR_LISTED_ACCOUNT_MISSING)),
        ("a stranger where the counter should be", vec![stranger, validation.clone(), program.clone()], InstructionError::Custom(hook::ERR_LISTED_ACCOUNT_MISSING)),
        // the list wants the counter writable; the transaction did not make it so, and the claim program adds nothing
        ("the counter read-only", vec![AccountMeta::new_readonly(counter.pubkey, false), validation.clone(), program.clone()], InstructionError::PrivilegeEscalation),
    ];
    let plan_before = w.b.plan(&w.plan);
    for (name, extra, expected) in cases {
        for close in [false, true] {
            let before = w.b.balance(&w.heir.pubkey());
            let e = w.claim(&t, close, extra.clone()).expect_err(name);
            assert_eq!(kind(e), expected, "{name}");
            assert_eq!(w.held(&t), (1_000, 0), "{name}: nothing moved");
            assert_eq!(w.b.balance(&w.heir.pubkey()), before - FEE, "{name}: the heir lost the fee and nothing else");
        }
    }
    assert_eq!(w.b.plan(&w.plan), plan_before);
    assert_eq!(hook::seen(&w.b.svm, &t.mint).calls, 0);
    // and with the right ones the claim goes through
    w.claim(&t, true, hook::accounts(&t.mint)).expect("the right accounts");
    assert_eq!(amount(&w.b.svm, &t.destination), 1_000);
}

// ---- nobody's signature reaches a hook through the claim program ----
//
// The heir signs every claim, and whoever pays for a transaction signs all of it, so the heir (and
// the fee payer, when that is somebody else) is a signer in every instruction that names them. A
// mint's owner can write any key into the hook's list and ask for it as a writable signer; a hook
// handed the heir that way could move the heir's SOL, as the price of collecting an inheritance.
// The claim program passes every remaining account on unsigned, so the token program has no
// signature to give a hook but the plan's own, and that one it keeps.
//
// Two layers enforce this. The Token-2022 that LiteSVM 0.17.0 runs (11.0.0) demotes every account of
// a hook's list to a non-signer by itself; the 8.0.1 source the programs are built against passed
// the flag on. The claim program's rule must not depend on which one a cluster runs, so the first
// test reads its call directly, with the fixture standing in for the token program.

/// The four accounts of a transfer as the token program has always been sent them: source and
/// destination writable, the mint read-only, the authority read-only and signed.
const FOUR: [(bool, bool); 4] = [(false, true), (false, false), (false, true), (true, false)];

#[test]
fn the_claim_program_hands_the_token_program_no_signature_but_the_plans() {
    let mut w = world();
    w.b.svm.add_program_from_file(hook::TOKEN_2022, HOOK_SO).expect(BUILD_IT);
    let heir = w.heir.pubkey();
    let second = Keypair::new();
    let mint = Keypair::new().pubkey();
    hook::put_mint(&mut w.b.svm, mint, DECIMALS);
    let source = Keypair::new().pubkey();
    let destination = Keypair::new().pubkey();
    hook::put_token_account(&mut w.b.svm, source, &mint, &w.plan, 1_000);
    hook::put_token_account(&mut w.b.svm, destination, &mint, &heir, 0);
    let t = Tokens { mint, source, destination };

    // nothing after claim_token's own accounts: the call is the one anchor-spl made before
    w.claim(&t, false, vec![]).expect("claim_token's own accounts alone");
    assert_eq!(hook::recorded(&w.b.svm, &source), FOUR);

    // After them: a read-only stranger, a writable one, the heir (who signs the claim and pays for
    // it) marked as a writable signer, and a second key that signed the transaction. Each arrives
    // writable or not as the transaction made it, and none of them signed.
    let extra = vec![
        AccountMeta::new_readonly(Keypair::new().pubkey(), false),
        AccountMeta::new(Keypair::new().pubkey(), false),
        AccountMeta::new(heir, true),
        AccountMeta::new_readonly(second.pubkey(), true),
    ];
    let unsigned = [(false, false), (false, true), (false, true), (false, false)];
    let expected: Vec<(bool, bool)> = FOUR.into_iter().chain(unsigned).collect();
    for close in [false, true] {
        hook::put_token_account(&mut w.b.svm, source, &mint, &w.plan, 1_000);
        w.claim_under(&T22, &t, close, extra.clone(), &[&second]).expect("claim_token");
        assert_eq!(hook::recorded(&w.b.svm, &source), expected, "close_account {close}");
    }

    // a private heir's claim is the same call
    let salt = [9; 32];
    let mut p = world_with(Some(salt));
    p.b.svm.add_program_from_file(hook::TOKEN_2022, HOOK_SO).expect(BUILD_IT);
    hook::put_mint(&mut p.b.svm, mint, DECIMALS);
    hook::put_token_account(&mut p.b.svm, source, &mint, &p.plan, 1_000);
    hook::put_token_account(&mut p.b.svm, destination, &mint, &p.heir.pubkey(), 0);
    let mut extra = extra;
    extra[2] = AccountMeta::new(p.heir.pubkey(), true);
    p.claim_under(&T22, &t, false, extra, &[&second]).expect("claim_token by a private heir");
    assert_eq!(hook::recorded(&p.b.svm, &source), expected, "a private heir");
}

/// A hook mint whose hook steals from `victim`: the list names the counter, the victim as a
/// writable signer, and the System Program.
fn thief_tokens(w: &mut World, victim: &Pubkey) -> Tokens {
    w.tokens(hook::STEAL, &[Listed::Counter, Listed::Fixed { key: *victim, signer: true, writable: true }, Listed::Fixed { key: SYSTEM_PROGRAM_ID, signer: false, writable: false }])
}

/// What a client that follows the hook's list to the letter would append: the hook's accounts,
/// the victim as a writable signer, the System Program.
fn thief_accounts(mint: &Pubkey, victim: &Pubkey) -> Vec<AccountMeta> {
    let mut metas = hook::accounts(mint);
    metas.push(AccountMeta::new(*victim, true));
    metas.push(AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false));
    metas
}

#[test]
fn the_fixtures_thief_steals_when_it_is_handed_a_signature() {
    // The control for the tests below: called directly, with its victim's signature on the
    // transaction, the hook takes the victim's SOL.
    let mut w = world();
    let victim = Keypair::new();
    w.b.fund(&victim.pubkey(), 5 * SOL);
    let payer = w.b.payer.insecure_clone();
    let mint = hook_mint(&mut w.b.svm, &payer, hook::STEAL, &[Listed::Counter]);
    let mut data = hook::EXECUTE.to_vec();
    data.extend_from_slice(&1u64.to_le_bytes());
    let any = AccountMeta::new_readonly(Keypair::new().pubkey(), false);
    let ix = Instruction {
        program_id: hook::HOOK_PROGRAM_ID,
        accounts: vec![
            any.clone(),
            AccountMeta::new_readonly(mint, false),
            any.clone(),
            any,
            AccountMeta::new_readonly(hook::validation_address(&mint), false),
            AccountMeta::new(hook::counter_address(&mint), false),
            AccountMeta::new(victim.pubkey(), true),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
        ],
        data,
    };
    w.b.send(&[ix], &[&victim]).expect("the thief, given a signature");
    assert_eq!(w.b.balance(&victim.pubkey()), 5 * SOL - hook::TAKE_LAMPORTS);
}

#[test]
fn a_hook_whose_list_names_the_heir_as_a_signer_cannot_take_the_heirs_sol() {
    for salt in [None, Some([7u8; 32])] {
        let mut w = world_with(salt);
        let heir = w.heir.pubkey();
        let t = thief_tokens(&mut w, &heir);
        let counter_lamports = w.b.balance(&hook::counter_address(&t.mint));
        let plan_before = w.b.plan(&w.plan);
        for close in [false, true] {
            // the heir signs the claim, pays for it, and is there once more among the remaining
            // accounts, marked as a writable signer
            let before = w.b.balance(&heir);
            let e = w.claim(&t, close, thief_accounts(&t.mint, &heir)).unwrap_err();
            assert_eq!(kind(e), InstructionError::PrivilegeEscalation, "the hook asked the System Program for a signature it does not have");
            assert_eq!(w.b.balance(&heir), before - FEE, "the heir lost the fee and nothing else");
            assert_eq!(w.b.balance(&hook::counter_address(&t.mint)), counter_lamports, "the hook got nothing");
            assert_eq!(w.held(&t), (1_000, 0), "no token moved");
        }
        assert_eq!(w.b.plan(&w.plan), plan_before);

        // left out of the accounts, the heir is simply missing from what the list names
        let mut extra = hook::accounts(&t.mint);
        extra.push(AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false));
        assert_eq!(custom(w.claim(&t, true, extra).unwrap_err()), hook::ERR_LISTED_ACCOUNT_MISSING);
        assert_eq!(w.held(&t), (1_000, 0));
    }
}

#[test]
fn someone_who_pays_for_an_heirs_claim_keeps_their_sol_too() {
    // the heir signs; a helper pays the fee, and the hook's list names the helper
    let mut w = world();
    let helper = w.b.payer.insecure_clone();
    let t = thief_tokens(&mut w, &helper.pubkey());
    let mut ix = claim_token_ix(&w.plan, &w.heir.pubkey(), &t.source, &t.destination, &t.mint, &T22, None, true);
    ix.accounts.extend(thief_accounts(&t.mint, &helper.pubkey()));
    let heir = w.heir.insecure_clone();
    let (helper_before, heir_before) = (w.b.balance(&helper.pubkey()), w.b.balance(&heir.pubkey()));
    let e = w.b.send(&[ix], &[&heir]).unwrap_err();
    assert_eq!(kind(e), InstructionError::PrivilegeEscalation);
    assert_eq!(w.b.balance(&helper.pubkey()), helper_before - 2 * FEE, "the helper paid for two signatures and nothing else");
    assert_eq!(w.b.balance(&heir.pubkey()), heir_before);
    assert_eq!(w.held(&t), (1_000, 0));
}

#[test]
fn a_signer_among_the_remaining_accounts_reaches_the_hook_unsigned() {
    // The hook's list names the heir, asked for as a writable signer, and a second signer of the
    // transaction, asked for as neither. Both are passed as signers among the remaining accounts.
    // This hook steals nothing; it only looks. The fixture refuses any transfer in which an account
    // reaches it as a signer, so the claim going through is the hook itself saying that none did.
    //
    // (That it goes through at all when the list asks for a signature is Token-2022 11.0.0
    // demoting the entry; a release that passed the flag on would fail here with
    // PrivilegeEscalation, having been given no signature to pass. Either way none arrives.)
    let mut w = world();
    let heir = w.heir.pubkey();
    let second = Keypair::new();
    let t = w.tokens(
        hook::ALLOW,
        &[Listed::Counter, Listed::Fixed { key: heir, signer: true, writable: true }, Listed::Fixed { key: second.pubkey(), signer: false, writable: false }],
    );
    let mut extra = hook::accounts(&t.mint);
    extra.push(AccountMeta::new(heir, true));
    extra.push(AccountMeta::new_readonly(second.pubkey(), true));
    let before = w.b.balance(&heir);
    w.claim_under(&T22, &t, false, extra, &[&second]).expect("the claim goes through: no signer reached the hook");
    assert_eq!(w.held(&t), (0, 1_000));
    assert_eq!(w.b.balance(&heir), before - 2 * FEE, "two signatures' fee and nothing else");
    let seen = hook_ran_once_for(&w, &t.mint, 1_000);
    assert_eq!(seen.accounts, 8, "the six, then the two listed keys");
    assert_eq!(seen.after_counter, Some((false, true)), "the heir: there, writable as listed, unsigned");
}

#[test]
fn the_plans_own_signature_stops_at_the_token_program() {
    // The hook's list names the plan itself, as a writable signer. The token program was given the
    // plan's signature for the authority; it hands the hook the authority unsigned and read-only,
    // and the same account again from the list no differently.
    let mut w = world();
    let plan = w.plan;
    let t = w.tokens(hook::ALLOW, &[Listed::Counter, Listed::Fixed { key: plan, signer: true, writable: true }]);
    let mut extra = hook::accounts(&t.mint);
    extra.push(AccountMeta::new(plan, false));
    w.claim(&t, true, extra).expect("the claim goes through: the hook saw no signer");
    assert_eq!(amount(&w.b.svm, &t.destination), 1_000);
    let seen = hook_ran_once_for(&w, &t.mint, 1_000);
    assert_eq!(seen.accounts, 7);
    assert_eq!(seen.after_counter, Some((false, false)), "the plan, from the list: unsigned and read-only");
}

#[test]
fn a_hook_cannot_call_back_into_the_claim_program() {
    // The hook's list names the claim program, and the hook invokes it. The runtime refuses to
    // enter a program that is already further up the call stack, so nothing a hook does during a
    // claim can reach `init_plan`, `activate` or another claim.
    let mut w = world();
    let t = w.tokens(hook::CALL_BACK, &[Listed::Counter, Listed::Fixed { key: CLAIM_PROGRAM_ID, signer: false, writable: false }]);
    let mut extra = hook::accounts(&t.mint);
    extra.push(AccountMeta::new_readonly(CLAIM_PROGRAM_ID, false));
    let e = w.claim(&t, true, extra).unwrap_err();
    assert_eq!(kind(e), InstructionError::ReentrancyNotAllowed);
    assert_eq!(w.held(&t), (1_000, 0));
    // the same hook, calling a program that is not on the stack (the Memo program, which takes an
    // empty memo), is let through: the refusal above was the runtime's
    let memo = Pubkey::from_str_const("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
    let t = w.tokens(hook::CALL_BACK, &[Listed::Counter, Listed::Fixed { key: memo, signer: false, writable: false }]);
    let mut extra = hook::accounts(&t.mint);
    extra.push(AccountMeta::new_readonly(memo, false));
    w.claim(&t, true, extra).expect("a call to a program that is not on the stack");
    assert_eq!(amount(&w.b.svm, &t.destination), 1_000);
}

// ---- mints without a hook ----

/// Accounts nobody needs: a stranger (writable), a hook's accounts for a mint that has no hook,
/// the System Program, and the heir marked as a signer.
fn junk(w: &World, mint: &Pubkey) -> Vec<AccountMeta> {
    let mut metas = vec![AccountMeta::new(Keypair::new().pubkey(), false)];
    metas.extend(hook::accounts(mint));
    metas.push(AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false));
    metas.push(AccountMeta::new(w.heir.pubkey(), true));
    metas
}

#[test]
fn mints_without_a_hook_are_claimed_as_before_with_or_without_accounts_nobody_needs() {
    let mut w = world();
    let payer = w.b.payer.insecure_clone();
    let authority = payer.pubkey();
    for (name, program, extensions, has_hook_extension) in [
        ("SPL Token", TOKEN_PROGRAM_ID, vec![], false),
        ("Token-2022", T22, vec![], false),
        // the extension is there, but no program is set: nothing to call
        ("Token-2022, hook extension with no program", T22, vec![ExtensionType::TransferHook], true),
    ] {
        for with_junk in [false, true] {
            let mint = mint(&mut w.b.svm, &payer, &program, &extensions, |mint| {
                if has_hook_extension {
                    vec![t22::extension::transfer_hook::instruction::initialize(&T22, mint, Some(authority), None).unwrap()]
                } else {
                    vec![]
                }
            });
            let t = w.holding(&program, mint);
            let rent = w.b.balance(&t.source);
            let before = w.b.balance(&w.heir.pubkey());
            let extra = if with_junk { junk(&w, &mint) } else { vec![] };
            w.claim_under(&program, &t, true, extra, &[]).unwrap_or_else(|e| panic!("{name}, junk {with_junk}: {e:?}"));
            assert_eq!(amount(&w.b.svm, &t.destination), 1_000, "{name}");
            assert!(!w.b.exists(&t.source), "{name}: the plan's token account is closed");
            assert_eq!(w.b.balance(&w.heir.pubkey()), before + rent - FEE, "{name}: its rent went to the heir");
        }
    }
}

// ---- both real programs ----

#[test]
fn a_hook_mint_in_a_real_vault_is_released_swept_into_the_plan_and_claimed() {
    // The Heir-enabled vault program itself, a real LMS-armed vault holding a hook mint, the release
    // after 90 and 30 days, a stranger's sweep into the plan, and the heir's claim: the hook runs
    // twice, once under each program, and is handed nobody's signature either time.
    let mut b = vault::Bench::new();
    b.svm.add_program_from_file(CLAIM_PROGRAM_ID, SO).expect("build the claim program first: node tools/scripts/build-programs.mjs");
    b.svm.add_program_from_file(hook::HOOK_PROGRAM_ID, HOOK_SO).expect(BUILD_IT);
    let heir = Keypair::new();
    b.svm.airdrop(&heir.pubkey(), SOL).unwrap();
    let terms = Terms { vault: b.vault, primary: HeirRef::address(&heir.pubkey()), contingent: HeirRef::none(), contingent_delay_secs: 0 };
    let plan = terms.plan();
    let payer = b.payer.insecure_clone();
    b.send(&[init_plan_ix(&payer.pubkey(), &terms, &[heir.pubkey()])], &[&heir]).expect("init_plan against a real vault");

    let mint = hook_mint(&mut b.svm, &payer, hook::ALLOW, &[Listed::Counter]);
    let vault_address = b.vault;
    let vault_tokens = ata(&mut b.svm, &payer, &T22, &vault_address, &mint);
    mint_to(&mut b.svm, &payer, &T22, &mint, &vault_tokens, 250_000);

    let succession = vault::Plan { claim: plan, window_secs: 90 * 86_400, wait_secs: 30 * 86_400, checkin_key: Pubkey::default(), contact_key: Pubkey::default() };
    b.set_plan(&succession).expect("the vault accepts the plan as its claim address");
    b.advance(90 * DAY + 1);
    b.start().expect("start_succession");
    b.advance(30 * DAY);
    b.execute(&plan, &[]).expect("execute_succession");
    b.send(&[activate_ix(&plan, &vault_address)], &[]).expect("activate");

    // a stranger sweeps the hook mint to the plan's own token account, with the hook's accounts
    let plan_tokens = ata_of(&T22, &plan, &mint);
    let mut sweep = vault::sweep_closed_ix(&payer.pubkey(), &vault_address, &plan, &vault_tokens, &mint, &T22);
    assert!(b.send(&[sweep.clone()], &[]).is_err(), "not without them");
    sweep.accounts.extend(hook::accounts(&mint));
    b.send(&[sweep], &[]).expect("sweep_closed of a hook mint to a plan");
    assert_eq!(amount(&b.svm, &plan_tokens), 250_000);
    let seen = hook::seen(&b.svm, &mint);
    assert_eq!((seen.calls, seen.authority, seen.signers), (1, vault_address, 0));

    // the heir collects it
    let heir_tokens = ata(&mut b.svm, &payer, &T22, &heir.pubkey(), &mint);
    let mut claim = claim_token_ix(&plan, &heir.pubkey(), &plan_tokens, &heir_tokens, &mint, &T22, None, true);
    claim.accounts.extend(hook::accounts(&mint));
    send_as(&mut b.svm, &heir, &[claim], &[]).expect("claim_token of a hook mint");
    assert_eq!(amount(&b.svm, &heir_tokens), 250_000);
    assert!(b.account(&plan_tokens).is_none(), "the plan's token account is closed");
    let seen = hook::seen(&b.svm, &mint);
    assert_eq!((seen.calls, seen.amount, seen.authority, seen.signers), (2, 250_000, plan, 0));
}
