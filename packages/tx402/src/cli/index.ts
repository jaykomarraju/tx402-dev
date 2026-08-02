#!/usr/bin/env node
/**
 * tx402 CLI — "Wireshark for HTTP 402".
 *
 * Bundled into the `tx402` package via the `bin` field so that `npx tx402` resolves with
 * no second install (ADR-009). This file is a **separate build entry**: it is not reachable
 * from the core import path and its dependencies never count against the ADR-008 size gate.
 *
 * The full command surface (`call`, `--dry-run`, `--json`, `--max-spend`, `--network`,
 * `--timeout`, and exit codes 0/2/3/4/5/6/7/8/9) lands in M7 (PLAN.md §6, session S11)
 * per SPEC §11.
 */

import { PACKAGE_NAME, PROJECT_URLS } from "../meta.js";

/** CLI exit codes. Normative — SPEC §11. */
export const EXIT_CODES = {
  success: 0,
  usage: 2,
  policy: 3,
  liquidity: 4,
  protocol: 5,
  signer: 6,
  transport: 7,
  ambiguousPayment: 8,
  resourceFailure: 9,
} as const;

const USAGE = `${PACKAGE_NAME} — resilient x402 buyer client

Usage:
  tx402 call <URL> [options]

Options:
  --method <METHOD>     HTTP method (default: GET)
  --body @<file>        Request body read from a file
  --max-spend <MONEY>   Per-request cap, e.g. "0.10 USDC"
  --network <CAIP2>     Restrict to one network
  --dry-run             Parse, evaluate policy, plan routes; never invoke a signer
  --json                Emit one JSON object to stdout
  --timeout <MS>        Request timeout in milliseconds
  -h, --help            Show this message
  -v, --version         Show version

Docs: ${PROJECT_URLS.documentation}

Note: this CLI is a scaffold. Commands land in milestone M7.
Private keys are never accepted as command-line flags.`;

export function main(argv: readonly string[]): number {
  const args = argv.slice(2);

  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT_CODES.success;
  }

  if (args.includes("-v") || args.includes("--version")) {
    process.stdout.write(`${PACKAGE_NAME} 0.0.0\n`);
    return EXIT_CODES.success;
  }

  // Human-readable diagnostics go to stderr; stdout is reserved for the response body
  // and for --json output (SPEC §11).
  process.stderr.write(
    `tx402: command not implemented yet — the CLI lands in milestone M7.\n${USAGE}\n`,
  );
  return EXIT_CODES.usage;
}

process.exitCode = main(process.argv);
