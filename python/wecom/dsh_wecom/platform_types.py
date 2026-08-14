"""Platform-neutral message types the WeCom adapter produces and consumes.

Ported from the Hermes gateway's platform layer, reduced to the fields the
WeCom Smart Robot adapter actually reads. Fields belonging to other platforms
(Discord threads, Signal alt ids, Matrix scopes) and to Hermes multi-profile
routing are intentionally absent: nothing in this package produces them.
"""

from __future__ import annotations

import mimetypes
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional


class Platform(Enum):
    """Messaging platform an adapter serves."""

    WECOM = "wecom"


class MessageType(Enum):
    """Type of an incoming message."""

    TEXT = "text"
    LOCATION = "location"
    PHOTO = "photo"
    VIDEO = "video"
    AUDIO = "audio"
    VOICE = "voice"
    DOCUMENT = "document"
    STICKER = "sticker"
    COMMAND = "command"


@dataclass
class SessionSource:
    """Origin of a message, used to route the reply and to key the session."""

    platform: Platform
    chat_id: str
    chat_name: Optional[str] = None
    chat_type: str = "dm"
    user_id: Optional[str] = None
    user_name: Optional[str] = None
    message_id: Optional[str] = None


@dataclass
class MessageEvent:
    """Incoming message, normalized away from the WeCom wire payload."""

    text: str
    message_type: MessageType = MessageType.TEXT
    source: Optional[SessionSource] = None
    raw_message: Any = None
    message_id: Optional[str] = None
    media_urls: List[str] = field(default_factory=list)
    media_types: List[str] = field(default_factory=list)
    reply_to_message_id: Optional[str] = None
    reply_to_text: Optional[str] = None
    timestamp: Optional[datetime] = None


@dataclass
class SendResult:
    """Outcome of one send attempt.

    ``retryable`` marks a transient transport failure; ``retry_after`` carries a
    server-requested delay in seconds when the platform supplies one.
    """

    success: bool
    message_id: Optional[str] = None
    error: Optional[str] = None
    raw_response: Any = None
    retryable: bool = False
    retry_after: Optional[float] = None


@dataclass
class PlatformConfig:
    """Per-platform runtime settings resolved from the environment."""

    platform: Platform
    enabled: bool = True
    extra: Dict[str, Any] = field(default_factory=dict)


def build_session_key(source: SessionSource, group_sessions_per_user: bool = True) -> str:
    """Derive the conversation key a message belongs to.

    One key means one continuing conversation: it selects both the text-batch
    bucket and the Harness session the turn runs in. Direct messages are keyed
    per chat. Group chats are keyed per sender when *group_sessions_per_user*
    holds, so members do not share one context; otherwise the whole group does.

    :param source: Origin of the message.
    :param group_sessions_per_user: Whether group members get separate sessions.
    :returns: The session key.
    """
    chat_id = source.chat_id or "unknown"
    if source.chat_type == "group" and group_sessions_per_user and source.user_id:
        return f"wecom:group:{chat_id}:{source.user_id}"
    if source.chat_type == "group":
        return f"wecom:group:{chat_id}"
    return f"wecom:dm:{chat_id}"


def _media_cache_dir(kind: str) -> Path:
    """Return the cache directory for *kind*, creating it when absent.

    :param kind: Cache subdirectory name, such as ``images`` or ``documents``.
    :returns: The existing directory path.
    """
    base = Path.home() / ".cache" / "dsh-wecom" / kind
    base.mkdir(parents=True, exist_ok=True)
    return base


def cache_image_from_bytes(data: bytes, ext: str = ".jpg") -> str:
    """Write inbound image bytes to the cache.

    :param data: Raw image bytes.
    :param ext: File extension including the leading dot.
    :returns: Absolute path to the cached file.
    """
    path = _media_cache_dir("images") / f"img_{uuid.uuid4().hex[:12]}{ext}"
    path.write_bytes(data)
    return str(path)


def cache_document_from_bytes(data: bytes, filename: str) -> str:
    """Write inbound document bytes to the cache under a sanitized name.

    The original name is preserved behind a unique prefix so the model sees a
    human-readable filename; directory components are stripped so a hostile
    name cannot escape the cache directory.

    :param data: Raw document bytes.
    :param filename: Original filename supplied by the platform.
    :returns: Absolute path to the cached file.
    """
    safe_name = Path(filename).name if filename else "document"
    safe_name = safe_name.replace("\x00", "").strip()
    if not safe_name or safe_name in {".", ".."}:
        safe_name = "document"
    path = _media_cache_dir("documents") / f"doc_{uuid.uuid4().hex[:12]}_{safe_name}"
    path.write_bytes(data)
    return str(path)


def guess_mime_type(filename: str) -> str:
    """Return the MIME type for *filename*, defaulting to octet-stream.

    :param filename: Filename to inspect.
    :returns: A MIME type string.
    """
    return mimetypes.guess_type(filename)[0] or "application/octet-stream"
