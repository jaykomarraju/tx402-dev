/**
 * Optional private-key convenience signer adapters.
 *
 * Deliberately isolated behind the `tx402/signers` subpath export. Per SEC-001, the
 * primary client configuration accepts **signer abstractions only** and never a raw
 * private key string. Anything in this module is an explicit opt-in by the caller.
 *
 * Lands alongside the chain adapters in M3/M4 (PLAN.md §6, sessions S5-S6).
 */

export {};
