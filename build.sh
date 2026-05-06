#!/usr/bin/env bash
# Concatenate src/header.js + src/panel.js → custom_components/zha_debug_capture/www/panel.js
# No npm, no bundler, no transpilation. Pure ES2020+.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="${ROOT}/src"
OUT_DIR="${ROOT}/custom_components/zha_debug_capture/www"
OUT="${OUT_DIR}/panel.js"

mkdir -p "${OUT_DIR}"

{
  cat "${SRC}/header.js"
  echo ""
  cat "${SRC}/panel.js"
} > "${OUT}"

echo "Built: ${OUT} ($(wc -c < "${OUT}") bytes)"
