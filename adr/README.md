# Architecture Decision Records

Per `SPEC.md` §0, changing any **MUST** or **MUST NOT** in the specification requires an ADR,
review by both Product and Engineering owners, and a specification version increment.

ADR-001 through ADR-007 are transcriptions of the decisions already recorded in `SPEC.md` §2.
They are reproduced here so that every architectural decision has a single, stable, citable home.
ADR-008 onward are new decisions taken during implementation.

| ADR                                                 | Title                                     | Status   | Source                           |
| :-------------------------------------------------- | :---------------------------------------- | :------- | :------------------------------- |
| [001](001-same-chain-only-synchronous-payment.md)   | Same-chain-only synchronous payment       | Accepted | SPEC §2                          |
| [002](002-facilitator-model.md)                     | Facilitator model                         | Accepted | SPEC §2                          |
| [003](003-failover-semantics.md)                    | Failover semantics                        | Accepted | SPEC §2                          |
| [004](004-protocol-version-boundary.md)             | Protocol version boundary                 | Accepted | SPEC §2                          |
| [005](005-shared-behavioral-specification.md)       | Shared behavioral specification           | Accepted | SPEC §2                          |
| [006](006-money-representation.md)                  | Money representation                      | Accepted | SPEC §2                          |
| [007](007-local-state.md)                           | Local state                               | Accepted | SPEC §2                          |
| [008](008-bundle-size-gate-rebaseline.md)           | Bundle size gate re-baseline              | Accepted | Amends SPEC §12.3                |
| [009](009-unscoped-package-and-bundled-cli.md)      | Unscoped `tx402` package with bundled CLI | Accepted | Amends SPEC §3.1, §4.1, §13, §16 |
| [010](010-upstream-envelope-reconciliation.md)      | Upstream envelope reconciliation          | Accepted | Clarifies SPEC §5.1, §7.1, §7.2  |
| [011](011-error-taxonomy-concretization.md)         | Error taxonomy concretization             | Accepted | Concretizes SPEC §8, §4.2        |
| [012](012-manifest-signing-envelope.md)             | Release manifest signing envelope         | Accepted | Concretizes SPEC §5.4            |
| [013](013-python-svm-transaction-construction.md)   | Python SVM transaction construction       | Accepted | Narrows SPEC §7.2 (Python only)  |
| [014](014-paid-retry-redirects-are-not-followed.md) | Paid-retry redirects are not followed     | Accepted | Narrows SPEC §6.1 (v0.1)         |

## Format

Each ADR carries: Status, Context, Decision, Consequences. ADRs are append-only — a decision that
is later reversed gets a new ADR that supersedes the old one, and the old one is marked
`Superseded by ADR-NNN` rather than edited away.
