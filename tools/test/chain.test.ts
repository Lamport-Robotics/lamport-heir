import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { base58, reasonFromLogs } from "../src/chain.ts";

describe("base58", () => {
  it("agrees with web3.js on 32-byte values, leading zeros included", () => {
    for (let i = 0; i < 20; i++) {
      const bytes = Keypair.generate().publicKey.toBytes();
      if (i % 4 === 0) bytes[0] = 0;
      if (i % 8 === 0) bytes[1] = 0;
      expect(base58(bytes)).toBe(new PublicKey(bytes).toBase58());
    }
    expect(base58(new Uint8Array(32))).toBe(PublicKey.default.toBase58());
  });

  it("encodes the short values RPC filters use", () => {
    expect(base58(Uint8Array.of(1))).toBe("2");
    expect(base58(Uint8Array.of(0))).toBe("1");
    expect(base58(Uint8Array.of(0, 1))).toBe("12");
    expect(base58(new Uint8Array(0))).toBe("");
  });
});

describe("reasonFromLogs", () => {
  it("prefers what an Anchor program said", () => {
    const logs = [
      "Program HK1Q invoke [1]",
      "Program log: Instruction: ExecuteSuccession",
      "Program log: AnchorError thrown in programs/lamport-vault/src/succession.rs:204. Error Code: WaitNotOver. Error Number: 6108. Error Message: the waiting period is not over.",
      "Program HK1Q failed: custom program error: 0x17dc",
    ];
    expect(reasonFromLogs(logs)).toBe("WaitNotOver (6108): the waiting period is not over");
  });

  it("then what a token program said", () => {
    expect(reasonFromLogs(["Program log: Instruction: TransferChecked", "Program log: Error: Account is frozen", "Program Tokenz failed: custom program error: 0x11"])).toBe("Account is frozen");
  });

  it("puts a token program's error number into words", () => {
    const refused = (code: string) => [
      "Program 3pwH161r4SZRH6nCHY4RUm7gk2NZqypyFJaUgv9a2duG invoke [1]",
      "Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb invoke [2]",
      "Program log: Instruction: TransferChecked",
      `Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb failed: custom program error: ${code}`,
      `Program 3pwH161r4SZRH6nCHY4RUm7gk2NZqypyFJaUgv9a2duG failed: custom program error: ${code}`,
    ];
    expect(reasonFromLogs(refused("0x25"))).toBe("this token is non-transferable: nobody can move it (token program error 0x25)");
    expect(reasonFromLogs(refused("0x11"))).toMatch(/frozen/);
    expect(reasonFromLogs(refused("0x23"))).toMatch(/withheld transfer fees/);
    expect(reasonFromLogs(refused("0x24"))).toMatch(/memo/);
    expect(reasonFromLogs(refused("0x43"))).toMatch(/paused/);
    // a number it has no words for is passed on as it is
    expect(reasonFromLogs(refused("0x2a"))).toBe("custom program error: 0x2a");
    // the same number from another program means something else, and is not translated
    expect(reasonFromLogs(["Program 3pwH161r4SZRH6nCHY4RUm7gk2NZqypyFJaUgv9a2duG failed: custom program error: 0x25"])).toBe("custom program error: 0x25");
  });

  it("then the bare failure line, and nothing when there is none", () => {
    expect(reasonFromLogs(["Program X invoke [1]", "Program X failed: insufficient funds for rent"])).toBe("insufficient funds for rent");
    expect(reasonFromLogs(["Program X invoke [1]", "Program X success"])).toBeUndefined();
    expect(reasonFromLogs([])).toBeUndefined();
  });
});
