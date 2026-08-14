"""WeCom Smart Robot channel for DeepSeek Harness.

The adapter connects to WeCom over the Smart Robot WebSocket gateway and
normalizes inbound messages; the bridge routes each one through a Harness
session and sends the reply back. See ``README.md`` for setup.
"""

from .adapter import WeComAdapter, check_wecom_requirements, qr_scan_for_bot_info
from .bridge import HarnessWeComBridge
from .platform_types import (
    MessageEvent,
    MessageType,
    Platform,
    PlatformConfig,
    SendResult,
    SessionSource,
    build_session_key,
)

__all__ = [
    "HarnessWeComBridge",
    "MessageEvent",
    "MessageType",
    "Platform",
    "PlatformConfig",
    "SendResult",
    "SessionSource",
    "WeComAdapter",
    "build_session_key",
    "check_wecom_requirements",
    "qr_scan_for_bot_info",
]
