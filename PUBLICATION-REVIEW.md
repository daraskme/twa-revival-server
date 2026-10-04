# Source snapshot notes

This file records the boundaries and verification limits of the published source snapshot. It does not certify game compatibility or a live deployment.

## Source and data boundary

The snapshot contains 42 TypeScript files and 11 SQL migrations. Thirty-seven TypeScript files and all 11 migrations retain their bytes from the current `source/private-server` tree. The five adapted files are `src/accounts.ts`, `src/career.ts`, `src/loadouts.ts`, `src/native-battle-maps.ts`, and `src/party-presentation.ts`. They read three omitted game-related tables through local ignored files: `data/commanders.json`, `data/native-loadouts.json`, and `data/native_battle_maps.json`.

The three committed `*.example.json` files are synthetic. In particular, a real map manifest used with this source must supply `legacy_defaults` containing valid keys for both `territory` and `annihilation`. No extracted game tables, client files, assets, executable files, DLLs, test fixtures, runtime records, or populated databases are included.

## Validation limits

The package scripts expose synthetic data preparation and TypeScript typechecking only. A previous `typecheck:synthetic` run passed in a disposable copy using the then-existing local dependencies. This is a compile check against synthetic data shapes, not a test of HTTP routes, Epic authentication, rooms, matchmaking, relay traffic, SQL behavior against a real database, Cloudflare bindings, native clients, or gameplay.

The omitted data, Wrangler configuration, account identifiers, bindings, and secrets are intentional. This snapshot has no development server, deployment, or database-migration command. Any future runtime work must use separately authorized data and a private deployment environment.

## Source review limits

The source includes protocol references and game-specific concepts needed by the implementation. Their presence is application code; this repository does not include extracted catalogs or tables. A bounded static scan can detect common credential formats and large inline payloads, but cannot establish provenance or rights for every identifier or protocol reference. No software reuse license is granted; see the repository README.
