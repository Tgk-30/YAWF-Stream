#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const MAX_CAPTURE_BYTES = 64 * 1024;

function fail(message) {
  throw new Error(message);
}

function exactOption(options, name) {
  const value = options.get(name);
  if (value == null || value.length === 0) fail(`Missing required ${name} option.`);
  return value;
}

function boundedInteger(value, name, minimum, maximum) {
  if (!/^\d+$/.test(value)) fail(`${name} must be an integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

export function parseArgs(argv) {
  const allowed = new Set([
    "--expected-version",
    "--server-entry",
    "--web-dist",
    "--receipt",
    "--startup-timeout-ms",
    "--request-timeout-ms",
  ]);
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (typeof name !== "string" || !allowed.has(name)) fail(`Unknown option ${name ?? "<missing>"}.`);
    if (typeof value !== "string" || value.startsWith("--")) fail(`Missing value for ${name}.`);
    if (options.has(name)) fail(`Duplicate option ${name}.`);
    options.set(name, value);
  }

  const expectedVersion = exactOption(options, "--expected-version");
  if (!/^\d+\.\d+\.\d+$/.test(expectedVersion)) {
    fail("--expected-version must be an exact numeric patch version.");
  }
  const serverEntry = resolve(exactOption(options, "--server-entry"));
  const webDist = resolve(exactOption(options, "--web-dist"));
  const receiptValue = options.get("--receipt");
  const receipt = receiptValue == null ? null : resolve(receiptValue);

  return {
    expectedVersion,
    serverEntry,
    webDist,
    receipt,
    startupTimeoutMs: boundedInteger(
      options.get("--startup-timeout-ms") ?? String(DEFAULT_STARTUP_TIMEOUT_MS),
      "--startup-timeout-ms",
      1_000,
      60_000,
    ),
    requestTimeoutMs: boundedInteger(
      options.get("--request-timeout-ms") ?? String(DEFAULT_REQUEST_TIMEOUT_MS),
      "--request-timeout-ms",
      500,
      30_000,
    ),
  };
}

export function assertSupportedRuntime(version = process.versions.node) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (match == null || Number(match[1]) < 24) {
    fail(`Packaged server smoke requires Node 24 or newer, found ${version}.`);
  }
  return version;
}

export function assertNonRootRuntime(getuid = process.getuid) {
  if (typeof getuid === "function" && getuid() === 0) {
    fail("Packaged server smoke must run as a non-root user.");
  }
}

export function assertHealth(body, expectedSetupRequired) {
  if (
    body == null ||
    typeof body !== "object" ||
    body.ok !== true ||
    body.setupRequired !== expectedSetupRequired ||
    body.setupTokenRequired !== expectedSetupRequired
  ) {
    fail("Health response did not match the expected setup state.");
  }
}

export function assertPackageVersion(adminHealth, expectedVersion) {
  const update = adminHealth?.update;
  if (
    adminHealth?.ok !== true ||
    update?.currentVersion !== expectedVersion ||
    update?.latestVersion !== null ||
    update?.available !== false
  ) {
    fail("Packaged server version or disabled update-check state did not match the smoke contract.");
  }
}

export function assertUnauthenticatedProfileDenied(statusCode) {
  if (statusCode !== 401) fail("Unauthenticated profile settings access was not denied.");
}

export function assertStableResourceResponse(statusCode, headers) {
  if (statusCode !== 200 || headers.get("cache-control") !== "no-cache") {
    fail("Stable hosted resource did not require HTTP revalidation.");
  }
  if (headers.get("x-content-type-options") !== "nosniff") {
    fail("Stable hosted resource was missing the nosniff header.");
  }
}

export function assertMissingResourceResponse(statusCode, headers) {
  if (
    statusCode !== 404 ||
    headers.get("cache-control") !== "no-store" ||
    headers.get("content-type")?.toLowerCase().includes("text/html")
  ) {
    fail("Missing hosted resource did not return a non-HTML, no-store 404.");
  }
}

export function assertPersistedSetting(body, key, expectedValue) {
  if (body?.settings?.[key] !== expectedValue) {
    fail("Profile setting was not persisted across the packaged server restart.");
  }
}

export function assertRestartedSession(body, expectedProfileId, expectedCsrfToken) {
  if (
    body?.session?.role !== "owner" ||
    body?.session?.profileId !== expectedProfileId ||
    body?.csrfToken !== expectedCsrfToken
  ) {
    fail("Existing owner session and CSRF state did not survive the packaged server restart.");
  }
}

function decodedAssetPath(urlValue) {
  let parsed;
  try {
    parsed = new URL(urlValue, "http://127.0.0.1");
  } catch {
    fail("Served HTML contained an invalid asset URL.");
  }
  if (parsed.origin !== "http://127.0.0.1" || !parsed.pathname.startsWith("/assets/")) return null;
  try {
    return decodeURIComponent(parsed.pathname);
  } catch {
    fail("Served HTML contained a malformed asset path.");
  }
}

export function discoverCompiledAssets(html) {
  const found = new Set();
  const attributePattern = /\b(?:src|href)=(?:"([^"]+)"|'([^']+)')/g;
  for (const match of html.matchAll(attributePattern)) {
    const path = decodedAssetPath(match[1] ?? match[2]);
    if (path != null) found.add(path);
  }
  const assets = [...found].sort();
  const scripts = assets.filter((path) => path.endsWith(".js"));
  const styles = assets.filter((path) => path.endsWith(".css"));
  if (scripts.length === 0 || styles.length === 0) {
    fail("Served HTML must reference hashed JavaScript and CSS assets.");
  }
  for (const path of [...scripts, ...styles]) {
    if (!/-[A-Za-z0-9_-]{8,}\.(?:js|css)$/.test(path)) {
      fail("Served HTML referenced an unhashed compiled JavaScript or CSS asset.");
    }
  }
  return assets;
}

function pathInside(root, candidate) {
  const value = relative(root, candidate);
  return value !== "" && !value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value);
}

async function resolveArtifactFile(webRoot, urlPath) {
  const root = await realpath(webRoot);
  const candidate = await realpath(resolve(root, `.${urlPath}`));
  if (!pathInside(root, candidate)) fail("Compiled asset escaped the supplied web distribution.");
  const info = await stat(candidate);
  if (!info.isFile()) fail("Compiled asset was not a regular file.");
  return candidate;
}

export async function listCompiledAssets(webRoot) {
  const assetsRoot = join(webRoot, "assets");
  const pending = [{ directory: assetsRoot, relativeDirectory: "assets" }];
  const paths = [];
  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await readdir(current.directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = `${current.relativeDirectory}/${entry.name}`;
      const diskPath = join(current.directory, entry.name);
      if (entry.isDirectory()) {
        pending.push({ directory: diskPath, relativeDirectory: relativePath });
      } else if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".css"))) {
        if (!/-[A-Za-z0-9_-]{8,}\.(?:js|css)$/.test(entry.name)) {
          fail("Packaged compiled JavaScript or CSS asset did not have a content hash.");
        }
        paths.push(`/${relativePath}`);
      }
      if (paths.length + pending.length > 512) {
        fail("Packaged web distribution exceeded the compiled asset count bound.");
      }
    }
  }
  paths.sort();
  if (paths.length === 0) fail("Packaged web distribution did not contain compiled assets.");
  return paths;
}

export function selectCompiledAssets(entryAssetPaths, packagedAssetPaths) {
  for (const entryPath of entryAssetPaths) {
    if (!packagedAssetPaths.includes(entryPath)) {
      fail("Served HTML referenced an asset outside the packaged compiled asset set.");
    }
  }
  return packagedAssetPaths;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sanitizeDiagnostic(message, secretValues = []) {
  let safe = String(message);
  for (const secret of secretValues) {
    if (typeof secret === "string" && secret.length > 0) safe = safe.split(secret).join("[REDACTED]");
  }
  safe = safe
    .replace(/(ds_(?:session|csrf)=)[^;\s,]+/gi, "$1[REDACTED]")
    .replace(/("(?:password|setupToken|csrfToken)"\s*:\s*")[^"]+/gi, "$1[REDACTED]");
  return safe;
}

class CookieJar {
  #cookies = new Map();

  header() {
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  get(name) {
    return this.#cookies.get(name) ?? null;
  }

  remember(headers) {
    const values = typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : (headers.get("set-cookie")?.split(/,(?=[^;,]+=)/) ?? []);
    for (const value of values) {
      const first = value.split(";", 1)[0] ?? "";
      const equals = first.indexOf("=");
      if (equals <= 0) continue;
      const name = first.slice(0, equals).trim();
      const cookieValue = first.slice(equals + 1);
      if (cookieValue.length === 0) this.#cookies.delete(name);
      else this.#cookies.set(name, cookieValue);
    }
  }
}

async function fetchBounded(url, options, timeoutMs) {
  return fetch(url, {
    ...options,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function request(baseUrl, path, { method = "GET", body, jar, csrf = false } = {}, timeoutMs) {
  const headers = new Headers({ accept: "application/json" });
  if (body !== undefined) headers.set("content-type", "application/json");
  const cookie = jar?.header();
  if (cookie) headers.set("cookie", cookie);
  if (csrf) {
    const token = jar?.get("ds_csrf");
    if (token == null) fail("Authenticated mutation did not have a CSRF cookie.");
    headers.set("x-csrf-token", token);
  }
  const response = await fetchBounded(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }, timeoutMs);
  jar?.remember(response.headers);
  return response;
}

async function jsonBody(response, contractName) {
  try {
    return await response.json();
  } catch {
    fail(`${contractName} did not return JSON.`);
  }
}

function expectStatus(response, expected, contractName) {
  if (response.status !== expected) fail(`${contractName} returned HTTP ${response.status}, expected ${expected}.`);
}

function boundedCapture(stream) {
  let output = "";
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk) => {
    output = `${output}${chunk}`.slice(-MAX_CAPTURE_BYTES);
  });
  return () => output;
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  const port = typeof address === "object" && address != null ? address.port : null;
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  if (port == null) fail("Could not reserve a loopback port for the smoke server.");
  return port;
}

function spawnPackagedServer(config, secrets, port) {
  const child = spawn(process.execPath, [config.serverEntry], {
    cwd: dirname(config.serverEntry),
    env: {
      PATH: process.env.PATH ?? "",
      HOME: config.tempRoot,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(port),
      DS_SERVER_DATA_DIR: config.dataDir,
      DS_SERVER_DB_PATH: config.databasePath,
      DS_WEB_DIST: config.webDist,
      DS_SERVER_SECRET_KEY: secrets.secretKey,
      DS_SERVER_SETUP_TOKEN: secrets.setupToken,
      DS_SERVER_COOKIE_SECURE: "false",
      DS_SERVER_ALLOW_INSECURE_PUBLIC: "false",
      DS_SERVER_TRUST_PROXY: "false",
      DS_SERVER_PUBLIC_MODE: "false",
      DS_SERVER_ALLOW_RAW_STREAM_URLS: "false",
      DS_SERVER_UPDATE_CHECK: "false",
      DS_SERVER_ENABLE_DIRECT_TORRENT: "false",
      DS_SERVER_ENABLE_TRANSCODE: "false",
      DS_SERVER_LOGGER: "false",
      DS_BUILD_PROFILE: "public",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    child,
    stdout: boundedCapture(child.stdout),
    stderr: boundedCapture(child.stderr),
  };
}

async function waitForHealth(server, baseUrl, config, expectedSetupRequired) {
  const deadline = Date.now() + config.startupTimeoutMs;
  while (Date.now() < deadline) {
    if (server.child.exitCode != null) fail(`Packaged server exited during startup with code ${server.child.exitCode}.`);
    try {
      const response = await request(baseUrl, "/api/health", {}, Math.min(1_000, config.requestTimeoutMs));
      if (response.status === 200) {
        assertHealth(await jsonBody(response, "Health endpoint"), expectedSetupRequired);
        return;
      }
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  fail("Packaged server did not become healthy before the startup timeout.");
}

async function stopServer(server) {
  if (server == null || server.child.exitCode != null) return;
  const exited = new Promise((resolvePromise) => server.child.once("exit", resolvePromise));
  server.child.kill("SIGTERM");
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise((resolvePromise) => setTimeout(() => resolvePromise(false), 3_000)),
  ]);
  if (!stopped && server.child.exitCode == null) {
    server.child.kill("SIGKILL");
    await Promise.race([exited, new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000))]);
  }
}

async function validateStaticApp(baseUrl, config) {
  const indexResponse = await fetchBounded(`${baseUrl}/`, { headers: { accept: "text/html" } }, config.requestTimeoutMs);
  expectStatus(indexResponse, 200, "Hosted web index");
  if (!indexResponse.headers.get("content-type")?.toLowerCase().startsWith("text/html")) {
    fail("Hosted web index had the wrong content type.");
  }
  if (indexResponse.headers.get("cache-control") !== "no-store") {
    fail("Hosted web index did not use no-store caching.");
  }
  if (indexResponse.headers.get("x-content-type-options") !== "nosniff") {
    fail("Hosted web index was missing the nosniff header.");
  }
  const html = await indexResponse.text();
  const entryAssetPaths = discoverCompiledAssets(html);
  const assetPaths = selectCompiledAssets(entryAssetPaths, await listCompiledAssets(config.webDist));
  const assets = [];
  let totalAssetBytes = 0;
  for (const assetPath of assetPaths) {
    const file = await resolveArtifactFile(config.webDist, assetPath);
    const expectedBytes = await readFile(file);
    if (expectedBytes.byteLength > 20 * 1024 * 1024) {
      fail("Packaged compiled asset exceeded the per-file size bound.");
    }
    totalAssetBytes += expectedBytes.byteLength;
    if (totalAssetBytes > 200 * 1024 * 1024) {
      fail("Packaged compiled assets exceeded the aggregate size bound.");
    }
    const response = await fetchBounded(`${baseUrl}${assetPath}`, {}, config.requestTimeoutMs);
    expectStatus(response, 200, "Compiled asset");
    const expectedContentType = assetPath.endsWith(".js") ? "text/javascript" : "text/css";
    if (!response.headers.get("content-type")?.toLowerCase().startsWith(expectedContentType)) {
      fail("Compiled asset had the wrong content type.");
    }
    if (response.headers.get("cache-control") !== "public, max-age=31536000, immutable") {
      fail("Compiled asset did not use immutable caching.");
    }
    if (response.headers.get("x-content-type-options") !== "nosniff") {
      fail("Compiled asset was missing the nosniff header.");
    }
    const servedBytes = Buffer.from(await response.arrayBuffer());
    if (sha256(servedBytes) !== sha256(expectedBytes)) {
      fail("Served compiled asset bytes did not match the packaged file.");
    }
    assets.push({
      path: assetPath,
      bytes: expectedBytes.byteLength,
      sha256: sha256(expectedBytes),
    });
  }

  const stableResources = [];
  for (const stablePath of ["/sw.js", "/manifest.webmanifest", "/icons/icon-192.png"]) {
    const file = await resolveArtifactFile(config.webDist, stablePath);
    const expectedBytes = await readFile(file);
    const response = await fetchBounded(`${baseUrl}${stablePath}`, {}, config.requestTimeoutMs);
    assertStableResourceResponse(response.status, response.headers);
    const servedBytes = Buffer.from(await response.arrayBuffer());
    if (sha256(servedBytes) !== sha256(expectedBytes)) {
      fail("Served stable resource bytes did not match the packaged file.");
    }
    stableResources.push({
      path: stablePath,
      bytes: expectedBytes.byteLength,
      sha256: sha256(expectedBytes),
    });
  }

  for (const missingPath of [
    "/assets/yawf-artifact-smoke-missing.js",
    "/icons/yawf-artifact-smoke-missing.png",
    "/yawf-artifact-smoke-missing.webmanifest",
  ]) {
    const response = await fetchBounded(`${baseUrl}${missingPath}`, {}, config.requestTimeoutMs);
    assertMissingResourceResponse(response.status, response.headers);
    await response.arrayBuffer();
  }
  return { entryAssetPaths, compiledAssets: assets, stableResources };
}

async function login(baseUrl, config, credentials) {
  const jar = new CookieJar();
  const response = await request(baseUrl, "/api/auth/login", {
    method: "POST",
    jar,
    body: { username: credentials.username, password: credentials.password },
  }, config.requestTimeoutMs);
  expectStatus(response, 200, "Owner login");
  await jsonBody(response, "Owner login");
  if (jar.get("ds_session") == null || jar.get("ds_csrf") == null) {
    fail("Owner login did not establish session and CSRF cookies.");
  }
  return jar;
}

async function authenticatedChecks(baseUrl, config, jar, expectedVersion, settingKey, settingValue) {
  const session = await request(baseUrl, "/api/auth/session", { jar }, config.requestTimeoutMs);
  expectStatus(session, 200, "Authenticated session");
  const sessionBody = await jsonBody(session, "Authenticated session");
  if (sessionBody?.session?.role !== "owner") fail("Authenticated session was not the owner role.");

  const adminHealth = await request(baseUrl, "/api/admin/health", { jar }, config.requestTimeoutMs);
  expectStatus(adminHealth, 200, "Admin health");
  assertPackageVersion(await jsonBody(adminHealth, "Admin health"), expectedVersion);

  const noCsrf = await request(baseUrl, "/api/settings/profile", {
    method: "PUT",
    jar,
    body: { key: settingKey, value: settingValue },
  }, config.requestTimeoutMs);
  expectStatus(noCsrf, 403, "Profile setting write without CSRF");
  return sessionBody.session;
}

async function runSmoke(config) {
  assertSupportedRuntime();
  assertNonRootRuntime();
  const entryInfo = await stat(config.serverEntry);
  const webInfo = await stat(config.webDist);
  if (!entryInfo.isFile()) fail("--server-entry must name a regular file.");
  if (!webInfo.isDirectory()) fail("--web-dist must name a directory.");

  const tempRoot = await mkdtemp(join(tmpdir(), "yawf-server-artifact-smoke-"));
  const dataDir = join(tempRoot, "data");
  const databasePath = join(dataDir, "debridstreamer.sqlite");
  const secrets = {
    setupToken: randomBytes(32).toString("base64url"),
    secretKey: randomBytes(32).toString("base64"),
    username: `smoke-${randomBytes(8).toString("hex")}`,
    password: randomBytes(48).toString("base64url"),
  };
  const secretValues = Object.values(secrets);
  const settingKey = "artifact_smoke_marker";
  const settingValue = `persisted-${randomBytes(12).toString("hex")}`;
  secretValues.push(settingValue);
  const runtimeConfig = { ...config, tempRoot, dataDir, databasePath };
  let server = null;

  try {
    const port = await availablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    server = spawnPackagedServer(runtimeConfig, secrets, port);
    await waitForHealth(server, baseUrl, config, true);

    const staticApp = await validateStaticApp(baseUrl, config);
    const unauthenticated = await request(baseUrl, "/api/settings/profile", {}, config.requestTimeoutMs);
    assertUnauthenticatedProfileDenied(unauthenticated.status);

    const setupJar = new CookieJar();
    const setup = await request(baseUrl, "/api/auth/setup-owner", {
      method: "POST",
      jar: setupJar,
      body: {
        username: secrets.username,
        password: secrets.password,
        displayName: "Artifact Smoke Owner",
        setupToken: secrets.setupToken,
      },
    }, config.requestTimeoutMs);
    expectStatus(setup, 200, "Owner setup");
    await jsonBody(setup, "Owner setup");

    const firstJar = await login(baseUrl, config, secrets);
    const firstSession = await authenticatedChecks(
      baseUrl,
      config,
      firstJar,
      config.expectedVersion,
      settingKey,
      settingValue,
    );
    const persisted = await request(baseUrl, "/api/settings/profile", {
      method: "PUT",
      jar: firstJar,
      csrf: true,
      body: { key: settingKey, value: settingValue },
    }, config.requestTimeoutMs);
    expectStatus(persisted, 200, "Profile setting write with CSRF");

    await stopServer(server);
    server = null;

    const restartPort = await availablePort();
    const restartBaseUrl = `http://127.0.0.1:${restartPort}`;
    server = spawnPackagedServer(runtimeConfig, secrets, restartPort);
    await waitForHealth(server, restartBaseUrl, config, false);
    const existingBootstrap = await request(restartBaseUrl, "/api/bootstrap", { jar: firstJar }, config.requestTimeoutMs);
    expectStatus(existingBootstrap, 200, "Existing session bootstrap after restart");
    assertRestartedSession(
      await jsonBody(existingBootstrap, "Existing session bootstrap after restart"),
      firstSession.profileId,
      firstJar.get("ds_csrf"),
    );
    const existingSettings = await request(
      restartBaseUrl,
      "/api/settings/profile",
      { jar: firstJar },
      config.requestTimeoutMs,
    );
    expectStatus(existingSettings, 200, "Existing session profile setting read after restart");
    assertPersistedSetting(
      await jsonBody(existingSettings, "Existing session profile setting read after restart"),
      settingKey,
      settingValue,
    );

    const freshJar = await login(restartBaseUrl, config, secrets);
    const freshSettings = await request(restartBaseUrl, "/api/settings/profile", { jar: freshJar }, config.requestTimeoutMs);
    expectStatus(freshSettings, 200, "Fresh login profile setting read after restart");
    assertPersistedSetting(
      await jsonBody(freshSettings, "Fresh login profile setting read after restart"),
      settingKey,
      settingValue,
    );
    await authenticatedChecks(restartBaseUrl, config, freshJar, config.expectedVersion, settingKey, settingValue);

    const serverBundle = await readFile(config.serverEntry);
    return {
      schemaVersion: 1,
      packageVersion: config.expectedVersion,
      runtime: {
        node: process.versions.node,
        platform: process.platform,
        architecture: process.arch,
        nonRoot: typeof process.getuid !== "function" || process.getuid() !== 0,
      },
      server: {
        entry: basename(config.serverEntry),
        bytes: serverBundle.byteLength,
        sha256: sha256(serverBundle),
      },
      web: {
        entryAssetPaths: staticApp.entryAssetPaths,
        compiledAssets: staticApp.compiledAssets,
        stableResources: staticApp.stableResources,
      },
      checks: {
        health: true,
        hostedHtml: true,
        assetHeadersAndBytes: true,
        stableResourcesRevalidate: true,
        missingResourcesReturn404: true,
        unauthenticatedProfileDenied: true,
        ownerSetupLoginSession: true,
        csrfDeniedWithoutToken: true,
        existingSessionAndCsrfPersistedAcrossRestart: true,
        freshLoginAfterRestart: true,
        settingsPersistedAcrossRestart: true,
        externalUpdateCheckDisabled: true,
      },
    };
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    const childTail = server == null ? "" : `${server.stdout()}\n${server.stderr()}`.trim();
    const suffix = childTail.length === 0 ? "" : ` Child output: ${childTail}`;
    throw new Error(sanitizeDiagnostic(`${diagnostic}${suffix}`, secretValues));
  } finally {
    await stopServer(server);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function writeReceipt(receiptPath, receipt) {
  const serialized = `${JSON.stringify(receipt)}\n`;
  if (receiptPath != null) {
    await writeFile(receiptPath, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
  }
  process.stdout.write(serialized);
}

export async function main(argv = process.argv.slice(2)) {
  const config = parseArgs(argv);
  const receipt = await runSmoke(config);
  await writeReceipt(config.receipt, receipt);
  return receipt;
}

const invokedPath = process.argv[1] == null ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`Server artifact smoke failed: ${sanitizeDiagnostic(error instanceof Error ? error.message : String(error))}\n`);
    process.exitCode = 1;
  });
}
