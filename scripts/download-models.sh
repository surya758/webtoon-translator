#!/usr/bin/env bash
# Fetches the two model files (~385 MB) into py/models/.
set -euo pipefail
cd "$(dirname "$0")/../py/models"
curl -L --progress-bar -o detector.onnx \
  https://huggingface.co/ogkalu/comic-text-and-bubble-detector/resolve/main/detector.onnx
curl -L --progress-bar -o anime-manga-big-lama.pt \
  https://github.com/Sanster/models/releases/download/AnimeMangaInpainting/anime-manga-big-lama.pt
echo "065744e91c0594ad8663aa8b870ce3fb27222942eded5a3cc388ce23421bd195  detector.onnx" | shasum -a 256 -c -
echo "done → $(pwd)"
