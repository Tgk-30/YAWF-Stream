#!/bin/bash
# Deterministic regression and mutation checks for macos_hdiutil_retry.sh.
# The production shim has no command override. Tests patch its one hardcoded
# /usr/bin/hdiutil path only in disposable copies.
set -u

script_dir=$(cd -P -- "$(dirname -- "$0")" && pwd -P) || exit 1
shim=$script_dir/macos_hdiutil_retry.sh

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

pass() {
  printf 'PASS: %s\n' "$1"
}

assert_eq() {
  expected=$1
  actual=$2
  label=$3
  if [ "$actual" != "$expected" ]; then
    fail "$label: expected [$expected], got [$actual]"
  fi
}

assert_file_eq() {
  expected_file=$1
  actual_file=$2
  label=$3
  if ! /usr/bin/cmp -s "$expected_file" "$actual_file"; then
    fail "$label: byte streams differ"
  fi
}

[ -f "$shim" ] || fail "missing production shim"
[ -x "$shim" ] || fail "production shim is not executable"

real_path_count=$(LC_ALL=C /usr/bin/grep -o -F '/usr/bin/hdiutil' "$shim" | /usr/bin/wc -l | /usr/bin/tr -d ' ')
assert_eq 1 "$real_path_count" "single hardcoded real command"

sandbox=$(/usr/bin/mktemp -d /tmp/yawf-hdiutil-retry-test.XXXXXX) || exit 1

cleanup_test() {
  # The test owns the whole unique mktemp directory.
  /bin/rm -rf -- "$sandbox"
}
trap cleanup_test EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

fake_template=$sandbox/fake-hdiutil-template
cat > "$fake_template" <<'FAKE'
#!/bin/bash
set -u

: "${FAKE_STATE:?FAKE_STATE is required}"
: "${FAKE_MODE:?FAKE_MODE is required}"

count=0
if [ -f "$FAKE_STATE/count" ]; then
  IFS= read -r count < "$FAKE_STATE/count" || exit 96
fi
count=$((count + 1))
printf '%s\n' "$count" > "$FAKE_STATE/count" || exit 96

argv_file=$FAKE_STATE/argv.$count
: > "$argv_file" || exit 96
for arg in "$@"; do
  printf '%s\000' "$arg" >> "$argv_file" || exit 96
done

limit=${FAKE_INVOCATION_LIMIT-20}
if [ "$count" -gt "$limit" ]; then
  printf '%s\n' 'fake invocation fence exceeded' > "$FAKE_STATE/invocation-fence"
  printf '%s\n' 'fake hdiutil: invocation fence exceeded' >&2
  exit 98
fi

case "$FAKE_MODE" in
  immediate_success)
    printf 'stdout:\000alpha\377omega\n'
    printf 'stderr:\000beta\376omega\n' >&2
    exit 0
    ;;
  noncreate_success)
    printf '%s\n' 'noncreate stdout'
    printf '%s\n' 'noncreate stderr' >&2
    exit 0
    ;;
  noncreate_failure)
    printf '%s\n' 'noncreate failed' >&2
    exit 23
    ;;
  busy_then_fifth_success)
    if [ "$count" -lt 5 ]; then
      printf 'attempt-%s-out\n' "$count"
      printf 'diagnostic before %s\n' "$count" >&2
      printf '%s\n' 'hdiutil: create failed - Resource busy' >&2
      printf 'diagnostic after %s\n' "$count" >&2
      exit 73
    fi
    printf '%s\n' 'attempt-5-success'
    printf '%s\n' 'attempt-5-final-diagnostic' >&2
    exit 0
    ;;
  busy_exhaustion)
    printf 'exhaust-attempt-%s-out\n' "$count"
    printf 'exhaust diagnostic %s\n' "$count" >&2
    printf '%s\n' 'hdiutil: create failed - Resource busy' >&2
    exit 79
    ;;
  zero_exit_busy)
    printf '%s\n' 'zero-exit stdout'
    printf '%s\n' 'hdiutil: create failed - Resource busy' >&2
    exit 0
    ;;
  unrelated_failure)
    printf '%s\n' 'unrelated stdout'
    printf '%s\n' 'prefix hdiutil: create failed - Resource busy suffix' >&2
    exit 47
    ;;
  *)
    printf '%s\n' 'fake hdiutil: unknown mode' >&2
    exit 97
    ;;
esac
FAKE
/bin/chmod 700 "$fake_template" || exit 1

CASE_DIR=
CASE_STATE=
CASE_RUNNER_TEMP=
CASE_TMPDIR=
CASE_FAKE=
CASE_SHIM=
LAST_STATUS=0
LAST_TIMED_OUT=0
LAST_STDOUT=
LAST_STDERR=

prepare_case() {
  case_name=$1
  CASE_DIR=$sandbox/$case_name
  CASE_STATE=$CASE_DIR/state
  CASE_RUNNER_TEMP=$CASE_DIR/runner-temp
  CASE_TMPDIR=$CASE_DIR/process-temp
  CASE_FAKE=$CASE_DIR/fake-hdiutil
  CASE_SHIM=$CASE_DIR/hdiutil
  /bin/mkdir -p "$CASE_STATE" "$CASE_RUNNER_TEMP" "$CASE_TMPDIR" || exit 1
  /bin/cp "$fake_template" "$CASE_FAKE" || exit 1

  # sandbox is rooted at /tmp with a controlled basename, so this replacement
  # cannot contain sed replacement metacharacters.
  case "$CASE_FAKE" in
    *'&'* | *'|'*) fail "unexpected test path metacharacter" ;;
  esac
  LC_ALL=C /usr/bin/sed "s|/usr/bin/hdiutil|$CASE_FAKE|" "$shim" > "$CASE_SHIM" || exit 1
  /bin/chmod 700 "$CASE_FAKE" "$CASE_SHIM" || exit 1

  patched_real_count=$(LC_ALL=C /usr/bin/grep -o -F "$CASE_FAKE" "$CASE_SHIM" | /usr/bin/wc -l | /usr/bin/tr -d ' ')
  assert_eq 1 "$patched_real_count" "test copy command replacement"
  if LC_ALL=C /usr/bin/grep -q -F '/usr/bin/hdiutil' "$CASE_SHIM"; then
    fail "test copy retained production hdiutil path"
  fi
}

run_with_watchdog() {
  timeout_seconds=$1
  stdout_path=$2
  stderr_path=$3
  shift 3
  timeout_marker=$CASE_DIR/watchdog-timeout
  done_marker=$CASE_DIR/watchdog-done
  /bin/rm -f -- "$timeout_marker" "$done_marker"

  "$@" > "$stdout_path" 2> "$stderr_path" &
  command_pid=$!
  (
    watchdog_tick=0
    watchdog_limit=$((timeout_seconds * 10))
    while [ "$watchdog_tick" -lt "$watchdog_limit" ]; do
      [ ! -f "$done_marker" ] || exit 0
      /bin/sleep 0.1
      watchdog_tick=$((watchdog_tick + 1))
    done
    if /bin/kill -0 "$command_pid" 2>/dev/null; then
      printf '%s\n' timeout > "$timeout_marker"
      /bin/kill -TERM "$command_pid" 2>/dev/null || :
      /bin/sleep 1
      /bin/kill -KILL "$command_pid" 2>/dev/null || :
    fi
  ) &
  watchdog_pid=$!

  wait "$command_pid"
  LAST_STATUS=$?
  : > "$done_marker"
  wait "$watchdog_pid" 2>/dev/null || :

  LAST_TIMED_OUT=0
  if [ -f "$timeout_marker" ]; then
    LAST_TIMED_OUT=1
  fi
}

invoke() {
  mode=$1
  receipt=$2
  limit=$3
  executable=$4
  label=$5
  shift 5
  LAST_STDOUT=$CASE_DIR/$label.stdout
  LAST_STDERR=$CASE_DIR/$label.stderr
  run_with_watchdog 12 "$LAST_STDOUT" "$LAST_STDERR" \
    /usr/bin/env \
      "FAKE_STATE=$CASE_STATE" \
      "FAKE_MODE=$mode" \
      "FAKE_INVOCATION_LIMIT=$limit" \
      "RUNNER_TEMP=$CASE_RUNNER_TEMP" \
      "TMPDIR=$CASE_TMPDIR" \
      "HDIUTIL_RETRY_RECEIPT=$receipt" \
      /bin/bash "$executable" "$@"
  assert_eq 0 "$LAST_TIMED_OUT" "$label watchdog"
}

read_count() {
  if [ -f "$CASE_STATE/count" ]; then
    IFS= read -r invocation_count < "$CASE_STATE/count" || exit 1
  else
    invocation_count=0
  fi
  printf '%s\n' "$invocation_count"
}

write_expected_argv() {
  output_path=$1
  shift
  : > "$output_path" || exit 1
  for expected_arg in "$@"; do
    printf '%s\000' "$expected_arg" >> "$output_path" || exit 1
  done
}

normalize_receipt() {
  input_path=$1
  output_path=$2
  LC_ALL=C /usr/bin/sed -E 's/"duration_seconds":[0-9]+/"duration_seconds":N/' \
    "$input_path" > "$output_path" || exit 1
}

validate_receipt() {
  receipt_path=$1
  expected_lines=$2
  [ -f "$receipt_path" ] || fail "receipt is not a regular file"
  [ ! -L "$receipt_path" ] || fail "receipt is a symlink"
  [ -O "$receipt_path" ] || fail "receipt is not owned by the current user"
  receipt_lines=$(/usr/bin/wc -l < "$receipt_path" | /usr/bin/tr -d ' ')
  assert_eq "$expected_lines" "$receipt_lines" "receipt line count"
  receipt_bytes=$(/usr/bin/wc -c < "$receipt_path" | /usr/bin/tr -d ' ')
  if [ "$receipt_bytes" -gt 1024 ]; then
    fail "receipt exceeded finite size bound"
  fi
  if ! LC_ALL=C /usr/bin/awk '
    BEGIN { valid = 1 }
    $0 !~ /^\{"attempt":[1-9][0-9]*,"duration_seconds":[0-9]+,"status":[0-9]+,"resource_busy":(true|false),"outcome":"(success|failure|retry|exhausted)"\}$/ { valid = 0 }
    END { exit valid ? 0 : 1 }
  ' "$receipt_path"; then
    fail "receipt JSONL schema"
  fi
}

assert_only_decoy_remains() {
  decoy_path=$1
  [ -f "$decoy_path/sentinel" ] || fail "wrapper removed unrelated temp content"
  for candidate in "$CASE_TMPDIR"/yawf-hdiutil-retry.*; do
    if [ ! -e "$candidate" ] && [ ! -L "$candidate" ]; then
      continue
    fi
    if [ "$candidate" != "$decoy_path" ]; then
      fail "wrapper leaked private temporary directory"
    fi
  done
}

# Exact create argv and binary stream replay. This also proves the receipt is
# metadata-only and cleanup leaves a similarly named unrelated directory alone.
prepare_case immediate-create
decoy=$CASE_TMPDIR/yawf-hdiutil-retry.do-not-delete
/bin/mkdir "$decoy" || exit 1
printf '%s\n' keep > "$decoy/sentinel"
receipt=$CASE_RUNNER_TEMP/create.jsonl
sensitive='caller-secret-SHOULD-NOT-ENTER-RECEIPT'
invoke immediate_success "$receipt" 2 "$CASE_SHIM" immediate \
  create '--volume-name' 'Name with spaces' '' 'literal*?[x]' "$sensitive" 'output path/image.dmg'
assert_eq 0 "$LAST_STATUS" "immediate create status"
assert_eq 1 "$(read_count)" "immediate create invocation count"
write_expected_argv "$CASE_DIR/expected.argv" \
  create '--volume-name' 'Name with spaces' '' 'literal*?[x]' "$sensitive" 'output path/image.dmg'
assert_file_eq "$CASE_DIR/expected.argv" "$CASE_STATE/argv.1" "immediate create argv"
printf 'stdout:\000alpha\377omega\n' > "$CASE_DIR/expected.stdout"
printf 'stderr:\000beta\376omega\n' > "$CASE_DIR/expected.stderr"
assert_file_eq "$CASE_DIR/expected.stdout" "$LAST_STDOUT" "binary stdout replay"
assert_file_eq "$CASE_DIR/expected.stderr" "$LAST_STDERR" "binary stderr replay"
validate_receipt "$receipt" 1
normalize_receipt "$receipt" "$CASE_DIR/receipt.normalized"
printf '%s\n' '{"attempt":1,"duration_seconds":N,"status":0,"resource_busy":false,"outcome":"success"}' > "$CASE_DIR/receipt.expected"
assert_file_eq "$CASE_DIR/receipt.expected" "$CASE_DIR/receipt.normalized" "immediate receipt"
if LC_ALL=C /usr/bin/grep -a -F -q "$sensitive" "$receipt"; then
  fail "receipt exposed a caller argument"
fi
receipt_mode=$(/usr/bin/stat -f '%Lp' "$receipt")
assert_eq 600 "$receipt_mode" "receipt permissions"
assert_only_decoy_remains "$decoy"
pass immediate_create_exact_argv_raw_bytes_and_cleanup

# Non-create verbs bypass all retry and receipt machinery and preserve status.
prepare_case noncreate-success
outside_receipt=$CASE_DIR/outside/noncreate.jsonl
invoke noncreate_success "$outside_receipt" 1 "$CASE_SHIM" noncreate-success attach 'disk image.dmg'
assert_eq 0 "$LAST_STATUS" "non-create success status"
assert_eq 1 "$(read_count)" "non-create success invocation count"
[ ! -e "$outside_receipt" ] || fail "non-create invocation wrote a receipt"
write_expected_argv "$CASE_DIR/expected.argv" attach 'disk image.dmg'
assert_file_eq "$CASE_DIR/expected.argv" "$CASE_STATE/argv.1" "non-create success argv"

prepare_case noncreate-failure
invoke noncreate_failure "$CASE_DIR/outside/noncreate.jsonl" 1 "$CASE_SHIM" noncreate-failure detach '/Volumes/Some Disk'
assert_eq 23 "$LAST_STATUS" "non-create failure status"
assert_eq 1 "$(read_count)" "non-create failure invocation count"
write_expected_argv "$CASE_DIR/expected.argv" detach '/Volumes/Some Disk'
assert_file_eq "$CASE_DIR/expected.argv" "$CASE_STATE/argv.1" "non-create failure argv"
pass noncreate_one_shot_success_and_failure

# The exact busy line remains retryable when accompanied by other diagnostics.
prepare_case busy-then-success
receipt=$CASE_RUNNER_TEMP/busy-success.jsonl
invoke busy_then_fifth_success "$receipt" 5 "$CASE_SHIM" busy-success create src --format ULFO 'final image.dmg'
assert_eq 0 "$LAST_STATUS" "fifth-attempt success status"
assert_eq 5 "$(read_count)" "fifth-attempt invocation count"
write_expected_argv "$CASE_DIR/expected.argv" create src --format ULFO 'final image.dmg'
attempt=1
while [ "$attempt" -le 5 ]; do
  assert_file_eq "$CASE_DIR/expected.argv" "$CASE_STATE/argv.$attempt" "retry argv $attempt"
  attempt=$((attempt + 1))
done
{
  attempt=1
  while [ "$attempt" -lt 5 ]; do
    printf 'attempt-%s-out\n' "$attempt"
    attempt=$((attempt + 1))
  done
  printf '%s\n' 'attempt-5-success'
} > "$CASE_DIR/expected.stdout"
{
  attempt=1
  while [ "$attempt" -lt 5 ]; do
    printf 'diagnostic before %s\n' "$attempt"
    printf '%s\n' 'hdiutil: create failed - Resource busy'
    printf 'diagnostic after %s\n' "$attempt"
    attempt=$((attempt + 1))
  done
  printf '%s\n' 'attempt-5-final-diagnostic'
} > "$CASE_DIR/expected.stderr"
assert_file_eq "$CASE_DIR/expected.stdout" "$LAST_STDOUT" "retry stdout replay"
assert_file_eq "$CASE_DIR/expected.stderr" "$LAST_STDERR" "retry stderr replay"
validate_receipt "$receipt" 5
normalize_receipt "$receipt" "$CASE_DIR/receipt.normalized"
: > "$CASE_DIR/receipt.expected"
attempt=1
while [ "$attempt" -lt 5 ]; do
  printf '{"attempt":%s,"duration_seconds":N,"status":73,"resource_busy":true,"outcome":"retry"}\n' "$attempt" >> "$CASE_DIR/receipt.expected"
  attempt=$((attempt + 1))
done
printf '%s\n' '{"attempt":5,"duration_seconds":N,"status":0,"resource_busy":false,"outcome":"success"}' >> "$CASE_DIR/receipt.expected"
assert_file_eq "$CASE_DIR/receipt.expected" "$CASE_DIR/receipt.normalized" "fifth-attempt receipt"
pass exact_busy_line_with_other_diagnostics_then_fifth_success

# The fifth failed attempt is final and its original exit status survives.
prepare_case busy-exhaustion
receipt=$CASE_RUNNER_TEMP/busy-exhausted.jsonl
invoke busy_exhaustion "$receipt" 5 "$CASE_SHIM" busy-exhausted create src 'exhausted image.dmg'
assert_eq 79 "$LAST_STATUS" "busy exhaustion status"
assert_eq 5 "$(read_count)" "busy exhaustion invocation count"
validate_receipt "$receipt" 5
normalize_receipt "$receipt" "$CASE_DIR/receipt.normalized"
: > "$CASE_DIR/receipt.expected"
attempt=1
while [ "$attempt" -lt 5 ]; do
  printf '{"attempt":%s,"duration_seconds":N,"status":79,"resource_busy":true,"outcome":"retry"}\n' "$attempt" >> "$CASE_DIR/receipt.expected"
  attempt=$((attempt + 1))
done
printf '%s\n' '{"attempt":5,"duration_seconds":N,"status":79,"resource_busy":true,"outcome":"exhausted"}' >> "$CASE_DIR/receipt.expected"
assert_file_eq "$CASE_DIR/receipt.expected" "$CASE_DIR/receipt.normalized" "busy exhaustion receipt"
busy_lines=$(LC_ALL=C /usr/bin/grep -a -F -x -c 'hdiutil: create failed - Resource busy' "$LAST_STDERR")
assert_eq 5 "$busy_lines" "busy exhaustion stderr replay count"
pass busy_exhaustion_is_bounded_and_preserves_status

# A successful command is never retried, even if it writes the busy line.
prepare_case zero-exit-busy
receipt=$CASE_RUNNER_TEMP/zero-exit.jsonl
invoke zero_exit_busy "$receipt" 1 "$CASE_SHIM" zero-exit create src zero.dmg
assert_eq 0 "$LAST_STATUS" "zero-exit busy status"
assert_eq 1 "$(read_count)" "zero-exit busy invocation count"
validate_receipt "$receipt" 1
normalize_receipt "$receipt" "$CASE_DIR/receipt.normalized"
printf '%s\n' '{"attempt":1,"duration_seconds":N,"status":0,"resource_busy":true,"outcome":"success"}' > "$CASE_DIR/receipt.expected"
assert_file_eq "$CASE_DIR/receipt.expected" "$CASE_DIR/receipt.normalized" "zero-exit busy receipt"
pass zero_exit_busy_line_is_not_retried

# A substring or superstring is not the exact transient signature.
prepare_case unrelated-failure
receipt=$CASE_RUNNER_TEMP/unrelated.jsonl
invoke unrelated_failure "$receipt" 1 "$CASE_SHIM" unrelated create src unrelated.dmg
assert_eq 47 "$LAST_STATUS" "unrelated failure status"
assert_eq 1 "$(read_count)" "unrelated failure invocation count"
validate_receipt "$receipt" 1
normalize_receipt "$receipt" "$CASE_DIR/receipt.normalized"
printf '%s\n' '{"attempt":1,"duration_seconds":N,"status":47,"resource_busy":false,"outcome":"failure"}' > "$CASE_DIR/receipt.expected"
assert_file_eq "$CASE_DIR/receipt.expected" "$CASE_DIR/receipt.normalized" "unrelated failure receipt"
pass unrelated_failure_is_not_retried

# Receipt paths fail closed before hdiutil starts. A valid new direct child is
# accepted, while outside, escaped, existing, and symlink paths are rejected.
prepare_case receipt-boundary
invalid_outside=$CASE_DIR/outside.jsonl
invoke immediate_success "$invalid_outside" 1 "$CASE_SHIM" receipt-outside create src outside.dmg
assert_eq 2 "$LAST_STATUS" "outside receipt status"
[ ! -e "$invalid_outside" ] || fail "outside receipt was created"

escaped=$CASE_RUNNER_TEMP/../escaped.jsonl
invoke immediate_success "$escaped" 1 "$CASE_SHIM" receipt-escape create src escaped.dmg
assert_eq 2 "$LAST_STATUS" "escaped receipt status"
[ ! -e "$CASE_DIR/escaped.jsonl" ] || fail "escaped receipt was created"

existing=$CASE_RUNNER_TEMP/existing.jsonl
printf '%s\n' KEEP > "$existing"
invoke immediate_success "$existing" 1 "$CASE_SHIM" receipt-existing create src existing.dmg
assert_eq 2 "$LAST_STATUS" "existing receipt status"
printf '%s\n' KEEP > "$CASE_DIR/existing.expected"
assert_file_eq "$CASE_DIR/existing.expected" "$existing" "existing receipt preservation"

symlink_target=$CASE_DIR/symlink-target
printf '%s\n' KEEP > "$symlink_target"
symlink_receipt=$CASE_RUNNER_TEMP/link.jsonl
/bin/ln -s "$symlink_target" "$symlink_receipt" || exit 1
invoke immediate_success "$symlink_receipt" 1 "$CASE_SHIM" receipt-symlink create src link.dmg
assert_eq 2 "$LAST_STATUS" "symlink receipt status"
assert_file_eq "$CASE_DIR/existing.expected" "$symlink_target" "symlink target preservation"

assert_eq 0 "$(read_count)" "invalid receipt preflight invocation count"
if LC_ALL=C /usr/bin/grep -a -F -q "$CASE_DIR" "$LAST_STDERR"; then
  fail "receipt error exposed a caller path"
fi

valid=$CASE_RUNNER_TEMP/valid.jsonl
invoke immediate_success "$valid" 1 "$CASE_SHIM" receipt-valid create src valid.dmg
assert_eq 0 "$LAST_STATUS" "valid receipt status"
assert_eq 1 "$(read_count)" "valid receipt invocation count"
validate_receipt "$valid" 1
pass receipt_boundary_fails_closed

make_mutant() {
  mutation=$1
  source_copy=$2
  mutant_path=$3
  LC_ALL=C /usr/bin/awk -v mutation="$mutation" '
    {
      if (pending == "removeRetry") {
        if ($0 != "    retryable=1") exit 90
        print "    retryable=0"
        pending = ""
        changed++
        next
      }
      if (pending == "broadenPredicate") {
        if (index($0, " /usr/bin/grep -a -F -x -q ") == 0) exit 91
        sub(/ -x -q /, " -q ")
        print
        pending = ""
        changed++
        next
      }
      if (pending == "removeBound") {
        if ($0 != "  if [ \"$attempt\" -ge \"$MAX_ATTEMPTS\" ]; then") exit 92
        print "  if false; then"
        pending = ""
        changed++
        next
      }
      print
      if (mutation == "removeRetry" && $0 ~ /TEST_MUTATION_REMOVE_RETRY/) pending = "removeRetry"
      if (mutation == "broadenPredicate" && $0 ~ /TEST_MUTATION_BROADEN_PREDICATE/) pending = "broadenPredicate"
      if (mutation == "removeBound" && $0 ~ /TEST_MUTATION_REMOVE_BOUND/) pending = "removeBound"
    }
    END {
      if (pending != "" || changed != 1) exit 93
    }
  ' "$source_copy" > "$mutant_path" || fail "could not create $mutation mutant"
  /bin/chmod 700 "$mutant_path" || exit 1
  /bin/bash -n "$mutant_path" || fail "$mutation mutant syntax"
  if /usr/bin/cmp -s "$source_copy" "$mutant_path"; then
    fail "$mutation mutant did not change the shim"
  fi
}

# Each mutant is run alone. The watchdog bounds wall time, and the fake command
# has an independent invocation fence so removal of the retry limit cannot loop.
prepare_case mutant-remove-retry
mutant=$CASE_DIR/removeRetry
make_mutant removeRetry "$CASE_SHIM" "$mutant"
invoke busy_then_fifth_success "$CASE_RUNNER_TEMP/remove-retry.jsonl" 5 "$mutant" mutant-remove-retry create src mutant.dmg
assert_eq 73 "$LAST_STATUS" "removeRetry mutant observed status"
assert_eq 1 "$(read_count)" "removeRetry mutant observed count"
printf '%s\n' 'MUTANT_KILLED: removeRetry'

prepare_case mutant-broaden-predicate
mutant=$CASE_DIR/broadenPredicate
make_mutant broadenPredicate "$CASE_SHIM" "$mutant"
invoke unrelated_failure "$CASE_RUNNER_TEMP/broaden.jsonl" 1 "$mutant" mutant-broaden create src mutant.dmg
assert_eq 98 "$LAST_STATUS" "broadenPredicate mutant fence status"
assert_eq 2 "$(read_count)" "broadenPredicate mutant invocation count"
[ -f "$CASE_STATE/invocation-fence" ] || fail "broadenPredicate mutant did not hit invocation fence"
printf '%s\n' 'MUTANT_KILLED: broadenPredicate'

prepare_case mutant-remove-bound
mutant=$CASE_DIR/removeBound
make_mutant removeBound "$CASE_SHIM" "$mutant"
invoke busy_exhaustion "$CASE_RUNNER_TEMP/remove-bound.jsonl" 5 "$mutant" mutant-remove-bound create src mutant.dmg
assert_eq 98 "$LAST_STATUS" "removeBound mutant fence status"
assert_eq 6 "$(read_count)" "removeBound mutant invocation count"
[ -f "$CASE_STATE/invocation-fence" ] || fail "removeBound mutant did not hit invocation fence"
printf '%s\n' 'MUTANT_KILLED: removeBound'

pass all_hdiutil_retry_regressions_and_mutants
