"""Inspect a merchant's terms without paying, and without a key.

    export TX402_MERCHANT_URL=https://...
    python examples/python/dry_run.py

``client.plan()`` runs the real decision path — decode, policy, route planning, ranking —
and stops before the budget reservation. No signature is produced and no budget is
consumed, so this is safe to run in a loop, in CI, or from an agent that should be able to
find out what something costs without being able to buy it.

This is the same call that backs the CLI's ``--dry-run``. It lives on the client rather
than in the CLI precisely so a dry run predicts the *shipped* decision path instead of a
second implementation of it.
"""

from __future__ import annotations

import os
import sys

from tx402 import Policy, Tx402Client
from tx402.errors import Tx402Error

MERCHANT_URL = os.environ.get("TX402_MERCHANT_URL")
if not MERCHANT_URL:
    print("Set TX402_MERCHANT_URL first.", file=sys.stderr)
    raise SystemExit(2)


def main() -> int:
    from urllib.parse import urlsplit

    # The SDK requires HTTPS for every merchant; this opt-in is scoped to localhost by the
    # SDK itself and derived from the URL, so copying this file carries no relaxation.
    is_localhost = (urlsplit(MERCHANT_URL).hostname or "") in {
        "localhost",
        "127.0.0.1",
        "::1",
    }

    # No signers configured at all. Route planning reports every offered requirement as a
    # candidate with `no-signer-configured`, which is exactly what you want to see when you
    # are asking "what would this cost me?" rather than "pay this".
    with Tx402Client(
        allow_insecure_localhost=is_localhost,
        policy=Policy(
            max_per_request="1.00 USDC",
            # Testnets are never allowed by default (SPEC §4.3): a silent fall back from
            # production to a testnet is worse than a refusal (SPEC §16).
            allowed_networks=["eip155:84532", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"],
        ),
    ) as tx402:
        try:
            plan = tx402.plan("GET", MERCHANT_URL)
        except Tx402Error as error:
            # A plan can fail for every reason a real call can, minus the ones that only
            # exist after signing — which is what makes it a useful preflight.
            print(f"{type(error).code}: {error.message}", file=sys.stderr)
            return 1

        if plan.payment_required is None:
            print(f"No payment required — the resource answered {plan.response.status_code}.")
            return 0

        print(f"request      {plan.request_id}")
        print(f"requirements {len(plan.payment_required['requirements'])}")
        print(f"header hash  {plan.payment_required['headerHash']}\n")

        print("What the merchant accepts:")
        for requirement in plan.payment_required["requirements"]:
            print(
                f"  [{requirement['index']}] {requirement['amountAtomic']} atomic  "
                f"{requirement['scheme']} on {requirement['network']}"
            )

        print("\nHow tx402 ranked them:")
        for candidate in plan.candidates or ():
            status = (
                "viable"
                if candidate.viable
                else f"not viable — {', '.join(candidate.rejection_reasons)}"
            )
            print(
                f"  #{candidate.rank} {candidate.network}  "
                f"health {candidate.health_score:.2f}  {status}"
            )

        if plan.selected is not None:
            print(
                f"\nWould pay {plan.selected.amount_atomic} atomic "
                f"on {plan.selected.network}."
            )
        print("Nothing was signed and no budget was reserved.")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
