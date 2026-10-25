import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const workflowPath = new URL('../.github/workflows/android-current-runtime.yml', import.meta.url);
const workflow = readFileSync(workflowPath, 'utf8');
const serverLock = JSON.parse(readFileSync(new URL('../server/package-lock.json', import.meta.url), 'utf8'));

function externalRuntimeStep(source = workflow) {
  const start = source.indexOf(
    '      - name: Run normal remote UI and external handoff on one fresh emulator\n',
  );
  const finish = source.indexOf(
    '      - name: Retain bounded external-player runtime evidence\n',
    start,
  );
  assert.ok(start >= 0 && finish > start, 'Missing bounded external-player runtime step');
  return source.slice(start, finish);
}

function assertDirectFixtureLaunch(source = workflow) {
  const step = externalRuntimeStep(source);
  assert.match(
    step,
    /node --import "\$GITHUB_WORKSPACE\/public-phone-source\/server\/node_modules\/tsx\/dist\/loader\.mjs" \\\n\s+scripts\/android_external_player_server_fixture\.mts \\/,
  );
  assert.doesNotMatch(step, /tsx\/dist\/cli\.mjs scripts\/android_external_player_server_fixture\.mts/);
  assert.match(step, /fixture_pid=\$!\n\s+capture_owned_child_identity "\$fixture_pid"/);
}

function assertWorkflowLifecycleIntegration() {
  const step = externalRuntimeStep();
  for (const fragment of [
    'capture_owned_child_identity "$fixture_pid"',
    'capture_owned_child_identity "$emulator_pid"',
    'capture_owned_child_identity "$activity_monitor_pid"',
    'terminate_owned_child activity-monitor "$activity_monitor_pid"',
    'terminate_owned_child emulator "$emulator_pid" "$emulator_identity"',
    'terminate_owned_child fixture "$fixture_pid" "$fixture_identity"',
    'finish_owned_cleanup "$status"',
    'cleanupCompleted=true',
  ]) assert.match(step, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(step, /(?:pkill|killall|pgrep)/);
  assert.doesNotMatch(step, /wait "\$(?:activity_monitor|emulator|fixture)_pid"/);
  assert.match(step, /timeout --kill-after=2s 20s adb .* logcat/);
  assert.match(step, /current_parent" != "\$\$"/);
  assert.match(step, /current_fingerprint" != "\$expected_identity"/);
}

test('fixture launch uses the admitted tsx loader in the tracked server process', () => {
  assert.equal(serverLock.packages['node_modules/tsx'].version, '4.22.4');
  assert.equal(
    serverLock.packages['node_modules/tsx'].integrity,
    'sha512-X8EX+XV4QR5xCsrgxaED954zTDfY8KqlDtskKEL0cHhyS/P8b4IFOvGDQpsC9Q1XnLq915wEfwwY/zzskCtmhg==',
  );
  assertDirectFixtureLaunch();
  assert.throws(() => assertDirectFixtureLaunch(
    workflow.replace('/tsx/dist/loader.mjs"', '/tsx/dist/cli.mjs"'),
  ));
  assert.throws(() => assertDirectFixtureLaunch(workflow.replace('node --import ', 'node ')));
});

test('direct import tracks and kills the stubborn server process itself', () => {
  const result = runScenario(`
cat > "$EVIDENCE/preload.mjs" <<'PRELOAD'
// The production preload is tsx's admitted loader. This inert preload verifies Node's direct process model.
PRELOAD
cat > "$EVIDENCE/stubborn-server.mjs" <<'SERVER'
import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {});
writeFileSync(process.argv[2], String(process.pid) + '\\n');
setInterval(() => {}, 1000);
SERVER
"${process.execPath}" --import "$EVIDENCE/preload.mjs" \\
  "$EVIDENCE/stubborn-server.mjs" "$EVIDENCE/server.pid" external-fixture-direct &
pid=$!
deadline=$((SECONDS + 5))
while [ ! -s "$EVIDENCE/server.pid" ] && [ "$SECONDS" -lt "$deadline" ]; do sleep 0.05; done
test -s "$EVIDENCE/server.pid"
test "$(cat "$EVIDENCE/server.pid")" = "$pid"
capture_owned_child_identity "$pid" stubborn-server.mjs fixture identity
terminate_owned_child fixture "$pid" "$identity" 1 2 state
printf 'pidMatch=true state=%s stopped=%s\\n' "$state" "$(owned_child_stopped "$state")"
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^pidMatch=true state=exited-after-kill stopped=true\s*$/);
});

function lifecycleHelperBlock() {
  const begin = '          # BEGIN EXTERNAL_OWNED_CHILD_LIFECYCLE\n';
  const end = '          # END EXTERNAL_OWNED_CHILD_LIFECYCLE\n';
  const start = workflow.indexOf(begin);
  assert.ok(start >= 0, 'Missing external owned-child lifecycle begin marker');
  const finish = workflow.indexOf(end, start + begin.length);
  assert.ok(finish > start, 'Missing external owned-child lifecycle end marker');
  return workflow
    .slice(start + begin.length, finish)
    .split('\n')
    .map(line => line.startsWith('          ') ? line.slice(10) : line)
    .join('\n');
}

function runScenario(body, { timeout = 15_000 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'yawf-external-cleanup-'));
  try {
    const script = join(root, 'scenario.bash');
    writeFileSync(script, `set -euo pipefail\nEVIDENCE="$1"\nmkdir -p "$EVIDENCE"\n${lifecycleHelperBlock()}\n${body}\n`);
    const result = spawnSync('bash', [script, root], { encoding: 'utf8', timeout });
    return {
      ...result,
      cleanupReceipt: existsSync(join(root, 'cleanup.txt'))
        ? readFileSync(join(root, 'cleanup.txt'), 'utf8')
        : '',
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const launchNormalChild = `
bash -c 'while :; do sleep 1; done' external-cleanup-normal &
pid=$!
capture_owned_child_identity "$pid" external-cleanup-normal normal identity
terminate_owned_child normal "$pid" "$identity" 2 2 state
printf 'state=%s stopped=%s\\n' "$state" "$(owned_child_stopped "$state")"
`;

test('bounded cleanup terminates and reaps a normal owned child', () => {
  assertWorkflowLifecycleIntegration();
  const result = runScenario(launchNormalChild);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^state=exited-after-term stopped=true\s*$/);
});

test('bounded cleanup escalates a stubborn owned child to KILL', () => {
  const result = runScenario(`
python3 -c 'import signal,sys,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); open(sys.argv[1], "w").write("ready\\n"); time.sleep(30)' "$EVIDENCE/stubborn.ready" external-cleanup-stubborn &
pid=$!
deadline=$((SECONDS + 5))
while [ ! -s "$EVIDENCE/stubborn.ready" ] && [ "$SECONDS" -lt "$deadline" ]; do sleep 0.05; done
test -s "$EVIDENCE/stubborn.ready"
capture_owned_child_identity "$pid" external-cleanup-stubborn stubborn identity
terminate_owned_child stubborn "$pid" "$identity" 1 2 state
printf 'state=%s stopped=%s\\n' "$state" "$(owned_child_stopped "$state")"
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^state=exited-after-kill stopped=true\s*$/);
});

test('bounded cleanup truthfully records an already-dead owned child', () => {
  const result = runScenario(`
sleep 0.2 &
pid=$!
capture_owned_child_identity "$pid" 'sleep 0.2' dead identity
sleep 0.3
wait "$pid" || true
terminate_owned_child dead "$pid" "$identity" 1 1 state
printf 'state=%s stopped=%s\\n' "$state" "$(owned_child_stopped "$state")"
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^state=already-exited stopped=true\s*$/);
});

test('bounded cleanup does not claim stopped when TERM and KILL fail', () => {
  const result = runScenario(`
python3 -c 'import signal,sys,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); open(sys.argv[1], "w").write("ready\\n"); time.sleep(30)' "$EVIDENCE/signal-failure.ready" external-cleanup-signal-failure &
pid=$!
deadline=$((SECONDS + 5))
while [ ! -s "$EVIDENCE/signal-failure.ready" ] && [ "$SECONDS" -lt "$deadline" ]; do sleep 0.05; done
test -s "$EVIDENCE/signal-failure.ready"
capture_owned_child_identity "$pid" external-cleanup-signal-failure signal-failure identity
identity_status=0
terminate_owned_child identity-mismatch "$pid" "\${identity}-wrong" 1 1 mismatch_state || identity_status=$?
test "$identity_status" -ne 0
test "$mismatch_state" = identity-mismatch
test "$(owned_child_stopped "$mismatch_state")" = false
builtin kill -0 "$pid"
send_owned_signal() { return 1; }
termination_status=0
terminate_owned_child signal-failure "$pid" "$identity" 1 1 state || termination_status=$?
test "$termination_status" -ne 0
printf 'state=%s stopped=%s\\n' "$state" "$(owned_child_stopped "$state")"
builtin kill -KILL "$pid"
wait "$pid" 2>/dev/null || true
activity_monitor_pid=
activity_monitor_identity=
activity_monitor_state=not-started
emulator_pid=
emulator_identity=
emulator_state=not-started
fixture_pid="$pid"
fixture_identity="$identity"
fixture_state="$state"
finish_owned_cleanup 0
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^state=kill-signal-failed-still-running stopped=false\s*$/);
  assert.match(result.cleanupReceipt, /^fixtureState=kill-signal-failed-still-running$/m);
  assert.match(result.cleanupReceipt, /^fixtureStopped=false$/m);
});

test('bounded cleanup receipt preserves the original failing exit code', () => {
  const result = runScenario(`
activity_monitor_pid=101
activity_monitor_identity=captured
activity_monitor_state=already-exited
emulator_pid=202
emulator_identity=captured
emulator_state=exited-after-term
fixture_pid=303
fixture_identity=captured
fixture_state=exited-after-kill
finish_owned_cleanup 37
`);
  assert.equal(result.status, 37, result.stderr || result.stdout);
  const receipt = result.cleanupReceipt;
  assert.match(receipt, /^workflowExit=37$/m);
  assert.match(receipt, /^activityMonitorStopped=true$/m);
  assert.match(receipt, /^emulatorStopped=true$/m);
  assert.match(receipt, /^fixtureStopped=true$/m);
  assert.match(receipt, /^cleanupCompleted=true$/m);
});
