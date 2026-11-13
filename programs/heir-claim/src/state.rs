//! A plan and its terms.

use anchor_lang::prelude::*;

use crate::error::ClaimError;

/// Seed prefix of the `Plan` PDA: `["plan", terms_hash]`.
pub const PLAN_SEED: &[u8] = b"plan";
/// Domain of the terms hash: `terms_hash = sha256(TERMS_DOMAIN || borsh(terms))`.
pub const TERMS_DOMAIN: &[u8] = b"lamport-heir/plan/v1";
/// Domain of a hashed heir: `sha256(HEIR_DOMAIN || salt[32] || address[32])`.
pub const HEIR_DOMAIN: &[u8] = b"lamport-heir/heir/v1";

/// Shortest contingent delay, 30 days: the primary heir always gets that long alone.
pub const MIN_CONTINGENT_DELAY_SECS: u64 = 30 * 86_400;
/// Longest contingent delay, 100 years. It also keeps the clock arithmetic far from overflow.
pub const MAX_CONTINGENT_DELAY_SECS: u64 = 100 * 365 * 86_400;

/// Who an heir is: nobody, an address, or the salted hash of one.
///
/// Fixed size on purpose (33 bytes whatever the kind), so a plan's fields sit at fixed offsets.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct HeirRef {
    /// [`HeirRef::NONE`], [`HeirRef::ADDRESS`] or [`HeirRef::HASHED`].
    pub kind: u8,
    /// All zero for `NONE`; the address for `ADDRESS`; `sha256(HEIR_DOMAIN || salt || address)` for `HASHED`.
    pub value: [u8; 32],
}

impl HeirRef {
    /// No heir in this position. Only the contingent position may hold it.
    pub const NONE: u8 = 0;
    /// The heir's address, public from the day the plan is created.
    pub const ADDRESS: u8 = 1;
    /// A salted hash of the heir's address. The heir stays private until they claim, and the
    /// claim needs the salt: a lost salt blocks it for good.
    pub const HASHED: u8 = 2;
    /// Borsh size.
    pub const LEN: usize = 1 + 32;

    /// No heir.
    pub const fn none() -> Self {
        Self { kind: Self::NONE, value: [0; 32] }
    }

    /// A named address.
    pub fn address(address: &Pubkey) -> Self {
        Self { kind: Self::ADDRESS, value: address.to_bytes() }
    }

    /// A hashed heir, from the commitment [`heir_commitment`] returns.
    pub const fn hashed(commitment: [u8; 32]) -> Self {
        Self { kind: Self::HASHED, value: commitment }
    }

    /// The address, when this is a named one.
    pub fn as_address(&self) -> Option<Pubkey> {
        (self.kind == Self::ADDRESS).then(|| Pubkey::new_from_array(self.value))
    }

    /// True when `signer` is this heir. A hashed heir needs the salt it was committed with.
    pub fn matches(&self, signer: &Pubkey, salt: Option<&[u8; 32]>) -> bool {
        match self.kind {
            Self::ADDRESS => self.value == signer.to_bytes(),
            Self::HASHED => match salt {
                Some(salt) => self.value == heir_commitment(salt, signer),
                None => false,
            },
            _ => false,
        }
    }
}

/// `sha256(HEIR_DOMAIN || salt || address)`: what a plan stores for a hashed heir.
pub fn heir_commitment(salt: &[u8; 32], address: &Pubkey) -> [u8; 32] {
    solana_sha256_hasher::hashv(&[HEIR_DOMAIN, salt, address.as_ref()]).to_bytes()
}

/// What a plan promises. The plan's address is derived from a hash of these, so none of them can
/// change after the plan exists: other terms are another plan.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct Terms {
    /// The vault whose release this plan receives.
    pub vault: Pubkey,
    /// The heir who may claim from the moment the plan is activated.
    pub primary: HeirRef,
    /// The heir who may claim once the primary has not claimed for `contingent_delay_secs`.
    /// [`HeirRef::none`] for no contingent heir.
    pub contingent: HeirRef,
    /// How long the contingent heir waits; 0 when there is none.
    pub contingent_delay_secs: u64,
}

impl Terms {
    /// Borsh size: 32 + 33 + 33 + 8.
    pub const LEN: usize = 32 + HeirRef::LEN + HeirRef::LEN + 8;

    /// `sha256(TERMS_DOMAIN || borsh(terms))`, the seed of the plan's address.
    pub fn hash(&self) -> [u8; 32] {
        let mut bytes = Vec::with_capacity(Self::LEN);
        self.serialize(&mut bytes).expect("in-memory serialize");
        solana_sha256_hasher::hashv(&[TERMS_DOMAIN, &bytes]).to_bytes()
    }

    /// The rules every plan's terms meet.
    pub fn validate(&self) -> Result<()> {
        require!(self.vault != Pubkey::default(), ClaimError::InvalidTerms);
        match self.primary.kind {
            HeirRef::ADDRESS => require!(self.primary.value != [0u8; 32], ClaimError::InvalidTerms),
            HeirRef::HASHED => {}
            _ => return err!(ClaimError::InvalidTerms),
        }
        match self.contingent.kind {
            HeirRef::NONE => {
                // one encoding of "no contingent heir", so one address per set of terms
                require!(self.contingent.value == [0u8; 32], ClaimError::InvalidTerms);
                require!(self.contingent_delay_secs == 0, ClaimError::InvalidContingentDelay);
            }
            HeirRef::ADDRESS | HeirRef::HASHED => {
                if self.contingent.kind == HeirRef::ADDRESS {
                    require!(self.contingent.value != [0u8; 32], ClaimError::InvalidTerms);
                }
                // The same heir twice is a plan with no contingent heir. (Two hashed heirs cannot
                // be compared here unless they share a salt; that is the owner's app to check.)
                require!(self.contingent != self.primary, ClaimError::SameHeirTwice);
                require!(
                    (MIN_CONTINGENT_DELAY_SECS..=MAX_CONTINGENT_DELAY_SECS).contains(&self.contingent_delay_secs),
                    ClaimError::InvalidContingentDelay
                );
            }
            _ => return err!(ClaimError::InvalidTerms),
        }
        Ok(())
    }
}

/// Released funds held for named heirs. PDA `["plan", terms_hash]`.
///
/// The account is never closed: SOL and token sweeps can reach a closed vault's heir at any later
/// time, so the plan keeps its rent and stays claimable.
#[account]
#[derive(Debug)]
pub struct Plan {
    /// Layout version, 1.
    pub version: u8,
    /// PDA bump.
    pub bump: u8,
    /// `terms.hash()`, kept so the PDA can sign without hashing again.
    pub terms_hash: [u8; 32],
    /// The terms, fixed at creation.
    pub terms: Terms,
    /// When the plan was created.
    pub created_ts: i64,
    /// Whether `activate` has seen the vault's tombstone naming this plan.
    pub activated: bool,
    /// When `activate` ran. Meaningless until `activated`.
    pub activated_ts: i64,
    /// `closed_slot` of the vault's tombstone, for the record.
    pub closed_slot: u64,
    /// The moment the contingent delay counts from: activation, then every claim by the primary
    /// heir. The contingent heir may claim once `now >= contingent_clock_ts + contingent_delay_secs`.
    pub contingent_clock_ts: i64,
}

impl Plan {
    /// Current layout version.
    pub const VERSION: u8 = 1;
    /// Account size including the discriminator: 181 bytes.
    pub const SPACE: usize = 8 + 1 + 1 + 32 + Terms::LEN + 8 + 1 + 8 + 8 + 8;

    /// The moment from which the contingent heir may claim.
    pub fn contingent_opens_at(&self) -> Result<i64> {
        let delay = i64::try_from(self.terms.contingent_delay_secs).map_err(|_| error!(ClaimError::Overflow))?;
        self.contingent_clock_ts.checked_add(delay).ok_or_else(|| error!(ClaimError::Overflow))
    }
}
