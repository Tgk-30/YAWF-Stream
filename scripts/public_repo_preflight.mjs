#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const args = process.argv.slice(2);
const MAX_GIT_OUTPUT_BYTES = 20 * 1024 * 1024;

function parseArgs(argv) {
  const refs = [];
  let allRefs = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--all-refs") {
      allRefs = true;
      continue;
    }
    if (arg === "--ref") {
      const value = argv[index + 1];
      if (!value) {
        fail("--ref requires a ref name");
      } else {
        refs.push(value);
        index += 1;
      }
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node scripts/public_repo_preflight.mjs [--all-refs] [--ref <ref> ...]

Default scans tracked/unignored files plus reachable history from HEAD.
Use --all-refs before pushing multiple branches or tags to a public remote.`);
      process.exit(0);
    }
    fail(`Unknown argument: ${arg}`);
  }
  if (allRefs && refs.length > 0) {
    fail("Use either --all-refs or one or more --ref values, not both");
  }
  return { allRefs, refs };
}

const options = parseArgs(args);

function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
    });
  } catch (error) {
    if (error?.code === "ENOBUFS") {
      throw new Error(`Git command output exceeded ${MAX_GIT_OUTPUT_BYTES} bytes`);
    }
    throw error;
  }
}

function gitBuffer(args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "buffer",
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
}

function gitWithInput(args, input) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    input,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
}

function fail(message) {
  failures.push(message);
}

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

function trackedFiles() {
  return git(["ls-files", "-z"])
    .split("\0")
    .filter(Boolean);
}

function unignoredUntrackedFiles() {
  return git(["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean);
}

const tracked = trackedFiles();
const untracked = unignoredUntrackedFiles();
const publishCandidateFiles = [...new Set([...tracked, ...untracked])];

const forbiddenHistoricalPathPatterns = [
  {
    label: "assistant instruction file",
    pattern:
      /(^|\/)(?:AI-WORKFLOW|ai-workflow|CLAUDE|claude|CODEX|codex|GEMINI|gemini|AGENT|agent|AGENTS|agents)\.md$/,
  },
  {
    label: "assistant workspace directory",
    pattern: /(^|\/)\.(agents|claude|codex|cursor|windsurf|continue|gemini|opencode)(\/|$)/,
  },
  {
    label: "assistant CLI artifact",
    pattern: /(^|\/)\.aider.*/i,
  },
  {
    label: "conversation or transcript artifact",
    pattern: /(^|\/).*(conversation|transcript).*/i,
  },
  {
    label: "local environment file",
    pattern: /(^|\/)\.env($|\.local$|\..*\.local$)/,
  },
];

const forbiddenPublishPathPatterns = [
  ...forbiddenHistoricalPathPatterns,
  {
    label: "local planning or handoff artifact",
    pattern:
      /(^|\/)(?:TARGETS?|targets?|PROBLEMS?|problems?|NOTES?|notes?|HANDOFF[^/]*|handoff[^/]*)\.md$/,
  },
  {
    label: "internal audit or verification artifact",
    pattern:
      /^(?:docs\/(?:verification\/|ai-scoreboard\.md$|UX-AUDIT\.md$|feature-gap-audit\.md$)|web\/src-tauri\/RENDER_PLAYER_PLAN\.md$)/,
  },
  {
    label: "local deployment state",
    pattern: /(^|\/)\.wrangler(\/|$)/,
  },
  {
    label: "obsolete proof-of-concept workspace",
    pattern: /^poc-tauri(\/|$)/,
  },
  {
    label: "local commit template",
    pattern: /(^|\/)\.git-commit-template\.txt$/,
  },
  {
    label: "credential or signing material",
    pattern:
      /(^|\/)(?:\.netrc|\.npmrc|\.pypirc|credentials\.json|service-account[^/]*\.json|[^/]+\.(?:pem|key|p12|pfx|jks|keystore|mobileprovision|provisionprofile))$/i,
  },
];

for (const file of publishCandidateFiles) {
  const issue = forbiddenPublishPathPatterns.find((entry) => entry.pattern.test(file));
  if (issue) {
    const scope = tracked.includes(file) ? "Tracked" : "Unignored untracked";
    fail(`${scope} ${issue.label}: ${file}`);
  }
}

function checkForbiddenPath(file, scope) {
  const issue = forbiddenHistoricalPathPatterns.find((entry) => entry.pattern.test(file));
  if (issue) fail(`${scope} ${issue.label}: ${file}`);
}

const secretPatterns = [
  {
    label: "sk-prefixed API key",
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/,
  },
  {
    label: "Google API key",
    pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/,
  },
  {
    label: "Cloudflare API token",
    pattern: /\bcfat_[A-Za-z0-9_-]{20,}\b/,
  },
  {
    label: "GitHub token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{20,255})\b/,
  },
  {
    label: "GitLab token",
    pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  },
  {
    label: "AWS access key",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  },
  {
    label: "Slack token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  },
  {
    label: "npm access token",
    pattern: /\bnpm_[A-Za-z0-9]{36,}\b/,
  },
  {
    label: "Stripe live secret key",
    pattern: /\bsk_live_[A-Za-z0-9]{20,}\b/,
  },
  {
    label: "private key block",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  },
  {
    label: "provider credential literal",
    pattern:
      /\b(?:tmdb|torbox|real[-_\s]?debrid|openai|mini\s?max|minimax|glm|zai|z\.ai)\b[^\n]{0,28}[:=][^\n]{0,8}(?:sk-[A-Za-z0-9_-]{20,}|[0-9a-f]{32,}|[A-Z0-9]{40,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i,
  },
];

const credentialLiteralPattern =
  /\b([A-Za-z0-9_]*(?:api_?key|key|token|secret|password)[A-Za-z0-9_]*)\s*[:=]\s*["']([^"'\s]{16,})["']/gi;

// Obvious NON-secret test fixtures that happen to pattern-match the generic
// name=value heuristic (mixed-case, hyphenated strings ≥16 chars). Allowlisted
// by exact value so both the working tree AND historical blobs pass - the string
// is a deliberate, self-labelled placeholder, never a real credential.
const allowlistedLiterals = new Set([
  "omdb-secret-key-DO-NOT-LEAK-xyz",
  // Swift string-interpolation cache key in AIAssistantManager.swift - the
  // variable is named cacheKey and the interpolated value is >=16 chars, so
  // the generic heuristic fires. It is a verdict-cache map key, not a
  // credential. Allowlisted by exact value because the blob is in history.
  "\\(item.id)|\\(personalizationEnabled)",
]);

function looksLikeSecretLiteral(value) {
  if (/^sk-[A-Za-z0-9_-]{20,}$/.test(value)) return true;
  if (/^AIza[0-9A-Za-z_-]{30,}$/.test(value)) return true;
  if (/^cfat_[A-Za-z0-9_-]{20,}$/.test(value)) return true;
  if (/^[0-9a-f]{32,}$/i.test(value)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    return true;
  }
  if (/^[A-Z0-9]{40,}$/.test(value)) return true;
  if (/^[a-z0-9_.-]+$/.test(value)) return false;

  const classes = [
    /[a-z]/.test(value),
    /[A-Z]/.test(value),
    /[0-9]/.test(value),
    /[_./+=-]/.test(value),
  ].filter(Boolean).length;
  return value.length >= 24 && classes >= 3;
}

const textExtensions = new Set([
  ".css",
  ".dockerignore",
  ".gitignore",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".rs",
  ".sh",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".webmanifest",
  ".yml",
  ".yaml",
]);

function isLikelyText(file, buffer) {
  if (buffer.includes(0)) return false;
  const dot = file.lastIndexOf(".");
  if (dot < 0) return true;
  return textExtensions.has(file.slice(dot).toLowerCase());
}

function scanTextForSecrets(text, file, scope) {
  for (const entry of secretPatterns) {
    if (entry.pattern.test(text)) {
      fail(`Possible ${entry.label} in ${scope}: ${file}`);
    }
  }
  let match;
  credentialLiteralPattern.lastIndex = 0;
  while ((match = credentialLiteralPattern.exec(text)) !== null) {
    if (allowlistedLiterals.has(match[2])) continue;
    if (looksLikeSecretLiteral(match[2])) {
      fail(`Possible credential-like literal in ${scope}: ${file}`);
      break;
    }
  }
}

for (const file of publishCandidateFiles) {
  const path = join(root, file);
  let stats;
  try {
    stats = statSync(path);
  } catch {
    continue;
  }
  if (!stats.isFile() || stats.size > 2_000_000) continue;
  const buffer = readFileSync(path);
  if (!isLikelyText(file, buffer)) continue;
  const scope = tracked.includes(file) ? "tracked file" : "unignored untracked file";
  scanTextForSecrets(buffer.toString("utf8"), file, scope);
}

function historyScopeArgs() {
  if (options.allRefs) return ["--all"];
  if (options.refs.length > 0) return options.refs;
  return ["HEAD"];
}

function historyScopeLabel() {
  if (options.allRefs) return "all refs";
  if (options.refs.length > 0) return options.refs.join(", ");
  return "HEAD";
}

function historyObjects() {
  return git(["rev-list", "--objects", ...historyScopeArgs()])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const space = line.indexOf(" ");
      return space === -1
        ? { oid: line, path: "" }
        : { oid: line.slice(0, space), path: line.slice(space + 1) };
    });
}

function objectInfo(objects) {
  const input = `${objects.map((object) => object.oid).join("\n")}\n`;
  const lines = gitWithInput(["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], input)
    .split("\n")
    .filter(Boolean);
  const byOid = new Map();
  for (const line of lines) {
    const [oid, type, size] = line.split(" ");
    byOid.set(oid, { type, size: Number(size) });
  }
  return byOid;
}

function scanHistory() {
  const objects = historyObjects();
  const info = objectInfo(objects);
  for (const object of objects) {
    if (!object.path) continue;
    checkForbiddenPath(object.path, "Historical");
    const meta = info.get(object.oid);
    if (!meta || meta.type !== "blob" || !Number.isFinite(meta.size) || meta.size > 2_000_000) {
      continue;
    }
    const buffer = gitBuffer(["cat-file", "-p", object.oid]);
    if (!isLikelyText(object.path, buffer)) continue;
    scanTextForSecrets(buffer.toString("utf8"), object.path, "historical blob");
  }

  const records = git(["log", "--format=%H%x00%B%x1e", ...historyScopeArgs()]).split("\x1e").filter(Boolean);
  for (const record of records) {
    const split = record.indexOf("\0");
    if (split === -1) continue;
    const commit = record.slice(0, split).trim();
    const body = record.slice(split + 1);
    scanTextForSecrets(body, commit, "commit message");
  }
}

scanHistory();

const requiredIgnorePatterns = [
  ".agents",
  ".claude",
  ".codex",
  ".cursor",
  ".windsurf",
  ".continue",
  ".gemini",
  ".opencode",
  ".aider*",
  "AI-WORKFLOW.md",
  "ai-workflow.md",
  "CLAUDE.md",
  "claude.md",
  "CODEX.md",
  "codex.md",
  "GEMINI.md",
  "gemini.md",
  "AGENTS.md",
  "agents.md",
  "AGENT.md",
  "agent.md",
  "transcripts",
  "conversation*.md",
  "*transcript*.md",
  "TARGET.md",
  "TARGETS.md",
  "target.md",
  "targets.md",
  "targets",
  "PROBLEMS.md",
  "problems.md",
  "NOTES.md",
  "notes.md",
  "notes",
  "handoff*.md",
  "HANDOFF*.md",
  ".git-commit-template.txt",
  "docs/verification",
  "docs/ai-scoreboard.md",
  "docs/UX-AUDIT.md",
  "docs/feature-gap-audit.md",
  "web/src-tauri/RENDER_PLAYER_PLAN.md",
  "poc-tauri",
  ".env",
  ".env.*",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "credentials.json",
  "service-account*.json",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.jks",
  "*.keystore",
  "*.mobileprovision",
  "*.provisionprofile",
  ".wrangler",
];

function normalizedIgnorePatterns(body) {
  return new Set(
    body
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => (line.length > 1 ? line.replace(/\/+$/, "") : line)),
  );
}

for (const ignoreFile of [".gitignore", ".dockerignore"]) {
  if (!existsSync(join(root, ignoreFile))) {
    fail(`${ignoreFile} is missing`);
    continue;
  }
  const patterns = normalizedIgnorePatterns(read(ignoreFile));
  for (const pattern of requiredIgnorePatterns) {
    if (!patterns.has(pattern)) {
      fail(`${ignoreFile} does not exclude ${pattern}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Public repo preflight failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`Public repo preflight passed (${historyScopeLabel()} history).`);
