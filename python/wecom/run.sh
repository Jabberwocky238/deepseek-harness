#!/usr/bin/env bash
# One-shot install and launch for the WeCom bot.
#
# Idempotent: each step is skipped when its product already exists. Pass
# --rebuild to force the runtime build, --qr to obtain bot credentials
# instead of serving. Remaining arguments reach `python -m dsh_wecom`.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
venv="$here/.venv"
runtime_dir="$repo/python/sdk-runtime/src/deepseek_harness_runtime/runtime"

rebuild=0
args=()
for arg in "$@"; do
  case "$arg" in
    --rebuild) rebuild=1 ;;
    *) args+=("$arg") ;;
  esac
done

command -v uv >/dev/null || {
  echo "uv is required: https://docs.astral.sh/uv/getting-started/installation/" >&2
  exit 1
}

# ── venv and Python packages ──
[ -d "$venv" ] || { echo "==> creating venv"; uv venv "$venv"; }

if ! "$venv/bin/python" -c "import dsh_wecom" 2>/dev/null; then
  echo "==> installing dsh_wecom"
  uv pip install --python "$venv" -e "$here"
fi

# The SDK spawns this runtime; its carrier is a build product, not checked in.
if ! "$venv/bin/python" -c "import deepseek_harness_runtime" 2>/dev/null; then
  echo "==> installing deepseek-harness-runtime-bin"
  uv pip install --python "$venv" -e "$repo/python/sdk-runtime"
fi

# ── runtime executable ──
if [ "$rebuild" = 1 ] || ! compgen -G "$runtime_dir/dsh-jsonrpc-agent-pkg-*" >/dev/null; then
  echo "==> building runtime (several minutes; downloads pkg and a Node binary)"
  (cd "$repo" && pnpm exec tsx scripts/build-exe-for-python-sdk.ts --skip-build)
fi

# ── credentials ──
# The entry point reads os.getenv only, so the repo-root .env must be sourced.
if [ -f "$repo/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$repo/.env"
  set +a
fi

case " ${args[*]-} " in
  *" --qr "*) exec "$venv/bin/python" -m dsh_wecom "${args[@]}" ;;
esac

for var in WECOM_BOT_ID WECOM_SECRET DEEPSEEK_API_KEY; do
  [ -n "${!var:-}" ] || {
    echo "$var is not set. Put it in $repo/.env, or run '$0 --qr' for WeCom credentials." >&2
    exit 1
  }
done

# Without --cwd the agent would work inside this package directory.
case " ${args[*]-} " in
  *" --cwd "*) ;;
  *) args+=(--cwd "$repo") ;;
esac

echo "==> starting WeCom bot (Ctrl-C to stop)"
exec "$venv/bin/python" -m dsh_wecom "${args[@]}"
