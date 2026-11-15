//! The ids each build compiles in: its own, and the one vault program whose tombstones it believes.
//!
//! The claim program pays out on the word of a tombstone, and believes one only from the vault
//! program compiled in here. A claim program paired with the wrong vault program either never
//! releases anything or believes a program that is not the vault, so the pairs are fixed per
//! build (docs/program-ids.md) and this test is run once per feature set in CI.

use heir_claim::{ID, VAULT_PROGRAM_ID};

const DEVNET: (&str, &str) = ("cvxRorjDzekSCcAyiinzgALnBT1dTuUdVvEraPeDkUW", "3mJU9ozZByXsHavMGfzdwDLFs9YuFaMA3jabaLwczxAV");
const SHORT_CLOCKS: (&str, &str) = ("HxMZSdKeFP2zJzhYUVNHefqEEz3B87EdTRjKwwPG6UhE", "3pwH161r4SZRH6nCHY4RUm7gk2NZqypyFJaUgv9a2duG");
const MAINNET: (&str, &str) = ("L8EWcWfZbPu3iWNSkShaFJYwLgQ5vAdjLQNzP2DY8Yf", "3XsnTrQJ5XmFyEyVauMmMseHph4wXkn6QWUZCRPjuEEX");

#[test]
fn the_pair_is_the_one_these_features_name() {
    let (claim, vault) = if cfg!(feature = "short-clocks") {
        SHORT_CLOCKS
    } else if cfg!(feature = "mainnet") {
        MAINNET
    } else {
        DEVNET
    };
    assert_eq!(ID.to_string(), claim);
    assert_eq!(VAULT_PROGRAM_ID.to_string(), vault);
}

#[test]
fn no_two_builds_share_an_id() {
    let all = [DEVNET.0, DEVNET.1, SHORT_CLOCKS.0, SHORT_CLOCKS.1, MAINNET.0, MAINNET.1];
    for (i, a) in all.iter().enumerate() {
        for b in &all[i + 1..] {
            assert_ne!(a, b);
        }
    }
}
