/**
 * Regression for the eleventh fresh-eyes UX pass (§11.3), open item O109 (finding F1).
 *
 * F1: a stranger who follows a getting-started surface runs `npm install tx402` /
 * `pip install tx402` / `npx tx402`, lands on the inert `0.0.0` name placeholder that is the only
 * thing published to npm and PyPI, and is silently dead-ended — the scaffold exits 0 with nothing
 * useful and the page they followed never says why. Both shipped package READMEs and the
 * repository README already disclose the placeholder; the docs-site surfaces did not.
 *
 * The guard is written to the CLASS, not the two pages the cold pass named. The class is
 * "reader-facing surfaces that hand a fresh user a registry install/run command for tx402": each
 * such surface must disclose, on itself, that `0.0.0` is a placeholder. Scoping a guard to the
 * single instance a finding pointed at — and leaving its siblings one directory over — is this
 * project's single most repeated mistake (O72→O77, O79→O82, O81→O85, O85's guard→O95, ADR-023's
 * principle→O104). Applying the class here surfaced three entry points the cold pass did not name:
 * the CLI guide's `npx tx402`, the examples README's Python `pip install "tx402[evm]"`, and the
 * API reference's `pip install tx402`.
 *
 * An earlier draft classified an install-entry only by whether the directive sat inside a fenced
 * code block, reasoning that fenced = copy-paste and inline = descriptive. An adversarial review
 * (S38 scope-audit workflow, three cold readers + one refuter) showed that heuristic is a blind
 * spot: `examples/README.md` dead-ends a stranger with an *inline* imperative
 * `pip install "tx402[evm]"`, which the fenced-only sweep could not see. So the class is drawn on
 * the directive itself, fenced or inline. The registry-install pattern is kept to literal
 * adjacency (`npx tx402`, not `npx …tx402`) precisely so the maintainer runbooks' `uvx --from
 * tx402==0.0.0 tx402` and `pnpm --filter tx402 …` are never mistaken for a consumer install — a
 * negative control below pins that, because the no-overreach property rides on that phrasing.
 *
 * Disclosure is checked co-located, not file-global: `0.0.0` must sit within a small window of the
 * word inert/placeholder/pre-release, so a stray `0.0.0` in one section plus "placeholder" in an
 * unrelated one cannot satisfy the check while the install block stays unwarned.
 *
 * TEMPORARY. The whole guard is a pre-publication artifact. When the functional `0.1.0` ships and
 * the `0.0.0` placeholder is gone, the disclosures and this file are both removed. Until then,
 * adding a new install-command surface without a disclosure fails here.
 *
 * Every assertion below was run against `d781fca` first and observed to fail there, except the
 * package-README control, the negative control, and the sweep-sanity superset, which hold there.
 */

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { read, readerSurfaces, relative, REPO } from "./reader-surfaces.js";

/**
 * A registry install or zero-install run of the published `tx402` — the directive that lands a
 * stranger on the placeholder. Literal adjacency on purpose: `npx tx402`, never `npx …tx402`, so a
 * maintainer runbook's `uvx --from tx402==0.0.0 tx402` or `pnpm --filter tx402 exec` is not a
 * consumer install. The negative control below fails if this is ever loosened.
 */
const REGISTRY_INSTALL =
  /(?:npm install|pnpm add|yarn add)\s+tx402\b|pip install\s+["']?tx402|(?:npx|uvx)\s+tx402\b/u;

/**
 * A co-located placeholder disclosure: `0.0.0` within a small window of the word that names it a
 * placeholder, in either order. Windowed rather than file-global so the disclosure cannot be
 * satisfied by unrelated text elsewhere on the page.
 */
const DISCLOSURE =
  /0\.0\.0[\s\S]{0,220}(?:inert|placeholder|pre-release)|(?:inert|placeholder|pre-release)[\s\S]{0,220}0\.0\.0/iu;

/** True iff a surface hands the reader a registry install/run of tx402, fenced or inline. */
function isInstallEntry(text: string): boolean {
  return REGISTRY_INSTALL.test(text);
}

/** True iff a surface discloses, on itself and co-located, that the published `0.0.0` is inert. */
function disclosesPlaceholder(text: string): boolean {
  return DISCLOSURE.test(text);
}

/**
 * Every reader surface that carried a registry install/run command at the time this guard was
 * written. The three READMEs already disclosed; the five docs/examples surfaces are what F1 and
 * the S38 scope audit added. Kept explicit so the sweep must still find each — a surface silently
 * dropping out (its install command edited away, or the extractor regressing) fails the sanity
 * check rather than quietly shrinking the set the disclosure check ranges over.
 */
const KNOWN_INSTALL_ENTRIES = [
  "README.md",
  "packages/tx402/README.md",
  "packages/tx402-python/README.md",
  "docs/src/content/docs/index.mdx",
  "docs/src/content/docs/start/quickstart.mdx",
  "docs/src/content/docs/guides/cli.mdx",
  "docs/src/content/docs/reference/api-typescript.mdx",
  "examples/README.md",
];

describe("O109 (F1) — every install-entry reader surface discloses the 0.0.0 placeholder", () => {
  const entries = readerSurfaces().filter((file) => isInstallEntry(read(file)));
  const entryPaths = new Set(entries.map(relative));

  it("finds every known install-entry surface, so the sweep is not vacuous or shrinking", () => {
    // A superset assertion, not a bare count: if the fenced/inline extractor regressed or a page's
    // install command was edited away, the missing surface names itself here instead of silently
    // dropping out of the set the disclosure check below ranges over.
    const missing = KNOWN_INSTALL_ENTRIES.filter((path) => !entryPaths.has(path));
    expect(
      missing,
      `known install-entry surfaces no longer detected: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("names no install-entry surface that omits the disclosure", () => {
    const undisclosed = entries
      .filter((file) => !disclosesPlaceholder(read(file)))
      .map(relative);
    expect(
      undisclosed,
      `install-entry surfaces missing the co-located 0.0.0 placeholder disclosure: ${undisclosed.join(", ")}`,
    ).toEqual([]);
  });

  it("does not classify the maintainer runbooks' non-consumer commands as installs (no overreach)", () => {
    // The no-overreach property rides on literal adjacency. These pages carry `uvx --from
    // tx402==0.0.0 tx402` and `pnpm --filter tx402 …`, which are not consumer installs; if the
    // pattern were loosened to `uvx …tx402`, they would be wrongly forced to carry a banner.
    for (const rel of [
      "docs/src/content/docs/operations/publishing.mdx",
      "docs/src/content/docs/operations/base-testnet.mdx",
      "docs/src/content/docs/operations/releasing.mdx",
    ]) {
      expect(
        isInstallEntry(read(join(REPO, rel))),
        `${rel} was classified as a consumer install-entry — REGISTRY_INSTALL is too loose`,
      ).toBe(false);
    }
  });

  it("includes the two package READMEs, which already disclose (positive control)", () => {
    // Proves the sweep is finding real entries, and that the two surfaces npm and PyPI render both
    // carry the install command and the disclosure. This assertion held at `d781fca` too.
    for (const rel of ["packages/tx402/README.md", "packages/tx402-python/README.md"]) {
      const text = read(join(REPO, rel));
      expect(isInstallEntry(text), `${rel} no longer detected as an install entry`).toBe(
        true,
      );
      expect(disclosesPlaceholder(text), `${rel} no longer discloses the placeholder`).toBe(
        true,
      );
    }
  });

  it("covers the five docs/examples entry points, the two F1 named and the three siblings", () => {
    // The regression proper: these five omitted the disclosure at `d781fca`. The quickstart and
    // landing page are what the cold pass named; the CLI guide, examples README, and API reference
    // are the siblings the class caught.
    for (const rel of [
      "docs/src/content/docs/index.mdx",
      "docs/src/content/docs/start/quickstart.mdx",
      "docs/src/content/docs/guides/cli.mdx",
      "docs/src/content/docs/reference/api-typescript.mdx",
      "examples/README.md",
    ]) {
      const text = read(join(REPO, rel));
      expect(isInstallEntry(text), `${rel} unexpectedly not an install entry`).toBe(true);
      expect(
        disclosesPlaceholder(text),
        `${rel} does not disclose the 0.0.0 placeholder`,
      ).toBe(true);
    }
  });
});
