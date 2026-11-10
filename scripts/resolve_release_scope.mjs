import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const FAILURE = "Release scope could not be resolved.";
const MAX_TAG_LENGTH = 128;
const TAG = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-web)?$/;
const OUTPUT_KEYS = ["desktop_only", "include_android", "include_server", "stable_version"];
const boundedString = (value, limit) => typeof value === "string" && value.length > 0 && value.length <= limit;

function parseTag(value) {
  if (!boundedString(value, MAX_TAG_LENGTH)) return null;
  const match = TAG.exec(value);
  // Require byte-for-byte full consumption, without trimming or normalizing.
  return match != null && match[0] === value ? match : null;
}

export function resolveReleaseScope(input) {
  try {
    if (input == null || typeof input !== "object" || Array.isArray(input)) throw new Error();
    const { eventName, refType, refName } = input;
    if (!boundedString(eventName, 64) || !/^[a-z]/.test(eventName) || /[^a-z0-9_]/.test(eventName) ||
        !["branch", "tag"].includes(refType) || !boundedString(refName, 256) || /[\u0000-\u001f\u007f]/.test(refName)) throw new Error();
    const coordinated = { desktop_only: "false", include_android: "true", include_server: "true", stable_version: "" };
    if (eventName !== "push" || refType !== "tag") return coordinated;

    const tag = parseTag(refName);
    if (tag == null) throw new Error();
    // An unrelated flag must not affect branch, PR or manual verification. Read
    // and validate it only after proving this is a push-tag release.
    const configuredTag = input.desktopOnlyTag;
    const desktopOnlyTag = configuredTag === undefined ? "" : configuredTag;
    if (typeof desktopOnlyTag !== "string" || desktopOnlyTag.length > MAX_TAG_LENGTH) throw new Error();
    if (desktopOnlyTag !== "") {
      const scope = parseTag(desktopOnlyTag);
      if (scope == null || scope[4] !== "-web") throw new Error();
    }
    const desktopOnly = tag[4] === "-web" && desktopOnlyTag === refName;
    return { desktop_only: desktopOnly ? "true" : "false", include_android: desktopOnly ? "false" : "true",
      include_server: desktopOnly ? "false" : "true", stable_version: `${tag[1]}.${tag[2]}.${tag[3]}` };
  } catch {
    throw new Error(FAILURE);
  }
}

function main() {
  let output;
  let json = false;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--github-output" && output === undefined) {
      output = args[++index];
      if (!boundedString(output, 4096) || /[\u0000\r\n]/.test(output) || output.startsWith("--")) throw new Error();
    } else if (args[index] === "--json" && !json) json = true;
    else throw new Error();
  }
  const outputs = resolveReleaseScope({
    eventName: process.env.RELEASE_SCOPE_EVENT_NAME,
    refType: process.env.RELEASE_SCOPE_REF_TYPE,
    refName: process.env.RELEASE_SCOPE_REF_NAME,
    desktopOnlyTag: process.env.RELEASE_SCOPE_DESKTOP_ONLY_TAG,
  });
  // Resolve completely before touching the output file. No caller-controlled
  // names, multiline values, shell evaluation or partial scope decisions.
  const lines = OUTPUT_KEYS.map(key => `${key}=${outputs[key]}\n`).join("");
  if (output !== undefined) appendFileSync(output, lines, { encoding: "utf8" });
  if (json || output === undefined) process.stdout.write(JSON.stringify(outputs) + "\n");
}

if (process.argv[1] != null && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { main(); }
  catch { process.stderr.write(FAILURE + "\n"); process.exitCode = 1; }
}
