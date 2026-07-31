#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

const checks = [];

function check(label, condition, fix) {
  checks.push({ label, condition, fix });
}

const appCss = read("web/src/App.css");
const navCss = read("web/src/components/NavRail.css");
const heroCss = read("web/src/components/HeroSpotlight.css");
const themeCss = read("web/src/theme/theme.css");
const moodCss = read("web/src/components/MoodStrip.css");
const settingsCss = read("web/src/screens/Settings.css");
const detailCss = read("web/src/screens/Detail.css");
const browseCss = read("web/src/screens/Browse.css");
const setupNudgeCss = read("web/src/components/SetupNudge.css");
const installPromptCss = read("web/src/components/InstallPrompt.css");
const appSource = read("web/src/App.tsx");
const setupCredentials = read("web/src/lib/serverSetupCredentials.ts");
const setupInvite = read("web/src/lib/serverSetupInvite.ts");
const serverSetupWizard = read("web/src/components/ServerSetupWizard.tsx");
const ciWorkflow = read(".github/workflows/ci.yml");

check(
  "mobile app viewport reserves bottom navigation space exactly once",
  /--mobile-nav-reserve:\s*calc\(var\(--mobile-nav-height\)\s*\+\s*var\(--mobile-nav-bottom\)\s*\+\s*30px\)/.test(appCss) &&
    /height:\s*100dvh/.test(appCss) &&
    /padding-bottom:\s*var\(--mobile-nav-reserve\)/.test(appCss) &&
    /scroll-padding-bottom:\s*var\(--mobile-nav-reserve\)/.test(appCss) &&
    !/height:\s*calc\(100d?vh\s*-\s*var\(--mobile-nav-reserve\)\)/.test(appCss),
  "web/src/App.css must keep a full viewport scrollport and reserve the floating bottom nav only with padding.",
);

check(
  "short landscape phones cannot inherit the desktop side gutter",
  /@media\s*\(min-width:\s*700px\)\s*and\s*\(max-width:\s*950px\)\s*and\s*\(max-height:\s*500px\)[\s\S]*--nav-rail-width:\s*0px[\s\S]*--nav-safe-left:\s*0px/.test(appCss),
  "web/src/App.css must zero both desktop rail variables when the short-landscape bottom nav is active.",
);

check(
  "mobile Discover uses one horizontal inset layer",
  /@media\s*\(max-width:\s*767px\)[\s\S]*\.discover\s*\{[\s\S]*padding:\s*0;[\s\S]*\.discover-body\s*\{[\s\S]*padding:\s*0\s+var\(--sp-md\)/.test(read("web/src/screens/Discover.css")),
  "Discover.css must not stack parent, hero, and body padding on phone-width content.",
);

check(
  "mobile Settings does not duplicate the app nav reserve",
  !/\.settings-screen\s*\{[\s\S]{0,300}padding-bottom:\s*calc\(var\(--mobile-nav-reserve\)/.test(settingsCss),
  "Settings.css must leave the shared mobile navigation reserve to App.css.",
);

check(
  "mobile overlays cover the hidden bottom-nav region",
  /@media\s*\(max-width:\s*699px\)[\s\S]*\.detail\s*\{[\s\S]{0,220}inset:\s*0;/.test(detailCss) &&
    /@media\s*\(max-width:\s*699px\)[\s\S]*\.browse\s*\{[\s\S]{0,220}inset:\s*0;/.test(browseCss) &&
    !/inset:\s*0\s+0\s+calc\(var\(--mobile-nav-height\)/.test(`${detailCss}\n${browseCss}`),
  "Detail.css and Browse.css must cover the entire phone viewport while NavRail is hidden.",
);

check(
  "mobile setup and install cards stay above navigation without clipping",
  /@media\s*\(max-width:\s*640px\)[\s\S]*bottom:\s*calc\(var\(--mobile-nav-bottom\)\s*\+\s*var\(--mobile-nav-height\)[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/.test(setupNudgeCss) &&
    /@media\s*\(max-width:\s*699px\)[\s\S]*bottom:\s*calc\(var\(--mobile-nav-bottom\)\s*\+\s*var\(--mobile-nav-height\)/.test(installPromptCss),
  "SetupNudge.css and InstallPrompt.css must clear the floating nav and keep phone actions within their cards.",
);

check(
  "bottom cards do not pierce Browse or Detail modal state",
  (appSource.match(/detailItem\s*==\s*null\s*&&\s*browseContext\s*==\s*null/g)?.length ?? 0) >= 2,
  "App.tsx must hide both setup and install cards while either full-screen overlay is open.",
);

check(
  "bottom nav has fixed five-slot geometry on phones",
  /@media\s*\(max-width:\s*699px\)[\s\S]*\.nav-rail\s*\{[\s\S]*grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/.test(navCss) &&
    /width:\s*min\(428px,\s*calc\(100vw - 20px\)\)/.test(navCss) &&
    /height:\s*var\(--mobile-nav-height\)/.test(navCss),
  "web/src/components/NavRail.css must keep the mobile nav as a stable five-slot grid.",
);

check(
  "bottom nav accounts for iOS safe areas",
  /bottom:\s*var\(--mobile-nav-bottom\)/.test(navCss) &&
    /var\(--safe-area-bottom\)/.test(appCss) &&
    ["top", "right", "bottom", "left"].every((side) =>
      new RegExp(
        `--safe-area-${side}:\\s*max\\(env\\(safe-area-inset-${side}`,
      ).test(themeCss),
    ),
  "The floating nav must use the shared safe-area-aware bottom offset.",
);

check(
  "fixed phone surfaces inset interactive content on every edge",
  /@media\s*\(max-width:\s*699px\)[\s\S]*\.browse-inner\s*\{[\s\S]{0,300}padding:\s*max\(var\(--sp-lg\),\s*var\(--safe-area-top\)\)[\s\S]{0,180}max\(var\(--sp-lg\),\s*var\(--safe-area-right\)\)[\s\S]{0,180}max\(var\(--sp-xl\),\s*var\(--safe-area-bottom\)\)[\s\S]{0,180}max\(var\(--sp-lg\),\s*var\(--safe-area-left\)\)/.test(browseCss) &&
    /@media\s*\(max-width:\s*699px\)[\s\S]*\.detail-inner\s*\{[\s\S]{0,300}padding:\s*max\(var\(--sp-lg\),\s*var\(--safe-area-top\)\)[\s\S]{0,180}max\(var\(--sp-lg\),\s*var\(--safe-area-right\)\)[\s\S]{0,180}max\(var\(--sp-xl\),\s*var\(--safe-area-bottom\)\)[\s\S]{0,180}max\(var\(--sp-lg\),\s*var\(--safe-area-left\)\)/.test(detailCss) &&
    /@media\s*\(max-width:\s*699px\)[\s\S]*\.fs-panel\s*\{[\s\S]{0,260}top:\s*max\(var\(--sp-sm\),\s*var\(--safe-area-top\)\)[\s\S]{0,120}right:\s*max\(var\(--sp-sm\),\s*var\(--safe-area-right\)\)[\s\S]{0,120}bottom:\s*max\(var\(--sp-sm\),\s*var\(--safe-area-bottom\)\)[\s\S]{0,120}left:\s*max\(var\(--sp-sm\),\s*var\(--safe-area-left\)\)/.test(read("web/src/components/FilterSlideover.css")),
  "Browse, Detail, and the phone filter panel must keep interactive content clear of all native insets.",
);

check(
  "bottom nav labels cannot resize the layout",
  /text-overflow:\s*ellipsis/.test(navCss) &&
    /white-space:\s*nowrap/.test(navCss) &&
    /data-mobile-label/.test(navCss),
  "Mobile nav labels must use compact labels, no wrapping, and ellipsis.",
);

check(
  "mobile more sheet is constrained to the viewport",
  /max-height:\s*min\(430px,\s*calc\(100dvh - var\(--mobile-nav-height\) - var\(--mobile-nav-bottom\) - 42px\)\)/.test(navCss) &&
    /overflow-y:\s*auto/.test(navCss),
  "The mobile More sheet must be viewport-constrained and scrollable.",
);

check(
  "hero remains visible when window animations are suspended",
  /:root\[data-suspended\][\s\S]*:root\[data-unfocused\][\s\S]*\.hero-backdrop-layer[\s\S]*animation:\s*none\s*!important[\s\S]*opacity:\s*1\s*!important/.test(heroCss) &&
    /:root\[data-input-idle\][\s\S]*\.hero-content[\s\S]*animation:\s*none\s*!important[\s\S]*opacity:\s*1\s*!important/.test(heroCss),
  "HeroSpotlight.css must settle animated hero layers into a visible state when the window is suspended, unfocused, or idle.",
);

check(
  "interactive overlays cannot freeze on an invisible entrance frame",
  /:root\[data-suspended\]\s*:is\([\s\S]*\.detail[\s\S]*\.player-backdrop[\s\S]*:root\[data-unfocused\]\s*:is\([\s\S]*animation:\s*none\s*!important/.test(themeCss),
  "theme.css must settle Detail, Browse, and player/dialog entrances while global animation work is parked.",
);

check(
  "Describe a vibe panel has phone and tablet responsive layouts",
  /@media\s*\(max-width:\s*560px\)/.test(moodCss) &&
    /@media\s*\(min-width:\s*561px\)\s*and\s*\(max-width:\s*920px\)/.test(moodCss) &&
    /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/.test(moodCss) &&
    /overflow-x:\s*auto/.test(moodCss),
  "MoodStrip.css must handle compact phones, short phones, and tablet-width layouts.",
);

check(
  "settings collapses option cards into a native selector on mobile",
  /\.settings-mobile-picker\s*\{[\s\S]*display:\s*none/.test(settingsCss) &&
    /@media\s*\(max-width:\s*560px\)[\s\S]*\.settings-mobile-picker\s*\{[\s\S]*display:\s*flex/.test(settingsCss) &&
    /\.settings-subsection-picker\.is-option-only \.settings-option-strip\s*\{[\s\S]*display:\s*none/.test(settingsCss),
  "Settings mobile layouts must show the selector and hide dense option-card strips.",
);

check(
  "setup wizard debrid selector defaults to first provider",
  /export const DEFAULT_DEBRID_PROVIDER\s*=\s*DEBRID_PROVIDER_OPTIONS\[0\]\.provider/.test(setupCredentials) &&
    /provider:\s*"real_debrid"/.test(setupCredentials),
  "Server setup credentials must default to the first debrid provider option.",
);

check(
  "setup wizard invite preset defaults to first selector option",
  /DEFAULT_SERVER_SETUP_INVITE_PRESET_ID\s*=\s*SERVER_SETUP_INVITE_PRESETS\[0\]\.id/.test(setupInvite) &&
    /id:\s*"family_simple"/.test(setupInvite),
  "Server setup invite presets must default to the first option.",
);

check(
  "setup wizard uses selectors instead of first-field freeform traps",
  /DEBRID_PROVIDER_OPTIONS\.map/.test(serverSetupWizard) &&
    /SERVER_SETUP_INVITE_PRESETS\.map/.test(serverSetupWizard) &&
    /<select/.test(serverSetupWizard),
  "ServerSetupWizard.tsx must render provider and invite preset selectors.",
);

check(
  "CI runs app responsive contract",
  /check_app_responsive_contract\.mjs/.test(ciWorkflow),
  ".github/workflows/ci.yml must run this checker.",
);

const failures = checks.filter((entry) => !entry.condition);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`fail ${failure.label}`);
    console.error(`     ${failure.fix}`);
  }
  process.exit(1);
}

for (const entry of checks) {
  console.log(`ok   ${entry.label}`);
}
console.log("\nApp responsive contract checks passed.");
