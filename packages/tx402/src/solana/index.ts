/**
 * SVM chain adapter — Solana.
 *
 * Optional subpath export (`tx402/solana`). Kept out of the core import path so that
 * `@solana/kit` and `@x402/svm` are only paid for by callers who import them.
 *
 * Lands in M4 (PLAN.md §6, session S6). Will expose the `SolanaSigner` interface from
 * SPEC §7.2, adapt it to `@solana/kit`'s `TransactionSigner`, and resolve the
 * `solana:mainnet` alias to its canonical genesis-hash CAIP-2 identifier
 * (ADR-010 decisions 4 and 5).
 */

export {};
