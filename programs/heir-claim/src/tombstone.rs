//! Reading what the vault leaves at its address when it closes.
//!
//! `Close`, and `execute_succession` in the Heir-enabled build, rewrite the vault account as a
//! `Tombstone` (lamport-vault, `programs/lamport-vault/src/state.rs`): 81 bytes,
//!
//! ```text
//!  0  discriminator  8   sha256("account:Tombstone")[..8]
//!  8  version        1   0xFE
//!  9  vault_id      32
//! 41  closed_slot    8   little-endian
//! 49  heir          32   where the vault's lamports went, and the only place its tokens can be swept to
//! ```
//!
//! The layout is rebuilt here so the claim program does not link the vault crate. The unit test
//! below reads the vector the vault repository publishes for it.

use anchor_lang::prelude::*;

use crate::error::ClaimError;
use crate::VAULT_PROGRAM_ID;

/// `sha256("account:Tombstone")[..8]`.
pub const TOMBSTONE_DISCRIMINATOR: [u8; 8] = [45, 187, 252, 155, 232, 114, 36, 22];
/// `sha256("account:Vault")[..8]`: a vault that is still open.
pub const VAULT_DISCRIMINATOR: [u8; 8] = [211, 8, 232, 43, 2, 152, 117, 119];
/// The tombstone's version byte; no vault layout carries it.
pub const TOMBSTONE_VERSION: u8 = 0xFE;
/// Size of a tombstone account.
pub const TOMBSTONE_SPACE: usize = 8 + 1 + 32 + 8 + 32;

/// A closed vault's tombstone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Tombstone {
    /// `vault_id` of the closed vault.
    pub vault_id: [u8; 32],
    /// Slot the vault closed in.
    pub closed_slot: u64,
    /// The address the vault released to.
    pub heir: Pubkey,
}

/// Decodes a tombstone from account data. `None` unless it is exactly one.
pub fn decode(data: &[u8]) -> Option<Tombstone> {
    if data.len() != TOMBSTONE_SPACE || data[..8] != TOMBSTONE_DISCRIMINATOR || data[8] != TOMBSTONE_VERSION {
        return None;
    }
    Some(Tombstone {
        vault_id: data[9..41].try_into().ok()?,
        closed_slot: u64::from_le_bytes(data[41..49].try_into().ok()?),
        heir: Pubkey::new_from_array(data[49..81].try_into().ok()?),
    })
}

/// True when `ai` is an open vault of the Heir-enabled vault program.
pub fn is_live_vault(ai: &AccountInfo) -> bool {
    *ai.owner == VAULT_PROGRAM_ID
        && ai
            .try_borrow_data()
            .map(|d| d.len() > 8 && d[..8] == VAULT_DISCRIMINATOR)
            .unwrap_or(false)
}

/// Reads the tombstone at `ai`. Only an account the Heir-enabled vault program owns is believed:
/// nobody else can write that program's accounts, so the tombstone is the vault's own word.
pub fn read(ai: &AccountInfo) -> Result<Tombstone> {
    require_keys_eq!(*ai.owner, VAULT_PROGRAM_ID, ClaimError::NotATombstone);
    let data = ai.try_borrow_data()?;
    require!(!(data.len() > 8 && data[..8] == VAULT_DISCRIMINATOR), ClaimError::VaultNotClosed);
    decode(&data).ok_or_else(|| error!(ClaimError::NotATombstone))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `accounts.tombstone_hex` of lamport-vault's `kat/vault_encoding.json` at commit c4a4ccd,
    /// which the vault's own Rust and TypeScript tests also read.
    const VAULT_KAT_TOMBSTONE: &str = "2dbbfc9be8722416fe36bfe00f25cee3b40a6e4842e3a77988ea05b01d62196682d52d13a773de435a66443322110000002222222222222222222222222222222222222222222222222222222222222222";

    #[test]
    fn decodes_the_vaults_published_vector() {
        let bytes = hex::decode(VAULT_KAT_TOMBSTONE).unwrap();
        assert_eq!(bytes.len(), TOMBSTONE_SPACE);
        let t = decode(&bytes).expect("a tombstone");
        assert_eq!(hex::encode(t.vault_id), "36bfe00f25cee3b40a6e4842e3a77988ea05b01d62196682d52d13a773de435a");
        assert_eq!(t.closed_slot, 0x0000_0011_2233_4466);
        assert_eq!(t.heir, Pubkey::new_from_array([0x22; 32]));
    }

    #[test]
    fn refuses_everything_that_is_not_exactly_a_tombstone() {
        let good = hex::decode(VAULT_KAT_TOMBSTONE).unwrap();
        assert!(decode(&good[..80]).is_none(), "one byte short");
        let mut long = good.clone();
        long.push(0);
        assert!(decode(&long).is_none(), "one byte long");
        let mut version = good.clone();
        version[8] = 2;
        assert!(decode(&version).is_none(), "a vault's version byte");
        let mut vault = good.clone();
        vault[..8].copy_from_slice(&VAULT_DISCRIMINATOR);
        assert!(decode(&vault).is_none(), "a live vault's discriminator");
        assert!(decode(&[]).is_none());
        // every single-bit flip of the header is refused
        for bit in 0..72 {
            let mut b = good.clone();
            b[bit / 8] ^= 1 << (bit % 8);
            assert!(decode(&b).is_none(), "bit {bit}");
        }
    }
}
