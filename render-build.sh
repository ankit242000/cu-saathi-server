#!/bin/bash
# Render build script: Node deps only (no Puppeteer/Chrome needed)
set -e
echo "=== Installing Node dependencies ==="
npm install
echo "=== Build complete ==="
