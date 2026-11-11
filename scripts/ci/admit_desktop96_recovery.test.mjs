import assert from 'node:assert/strict';
import test from 'node:test';
import { admitRecoveryMetadata, PINS, readFixedMetadata } from './admit_desktop96_recovery.mjs';
const pins = { ...PINS, intelRun: 999997, intelJob: 999998, intelArtifact: 999999, intelArtifactBytes: 123456, intelArtifactDigest: `sha256:${'1'.repeat(64)}`, intelArchiveSha256: '2'.repeat(64) };
function fixture() {
  const run = (id, source, branch, path, event, attempt, conclusion) => ({ id, head_sha: source, head_branch: branch, path, event,
    run_attempt: attempt, status: 'completed', conclusion, repository: { id: pins.repositoryId, full_name: pins.repository }, head_repository: { id: pins.repositoryId } });
  const job = (id, runId, source, branch, name) => ({ id, run_id: runId, head_sha: source, head_branch: branch, name, run_attempt: 1, status: 'completed', conclusion: 'success' });
  const artifact = (id, name, bytes, digest, runId, source, branch) => ({ id, name, size_in_bytes: bytes, digest, expired: false,
    workflow_run: { id: runId, repository_id: pins.repositoryId, head_repository_id: pins.repositoryId, head_sha: source, head_branch: branch } });
  return { repository: pins.repository, actor: 'Tgk-30', ref: 'refs/heads/codex/desktop96-recovery', event: 'workflow_dispatch', scopeTag: pins.tag, windowsEnabled: '', releaseAbsent: true,
    tagRef: { ref: `refs/tags/${pins.tag}`, object: { type: 'tag', sha: pins.tagObject } }, tagObject: { sha: pins.tagObject, tag: pins.tag, object: { type: 'commit', sha: pins.source } },
    originalRun: run(pins.originalRun, pins.source, pins.tag, '.github/workflows/web-release.yml', 'push', 2, 'cancelled'),
    intelRun: run(pins.intelRun, pins.exporterSource, 'codex/desktop96-media-observe', '.github/workflows/macos-media-runtime.yml', 'workflow_dispatch', 1, 'success'),
    priorDiagnosticRun: run(pins.priorDiagnosticRun, pins.priorObserverSource, 'codex/desktop96-media-observe', '.github/workflows/macos-media-replay-experiment.yml', 'workflow_dispatch', 1, 'failure'),
    armJob: job(pins.armJob, pins.originalRun, pins.source, pins.tag, 'macos-media-runtime / Confined native arm64 media runtime'),
    intelJob: job(pins.intelJob, pins.intelRun, pins.exporterSource, 'codex/desktop96-media-observe', 'Export frozen Intel96 production runtime, no signing'),
    armArtifact: artifact(pins.armArtifact, 'macos-media-runtime-arm64', pins.armArtifactBytes, pins.armArtifactDigest, pins.originalRun, pins.source, pins.tag),
    intelArtifact: artifact(pins.intelArtifact, 'intel96-fixed-production-export-runtime', pins.intelArtifactBytes, pins.intelArtifactDigest, pins.intelRun, pins.exporterSource, 'codex/desktop96-media-observe') };
}
test('exact metadata fixture admits only metadata, retaining native and signed gates', () => {
  const x = admitRecoveryMetadata(fixture(), pins); assert.equal(x.productSource, pins.source); assert.equal(x.originalFailureRetained, true);
  assert.equal(x.runtimeStillRequiresPinnedArchiveAndNativeSmoke, true); assert.equal(x.signedOrPublished, false);
});
const controls = {
  'foreign actor': x => { x.actor = 'another-writer'; },
  'foreign repository': x => { x.repository = 'foreign/repository'; },
  'wrong branch': x => { x.ref = 'refs/heads/main'; },
  'push event': x => { x.event = 'push'; },
  'missing explicit desktop scope': x => { x.scopeTag = ''; },
  'noncanonical Windows flag': x => { x.windowsEnabled = 'TRUE'; },
  'Windows enabled': x => { x.windowsEnabled = 'true'; },
  'existing release': x => { x.releaseAbsent = false; },
  'moved annotated tag': x => { x.tagObject.object.sha = '0'.repeat(40); },
  'lightweight tag substitution': x => { x.tagRef.object.type = 'commit'; },
  'unrelated original run': x => { x.originalRun.id++; },
  'fork original source': x => { x.originalRun.head_repository.id++; },
  'wrong product source': x => { x.originalRun.head_sha = '1'.repeat(40); },
  'unqualified original attempt': x => { x.originalRun.run_attempt++; },
  'exporter source substitution': x => { x.intelRun.head_sha = pins.source; },
  'exporter still running': x => { x.intelRun.status = 'in_progress'; x.intelRun.conclusion = null; },
  'exporter failure': x => { x.intelRun.conclusion = 'failure'; },
  'exporter retry': x => { x.intelRun.run_attempt++; },
  'wrong exporter workflow': x => { x.intelRun.path = '.github/workflows/web-release.yml'; },
  'ARM native job failure': x => { x.armJob.conclusion = 'failure'; },
  'wrong Intel native job': x => { x.intelJob.name = 'Confined ARM source replay, no publication'; },
  'prior diagnostic reclassified as success': x => { x.priorDiagnosticRun.conclusion = 'success'; },
  'prior diagnostic source substitution': x => { x.priorDiagnosticRun.head_sha = pins.exporterSource; },
  'Intel job cancellation': x => { x.intelJob.conclusion = 'cancelled'; },
  'ARM artifact digest substitution': x => { x.armArtifact.digest = `sha256:${'0'.repeat(64)}`; },
  'Intel artifact latest alias': x => { x.intelArtifact.name = 'latest'; },
  'Intel artifact wrong bytes': x => { x.intelArtifact.size_in_bytes++; },
  'Intel artifact wrong ID': x => { x.intelArtifact.id++; },
  'expired artifact': x => { x.intelArtifact.expired = true; },
  'fork artifact': x => { x.intelArtifact.workflow_run.head_repository_id++; },
  'artifact transplanted from another run': x => { x.intelArtifact.workflow_run.id++; },
};
for (const [name, mutate] of Object.entries(controls)) test(`refuses ${name}`, () => { const x = fixture(); mutate(x); assert.throws(() => admitRecoveryMetadata(x, pins)); });
test('production pins are frozen or refused before metadata IO', () => {
  if (PINS.intelArtifact > 0) return assert.match(PINS.intelArtifactDigest, /^sha256:[a-f0-9]{64}$/);
  let calls = 0; assert.throws(() => readFixedMetadata({}, () => { calls++; throw new Error('unexpected API'); })); assert.equal(calls, 0);
});
