import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const verify = readFileSync(new URL('../website-app/src/pages/download/Verify.tsx', import.meta.url), 'utf8');
const help = readFileSync(new URL('../website-app/src/pages/Help.tsx', import.meta.url), 'utf8');
export function validateGuidance(source) {
  const required = [
    /Android 2\.3\.21/,
    /install(?: the current APK| it)? once in place/i,
    /(?:without uninstalling or resetting app data|Do not uninstall or reset the app first)/i,
    /Do not assume (?:the older app native OTA check|the older app's native OTA check) can complete (?:this|that) upgrade/i,
    /confirm Android(?:\\)?'s install prompt/i,
  ];
  const missing = required.filter((pattern) => !pattern.test(source));
  if (missing.length) throw new Error(`missing Android migration guidance clauses: ${missing.join(', ')}`);
}
test('Verify preserves the complete manual migration bridge', () => {
  validateGuidance(verify);
});

test('Help preserves the complete manual migration bridge', () => {
  validateGuidance(help);
});
for (const [name, mutate] of [
  ['legacy version', (s) => s.replace(/Android 2\.3\.21/g, 'Android app')],
  ['in-place action', (s) => s.replace(/install(?: the current APK| it)? once in place/gi, 'use the updater')],
  ['data safety', (s) => s.replace(/without uninstalling or resetting app data|Do not uninstall or reset the app first/gi, 'before updating')],
  ['old OTA honesty', (s) => s.replace(/Do not assume (?:the older app native OTA check|the older app's native OTA check) can complete (?:this|that) upgrade/gi, 'Use OTA')],
  ['OS confirmation', (s) => s.replace(/confirm Android(?:\\)?'s install prompt/gi, 'continue')],
]) {
  test(`rejects removal of ${name} clause from each page`, () => {
    assert.throws(() => validateGuidance(mutate(verify)));
    assert.throws(() => validateGuidance(mutate(help)));
  });
}

export function validateHelpSeparation(source) {
  const required = [
    /native Android phone\/tablet APK can run standalone or connect to Server Mode/i,
    /A running YAWF Stream server is required for the mobile browser\/PWA and for iPhone or iPad\./i,
    /No standalone iOS package is published/i,
    /No App Store package is published/i,
    /browser PWA on Android, HTTPS is required/i,
  ];
  const missing = required.filter((pattern) => !pattern.test(source));
  if (missing.length) throw new Error(`missing Android/PWA separation clauses: ${missing.join(', ')}`);
}

export function validateKnownUpdateLimitation(source) {
  const required = [
    /On Android 2\.3\.25 and 2\.3\.26, the native update flow can remain at/i,
    /after Android(?:\\)?'s install permission is granted/i,
    /can remain at [“"]Update ready to install[”"]/i,
    /Android 2\.3\.27 repairs the permission-return handoff to the system installer/i,
    /Manual in-place installation of the current APK avoids relying on that (?:older )?flow/i,
    /(?:On Android 2\.3\.27 and later, )?weekly automatic checks remain opt-in/i,
    /YAWF asks before downloading, and Android confirms installation/i,
  ];
  const missing = required.filter((pattern) => !pattern.test(source));
  if (missing.length) throw new Error(`missing known Android update limitation clauses: ${missing.join(', ')}`);
}

test('Help separates standalone Android APK from server-required mobile paths', () => {
  validateHelpSeparation(help);
});

test('both pages state the known Android update limitation', () => {
  validateKnownUpdateLimitation(verify);
  validateKnownUpdateLimitation(help);
});

for (const [name, mutate] of [
  ['permission state', (s) => s.replace(/after Android(?:\\)?'s install permission is granted/gi, 'after installation')],
  ['stalled status', (s) => s.replace(/[“"]Update ready to install[”"]/gi, 'Update pending')],
  ['repair boundary', (s) => s.replace(/Android 2\.3\.27 repairs the permission-return handoff to the system installer/gi, 'Updates work automatically')],
  ['manual fallback', (s) => s.replace(/Manual in-place installation of the current APK avoids relying on that (?:older )?flow/gi, 'Use the native updater')],
]) {
  test(`rejects removal of ${name} limitation clause from each page`, () => {
    assert.throws(() => validateKnownUpdateLimitation(mutate(verify)));
    assert.throws(() => validateKnownUpdateLimitation(mutate(help)));
  });
}

test('Help rejects a blanket server-required Android statement', () => {
  const mutant = help.replace(
    /The native Android phone\/tablet APK can run standalone or connect to Server Mode\./,
    'A running YAWF Stream server is required for Android.',
  );
  assert.throws(() => validateHelpSeparation(mutant));
});
