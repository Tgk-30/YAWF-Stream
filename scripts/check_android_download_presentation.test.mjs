import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const download = readFileSync('website-app/src/pages/Download.tsx', 'utf8');
const hero = readFileSync('website-app/src/pages/download/Hero.tsx', 'utf8');
const phone = readFileSync('website-app/src/pages/download/AndroidPhoneInstall.tsx', 'utf8');

const source = `${download}\n${hero}\n${phone}`;

test('hero exposes the native Android phone APK CTA using release constants', () => {
  assert.match(hero, /PrimaryButton href=\{DOWNLOAD_LINKS\.androidPhone\}>Download Android APK/);
  assert.match(hero, /ANDROID_PHONE_RELEASE\.tag/);
});

test('native phone section is rendered before TV and PWA sections', () => {
  assert.match(download, /<AndroidPhoneInstall \/>[\s\S]*<AndroidTVInstall \/>[\s\S]*<PwaSteps \/>/);
  assert.match(phone, /eyebrow="\/\/ ANDROID PHONE AND TABLET"/);
  assert.match(phone, /PrimaryButton href=\{DOWNLOAD_LINKS\.androidPhone\}>Download Android APK/);
});

test('copy distinguishes standalone native APK from server-hosted PWA', () => {
  assert.match(phone, /standalone Android app/i);
  assert.match(phone, /do not need to run your own personal server/i);
  assert.match(phone, /server-hosted PWA/i);
  assert.match(phone, /iPhone and iPad use the PWA and require a running server/i);
  assert.match(phone, /Server Mode remains optional/i);
});

test('phone download does not hardcode a release URL or version', () => {
  assert.match(phone, /DOWNLOAD_LINKS\.androidPhone/);
  assert.match(phone, /ANDROID_PHONE_RELEASE\.tag/);
  assert.doesNotMatch(phone, /https?:\/\//i);
  assert.doesNotMatch(phone, /2\.3\.\d+/);
});

test('update wording requires an explicit OS compatibility check', () => {
  assert.match(phone, /Check the published \{ANDROID_PHONE_RELEASE\.tag\} release and Android version compatibility before updating/i);
  assert.match(phone, /does not silently install updates/i);
  assert.match(phone, /one-time manual upgrade over the existing app/i);
  assert.match(phone, /Do not uninstall first/i);
  assert.match(phone, /enable weekly checks in the native prompt/i);
  assert.match(phone, /Android asks before installation/i);
});

// Source contract should reject the previous presentation if the new section is removed.
test('regression guard rejects the old presentation without a native phone section', () => {
  assert.throws(
    () => assert.match(download.replace(/\s*<AndroidPhoneInstall \/>/, ''), /<AndroidPhoneInstall \/>/),
    /AndroidPhoneInstall/,
  );
});

console.log(`Checked ${source.length} source characters across the download presentation.`);
