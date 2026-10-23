#!/bin/bash
# Retry only the observed CloudKit connection loss, never a ticket rejection.
set -u

readonly XCRUN_REAL=/usr/bin/xcrun
readonly MAX_ATTEMPTS=3
verb=${1-}
case "$verb" in
  staple | validate) ;;
  *) exec "$XCRUN_REAL" stapler "$@" ;;
esac

receipt=${STAPLER_RETRY_RECEIPT-}
receipt_error() {
  printf '%s\n' 'stapler retry: receipt must be a new direct child of owned RUNNER_TEMP' >&2
  exit 2
}
if [ -n "$receipt" ]; then
  runner_temp=${RUNNER_TEMP-}
  case "$runner_temp" in /*) ;; *) receipt_error ;; esac
  [ -d "$runner_temp" ] && [ -O "$runner_temp" ] || receipt_error
  runner_temp_real=$(cd -P -- "$runner_temp" 2>/dev/null && pwd -P) || receipt_error
  receipt_parent=${receipt%/*}
  receipt_name=${receipt##*/}
  [ "$receipt_parent" != "$receipt" ] || receipt_error
  case "$receipt_name" in '' | '.' | '..' | *[!A-Za-z0-9._-]*) receipt_error ;; esac
  [ -d "$receipt_parent" ] && [ -O "$receipt_parent" ] || receipt_error
  receipt_parent_real=$(cd -P -- "$receipt_parent" 2>/dev/null && pwd -P) || receipt_error
  [ "$receipt_parent_real" = "$runner_temp_real" ] || receipt_error
  if [ -e "$receipt" ] || [ -L "$receipt" ]; then receipt_error; fi
  if ! (umask 077; set -C; : > "$receipt") 2>/dev/null; then receipt_error; fi
  if ! /bin/chmod 600 "$receipt" || [ ! -f "$receipt" ] || [ -L "$receipt" ] || [ ! -O "$receipt" ]; then
    /bin/rm -f -- "$receipt"
    receipt_error
  fi
fi

temp_base=${TMPDIR:-/tmp}
[ -d "$temp_base" ] || temp_base=/tmp
work_dir=$(/usr/bin/mktemp -d "$temp_base/yawf-stapler-retry.XXXXXX") || exit 70
stdout_file=$work_dir/stdout
stderr_file=$work_dir/stderr
if ! /bin/chmod 700 "$work_dir" || ! : > "$stdout_file" || ! : > "$stderr_file"; then
  /bin/rm -f -- "$stdout_file" "$stderr_file"
  /bin/rmdir -- "$work_dir" 2>/dev/null || :
  exit 70
fi
cleanup() {
  /bin/rm -f -- "$stdout_file" "$stderr_file"
  /bin/rmdir -- "$work_dir" 2>/dev/null || :
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

attempt=1
while :; do
  : > "$stdout_file" || exit 70
  : > "$stderr_file" || exit 70
  "$XCRUN_REAL" stapler "$@" > "$stdout_file" 2> "$stderr_file"
  status=$?
  /bin/cat -- "$stdout_file" || exit 74
  /bin/cat -- "$stderr_file" >&2 || exit 74

  transient=false
  if [ "$status" -eq 68 ] \
    && LC_ALL=C /usr/bin/grep -a -F -q -- 'NSURLErrorDomain Code=-1005 "The network connection was lost."' "$stdout_file" "$stderr_file" \
    && LC_ALL=C /usr/bin/grep -a -E -q -- 'https://api\.apple-cloudkit\.com/database/1/com\.apple\.gk\.ticket-delivery/production/public/records/lookup([ ,}]|$)' "$stdout_file" "$stderr_file"; then
    transient=true
  fi
  if [ "$status" -eq 0 ]; then
    outcome=success
  elif [ "$transient" != true ]; then
    outcome=failure
  elif [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
    outcome=exhausted
  else
    outcome=retry
  fi
  if [ -n "$receipt" ]; then
    if ! printf '{"verb":"%s","attempt":%s,"status":%s,"cloudkit_connection_lost":%s,"outcome":"%s"}\n' \
      "$verb" "$attempt" "$status" "$transient" "$outcome" >> "$receipt"; then
      printf '%s\n' 'stapler retry: could not write receipt' >&2
      exit 74
    fi
  fi
  if [ "$status" -eq 0 ] || [ "$transient" != true ]; then exit "$status"; fi
  if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then exit "$status"; fi
  /bin/sleep 2
  attempt=$((attempt + 1))
done
