#!/usr/bin/env node
/**
 * Fails if any tracked text file contains a raw NUL byte.
 *
 * PLAN.md open item **O25**. At S7 four literal NUL bytes reached
 * `src/evm/adapter.ts` and `src/solana/adapter.ts` — a cache-key separator written as a raw
 * control character instead of the `\u0000` escape. The resulting strings were correct and
 * **every gate passed**: lint, format, types, tests, coverage, size.
 *
 * What broke was review, not behaviour. Git classifies a file containing a NUL as binary,
 * so `git diff` reported `Bin 9713 -> 10761 bytes` instead of a diff, and `grep` silently
 * refused to search the file. A source file that cannot be diffed cannot be reviewed, and
 * a payment SDK whose adapter is unreviewable is a worse problem than any single bug in it.
 *
 * This check is deliberately cheap and deliberately blunt: it asks git which files it
 * considers binary and complains about any of them that is not on a short allowlist of
 * genuinely binary extensions. That catches the failure by its *symptom* — unreviewable —
 * rather than by guessing which control characters are suspicious.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Extensions whose files are expected to be binary and are therefore not text to review. */
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".pdf",
  ".zip",
  ".gz",
  ".wasm",
]);

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
    .toString("utf8")
    .split("\0")
    .filter((path) => path !== "");
}

const offenders = [];
for (const path of trackedFiles()) {
  if (BINARY_EXTENSIONS.has(extname(path).toLowerCase())) continue;

  let bytes;
  try {
    bytes = readFileSync(join(ROOT, path));
  } catch {
    // A tracked path that cannot be read here is a submodule or a broken symlink, neither
    // of which is a file whose contents this check is about.
    continue;
  }

  const index = bytes.indexOf(0);
  if (index !== -1) {
    // Report the line so the fix is a one-line edit rather than a hunt. The byte offset
    // alone would be useless in a file git has already refused to diff.
    const line = bytes.subarray(0, index).toString("utf8").split("\n").length;
    offenders.push({ path, line });
  }
}

if (offenders.length > 0) {
  console.error("Raw NUL bytes found in tracked text files:\n");
  for (const { path, line } of offenders) {
    console.error(`  ${path}:${line}`);
  }
  console.error(
    "\nGit treats these files as binary: `git diff` shows a byte count instead of a diff\n" +
      "and `grep` will not search them, so they cannot be reviewed.\n" +
      "Write the escape (\\u0000 in TypeScript, \\u0000 in Python) rather than a literal NUL.",
  );
  process.exit(1);
}

console.log(`OK    no NUL bytes in ${trackedFiles().length} tracked files`);
