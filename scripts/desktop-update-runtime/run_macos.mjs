#!/usr/bin/env node
// Disposable hosted-runner qualification, never a release or a user install.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { startRuntimeService, verifyRuntimeEvents } from './runtime-service.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const web = join(root, 'web');
const baseVersion = '2.3.101', nextVersion = '2.3.102';
const fixtureName = 'YAWF Update Runtime Fixture';
export const fixtureIdentifier = 'com.yawf.tests.desktopupdateruntime';
export const pinnedMedia = {
  arm64: { name: 'YAWF.Stream_aarch64.app.tar.gz', sha256: 'cfe12194369b71390b31d779577bdbc4c03994b4b719dbe16910275415802bd7' },
  x64: { name: 'YAWF.Stream_x64.app.tar.gz', sha256: '1eb7dca34cfc383c20ec35857c4d345fd0d13c9882590805fb32540e5a06dba4' },
};
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function fixtureConfig({ version, publicKey, baseUrl, frontend, frameworks }) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error('Only the disposable loopback feed is allowed');
  if (![baseVersion, nextVersion].includes(version) || !publicKey || !frameworks.length) throw new Error('Invalid test-only bundle inputs');
  return {
    productName: fixtureName, identifier: fixtureIdentifier, version,
    build: { beforeBuildCommand: '', frontendDist: frontend },
    bundle: { resources: [], targets: ['app'], createUpdaterArtifacts: false, macOS: { frameworks, signingIdentity: null } },
    plugins: { updater: { endpoints: [`${url.origin}/latest.json`], pubkey: publicKey, dangerousInsecureTransportProtocol: true } },
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, env: process.env, encoding: 'utf8', timeout: 35 * 60_000, maxBuffer: 16 * 1024 * 1024, ...options });
  if (options.log) throw new Error('Use a file descriptor for bounded build output');
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${(result.stderr ?? result.error?.message ?? '').slice(-2000)}`);
  return result.stdout?.trim() ?? '';
}

async function filesBelow(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function exactPids(executable) {
  return run('/bin/ps', ['-axo', 'pid=,command=']).split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    return match && match[2] === executable ? [Number(match[1])] : [];
  });
}

export async function runMacosQualification() {
  if (process.platform !== 'darwin' || process.env.GITHUB_ACTIONS !== 'true' || !process.env.RUNNER_TEMP) throw new Error('This test may run only on a disposable GitHub macOS runner');
  if (!pinnedMedia[process.arch]) throw new Error('Unsupported native test architecture');
  const temporaryRoot = resolve(process.env.RUNNER_TEMP);
  const workspace = await mkdtemp(join(temporaryRoot, 'yawf-update-runtime-'));
  if (!workspace.startsWith(`${temporaryRoot}${sep}`)) throw new Error('Invalid disposable test directory');
  const evidence = join(temporaryRoot, 'desktop-update-runtime-evidence');
  await mkdir(evidence, { recursive: true });
  const privateDirectory = join(workspace, 'private');
  await mkdir(privateDirectory, { mode: 0o700 });
  const runtimeConfig = join(root, 'scripts/desktop-update-runtime/runtime-config.json');
  const inheritedSigning = /^(APPLE_|TAURI_SIGNING_|GH_TOKEN$|GITHUB_TOKEN$)/;
  const cleanEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !inheritedSigning.test(name)));
  let service, executable, child, stdout, stderr;
  const receipt = { schemaVersion: 1, classification: 'disposable-native-qualification-not-release', source: run('git', ['rev-parse', 'HEAD']), arch: process.arch, baseVersion, nextVersion, startedAt: new Date().toISOString(), passed: false };
  try {
    const pinned = pinnedMedia[process.arch];
    const release = await fetch(`https://github.com/Tgk-30/YAWF-Stream/releases/download/v2.3.58-web/${pinned.name}`, { signal: AbortSignal.timeout(120_000) });
    if (!release.ok) throw new Error(`Pinned public media package returned ${release.status}`);
    const bytes = Buffer.from(await release.arrayBuffer());
    if (digest(bytes) !== pinned.sha256) throw new Error('Pinned media package hash mismatch');
    const mediaArchive = join(workspace, 'media.tar.gz'); await writeFile(mediaArchive, bytes);
    const mediaRoot = join(workspace, 'media'); await mkdir(mediaRoot);
    const listing = run('/usr/bin/tar', ['-tzf', mediaArchive]).split('\n');
    if (listing.some((name) => name.startsWith('/') || name.split('/').includes('..'))) throw new Error('Unsafe pinned package path');
    run('/usr/bin/tar', ['-xzf', mediaArchive, '-C', mediaRoot]);
    const originalApp = join(mediaRoot, 'YAWF Stream.app');
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', originalApp]);
    const frameworkDirectory = join(originalApp, 'Contents/Frameworks');
    const frameworks = (await filesBelow(frameworkDirectory)).filter((path) => path.endsWith('.dylib'));
    if (!frameworks.some((path) => /libmpv(?:\.\d+)*\.dylib$/.test(path))) throw new Error('Pinned signed package lacks libmpv');
    const ffmpeg = (await filesBelow(join(originalApp, 'Contents/Resources'))).find((path) => path.endsWith('/ffmpeg'));
    if (!ffmpeg) throw new Error('Pinned signed package lacks FFmpeg');
    const mediaPath = join(workspace, 'fixture.mp4');
    run(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '40', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', mediaPath]);
    const cli = join(web, 'node_modules/@tauri-apps/cli/tauri.js');
    const key = join(privateDirectory, 'fixture.key');
    // No production secrets, no key bytes in stdout or evidence artifacts.
    run(process.execPath, [cli, 'signer', 'generate', '--ci', '--write-keys', key, '--password', ''], { cwd: web, env: cleanEnvironment });
    await chmod(key, 0o600);
    const publicKey = (await readFile(`${key}.pub`, 'utf8')).trim();
    let signature = '';
    const archivePath = join(workspace, 'update.tar.gz');
    const runId = randomUUID();
    service = await startRuntimeService({ runId, mediaPath, archivePath, signature: () => signature, baseVersion, nextVersion });
    await writeFile(runtimeConfig, `${JSON.stringify({ runId, baseUrl: service.address, baseVersion, nextVersion })}\n`);
    const fixtureRoot = join(web, '.build/desktop-update-runtime');
    await mkdir(fixtureRoot, { recursive: true });
    await writeFile(join(fixtureRoot, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Disposable update qualification</title></head><body><div id="root"></div><script type="module" src="../../../scripts/desktop-update-runtime/fixture-driver.tsx"></script></body></html>');
    const frontend = join(workspace, 'frontend');
    const vite = await import(pathToFileURL(join(web, 'node_modules/vite/dist/node/index.js')).href);
    await vite.build({ configFile: false, root: fixtureRoot, publicDir: false,
      resolve: { alias: { react: join(web, 'node_modules/react'), 'react-dom': join(web, 'node_modules/react-dom'), '@tauri-apps': join(web, 'node_modules/@tauri-apps') } },
      esbuild: { jsx: 'automatic' }, build: { target: 'chrome90', outDir: frontend, emptyOutDir: true } });
    const nativeEnvironment = { ...cleanEnvironment, MPV_LIB_DIR: frameworkDirectory, MACOSX_DEPLOYMENT_TARGET: '11.0' };
    for (const version of [baseVersion, nextVersion]) {
      const configPath = join(workspace, `tauri-${version}.json`);
      await writeFile(configPath, JSON.stringify(fixtureConfig({ version, publicKey, baseUrl: service.address, frontend, frameworks })));
      const logPath = join(evidence, `build-${version}.log`);
      const { open } = await import('node:fs/promises'); const log = await open(logPath, 'w');
      try { run(process.execPath, [cli, 'build', '--ci', '--bundles', 'app', '--no-sign', '--config', configPath], { cwd: web, env: nativeEnvironment, stdio: ['ignore', log.fd, log.fd] }); }
      finally { await log.close(); }
      const bundle = join(web, 'src-tauri/target/release/bundle/macos', `${fixtureName}.app`);
      run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--options', 'runtime', '--entitlements', join(web, 'src-tauri/entitlements.plist'), bundle]);
      run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
      const versionRoot = join(workspace, version); await mkdir(versionRoot); await cp(bundle, join(versionRoot, `${fixtureName}.app`), { recursive: true, verbatimSymlinks: true });
    }
    const nextApp = join(workspace, nextVersion, `${fixtureName}.app`);
    run('/usr/bin/tar', ['-czf', archivePath, '-C', dirname(nextApp), `${fixtureName}.app`]);
    run(process.execPath, [cli, 'signer', 'sign', '--private-key-path', key, '--password', '', '--app-version', nextVersion, archivePath], { cwd: web, env: cleanEnvironment });
    signature = (await readFile(`${archivePath}.sig`, 'utf8')).trim();
    await rm(privateDirectory, { recursive: true, force: true });
    const home = join(workspace, 'home'), installed = join(workspace, 'Applications', `${fixtureName}.app`);
    await mkdir(home); await mkdir(dirname(installed));
    await cp(join(workspace, baseVersion, `${fixtureName}.app`), installed, { recursive: true, verbatimSymlinks: true });
    const marker = join(home, 'preserved-user-data.txt'); await writeFile(marker, runId);
    executable = join(installed, 'Contents/MacOS/debridstreamer');
    const targetExecutableHash = digest(await readFile(join(nextApp, 'Contents/MacOS/debridstreamer')));
    const initialExecutableHash = digest(await readFile(executable));
    if (initialExecutableHash === targetExecutableHash) throw new Error('Two native versions unexpectedly have identical executables');
    stdout = createWriteStream(join(evidence, 'native-stdout.log')); stderr = createWriteStream(join(evidence, 'native-stderr.log'));
    child = spawn(executable, [], { cwd: workspace, env: { ...cleanEnvironment, HOME: home, CFFIXED_USER_HOME: home, TMPDIR: `${workspace}/`, XDG_DATA_HOME: join(home, 'data'), XDG_CONFIG_HOME: join(home, 'config') }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(stdout); child.stderr.pipe(stderr);
    receipt.initialPid = child.pid;
    let oldExit = null; child.on('exit', (code, signal) => { oldExit = { code, signal, observedAt: new Date().toISOString() }; });
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline && !service.events.some((event) => ['completed', 'failed'].includes(event.stage))) await sleep(200);
    const verification = verifyRuntimeEvents(service.events, service.requests, baseVersion, nextVersion);
    const running = exactPids(executable);
    if (!oldExit || running.length !== 1 || running[0] === child.pid) throw new Error('No independently observed old-process exit and successor process');
    if (digest(await readFile(executable)) !== targetExecutableHash) throw new Error('Installed native executable is not the signed target');
    const installedVersion = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(installed, 'Contents/Info.plist')]);
    if (installedVersion !== nextVersion || await readFile(marker, 'utf8') !== runId) throw new Error('Native installed version or preserved user-data marker mismatch');
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', installed]);
    Object.assign(receipt, { passed: true, verification, initialExecutableHash, targetExecutableHash, archiveSha256: digest(await readFile(archivePath)), mediaPackageSha256: pinned.sha256, oldExit, successorPid: running[0], installedVersion, isolatedDataPreserved: true, scope: 'Real AppKit/libmpv IPC and ephemeral-key-signed updater apply/relaunch in a disposable test identity. Not Developer ID, notarization, physical media output, or user-installed update qualification.' });
  } catch (error) { receipt.error = String(error.message).slice(0, 2000); throw error; }
  finally {
    receipt.finishedAt = new Date().toISOString();
    await rm(privateDirectory, { recursive: true, force: true });
    await rm(runtimeConfig, { force: true });
    if (executable) {
      for (const pid of exactPids(executable)) { try { process.kill(pid, 'SIGTERM'); } catch { /* Process may already have exited. */ } }
      for (let attempt = 0; attempt < 20 && exactPids(executable).length; attempt++) await sleep(100);
      for (const pid of exactPids(executable)) { try { process.kill(pid, 'SIGKILL'); } catch { /* Process may already have exited. */ } }
      for (let attempt = 0; attempt < 20 && exactPids(executable).length; attempt++) await sleep(100);
      receipt.remainingFixtureProcesses = exactPids(executable).length;
      if (receipt.remainingFixtureProcesses) { receipt.passed = false; receipt.cleanupError = 'Disposable native processes remained alive'; }
    }
    child?.stdout?.destroy(); child?.stderr?.destroy(); stdout?.end(); stderr?.end();
    if (service) {
      await writeFile(join(evidence, 'events.json'), JSON.stringify(service.events, null, 2));
      await writeFile(join(evidence, 'requests.json'), JSON.stringify(service.requests, null, 2));
      await service.close();
    }
    await writeFile(join(evidence, 'RESULTS.json'), JSON.stringify(receipt, null, 2));
  }
  if (!receipt.passed) throw new Error(receipt.cleanupError ?? 'Native qualification failed');
  console.log('Native updater fixture completed. Evidence is test-only, not a release.');
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3 || process.argv[2] !== '--run') throw new Error('Usage: node scripts/desktop-update-runtime/run_macos.mjs --run (disposable hosted macOS runner only)');
  await runMacosQualification();
}
