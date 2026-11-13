#!/usr/bin/env python3
"""Mutation check for heir-claim.

Breaks the program one way at a time, rebuilds it for Solana, and runs the LiteSVM suite. Every
mutant has to be caught by at least one test; a mutant that survives is a rule no test defends.
Each mutation is a text replacement in programs/heir-claim/src, undone before the next one.

    python3 tests/mutants/run.py            # all of them
    python3 tests/mutants/run.py clock      # only mutants whose name contains "clock"

Needs `cargo build-sbf` on the PATH. Exits non-zero if a mutant survives, or if a pattern no longer
matches the source (then the list below needs the same edit the source got).
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(ROOT, "programs", "heir-claim", "src")
BUILD = "cargo build-sbf --manifest-path programs/heir-claim/Cargo.toml"

# (what the mutant does, file, text to find exactly once, replacement)
MUTANTS = [
 ("contingent may claim at once", "lib.rs", "        require!(now >= plan.contingent_opens_at()?, ClaimError::ContingentTooEarly);\n", ""),
 ("ed25519 entries may point anywhere", "proof.rs", "        if signature_ix != THIS_INSTRUCTION || key_ix != THIS_INSTRUCTION || message_ix != THIS_INSTRUCTION {\n            continue;\n        }\n", ""),
 ("activate ignores whom the tombstone names", "lib.rs", "        require_keys_eq!(tomb.heir, plan.key(), ClaimError::TombstoneNamesAnother);\n", ""),
 ("tombstone believed from any owner", "tombstone.rs", "    require_keys_eq!(*ai.owner, VAULT_PROGRAM_ID, ClaimError::NotATombstone);\n", ""),
 ("tokens may go to anyone's account", "lib.rs", "        require_keys_eq!(destination_owner, heir_key, ClaimError::DestinationNotHeirs);\n", ""),
 ("any token account may be the source", "lib.rs", "        require_keys_eq!(source_owner, plan.key(), ClaimError::NotPlanTokenAccount);\n", ""),
 ("claim_sol takes the rent too", "lib.rs", "        let keep = Rent::get()?.minimum_balance(plan_ai.data_len());\n", "        let keep = 0u64;\n"),
 ("primary claim does not restart the clock", "lib.rs", "    if role == Role::Primary {\n        plan.contingent_clock_ts = now;\n    }\n", ""),
 ("heirs need not prove control", "lib.rs", "            require!(proven, ClaimError::HeirNotProven);\n", "            let _ = proven;\n"),
 ("claims before activation", "lib.rs", "    require!(plan.activated, ClaimError::NotActivated);\n", ""),
 ("init_plan takes any vault account", "lib.rs", "        require!(tombstone::is_live_vault(&ctx.accounts.vault) || released_to_this_plan, ClaimError::NotALiveVault);\n", ""),
 ("init_plan takes a vault that released to anyone", "lib.rs", ".is_ok_and(|t| t.heir == plan_key);\n", ".is_ok();\n"),
 ("init_plan refuses a vault that released to this plan", "lib.rs", "        require!(tombstone::is_live_vault(&ctx.accounts.vault) || released_to_this_plan, ClaimError::NotALiveVault);\n", "        require!(tombstone::is_live_vault(&ctx.accounts.vault), ClaimError::NotALiveVault);\n"),
 ("message accepted if it merely ends with the text", "proof.rs", "        && signed.starts_with(OFFCHAIN_DOMAIN)\n", ""),
 ("terms_hash unchecked", "lib.rs", "        require!(terms_hash == terms.hash(), ClaimError::TermsHashMismatch);\n", ""),
 ("second activate restarts everything", "lib.rs", "        if plan.activated {\n            return Ok(());\n        }\n", ""),
 ("vault account not tied to the terms at activate", "lib.rs", "    #[account(address = plan.terms.vault @ ClaimError::WrongVault)]\n    pub vault: UncheckedAccount<'info>,\n}\n\n#[derive(Accounts)]\npub struct ClaimSol", "    pub vault: UncheckedAccount<'info>,\n}\n\n#[derive(Accounts)]\npub struct ClaimSol"),
 ("contingent delay floor dropped", "state.rs", "                    (MIN_CONTINGENT_DELAY_SECS..=MAX_CONTINGENT_DELAY_SECS).contains(&self.contingent_delay_secs),", "                    self.contingent_delay_secs <= MAX_CONTINGENT_DELAY_SECS,"),
 ("a hashed heir matches without its salt", "state.rs", "                None => false,\n", "                None => true,\n"),
 ("the same heir may be named twice", "state.rs", "                require!(self.contingent != self.primary, ClaimError::SameHeirTwice);\n", ""),
 ("empty claim_token succeeds", "lib.rs", "        require!(amount > 0 || close_account, ClaimError::NothingToClaim);\n", ""),
 ("mint of the source unchecked", "lib.rs", "        require_keys_eq!(source_mint, mint_ai.key(), ClaimError::WrongMint);\n", ""),
]


def sh(cmd, cwd):
    return subprocess.run(cmd, cwd=cwd, shell=True, capture_output=True, text=True)


def ran_and_failed(output):
    lines = [l for l in output.splitlines() if l.startswith("test ") and " ... " in l]
    return len(lines), [l.split()[1] for l in lines if l.rstrip().endswith("FAILED")]


def main():
    only = sys.argv[1:]
    bad = []
    # A mutant counts as caught when a test fails. That means nothing unless every test passes
    # without the mutation: a missing build, a stale file or a broken machine would otherwise
    # "catch" everything. So the untouched program goes first, and has to be green.
    build = sh(BUILD, ROOT)
    if build.returncode != 0:
        print("the untouched program does not build:", build.stderr[-400:])
        return 1
    ran, failed = ran_and_failed(sh("cargo test 2>&1", os.path.join(ROOT, "tests", "svm")).stdout)
    if ran == 0 or failed:
        print(f"the untouched program must pass every test before a mutant can be called caught: {ran} ran, {len(failed)} failed {failed[:5]}")
        return 1
    print(f"baseline  {ran} tests pass on the untouched program", flush=True)
    for name, file, old, new in MUTANTS:
        if only and not any(o in name for o in only):
            continue
        path = os.path.join(SRC, file)
        with open(path) as f:
            original = f.read()
        if original.count(old) != 1:
            print(f"SETUP     {name}: pattern found {original.count(old)} times in {file}", flush=True)
            bad.append(name)
            continue
        try:
            with open(path, "w") as f:
                f.write(original.replace(old, new))
            build = sh(BUILD, ROOT)
            if build.returncode != 0:
                # a mutant that does not compile cannot ship; it tells us nothing about the tests
                print(f"NO BUILD  {name}", flush=True)
                bad.append(name)
                continue
            test = sh("cargo test 2>&1", os.path.join(ROOT, "tests", "svm"))
            failed = [l.split()[1] for l in test.stdout.splitlines() if l.startswith("test ") and l.rstrip().endswith("FAILED")]
            if failed:
                print(f"caught    {name}: {len(failed)} test(s), e.g. {failed[0]}", flush=True)
            else:
                print(f"SURVIVED  {name}", flush=True)
                bad.append(name)
        finally:
            with open(path, "w") as f:
                f.write(original)
    restored = sh(BUILD, ROOT)
    if restored.returncode != 0:
        print("the restored source does not build:", restored.stderr[-400:])
        return 1
    if bad:
        print(f"{len(bad)} mutant(s) not caught: {bad}")
        return 1
    print("every mutant was caught")
    return 0


if __name__ == "__main__":
    sys.exit(main())
