//! How an heir named by address proves, when a plan is created, that they control that address.
//!
//! Two ways, and either is enough:
//!
//! 1. **They sign the `init_plan` transaction.** Simple, but every signer has to sign inside one
//!    blockhash lifetime, and the heir shows up as a signer of the transaction.
//! 2. **They sign a message that names the plan**, whenever suits them, and hand the signature to
//!    whoever creates the plan. The transaction then carries an instruction for Solana's Ed25519
//!    program, which verifies the signature, and `init_plan` reads that instruction to see whose
//!    signature over which message was verified.
//!
//! The message is plain text, so a wallet can show it: [`acceptance_message`]. The plan's address is
//! derived from its terms, so naming the plan names the vault, both heirs and the delay.
//!
//! A hashed heir proves nothing on chain: showing their address is what hashing avoids. The owner's
//! app checks their signature itself.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::load_instruction_at_checked;

use crate::error::ClaimError;

/// Solana's Ed25519 signature-verification program.
pub const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");

/// What a wallet prepends when it signs under Solana's off-chain message format (a hardware
/// wallet signs nothing else). Bytes that start with it can never be a transaction.
pub const OFFCHAIN_DOMAIN: &[u8] = b"\xffsolana offchain";
/// Most bytes an off-chain envelope may put in front of the message.
pub const MAX_ENVELOPE_LEN: usize = 128;

/// The text an heir signs to accept a place in `plan`.
pub fn acceptance_message(plan: &Pubkey) -> String {
    format!("Lamport Heir: I control this address and accept being named an heir in plan {plan}.")
}

/// True when the signed bytes are the acceptance message: the text itself, or the text inside an
/// off-chain message envelope (the envelope's domain first, the text last).
pub fn message_accepted(signed: &[u8], expected: &[u8]) -> bool {
    if expected.is_empty() {
        return false;
    }
    if signed == expected {
        return true;
    }
    signed.len() > expected.len()
        && signed.len() - expected.len() <= MAX_ENVELOPE_LEN
        && signed.starts_with(OFFCHAIN_DOMAIN)
        && signed.ends_with(expected)
}

const OFFSETS_START: usize = 2;
const OFFSETS_LEN: usize = 14;
/// In an offsets entry: "the data is in this same instruction".
const THIS_INSTRUCTION: u16 = u16::MAX;

/// Reads the data of one Ed25519 program instruction. True when it carries a signature by `signer`
/// over the acceptance message.
///
/// The Ed25519 program has already verified every signature in the instruction, or the transaction
/// would have failed. What is checked here is *which* key and *which* message it verified. An
/// entry may point at bytes in another instruction; such an entry is skipped, because the bytes at
/// the same offsets in this instruction would then be something nobody signed.
pub fn ed25519_data_proves(data: &[u8], signer: &Pubkey, expected: &[u8]) -> bool {
    let Some(&count) = data.first() else { return false };
    for i in 0..count as usize {
        let start = OFFSETS_START + i * OFFSETS_LEN;
        let Some(entry) = data.get(start..start + OFFSETS_LEN) else { return false };
        let field = |k: usize| u16::from_le_bytes([entry[k], entry[k + 1]]);
        let (signature_offset, signature_ix) = (field(0) as usize, field(2));
        let (key_offset, key_ix) = (field(4) as usize, field(6));
        let (message_offset, message_len, message_ix) = (field(8) as usize, field(10) as usize, field(12));
        if signature_ix != THIS_INSTRUCTION || key_ix != THIS_INSTRUCTION || message_ix != THIS_INSTRUCTION {
            continue;
        }
        let (Some(_signature), Some(key), Some(message)) = (
            data.get(signature_offset..signature_offset + 64),
            data.get(key_offset..key_offset + 32),
            data.get(message_offset..message_offset + message_len),
        ) else {
            continue;
        };
        if key == signer.as_ref() && message_accepted(message, expected) {
            return true;
        }
    }
    false
}

/// True when the transaction being executed carries an Ed25519 program instruction that verified
/// `signer`'s signature over the acceptance message for `plan`.
pub fn transaction_proves(instructions_sysvar: &AccountInfo, signer: &Pubkey, plan: &Pubkey) -> Result<bool> {
    let expected = acceptance_message(plan);
    let count = {
        let data = instructions_sysvar.try_borrow_data()?;
        require!(data.len() >= 2, ClaimError::WrongInstructionsSysvar);
        u16::from_le_bytes([data[0], data[1]]) as usize
    };
    for index in 0..count {
        let instruction = load_instruction_at_checked(index, instructions_sysvar)?;
        if instruction.program_id == ED25519_PROGRAM_ID && ed25519_data_proves(&instruction.data, signer, expected.as_bytes()) {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ed25519 instruction data as web3.js and the Rust SDK build it: header, one offsets entry,
    /// then key, signature, message.
    fn ed25519_data(key: &[u8; 32], message: &[u8], indexes: [u16; 3]) -> Vec<u8> {
        let key_offset = (OFFSETS_START + OFFSETS_LEN) as u16;
        let signature_offset = key_offset + 32;
        let message_offset = signature_offset + 64;
        let mut d = vec![1u8, 0];
        for v in [signature_offset, indexes[0], key_offset, indexes[1], message_offset, message.len() as u16, indexes[2]] {
            d.extend_from_slice(&v.to_le_bytes());
        }
        d.extend_from_slice(key);
        d.extend_from_slice(&[7u8; 64]);
        d.extend_from_slice(message);
        d
    }

    const HERE: [u16; 3] = [u16::MAX; 3];

    #[test]
    fn the_message_names_the_plan_in_plain_text() {
        let plan = Pubkey::new_from_array([3; 32]);
        let m = acceptance_message(&plan);
        assert!(m.is_ascii());
        assert!(m.starts_with("Lamport Heir: "));
        assert!(m.contains(&plan.to_string()));
        assert_ne!(m, acceptance_message(&Pubkey::new_from_array([4; 32])));
    }

    #[test]
    fn accepts_the_text_or_the_text_in_an_offchain_envelope() {
        let expected = b"the text";
        assert!(message_accepted(expected, expected));
        let mut enveloped = OFFCHAIN_DOMAIN.to_vec();
        enveloped.extend_from_slice(&[0, 0, 8, 0]); // a header; its contents are not interpreted
        enveloped.extend_from_slice(expected);
        assert!(message_accepted(&enveloped, expected));

        assert!(!message_accepted(b"the text ", expected), "trailing byte");
        assert!(!message_accepted(b" the text", expected), "a prefix that is not the off-chain domain");
        assert!(!message_accepted(b"", expected));
        let mut tail = enveloped.clone();
        tail.push(b'!');
        assert!(!message_accepted(&tail, expected), "the text must come last");
        let mut long = OFFCHAIN_DOMAIN.to_vec();
        long.extend_from_slice(&[0u8; MAX_ENVELOPE_LEN]);
        long.extend_from_slice(expected);
        assert!(!message_accepted(&long, expected), "envelope too long");
        assert!(!message_accepted(OFFCHAIN_DOMAIN, expected), "an envelope with nothing in it");
        assert!(!message_accepted(OFFCHAIN_DOMAIN, b"") && !message_accepted(b"", b""), "nothing is ever expected to be empty");
    }

    #[test]
    fn proves_only_the_named_key_over_the_named_message() {
        let key = [9u8; 32];
        let signer = Pubkey::new_from_array(key);
        let expected = b"accept plan X";
        assert!(ed25519_data_proves(&ed25519_data(&key, expected, HERE), &signer, expected));
        assert!(!ed25519_data_proves(&ed25519_data(&[8; 32], expected, HERE), &signer, expected), "another key");
        assert!(!ed25519_data_proves(&ed25519_data(&key, b"accept plan Y", HERE), &signer, expected), "another message");
    }

    #[test]
    fn an_entry_that_points_into_another_instruction_proves_nothing() {
        let key = [9u8; 32];
        let signer = Pubkey::new_from_array(key);
        let expected = b"accept plan X";
        for bad in [[0, u16::MAX, u16::MAX], [u16::MAX, 0, u16::MAX], [u16::MAX, u16::MAX, 0], [1, 1, 1]] {
            assert!(!ed25519_data_proves(&ed25519_data(&key, expected, bad), &signer, expected), "{bad:?}");
        }
    }

    #[test]
    fn malformed_data_proves_nothing_and_never_panics() {
        let key = [9u8; 32];
        let signer = Pubkey::new_from_array(key);
        let expected = b"accept plan X";
        let good = ed25519_data(&key, expected, HERE);
        assert!(!ed25519_data_proves(&[], &signer, expected));
        assert!(!ed25519_data_proves(&[0, 0], &signer, expected), "no signatures");
        assert!(!ed25519_data_proves(&[3, 0], &signer, expected), "count without entries");
        for cut in 0..good.len() {
            assert!(!ed25519_data_proves(&good[..cut], &signer, expected), "truncated at {cut}");
        }
        // offsets past the end
        let mut far = good.clone();
        far[OFFSETS_START + 8..OFFSETS_START + 10].copy_from_slice(&u16::MAX.to_le_bytes());
        assert!(!ed25519_data_proves(&far, &signer, expected));
        // a second entry is read too: the first is another key over another message
        let mut two = vec![2u8, 0];
        let key_a = (OFFSETS_START + 2 * OFFSETS_LEN) as u16;
        let sig_a = key_a + 32;
        let msg_a = sig_a + 64;
        let key_b = msg_a + 5;
        let sig_b = key_b + 32;
        let msg_b = sig_b + 64;
        for v in [sig_a, u16::MAX, key_a, u16::MAX, msg_a, 5, u16::MAX, sig_b, u16::MAX, key_b, u16::MAX, msg_b, expected.len() as u16, u16::MAX] {
            two.extend_from_slice(&v.to_le_bytes());
        }
        two.extend_from_slice(&[1u8; 32]);
        two.extend_from_slice(&[7u8; 64]);
        two.extend_from_slice(b"other");
        two.extend_from_slice(&key);
        two.extend_from_slice(&[7u8; 64]);
        two.extend_from_slice(expected);
        assert!(ed25519_data_proves(&two, &signer, expected));
        assert!(!ed25519_data_proves(&two, &Pubkey::new_from_array([1; 32]), expected), "the first key signed another message");
    }
}
