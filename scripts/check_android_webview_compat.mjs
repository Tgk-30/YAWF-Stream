#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

function mediaPrelude(css, start) {
  let prelude = "";
  let quote = null;
  let inComment = false;
  for (let index = start; index < css.length; index += 1) {
    const character = css[index];
    const next = css[index + 1];
    if (inComment) {
      if (character === "*" && next === "/") {
        inComment = false;
        index += 1;
      }
      continue;
    }
    if (quote != null) {
      if (character === "\\") {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "/" && next === "*") {
      inComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "{") return { prelude, end: index };
    prelude += character;
  }
  throw new Error("unterminated @media rule");
}

export function findUnsupportedMediaFeatureRanges(css) {
  const findings = [];
  let quote = null;
  let inComment = false;
  for (let index = 0; index < css.length; index += 1) {
    const character = css[index];
    const next = css[index + 1];
    if (inComment) {
      if (character === "*" && next === "/") {
        inComment = false;
        index += 1;
      }
      continue;
    }
    if (quote != null) {
      if (character === "\\") {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "/" && next === "*") {
      inComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (css.slice(index, index + 6).toLowerCase() !== "@media") continue;
    const boundary = css[index + 6];
    if (boundary != null && !/[\s(]/.test(boundary)) continue;
    const { prelude, end } = mediaPrelude(css, index + 6);
    if (/[<>]/.test(prelude)) {
      findings.push({ offset: index, prelude });
    }
    index = end;
  }
  return findings;
}

function collectCssFiles(directory, root = directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectCssFiles(path, root));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".css")) {
      files.push({ path, relativePath: relative(root, path) || basename(path) });
    }
  }
  return files;
}

export function checkAndroidWebviewBuild(directory) {
  if (typeof directory !== "string" || directory.length === 0) {
    throw new Error("Provide an explicit built asset directory.");
  }
  if (!existsSync(directory)) {
    throw new Error(`${basename(directory)}: built asset directory is missing.`);
  }
  if (!statSync(directory).isDirectory()) {
    throw new Error(`${basename(directory)}: built asset path is not a directory.`);
  }
  const cssFiles = collectCssFiles(directory).sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath),
  );
  if (cssFiles.length === 0) {
    throw new Error(`${basename(directory)}: built asset directory contains no CSS files.`);
  }

  let mediaRuleCount = 0;
  for (const file of cssFiles) {
    const css = readFileSync(file.path, "utf8");
    const findings = findUnsupportedMediaFeatureRanges(css);
    mediaRuleCount += (css.match(/@media\b/gi) ?? []).length;
    if (findings.length > 0) {
      throw new Error(
        `${file.relativePath}: built CSS contains ${findings.length} unsupported media feature range comparison(s).`,
      );
    }
  }
  return { cssFileCount: cssFiles.length, mediaRuleCount };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) {
      throw new Error("Provide exactly one explicit built asset directory.");
    }
    const result = checkAndroidWebviewBuild(process.argv[2]);
    console.log(
      `Android WebView CSS compatibility passed for ${result.cssFileCount} CSS file(s) and ${result.mediaRuleCount} media rule(s).`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Android WebView CSS compatibility check failed.");
    process.exitCode = 1;
  }
}
