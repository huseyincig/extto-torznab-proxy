const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const srv = require("../server.js");

test("APP_VERSION is 1.0.2", () => {
  assert.equal(srv.APP_VERSION, "1.0.2");
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

test("torznabCapsXml: exposes only Movies (2000), TV (5000), and Anime (5070)", () => {
  const xml = srv.torznabCapsXml();
  assert.match(xml, /<category\s+id="2000"\s+name="Movies"\s*\/>/);
  assert.match(xml, /<category\s+id="5000"\s+name="TV"\s*\/>/);
  assert.match(xml, /<category\s+id="5070"\s+name="Anime"\s*\/>/);
  assert.doesNotMatch(xml, /id="7000"/);
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
