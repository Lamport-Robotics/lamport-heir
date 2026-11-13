/** Writes `kat/claim_encoding.json`. Run with `npm run kat`; the tests fail if the file is stale. */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildClaimKat } from "./claim-kat.ts";

const path = fileURLToPath(new URL("../../kat/claim_encoding.json", import.meta.url));
writeFileSync(path, JSON.stringify(buildClaimKat(), null, 2) + "\n");
console.log(`wrote ${path}`);
