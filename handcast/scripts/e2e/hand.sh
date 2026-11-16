#!/usr/bin/env bash
# Helpers for driving IWER emulated hands from the CLI.
# usage: source scripts/e2e/hand.sh
ev() { EXPR="$1" npx @iwsdk/cli browser run scripts/e2e/eval.mjs 2>&1 | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["data"]["result"] if d.get("ok") else d)'; }
# Pinched-pose pinch point offset from the IWER right-hand transform (identity orientation).
OFF_X=0.0005; OFF_Y=-0.025; OFF_Z=-0.012
hand_to() { # x y z [yawDeg]
  local x y z
  x=$(python3 -c "print($1 - ($OFF_X))"); y=$(python3 -c "print($2 - ($OFF_Y))"); z=$(python3 -c "print($3 - ($OFF_Z))")
  local yaw=${4:-0}
  npx @iwsdk/cli xr set-transform --input-json "{\"device\":\"hand-right\",\"position\":{\"x\":$x,\"y\":$y,\"z\":$z},\"orientation\":{\"pitch\":0,\"yaw\":$yaw,\"roll\":0}}" 2>&1 | grep -q '"ok": true' || echo "set-transform failed"
}
pinch() { npx @iwsdk/cli xr set-select-value --input-json "{\"device\":\"hand-right\",\"value\":$1}" 2>&1 | grep -q '"ok": true' || echo "select failed"; }
