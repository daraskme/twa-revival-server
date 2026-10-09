# TWA Revival server source

Project links: [project website](https://darask.me/twa/) · [privacy](https://darask.me/twa/privacy/) · [support guide](https://darask.me/twa/support/) · [support repository](https://github.com/daraskme/twa-revival-support) · [Discord](https://discord.gg/w9vnpAJ7ET) · [launcher source](https://github.com/daraskme/twa-revival-launcher) · [data comparison](https://darask.me/twa/source/)

This repository is maintained by DARASK and publishes selected TypeScript server code and SQL migrations for inspection. It is a source snapshot, not a complete, running, or deployable service. The server routes, game client, and live environment have not been validated from this repository.

**All rights reserved. No software reuse license is granted.** This snapshot is published for code review.

## Service and development status — 2026-10-09

**Production remains in maintenance. New sign-ins and matchmaking are paused,
with existing battle relays left enabled. No reopening date is set.**
[Current progress and release checks (日本語 / English / Русский)](https://github.com/daraskme/twa-revival-support/blob/main/STATUS.md)
distinguish the live service, QA builds and unpublished work.

The internal integrated candidate adds battle configuration history and usage
queries, diagnostic stages, and moderation/lifecycle fixes. It passed 1,015
backend tests and typechecking; acceptance with the final signed game package,
both clients' results/rematches, complete equipped-skill capture and the website
is still pending. These results concern the internal candidate, **not this
public source snapshot**, and are not a deployment claim. Cost work also targets
redundant storage and polling; actual billing savings have not been established.

This update changes documentation only. The selected source, migrations,
synthetic examples and exclusions below are unchanged. Do not deploy this
snapshot as if it contained the current private candidate or production setup.

## What is included

The snapshot contains 42 TypeScript files, 11 SQL migrations, package metadata, and three independently authored synthetic JSON examples. Thirty-seven TypeScript files and all 11 migrations retain their current source bytes. Five TypeScript importers were adapted to read data from local ignored `data/*.json` files instead of importing omitted game-related tables.

The synthetic examples contain invented IDs, names, units, and map keys. They exist only to satisfy the import shapes for a local compile check. They have no game meaning and cannot interoperate with a game client. `native-battle-maps.ts` also expects a `legacy_defaults` object in the map manifest, with one valid map key for each ruleset. Any real data used with this changed contract must be separately authorized.

To run the synthetic typecheck with Node.js and npm installed:

```sh
npm ci --ignore-scripts
npm run typecheck:synthetic
```

The synthetic preparation script creates ignored `data/*.json` files and leaves any existing files in place. A prior typecheck passed in a disposable copy of this candidate. A typecheck only checks source consistency against these synthetic shapes; it does not validate API behavior, authentication, matchmaking, rooms, relays, migrations, Cloudflare bindings, a game client, or deployment.

## Exclusions and deployment

This selection excludes Creative Assembly game assets, executables and DLLs, extracted or other game-derived data tables, client files, tests and fixtures, runtime data, logs, Wrangler configuration, account values, and secrets. Do not commit real data, populated local databases, `.dev.vars`, `.env` files, or deployment credentials. No Wrangler config or deploy, database-mutation, or runtime command is included.

EOS settings and secret names in TypeScript are environment-variable declarations, not their values. Signing keys, EOS client secrets, administrator tokens and relay signing secrets belong only in the private deployment environment. See [SECURITY.md](SECURITY.md).

Project information and service updates are posted on the [project website](https://darask.me/twa/) and [Discord](https://discord.gg/w9vnpAJ7ET). Server verification results will be documented separately when available; this source snapshot does not claim a successful live service or gameplay test.

This is an independent fan project and is not affiliated with or endorsed by Creative Assembly, SEGA, or Epic Games.
