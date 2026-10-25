#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

function ruleBlock(css, selector) {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) return "";
  const openingBrace = css.indexOf("{", start);
  let depth = 0;
  for (let index = openingBrace; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(start, index + 1);
    }
  }
  return "";
}

function atRuleBlock(css, header) {
  const start = css.indexOf(header);
  if (start < 0) return "";
  const openingBrace = css.indexOf("{", start);
  let depth = 0;
  for (let index = openingBrace; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(start, index + 1);
    }
  }
  return "";
}

function mediaBlocks(css) {
  const blocks = [];
  const headerPattern = /@media\s+[^\{]+\{/g;
  let match;
  while ((match = headerPattern.exec(css)) != null) {
    const openingBrace = match.index + match[0].lastIndexOf("{");
    let depth = 0;
    for (let index = openingBrace; index < css.length; index += 1) {
      if (css[index] === "{") depth += 1;
      if (css[index] === "}") {
        depth -= 1;
        if (depth === 0) {
          blocks.push({
            header: css.slice(match.index, openingBrace).trim(),
            css: css.slice(match.index, index + 1),
          });
          headerPattern.lastIndex = index + 1;
          break;
        }
      }
    }
  }
  return blocks;
}

const checks = [];

function check(label, condition, fix) {
  checks.push({ label, condition, fix });
}

const appCss = read("web/src/App.css");
const navCss = read("web/src/components/NavRail.css");
const heroCss = read("web/src/components/HeroSpotlight.css");
const globalSearchCss = read("web/src/components/GlobalSearch.css");
const discoverCss = read("web/src/screens/Discover.css");
const libraryScreensCss = read("web/src/screens/LibraryScreens.css");
const themeCss = read("web/src/theme/theme.css");
const moodCss = read("web/src/components/MoodStrip.css");
const settingsCss = read("web/src/screens/Settings.css");
const detailCss = read("web/src/screens/Detail.css");
const browseCss = read("web/src/screens/Browse.css");
const playerCss = read("web/src/components/VideoPlayer.css");
const playerSource = read("web/src/components/VideoPlayer.tsx");
const playerPauseCss = read("web/src/components/player/PlayerPauseOverlay.css");
const playerInfoCss = read("web/src/components/player/PlayerInfoPopover.css");
const setupNudgeCss = read("web/src/components/SetupNudge.css");
const installPromptCss = read("web/src/components/InstallPrompt.css");
const profileMenuCss = read("web/src/components/ProfileMenu.css");
const welcomeCss = read("web/src/components/WelcomeGuide.css");
const appSource = read("web/src/App.tsx");
const setupCredentials = read("web/src/lib/serverSetupCredentials.ts");
const setupInvite = read("web/src/lib/serverSetupInvite.ts");
const serverSetupWizard = read("web/src/components/ServerSetupWizard.tsx");
const ciWorkflow = read(".github/workflows/ci.yml");
const viteConfig = read("web/vite.config.ts");
const appShellRule = ruleBlock(appCss, ".app");
const appContentRule = ruleBlock(appCss, ".app-content");
const skipLinkRule = ruleBlock(appCss, ".skip-to-content");
const skipLinkFocusRule = ruleBlock(appCss, ".skip-to-content:focus");
const intermediatePlayerStart = playerCss.indexOf(
  "@media (min-width: 561px) and (max-width: 950px) {",
);
const intermediatePlayerEnd = playerCss.indexOf(
  "@media (max-width: 560px)",
  intermediatePlayerStart,
);
const intermediatePlayerCss = intermediatePlayerStart >= 0 && intermediatePlayerEnd > intermediatePlayerStart
  ? playerCss.slice(intermediatePlayerStart, intermediatePlayerEnd)
  : "";
const compactPlayerStart = playerCss.indexOf("@media (max-width: 560px) {");
const compactPlayerEnd = playerCss.indexOf(
  "@media (pointer: coarse)",
  compactPlayerStart,
);
const compactPlayerCss = compactPlayerStart >= 0 && compactPlayerEnd > compactPlayerStart
  ? playerCss.slice(compactPlayerStart, compactPlayerEnd)
  : "";
const shortLandscapePlayerStart = playerCss.indexOf(
  "@media (min-width: 561px) and (max-width: 950px) and (max-height: 500px)",
);
const shortLandscapePlayerCss = shortLandscapePlayerStart >= 0
  ? playerCss.slice(shortLandscapePlayerStart)
  : "";
const mobileNavStart = navCss.indexOf(
  "@media (max-width: 699px), (max-width: 950px) and (max-height: 500px)",
);
const extraCompactNavStart = navCss.indexOf("@media (max-width: 340px)", mobileNavStart);
const shortLandscapeNavStart = navCss.indexOf(
  "@media (max-width: 950px) and (max-height: 500px)",
  extraCompactNavStart,
);
const narrowNavStart = navCss.indexOf("@media (max-width: 380px)", shortLandscapeNavStart);
const trueDesktopNavQuery = "@media (min-width: 951px), (min-width: 700px) and (min-height: 501px)";
const standaloneCoarseAppCss = atRuleBlock(
  appCss,
  "@media (display-mode: standalone) and (pointer: coarse) {",
);
const standaloneScrollportRule = ruleBlock(
  atRuleBlock(standaloneCoarseAppCss, `${trueDesktopNavQuery} {`),
  ".app-content",
);
const standaloneDynamicScrollportRule = ruleBlock(
  atRuleBlock(standaloneCoarseAppCss, "@supports (height: 100dvh) {"),
  ".app-content",
);
const desktopBottomNavStart = navCss.indexOf(`${trueDesktopNavQuery} {`, narrowNavStart);
const mobileNavCss = mobileNavStart >= 0 && extraCompactNavStart > mobileNavStart
  ? navCss.slice(mobileNavStart, extraCompactNavStart)
  : "";
const extraCompactNavCss = extraCompactNavStart >= 0 && shortLandscapeNavStart > extraCompactNavStart
  ? navCss.slice(extraCompactNavStart, shortLandscapeNavStart)
  : "";
const shortLandscapeNavCss = shortLandscapeNavStart >= 0 && narrowNavStart > shortLandscapeNavStart
  ? navCss.slice(shortLandscapeNavStart, narrowNavStart)
  : "";
const narrowNavCss = narrowNavStart >= 0 && desktopBottomNavStart > narrowNavStart
  ? navCss.slice(narrowNavStart, desktopBottomNavStart)
  : "";
const setupNudgeMobileStackCss = atRuleBlock(
  setupNudgeCss,
  "@media (max-width: 699px), (max-width: 950px) and (max-height: 500px) {",
);
const setupNudgeBaseRule = ruleBlock(setupNudgeCss, ".setup-nudge");
const setupNudgeMobileStackRule = ruleBlock(setupNudgeMobileStackCss, ".setup-nudge");
const mobileNavRule = ruleBlock(mobileNavCss, ".nav-rail");
const mobileNavFrostRule = ruleBlock(mobileNavCss, ".nav-rail::after");
const mobileMoreScrimRule = ruleBlock(mobileNavCss, ".nav-rail-more-scrim");
const mobileNavButtonRule = ruleBlock(mobileNavCss, ".nav-rail-btn");
const mobileMoreSheetRule = ruleBlock(mobileNavCss, ".nav-rail-more-sheet");
const extraCompactNavRule = ruleBlock(extraCompactNavCss, ".nav-rail");
const shortLandscapeNavRule = ruleBlock(shortLandscapeNavCss, ".nav-rail");
const narrowNavRule = ruleBlock(narrowNavCss, ".nav-rail");
const welcomeSkipRule = ruleBlock(welcomeCss, ".welcome-skip");
const welcomeStageRule = ruleBlock(welcomeCss, ".welcome-stage");
const navMediaBlocks = mediaBlocks(navCss);
const desktopBottomNavBlocks = navMediaBlocks.filter(({ css }) =>
  css.includes(':root[data-nav-position="bottom"] .nav-rail {'),
);
const desktopCollapsedNavBlocks = navMediaBlocks.filter(({ css }) =>
  css.includes(':root[data-nav-collapsed="true"] .nav-rail-btn {'),
);
const phoneDiscoverCss = atRuleBlock(discoverCss, "@media (max-width: 767px) {");
const shortLandscapeDiscoverCss = atRuleBlock(
  discoverCss,
  "@media (max-width: 950px) and (max-height: 500px) {",
);
const phoneSearchCss = atRuleBlock(
  globalSearchCss,
  "@media (max-width: 699px), (max-width: 950px) and (max-height: 500px) {",
);
const globalSearchBaseRule = ruleBlock(globalSearchCss, ".global-search");
const libraryAbsoluteHeaderRule = ruleBlock(
  atRuleBlock(libraryScreensCss, `${trueDesktopNavQuery} {`),
  ".lib-screen",
);
const libraryPhoneRule = ruleBlock(
  atRuleBlock(libraryScreensCss, "@media (max-width: 699px) {"),
  ".lib-screen",
);
const coarseSearchCss = atRuleBlock(globalSearchCss, "@media (pointer: coarse) {");
const coarseSearchClearRule = ruleBlock(coarseSearchCss, ".global-search-clear");
const coarseNavCss = atRuleBlock(navCss, "@media (pointer: coarse) {");
const coarseNavCollapseRule = ruleBlock(coarseNavCss, ".nav-rail-collapse");
const tabletSearchCss = atRuleBlock(
  globalSearchCss,
  "@media (min-width: 700px) and (max-width: 1199px) and (min-height: 501px) {",
);
const safeHeroCss = atRuleBlock(
  heroCss,
  "@media (max-width: 767px), (max-width: 950px) and (max-height: 500px) {",
);
const shortLandscapeHeroControlsCss = atRuleBlock(
  heroCss,
  "@media (max-height: 500px) and (max-width: 950px) {",
);
const phoneSettingsCss = atRuleBlock(settingsCss, "@media (max-width: 699px) {");
const compactSettingsCss = atRuleBlock(settingsCss, "@media (max-width: 560px) {");
const tabletCategorySettingsCss = atRuleBlock(
  settingsCss,
  "@media (max-width: 1099px) {",
);
const tabletCategoryTabsRule = ruleBlock(tabletCategorySettingsCss, ".settings-tabs");
const tabletCategorySelectRule = ruleBlock(tabletCategorySettingsCss, ".settings-tab-select");
const tabletCategorySelectInputRule = ruleBlock(
  tabletCategorySettingsCss,
  ".settings-tab-select select",
);
const desktopSettingsCss = atRuleBlock(settingsCss, "@media (min-width: 1100px) {");
const desktopSettingsTabsRule = ruleBlock(desktopSettingsCss, ".settings-tabs");
const desktopSettingsSelectRule = ruleBlock(desktopSettingsCss, ".settings-tab-select");
const shortLandscapeSettingsCss = atRuleBlock(
  settingsCss,
  "@media (min-width: 700px) and (max-width: 950px) and (max-height: 500px) {",
);

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
  "general app shell tracks the dynamic viewport outside mobile media",
  /min-height:\s*100vh;\s*min-height:\s*100dvh;/.test(appShellRule) &&
    /height:\s*100vh;\s*height:\s*100dvh;/.test(appContentRule),
  "The base app and app-content rules must declare 100vh fallbacks immediately before 100dvh so tablet Safari uses its visible viewport.",
);

check(
  "standalone coarse non-phone scrollport consumes the top inset without moving fixed overlays",
  /--app-content-safe-top-consumed:\s*0px;/.test(appContentRule) &&
    /--app-content-safe-top-consumed:\s*var\(--safe-area-top\);/.test(standaloneScrollportRule) &&
    /margin-top:\s*var\(--app-content-safe-top-consumed\);/.test(standaloneScrollportRule) &&
    /height:\s*calc\(100vh - var\(--app-content-safe-top-consumed\)\);/.test(standaloneScrollportRule) &&
    !/100dvh/.test(standaloneScrollportRule) &&
    /height:\s*calc\(100dvh - var\(--app-content-safe-top-consumed\)\);/.test(standaloneDynamicScrollportRule) &&
    !/(?:transform|filter|perspective|contain|will-change|clip-path|--safe-area-top)\s*:/.test(`${appShellRule}\n${appContentRule}\n${standaloneCoarseAppCss}`) &&
    !/(?:padding|scroll-padding)-(?:top|bottom)\s*:/.test(standaloneCoarseAppCss),
  "App.css must physically inset only standalone coarse non-phone scrollports, keep legacy height fallback and fixed viewport coordinates, and leave global insets/nav reserves untouched.",
);

check(
  "short landscape phones cannot inherit the desktop side gutter",
  /@media\s*\(min-width:\s*700px\)\s*and\s*\(max-width:\s*950px\)\s*and\s*\(max-height:\s*500px\)[\s\S]*--nav-rail-width:\s*0px[\s\S]*--nav-safe-left:\s*0px/.test(appCss),
  "web/src/App.css must zero both desktop rail variables when the short-landscape bottom nav is active.",
);

check(
  "mobile Discover uses one horizontal inset layer",
  /\.discover\s*\{[\s\S]{0,160}padding:\s*0;/.test(phoneDiscoverCss) &&
    /\.discover-body\s*\{[\s\S]{0,180}padding:\s*0\s+max\(var\(--sp-md\),\s*var\(--safe-area-right\)\)[\s\S]{0,100}max\(var\(--sp-md\),\s*var\(--safe-area-left\)\)/.test(phoneDiscoverCss) &&
    /\.discover-body\s*\{[\s\S]{0,180}padding:\s*0\s+max\(var\(--sp-md\),\s*var\(--safe-area-right\)\)[\s\S]{0,100}max\(var\(--sp-md\),\s*var\(--safe-area-left\)\)/.test(shortLandscapeDiscoverCss),
  "Discover.css must not stack parent, hero, and body padding on phone-width content.",
);

check(
  "mobile search composes profile clearance with both native side insets",
  /\.global-search\s*\{[\s\S]{0,420}calc\(max\(var\(--sp-lg\),\s*var\(--safe-area-right\)\)\s*\+[\s\S]{0,180}max\(var\(--sp-lg\),\s*var\(--safe-area-left\)\)/.test(phoneSearchCss) &&
    /width:\s*min\(520px,\s*calc\(100% - 48px\)\)/.test(tabletSearchCss),
  "GlobalSearch.css must keep the input and profile clearance inside both native side insets on portrait and short-landscape phones.",
);

check(
  "tablet search clears the native top inset without double-insetting mobile sticky search",
  /top:\s*calc\(max\(var\(--sp-md\),\s*var\(--safe-area-top\)\)\s*-\s*var\(--app-content-safe-top-consumed,\s*0rem\)\)/.test(globalSearchBaseRule) &&
    /position:\s*sticky/.test(ruleBlock(phoneSearchCss, ".global-search")) &&
    /top:\s*var\(--sp-sm\)/.test(ruleBlock(phoneSearchCss, ".global-search")),
  "GlobalSearch.css must subtract the consumed inset from its complete max offset while mobile sticky search keeps its local offset.",
);

check(
  "coarse search clear control keeps a 44px touch target",
  /width:\s*44px/.test(coarseSearchClearRule) &&
    /height:\s*44px/.test(coarseSearchClearRule),
  "GlobalSearch.css must keep the clear control at least 44px square for coarse pointers.",
);

check(
  "library headers reserve the safe floating search row without double-insetting in-flow search",
  /--lib-floating-row-height:\s*calc\(44px\s*\+\s*var\(--sp-sm\)\s*\+\s*var\(--sp-sm\)\s*\+\s*2px\)/.test(libraryAbsoluteHeaderRule) &&
    /padding-top:\s*calc\(\s*max\(var\(--sp-md\),\s*var\(--safe-area-top\)\)\s*-\s*var\(--app-content-safe-top-consumed,\s*0rem\)\s*\+\s*var\(--lib-floating-row-height\)\s*\+\s*var\(--sp-md\)\s*\)/.test(libraryAbsoluteHeaderRule) &&
    /padding-top:\s*calc\(64px\s*\*\s*var\(--density-scale\)\)/.test(ruleBlock(libraryScreensCss, ".lib-screen")) &&
    /padding-top:\s*var\(--sp-lg\)/.test(libraryPhoneRule),
  "LibraryScreens.css must reserve the unconsumed safe offset, 44px search/profile control, field padding/border and a gap only in absolute-search layouts; phone and short-landscape in-flow spacing must stay unchanged.",
);

check(
  "coarse navigation collapse control keeps a 44px touch target",
  /width:\s*44px/.test(coarseNavCollapseRule) &&
    /height:\s*44px/.test(coarseNavCollapseRule),
  "NavRail.css must keep the collapse control at least 44px square for coarse pointers.",
);

check(
  "mobile hero keeps foreground controls safe while artwork stays full bleed",
  /--hero-viewport-left:\s*var\(--sp-md\)[\s\S]{0,100}--hero-viewport-right:\s*var\(--sp-md\)/.test(discoverCss) &&
    /\.hero-content\s*\{[\s\S]{0,260}padding-left:\s*max\([\s\S]{0,200}var\(--safe-area-left\)\s*-\s*var\(--hero-viewport-left,[\s\S]{0,260}padding-right:\s*max\([\s\S]{0,200}var\(--safe-area-right\)\s*-\s*var\(--hero-viewport-right,/.test(safeHeroCss) &&
    /\.hero-dots\s*\{[\s\S]{0,220}right:\s*max\([\s\S]{0,180}var\(--safe-area-right\)\s*-\s*var\(--hero-viewport-right,/.test(safeHeroCss),
  "Discover and HeroSpotlight must compose card margins with native side insets for actions and carousel controls without insetting the artwork.",
);

check(
  "short landscape hero actions clear the fixed bottom navigation",
  /\.hero-content\s*\{[\s\S]{0,480}inset:\s*0\s+0\s+auto\s+0[\s\S]{0,220}grid-template-areas:\s*[\s\S]{0,100}"badges badges"[\s\S]{0,80}"title actions"[\s\S]{0,260}padding-top:\s*calc\(34px\s*\+\s*calc\(4px\s*\*\s*var\(--density-scale\)\)\)[\s\S]{0,80}padding-bottom:\s*0/.test(shortLandscapeHeroControlsCss) &&
    /\.hero-actions\s*\{[\s\S]{0,160}grid-area:\s*actions[\s\S]{0,120}flex-wrap:\s*nowrap/.test(shortLandscapeHeroControlsCss),
  "HeroSpotlight.css must reflow the complete short-landscape hero above the fixed nav without clipping badges or removing either action.",
);

check(
  "mobile Settings keeps search and category controls inside native sides",
  /\.settings-screen\s*\{[\s\S]{0,180}padding-left:\s*max\(var\(--sp-xl\),\s*var\(--safe-area-left\)\)[\s\S]{0,120}padding-right:\s*max\(var\(--sp-xl\),\s*var\(--safe-area-right\)\)/.test(phoneSettingsCss) &&
    /\.settings-screen\s*\{[\s\S]{0,260}padding-left:\s*max\(var\(--sp-md\),\s*var\(--safe-area-left\)\)[\s\S]{0,120}padding-right:\s*max\(var\(--sp-md\),\s*var\(--safe-area-right\)\)/.test(compactSettingsCss) &&
    /\.settings-screen\s*\{[\s\S]{0,180}var\(--safe-area-left\)[\s\S]{0,120}var\(--safe-area-right\)/.test(shortLandscapeSettingsCss),
  "Settings.css must preserve its normal gutters while bounding controls by native side insets at phone and short-landscape breakpoints.",
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
  "mobile setup reminder stays below the modal navigation stack",
  /z-index:\s*40;/.test(setupNudgeBaseRule) &&
    /z-index:\s*29;/.test(setupNudgeMobileStackRule) &&
    /z-index:\s*30;/.test(mobileNavRule),
  "SetupNudge.css must preserve desktop layer 40 but use layer 29 at the exact mobile NavRail breakpoint so the layer-30 More dialog remains modal.",
);

check(
  "tablet and desktop setup reminder stays inside the available app content",
  /left:\s*calc\(var\(--nav-safe-left\)\s*\+\s*var\(--sp-lg\)\)/.test(setupNudgeBaseRule) &&
    /right:\s*var\(--sp-lg\)/.test(setupNudgeBaseRule) &&
    /margin-inline:\s*auto/.test(setupNudgeBaseRule) &&
    /width:\s*min\(\s*680px,\s*calc\(\s*100%\s*-\s*var\(--nav-safe-left\)\s*-\s*var\(--sp-lg\)\s*-\s*var\(--sp-lg\)\s*\)\s*\)/.test(setupNudgeBaseRule) &&
    /transform:\s*none/.test(setupNudgeBaseRule) &&
    !/left:\s*50%/.test(setupNudgeBaseRule),
  "SetupNudge.css must center the fixed reminder between the current nav-safe left edge and the right content edge without a viewport-centered transform.",
);

check(
  "mobile setup and install cards stay above navigation without clipping",
  /@media\s*\(max-width:\s*640px\)[\s\S]*right:\s*max\(var\(--sp-sm\),\s*var\(--safe-area-right\)\)[\s\S]{0,120}left:\s*max\(var\(--sp-sm\),\s*var\(--safe-area-left\)\)[\s\S]{0,160}bottom:\s*calc\(var\(--mobile-nav-bottom\)\s*\+\s*var\(--mobile-nav-height\)[\s\S]{0,260}width:\s*auto[\s\S]{0,180}margin-inline:\s*0[\s\S]{0,100}transform:\s*none[\s\S]{0,800}grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)[\s\S]{0,500}min-height:\s*44px/.test(setupNudgeCss) &&
    /@media\s*\(max-width:\s*699px\)[\s\S]*bottom:\s*calc\(var\(--mobile-nav-bottom\)\s*\+\s*var\(--mobile-nav-height\)/.test(installPromptCss),
  "SetupNudge.css and InstallPrompt.css must clear the floating nav, reset desktop centering inside native phone insets, and keep 44px phone actions within their cards.",
);

check(
  "welcome tour Skip stacks above its overlapping stage",
  /position:\s*absolute/.test(welcomeSkipRule) &&
    /z-index:\s*1;/.test(welcomeSkipRule) &&
    /position:\s*relative/.test(welcomeStageRule) &&
    !/z-index\s*:/.test(welcomeStageRule) &&
    !/pointer-events:\s*none/.test(welcomeStageRule),
  "WelcomeGuide.css must stack the positioned Skip above the later stage without disabling stage controls.",
);

check(
  "bottom cards do not pierce Browse or Detail modal state",
  (appSource.match(/detailItem\s*==\s*null\s*&&\s*browseContext\s*==\s*null/g)?.length ?? 0) >= 2,
  "App.tsx must hide both setup and install cards while either full-screen overlay is open.",
);

check(
  "bottom nav has fixed five-slot geometry on phones",
  /@media\s*\(max-width:\s*699px\)[\s\S]*\.nav-rail\s*\{[\s\S]*grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/.test(navCss) &&
    /width:\s*min\(\s*428px,\s*calc\(100vw - 20px - var\(--safe-area-left\) - var\(--safe-area-right\)\)\s*\)/.test(mobileNavRule) &&
    /height:\s*var\(--mobile-nav-height\)/.test(navCss),
  "web/src/components/NavRail.css must keep the mobile nav as a stable five-slot grid.",
);

check(
  "mobile bottom navigation centers within both native side insets",
  /left:\s*var\(--safe-area-left\);[\s\S]{0,80}right:\s*var\(--safe-area-right\);/.test(mobileNavRule) &&
    /margin-inline:\s*auto;/.test(mobileNavRule) &&
    /transform:\s*none;/.test(mobileNavRule) &&
    /width:\s*min\(\s*428px,\s*calc\(100vw - 20px - var\(--safe-area-left\) - var\(--safe-area-right\)\)\s*\)/.test(mobileNavRule) &&
    /position:\s*fixed;[\s\S]{0,100}left:\s*0;[\s\S]{0,80}right:\s*0;[\s\S]{0,180}width:\s*100vw;[\s\S]{0,500}transform:\s*none;/.test(mobileMoreScrimRule) &&
    /left:\s*var\(--safe-area-left\);[\s\S]{0,80}right:\s*var\(--safe-area-right\);/.test(mobileMoreSheetRule) &&
    /width:\s*min\(\s*428px,\s*calc\(100vw - 20px - var\(--safe-area-left\) - var\(--safe-area-right\)\)\s*\);/.test(mobileMoreSheetRule) &&
    /box-sizing:\s*border-box;/.test(mobileMoreSheetRule) &&
    /margin-inline:\s*auto;/.test(mobileMoreSheetRule) &&
    /width:\s*calc\(\s*100vw - 16px - var\(--safe-area-left\) - var\(--safe-area-right\)\s*\)/.test(extraCompactNavRule) &&
    /width:\s*min\(\s*620px,\s*calc\(100vw - 32px - var\(--safe-area-left\) - var\(--safe-area-right\)\)\s*\)/.test(shortLandscapeNavRule) &&
    /width:\s*min\(\s*calc\(100vw - 18px - var\(--safe-area-left\) - var\(--safe-area-right\)\),\s*392px\s*\)/.test(narrowNavRule),
  "NavRail.css must center the five-slot nav and More sheet inside both native side insets, with every compact width override reserving the same safe region.",
);

check(
  "mobile More overlay stays viewport-fixed outside the filtered nav decoration",
  /(?:^|\n)\s*backdrop-filter:\s*none/.test(mobileNavRule) &&
    /backdrop-filter:\s*blur\(22px\)\s*saturate\(1\.18\)/.test(mobileNavFrostRule) &&
    /position:\s*fixed;[\s\S]{0,100}left:\s*0;[\s\S]{0,80}right:\s*0;[\s\S]{0,80}bottom:\s*0;[\s\S]{0,180}height:\s*100vh;\s*height:\s*100dvh;/.test(mobileMoreScrimRule) &&
    /position:\s*fixed;[\s\S]{0,120}left:\s*var\(--safe-area-left\);[\s\S]{0,100}right:\s*var\(--safe-area-right\);/.test(mobileMoreSheetRule),
  "NavRail.css must transfer mobile frost to its decoration so the More scrim and sheet remain fixed to the viewport.",
);

check(
  "mobile More scrim blocks navigation beneath the modal sheet",
  /z-index:\s*32;/.test(mobileMoreScrimRule) &&
    /z-index:\s*31;/.test(mobileNavButtonRule) &&
    /z-index:\s*33;/.test(mobileMoreSheetRule),
  "NavRail.css must stack the viewport scrim above every nav button and below the More sheet so outside clicks dismiss without navigating.",
);

check(
  "desktop nav appearance overrides exclude mobile short landscape",
  desktopBottomNavBlocks.length === 1 &&
    desktopBottomNavBlocks[0].header === trueDesktopNavQuery &&
    /left:\s*50%;[\s\S]{0,80}right:\s*auto;[\s\S]{0,220}width:\s*auto;[\s\S]{0,320}transform:\s*translateX\(-50%\)/.test(desktopBottomNavBlocks[0].css) &&
    desktopCollapsedNavBlocks.length === 1 &&
    desktopCollapsedNavBlocks[0].header === trueDesktopNavQuery &&
    /data-nav-collapsed="true"[\s\S]{0,180}display:\s*none;[\s\S]{0,180}data-nav-collapsed="true"[\s\S]{0,160}flex-direction:\s*column/.test(desktopCollapsedNavBlocks[0].css),
  "NavRail.css must keep bottom-position and collapsed desktop overrides out of the 700px to 950px short-landscape mobile band.",
);

check(
  "mobile More sheet reserves the native top inset",
  /max-height:\s*min\(\s*430px,\s*calc\(100vh[^\n]*- 12px - 42px\),\s*calc\(100vh[^\n]*- var\(--safe-area-bottom\) - 42px\),\s*calc\(100vh[^\n]*- 12px - var\(--safe-area-top\) - calc\(14px \* var\(--density-scale\)\)\),\s*calc\(100vh[^\n]*- var\(--safe-area-bottom\) - var\(--safe-area-top\) - calc\(14px \* var\(--density-scale\)\)\)\s*\)/.test(mobileMoreSheetRule) &&
    !/max-height:[^;]*100dvh/.test(mobileMoreSheetRule),
  "NavRail.css must preserve the legacy viewport fallback and express the fixed and native-top reserves as separate legacy-compatible min branches.",
);

check(
  "mobile More max-height avoids a legacy dynamic-viewport var override",
  !/max-height:[^;]*100dvh/.test(mobileMoreSheetRule),
  "NavRail.css must not follow the valid 100vh More-sheet constraint with a 100dvh and custom-property declaration that WebView 91 accepts before invalidating at computed-value time.",
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
  "profile control clears native top and right insets",
  /\.profile-menu\s*\{[\s\S]{0,160}top:\s*calc\(max\(var\(--sp-md\),\s*var\(--safe-area-top\)\)\s*-\s*var\(--app-content-safe-top-consumed,\s*0rem\)\)[\s\S]{0,100}right:\s*max\(var\(--sp-lg\),\s*var\(--safe-area-right\)\)/.test(profileMenuCss),
  "ProfileMenu.css must subtract the consumed inset from its complete max offset, preserving normal spacing and the native right inset.",
);

check(
  "skip link is fully hidden independent of native top inset until focused",
  /top:\s*0;/.test(skipLinkRule) &&
    /transform:\s*translateY\(calc\(-100% - 2px\)\)/.test(skipLinkRule) &&
    /transform:\s*translateY\(max\(10px,\s*var\(--safe-area-top\)\)\)/.test(skipLinkFocusRule),
  "App.css must park the whole skip link above the viewport and move its focused state below the native top inset.",
);

check(
  "fixed phone surfaces inset interactive content on every edge",
  /@media\s*\(max-width:\s*699px\)[\s\S]{0,160}\(min-width:\s*700px\)\s*and\s*\(max-width:\s*950px\)\s*and\s*\(max-height:\s*500px\)[\s\S]*\.browse-inner\s*\{[\s\S]{0,300}padding:\s*max\(var\(--sp-lg\),\s*var\(--safe-area-top\)\)[\s\S]{0,180}max\(var\(--sp-lg\),\s*var\(--safe-area-right\)\)[\s\S]{0,180}max\(var\(--sp-xl\),\s*var\(--safe-area-bottom\)\)[\s\S]{0,180}max\(var\(--sp-lg\),\s*var\(--safe-area-left\)\)/.test(browseCss) &&
    /@media\s*\(max-width:\s*699px\)[\s\S]{0,160}\(min-width:\s*700px\)\s*and\s*\(max-width:\s*950px\)\s*and\s*\(max-height:\s*500px\)[\s\S]*\.detail-inner\s*\{[\s\S]{0,300}padding:\s*max\(var\(--sp-lg\),\s*var\(--safe-area-top\)\)[\s\S]{0,180}max\(var\(--sp-lg\),\s*var\(--safe-area-right\)\)[\s\S]{0,180}max\(var\(--sp-xl\),\s*var\(--safe-area-bottom\)\)[\s\S]{0,180}max\(var\(--sp-lg\),\s*var\(--safe-area-left\)\)/.test(detailCss) &&
    /@media\s*\(max-width:\s*699px\)[\s\S]*\.fs-panel\s*\{[\s\S]{0,260}top:\s*max\(var\(--sp-sm\),\s*var\(--safe-area-top\)\)[\s\S]{0,120}right:\s*max\(var\(--sp-sm\),\s*var\(--safe-area-right\)\)[\s\S]{0,120}bottom:\s*max\(var\(--sp-sm\),\s*var\(--safe-area-bottom\)\)[\s\S]{0,120}left:\s*max\(var\(--sp-sm\),\s*var\(--safe-area-left\)\)/.test(read("web/src/components/FilterSlideover.css")),
  "Browse, Detail, and the phone filter panel must keep interactive content clear of all native insets.",
);

check(
  "phone player keeps touch controls reachable without one overflowing row",
  /@media\s*\(max-width:\s*560px\)[\s\S]*\.player-osd-row\s*\{[\s\S]{0,260}display:\s*grid[\s\S]{0,260}grid-template-areas:[\s\S]{0,180}"transport transport"[\s\S]{0,120}"audio actions"/.test(playerCss) &&
    /padding-left:\s*max\(calc\(12px \* var\(--density-scale\)\),\s*var\(--safe-area-left\)\)/.test(playerCss) &&
    /padding-right:\s*max\(calc\(12px \* var\(--density-scale\)\),\s*var\(--safe-area-right\)\)/.test(playerCss) &&
    /\.player-osd \.chip\s*\{[\s\S]{0,120}min-height:\s*44px/.test(playerCss) &&
    /@media\s*\(pointer:\s*coarse\)[\s\S]*\.player-close[\s\S]{0,260}min-height:\s*44px/.test(playerCss) &&
    /@media\s*\(pointer:\s*coarse\)[\s\S]*\.player-options-sliders input[\s\S]{0,180}min-height:\s*44px/.test(playerCss) &&
    /@media\s*\(max-width:\s*560px\)[\s\S]*\.player-options-menu,[\s\S]{0,120}\.captions-menu\s*\{[\s\S]{0,420}overflow-y:\s*auto/.test(playerCss) &&
    /\.player-osd \.player-mobile-optional\s*\{[\s\S]{0,80}display:\s*none/.test(compactPlayerCss) &&
    /\.player-playback-status\s*\{[\s\S]{0,500}pointer-events:\s*none/.test(playerCss) &&
    playerCss.lastIndexOf("@media (max-width: 560px)") > playerCss.indexOf(".player-osd .chip {") &&
    playerCss.lastIndexOf("@media (pointer: coarse)") > playerCss.indexOf(".player-close,"),
  "VideoPlayer.css must use grouped phone rows and at least 44px coarse-pointer targets.",
);

check(
  "intermediate player controls keep three non-overlapping columns",
  /\.player-osd-row\s*\{[\s\S]{0,180}display:\s*grid[\s\S]{0,180}grid-template-columns:\s*minmax\(44px,\s*1fr\)\s+auto\s+max-content[\s\S]{0,160}column-gap:\s*calc\(4px \* var\(--density-scale\)\)/.test(intermediatePlayerCss) &&
    /\.player-osd-audio\s*\{[\s\S]{0,100}grid-column:\s*1/.test(intermediatePlayerCss) &&
    /\.player-osd-transport\s*\{[\s\S]{0,100}grid-column:\s*2/.test(intermediatePlayerCss) &&
    /\.player-osd-actions\s*\{[\s\S]{0,100}grid-column:\s*3/.test(intermediatePlayerCss) &&
    !/\.player-osd \.player-mobile-optional\s*\{[\s\S]{0,80}display:\s*none/.test(intermediatePlayerCss) &&
    /\.player-osd \.player-osd-icon-button\s*\{[\s\S]{0,120}width:\s*44px[\s\S]{0,80}min-width:\s*44px/.test(shortLandscapePlayerCss) &&
    /\.player-speed-control select\s*\{[\s\S]{0,120}width:\s*64px[\s\S]{0,80}min-width:\s*64px/.test(shortLandscapePlayerCss) &&
    /\.player-osd \.chip,[\s\S]{0,80}\.player-speed-control select\s*\{[\s\S]{0,80}min-height:\s*44px/.test(shortLandscapePlayerCss) &&
    /\.player-osd \.player-mobile-optional\s*\{[\s\S]{0,80}display:\s*none/.test(shortLandscapePlayerCss),
  "Intermediate widths must reserve independent audio, transport, and action columns; short landscape keeps 44px controls while hiding only optional cast and picture-in-picture actions.",
);

check(
  "shared touch player is host-gated and keeps supported actions scroll-reachable",
  /const sharedTouchPlayer\s*=\s*[\s\S]{0,180}mode === "webview"[\s\S]{0,140}!androidTVNative[\s\S]{0,180}dk === "ios" && !underTauri[\s\S]{0,80}\|\| androidAppUi/.test(playerSource) &&
    /className="player-touch-actions"[\s\S]{0,120}role="toolbar"/.test(playerSource) &&
    /\.player-touch-actions\s*\{[\s\S]{0,260}overflow-x:\s*auto[\s\S]{0,180}touch-action:\s*pan-x/.test(playerCss) &&
    /\.player-touch-actions \.player-mobile-optional\s*\{[\s\S]{0,80}display:\s*inline-flex/.test(playerCss) &&
    /\.player-touch-actions \.player-touch-action\s*\{[\s\S]{0,180}min-height:\s*46px/.test(playerCss) &&
    /\.player-touch-skip\s*\{[\s\S]{0,160}min-height:\s*56px/.test(playerCss) &&
    /\.player-touch-play\s*\{[\s\S]{0,120}clamp\(64px,\s*9vw,\s*72px\)/.test(playerCss),
  "VideoPlayer must select touch chrome from iOS browser or marked Android app identity after the TV escape, use 44px-plus controls, and scroll rather than hide supported actions.",
);

check(
  "shared touch timeline and sheets honor numeric feedback and all safe-area edges",
  /touchPresentation/.test(playerSource) &&
    /\.scrubbar-wrap\.is-touch \.scrubbar\s*\{[\s\S]{0,100}min-height:\s*44px/.test(playerCss) &&
    /\.scrubbar-wrap\.is-touch \.scrubbar-progress-thumb\s*\{[\s\S]{0,180}display:\s*block/.test(playerCss) &&
    /\.player\.is-touch-player \.player-options-menu,[\s\S]{0,420}var\(--safe-area-top\)[\s\S]{0,180}var\(--safe-area-right\)[\s\S]{0,180}var\(--safe-area-bottom\)[\s\S]{0,180}var\(--safe-area-left\)/.test(playerCss) &&
    /\.player-options-menu\.is-touch-audio-sheet/.test(playerCss),
  "Touch scrub feedback must keep a broad hit target and visible thumb, while focused audio, captions, and advanced sheets stay scrollable inside all native insets.",
);

check(
  "compact paused title reserves the visible player controls",
  /@media\s*\(max-width:\s*560px\)[\s\S]*--player-compact-osd-reserve:\s*calc\([\s\S]{0,260}\+\s*92px[\s\S]{0,180}var\(--safe-area-bottom\)/.test(playerCss) &&
    /@media\s*\(min-width:\s*561px\)\s*and\s*\(max-width:\s*950px\)\s*and\s*\(max-height:\s*500px\)[\s\S]*--player-compact-osd-reserve:\s*calc\([\s\S]{0,260}\+\s*44px[\s\S]{0,180}var\(--safe-area-bottom\)/.test(playerCss) &&
    (playerPauseCss.match(/calc\(\s*var\(--player-compact-osd-reserve\)\s*\+\s*calc\(10px \* var\(--density-scale\)\)\s*\)/g)?.length ?? 0) === 2 &&
    /max-height:\s*calc\([\s\S]{0,220}var\(--safe-area-top\)/.test(playerPauseCss),
  "The paused title must share the compact OSD reserve, keep a 10px gap, and stay below the safe-area-aware top bar.",
);

check(
  "legacy WebViews receive viewport fallbacks before dynamic viewport units",
  /\.full-viewport-boot\s*\{[\s\S]{0,180}min-height:\s*100vh;\s*min-height:\s*100dvh;/.test(appCss) &&
    /@media\s*\(max-width:\s*699px\),\s*\(max-width:\s*950px\)\s*and\s*\(max-height:\s*500px\)[\s\S]{0,320}\.app-content\s*\{[\s\S]{0,260}height:\s*100vh;\s*height:\s*100dvh;/.test(appCss) &&
    // Two webview surfaces and the native pause surface each retain a fallback.
    (playerPauseCss.match(/max-height:\s*calc\(\s*100vh[\s\S]{0,360}max-height:\s*calc\(\s*100dvh/g)?.length ?? 0) === 3 &&
    (playerInfoCss.match(/max-height:\s*calc\(100vh[\s\S]{0,240}max-height:\s*calc\(100dvh/g)?.length ?? 0) === 2 &&
    /\.nav-rail-more-scrim\s*\{[\s\S]{0,320}height:\s*100vh;\s*height:\s*100dvh;/.test(navCss) &&
    mobileMoreSheetRule.includes("max-height: min(") &&
    mobileMoreSheetRule.includes("calc(100vh") &&
    !/max-height:[^;]*100dvh/.test(mobileMoreSheetRule),
  "App boot and mobile scrollport, paused/player information surfaces, and the mobile More menu must declare 100vh before 100dvh for Android WebView 91.",
);

check(
  "production transforms target the five-year Android WebView floor",
  /build:\s*\{[\s\S]{0,320}target:\s*["']chrome90["'][\s\S]{0,160}cssTarget:\s*["']chrome90["']/.test(viteConfig),
  "Vite must target Chrome 90 for both JavaScript and CSS so WebView 91 keeps legacy media-query syntax.",
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
  /max-height:\s*min\(\s*430px,\s*calc\(100vh[^\n]*- 12px - 42px\),\s*calc\(100vh[^\n]*- var\(--safe-area-bottom\) - 42px\),\s*calc\(100vh[^\n]*- 12px - var\(--safe-area-top\)/.test(mobileMoreSheetRule) &&
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
  "tablet Settings replaces clipped category chips with the native selector",
  /display:\s*none/.test(tabletCategoryTabsRule) &&
    /display:\s*flex/.test(tabletCategorySelectRule) &&
    /flex-direction:\s*column/.test(tabletCategorySelectRule) &&
    /min-height:\s*44px/.test(tabletCategorySelectInputRule) &&
    !/\.(?:settings-screen|settings-header|settings-panel|settings-footer|settings-mobile-picker)\s*\{/.test(tabletCategorySettingsCss) &&
    /flex-direction:\s*column/.test(desktopSettingsTabsRule) &&
    /display:\s*none/.test(desktopSettingsSelectRule),
  "Settings.css must use the existing category select through 1099px without widening phone-only layout rules or changing the 1100px desktop sidebar.",
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
