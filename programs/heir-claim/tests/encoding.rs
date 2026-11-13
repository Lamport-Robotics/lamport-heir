//! `kat/claim_encoding.json` against the program's own types.
//!
//! The file is written by the TypeScript client (`tools/scripts/claim-kat.ts`). Every value in it is
//! rebuilt here with the types the program is compiled from: the terms and their hash, the plan's
//! address, an heir's commitment, the acceptance message, a `Plan` account, who may claim when, and
//! each instruction's data and account list as Anchor generates them. If either side changes a
//! byte, this fails.
//!
//! Not built for `short-clocks`: that test build has other program ids and limits.
#![cfg(not(feature = "short-clocks"))]

use std::str::FromStr;

use anchor_lang::prelude::*;
use anchor_lang::{AccountDeserialize, AccountSerialize, Discriminator, InstructionData, ToAccountMetas};
use heir_claim::proof::acceptance_message;
use heir_claim::{claim_role, heir_commitment, ClaimError, HeirRef, Plan, Role, Terms, ID, PLAN_SEED, VAULT_PROGRAM_ID};
use serde_json::Value;

fn kat() -> Value {
    serde_json::from_str(include_str!("../../../kat/claim_encoding.json")).expect("kat/claim_encoding.json parses")
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap_or_else(|| panic!("expected a string, got {v}"))
}

fn pk(v: &Value) -> Pubkey {
    Pubkey::from_str(s(v)).expect("a base58 address")
}

fn bytes(v: &Value) -> Vec<u8> {
    hex::decode(s(v)).expect("hex")
}

fn arr32(v: &Value) -> [u8; 32] {
    bytes(v).try_into().expect("32 bytes")
}

fn int<T: FromStr>(v: &Value) -> T
where
    T::Err: std::fmt::Debug,
{
    s(v).parse().expect("a decimal number")
}

fn heir(v: &Value) -> HeirRef {
    HeirRef { kind: v["kind"].as_u64().unwrap() as u8, value: arr32(&v["value_hex"]) }
}

fn terms(v: &Value) -> Terms {
    Terms { vault: pk(&v["vault"]), primary: heir(&v["primary"]), contingent: heir(&v["contingent"]), contingent_delay_secs: int(&v["contingent_delay_secs"]) }
}

fn terms_named<'a>(k: &'a Value, name: &str) -> &'a Value {
    k["terms"].as_array().unwrap().iter().find(|t| s(&t["name"]) == name).unwrap_or_else(|| panic!("no terms named {name}"))
}

#[test]
fn program_ids() {
    let k = kat();
    assert_eq!(pk(&k["program_ids"]["heir_claim"]), ID);
    assert_eq!(pk(&k["program_ids"]["vault"]), VAULT_PROGRAM_ID);
}

#[test]
fn discriminators() {
    let d = &kat()["discriminators"];
    assert_eq!(bytes(&d["init_plan"]), heir_claim::instruction::InitPlan::DISCRIMINATOR);
    assert_eq!(bytes(&d["activate"]), heir_claim::instruction::Activate::DISCRIMINATOR);
    assert_eq!(bytes(&d["claim_sol"]), heir_claim::instruction::ClaimSol::DISCRIMINATOR);
    assert_eq!(bytes(&d["claim_token"]), heir_claim::instruction::ClaimToken::DISCRIMINATOR);
    assert_eq!(bytes(&d["plan_account"]), Plan::DISCRIMINATOR);
}

#[test]
fn error_codes() {
    use ClaimError::*;
    let all = [
        ("InvalidTerms", InvalidTerms),
        ("TermsHashMismatch", TermsHashMismatch),
        ("InvalidContingentDelay", InvalidContingentDelay),
        ("SameHeirTwice", SameHeirTwice),
        ("NotALiveVault", NotALiveVault),
        ("HeirNotProven", HeirNotProven),
        ("WrongInstructionsSysvar", WrongInstructionsSysvar),
        ("WrongVault", WrongVault),
        ("VaultNotClosed", VaultNotClosed),
        ("NotATombstone", NotATombstone),
        ("TombstoneNamesAnother", TombstoneNamesAnother),
        ("NotActivated", NotActivated),
        ("NotAnHeir", NotAnHeir),
        ("ContingentTooEarly", ContingentTooEarly),
        ("NothingToClaim", NothingToClaim),
        ("InvalidTokenProgram", InvalidTokenProgram),
        ("NotPlanTokenAccount", NotPlanTokenAccount),
        ("WrongMint", WrongMint),
        ("DestinationNotHeirs", DestinationNotHeirs),
        ("Overflow", Overflow),
    ];
    let k = kat();
    let listed = k["errors"].as_object().unwrap();
    assert_eq!(listed.len(), all.len(), "the file lists every error and no other");
    for (name, e) in all {
        assert_eq!(listed[name].as_u64().unwrap() as u32, u32::from(e), "{name}");
    }
}

#[test]
fn terms_their_hash_and_the_plan_address() {
    let k = kat();
    let all = k["terms"].as_array().unwrap();
    assert_eq!(all.len(), 4);
    for t in all {
        let name = s(&t["name"]);
        let terms = terms(t);
        terms.validate().unwrap_or_else(|e| panic!("{name}: the program refuses these terms: {e:?}"));
        assert_eq!(terms.try_to_vec().unwrap(), bytes(&t["encoded_hex"]), "{name}: encoding");
        assert_eq!(terms.hash(), arr32(&t["terms_hash_hex"]), "{name}: hash");
        let (plan, _) = Pubkey::find_program_address(&[PLAN_SEED, &terms.hash()], &ID);
        assert_eq!(plan, pk(&t["plan_address"]), "{name}: plan address");
        // The short-clocks build is another program, so the same terms live at another address.
        let short = Pubkey::find_program_address(&[PLAN_SEED, &terms.hash()], &pk(&k["program_ids"]["heir_claim_short_clocks"])).0;
        assert_eq!(short, pk(&t["plan_address_short_clocks"]), "{name}: plan address under the short-clocks program");
        assert_ne!(short, plan);
    }
}

#[test]
fn heir_commitments() {
    let k = kat();
    let all = k["heir_commitments"].as_array().unwrap();
    assert_eq!(all.len(), 3);
    for c in all {
        assert_eq!(heir_commitment(&arr32(&c["salt_hex"]), &pk(&c["address"])), arr32(&c["commitment_hex"]));
    }
}

#[test]
fn the_acceptance_message() {
    let m = &kat()["acceptance_message"];
    assert_eq!(acceptance_message(&pk(&m["plan"])), s(&m["text"]));
}

fn plan_named(k: &Value, name: &str) -> Plan {
    let p = k["plan_accounts"].as_array().unwrap().iter().find(|p| s(&p["name"]) == name).unwrap_or_else(|| panic!("no plan named {name}"));
    Plan::try_deserialize(&mut &bytes(&p["hex"])[..]).expect("a Plan account")
}

#[test]
fn plan_accounts() {
    let k = kat();
    let all = k["plan_accounts"].as_array().unwrap();
    assert_eq!(all.len(), 3);
    for p in all {
        let name = s(&p["name"]);
        let data = bytes(&p["hex"]);
        assert_eq!(data.len(), Plan::SPACE, "{name}: size");
        let plan = Plan::try_deserialize(&mut &data[..]).unwrap_or_else(|e| panic!("{name}: {e:?}"));
        let expected = terms(terms_named(&k, s(&p["terms"])));
        assert_eq!(plan.version, Plan::VERSION, "{name}");
        assert_eq!(plan.bump as u64, p["bump"].as_u64().unwrap(), "{name}");
        assert_eq!(plan.terms_hash, expected.hash(), "{name}");
        assert_eq!(plan.terms, expected, "{name}");
        assert_eq!(plan.created_ts, int::<i64>(&p["created_ts"]), "{name}");
        assert_eq!(plan.activated, p["activated"].as_bool().unwrap(), "{name}");
        assert_eq!(plan.activated_ts, int::<i64>(&p["activated_ts"]), "{name}");
        assert_eq!(plan.closed_slot, int::<u64>(&p["closed_slot"]), "{name}");
        assert_eq!(plan.contingent_clock_ts, int::<i64>(&p["contingent_clock_ts"]), "{name}");
        // and back: the program writes the same bytes it was given
        let mut out = Vec::new();
        plan.try_serialize(&mut out).unwrap();
        assert_eq!(out, data, "{name}: re-encoded");
    }
}

#[test]
fn who_may_claim_and_when() {
    let k = kat();
    let cases = k["claim_role"].as_array().unwrap();
    assert_eq!(cases.len(), 10);
    for c in cases {
        let name = s(&c["name"]);
        let plan = plan_named(&k, s(&c["plan"]));
        let salt = (!c["salt_hex"].is_null()).then(|| arr32(&c["salt_hex"]));
        let got = match claim_role(&plan, &pk(&c["signer"]), salt.as_ref(), int(&c["now"])) {
            Ok(Role::Primary) => "primary".to_string(),
            Ok(Role::Contingent) => "contingent".to_string(),
            Err(anchor_lang::error::Error::AnchorError(e)) => e.error_name,
            Err(e) => format!("{e:?}"),
        };
        assert_eq!(got, s(&c["result"]), "{name}");
    }
}

fn metas(v: &Value) -> Vec<(Pubkey, bool, bool)> {
    v.as_array().unwrap().iter().map(|a| (pk(&a["pubkey"]), a["signer"].as_bool().unwrap(), a["writable"].as_bool().unwrap())).collect()
}

fn built(accounts: Vec<AccountMeta>) -> Vec<(Pubkey, bool, bool)> {
    accounts.into_iter().map(|m| (m.pubkey, m.is_signer, m.is_writable)).collect()
}

#[test]
fn instructions_as_anchor_builds_them() {
    use anchor_lang::solana_program::sysvar::instructions::ID as INSTRUCTIONS;
    use anchor_lang::system_program::ID as SYSTEM;

    let k = kat();
    let both = terms(terms_named(&k, "a primary and a contingent heir"));
    let sole = terms(terms_named(&k, "a sole heir"));
    let hashed = terms(terms_named(&k, "two hashed heirs"));
    let plan_of = |t: &Terms| Pubkey::find_program_address(&[PLAN_SEED, &t.hash()], &ID).0;
    let primary = both.primary.as_address().unwrap();
    let contingent = both.contingent.as_address().unwrap();
    let one = |b: u8| Pubkey::new_from_array([b; 32]);
    let (payer, mint, source, destination, extra) = (one(0x55), one(0x66), one(0x77), one(0x78), one(0x79));
    let salt_a = [0xa1u8; 32];
    let salt_b = [0xb2u8; 32];

    let init = |payer: Pubkey, t: &Terms, signing: &[Pubkey]| {
        let mut accounts = heir_claim::accounts::InitPlan { payer, plan: plan_of(t), vault: t.vault, instructions: INSTRUCTIONS, system_program: SYSTEM }.to_account_metas(None);
        accounts.extend(signing.iter().map(|h| AccountMeta::new_readonly(*h, true)));
        (heir_claim::instruction::InitPlan { terms_hash: t.hash(), terms: t.clone() }.data(), accounts)
    };
    let claim_token = |t: &Terms, heir: Pubkey, token_program: Pubkey, salt: Option<[u8; 32]>, close_account: bool, more: &[Pubkey]| {
        let mut accounts =
            heir_claim::accounts::ClaimToken { plan: plan_of(t), heir, plan_token_account: source, destination, mint, token_program }.to_account_metas(None);
        accounts.extend(more.iter().map(|a| AccountMeta::new_readonly(*a, false)));
        (heir_claim::instruction::ClaimToken { salt, close_account }.data(), accounts)
    };

    let expected: Vec<(&str, (Vec<u8>, Vec<AccountMeta>))> = vec![
        ("init_plan, the payer is the primary heir", init(primary, &sole, &[])),
        ("init_plan, both heirs sign beside the payer", init(payer, &both, &[primary, contingent])),
        ("activate", (heir_claim::instruction::Activate {}.data(), heir_claim::accounts::Activate { plan: plan_of(&both), vault: both.vault }.to_account_metas(None))),
        ("claim_sol, no salt", (heir_claim::instruction::ClaimSol { salt: None }.data(), heir_claim::accounts::ClaimSol { plan: plan_of(&both), heir: primary }.to_account_metas(None))),
        (
            "claim_sol, with a salt",
            (heir_claim::instruction::ClaimSol { salt: Some(salt_a) }.data(), heir_claim::accounts::ClaimSol { plan: plan_of(&hashed), heir: primary }.to_account_metas(None)),
        ),
        ("claim_token, close the account", claim_token(&both, primary, anchor_spl::token::ID, None, true, &[])),
        ("claim_token, Token-2022, with a salt, keep the account, one extra account", claim_token(&hashed, contingent, anchor_spl::token_2022::ID, Some(salt_b), false, &[extra])),
    ];

    let listed = k["instructions"].as_array().unwrap();
    assert_eq!(listed.len(), expected.len(), "the file lists these instructions and no other");
    for (name, (data, accounts)) in expected {
        let ix = listed.iter().find(|i| s(&i["name"]) == name).unwrap_or_else(|| panic!("no instruction named {name}"));
        assert_eq!(pk(&ix["program_id"]), ID, "{name}: program");
        assert_eq!(bytes(&ix["data_hex"]), data, "{name}: data");
        assert_eq!(metas(&ix["accounts"]), built(accounts), "{name}: accounts");
    }
}
