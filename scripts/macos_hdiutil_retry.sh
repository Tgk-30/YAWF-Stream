#!/bin/bash
# Retry only the documented transient from `hdiutil create`. This file is
# installed as `hdiutil` ahead of PATH for the macOS Tauri packaging step.
set -u

readonly HDIUTIL_REAL=/usr/bin/hdiutil
readonly MAX_ATTEMPTS=5

# Every command other than the exact `create` verb is a transparent one-shot
# delegation, including an invocation with no arguments.
if [ "${1-}" != "create" ]; then
  exec "$HDIUTIL_REAL" "$@"
fi

receipt=${HDIUTIL_RETRY_RECEIPT-}

receipt_error() {
  printf '%s\n' 'hdiutil retry shim: receipt must be a new direct child of owned RUNNER_TEMP' >&2
  exit 2
}

# A receipt is optional. If requested, constrain it to one new regular file
# directly inside the runner-owned temporary directory. This keeps the receipt
# finite and prevents a caller-controlled path from being opened or truncated.
if [ -n "$receipt" ]; then
  runner_temp=${RUNNER_TEMP-}
  case "$runner_temp" in
    /*) ;;
    *) receipt_error ;;
  esac
  [ -d "$runner_temp" ] || receipt_error
  [ -O "$runner_temp" ] || receipt_error

  runner_temp_real=$(cd -P -- "$runner_temp" 2>/dev/null && pwd -P) || receipt_error
  receipt_parent=${receipt%/*}
  receipt_name=${receipt##*/}
  [ "$receipt_parent" != "$receipt" ] || receipt_error
  case "$receipt_name" in
    '' | '.' | '..' | *[!A-Za-z0-9._-]*) receipt_error ;;
  esac
  [ -d "$receipt_parent" ] || receipt_error
  [ -O "$receipt_parent" ] || receipt_error
  receipt_parent_real=$(cd -P -- "$receipt_parent" 2>/dev/null && pwd -P) || receipt_error
  [ "$receipt_parent_real" = "$runner_temp_real" ] || receipt_error
  if [ -e "$receipt" ] || [ -L "$receipt" ]; then
    receipt_error
  fi
  if ! (umask 077; set -C; : > "$receipt") 2>/dev/null; then
    receipt_error
  fi
  if ! /bin/chmod 600 "$receipt" || [ ! -f "$receipt" ] || [ -L "$receipt" ] || [ ! -O "$receipt" ]; then
    /bin/rm -f -- "$receipt"
    receipt_error
  fi
fi

temp_base=${TMPDIR:-/tmp}
if [ ! -d "$temp_base" ]; then
  temp_base=/tmp
fi
work_dir=$(/usr/bin/mktemp -d "$temp_base/yawf-hdiutil-retry.XXXXXX") || exit 70
stdout_file=$work_dir/stdout
stderr_file=$work_dir/stderr
if ! /bin/chmod 700 "$work_dir" || ! : > "$stdout_file" || ! : > "$stderr_file"; then
  /bin/rm -f -- "$stdout_file" "$stderr_file"
  /bin/rmdir -- "$work_dir" 2>/dev/null || :
  exit 70
fi

cleanup() {
  # These are the only disposable paths this process creates.
  /bin/rm -f -- "$stdout_file" "$stderr_file"
  /bin/rmdir -- "$work_dir" 2>/dev/null || :
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

write_receipt() {
  [ -n "$receipt" ] || return 0
  if ! printf '{"attempt":%s,"duration_seconds":%s,"status":%s,"resource_busy":%s,"outcome":"%s"}\n' \
    "$attempt" "$duration_seconds" "$status" "$resource_busy" "$outcome" >> "$receipt"; then
    printf '%s\n' 'hdiutil retry shim: could not write receipt' >&2
    exit 74
  fi
}

attempt=1
while :; do
  : > "$stdout_file" || exit 70
  : > "$stderr_file" || exit 70
  started=$(/bin/date +%s) || exit 70
  "$HDIUTIL_REAL" "$@" > "$stdout_file" 2> "$stderr_file"
  status=$?
  finished=$(/bin/date +%s) || exit 70
  duration_seconds=$((finished - started))
  if [ "$duration_seconds" -lt 0 ]; then
    duration_seconds=0
  fi

  # Replay the original byte streams after the real process has closed both
  # regular files. Tauri otherwise captures the whole bundle script output.
  /bin/cat -- "$stdout_file" || exit 74
  /bin/cat -- "$stderr_file" >&2 || exit 74

  resource_busy=false
  # TEST_MUTATION_BROADEN_PREDICATE
  if LC_ALL=C /usr/bin/grep -a -F -x -q -- 'hdiutil: create failed - Resource busy' "$stderr_file"; then
    resource_busy=true
  fi

  retryable=0
  if [ "$status" -ne 0 ] && [ "$resource_busy" = true ]; then
    # TEST_MUTATION_REMOVE_RETRY
    retryable=1
  fi

  if [ "$status" -eq 0 ]; then
    outcome=success
  elif [ "$retryable" -eq 0 ]; then
    outcome=failure
  elif [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
    outcome=exhausted
  else
    outcome=retry
  fi
  write_receipt

  if [ "$status" -eq 0 ] || [ "$retryable" -eq 0 ]; then
    exit "$status"
  fi

  # TEST_MUTATION_REMOVE_BOUND
  if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
    exit "$status"
  fi

  # A short fixed delay is sufficient because the failed real invocation has
  # already spent time waiting on diskimages-helper. The total delay is finite.
  /bin/sleep 1
  attempt=$((attempt + 1))
done
