import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROVIDERS,
  openOfficialPage,
  parseArgs,
  runMetadataKeySetup,
} from "./metadata_key_setup.mjs";

function response(json, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
  };
}

const secret = "secret-value-never-print";

function output(report) {
  return report.lines.join("\n");
}

test("print-only guidance makes no browser or network call and lists official pages", async () => {
  let fetches = 0;
  let opens = 0;
  const report = await runMetadataKeySetup({
    args: ["--print-only"],
    env: { DS_TMDB_API_KEY: secret, DS_OMDB_API_KEY: secret },
    fetchImpl: async () => {
      fetches += 1;
      throw new Error("should not fetch");
    },
    openImpl: async () => {
      opens += 1;
      throw new Error("should not open");
    },
  });

  assert.equal(report.exitCode, 0);
  assert.equal(fetches, 0);
  assert.equal(opens, 0);
  assert.match(output(report), new RegExp(PROVIDERS.tmdb.requestUrl));
  assert.match(output(report), new RegExp(PROVIDERS.omdb.requestUrl));
  assert.doesNotMatch(output(report), new RegExp(secret));
});

test("opening official pages requires explicit consent", async () => {
  let opens = 0;
  const report = await runMetadataKeySetup({
    args: ["--open", "--tmdb"],
    openImpl: async () => {
      opens += 1;
      return { ok: true };
    },
  });

  assert.equal(report.exitCode, 2);
  assert.equal(opens, 0);
  assert.match(output(report), /Refusing to open external pages/);
});

test("opening uses only the selected official URL after consent", async () => {
  const urls = [];
  const report = await runMetadataKeySetup({
    args: ["--open", "--i-understand-third-party-terms", "--omdb"],
    openImpl: async (url) => {
      urls.push(url);
      return { ok: true };
    },
  });

  assert.equal(report.exitCode, 0);
  assert.deepEqual(urls, [PROVIDERS.omdb.requestUrl]);
  assert.match(output(report), /Opened OMDb/);
});

test("validation uses environment keys, never logs them, and sends no key header", async () => {
  const requests = [];
  const report = await runMetadataKeySetup({
    args: ["--tmdb", "--validate"],
    env: { DS_TMDB_API_KEY: secret },
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return response({ images: {} });
    },
  });

  assert.equal(report.exitCode, 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.hostname, "api.themoviedb.org");
  assert.equal(requests[0].url.searchParams.get("api_key"), secret);
  assert.deepEqual(requests[0].init.headers, { Accept: "application/json" });
  assert.match(output(report), /key validation passed/);
  assert.doesNotMatch(output(report), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(report), new RegExp(secret));
});

test("validation skips missing variables and rejects command-line key arguments", async () => {
  const missing = await runMetadataKeySetup({
    args: ["--omdb", "--validate"],
    env: {},
    fetchImpl: async () => {
      throw new Error("should not fetch");
    },
  });
  assert.equal(missing.exitCode, 2);
  assert.match(output(missing), /DS_OMDB_API_KEY/);

  const rejected = await runMetadataKeySetup({
    args: ["--tmdb", `--key=${secret}`],
  });
  assert.equal(rejected.exitCode, 2);
  assert.doesNotMatch(output(rejected), new RegExp(secret));
});

test("validation failures redact supplied keys from provider and network errors", async () => {
  const providerReport = await runMetadataKeySetup({
    args: ["--omdb", "--validate"],
    env: { DS_OMDB_API_KEY: secret },
    fetchImpl: async () => response({}, secret),
  });
  assert.equal(providerReport.exitCode, 1);
  assert.match(output(providerReport), /HTTP \[redacted\]/);
  assert.doesNotMatch(JSON.stringify(providerReport), new RegExp(secret));

  const networkReport = await runMetadataKeySetup({
    args: ["--omdb", "--validate"],
    env: { DS_OMDB_API_KEY: secret },
    fetchImpl: async () => {
      throw new Error(`network failed for ${secret}`);
    },
  });

  assert.equal(networkReport.exitCode, 1);
  assert.match(output(networkReport), /network error/);
  assert.doesNotMatch(output(networkReport), new RegExp(secret));
});

test("cross-platform opener avoids shells and builds platform-specific commands", async () => {
  const calls = [];
  for (const platform of ["darwin", "win32", "linux"]) {
    const result = await openOfficialPage("https://example.test/request", {
      platform,
      spawnImpl(command, args, options) {
        calls.push({ command, args, options });
        return {
          once(event, listener) {
            if (event === "spawn") queueMicrotask(listener);
            return this;
          },
        };
      },
    });
    assert.equal(result.ok, true);
  }

  assert.deepEqual(calls, [
    {
      command: "open",
      args: ["https://example.test/request"],
      options: { stdio: "ignore", windowsHide: true },
    },
    {
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", "https://example.test/request"],
      options: { stdio: "ignore", windowsHide: true },
    },
    {
      command: "xdg-open",
      args: ["https://example.test/request"],
      options: { stdio: "ignore", windowsHide: true },
    },
  ]);
});

test("argument parsing is strict about conflicting and misplaced flags", () => {
  assert.throws(() => parseArgs(["--open", "--print-only"]), /either --open or --print-only/);
  assert.throws(
    () => parseArgs(["--i-understand-third-party-terms"]),
    /only applies with --open/,
  );
});
