# Publishing & Name Reservation Runbook

Covers reserving the `tx402` name on both registries and, later, cutting real releases.

## Current reservation status

| Registry | Name    | Status                                       | Version |
| :------- | :------ | :------------------------------------------- | :------ |
| npm      | `tx402` | ✅ **Reserved** (maintainer `jay.komarraju`) | `0.0.0` |
| PyPI     | `tx402` | ✅ **Reserved**                              | `0.0.0` |

Neither registry offers a true "reserve" operation. A name is held only by publishing to it,
which is why a deliberately inert `0.0.0` placeholder was published. Both placeholder READMEs
state plainly that nothing is implemented and that the first functional release is `0.1.0`.

> **npm unpublish window.** npm permits unpublishing a version only within **72 hours** of
> publication, and only when nothing depends on it. After that the version is permanent — a
> republish of `0.0.0` is impossible and the version number is burned.

---

## Reserving `tx402` on PyPI

Completed 2026-08-03 (PLAN.md open item **O1**). The prebuilt placeholder wheel and source
distribution were published without rebuilding later development code into version `0.0.0`.

### 1. Create the account and token — _you_

1. Register at <https://pypi.org/account/register/> if you do not already have an account.
2. Enable 2FA (PyPI requires it for publishing).
3. Create an API token at <https://pypi.org/manage/account/token/>.
   - Scope: **"Entire account"**. A project-scoped token cannot be created before the project
     exists, and this publish is what creates it.
   - Immediately after the first publish, replace it with a project-scoped token for `tx402`.

### 2. Publish the placeholder

The distributions are already built and verified:

```
packages/tx402-python/dist/tx402-0.0.0.tar.gz
packages/tx402-python/dist/tx402-0.0.0-py3-none-any.whl
```

Rebuild and publish:

```bash
cd packages/tx402-python
uv build                       # regenerates dist/
uv publish --token pypi-AgEI...   # paste the token; do NOT commit it
```

Do not put the token in `.pypirc`, a shell profile, or any tracked file. `.pypirc` and `.env*`
are already gitignored, but the safe path is passing it once on the command line in an
interactive shell.

### 3. Verify

```bash
curl -s https://pypi.org/pypi/tx402/json | python3 -c \
  "import sys,json; d=json.load(sys.stdin)['info']; print(d['name'], d['version'], d['license'])"
```

Then update the table at the top of this file and the reservation line in `PLAN.md` §7.

Publication verification on 2026-08-03:

- PyPI reported `tx402` version `0.0.0`, Apache-2.0, Python `>=3.10`.
- Wheel SHA-256: `d2e81d16f19a1cae92f049d5298bd8ff85293a491c1b862c4f36f02a2aee036b`.
- Source SHA-256: `01d32fbdba6c816215a585c3575684a24aa72c35e2c2c0373b83724b9f0f49e8`.
- A clean `uvx --from tx402==0.0.0 tx402 --version` returned `tx402 0.0.0`.

---

## Real releases (`0.1.0` onward)

Placeholder publishing is a one-off. Every subsequent release goes through CI, never a laptop.

### Preconditions — all of SPEC §12.4 must hold

- [ ] All P0/P1 tests green on protected `main`
- [ ] No unresolved critical/high severity finding in reachable production code
- [ ] TypeScript ↔ Python conformance parity at 100 % (T-016)
- [ ] SBOM, license report, and vulnerability scan clean
- [ ] Reproducible build verified
- [ ] Public testnet smoke suite passed **twice from clean environments** (T-019)
- [ ] API docs, migration notes, examples, and the error reference published
- [ ] Independent security review closed with no release-blocking finding

### Trusted publishing

Both registries must be configured for OIDC trusted publishing before `0.1.0`, so that no
long-lived token exists anywhere:

- **npm** — provenance is already declared in `packages/tx402/package.json`
  (`publishConfig.provenance: true`). It requires a supported CI with an OIDC identity, which is
  why the local placeholder publish used `--no-provenance`. The release workflow must **not**
  pass that flag.
- **PyPI** — configure a trusted publisher at
  <https://pypi.org/manage/project/tx402/settings/publishing/> pointing at this repository and the
  release workflow. Then `uv publish` needs no token at all.

### Version and compatibility rules (SPEC §15)

- Semantic versioning applies. During `0.x`, release notes **must** explicitly call out breaks.
- After `1.0`, any exported type removal, error code change, default policy relaxation, or wire
  behavior change requires a major version.
- Network/token manifest updates that do not change API behavior are **patch** releases.
- Adding a production network is a **minor** release and requires a chain adapter security review.
- Upgrading the pinned `@x402/*` or `x402` dependency requires replaying every conformance fixture
  and adding fixtures for each newly accepted envelope or scheme.

---

## Repository migration

Development happens in the private `tx402-dev` repository; the public open-source repository is a
later migration (open item **O3**). Every outward-facing URL is centralized so the move is a
single-file change per language:

- `packages/tx402/src/meta.ts` → `PROJECT_URLS`
- `packages/tx402-python/src/tx402/meta.py` → `PROJECT_URLS`
- `packages/tx402/package.json` and `packages/tx402-python/pyproject.toml` → the URL blocks

Nothing else should ever hardcode a repository URL.
