import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const PINS = Object.freeze({
  repository: 'Tgk-30/YAWF-Stream', repositoryId: 1275935363,
  tag: 'v2.3.96-web', tagObject: '20b1ec2db9df5282a6db077ce54a0d4f487e67eb',
  source: '2edc189a33539bf1742435590810fb84aa653ce5',
  originalRun: 42916926303, armJob: 130182421368, armArtifact: 13810464736,
  armArtifactBytes: 480976412,
  armArchiveSha256: 'c3a076d075b70e39f07dd5a048d842f41696428818ea5848198e0a5e7836a4ec',
  armArtifactDigest: 'sha256:811d301f3d34ef7311f9697d98b7bfafdbb3bb5b6c9e2e87eff9e7ae1aa59f11',
  intelRun: 42963084399, intelJob: 130333974334,
  priorDiagnosticRun: 42955542025,
  priorObserverSource: '25aedc546a697e9c834be6686d9c15ea15a01c89',
  exporterSource: 'aa6d3588ac347acbbdcf171995d99a283b59f5c4',
  intelArtifact: 13833037325, intelArtifactBytes: 484944406, intelArtifactDigest: 'sha256:a26322853d8393c75c59e0438270923f2ff0dfc7c0f37dab74f82c940215266a',
  intelArchiveSha256: '88a499bda51a7baba874e342ded2d73d9578b5648d58991dec952cf17576400b',
});
const required = (actual, expected) => assert.deepEqual(actual, expected, 'Frozen recovery metadata mismatch');
function validatePins(pins) {
  for (const key of ['intelRun', 'intelJob', 'intelArtifact', 'intelArtifactBytes']) assert.ok(Number.isSafeInteger(pins[key]) && pins[key] > 0, 'Intel runtime is not admitted');
  assert.match(pins.intelArtifactDigest, /^sha256:[a-f0-9]{64}$/, 'Intel runtime is not admitted');
  assert.match(pins.intelArchiveSha256, /^[a-f0-9]{64}$/, 'Intel runtime is not admitted');
}
export function admitRecoveryMetadata(input, pins = PINS) {
  validatePins(pins);
  required(input.repository, pins.repository);
  required(input.actor, 'Tgk-30');
  required(input.ref, 'refs/heads/codex/desktop96-recovery');
  required(input.event, 'workflow_dispatch');
  required(input.scopeTag, pins.tag);
  assert.ok(input.windowsEnabled === '' || input.windowsEnabled === 'false', 'Windows remains held');
  required(input.releaseAbsent, true);
  required(input.tagRef.ref, `refs/tags/${pins.tag}`);
  required(input.tagRef.object.type, 'tag'); required(input.tagRef.object.sha, pins.tagObject);
  required(input.tagObject.sha, pins.tagObject);
  required(input.tagObject.tag, pins.tag);
  required(input.tagObject.object.type, 'commit'); required(input.tagObject.object.sha, pins.source);
  const checkRun = (run, id, source, branch, path, event, attempt, conclusion) => {
    required(run.id, id); required(run.repository.id, pins.repositoryId); required(run.repository.full_name, pins.repository);
    required(run.head_repository.id, pins.repositoryId); required(run.head_sha, source); required(run.head_branch, branch);
    required(run.path, path); required(run.event, event); required(run.run_attempt, attempt);
    required(run.status, 'completed'); required(run.conclusion, conclusion);
  };
  checkRun(input.originalRun, pins.originalRun, pins.source, pins.tag, '.github/workflows/web-release.yml', 'push', 2, 'cancelled');
  checkRun(input.intelRun, pins.intelRun, pins.exporterSource, 'codex/desktop96-media-observe', '.github/workflows/macos-media-runtime.yml', 'workflow_dispatch', 1, 'success');
  checkRun(input.priorDiagnosticRun, pins.priorDiagnosticRun, pins.priorObserverSource, 'codex/desktop96-media-observe', '.github/workflows/macos-media-replay-experiment.yml', 'workflow_dispatch', 1, 'failure');
  const checkJob = (job, id, run, source, branch, name) => {
    required(job.id, id); required(job.run_id, run); required(job.head_sha, source); required(job.head_branch, branch);
    required(job.run_attempt, 1); required(job.name, name); required(job.status, 'completed'); required(job.conclusion, 'success');
  };
  checkJob(input.armJob, pins.armJob, pins.originalRun, pins.source, pins.tag, 'macos-media-runtime / Confined native arm64 media runtime');
  checkJob(input.intelJob, pins.intelJob, pins.intelRun, pins.exporterSource, 'codex/desktop96-media-observe', 'Export frozen Intel96 production runtime, no signing');
  const checkArtifact = (artifact, id, name, bytes, digest, run, source, branch) => {
    required(artifact.id, id); required(artifact.name, name); required(artifact.size_in_bytes, bytes);
    required(artifact.digest, digest); required(artifact.expired, false);
    required(artifact.workflow_run.id, run); required(artifact.workflow_run.repository_id, pins.repositoryId);
    required(artifact.workflow_run.head_repository_id, pins.repositoryId); required(artifact.workflow_run.head_sha, source);
    required(artifact.workflow_run.head_branch, branch);
  };
  checkArtifact(input.armArtifact, pins.armArtifact, 'macos-media-runtime-arm64', pins.armArtifactBytes, pins.armArtifactDigest, pins.originalRun, pins.source, pins.tag);
  checkArtifact(input.intelArtifact, pins.intelArtifact, 'intel96-fixed-production-export-runtime', pins.intelArtifactBytes, pins.intelArtifactDigest, pins.intelRun, pins.exporterSource, 'codex/desktop96-media-observe');
  return { schemaVersion: 1, result: 'metadata-admitted', repository: pins.repository, productSource: pins.source,
    tag: pins.tag, tagObject: pins.tagObject, exporterSource: pins.exporterSource,
    originalRun: pins.originalRun, armJob: pins.armJob, armArtifact: pins.armArtifact,
    intelRun: pins.intelRun, intelJob: pins.intelJob, intelArtifact: pins.intelArtifact,
    armArchiveSha256: pins.armArchiveSha256, intelArchiveSha256: pins.intelArchiveSha256,
    originalFailureRetained: true, priorDiagnosticRun: pins.priorDiagnosticRun, priorDiagnosticObserverValid: false,
    runtimeStillRequiresPinnedArchiveAndNativeSmoke: true,
    signedOrPublished: false, windowsHeld: true };
}
export function readFixedMetadata(env = process.env, api = fixedApi) {
  validatePins(PINS);
  const prefix = `repos/${PINS.repository}`;
  // A draft can only be seen by the workflow's explicitly scoped write token.
  // Do not treat auth, transport or rate-limit errors as an absent release.
  const releaseAbsent = api(`${prefix}/releases/tags/${PINS.tag}`, true) === null;
  return admitRecoveryMetadata({
    repository: env.GITHUB_REPOSITORY, actor: env.GITHUB_ACTOR, ref: env.GITHUB_REF, event: env.GITHUB_EVENT_NAME,
    scopeTag: env.DESKTOP_ONLY_TAG, windowsEnabled: env.WINDOWS_ENABLED, releaseAbsent,
    tagRef: api(`${prefix}/git/ref/tags/${PINS.tag}`), tagObject: api(`${prefix}/git/tags/${PINS.tagObject}`),
    originalRun: api(`${prefix}/actions/runs/${PINS.originalRun}`), armJob: api(`${prefix}/actions/jobs/${PINS.armJob}`),
    armArtifact: api(`${prefix}/actions/artifacts/${PINS.armArtifact}`),
    priorDiagnosticRun: api(`${prefix}/actions/runs/${PINS.priorDiagnosticRun}`),
    intelRun: api(`${prefix}/actions/runs/${PINS.intelRun}`), intelJob: api(`${prefix}/actions/jobs/${PINS.intelJob}`),
    intelArtifact: api(`${prefix}/actions/artifacts/${PINS.intelArtifact}`),
  });
}
function fixedApi(endpoint, allowAbsent = false) {
  const result = spawnSync('gh', ['api', endpoint], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  if (result.error) throw new Error('Recovery metadata transport failed');
  if (result.status !== 0) {
    if (allowAbsent && result.status === 1 && /^gh: Not Found \(HTTP 404\)\s*$/.test(result.stderr)) return null;
    throw new Error('Recovery metadata unavailable');
  }
  return JSON.parse(result.stdout);
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    assert.equal(process.argv.length, 3, 'Expected a new receipt path');
    const receipt = readFixedMetadata();
    writeFileSync(process.argv[2], JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    process.stdout.write('Exact desktop96 metadata admitted. Native archive and release gates remain mandatory.\n');
  } catch { process.stderr.write('Desktop96 recovery admission refused.\n'); process.exitCode = 1; }
}
