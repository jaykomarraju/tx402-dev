/**
 * EVM chain adapter — Base.
 *
 * Optional subpath export (`tx402/evm`). Kept out of the core import path so that `viem`
 * and `@x402/evm` are only paid for by callers who import them (ADR-008, ADR-009).
 *
 * Lands in M3 (PLAN.md §6, session S5). Will expose the `EvmSigner` interface from
 * SPEC §7.1 and adapt it to upstream's `ClientEvmSigner` per ADR-010 decision 5.
 */

export {};
