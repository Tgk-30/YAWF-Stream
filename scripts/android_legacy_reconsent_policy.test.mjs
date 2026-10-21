import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const java = readFileSync(new URL('./android-runtime-instrumentation/app/src/androidTest/java/com/yawf/runtimeinstrumentation/RuntimeOtaFlowTest.java', import.meta.url), 'utf8');
const host = readFileSync(new URL('./android_public_ota_runtime_check.py', import.meta.url), 'utf8');

function validatePolicy(javaSource, hostSource) {
  const required = [
    /"legacy-manual-reconsent"\.equals\(otaMode\)/,
    /if \(!"legacy-manual-reconsent"\.equals\(otaMode\)\) \{\s*return;/s,
    /By\.text\("Update ready to install"\)\.pkg\(OtaFlowPolicy\.PRODUCT_PACKAGE\)/,
    /By\.text\("YAWF Stream 2\.3\.26 passed all checks\. Android will show the system installer\."\)/,
    /By\.res\("android", "button1"\)\s*\.pkg\(OtaFlowPolicy\.PRODUCT_PACKAGE\)/s,
    /legacyManualReconsentUsed = true/,
    /permissionBackReturnObserved = true/,
    /assertTrue\("Legacy reconsent requires a settled Settings Back return", permissionBackReturnObserved\)/,
    /if \(!waitForLegacyReadyOrInstaller\(\)/,
    /"legacyManualReconsentUsed"/,
    /choices=\(STRICT_OTA_MODE, LEGACY_MANUAL_RECONSENT_MODE\)/,
    /validate_receipt\(receipt, self\.args\.ota_mode\)/,
    /otaMode.*legacy-manual-reconsent|legacy-manual-reconsent.*otaMode/s,
  ];
  const missing = required.filter((pattern) => !pattern.test(javaSource + '\n' + hostSource));
  if (missing.length) throw new Error(`missing reconsent policy guards: ${missing.join(', ')}`);
  if (!/LEGACY_MANUAL_RECONSENT_MODE\s*=\s*"legacy-manual-reconsent"/.test(hostSource)) {
    throw new Error('host receipt mode label is not the explicit legacy-manual-reconsent mode');
  }
  if (/for\s*\([^)]*\)\s*install\.click\(\)/s.test(javaSource)) {
    throw new Error('legacy reconsent tap must not repeat');
  }
}

test('legacy reconsent remains opt-in, exact, scoped, and receipt-labelled', () => {
  validatePolicy(java, host);
});

test('rejects an unconditional additional tap mutant', () => {
  const mutant = java.replace(
    'if (!"legacy-manual-reconsent".equals(otaMode)) {\n            return;\n        }',
    '',
  );
  assert.throws(() => validatePolicy(mutant, host));
});

test('rejects a repeated-tap loop mutant', () => {
  const mutant = java.replace(
    'install.click();\n        legacyManualReconsentUsed = true;',
    'for (int attempt = 0; attempt < 2; attempt++) install.click();\n        legacyManualReconsentUsed = true;',
  );
  assert.throws(() => validatePolicy(mutant, host));
});

test('rejects missing exact product scoping mutant', () => {
  const mutant = java.replace(
    '.pkg(OtaFlowPolicy.PRODUCT_PACKAGE)\n                        .text(OtaFlowPolicy.INSTALL.textPattern())',
    '.text(OtaFlowPolicy.INSTALL.textPattern())',
  );
  assert.throws(() => validatePolicy(mutant, host));
});

test('rejects bypassing the recorded permission transition', () => {
  const mutant = java.replace(
    'assertTrue("Legacy reconsent requires a settled Settings Back return", permissionBackReturnObserved);',
    '',
  );
  assert.throws(() => validatePolicy(mutant, host));
});

test('rejects an unbounded premature ready-state check mutant', () => {
  const mutant = java.replace(
    'if (!waitForLegacyReadyOrInstaller()\n                || !OtaFlowPolicy.PRODUCT_PACKAGE.equals(device.getCurrentPackageName())',
    'if (!OtaFlowPolicy.PRODUCT_PACKAGE.equals(device.getCurrentPackageName())',
  );
  assert.throws(() => validatePolicy(mutant, host));
});

test('rejects a misleading automatic-continuation receipt mutant', () => {
  const mutant = host.replace(
    /legacy-manual-reconsent/g,
    'automatic-install-complete',
  );
  assert.throws(() => validatePolicy(java, mutant));
});
