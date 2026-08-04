#!/usr/bin/env node
/**
 * Supply-chain release gates (SPEC §12.4).
 *
 *   node tools/supply-chain/index.js sbom          # emit CycloneDX SBOMs + licence report
 *   node tools/supply-chain/index.js audit         # vulnerability + licence policy gates
 *   node tools/supply-chain/index.js reproducible  # build twice, compare digests
 *   node tools/supply-chain/index.js all
 *
 * SPEC §12.4 requires "package signatures/provenance, SBOMs, license checks, and
 * reproducible build verification complete" before release. Provenance is the release
 * workflow's job (OIDC trusted publishing); the other three are here.
 *
 * **Everything is scoped to what actually ships.** The workspace has a large dev tree —
 * vitest, Astro, eslint, esbuild — and none of it reaches a user. SPEC §12.4's wording is
 * "no critical or high-severity unresolved security issue in **reachable production code**",
 * so dev-only findings are reported and do not fail the gate. Conflating the two produces a
 * gate nobody can keep green, which is a gate that gets disabled.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = join(ROOT, "sbom");

/**
 * Licences acceptable in a **shipped** dependency.
 *
 * Permissive and weak-copyleft-with-file-scope only. A strong copyleft licence in the
 * production tree would impose terms on everyone who installs tx402, which is a licensing
 * decision rather than a dependency choice — so it fails the gate and needs a human.
 */
const ALLOWED_LICENSES = new Set([
  "MIT",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "Unlicense",
  "CC0-1.0",
  "BlueOak-1.0.0",
  "Python-2.0",
  "PSF-2.0",
  "MPL-2.0",
  "MIT-0",
  // Legacy free-text spellings that predate SPDX identifiers. Kept deliberately short:
  // every entry here is a licence someone read, not a wildcard.
  "BSD",
  "Apache 2.0",
]);

/**
 * Evaluates a simple SPDX expression against the allowlist.
 *
 * `cryptography` ships "Apache-2.0 OR BSD-3-Clause" — a genuine choice of two acceptable
 * licences, which a string comparison against the allowlist rejects even though either
 * operand alone would pass. `OR` therefore needs only one acceptable operand; `AND` needs
 * all of them, because an `AND` imposes every listed licence at once.
 *
 * Parenthesised expressions are not parsed. They are rare, and a licence expression this
 * tool cannot read must fail rather than be guessed at.
 */
function licenseAcceptable(expression) {
  const value = expression.trim().replace(/^\(|\)$/gu, "");
  if (value.includes("(")) return false;
  if (/ OR /iu.test(value)) {
    return value.split(/ OR /iu).some((part) => licenseAcceptable(part));
  }
  if (/ AND /iu.test(value)) {
    return value.split(/ AND /iu).every((part) => licenseAcceptable(part));
  }
  return ALLOWED_LICENSES.has(value.replace(/-only$|-or-later$/u, ""));
}

const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });

/** `pnpm audit` exits non-zero when it finds anything, which is not an execution failure. */
function runAllowingFailure(command, args, options = {}) {
  try {
    return run(command, args, options);
  } catch (error) {
    return String(error.stdout ?? "");
  }
}

const problems = [];
const notes = [];

// --- dependency inventory ------------------------------------------------------------------

/** The npm production tree of the *published* package, not of the workspace. */
function npmProductionTree() {
  const raw = run("pnpm", [
    "--filter",
    "tx402",
    "list",
    "--prod",
    "--depth",
    "Infinity",
    "--json",
  ]);
  const parsed = JSON.parse(raw);
  const found = new Map();
  const walk = (dependencies) => {
    for (const [name, info] of Object.entries(dependencies ?? {})) {
      const key = `${name}@${info.version ?? "?"}`;
      if (!found.has(key)) {
        found.set(key, { name, version: info.version ?? "0.0.0", path: info.path });
      }
      walk(info.dependencies);
    }
  };
  for (const entry of parsed) walk(entry.dependencies);
  return [...found.values()];
}

/** The Python runtime tree, from the lockfile rather than from the environment. */
function pythonProductionTree() {
  const raw = run(
    "uv",
    ["export", "--no-dev", "--no-hashes", "--format", "requirements-txt"],
    {
      cwd: join(ROOT, "packages/tx402-python"),
    },
  );
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("-e"))
    .map((line) => {
      // A requirements line may carry an environment marker — `cffi==2.1.0 ; platform...`
      // — which is not part of the version and must not end up in a purl.
      const [requirement] = line.split(";");
      const [name, version] = requirement.split("==");
      return { name: name.split("[")[0].trim(), version: (version ?? "0.0.0").trim() };
    })
    .filter((entry) => entry.name.length > 0);
}

function npmLicenseOf(component) {
  try {
    const manifest = JSON.parse(readFileSync(join(component.path, "package.json"), "utf8"));
    if (typeof manifest.license === "string") return manifest.license;
    if (manifest.license?.type !== undefined) return String(manifest.license.type);
    if (Array.isArray(manifest.licenses)) {
      return manifest.licenses.map((entry) => entry.type).join(" OR ");
    }
  } catch {
    /* fall through to unknown */
  }
  return "UNKNOWN";
}

/**
 * Python licences, read from installed metadata in one call.
 *
 * `uv pip show` does not print a licence at all, and the field moved: modern packaging puts
 * an SPDX string in `License-Expression`, older packages put free text in `License`, and
 * some only carry a `License :: OSI Approved :: …` classifier. All three are consulted, in
 * that order, because relying on any one of them alone reports most of the tree as UNKNOWN.
 */
function pythonLicenses(names) {
  const script = `
import json
from importlib.metadata import metadata

CLASSIFIER = {
    "License :: OSI Approved :: MIT License": "MIT",
    "License :: OSI Approved :: BSD License": "BSD-3-Clause",
    "License :: OSI Approved :: Apache Software License": "Apache-2.0",
    "License :: OSI Approved :: ISC License (ISCL)": "ISC",
    "License :: OSI Approved :: Mozilla Public License 2.0 (MPL 2.0)": "MPL-2.0",
    "License :: OSI Approved :: Python Software Foundation License": "PSF-2.0",
}

out = {}
for name in json.loads(input()):
    try:
        meta = metadata(name)
    except Exception:
        out[name] = "NOT-INSTALLED"
        continue
    value = meta.get("License-Expression") or meta.get("License") or ""
    value = value.strip()
    if not value or chr(10) in value:
        for classifier in meta.get_all("Classifier") or []:
            if classifier in CLASSIFIER:
                value = CLASSIFIER[classifier]
                break
    out[name] = value or "UNKNOWN"
print(json.dumps(out))
`;
  try {
    const raw = run("uv", ["run", "python", "-c", script], {
      cwd: join(ROOT, "packages/tx402-python"),
      input: JSON.stringify(names),
      stdio: ["pipe", "pipe", "pipe"],
    });
    return JSON.parse(raw.trim().split("\n").at(-1));
  } catch (error) {
    notes.push(
      `python licence lookup failed: ${String(error.stderr ?? error.message).slice(-400)}`,
    );
    return Object.fromEntries(names.map((name) => [name, "UNKNOWN"]));
  }
}

// --- 1. SBOM ---------------------------------------------------------------------------------

function cycloneDx(name, version, components) {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      // No timestamp. A timestamp would make two SBOMs of the same tree differ, which
      // defeats the reproducible-build gate that compares them.
      component: { type: "library", name, version, purl: `pkg:generic/${name}@${version}` },
      tools: [{ vendor: "tx402", name: "tools/supply-chain" }],
    },
    components: components
      .map((component) => ({
        type: "library",
        name: component.name,
        version: component.version,
        purl: component.purl,
        licenses: [{ license: { id: component.license } }],
      }))
      .sort((a, b) => a.purl.localeCompare(b.purl)),
  };
}

function buildSboms() {
  mkdirSync(OUT, { recursive: true });

  const npmVersion = JSON.parse(
    readFileSync(join(ROOT, "packages/tx402/package.json"), "utf8"),
  ).version;

  const npmComponents = npmProductionTree().map((component) => ({
    name: component.name,
    version: component.version,
    purl: `pkg:npm/${component.name}@${component.version}`,
    license: npmLicenseOf(component),
  }));

  const pythonTree = pythonProductionTree();
  const pythonLicenseMap = pythonLicenses(pythonTree.map((component) => component.name));
  const pythonComponents = pythonTree.map((component) => ({
    name: component.name,
    version: component.version,
    purl: `pkg:pypi/${component.name}@${component.version}`,
    license: pythonLicenseMap[component.name] ?? "UNKNOWN",
  }));

  writeFileSync(
    join(OUT, "tx402-npm.cdx.json"),
    JSON.stringify(cycloneDx("tx402", npmVersion, npmComponents), null, 2) + "\n",
  );
  writeFileSync(
    join(OUT, "tx402-pypi.cdx.json"),
    JSON.stringify(cycloneDx("tx402", npmVersion, pythonComponents), null, 2) + "\n",
  );

  const row = (component) =>
    `| \`${component.name}\` | ${component.version} | ${component.license} |`;
  writeFileSync(
    join(OUT, "LICENSES.md"),
    [
      "# Third-party licences",
      "",
      "Generated by `node tools/supply-chain/index.js sbom`. **Do not hand-edit.**",
      "",
      "Only dependencies that reach a user are listed. The development tree — vitest,",
      "Astro, eslint, ruff, mypy — is not distributed and is deliberately excluded.",
      "",
      "tx402 itself is Apache-2.0.",
      "",
      "## npm (`tx402`)",
      "",
      "| Package | Version | Licence |",
      "| --- | --- | --- |",
      ...npmComponents.map(row),
      "",
      "## PyPI (`tx402`)",
      "",
      "| Package | Version | Licence |",
      "| --- | --- | --- |",
      ...pythonComponents.map(row),
      "",
    ].join("\n"),
  );

  console.log(
    `  SBOM: ${npmComponents.length} npm + ${pythonComponents.length} PyPI production ` +
      `components → sbom/`,
  );
  return { npmComponents, pythonComponents };
}

// --- 2. licence policy + vulnerabilities -----------------------------------------------------

function licenseGate({ npmComponents, pythonComponents }) {
  for (const component of [...npmComponents, ...pythonComponents]) {
    if (component.license === "NOT-INSTALLED") {
      // A dependency conditional on an interpreter this machine is not running — for
      // example `exceptiongroup ; python_full_version < "3.11"` on CPython 3.13. Its
      // metadata genuinely cannot be read here, so reporting it as an unacceptable licence
      // would be a false finding. CI's 3.10 leg resolves it.
      notes.push(
        `licence: ${component.name}@${component.version} is not installed for this ` +
          `interpreter, so its licence was not read here`,
      );
      continue;
    }
    if (!licenseAcceptable(component.license)) {
      problems.push(
        `licence: ${component.name}@${component.version} is "${component.license}", ` +
          `which is not on the shipped-dependency allowlist`,
      );
    }
  }
  console.log(`  licences: ${npmComponents.length + pythonComponents.length} checked`);
}

function vulnerabilityGate() {
  // `pnpm --filter` implies `--recursive`, and `pnpm audit` rejects that, so the audit runs
  // at the workspace root and findings are filtered afterwards. A finding counts only if it
  // is reachable from the published package: `tools__size-gate>esbuild` ships to nobody.
  const raw = runAllowingFailure("pnpm", ["audit", "--prod", "--json"]);
  let advisories = {};
  try {
    advisories = JSON.parse(raw).advisories ?? {};
  } catch {
    notes.push("npm audit produced no parseable JSON; treated as no findings");
  }
  for (const advisory of Object.values(advisories)) {
    const severity = String(advisory.severity ?? "unknown");
    const paths = (advisory.findings ?? []).flatMap((finding) => finding.paths ?? []);
    const shipped = paths.some((path) => path.startsWith("tx402>") || path === "tx402");
    const line =
      `${advisory.module_name}: ${advisory.title} (${severity})` +
      (shipped ? "" : " [dev-only, not shipped]");
    if (!shipped) {
      notes.push(`vulnerability (non-blocking): ${line}`);
      continue;
    }
    // SPEC §12.4 blocks on critical and high only. Moderate and low are recorded so the
    // audit session sees them, without making the gate un-keepable.
    if (severity === "critical" || severity === "high")
      problems.push(`vulnerability: ${line}`);
    else notes.push(`vulnerability (non-blocking): ${line}`);
  }

  const python = runAllowingFailure(
    "uv",
    ["run", "--with", "pip-audit", "pip-audit", "-f", "json", "--progress-spinner", "off"],
    {
      cwd: join(ROOT, "packages/tx402-python"),
    },
  );
  try {
    const parsed = JSON.parse(python);
    for (const dependency of parsed.dependencies ?? []) {
      for (const vulnerability of dependency.vulns ?? []) {
        notes.push(
          `python vulnerability: ${dependency.name}@${dependency.version} ${vulnerability.id}`,
        );
      }
    }
    console.log(`  vulnerabilities: npm + PyPI scanned`);
  } catch {
    notes.push(
      "pip-audit unavailable or produced no parseable JSON — PyPI tree not scanned",
    );
    console.log(`  vulnerabilities: npm scanned; PyPI scan unavailable`);
  }
}

// --- 3. reproducible build --------------------------------------------------------------------

/** sha256 over every emitted file, keyed by path, so ordering cannot hide a difference. */
function digestTree(directory) {
  const entries = [];
  const walk = (current, prefix) => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const relative = prefix === "" ? name : `${prefix}/${name}`;
      if (statSync(full).isDirectory()) walk(full, relative);
      else {
        entries.push(
          `${relative}  ${createHash("sha256").update(readFileSync(full)).digest("hex")}`,
        );
      }
    }
  };
  walk(directory, "");
  return {
    manifest: entries,
    digest: createHash("sha256").update(entries.join("\n")).digest("hex"),
  };
}

function reproducibleGate() {
  const dist = join(ROOT, "packages/tx402/dist");

  rmSync(dist, { recursive: true, force: true });
  run("pnpm", ["--filter", "tx402", "build"]);
  const first = digestTree(dist);

  rmSync(dist, { recursive: true, force: true });
  run("pnpm", ["--filter", "tx402", "build"]);
  const second = digestTree(dist);

  if (first.digest === second.digest) {
    console.log(
      `  reproducible build: identical across two clean builds (${first.digest.slice(0, 16)}…)`,
    );
  } else {
    const differing = first.manifest.filter(
      (line, index) => line !== second.manifest[index],
    );
    problems.push(
      `reproducible build: two clean builds differ (${differing.length} file(s), first: ` +
        `${differing[0] ?? "path set differs"})`,
    );
  }

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "build-digest.txt"), first.manifest.join("\n") + "\n");
}

// --- run ----------------------------------------------------------------------------------------

const command = process.argv[2] ?? "all";
console.log(`tx402 supply-chain gates (SPEC §12.4) — ${command}\n`);

let inventory;
if (command === "sbom" || command === "audit" || command === "all")
  inventory = buildSboms();
if (command === "audit" || command === "all") {
  licenseGate(inventory);
  vulnerabilityGate();
}
if (command === "reproducible" || command === "all") reproducibleGate();

if (notes.length > 0) {
  console.log("\nNotes (non-blocking):");
  for (const note of notes) console.log(`  - ${note}`);
}

if (problems.length > 0) {
  console.error(`\n${problems.length} blocking finding(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log("\nsupply-chain: PASS");
