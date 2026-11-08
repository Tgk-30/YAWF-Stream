import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GRADLE_ALL_ASSET_API, fetchAndroidGradleArchive, gradleDownloadInvocation, gradleTransferStatus,
} from "./fetch_android_gradle.mjs";

const fixtureToken = "fixture" + "a".repeat(32);

test("the explicit API credential is stdin-only and the source remains fixed", () => {
  const { args, input } = gradleDownloadInvocation("/owned/gradle.zip", fixtureToken);
  assert.equal(args.includes(fixtureToken), false);
  assert.equal(args.some(arg => arg.includes(fixtureToken)), false);
  assert.equal(input, `header = "Authorization: Bearer ${fixtureToken}"\n`);
  assert.equal(args[0], "--disable");
  assert.equal(args[args.indexOf("--config") + 1], "-");
  assert.equal(args[args.indexOf("--max-redirs") + 1], "3");
  assert.equal(args.filter(arg => arg.startsWith("https://")).length, 1);
  assert.ok(args.includes(GRADLE_ALL_ASSET_API));
  for (const forbidden of ["--location-trusted", "--netrc", "--insecure", "--user"]) {
    assert.equal(args.includes(forbidden), false);
  }
});

test("accepts bounded stateless installation credentials without assuming an opaque token length", () => {
  const segment = Buffer.from(JSON.stringify({ fixture: "a".repeat(600) })).toString("base64url");
  const stateless = ["gh", "s_", "123456_", "fixture-header", ".", segment, ".fixture-signature"].join("");
  for (const token of [stateless, "x".repeat(20), "x".repeat(4096), "a".repeat(20) + "-._~+/=="]) {
    const { args, input } = gradleDownloadInvocation("/owned/gradle.zip", token);
    assert.equal(args.some(arg => arg.includes(token)), false);
    assert.equal(input, `header = "Authorization: Bearer ${token}"\n`);
  }
});

test("an anonymous transfer uses no credential or ambient curl configuration", () => {
  for (const token of [undefined, null, ""]) {
    const { args, input } = gradleDownloadInvocation("/owned/gradle.zip", token);
    assert.equal(input, "");
    assert.equal(args[0], "--disable");
    assert.equal(args.includes("Authorization"), false);
  }
});

for (const [label, token] of [
  ["newline", fixtureToken + "\nheader = invalid"],
  ["quote", fixtureToken + '"'],
  ["backslash", fixtureToken + "\\"],
  ["carriage-return", fixtureToken + "\r"],
  ["embedded-padding", fixtureToken + "=a"],
  ["space", fixtureToken + " value"],
  ["short", "x"],
  ["long", "x".repeat(4097)],
  ["non-string", 12345678901234567890n],
]) {
  test(`rejects a ${label} credential before staging or starting transport`, () => {
    const root = mkdtempSync(join(tmpdir(), "yawf-gradle-token-"));
    try {
      assert.throws(() => gradleDownloadInvocation("/owned/gradle.zip", token), /credential format/);
      assert.throws(() => fetchAndroidGradleArchive(root, token), /credential format/);
      assert.deepEqual(readdirSync(root), []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("transfer errors expose only bounded numeric status, never transport text", () => {
  assert.equal(gradleTransferStatus({ status: 22, stdout: "403", stderr: fixtureToken }), "curl=22, HTTP=403");
  assert.equal(gradleTransferStatus({ status: fixtureToken, stdout: "200\n" + fixtureToken }), "curl=unavailable, HTTP=unavailable");
  assert.equal(gradleTransferStatus({ status: null, stdout: undefined }), "curl=unavailable, HTTP=unavailable");
});

test("real curl keeps API authentication off a different HTTPS origin", { timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "yawf-gradle-redirect-"));
  const keyPath = join(root, "key.pem");
  const certificatePath = join(root, "certificate.pem");
  const generated = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-keyout", keyPath, "-out", certificatePath,
  ], { encoding: "utf8", timeout: 10_000 });
  assert.equal(generated.status, 0, "The test-only HTTPS certificate must generate.");
  chmodSync(keyPath, 0o600);
  const tls = { key: readFileSync(keyPath), cert: readFileSync(certificatePath) };
  const observations = [];
  const payload = Buffer.from("transport-only fixture, not a verified Gradle archive");
  const cdn = createServer(tls, (request, response) => {
    observations.push({ hop: "cdn", authorizationAbsent: request.headers.authorization == null });
    response.writeHead(200, { "Content-Length": payload.length, Connection: "close" });
    response.end(payload);
  });
  let api;
  let child;
  let deadline;
  try {
    cdn.listen(0, "127.0.0.1"); await once(cdn, "listening");
    api = createServer(tls, (request, response) => {
      observations.push({ hop: "api", authorizationMatches: request.headers.authorization === `Bearer ${fixtureToken}` });
      response.writeHead(302, { Location: `https://localhost:${cdn.address().port}/archive`, Connection: "close" });
      response.end();
    });
    api.listen(0, "127.0.0.1"); await once(api, "listening");
    const output = join(root, "transport.bin");
    const invocation = gradleDownloadInvocation(output, fixtureToken);
    // Change only the fixed destination in this test to two owned HTTPS hosts.
    // The production CLI still has no URL, CA or checksum override.
    const args = invocation.args.map(arg => arg === GRADLE_ALL_ASSET_API ? `https://127.0.0.1:${api.address().port}/asset` : arg);
    args.push("--cacert", certificatePath);
    child = spawn("/usr/bin/curl", args, { stdio: ["pipe", "pipe", "pipe"] });
    let status = "";
    child.stdout.on("data", chunk => { status += chunk.toString(); });
    child.stderr.resume();
    deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.stdin.end(invocation.input);
    const [code, signal] = await once(child, "close");
    assert.equal(code, 0, "The owned HTTPS redirect transfer must complete.");
    assert.equal(signal, null);
    assert.equal(status, "200");
    assert.deepEqual(observations, [{ hop: "api", authorizationMatches: true }, { hop: "cdn", authorizationAbsent: true }]);
    assert.deepEqual(readFileSync(output), payload);
  } finally {
    clearTimeout(deadline);
    if (child != null && child.exitCode == null && child.signalCode == null) {
      child.kill("SIGKILL"); await once(child, "close");
    }
    for (const server of [api, cdn]) {
      if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    }
    rmSync(root, { recursive: true, force: true });
  }
});
