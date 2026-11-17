import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHttpUrl, isLoopbackHttpUrl } from "../src/urls.js";

test("parseHttpUrl accepts http and https and normalizes", () => {
  assert.equal(parseHttpUrl("https://example.com/a?b=1").href, "https://example.com/a?b=1");
  assert.equal(parseHttpUrl("http://Example.com").href, "http://example.com/");
});

test("parseHttpUrl rejects other schemes and junk", () => {
  const bad = [
    "file:///C:/Windows", "javascript:alert(1)", "ftp://x", "C:\\Windows\\notepad.exe",
    "not a url", "", null, undefined, 42, {}, "https://" + "a".repeat(2050)
  ];
  for (const value of bad) assert.equal(parseHttpUrl(value), null, String(value));
});

test("isLoopbackHttpUrl accepts only loopback hosts", () => {
  for (const ok of ["http://127.0.0.1:36061/?t=abc", "http://localhost:1/", "http://[::1]:5/", "https://localhost/"]) {
    assert.equal(isLoopbackHttpUrl(ok), true, ok);
  }
  for (const no of ["https://example.com", "http://127.0.0.2/", "http://localhost.evil.com/",
    "http://localhost@evil.com/", "file://localhost/x", null]) {
    assert.equal(isLoopbackHttpUrl(no), false, String(no));
  }
});
