#!/bin/sh
# Starts the Chrome DevTools MCP server with its extension tools (install,
# reload and trigger the toolbar action of an unpacked extension), as Chrome's
# "Build with AI" docs suggest. Used by .mcp.json.
#
# On your computer it connects to the Chrome you are running: turn on remote
# debugging at chrome://inspect/#remote-debugging first (Chrome 144+).
# In a Claude Code cloud session there is no Chrome of yours to connect to, so
# it starts the preinstalled Chromium headless instead. The container runs as
# root, where Chrome only starts without its sandbox.
chromium=$(ls -d /opt/pw-browsers/chromium-*/chrome-linux*/chrome 2>/dev/null | head -n 1)
if [ -n "$chromium" ]; then
  exec npx -y chrome-devtools-mcp@latest --categoryExtensions --headless --isolated \
    --executablePath "$chromium" --chromeArg=--no-sandbox
fi
exec npx -y chrome-devtools-mcp@latest --categoryExtensions --autoConnect
