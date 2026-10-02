#!/bin/bash
# Render build script: Node deps + Chromium for puppeteer-core
set -e

echo "=== Installing Node dependencies ==="
npm install

echo "=== Installing Chromium ==="
apt-get update
apt-get install -y chromium

echo "=== Verifying Chromium ==="
which chromium || which chromium-browser || echo "WARNING: chromium not in PATH"

echo "=== Build complete ==="
