"""Base class for the WeCom adapter.

The Hermes original is a template-method base carrying that gateway's retry,
streaming-draft, TTS, and access-policy machinery. This port keeps only what
the WeCom adapter calls: connection-state marks, a fatal-error latch, the
``SessionSource`` helper, and the ``handle_message`` seam.

``handle_message`` is the seam a runner overrides to route an inbound message
somewhere — in this package, to a DeepSeek Harness session.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from typing import Any, Callable, Dict, Optional

from .platform_types import (
    MessageEvent,
    Platform,
    PlatformConfig,
    SendResult,
    SessionSource,
)

logger = logging.getLogger(__name__)


class BasePlatformAdapter(ABC):
    """Connection lifecycle and message seam shared by platform adapters."""

    def __init__(self, config: PlatformConfig, platform: Platform):
        """Initialize connection state.

        :param config: Resolved settings for this platform.
        :param platform: Platform this adapter serves.
        """
        self.config = config
        self.platform = platform
        self.name = platform.value
        self._running = False
        self._fatal_error_code: Optional[str] = None
        self._fatal_error_message: Optional[str] = None
        self._fatal_error_retryable = True
        self._message_handler: Optional[Callable[[MessageEvent], Any]] = None

    @abstractmethod
    async def connect(self, *, is_reconnect: bool = False) -> bool:
        """Establish the platform connection.

        :param is_reconnect: True when retrying an earlier lost connection.
        :returns: True once the connection is usable.
        """

    @abstractmethod
    async def disconnect(self) -> None:
        """Tear down the platform connection and release its resources."""

    @abstractmethod
    async def send(self, chat_id: str, text: str, **kwargs: Any) -> SendResult:
        """Send a text message to a chat.

        :param chat_id: Destination chat.
        :param text: Message body.
        :returns: The send outcome.
        """

    @property
    def is_running(self) -> bool:
        """Whether the adapter currently holds a live connection."""
        return self._running

    @property
    def has_fatal_error(self) -> bool:
        """Whether the adapter stopped on an error that reconnecting cannot clear."""
        return self._fatal_error_code is not None

    @property
    def fatal_error_message(self) -> Optional[str]:
        """Human-readable detail of the latched fatal error, if any."""
        return self._fatal_error_message

    @property
    def fatal_error_code(self) -> Optional[str]:
        """Machine-readable code of the latched fatal error, if any."""
        return self._fatal_error_code

    @property
    def fatal_error_retryable(self) -> bool:
        """Whether the latched fatal error may clear on a later attempt."""
        return self._fatal_error_retryable

    def set_message_handler(self, handler: Callable[[MessageEvent], Any]) -> None:
        """Install the coroutine that receives every inbound message.

        :param handler: Awaitable called with each normalized ``MessageEvent``.
        """
        self._message_handler = handler

    async def handle_message(self, event: MessageEvent) -> None:
        """Deliver one inbound message to the installed handler.

        Dropping the event when no handler is installed keeps a connected
        adapter usable for send-only operation.

        :param event: The normalized inbound message.
        """
        if self._message_handler is None:
            logger.debug("[%s] No message handler installed; dropping message", self.name)
            return
        await self._message_handler(event)

    def build_source(
        self,
        chat_id: str,
        chat_name: Optional[str] = None,
        chat_type: str = "dm",
        user_id: Optional[str] = None,
        user_name: Optional[str] = None,
        message_id: Optional[str] = None,
    ) -> SessionSource:
        """Build the origin record for a message on this platform.

        :param chat_id: Chat the message arrived in.
        :param chat_name: Display name of the chat, when known.
        :param chat_type: Either ``dm`` or ``group``.
        :param user_id: Sender id, when known.
        :param user_name: Sender display name, when known.
        :param message_id: Id of the triggering message, when known.
        :returns: The populated ``SessionSource``.
        """
        return SessionSource(
            platform=self.platform,
            chat_id=str(chat_id),
            chat_name=chat_name,
            chat_type=chat_type,
            user_id=user_id,
            user_name=user_name,
            message_id=message_id,
        )

    async def send_typing(self, chat_id: str, metadata: Any = None) -> None:
        """Show a typing indicator when the platform supports one.

        :param chat_id: Chat to signal activity in.
        :param metadata: Platform-specific context, unused by default.
        """

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        """Return what the adapter knows about a chat.

        :param chat_id: Chat to describe.
        :returns: A mapping of known chat attributes.
        """
        return {"chat_id": chat_id}

    def _mark_connected(self) -> None:
        """Record a live connection and clear any latched fatal error."""
        self._running = True
        self._fatal_error_code = None
        self._fatal_error_message = None
        self._fatal_error_retryable = True

    def _mark_disconnected(self) -> None:
        """Record a lost connection, preserving an already-latched fatal error."""
        self._running = False

    def _set_fatal_error(self, code: str, message: str, *, retryable: bool) -> None:
        """Latch an error that stops the adapter.

        :param code: Machine-readable failure category.
        :param message: Human-readable detail.
        :param retryable: Whether a later attempt may succeed.
        """
        self._running = False
        self._fatal_error_code = code
        self._fatal_error_message = message
        self._fatal_error_retryable = retryable
        logger.error("[%s] Fatal error %s: %s", self.name, code, message)
