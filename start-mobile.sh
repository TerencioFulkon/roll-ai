#!/bin/bash
# ─────────────────────────────────────────────
# RollAI — Mobile dev server
# Starts backend + worker + frontend + localtunnel
# Usage: bash start-mobile.sh
# ─────────────────────────────────────────────

set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_PID=""
WORKER_PID=""
FRONTEND_PID=""

cleanup() {
  [[ -n "$BACKEND_PID" ]] && kill "$BACKEND_PID" 2>/dev/null || true
  [[ -n "$WORKER_PID" ]] && kill "$WORKER_PID" 2>/dev/null || true
  [[ -n "$FRONTEND_PID" ]] && kill "$FRONTEND_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT

echo ""
echo "▶  Starting RollAI backend..."
cd "$PROJECT_DIR/backend"
node server.js &
BACKEND_PID=$!

echo "▶  Starting RollAI worker (analysis pipeline)..."
node worker.js &
WORKER_PID=$!

echo "▶  Starting RollAI frontend (proxy mode)..."
cd "$PROJECT_DIR/frontend"
# Unset VITE_API_URL so relative paths + Vite proxy are used
VITE_API_URL="" npx vite --host &
FRONTEND_PID=$!

echo "▶  Waiting for frontend to start..."
sleep 5

echo "▶  Starting localtunnel on port 5173..."
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Open the URL below on your phone:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

npx localtunnel --port 5173
