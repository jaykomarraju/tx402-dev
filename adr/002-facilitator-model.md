# ADR-002 — Facilitator model

**Status:** Accepted · transcribed from `SPEC.md` §2 (ADR-002)

## Context

The canonical x402 flow sends the signed payment payload back to the **merchant**; the merchant
verifies and settles, either directly or through a facilitator. Buyer-side direct settlement would
violate role boundaries and create duplicate-settlement races.

## Decision

The client creates payment payloads but **does not** call `/verify` or `/settle` as part of the
normal buyer flow. Facilitator configuration in the buyer SDK is used **only** for compatibility
discovery, health metadata, and diagnostics, and only when the `PaymentRequired` object identifies
or permits facilitator selection.

## Consequences

- The resource retry is authoritative. A successful HTTP response plus a valid `PAYMENT-RESPONSE`
  is the payment outcome.
- Facilitator health can influence route _ordering_ but can never override merchant requirements or
  authorize a network the merchant did not offer.
- The PRD's framing of "facilitator failover" (PRD §F1) is **superseded** by this ADR together with
  ADR-003. tx402 does not race facilitator settle calls. What fails over is the set of
  merchant-offered payment requirements and the RPC endpoints used to evaluate them.
