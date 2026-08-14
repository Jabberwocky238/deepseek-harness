# deepseek-harness-wecom

WeCom (Enterprise WeChat) Smart Robot channel for DeepSeek Harness. The bot
connects out over WebSocket, so it needs no public callback URL and no inbound
port.

## Install

```sh
uv venv .venv
uv pip install --python .venv -e .
```

## Obtain bot credentials

```sh
python -m dsh_wecom --qr
```

The command prints a QR code URL to scan with WeCom and reports the resulting
bot id and secret. Export them, or place them in the repo-root `.env`:

```sh
export WECOM_BOT_ID=...
export WECOM_SECRET=...
```

## Run

```sh
python -m dsh_wecom
```

`DEEPSEEK_API_KEY` reaches the runtime through the environment, as with any
other Harness SDK consumer. `--cordis` selects a plugin composition, and
`--provider` / `--model` select a route that composition registers; without
them, the SDK's bundled default runtime and configuration answer each turn.

## Sessions

One WeCom conversation maps to one Harness session, so a chat keeps its context
across turns. Direct messages are keyed per chat. Group chats are keyed per
sender, so members do not share one context; `--group-shared-session` gives the
whole group a single session instead.

Turns within one conversation are serialized. The runtime's `final_response`
describes an activity interval rather than one specific prompt, so two prompts
in flight against the same session can return each other's text. Separate
conversations still run concurrently.

## Stopping a turn

Sending `/stop` (also `stop`, `cancel`, `停`, `停止`, `取消`) abandons the turn
running in that conversation. The reply is immediate: the conversation unlocks
at once and the next message is served without waiting.

The runtime is not asked to stop, because it cannot be: the SDK protocol has no
prompt-cancel, and a turn blocked inside a tool call would not observe one. The
bridge invalidates the conversation's run generation instead, so the abandoned
turn's result is discarded when it eventually arrives, and the conversation
continues in a fresh Harness session rather than one still working through
superseded instructions. The abandoned worker thread runs to completion in the
background; its side effects are not rolled back.

## Layout

| Module | Role |
|---|---|
| `adapter.py` | WeCom Smart Robot WebSocket adapter: connect, receive, send, media |
| `bridge.py` | Routes each message through a Harness session and replies |
| `base_adapter.py` | Connection lifecycle and the `handle_message` seam |
| `platform_types.py` | Normalized message types and the session key |
| `url_safety.py` | Pre-flight SSRF validation for platform-supplied URLs |
| `net.py` | HTTP client limits and redirect-time SSRF re-validation |
| `wecom_crypto.py` | WeCom AES message crypto |
| `__main__.py` | Command-line entry point |

`adapter.py`, `wecom_crypto.py`, and `url_safety.py` are ported from the Hermes
agent's WeCom platform plugin; the remaining modules replace that project's
gateway, which this package does not carry.

## Known limitations

- **A stopped turn keeps consuming tokens.** `/stop` frees the conversation
  immediately, but the abandoned turn runs to completion in the background and
  bills for it.
- **Callback mode is not ported.** Only the WebSocket Smart Robot is served;
  self-built apps using an HTTP callback endpoint are not.
- **Media reaches the model as file paths.** Inbound images and documents are
  cached locally and named in the prompt; reading them needs a composition
  whose tools can open local files.
