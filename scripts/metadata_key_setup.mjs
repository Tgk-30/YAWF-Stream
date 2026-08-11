#!/usr/bin/env node

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export const PROVIDERS = {
  tmdb: {
    id: "tmdb",
    label: "TMDB",
    requestUrl: "https://www.themoviedb.org/settings/api",
    requirements:
      "Create or sign in to a TMDB account, accept its terms, then request a v3 API key.",
    env: "DS_TMDB_API_KEY",
    validationUrl(key) {
      const url = new URL("https://api.themoviedb.org/3/configuration");
      url.searchParams.set("api_key", key);
      return url;
    },
    valid(json) {
      return typeof json === "object" && json !== null && "images" in json;
    },
  },
  omdb: {
    id: "omdb",
    label: "OMDb",
    requestUrl: "https://www.omdbapi.com/apikey.aspx",
    requirements:
      "Request a free key with your email address, activate the email link, and observe the provider's usage limits.",
    env: "DS_OMDB_API_KEY",
    validationUrl(key) {
      const url = new URL("https://www.omdbapi.com/");
      url.searchParams.set("apikey", key);
      url.searchParams.set("i", "tt0133093");
      return url;
    },
    valid(json) {
      return json?.Response === "True";
    },
  },
};

const CONSENT_FLAG = "--i-understand-third-party-terms";
const REDACTION_MARKER = "[redacted]";

function usage() {
  return [
    "Usage: node scripts/metadata_key_setup.mjs [--print-only | --open] [--tmdb] [--omdb] [--validate]",
    "",
    "This helper only opens or prints the official request pages. It never creates accounts,",
    "submits forms, reads email, retrieves keys, stores keys, or prints supplied keys.",
    "",
    "Options:",
    "  --print-only                         Print the official pages and requirements (default).",
    `  --open ${CONSENT_FLAG}  Open the selected official pages after explicit consent.`,
    "  --tmdb, --omdb                       Limit the action to one provider (default: both).",
    "  --validate                            Validate selected keys supplied only through environment variables.",
    "  --help                                Show this help.",
    "",
    "Validation examples, with values omitted intentionally:",
    "  DS_TMDB_API_KEY=... node scripts/metadata_key_setup.mjs --tmdb --validate",
    "  DS_OMDB_API_KEY=... node scripts/metadata_key_setup.mjs --omdb --validate",
  ].join("\n");
}

export function parseArgs(args) {
  const options = {
    help: false,
    open: false,
    printOnly: false,
    consent: false,
    validate: false,
    providerIds: [],
  };

  for (const arg of args) {
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--open") options.open = true;
    else if (arg === "--print-only") options.printOnly = true;
    else if (arg === CONSENT_FLAG) options.consent = true;
    else if (arg === "--validate") options.validate = true;
    else if (arg === "--tmdb" || arg === "--omdb") options.providerIds.push(arg.slice(2));
    else throw new Error("Unknown or unsupported option.");
  }

  if (options.open && options.printOnly) {
    throw new Error("Use either --open or --print-only, not both.");
  }
  if (options.consent && !options.open) {
    throw new Error(`${CONSENT_FLAG} only applies with --open.`);
  }

  options.providerIds = [...new Set(options.providerIds)];
  if (options.providerIds.length === 0) options.providerIds = Object.keys(PROVIDERS);
  return options;
}

function redactedMessage(error, secret) {
  const message = error instanceof Error ? error.message : String(error);
  if (!secret) return message;
  return message.split(secret).join(REDACTION_MARKER);
}

export function formatRequirements(providers) {
  return providers.flatMap((provider) => [
    `${provider.label}: ${provider.requestUrl}`,
    `  Requirement: ${provider.requirements}`,
  ]);
}

export function openOfficialPage(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  let command;
  let args;
  if (platform === "darwin") {
    command = "open";
    args = [url];
  } else if (platform === "win32") {
    command = "rundll32.exe";
    args = ["url.dll,FileProtocolHandler", url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(command, args, { stdio: "ignore", windowsHide: true });
    } catch (error) {
      resolve({ ok: false, error });
      return;
    }
    child.once("error", (error) => resolve({ ok: false, error }));
    child.once("spawn", () => resolve({ ok: true }));
  });
}

async function validateProvider(provider, key, { fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(provider.validationUrl(key), {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    let json;
    try {
      json = await response.json();
    } catch {
      return { ok: false, reason: "invalid JSON" };
    }
    return provider.valid(json)
      ? { ok: true }
      : { ok: false, reason: "unexpected response" };
  } catch (error) {
    return {
      ok: false,
      reason: error?.name === "AbortError" ? "request timed out" : "network error",
      error,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function runMetadataKeySetup({
  args = [],
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 15_000,
  openImpl = openOfficialPage,
} = {}) {
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    return { exitCode: 2, lines: [`Error: ${redactedMessage(error)}`, usage()] };
  }
  if (options.help) return { exitCode: 0, lines: [usage()] };

  const providers = options.providerIds.map((id) => PROVIDERS[id]);
  const lines = [
    "Metadata key setup is user-controlled.",
    "This helper does not create accounts, submit forms, read email, retrieve keys, or store keys.",
    ...formatRequirements(providers),
  ];

  if (options.open) {
    if (!options.consent) {
      lines.push(`Refusing to open external pages without ${CONSENT_FLAG}.`);
      return { exitCode: 2, lines };
    }
    let failed = false;
    for (const provider of providers) {
      const result = await openImpl(provider.requestUrl);
      if (result.ok) {
        lines.push(`Opened ${provider.label}'s official request page.`);
      } else {
        failed = true;
        lines.push(`Could not open ${provider.label}'s page: ${redactedMessage(result.error)}.`);
      }
    }
    if (failed) return { exitCode: 1, lines };
  }

  if (!options.validate) {
    if (!options.open) lines.push("No network request was made. Use --validate only after you obtain a key yourself.");
    return { exitCode: 0, lines };
  }

  let configured = 0;
  let failed = false;
  for (const provider of providers) {
    const key = env[provider.env]?.trim();
    if (!key) {
      lines.push(`${provider.label}: no ${provider.env} environment variable supplied, validation skipped.`);
      continue;
    }
    configured += 1;
    const result = await validateProvider(provider, key, { fetchImpl, timeoutMs });
    if (result.ok) {
      lines.push(`${provider.label}: key validation passed.`);
    } else {
      failed = true;
      lines.push(`${provider.label}: key validation failed (${redactedMessage(result.reason, key)}).`);
    }
  }

  if (configured === 0) {
    lines.push("No selected environment variables were supplied. Keys are accepted only through the environment, never command-line arguments.");
    return { exitCode: 2, lines };
  }
  return { exitCode: failed ? 1 : 0, lines };
}

export async function main({
  args = process.argv.slice(2),
  env = process.env,
  log = console.log,
  error = console.error,
  ...dependencies
} = {}) {
  const report = await runMetadataKeySetup({ args, env, ...dependencies });
  for (const line of report.lines) (report.exitCode === 0 ? log : error)(line);
  return report.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
