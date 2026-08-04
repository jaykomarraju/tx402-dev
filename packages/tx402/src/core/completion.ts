/**
 * SPEC §6.7's completion table, as a pure function (M6).
 *
 * What happens to a reservation after a signature has been transmitted is the single most
 * consequential decision in the SDK, and it is scattered across five clauses of §6.7. This
 * module states it once, as data-in / data-out, for three reasons:
 *
 *  1. **It is the rule Python must reproduce exactly.** `completion.paid-attempt`
 *     conformance vectors drive this function directly, so S10 inherits the table rather
 *     than re-deriving it from prose.
 *  2. **The ordering of the branches is normative.** A 402 is checked before a 5xx check
 *     could ever see it, and the `maxPaidAttempts` boundary is checked *inside* the 402
 *     branch — not as a separate loop guard — so exhaustion is a typed terminal outcome
 *     rather than a loop that quietly stops.
 *  3. **It keeps the money rule out of the control flow.** In `client.ts` the disposition
 *     is looked up and then obeyed; there is no `if` in the request path that can drift
 *     from the specification independently.
 *
 * The asymmetry the table encodes: **before** a signature reaches the merchant, a failure
 * releases the reservation. **After** it does, only evidence that no settlement occurred
 * may release it. A fresh 402 for the same resource is exactly that evidence — the merchant
 * is still asking to be paid — which is why a re-challenge releases while a 5xx retains.
 * Releasing on anything ambiguous would let the same money be spent twice against the
 * hourly cap.
 */

import { TX402_ERROR_CODES, type Tx402ErrorCode } from "./errors.js";

/** Raised when the merchant re-challenges on the last permitted signed attempt. */
export const MAX_PAID_ATTEMPTS_REASON = "max-paid-attempts-exhausted";

/**
 * What the merchant's PAYMENT-RESPONSE proves about settlement.
 *
 * `"unknown"` covers both an absent header and one that does not decode. Neither is
 * evidence in either direction, and conflating either with `"unsuccessful"` would refuse
 * a resource the merchant did deliver.
 */
export type SettlementEvidence = "success" | "unsuccessful" | "unknown";

/** How the one signature-bearing request of an attempt ended. */
export type PaidAttemptResult =
  /** The merchant answered. `status` is that answer. */
  | {
      readonly kind: "response";
      readonly status: number;
      readonly settlement: SettlementEvidence;
    }
  /** The answer was a cross-origin redirect, refused by SEC-005 after transmission. */
  | { readonly kind: "redirect-blocked" }
  /** No answer: connection failure, reset, or the tx402 deadline expiring. */
  | { readonly kind: "transport-failure" };

export interface PaidAttemptInput {
  /** 1-based, counting signed retries only — never the initial unpaid request. */
  readonly attempt: number;
  /** `policy.maxPaidAttempts`, already validated to 1–3 (SPEC §4.3). */
  readonly maxPaidAttempts: number;
  readonly result: PaidAttemptResult;
}

/** Terminal, with the outcome unknown. The reservation is held to its TTL. */
export interface AmbiguousDisposition {
  readonly kind: "ambiguous";
  readonly reservation: "retained";
  readonly errorCode: Tx402ErrorCode;
  readonly causeCategory: string;
}

/** What the request path must do with the reservation, and what it must report. */
export type PaidAttemptDisposition =
  /** Settlement stands. Commit the reservation and return the response. */
  | { readonly kind: "commit"; readonly reservation: "committed" }
  /** A fresh challenge with attempts remaining. Release, re-plan, re-sign. */
  | { readonly kind: "rechallenge"; readonly reservation: "released" }
  /** Terminal, with proof that no settlement occurred. */
  | {
      readonly kind: "failed";
      readonly reservation: "released";
      readonly errorCode: Tx402ErrorCode;
      readonly reason: string;
    }
  | AmbiguousDisposition;

const COMMIT: PaidAttemptDisposition = Object.freeze({
  kind: "commit",
  reservation: "committed",
});

const RECHALLENGE: PaidAttemptDisposition = Object.freeze({
  kind: "rechallenge",
  reservation: "released",
});

function failed(reason: string): PaidAttemptDisposition {
  return Object.freeze({
    kind: "failed",
    reservation: "released",
    errorCode: TX402_ERROR_CODES.resourceDelivery,
    reason,
  });
}

function ambiguous(causeCategory: string): AmbiguousDisposition {
  return Object.freeze({
    kind: "ambiguous",
    reservation: "retained",
    errorCode: TX402_ERROR_CODES.paymentAmbiguous,
    causeCategory,
  });
}

/**
 * A transmission that never completed is ambiguous whatever the cause, and the type says
 * so — the request path gets a `causeCategory` without a fallback branch that could never
 * run and could never be covered.
 */
export function classifyPaidAttempt(
  input: PaidAttemptInput & {
    readonly result: { readonly kind: "redirect-blocked" | "transport-failure" };
  },
): AmbiguousDisposition;
/**
 * Decides one signed attempt's outcome (SPEC §6.7). Pure: no clock, no I/O, no state.
 *
 * Branch order is part of the contract and is asserted by the conformance vectors.
 */
export function classifyPaidAttempt(input: PaidAttemptInput): PaidAttemptDisposition;
export function classifyPaidAttempt(input: PaidAttemptInput): PaidAttemptDisposition {
  const { result } = input;

  // Nothing came back. The signature is on the wire either way, so this is the canonical
  // ambiguous case — the one SPEC §6.7 names explicitly.
  if (result.kind === "transport-failure") return ambiguous("transport-after-signature");

  // SEC-005 stopped the *follow-up*, not the original transmission. The merchant already
  // has the signature and may well have settled against it.
  if (result.kind === "redirect-blocked") return ambiguous("redirect-blocked");

  if (result.status === 402) {
    // Checked here rather than as a loop guard: an exhausted budget of attempts must be a
    // typed terminal error, and this is the only place that knows it was a re-challenge
    // that exhausted it.
    return input.attempt < input.maxPaidAttempts
      ? RECHALLENGE
      : failed(MAX_PAID_ATTEMPTS_REASON);
  }

  // A server error is not a refusal. It says the merchant could not finish telling tx402
  // what happened, which is not the same as saying nothing happened.
  if (result.status >= 500) return ambiguous("server-error");

  // A same-origin redirect reaches here because v0.1 does not follow one (SPEC §6.1's
  // exception is not implemented — see the open item). A redirect is *not* a refusal: the
  // merchant may have settled and be pointing at the delivered resource. Releasing on it
  // would give back budget for money that moved, so it is ambiguous rather than failed.
  if (result.status >= 300 && result.status < 400)
    return ambiguous("redirect-not-followed");

  // Any other non-2xx is the merchant declining the request outright. Declining is a
  // statement that it did not settle.
  if (result.status < 200 || result.status >= 300) return failed("paid-request-rejected");

  // A 2xx whose own PAYMENT-RESPONSE says `success: false` is a merchant contradicting
  // itself. tx402 believes the payment metadata, not the status line.
  if (result.settlement === "unsuccessful") return failed("settlement-unsuccessful");

  return COMMIT;
}
