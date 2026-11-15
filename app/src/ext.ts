/**
 * Lamport Heir's module for the seam the vault's page and signer leave open
 * (vendor/lamport-vault/web/src/heir-ext.ts): the build puts this file in that one's place.
 *
 *   explainClaim    for the page and the cold signer: who is behind a plan's address, derived
 *                   again from the terms in the request (terms.ts)
 *   claimComposer   for the page: choose heirs, collect their acceptances, create the plan
 *   extraPanels     for the page: the check-in key kept on this device, and the heirs' kits
 *
 * The cold signer reaches only the first. The other two are in files of their own, which talk to
 * the network and which the signer's bundle must not carry: the build checks that it does not.
 */
export { explainClaim, type ClaimExplained } from "./terms.ts";
export { claimComposer } from "./composer.ts";
export { extraPanels } from "./panels.ts";
