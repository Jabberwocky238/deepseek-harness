"""Helpers the WeCom adapter depends on.

``MessageDeduplicator`` is ported unchanged from the Hermes gateway; the
environment readers replace that project's multi-profile secret scope, which
has no counterpart here — this package reads one process environment.
"""

from __future__ import annotations

import os
import time
from typing import Any, Dict, Optional

TRUTHY_STRINGS = frozenset({"1", "true", "yes", "on", "y", "t"})


def is_truthy_value(value: Any, default: bool = False) -> bool:
    """Coerce a bool-ish config or environment value.

    :param value: Value to interpret; ``None`` selects *default*.
    :param default: Result for ``None``.
    :returns: The coerced boolean.
    """
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        stripped = value.strip().lower()
        return stripped in TRUTHY_STRINGS if stripped else default
    return bool(value)


def env_float(key: str, default: float = 0.0) -> float:
    """Read an environment variable as a float.

    :param key: Environment variable name.
    :param default: Value used when unset or unparsable.
    :returns: The parsed float, or *default*.
    """
    raw = os.getenv(key, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except (ValueError, TypeError):
        return default


def get_secret(name: str, default: Optional[str] = None) -> Optional[str]:
    """Read a credential from the process environment.

    :param name: Environment variable name.
    :param default: Value used when unset.
    :returns: The credential, or *default*.
    """
    val = os.getenv(name)
    return val if val is not None else default


class MessageDeduplicator:
    """TTL-based message deduplication cache.

    WeCom redelivers a message when it does not observe an ack in time, so the
    adapter claims each id before handing it on.

    Usage::

        self._dedup = MessageDeduplicator()

        # In message handler:
        if self._dedup.is_duplicate(msg_id):
            return
    """

    def __init__(self, max_size: int = 2000, ttl_seconds: float = 300):
        self._seen: Dict[str, float] = {}
        self._max_size = max_size
        self._ttl = ttl_seconds

    def is_duplicate(self, msg_id: str) -> bool:
        """Return True if *msg_id* was already seen within the TTL window."""
        if not msg_id:
            return False
        now = time.time()
        if msg_id in self._seen:
            if now - self._seen[msg_id] < self._ttl:
                return True
            # Entry has expired — remove it and treat as new
            del self._seen[msg_id]
        self._seen[msg_id] = now
        if len(self._seen) > self._max_size:
            cutoff = now - self._ttl
            self._seen = {k: v for k, v in self._seen.items() if v > cutoff}
            if len(self._seen) > self._max_size:
                # TTL pruning alone does not cap the cache when every entry is
                # still fresh. Keep the newest entries so the helper's
                # max_size bound is enforced under sustained traffic.
                newest = sorted(
                    self._seen.items(),
                    key=lambda item: item[1],
                )[-self._max_size:]
                self._seen = dict(newest)
        return False

    def contains(self, msg_id: str) -> bool:
        """Return whether *msg_id* is live in the cache without inserting it."""
        if not msg_id:
            return False
        seen_at = self._seen.get(msg_id)
        if seen_at is None:
            return False
        if time.time() - seen_at < self._ttl:
            return True
        del self._seen[msg_id]
        return False

    def discard(self, msg_id: str) -> None:
        """Release a claimed message ID after cancelled/failed handoff."""
        self._seen.pop(msg_id, None)

    def clear(self):
        """Clear all tracked messages."""
        self._seen.clear()
