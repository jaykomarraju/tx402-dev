#!/usr/bin/env node
/**
 * Conformance fixture index builder and integrity checker (ADR-005, SEC-007).
 *
 *   tx402-conformance build   rewrite core-spec/conformance/index.json from the vectors
 *   tx402-conformance check   verify the index matches what is on disk (CI, exit 1 on drift)
 *
 * The index exists so that the runners have something to trust. A runner that merely
 * globbed the vectors directory would silently pass if a vector were deleted, and would
 * silently execute one that had been edited — neither is acceptable for artifacts SEC-007
 * requires to be integrity-checked before release.
 *
 * `build` also validates every vector against `conformance-vector.schema.json`, so a
 * malformed fixture is caught here rather than as a confusing failure inside two different
 * language runners.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const schemasDir = path.join(repoRoot, "core-spec/schemas");
const conformanceDir = path.join(repoRoot, "core-spec/conformance");
const vectorsDir = path.join(conformanceDir, "vectors");
const indexPath = path.join(conformanceDir, "index.json");

/** The format generation of index.json itself. Bumped only if its shape changes. */
const FORMAT_VERSION = 1;

/** @param {string} file */
function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * Hashes the file's exact bytes, not a re-serialization of its contents. Reformatting a
 * vector is a change to the fixture set and should be visible as one.
 *
 * @param {string} file
 */
function hashFile(file) {
  return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
}

/** @param {string} dir @returns {string[]} repo-relative paths, sorted */
function findVectors(dir) {
  /** @type {string[]} */
  const found = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...findVectors(full));
    } else if (entry.endsWith(".json")) {
      found.push(full);
    }
  }
  return found;
}

function buildValidator() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const entry of readdirSync(schemasDir)) {
    if (entry.endsWith(".schema.json")) {
      ajv.addSchema(readJson(path.join(schemasDir, entry)));
    }
  }
  return ajv.getSchema("https://tx402.dev/schemas/v1/conformance-vector.schema.json");
}

function collect() {
  const validate = buildValidator();
  if (!validate) throw new Error("conformance-vector.schema.json did not compile");

  const seenIds = new Map();
  const entries = [];

  for (const file of findVectors(vectorsDir)) {
    const relative = path.relative(conformanceDir, file);
    const vector = readJson(file);

    // `$schema` is an editor affordance on the fixture files; it is not part of the format.
    const { $schema: _schema, ...document } = vector;

    if (!validate(document)) {
      const detail = (validate.errors ?? [])
        .map((error) => `      ${error.instancePath || "/"} ${error.message}`)
        .join("\n");
      throw new Error(`${relative} does not match the vector schema:\n${detail}`);
    }

    const previous = seenIds.get(document.id);
    if (previous) {
      throw new Error(`Duplicate vector id ${document.id} in ${relative} and ${previous}`);
    }
    seenIds.set(document.id, relative);

    entries.push({
      id: document.id,
      kind: document.kind,
      milestone: document.milestone,
      file: relative.split(path.sep).join("/"),
      sha256: hashFile(file),
    });
  }

  entries.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return { formatVersion: FORMAT_VERSION, vectors: entries };
}

function summarize(index) {
  /** @type {Record<string, number>} */
  const byMilestone = {};
  for (const vector of index.vectors) {
    byMilestone[vector.milestone] = (byMilestone[vector.milestone] ?? 0) + 1;
  }
  const counts = Object.entries(byMilestone)
    .sort()
    .map(([milestone, count]) => `${milestone}:${count}`)
    .join("  ");
  console.log(`  ${index.vectors.length} vectors   ${counts}`);
}

function build() {
  const index = collect();
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  console.log(`Wrote ${path.relative(repoRoot, indexPath)}`);
  summarize(index);
  return 0;
}

function check() {
  const rebuilt = collect();
  let onDisk;
  try {
    onDisk = readJson(indexPath);
  } catch {
    console.error(
      "FAIL  core-spec/conformance/index.json is missing. Run: tx402-conformance build",
    );
    return 1;
  }

  const expected = new Map(rebuilt.vectors.map((vector) => [vector.id, vector]));
  const actual = new Map((onDisk.vectors ?? []).map((vector) => [vector.id, vector]));
  const problems = [];

  for (const [id, vector] of expected) {
    const recorded = actual.get(id);
    if (!recorded) {
      problems.push(`  added but not indexed:   ${id} (${vector.file})`);
    } else if (recorded.sha256 !== vector.sha256) {
      problems.push(`  content changed:         ${id} (${vector.file})`);
    } else if (recorded.kind !== vector.kind || recorded.milestone !== vector.milestone) {
      problems.push(`  kind or milestone moved: ${id}`);
    }
  }
  for (const id of actual.keys()) {
    if (!expected.has(id)) problems.push(`  indexed but missing:     ${id}`);
  }

  if (onDisk.formatVersion !== FORMAT_VERSION) {
    problems.push(
      `  index formatVersion is ${onDisk.formatVersion}, expected ${FORMAT_VERSION}`,
    );
  }

  if (problems.length > 0) {
    console.error("FAIL  conformance index is out of date:");
    console.error(problems.join("\n"));
    console.error("\n      Run: node tools/conformance/index.js build");
    return 1;
  }

  console.log("OK    conformance index matches the vectors on disk");
  summarize(rebuilt);
  return 0;
}

const USAGE = `tx402-conformance — fixture index tooling (ADR-005, SEC-007)

Usage:
  tx402-conformance build   rewrite core-spec/conformance/index.json
  tx402-conformance check   fail if the index and the vectors disagree`;

try {
  const command = process.argv[2];
  if (command === "build") process.exitCode = build();
  else if (command === "check") process.exitCode = check();
  else if (command === undefined || command === "-h" || command === "--help") {
    console.log(USAGE);
  } else {
    console.error(`Unknown command: ${command}\n\n${USAGE}`);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(
    `tx402-conformance: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
