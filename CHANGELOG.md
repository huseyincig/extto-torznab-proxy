# Changelog

## 1.0.7 — 2026-11-22

- **Torznab EXT Filtering & Sorting Options for qBittorrent RSS & Custom Clients (`server.js`)**: Added `extractBrowseFilters()` and extended `buildBrowsePath()`, `fetchBrowse()`, and `handleApi()` to forward validated EXT `/browse/` filter and sort parameters directly from `/api` requests without requiring a search keyword `q` (closes #5):
  - `user_nick` (alias: `uploader`): Filter torrents by EXT uploader nickname (e.g. `PSA`, `QxR`, `MeGusta`).
  - `sort`: Sort results by `age` (aliases: `created`, `date`, `time`), `seed` (aliases: `seeds`, `seeders`), `leech` (aliases: `leechs`, `leechers`, `peers`), `size`, `files`, or `comments`.
  - `order`: Sort direction (`desc` or `asc`; defaults to `desc` when `sort` is specified).
  - `age`: Upload time window (`0` = Last 24 Hours, `1` = Last 3 Days, `2` = Last Week, `3` = Last 2 Weeks, `4` = Last Month).
  - `ext_cat` (alias: `site_cat`, or `cat` when `1..10`): Native EXT site category ID (`1` = Movies, `2` = TV, `3` = Music, `4` = Games, `5` = Applications, `6` = Books, `7` = Anime, `8` = Other, `10` = XXX), while preserving standard Torznab `cat` filtering (`2000`, `5000`, `5070`).
  - `sub_cat`: Native EXT subcategory ID (`1..999`).
  - `page`: Upstream `/browse/` page number (`1..100`).
  - `with_adult`: Per-request adult content override (`0`/`1` or `false`/`true`) without altering the global Prowlarr/Sonarr/Radarr setting.
- **Keyword-Optional Browse Mode (`server.js`)**: When any filter or sort parameter (`filters.hasFilters`) is present on `/api?t=search`, `extractSearchInputs()` and `buildBrowsePath()` no longer inject the fallback `q=warm` term when `q` is empty, allowing qBittorrent RSS feeds to track an uploader's or category's latest uploads cleanly.
- **Interactive Web UI RSS & Filtered Feed URL Builder (`server.js`)**: Added an interactive **"RSS & Filtered Feed URL Builder (qBittorrent / RSS)"** card to the Web UI (`settingsHtml()`) localized across all 8 supported languages (`en`, `tr`, `es`, `ru`, `pt`, `fr`, `de`, `pl` — 117 keys per language) with live URL generation, one-click clipboard copy, and direct XML feed preview.
- **Acknowledgments**: Special thanks to [@blowfish602](https://github.com/blowfish602) for proposing custom EXT filtering and sorting parameters for qBittorrent RSS feeds in [#5](https://github.com/huseyincig/extto-torznab-proxy/issues/5).
- **Verification**: 39/39 unit & regression tests passing (`npm test`), including inline Web UI `<script>` compilation verification via `vm.Script`.

## 1.0.6 — 2026-11-21

- **Auto-Detected 8-Language Multilingual Web UI (`server.js`)**: Expanded automatic browser language detection (`navigator.languages` / `navigator.language`, `SUPPORTED_UI_LANGS`, `UI_I18N`, `resolveUiLang()`) to support **English (`en`)**, **Turkish (`tr`)**, **Spanish (`es`)**, **Russian (`ru`)**, **Portuguese (`pt`)**, **French (`fr`)**, **German (`de`)**, and **Polish (`pl`)** with 100% key parity across all 82 UI strings.
- **Prowlarr `{ImdbId:...}` & `q=tt...` Token Extraction (`server.js`)**: Added `extractSearchInputs()` to automatically extract IMDb IDs passed inside `q` (`{ImdbId:tt0903747}`, `{ImdbId:903747}`, or `tt0903747`) during Prowlarr searches and trigger the hybrid IMDb + title search pipeline while requiring the `tt` prefix in free text so numeric titles (`90210`, `1917`) are never misclassified.
- **Native Docker Environment Variable Overrides (`server.js`, `examples/docker-compose.yml`)**: Added `applyEnvOverrides()` directly in `loadConfig()` to support `FLARESOLVERR_URL` (for FlareSolverr or compatible services such as Byparr), `BASE_URL`, `PUBLIC_URL`, `SESSION_NAME`, and `API_KEY` environment variables without requiring an external wrapper script.
- **Unsupported External ID Query Guard (`server.js`)**: When a caller queries by an unsupported external ID parameter (`tmdbid`, `tvdbid`, `tvmazeid`, `rid`, `traktid`, `doubanid`) or by `imdbid` while `enableImdbSearch` is disabled—without a title `q`—`/api` now returns an empty Torznab `<channel>` immediately instead of falling back to `q=warm` and returning unrelated `"warm"` torrents.
- **HTML Parser, Date/Size & Reverse Proxy Hardening (`server.js`)**:
  - `decodeEntities()`: Added `safeFromCodePoint()` bounds checking (`0..0x10FFFF`, excluding UTF-16 surrogates `0xD800..0xDFFF`) and case-insensitive entity matching (`/&nbsp;/gi`) so malformed numeric entities (`&#99999999;`) never throw `RangeError`.
  - `parseSizeToBytes()`: Differentiated thousands-separator commas (`1,234.56 MB`) from decimal commas (`1,5 GB`) and guarded against `NaN` so `<size>NaN</size>` is never emitted.
  - `parseDateToRfc822()`: Restricted the fallback `new Date(text)` parser to strings containing a 4-digit year (`19xx` / `20xx`) so bare numbers (`"5"`, `"12"`) are never parsed by V8 as year `2001`.
  - `toRelativeTorrentPath()`: Normalized absolute mirror URLs (`https://ext.to/...`) in `findTorrentAnchor()` and `parseResults()` to relative pathnames so cross-mirror links are never dropped.
  - `getPublicBaseUrl()`: Added `X-Forwarded-Proto` (`https`/`http`) and `X-Forwarded-Host` support for reverse proxy deployments when `publicUrl` is empty.
  - `/warm`, `/cache/clear`, `/session/reset` & `saveConfig()`: Enabled both `GET` and `POST` methods on action endpoints, included `imdbTitleCache` in cache eviction/clearing, cleared stale search cache on `baseUrl`/`publicUrl` changes, and stopped the warm timer immediately when `warmEnabled` is unchecked.
- **GitHub Actions Buildx Caching (`.github/workflows/docker-image.yml`, `.github/workflows/docker-publish.yml`)**: Added `cache-from: type=gha` and `cache-to: type=gha,mode=max` to accelerate multi-arch container builds.
- **Acknowledgments**: Special thanks to [@ryandash](https://github.com/ryandash) for the ideas around Prowlarr `{ImdbId:...}` / `q=tt...` query token handling, `FLARESOLVERR_URL` environment variable configuration for FlareSolverr-compatible endpoints (such as Byparr), and GitHub Actions Buildx caching.
- **Verification**: 37/37 unit & regression tests passing (`npm test`).

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
