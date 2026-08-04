"""``tx402 call`` — the Python console entry point (SPEC §11).

Port of ``packages/tx402/src/cli/{args,exit-codes,run}.ts``. The two CLIs are the same
command surface, the same flags, the same ``--json`` document, and — the part a user's
shell script actually depends on — the same exit codes. The three TypeScript modules are
one file here because Python's package layout is flat; the section markers below keep the
correspondence obvious.

**The stdout/stderr contract is load-bearing** (SPEC §11). stdout carries the response
body, or exactly one JSON object under ``--json``, and nothing else ever. Every
diagnostic, warning and error goes to stderr. That is what makes ``tx402 call … >
out.json`` produce a usable file even when the call emitted warnings, and it is why the
SDK itself is forbidden from writing to the console at all (SPEC §10) — the CLI renders
from the structured event stream instead.

**No flag accepts a private key, and none ever will** (SPEC §11, SEC-001). Anything on a
command line lands in shell history, in ``ps`` output, and in CI logs.
"""

from __future__ import annotations

import json
import sys
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Final
from urllib.parse import urlsplit

from tx402.errors import TX402_ERROR_CODES, Tx402Error
from tx402.meta import PACKAGE_NAME, PROJECT_URLS

# --- exit codes (mirrors cli/exit-codes.ts) ---------------------------------------------

#: CLI exit codes. Normative — SPEC §11. ``1`` is deliberately unused: it is the
#: interpreter's own crash code.
EXIT_CODES: Final[Mapping[str, int]] = {
    "success": 0,
    "usage": 2,
    "policy": 3,
    "liquidity": 4,
    "protocol": 5,
    "signer": 6,
    "transport": 7,
    "ambiguous_payment": 8,
    "resource_failure": 9,
}

#: Every SPEC §8 error code, mapped onto the nine SPEC §11 exit codes.
#:
#: Collapsing fifteen onto nine is an implementation decision, and it is made here, once,
#: in a table — rather than in a chain of ``isinstance`` checks somewhere in the render
#: path — because a script's ``if [ $? -eq 3 ]`` is a public API. Changing a row silently
#: changes the meaning of somebody's shell script. The rationale for each grouping is
#: written once, in ``packages/tx402/src/cli/exit-codes.ts``, and this table is held to it
#: by ``tests/test_cli.py``; the grouping principle is *what the operator has to change to
#: make it work*.
EXIT_CODE_BY_ERROR: Final[Mapping[str, int]] = {
    TX402_ERROR_CODES["config_invalid"]: EXIT_CODES["usage"],
    TX402_ERROR_CODES["reserved_header"]: EXIT_CODES["usage"],
    TX402_ERROR_CODES["non_replayable"]: EXIT_CODES["usage"],
    TX402_ERROR_CODES["policy_budget"]: EXIT_CODES["policy"],
    TX402_ERROR_CODES["policy_domain"]: EXIT_CODES["policy"],
    TX402_ERROR_CODES["liquidity"]: EXIT_CODES["liquidity"],
    TX402_ERROR_CODES["protocol_unsupported"]: EXIT_CODES["protocol"],
    TX402_ERROR_CODES["scheme_unsupported"]: EXIT_CODES["protocol"],
    TX402_ERROR_CODES["payment_required_invalid"]: EXIT_CODES["protocol"],
    TX402_ERROR_CODES["clock_skew"]: EXIT_CODES["protocol"],
    TX402_ERROR_CODES["signer"]: EXIT_CODES["signer"],
    TX402_ERROR_CODES["transport"]: EXIT_CODES["transport"],
    TX402_ERROR_CODES["payment_ambiguous"]: EXIT_CODES["ambiguous_payment"],
    TX402_ERROR_CODES["resource_delivery"]: EXIT_CODES["resource_failure"],
    TX402_ERROR_CODES["redirect_blocked"]: EXIT_CODES["resource_failure"],
}


class UsageError(Exception):
    """Raised for a bad invocation, before the SDK is reached. Always exit code 2."""


def exit_code_for(error: BaseException) -> int:
    """The exit code for any raised exception.

    An unrecognised error exits ``2`` rather than ``1``: reaching here means the CLI was
    asked to do something it could not even classify, which is a usage problem from the
    caller's side, and ``1`` is reserved for the runtime crashing under us.
    """
    if isinstance(error, UsageError):
        return EXIT_CODES["usage"]
    # `isinstance` rather than `is_tx402_error` so the class attribute below is narrowed:
    # the two agree by construction, since every tx402 error derives from `Tx402Error`.
    if isinstance(error, Tx402Error):
        return EXIT_CODE_BY_ERROR[type(error).code]
    return EXIT_CODES["usage"]


# --- argument parsing (mirrors cli/args.ts) ---------------------------------------------

_VALUE_FLAGS: Final = frozenset(
    {"--method", "--body", "--max-spend", "--network", "--timeout"}
)
_METHODS: Final = frozenset({"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"})


@dataclass(frozen=True, slots=True)
class CallOptions:
    url: str
    method: str = "GET"
    #: Literal body, already read from disk if ``@file`` was used.
    body: str | None = None
    body_path: str | None = None
    max_spend: str | None = None
    network: str | None = None
    dry_run: bool = False
    json: bool = False
    timeout_ms: int | None = None


@dataclass(frozen=True, slots=True)
class ParsedCommand:
    kind: str
    options: CallOptions | None = None


def parse_args(argv: Sequence[str], read_file: Callable[[str], str]) -> ParsedCommand:
    """Parses argv (already sliced past the interpreter and script path).

    ``read_file`` is injected so the parser stays testable without touching a real
    filesystem. ``--body @file`` is resolved here rather than later so that a missing file
    is a usage error before any network request is made — a dry run that first pays a
    round trip to the merchant and only then discovers the body is unreadable wastes the
    operator's time and the merchant's.
    """
    if not argv:
        return ParsedCommand("help")
    if "-h" in argv or "--help" in argv:
        return ParsedCommand("help")
    if "-v" in argv or "--version" in argv:
        return ParsedCommand("version")

    command, rest = argv[0], list(argv[1:])
    if command != "call":
        raise UsageError(f'Unknown command "{command}". The only command is "call".')

    url: str | None = None
    method = "GET"
    body: str | None = None
    body_path: str | None = None
    max_spend: str | None = None
    network: str | None = None
    dry_run = False
    emit_json = False
    timeout_ms: int | None = None

    index = 0
    while index < len(rest):
        argument = rest[index]

        if argument in _VALUE_FLAGS:
            value = rest[index + 1] if index + 1 < len(rest) else None
            if value is None or value.startswith("--"):
                raise UsageError(f"{argument} requires a value")
            index += 2

            if argument == "--method":
                method = value.upper()
                if method not in _METHODS:
                    raise UsageError(f'Unsupported --method "{value}"')
            elif argument == "--body":
                if not value.startswith("@"):
                    raise UsageError(
                        "--body takes @<file>. An inline body is refused so a secret "
                        "cannot be captured in shell history."
                    )
                body_path = value[1:]
                if not body_path:
                    raise UsageError("--body @<file> needs a filename")
                try:
                    body = read_file(body_path)
                except OSError as error:
                    # The underlying message is not forwarded: it quotes an absolute
                    # path, which ends up in CI logs more often than anyone intends.
                    raise UsageError(f'Cannot read --body file "{body_path}"') from error
            elif argument == "--max-spend":
                max_spend = value
            elif argument == "--network":
                network = value
            elif argument == "--timeout":
                # Rejected rather than coerced. `--timeout 10s` silently becoming 10 ms is
                # the kind of thing that only surfaces as a flaky timeout in production.
                if not value.isdigit():
                    raise UsageError(
                        "--timeout takes whole milliseconds, e.g. --timeout 10000"
                    )
                timeout_ms = int(value, 10)
                if timeout_ms <= 0:
                    raise UsageError("--timeout must be greater than zero")
            continue

        index += 1
        if argument == "--dry-run":
            dry_run = True
            continue
        if argument == "--json":
            emit_json = True
            continue

        if argument.startswith("-"):
            # Catches `--private-key` and friends explicitly rather than letting an
            # unknown flag be silently treated as the URL.
            raise UsageError(f'Unknown option "{argument}"')
        if url is not None:
            raise UsageError("Only one URL may be given")
        url = argument

    if url is None:
        raise UsageError("tx402 call requires a URL")

    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise UsageError(f'"{url}" is not an absolute http or https URL')
    if parsed.username or parsed.password:
        # Credentials in a URL would be logged by anything that echoes the argv.
        raise UsageError("URL must not embed credentials")

    return ParsedCommand(
        "call",
        CallOptions(
            url=url,
            method=method,
            body=body,
            body_path=body_path,
            max_spend=max_spend,
            network=network,
            dry_run=dry_run,
            json=emit_json,
            timeout_ms=timeout_ms,
        ),
    )


# --- the command itself (mirrors cli/run.ts) --------------------------------------------

#: Schema version of the ``--json`` document. Bumped only on a breaking shape change,
#: and deliberately equal to the TypeScript CLI's: the two emit the same document.
JSON_SCHEMA_VERSION: Final = 1

#: Documented development-key variables (SPEC §11). Never flags.
DEV_KEY_ENV: Final[Mapping[str, str]] = {
    "evm": "TX402_DEV_PRIVATE_KEY",
    "solana": "TX402_DEV_SOLANA_KEYPAIR",
}

USAGE: Final = f"""{PACKAGE_NAME} — resilient x402 buyer client

Usage:
  tx402 call <URL> [options]

Options:
  --method <METHOD>     HTTP method (default: GET)
  --body @<file>        Request body, read from a file
  --max-spend <MONEY>   Per-request cap, e.g. "0.10 USDC"
  --network <CAIP2>     Restrict payment to one network
  --dry-run             Parse, evaluate policy, and plan routes. Never signs.
  --json                Emit one JSON object on stdout
  --timeout <MS>        Paid-retry timeout in whole milliseconds
  -h, --help            Show this message
  -v, --version         Show version

Exit codes:
  0 success   2 usage/config   3 policy    4 liquidity   5 protocol
  6 signer    7 transport      8 ambiguous payment       9 resource failure

Signing keys are never accepted as flags. For development only, tx402 reads
{DEV_KEY_ENV["evm"]} and {DEV_KEY_ENV["solana"]}; prefer an external signer.

Docs: {PROJECT_URLS["documentation"]}"""


def _read_text_file(path: str) -> str:
    """The real filesystem read behind ``CliIo.read_file``.

    A named function rather than a lambda in the dataclass default: a plain callable
    assigned as a default would be bound as a method and receive ``self`` as its first
    argument the moment anyone read it off an instance.
    """
    return Path(path).read_text(encoding="utf-8")


@dataclass
class CliIo:
    """Every effect the CLI has, in one injectable object.

    Declared as attributes holding callables rather than as methods so they can be passed
    around detached — ``parse_args(io.argv, io.read_file)`` — exactly as the TypeScript
    ``CliIo`` is.
    """

    argv: Sequence[str]
    env: Mapping[str, str]
    stdout: Callable[[str], None]
    stderr: Callable[[str], None]
    read_file: Callable[[str], str] = field(default=_read_text_file)
    #: Injected so tests can supply signers without touching a real key.
    create_client: Callable[..., Any] | None = None
    events: list[dict[str, Any]] = field(default_factory=list)


def _collecting_logger(events: list[dict[str, Any]]) -> Any:
    """Collects the structured event stream so ``--json`` can report real timings."""

    def push(event: Mapping[str, Any]) -> None:
        events.append(dict(event))

    return type(
        "_CollectingLogger",
        (),
        {
            "debug": staticmethod(push),
            "info": staticmethod(push),
            "warn": staticmethod(push),
            "error": staticmethod(push),
        },
    )()


class _DryRunSigner:
    """An EVM signer that can report its address and can never produce a signature.

    SPEC §11: ``--dry-run`` MUST NOT invoke a signer. Enforced structurally rather than by
    trusting the code path, so that any future edit which reaches signing on this path
    fails loudly instead of quietly producing a signature during a "dry" run.
    """

    kind = "evm"

    def __init__(self, inner: Any) -> None:
        self._inner = inner

    def get_address(self) -> str:
        return str(self._inner.get_address())

    def sign_typed_data(self, request: Any) -> bytes:
        raise AssertionError("tx402: --dry-run must never produce a signature")


class _DryRunSolanaSigner:
    """A Solana signer that can report its public key and can never produce a signature.

    The Solana counterpart to :class:`_DryRunSigner`, and it exists for the same reason:
    SPEC §11's rule is enforced structurally, so an edit that reaches signing on the dry-run
    path fails loudly rather than quietly signing.
    """

    kind = "solana"

    def __init__(self, inner: Any) -> None:
        self._inner = inner

    def get_public_key(self) -> str:
        return str(self._inner.get_public_key())

    def sign_transaction(self, request: Any) -> bytes:
        raise AssertionError("tx402: --dry-run must never produce a signature")


def _resolve_signers(io: CliIo, dry_run: bool) -> dict[str, Any]:
    """Builds signers from the documented environment variables, warning first.

    The warning is unconditional and goes to stderr on every run that uses one of these,
    not once per session and not behind a verbosity flag. A key in an environment variable
    is a key any child process and any crash reporter can read, and the operator should be
    told every single time — SPEC §11 requires the warning, and habituation is the failure
    mode a once-per-session warning would introduce.
    """
    evm_key = io.env.get(DEV_KEY_ENV["evm"])
    solana_key = io.env.get(DEV_KEY_ENV["solana"])
    if evm_key is None and solana_key is None:
        return {}

    def warn(variable: str) -> None:
        io.stderr(
            f"warning: using a development signing key from {variable}. "
            "Anything that can read this process's environment can read the key. "
            "Use an external signer for anything but a low-balance test wallet.\n"
        )

    signers: dict[str, Any] = {}

    if evm_key is not None:
        warn(DEV_KEY_ENV["evm"])

        # Imported lazily so the CLI's help and usage paths never load a chain library, and
        # so a dry run on a machine without the `evm` extra installed still works.
        from tx402.signers import private_key_to_evm_signer

        try:
            signer = private_key_to_evm_signer(evm_key)
        except Exception as error:
            # The raised message is not forwarded — key validation tends to quote its input.
            raise UsageError(
                f"{DEV_KEY_ENV['evm']} is not a 0x-prefixed 32-byte hex private key"
            ) from error

        signers["evm_signer"] = _DryRunSigner(signer) if dry_run else signer

    if solana_key is not None:
        warn(DEV_KEY_ENV["solana"])

        from tx402.signers import keypair_to_solana_signer

        try:
            solana_signer = keypair_to_solana_signer(solana_key)
        except Exception as error:
            raise UsageError(
                f"{DEV_KEY_ENV['solana']} is not a JSON array of 64 Solana keypair bytes"
            ) from error

        signers["solana_signer"] = (
            _DryRunSolanaSigner(solana_signer) if dry_run else solana_signer
        )

    return signers


def _render_plan_human(io: CliIo, plan: Any) -> None:
    if plan.payment_required is None:
        io.stderr(f"no payment required — resource answered {plan.response.status_code}\n")
        return
    io.stderr(f"request-id      {plan.request_id}\n")
    io.stderr(f"requirements    {len(plan.payment_required['requirements'])}\n")
    selected = plan.selected
    if selected is None:  # pragma: no cover - planning raises rather than returning none
        io.stderr("no viable route\n")
        return
    io.stderr(f"would pay       {selected.amount_atomic} atomic on {selected.network}\n")
    io.stderr(f"scheme          {selected.scheme}\n")
    io.stderr(f"asset           {selected.asset_id}\n")
    io.stderr(f"health/rank     {selected.health_score:.2f} / {selected.rank}\n")
    io.stderr(f"candidates      {len(plan.candidates or ())}\n")
    io.stderr("dry run — nothing was signed and no budget was reserved\n")


def _from_events(events: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Recovers the inspection and route facts from the structured event stream.

    A real call returns a response, not a plan, so on the paying path these are not
    available as return values — but SPEC §11 requires ``--json`` to report both. Rather
    than widen the SDK's return type for the CLI's benefit, they are read back out of the
    SPEC §10 events the run already emitted. Those events are redaction-safe by
    construction, so nothing reaches the JSON document that could not already be logged.
    """

    def find(name: str) -> Mapping[str, Any] | None:
        return next((event for event in events if event.get("event") == name), None)

    required = find("payment.required")
    planned = find("route.planned")
    return {
        "inspection": None
        if required is None
        else {
            "requirementCount": required.get("requirementCount"),
            "headerHash": required.get("headerHash"),
        },
        "route": None
        if planned is None
        else {
            "network": planned.get("selectedNetwork"),
            "scheme": planned.get("selectedScheme"),
            "healthScore": planned.get("selectedHealthScore"),
            "rank": planned.get("selectedRank"),
            "candidateCount": planned.get("candidateCount"),
        },
    }


def _json_document(
    *,
    ok: bool,
    exit_code: int,
    dry_run: bool,
    elapsed_ms: int,
    events: Sequence[Mapping[str, Any]],
    request_id: str | None = None,
    status: int | None = None,
    plan: Any = None,
    body: str | None = None,
    error: BaseException | None = None,
) -> str:
    """The ``--json`` document (SPEC §11: schema version, inspection, route, timings,
    error). Key order and shape match the TypeScript CLI's byte for byte."""
    recovered = _from_events(events)
    # A dry run has the plan in hand and reports it directly; the paying path reconstructs
    # the same facts from the event stream, so both produce the same document shape.
    has_plan = plan is not None and plan.payment_required is not None

    document: dict[str, Any] = {
        "schemaVersion": JSON_SCHEMA_VERSION,
        "ok": ok,
        "exitCode": exit_code,
        "dryRun": dry_run,
    }
    if request_id is not None:
        document["requestId"] = request_id
    document["inspection"] = (
        {
            "status": plan.response.status_code,
            "requirementCount": len(plan.payment_required["requirements"]),
            "headerHash": plan.payment_required["headerHash"],
        }
        if has_plan
        else recovered["inspection"]
    )
    document["route"] = (
        {
            "network": plan.selected.network,
            "scheme": plan.selected.scheme,
            "assetId": plan.selected.asset_id,
            "amountAtomic": plan.selected.amount_atomic,
            "healthScore": plan.selected.health_score,
            "rank": plan.selected.rank,
            "candidateCount": len(plan.candidates or ()),
        }
        if has_plan and plan.selected is not None
        else recovered["route"]
    )
    if status is not None:
        document["status"] = status
    if body is not None:
        document["body"] = body
    document["timings"] = {"elapsedMs": elapsed_ms, "events": len(events)}
    # `to_dict` on Tx402Error deliberately omits the cause and traceback (SEC-003), so
    # this cannot carry a signer payload or a URL with credentials into a log aggregator.
    if error is None:
        document["error"] = None
    elif isinstance(error, Tx402Error):
        document["error"] = error.to_dict()
    else:
        document["error"] = {"code": "TX402_CLI_USAGE", "message": str(error)}
    return f"{json.dumps(document, indent=2)}\n"


def run_cli(io: CliIo) -> int:
    """Runs one CLI invocation and returns its exit code.

    Never raises and never calls ``sys.exit``: the caller owns the process. That is what
    lets the test suite assert on exit codes directly.
    """
    started_at = time.monotonic()
    events = io.events
    options: CallOptions | None = None

    def elapsed() -> int:
        return int((time.monotonic() - started_at) * 1000)

    try:
        parsed = parse_args(io.argv, io.read_file)
        if parsed.kind == "help":
            io.stdout(f"{USAGE}\n")
            return EXIT_CODES["success"]
        if parsed.kind == "version":
            io.stdout(f"{PACKAGE_NAME} 0.0.0\n")
            return EXIT_CODES["success"]

        options = parsed.options
        assert options is not None

        # One policy object, built once. Assigning per flag would make the last flag win
        # and silently drop the other — `--max-spend` quietly ignored because `--network`
        # was also given is exactly the kind of guardrail failure that only shows up as an
        # unexpectedly large payment.
        from tx402.client import Tx402Client
        from tx402.policy import Policy

        policy_fields: dict[str, Any] = {}
        if options.max_spend is not None:
            policy_fields["max_per_request"] = options.max_spend
        if options.network is not None:
            policy_fields["allowed_networks"] = [options.network]

        create = io.create_client or Tx402Client
        kwargs: dict[str, Any] = {
            "logger": _collecting_logger(events),
            # Localhost over plain HTTP is allowed so the documented local-merchant
            # walkthrough works; every other host is still required to be HTTPS.
            "allow_insecure_localhost": True,
            **_resolve_signers(io, options.dry_run),
        }
        if policy_fields:
            kwargs["policy"] = Policy(**policy_fields)
        if options.timeout_ms is not None:
            kwargs["payment_retry_timeout_ms"] = options.timeout_ms

        with create(**kwargs) as client:
            request_kwargs: dict[str, Any] = {}
            if options.body is not None:
                request_kwargs["content"] = options.body.encode("utf-8")

            if options.dry_run:
                plan = client.plan(options.method, options.url, **request_kwargs)
                if options.json:
                    io.stdout(
                        _json_document(
                            ok=True,
                            exit_code=EXIT_CODES["success"],
                            dry_run=True,
                            request_id=plan.request_id,
                            plan=plan,
                            elapsed_ms=elapsed(),
                            events=events,
                        )
                    )
                else:
                    _render_plan_human(io, plan)
                return EXIT_CODES["success"]

            response = client.request(options.method, options.url, **request_kwargs)
            body = response.text

            if options.json:
                io.stdout(
                    _json_document(
                        ok=response.is_success,
                        exit_code=EXIT_CODES["success"],
                        dry_run=False,
                        status=response.status_code,
                        body=body,
                        elapsed_ms=elapsed(),
                        events=events,
                    )
                )
            else:
                # The body, and only the body. A caller redirecting stdout gets a clean
                # artifact.
                io.stdout(body)
            return EXIT_CODES["success"]

    except BaseException as error:
        if isinstance(error, (KeyboardInterrupt, SystemExit)):
            raise
        code = exit_code_for(error)

        if options is not None and options.json:
            io.stdout(
                _json_document(
                    ok=False,
                    exit_code=code,
                    dry_run=options.dry_run,
                    elapsed_ms=elapsed(),
                    events=events,
                    error=error if isinstance(error, (Tx402Error, UsageError)) else None,
                )
            )
        elif isinstance(error, Tx402Error):
            io.stderr(f"{type(error).code}: {error.message}\n")
            if type(error).code == TX402_ERROR_CODES["payment_ambiguous"]:
                # Worth spelling out: this is the one exit code where retrying may pay
                # twice.
                io.stderr(
                    "the payment may have settled — do not retry without checking "
                    "the merchant\n"
                )
        elif isinstance(error, UsageError):
            io.stderr(f"tx402: {error}\n\n{USAGE}\n")
        else:
            io.stderr(f"tx402: {error}\n")
        return code


def main(argv: Sequence[str]) -> int:
    """Runs the CLI from a full ``sys.argv`` and returns a process exit code."""
    import os

    # `sys.stdout.write` returns a character count; the sinks are declared as returning
    # nothing so a future implementation cannot start meaning something by the result.
    def to_stdout(text: str) -> None:
        sys.stdout.write(text)

    def to_stderr(text: str) -> None:
        sys.stderr.write(text)

    return run_cli(
        CliIo(
            argv=list(argv[1:]),
            env=dict(os.environ),
            stdout=to_stdout,
            stderr=to_stderr,
        )
    )


def run() -> None:
    """Console-script shim registered as the ``tx402`` command."""
    raise SystemExit(main(sys.argv))
