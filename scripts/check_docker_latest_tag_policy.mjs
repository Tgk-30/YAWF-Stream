#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const METADATA_STEP_NAME = "Docker metadata";
const PUBLISH_STEP_NAME = "Build and publish multi-arch image";
const REQUIRED_TAG_RULES = [
  "type=ref,event=branch",
  "type=ref,event=tag",
  "type=semver,pattern={{version}}",
  "type=semver,pattern={{major}}.{{minor}}",
  "type=raw,value=${{ steps.release-version.outputs.version }},enable=${{ steps.release-version.outputs.enabled }}",
  "type=raw,value=${{ steps.release-version.outputs.major_minor }},enable=${{ steps.release-version.outputs.enabled }}",
];

function normalizeName(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function namedSteps(text, expectedName) {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)-\s+name:\s*(.+?)\s*$/);
    if (match != null) {
      starts.push({ index, indent: match[1].length, name: normalizeName(match[2]) });
    }
  }

  return starts
    .filter((start) => start.name === expectedName)
    .map((start) => {
      const next = starts.find(
        (candidate) =>
          candidate.index > start.index && candidate.indent === start.indent,
      );
      return {
        indent: start.indent,
        lines: lines.slice(start.index, next?.index ?? lines.length),
      };
    });
}

function mappingEntries(lines, indent) {
  const prefix = " ".repeat(indent);
  const entries = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith(prefix)) continue;
    const remainder = lines[index].slice(indent);
    if (remainder.startsWith(" ") || remainder.startsWith("-")) continue;
    const match = remainder.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (match == null) continue;
    entries.push({ key: match[1], value: (match[2] ?? "").trim(), index });
  }
  return entries.map((entry, index) => ({
    ...entry,
    end: entries[index + 1]?.index ?? lines.length,
    indent,
  }));
}

function fieldValues(entries, key) {
  return entries.filter((entry) => entry.key === key);
}

function literalBlockLines(lines, entry) {
  if (entry.value !== "|") return null;
  const contentIndent = entry.indent + 2;
  const prefix = " ".repeat(contentIndent);
  const result = [];
  for (const line of lines.slice(entry.index + 1, entry.end)) {
    if (line.trim().length === 0) continue;
    if (!line.startsWith(prefix) || line[contentIndent] === " ") return null;
    result.push(line.slice(contentIndent));
  }
  return result;
}

function withEntries(step, failureLabel, failures) {
  const stepFields = mappingEntries(step.lines, step.indent + 2);
  const withFields = fieldValues(stepFields, "with");
  if (withFields.length !== 1 || withFields[0].value !== "") {
    failures.push(`${failureLabel} must define exactly one with mapping`);
    return null;
  }
  const withField = withFields[0];
  const lines = step.lines.slice(withField.index + 1, withField.end);
  return {
    lines,
    entries: mappingEntries(lines, step.indent + 4),
  };
}

function hasExactStepField(step, key, expectedValue) {
  const fields = mappingEntries(step.lines, step.indent + 2);
  const matches = fieldValues(fields, key);
  return matches.length === 1 && matches[0].value === expectedValue;
}

/**
 * Validate the repository's known Docker workflow layout statically.
 * This does not execute docker/metadata-action or predict registry publication.
 */
export function validateDockerLatestTagPolicy(workflowText) {
  const failures = [];

  const metadataSteps = namedSteps(workflowText, METADATA_STEP_NAME);
  if (metadataSteps.length !== 1) {
    failures.push(
      `expected exactly one ${METADATA_STEP_NAME} step (found ${metadataSteps.length})`,
    );
  } else {
    const metadata = metadataSteps[0];
    if (
      !hasExactStepField(metadata, "uses", "docker/metadata-action@v5") ||
      !hasExactStepField(metadata, "id", "meta")
    ) {
      failures.push(
        "Docker metadata step must use docker/metadata-action@v5 with id: meta",
      );
    }

    const withBlock = withEntries(metadata, "Docker metadata step", failures);
    if (withBlock != null) {
      const flavorFields = fieldValues(withBlock.entries, "flavor");
      const flavorLines =
        flavorFields.length === 1
          ? literalBlockLines(withBlock.lines, flavorFields[0])
          : null;
      if (
        flavorFields.length !== 1 ||
        flavorLines == null ||
        flavorLines.length !== 1 ||
        flavorLines[0] !== "latest=false"
      ) {
        failures.push(
          "Docker metadata flavor must be one literal block containing only latest=false",
        );
      }

      const tagFields = fieldValues(withBlock.entries, "tags");
      const tagLines =
        tagFields.length === 1
          ? literalBlockLines(withBlock.lines, tagFields[0])
          : null;
      if (
        tagFields.length !== 1 ||
        tagLines == null ||
        tagLines.length !== REQUIRED_TAG_RULES.length ||
        !REQUIRED_TAG_RULES.every((rule, index) => tagLines[index] === rule)
      ) {
        failures.push(
          "Docker metadata tags must contain only the required version and ref rules in order",
        );
      }
      if (
        tagLines?.some((line) =>
          /type\s*=\s*raw\s*,\s*value\s*=\s*latest\b/i.test(line),
        )
      ) {
        failures.push("Docker metadata step must not define a raw latest tag rule");
      }
    }
  }

  const publishSteps = namedSteps(workflowText, PUBLISH_STEP_NAME);
  if (publishSteps.length !== 1) {
    failures.push(
      `expected exactly one ${PUBLISH_STEP_NAME} step (found ${publishSteps.length})`,
    );
  } else {
    const publish = publishSteps[0];
    if (!hasExactStepField(publish, "uses", "docker/build-push-action@v6")) {
      failures.push(
        "Build and publish step must use docker/build-push-action@v6 exactly once",
      );
    }
    const withBlock = withEntries(publish, "Build and publish step", failures);
    if (withBlock != null) {
      const tags = fieldValues(withBlock.entries, "tags");
      if (
        tags.length !== 1 ||
        tags[0].value !== "${{ steps.meta.outputs.tags }}" ||
        tags[0].end !== tags[0].index + 1
      ) {
        failures.push(
          "Build and publish step tags must be exactly steps.meta.outputs.tags",
        );
      }
    }
  }

  return failures;
}

const isMain =
  process.argv[1] != null &&
  (import.meta.url === pathToFileURL(resolve(process.argv[1])).href ||
    realpathSync(fileURLToPath(import.meta.url)) ===
      realpathSync(resolve(process.argv[1])));

if (isMain) {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const workflowPath = process.argv[2]
    ? resolve(process.argv[2])
    : resolve(scriptDir, "../.github/workflows/docker-image.yml");
  const failures = validateDockerLatestTagPolicy(
    readFileSync(workflowPath, "utf8"),
  );
  if (failures.length > 0) {
    console.error(failures.map((failure) => `fail: ${failure}`).join("\n"));
    process.exit(1);
  }
  console.log(`Docker latest-tag policy passed: ${workflowPath}`);
}
