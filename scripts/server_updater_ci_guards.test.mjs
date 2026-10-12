import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/deb-release.yml", import.meta.url), "utf8");
const integration = readFileSync(new URL("./server_updater_compose_integration.mjs", import.meta.url), "utf8");
const transactionDriver = readFileSync(new URL("./server_updater_transaction_driver.mjs", import.meta.url), "utf8");
const syntheticStep = workflow.match(/- name: Verify isolated Compose upgrade and rollback[\s\S]*?(?=\n\s+- name: Validate optional)/)?.[0] ?? "";
const actualStep = workflow.match(/- name: Verify actual published image upgrade and rollback[\s\S]*?(?=\n\s+- name: Retain updater)/)?.[0] ?? "";

test("updater transaction pipelines cannot hide a failed Node process behind tee", () => {
  for (const [name, step] of [["synthetic", syntheticStep], ["actual", actualStep]]) {
    assert.match(step, /set -euo pipefail/, `${name} updater step does not enable pipefail`);
    assert.match(step, /2>&1 \| tee "\$raw"/, `${name} updater step does not retain raw failure output`);
    assert.match(step, /test -s "\$receipt"/, `${name} updater step accepts an empty receipt`);
  }
  assert.match(syntheticStep, /sudo \/usr\/bin\/node scripts\/server_updater_compose_integration\.mjs/,
    "synthetic integration does not run as root for root-owned fixture cleanup");
});

test("separate receipt validators require identity and every transaction claim", () => {
  for (const field of ["result.ok", "result.mode", "result.version", "result.digest", "result.source"]) {
    assert.match(actualStep, new RegExp(`assert\\.equal\\(${field.replace(".", "\\.")}`), `actual receipt does not validate ${field}`);
  }
  for (const claim of ["digestVerified", "sourceVerified", "candidateHealthVerified", "injectedRollbackVerified",
    "activePlaybackDeferred", "successfulUpdateVerified", "stopFailureVerified", "snapshotFailureVerified",
    "interruptedRecoveryVerified", "registrationDriftPreserved", "ownershipAndDatabaseWriteVerified", "otherServicePreserved",
    "umask077PublicStatusVerified", "nonRootReadOnlyStatusVerified"]) {
    assert.ok(actualStep.includes(`\"${claim}\"`), `actual receipt validator omits ${claim}`);
  }
  assert.match(actualStep, /assert\.equal\(result\.digest, expectedDigest\)/);
  assert.match(actualStep, /assert\.equal\(result\.source, expectedSource\)/);
  assert.match(actualStep, /assert\.equal\(result\.version, expectedVersion\)/);
  assert.match(actualStep, /writeFileSync\(receipt,[\s\S]*mode: 0o600/);
  assert.match(syntheticStep, /assert\.equal\(result\.mode, "transaction-primitive"\)/);
  assert.match(syntheticStep, /assert\.match\(result\.digest, \/\^sha256:/);
  assert.match(syntheticStep, /assert\.equal\(result\.source, "generated-user-node-fixtures"\)/);
  assert.match(syntheticStep, /assert\.equal\(result\.version, expectedVersion\)/);
  assert.match(syntheticStep, /writeFileSync\(receipt,[\s\S]*mode: 0o600/);
});

test("interrupted transaction evidence proves stopped state and journal identity", () => {
  assert.match(integration, /composeRun\("ps", "--all", "--quiet", service\)/);
  assert.match(integration, /docker\("inspect", "--format", "\{\{\.State\.Running\}\}"/);
  assert.match(integration, /assert\.equal\(interruptedRunning, "false"/);
  assert.match(integration, /assert\.equal\(interruptedStatus, "exited"/);
  assert.match(integration, /assert\.equal\(interruptedJournal\.phase, "snapshotted"/);
  assert.match(integration, /assert\.deepEqual\(interruptedJournal\.registration, expectedRegistration/);
  assert.match(integration, /diagnostic: "interrupted-transaction"/);
  assert.match(integration, /assert\.equal\(existsSync\(journalPath\), false/);
  assert.match(integration, /diagnostic: "pre-snapshot-fault"/);
  assert.match(integration, /assert\.equal\(failedStatus\.state, "failed"/);
  assert.match(integration, /assert\.equal\(failedPolicy\.inhibitedVersion, candidateVersion/);
  assert.match(integration, /assert\.equal\(journalPending, false/);
});

test("post-health rollback cannot pass unless the injected mutation was reached", () => {
  assert.match(transactionDriver, /let faultReached = false/);
  assert.match(transactionDriver, /writeFileSync\(policy\.envPath,[\s\S]*faultReached = true;[\s\S]*throw new Error\("Injected post-health failure\."\)/);
  assert.match(transactionDriver, /if \(fault === "after-health"\) assert\.equal\(faultReached, true/);
  assert.match(integration, /assert\.equal\(rollbackStatus\.state, "rolled_back"/);
  assert.match(integration, /assert\.equal\(rollbackPolicy\.inhibitedVersion, candidateVersion/);
});

test("integration emits structured synthetic and actual receipts", () => {
  assert.match(integration, /process\.umask\(0o077\)/);
  assert.match(integration, /mode: "actual-published-images", version: candidateVersion, digest: actualCandidateDigest/);
  assert.match(integration, /source: actualSourceRevision/);
  assert.match(integration, /digestVerified: true, sourceVerified: true/);
  assert.match(integration, /umask077PublicStatusVerified: true, nonRootReadOnlyStatusVerified: true/);
  assert.match(integration, /mode: "transaction-primitive", version: candidateVersion, digest: newImage/);
  assert.match(integration, /source: "generated-user-node-fixtures"/);
  assert.match(integration, /fixtureDigestVerified: true, fixtureSourceVerified: true/);
});

test("candidate version follows server package metadata instead of a frozen release", () => {
  assert.match(integration, /server\/package\.json/);
  assert.match(transactionDriver, /server\/package\.json/);
  assert.doesNotMatch(integration, /2\.3\.(?:9|10)/);
  assert.doesNotMatch(transactionDriver, /2\.3\.(?:9|10)/);
  assert.doesNotMatch(workflow, /2\.3\.(?:9|10)/);
});

test("actual transaction proves umask-safe nonroot read-only status access", () => {
  assert.match(integration, /process\.umask\(0o077\)/);
  assert.match(integration, /lstatSync\("\/var\/lib\/yawf-server-updater\/public"\)/);
  assert.match(integration, /lstatSync\("\/var\/lib\/yawf-server-updater\/public\/status\.json"\)/);
  assert.match(integration, /"--user", "node"/);
  assert.match(integration, /source=\/var\/lib\/yawf-server-updater\/public,target=\/updater-status,readonly/);
  assert.match(integration, /writeBlocked=true/);
  assert.match(integration, /umask077PublicStatusVerified: true, nonRootReadOnlyStatusVerified: true/);
});
