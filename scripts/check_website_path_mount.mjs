#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const website = join(root, "website-app", "dist");
// Must match SITE_BASE in the build that produced website-app/dist.
const mount = `/${(process.env.SITE_BASE ?? "debridstreamer").replace(/^\/+|\/+$/g, "")}/`;
const html = readFileSync(join(website, "index.html"), "utf8");
const assetsDir = join(website, "assets");
const css = existsSync(assetsDir)
  ? readdirSync(assetsDir)
      .filter((name) => name.endsWith(".css"))
      .map((name) => readFileSync(join(assetsDir, name), "utf8"))
      .join("\n")
  : "";
const deployHelper = readFileSync(join(root, "scripts", "deploy_website_cloudflare.mjs"), "utf8");
const failures = [];

function fail(message) {
  failures.push(message);
}

function check(condition, message) {
  if (!condition) fail(message);
}

function attrsFrom(tag) {
  const attrs = {};
  const attrRe = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match;
  while ((match = attrRe.exec(tag)) != null) {
    attrs[match[1]] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attrs;
}

function tags(name) {
  return [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, "gi"))].map((match) => ({
    raw: match[0],
    attrs: attrsFrom(match[0]),
  }));
}

function isExternal(value) {
  return /^(?:https?:|mailto:|tel:|data:|blob:)/i.test(value);
}

function isLocalPath(value) {
  return value && !value.startsWith("#") && !isExternal(value);
}

function assertMountSafe(value, context) {
  if (!isLocalPath(value)) return;
  check(
    !value.startsWith("/") || value.startsWith(mount),
    `${context} resolves outside the mounted path: ${value}`,
  );

  const normalizedValue = (value.startsWith(mount) ? value.slice(mount.length) : value).split(/[?#]/)[0];
  const resolvedFile = normalize(join(website, normalizedValue));
  check(resolvedFile.startsWith(website), `${context} escapes website/: ${value}`);
  check(existsSync(resolvedFile), `${context} missing local file: ${value}`);

  const resolvedUrl = new URL(value, `https://example.test${mount}`);
  check(
    resolvedUrl.pathname.startsWith(mount),
    `${context} would resolve outside ${mount}: ${resolvedUrl.pathname}`,
  );
}

function srcsetUrls(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/)[0])
    .filter(Boolean);
}

for (const image of tags("img")) {
  assertMountSafe(image.attrs.src, `image ${image.attrs.src ?? ""}`);
  for (const src of srcsetUrls(image.attrs.srcset)) {
    assertMountSafe(src, `image srcset ${src}`);
  }
}

for (const source of tags("source")) {
  for (const src of srcsetUrls(source.attrs.srcset)) {
    assertMountSafe(src, `source srcset ${src}`);
  }
}
for (const link of tags("link")) assertMountSafe(link.attrs.href, `link ${link.attrs.href ?? ""}`);
for (const script of tags("script")) assertMountSafe(script.attrs.src, `script ${script.attrs.src ?? ""}`);

for (const match of css.matchAll(/url\(([^)]+)\)/g)) {
  const value = match[1].trim().replace(/^["']|["']$/g, "");
  assertMountSafe(value, `css url(${value})`);
}

const localExtensions = new Set([".css", ".js", ".png", ".jpg", ".jpeg", ".webp", ".svg", ".ico"]);
for (const match of html.matchAll(/\s(?:href|src)=["']([^"']+)["']/g)) {
  const value = match[1];
  if (isLocalPath(value) && localExtensions.has(extname(value.split(/[?#]/)[0]).toLowerCase())) {
    assertMountSafe(value, `asset ${value}`);
  }
}

for (const match of html.matchAll(/\ssrcset=["']([^"']+)["']/g)) {
  for (const value of srcsetUrls(match[1])) {
    if (isLocalPath(value) && localExtensions.has(extname(value.split(/[?#]/)[0]).toLowerCase())) {
      assertMountSafe(value, `asset srcset ${value}`);
    }
  }
}

check(/incoming\.pathname === PREFIX/.test(deployHelper), "Cloudflare Worker must handle the bare mount path");
check(/Response\.redirect\(incoming\.toString\(\), 308\)/.test(deployHelper), "Cloudflare Worker must redirect bare mount path with 308");
check(/PREFIX \+ "\/"/.test(deployHelper), "Cloudflare Worker must redirect to a trailing-slash mount path");
check(/workers\/routes/.test(deployHelper), "Cloudflare helper must install a Worker route");
check(/requiredTokenScopes/.test(deployHelper), "Cloudflare helper must document required token scopes in errors");
check(/Account:Cloudflare Pages:Edit/.test(deployHelper), "Cloudflare helper must require Pages edit scope");
check(/Account:Workers Scripts:Edit/.test(deployHelper), "Cloudflare helper must require Workers Scripts edit scope");
check(/Zone:Zone:Read/.test(deployHelper), "Cloudflare helper must require Zone read scope");
check(/Zone:Workers Routes:Edit/.test(deployHelper), "Cloudflare helper must require Workers Routes edit scope");
check(/status === 401 \|\| status === 403/.test(deployHelper), "Cloudflare helper must give actionable auth errors");
check(!/console\.error\(config\.token/.test(deployHelper), "Cloudflare helper must not print the token");
check(!/headersForOrigin\.set\(["']Host["']/.test(deployHelper), "Cloudflare Worker should let fetch derive the Host header from the Pages origin URL");
check(/headersForOrigin\.delete\(["']Host["']/.test(deployHelper), "Cloudflare Worker should strip the incoming Host header before proxying to Pages");
check(
  /max-age=31536000, immutable/.test(deployHelper),
  "Cloudflare Worker must cache fingerprinted bundles immutably",
);
check(
  /max-age=86400, stale-while-revalidate=604800/.test(deployHelper),
  "Cloudflare Worker must cache stable media with bounded revalidation",
);
check(
  /max-age=0, must-revalidate/.test(deployHelper),
  "Cloudflare Worker must keep route HTML revalidating",
);

if (failures.length > 0) {
  console.error("Website mounted-path check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Website mounted-path check passed.");
