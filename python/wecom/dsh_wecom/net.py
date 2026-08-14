"""HTTP client tuning and redirect-time SSRF protection.

Pre-flight URL validation lives in :mod:`.url_safety`; that check alone is
bypassable, because an attacker-controlled public URL can redirect to an
internal address after passing it. The redirect guard here re-validates every
hop, so both must stay installed on any client fetching a platform-supplied URL.
"""

from __future__ import annotations

import os
from typing import Any, Optional
from urllib.parse import urlsplit

from .url_safety import is_safe_url, redirect_target_from_response

try:
    import httpx
except ImportError:  # httpx is an optional dependency of this package.
    httpx = None  # type: ignore[assignment]

_DEFAULT_KEEPALIVE_EXPIRY_S = 2.0
_DEFAULT_MAX_KEEPALIVE = 10


def safe_url_for_log(url: str, max_len: int = 80) -> str:
    """Reduce a URL to a form safe to log, dropping credentials and query.

    :param url: URL to sanitize.
    :param max_len: Maximum length of the result.
    :returns: The sanitized, length-bounded URL.
    """
    if max_len <= 0 or url is None:
        return ""

    raw = str(url)
    if not raw:
        return ""

    try:
        parsed = urlsplit(raw)
    except ValueError:
        return raw[:max_len]

    if parsed.scheme and parsed.netloc:
        netloc = parsed.netloc.rsplit("@", 1)[-1]
        base = f"{parsed.scheme}://{netloc}"
        path = parsed.path or ""
        if path and path != "/":
            basename = path.rsplit("/", 1)[-1]
            safe = f"{base}/.../{basename}" if basename else f"{base}/..."
        else:
            safe = base
    else:
        safe = raw

    if len(safe) <= max_len:
        return safe
    if max_len <= 3:
        return "." * max_len
    return f"{safe[:max_len - 3]}..."


async def ssrf_redirect_guard(response: Any) -> None:
    """Reject a redirect whose target resolves to a private or internal address.

    Installed as an httpx response event hook, which is why this is a
    coroutine even though it performs no I/O.

    :param response: The response httpx is about to follow.
    :raises ValueError: When the redirect target fails validation.
    """
    redirect_url = redirect_target_from_response(response)
    if redirect_url and not is_safe_url(redirect_url):
        raise ValueError(
            f"Blocked redirect to private/internal address: {safe_url_for_log(redirect_url)}"
        )


def platform_httpx_limits() -> Optional["httpx.Limits"]:
    """Return connection limits for the adapter's long-lived HTTP client.

    The adapter keeps one client alive for its whole run, so idle keep-alive
    sockets are recycled more aggressively than the httpx default: behind a
    transparent proxy, peer-initiated FIN can linger in ``CLOSE_WAIT`` long
    enough to press on the process file-descriptor limit.

    :returns: The tuned limits, or ``None`` when httpx is unavailable so the
        caller falls back to the httpx default.
    """
    if httpx is None:
        return None

    def _env_float(name: str, default: float) -> float:
        raw = os.environ.get(name, "").strip()
        if not raw:
            return default
        try:
            val = float(raw)
        except (TypeError, ValueError):
            return default
        return val if val > 0 else default

    def _env_int(name: str, default: int) -> int:
        raw = os.environ.get(name, "").strip()
        if not raw:
            return default
        try:
            val = int(raw)
        except (TypeError, ValueError):
            return default
        return val if val > 0 else default

    return httpx.Limits(
        max_keepalive_connections=_env_int(
            "DSH_WECOM_HTTPX_MAX_KEEPALIVE", _DEFAULT_MAX_KEEPALIVE
        ),
        keepalive_expiry=_env_float(
            "DSH_WECOM_HTTPX_KEEPALIVE_EXPIRY", _DEFAULT_KEEPALIVE_EXPIRY_S
        ),
    )
