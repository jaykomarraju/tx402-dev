/**
 * Inspect a merchant's terms without paying, and without a key.
 *
 *   export TX402_MERCHANT_URL=https://...
 *   pnpm --filter tx402-example-typescript dry-run
 *
 * `client.plan()` runs the real decision path — decode, policy, route planning, ranking —
 * and stops before the budget reservation. No signature is produced and no budget is
 * consumed, so this is safe to run in a loop, in CI, or from an agent that should be able
 * to find out what something costs without being able to buy it.
 *
 * This is the same call that backs the CLI's `--dry-run`. It lives on the client rather
 * than in the CLI precisely so that a dry run predicts the *shipped* decision path instead
 * of a second implementation of it.
 */

import { createTx402Client, isTx402Error } from "tx402";

const MERCHANT_URL = process.env["TX402_MERCHANT_URL"];
if (MERCHANT_URL === undefined) {
  console.error("Set TX402_MERCHANT_URL first.");
  process.exit(2);
}

// No signers configured at all. Route planning will report every offered requirement as a
// candidate with `no-signer-configured`, which is exactly what you want to see when you
// are asking "what would this cost me?" rather than "pay this".
const tx402 = createTx402Client({
  policy: { maxPerRequest: "1.00 USDC" },
});

try {
  const plan = await tx402.plan(MERCHANT_URL);

  if (plan.paymentRequired === undefined) {
    console.log(`No payment required — the resource answered ${plan.response.status}.`);
    process.exit(0);
  }

  console.log(`request      ${plan.requestId}`);
  console.log(`requirements ${plan.paymentRequired.requirements.length}`);
  console.log(`header hash  ${plan.paymentRequired.headerHash}\n`);

  console.log("What the merchant accepts:");
  for (const requirement of plan.paymentRequired.requirements) {
    console.log(
      `  [${requirement.index}] ${requirement.amountAtomic} atomic  ` +
        `${requirement.scheme} on ${requirement.network}`,
    );
  }

  console.log("\nHow tx402 ranked them:");
  for (const candidate of plan.candidates ?? []) {
    const status = candidate.viable
      ? "viable"
      : `not viable — ${candidate.rejectionReasons.join(", ")}`;
    console.log(
      `  #${candidate.rank} ${candidate.network}  health ${candidate.healthScore.toFixed(2)}  ${status}`,
    );
  }

  if (plan.selected !== undefined) {
    console.log(
      `\nWould pay ${plan.selected.amountAtomic} atomic on ${plan.selected.network}.`,
    );
  }
  console.log("Nothing was signed and no budget was reserved.");
} catch (error) {
  if (!isTx402Error(error)) throw error;
  // A plan can fail for every reason a real call can, minus the ones that only exist after
  // signing — which is what makes it a useful preflight.
  console.error(`${error.code}: ${error.message}`);
  process.exitCode = 1;
}
