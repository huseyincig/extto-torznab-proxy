# Changelog

## 1.0.5 — 2026-11-21

- **Hybrid IMDb + Title Search Architecture (`server.js`)**: When `imdbid` is queried (`t=tvsearch` or `t=movie`), the proxy now combines three search strategies and deduplicates by torrent ID (`mergeSearchItems`):
  1. Primary `imdb_id=tt...` + query token (`Sxx` / `SxxExx`).
  2. Secondary `imdb_id=tt...` full-pack lookup (without `q=Sxx`) during season searches so `"Season X Complete"` packs are never filtered out by `Sxx` text matching.
  3. Automatic IMDb title & year resolution (`resolveImdbTitle`, cached 24h in `imdbTitleCache`) + text query fallback (`Breaking Bad S01`, `Dune Part Two 2024`) when Sonarr/Radarr Tier 0 omits `q`, ensuring uploads on the site that lack an IMDb database link are still returned while attaching `<torznab:attr name="imdb">` only to IMDb-verified rows.
- **Unclassified (`7000`) Category Resolution for Prowlarr (`server.js`)**: Added `resolveItemCategories()` and expanded `categoryFromRow()` (supporting both relative and full-domain `/movies/`, `/tv/`, `/anime/` links). Unclassified rows (`7000`) that pass through `filterItemsByCategory()` are now mapped to advertised Torznab categories (`2000`, `5000`, `5070`) based on query context and title structure (`S01`, `Season 1`, `S01E01`) so Prowlarr's `ReleaseSearchService.cs` (`line 222`) never drops them.
- **Web UI `enableImdbSearch` Toggle (`server.js`, `examples/config.example.json`)**: Added a persistent **Enable IMDb ID search (`imdbid`)** checkbox (`enableImdbSearch: true` by default) to the Web UI settings card with full Turkish and English translations, controlling whether `imdbid` is advertised in `/api?t=caps` and processed in `/api`.
- **Torznab Pagination (`offset` & `limit`) (`server.js`)**: Updated `<limits max="100" default="100" />` in `torznabCapsXml()` and added `paginateItems()` in `handleApi()` to slice results accurately by `offset` and `limit`, preventing Prowlarr/Sonarr/Radarr from executing redundant multi-page fetch loops.
- **Season-to-Episode Upgrade & Daily Series Support (`server.js`)**:
  - `buildSearchQuery()` now upgrades season-only tokens in `q` (`Season 2` / `S02`) to `S02E04` when both `season=2` and `ep=4` parameters are provided.
  - `buildTvToken()` now formats Sonarr daily series queries (`season=YYYY&ep=MM/DD`) into `YYYY.MM.DD` instead of `S2026E1118`.
- **Audio Channel, Video Codec & Date Dot Preservation (`server.js`)**: Updated `normalizeTitle()` to preserve dots inside audio channels (`5.1`, `7.1`, `2.0`, `DDP5.1`, `AAC2.0`, `DD+5.1`), video codecs (`H.264`, `H.265`), and daily episode dates (`YYYY.MM.DD`).
- **Public Tracker Freeleech Attributes (`server.js`)**: Added `<torznab:attr name="downloadvolumefactor" value="0" />` and `<torznab:attr name="uploadvolumefactor" value="1" />` to `torznabResultsXml()`.
- **Verification**: 29/29 unit & regression tests (`npm test`) and live end-to-end acceptance verified against **Prowlarr `v3.0.2.5780`**, **Sonarr `v4.0.20.3014`**, and **Radarr `v7.0.3.10918`**.

## 1.0.4 — 2026-11-21

- **IMDb ID (`imdbid`) Search Support (`server.js`)**: Added `imdbid` (`tt1234567` and numeric `1234567`) support for `movie-search` and `tv-search` in `/api?t=caps` and `/api`, normalizing IDs via `normalizeImdbId()`, forwarding `imdb_id=tt...` to upstream `/browse/`, emitting `<torznab:attr name="imdb">` / `<torznab:attr name="imdbid">`, and returning Torznab error `201` on malformed `imdbid` parameters (closes #3).

## 1.0.3 — 2026-11-18

- **Torznab Capabilities Category Alignment (`server.js`)**: Restricted advertised Torznab `<categories>` in `/api?t=caps` to Movies (`2000`), TV (`5000`), and Anime (`5070`) for clean Prowlarr indexer synchronization with Sonarr and Radarr.

## 1.0.2 — 2026-11-18

- **FlareSolverr Diagnostics & Parser Hardening (`server.js`)**: Surfaced underlying `cause.code` (`ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`) and target URLs on FlareSolverr connection failures, serialized FlareSolverr session operations via `withFsLock()`, fixed relative age parsing in `parseDateToRfc822()`, fixed comma-formatted seeders/leechers (`1,234`), hardened `decodeEntities()` and `xmlEscape()`, and prevented `setLimitedCache()` from evicting unrelated keys on updates (addresses #2).

## 1.0.1 — 2026-09-28

- **RFC 7230 Magnet `Location` Header Normalization (`server.js`)**: Added `normalizeMagnet()` to strip control characters and percent-encode non-ASCII characters in resolved magnet URIs without double-encoding existing tracker parameters, preventing `TypeError [ERR_INVALID_CHAR]: Invalid character in header content ["Location"]` crashes on `/download` redirects (fixes #1).

## 1.0.0 — 2026-06-03

- **Initial Release**: Self-hosted Generic Torznab proxy for EXT-style torrent search pages with persistent FlareSolverr session management, automated warm timer, separate search and magnet LRU caches, on-demand magnet resolution, and bilingual (TR/EN) Web UI.
