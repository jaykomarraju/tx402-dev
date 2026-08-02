"""tx402 Python console entry point.

The primary CLI is the TypeScript one (``npx tx402``), specified in SPEC §11 and built
in M7. This entry point exists so that ``pip install tx402`` also puts a ``tx402``
command on PATH, and it deliberately shares the same exit codes.

Private keys are never accepted as command-line flags.
"""

from __future__ import annotations

import sys
from typing import Final

from tx402.meta import PACKAGE_NAME, PROJECT_URLS

#: CLI exit codes. Normative — SPEC §11.
EXIT_CODES: Final[dict[str, int]] = {
    "success": 0,
    "usage": 2,
    "policy": 3,
    "liquidity": 4,
    "protocol": 5,
    "signer": 6,
    "transport": 7,
    "ambiguous_payment": 8,
    "resource_failure": 9,
}

USAGE: Final = f"""{PACKAGE_NAME} — resilient x402 buyer client

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

Docs: {PROJECT_URLS["documentation"]}

Note: this CLI is a scaffold. Commands land in milestone M7.
Private keys are never accepted as command-line flags."""


def main(argv: list[str]) -> int:
    """Run the CLI and return a process exit code."""
    args = argv[1:]

    if not args or "-h" in args or "--help" in args:
        sys.stdout.write(f"{USAGE}\n")
        return EXIT_CODES["success"]

    if "-v" in args or "--version" in args:
        sys.stdout.write(f"{PACKAGE_NAME} 0.0.0\n")
        return EXIT_CODES["success"]

    # Human-readable diagnostics go to stderr; stdout is reserved for the response body
    # and for --json output (SPEC §11).
    sys.stderr.write(
        f"tx402: command not implemented yet — the CLI lands in milestone M7.\n{USAGE}\n"
    )
    return EXIT_CODES["usage"]


def run() -> None:
    """Console-script shim registered as the ``tx402`` command."""
    raise SystemExit(main(sys.argv))
