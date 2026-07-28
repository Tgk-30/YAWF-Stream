# YAWF Stream Deep Research Prompts for v1 and v2

Prepared 2026-07-21 for the current DebridStreamer/YAWF Stream project.

This pack is designed to produce evidence that can be compared and synthesized, not a pile of generic feature ideas. Run the prompts in waves. Save each report with the suggested file name, then return the reports together with the source links or citation appendix.

## How to use this pack

1. Start a fresh Deep Research task for each numbered prompt.
2. Paste the shared context and research contract below, followed by one numbered prompt.
3. Ask for Markdown output and save it under the suggested file name.
4. Do not silently merge reports or remove disagreements. Conflicting evidence is useful.
5. Run prompts 01 through 12 first. They establish product truth, target users, positioning, and the critical pre-v1 journey.
6. Run prompts 13 through 36 next in any order, or prioritize the surfaces that matter most.
7. Run prompts 37 and 38 only after the earlier reports are complete. They are synthesis prompts.

## Shared product context to paste before every prompt

```text
Product: YAWF Stream, whose public repository is currently named DebridStreamer.

Public sources:
- Product site: https://tgk30.com/debridstreamer/
- Public repository: https://github.com/Tgk-30/DebridStreamer
- Latest releases: https://github.com/Tgk-30/DebridStreamer/releases/latest

Current product direction:
- Free, MIT-licensed, open-source streaming software built around user-supplied debrid accounts and user-controlled data.
- Desktop app for macOS, Windows, and Linux using a React/Tauri shell.
- Browser/PWA client and a self-hosted server mode for households.
- Local mode and server mode, profiles, roles, invites, separate history/watchlists, personal credential overrides, and operator diagnostics.
- Catalog discovery, search, browse, calendar, media detail, watch state, watchlist, library, and history.
- Stream discovery through built-in or user-configured indexers, multi-provider cache checks, source deduplication/ranking, and support for Real-Debrid, AllDebrid, Premiumize, and TorBox.
- Native desktop playback, browser playback with HLS compatibility paths, external-player handoff, subtitles, AI subtitle translation, and a desktop download queue with optional optimized transcode.
- AI-assisted discovery and recommendations, appearance customization, Simple/Advanced disclosure, privacy/network modes, signed updates, and self-host deployment tooling.
- Current brand language includes YAWF Stream, "Your Accounts. Watch Freely.", and "Yours. Always. Wherever. Forever." The visual system is cinematic, dark-first, glassy, and uses cool blue/violet in the app while the website currently emphasizes stream teal.

Important cautions:
- Establish the exact current state before judging gaps. Historical repository audits can be stale, and the public release may be newer than checked-in website metadata.
- Do not assume a feature is absent because an old audit says so. Verify it against the latest release, current source, release notes, documentation, and issue history.
- Distinguish the desktop app, hosted web/PWA, self-hosted server, public website, and unshipped legacy SwiftUI surface. Do not blend their capabilities.
- Treat legal availability, provider policies, platform rules, codecs, and competitor capabilities as time-sensitive.
```

## Shared research contract to paste before every prompt

```text
Work as a skeptical senior product researcher. Browse the current web and verify all time-sensitive facts. Prefer primary sources such as official documentation, release notes, platform policies, standards, source code, and issue trackers. Use recent user discussions and reviews for sentiment, but label anecdotes and selection bias. Date every source and cite every material claim with a direct link.

Rules:
1. Start by confirming the latest YAWF Stream release/tag and the artifact or commit you assessed.
2. Separate observed facts, user-reported evidence, inference, and recommendation.
3. Do not invent market size, conversion rates, user counts, complaints, feature availability, effort, or legal conclusions.
4. Prefer evidence from the last 24 months. Mark older evidence as background.
5. Look for disconfirming evidence and explain where sources disagree.
6. Compare relevant alternatives, but do not recommend copying a competitor without explaining the user job and fit.
7. Account for a small open-source team, cross-platform maintenance cost, privacy goals, and the difference between local and server modes.
8. Avoid feature bloat. Identify what should be removed, deferred, simplified, or made more honest as well as what should be added.
9. Treat v1 as a trust and adoption milestone. Reserve large, uncertain platform bets for v2 unless evidence proves they are release blockers.

Use this report structure:
- Executive answer
- Scope, methods, sources, and limitations
- Current YAWF Stream baseline
- Findings with evidence and confidence
- Relevant competitor or benchmark table
- Opportunities and risks
- Recommendations split into: Must before v1, Should before v1, Explicitly defer to v2, Do not pursue
- For each recommendation: user problem, proposed outcome, reach, impact, confidence, effort, dependencies, risk, reversibility, and success metric
- The smallest validation experiment that could falsify each major recommendation
- Open questions and missing evidence
- Source appendix with direct links and access dates

End with a one-page decision brief that another product lead can use without rereading the full report.
```

## Wave 1: Establish product truth and the pre-v1 decision frame

### 01. Current-state truth map and version parity

Suggested file: `01-current-state-truth-map.md`

```text
Create an independently verified current-state map of YAWF Stream across the public website, latest GitHub release, default branch, desktop artifacts, hosted PWA, and self-hosted server. Build a capability matrix covering install, onboarding, catalog, debrid providers, indexers, playback paths, downloads, subtitles, AI, sync/imports, profiles, remote access, diagnostics, security, update/signing status, and platform limitations. Identify stale copy, dead links, version drift, conflicting documentation, features present in code but not reachable in the UI, and claims that are not supported by the latest shipping artifact. Distinguish local unshipped code from public user reality. Rank every mismatch by user harm and release risk. Produce a concise canonical product fact sheet that all later reports should use.
```

### 02. Category, market, and alternative-solution map

Suggested file: `02-category-and-market-map.md`

```text
Define the category YAWF Stream should compete in and the category language users actually understand. Map direct, adjacent, and substitute solutions, including Stremio and its addon ecosystem, Kodi, Plex, Jellyfin, Emby, Infuse, VidHub, Debrid Media Manager, Stremio-like debrid clients, debrid provider interfaces, local media servers, and manual torrent plus external-player workflows. For each, research target user, core job, onboarding cost, supported platforms, privacy model, discovery, source selection, playback reliability, household features, downloads, remote access, pricing, and current user sentiment. Identify underserved jobs that fit YAWF Stream's architecture and traps that would turn it into a poor clone. Recommend a defensible category statement for v1 and a broader v2 category option.
```

### 03. Voice-of-customer pain and switching triggers

Suggested file: `03-voice-of-customer.md`

```text
Mine recent, public user evidence from relevant GitHub issues, Reddit communities, forums, app reviews, Discord excerpts when publicly indexed, support threads, and competitor issue trackers. Find recurring pain in setup, keys, debrid configuration, indexers, source choice, playback, subtitles, downloads, mobile/TV use, household sharing, remote access, reliability, privacy, and updates. Sample across novice, power-user, household-admin, and self-hosting users. Code the evidence into themes, frequency bands, severity, emotional language, workaround cost, and switching trigger. Include representative short quotations within copyright limits and direct links. Separate complaints YAWF Stream can credibly solve from ecosystem constraints it cannot. End with the ten problems most likely to affect adoption or retention before v1.
```

### 04. Jobs-to-be-done, personas, and target-user priority

Suggested file: `04-jtbd-and-personas.md`

```text
Develop an evidence-backed jobs-to-be-done model for YAWF Stream. Test at least these candidate segments: solo "just play it" viewer, privacy-focused desktop user, debrid power user, household member, household server operator, remote traveler, subtitle/language-learning user, and open-source self-hoster. For each, document trigger, desired progress, current alternatives, functional and emotional jobs, anxieties, unacceptable friction, willingness to configure, devices used, and success moment. Score segment attractiveness against problem intensity, reachable channels, product fit, maintenance burden, support burden, and strategic differentiation. Recommend one primary v1 user, one secondary v1 user, and the segments to defer until v2. Include the implications for onboarding, defaults, copy, navigation, platform support, and roadmap cuts.
```

### 05. Positioning and value-proposition research

Suggested file: `05-positioning-and-value-proposition.md`

```text
Evaluate YAWF Stream's current positioning and brand promises against user language and competitive claims. Test whether "Your Accounts. Watch Freely." and "Yours. Always. Wherever. Forever." are clear, credible, memorable, and differentiated. Examine whether users understand "debrid," "self-hosted," "your accounts," "cached," and "server mode," and whether the current wording creates trust or confusion. Produce a positioning canvas with target, category, problem, alternative, unique value, proof, and reason to believe. Propose three evidence-backed positioning territories, each with homepage headline, subhead, proof points, objections, and what the product must actually deliver. Recommend one for v1 and state what should wait for v2.
```

### 06. Brand architecture, naming, and identity coherence

Suggested file: `06-brand-architecture-and-naming.md`

```text
Research the brand architecture problem created by the public repository name DebridStreamer, the product name YAWF Stream, the YAWF Group parent reference, different tag and installer naming, and the current mix of blue/violet app visuals and teal website visuals. Check name clarity, searchability, pronunciation, distinctiveness, confusion risk, domain/social availability, open-source discoverability, and obvious trademark conflicts using current sources. Audit how consistently the name, icon, tagline, tone, colors, screenshots, package names, updater copy, and documentation appear across user touchpoints. Recommend a low-risk v1 brand architecture and migration plan, plus optional v2 brand expansion. Do not give legal conclusions; identify where counsel or formal trademark search is needed.
```

### 07. v1 product promise and scope discipline

Suggested file: `07-v1-product-promise.md`

```text
Define the smallest product promise YAWF Stream can make at v1 and keep reliably across supported platforms. Use current capabilities, user expectations, competitor baselines, and release risk. Identify the one core loop that must feel complete, the supporting loops that must be good enough, and features that create disproportionate support or trust risk. Produce a "v1 means" contract for users, a non-goals list, a platform support matrix, honest limitation copy, and criteria for removing beta or experimental labels. Explicitly identify features that should be hidden, renamed, or deferred if they cannot meet the promise. Then define how the promise can widen in v2 without invalidating v1.
```

### 08. Public website conversion and credibility audit

Suggested file: `08-website-conversion-audit.md`

```text
Audit the current public YAWF Stream site as a conversion journey from first visit to an appropriate next action. Capture and inspect desktop and mobile screenshots of Home, Features, Download, Devices, Household, Self-host, Brand, and outbound release links. Evaluate message clarity, information scent, credibility, visual hierarchy, motion, accessibility, page speed, responsive behavior, trust proof, FAQ coverage, and whether the site routes different personas to the right path. Check every download and documentation claim against the latest release. Identify where the site is beautiful but unclear, where it overpromises, and where a visitor lacks proof. Recommend an evidence-backed v1 information architecture and prioritized CRO experiments with success metrics.
```

### 09. Discoverability, SEO, and intent capture

Suggested file: `09-discoverability-and-seo.md`

```text
Research how potential users would discover a product like YAWF Stream without already knowing its name. Build an intent map for queries around debrid streaming clients, desktop players, self-hosted household streaming, Real-Debrid/TorBox/Premiumize apps, private media discovery, PWA streaming, and relevant problem-led searches. Review current search results, competing pages, GitHub discoverability, metadata, structured data, documentation, release pages, backlink opportunities, and content gaps. Flag terms that carry legal, reputational, or platform-policy risk. Recommend a v1 technical SEO and content plan, a measurement plan, and a v2 authority-building strategy. Include exact page concepts, search intent, proof required, and expected time horizon without inventing traffic forecasts.
```

### 10. Acquisition and distribution strategy for a small open-source app

Suggested file: `10-acquisition-and-distribution.md`

```text
Research realistic acquisition channels for YAWF Stream given that it is free, open source, pre-v1, privacy-oriented, and maintained by a small team. Evaluate GitHub discovery, community launches, relevant subreddits and forums, creator reviews, product directories, package managers, app stores, Linux repositories, home-server catalogs, debrid-provider partnerships, documentation content, referral loops, and household invites. For each channel, assess audience fit, rules, credibility requirements, effort, moderation burden, legal/policy exposure, and likely feedback quality. Recommend a sequenced v1 launch plan and a v2 growth system. Include what must be true in the product and support experience before exposing it to each channel.
```

### 11. Download funnel, installer choice, and update trust

Suggested file: `11-download-install-update-funnel.md`

```text
Research the end-to-end journey from clicking Download to running an updated YAWF Stream app on macOS Apple Silicon, macOS Intel, Windows, and Linux. Verify current assets, naming, architecture detection, signing/notarization, warnings, permissions, package formats, checksums, auto-update behavior, rollback/recovery, and stale-version risks. Benchmark high-trust open-source download experiences. Identify abandonment points and confusing choices, especially for non-technical users. Recommend the simplest safe v1 download page and installer flow, including automatic platform detection with manual override, trust copy, release integrity checks, failure recovery, and post-install handoff. Separate platform-specific must-fixes from v2 packaging improvements such as package managers or store distribution.
```

### 12. First-run to first-play journey

Suggested file: `12-first-run-to-first-play.md`

```text
Analyze the complete new-user journey from first launch to successful playback for each existing path: just watch on this device, connect to a server, host for my family, and advanced setup. Reconstruct the current screens and decision points from the latest code and artifact. Measure interaction count, external-site hops, secrets required, validation points, waiting, terminology, failure states, reversibility, and moments where users must understand the architecture. Benchmark best-in-class setup flows with comparable constraints. Propose a v1 journey that minimizes time-to-first-success without hiding mandatory requirements or weakening security. Include screen-by-screen changes, default choices, recovery paths, instrumentation events, usability-test tasks, and target metrics. Reserve optional personalization and power-user setup for the right moment.
```

## Wave 2: Deep experience, functionality, and reliability research

### 13. BYOK, catalog, debrid, and indexer setup friction

Suggested file: `13-provider-and-key-setup.md`

```text
Research the safest and lowest-workload way to configure catalog metadata, debrid providers, optional ratings, AI, subtitles, and indexers. Map every current key or token, why it is needed, where users obtain it, provider terms, validation behavior, storage location, failure recovery, and whether it can be shared by a server. Compare BYOK, brokered keys, device flows, OAuth, deep links, guided copy, and capability-based onboarding. Identify which dependencies can be removed, deferred, bundled, proxied, or explained better for v1 without violating provider policies. Propose a progressive setup architecture that reaches a useful state early, then unlocks enrichment. Include security and support tradeoffs, exact user-facing terminology, and v2 opportunities.
```

### 14. Self-hosting from zero to household-ready

Suggested file: `14-self-hosting-zero-to-ready.md`

```text
Audit the complete self-hosting journey for a reasonably technical person and for a motivated novice: choosing a host, installing with desktop host mode, Docker, Debian package, NAS or home-server patterns, creating the owner account, adding credentials, inviting a household, enabling HTTPS or private-network access, updating, backing up, diagnosing, and recovering. Use current YAWF Stream docs and artifacts, then benchmark modern self-hosted products with unusually good onboarding. Identify manual commands, hidden prerequisites, security hazards, platform fragmentation, and recurring operator workload. Recommend a v1 golden path plus supported alternatives, with exact success and health checks. Define what can be automated safely now and what belongs in v2.
```

### 15. Settings information architecture and Simple/Advanced disclosure

Suggested file: `15-settings-and-progressive-disclosure.md`

```text
Research whether YAWF Stream's current Simple/Advanced model and settings categories match user mental models. Inventory every current setting, role restriction, platform restriction, server/local distinction, dependency, and default. Run a comparative IA review against consumer streaming apps, media servers, and power-user debrid tools. Identify settings that should be automatic, contextual, searchable, moved into the relevant task, grouped, renamed, resettable, hidden, or removed. Propose a v1 settings architecture with navigation, summaries, status, dependency explanations, safe defaults, and recovery. Include card-sorting and tree-testing plans that can validate the structure before implementation. Reserve only genuinely expert controls for Advanced mode.
```

### 16. Discovery, search, browse, and calendar experience

Suggested file: `16-content-discovery-experience.md`

```text
Evaluate YAWF Stream's discovery loop across Discover, global search, Search, Browse, Calendar, genres, rails, filters, watch state, and media cards. Research which discovery jobs matter to the priority v1 user and which are decorative or duplicative. Compare relevant products on speed, information density, recommendation transparency, search tolerance, filters, list continuity, ratings visibility, and paths from discovery to play. Audit the current cinematic visual hierarchy and responsive behavior using screenshots at key viewports. Recommend v1 improvements that reduce choice overload and dead ends, plus v2 differentiators. Include empty, loading, offline, no-key, no-result, and partially configured states.
```

### 17. Detail page and stream-choice simplification

Suggested file: `17-detail-and-stream-choice.md`

```text
Research how users choose a playable source when results vary by cache state, provider, quality, file size, codec, HDR, audio, release group, episode match, seeders, and compatibility. Reconstruct YAWF Stream's current detail-to-play flow and ranking logic, then compare debrid tools and media apps. Identify which information novices need, which information power users demand, and which signals are unreliable. Recommend a v1 default that can choose or strongly recommend a source, explain the choice, expose alternatives, recover from a bad match, and protect remote-bandwidth limits. Include specific row hierarchy, labels, filters, sorting, confidence states, edge cases, and validation metrics. Propose v2 automation only where it remains reversible and transparent.
```

### 18. Playback reliability and format strategy

Suggested file: `18-playback-reliability-and-formats.md`

```text
Research the playback reliability bar YAWF Stream must meet across macOS, Windows, Linux, major browsers, local mode, server mode, and remote access. Build a current capability and risk matrix for containers, codecs, profiles, bit depths, HDR formats, audio formats, subtitles, seeking, resume, chapters, direct play, native playback, HLS compatibility streaming, transcode fallback, and external-player handoff. Use official platform and codec documentation, current library capabilities, recent issue evidence, and competitor behavior. Define a representative pre-v1 playback test corpus and success criteria. Recommend a transparent fallback ladder, error taxonomy, user recovery controls, and platform claims. Put expensive or low-confidence format promises into v2.
```

### 19. Player controls, subtitles, and long-session UX

Suggested file: `19-player-controls-and-subtitles.md`

```text
Audit the actual player experience, not just codec support. Research transport controls, scrubbing, thumbnail previews, volume, speed, keyboard and remote input, fullscreen, aspect handling, stream switching, audio tracks, subtitle search/download/translation, caption appearance, sync offsets, up-next, autoplay, skip intro/credits, error recovery, and accessibility. Compare desktop, browser, mobile, and TV expectations. Identify the smallest consistent control model for v1 and platform-specific exceptions. Include focus, keyboard, screen-reader, reduced-motion, touch-target, and interruption behavior. Recommend which advanced functions belong in menus, which need first-class controls, and which should wait for v2.
```

### 20. Downloads, offline viewing, and optimized transcode

Suggested file: `20-downloads-and-offline.md`

```text
Research user jobs and failure modes for YAWF Stream's desktop download queue, background operation, pause/resume/cancel/force-stop, destination choice, progress, size estimates, storage pressure, source expiry, retries, optimized transcode, completed-file playback, reveal/open actions, and cleanup. Compare trustworthy download managers and offline viewing in media apps. Test whether "download" means the same thing to novices and debrid power users. Recommend a v1 workflow with clear states, safe defaults, accurate progress, recovery, disk-space behavior, and honest constraints when the app closes. Define the cross-platform and mobile boundary. Identify v2 opportunities such as scheduled downloads, remote queueing, device handoff, or server-managed offline copies only if policy and architecture allow them.
```

### 21. Mobile and PWA experience

Suggested file: `21-mobile-and-pwa.md`

```text
Assess whether the current PWA is a credible mobile product or only a remote web client. Research iOS/iPadOS and Android PWA capabilities and constraints for installation, media playback, background behavior, notifications, casting, downloads, wake locks, orientation, fullscreen, keyboard handling, storage, updates, and home-screen trust. Audit key YAWF Stream journeys at phone and tablet sizes, including onboarding, discovery, detail, stream choice, playback, settings, profiles, and server connection. Recommend the v1 supported promise, responsive changes, install education, and browser-specific fallback copy. Build a decision framework for v2 native mobile, continued PWA investment, or a hybrid approach.
```

### 22. Living-room, casting, and TV strategy

Suggested file: `22-living-room-and-tv.md`

```text
Research the highest-value path for YAWF Stream to reach televisions. Compare Chromecast, Google Cast, AirPlay, DLNA, smart-TV browsers/PWAs, Android TV, tvOS, Fire TV, phone-as-remote, and desktop-to-TV HDMI scenarios. For each, assess codec behavior, subtitle support, authentication, remote-control UX, debrid URL exposure, development effort, certification/store-policy risk, maintenance burden, and household fit. Verify what the current app can already do. Recommend a v1 interim story that is honest and supportable, plus a staged v2 platform strategy with kill criteria. Include the ten-foot UI requirements and a remote-input test plan.
```

### 23. Household profiles, governance, and shared-device safety

Suggested file: `23-household-profiles-and-governance.md`

```text
Research household expectations for profiles, separate history/watchlists, PINs or passwords, kids controls, maturity filters, viewing schedules, bandwidth/file-size limits, personal credentials, guest access, device sessions, admin roles, and account recovery. Compare consumer streaming services and self-hosted media servers. Audit YAWF Stream's current local and server-mode boundaries, including what is merely hidden versus actually enforced. Identify privacy leaks, confusing ownership, and operator workload. Recommend the minimum trustworthy household contract for v1, exact defaults, and controls that should wait for v2. Include threat scenarios without treating a household profile as a high-security boundary unless the implementation supports it.
```

### 24. Remote access, invitations, and device handoff

Suggested file: `24-remote-access-invites-and-handoff.md`

```text
Research the current remote-access and device-onboarding experience using direct LAN access, Tailscale, Cloudflare Tunnel/Access, reverse proxies, invite links, QR codes, desktop host mode, and PWA installation. Map novice and expert paths, security assumptions, certificate/cookie behavior, failure modes, network terminology, and what happens when a host sleeps or addresses change. Benchmark remote-access onboarding in strong self-hosted products. Recommend a v1 guided path, diagnostics, invite lifecycle, connection health, and recovery copy that reduce operator support. Define v2 options such as a relay or coordinated discovery only after assessing cost, privacy, abuse, and maintenance.
```

### 25. Watch data, Trakt, imports, sync, backup, and migration

Suggested file: `25-data-portability-and-sync.md`

```text
Research the jobs around bringing data into YAWF Stream, keeping it synchronized, moving between local and server modes, switching devices, recovering from failure, and leaving the product. Verify current behavior for Trakt, IMDb CSV, watchlist, history, ratings, taste signals, folders, profile data, settings, downloads, and server backups. Compare one-time import, two-way sync, conflict handling, scrobbling, export, and account unlink behavior in relevant products. Recommend a v1 data-portability contract with conflict rules, privacy boundaries, progress/error states, and safe rollback. Identify which sync systems add unacceptable release risk and should remain v2.
```

### 26. AI discovery, assistant, and subtitle translation

Suggested file: `26-ai-product-value.md`

```text
Evaluate every AI-related YAWF Stream job: mood or vibe discovery, curated recommendations, conversational assistant, provider comparison, memory/taste use, and subtitle translation. Research whether users value these jobs enough to justify keys, latency, cost, privacy concerns, setup, and interface complexity. Compare non-AI alternatives and current media-product AI patterns. Audit whether AI results lead to a useful next action or create dead ends. Recommend what, if anything, deserves v1 prominence, what should be optional, and what should be deferred or removed. Include provider-agnostic UX, local-model expectations, usage/cost transparency, failure states, evaluation datasets, hallucination risks, and measurable quality criteria.
```

### 27. Retention, re-engagement, and the return visit

Suggested file: `27-retention-and-reengagement.md`

```text
Research why users return to a streaming client after initial setup. Evaluate continue watching, watchlist, calendar, new-episode signals, history, recommendations, downloads, household activity, and server health as potential return loops. Compare products without importing manipulative engagement patterns. Identify high-value reminders versus notification noise and privacy risk. Recommend a v1 return-state hierarchy, re-engagement features, and lifecycle messages that help users complete intended viewing. Define v2 loops only when they strengthen user control. Include metrics such as activation, first successful play, successful return play, playback completion, source recovery, and retained configured users, with precise definitions rather than invented targets.
```

## Wave 3: Cross-cutting quality, growth, and governance research

### 28. Accessibility and inclusive media use

Suggested file: `28-accessibility-and-inclusive-use.md`

```text
Perform a combined accessibility research and audit program for YAWF Stream's website, desktop/web shell, onboarding, discovery, detail, stream picker, player, downloads, profiles, and settings. Use current screenshots, DOM/code inspection, keyboard testing, contrast measurement, zoom/reflow checks, reduced-motion behavior, and screen-reader spot checks. Map findings to current WCAG guidance without claiming compliance from screenshots alone. Include media-specific needs such as caption discovery, appearance, audio-track labeling, keyboard transport, time-based controls, and error recovery. Rank issues by blocked task and release risk. Recommend a v1 accessibility baseline, automated and manual test matrix, and v2 enhancements.
```

### 29. Performance and perceived speed

Suggested file: `29-performance-and-perceived-speed.md`

```text
Research and measure performance across website load, app startup, first catalog paint, search, Discover rails, image loading, detail opening, stream resolution/cache checks, time-to-first-frame, seeking, HLS fallback, download updates, settings saves, and server responses. Test representative low-end devices, average home networks, remote-server latency, large libraries, and partially failing providers. Separate actual latency from poor feedback or unstable layout. Benchmark user expectations and relevant technical budgets. Recommend v1 performance budgets, observability, loading/empty/error patterns, caching, cancellation, and progressive rendering. Identify large architectural optimizations that should wait for v2 unless they block the core promise.
```

### 30. Privacy, security, and trust communication

Suggested file: `30-privacy-security-and-trust.md`

```text
Research the trust model a reasonable YAWF Stream user needs to understand: local versus server mode, where debrid/catalog/AI/subtitle credentials live, what the server can see, provider URL exposure, personal credential overrides, profiles, remote access, updates, diagnostics, zero-telemetry claims, and threat boundaries. Review current security documentation and implementation claims against current code and release behavior. Compare how trustworthy open-source tools communicate similar tradeoffs. Identify confusing, absolute, or unsupported claims and moments where reassurance is missing. Recommend a plain-language v1 trust center, in-product disclosures, consent/permission moments, credential lifecycle, and security-reporting path. Keep deeper hardening proposals separate from communication fixes.
```

### 31. Support, documentation, diagnostics, and workload reduction

Suggested file: `31-support-docs-and-diagnostics.md`

```text
Design a research-backed support system for a small YAWF Stream team. Audit README, website guidance, setup docs, self-hosting docs, troubleshooting, in-app help, diagnostics export, health panels, error messages, GitHub issues, release notes, and recovery instructions. Build a likely support-demand taxonomy from competitor communities and YAWF Stream issue history. Identify questions the product should answer automatically, information safe diagnostics should collect, and where users need a decision tree rather than a long document. Recommend a v1 support funnel, documentation IA, issue templates, diagnostic bundle, status checks, and feedback loop. Estimate workload qualitatively and identify v2 self-service automation.
```

### 32. Privacy-preserving measurement and product KPIs

Suggested file: `32-measurement-and-kpis.md`

```text
Create a measurement strategy compatible with YAWF Stream's privacy and zero-telemetry positioning. Define a metric tree from successful setup and playback to reliability, repeat value, downloads, household use, and support burden. Distinguish metrics that can be computed locally, shown only to the user/admin, collected through explicit opt-in, inferred from release infrastructure, or learned through periodic research. Recommend a minimal v1 event and diagnostic schema without raw titles, stream URLs, credentials, or unnecessary identifiers. Include consent UX, retention, deletion, aggregation, sampling, and threat analysis. Provide an alternative no-product-telemetry research plan using opt-in surveys, usability tests, issue templates, and release/download data.
```

### 33. Localization and international expansion readiness

Suggested file: `33-localization-and-markets.md`

```text
Research where YAWF Stream may have organic international demand based on debrid-provider availability, competitor communities, operating-system mix, language needs, subtitle use, payment/provider access, and self-hosting adoption. Audit current English-only strings, hard-coded language lists, date/number formats, text expansion, right-to-left risk, subtitle language naming, search/catalog behavior, and documentation burden. Recommend whether localization is a v1 requirement, a v1 architectural prerequisite only, or a v2 feature. If localization is justified, prioritize languages with evidence and propose a contributor-friendly workflow, quality controls, glossary, and translated support strategy.
```

### 34. Open-source community and product sustainability

Suggested file: `34-open-source-community-and-sustainability.md`

```text
Research how YAWF Stream can attract useful contributors and sustain maintenance without compromising user trust or the MIT open-source model. Audit repository onboarding, roadmap visibility, issue labeling, good-first-issue quality, contribution boundaries, architecture docs, release cadence, governance, security reporting, funding options, and community channels. Compare healthy small open-source media projects and cautionary cases. Recommend a v1 contributor experience and launch posture, including what not to open for community design by committee. Define v2 sustainability options such as sponsorship, hosted convenience services, or partnerships, with conflict-of-interest and support-burden analysis.
```

### 35. Legal, platform-policy, and reputation risk map

Suggested file: `35-legal-policy-and-reputation.md`

```text
Create a jurisdiction-aware risk map for an open-source client that connects user-supplied debrid accounts, indexers, metadata services, subtitle services, AI providers, and self-hosted servers. Research current provider terms, API attribution rules, trademark/use guidelines, app-store and code-signing policies, DMCA/takedown processes, repository-host policies, website copy risk, logging/privacy obligations, and distribution-channel restrictions. Distinguish software functionality from user conduct and do not present the report as legal advice. Identify claims, defaults, bundled sources, screenshots, examples, and growth channels that could create avoidable risk. Recommend v1 mitigations and questions for qualified counsel, plus v2 constraints that should shape platform strategy.
```

### 36. v1 reliability, release, and failure-mode readiness

Suggested file: `36-v1-reliability-and-release-readiness.md`

```text
Independently assess whether YAWF Stream is ready to call v1 from a user-trust perspective. Review latest release artifacts, signing/notarization, clean-install evidence, update paths, migration compatibility, provider smoke tests, player fallbacks, server upgrades, backup/recovery, diagnostics redaction, accessibility, performance, dependency risk, and known warnings. Build a failure-mode and effects analysis for the core setup-to-play loop on every claimed platform. Separate hard launch blockers, documented limitations, post-launch follow-ups, and nonessential polish. Recommend a release-candidate test matrix, beta cohort, rollback plan, go/no-go criteria, and a 30-day v1 monitoring/support plan.
```

## Wave 4: Synthesis after the evidence is complete

### 37. Opportunity solution tree and concept portfolio

Suggested file: `37-opportunity-solution-tree.md`

```text
Use the full set of completed YAWF Stream research reports as source material. Do not perform a fresh generic brainstorm. Extract the priority user outcome, then build an opportunity solution tree that links evidence-backed user problems to multiple solution approaches and testable experiments. De-duplicate recommendations, preserve disagreements, expose dependencies, and flag proposals based on weak evidence. Produce a balanced portfolio across trust/reliability, workload reduction, core UX, reach, retention, brand, and growth. For each concept, score reach, impact, confidence, effort, risk, reversibility, ongoing maintenance, and time-to-learning. Identify quick wins, v1 blockers, v1 polish, v2 bets, and ideas to reject. End with the smallest set of experiments that most reduces roadmap uncertainty.
```

### 38. Final v1 plan and v2 strategic roadmap

Suggested file: `38-final-v1-v2-roadmap.md`

```text
Synthesize all completed YAWF Stream reports into one decision-ready product strategy. Reconcile contradictory findings by source quality and confidence instead of averaging them. Define the primary v1 user, product promise, core journey, supported platform contract, positioning, success metrics, release gates, and explicit non-goals. Produce a dependency-aware v1 plan split into blocker, must, should, and cut, with rationale and acceptance outcomes. Then define two or three coherent v2 strategic themes rather than a feature backlog. Include sequencing, opportunity cost, technical and policy dependencies, maintenance burden, validation checkpoints, kill criteria, and what new evidence would change the plan. Provide a Now/Next/Later roadmap, a risk register, and a one-page executive recommendation.
```

## Return package

When returning the reports for synthesis, include:

- All Markdown reports with their original file names.
- A source/citation appendix for each report.
- Any screenshots or comparison tables the research relied on.
- The latest release/tag and access date used by each researcher.
- A short note listing missing reports, blocked sources, or reports that used a different product version.
- Do not send only the final synthesis. The underlying reports are needed to challenge its assumptions.
