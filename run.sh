#!/usr/bin/env bash
# 定时任务入口：跑一轮 Apply，只把需要通知的报告块打印到 stdout，其余日志写到 LAST_LOG。
set -o pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
[ -f "$DIR/local.env" ] && . "$DIR/local.env"

export NO_PROXY="127.0.0.1,localhost"
export no_proxy="127.0.0.1,localhost"
LOCK_FILE="${OCI_APPLY_LOCK_FILE:-/tmp/oracle-instance-apply.lock}"
LAST_LOG="${OCI_APPLY_LAST_LOG:-/tmp/oracle-instance-apply.last.log}"
LOCK_WAIT="${OCI_APPLY_LOCK_WAIT:-600}"

exec 9>"$LOCK_FILE"
if ! flock -w "$LOCK_WAIT" 9; then
  exit 0
fi

LOG="$(mktemp /tmp/oracle-instance-apply.XXXXXX.log)"
cd "$DIR"
node oci-apply-stack.js >"$LOG" 2>&1
STATUS=$?
cp "$LOG" "$LAST_LOG" 2>/dev/null || true

if grep -q "OCI_FREE_REPORT_BEGIN" "$LOG"; then
  awk '/OCI_FREE_REPORT_BEGIN/{capture=1; next} /OCI_FREE_REPORT_END/{capture=0} capture' "$LOG"
elif [ "$STATUS" -ne 0 ]; then
  echo "oracle-instance-apply: failed"
  tail -8 "$LOG"
fi

rm -f "$LOG"
exit "$STATUS"
