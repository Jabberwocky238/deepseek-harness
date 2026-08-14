"""Routes WeCom messages through DeepSeek Harness sessions.

One WeCom conversation maps to one Harness session, keyed by
:func:`.platform_types.build_session_key`, so a chat keeps its context across
turns. Turns for a single conversation are serialized: the runtime's
``final_response`` describes an activity interval rather than one prompt, so
concurrent prompts against the same session can return each other's text.
Different conversations still run concurrently.

The SDK is synchronous and the adapter is asyncio, so every ``run()`` executes
on a worker thread — blocking the event loop would stall the WebSocket
heartbeat and drop the connection.

Stopping a turn does not require the runtime's cooperation. The SDK protocol has
no prompt-cancel, and a turn blocked in a tool call would not observe one
anyway, so a stop invalidates the conversation's run generation instead: the
in-flight result is discarded when it arrives and the conversation unlocks at
once, leaving the user free to continue.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, Optional

from deepseek_harness import DeepSeekHarness

from .adapter import WeComAdapter
from .platform_types import MessageEvent, PlatformConfig, build_session_key

logger = logging.getLogger(__name__)

DEFAULT_ERROR_REPLY = "The agent could not complete that request. Please try again."
DEFAULT_STOP_REPLY = "Stopped."
DEFAULT_IDLE_STOP_REPLY = "Nothing is running."

STOP_COMMANDS = frozenset(
    {"/stop", "stop", "/cancel", "cancel", "停", "停止", "取消", "别说了"}
)


def is_stop_command(text: str) -> bool:
    """Report whether a message asks to stop the running turn.

    :param text: Raw inbound message text.
    :returns: True when the message is a stop request.
    """
    return " ".join(str(text or "").strip().split()).lower() in STOP_COMMANDS


class HarnessWeComBridge:
    """Serves one WeCom bot from one Harness runtime.

    The runtime subprocess is shared by every conversation; isolation comes from
    the per-conversation session id, not from separate processes.
    """

    def __init__(
        self,
        config: PlatformConfig,
        harness: DeepSeekHarness,
        *,
        group_sessions_per_user: bool = True,
        error_reply: str = DEFAULT_ERROR_REPLY,
        stop_reply: str = DEFAULT_STOP_REPLY,
        idle_stop_reply: str = DEFAULT_IDLE_STOP_REPLY,
    ):
        """Wire an adapter to a Harness runtime.

        :param config: WeCom platform settings.
        :param harness: Runtime that answers each turn. The bridge does not own
            it: the caller starts and closes it.
        :param group_sessions_per_user: Whether group members get separate sessions.
        :param error_reply: Text sent to the chat when a turn raises.
        :param stop_reply: Text sent when a stop abandons a running turn.
        :param idle_stop_reply: Text sent when a stop arrives with nothing running.
        """
        self.adapter = WeComAdapter(config)
        self.harness = harness
        self.group_sessions_per_user = group_sessions_per_user
        self.error_reply = error_reply
        self.stop_reply = stop_reply
        self.idle_stop_reply = idle_stop_reply
        self._session_ids: Dict[str, str] = {}
        self._session_locks: Dict[str, asyncio.Lock] = {}
        self._generations: Dict[str, int] = {}
        self._running: Dict[str, int] = {}
        self.adapter.set_message_handler(self._on_message)

    async def start(self) -> bool:
        """Connect the adapter and begin serving messages.

        :returns: True once connected.
        """
        return await self.adapter.connect()

    async def stop(self) -> None:
        """Disconnect the adapter, leaving the Harness runtime to its owner."""
        await self.adapter.disconnect()

    async def __aenter__(self) -> "HarnessWeComBridge":
        await self.start()
        return self

    async def __aexit__(self, _exc_type: Any, _exc: Any, _tb: Any) -> None:
        await self.stop()

    def _session_key(self, event: MessageEvent) -> str:
        """Return the conversation key for an inbound message.

        :param event: The inbound message.
        :returns: The conversation key.
        """
        return build_session_key(
            event.source, group_sessions_per_user=self.group_sessions_per_user
        )

    def _lock_for(self, key: str) -> asyncio.Lock:
        """Return the lock serializing turns for one conversation.

        A stop replaces this lock, so an abandoned turn releases an object
        nobody waits on any more.

        :param key: Conversation key.
        :returns: The lock currently owned by that conversation.
        """
        lock = self._session_locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._session_locks[key] = lock
        return lock

    def is_busy(self, key: str) -> bool:
        """Report whether a turn is running for a conversation.

        :param key: Conversation key.
        :returns: True while a turn is in flight.
        """
        return key in self._running

    def interrupt(self, key: str) -> bool:
        """Abandon the turn running for a conversation.

        The worker thread keeps running to completion — the runtime offers no
        way to stop it — but its result is discarded and the conversation is
        handed a fresh lock, so the next message is served without waiting for
        it. The abandoned turn releases the lock it took, which by then nobody
        holds a reference to.

        :param key: Conversation key.
        :returns: True when a turn was abandoned, False when none was running.
        """
        if key not in self._running:
            return False
        self._generations[key] = self._generations.get(key, 0) + 1
        del self._running[key]
        self._session_locks[key] = asyncio.Lock()
        # The abandoned turn still owns that Harness session, and its prompt
        # stays queued there. Reusing the id would interleave the next turn
        # with work the user asked to be rid of, so the conversation continues
        # in a fresh session.
        self._session_ids.pop(key, None)
        logger.info("[wecom-bridge] Abandoned running turn for %s", key)
        return True

    async def _on_message(self, event: MessageEvent) -> None:
        """Answer one inbound WeCom message.

        :param event: The normalized inbound message.
        """
        source = event.source
        if source is None:
            logger.warning("[wecom-bridge] Message without a source; dropping")
            return

        key = self._session_key(event)

        # A stop is handled before the conversation lock: waiting for it would
        # mean waiting for the very turn being stopped.
        if is_stop_command(event.text or ""):
            stopped = self.interrupt(key)
            await self.adapter.send(
                source.chat_id, self.stop_reply if stopped else self.idle_stop_reply
            )
            return

        prompt = self._build_prompt(event)
        if not prompt:
            logger.debug("[wecom-bridge] Nothing to send for message %s", event.message_id)
            return

        async with self._lock_for(key):
            generation = self._generations.get(key, 0)
            self._running[key] = generation
            try:
                reply = await self._run_turn(key, prompt, generation)
            except Exception:
                logger.exception("[wecom-bridge] Turn failed for %s", key)
                if self._still_current(key, generation):
                    del self._running[key]
                    await self.adapter.send(source.chat_id, self.error_reply)
                return

            if not self._still_current(key, generation):
                logger.info("[wecom-bridge] Discarding result of abandoned turn for %s", key)
                return
            del self._running[key]

        if reply:
            result = await self.adapter.send(source.chat_id, reply)
            if not result.success:
                logger.error(
                    "[wecom-bridge] Send failed for %s: %s", key, result.error
                )
        else:
            logger.info("[wecom-bridge] Empty response for %s; nothing sent", key)

    def _still_current(self, key: str, generation: int) -> bool:
        """Report whether a turn still owns its conversation.

        :param key: Conversation key.
        :param generation: Generation captured when the turn started.
        :returns: False once a stop has superseded the turn.
        """
        return self._generations.get(key, 0) == generation

    def _build_prompt(self, event: MessageEvent) -> str:
        """Render an inbound message as prompt text.

        Cached media paths are appended as local paths, which the runtime's file
        tools can open; unresolved media is named so the model can say what it
        cannot see.

        :param event: The inbound message.
        :returns: The prompt text, empty when the message carries nothing.
        """
        parts = []
        text = (event.text or "").strip()
        if text:
            parts.append(text)

        for url, kind in zip(event.media_urls, event.media_types):
            parts.append(f"[{kind}] {url}")

        if event.reply_to_text:
            quoted = event.reply_to_text.strip()
            if quoted:
                parts.insert(0, f"[quoting] {quoted}")

        return "\n".join(parts).strip()

    async def _run_turn(self, key: str, prompt: str, generation: int) -> Optional[str]:
        """Run one agent turn for a conversation on a worker thread.

        :param key: Conversation key.
        :param prompt: Prompt text.
        :param generation: Generation this turn belongs to.
        :returns: The turn's final response text, if any.
        """
        session_id = self._session_ids.get(key)

        def call() -> Any:
            session = self.harness.start_session(session_id)
            # A turn abandoned mid-run must not reinstate the session id the
            # stop cleared, which would route later turns back into it.
            if self._still_current(key, generation):
                self._session_ids[key] = session.id
            return session.run(prompt)

        result = await asyncio.to_thread(call)
        return result.final_response
