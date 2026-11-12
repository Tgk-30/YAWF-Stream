import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TAG = 'v2.3.102-web';
export const SOURCE = '61b13db998f421bdd10c5b1949fa1af8fb2996c0';
export const PRODUCER = 43246997392;
export const RELEASE_ID = 443250250;
const REPOSITORY = 'Tgk-30/YAWF-Stream';
const API_RELEASE = `https://api.github.com/repos/${REPOSITORY}/releases/${RELEASE_ID}`;
const SHA256 = /^[a-f0-9]{64}$/;
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export const ORIGINAL_ASSET_PINS = freeze([
  {
    "id": 740493395,
    "name": "latest.json",
    "size": 4542,
    "sha256": "efc3e2d120695b981f3527dd86b0730c0018e5a668ae1ddc4f7c675407d924d6"
  },
  {
    "id": 740304258,
    "name": "macos-media-provenance-arm64.json",
    "size": 1591,
    "sha256": "04fbf6aeef4783640ed98015147e11fb30e8679794679af1ad190ba82f07e104"
  },
  {
    "id": 740494215,
    "name": "macos-media-provenance-x86_64.json",
    "size": 1592,
    "sha256": "7f99bdf228223651188bee3c4ea4e0cfaefeb89752c9ee32a914179d0fe95746"
  },
  {
    "id": 740304364,
    "name": "yawf-macos-media-runtime-source-6c850c418e17824d70ba2dcb9bb71a1c829906d8238c3ba616981001098e941c.tar.gz",
    "size": 456776628,
    "sha256": "6c850c418e17824d70ba2dcb9bb71a1c829906d8238c3ba616981001098e941c"
  },
  {
    "id": 740310737,
    "name": "YAWF.Stream_2.3.102_aarch64.dmg",
    "size": 94314073,
    "sha256": "69ee52b72dad47aa06d7afae47bedd1679b11c38417e6c9af6305bb25a248078"
  },
  {
    "id": 740293738,
    "name": "YAWF.Stream_2.3.102_amd64.AppImage",
    "size": 262433272,
    "sha256": "5c4fef088638505e337241e8678ec382cc7b7ed36c755212dd959fe3faeb8a9b"
  },
  {
    "id": 740294277,
    "name": "YAWF.Stream_2.3.102_amd64.AppImage.sig",
    "size": 448,
    "sha256": "deadef840940fd78d1f243221515b1a62b320a4264c23214bc939d8bfd4bec8c"
  },
  {
    "id": 740293355,
    "name": "YAWF.Stream_2.3.102_amd64.deb",
    "size": 137700494,
    "sha256": "576cc2b9a299d5b0ce86967baa3fac7e73bd41fc9e7ea94481b1876fdb79ef8f"
  },
  {
    "id": 740293706,
    "name": "YAWF.Stream_2.3.102_amd64.deb.sig",
    "size": 440,
    "sha256": "a1bd4e0d2adcf8d0666e7566aec85d94acf9ac87a9de6fe863d18ca7a14661f4"
  },
  {
    "id": 740499431,
    "name": "YAWF.Stream_2.3.102_x64.dmg",
    "size": 99849109,
    "sha256": "65b2347abe6e13cbc09e0e770e609f2594afa193f2d6122240cd92e4608cb408"
  },
  {
    "id": 740303436,
    "name": "YAWF.Stream_aarch64.app.tar.gz",
    "size": 95584951,
    "sha256": "a6faf88930b95d119e356fe34311319ab983129a3e37b86138f9a637abde7bd5"
  },
  {
    "id": 740303658,
    "name": "YAWF.Stream_aarch64.app.tar.gz.sig",
    "size": 432,
    "sha256": "af00772bfa46289a5f66174bc88c57cbf7c226ad1d521a6c68f4d29d104351cd"
  },
  {
    "id": 740492816,
    "name": "YAWF.Stream_x64.app.tar.gz",
    "size": 100518502,
    "sha256": "f2fa5d710f49cb90b5c69f7fee9c62cb5dd012520a74d4d632d5e2637f0dd263"
  },
  {
    "id": 740493195,
    "name": "YAWF.Stream_x64.app.tar.gz.sig",
    "size": 432,
    "sha256": "f5b0b8a24e1019c8572e5ed4f4c38747fa952701099ec03fe65768354ca97ffe"
  }
]);
export const JOB_PINS = freeze([
  [
    {
      "id": 131282223189,
      "run_id": 43246997392,
      "run_attempt": 1,
      "head_sha": "61b13db998f421bdd10c5b1949fa1af8fb2996c0",
      "name": "Resolve explicit release scope",
      "status": "completed",
      "conclusion": "success",
      "failedSteps": []
    },
    {
      "id": 131282382737,
      "run_id": 43246997392,
      "run_attempt": 1,
      "head_sha": "61b13db998f421bdd10c5b1949fa1af8fb2996c0",
      "name": "macos-media-runtime / Retrieve the pinned private source seed",
      "status": "completed",
      "conclusion": "success",
      "failedSteps": []
    },
    {
      "id": 131282580423,
      "run_id": 43246997392,
      "run_attempt": 1,
      "head_sha": "61b13db998f421bdd10c5b1949fa1af8fb2996c0",
      "name": "macos-media-runtime / Prepare one exact corresponding-source archive",
      "status": "completed",
      "conclusion": "success",
      "failedSteps": []
    },
    {
      "id": 131283456170,
      "run_id": 43246997392,
      "run_attempt": 1,
      "head_sha": "61b13db998f421bdd10c5b1949fa1af8fb2996c0",
      "name": "macos-media-runtime / Confined native x86_64 media runtime",
      "status": "completed",
      "conclusion": "success",
      "failedSteps": []
    },
    {
      "id": 131283456795,
      "run_id": 43246997392,
      "run_attempt": 1,
      "head_sha": "61b13db998f421bdd10c5b1949fa1af8fb2996c0",
      "name": "macos-media-runtime / Confined native arm64 media runtime",
      "status": "completed",
      "conclusion": "success",
      "failedSteps": []
    },
    {
      "id": 131334107752,
      "run_id": 43246997392,
      "run_attempt": 1,
      "head_sha": "61b13db998f421bdd10c5b1949fa1af8fb2996c0",
      "name": "release (macos-15-intel, macos, x86_64, x86_64-apple-darwin, darwin-x64, --target x86_64-apple-da...",
      "status": "completed",
      "conclusion": "failure",
      "failedSteps": [
        {
          "name": "Test frontend",
          "number": 30,
          "status": "completed",
          "conclusion": "failure"
        }
      ]
    },
    {
      "id": 131334107765,
      "run_id": 43246997392,
      "run_attempt": 1,
      "head_sha": "61b13db998f421bdd10c5b1949fa1af8fb2996c0",
      "name": "release (ubuntu-24.04, linux, --bundles deb,appimage)",
      "status": "completed",
      "conclusion": "success",
      "failedSteps": []
    },
    {
      "id": 131334107801,
      "run_id": 43246997392,
      "run_attempt": 1,
      "head_sha": "61b13db998f421bdd10c5b1949fa1af8fb2996c0",
      "name": "release (windows-latest, windows)",
      "status": "completed",
      "conclusion": "failure",
      "failedSteps": [
        {
          "name": "Test frontend",
          "number": 30,
          "status": "completed",
          "conclusion": "failure"
        }
      ]
    },
    {
      "id": 131334107821,
      "run_id": 43246997392,
      "run_attempt": 1,
      "head_sha": "61b13db998f421bdd10c5b1949fa1af8fb2996c0",
      "name": "release (macos-15, macos, arm64, aarch64-apple-darwin, darwin-arm64, --target aarch64-apple-darwin)",
      "status": "completed",
      "conclusion": "success",
      "failedSteps": []
    },
    {
      "id": 131352967821,
      "run_id": 43246997392,
      "run_attempt": 1,
      "head_sha": "61b13db998f421bdd10c5b1949fa1af8fb2996c0",
      "name": "Signed Android TV APK",
      "status": "completed",
      "conclusion": "skipped",
      "failedSteps": []
    },
    {
      "id": 131352968547,
      "run_id": 43246997392,
      "run_attempt": 1,
      "head_sha": "61b13db998f421bdd10c5b1949fa1af8fb2996c0",
      "name": "Signed Android phone APK",
      "status": "completed",
      "conclusion": "skipped",
      "failedSteps": []
    },
    {
      "id": 131352975149,
      "run_id": 43246997392,
      "run_attempt": 1,
      "head_sha": "61b13db998f421bdd10c5b1949fa1af8fb2996c0",
      "name": "Publish signed Android phone APK",
      "status": "completed",
      "conclusion": "skipped",
      "failedSteps": []
    },
    {
      "id": 131352980631,
      "run_id": 43246997392,
      "run_attempt": 1,
      "head_sha": "61b13db998f421bdd10c5b1949fa1af8fb2996c0",
      "name": "Checksums and provenance",
      "status": "completed",
      "conclusion": "skipped",
      "failedSteps": []
    },
    {
      "id": 131352985948,
      "run_id": 43246997392,
      "run_attempt": 1,
      "head_sha": "61b13db998f421bdd10c5b1949fa1af8fb2996c0",
      "name": "Verify clean installs",
      "status": "completed",
      "conclusion": "skipped",
      "failedSteps": []
    }
  ],
  [
    {
      "id": 131359049777,
      "run_id": 43246997392,
      "run_attempt": 2,
      "head_sha": "61b13db998f421bdd10c5b1949fa1af8fb2996c0",
      "name": "Resolve explicit release scope",
      "status": "completed",
      "conclusion": "success",
      "failedSteps": []
    },
    {
      "id": 131359052037,
      "run_id": 43246997392,
      "run_attempt": 2,
      "head_sha": "61b13db998f421bdd10c5b1949fa1af8fb2996c0",
      "name": "macos-media-runtime / Retrieve the pinned private source seed",
      "status": "completed",
      "conclusion": "success",
      "failedSteps": []
    },
    {
      "id": 131359052706,
      "run_id": 43246997392,
      "run_attempt": 2,
      "head_sha": "61b13db998f421bdd10c5b1949fa1af8fb2996c0",
      "name": "release (macos-15-intel, macos, x86_64, x86_64-apple-darwin, darwin-x64, --target x86_64-apple-da...",
      "status": "completed",
      "conclusion": "success",
      "failedSteps": []
    },
    {
      "id": 131359053031,
      "run_id": 43246997392,
      "run_attempt": 2,
      "head_sha": "61b13db998f421bdd10c5b1949fa1af8fb2996c0",
      "name": "macos-media-runtime / Prepare one exact corresponding-source archive",
      "status": "completed",
      "conclusion": "success",
      "failedSteps": []
    },
    {
      "id": 131359053229,
      "run_id": 43246997392,
      "run_attempt": 2,
      "head_sha": "61b13db998f421bdd10c5b1949fa1af8fb2996c0",
      "name": "macos-media-runtime / Confined native arm64 media runtime",
      "status": "completed",
      "conclusion": "success",
      "failedSteps": []
    },
    {
      "id": 131359055016,
      "run_id": 43246997392,
      "run_attempt": 2,
      "head_sha": "61b13db998f421bdd10c5b1949fa1af8fb2996c0",
      "name": "release (ubuntu-24.04, linux, --bundles deb,appimage)",
      "status": "completed",
      "conclusion": "success",
      "failedSteps": []
    },
    {
      "id": 131359055164,
      "run_id": 43246997392,
      "run_attempt": 2,
      "head_sha": "61b13db998f421bdd10c5b1949fa1af8fb2996c0",
      "name": "macos-media-runtime / Confined native x86_64 media runtime",
      "status": "completed",
      "conclusion": "success",
      "failedSteps": []
    },
    {
      "id": 131359055235,
      "run_id": 43246997392,
      "run_attempt": 2,
      "head_sha": "61b13db998f421bdd10c5b1949fa1af8fb2996c0",
      "name": "release (macos-15, macos, arm64, aarch64-apple-darwin, darwin-arm64, --target aarch64-apple-darwin)",
      "status": "completed",
      "conclusion": "success",
      "failedSteps": []
    },
    {
      "id": 131359056212,
      "run_id": 43246997392,
      "run_attempt": 2,
      "head_sha": "61b13db998f421bdd10c5b1949fa1af8fb2996c0",
      "name": "release (windows-latest, windows)",
      "status": "completed",
      "conclusion": "failure",
      "failedSteps": [
        {
          "name": "Test frontend",
          "number": 30,
          "status": "completed",
          "conclusion": "failure"
        }
      ]
    },
    {
      "id": 131381119421,
      "run_id": 43246997392,
      "run_attempt": 2,
      "head_sha": "61b13db998f421bdd10c5b1949fa1af8fb2996c0",
      "name": "Signed Android phone APK",
      "status": "completed",
      "conclusion": "skipped",
      "failedSteps": []
    },
    {
      "id": 131381120143,
      "run_id": 43246997392,
      "run_attempt": 2,
      "head_sha": "61b13db998f421bdd10c5b1949fa1af8fb2996c0",
      "name": "Publish signed Android phone APK",
      "status": "completed",
      "conclusion": "skipped",
      "failedSteps": []
    },
    {
      "id": 131381120404,
      "run_id": 43246997392,
      "run_attempt": 2,
      "head_sha": "61b13db998f421bdd10c5b1949fa1af8fb2996c0",
      "name": "Signed Android TV APK",
      "status": "completed",
      "conclusion": "skipped",
      "failedSteps": []
    },
    {
      "id": 131381121619,
      "run_id": 43246997392,
      "run_attempt": 2,
      "head_sha": "61b13db998f421bdd10c5b1949fa1af8fb2996c0",
      "name": "Checksums and provenance",
      "status": "completed",
      "conclusion": "skipped",
      "failedSteps": []
    },
    {
      "id": 131381122931,
      "run_id": 43246997392,
      "run_attempt": 2,
      "head_sha": "61b13db998f421bdd10c5b1949fa1af8fb2996c0",
      "name": "Verify clean installs",
      "status": "completed",
      "conclusion": "skipped",
      "failedSteps": []
    }
  ]
]);

export const ASSETS = Object.freeze(ORIGINAL_ASSET_PINS.map(asset => asset.name));
const DERIVED_NAMES = Object.freeze([...ASSETS, 'latest-macos11.json'].sort());
const FINAL_NAMES = Object.freeze([...DERIVED_NAMES, 'SHA256SUMS'].sort());
function requireThat(ok, message) { if (!ok) throw new Error(message); }
function same(actual, expected) { return JSON.stringify(actual) === JSON.stringify(expected); }
function sameNames(actual, expected) { return same([...actual].sort(), [...expected].sort()); }
function exactKeys(value, keys, message) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value) && sameNames(Object.keys(value), keys), message);
}
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function canonicalDirectory(directory) {
  requireThat(typeof directory === 'string' && path.isAbsolute(directory) && path.resolve(directory) === directory &&
    lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink() && realpathSync(directory) === directory,
  'Artifact directory is not canonical');
  return directory;
}
function readRegular(file, expectedSize) {
  const before = lstatSync(file);
  requireThat(before.isFile() && !before.isSymbolicLink() && (expectedSize === undefined || before.size === expectedSize),
    `Regular file identity/size changed: ${path.basename(file)}`);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    requireThat(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino && opened.size === before.size,
      'Opened artifact identity changed');
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    requireThat(bytes.length === opened.size && after.size === opened.size && after.mtimeMs === opened.mtimeMs &&
      after.ctimeMs === opened.ctimeMs, 'Artifact changed while hashing');
    return bytes;
  } finally { closeSync(fd); }
}
function readJson(file) {
  requireThat(lstatSync(file).size <= 1024 * 1024, 'Metadata exceeds its bound');
  return JSON.parse(readRegular(file).toString('utf8'));
}
function writeJson(file, value) {
  const absolute = path.resolve(file);
  canonicalDirectory(path.dirname(absolute));
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}
function releaseIdentity(release) {
  requireThat(release && release.id === RELEASE_ID && release.url === API_RELEASE && release.tag_name === TAG &&
    release.target_commitish === SOURCE && release.draft === true && release.prerelease === false &&
    release.published_at === null, 'Exact draft identity/source/state changed');
}
function projectJob(job) {
  requireThat(job && Array.isArray(job.steps) && job.steps.every(step => step && typeof step.name === 'string' &&
    Number.isSafeInteger(step.number) && step.number > 0 && step.status === 'completed' &&
    ['success', 'failure', 'skipped'].includes(step.conclusion)), 'Job step metadata is missing or active');
  return Object.fromEntries([
    ...['id', 'run_id', 'run_attempt', 'head_sha', 'name', 'status', 'conclusion'].map(key => [key, job[key]]),
    ['failedSteps', job.steps.filter(step => step.conclusion === 'failure').map(step =>
      Object.fromEntries(['name', 'number', 'status', 'conclusion'].map(key => [key, step[key]])))],
  ]);
}
function verifyJobs(inventory, attempt) {
  requireThat(inventory && Array.isArray(inventory.jobs) && inventory.total_count === JOB_PINS[attempt - 1].length &&
    inventory.jobs.length === inventory.total_count, `Attempt${attempt} job inventory is incomplete or extra`);
  const actual = inventory.jobs.map(projectJob).sort((a, b) => a.id - b.id);
  requireThat(same(actual, JOB_PINS[attempt - 1]), `Attempt${attempt} exact job identities/state/failure lineage changed`);
}
function assetMetadata(asset, expected, pinId) {
  requireThat(asset && Number.isSafeInteger(asset.id) && asset.id > 0 && asset.name === expected.name &&
    asset.state === 'uploaded' && asset.size === expected.size && asset.digest === `sha256:${expected.sha256}` &&
    asset.url === `https://api.github.com/repos/${REPOSITORY}/releases/assets/${asset.id}`,
  `Asset immutable size/digest/metadata changed: ${expected.name}`);
  if (pinId) requireThat(asset.id === expected.id, `Original asset ID changed: ${expected.name}`);
}
function contained(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function createAdmission(pins) {
  const originalByName = new Map(pins.map(asset => [asset.name, asset]));
  const preserved = pins.filter(asset => asset.name !== 'latest.json');
  function originalRelease(release) {
    releaseIdentity(release);
    requireThat(Array.isArray(release.assets) && sameNames(release.assets.map(asset => asset.name), ASSETS),
      'Original14 asset inventory changed');
    for (const asset of release.assets) assetMetadata(asset, originalByName.get(asset.name), true);
  }
  function checkedFiles(directory, expectedRows) {
    canonicalDirectory(directory);
    requireThat(sameNames(readdirSync(directory), expectedRows.map(asset => asset.name)), 'Downloaded inventory changed');
    return expectedRows.map(asset => {
      const sha256 = digest(readRegular(path.join(directory, asset.name), asset.size));
      requireThat(sha256 === asset.sha256, `Downloaded pinned digest changed: ${asset.name}`);
      return { name: asset.name, size: asset.size, sha256 };
    });
  }
  function admit({ release, run, jobs1, jobs2, ref, heldTag, windows }) {
    requireThat(heldTag === TAG && (windows === '' || windows === 'false'), 'Desktop-only and held-Windows scope changed');
    originalRelease(release);
    requireThat(ref?.ref === `refs/tags/${TAG}` && ref.object?.type === 'commit' && ref.object.sha === SOURCE,
      'Immutable tag changed');
    requireThat(run && run.id === PRODUCER && run.run_attempt === 2 && run.run_number === 185 &&
      run.workflow_id === 299659497 && run.repository?.full_name === REPOSITORY && run.head_sha === SOURCE &&
      run.head_branch === TAG && run.event === 'push' && run.path === '.github/workflows/web-release.yml' &&
      run.status === 'completed' && run.conclusion === 'failure', 'Exact producer attempt2 identity/state changed');
    verifyJobs(jobs1, 1);
    verifyJobs(jobs2, 2);
    return { tag: TAG, source: SOURCE, releaseId: RELEASE_ID, producer: PRODUCER, producerAttempt: 2,
      initialIntelFrontendFailureRetained: true, intelAttempt2SuccessObserved: true,
      heldWindowsFrontendFailureRetained: true, windowsQualified: false,
      publishAuthorizedByThisGate: false, finalizedOrCleanInstalled: false };
  }
  function verifyDownloadedAssets(release, directory) {
    originalRelease(release);
    return checkedFiles(directory, pins);
  }
  function feeds(directory) {
    const fullBytes = readRegular(path.join(directory, 'latest-macos11.json'));
    const full = JSON.parse(fullBytes.toString('utf8'));
    const targets = {
      'darwin-aarch64': 'YAWF.Stream_aarch64.app.tar.gz',
      'darwin-aarch64-app': 'YAWF.Stream_aarch64.app.tar.gz',
      'darwin-x86_64': 'YAWF.Stream_x64.app.tar.gz',
      'darwin-x86_64-app': 'YAWF.Stream_x64.app.tar.gz',
      'linux-x86_64': 'YAWF.Stream_2.3.102_amd64.AppImage',
      'linux-x86_64-appimage': 'YAWF.Stream_2.3.102_amd64.AppImage',
      'linux-x86_64-deb': 'YAWF.Stream_2.3.102_amd64.deb',
    };
    requireThat(full.version === '2.3.102' && full.platforms && sameNames(Object.keys(full.platforms), Object.keys(targets)),
      'Derived feed target scope changed');
    for (const [key, name] of Object.entries(targets)) {
      requireThat(full.platforms[key].url === `https://github.com/${REPOSITORY}/releases/download/${TAG}/${name}` &&
        full.platforms[key].signature === readRegular(path.join(directory, `${name}.sig`)).toString('utf8').trim(),
      `Derived feed URL/signature changed: ${key}`);
    }
    const legacy = structuredClone(full);
    delete legacy.platforms['darwin-x86_64'];
    delete legacy.platforms['darwin-x86_64-app'];
    requireThat(fullBytes.equals(Buffer.from(`${JSON.stringify(full, null, 2)}\n`)) &&
      readRegular(path.join(directory, 'latest.json')).equals(Buffer.from(`${JSON.stringify(legacy, null, 2)}\n`)),
    'Derived feed bytes do not match the deterministic split');
  }
  function checksums(directory, rows) {
    const text = readRegular(path.join(directory, 'SHA256SUMS')).toString('utf8');
    requireThat(text.endsWith('\n'), 'Checksum list has no terminal newline');
    const lines = text.slice(0, -1).split('\n');
    const entries = lines.map(line => /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/.exec(line));
    requireThat(entries.every(Boolean) && sameNames(entries.map(entry => entry[2]), DERIVED_NAMES),
      'Checksum list is incomplete, duplicate or extra');
    for (const entry of entries) requireThat(rows.find(row => row.name === entry[2])?.sha256 === entry[1],
      'Checksum row digest changed');
  }
  function inventory(directory) {
    canonicalDirectory(directory);
    requireThat(sameNames(readdirSync(directory), FINAL_NAMES), 'Expected local16 inventory changed');
    checkedFilesSubset(directory, preserved);
    feeds(directory);
    const assets = FINAL_NAMES.map(name => {
      const bytes = readRegular(path.join(directory, name));
      return { name, size: bytes.length, sha256: digest(bytes) };
    });
    checksums(directory, assets);
    return { schemaVersion: 1, releaseId: RELEASE_ID, tag: TAG, source: SOURCE, producer: PRODUCER,
      producerAttempt: 2, sourceDirectory: directory, assets };
  }
  function checkedFilesSubset(directory, rows) {
    for (const row of rows) requireThat(digest(readRegular(path.join(directory, row.name), row.size)) === row.sha256,
      `Preserved original13 digest changed: ${row.name}`);
  }
  function verifyDerivedInventory(expected, release, directory, stage) {
    requireThat(stage === 'derived' || stage === 'final', 'Derived verification stage is invalid');
    exactKeys(expected, ['schemaVersion', 'releaseId', 'tag', 'source', 'producer', 'producerAttempt', 'sourceDirectory', 'assets'],
      'Expected local inventory keys changed');
    requireThat(expected.schemaVersion === 1 && expected.releaseId === RELEASE_ID && expected.tag === TAG &&
      expected.source === SOURCE && expected.producer === PRODUCER && expected.producerAttempt === 2 &&
      typeof expected.sourceDirectory === 'string' && path.isAbsolute(expected.sourceDirectory) &&
      path.resolve(expected.sourceDirectory) === expected.sourceDirectory, 'Expected local scope changed');
    requireThat(Array.isArray(expected.assets) && sameNames(expected.assets.map(asset => asset.name), FINAL_NAMES),
      'Expected local asset set changed');
    for (const row of expected.assets) {
      exactKeys(row, ['name', 'size', 'sha256'], 'Expected asset keys changed');
      requireThat(Number.isSafeInteger(row.size) && row.size > 0 && SHA256.test(row.sha256), 'Expected asset hash/size missing');
    }
    for (const pin of preserved) requireThat(expected.assets.some(row => row.name === pin.name &&
      row.size === pin.size && row.sha256 === pin.sha256), `Expected original13 pin changed: ${pin.name}`);
    canonicalDirectory(directory);
    requireThat(!contained(expected.sourceDirectory, directory) && !contained(directory, expected.sourceDirectory),
      'Remote verification requires a separate clean directory');
    releaseIdentity(release);
    const names = stage === 'derived' ? DERIVED_NAMES : FINAL_NAMES;
    requireThat(Array.isArray(release.assets) && sameNames(release.assets.map(asset => asset.name), names),
      'Remote derived/final asset inventory changed');
    requireThat(new Set(release.assets.map(asset => asset.id)).size === names.length, 'Remote asset IDs are duplicated');
    for (const asset of release.assets) {
      const row = expected.assets.find(entry => entry.name === asset.name);
      assetMetadata(asset, { ...row, id: originalByName.get(row.name)?.id }, row.name !== 'latest.json' && row.name !== 'latest-macos11.json' && row.name !== 'SHA256SUMS');
      if (!preserved.some(pin => pin.name === asset.name)) requireThat(!pins.some(pin => pin.id === asset.id),
        'Derived asset incorrectly reuses an original asset ID');
    }
    const rows = checkedFiles(directory, expected.assets.filter(row => names.includes(row.name)));
    feeds(directory);
    if (stage === 'final') checksums(directory, rows);
    return { tag: TAG, source: SOURCE, releaseId: RELEASE_ID, stage, assets: rows,
      unchangedOriginalAssets: 13, publishAuthorizedByThisGate: false, cleanInstallQualified: false };
  }
  return { admit, verifyDownloadedAssets, inventory, verifyDerivedInventory };
}
const production = createAdmission(ORIGINAL_ASSET_PINS);
export const admit = production.admit;
export const verifyDownloadedAssets = production.verifyDownloadedAssets;
export const inventory = production.inventory;
export const verifyDerivedInventory = production.verifyDerivedInventory;

// Only the exact Node test entrypoint can substitute tiny byte fixtures. CLI pins never vary.
export function createTestAdmission(pins) {
  requireThat(process.env.NODE_TEST_CONTEXT && path.basename(process.argv[1] ?? '') === 'admit_desktop102_finalization.test.mjs',
    'Pin injection is restricted to the exact Node test entrypoint');
  requireThat(Array.isArray(pins) && pins.length === ORIGINAL_ASSET_PINS.length && pins.every((pin, i) =>
    pin.id === ORIGINAL_ASSET_PINS[i].id && pin.name === ORIGINAL_ASSET_PINS[i].name &&
    Number.isSafeInteger(pin.size) && pin.size > 0 && SHA256.test(pin.sha256)), 'Test pins changed asset identity');
  return createAdmission(freeze(structuredClone(pins)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'admit') {
    const [releaseFile, runFile, jobs1File, jobs2File, refFile, directory, receipt] = args;
    requireThat(args.length === 7, 'Usage: admit RELEASE RUN JOBS1 JOBS2 REF ARTIFACT_DIR RECEIPT');
    const release = readJson(releaseFile);
    const admission = admit({ release, run: readJson(runFile), jobs1: readJson(jobs1File), jobs2: readJson(jobs2File), ref: readJson(refFile),
      heldTag: process.env.HELD_DESKTOP_TAG, windows: process.env.RELEASE_WINDOWS ?? '' });
    writeJson(receipt, { ...admission, assets: verifyDownloadedAssets(release, directory) });
  } else if (mode === 'inventory') {
    requireThat(args.length === 2, 'Usage: inventory DIR OUT');
    writeJson(args[1], inventory(args[0]));
  } else if (mode === 'verify-derived' || mode === 'verify-final') {
    requireThat(args.length === 4, 'Usage: verify-derived|verify-final EXPECTED RELEASE REMOTEDIR RECEIPT');
    writeJson(args[3], verifyDerivedInventory(readJson(args[0]), readJson(args[1]), args[2], mode === 'verify-derived' ? 'derived' : 'final'));
  } else throw new Error('Expected admit, inventory, verify-derived or verify-final');
}
