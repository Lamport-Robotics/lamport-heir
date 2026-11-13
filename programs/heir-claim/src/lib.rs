//! # heir-claim
//!
//! Holds what a Lamport Vault releases, for the heirs its owner named.
//!
//! A vault's succession names one address. When the vault releases, that address receives its SOL
//! and becomes the only place its tokens can be swept to. Naming a [`Plan`] account of this program
//! as that address adds what a plain address cannot give: a contingent heir, who may claim if the
//! primary heir does not.
//!
//! There is no admin, authority, pause or fee anywhere in this program. A plan's terms are fixed by
//! its address. Funds leave a plan in exactly two ways, `claim_sol` and `claim_token`, each signed
//! by an heir the terms name, and only after the vault's own tombstone says it released to the plan.

#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::ID as INSTRUCTIONS_SYSVAR_ID;
use anchor_spl::token_interface::{self, CloseAccount, TransferChecked};

pub mod error;
pub mod proof;
pub mod state;
pub mod tombstone;

pub use error::ClaimError;
pub use state::{heir_commitment, HeirRef, Plan, Terms, DAY_SECS, HEIR_DOMAIN, MAX_CONTINGENT_DELAY_SECS, MIN_CONTINGENT_DELAY_SECS, PLAN_SEED, TERMS_DOMAIN};

// Placeholder ids with no private key (docs/program-ids.md). Local tests load the program at them.
#[cfg(not(feature = "short-clocks"))]
declare_id!("2SbWfdn3N5LqZz4nwcJuUkD9DhPDJyMusSNqyWaUWUDd");
// The `short-clocks` test build is a different program: its own id, and its own vault program.
#[cfg(feature = "short-clocks")]
declare_id!("HzoHmRyCtxv8nd9u9NpnLTJcJssGJvyvbjeWBY7BMXPD");

/// The Heir-enabled vault program: the only program whose tombstones `activate` believes.
/// Placeholder id with no private key until the program is deployed (docs/program-ids.md).
#[cfg(not(feature = "short-clocks"))]
pub const VAULT_PROGRAM_ID: Pubkey = pubkey!("HK1QPbqjkozJHB74QuGaduYzAtqBe9hry3nV64LmpCsb");
/// The vault's `short-clocks` test build: the only vault program this test build believes.
#[cfg(feature = "short-clocks")]
pub const VAULT_PROGRAM_ID: Pubkey = pubkey!("DGe6SeUVApXcN7j3X613SeTmazXGqtAuFSn7RQWBiDDS");

fn is_token_program(key: &Pubkey) -> bool {
    *key == anchor_spl::token::ID || *key == anchor_spl::token_2022::ID
}

// Token and Token-2022 share their base layouts: a Mint is 82 bytes with `decimals` at 44 and
// `is_initialized` at 45; an Account is 165 bytes with `mint` at 0..32, `owner` at 32..64, `amount`
// at 64..72 and `state` at 108. Token-2022 appends an account-type byte at 165 (1 = Mint,
// 2 = Account) before any extensions. The fields are read directly, as lamport-vault does, which
// keeps extension parsing out of the program; the token program validates both accounts again in
// the CPI that follows.
const MINT_LEN: usize = 82;
const TOKEN_ACCOUNT_LEN: usize = 165;

/// `decimals` of an initialized Token / Token-2022 mint.
fn mint_decimals(ai: &AccountInfo) -> Result<u8> {
    let data = ai.try_borrow_data()?;
    let shape_ok = data.len() == MINT_LEN || (data.len() > TOKEN_ACCOUNT_LEN && data[TOKEN_ACCOUNT_LEN] == 1);
    require!(shape_ok && data[45] == 1, ErrorCode::AccountDidNotDeserialize);
    Ok(data[44])
}

/// `(mint, owner, amount)` of an initialized Token / Token-2022 token account.
fn token_account_fields(ai: &AccountInfo) -> Result<(Pubkey, Pubkey, u64)> {
    let data = ai.try_borrow_data()?;
    let shape_ok = data.len() == TOKEN_ACCOUNT_LEN || (data.len() > TOKEN_ACCOUNT_LEN && data[TOKEN_ACCOUNT_LEN] == 2);
    require!(shape_ok && data[108] != 0, ErrorCode::AccountDidNotDeserialize);
    let mint = Pubkey::new_from_array(data[..32].try_into().unwrap());
    let owner = Pubkey::new_from_array(data[32..64].try_into().unwrap());
    let amount = u64::from_le_bytes(data[64..72].try_into().unwrap());
    Ok((mint, owner, amount))
}

/// Who is claiming.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    /// The primary heir: may claim from activation on.
    Primary,
    /// The contingent heir: may claim once the primary has not claimed for the contingent delay.
    Contingent,
}

/// Decides whether `signer` may claim from `plan` at `now`, and as whom. Pure.
///
/// The primary heir may always claim. The contingent heir may claim once
/// `now >= contingent_clock_ts + contingent_delay_secs`, where the clock starts at activation and
/// restarts every time the primary claims: a primary who is still claiming keeps the contingent
/// heir out, and a primary who stops leaves the rest to the contingent heir after the delay.
pub fn claim_role(plan: &Plan, signer: &Pubkey, salt: Option<&[u8; 32]>, now: i64) -> Result<Role> {
    require!(plan.activated, ClaimError::NotActivated);
    if plan.terms.primary.matches(signer, salt) {
        return Ok(Role::Primary);
    }
    if plan.terms.contingent.matches(signer, salt) {
        require!(now >= plan.contingent_opens_at()?, ClaimError::ContingentTooEarly);
        return Ok(Role::Contingent);
    }
    err!(ClaimError::NotAnHeir)
}

/// The role check, and the bookkeeping that follows from it.
fn authorize(plan: &mut Plan, signer: &Pubkey, salt: Option<&[u8; 32]>) -> Result<Role> {
    let now = Clock::get()?.unix_timestamp;
    let role = claim_role(plan, signer, salt, now)?;
    if role == Role::Primary {
        plan.contingent_clock_ts = now;
    }
    Ok(role)
}

#[program]
pub mod heir_claim {
    use super::*;

    /// Creates the plan for `terms`. Anyone may pay; nobody controls the plan afterwards.
    ///
    /// `terms_hash` must equal `terms.hash()`. It is passed on its own so the PDA seed is a plain
    /// argument that an IDL can describe.
    ///
    /// The vault in the terms must be an open vault of the Heir-enabled vault program, which catches
    /// a mistyped address before anything depends on it. One other state is accepted: a vault that
    /// has already released to this very plan. Its owner signed for this address, and only these
    /// terms produce it, so creating the plan late gives nobody anything the owner did not sign
    /// for. Without it, a vault armed to a plan that was never created would release to an address
    /// that could never be claimed from.
    ///
    /// Every heir named by address must prove control (see [`proof`]): by signing this transaction
    /// (as the payer, or as any remaining account), or with an Ed25519 program instruction in this
    /// transaction over [`proof::acceptance_message`] for this plan. Hashed heirs prove nothing here.
    pub fn init_plan(ctx: Context<InitPlan>, terms_hash: [u8; 32], terms: Terms) -> Result<()> {
        terms.validate()?;
        require!(terms_hash == terms.hash(), ClaimError::TermsHashMismatch);
        require_keys_eq!(ctx.accounts.vault.key(), terms.vault, ClaimError::WrongVault);
        let plan_key = ctx.accounts.plan.key();
        let released_to_this_plan = tombstone::read(&ctx.accounts.vault).is_ok_and(|t| t.heir == plan_key);
        require!(tombstone::is_live_vault(&ctx.accounts.vault) || released_to_this_plan, ClaimError::NotALiveVault);

        for heir in [&terms.primary, &terms.contingent] {
            let Some(address) = heir.as_address() else { continue };
            let signed_this_transaction = ctx.accounts.payer.key() == address
                || ctx.remaining_accounts.iter().any(|a| a.is_signer && a.key() == address);
            let proven = signed_this_transaction || proof::transaction_proves(&ctx.accounts.instructions, &address, &plan_key)?;
            require!(proven, ClaimError::HeirNotProven);
        }

        let plan = &mut ctx.accounts.plan;
        plan.version = Plan::VERSION;
        plan.bump = ctx.bumps.plan;
        plan.terms_hash = terms_hash;
        plan.terms = terms;
        plan.created_ts = Clock::get()?.unix_timestamp;
        plan.activated = false;
        plan.activated_ts = 0;
        plan.closed_slot = 0;
        plan.contingent_clock_ts = 0;
        Ok(())
    }

    /// Records that the vault has released to this plan. Anyone may call it.
    ///
    /// It believes one thing only: a tombstone at the vault's address, owned by the Heir-enabled
    /// vault program, whose `heir` is this plan. The contingent delay counts from the moment this
    /// runs (a tombstone holds a slot, not a time). Calling it again changes nothing.
    pub fn activate(ctx: Context<Activate>) -> Result<()> {
        let plan = &mut ctx.accounts.plan;
        let tomb = tombstone::read(&ctx.accounts.vault)?;
        require_keys_eq!(tomb.heir, plan.key(), ClaimError::TombstoneNamesAnother);
        if plan.activated {
            return Ok(());
        }
        let now = Clock::get()?.unix_timestamp;
        plan.activated = true;
        plan.activated_ts = now;
        plan.closed_slot = tomb.closed_slot;
        plan.contingent_clock_ts = now;
        Ok(())
    }

    /// Sends every lamport the plan holds above its own rent to the claiming heir.
    ///
    /// `heir` signs: the primary heir at any time after activation, the contingent heir once the
    /// primary has not claimed for the contingent delay. A hashed heir passes the `salt` it was
    /// committed with. The plan keeps its rent and stays open, so SOL that arrives later can be
    /// claimed the same way.
    pub fn claim_sol(ctx: Context<ClaimSol>, salt: Option<[u8; 32]>) -> Result<()> {
        let heir_key = ctx.accounts.heir.key();
        authorize(&mut ctx.accounts.plan, &heir_key, salt.as_ref())?;

        let plan_ai = ctx.accounts.plan.to_account_info();
        let keep = Rent::get()?.minimum_balance(plan_ai.data_len());
        let amount = plan_ai.lamports().saturating_sub(keep);
        require!(amount > 0, ClaimError::NothingToClaim);
        plan_ai.sub_lamports(amount)?;
        ctx.accounts.heir.to_account_info().add_lamports(amount)?;
        Ok(())
    }

    /// Sends the whole balance of one token account the plan owns to a token account the claiming
    /// heir owns, and, when `close_account` is set, closes the plan's account, its rent to the heir.
    ///
    /// Signing rules as for `claim_sol`. Token and Token-2022. Accounts after the named ones go to
    /// the token program as they are: a mint with a transfer hook needs its hook program and extra
    /// accounts there.
    ///
    /// `close_account` is the caller's choice because some accounts cannot be closed yet (a
    /// Token-2022 account holding withheld transfer fees must be harvested first). The tokens can
    /// always be claimed with it unset, and the empty account closed by a later call.
    pub fn claim_token<'info>(
        ctx: Context<'_, '_, 'info, 'info, ClaimToken<'info>>,
        salt: Option<[u8; 32]>,
        close_account: bool,
    ) -> Result<()> {
        let heir_key = ctx.accounts.heir.key();
        authorize(&mut ctx.accounts.plan, &heir_key, salt.as_ref())?;

        let plan = &ctx.accounts.plan;
        let token_program = &ctx.accounts.token_program;
        let mint_ai = &ctx.accounts.mint;
        let source = &ctx.accounts.plan_token_account;
        let destination = &ctx.accounts.destination;

        require!(is_token_program(token_program.key), ClaimError::InvalidTokenProgram);
        require_keys_eq!(*mint_ai.owner, token_program.key(), ClaimError::InvalidTokenProgram);
        require_keys_eq!(*source.owner, token_program.key(), ClaimError::InvalidTokenProgram);
        require_keys_eq!(*destination.owner, token_program.key(), ClaimError::InvalidTokenProgram);
        let (source_mint, source_owner, amount) = token_account_fields(source)?;
        require_keys_eq!(source_owner, plan.key(), ClaimError::NotPlanTokenAccount);
        require_keys_eq!(source_mint, mint_ai.key(), ClaimError::WrongMint);
        let (destination_mint, destination_owner, _) = token_account_fields(destination)?;
        require_keys_eq!(destination_mint, mint_ai.key(), ClaimError::WrongMint);
        require_keys_eq!(destination_owner, heir_key, ClaimError::DestinationNotHeirs);
        require!(amount > 0 || close_account, ClaimError::NothingToClaim);

        let signer_seeds: &[&[u8]] = &[PLAN_SEED, &plan.terms_hash, &[plan.bump]];
        if amount > 0 {
            let decimals = mint_decimals(mint_ai)?;
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    token_program.to_account_info(),
                    TransferChecked {
                        from: source.to_account_info(),
                        mint: mint_ai.to_account_info(),
                        to: destination.to_account_info(),
                        authority: plan.to_account_info(),
                    },
                    &[signer_seeds],
                )
                .with_remaining_accounts(ctx.remaining_accounts.to_vec()),
                amount,
                decimals,
            )?;
        }
        if close_account {
            token_interface::close_account(CpiContext::new_with_signer(
                token_program.to_account_info(),
                CloseAccount {
                    account: source.to_account_info(),
                    destination: ctx.accounts.heir.to_account_info(),
                    authority: plan.to_account_info(),
                },
                &[signer_seeds],
            ))?;
        }
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(terms_hash: [u8; 32])]
pub struct InitPlan<'info> {
    /// Pays the plan's rent. Counts as a proof of control if it is itself an heir.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = Plan::SPACE,
        seeds = [PLAN_SEED, terms_hash.as_ref()],
        bump,
    )]
    pub plan: Account<'info, Plan>,
    /// CHECK: must be `terms.vault` and an open vault of the Heir-enabled vault program; checked in the handler.
    pub vault: UncheckedAccount<'info>,
    /// CHECK: the instructions sysvar, read for Ed25519 proofs of control.
    #[account(address = INSTRUCTIONS_SYSVAR_ID @ ClaimError::WrongInstructionsSysvar)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Activate<'info> {
    #[account(mut)]
    pub plan: Account<'info, Plan>,
    /// CHECK: the vault the plan names; the handler believes it only as a tombstone owned by the vault program.
    #[account(address = plan.terms.vault @ ClaimError::WrongVault)]
    pub vault: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ClaimSol<'info> {
    #[account(mut)]
    pub plan: Account<'info, Plan>,
    /// The claiming heir; receives the lamports. The fee payer may be someone else.
    #[account(mut)]
    pub heir: Signer<'info>,
}

/// Accounts of `claim_token`. The token accounts are unchecked here and validated in the handler
/// (owner program, owner, mint), as in lamport-vault's `sweep_closed`; the token program validates
/// everything again in the CPIs.
#[derive(Accounts)]
pub struct ClaimToken<'info> {
    #[account(mut)]
    pub plan: Account<'info, Plan>,
    /// The claiming heir; receives the closed account's rent. The fee payer may be someone else.
    #[account(mut)]
    pub heir: Signer<'info>,
    /// CHECK: a token account owned by the plan, for `mint`; emptied, and closed if asked.
    #[account(mut)]
    pub plan_token_account: UncheckedAccount<'info>,
    /// CHECK: a token account owned by the claiming heir, for `mint`.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    /// CHECK: the mint, owned by `token_program`.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: Token or Token-2022.
    pub token_program: UncheckedAccount<'info>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::error::ERROR_CODE_OFFSET;

    fn code<T: core::fmt::Debug>(r: Result<T>) -> u32 {
        match r.expect_err("expected an error") {
            anchor_lang::error::Error::AnchorError(a) => a.error_code_number,
            anchor_lang::error::Error::ProgramError(_) => u32::MAX,
        }
    }

    const fn claim_err(e: ClaimError) -> u32 {
        e as u32 + ERROR_CODE_OFFSET
    }

    const DAY: u64 = DAY_SECS;

    fn terms(primary: HeirRef, contingent: HeirRef, delay: u64) -> Terms {
        Terms { vault: Pubkey::new_from_array([1; 32]), primary, contingent, contingent_delay_secs: delay }
    }

    fn plan(t: Terms) -> Plan {
        Plan {
            version: Plan::VERSION,
            bump: 255,
            terms_hash: t.hash(),
            terms: t,
            created_ts: 0,
            activated: true,
            activated_ts: 1_000,
            closed_slot: 7,
            contingent_clock_ts: 1_000,
        }
    }

    #[test]
    fn sizes() {
        assert_eq!(HeirRef::LEN, 33);
        assert_eq!(Terms::LEN, 106);
        assert_eq!(Plan::SPACE, 181);
        let t = terms(HeirRef::address(&Pubkey::new_from_array([2; 32])), HeirRef::none(), 0);
        let mut bytes = Vec::new();
        t.serialize(&mut bytes).unwrap();
        assert_eq!(bytes.len(), Terms::LEN, "every HeirRef kind has the same size");
        let mut whole = Vec::new();
        plan(t).serialize(&mut whole).unwrap();
        assert_eq!(8 + whole.len(), Plan::SPACE);
    }

    #[test]
    fn terms_hash_binds_every_field() {
        let a = Pubkey::new_from_array([2; 32]);
        let b = Pubkey::new_from_array([3; 32]);
        let base = terms(HeirRef::address(&a), HeirRef::address(&b), 365 * DAY);
        let h = base.hash();
        assert_eq!(h, base.clone().hash(), "deterministic");
        let mut t = base.clone();
        t.vault = Pubkey::new_from_array([9; 32]);
        assert_ne!(t.hash(), h, "vault");
        let mut t = base.clone();
        t.primary = HeirRef::address(&b);
        t.contingent = HeirRef::address(&a);
        assert_ne!(t.hash(), h, "heirs swapped");
        let mut t = base.clone();
        t.contingent_delay_secs += 1;
        assert_ne!(t.hash(), h, "delay");
        let mut t = base.clone();
        t.primary = HeirRef::hashed(a.to_bytes());
        assert_ne!(t.hash(), h, "kind");
        // the formula, spelled out
        let mut bytes = Vec::new();
        base.serialize(&mut bytes).unwrap();
        assert_eq!(h, solana_sha256_hasher::hashv(&[b"lamport-heir/plan/v1", &bytes]).to_bytes());
    }

    #[test]
    fn terms_rules() {
        let a = Pubkey::new_from_array([2; 32]);
        let b = Pubkey::new_from_array([3; 32]);
        assert!(terms(HeirRef::address(&a), HeirRef::none(), 0).validate().is_ok());
        assert!(terms(HeirRef::address(&a), HeirRef::address(&b), 30 * DAY).validate().is_ok());
        assert!(terms(HeirRef::hashed([5; 32]), HeirRef::hashed([6; 32]), 365 * DAY).validate().is_ok());
        assert!(terms(HeirRef::address(&a), HeirRef::address(&b), MAX_CONTINGENT_DELAY_SECS).validate().is_ok());

        let invalid = claim_err(ClaimError::InvalidTerms);
        let delay = claim_err(ClaimError::InvalidContingentDelay);
        assert_eq!(code(terms(HeirRef::none(), HeirRef::none(), 0).validate()), invalid, "no primary heir");
        assert_eq!(code(terms(HeirRef { kind: 3, value: [1; 32] }, HeirRef::none(), 0).validate()), invalid, "unknown kind");
        assert_eq!(code(terms(HeirRef::address(&a), HeirRef { kind: 9, value: [1; 32] }, 30 * DAY).validate()), invalid);
        assert_eq!(code(terms(HeirRef::address(&Pubkey::default()), HeirRef::none(), 0).validate()), invalid, "the default address");
        assert_eq!(code(terms(HeirRef::address(&a), HeirRef::address(&Pubkey::default()), 30 * DAY).validate()), invalid);
        assert_eq!(code(terms(HeirRef::address(&a), HeirRef { kind: 0, value: [1; 32] }, 0).validate()), invalid, "one encoding of none");
        let mut no_vault = terms(HeirRef::address(&a), HeirRef::none(), 0);
        no_vault.vault = Pubkey::default();
        assert_eq!(code(no_vault.validate()), invalid);

        assert_eq!(code(terms(HeirRef::address(&a), HeirRef::none(), 1).validate()), delay, "a delay with nobody to wait");
        assert_eq!(code(terms(HeirRef::address(&a), HeirRef::address(&b), 0).validate()), delay);
        assert_eq!(code(terms(HeirRef::address(&a), HeirRef::address(&b), 30 * DAY - 1).validate()), delay);
        assert_eq!(code(terms(HeirRef::address(&a), HeirRef::address(&b), MAX_CONTINGENT_DELAY_SECS + 1).validate()), delay);
        assert_eq!(code(terms(HeirRef::address(&a), HeirRef::address(&a), 30 * DAY).validate()), claim_err(ClaimError::SameHeirTwice));
    }

    #[test]
    fn hashed_heir_needs_its_salt() {
        let heir = Pubkey::new_from_array([7; 32]);
        let salt = [4u8; 32];
        let r = HeirRef::hashed(heir_commitment(&salt, &heir));
        assert!(r.matches(&heir, Some(&salt)));
        assert!(!r.matches(&heir, None), "no salt");
        assert!(!r.matches(&heir, Some(&[5; 32])), "another salt");
        assert!(!r.matches(&Pubkey::new_from_array([8; 32]), Some(&salt)), "another signer");
        assert_eq!(heir_commitment(&salt, &heir), solana_sha256_hasher::hashv(&[b"lamport-heir/heir/v1", &salt, heir.as_ref()]).to_bytes());
        // an address heir ignores a salt; none matches nobody
        assert!(HeirRef::address(&heir).matches(&heir, Some(&salt)));
        assert!(!HeirRef::none().matches(&Pubkey::default(), None));
        assert!(r.as_address().is_none() && HeirRef::none().as_address().is_none());
        assert_eq!(HeirRef::address(&heir).as_address(), Some(heir));
    }

    #[test]
    fn who_may_claim_and_when() {
        let primary = Pubkey::new_from_array([2; 32]);
        let contingent = Pubkey::new_from_array([3; 32]);
        let stranger = Pubkey::new_from_array([4; 32]);
        let p = plan(terms(HeirRef::address(&primary), HeirRef::address(&contingent), 365 * DAY));
        let opens = 1_000 + 365 * DAY as i64;

        assert_eq!(claim_role(&p, &primary, None, 1_000).unwrap(), Role::Primary);
        assert_eq!(claim_role(&p, &primary, None, opens + 10).unwrap(), Role::Primary, "the primary is never shut out");
        assert_eq!(code(claim_role(&p, &contingent, None, 1_000)), claim_err(ClaimError::ContingentTooEarly));
        assert_eq!(code(claim_role(&p, &contingent, None, opens - 1)), claim_err(ClaimError::ContingentTooEarly));
        assert_eq!(claim_role(&p, &contingent, None, opens).unwrap(), Role::Contingent);
        for t in [1_000, opens, i64::MAX] {
            assert_eq!(code(claim_role(&p, &stranger, None, t)), claim_err(ClaimError::NotAnHeir));
            assert_eq!(code(claim_role(&p, &p.terms.vault, None, t)), claim_err(ClaimError::NotAnHeir));
        }

        // not activated: nobody
        let mut closed = p.clone();
        closed.activated = false;
        for who in [&primary, &contingent, &stranger] {
            assert_eq!(code(claim_role(&closed, who, None, i64::MAX)), claim_err(ClaimError::NotActivated));
        }

        // a claim by the primary restarts the contingent heir's wait
        let mut later = p.clone();
        later.contingent_clock_ts = opens - 5;
        assert_eq!(code(claim_role(&later, &contingent, None, opens)), claim_err(ClaimError::ContingentTooEarly));
        assert_eq!(claim_role(&later, &contingent, None, opens - 5 + 365 * DAY as i64).unwrap(), Role::Contingent);

        // no contingent heir: only the primary, ever
        let solo = plan(terms(HeirRef::address(&primary), HeirRef::none(), 0));
        assert_eq!(code(claim_role(&solo, &contingent, None, i64::MAX)), claim_err(ClaimError::NotAnHeir));
        assert_eq!(code(claim_role(&solo, &Pubkey::default(), None, i64::MAX)), claim_err(ClaimError::NotAnHeir));
    }

    #[test]
    fn the_clock_cannot_overflow_into_an_early_claim() {
        let primary = Pubkey::new_from_array([2; 32]);
        let contingent = Pubkey::new_from_array([3; 32]);
        let mut p = plan(terms(HeirRef::address(&primary), HeirRef::address(&contingent), MAX_CONTINGENT_DELAY_SECS));
        p.contingent_clock_ts = i64::MAX - 10;
        assert_eq!(code(claim_role(&p, &contingent, None, i64::MAX)), claim_err(ClaimError::Overflow));
        assert_eq!(claim_role(&p, &primary, None, i64::MAX).unwrap(), Role::Primary);
    }
}
