#!/usr/bin/env bash
# The spike's fixed comparison set (three.js world coords, 10:30, clear, waves frozen at t = 5):
#   A chase cam · B toward the sun · C over the shallows · D alongside the hull · E the reef pass
# usage: tools/dev/compare-all.sh [A B …]   (dev server on :5173, Unity player built)
set -e
cd "$(dirname "$0")/../.."
declare -A CAM=(
  [A]=""
  [B]="-20,12,20,5,0,-5"
  [C]="80,25,150,95,0,115"
  [D]="9,3.2,15,-0.7,0.5,4"
  [E]="250,15,170,360,0,260"
)
views=("$@"); [ ${#views[@]} -eq 0 ] && views=(A B C D E)
for v in "${views[@]}"; do
  c=${CAM[$v]}
  q="?weather=clear&time=10:30&pause&t=5${c:+&cam=$c}"
  node tools/dev/shot-three.mjs "$v" "$q" >/dev/null
  timeout 120 tools/unity.sh shot "$v" -t 5 -frames 90 ${c:+-cam $c} >/dev/null 2>&1 || true
  tools/dev/compare.sh "$v"
done
