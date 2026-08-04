/**
 * Scenario catalogue for the deterministic test merchant.
 *
 * Each scenario is a small state machine over attempt numbers rather than a bag of flags,
 * because most of what needs testing is a *sequence*: challenge, then pay, then re-challenge.
 * A flag-based server cannot express "402 on the paid retry, then 200 on the one after".
 *
 * Every scenario maps to something normative. The `covers` field records what, so that a
 * scenario nobody can justify is visible as such.
 */

/** Default requirements offered when a caller does not supply their own. */
export const DEFAULT_REQUIREMENTS = {
  base: {
    scheme: "exact",
    network: "eip155:8453",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    amount: "50000",
    payTo: "0x1234567890AbcdEF1234567890aBcdef12345678",
    maxTimeoutSeconds: 60,
    extra: {},
  },
  baseSepolia: {
    scheme: "exact",
    network: "eip155:84532",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    amount: "50000",
    payTo: "0x1234567890AbcdEF1234567890aBcdef12345678",
    maxTimeoutSeconds: 60,
    extra: {},
  },
  solana: {
    scheme: "exact",
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amount: "50000",
    payTo: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    maxTimeoutSeconds: 60,
    extra: {},
  },
  solanaDevnet: {
    scheme: "exact",
    network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    amount: "50000",
    payTo: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    maxTimeoutSeconds: 60,
    extra: {},
  },
};

/**
 * An action the server takes for one request.
 *
 * @typedef {object} Action
 * @property {"challenge"|"deliver"|"malformed-challenge"|"status"|"redirect"|"hang"|"reject"} type
 * @property {number} [status]
 * @property {string} [location]
 * @property {boolean} [omitPaymentResponse]
 * @property {"corrupt"|"unsuccessful"} [paymentResponse] how to spoil PAYMENT-RESPONSE
 * @property {string} [reason]
 */

/**
 * @typedef {object} Scenario
 * @property {string} description
 * @property {string[]} covers  normative clauses or test IDs this scenario exists for
 * @property {(context: {paidAttempt: number, hasSignature: boolean}) => Action} next
 */

/** @type {Record<string, Scenario>} */
export const SCENARIOS = {
  "unpaid-200": {
    description: "Never challenges. The resource is free.",
    covers: ["T-001"],
    next: () => ({ type: "deliver", status: 200, omitPaymentResponse: true }),
  },

  "pay-once": {
    description:
      "Challenges the first request, then delivers once a valid signature arrives.",
    covers: ["T-002", "T-003", "SPEC §6.7"],
    next: ({ hasSignature }) =>
      hasSignature ? { type: "deliver", status: 200 } : { type: "challenge" },
  },

  "always-402": {
    description:
      "Challenges every request, including paid retries, without ever accepting payment.",
    covers: ["SPEC §6.7 maxPaidAttempts"],
    next: () => ({ type: "challenge" }),
  },

  "rechallenge-once": {
    description:
      "Challenges, rejects the first paid attempt with a fresh 402, then accepts the second.",
    covers: ["T-010"],
    next: ({ paidAttempt }) =>
      paidAttempt >= 2 ? { type: "deliver", status: 200 } : { type: "challenge" },
  },

  "rechallenge-malformed": {
    description:
      "Challenges normally, then answers the paid attempt with a 402 whose PAYMENT-REQUIRED " +
      "does not decode. The re-challenge gets the same strict parse the first one did.",
    covers: ["T-010", "SPEC §6.2", "SPEC §6.7"],
    next: ({ hasSignature }) =>
      hasSignature ? { type: "malformed-challenge" } : { type: "challenge" },
  },

  "malformed-challenge": {
    description: "Returns a 402 whose PAYMENT-REQUIRED header is not decodable.",
    covers: ["T-009", "SPEC §6.2"],
    next: () => ({ type: "malformed-challenge" }),
  },

  "missing-payment-response": {
    description:
      "Accepts payment and returns 200 but omits PAYMENT-RESPONSE. Accepted with a warning " +
      "only where the pinned protocol marks it optional (SPEC §6.7).",
    covers: ["SPEC §6.7"],
    next: ({ hasSignature }) =>
      hasSignature
        ? { type: "deliver", status: 200, omitPaymentResponse: true }
        : { type: "challenge" },
  },

  "corrupt-payment-response": {
    description:
      "Accepts payment and delivers, but the PAYMENT-RESPONSE header does not decode. The " +
      "buyer cannot read it as evidence in either direction, so the resource is delivered " +
      "with a diagnostic warning rather than being treated as a failure.",
    covers: ["SPEC §6.7"],
    next: ({ hasSignature }) =>
      hasSignature
        ? { type: "deliver", status: 200, paymentResponse: "corrupt" }
        : { type: "challenge" },
  },

  "unsuccessful-settlement": {
    description:
      "Delivers a 200 whose PAYMENT-RESPONSE reports success:false. A merchant contradicting " +
      "itself is not a payment; the buyer must not commit the spend.",
    covers: ["SPEC §6.7", "SPEC §5.3"],
    next: ({ hasSignature }) =>
      hasSignature
        ? { type: "deliver", status: 200, paymentResponse: "unsuccessful" }
        : { type: "challenge" },
  },

  "error-after-signature": {
    description:
      "Challenges, then returns 503 to the paid retry. The signature was transmitted, so the " +
      "outcome is ambiguous and the reservation must be retained.",
    covers: ["T-011", "SPEC §6.7"],
    next: ({ hasSignature }) =>
      hasSignature ? { type: "status", status: 503 } : { type: "challenge" },
  },

  "refused-after-signature": {
    description:
      "Challenges, then answers the paid retry with 403. The merchant refused the request " +
      "outright rather than failing to complete it, so no settlement exists and the buyer's " +
      "reservation must be released rather than retained.",
    covers: ["SPEC §6.7", "SPEC §5.3"],
    next: ({ hasSignature }) =>
      hasSignature ? { type: "status", status: 403 } : { type: "challenge" },
  },

  "hang-after-signature": {
    description:
      "Challenges, then never responds to the paid retry. Same ambiguity as a 5xx, reached " +
      "through a timeout instead.",
    covers: ["T-011"],
    next: ({ hasSignature }) => (hasSignature ? { type: "hang" } : { type: "challenge" }),
  },

  "cross-origin-redirect": {
    description:
      "Challenges, then answers the paid retry with a 307 to a different origin. Must be " +
      "blocked before the signature is transmitted onward.",
    covers: ["T-012", "SEC-005"],
    next: ({ hasSignature }) =>
      hasSignature
        ? { type: "redirect", status: 307, location: "https://elsewhere.example.net/paid" }
        : { type: "challenge" },
  },

  "same-origin-redirect": {
    description:
      "Challenges, then answers the paid retry with a same-origin 307. Permitted — the " +
      "counterpart to cross-origin-redirect, so the block is provably not blanket.",
    covers: ["SEC-005", "SPEC §6.1"],
    next: ({ hasSignature }) =>
      hasSignature
        ? { type: "redirect", status: 307, location: "/delivered" }
        : { type: "challenge" },
  },

  "server-error": {
    description: "Returns 500 to the very first request, before any challenge is issued.",
    covers: ["T-017"],
    next: () => ({ type: "status", status: 500 }),
  },
};

/** @param {string} name */
export function requireScenario(name) {
  const scenario = SCENARIOS[name];
  if (!scenario) {
    throw new Error(
      `Unknown scenario ${JSON.stringify(name)}. Known: ${Object.keys(SCENARIOS).join(", ")}`,
    );
  }
  return scenario;
}
