#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = 'web/src/components/VideoPlayer.tsx';
const testPath = 'web/src/components/VideoPlayer.test.tsx';
const currentSourceSha256 = 'b9827d2c604947fec6522315f2d571617bdb099a1fef26d79b49354b60dcf54d';
const currentTestSha256 = '8c47d788708d73b1d06b36281a35267bf4a150dfdba1090ff18a99440cdf1e5f';
const oldCommit = '60e59b3dc62cec0f491e3789b2a0ed80f31cc43a';
const oldSourceSha256 = '19ca7081f07a523e82359e06c763534b5b6d31c48af7bf7c075f7bc9b7d73069';
const cases = [
  ...['implicit zero', 'explicit zero', 'zero local target with absolute offset', 'small positive local target', 'five-second boundary']
    .map((label) => ({ fullName: `HLS source attach pins a fresh trusted hls.js EVENT start: ${label}`, oldStatus: 'failed' })),
  ...['provider live HLS', 'lookalike server origin', 'lookalike manifest path', 'missing server capability', 'different engine',
    'resume beyond fresh window', 'negative target', 'NaN target', 'infinite target']
    .map((label) => ({ fullName: `HLS source attach leaves nonexact hls.js defaults unchanged: ${label}`, oldStatus: 'passed' })),
];
const receiptLimit = 256 * 1024, fileLimit = 2 * 1024 * 1024, processOutputLimit = 4 * 1024 * 1024;
const deadline = Date.now() + 600_000;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const check = (condition, code) => { if (!condition) throw new Error(code); };
const failureCode = (error) => error instanceof Error && /^[A-Z0-9_]{1,64}$/.test(error.message) ? error.message : 'CHECK_REFUSED';
const escapeRegex = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const remaining = (limit) => { const ms = deadline - Date.now(); check(ms > 0, 'TOTAL_DEADLINE'); return Math.min(ms, limit); };
function regular(path) {
  const info = lstatSync(path);
  check(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= fileLimit, 'FILE_BOUND');
  return readFileSync(path);
}

function runSelected(selectedCases, expectedStatus, record, directory) {
  const names = selectedCases.map((test) => test.fullName);
  const pattern = `^(?:${names.map(escapeRegex).join('|')})$`;
  const output = join(directory, 'vitest-private.json');
  try {
    const child = spawnSync(process.execPath, [join(root, 'web/node_modules/vitest/vitest.mjs'), 'run',
      'src/components/VideoPlayer.test.tsx', '--testNamePattern', pattern, '--maxWorkers=1', '--no-file-parallelism',
      '--reporter=json', `--outputFile=${output}`], {
      cwd: join(root, 'web'), env: { ...process.env, TMPDIR: directory, NO_COLOR: '1', FORCE_COLOR: '0' },
      encoding: 'utf8', timeout: remaining(45_000), killSignal: 'SIGKILL', maxBuffer: processOutputLimit,
    });
    record.exitCode = child.status; record.signal = child.signal;
    check(child.error === undefined && child.signal === null && [0, 1].includes(child.status), 'PROCESS_BOUNDS');
    check(!/Unhandled Errors|Unhandled Rejection|Uncaught Exception|FATAL ERROR|Worker exited unexpectedly/i.test(`${child.stdout ?? ''}\n${child.stderr ?? ''}`), 'WORKER_FAILURE');
    const bytes = regular(output); record.reportSha256 = sha256(bytes);
    const json = JSON.parse(bytes.toString('utf8'));
    check(Array.isArray(json.testResults) && json.testResults.length === 1, 'TEST_FILE_COUNT');
    check((json.numRuntimeErrorTestSuites ?? 0) === 0 && (json.numUnhandledErrors ?? 0) === 0 &&
      (json.unhandledErrors === undefined || (Array.isArray(json.unhandledErrors) && json.unhandledErrors.length === 0)), 'RUNTIME_ERRORS');
    const file = json.testResults[0];
    check(typeof file.name === 'string' && resolve(file.name) === join(root, testPath) && file.message === '', 'TEST_FILE_FAILURE');
    check(Array.isArray(file.assertionResults), 'ASSERTIONS_MISSING');
    const selected = file.assertionResults.filter((test) => names.includes(test.fullName));
    const executed = file.assertionResults.filter((test) => test.status === 'passed' || test.status === 'failed');
    check(selected.length === names.length && new Set(selected.map((test) => test.fullName)).size === names.length &&
      executed.length === names.length && executed.every((test) => selected.includes(test)), 'EXACT_SELECTION');
    check(selected.every((test) => Array.isArray(test.failureMessages)), 'FAILURES_MISSING');
    check(selected.every((test) => test.status === 'failed' ? test.failureMessages.length > 0 && test.failureMessages.every((message) =>
      typeof message === 'string' && /(?:^|\n)AssertionError:/.test(message) && !/Test timed out|Hook timed out|Timeout of \d+ms exceeded/i.test(message)) :
      test.status === 'passed' && test.failureMessages.length === 0), 'ASSERTION_NOT_INFRASTRUCTURE');
    const failed = selected.filter((test) => test.status === 'failed').length;
    check(json.numPassedTests === names.length - failed && json.numFailedTests === failed &&
      json.success === (failed === 0) && child.status === (failed === 0 ? 0 : 1) &&
      file.status === (failed === 0 ? 'passed' : 'failed') &&
      (failed > 0 ? json.numFailedTestSuites > 0 : json.numFailedTestSuites === 0), 'RESULT_COUNTS');
    record.passed = names.length - failed; record.failed = failed;
    record.assertions = selected.map((test) => ({ fullName: test.fullName, status: test.status,
      failureKind: test.status === 'failed' ? 'assertion' : null,
      failureSha256: test.failureMessages.length ? sha256(Buffer.from(test.failureMessages.join('\n'))) : null }));
    check(selected.every((test) => test.status === expectedStatus), 'EXPECTED_BEHAVIOR_MISMATCH');
    record.valid = true;
  } finally {
    try { unlinkSync(output); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
}

function main() {
  check(process.env.GITHUB_ACTIONS === 'true', 'CI_ONLY');
  check(process.argv.length === 2, 'NO_ARGUMENTS');
  check(process.env.RUNNER_TEMP && isAbsolute(process.env.RUNNER_TEMP), 'RUNNER_TEMP_REQUIRED');
  const runnerTemp = realpathSync(process.env.RUNNER_TEMP);
  const directory = mkdtempSync(join(runnerTemp, 'fresh-server-hls-start-'));
  const reportPath = join(runnerTemp, 'fresh-server-hls-start-regressions.json');
  const original = regular(join(root, sourcePath)), testBytes = regular(join(root, testPath));
  const report = { schemaVersion: 1, scope: 'FRESH_SERVER_HLS_START_UNIT_REVERT_CHECK_NOT_PLAYBACK_PROOF',
    currentSourceSha256: sha256(original), currentTestSha256: sha256(testBytes), oldCommit, oldSourceSha256,
    expectedCurrentPassed: 14, expectedOldFailed: 5, expectedOldPassed: 9, group: {}, cases: [], restored: false, success: false };
  const save = (first = false) => {
    const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
    check(bytes.length <= receiptLimit, 'RECEIPT_BOUND');
    writeFileSync(reportPath, bytes, { flag: first ? 'wx' : 'w', mode: 0o600 });
  };
  const assertOriginal = () => {
    check(regular(join(root, sourcePath)).equals(original), 'SOURCE_NOT_RESTORED');
    check(sha256(regular(join(root, testPath))) === currentTestSha256, 'TEST_SOURCE_CHANGED');
  };
  let mutated = false;
  save(true);
  try {
    check(sha256(original) === currentSourceSha256 && sha256(testBytes) === currentTestSha256, 'CURRENT_SOURCE_PIN');
    const readBlob = spawnSync('git', ['cat-file', 'blob', `${oldCommit}:${sourcePath}`],
      { cwd: root, timeout: remaining(5000), killSignal: 'SIGKILL', maxBuffer: fileLimit });
    check(readBlob.error === undefined && readBlob.signal === null && readBlob.status === 0, 'OLD_GIT_SOURCE_FAILED');
    const old = readBlob.stdout;
    check(Buffer.isBuffer(old) && old.length > 0 && old.length <= fileLimit && sha256(old) === oldSourceSha256, 'OLD_SOURCE_PIN');
    report.oldBlob = createHash('sha1').update(`blob ${old.length}\0`).update(old).digest('hex');
    assertOriginal();
    runSelected(cases, 'passed', report.group, directory);
    save();
    for (const testCase of cases) {
      const item = { ...testCase, current: {}, old: {}, restored: false };
      report.cases.push(item);
      try {
        assertOriginal();
        runSelected([testCase], 'passed', item.current, directory);
        assertOriginal();
        mutated = true; writeFileSync(join(root, sourcePath), old);
        check(sha256(regular(join(root, sourcePath))) === oldSourceSha256, 'REVERT_WRITE_HASH');
        runSelected([testCase], testCase.oldStatus, item.old, directory);
      } finally {
        if (mutated) writeFileSync(join(root, sourcePath), original);
        assertOriginal(); mutated = false;
        item.restored = true; item.restoredSha256 = sha256(regular(join(root, sourcePath))); save();
      }
    }
    check(report.cases.length === 14 && report.cases.every((item) => item.current.valid && item.old.valid && item.restored) &&
      report.cases.reduce((sum, item) => sum + item.old.failed, 0) === 5 &&
      report.cases.reduce((sum, item) => sum + item.old.passed, 0) === 9, 'FINAL_CASE_COUNTS');
    report.success = true;
  } catch (error) {
    report.failureCode = failureCode(error); throw error;
  } finally {
    try {
      if (mutated) writeFileSync(join(root, sourcePath), original);
      assertOriginal(); report.restored = true;
      report.finalSourceSha256 = sha256(regular(join(root, sourcePath)));
      report.finalTestSha256 = sha256(regular(join(root, testPath)));
    } catch (error) {
      report.success = false; report.restored = false;
      report.failureCode = failureCode(error); throw error;
    } finally { save(); }
  }
  console.log('Fresh server HLS start unit revert checks passed; bounded receipt saved.');
}

try { main(); }
catch (error) { console.error(failureCode(error)); process.exitCode = 1; }
