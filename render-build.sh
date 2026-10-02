#!/bin/bash
# Render build script: Node deps + explicitly install Chrome for Puppeteer
set -e

echo "=== Installing Node dependencies ==="
npm install

echo "=== Installing Chrome for Puppeteer (explicit) ==="
npx puppeteer browsers install chrome

echo "=== Verifying Chrome installation ==="
ls -la /opt/render/.cache/puppeteer/ 2>/dev/null || echo "Puppeteer cache dir not found, checking alternative..."
find /opt/render -name "chrome" -type f 2>/dev/null | head -5 || true

echo "=== Build complete ==="
