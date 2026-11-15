import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, linkSync, lstatSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const BASE_SHA256 = 'cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849';
export const DERIVED_SHA256 = 'e53c15d248f57bceec0a3a16fad1b4ab0d05a7bddb455f86a60e2dba5612cdf7';
export const LICENSE_SHA256 = '45873d00a0dd243596deb4aa23b2493b3d1f0671921bf2538ea431d7380220eb';
export const PROFILE_VERSION = 'playwright-1.65.1-chroot-v1';
export const OUTPUT_NAME = 'foreground-seccomp-playwright-1.65.1-chroot-v1.json';
const MAX_POLICY_BYTES = 32 * 1024;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const requirePolicy = (condition, code) => { if (!condition) throw new Error(code); };

export function parsePinnedForegroundBase(bytes) {
  requirePolicy(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_POLICY_BYTES, 'FOREGROUND_SECCOMP_BASE_BOUND');
  requirePolicy(digest(bytes) === BASE_SHA256, 'FOREGROUND_SECCOMP_BASE_SHA');
  const base = JSON.parse(bytes.toString('utf8'));
  requirePolicy(base.defaultAction === 'SCMP_ACT_ERRNO' && Array.isArray(base.syscalls), 'FOREGROUND_SECCOMP_BASE_SHAPE');
  return base;
}

export function hasOnlyForegroundChrootDelta(base, candidate) {
  try {
    if (!base || !candidate || !Array.isArray(base.syscalls) || !Array.isArray(candidate.syscalls)) return false;
    const { syscalls: _baseRules, ...baseRest } = base;
    const { syscalls: _candidateRules, ...candidateRest } = candidate;
    return JSON.stringify(baseRest) === JSON.stringify(candidateRest) && candidate.syscalls.length === base.syscalls.length + 1 &&
      JSON.stringify(candidate.syscalls.slice(0, -1)) === JSON.stringify(base.syscalls) &&
      JSON.stringify(candidate.syscalls.at(-1)) === '{"names":["chroot"],"action":"SCMP_ACT_ALLOW","args":[]}';
  } catch { return false; }
}

export function pinForegroundDerivedBytes(bytes) {
  requirePolicy(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_POLICY_BYTES, 'FOREGROUND_SECCOMP_DERIVED_BOUND');
  requirePolicy(digest(bytes) === DERIVED_SHA256, 'FOREGROUND_SECCOMP_DERIVED_SHA');
  return bytes;
}

export function deriveForegroundSeccomp(baseBytes) {
  const base = parsePinnedForegroundBase(baseBytes);
  const derived = { ...base, syscalls: [...base.syscalls, { names: ['chroot'], action: 'SCMP_ACT_ALLOW', args: [] }] };
  requirePolicy(hasOnlyForegroundChrootDelta(base, derived), 'FOREGROUND_SECCOMP_DELTA');
  return pinForegroundDerivedBytes(Buffer.from(`${JSON.stringify(derived, null, 2)}\n`));
}

function readBoundedVendor(name) {
  const path = fileURLToPath(new URL(`./foreground-playback/${name}`, import.meta.url));
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(descriptor);
    requirePolicy(info.isFile() && info.size > 0 && info.size <= MAX_POLICY_BYTES, 'FOREGROUND_SECCOMP_VENDOR_BOUND');
    const bytes = Buffer.alloc(MAX_POLICY_BYTES + 1);
    const count = readSync(descriptor, bytes, 0, bytes.length, 0);
    requirePolicy(count > 0 && count <= MAX_POLICY_BYTES, 'FOREGROUND_SECCOMP_VENDOR_BOUND');
    return bytes.subarray(0, count);
  } finally { closeSync(descriptor); }
}

export function publishOwnedForegroundSeccomp(root, outputBytes) {
  pinForegroundDerivedBytes(outputBytes);
  requirePolicy(typeof root === 'string' && isAbsolute(root) && resolve(root) === root && root !== parse(root).root,
    'FOREGROUND_SECCOMP_OUTPUT_ROOT');
  const info = lstatSync(root);
  requirePolicy(info.isDirectory() && !info.isSymbolicLink() && realpathSync(root) === root &&
    typeof process.getuid === 'function' && info.uid === process.getuid() && (info.mode & 0o022) === 0,
  'FOREGROUND_SECCOMP_OUTPUT_OWNER');
  const outputPath = join(root, OUTPUT_NAME);
  const temporary = mkdtempSync(join(root, '.foreground-seccomp-'));
  const temporaryProfile = join(temporary, 'profile.json');
  try {
    writeFileSync(temporaryProfile, outputBytes, { flag: 'wx', mode: 0o600 });
    // Hard-link publication is atomic and refuses an existing file or symlink.
    linkSync(temporaryProfile, outputPath);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('FOREGROUND_SECCOMP_OUTPUT_EXISTS');
    throw error;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  return outputPath;
}

export function prepareForegroundSeccomp(root) {
  const license = readBoundedVendor('LICENSE.playwright');
  requirePolicy(digest(license) === LICENSE_SHA256, 'FOREGROUND_SECCOMP_LICENSE_SHA');
  return publishOwnedForegroundSeccomp(root, deriveForegroundSeccomp(readBoundedVendor('seccomp-playwright-1.65.1.json')));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    requirePolicy(process.argv.length === 2, 'FOREGROUND_SECCOMP_NO_OVERRIDES');
    prepareForegroundSeccomp(process.env.RUNNER_TEMP);
    process.stdout.write(`seccompProfileVersion=${PROFILE_VERSION}\nseccompBaseSha256=${BASE_SHA256}\nseccompDerivedSha256=${DERIVED_SHA256}\nseccompLicenseSha256=${LICENSE_SHA256}\n`);
  } catch {
    process.stderr.write('FOREGROUND_SECCOMP_REFUSED\n');
    process.exitCode = 1;
  }
}
