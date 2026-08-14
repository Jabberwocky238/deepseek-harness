"""Run a WeCom bot backed by a DeepSeek Harness runtime.

``python -m dsh_wecom`` serves messages until interrupted.
``python -m dsh_wecom --qr`` obtains bot credentials by QR scan instead.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import signal
import sys

from deepseek_harness import DeepSeekHarness

from .adapter import check_wecom_requirements, qr_scan_for_bot_info
from .bridge import HarnessWeComBridge
from .platform_types import Platform, PlatformConfig

logger = logging.getLogger("dsh_wecom")


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse the command line.

    :param argv: Arguments to parse; ``None`` reads ``sys.argv``.
    :returns: The parsed arguments.
    """
    parser = argparse.ArgumentParser(prog="dsh_wecom", description=__doc__)
    parser.add_argument(
        "--qr",
        action="store_true",
        help="obtain WECOM_BOT_ID and WECOM_SECRET by QR scan, then exit",
    )
    parser.add_argument("--cordis", help="path to a cordis.yml composing the runtime")
    parser.add_argument("--provider", help="provider route registered by that composition")
    parser.add_argument("--model", help="model id resolved by the provider adapter")
    parser.add_argument(
        "--cwd",
        help="workspace directory the agent operates in (default: current directory)",
    )
    parser.add_argument(
        "--group-shared-session",
        action="store_true",
        help="give a group chat one shared session instead of one session per member",
    )
    parser.add_argument("--log-level", default="INFO", help="Python logging level")
    return parser.parse_args(argv)


async def _serve(args: argparse.Namespace) -> int:
    """Serve WeCom messages until the process is asked to stop.

    :param args: Parsed command line.
    :returns: Process exit status.
    """
    bot_id = os.getenv("WECOM_BOT_ID", "").strip()
    secret = os.getenv("WECOM_SECRET", "").strip()
    if not bot_id or not secret:
        logger.error(
            "WECOM_BOT_ID and WECOM_SECRET must be set. Run `python -m dsh_wecom --qr` to obtain them."
        )
        return 2

    config = PlatformConfig(
        platform=Platform.WECOM,
        extra={"bot_id": bot_id, "secret": secret},
    )
    harness_options = {
        key: value
        for key, value in (
            ("cordis", args.cordis),
            ("provider", args.provider),
            ("model", args.model),
            ("cwd", args.cwd),
        )
        if value is not None
    }

    harness = DeepSeekHarness(**harness_options)
    bridge = HarnessWeComBridge(
        config,
        harness,
        group_sessions_per_user=not args.group_shared_session,
    )

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)

    try:
        if not await bridge.start():
            logger.error(
                "WeCom connection failed: %s", bridge.adapter.fatal_error_message or "unknown error"
            )
            return 1
        logger.info("WeCom bot connected. Press Ctrl-C to stop.")
        await stop.wait()
    finally:
        await bridge.stop()
        harness.close()

    return 0


def main(argv: list[str] | None = None) -> int:
    """Entry point.

    :param argv: Arguments to parse; ``None`` reads ``sys.argv``.
    :returns: Process exit status.
    """
    args = _parse_args(argv)
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    if not check_wecom_requirements():
        logger.error("aiohttp and httpx are required. Run: pip install aiohttp httpx")
        return 2

    if args.qr:
        return 0 if qr_scan_for_bot_info() else 1

    return asyncio.run(_serve(args))


if __name__ == "__main__":
    sys.exit(main())
