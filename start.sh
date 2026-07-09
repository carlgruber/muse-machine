#!/bin/bash
# Starts Muse Machine: the web app (http://localhost:8778) and, if a
# cert is available, the HTTPS MCP bridge for Claude Desktop's Connectors
# (https://localhost:8790/mcp). Ctrl+C stops everything cleanly.
#
# Note: this does NOT start the stdio MCP server for Claude Code — that
# one is spawned automatically by Claude Code itself via ~/.mcp.json.

set -u
cd "$(dirname "${BASH_SOURCE[0]}")"

APP_PORT=8778
MCP_PORT=8790
PIDS=()

cleanup() {
  echo ""
  echo "Stopping…"
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null
  done
  exit 0
}
trap cleanup INT TERM

port_in_use() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

if port_in_use "$APP_PORT"; then
  echo "✓ App already running at http://localhost:$APP_PORT"
else
  python3 -m http.server "$APP_PORT" --directory . >/tmp/muse-app.log 2>&1 &
  PIDS+=($!)
  sleep 0.3
  if port_in_use "$APP_PORT"; then
    echo "✓ App started at http://localhost:$APP_PORT"
  else
    echo "✗ App failed to start — check /tmp/muse-app.log"
  fi
fi

TTS_PORT=8793
if port_in_use "$TTS_PORT"; then
  echo "✓ Neural TTS daemon already running on :$TTS_PORT"
elif [ -x mcp/tts-venv/bin/python3 ] && [ -f mcp/models/kokoro-v1.0.onnx ]; then
  ./mcp/tts-venv/bin/python3 mcp/tts_daemon.py >/tmp/muse-tts.log 2>&1 &
  PIDS+=($!)
  echo "… Neural TTS daemon starting on :$TTS_PORT (model loads in ~10s)"
else
  echo "… skipping neural TTS (no venv/model — see mcp/tts_daemon.py)"
fi

if port_in_use "$MCP_PORT"; then
  echo "✓ Claude Desktop bridge already running at https://localhost:$MCP_PORT/mcp"
elif [ -f mcp/certs/localhost-cert.pem ] && [ -f mcp/certs/localhost-key.pem ]; then
  node mcp/server-http.js >/tmp/muse-mcp.log 2>&1 &
  PIDS+=($!)
  sleep 0.5
  if port_in_use "$MCP_PORT"; then
    echo "✓ Claude Desktop bridge started at https://localhost:$MCP_PORT/mcp"
  else
    echo "✗ Bridge failed to start — check /tmp/muse-mcp.log"
  fi
else
  echo "… skipping Claude Desktop bridge (no cert yet — see README.md's mkcert setup)"
fi

echo ""
echo "Open http://localhost:$APP_PORT in your browser and click the page once to unlock audio."
echo "Press Ctrl+C to stop."
wait
