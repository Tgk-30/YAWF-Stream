#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = 'web/src/components/VideoPlayer.tsx';
const testPath = 'web/src/components/VideoPlayer.test.tsx';
const currentSourceSha256 = '19ca7081f07a523e82359e06c763534b5b6d31c48af7bf7c075f7bc9b7d73069';
const currentTestSha256 = '31602626182a1c9ed5ce0322a290f853e8c619c2912bf2db8c7356636377c3a9';
const oldCommit = 'd81c3ff9fe004a3bc08c64153a0de07ce618ed8b';
const oldBlob = '7e2d608a2cfd1bf2d48f78f045543dfa06beb7b4';
const oldSourceSha256 = 'e4475cfdef73d87a9eca7f0fd811ce4e40097b4e5bb379ecdf304b69ae56aa9a';
const mandatoryTitle = '[manual-snapshot] keeps the original through one segment, then hands off at the quiet current clock';
const groupCount = 14, receiptLimit = 2 * 1024 * 1024, processOutputLimit = 4 * 1024 * 1024;
const deadline = Date.now() + 600_000;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const check = (condition, code) => { if (!condition) throw new Error(code); };
const failureCode = (error) => error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'CHECK_REFUSED';
const escapeRegex = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const remaining = (limit) => { const ms = deadline - Date.now(); check(ms > 0, 'TOTAL_DEADLINE'); return Math.min(ms, limit); };
function regular(path, limit = receiptLimit) {
  const info = lstatSync(path);
  check(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= limit, 'FILE_BOUND');
  return readFileSync(path);
}
function childSucceeded(child) {
  check(child.error === undefined && child.signal === null, 'PROCESS_BOUNDS');
  check(child.status === 0, 'GIT_METADATA_FAILED');
}

function runSelected(pattern, phase, record, directory, expectedName = null) {
  const output = join(directory, 'vitest-private.json');
  try {
    const child = spawnSync(process.execPath, [join(root, 'web/node_modules/vitest/vitest.mjs'), 'run',
      'src/components/VideoPlayer.test.tsx', '--testNamePattern', pattern, '--maxWorkers=1', '--no-file-parallelism',
      '--reporter=json', `--outputFile=${output}`], {
      cwd: join(root, 'web'), env: { ...process.env, TMPDIR: directory, NO_COLOR: '1', FORCE_COLOR: '0' },
      encoding: 'utf8', timeout: remaining(40_000), killSignal: 'SIGKILL', maxBuffer: processOutputLimit,
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
    const selected = file.assertionResults.filter((test) => typeof test.fullName === 'string' &&
      (expectedName === null ? test.fullName.includes('[manual-snapshot]') : test.fullName === expectedName));
    const executed = file.assertionResults.filter((test) => test.status === 'passed' || test.status === 'failed');
    check(selected.length === (expectedName === null ? groupCount : 1) && executed.length === selected.length &&
      executed.every((test) => selected.includes(test)), 'EXACT_SELECTION');
    const names = selected.map((test) => test.fullName);
    check(new Set(names).size === names.length && names.every((name) => name.length <= 512 && /^[\x20-\x7e]+$/.test(name)), 'TEST_NAMES');
    const failed = selected.filter((test) => test.status === 'failed');
    check(selected.every((test) => Array.isArray(test.failureMessages)), 'FAILURES_MISSING');
    check(selected.every((test) => test.status === 'failed' ? test.failureMessages.length > 0 && test.failureMessages.every((message) =>
      typeof message === 'string' && /(?:^|\n)AssertionError:/.test(message) && !/Test timed out|Hook timed out|Timeout of \d+ms exceeded/i.test(message)) :
      test.status === 'passed' && test.failureMessages.length === 0), 'ASSERTION_NOT_INFRASTRUCTURE');
    check(phase === 'old' || failed.length === 0, 'CURRENT_POSITIVE_FAILED');
    check(json.numPassedTests === selected.length - failed.length && json.numFailedTests === failed.length &&
      json.success === (failed.length === 0) && child.status === (failed.length === 0 ? 0 : 1) &&
      file.status === (failed.length === 0 ? 'passed' : 'failed') &&
      (failed.length > 0 ? json.numFailedTestSuites > 0 : json.numFailedTestSuites === 0), 'RESULT_COUNTS');
    record.valid = true; record.passed = selected.length - failed.length; record.failed = failed.length;
    record.assertions = selected.map((test) => ({ fullName: test.fullName, status: test.status,
      failureKind: test.status === 'failed' ? 'assertion' : null,
      failureSha256: test.failureMessages.length ? sha256(Buffer.from(test.failureMessages.join('\n'))) : null }));
    return names;
  } finally {
    try { unlinkSync(output); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
}

function main() {
  check(process.env.GITHUB_ACTIONS === 'true', 'CI_ONLY');
  check(process.argv.length === 2, 'NO_ARGUMENTS');
  check(process.env.RUNNER_TEMP && isAbsolute(process.env.RUNNER_TEMP), 'RUNNER_TEMP_REQUIRED');
  const runnerTemp = realpathSync(process.env.RUNNER_TEMP);
  const directory = mkdtempSync(join(runnerTemp, 'manual-hls-readiness-'));
  const reportPath = join(runnerTemp, 'manual-hls-readiness-regressions.json');
  const original = regular(join(root, sourcePath)), testBytes = regular(join(root, testPath));
  const report = { schemaVersion: 1, scope: 'SELECTED_MANUAL_HLS_UNIT_REVERT_CHECK_NOT_PLAYBACK_PROOF',
    currentSourceSha256: sha256(original), currentTestSha256: sha256(testBytes),
    oldCommit, oldBlob, oldSourceSha256, mandatoryTitle, group: {}, cases: [], restored: false, success: false };
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
    const resolveBlob = spawnSync('git', ['rev-parse', '--verify', `${oldCommit}:${sourcePath}`],
      { cwd: root, encoding: 'utf8', timeout: remaining(5000), killSignal: 'SIGKILL', maxBuffer: 4096 });
    childSucceeded(resolveBlob); check(resolveBlob.stdout.trim() === oldBlob, 'OLD_COMMIT_BLOB');
    const readBlob = spawnSync('git', ['cat-file', 'blob', oldBlob],
      { cwd: root, timeout: remaining(5000), killSignal: 'SIGKILL', maxBuffer: receiptLimit });
    childSucceeded(readBlob);
    const old = readBlob.stdout;
    check(Buffer.isBuffer(old) && old.length > 0 && old.length <= receiptLimit && sha256(old) === oldSourceSha256, 'OLD_SOURCE_PIN');
    check(createHash('sha1').update(`blob ${old.length}\0`).update(old).digest('hex') === oldBlob, 'OLD_BLOB_HASH');
    assertOriginal();
    const names = runSelected('\\[manual-snapshot\\]', 'group', report.group, directory);
    const required = names.filter((name) => name.endsWith(mandatoryTitle));
    check(required.length === 1, 'MANDATORY_TEST_IDENTITY');
    const ordered = [required[0], ...names.filter((name) => name !== required[0]).sort()];
    save();
    for (const fullName of ordered) {
      const item = { fullName, mandatory: fullName === required[0], current: {}, old: {}, restored: false };
      report.cases.push(item);
      try {
        assertOriginal();
        runSelected(`^${escapeRegex(fullName)}$`, 'current', item.current, directory, fullName);
        assertOriginal();
        mutated = true; writeFileSync(join(root, sourcePath), old);
        check(sha256(regular(join(root, sourcePath))) === oldSourceSha256, 'REVERT_WRITE_HASH');
        runSelected(`^${escapeRegex(fullName)}$`, 'old', item.old, directory, fullName);
        check(!item.mandatory || item.old.failed === 1, 'MANDATORY_OLD_SOURCE_DID_NOT_FAIL');
      } finally {
        if (mutated) writeFileSync(join(root, sourcePath), original);
        assertOriginal(); mutated = false;
        item.restored = true; item.restoredSha256 = sha256(regular(join(root, sourcePath))); save();
      }
    }
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
  console.log('Manual HLS readiness revert checks passed; bounded receipt saved.');
}

try { main(); }
catch (error) { console.error(failureCode(error)); process.exitCode = 1; }
