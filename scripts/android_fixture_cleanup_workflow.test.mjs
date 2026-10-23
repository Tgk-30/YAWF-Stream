import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const workflow = readFileSync(new URL('../.github/workflows/android-permission-return-fixture.yml', import.meta.url), 'utf8');

function policy(marker, terminator) {
  const start = workflow.indexOf(marker);
  assert.ok(start >= 0, marker);
  const body = workflow.slice(start + marker.length).split(`\n          ${terminator}`)[0];
  assert.notEqual(body, workflow.slice(start + marker.length));
  return body.split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
}

const driverManifestPolicy = policy('DRIVER_MANIFEST="$EVIDENCE/driver-manifest.xml" python3 - <<\'PY_MANIFEST\'\n', 'PY_MANIFEST');
const corePolicy = policy('MODE="${{ matrix.mode }}" python3 - <<\'PY\'\n', 'PY');
const cleanupPolicy = policy('RECEIPT="$run_evidence/cleanup-evidence/receipt.json" python3 - <<\'PY_CLEANUP\'\n', 'PY_CLEANUP');

const pythonRunner = String.raw`
import json, os, sys, tempfile
from pathlib import Path
p = json.load(sys.stdin)
results = []
with tempfile.TemporaryDirectory(prefix='yawf-cleanup-policy-') as directory:
    receipt = Path(directory) / 'receipt.json'
    os.environ['RECEIPT'] = str(receipt)
    os.environ['DRIVER_MANIFEST'] = str(receipt)
    os.environ['TARGET_SHA256'] = 'a' * 64
    for case in p['cases']:
        receipt.write_text(case['xml'] if 'xml' in case else json.dumps(case['receipt']))
        os.environ['MODE'] = case.get('mode', 'positive')
        admitted = True
        try:
            exec(compile(p['policy'], '<exact-embedded-receipt-policy>', 'exec'), {})
        except (AssertionError, KeyError):
            admitted = False
        results.append({'name': case['name'], 'admitted': admitted})
print(json.dumps(results))
`;

function runPolicy(source, cases) {
  const result = spawnSync('python3', ['-c', pythonRunner], {
    input: JSON.stringify({ policy: source, cases }), encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const validCleanup = {
  outcome: 'passed', failure: null, classification: 'fixture-external-permission-cleanup-only',
  separateDriverPackage: true, fixturePackage: 'com.yawf.permissionreturnfixture',
  fixtureLabel: 'YAWF permission return fixture', fixtureIdentityObserved: true,
  scopedSettingsObserved: true, permissionInitiallyEnabled: true, cleanupClicked: true,
  settledOffSamples: 3, permissionVisiblyOff: true, directPermissionMutationUsed: false,
  coreFlowProof: false, publicOtaProof: false, installProof: false,
};
const validCore = {
  outcome: 'passed', failure: null, permissionEnabledByTest: true, corePassed: true,
  externalPermissionCleanupRequired: true, permissionCleanupPerformedByCore: false,
  installerObserved: false, controlReachedTamper: true, publicOtaProof: false,
  installProof: false, dataPreservationProof: false,
  classification: 'fixture-lifecycle-and-tamper-rejection-core-only', negativeControl: false,
  verifierRecoveryObserved: true, stagedFileCleared: true,
  identityBeforeTamperValidated: true, identityAfterTamperValidated: true,
  sameLengthTamper: true, originalSha256: 'a'.repeat(64), tamperedSha256: 'b'.repeat(64),
  signingPaddingBytes: 2650, retryMessage: 'The verified update changed or became unavailable.',
};

test('both instrumentation processes must finish and cleanup always runs after the core result', () => {
  const coreEnd = workflow.indexOf('instrument_status=${PIPESTATUS[0]}');
  const cleanupStart = workflow.indexOf('-e class com.yawf.permissionreturndriver.FixturePermissionCleanupTest');
  const receiptStart = workflow.indexOf('for evidence_scope in core cleanup; do');
  assert.ok(coreEnd >= 0 && cleanupStart > coreEnd && receiptStart > cleanupStart);
  assert.ok(workflow.indexOf('test "$instrument_status" -eq 0') > receiptStart);
  assert.ok(workflow.indexOf('test "$cleanup_status" -eq 0') > receiptStart);
  assert.ok(workflow.includes("grep -F 'OK (1 test)' \"$run_evidence/instrumentation.txt\""));
  assert.ok(workflow.includes("grep -F 'OK (1 test)' \"$run_evidence/cleanup-instrumentation.txt\""));
  assert.ok(workflow.includes('extra_args=(:success-driver:assembleDebug :success-driver:assembleDebugAndroidTest)'));
  assert.ok(workflow.includes('com.yawf.permissionreturndriver/permission-return-cleanup-evidence'));
  assert.doesNotMatch(workflow, /(?:appops\s+set|pm\s+(?:grant|revoke)|shortMsg=Process crashed.*(?:true|continue))/);
});

test('the exact cleanup policy rejects no-op, wrong-identity, incomplete and dishonest receipts', () => {
  const changes = {
    noClick: { cleanupClicked: false }, alreadyOff: { permissionInitiallyEnabled: false },
    wrongPackage: { fixturePackage: 'com.yawf.unrelated' }, wrongLabel: { fixtureLabel: 'Other app' },
    missingIdentity: { fixtureIdentityObserved: false }, wrongScope: { scopedSettingsObserved: false },
    unsettled: { settledOffSamples: 2 }, stillEnabled: { permissionVisiblyOff: false },
    sameUid: { separateDriverPackage: false }, bypass: { directPermissionMutationUsed: true },
    falseCoreClaim: { coreFlowProof: true }, falseOtaClaim: { publicOtaProof: true },
    falseInstallClaim: { installProof: true }, failed: { outcome: 'failed' },
    hiddenFailure: { failure: 'AssertionError' },
  };
  const cases = [{ name: 'valid', receipt: validCleanup }, ...Object.entries(changes).map(([name, change]) => ({ name, receipt: { ...validCleanup, ...change } }))];
  assert.deepEqual(runPolicy(cleanupPolicy, cases), cases.map((c, i) => ({ name: c.name, admitted: i === 0 })));
  for (const [guard, caseName] of [
    ['assert receipt["permissionInitiallyEnabled"] is True', 'alreadyOff'],
    ['assert receipt["cleanupClicked"] is True', 'noClick'],
    ['assert receipt["settledOffSamples"] == 3', 'unsettled'],
  ]) {
    const mutant = cleanupPolicy.replace(guard, 'pass');
    assert.notEqual(mutant, cleanupPolicy);
    assert.equal(runPolicy(mutant, [cases.find(c => c.name === caseName)])[0].admitted, true);
  }
});

test('the exact core policy cannot claim same-UID cleanup or omit the external cleanup requirement', () => {
  const negative = { ...validCore, classification: 'fixture-negative-control-return-resume-omitted-core-only', negativeControl: true, verifierRecoveryObserved: false, stagedFileCleared: false };
  const cases = [
    { name: 'positive', receipt: validCore },
    { name: 'negative', mode: 'return-resume-omitted', receipt: negative },
    { name: 'coreFailure', receipt: { ...validCore, corePassed: false } },
    { name: 'identityBeforeMissing', receipt: { ...validCore, identityBeforeTamperValidated: false } },
    { name: 'identityAfterMissing', receipt: { ...validCore, identityAfterTamperValidated: false } },
    { name: 'unchangedDigest', receipt: { ...validCore, tamperedSha256: 'a'.repeat(64) } },
    { name: 'wrongOriginal', receipt: { ...validCore, originalSha256: 'c'.repeat(64) } },
    { name: 'missingPadding', receipt: { ...validCore, signingPaddingBytes: 0 } },
    { name: 'genericInterrupted', receipt: { ...validCore, retryMessage: 'Update preparation was interrupted. Retry when you are ready.' } },
    { name: 'cleanupNotRequired', receipt: { ...validCore, externalPermissionCleanupRequired: false } },
    { name: 'sameUidCleanupClaim', receipt: { ...validCore, permissionCleanupPerformedByCore: true } },
    { name: 'recoveryUnobserved', receipt: { ...validCore, verifierRecoveryObserved: false } },
    { name: 'stageRetained', receipt: { ...validCore, stagedFileCleared: false } },
    { name: 'negativeRecovered', mode: 'return-resume-omitted', receipt: { ...negative, verifierRecoveryObserved: true } },
  ];
  assert.deepEqual(runPolicy(corePolicy, cases), cases.map((c, i) => ({ name: c.name, admitted: i < 2 })));
});

const generatedOwnPermission = 'com.yawf.permissionreturndriver.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION';
const actualMergedManifestShape = `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.yawf.permissionreturndriver">
  <queries><package android:name="com.yawf.permissionreturnfixture" /></queries>
  <permission android:name="${generatedOwnPermission}" android:protectionLevel="0x2" />
  <uses-permission android:name="${generatedOwnPermission}" />
  <application />
</manifest>`;

test('the exact compiled driver policy admits only its own signature-only receiver permission and one fixture query', () => {
  const invalid = {
    wrongDriver: actualMergedManifestShape.replace('package="com.yawf.permissionreturndriver"', 'package="com.yawf.unrelated"'),
    wrongQuery: actualMergedManifestShape.replace('android:name="com.yawf.permissionreturnfixture"', 'android:name="com.yawf.unrelated"'),
    extraQuery: actualMergedManifestShape.replace('</queries>', '<package android:name="com.yawf.unrelated" /></queries>'),
    broadQuery: actualMergedManifestShape.replace('</queries>', '<intent><action android:name="android.intent.action.VIEW" /></intent></queries>'),
    unsignedOwnPermission: actualMergedManifestShape.replace('android:protectionLevel="0x2"', 'android:protectionLevel="0x0"'),
    wrongOwnPermission: actualMergedManifestShape.replaceAll(generatedOwnPermission, 'com.yawf.unrelated.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION'),
    missingDefinition: actualMergedManifestShape.replace(/  <permission[^>]+\/>\n/, ''),
    missingUse: actualMergedManifestShape.replace(/  <uses-permission[^>]+\/>\n/, ''),
  };
  for (const permission of ['INTERNET', 'REQUEST_INSTALL_PACKAGES', 'QUERY_ALL_PACKAGES', 'READ_CONTACTS']) {
    invalid[permission] = actualMergedManifestShape.replace('<application />', `<uses-permission android:name="android.permission.${permission}" /><application />`);
  }
  const cases = [{ name: 'actual-reviewed-merged-shape', xml: actualMergedManifestShape }, ...Object.entries(invalid).map(([name, xml]) => ({ name, xml }))];
  assert.deepEqual(runPolicy(driverManifestPolicy, cases), cases.map((c, i) => ({ name: c.name, admitted: i === 0 })));
  for (const [guard, caseName] of [
    ['assert len(uses_permissions) == 1', 'INTERNET'],
    ['assert uses_permissions[0].attrib == {android_name: own_permission}', 'wrongOwnPermission'],
  ]) {
    let mutant = driverManifestPolicy.replace(guard, 'pass');
    if (caseName === 'wrongOwnPermission') {
      mutant = mutant.replace('android_name: own_permission,', 'android_name: permissions[0].attrib[android_name],');
    }
    assert.notEqual(mutant, driverManifestPolicy);
    assert.equal(runPolicy(mutant, [cases.find(c => c.name === caseName)])[0].admitted, true);
  }
});
