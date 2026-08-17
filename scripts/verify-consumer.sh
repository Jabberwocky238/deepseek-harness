#!/usr/bin/env bash
# Install the packed tarball into a scratch project and boot it, so a broken
# exports path or a missing runtime dependency fails here rather than for a user.
set -euo pipefail

tarball="$(ls "$1"/jabberwocky238-cordis-*.tgz)"
work="$(mktemp -d)"
cd "$work"

echo '{"name":"consume","type":"module","private":true}' > package.json

cat > cordis.yml <<'EOF'
- id: logger
  name: '@jabberwocky238/cordis/logger-console'
- id: timer
  name: '@jabberwocky238/cordis/timer'
- id: hello
  name: './hello.ts'
EOF

cat > hello.ts <<'EOF'
import type { Context } from '@jabberwocky238/cordis'

export const name = 'hello'

export function apply(ctx: Context) {
  ctx.effect(() => {
    const handle = setInterval(() => ctx.logger('hello').info('tick'), 500)
    return () => clearInterval(handle)
  })
}
EOF

cat > main.ts <<'EOF'
import { start } from '@jabberwocky238/cordis'

await start({ config: './cordis.yml' })
EOF

npm install --silent "$tarball" tsx
timeout 8 npx tsx main.ts > out.log 2>&1 || true

if ! grep -q 'hello tick' out.log; then
  echo "consumer failed to boot:" >&2
  cat out.log >&2
  exit 1
fi
echo "consumer booted against $(basename "$tarball")"
