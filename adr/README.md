# Architecture Decision Records

Per `SPEC.md` §0, changing any **MUST** or **MUST NOT** in the specification requires an ADR,
review by both Product and Engineering owners, and a specification version increment.

ADR-001 through ADR-007 are transcriptions of the decisions already recorded in `SPEC.md` §2.
They are reproduced here so that every architectural decision has a single, stable, citable home.
ADR-008 onward are new decisions taken during implementation.

**Every accepted ADR is listed below.** The S15 audit found ADR-015 missing from this table
(O50), which is the failure mode an index has: it is only useful if adding a row is part of
adding an ADR. ADR-016 through ADR-018 close the S15 audit's money-safety findings and were
added together with this line.

| ADR                                                                                  | Title                                                                  | Status                 | Source                             |
| :----------------------------------------------------------------------------------- | :--------------------------------------------------------------------- | :--------------------- | :--------------------------------- |
| [001](001-same-chain-only-synchronous-payment.md)                                    | Same-chain-only synchronous payment                                    | Accepted               | SPEC §2                            |
| [002](002-facilitator-model.md)                                                      | Facilitator model                                                      | Accepted               | SPEC §2                            |
| [003](003-failover-semantics.md)                                                     | Failover semantics                                                     | Accepted               | SPEC §2                            |
| [004](004-protocol-version-boundary.md)                                              | Protocol version boundary                                              | Accepted               | SPEC §2                            |
| [005](005-shared-behavioral-specification.md)                                        | Shared behavioral specification                                        | Accepted               | SPEC §2                            |
| [006](006-money-representation.md)                                                   | Money representation                                                   | Accepted               | SPEC §2                            |
| [007](007-local-state.md)                                                            | Local state                                                            | Accepted               | SPEC §2                            |
| [008](008-bundle-size-gate-rebaseline.md)                                            | Bundle size gate re-baseline                                           | Accepted, amended S29  | Amends SPEC §12.3                  |
| [009](009-unscoped-package-and-bundled-cli.md)                                       | Unscoped `tx402` package with bundled CLI                              | Accepted               | Amends SPEC §3.1, §4.1, §13, §16   |
| [010](010-upstream-envelope-reconciliation.md)                                       | Upstream envelope reconciliation                                       | Accepted               | Clarifies SPEC §5.1, §7.1, §7.2    |
| [011](011-error-taxonomy-concretization.md)                                          | Error taxonomy concretization                                          | Accepted               | Concretizes SPEC §8, §4.2          |
| [012](012-manifest-signing-envelope.md)                                              | Release manifest signing envelope                                      | Accepted               | Concretizes SPEC §5.4              |
| [013](013-python-svm-transaction-construction.md)                                    | Python SVM transaction construction                                    | Accepted               | Narrows SPEC §7.2 (Python only)    |
| [014](014-paid-retry-redirects-are-not-followed.md)                                  | Paid-retry redirects are not followed                                  | Accepted, amended S15b | Narrows SPEC §6.1 (v0.1)           |
| [015](015-caller-supplied-rpc-endpoints.md)                                          | Caller-supplied RPC endpoints                                          | Accepted               | Extends SPEC §6.4, §4.3            |
| [016](016-settlement-evidence-outranks-the-status-line.md)                           | Settlement evidence outranks the status line                           | Accepted               | Implements SPEC §5.3; narrows §6.7 |
| [017](017-spend-store-failure-semantics.md)                                          | Spend-store failure semantics                                          | Accepted               | Fills a gap in SPEC §5.3, §8       |
| [018](018-policy-scope-is-the-normalized-merchant-host.md)                           | Policy scope is the normalized merchant host                           | Accepted, amended S15d | Fixes SPEC §5.3 conformance        |
| [019](019-settlement-metadata-in-the-cli-json-document.md)                           | Settlement metadata in the CLI `--json` document                       | Accepted               | Concretizes SPEC §11               |
| [020](020-inspect-is-the-keyless-question-plan-is-not.md)                            | `inspect()` is keyless; `plan()` is not                                | Accepted               | Clarifies SPEC §11                 |
| [021](021-configuration-parity-is-a-spec-obligation-api-shape-is-not.md)             | Configuration parity is a SPEC obligation; API shape is not            | Accepted, amended S25  | Implements SPEC §4.3 in Python     |
| [022](022-a-post-transmission-failure-is-never-classified-as-a-pre-signature-one.md) | A post-transmission failure is never classified as a pre-signature one | Accepted               | Changes one exit-code mapping      |
| [023](023-behavioural-prose-is-written-from-execution-not-from-reading.md)           | Behavioural prose is written from execution                            | Accepted               | Process rule; changes no MUST      |
| [024](024-the-two-clis-emit-one-json-document-python-resolves-to-typescript.md)      | The two CLIs emit one `--json` document; Python resolves to TypeScript | Accepted               | Changes Python CLI `error.context` |

## Format

Each ADR carries: Status, Context, Decision, Consequences. ADRs are append-only — a decision that
is later reversed gets a new ADR that supersedes the old one, and the old one is marked
`Superseded by ADR-NNN` rather than edited away.
