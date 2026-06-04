const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || "8998");
const CONFIG_DIR = process.env.CONFIG_DIR || "/config";
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

const DEFAULT_CONFIG = {
  baseUrl: "https://extranet.torrentbay.st",
  publicUrl: "",
  flaresolverrUrl: "http://flaresolverr:8191/v1",
  sessionName: "extto_persistent",
  apiKey: "",
  withAdult: true,
  warmEnabled: true,
  warmQuery: "warm",
  warmIntervalMinutes: 10,
  coldThresholdSeconds: 30,
  requestTimeoutMs: 120000,
  idleTimeoutMinutes: 360,
  searchTtlSeconds: 180,
  magnetTtlMinutes: 1440,
  maxSearchCacheItems: 100,
  maxMagnetCacheItems: 1000,
  stripSeasonFromSearch: true
};

let config = loadConfig();

let sessionReady = false;
let sessionBusy = false;
let fsBusy = false;
let lastUsed = Date.now();
let lastWarm = null;
let currentWarm = null;

const searchCache = new Map();
const magnetCache = new Map();

let sessionQueue = Promise.resolve();
let fsQueue = Promise.resolve();

function nowIso() {
  return new Date().toISOString();
}

function log(...args) {
  console.log(nowIso(), ...args);
}

function warn(...args) {
  console.warn(nowIso(), ...args);
}

function error(...args) {
  console.error(nowIso(), ...args);
}

function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function randomApiKey() {
  return crypto.randomBytes(18).toString("hex");
}

function loadConfig() {
  ensureConfigDir();

  if (!fs.existsSync(CONFIG_FILE)) {
    const initial = { ...DEFAULT_CONFIG, apiKey: randomApiKey() };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }

  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const merged = { ...DEFAULT_CONFIG, ...parsed };

    if (!merged.apiKey) {
      merged.apiKey = randomApiKey();
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
    }

    return merged;
  } catch (e) {
    error("[config] failed to read config, using defaults:", e.message || e);
    return { ...DEFAULT_CONFIG, apiKey: randomApiKey() };
  }
}

function saveConfig(next) {
  ensureConfigDir();
  config = { ...config, ...next };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function normalizeBaseUrl(s) {
  return String(s || "").replace(/\/+$/, "");
}

function xmlEscape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function htmlEscape(s) {
  return xmlEscape(s).replace(/'/g, "&#39;");
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripTags(s) {
  return decodeEntities(String(s || "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function pick(re, s) {
  const m = String(s || "").match(re);
  return m ? m[1] : "";
}

function withSessionLock(fn) {
  const run = sessionQueue.then(fn, fn);

  sessionBusy = true;

  sessionQueue = run
    .catch(() => {})
    .finally(() => {
      sessionBusy = false;
    });

  return run;
}

function withFsLock(fn) {
  const run = fsQueue.then(fn, fn);

  fsBusy = true;

  fsQueue = run
    .catch(() => {})
    .finally(() => {
      fsBusy = false;
    });

  return run;
}

async function fsCall(payload) {
  const url = config.flaresolverrUrl;

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const text = await r.text();

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("FlareSolverr bad JSON response: " + text.slice(0, 300));
  }

  if (!r.ok) {
    throw new Error("FlareSolverr HTTP " + r.status + ": " + text.slice(0, 300));
  }

  if (json.status && json.status !== "ok") {
    throw new Error("FlareSolverr status " + json.status + ": " + (json.message || ""));
  }

  return json;
}

async function destroySessionUnlocked() {
  try {
    await fsCall({
      cmd: "sessions.destroy",
      session: config.sessionName
    });
  } catch (e) {
    warn("[session] destroy ignored:", e.message || e);
  }

  sessionReady = false;
}

async function createSessionUnlocked() {
  await fsCall({
    cmd: "sessions.create",
    session: config.sessionName
  });

  sessionReady = true;
  lastUsed = Date.now();

  log("[session] created", config.sessionName);
}

async function ensureSessionUnlocked() {
  if (sessionReady) return;

  await destroySessionUnlocked();
  await createSessionUnlocked();
}

async function ensureSession() {
  return await withSessionLock(async () => {
    await ensureSessionUnlocked();
  });
}

async function resetSession() {
  return await withSessionLock(async () => {
    log("[session] reset");
    await destroySessionUnlocked();
    await createSessionUnlocked();
  });
}

function cookiesToHeader(cookies) {
  if (!Array.isArray(cookies)) return "";

  return cookies
    .filter(c => c && c.name && typeof c.value !== "undefined")
    .map(c => `${c.name}=${c.value}`)
    .join("; ");
}

function getUserAgent(solution) {
  return (
    solution &&
    (
      solution.userAgent ||
      solution.user_agent ||
      solution.headers?.["user-agent"] ||
      solution.headers?.["User-Agent"]
    )
  ) || "Mozilla/5.0";
}

async function fetchHtmlViaFlaresolverr(targetUrl) {
  await ensureSession();

  lastUsed = Date.now();

  let pageRes;

  try {
    pageRes = await fsCall({
      cmd: "request.get",
      url: targetUrl,
      session: config.sessionName,
      maxTimeout: Number(config.requestTimeoutMs || 120000)
    });
  } catch (e) {
    warn("[retry] request.get failed, resetting session:", e.message || e);

    await resetSession();

    pageRes = await fsCall({
      cmd: "request.get",
      url: targetUrl,
      session: config.sessionName,
      maxTimeout: Number(config.requestTimeoutMs || 120000)
    });
  }

  const html = pageRes && pageRes.solution ? pageRes.solution.response : "";

  if (!html) {
    throw new Error("empty html response");
  }

  return {
    html,
    solution: pageRes.solution || {}
  };
}

function setLimitedCache(map, key, value, maxItems, ttlMs) {
  if (map.size >= maxItems) {
    let oldestKey = null;
    let oldestTime = Infinity;

    for (const [k, v] of map.entries()) {
      const t = v.lastHitAt || v.createdAt || 0;
      if (t < oldestTime) {
        oldestTime = t;
        oldestKey = k;
      }
    }

    if (oldestKey) {
      map.delete(oldestKey);
    }
  }

  const now = Date.now();

  map.set(key, {
    value,
    createdAt: now,
    lastHitAt: now,
    expiresAt: now + ttlMs,
    hits: 0
  });
}

function getCache(map, key) {
  const item = map.get(key);
  if (!item) return null;

  if (Date.now() > item.expiresAt) {
    map.delete(key);
    return null;
  }

  item.hits++;
  item.lastHitAt = Date.now();

  return item.value;
}

function clearExpiredCache() {
  const now = Date.now();
  let removedSearches = 0;
  let removedMagnets = 0;

  for (const [key, value] of searchCache.entries()) {
    if (now > value.expiresAt) {
      searchCache.delete(key);
      removedSearches++;
    }
  }

  for (const [key, value] of magnetCache.entries()) {
    if (now > value.expiresAt) {
      magnetCache.delete(key);
      removedMagnets++;
    }
  }

  return { removedSearches, removedMagnets };
}

function padNumberText(value, width) {
  const n = String(value || "").replace(/\D+/g, "");
  if (!n) return "";
  return n.padStart(width, "0");
}

function buildTvToken(params) {
  const season = padNumberText(params.get("season"), 2);
  const ep = padNumberText(params.get("ep") || params.get("episode"), 2);

  if (season && ep) {
    return `S${season}E${ep}`;
  }

  if (season) {
    return `S${season}`;
  }

  return "";
}

function normalizeSearchQueryText(q) {
  return String(q || "")
    // Sonarr/Prowlarr can send "Title : S02". EXT searches work better without the colon.
    .replace(/\s*:\s*/g, " ")
    // "Season 2 Episode 4" / "Season 2 Ep 4" / "Season 2 E4" -> "S02E04"
    .replace(/\bSeason\s*(\d{1,2})\s*(?:Episode|Ep|E)\s*(\d{1,3})\b/gi, (_, s, e) => {
      return `S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}`;
    })
    // "Season 2" -> "S02"
    .replace(/\bSeason\s*(\d{1,2})\b/gi, (_, s) => {
      return `S${String(s).padStart(2, "0")}`;
    })
    // "S 2 E 4" / "S2E4" / "S02E4" -> "S02E04"
    .replace(/\bS\s*(\d{1,2})\s*E\s*(\d{1,3})\b/gi, (_, s, e) => {
      return `S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}`;
    })
    // "S 2" / "S2" -> "S02"
    .replace(/\bS\s*(\d{1,2})\b/gi, (_, s) => {
      return `S${String(s).padStart(2, "0")}`;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function queryHasTvToken(q) {
  return /\bS\d{2}(?:E\d{2,3})?\b/i.test(String(q || ""));
}

function buildSearchQuery(params) {
  let q = params.get("q") || params.get("search") || "";

  if (!q) {
    q = config.warmQuery || "warm";
  }

  q = normalizeSearchQueryText(q);

  const tvToken = buildTvToken(params);

  // Prowlarr tvsearch may pass season/ep separately instead of embedding them in q.
  // Keep the season/episode token and normalize it into: "Title S02" or "Title S02E04".
  if (tvToken && !queryHasTvToken(q)) {
    q = normalizeSearchQueryText(`${q} ${tvToken}`);
  }

  // The old config field name is kept for backward compatibility.
  // It now means "normalize TV tokens" rather than removing them.
  q = normalizeSearchQueryText(q);

  if (!q) {
    q = config.warmQuery || "warm";
  }

  log("[query]", "built", JSON.stringify({
    t: params.get("t") || "",
    q,
    season: params.get("season") || "",
    ep: params.get("ep") || params.get("episode") || ""
  }));

  return q;
}

async function fetchBrowse(q) {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const withAdult = config.withAdult ? "1" : "0";
  const searchPath = `/browse/?q=${encodeURIComponent(q).replace(/%20/g, "+")}&with_adult=${withAdult}`;
  const targetUrl = baseUrl + searchPath;
  const cacheKey = searchPath;
  const cached = getCache(searchCache, cacheKey);

  if (cached) {
    log("[cache] search hit", cacheKey);
    return cached;
  }

  return await withFsLock(async () => {
    const cachedAgain = getCache(searchCache, cacheKey);
    if (cachedAgain) {
      log("[cache] search hit after wait", cacheKey);
      return cachedAgain;
    }

    log("[flaresolverr] browse fetch", targetUrl);

    const r = await fetchHtmlViaFlaresolverr(targetUrl);
    const html = r.html;

    setLimitedCache(
      searchCache,
      cacheKey,
      html,
      Number(config.maxSearchCacheItems || 100),
      Number(config.searchTtlSeconds || 180) * 1000
    );

    log("[cache] search stored", cacheKey);

    return html;
  });
}

function getRows(html) {
  const m = String(html || "").match(/<table[^>]*class=["'][^"']*search-table[^"']*["'][^>]*>[\s\S]*?<\/table>/i);
  const table = m ? m[0] : html;

  const rows = [];
  const re = /<tr\b[^>]*>[\s\S]*?<\/tr>/gi;
  let row;

  while ((row = re.exec(table))) {
    rows.push(row[0]);
  }

  return rows;
}

function getTds(row) {
  const out = [];
  const re = /<td\b[^>]*>[\s\S]*?<\/td>/gi;
  let m;

  while ((m = re.exec(row))) {
    out.push(m[0]);
  }

  return out;
}

function normalizeTitle(s) {
  return stripTags(s)
    .replace(/_/g, " ")
    .replace(/\./g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseSizeToBytes(s) {
  const raw = String(s || "").replace(/,/g, ".").trim();
  const m = raw.match(/([\d.]+)\s*(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)/i);
  if (!m) return 0;

  const n = Number(m[1]);
  const unit = m[2].toUpperCase();

  const mult =
    unit === "B" ? 1 :
    unit === "KB" || unit === "KIB" ? 1024 :
    unit === "MB" || unit === "MIB" ? 1024 ** 2 :
    unit === "GB" || unit === "GIB" ? 1024 ** 3 :
    unit === "TB" || unit === "TIB" ? 1024 ** 4 :
    1;

  return Math.max(0, Math.floor(n * mult));
}

function parseDateToRfc822(s) {
  const text = stripTags(s);
  const d = new Date(text);

  if (!isNaN(d.getTime())) {
    return d.toUTCString();
  }

  return new Date().toUTCString();
}

function categoryFromRow(row) {
  if (/href=["']\/movies\//i.test(row)) return 2000;
  if (/href=["']\/anime\//i.test(row)) return 5070;
  if (/href=["']\/tv\//i.test(row)) return 5000;
  return 7000;
}

function attr(tag, name) {
  const re = new RegExp(name + "\\s*=\\s*([\"'])(.*?)\\1", "i");
  const m = String(tag || "").match(re);
  return m ? decodeEntities(m[2]) : "";
}

function findTorrentAnchor(row) {
  const re = /<a\b[^>]*>[\s\S]*?<\/a>/gi;
  let m;

  while ((m = re.exec(row))) {
    const a = m[0];
    const cls = attr(a, "class");
    const href = attr(a, "href");

    if (cls && cls.split(/\s+/).includes("torrent-title-link") && href) {
      const text = a.replace(/<a\b[^>]*>/i, "").replace(/<\/a>/i, "");
      return { href, text };
    }
  }

  // fallback: class yakalanamazsa torrent detay URL'sine benzeyen ilk link
  re.lastIndex = 0;
  while ((m = re.exec(row))) {
    const a = m[0];
    const href = attr(a, "href");

    if (href && /^\/.+-\d+\/?$/.test(href)) {
      const text = a.replace(/<a\b[^>]*>/i, "").replace(/<\/a>/i, "");
      return { href, text };
    }
  }

  return null;
}

function parseResults(html, req) {
  const rows = getRows(html);
  const items = [];

  for (const row of rows) {
    const found = findTorrentAnchor(row);
    if (!found) continue;

    let relPath = found.href;
    const title = normalizeTitle(found.text);

    if (!title || !relPath) continue;

    if (relPath.startsWith(config.baseUrl)) {
      relPath = relPath.slice(normalizeBaseUrl(config.baseUrl).length);
    }

    if (!relPath.startsWith("/")) continue;

    if (!relPath.endsWith("/")) {
      relPath += "/";
    }

    const id = relPath.replace(/\/$/, "").split("-").pop();
    if (!id || !/^\d+$/.test(id)) continue;

    const tds = getTds(row);

    const sizeText = tds[1] ? stripTags(tds[1]) : "";
    const dateText = tds[3] ? stripTags(tds[3]) : "";
    const seedersText = tds[4] ? stripTags(tds[4]) : "0";
    const leechersText = tds[5] ? stripTags(tds[5]) : "0";

    const size = parseSizeToBytes(sizeText);
    const seeders = Number((seedersText.match(/\d+/) || ["0"])[0]);
    const leechers = Number((leechersText.match(/\d+/) || ["0"])[0]);
    const category = categoryFromRow(row);

    const publicBase = getPublicBaseUrl(req);
    const downloadUrl = `${publicBase}/download?id=${encodeURIComponent(id)}&path=${encodeURIComponent(relPath)}`;
    const commentsUrl = normalizeBaseUrl(config.baseUrl) + relPath;

    items.push({
      id,
      title,
      relPath,
      downloadUrl,
      commentsUrl,
      category,
      size,
      seeders,
      leechers,
      pubDate: parseDateToRfc822(dateText)
    });
  }

  log("[parser] rows=", rows.length, "items=", items.length);

  return items;
}

function getPublicBaseUrl(req) {
  if (config.publicUrl) {
    return normalizeBaseUrl(config.publicUrl);
  }

  const host = req.headers.host || `localhost:${PORT}`;
  return `http://${host}`;
}

function torznabCapsXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<caps>
  <server title="EXT Torznab Proxy" version="1.0.0" />
  <limits max="100" default="50" />
  <searching>
    <search available="yes" supportedParams="q" />
    <movie-search available="yes" supportedParams="q" />
    <tv-search available="yes" supportedParams="q,season,ep" />
  </searching>
  <categories>
    <category id="2000" name="Movies" />
    <category id="5000" name="TV" />
    <category id="5070" name="Anime" />
  </categories>
</caps>`;
}

function torznabErrorXml(code, description) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<error code="${xmlEscape(code)}" description="${xmlEscape(description)}" />`;
}

function torznabResultsXml(items) {
  const itemXml = items.map(item => {
    const peers = item.seeders + item.leechers;

    return `    <item>
      <title>${xmlEscape(item.title)}</title>
      <guid isPermaLink="false">extto-${xmlEscape(item.id)}</guid>
      <link>${xmlEscape(item.downloadUrl)}</link>
      <comments>${xmlEscape(item.commentsUrl)}</comments>
      <pubDate>${xmlEscape(item.pubDate)}</pubDate>
      <category>${xmlEscape(item.category)}</category>
      <size>${xmlEscape(item.size)}</size>
      <enclosure url="${xmlEscape(item.downloadUrl)}" length="${xmlEscape(item.size)}" type="application/x-bittorrent" />
      <torznab:attr name="category" value="${xmlEscape(item.category)}" />
      <torznab:attr name="seeders" value="${xmlEscape(item.seeders)}" />
      <torznab:attr name="peers" value="${xmlEscape(peers)}" />
      <torznab:attr name="grabs" value="0" />
    </item>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>
    <title>EXT Torznab Proxy</title>
    <description>EXT results via FlareSolverr Torznab proxy</description>
    <link>${xmlEscape(normalizeBaseUrl(config.baseUrl))}</link>
${itemXml}
  </channel>
</rss>`;
}

function apiKeyOk(params) {
  if (!config.apiKey) return true;
  return params.get("apikey") === config.apiKey;
}

async function handleApi(req, res, u) {
  const t = (u.searchParams.get("t") || "search").toLowerCase();

  if (t === "caps") {
    return send(res, 200, "application/xml; charset=utf-8", torznabCapsXml());
  }

  if (!apiKeyOk(u.searchParams)) {
    return send(res, 403, "application/xml; charset=utf-8", torznabErrorXml(100, "Invalid API key"));
  }

  if (t === "search" || t === "movie" || t === "tvsearch") {
    const q = buildSearchQuery(u.searchParams);
    const html = await fetchBrowse(q);
    const items = parseResults(html, req);

    return send(res, 200, "application/rss+xml; charset=utf-8", torznabResultsXml(items));
  }

  return send(res, 400, "application/xml; charset=utf-8", torznabErrorXml(200, "Unsupported function"));
}

function parseMagnetJson(text) {
  const body = pick(/<pre>([\s\S]*?)<\/pre>/, text) || text;
  return JSON.parse(body);
}

async function postMagnetDirect({ id, ts, hmac, csrf, referer, cookies, userAgent }) {
  const postData = new URLSearchParams({
    torrent_id: id,
    action: "get_magnet",
    timestamp: ts,
    hmac,
    sessid: csrf
  }).toString();

  const r = await fetch(normalizeBaseUrl(config.baseUrl) + "/ajax/getTorrentMagnet.php", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "x-requested-with": "XMLHttpRequest",
      "referer": referer,
      "origin": normalizeBaseUrl(config.baseUrl),
      "user-agent": userAgent,
      "accept": "application/json, text/javascript, */*; q=0.01",
      "cookie": cookiesToHeader(cookies)
    },
    body: postData
  });

  const text = await r.text();

  let json;
  try {
    json = parseMagnetJson(text);
  } catch {
    throw new Error("magnet ajax bad JSON: HTTP " + r.status + " " + text.slice(0, 300));
  }

  if (!r.ok) {
    throw new Error("magnet ajax HTTP " + r.status + ": " + text.slice(0, 300));
  }

  return json;
}

async function fetchMagnetOnce(relPath, id) {
  await ensureSession();

  const url = normalizeBaseUrl(config.baseUrl) + relPath;

  lastUsed = Date.now();

  const pageRes = await fsCall({
    cmd: "request.get",
    url,
    session: config.sessionName,
    maxTimeout: Number(config.requestTimeoutMs || 120000)
  });

  const solution = pageRes && pageRes.solution ? pageRes.solution : {};
  const page = solution.response || "";

  const pageToken = pick(/window\.pageToken\s*=\s*'([^']+)'/, page);
  const csrf = pick(/window\.csrfToken\s*=\s*'([^']+)'/, page);

  if (!pageToken || !csrf) {
    throw new Error("token parse failed");
  }

  const ts = Math.floor(Date.now() / 1000).toString();

  const hmac = crypto
    .createHash("sha256")
    .update(`${id}|${ts}|${pageToken}`)
    .digest("hex");

  const json = await postMagnetDirect({
    id,
    ts,
    hmac,
    csrf,
    referer: url,
    cookies: solution.cookies,
    userAgent: getUserAgent(solution)
  });

  if (!json.success || !json.magnet) {
    throw new Error(json.error || "magnet failed");
  }

  return json.magnet;
}

async function fetchMagnet(relPath, id) {
  try {
    return await fetchMagnetOnce(relPath, id);
  } catch (e) {
    warn("[retry] magnet failed, resetting session:", e.message || e);

    await resetSession();

    return await fetchMagnetOnce(relPath, id);
  }
}

async function handleDownload(req, res, u) {
  const id = u.searchParams.get("id") || "";
  const relPath = u.searchParams.get("path") || "";

  if (!id || !relPath || !relPath.startsWith("/") || !relPath.endsWith("/")) {
    return send(res, 400, "text/plain; charset=utf-8", "bad download parameters");
  }

  const cached = getCache(magnetCache, id);
  if (cached) {
    log("[cache] magnet hit", id);
    res.writeHead(302, {
      Location: cached,
      "cache-control": "private, max-age=86400"
    });
    return res.end();
  }

  const magnet = await withFsLock(async () => {
    const cachedAgain = getCache(magnetCache, id);
    if (cachedAgain) {
      log("[cache] magnet hit after wait", id);
      return cachedAgain;
    }

    log("[flaresolverr] magnet fetch", id);

    const m = await fetchMagnet(relPath, id);

    setLimitedCache(
      magnetCache,
      id,
      m,
      Number(config.maxMagnetCacheItems || 1000),
      Number(config.magnetTtlMinutes || 1440) * 60 * 1000
    );

    log("[cache] magnet stored", id);

    return m;
  });

  res.writeHead(302, {
    Location: magnet,
    "cache-control": "private, max-age=86400"
  });
  res.end();
}

async function doWarm() {
  const start = Date.now();
  const q = config.warmQuery || "warm";

  currentWarm = {
    running: true,
    query: q,
    startedAt: new Date().toISOString()
  };

  try {
    // Warm gerçek siteye gitmeli. Lokal search cache'den dönerse Cloudflare/session sıcak tutulmaz.
    const withAdult = config.withAdult ? "1" : "0";
    const warmCacheKey = `/browse/?q=${encodeURIComponent(q).replace(/%20/g, "+")}&with_adult=${withAdult}`;
    searchCache.delete(warmCacheKey);

    await fetchBrowse(q);

    const durationMs = Date.now() - start;
    const duration = Math.round(durationMs / 1000);

    lastWarm = {
      ok: true,
      query: q,
      durationSeconds: duration,
      durationMs,
      cacheBypassed: true,
      state: duration >= Number(config.coldThresholdSeconds || 30) ? "COLD_OR_CHALLENGE" : "WARM",
      at: new Date().toISOString()
    };

    log("[warm]", `query=${q}`, `duration=${duration}s`, `durationMs=${durationMs}`, `state=${lastWarm.state}`, "cacheBypassed=true");

    return lastWarm;
  } catch (e) {
    const durationMs = Date.now() - start;
    const duration = Math.round(durationMs / 1000);

    lastWarm = {
      ok: false,
      query: q,
      durationSeconds: duration,
      durationMs,
      cacheBypassed: true,
      state: "ERROR",
      error: e.message || String(e),
      at: new Date().toISOString()
    };

    warn("[warm] failed", e.message || e);

    return lastWarm;
  } finally {
    currentWarm = null;
  }
}

function startWarmTimer() {
  async function tick(reason) {
    if (!config.warmEnabled) return;

    log("[warm] scheduled", reason || "timer");

    try {
      await doWarm();
    } catch (e) {
      warn("[warm] background failed", e.message || e);
    }
  }

  // İlk açılışta 10 dakika bekleme; servis başladıktan kısa süre sonra warm yap.
  setTimeout(() => {
    tick("startup").catch(e => {
      warn("[warm] startup failed", e.message || e);
    });
  }, 5000);

  setInterval(() => {
    tick("interval").catch(e => {
      warn("[warm] interval failed", e.message || e);
    });
  }, Math.max(1, Number(config.warmIntervalMinutes || 10)) * 60 * 1000);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        reject(new Error("body too large"));
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function boolFromForm(v) {
  return v === "on" || v === "true" || v === "1";
}

function formatDurationView(seconds, ms) {
  if (typeof ms === "number" && ms > 0 && seconds < 1) {
    return `${ms}ms`;
  }

  return `${seconds || 0}s`;
}

function getCurrentWarmSeconds() {
  if (!currentWarm || !currentWarm.startedAt) {
    return null;
  }

  return Math.max(0, Math.floor((Date.now() - new Date(currentWarm.startedAt).getTime()) / 1000));
}

function getCurrentWarmState() {
  const runningSeconds = getCurrentWarmSeconds();

  if (runningSeconds === null) {
    return null;
  }

  return runningSeconds >= Number(config.coldThresholdSeconds || 30)
    ? "CHALLENGE"
    : "RUNNING";
}

function getWarmBadgeText() {
  if (!config.warmEnabled) {
    return "Off";
  }

  const runningSeconds = getCurrentWarmSeconds();
  const state = getCurrentWarmState();

  if (runningSeconds !== null) {
    return state === "CHALLENGE"
      ? `Challenge ${runningSeconds}s`
      : `Running ${runningSeconds}s`;
  }

  return "On";
}

function getWarmAgeView() {
  const runningSeconds = getCurrentWarmSeconds();
  const state = getCurrentWarmState();

  if (runningSeconds !== null) {
    return state === "CHALLENGE"
      ? `${runningSeconds}s CHALLENGE`
      : `${runningSeconds}s RUNNING`;
  }

  if (!lastWarm || !lastWarm.ok || !lastWarm.at) {
    return "—";
  }

  const ageSeconds = Math.max(0, Math.floor((Date.now() - new Date(lastWarm.at).getTime()) / 1000));
  return `${ageSeconds}s WARM`;
}

function getLastWarmRunView() {
  const runningSeconds = getCurrentWarmSeconds();
  const state = getCurrentWarmState();

  if (runningSeconds !== null) {
    return state === "CHALLENGE"
      ? `${runningSeconds}s CHALLENGE`
      : `${runningSeconds}s RUNNING`;
  }

  if (!lastWarm) {
    return "—";
  }

  if (!lastWarm.ok) {
    return `${formatDurationView(lastWarm.durationSeconds || 0, lastWarm.durationMs)} ERROR`;
  }

  return `${formatDurationView(lastWarm.durationSeconds || 0, lastWarm.durationMs)} ${lastWarm.state || "UNKNOWN"}`;
}

function settingsHtml(message = "") {
  const c = config;

  const publicUrlValue = c.publicUrl || "";
  const apiKey = c.apiKey || "";
  const currentWarmSeconds = getCurrentWarmSeconds();
  const currentWarmState = getCurrentWarmState();
  const lastWarmAgeSeconds = lastWarm && lastWarm.ok && lastWarm.at
    ? Math.max(0, Math.floor((Date.now() - new Date(lastWarm.at).getTime()) / 1000))
    : null;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>EXT Torznab Proxy</title>
  <style>
    :root {
      --bg: #0f172a;
      --bg-soft: #111827;
      --card: rgba(31, 41, 55, 0.92);
      --card-2: rgba(17, 24, 39, 0.88);
      --border: rgba(148, 163, 184, 0.22);
      --border-strong: rgba(148, 163, 184, 0.38);
      --text: #e5e7eb;
      --muted: #9ca3af;
      --muted-2: #6b7280;
      --primary: #3b82f6;
      --primary-2: #60a5fa;
      --success: #22c55e;
      --warning: #f59e0b;
      --danger: #ef4444;
      --input: #0b1220;
      --shadow: 0 24px 80px rgba(0,0,0,.34);
      --radius: 18px;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at top left, rgba(59,130,246,.20), transparent 34rem),
        radial-gradient(circle at top right, rgba(34,197,94,.13), transparent 32rem),
        linear-gradient(180deg, #0b1020 0%, var(--bg) 52%, #080d19 100%);
    }

    a { color: var(--primary-2); text-decoration: none; }
    a:hover { text-decoration: underline; }

    .page {
      width: min(1180px, calc(100% - 32px));
      margin: 0 auto;
      padding: 28px 0 48px;
    }

    .hero {
      display: grid;
      grid-template-columns: 1.2fr .8fr;
      gap: 18px;
      align-items: stretch;
      margin-bottom: 18px;
    }

    .title-card, .quick-card, .section {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      backdrop-filter: blur(12px);
    }

    .title-card {
      padding: 26px;
      position: relative;
      overflow: hidden;
    }

    .title-card:after {
      content: "";
      position: absolute;
      inset: auto -80px -110px auto;
      width: 260px;
      height: 260px;
      border-radius: 999px;
      background: rgba(59,130,246,.18);
      filter: blur(8px);
    }

    h1 {
      margin: 0;
      font-size: clamp(30px, 4vw, 46px);
      letter-spacing: -0.04em;
      line-height: 1;
    }

    .subtitle {
      margin: 14px 0 0;
      max-width: 720px;
      color: var(--muted);
      font-size: 15px;
      line-height: 1.55;
    }

    .badge-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 18px;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 7px 10px;
      border: 1px solid var(--border);
      background: rgba(15,23,42,.62);
      color: var(--muted);
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
    }

    .dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: var(--success);
      box-shadow: 0 0 0 4px rgba(34,197,94,.12);
    }

    .dot.off { background: var(--muted-2); box-shadow: none; }
    .dot.warn { background: var(--warning); box-shadow: 0 0 0 4px rgba(245,158,11,.13); }

    .quick-card {
      padding: 20px;
    }

    .quick-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 14px;
    }

    .quick-title h2, .section h2 {
      margin: 0;
      font-size: 18px;
      letter-spacing: -0.02em;
    }

    .copy-grid {
      display: grid;
      gap: 10px;
    }

    .copy-line {
      display: grid;
      grid-template-columns: 92px 1fr auto;
      gap: 10px;
      align-items: center;
      padding: 10px;
      border-radius: 12px;
      background: rgba(15,23,42,.62);
      border: 1px solid rgba(148,163,184,.14);
    }

    .copy-label {
      color: var(--muted);
      font-weight: 700;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: .04em;
    }

    code {
      display: inline-block;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      background: #030712;
      color: #dbeafe;
      border: 1px solid rgba(96,165,250,.18);
      padding: 7px 9px;
      border-radius: 9px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 38px;
      padding: 0 14px;
      border: 0;
      border-radius: 12px;
      background: var(--primary);
      color: white;
      font-weight: 800;
      cursor: pointer;
      text-decoration: none;
      box-shadow: 0 8px 18px rgba(59,130,246,.24);
    }

    .btn:hover { background: #2563eb; text-decoration: none; }
    .btn.secondary {
      background: rgba(148,163,184,.14);
      color: var(--text);
      box-shadow: none;
      border: 1px solid var(--border);
    }
    .btn.secondary:hover { background: rgba(148,163,184,.22); }

    .btn.ghost {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--muted);
      box-shadow: none;
    }

    .btn.small {
      min-height: 32px;
      padding: 0 10px;
      border-radius: 10px;
      font-size: 12px;
    }

    .msg {
      margin: 0 0 18px;
      padding: 13px 15px;
      border-radius: 14px;
      border: 1px solid rgba(34,197,94,.35);
      background: rgba(34,197,94,.12);
      color: #bbf7d0;
      font-weight: 700;
    }

    .status-grid {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 12px;
      margin: 18px 0;
    }

    .stat {
      padding: 14px;
      background: rgba(17,24,39,.72);
      border: 1px solid rgba(148,163,184,.16);
      border-radius: 14px;
    }

    .stat span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: .04em;
    }

    .stat strong {
      display: block;
      margin-top: 7px;
      font-size: 18px;
      letter-spacing: -0.02em;
    }

    form {
      display: grid;
      gap: 18px;
    }

    .section {
      padding: 20px;
    }

    .section-head {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 18px;
      padding-bottom: 14px;
      border-bottom: 1px solid var(--border);
    }

    .section-desc {
      margin: 6px 0 0;
      color: var(--muted);
      line-height: 1.5;
      font-size: 13px;
    }

    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }

    .field {
      display: grid;
      gap: 7px;
    }

    label {
      color: #f3f4f6;
      font-size: 13px;
      font-weight: 800;
    }

    .hint {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
    }

    input[type=text],
    input[type=number],
    input[type=password],
    select {
      width: 100%;
      min-height: 42px;
      border-radius: 12px;
      border: 1px solid var(--border-strong);
      background: var(--input);
      color: var(--text);
      padding: 10px 12px;
      outline: none;
      font: inherit;
    }

    select {
      cursor: pointer;
      appearance: none;
      background-image:
        linear-gradient(45deg, transparent 50%, var(--muted) 50%),
        linear-gradient(135deg, var(--muted) 50%, transparent 50%);
      background-position:
        calc(100% - 18px) 18px,
        calc(100% - 12px) 18px;
      background-size: 6px 6px, 6px 6px;
      background-repeat: no-repeat;
      padding-right: 36px;
    }

    input:focus,
    select:focus {
      border-color: rgba(96,165,250,.85);
      box-shadow: 0 0 0 4px rgba(59,130,246,.14);
    }

    .api-key-row {
      display: grid;
      grid-template-columns: 1fr 46px 46px;
      gap: 8px;
      align-items: center;
    }

    .api-key-row input {
      min-width: 0;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      letter-spacing: .01em;
    }

    .icon-btn {
      width: 46px;
      min-height: 42px;
      border: 1px solid var(--border-strong);
      border-radius: 12px;
      background: rgba(148,163,184,.14);
      color: var(--text);
      font-size: 20px;
      font-weight: 900;
      cursor: pointer;
      line-height: 1;
    }

    .icon-btn:hover {
      background: rgba(148,163,184,.24);
    }

    .icon-btn.danger {
      background: rgba(239,68,68,.88);
      border-color: rgba(239,68,68,.95);
      color: white;
    }

    .icon-btn.danger:hover {
      background: rgba(220,38,38,.98);
    }

    .confirm-overlay {
      position: fixed;
      inset: 0;
      z-index: 50;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      background: rgba(2, 6, 23, .72);
      backdrop-filter: blur(8px);
    }

    .confirm-overlay[hidden] {
      display: none;
    }

    .confirm-box {
      width: min(560px, 100%);
      border: 1px solid var(--border-strong);
      border-radius: 18px;
      background: #111827;
      box-shadow: var(--shadow);
      padding: 20px;
    }

    .confirm-box h3 {
      margin: 0 0 10px;
      font-size: 20px;
      letter-spacing: -0.02em;
    }

    .confirm-box p {
      margin: 0;
      color: var(--muted);
      line-height: 1.55;
      font-size: 14px;
    }

    .confirm-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      margin-top: 18px;
    }

    .check-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-top: 14px;
    }

    .check {
      display: flex;
      gap: 10px;
      align-items: flex-start;
      padding: 13px;
      border: 1px solid rgba(148,163,184,.18);
      background: rgba(15,23,42,.55);
      border-radius: 14px;
    }

    .check input { margin-top: 2px; transform: scale(1.15); }
    .check label { display: block; }
    .check small { display: block; color: var(--muted); margin-top: 4px; line-height: 1.45; }

    .actions {
      position: sticky;
      bottom: 0;
      z-index: 5;
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      justify-content: flex-end;
      padding: 14px 0 0;
      background: linear-gradient(180deg, transparent, rgba(15,23,42,.92) 24%);
      backdrop-filter: blur(8px);
    }

    .footer-note {
      margin-top: 14px;
      color: var(--muted-2);
      font-size: 12px;
      text-align: center;
    }

    .refresh-box {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      min-height: 38px;
      padding: 0 12px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: rgba(15,23,42,.62);
      color: var(--muted);
      font-size: 13px;
      font-weight: 800;
    }

    .refresh-toggle {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin: 0;
      color: var(--muted);
      font-size: 13px;
      white-space: nowrap;
    }

    .refresh-toggle input {
      transform: scale(1.08);
    }

    .refresh-input {
      width: 72px !important;
      min-height: 30px !important;
      padding: 5px 8px !important;
      border-radius: 9px !important;
      text-align: center;
    }

    .refresh-unit {
      color: var(--muted-2);
      font-size: 12px;
      font-weight: 800;
    }

    .toast {
      margin-top: 12px;
      padding: 12px 14px;
      border-radius: 14px;
      border: 1px solid rgba(96,165,250,.30);
      background: rgba(59,130,246,.12);
      color: #bfdbfe;
      font-size: 13px;
      font-weight: 800;
      line-height: 1.45;
    }

    .toast.ok {
      border-color: rgba(34,197,94,.35);
      background: rgba(34,197,94,.12);
      color: #bbf7d0;
    }

    .toast.err {
      border-color: rgba(239,68,68,.35);
      background: rgba(239,68,68,.12);
      color: #fecaca;
    }

    @media (max-width: 900px) {
      .hero, .grid, .status-grid, .check-row { grid-template-columns: 1fr; }
      .copy-line { grid-template-columns: 1fr; }
      .actions { justify-content: stretch; }
      .actions .btn { flex: 1; }
      .refresh-box { width: 100%; justify-content: space-between; }
      .api-key-row { grid-template-columns: 1fr 42px 42px; }
      .icon-btn { width: 42px; }
    }
  </style>
</head>
<body>
<div class="page">
  <div class="hero">
    <div class="title-card">
      <h1>EXT Torznab Proxy</h1>
      <p class="subtitle" data-i18n="subtitle">A self-hosted Torznab gateway for EXT results with FlareSolverr session handling, warm checks, cache and magnet resolving.</p>
      <div class="badge-row">
        <span class="badge"><span id="sessionDot" class="dot ${sessionReady ? "" : "off"}"></span><span id="sessionStatus">Session: ${sessionReady ? "Ready" : "Cold"}</span></span>
        <span class="badge"><span id="warmDot" class="dot ${currentWarm ? "warn" : (config.warmEnabled ? "" : "off")}"></span><span id="warmStatus">Warm: ${htmlEscape(getWarmBadgeText())}</span></span>
        <span class="badge"><span id="fsDot" class="dot ${fsBusy ? "warn" : ""}"></span><span id="fsStatus">FlareSolverr: ${fsBusy ? "Busy" : "Idle"}</span></span>
      </div>
    </div>

    <div class="quick-card">
      <div class="quick-title">
        <h2 data-i18n="prowlarrInfo">Prowlarr Generic Torznab</h2>
        <a class="btn small secondary" href="/api?t=caps" target="_blank" data-i18n="caps">Caps</a>
      </div>
      <div class="copy-grid">
        <div class="copy-line">
          <div class="copy-label" data-i18n="quickUrl">URL</div>
          <code id="torznabUrl">${htmlEscape(publicUrlValue)}</code>
          <button type="button" class="btn small ghost" data-copy="torznabUrl" data-i18n="copy">Copy</button>
        </div>
        <div class="copy-line">
          <div class="copy-label" data-i18n="quickApiPath">API Path</div>
          <code id="apiPath">/api</code>
          <button type="button" class="btn small ghost" data-copy="apiPath" data-i18n="copy">Copy</button>
        </div>
        <div class="copy-line">
          <div class="copy-label" data-i18n="quickApiKey">API Key</div>
          <code id="apiKey">${htmlEscape(apiKey)}</code>
          <button type="button" class="btn small ghost" data-copy="apiKey" data-i18n="copy">Copy</button>
        </div>
      </div>
    </div>
  </div>

  ${message ? `<p class="msg">${htmlEscape(message)}</p>` : ""}

  <div class="status-grid">
    <div class="stat"><span data-i18n="searchCache">Search Cache</span><strong id="searchCacheVal">${searchCache.size}</strong></div>
    <div class="stat"><span data-i18n="magnetCache">Magnet Cache</span><strong id="magnetCacheVal">${magnetCache.size}</strong></div>
    <div class="stat"><span data-i18n="idleSeconds">Idle Seconds</span><strong id="idleSecondsVal">${Math.floor((Date.now() - lastUsed) / 1000)}</strong></div>
    <div class="stat"><span data-i18n="warmAge">Warm Age</span><strong id="warmAgeVal">${htmlEscape(getWarmAgeView())}</strong></div>
    <div class="stat"><span data-i18n="lastWarmRun">Last Warm / Challenge</span><strong id="lastWarmRunVal">${htmlEscape(getLastWarmRunView())}</strong></div>
  </div>

  <form method="post" action="/settings">
    <div class="section">
      <div class="section-head">
        <div>
          <h2 data-i18n="siteAndFs">Site and FlareSolverr</h2>
          <p class="section-desc" data-i18n="siteAndFsDesc">Main site URL, FlareSolverr endpoint, session name and API identity.</p>
        </div>
      </div>

      <div class="grid">
        <div class="field">
          <label data-i18n="baseUrl">Base URL</label>
          <select name="baseUrl">
            <option value="https://extranet.torrentbay.st" ${normalizeBaseUrl(c.baseUrl) === "https://extranet.torrentbay.st" ? "selected" : ""}>https://extranet.torrentbay.st</option>
            <option value="https://ext.to" ${normalizeBaseUrl(c.baseUrl) === "https://ext.to" ? "selected" : ""}>https://ext.to</option>
          </select>
          <div class="hint" data-i18n="baseUrlHint">Target EXT site domain used internally by the proxy.</div>
        </div>

        <div class="field">
          <label data-i18n="publicUrl">Public URL</label>
          <input type="text" name="publicUrl" placeholder="http://192.168.2.1:8998" value="${htmlEscape(c.publicUrl)}">
          <div class="hint" data-i18n="publicUrlHint">Address Prowlarr can reach. Leave empty to use browser origin on this page.</div>
        </div>

        <div class="field">
          <label data-i18n="flaresolverrUrl">FlareSolverr URL</label>
          <input type="text" name="flaresolverrUrl" value="${htmlEscape(c.flaresolverrUrl)}">
          <div class="hint" data-i18n="fsHint">Usually http://flaresolverr:8191/v1 when both containers share a Docker network.</div>
        </div>

        <div class="field">
          <label data-i18n="sessionName">Session Name</label>
          <input type="text" name="sessionName" value="${htmlEscape(c.sessionName)}">
          <div class="hint" data-i18n="sessionNameHint">Persistent FlareSolverr browser session name.</div>
        </div>

        <div class="field">
          <label data-i18n="apiKeyLabel">API Key</label>
          <div class="api-key-row">
            <input id="apiKeyInput" type="text" name="apiKey" value="${htmlEscape(c.apiKey)}" autocomplete="off" spellcheck="false">
            <button class="icon-btn" type="button" onclick="copyApiKeyFromInput(this)" title="Copy API Key" data-i18n-title="copyApiKey" aria-label="Copy API Key">⧉</button>
            <button class="icon-btn danger" type="button" onclick="regenerateApiKey(this)" title="Generate new API Key" data-i18n-title="generateApiKey" aria-label="Generate new API Key">↻</button>
          </div>
          <div class="hint" data-i18n="apiKeyHint">Used by Prowlarr Generic Torznab.</div>
        </div>

        <div class="field">
          <label data-i18n="requestTimeout">Request Timeout Ms</label>
          <input type="number" name="requestTimeoutMs" value="${htmlEscape(c.requestTimeoutMs)}">
          <div class="hint" data-i18n="requestTimeoutHint">Must be higher than Cloudflare challenge duration.</div>
        </div>
      </div>

      <div class="check-row">
        <div class="check">
          <input id="withAdult" type="checkbox" name="withAdult" ${c.withAdult ? "checked" : ""}>
          <div>
            <label for="withAdult" data-i18n="withAdult">Include adult results</label>
            <small data-i18n="withAdultHint">Adds with_adult=1 to browse requests.</small>
          </div>
        </div>
        <div class="check">
          <input id="stripSeason" type="checkbox" name="stripSeasonFromSearch" ${c.stripSeasonFromSearch ? "checked" : ""}>
          <div>
            <label for="stripSeason" data-i18n="stripSeason">Normalize season/episode tokens</label>
            <small data-i18n="stripSeasonHint">Normalizes Season 2 / S2 / S02E4 style searches into S02 or S02E04.</small>
          </div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-head">
        <div>
          <h2 data-i18n="warmCache">Warm and Cache</h2>
          <p class="section-desc" data-i18n="warmCacheDesc">Keeps the Cloudflare session warm and limits repeated site requests.</p>
        </div>
      </div>

      <div class="grid">
        <div class="field">
          <label data-i18n="warmQuery">Warm Query</label>
          <input type="text" name="warmQuery" value="${htmlEscape(c.warmQuery)}">
        </div>

        <div class="field">
          <label data-i18n="warmInterval">Warm Interval Minutes</label>
          <input type="number" name="warmIntervalMinutes" value="${htmlEscape(c.warmIntervalMinutes)}">
        </div>

        <div class="field">
          <label data-i18n="coldThreshold">Cold Threshold Seconds</label>
          <input type="number" name="coldThresholdSeconds" value="${htmlEscape(c.coldThresholdSeconds)}">
        </div>

        <div class="field">
          <label data-i18n="searchTtl">Search TTL Seconds</label>
          <input type="number" name="searchTtlSeconds" value="${htmlEscape(c.searchTtlSeconds)}">
        </div>

        <div class="field">
          <label data-i18n="magnetTtl">Magnet TTL Minutes</label>
          <input type="number" name="magnetTtlMinutes" value="${htmlEscape(c.magnetTtlMinutes)}">
        </div>

        <div class="field">
          <label data-i18n="idleTimeout">Idle Timeout Minutes</label>
          <input type="number" name="idleTimeoutMinutes" value="${htmlEscape(c.idleTimeoutMinutes)}">
        </div>

        <div class="field">
          <label data-i18n="maxSearch">Max Search Cache Items</label>
          <input type="number" name="maxSearchCacheItems" value="${htmlEscape(c.maxSearchCacheItems)}">
        </div>

        <div class="field">
          <label data-i18n="maxMagnet">Max Magnet Cache Items</label>
          <input type="number" name="maxMagnetCacheItems" value="${htmlEscape(c.maxMagnetCacheItems)}">
        </div>
      </div>

      <div class="check-row">
        <div class="check">
          <input id="warmEnabled" type="checkbox" name="warmEnabled" ${c.warmEnabled ? "checked" : ""}>
          <div>
            <label for="warmEnabled" data-i18n="warmEnabled">Enable internal warm timer</label>
            <small data-i18n="warmEnabledHint">The container periodically calls /warm by itself. No external cron is required for this container.</small>
          </div>
        </div>
      </div>
    </div>

    <div class="actions">
      <div class="refresh-box">
        <label class="refresh-toggle">
          <input id="autoRefreshEnabled" type="checkbox">
          <span data-i18n="autoRefresh">Auto refresh</span>
        </label>
        <input id="autoRefreshSeconds" class="refresh-input" type="number" min="3" max="3600" value="10">
        <span class="refresh-unit" data-i18n="secondsShort">sec</span>
      </div>

      <button class="btn secondary" type="button" id="manualWarmBtn" onclick="manualWarmAction(this)" data-i18n="manualWarm">Manual Warm</button>
      <button class="btn secondary" type="button" id="clearCacheBtn" onclick="clearCacheAction(this)" data-i18n="clearCache">Clear Cache</button>
      <button class="btn secondary" type="button" id="sessionResetBtn" onclick="sessionResetAction(this)" data-i18n="sessionReset">Session Reset</button>
      <button class="btn" type="submit" data-i18n="save">Save Settings</button>
    </div>

    <div id="actionToast" class="toast" hidden></div>
  </form>

  <p class="footer-note" data-i18n="footer">EXT Torznab Proxy runs locally. Keep this page inside your trusted network.</p>
</div>

<div id="apiKeyConfirmOverlay" class="confirm-overlay" hidden>
  <div class="confirm-box" role="dialog" aria-modal="true" aria-labelledby="apiKeyConfirmTitle">
    <h3 id="apiKeyConfirmTitle" data-i18n="apiKeyRotateTitle">Generate new API key?</h3>
    <p data-i18n="apiKeyRotateConfirm">A new API key will be written immediately. You must update the API Key field in Prowlarr after this change. Continue?</p>
    <div class="confirm-actions">
      <button class="btn secondary" type="button" id="apiKeyConfirmCancel" data-i18n="cancel">Cancel</button>
      <button class="btn" type="button" id="apiKeyConfirmOk" data-i18n="ok">OK</button>
    </div>
  </div>
</div>

<script>
(function () {
  var tr = {
    subtitle: "FlareSolverr oturumu, sıcak tutma, cache ve magnet çözme desteği olan EXT için bağımsız Torznab geçidi.",
    session: "Oturum",
    warm: "Warm",
    ready: "Hazır",
    cold: "Soğuk",
    on: "Açık",
    off: "Kapalı",
    busy: "Meşgul",
    idle: "Boşta",
    runningState: "ÇALIŞIYOR",
    challengeState: "CHALLENGE",
    warmState: "WARM",
    coldChallengeState: "COLD/CHALLENGE",
    errorState: "HATA",
    prowlarrInfo: "Prowlarr Generic Torznab Bilgileri",
    caps: "Caps",
    copy: "Kopyala",
    quickUrl: "URL",
    quickApiPath: "API Yolu",
    quickApiKey: "API Anahtarı",
    searchCache: "Arama Önbelleği",
    magnetCache: "Magnet Önbelleği",
    idleSeconds: "Boşta Süresi",
    warmAge: "Warm Süresi",
    lastWarmRun: "Son Warm / Challenge",
    lastWarm: "Son Warm",
    siteAndFs: "Site ve FlareSolverr",
    siteAndFsDesc: "Ana site adresi, FlareSolverr bağlantısı, session adı ve API kimliği.",
    baseUrl: "Site Adresi",
    baseUrlHint: "Proxy'nin içeride kullandığı hedef EXT site adresi.",
    publicUrl: "Dış Erişim Adresi",
    publicUrlHint: "Prowlarr'ın erişeceği adres. Boş bırakılırsa bu sayfanın adresi gösterilir.",
    fsHint: "İki container aynı Docker ağındaysa genelde http://flaresolverr:8191/v1 olur.",
    sessionName: "Oturum Adı",
    sessionNameHint: "Kalıcı FlareSolverr tarayıcı oturumu adı.",
    flaresolverrUrl: "FlareSolverr Adresi",
    apiKeyLabel: "API Anahtarı",
    apiKeyHint: "Prowlarr Generic Torznab tarafından kullanılır.",
    copyApiKey: "API anahtarını kopyala",
    generateApiKey: "Yeni API anahtarı üret",
    apiKeyCopied: "API anahtarı kopyalandı",
    apiKeyCopyFailed: "API anahtarı kopyalanamadı",
    apiKeyGenerated: "Yeni API anahtarı oluşturuldu, ayar dosyasına yazıldı ve panoya kopyalandı. Prowlarr içindeki API Key alanını da bu yeni anahtarla güncellemeyi unutmayın.",
    apiKeyRotateTitle: "Yeni API anahtarı oluşturulsun mu?",
    apiKeyRotateConfirm: "Yeni API anahtarı hemen ayar dosyasına yazılacak. Bu işlemden sonra Prowlarr içindeki API Key alanını da yeni anahtarla güncellemeniz gerekir. Devam edilsin mi?",
    ok: "Tamam",
    cancel: "İptal",
    requestTimeout: "İstek Zaman Aşımı (ms)",
    requestTimeoutHint: "Cloudflare challenge süresinden yüksek olmalı.",
    withAdult: "Adult sonuçları dahil et",
    withAdultHint: "Browse isteklerine with_adult=1 ekler.",
    stripSeason: "Sezon/bölüm kalıplarını düzelt",
    stripSeasonHint: "Season 2 / S2 / S02E4 gibi aramaları S02 veya S02E04 biçimine çevirir.",
    warmCache: "Warm ve Önbellek",
    warmCacheDesc: "Cloudflare oturumunu sıcak tutar ve tekrar eden site isteklerini azaltır.",
    warmQuery: "Warm Arama Kelimesi",
    warmInterval: "Warm Aralığı (dakika)",
    coldThreshold: "Cold Eşiği (saniye)",
    searchTtl: "Arama Önbellek Süresi (saniye)",
    magnetTtl: "Magnet Önbellek Süresi (dakika)",
    idleTimeout: "Boşta Oturum Kapatma (dakika)",
    maxSearch: "Maksimum Arama Önbellek Adedi",
    maxMagnet: "Maksimum Magnet Önbellek Adedi",
    warmEnabled: "Dahili warm zamanlayıcısını aç",
    warmEnabledHint: "Container belirli aralıklarla kendi içinde /warm çağırır. Bu container için harici cron gerekmez.",
    manualWarm: "Manuel Warm",
    clearCache: "Önbelleği Temizle",
    autoRefresh: "Otomatik yenile",
    secondsShort: "sn",
    running: "Çalışıyor...",
    warmOk: "Warm tamamlandı",
    cacheClearOk: "Önbellek temizlendi",
    sessionReset: "Session Reset",
    sessionResetOk: "Session sıfırlandı",
    actionFailed: "İşlem başarısız",
    save: "Ayarları Kaydet",
    footer: "EXT Torznab Proxy yerel ağda çalışır. Bu sayfayı güvenilir ağ içinde tutun."
  };

  var en = {
    subtitle: "A self-hosted Torznab gateway for EXT results with FlareSolverr session handling, warm checks, cache and magnet resolving.",
    session: "Session",
    warm: "Warm",
    ready: "Ready",
    cold: "Cold",
    on: "On",
    off: "Off",
    busy: "Busy",
    idle: "Idle",
    runningState: "RUNNING",
    challengeState: "CHALLENGE",
    warmState: "WARM",
    coldChallengeState: "COLD/CHALLENGE",
    errorState: "ERROR",
    prowlarrInfo: "Prowlarr Generic Torznab",
    caps: "Caps",
    copy: "Copy",
    quickUrl: "URL",
    quickApiPath: "API Path",
    quickApiKey: "API Key",
    searchCache: "Search Cache",
    magnetCache: "Magnet Cache",
    idleSeconds: "Idle Seconds",
    warmAge: "Warm Age",
    lastWarmRun: "Last Warm / Challenge",
    lastWarm: "Last Warm",
    siteAndFs: "Site and FlareSolverr",
    siteAndFsDesc: "Main site URL, FlareSolverr endpoint, session name and API identity.",
    baseUrl: "Base URL",
    baseUrlHint: "Target EXT site domain used internally by the proxy.",
    publicUrl: "Public URL",
    publicUrlHint: "Address Prowlarr can reach. Leave empty to use browser origin on this page.",
    fsHint: "Usually http://flaresolverr:8191/v1 when both containers share a Docker network.",
    sessionName: "Session Name",
    sessionNameHint: "Persistent FlareSolverr browser session name.",
    flaresolverrUrl: "FlareSolverr URL",
    apiKeyLabel: "API Key",
    apiKeyHint: "Used by Prowlarr Generic Torznab.",
    copyApiKey: "Copy API key",
    generateApiKey: "Generate new API key",
    apiKeyCopied: "API key copied",
    apiKeyCopyFailed: "API key copy failed",
    apiKeyGenerated: "New API key was generated, saved to the config file, and copied to the clipboard. Do not forget to update the API Key field in Prowlarr too.",
    apiKeyRotateTitle: "Generate a new API key?",
    apiKeyRotateConfirm: "A new API key will be written to the config file immediately. After this change, you must update the API Key field in Prowlarr with the new key. Continue?",
    ok: "OK",
    cancel: "Cancel",
    requestTimeout: "Request Timeout (ms)",
    requestTimeoutHint: "Must be higher than Cloudflare challenge duration.",
    withAdult: "Include adult results",
    withAdultHint: "Adds with_adult=1 to browse requests.",
    stripSeason: "Normalize season/episode tokens",
    stripSeasonHint: "Normalizes Season 2 / S2 / S02E4 style searches into S02 or S02E04.",
    warmCache: "Warm and Cache",
    warmCacheDesc: "Keeps the Cloudflare session warm and limits repeated site requests.",
    warmQuery: "Warm Query",
    warmInterval: "Warm Interval (minutes)",
    coldThreshold: "Cold Threshold (seconds)",
    searchTtl: "Search TTL (seconds)",
    magnetTtl: "Magnet TTL (minutes)",
    idleTimeout: "Idle Timeout (minutes)",
    maxSearch: "Max Search Cache Items",
    maxMagnet: "Max Magnet Cache Items",
    warmEnabled: "Enable internal warm timer",
    warmEnabledHint: "The container periodically calls /warm by itself. No external cron is required for this container.",
    manualWarm: "Manual Warm",
    clearCache: "Clear Cache",
    autoRefresh: "Auto refresh",
    secondsShort: "sec",
    running: "Running...",
    warmOk: "Warm completed",
    cacheClearOk: "Cache cleared",
    sessionReset: "Session Reset",
    sessionResetOk: "Session reset completed",
    actionFailed: "Action failed",
    save: "Save Settings",
    footer: "EXT Torznab Proxy runs locally. Keep this page inside your trusted network."
  };

  if (window.location.search.indexOf("saved=1") >= 0) {
    window.history.replaceState(null, "", "/");
  }

  var lang = (navigator.language || navigator.userLanguage || "en").toLowerCase();
  var dict = lang.indexOf("tr") === 0 ? tr : en;

  document.documentElement.lang = lang.indexOf("tr") === 0 ? "tr" : "en";

  var initialStatus = {
    sessionReady: ${sessionReady ? "true" : "false"},
    fsBusy: ${fsBusy ? "true" : "false"},
    warmEnabled: ${config.warmEnabled ? "true" : "false"},
    currentWarmSeconds: ${currentWarmSeconds === null ? "null" : String(currentWarmSeconds)},
    currentWarmState: ${JSON.stringify(currentWarmState)},
    warmAgeSeconds: ${lastWarmAgeSeconds === null ? "null" : String(lastWarmAgeSeconds)},
    lastWarmDurationSeconds: ${lastWarm ? Number(lastWarm.durationSeconds || 0) : "null"},
    lastWarmDurationMs: ${lastWarm ? Number(lastWarm.durationMs || 0) : "null"},
    lastWarmState: ${JSON.stringify(lastWarm ? lastWarm.state : null)}
  };

  document.querySelectorAll("[data-i18n]").forEach(function (el) {
    var key = el.getAttribute("data-i18n");
    el.textContent = dict[key] || en[key] || el.textContent;
  });

  document.querySelectorAll("[data-i18n-title]").forEach(function (el) {
    var key = el.getAttribute("data-i18n-title");
    el.title = dict[key] || en[key] || el.title;
    el.setAttribute("aria-label", el.title);
  });

  function stateText(state) {
    if (state === "WARM") return dict.warmState || "WARM";
    if (state === "COLD_OR_CHALLENGE") return dict.coldChallengeState || "COLD/CHALLENGE";
    if (state === "ERROR") return dict.errorState || "ERROR";
    if (state === "RUNNING") return dict.runningState || "RUNNING";
    if (state === "CHALLENGE") return dict.challengeState || "CHALLENGE";
    return state || "—";
  }

  function durationText(seconds, ms) {
    seconds = Number(seconds || 0);
    ms = Number(ms || 0);
    if (seconds < 1 && ms > 0) return ms + "ms";
    return seconds + "s";
  }

  function setText(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function applyInitialStatus() {
    setText("sessionStatus", (dict.session || "Session") + ": " + (initialStatus.sessionReady ? (dict.ready || "Ready") : (dict.cold || "Cold")));

    if (initialStatus.currentWarmSeconds !== null) {
      var warmRunState = initialStatus.currentWarmState === "CHALLENGE" ? (dict.challengeState || "CHALLENGE") : (dict.runningState || "RUNNING");
      setText("warmStatus", (dict.warm || "Warm") + ": " + warmRunState + " " + initialStatus.currentWarmSeconds + "s");
    } else {
      setText("warmStatus", (dict.warm || "Warm") + ": " + (initialStatus.warmEnabled ? (dict.on || "On") : (dict.off || "Off")));
    }

    setText("fsStatus", "FlareSolverr: " + (initialStatus.fsBusy ? (dict.busy || "Busy") : (dict.idle || "Idle")));

    if (initialStatus.currentWarmSeconds !== null) {
      var currentStateText = initialStatus.currentWarmState === "CHALLENGE" ? (dict.challengeState || "CHALLENGE") : (dict.runningState || "RUNNING");
      setText("warmAgeVal", initialStatus.currentWarmSeconds + "s " + currentStateText);
      setText("lastWarmRunVal", initialStatus.currentWarmSeconds + "s " + currentStateText);
    } else {
      setText("warmAgeVal", initialStatus.warmAgeSeconds === null ? "—" : initialStatus.warmAgeSeconds + "s " + (dict.warmState || "WARM"));
      setText("lastWarmRunVal", initialStatus.lastWarmState ? durationText(initialStatus.lastWarmDurationSeconds, initialStatus.lastWarmDurationMs) + " " + stateText(initialStatus.lastWarmState) : "—");
    }
  }

  applyInitialStatus();

  var torznabUrl = document.getElementById("torznabUrl");
  if (torznabUrl && !torznabUrl.textContent.trim()) {
    torznabUrl.textContent = window.location.origin;
  }

  function fallbackCopyText(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "-9999px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();

    var ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (_) {
      ok = false;
    }

    document.body.removeChild(ta);
    return ok;
  }

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (_) {}
    }

    return fallbackCopyText(text);
  }

  document.querySelectorAll("[data-copy]").forEach(function (btn) {
    btn.addEventListener("click", async function () {
      var id = btn.getAttribute("data-copy");
      var el = document.getElementById(id);
      if (!el) return;

      var text = el.textContent.trim();
      var oldText = btn.textContent;

      var ok = await copyText(text);

      if (ok) {
        btn.textContent = lang.indexOf("tr") === 0 ? "Kopyalandı" : "Copied";
      } else {
        btn.textContent = lang.indexOf("tr") === 0 ? "Kopyalanamadı" : "Failed";
      }

      setTimeout(function () {
        btn.textContent = oldText;
      }, 1200);
    });
  });

  var toast = document.getElementById("actionToast");

  function showToast(text, kind) {
    if (!toast) return;
    toast.hidden = false;
    toast.className = "toast " + (kind || "");
    toast.textContent = text;
  }

  function setBusy(btn, busy) {
    if (!btn) return;
    if (busy) {
      btn.dataset.oldText = btn.textContent;
      btn.textContent = dict.running || "Running...";
      btn.disabled = true;
      btn.style.opacity = ".72";
      btn.style.cursor = "wait";
    } else {
      btn.textContent = btn.dataset.oldText || btn.textContent;
      btn.disabled = false;
      btn.style.opacity = "";
      btn.style.cursor = "";
    }
  }

  async function callJson(url, options) {
    options = options || {};
    options.cache = "no-store";
    var r = await fetch(url, options);
    var text = await r.text();
    var json = null;
    try { json = JSON.parse(text); } catch (_) {}
    if (!r.ok) {
      throw new Error((json && (json.error || json.message)) || text || ("HTTP " + r.status));
    }
    return json || { ok: true, text: text };
  }

  function showApiKeyConfirm() {
    var overlay = document.getElementById("apiKeyConfirmOverlay");
    var okBtn = document.getElementById("apiKeyConfirmOk");
    var cancelBtn = document.getElementById("apiKeyConfirmCancel");

    if (!overlay || !okBtn || !cancelBtn) {
      return Promise.resolve(window.confirm(dict.apiKeyRotateConfirm || "Generate new API key?"));
    }

    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }

    overlay.hidden = false;
    okBtn.focus();

    return new Promise(function (resolve) {
      function close(value) {
        overlay.hidden = true;
        okBtn.removeEventListener("click", onOk);
        cancelBtn.removeEventListener("click", onCancel);
        overlay.removeEventListener("click", onOverlay);
        document.removeEventListener("keydown", onKey);
        armRefresh();
        resolve(value);
      }

      function onOk() { close(true); }
      function onCancel() { close(false); }
      function onOverlay(e) { if (e.target === overlay) close(false); }
      function onKey(e) { if (e.key === "Escape") close(false); }

      okBtn.addEventListener("click", onOk);
      cancelBtn.addEventListener("click", onCancel);
      overlay.addEventListener("click", onOverlay);
      document.addEventListener("keydown", onKey);
    });
  }

  window.copyApiKeyFromInput = async function () {
    var input = document.getElementById("apiKeyInput");
    if (!input) return;

    var ok = await copyText(input.value.trim());

    if (ok) {
      showToast(dict.apiKeyCopied || "API key copied", "ok");
    } else {
      showToast(dict.apiKeyCopyFailed || "API key copy failed", "err");
    }
  };

  window.regenerateApiKey = async function (btn) {
    var input = document.getElementById("apiKeyInput");
    if (!input) return;

    var confirmed = await showApiKeyConfirm();
    if (!confirmed) return;

    try {
      setBusy(btn, true);
      showToast(dict.running || "Running...", "");

      var j = await callJson("/api-key/regenerate", { method: "POST" });
      if (!j || !j.apiKey) throw new Error("No API key returned");

      input.value = j.apiKey;
      var quickApiKey = document.getElementById("apiKey");
      if (quickApiKey) quickApiKey.textContent = j.apiKey;

      var ok = await copyText(j.apiKey);

      if (ok) {
        showToast(dict.apiKeyGenerated || "New API key generated and copied.", "ok");
      } else {
        showToast((dict.apiKeyGenerated || "New API key generated.") + " " + (dict.apiKeyCopyFailed || "Copy failed."), "err");
      }
    } catch (e) {
      showToast((dict.actionFailed || "Action failed") + ": " + e.message, "err");
    } finally {
      setBusy(btn, false);
    }
  };

  window.manualWarmAction = async function (btn) {
    try {
      setBusy(btn, true);
      showToast((dict.running || "Running...") + " /warm", "");

      var j = await callJson("/warm");

      showToast((dict.warmOk || "Warm completed") + ": " + (j.durationSeconds || 0) + "s " + (j.state || ""), "ok");

      setTimeout(function () {
        window.location.reload();
      }, 900);
    } catch (e) {
      showToast((dict.actionFailed || "Action failed") + ": " + e.message, "err");
    } finally {
      setBusy(btn, false);
    }
  };

  window.clearCacheAction = async function (btn) {
    try {
      setBusy(btn, true);
      showToast((dict.running || "Running...") + " /cache/clear", "");

      var j = await callJson("/cache/clear");

      showToast((dict.cacheClearOk || "Cache cleared") + ": search=" + (j.clearedSearches || 0) + ", magnet=" + (j.clearedMagnets || 0), "ok");

      setTimeout(function () {
        window.location.reload();
      }, 900);
    } catch (e) {
      showToast((dict.actionFailed || "Action failed") + ": " + e.message, "err");
    } finally {
      setBusy(btn, false);
    }
  };

  // Manual Warm and Clear Cache actions are attached inline with onclick
  // to keep them reliable even after page refresh / browser cache quirks.

  window.sessionResetAction = async function (btn) {
    try {
      setBusy(btn, true);
      showToast((dict.running || "Running...") + " /session/reset", "");

      var j = await callJson("/session/reset");

      showToast((dict.sessionResetOk || "Session reset completed"), "ok");

      setTimeout(function () {
        window.location.reload();
      }, 900);
    } catch (e) {
      showToast((dict.actionFailed || "Action failed") + ": " + e.message, "err");
    } finally {
      setBusy(btn, false);
    }
  };

  var refreshEnabled = document.getElementById("autoRefreshEnabled");
  var refreshSeconds = document.getElementById("autoRefreshSeconds");
  var refreshTimer = null;

  function getRefreshSeconds() {
    var n = parseInt(refreshSeconds && refreshSeconds.value ? refreshSeconds.value : "10", 10);
    if (!isFinite(n) || n < 3) n = 3;
    if (n > 3600) n = 3600;
    return n;
  }

  function saveRefreshPrefs() {
    try {
      localStorage.setItem("extto:autoRefresh", refreshEnabled && refreshEnabled.checked ? "1" : "0");
      localStorage.setItem("extto:autoRefreshSeconds", String(getRefreshSeconds()));
    } catch (_) {}
  }

  function armRefresh() {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }

    saveRefreshPrefs();

    if (!refreshEnabled || !refreshEnabled.checked) return;

    refreshTimer = setTimeout(function () {
      window.location.reload();
    }, getRefreshSeconds() * 1000);
  }

  try {
    var savedEnabled = localStorage.getItem("extto:autoRefresh");
    var savedSeconds = localStorage.getItem("extto:autoRefreshSeconds");

    if (refreshSeconds && savedSeconds) {
      refreshSeconds.value = savedSeconds;
    }

    if (refreshEnabled) {
      refreshEnabled.checked = savedEnabled === "1";
    }
  } catch (_) {}

  if (refreshEnabled) {
    refreshEnabled.addEventListener("change", armRefresh);
  }

  if (refreshSeconds) {
    refreshSeconds.addEventListener("change", armRefresh);
    refreshSeconds.addEventListener("input", function () {
      saveRefreshPrefs();
    });
  }

  armRefresh();
})();
</script>
</body>
</html>`;
}

function parseForm(body) {
  const p = new URLSearchParams(body);
  return {
    baseUrl: normalizeBaseUrl(p.get("baseUrl")),
    publicUrl: normalizeBaseUrl(p.get("publicUrl")),
    flaresolverrUrl: p.get("flaresolverrUrl"),
    sessionName: p.get("sessionName"),
    apiKey: p.get("apiKey"),
    withAdult: boolFromForm(p.get("withAdult")),
    stripSeasonFromSearch: boolFromForm(p.get("stripSeasonFromSearch")),
    warmEnabled: boolFromForm(p.get("warmEnabled")),
    warmQuery: p.get("warmQuery"),
    warmIntervalMinutes: Number(p.get("warmIntervalMinutes") || 10),
    coldThresholdSeconds: Number(p.get("coldThresholdSeconds") || 30),
    searchTtlSeconds: Number(p.get("searchTtlSeconds") || 180),
    magnetTtlMinutes: Number(p.get("magnetTtlMinutes") || 1440),
    maxSearchCacheItems: Number(p.get("maxSearchCacheItems") || 100),
    maxMagnetCacheItems: Number(p.get("maxMagnetCacheItems") || 1000),
    requestTimeoutMs: Number(p.get("requestTimeoutMs") || 120000),
    idleTimeoutMinutes: Number(p.get("idleTimeoutMinutes") || 360)
  };
}

function send(res, status, type, body) {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store"
  });
  res.end(body);
}

setInterval(() => {
  const r = clearExpiredCache();

  if (r.removedSearches > 0 || r.removedMagnets > 0) {
    log("[cache] expired removed searches=", r.removedSearches, "magnets=", r.removedMagnets);
  }
}, 5 * 60 * 1000);

setInterval(async () => {
  const idle = Date.now() - lastUsed;
  const idleTimeoutMs = Number(config.idleTimeoutMinutes || 360) * 60 * 1000;

  if (sessionReady && idle > idleTimeoutMs) {
    log("[idle] destroying session after", config.idleTimeoutMinutes, "minutes");
    await destroySessionUnlocked();
  }
}, 60 * 1000);

http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://x");

    if (req.method === "GET" && u.pathname === "/") {
      const savedMessage = u.searchParams.get("saved") === "1"
        ? "Settings saved."
        : "";

      return send(res, 200, "text/html; charset=utf-8", settingsHtml(savedMessage));
    }

    if (req.method === "POST" && u.pathname === "/settings") {
      const body = await readBody(req);
      const next = parseForm(body);

      saveConfig(next);

      res.writeHead(303, {
        Location: "/?saved=1"
      });
      return res.end();
    }

    if (req.method === "GET" && u.pathname === "/health") {
      return send(res, 200, "application/json; charset=utf-8", JSON.stringify({
        ok: true,
        app: "extto-torznab-proxy",
        version: "1.0.0",
        baseUrl: config.baseUrl,
        flaresolverrUrl: config.flaresolverrUrl,
        sessionName: config.sessionName,
        sessionReady,
        sessionBusy,
        fsBusy,
        idleSeconds: Math.floor((Date.now() - lastUsed) / 1000),
        searchCacheItems: searchCache.size,
        magnetCacheItems: magnetCache.size,
        warmEnabled: config.warmEnabled,
        warmIntervalMinutes: config.warmIntervalMinutes,
        coldThresholdSeconds: config.coldThresholdSeconds,
        warmRunning: !!currentWarm,
        currentWarm: currentWarm ? {
          query: currentWarm.query,
          startedAt: currentWarm.startedAt,
          runningSeconds: Math.max(0, Math.floor((Date.now() - new Date(currentWarm.startedAt).getTime()) / 1000))
        } : null,
        warmAgeSeconds: lastWarm && lastWarm.ok ? Math.max(0, Math.floor((Date.now() - new Date(lastWarm.at).getTime()) / 1000)) : null,
        lastWarmRun: lastWarm ? {
          durationSeconds: lastWarm.durationSeconds,
          durationMs: lastWarm.durationMs,
          state: lastWarm.state,
          at: lastWarm.at
        } : null,
        lastWarm
      }, null, 2));
    }

    if (req.method === "GET" && u.pathname === "/warm") {
      const result = await doWarm();
      return send(res, result.ok ? 200 : 500, "application/json; charset=utf-8", JSON.stringify(result, null, 2));
    }

    if (req.method === "POST" && u.pathname === "/api-key/regenerate") {
      const nextApiKey = randomApiKey();
      saveConfig({ ...config, apiKey: nextApiKey });
      return send(res, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true, apiKey: nextApiKey }, null, 2));
    }

    if (req.method === "GET" && u.pathname === "/cache/clear") {
      const s = searchCache.size;
      const m = magnetCache.size;
      searchCache.clear();
      magnetCache.clear();
      return send(res, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true, clearedSearches: s, clearedMagnets: m }, null, 2));
    }

    if (req.method === "GET" && u.pathname === "/session/reset") {
      await destroySessionUnlocked();
      sessionReady = false;
      return send(res, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true, sessionReset: true }, null, 2));
    }

    if (req.method === "GET" && u.pathname === "/api") {
      return await handleApi(req, res, u);
    }

    if (req.method === "GET" && u.pathname === "/download") {
      return await handleDownload(req, res, u);
    }

    return send(res, 404, "text/plain; charset=utf-8", "not found");
  } catch (e) {
    error("[error]", e && e.stack ? e.stack : e);
    return send(res, 500, "text/plain; charset=utf-8", String(e.message || e));
  }
}).listen(PORT, "0.0.0.0", () => {
  log("extto-torznab-proxy listening on :" + PORT);
  log("config:", CONFIG_FILE);
  log("base:", config.baseUrl);
  log("flaresolverr:", config.flaresolverrUrl);
  log("session:", config.sessionName);
  startWarmTimer();
});
