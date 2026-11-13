//! Error codes, numbered from 6000 in declaration order. New codes go at the end.

use anchor_lang::prelude::*;

#[error_code]
pub enum ClaimError {
    #[msg("the terms are not valid: no vault, no primary heir, or an unknown heir kind")]
    InvalidTerms,
    #[msg("terms_hash is not the hash of the terms")]
    TermsHashMismatch,
    #[msg("the contingent delay must be 0 with no contingent heir, and between 30 days and 100 years with one")]
    InvalidContingentDelay,
    #[msg("the primary and the contingent heir are the same")]
    SameHeirTwice,
    #[msg("the vault in the terms is not a live vault of the Heir-enabled vault program")]
    NotALiveVault,
    #[msg("an heir named by address has not proven control: sign the transaction, or include an Ed25519 instruction over the acceptance message")]
    HeirNotProven,
    #[msg("the instructions sysvar is not the account passed")]
    WrongInstructionsSysvar,
    #[msg("this is not the vault the plan names")]
    WrongVault,
    #[msg("the vault is still open: the plan activates only after it has released")]
    VaultNotClosed,
    #[msg("the account at the vault's address is not a vault tombstone")]
    NotATombstone,
    #[msg("the vault released to another address, not to this plan")]
    TombstoneNamesAnother,
    #[msg("the plan is not activated yet")]
    NotActivated,
    #[msg("the signer is not an heir of this plan (a hashed heir must pass its salt)")]
    NotAnHeir,
    #[msg("the contingent heir may not claim yet")]
    ContingentTooEarly,
    #[msg("there is nothing to claim")]
    NothingToClaim,
    #[msg("the token program is not Token or Token-2022, or does not own the mint or the account")]
    InvalidTokenProgram,
    #[msg("the token account is not owned by this plan")]
    NotPlanTokenAccount,
    #[msg("the token account is not for this mint")]
    WrongMint,
    #[msg("the destination token account is not owned by the claiming heir")]
    DestinationNotHeirs,
    #[msg("arithmetic overflow")]
    Overflow,
}
