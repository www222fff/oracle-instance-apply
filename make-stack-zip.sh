#!/usr/bin/env bash
# 把 Terraform 目录打成 Resource Manager 能用的 zip（main.tf 在 zip 根目录）。
# 用法：./make-stack-zip.sh [terraform 目录，默认 local/ 存在就用 local/，否则 terraform/] [输出 zip，默认 dist/stack.zip]
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="${1:-}"
if [ -z "$SRC" ]; then
  if [ -f "$DIR/local/main.tf" ]; then SRC="$DIR/local"; else SRC="$DIR/terraform"; fi
fi
OUT="${2:-$DIR/dist/stack.zip}"

mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
(cd "$SRC" && zip -q -r "$OUT" . -i '*.tf')
unzip -l "$OUT"
