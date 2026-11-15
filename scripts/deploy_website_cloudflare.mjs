#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const websiteSourceDir = join(root, "website-app");
const websiteDir = join(websiteSourceDir, "dist");
const deployOnly = process.argv.includes("--deploy-only");
const requiredTokenScopes = [
  "Account:Cloudflare Pages:Edit",
  "Account:Workers Scripts:Edit",
  "Zone:Zone:Read",
  "Zone:Workers Routes:Edit",
];

const config = {
  domain: env("CLOUDFLARE_DOMAIN", "tgk30.com"),
  prefix: normalizePrefix(env("CLOUDFLARE_PATH", "/debridstreamer")),
  project: env("CLOUDFLARE_PAGES_PROJECT", "debridstreamer"),
  productionBranch: env("CLOUDFLARE_PAGES_BRANCH", "main"),
  scriptName: env("CLOUDFLARE_WORKER_NAME", "debridstreamer-site-path"),
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID?.trim(),
  zoneId: process.env.CLOUDFLARE_ZONE_ID?.trim(),
  token: process.env.CLOUDFLARE_API_TOKEN?.trim(),
};

function env(name, fallback) {
  const value = process.env[name]?.trim();
  return value || fallback;
}

function normalizePrefix(value) {
  const path = value.startsWith("/") ? value : `/${value}`;
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function runNode(script) {
  execFileSync(process.execPath, [join(root, script)], {
    cwd: root,
    stdio: "inherit",
  });
}

function buildWebsite() {
  execFileSync("npm", ["ci"], {
    cwd: websiteSourceDir,
    stdio: "inherit",
  });
  execFileSync("npm", ["run", "build"], {
    cwd: websiteSourceDir,
    stdio: "inherit",
  });
}

async function cloudflare(path, options = {}) {
  if (!config.token) {
    throw new Error("CLOUDFLARE_API_TOKEN is required.");
  }

  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${config.token}`,
      ...(options.body && typeof options.body === "string" ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Cloudflare returned non-JSON ${response.status}: ${text.slice(0, 300)}`);
  }
  if (!response.ok || json.success === false) {
    const errors = (json.errors ?? []).map((entry) => entry.message).join("; ");
    throw new Error(cloudflareErrorMessage(path, response.status, errors || text.slice(0, 300)));
  }
  return json.result;
}

function cloudflareErrorMessage(path, status, message) {
  const base = `Cloudflare API ${status}${message ? `: ${message}` : ""}`;
  if (status === 401 || status === 403 || path === "/user/tokens/verify") {
    return `${base}\n\nCheck CLOUDFLARE_API_TOKEN. It must be an API token with these scopes:\n- ${requiredTokenScopes.join("\n- ")}\n\nIf the token can see multiple accounts, set CLOUDFLARE_ACCOUNT_ID. If zone discovery is unavailable, set CLOUDFLARE_ZONE_ID.`;
  }
  return base;
}

async function resolveAccountId() {
  if (config.accountId) return config.accountId;
  const accounts = await cloudflare("/accounts?per_page=50");
  if (accounts.length === 1) return accounts[0].id;
  if (accounts.length === 0) throw new Error("No Cloudflare accounts visible to this token.");
  throw new Error("Multiple Cloudflare accounts visible. Set CLOUDFLARE_ACCOUNT_ID.");
}

async function resolveZoneId() {
  if (config.zoneId) return config.zoneId;
  const zones = await cloudflare(`/zones?name=${encodeURIComponent(config.domain)}&per_page=10`);
  const zone = zones.find((entry) => entry.name === config.domain);
  if (!zone) throw new Error(`No Cloudflare zone found for ${config.domain}.`);
  return zone.id;
}

async function ensurePagesProject(accountId) {
  try {
    await cloudflare(`/accounts/${accountId}/pages/projects/${encodeURIComponent(config.project)}`);
    return;
  } catch (error) {
    if (!String(error.message).includes("not found") && !String(error.message).includes("404")) {
      throw error;
    }
  }

  await cloudflare(`/accounts/${accountId}/pages/projects`, {
    method: "POST",
    body: JSON.stringify({
      name: config.project,
      production_branch: config.productionBranch,
    }),
  });
}

function deployPages(accountId) {
  execFileSync(
    "npx",
    [
      "--yes",
      "wrangler@latest",
      "pages",
      "deploy",
      websiteDir,
      "--project-name",
      config.project,
      "--branch",
      config.productionBranch,
    ],
    {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        CLOUDFLARE_ACCOUNT_ID: accountId,
        CLOUDFLARE_API_TOKEN: config.token,
      },
    },
  );
}

function workerSource() {
  const pagesOrigin = `https://${config.project}.pages.dev`;
  return `const PAGES_ORIGIN = ${JSON.stringify(pagesOrigin)};
const PREFIX = ${JSON.stringify(config.prefix)};

addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const incoming = new URL(request.url);
  if (incoming.pathname === PREFIX) {
    // Keep relative asset URLs under the mounted path.
    incoming.pathname = PREFIX + "/";
    return Response.redirect(incoming.toString(), 308);
  } else if (incoming.pathname.startsWith(PREFIX + "/")) {
    incoming.pathname = incoming.pathname.slice(PREFIX.length) || "/";
  } else {
    return new Response("Not found", { status: 404 });
  }

  const target = new URL(incoming.toString());
  const origin = new URL(PAGES_ORIGIN);
  target.protocol = origin.protocol;
  target.hostname = origin.hostname;
  target.port = "";

  const headersForOrigin = new Headers(request.headers);
  headersForOrigin.delete("Host");
  const requestInit = {
    headers: headersForOrigin,
    method: request.method,
    redirect: request.redirect,
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    requestInit.body = request.body;
  }

  const proxied = new Request(target.toString(), requestInit);
  const response = await fetch(proxied);
  const headers = new Headers(response.headers);
  const location = headers.get("Location");
  if (location !== null && [301, 302, 303, 307, 308].includes(response.status)) {
    try {
      const canonical = new URL(location, target);
      if (canonical.origin === origin.origin && !canonical.username && !canonical.password) {
        const mounted = canonical.pathname === PREFIX || canonical.pathname.startsWith(PREFIX + "/");
        headers.set("Location", (mounted ? canonical.pathname : PREFIX + canonical.pathname) + canonical.search + canonical.hash);
      }
    } catch {
      // Preserve malformed or noncanonical upstream locations without guessing.
    }
  }
  headers.set("X-YAWF-Stream-Site", "cloudflare-pages");
  if (response.ok && (request.method === "GET" || request.method === "HEAD")) {
    if (incoming.pathname.startsWith("/assets/")) {
      // Vite fingerprints production bundles, so a new deployment always
      // receives a new URL and can safely use immutable browser caching.
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
    } else if (/\\.(?:mp4|webm|png|jpe?g|webp|svg|ico|woff2?)$/i.test(incoming.pathname)) {
      // Public media keeps stable filenames. Revalidate daily so replacements
      // propagate without forcing every page visit to download them again.
      headers.set("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
    } else {
      headers.set("Cache-Control", "public, max-age=0, must-revalidate");
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
`;
}

async function uploadWorker(accountId) {
  await cloudflare(`/accounts/${accountId}/workers/scripts/${encodeURIComponent(config.scriptName)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/javascript" },
    body: workerSource(),
  });
}

async function upsertRoute(zoneId) {
  const pattern = `${config.domain}${config.prefix}*`;
  const routes = await cloudflare(`/zones/${zoneId}/workers/routes?per_page=100`);
  const existing = routes.find((route) => route.pattern === pattern);
  const body = JSON.stringify({ pattern, script: config.scriptName });

  if (existing) {
    await cloudflare(`/zones/${zoneId}/workers/routes/${existing.id}`, {
      method: "PUT",
      body,
    });
    return;
  }

  await cloudflare(`/zones/${zoneId}/workers/routes`, {
    method: "POST",
    body,
  });
}

async function main() {
  if (!existsSync(join(websiteSourceDir, "index.html"))) {
    throw new Error("website-app/index.html is missing.");
  }

  if (!deployOnly) {
    buildWebsite();
    runNode("scripts/check_website_app.mjs");
    runNode("scripts/check_website_download_logic.mjs");
    runNode("scripts/check_website_static.mjs");
    runNode("scripts/check_website_path_mount.mjs");
    runNode("scripts/public_repo_preflight.mjs");
  } else if (!existsSync(join(websiteDir, "index.html"))) {
    throw new Error("website-app/dist is missing. Build and validate the site before using --deploy-only.");
  }

  // /user/tokens/verify requires a "User → API Tokens → Read" scope that the
  // deploy itself doesn't need, so don't gate on it - the account/zone/Pages/
  // Workers calls below will fail clearly if the token lacks deploy permissions.
  try {
    await cloudflare("/user/tokens/verify");
  } catch (error) {
    console.warn(`Token self-verify skipped: ${String(error.message).split("\n")[0]}`);
  }
  const accountId = await resolveAccountId();
  const zoneId = await resolveZoneId();

  await ensurePagesProject(accountId);
  deployPages(accountId);
  await uploadWorker(accountId);
  await upsertRoute(zoneId);

  console.log(`Deployed https://${config.domain}${config.prefix}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
