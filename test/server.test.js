const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const srv = require("../server.js");

test("APP_VERSION is 1.0.7", () => {
  assert.equal(srv.APP_VERSION, "1.0.7");
});

test("parseDateToRfc822: parses relative ages accurately instead of current time or year 2001", () => {
  const fixedNow = Date.UTC(2026, 10, 18, 12, 0, 0); // 2026-11-18T12:00:00Z

  const twoHours = srv.parseDateToRfc822("2 hours", fixedNow);
  assert.equal(twoHours, new Date(fixedNow - 2 * 3600 * 1000).toUTCString());

  const threeMonths = srv.parseDateToRfc822("3 months ago", fixedNow);
  const expectedThreeMonths = new Date(fixedNow);
  expectedThreeMonths.setUTCMonth(expectedThreeMonths.getUTCMonth() - 3);
  assert.equal(threeMonths, expectedThreeMonths.toUTCString());

  const fiveDays = srv.parseDateToRfc822("5 days", fixedNow);
  assert.equal(fiveDays, new Date(fixedNow - 5 * 86400 * 1000).toUTCString());

  const oneYear = srv.parseDateToRfc822("1 year", fixedNow);
  const expectedOneYear = new Date(fixedNow);
  expectedOneYear.setUTCFullYear(expectedOneYear.getUTCFullYear() - 1);
  assert.equal(oneYear, expectedOneYear.toUTCString());
});

test("decodeEntities: does not double-unescape &amp;lt; and decodes numeric entities", () => {
  assert.equal(srv.decodeEntities("&amp;lt;script&amp;gt;"), "&lt;script&gt;");
  assert.equal(srv.decodeEntities("Movie &#39;Title&#39; &#8211; 2026"), "Movie 'Title' \u2013 2026");
  assert.equal(srv.decodeEntities("Hex &#x27;Test&#x27;"), "Hex 'Test'");
});

test("xmlEscape: strips XML 1.0 invalid control characters", () => {
  const escaped = srv.xmlEscape("Bad\x00Title\x07 & <Test>");
  assert.equal(escaped, "BadTitle &amp; &lt;Test&gt;");
});

test("torznabCapsXml: exposes only Movies (2000), TV (5000), and Anime (5070) and respects enableImdbSearch toggle", () => {
  const prev = srv.getConfig().enableImdbSearch;
  try {
    srv.setConfigForTest({ enableImdbSearch: true });
    const xml = srv.torznabCapsXml();
    assert.match(xml, /<category\s+id="2000"\s+name="Movies"\s*\/>/);
    assert.match(xml, /<category\s+id="5000"\s+name="TV"\s*\/>/);
    assert.match(xml, /<category\s+id="5070"\s+name="Anime"\s*\/>/);
    assert.doesNotMatch(xml, /id="7000"/);
    assert.match(xml, /<movie-search\s+available="yes"\s+supportedParams="q,imdbid"\s*\/>/);
    assert.match(xml, /<tv-search\s+available="yes"\s+supportedParams="q,season,ep,imdbid"\s*\/>/);

    srv.setConfigForTest({ enableImdbSearch: false });
    const xmlDisabled = srv.torznabCapsXml();
    assert.match(xmlDisabled, /<movie-search\s+available="yes"\s+supportedParams="q"\s*\/>/);
    assert.match(xmlDisabled, /<tv-search\s+available="yes"\s+supportedParams="q,season,ep"\s*\/>/);
  } finally {
    srv.setConfigForTest({ enableImdbSearch: prev });
  }
});

test("normalizeImdbId: normalizes tt-prefixed, unprefixed, and short IMDb IDs to tt + 7+ digits", () => {
  assert.equal(srv.normalizeImdbId("tt1533395"), "tt1533395");
  assert.equal(srv.normalizeImdbId("1533395"), "tt1533395");
  assert.equal(srv.normalizeImdbId("111161"), "tt0111161");
  assert.equal(srv.normalizeImdbId("  TT0111161 "), "tt0111161");
  assert.equal(srv.normalizeImdbId("tt12345678"), "tt12345678");
  assert.equal(srv.normalizeImdbId(""), "");
  assert.equal(srv.normalizeImdbId("0"), "");
  assert.equal(srv.normalizeImdbId("tt0000000"), "");
  assert.equal(srv.normalizeImdbId("invalid"), "");
});

test("buildSearchQuery and buildBrowsePath: handles imdbid with and without q or season/ep without falling back to warm", () => {
  // Movie search by IMDb ID only (no q)
  const movieParams = new URLSearchParams("t=movie&imdbid=1533395");
  const qMovie = srv.buildSearchQuery(movieParams);
  assert.equal(qMovie, "");
  assert.equal(srv.buildBrowsePath(qMovie, "tt1533395"), "/browse/?imdb_id=tt1533395&with_adult=1");

  // TV search by IMDb ID + season + ep (no q)
  const tvParams = new URLSearchParams("t=tvsearch&imdbid=tt1533395&season=1&ep=2");
  const qTv = srv.buildSearchQuery(tvParams);
  assert.equal(qTv, "S01E02");
  assert.equal(srv.buildBrowsePath(qTv, "tt1533395"), "/browse/?q=S01E02&imdb_id=tt1533395&with_adult=1");

  // Standard empty search without imdbid still falls back to warm
  const warmParams = new URLSearchParams("t=search");
  const qWarm = srv.buildSearchQuery(warmParams);
  assert.equal(qWarm, "warm");
  assert.equal(srv.buildBrowsePath(qWarm, ""), "/browse/?q=warm&with_adult=1");
});

test("torznabResultsXml: includes both numeric imdb and tt-prefixed imdbid attributes when imdbId is provided", () => {
  const items = [
    {
      id: "999",
      title: "Life 2009 S01E01 1080p",
      downloadUrl: "http://localhost:8998/download?id=999&path=%2Flife-999%2F",
      commentsUrl: "https://extranet.torrentbay.st/life-999/",
      pubDate: "Wed, 18 Nov 2026 12:00:00 GMT",
      category: 5000,
      size: 1024,
      seeders: 10,
      leechers: 2
    }
  ];

  const xmlWithImdb = srv.torznabResultsXml(items, "tt1533395");
  assert.match(xmlWithImdb, /<torznab:attr\s+name="imdb"\s+value="1533395"\s*\/>/);
  assert.match(xmlWithImdb, /<torznab:attr\s+name="imdbid"\s+value="tt1533395"\s*\/>/);

  const xmlWithoutImdb = srv.torznabResultsXml(items, "");
  assert.doesNotMatch(xmlWithoutImdb, /name="imdb"/);
  assert.doesNotMatch(xmlWithoutImdb, /name="imdbid"/);
});

test("/api: returns Torznab error 201 on invalid imdbid parameter", async () => {
  const prevKey = srv.getConfig().apiKey;
  srv.setConfigForTest({ apiKey: "" });
  const server = srv.server;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api?t=movie&imdbid=not_an_imdb_id`);
    assert.equal(res.status, 400);
    const body = await res.text();
    assert.match(body, /<error\s+code="201"\s+description="Incorrect parameter \(imdbid\)"\s*\/>/);
  } finally {
    await new Promise((r) => server.close(r));
    srv.setConfigForTest({ apiKey: prevKey });
  }
});

test("buildSearchQuery: respects stripSeasonFromSearch=false", () => {
  const prev = srv.getConfig().stripSeasonFromSearch;
  try {
    srv.setConfigForTest({ stripSeasonFromSearch: false });
    const params = new URLSearchParams("t=tvsearch&q=Show+Season+2+Ep+4");
    const q = srv.buildSearchQuery(params);
    assert.equal(q, "Show Season 2 Ep 4");

    srv.setConfigForTest({ stripSeasonFromSearch: true });
    const qNorm = srv.buildSearchQuery(params);
    assert.equal(qNorm, "Show S02E04");
  } finally {
    srv.setConfigForTest({ stripSeasonFromSearch: prev });
  }
});

test("fsCall: surfaces underlying ECONNREFUSED cause and URL when FlareSolverr is unreachable", async () => {
  const prevUrl = srv.getConfig().flaresolverrUrl;
  // Find an unused ephemeral port
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const deadPort = probe.address().port;
  await new Promise((r) => probe.close(r));

  const deadUrl = `http://127.0.0.1:${deadPort}/v1`;
  srv.setConfigForTest({ flaresolverrUrl: deadUrl });

  try {
    await assert.rejects(
      () => srv.fsCall({ cmd: "sessions.create", session: "test" }),
      (err) => {
        assert.match(err.message, /FlareSolverr unreachable/i);
        assert.match(err.message, /ECONNREFUSED/);
        assert.ok(err.message.includes(deadUrl));
        return true;
      }
    );
  } finally {
    srv.setConfigForTest({ flaresolverrUrl: prevUrl });
  }
});

test("handleDownload: rejects invalid id or protocol-relative/traversal path with 400", async () => {
  const server = srv.server;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  try {
    const r1 = await fetch(`http://127.0.0.1:${port}/download?id=abc&path=/movie-123/`);
    assert.equal(r1.status, 400);

    const r2 = await fetch(`http://127.0.0.1:${port}/download?id=123&path=//evil.com/`);
    assert.equal(r2.status, 400);

    const r3 = await fetch(`http://127.0.0.1:${port}/download?id=123&path=/../etc/`);
    assert.equal(r3.status, 400);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("parseResults: parses comma-formatted seeders/leechers correctly", () => {
  const html = `<table class="search-table"><tr>
    <td><a class="torrent-title-link" href="/movies/test-movie-12345/">Test.Movie.2026</a></td>
    <td>1.5 GB</td>
    <td>-</td>
    <td>2 hours</td>
    <td>1,234</td>
    <td>567</td>
  </tr></table>`;

  const items = srv.parseResults(html, { headers: { host: "localhost:8998" } });
  assert.equal(items.length, 1);
  assert.equal(items[0].seeders, 1234);
  assert.equal(items[0].leechers, 567);
});

test("setLimitedCache: does not evict other keys when updating an existing key", () => {
  const map = new Map();
  srv.setLimitedCache(map, "a", "1", 2, 60000);
  srv.setLimitedCache(map, "b", "2", 2, 60000);
  srv.setLimitedCache(map, "a", "1-updated", 2, 60000);

  assert.equal(map.size, 2);
  assert.equal(map.has("a"), true);
  assert.equal(map.has("b"), true);
});

test("torznabCapsXml: sets limits default=100 max=100 and paginateItems slices by offset and limit", () => {
  const xml = srv.torznabCapsXml();
  assert.match(xml, /<limits\s+max="100"\s+default="100"\s*\/>/);

  const items = Array.from({ length: 25 }, (_, i) => ({ id: String(i + 1) }));
  const page1 = srv.paginateItems(items, new URLSearchParams("offset=0&limit=10"));
  assert.equal(page1.length, 10);
  assert.equal(page1[0].id, "1");
  assert.equal(page1[9].id, "10");

  const page2 = srv.paginateItems(items, new URLSearchParams("offset=20&limit=10"));
  assert.equal(page2.length, 5);
  assert.equal(page2[0].id, "21");

  const page3 = srv.paginateItems(items, new URLSearchParams("offset=50&limit=50"));
  assert.equal(page3.length, 0);
});

test("buildSearchQuery: upgrades season-only token in q to SxxExx when season and ep params are provided", () => {
  const params = new URLSearchParams("t=tvsearch&q=Show+Season+2&season=2&ep=4");
  assert.equal(srv.buildSearchQuery(params), "Show S02E04");

  const prev = srv.getConfig().stripSeasonFromSearch;
  try {
    srv.setConfigForTest({ stripSeasonFromSearch: false });
    assert.equal(srv.buildSearchQuery(params), "Show Season 2 S02E04");
  } finally {
    srv.setConfigForTest({ stripSeasonFromSearch: prev });
  }
});

test("buildSearchQuery: formats Sonarr daily episode season=YYYY and ep=MM/DD into YYYY.MM.DD", () => {
  const dailyParams = new URLSearchParams("t=tvsearch&q=The+Daily+Show&season=2026&ep=11/18");
  assert.equal(srv.buildSearchQuery(dailyParams), "The Daily Show 2026.11.18");

  const dailyImdbParams = new URLSearchParams("t=tvsearch&imdbid=tt0115147&season=2026&ep=03/05");
  assert.equal(srv.buildSearchQuery(dailyImdbParams), "2026.03.05");
});

test("parseResults and filterItemsByCategory: preserves unclassified (7000) rows for Prowlarr pass-through while filtering explicit 2000/5000/5070 mismatches", () => {
  const html = `<table class="search-table">
    <tr>
      <td><a class="torrent-title-link" href="/movies/life-2009-101/">Life.2009.1080p.BluRay</a><a href="/movies/">Movies</a></td>
      <td>4.2 GB</td><td>-</td><td>1 day</td><td>50</td><td>5</td>
    </tr>
    <tr>
      <td><a class="torrent-title-link" href="/tv/life-s01e01-102/">Life.2009.S01E01.1080p.WEB-DL</a><a href="/tv/">TV</a></td>
      <td>1.8 GB</td><td>-</td><td>2 days</td><td>30</td><td>3</td>
    </tr>
    <tr>
      <td><a class="torrent-title-link" href="/anime/life-anime-103/">Life.Anime.01.1080p</a><a href="/anime/">Anime</a></td>
      <td>900 MB</td><td>-</td><td>3 days</td><td>20</td><td>2</td>
    </tr>
    <tr>
      <td><a class="torrent-title-link" href="/life-s01-complete-104/">Life.S01.COMPLETE.1080p.BluRay</a></td>
      <td>15 GB</td><td>-</td><td>4 days</td><td>10</td><td>1</td>
    </tr>
  </table>`;

  const allItems = srv.parseResults(html, { headers: { host: "localhost:8998" } });
  assert.equal(allItems.length, 4);
  assert.deepEqual(allItems.map((x) => x.category), [2000, 5000, 5070, 7000]);

  const moviesOnly = srv.filterItemsByCategory(allItems, "2000,2040");
  assert.deepEqual(moviesOnly.map((x) => x.id), ["101", "104"]);

  const tvOnly = srv.filterItemsByCategory(allItems, "5000,5040");
  assert.deepEqual(tvOnly.map((x) => x.id), ["102", "104"]);

  const animeOnly = srv.filterItemsByCategory(allItems, "5070");
  assert.deepEqual(animeOnly.map((x) => x.id), ["103", "104"]);

  const tvAndAnime = srv.filterItemsByCategory(allItems, "5000,5070");
  assert.deepEqual(tvAndAnime.map((x) => x.id), ["102", "103", "104"]);
});

test("mergeSearchItems: deduplicates items by id and preserves item-level imdbId only on IMDb-verified results", () => {
  const imdbItems = [
    {
      id: "1001",
      title: "Breaking Bad S01E01 1080p",
      downloadUrl: "http://localhost:8998/download?id=1001&path=%2Fbb-1001%2F",
      commentsUrl: "https://extranet.torrentbay.st/bb-1001/",
      pubDate: "Wed, 18 Nov 2026 12:00:00 GMT",
      category: 5000,
      size: 1024,
      seeders: 50,
      leechers: 5,
      imdbId: "tt0903747"
    }
  ];
  const textItems = [
    {
      id: "1001",
      title: "Breaking Bad S01E01 1080p",
      downloadUrl: "http://localhost:8998/download?id=1001&path=%2Fbb-1001%2F",
      commentsUrl: "https://extranet.torrentbay.st/bb-1001/",
      pubDate: "Wed, 18 Nov 2026 12:00:00 GMT",
      category: 5000,
      size: 1024,
      seeders: 50,
      leechers: 5
    },
    {
      id: "1002",
      title: "Breaking Bad Season 1 Complete 1080p BluRay",
      downloadUrl: "http://localhost:8998/download?id=1002&path=%2Fbb-1002%2F",
      commentsUrl: "https://extranet.torrentbay.st/bb-1002/",
      pubDate: "Wed, 18 Nov 2026 12:00:00 GMT",
      category: 7000,
      size: 2048,
      seeders: 100,
      leechers: 10
    }
  ];

  const merged = srv.mergeSearchItems(imdbItems, textItems);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].id, "1001");
  assert.equal(merged[0].imdbId, "tt0903747");
  assert.equal(merged[1].id, "1002");
  assert.equal(merged[1].imdbId, undefined);

  const xml = srv.torznabResultsXml(merged);
  // Item 1001 has imdb attributes; item 1002 does not force imdb attribute
  const itemMatches = xml.match(/<item>[\s\S]*?<\/item>/g);
  assert.equal(itemMatches.length, 2);
  assert.match(itemMatches[0], /name="imdb"\s+value="0903747"/);
  assert.doesNotMatch(itemMatches[1], /name="imdb"/);
});

test("normalizeTitle: preserves audio channels (5.1, 7.1, 2.0), video codecs (H.264, H.265), and daily dates (YYYY.MM.DD)", () => {
  assert.equal(
    srv.normalizeTitle("Movie.Name.2026.1080p.WEB-DL.DDP5.1.Atmos.7.1.AAC2.0.H.264-GROUP"),
    "Movie Name 2026 1080p WEB-DL DDP5.1 Atmos 7.1 AAC2.0 H.264-GROUP"
  );
  assert.equal(
    srv.normalizeTitle("Daily.Show.2026.11.18.720p.WEB.H.265-GRP"),
    "Daily Show 2026.11.18 720p WEB H.265-GRP"
  );
});

test("torznabResultsXml: includes downloadvolumefactor=0 and uploadvolumefactor=1 for public tracker freeleech compatibility", () => {
  const items = [
    {
      id: "101",
      title: "Movie Name 2026 1080p",
      downloadUrl: "http://localhost:8998/download?id=101&path=%2Fmovie-101%2F",
      commentsUrl: "https://extranet.torrentbay.st/movie-101/",
      pubDate: "Wed, 18 Nov 2026 12:00:00 GMT",
      category: 2000,
      size: 1024,
      seeders: 10,
      leechers: 2
    }
  ];

  const xml = srv.torznabResultsXml(items);
  assert.match(xml, /<torznab:attr\s+name="downloadvolumefactor"\s+value="0"\s*\/>/);
  assert.match(xml, /<torznab:attr\s+name="uploadvolumefactor"\s+value="1"\s*\/>/);
});

test("resolveItemCategories: maps unclassified (7000) items to advertised categories (2000/5000/5070) so Prowlarr does not drop them", () => {
  const rawItems = [
    { id: "1", title: "Breaking Bad Season 1 COMPLETE 1080p BluRay x265-PSA", category: 7000 },
    { id: "2", title: "Dune Part Two 2024 1080p BluRay x264", category: 7000 },
    { id: "3", title: "Explicit TV Item", category: 5000 }
  ];

  // When Sonarr queries cat=5000 (tvsearch)
  const tvResolved = srv.resolveItemCategories(rawItems, "5000", "tvsearch");
  assert.deepEqual(tvResolved.map((x) => x.category), [5000, 5000, 5000]);

  // When Radarr queries cat=2000 (movie)
  const movieResolved = srv.resolveItemCategories(rawItems, "2000", "movie");
  assert.deepEqual(movieResolved.map((x) => x.category), [2000, 2000, 5000]);

  // When Anime queries cat=5070
  const animeResolved = srv.resolveItemCategories(rawItems, "5070", "tvsearch");
  assert.deepEqual(animeResolved.map((x) => x.category), [5070, 5070, 5000]);

  // When general search (no single category filter) uses title heuristics
  const generalResolved = srv.resolveItemCategories(rawItems, "2000,5000,5070", "search");
  assert.deepEqual(generalResolved.map((x) => x.category), [5000, 2000, 5000]);
});

test("UI_I18N and resolveUiLang: supports automatic browser language detection across 8 languages with complete key parity", () => {
  const expectedLangs = ["en", "tr", "es", "ru", "pt", "fr", "de", "pl"];
  assert.deepEqual(srv.SUPPORTED_UI_LANGS, expectedLangs);

  assert.equal(srv.resolveUiLang(["tr-TR", "en-US"]), "tr");
  assert.equal(srv.resolveUiLang(["es-MX", "en"]), "es");
  assert.equal(srv.resolveUiLang(["ru-RU"]), "ru");
  assert.equal(srv.resolveUiLang(["pt-BR", "pt"]), "pt");
  assert.equal(srv.resolveUiLang(["fr-CA"]), "fr");
  assert.equal(srv.resolveUiLang(["de-AT"]), "de");
  assert.equal(srv.resolveUiLang(["pl-PL"]), "pl");
  assert.equal(srv.resolveUiLang(["ja-JP", "pt-PT"]), "pt");
  assert.equal(srv.resolveUiLang(["ja-JP"]), "en");
  assert.equal(srv.resolveUiLang(""), "en");

  const enKeys = Object.keys(srv.UI_I18N.en).sort();
  assert.ok(enKeys.length >= 60);

  for (const code of expectedLangs) {
    assert.ok(srv.UI_I18N[code], `Missing UI_I18N dictionary for ${code}`);
    const langKeys = Object.keys(srv.UI_I18N[code]).sort();
    assert.deepEqual(langKeys, enKeys, `Key mismatch in UI_I18N.${code}`);
    for (const k of enKeys) {
      assert.ok(typeof srv.UI_I18N[code][k] === "string" && srv.UI_I18N[code][k].trim().length > 0, `Empty translation for ${code}.${k}`);
    }
  }
});

test("extractSearchInputs: extracts IMDb ID from Prowlarr {ImdbId:...} or tt-prefixed q tokens without misclassifying numeric titles", () => {
  // Prowlarr {ImdbId:tt...} token in q
  const p1 = srv.extractSearchInputs(new URLSearchParams("t=search&q=%7BImdbId%3Att0903747%7D"));
  assert.equal(p1.imdbId, "tt0903747");
  assert.equal(p1.rawQ, "");
  assert.equal(p1.q, "");

  // Prowlarr {ImdbId:digits} with episode token in q
  const p2 = srv.extractSearchInputs(new URLSearchParams("t=tvsearch&q=%7BImdbId%3A903747%7D+Season+1+Ep+2"));
  assert.equal(p2.imdbId, "tt0903747");
  assert.equal(p2.q, "S01E02");

  // Raw tt1234567 in q + season/ep params
  const p3 = srv.extractSearchInputs(new URLSearchParams("t=tvsearch&q=tt0903747&season=1&ep=3"));
  assert.equal(p3.imdbId, "tt0903747");
  assert.equal(p3.rawQ, "");
  assert.equal(p3.q, "S01E03");

  // Numeric movie/show titles like "90210" or "1917" must NOT be mistaken for IMDb IDs
  const p4 = srv.extractSearchInputs(new URLSearchParams("t=tvsearch&q=90210&season=1"));
  assert.equal(p4.imdbId, "");
  assert.equal(p4.rawQ, "90210");
  assert.equal(p4.q, "90210 S01");

  const p5 = srv.extractSearchInputs(new URLSearchParams("t=movie&q=1917"));
  assert.equal(p5.imdbId, "");
  assert.equal(p5.rawQ, "1917");
  assert.equal(p5.q, "1917");
});

test("applyEnvOverrides: applies FLARESOLVERR_URL, BASE_URL, PUBLIC_URL, SESSION_NAME, and API_KEY environment variables", () => {
  const base = {
    baseUrl: "https://extranet.torrentbay.st",
    publicUrl: "",
    flaresolverrUrl: "http://flaresolverr:8191/v1",
    sessionName: "extto_persistent",
    apiKey: "defaultkey"
  };

  const overridden = srv.applyEnvOverrides(base, {
    FLARESOLVERR_URL: " http://byparr:8191/v1 ",
    BASE_URL: "https://ext.to/",
    PUBLIC_URL: "http://192.168.1.50:8998/",
    SESSION_NAME: " custom_session ",
    API_KEY: " env_api_key "
  });

  assert.equal(overridden.flaresolverrUrl, "http://byparr:8191/v1");
  assert.equal(overridden.baseUrl, "https://ext.to");
  assert.equal(overridden.publicUrl, "http://192.168.1.50:8998");
  assert.equal(overridden.sessionName, "custom_session");
  assert.equal(overridden.apiKey, "env_api_key");

  // Empty env leaves config unchanged
  const unchanged = srv.applyEnvOverrides(base, {});
  assert.deepEqual(unchanged, base);
});

test("decodeEntities: does not throw RangeError on out-of-range or surrogate numeric HTML entities and decodes uppercase &NBSP;", () => {
  assert.doesNotThrow(() => srv.decodeEntities("Title &#99999999; &#x110000; &#55296; &NBSP; Test"));
  assert.equal(srv.decodeEntities("Hello&NBSP;World &#99999999;"), "Hello World &#99999999;");
});

test("parseSizeToBytes: handles comma thousands separators (1,234.56 MB) and invalid numbers without returning NaN", () => {
  assert.equal(srv.parseSizeToBytes("1,234.56 MB"), Math.floor(1234.56 * 1024 * 1024));
  assert.equal(srv.parseSizeToBytes("1,5 GB"), Math.floor(1.5 * 1024 * 1024 * 1024));
  assert.equal(srv.parseSizeToBytes("... GB"), 0);
  assert.equal(Number.isNaN(srv.parseSizeToBytes("1,234.56 MB")), false);
  assert.equal(Number.isNaN(srv.parseSizeToBytes("... GB")), false);
});

test("parseDateToRfc822: does not parse bare numbers (e.g. '5' or '12') as year 2001", () => {
  const fixedNow = Date.UTC(2026, 10, 21, 12, 0, 0);
  assert.equal(srv.parseDateToRfc822("5", fixedNow), new Date(fixedNow).toUTCString());
  assert.equal(srv.parseDateToRfc822("12", fixedNow), new Date(fixedNow).toUTCString());
  assert.equal(srv.parseDateToRfc822("2024-05-10", fixedNow), new Date("2024-05-10").toUTCString());
});

test("parseResults: handles absolute mirror URLs in torrent links and X-Forwarded-Proto/Host headers", () => {
  const html = `<table class="search-table"><tr>
    <td><a href="https://ext.to/tv/show-s01e01-54321/">Show.S01E01.1080p.WEB-DL</a><a href="https://ext.to/tv/">TV</a></td>
    <td>1,234.5 MB</td><td>2</td><td>1 hour</td><td>100</td><td>10</td>
  </tr></table>`;

  const items = srv.parseResults(html, {
    headers: {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "torznab.example.com"
    }
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].id, "54321");
  assert.equal(items[0].relPath, "/tv/show-s01e01-54321/");
  assert.equal(items[0].category, 5000);
  assert.equal(items[0].downloadUrl, "https://torznab.example.com/download?id=54321&path=%2Ftv%2Fshow-s01e01-54321%2F");
});

test("/api and /cache/clear: returns empty feed on unsupported ID-only queries (tmdbid/tvdbid or disabled imdbid) instead of warm results, and accepts POST on /cache/clear", async () => {
  const prevKey = srv.getConfig().apiKey;
  const prevImdb = srv.getConfig().enableImdbSearch;
  srv.setConfigForTest({ apiKey: "", enableImdbSearch: false });

  const server = srv.server;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  try {
    // 1. imdbid-only query while enableImdbSearch is false must return empty <channel> without calling FlareSolverr for "warm"
    const r1 = await fetch(`http://127.0.0.1:${port}/api?t=movie&imdbid=tt15239678`);
    assert.equal(r1.status, 200);
    const xml1 = await r1.text();
    assert.doesNotMatch(xml1, /<item>/);

    // 2. tmdbid-only or tvdbid-only query without q/imdbid must return empty <channel>
    srv.setConfigForTest({ enableImdbSearch: true });
    const r2 = await fetch(`http://127.0.0.1:${port}/api?t=tvsearch&tvdbid=81189&season=1`);
    assert.equal(r2.status, 200);
    const xml2 = await r2.text();
    assert.doesNotMatch(xml2, /<item>/);

    // 3. POST /cache/clear must succeed with 200
    const r3 = await fetch(`http://127.0.0.1:${port}/cache/clear`, { method: "POST" });
    assert.equal(r3.status, 200);
    const j3 = await r3.json();
    assert.equal(j3.ok, true);
  } finally {
    await new Promise((r) => server.close(r));
    srv.setConfigForTest({ apiKey: prevKey, enableImdbSearch: prevImdb });
  }
});

test("extractBrowseFilters and buildBrowsePath: supports user_nick, sort, order, age, ext_cat, sub_cat, page, and with_adult without requiring q", () => {
  // 1. Keywordless uploader + sort + order query (Issue #5 example)
  const p1 = new URLSearchParams("t=search&user_nick=PSA&sort=age&order=desc");
  const in1 = srv.extractSearchInputs(p1);
  assert.equal(in1.q, "");
  assert.equal(in1.filters.userNick, "PSA");
  assert.equal(in1.filters.sort, "age");
  assert.equal(in1.filters.order, "desc");
  assert.equal(
    srv.buildBrowsePath(in1.q, in1.imdbId, in1.filters),
    "/browse/?user_nick=PSA&sort=age&order=desc&with_adult=1"
  );

  // 2. Sort aliases (seeders -> seed) + age + ext_cat + sub_cat + page + with_adult override
  const p2 = new URLSearchParams("t=search&uploader=QxR&sort=seeders&order=asc&age=0&ext_cat=2&sub_cat=72&page=2&with_adult=0");
  const in2 = srv.extractSearchInputs(p2);
  assert.equal(in2.q, "");
  assert.equal(
    srv.buildBrowsePath(in2.q, in2.imdbId, in2.filters),
    "/browse/?user_nick=QxR&cat=2&sub_cat=72&age=0&sort=seed&order=asc&page=2&with_adult=0"
  );

  // 3. Combined keyword + uploader + sort
  const p3 = new URLSearchParams("t=tvsearch&q=Breaking+Bad&season=1&user_nick=MeGusta&sort=size&order=desc");
  const in3 = srv.extractSearchInputs(p3);
  assert.equal(in3.q, "Breaking Bad S01");
  assert.equal(
    srv.buildBrowsePath(in3.q, in3.imdbId, in3.filters),
    "/browse/?q=Breaking+Bad+S01&user_nick=MeGusta&sort=size&order=desc&with_adult=1"
  );

  // 4. Invalid filter values are ignored and empty query falls back to warm
  const p4 = new URLSearchParams("t=search&sort=invalid_field&order=sideways&age=99&page=0");
  const in4 = srv.extractSearchInputs(p4);
  assert.equal(in4.filters.hasFilters, false);
  assert.equal(in4.q, "warm");
  assert.equal(
    srv.buildBrowsePath(in4.q, in4.imdbId, in4.filters),
    "/browse/?q=warm&with_adult=1"
  );
});

test("GET / Web UI: inline <script> parses cleanly without syntax errors and contains RSS URL builder before sticky actions", async () => {
  const vm = require("node:vm");
  const server = srv.server;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    const html = await res.text();

    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/i);
    assert.ok(scriptMatch, "Expected inline <script> in Web UI HTML");
    assert.doesNotThrow(() => new vm.Script(scriptMatch[1]), "Inline Web UI script must not have syntax errors");

    const rssIdx = html.indexOf('id="rssFeedUrl"');
    const actionsIdx = html.indexOf('class="actions"');
    assert.ok(rssIdx > 0 && actionsIdx > rssIdx, "RSS builder section must appear above sticky .actions bar");
  } finally {
    await new Promise((r) => server.close(r));
  }
});






