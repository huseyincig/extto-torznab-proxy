const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { APP_VERSION, normalizeMagnet } = require("../server.js");

test("APP_VERSION is 1.0.1", () => {
  assert.equal(APP_VERSION, "1.0.1");
});

test("normalizeMagnet: preserves standard valid magnet URIs", () => {
  const input = "magnet:?xt=urn:btih:3b5c3e7b1a2c4d5e6f7a8b9c0d1e2f3a4b5c6d7e&dn=Ubuntu-24.04";
  const result = normalizeMagnet(input);
  assert.equal(result, input);
});

test("normalizeMagnet: strips trailing and embedded CR, LF and control characters", () => {
  const input = "  magnet:?xt=urn:btih:1234567890abcdef\r\n\t  ";
  const result = normalizeMagnet(input);
  assert.equal(result, "magnet:?xt=urn:btih:1234567890abcdef");
  assert.equal(result.includes("\r"), false);
  assert.equal(result.includes("\n"), false);
});

test("normalizeMagnet: percent-encodes unencoded non-ASCII characters in display name", () => {
  const input = "magnet:?xt=urn:btih:12345&dn=Film Şahane (2024)";
  const result = normalizeMagnet(input);
  // Non-ASCII and spaces should be safely encoded
  assert.equal(result, "magnet:?xt=urn:btih:12345&dn=Film%20%C5%9Eahane%20(2024)");
  // Verify all characters are printable ASCII (33 to 126)
  assert.match(result, /^[\x21-\x7E]+$/);
});

test("normalizeMagnet: does NOT double-encode existing percent-encoded tracker parameters", () => {
  const input = "magnet:?xt=urn:btih:12345&dn=Test%20File&tr=udp%3A%2F%2Ftracker.example.com%3A6969%2Fannounce";
  const result = normalizeMagnet(input);
  assert.equal(result, input);
  assert.equal(result.includes("%25"), false, "Must not introduce double-encoding %25");
});

test("normalizeMagnet: throws on invalid inputs", () => {
  assert.throws(() => normalizeMagnet(null), /expected string/);
  assert.throws(() => normalizeMagnet(12345), /expected string/);
  assert.throws(() => normalizeMagnet("http://example.com/file.torrent"), /missing magnet:\? prefix/);
  assert.throws(() => normalizeMagnet(""), /missing magnet:\? prefix/);
});

test("HTTP Location header safety: Node.js HTTP server accepts normalized magnet without ERR_INVALID_CHAR", async () => {
  const problematicMagnets = [
    "magnet:?xt=urn:btih:12345&dn=Film Şahane\r\n",
    "magnet:?xt=urn:btih:12345\n\r",
    "magnet:?xt=urn:btih:12345&dn=Movie with spaces and umlauts: äöü ß",
    "magnet:?xt=urn:btih:12345&dn=Cyrillic Фильм",
  ];

  const server = http.createServer((req, res) => {
    try {
      const idx = Number(req.url.slice(1));
      const raw = problematicMagnets[idx];
      const normalized = normalizeMagnet(raw);
      res.writeHead(302, {
        Location: normalized,
        "cache-control": "private, max-age=86400",
      });
      res.end();
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(err.name + ": " + err.message);
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    for (let i = 0; i < problematicMagnets.length; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/${i}`, { redirect: "manual" });
      assert.equal(res.status, 302, `Expected 302 redirect for magnet ${i}, got status ${res.status}`);
      const loc = res.headers.get("location");
      assert.ok(loc && loc.startsWith("magnet:?"));
      assert.match(loc, /^[\x21-\x7E]+$/, "Location header must be strict printable ASCII");
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
