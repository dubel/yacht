#!/usr/bin/env bash
# Unity spike loop, run from the repo root:
#   tools/unity.sh setup            import the exported data, build the scene (SpikeSetup.All)
#   tools/unity.sh build            Linux player → unity-spike/Build/spike.x86_64
#   tools/unity.sh shot NAME [args] run the player: -cam x,y,z,tx,ty,tz -t 5 … → .shots/NAME-unity.png (+ .json)
#   tools/unity.sh run [args]       play it (W/S speed, A/D helm, drag to orbit, wheel to zoom)
set -euo pipefail
cd "$(dirname "$0")/.."
UNITY=${UNITY:-$(ls -d ~/Unity/Hub/Editor/*/Editor/Unity | sort -V | tail -1)}
PROJ=unity-spike
LOG=$PROJ/Logs/batch.log
batch() {
  "$UNITY" -batchmode -quit -projectPath "$PROJ" -logFile "$LOG" "$@" >/dev/null 2>&1 || true
  grep -E "error CS|\[spike\]|Shader error|Exception|error:" "$LOG" | grep -v "^UnityEngine" | head -40
  grep -q "Exiting batchmode successfully" "$LOG" || { echo "unity: failed (see $LOG)"; tail -30 "$LOG"; exit 1; }
}
case "${1:-}" in
  setup) batch -executeMethod SpikeSetup.All ;;
  build) batch -executeMethod SpikeSetup.Build ;;
  shot)
    name=$2; shift 2
    mkdir -p .shots
    "$PROJ/Build/spike.x86_64" -screen-width 1280 -screen-height 720 -screen-fullscreen 0 -logFile "$PWD/$PROJ/Logs/player.log" \
      -shot "$PWD/.shots/$name-unity.png" -state "$PWD/.shots/$name-unity.json" "$@"
    grep -E "\[spike\]|Exception|error" "$PROJ/Logs/player.log" | head -20 || true
    cat ".shots/$name-unity.json" 2>/dev/null; echo ;;
  run) shift; exec "$PROJ/Build/spike.x86_64" -screen-width 1600 -screen-height 900 -screen-fullscreen 0 "$@" ;;
  *) sed -n 2,7p "$0"; exit 1 ;;
esac
