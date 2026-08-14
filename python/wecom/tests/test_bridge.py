"""Bridge behavior: session mapping, serialization, and reply delivery."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, List, Optional

import pytest

from dsh_wecom.bridge import HarnessWeComBridge
from dsh_wecom.platform_types import (
    MessageEvent,
    MessageType,
    Platform,
    PlatformConfig,
    SendResult,
    SessionSource,
)


@dataclass
class FakeRunResult:
    final_response: Optional[str]


class FakeSession:
    def __init__(self, harness: "FakeHarness", session_id: Optional[str]) -> None:
        self.harness = harness
        self.id = session_id or f"session-{len(harness.sessions) + 1}"

    def run(self, prompt: str) -> FakeRunResult:
        self.harness.calls.append((self.id, prompt))
        if self.harness.fail:
            raise RuntimeError("turn failed")
        if self.harness.on_run is not None:
            self.harness.on_run()
        return FakeRunResult(final_response=f"reply to {prompt}")


class FakeHarness:
    def __init__(self) -> None:
        self.calls: List[tuple[str, str]] = []
        self.sessions: List[str] = []
        self.fail = False
        self.on_run = None

    def start_session(self, session_id: Optional[str] = None) -> FakeSession:
        session = FakeSession(self, session_id)
        self.sessions.append(session.id)
        return session


def make_bridge(**kwargs: Any) -> tuple[HarnessWeComBridge, FakeHarness, List[tuple[str, str]]]:
    config = PlatformConfig(platform=Platform.WECOM, extra={"bot_id": "b", "secret": "s"})
    harness = FakeHarness()
    bridge = HarnessWeComBridge(config, harness, **kwargs)
    sent: List[tuple[str, str]] = []

    async def fake_send(chat_id: str, text: str, **_: Any) -> SendResult:
        sent.append((chat_id, text))
        return SendResult(success=True)

    bridge.adapter.send = fake_send  # type: ignore[method-assign]
    return bridge, harness, sent


def make_event(
    text: str = "hello",
    chat_id: str = "c1",
    chat_type: str = "dm",
    user_id: str = "u1",
    **kwargs: Any,
) -> MessageEvent:
    return MessageEvent(
        text=text,
        message_type=MessageType.TEXT,
        source=SessionSource(
            platform=Platform.WECOM,
            chat_id=chat_id,
            chat_type=chat_type,
            user_id=user_id,
        ),
        **kwargs,
    )


async def test_reply_goes_back_to_the_originating_chat() -> None:
    bridge, harness, sent = make_bridge()

    await bridge._on_message(make_event(text="hi", chat_id="c7"))

    assert harness.calls == [(harness.sessions[0], "hi")]
    assert sent == [("c7", "reply to hi")]


async def test_one_chat_keeps_one_session_across_turns() -> None:
    bridge, harness, _ = make_bridge()

    await bridge._on_message(make_event(text="first"))
    await bridge._on_message(make_event(text="second"))

    assert harness.calls[0][0] == harness.calls[1][0]


async def test_separate_chats_get_separate_sessions() -> None:
    bridge, harness, _ = make_bridge()

    await bridge._on_message(make_event(chat_id="a"))
    await bridge._on_message(make_event(chat_id="b"))

    assert harness.calls[0][0] != harness.calls[1][0]


async def test_group_members_get_separate_sessions_by_default() -> None:
    bridge, harness, _ = make_bridge()

    await bridge._on_message(make_event(chat_id="g", chat_type="group", user_id="u1"))
    await bridge._on_message(make_event(chat_id="g", chat_type="group", user_id="u2"))

    assert harness.calls[0][0] != harness.calls[1][0]


async def test_group_shares_one_session_when_per_user_is_disabled() -> None:
    bridge, harness, _ = make_bridge(group_sessions_per_user=False)

    await bridge._on_message(make_event(chat_id="g", chat_type="group", user_id="u1"))
    await bridge._on_message(make_event(chat_id="g", chat_type="group", user_id="u2"))

    assert harness.calls[0][0] == harness.calls[1][0]


async def test_turns_in_one_chat_do_not_overlap() -> None:
    bridge, harness, _ = make_bridge()
    active = 0
    peak = 0

    def track() -> None:
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        # Hold the worker thread so an unserialized second turn would overlap.
        import time

        time.sleep(0.05)
        active -= 1

    harness.on_run = track

    await asyncio.gather(
        bridge._on_message(make_event(text="a")),
        bridge._on_message(make_event(text="b")),
    )

    assert peak == 1
    assert len(harness.calls) == 2


async def test_a_failed_turn_reports_to_the_chat() -> None:
    bridge, harness, sent = make_bridge(error_reply="boom")
    harness.fail = True

    await bridge._on_message(make_event(chat_id="c9"))

    assert sent == [("c9", "boom")]


async def test_a_message_with_no_content_runs_no_turn() -> None:
    bridge, harness, sent = make_bridge()

    await bridge._on_message(make_event(text="   "))

    assert harness.calls == []
    assert sent == []


async def test_media_and_quotes_reach_the_prompt() -> None:
    bridge, harness, _ = make_bridge()

    await bridge._on_message(
        make_event(
            text="look",
            media_urls=["/cache/img_1.jpg"],
            media_types=["image"],
            reply_to_text="earlier message",
        )
    )

    prompt = harness.calls[0][1]
    assert prompt.splitlines() == [
        "[quoting] earlier message",
        "look",
        "[image] /cache/img_1.jpg",
    ]


async def test_stop_abandons_the_running_turn() -> None:
    bridge, harness, sent = make_bridge(stop_reply="ok stopped")
    release = asyncio.Event()

    def block() -> None:
        asyncio.run_coroutine_threadsafe(_wait(release), loop).result()

    async def _wait(ev: asyncio.Event) -> None:
        await ev.wait()

    loop = asyncio.get_running_loop()
    harness.on_run = block

    turn = asyncio.create_task(bridge._on_message(make_event(text="long task")))
    await asyncio.sleep(0.05)
    key = bridge._session_key(make_event())
    assert bridge.is_busy(key)

    await bridge._on_message(make_event(text="/stop"))
    assert sent == [("c1", "ok stopped")]
    assert not bridge.is_busy(key)

    release.set()
    await turn
    # The abandoned turn's answer is discarded, not delivered.
    assert sent == [("c1", "ok stopped")]


async def test_stop_with_nothing_running_says_so() -> None:
    bridge, harness, sent = make_bridge(idle_stop_reply="nothing here")

    await bridge._on_message(make_event(text="stop"))

    assert harness.calls == []
    assert sent == [("c1", "nothing here")]


async def test_a_new_message_after_stop_does_not_wait_for_the_abandoned_turn() -> None:
    bridge, harness, sent = make_bridge()
    release = asyncio.Event()
    loop = asyncio.get_running_loop()

    async def _wait() -> None:
        await release.wait()

    def block() -> None:
        # Only the first turn blocks; the follow-up must not be held behind it.
        harness.on_run = None
        asyncio.run_coroutine_threadsafe(_wait(), loop).result()

    harness.on_run = block

    stuck = asyncio.create_task(bridge._on_message(make_event(text="long task")))
    await asyncio.sleep(0.05)

    await bridge._on_message(make_event(text="/stop"))

    # The abandoned turn still holds its worker thread here.
    await asyncio.wait_for(bridge._on_message(make_event(text="next")), timeout=1.0)
    assert ("c1", "reply to next") in sent

    release.set()
    await stuck


async def test_a_stopped_conversation_continues_in_a_fresh_session() -> None:
    bridge, harness, _ = make_bridge()
    release = asyncio.Event()
    loop = asyncio.get_running_loop()

    async def _wait() -> None:
        await release.wait()

    def block() -> None:
        harness.on_run = None
        asyncio.run_coroutine_threadsafe(_wait(), loop).result()

    harness.on_run = block

    stuck = asyncio.create_task(bridge._on_message(make_event(text="long task")))
    await asyncio.sleep(0.05)
    await bridge._on_message(make_event(text="/stop"))
    await bridge._on_message(make_event(text="next"))

    release.set()
    await stuck

    abandoned_session = harness.calls[0][0]
    follow_up_session = harness.calls[1][0]
    assert abandoned_session != follow_up_session
