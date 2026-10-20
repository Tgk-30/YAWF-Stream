# Multi-User & Profiles

A DebridStreamer server is built for a household: multiple people, each with
their own sign-in and their own private history - while sharing one set of
provider credentials and one debrid-facing IP.

This guide covers how accounts, roles, and credentials fit together.

---

## Accounts and profiles

There are two related ideas:

- An **account** is a sign-in: a username, a password, and a role. The first
  account is the owner; others join by invite or are created by an admin.
- A **profile** is a viewer that owns a private set of data. Every account has at
  least one profile, and an account can add more **household sub-profiles** - for
  kids, guests, or a shared living-room TV - that switch _without re-signing-in_.
  See [Household sub-profiles](#household-sub-profiles-whos-watching) below.

Each profile keeps these **separate**:

- **Watch history** and **resume points** ("Continue Watching")
- **Watchlist**
- **Library** and its **folders**
- Personal **settings** (including the Simple/Advanced experience tier)
- Sign-in **sessions / devices** (each account can review and revoke their own)
- Optional **personal credential overrides** (see below)

One profile never sees another profile's history, watchlist, or library.

---

## Household sub-profiles ("Who's watching?")

Within a single account you can keep several **viewer profiles** that share the
sign-in but not the data - the same idea as the profile row on a streaming
service. Each sub-profile has its own history, watchlist, library, and
Simple/Advanced tier.

- **Add / rename / remove** sub-profiles in the account area (a colour-coded
  avatar is generated from the name). The original profile is the default and
  can't be removed; an account always keeps at least one.
- **Switch** with the **"Who's watching?"** picker. Picking a profile changes the
  active viewer for the session and instantly reloads that profile's data - no
  password and no re-sign-in. The switcher only appears once an account has more
  than one profile.
- A sub-profile is a **viewer, not a login**: it has no separate username, and an
  optional profile password is reserved for a future per-profile PIN (it isn't
  required to switch today - switching is allowed because you're already signed
  in to the account).
- Sub-profiles **inherit the account's role and credentials.** They're for
  separating *viewing*, not for granting different permissions; use separate
  accounts (with roles) when you need different privileges.

> Household sub-profiles are a **Server Mode** feature - they live on the
> self-hosted server, which is what stores each profile's separate data.

---

## Roles

Every account has a role that controls what it can do:

| Role | Can do |
| --- | --- |
| **Owner** | The first account created at setup. Full control: manage everyone, shared credentials, admin invites, diagnostics. Cannot be disabled. |
| **Admin** | Manage profiles, invites, shared credentials, and view usage/diagnostics. (Only the **owner** can create *admin*-level accounts or invites.) |
| **Member** | A normal household user: their own history, watchlist, library, settings, and optional personal overrides. |
| **Restricted** | A view-only household user. Can browse, search, watch, and keep their own history/watchlist/library + per-profile settings (and change their own password), but **cannot manage anything** - no credential changes, no creating/renaming/deleting profiles or sub-profiles, no invites, no admin/diagnostics. Strictly less than a Member. Use it for kids or guests who should watch but not reconfigure the server. The limits are enforced on the **server**, not just hidden in the UI. |

---

## Adding people: invite links vs. created profiles

Owners and admins manage users in **Settings → Server**. Two ways to add someone:

### Invite links (recommended)

Create an invite link in **Settings → Server**. Send it to the person. When they
open it, they:

1. Land in the hosted app,
2. Create **their own password** and an isolated profile,
3. Get signed in automatically.

You never have to share or type their password, and you never hand out the shared
debrid credentials. Invites can carry a role, a default Simple/Advanced tier, an
expiry, and a maximum number of uses.

### Created profiles

An owner/admin can also create a profile directly (username + initial password +
role + default tier). Useful when you'd rather set the account up yourself.

---

## Credentials: shared server-wide vs. per-profile overrides

This is the key concept for a household.

### Shared (server) credentials - the default

The owner/admin stores credentials **once, on the server** - debrid tokens, a
TMDB key, an AI provider key, an OpenSubtitles key, etc. These are encrypted at
rest. **Every profile uses them by default**, so family members can stream, get
recommendations, and fetch subtitles **without ever seeing or entering a token.**

### Personal (profile) overrides - optional

Any user can save their **own** credential for a provider in
**Settings → Server**, without admin involvement. When a profile has its own
credential for a provider, it is used **instead of** the shared one - but only
for that profile.

The server resolves credentials in this order, per provider, per profile:

1. **This profile's own override**, if set and active → use it.
2. Otherwise the **shared server credential**, if set → use it.
3. Otherwise that feature is unavailable for this profile.

Use cases for overrides: someone wants to bring their own debrid account, their
own AI key, or their own subtitle key, while still sharing everything else.

> Users can also change their **own password** from Settings → Server, so admins
> don't have to handle every password reset.

---

## What admins can see (and not see)

Owners/admins get diagnostics in **Settings → Server**:

- **Usage:** per-profile bandwidth served by the proxy - who is using the hosted
  network path, and how much.
- **Revocable stream access:** unexpired, unrevoked playback grants, bytes sent,
  HTTP status, and expiry. A completed transfer can still allow replay or seeking.
  An admin can **Terminate** its access so future requests are refused; already
  buffered video may continue. The panel shows the latest 100 valid grants.
  Terminating a listed grant reveals older grants when the list is full.
- **Health & warnings:** session counts, configuration flags (HTTPS cookies,
  proxy trust, etc.), and recent stream errors.
- **Audit log:** auth, credential changes, profile changes, and stream starts.

Privacy notes baked into the design:

- Credential **values** are never shown back or logged - only redacted status.
- Subtitle searches log language codes and whether free text was used, but
  **not the search text** itself.

---

## A typical household setup

1. Owner completes first-run setup on the server.
2. Owner adds shared credentials once: a TMDB key + a debrid provider (and
   optionally AI + OpenSubtitles keys).
3. Owner creates an **invite link** per family member and shares it.
4. Each member opens the link, sets their own password, and starts watching - 
   with their own history and watchlist, using the shared credentials, all
   egressing from the single server IP.
5. Anyone who wants to bring their own debrid/AI/subtitle account adds a
   **personal override** in Settings → Server.
