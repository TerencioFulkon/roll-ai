#!/bin/bash
# ─────────────────────────────────────────────────────────────
# RollAI — Mobile Dev Server
# Double-click this file in Finder to start everything.
# ─────────────────────────────────────────────────────────────

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_PID=""
WORKER_PID=""
FRONTEND_PID=""

cleanup() {
  echo ''
  echo 'Shutting down...'
  [[ -n "$BACKEND_PID" ]] && kill "$BACKEND_PID" 2>/dev/null || true
  [[ -n "$WORKER_PID" ]] && kill "$WORKER_PID" 2>/dev/null || true
  [[ -n "$FRONTEND_PID" ]] && kill "$FRONTEND_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  RollAI — Mobile Dev Server"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Kill anything already on ports 3001 and 5173 ──────────────
echo "▶  Clearing ports 3001 and 5173..."
lsof -ti :3001 | xargs kill -9 2>/dev/null && echo "   Killed process on 3001" || echo "   Port 3001 was free"
lsof -ti :5173 | xargs kill -9 2>/dev/null && echo "   Killed process on 5173" || echo "   Port 5173 was free"
sleep 1

# ── Start backend ─────────────────────────────────────────────
echo ""
echo "▶  Starting backend (port 3001)..."
cd "$PROJECT_DIR/backend"
node server.js &
BACKEND_PID=$!
sleep 2

# ── Start worker (analysis pipeline) ─────────────────────────
echo "▶  Starting worker (analysis pipeline)..."
node worker.js &
WORKER_PID=$!

# ── Start frontend ────────────────────────────────────────────
echo "▶  Starting frontend (port 5173)..."
cd "$PROJECT_DIR/frontend"
npm run dev &
FRONTEND_PID=$!

echo "▶  Waiting for Vite to be ready..."
sleep 6

# ── Print local network URL ───────────────────────────────────
LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "unknown")

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Open this on your phone (same WiFi as your Mac):"
echo ""
echo "  http://$LOCAL_IP:5173"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Press Ctrl+C to stop all servers."
echo ""

# Keep script alive
wait
