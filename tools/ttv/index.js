#!/usr/bin/env node
/**
 * Time-to-value measurement (SPEC §16).
 *
 *   . tools/live-env.sh && node tools/ttv/index.js
 *
 * The release-defining check is that a fresh user completes **a real paid call in under
 * five minutes without reading source code**. This script measures the part of that a
 * machine can measure: the wall-clock time from "an installed package and a funded wallet"
 * to "a settled on-chain payment and a delivered resource", following the documented
 * quickstart path.
 *
 * **The settlement is real.** The merchant runs locally, and that does not make the money
 * fake — settlement does, and this settles. The merchant is wired to the public x402
 * facilitator at https://x402.org/facilitator, which verifies the EIP-3009 authorization
 * and broadcasts the transfer on Base Sepolia. Real testnet USDC moves, and the
 * transaction hash the facilitator returns is printed and recorded.
 *
 * ADR-002 keeps `/verify` and `/settle` on the merchant, so the buyer SDK still never
 * learns a facilitator exists. That separation is exactly what makes a local merchant a
 * legitimate fixture here: the buyer's code path is the shipped one, byte for byte, and
 * the only thing the fixture supplies is the counterparty.
 *
 * Why not the public demo merchant: `x402.org/protected` returns 502.
 */

import { createTestMerchant } from "@tx402-dev/test-merchant";

import { BUNDLED_MANIFEST } from "../../packages/tx402/dist/core/bundled-manifest.js";
import { createTx402Client } from "../../packages/tx402/dist/index.js";
import { privateKeyToEvmSigner } from "../../packages/tx402/dist/signers/index.js";

const FACILITATOR = process.env["TX402_FACILITATOR_URL"] ?? "https://x402.org/facilitator";
const NETWORK = "eip155:84532";
const PRIVATE_KEY = process.env["TX402_BASE_SEPOLIA_PRIVATE_KEY"];

/**
 * Where the test merchant is paid.
 *
 * Defaults to a throwaway Base Sepolia address that nothing in this project holds a key
 * for. Each run sends it 0.001 USDC, which is the price of proving that value genuinely
 * left the payer's wallet. Override with `TX402_TTV_PAY_TO` to send it somewhere you own.
 */
const PAY_TO =
  process.env["TX402_TTV_PAY_TO"] ?? "0x1CB8D0000000000000000000000000000000402A";

if (PRIVATE_KEY === undefined) {
  console.error(
    "TX402_BASE_SEPOLIA_PRIVATE_KEY is not set.\n" +
      "Run `. tools/live-env.sh` first — it normalises the .env names and prints which\n" +
      "resolved. Without it the live suites silently skip and look exactly like an\n" +
      "unfunded wallet (PLAN.md open item O33).",
  );
  process.exit(2);
}

const network = BUNDLED_MANIFEST.networks[NETWORK];
const usdc = network.assets[0];

/** One pass of the quickstart, timed by phase. */
async function main() {
  const marks = [];
  const started = performance.now();
  const mark = (label) =>
    marks.push({ label, atMs: Math.round(performance.now() - started) });

  // Confirm the facilitator supports what we are about to ask of it, before spending
  // anyone's time. A merchant offering terms its facilitator cannot settle is a
  // configuration error, and finding it here rather than after a signature is cheaper.
  const supported = await (await fetch(`${FACILITATOR}/supported`)).json();
  const kind = supported.kinds.find(
    (entry) =>
      entry.x402Version === 2 && entry.scheme === "exact" && entry.network === NETWORK,
  );
  if (kind === undefined) {
    throw new Error(`facilitator does not support exact/${NETWORK} at x402Version 2`);
  }
  mark("facilitator capability confirmed");

  const evm = privateKeyToEvmSigner(PRIVATE_KEY);
  const payer = await evm.getAddress();
  mark("signer ready");
  console.log(`  payer         ${payer}`);
  console.log(`  merchant      ${PAY_TO}`);

  const merchant = await createTestMerchant({
    scenario: "pay-once",
    facilitatorUrl: FACILITATOR,
    body: JSON.stringify({ ok: true, resource: "ttv" }),
    requirements: [
      {
        scheme: "exact",
        network: NETWORK,
        asset: usdc.address,
        // 0.001 USDC. Small enough to run this repeatedly, large enough to be a real
        // ERC-20 transfer rather than a zero-value no-op.
        amount: "1000",
        // A recipient the payer does not control, so the on-chain `Transfer` is a genuine
        // buyer→merchant movement rather than a self-transfer. Paying yourself would still
        // consume the EIP-3009 authorization and still prove settlement, but it would leave
        // "did value actually leave the wallet" untested, which is the one question a
        // payment SDK cannot afford to leave open.
        payTo: PAY_TO,
        maxTimeoutSeconds: 120,
        extra: { name: "USDC", version: usdc.eip712Version },
      },
    ],
  });
  mark("merchant listening");

  const tx402 = createTx402Client({
    signers: { evm },
    policy: {
      maxPerRequest: "0.10 USDC",
      maxPerHour: "1.00 USDC",
      allowedNetworks: [NETWORK],
    },
    allowInsecureLocalhost: true,
  });
  mark("client constructed");

  try {
    // --- the dry run a first-time user does first --------------------------------------
    const plan = await tx402.plan(`${merchant.url}/resource`);
    mark("dry run complete (no signature, no reservation)");
    console.log(
      `  plan: ${plan.selected?.amountAtomic} atomic on ${plan.selected?.network}, ` +
        `rank ${plan.selected?.rank} of ${plan.candidates?.length}`,
    );

    // --- the real, settled call ---------------------------------------------------------
    const paidAt = performance.now();
    const response = await tx402.fetch(`${merchant.url}/resource`);
    const paidMs = Math.round(performance.now() - paidAt);
    mark("paid call complete");

    const settlement = merchant.requests.find((entry) => entry.settlement)?.settlement;
    const body = await response.text();

    console.log(`\n  status        ${response.status}`);
    console.log(`  body          ${body}`);
    console.log(`  settled       ${settlement?.success}`);
    console.log(`  transaction   ${settlement?.transaction}`);
    console.log(
      `  explorer      https://sepolia.basescan.org/tx/${settlement?.transaction}`,
    );
    console.log(`  paid call     ${paidMs} ms`);

    if (settlement?.success !== true) {
      throw new Error(
        `settlement did not succeed: ${settlement?.errorReason ?? "unknown"}. ` +
          "The payment was not real, so this measurement does not count.",
      );
    }

    console.log("\n  Phase timings");
    let previous = 0;
    for (const { label, atMs } of marks) {
      console.log(`    ${String(atMs).padStart(6)} ms  (+${atMs - previous})  ${label}`);
      previous = atMs;
    }

    const totalMs = marks.at(-1).atMs;
    const budgetMs = 5 * 60 * 1000;
    console.log(
      `\n  TOTAL ${totalMs} ms (${(totalMs / 1000).toFixed(2)} s) ` +
        `against a ${budgetMs / 1000} s budget — ${totalMs < budgetMs ? "PASS" : "FAIL"}`,
    );
    if (totalMs >= budgetMs) process.exitCode = 1;
  } finally {
    await merchant.close();
  }
}

await main();
