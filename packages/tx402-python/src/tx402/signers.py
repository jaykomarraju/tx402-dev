"""Optional private-key convenience signer adapters.

Port of ``packages/tx402/src/signers/index.ts``. Deliberately a module nothing else in
the package imports: per SEC-001 the primary client configuration accepts **signer
abstractions only** and never a raw private key, so nothing in the core API can reach this
code. A caller has to ``from tx402.signers import private_key_to_evm_signer`` by name,
which is what makes the choice explicit and auditable in a diff.

**Use an external signer if you can.** SPEC §9.1 lists prompt injection extracting a
wallet key as a live threat for exactly the autonomous agents this SDK targets, and a key
held in process memory is a key an in-process compromise can read. A KMS, a hardware
wallet, or a remote signing service implements the same :class:`~tx402.evm.EvmSigner`
protocol and keeps the key outside the blast radius. This adapter exists for development
and for small, dedicated, low-balance wallets.

The key is captured in a closure and is never stored on the returned object, never
serialized, and never logged. ``__repr__`` is overridden so that a signer accidentally
passed to a logger renders as a redacted placeholder rather than as an object holding an
account.

Example::

    import os
    from tx402.signers import private_key_to_evm_signer

    evm = private_key_to_evm_signer(os.environ["TX402_DEV_PRIVATE_KEY"])
"""

from __future__ import annotations

import re
from typing import Any, Final, Literal

from tx402.evm import EvmTypedDataRequest

__all__ = ["PrivateKeyEvmSigner", "private_key_to_evm_signer"]

_PRIVATE_KEY: Final = re.compile(r"^0x[0-9a-fA-F]{64}$")


class PrivateKeyEvmSigner:
    """An :class:`~tx402.evm.EvmSigner` backed by a raw secp256k1 key.

    The key lives in ``_sign``'s closure. It is not an attribute, so it cannot be reached
    by attribute access, by ``vars()``, or by a serializer walking the object.
    """

    kind: Literal["evm"] = "evm"

    __slots__ = ("_address", "_sign")

    def __init__(self, private_key: str) -> None:
        if not isinstance(private_key, str) or not _PRIVATE_KEY.match(private_key):
            # Validated here rather than by the chain library, whose own validation error
            # tends to quote its input — which is how a key reaches a traceback.
            raise ValueError(
                "private_key_to_evm_signer expects a 0x-prefixed 32-byte hex private key"
            )

        # Imported lazily so the core install never loads a chain library: `import tx402`
        # must not require the `evm` extra, and `tests/test_package_contract.py` asserts it.
        from eth_account import Account
        from eth_account.messages import encode_typed_data

        account = Account.from_key(private_key)
        self._address: str = str(account.address)

        def sign(request: EvmTypedDataRequest) -> bytes:
            # `presentation` is tx402's human-readable summary (SPEC §6.6). eth-account
            # signs the EIP-712 structure only, so it is deliberately not forwarded.
            encoded = encode_typed_data(
                full_message={
                    "domain": dict(request.domain),
                    "types": {
                        name: [dict(field) for field in fields]
                        for name, fields in request.types.items()
                    },
                    "primaryType": request.primary_type,
                    "message": dict(request.message),
                }
            )
            # Returned as raw bytes rather than as a hex string: `HexBytes` is a `bytes`
            # subclass, so the adapter's `isinstance(..., bytes)` branch accepts it
            # directly and no prefix convention has to be agreed on twice.
            return bytes(account.sign_message(encoded).signature)

        self._sign = sign

    def get_address(self) -> str:
        return self._address

    def sign_typed_data(self, request: EvmTypedDataRequest) -> bytes | str:
        return self._sign(request)

    def __repr__(self) -> str:
        return f"PrivateKeyEvmSigner(evm:{self._address})"

    def __reduce__(self) -> Any:
        # Pickling would be a second route to serializing the closure. Refused outright:
        # there is no legitimate reason to send a live signer to another process.
        raise TypeError("a tx402 signer cannot be pickled")


def private_key_to_evm_signer(private_key: str) -> PrivateKeyEvmSigner:
    """Wraps a raw secp256k1 private key as an :class:`~tx402.evm.EvmSigner`.

    :param private_key: 32-byte hex, ``0x``-prefixed. Never logged, and rejected before
        ``eth_account`` sees it if it is malformed.
    """
    return PrivateKeyEvmSigner(private_key)
