#!/usr/bin/env bash
# SessionStart hook. Prints one tool-check line and installs dependencies if missing.
# It never fails the session and stays under a minute.
set +e
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

have() { command -v "$1" >/dev/null 2>&1; }
status=()

# rtk: the rtk-ai install script is unreachable from the cloud session (see docs/build/questions.md).
# If a session image provides rtk, wire it up.
if have rtk && rtk gain >/dev/null 2>&1; then
  timeout 10 rtk init >/dev/null 2>&1
  status+=("rtk=ok")
else
  status+=("rtk=missing")
fi

# Playwright browser: use the preinstalled Chromium when present.
if [ -d "${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" ]; then
  status+=("playwright-browser=preinstalled")
elif have pnpm && [ -d node_modules/@playwright/test ]; then
  timeout 40 pnpm exec playwright install chromium >/dev/null 2>&1 && status+=("playwright-browser=installed") || status+=("playwright-browser=missing")
else
  status+=("playwright-browser=missing")
fi

# Node dependencies.
if have pnpm && [ ! -d node_modules ]; then
  timeout 45 pnpm install --frozen-lockfile >/dev/null 2>&1 && status+=("deps=installed") || status+=("deps=missing")
fi

for t in node pnpm uv docker redis-server; do
  if have "$t"; then status+=("$t=ok"); else status+=("$t=missing"); fi
done
echo "tool check: ${status[*]}"
exit 0
