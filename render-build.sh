#!/bin/bash
# Render build script: Node deps (puppeteer downloads Chrome automatically)
set -e

echo "=== Installing Node dependencies (puppeteer downloads Chrome) ==="
npm install

echo "=== Build complete ==="
