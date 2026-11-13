//! Helpers for the LiteSVM tests of `heir-claim`: the program's wire formats, rebuilt here byte for
//! byte with no dependency on the program crate, and a small test bench around LiteSVM.
use litesvm::LiteSVM;
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_address::Address;
use solana_clock::Clock;
use solana_instruction::{AccountMeta, Instruction};
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;

pub type Pubkey = Address;

pub fn hashv(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

/// `declare_id!` of `programs/heir-claim`.
pub const CLAIM_PROGRAM_ID: Pubkey = Address::from_str_const("2SbWfdn3N5LqZz4nwcJuUkD9DhPDJyMusSNqyWaUWUDd");
/// `VAULT_PROGRAM_ID` of `programs/heir-claim`: the Heir-enabled vault program.
pub const VAULT_PROGRAM_ID: Pubkey = Address::from_str_const("HK1QPbqjkozJHB74QuGaduYzAtqBe9hry3nV64LmpCsb");
pub const SYSTEM_PROGRAM_ID: Pubkey = Address::from_str_const("11111111111111111111111111111111");
pub const TOKEN_PROGRAM_ID: Pubkey = Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022_PROGRAM_ID: Pubkey = Address::from_str_const("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const ED25519_PROGRAM_ID: Pubkey = Address::from_str_const("Ed25519SigVerify111111111111111111111111111");
pub const INSTRUCTIONS_SYSVAR_ID: Pubkey = Address::from_str_const("Sysvar1nstructions1111111111111111111111111");

pub const SO: &str = "../../target/deploy/heir_claim.so";

pub const DAY: i64 = 86_400;
pub const MIN_CONTINGENT_DELAY_SECS: u64 = 30 * 86_400;
pub const MAX_CONTINGENT_DELAY_SECS: u64 = 100 * 365 * 86_400;
pub const PLAN_SPACE: usize = 181;
pub const TOMBSTONE_SPACE: usize = 81;
pub const VAULT_DISC: [u8; 8] = [211, 8, 232, 43, 2, 152, 117, 119];
pub const TOMBSTONE_DISC: [u8; 8] = [45, 187, 252, 155, 232, 114, 36, 22];

/// `ClaimError` codes: declaration order from 6000 (`programs/heir-claim/src/error.rs`).
pub mod err {
    pub const INVALID_TERMS: u32 = 6000;
    pub const TERMS_HASH_MISMATCH: u32 = 6001;
    pub const INVALID_CONTINGENT_DELAY: u32 = 6002;
    pub const SAME_HEIR_TWICE: u32 = 6003;
    pub const NOT_A_LIVE_VAULT: u32 = 6004;
    pub const HEIR_NOT_PROVEN: u32 = 6005;
    pub const WRONG_INSTRUCTIONS_SYSVAR: u32 = 6006;
    pub const WRONG_VAULT: u32 = 6007;
    pub const VAULT_NOT_CLOSED: u32 = 6008;
    pub const NOT_A_TOMBSTONE: u32 = 6009;
    pub const TOMBSTONE_NAMES_ANOTHER: u32 = 6010;
    pub const NOT_ACTIVATED: u32 = 6011;
    pub const NOT_AN_HEIR: u32 = 6012;
    pub const CONTINGENT_TOO_EARLY: u32 = 6013;
    pub const NOTHING_TO_CLAIM: u32 = 6014;
    pub const INVALID_TOKEN_PROGRAM: u32 = 6015;
    pub const NOT_PLAN_TOKEN_ACCOUNT: u32 = 6016;
    pub const WRONG_MINT: u32 = 6017;
    pub const DESTINATION_NOT_HEIRS: u32 = 6018;
    pub const OVERFLOW: u32 = 6019;
    /// Anchor's own codes the tests meet.
    pub const ANCHOR_ACCOUNT_NOT_SIGNER: u32 = 3010;
    pub const ANCHOR_ACCOUNT_OWNED_BY_WRONG_PROGRAM: u32 = 3007;
    pub const ANCHOR_ACCOUNT_DISCRIMINATOR_MISMATCH: u32 = 3002;
    pub const ANCHOR_ACCOUNT_NOT_INITIALIZED: u32 = 3012;
    pub const ANCHOR_CONSTRAINT_SEEDS: u32 = 2006;
}

/// Anchor instruction discriminator, `sha256("global:<name>")[..8]`.
pub fn ix_disc(name: &str) -> [u8; 8] {
    hashv(&[b"global:", name.as_bytes()])[..8].try_into().unwrap()
}

// ---- terms ----

/// An heir reference: kind (0 none, 1 address, 2 hashed) and 32 bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HeirRef {
    pub kind: u8,
    pub value: [u8; 32],
}

impl HeirRef {
    pub const fn none() -> Self {
        Self { kind: 0, value: [0; 32] }
    }
    pub fn address(a: &Pubkey) -> Self {
        Self { kind: 1, value: a.to_bytes() }
    }
    /// `sha256("lamport-heir/heir/v1" || salt || address)`.
    pub fn hashed(salt: &[u8; 32], a: &Pubkey) -> Self {
        Self { kind: 2, value: hashv(&[b"lamport-heir/heir/v1", salt, a.as_ref()]) }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Terms {
    pub vault: Pubkey,
    pub primary: HeirRef,
    pub contingent: HeirRef,
    pub contingent_delay_secs: u64,
}

impl Terms {
    /// Borsh: vault, kind + value, kind + value, u64 little-endian. 106 bytes.
    pub fn encode(&self) -> Vec<u8> {
        let mut v = Vec::with_capacity(106);
        v.extend_from_slice(self.vault.as_ref());
        v.push(self.primary.kind);
        v.extend_from_slice(&self.primary.value);
        v.push(self.contingent.kind);
        v.extend_from_slice(&self.contingent.value);
        v.extend_from_slice(&self.contingent_delay_secs.to_le_bytes());
        v
    }
    /// `sha256("lamport-heir/plan/v1" || borsh(terms))`.
    pub fn hash(&self) -> [u8; 32] {
        hashv(&[b"lamport-heir/plan/v1", &self.encode()])
    }
    /// PDA `["plan", terms_hash]`.
    pub fn plan(&self) -> Pubkey {
        Pubkey::find_program_address(&[b"plan", &self.hash()], &CLAIM_PROGRAM_ID).0
    }
}

/// The text an heir signs to accept a place in `plan`.
pub fn acceptance_message(plan: &Pubkey) -> String {
    format!("Lamport Heir: I control this address and accept being named an heir in plan {plan}.")
}

/// The `Plan` account, decoded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanState {
    pub version: u8,
    pub bump: u8,
    pub terms_hash: [u8; 32],
    pub terms: Terms,
    pub created_ts: i64,
    pub activated: bool,
    pub activated_ts: i64,
    pub closed_slot: u64,
    pub contingent_clock_ts: i64,
}

pub fn decode_plan(data: &[u8]) -> PlanState {
    assert_eq!(data.len(), PLAN_SPACE, "plan size");
    assert_eq!(&data[..8], &hashv(&[b"account:Plan"])[..8], "not a Plan");
    let mut o = 8;
    let mut take = |n: usize| {
        let s = &data[o..o + n];
        o += n;
        s
    };
    let version = take(1)[0];
    let bump = take(1)[0];
    let terms_hash: [u8; 32] = take(32).try_into().unwrap();
    let vault = Pubkey::new_from_array(take(32).try_into().unwrap());
    let primary = HeirRef { kind: take(1)[0], value: take(32).try_into().unwrap() };
    let contingent = HeirRef { kind: take(1)[0], value: take(32).try_into().unwrap() };
    let contingent_delay_secs = u64::from_le_bytes(take(8).try_into().unwrap());
    let created_ts = i64::from_le_bytes(take(8).try_into().unwrap());
    let activated = take(1)[0] != 0;
    let activated_ts = i64::from_le_bytes(take(8).try_into().unwrap());
    let closed_slot = u64::from_le_bytes(take(8).try_into().unwrap());
    let contingent_clock_ts = i64::from_le_bytes(take(8).try_into().unwrap());
    PlanState {
        version,
        bump,
        terms_hash,
        terms: Terms { vault, primary, contingent, contingent_delay_secs },
        created_ts,
        activated,
        activated_ts,
        closed_slot,
        contingent_clock_ts,
    }
}

// ---- instructions ----

/// `init_plan(terms_hash, terms)`. `signing_heirs` are added as read-only signer accounts.
pub fn init_plan_ix_with(payer: &Pubkey, plan: &Pubkey, terms_hash: &[u8; 32], terms: &Terms, vault: &Pubkey, sysvar: &Pubkey, signing_heirs: &[Pubkey]) -> Instruction {
    let mut data = ix_disc("init_plan").to_vec();
    data.extend_from_slice(terms_hash);
    data.extend_from_slice(&terms.encode());
    let mut accounts = vec![
        AccountMeta::new(*payer, true),
        AccountMeta::new(*plan, false),
        AccountMeta::new_readonly(*vault, false),
        AccountMeta::new_readonly(*sysvar, false),
        AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
    ];
    accounts.extend(signing_heirs.iter().map(|h| AccountMeta::new_readonly(*h, true)));
    Instruction { program_id: CLAIM_PROGRAM_ID, accounts, data }
}

pub fn init_plan_ix(payer: &Pubkey, terms: &Terms, signing_heirs: &[Pubkey]) -> Instruction {
    init_plan_ix_with(payer, &terms.plan(), &terms.hash(), terms, &terms.vault, &INSTRUCTIONS_SYSVAR_ID, signing_heirs)
}

pub fn activate_ix(plan: &Pubkey, vault: &Pubkey) -> Instruction {
    Instruction {
        program_id: CLAIM_PROGRAM_ID,
        accounts: vec![AccountMeta::new(*plan, false), AccountMeta::new_readonly(*vault, false)],
        data: ix_disc("activate").to_vec(),
    }
}

fn option_salt(out: &mut Vec<u8>, salt: Option<&[u8; 32]>) {
    match salt {
        Some(s) => {
            out.push(1);
            out.extend_from_slice(s);
        }
        None => out.push(0),
    }
}

pub fn claim_sol_ix(plan: &Pubkey, heir: &Pubkey, salt: Option<&[u8; 32]>) -> Instruction {
    let mut data = ix_disc("claim_sol").to_vec();
    option_salt(&mut data, salt);
    Instruction {
        program_id: CLAIM_PROGRAM_ID,
        accounts: vec![AccountMeta::new(*plan, false), AccountMeta::new(*heir, true)],
        data,
    }
}

#[allow(clippy::too_many_arguments)]
pub fn claim_token_ix(plan: &Pubkey, heir: &Pubkey, source: &Pubkey, destination: &Pubkey, mint: &Pubkey, token_program: &Pubkey, salt: Option<&[u8; 32]>, close: bool) -> Instruction {
    let mut data = ix_disc("claim_token").to_vec();
    option_salt(&mut data, salt);
    data.push(close as u8);
    Instruction {
        program_id: CLAIM_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*plan, false),
            AccountMeta::new(*heir, true),
            AccountMeta::new(*source, false),
            AccountMeta::new(*destination, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(*token_program, false),
        ],
        data,
    }
}

/// An Ed25519 program instruction as web3.js and the Rust SDK build it: header, one offsets entry
/// that points into this same instruction, then key, signature, message.
pub fn ed25519_ix_raw(key: &[u8; 32], signature: &[u8; 64], message: &[u8], indexes: [u16; 3]) -> Instruction {
    let key_offset: u16 = 2 + 14;
    let signature_offset = key_offset + 32;
    let message_offset = signature_offset + 64;
    let mut data = vec![1u8, 0];
    for v in [signature_offset, indexes[0], key_offset, indexes[1], message_offset, message.len() as u16, indexes[2]] {
        data.extend_from_slice(&v.to_le_bytes());
    }
    data.extend_from_slice(key);
    data.extend_from_slice(signature);
    data.extend_from_slice(message);
    Instruction { program_id: ED25519_PROGRAM_ID, accounts: vec![], data }
}

/// `signer`'s signature over `message`, wrapped for the Ed25519 program.
pub fn ed25519_ix(signer: &Keypair, message: &[u8]) -> Instruction {
    let sig: [u8; 64] = signer.sign_message(message).into();
    ed25519_ix_raw(&signer.pubkey().to_bytes(), &sig, message, [u16::MAX; 3])
}

// ---- accounts the tests fabricate ----

/// An open vault as the claim program sees it: owned by the vault program, the `Vault`
/// discriminator first. The rest of a vault's layout is the vault's business.
pub fn live_vault_data() -> Vec<u8> {
    let mut d = VAULT_DISC.to_vec();
    d.push(3); // layout version of the Heir-enabled vault
    d.extend_from_slice(&[0u8; 120]);
    d
}

/// A tombstone (lamport-vault `state.rs`): discriminator, 0xFE, vault_id, closed_slot, heir.
pub fn tombstone_data(vault_id: &[u8; 32], closed_slot: u64, heir: &Pubkey) -> Vec<u8> {
    let mut d = TOMBSTONE_DISC.to_vec();
    d.push(0xFE);
    d.extend_from_slice(vault_id);
    d.extend_from_slice(&closed_slot.to_le_bytes());
    d.extend_from_slice(heir.as_ref());
    assert_eq!(d.len(), TOMBSTONE_SPACE);
    d
}

/// SPL Mint, 82 bytes: no authorities, `decimals` at 44, `is_initialized` at 45.
pub fn mint_data(decimals: u8, supply: u64) -> Vec<u8> {
    let mut d = vec![0u8; 82];
    d[36..44].copy_from_slice(&supply.to_le_bytes());
    d[44] = decimals;
    d[45] = 1;
    d
}

/// SPL token Account, 165 bytes: mint, owner, amount, state Initialized at 108.
pub fn token_account_data(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Vec<u8> {
    let mut d = vec![0u8; 165];
    d[..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d[108] = 1;
    d
}

pub fn token_amount(data: &[u8]) -> u64 {
    u64::from_le_bytes(data[64..72].try_into().unwrap())
}

// ---- the bench ----

pub const FEE: u64 = 5_000; // one signature

pub struct Bench {
    pub svm: LiteSVM,
    pub payer: Keypair,
}

impl Default for Bench {
    fn default() -> Self {
        Self::new()
    }
}

impl Bench {
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program_from_file(CLAIM_PROGRAM_ID, SO).expect("build the program first: cargo build-sbf --manifest-path programs/heir-claim/Cargo.toml");
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 1_000_000_000_000).unwrap();
        let mut bench = Bench { svm, payer };
        bench.set_time(1_800_000_000);
        bench
    }

    pub fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }

    pub fn set_time(&mut self, unix_timestamp: i64) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = unix_timestamp;
        self.svm.set_sysvar::<Clock>(&clock);
    }

    pub fn advance(&mut self, secs: i64) {
        let t = self.now() + secs;
        self.set_time(t);
    }

    pub fn rent(&self, len: usize) -> u64 {
        self.svm.minimum_balance_for_rent_exemption(len)
    }

    pub fn balance(&self, k: &Pubkey) -> u64 {
        self.svm.get_balance(k).unwrap_or(0)
    }

    pub fn data(&self, k: &Pubkey) -> Vec<u8> {
        self.svm.get_account(k).map(|a| a.data).unwrap_or_default()
    }

    pub fn exists(&self, k: &Pubkey) -> bool {
        self.svm.get_account(k).map(|a| a.lamports > 0).unwrap_or(false)
    }

    pub fn plan(&self, k: &Pubkey) -> PlanState {
        decode_plan(&self.data(k))
    }

    /// Writes an account, rent-exempt for its size plus `extra` lamports.
    pub fn put(&mut self, k: &Pubkey, owner: &Pubkey, data: Vec<u8>, extra: u64) {
        let lamports = self.rent(data.len()) + extra;
        self.svm.set_account(*k, Account { lamports, data, owner: *owner, executable: false, rent_epoch: 0 }).unwrap();
    }

    /// A funded system account.
    pub fn fund(&mut self, k: &Pubkey, lamports: u64) {
        self.svm.airdrop(k, lamports).unwrap();
    }

    /// Signs with the payer and `extra`, sends, and moves to a fresh blockhash so the same
    /// instructions can be sent again.
    pub fn send(&mut self, ixs: &[Instruction], extra: &[&Keypair]) -> Result<(), TransactionError> {
        let bh = self.svm.latest_blockhash();
        let msg = Message::new_with_blockhash(ixs, Some(&self.payer.pubkey()), &bh);
        let mut signers: Vec<&Keypair> = vec![&self.payer];
        signers.extend_from_slice(extra);
        let tx = Transaction::new(&signers, msg, bh);
        let r = self.svm.send_transaction(tx).map(|_| ()).map_err(|e| e.err);
        self.svm.expire_blockhash();
        r
    }

    /// A new vault address with an open vault at it.
    pub fn open_vault(&mut self) -> Pubkey {
        let vault = Keypair::new().pubkey();
        self.put(&vault, &VAULT_PROGRAM_ID, live_vault_data(), 0);
        vault
    }

    /// Turns the vault at `vault` into a tombstone naming `heir`, with `released` lamports sent on
    /// to `heir`, as the vault's release does.
    pub fn release_vault(&mut self, vault: &Pubkey, heir: &Pubkey, released: u64) {
        let slot = self.svm.get_sysvar::<Clock>().slot;
        self.put(vault, &VAULT_PROGRAM_ID, tombstone_data(&[7; 32], slot, heir), 0);
        if released > 0 {
            self.deposit(heir, released);
        }
    }

    /// Adds lamports to an existing account, as a transfer to it would.
    pub fn deposit(&mut self, k: &Pubkey, lamports: u64) {
        let mut a = self.svm.get_account(k).expect("account exists");
        a.lamports += lamports;
        self.svm.set_account(*k, a).unwrap();
    }

    /// A mint under `token_program`.
    pub fn mint(&mut self, token_program: &Pubkey, decimals: u8) -> Pubkey {
        let mint = Keypair::new().pubkey();
        self.put(&mint, token_program, mint_data(decimals, 1_000_000_000_000), 0);
        mint
    }

    /// A token account for `mint` owned by `owner`, holding `amount`.
    pub fn token_account(&mut self, token_program: &Pubkey, mint: &Pubkey, owner: &Pubkey, amount: u64) -> Pubkey {
        let k = Keypair::new().pubkey();
        self.put(&k, token_program, token_account_data(mint, owner, amount), 0);
        k
    }
}

/// The custom program error a transaction failed with.
pub fn custom(e: TransactionError) -> u32 {
    match e {
        TransactionError::InstructionError(_, InstructionError::Custom(c)) => c,
        other => panic!("not a program error: {other:?}"),
    }
}

/// Small deterministic generator for the randomized tests (xorshift64*).
pub struct Rng(pub u64);

impl Rng {
    pub fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    pub fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    pub fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len() as u64) as usize]
    }
}
