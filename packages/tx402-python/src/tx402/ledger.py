"""Atomic process-local rolling spend reservations (SPEC §5.3, ADR-007)."""

from __future__ import annotations

from dataclasses import dataclass, replace
from threading import RLock
from typing import Literal

from tx402.errors import BudgetExceededError, Tx402ErrorContext

RESERVATION_TTL_MS = 120_000
ROLLING_WINDOW_MS = 3_600_000
ReservationState = Literal["reserved", "committed", "released", "expired"]


@dataclass(frozen=True, slots=True)
class SpendReservation:
    reservation_id: str
    policy_scope: str
    request_fingerprint: str
    asset_id: str
    amount_atomic: str
    created_at_epoch_ms: int
    expires_at_epoch_ms: int
    state: ReservationState


@dataclass(frozen=True, slots=True)
class SpendEntry:
    reservation_id: str
    request_fingerprint: str
    asset_id: str
    amount_atomic: str
    committed_at_epoch_ms: int
    settlement_id: str | None = None


@dataclass(frozen=True, slots=True)
class BudgetState:
    store_kind: str
    committed_atomic: str
    reserved_atomic: str
    entries: tuple[SpendEntry, ...]
    reservations: tuple[SpendReservation, ...]


class MemorySpendStore:
    """Single-process store with atomic operations protected by a re-entrant lock."""

    kind = "memory"

    def __init__(self) -> None:
        self._reservations: dict[str, SpendReservation] = {}
        self._entries: dict[str, SpendEntry] = {}
        self._lock = RLock()

    def _maintain(self, now_epoch_ms: int) -> None:
        cutoff = now_epoch_ms - ROLLING_WINDOW_MS
        for reservation_id, reservation in list(self._reservations.items()):
            current = reservation
            if current.state == "reserved" and current.expires_at_epoch_ms <= now_epoch_ms:
                current = replace(current, state="expired")
                self._reservations[reservation_id] = current
            committed_entry = self._entries.get(reservation_id)
            if (
                current.created_at_epoch_ms < cutoff
                and current.state != "reserved"
                and (
                    current.state != "committed"
                    or committed_entry is None
                    or committed_entry.committed_at_epoch_ms < cutoff
                )
            ):
                del self._reservations[reservation_id]
        for reservation_id, entry in list(self._entries.items()):
            if entry.committed_at_epoch_ms < cutoff:
                del self._entries[reservation_id]

    def get_budget_state(
        self, *, policy_scope: str, asset_id: str, now_epoch_ms: int
    ) -> BudgetState:
        with self._lock:
            self._maintain(now_epoch_ms)
            cutoff = now_epoch_ms - ROLLING_WINDOW_MS
            entries = tuple(
                entry
                for entry in self._entries.values()
                if entry.asset_id == asset_id
                and entry.committed_at_epoch_ms >= cutoff
                and entry.committed_at_epoch_ms <= now_epoch_ms
                and self._reservations[entry.reservation_id].policy_scope == policy_scope
            )
            reservations = tuple(
                reservation
                for reservation in self._reservations.values()
                if reservation.policy_scope == policy_scope
                and reservation.asset_id == asset_id
            )
            committed = sum(int(entry.amount_atomic) for entry in entries)
            reserved = sum(
                int(reservation.amount_atomic)
                for reservation in reservations
                if reservation.state == "reserved"
                and reservation.created_at_epoch_ms >= cutoff
                and reservation.created_at_epoch_ms <= now_epoch_ms
                and reservation.expires_at_epoch_ms > now_epoch_ms
            )
            return BudgetState(
                self.kind, str(committed), str(reserved), entries, reservations
            )

    def reserve(
        self,
        *,
        reservation_id: str,
        request_id: str,
        policy_scope: str,
        request_fingerprint: str,
        asset_id: str,
        amount_atomic: str,
        max_per_hour_atomic: str,
        now_epoch_ms: int,
    ) -> SpendReservation:
        with self._lock:
            existing = self._reservations.get(reservation_id)
            if existing is not None:
                if (
                    existing.policy_scope != policy_scope
                    or existing.request_fingerprint != request_fingerprint
                    or existing.asset_id != asset_id
                    or existing.amount_atomic != amount_atomic
                ):
                    raise ValueError("Reservation ID was reused with different spend data")
                return existing
            current = self.get_budget_state(
                policy_scope=policy_scope, asset_id=asset_id, now_epoch_ms=now_epoch_ms
            )
            if int(current.committed_atomic) + int(current.reserved_atomic) + int(
                amount_atomic
            ) > int(max_per_hour_atomic):
                raise BudgetExceededError(
                    "Hourly spend limit would be exceeded",
                    context=Tx402ErrorContext(
                        request_id=request_id,
                        phase="policy",
                        amount_atomic=amount_atomic,
                        asset_id=asset_id,
                    ),
                    details={
                        "requestedAtomic": amount_atomic,
                        "capAtomic": max_per_hour_atomic,
                        "committedAtomic": current.committed_atomic,
                        "reservedAtomic": current.reserved_atomic,
                        "capKind": "per-hour",
                    },
                )
            reservation = SpendReservation(
                reservation_id,
                policy_scope,
                request_fingerprint,
                asset_id,
                amount_atomic,
                now_epoch_ms,
                now_epoch_ms + RESERVATION_TTL_MS,
                "reserved",
            )
            self._reservations[reservation_id] = reservation
            return reservation

    def commit(
        self,
        *,
        reservation_id: str,
        committed_at_epoch_ms: int,
        settlement_id: str | None = None,
    ) -> SpendEntry:
        with self._lock:
            existing = self._entries.get(reservation_id)
            if existing is not None:
                return existing
            self._maintain(committed_at_epoch_ms)
            reservation = self._reservations[reservation_id]
            if reservation.state == "released":
                raise ValueError("Released reservation cannot commit")
            entry = SpendEntry(
                reservation_id,
                reservation.request_fingerprint,
                reservation.asset_id,
                reservation.amount_atomic,
                committed_at_epoch_ms,
                settlement_id,
            )
            self._entries[reservation_id] = entry
            self._reservations[reservation_id] = replace(reservation, state="committed")
            return entry

    def release(self, *, reservation_id: str, now_epoch_ms: int) -> SpendReservation:
        with self._lock:
            self._maintain(now_epoch_ms)
            reservation = self._reservations[reservation_id]
            if reservation.state != "reserved":
                return reservation
            released = replace(reservation, state="released")
            self._reservations[reservation_id] = released
            return released
