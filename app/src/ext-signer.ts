/**
 * The same seam as ext.ts, for the cold signer's build. The signer learns one thing from Lamport
 * Heir: how to derive a plan's address again from the heirs a request names (terms.ts). The other
 * two functions belong to the page, and their files talk to the network; the signer's bundle is
 * built from this file so that it never contains them.
 */
export { explainClaim, type ClaimExplained } from "./terms.ts";

export function claimComposer(): HTMLElement | null {
  return null;
}

export function extraPanels(): HTMLElement | null {
  return null;
}
