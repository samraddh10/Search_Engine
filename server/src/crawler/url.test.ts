//These are pure functions, so unlike fetcher.test.ts and robots.test.ts there's no fixture
//server here — there's no I/O to be honest about.
//
//The canonical form is the frontier's dedup key, which makes these tests unusually
//load-bearing: every assertion below is really the statement "these two spellings are the
//same page", and getting one wrong means either re-crawling a page forever or silently
//never crawling one at all.
import { describe, expect, it } from "vitest";
import { MAX_URL_LENGTH, isTrackingParam, normalizeUrl, parseHttpUrl } from "./url.js";

describe("parseHttpUrl", () => {
  it("accepts absolute http and https URLs", () => {
    expect(parseHttpUrl("http://example.com/a")?.href).toBe("http://example.com/a");
    expect(parseHttpUrl("https://example.com/a")?.href).toBe("https://example.com/a");
  });

  //The security-relevant case: `new URL` accepts all of these happily, so the protocol
  //check is the only thing standing between the crawler and reading the local filesystem.
  it("rejects every scheme that isn't http(s)", () => {
    for (const value of [
      "javascript:alert(1)",
      "data:text/html,<script>x</script>",
      "file:///etc/passwd",
      "ftp://example.com/f",
      "mailto:someone@example.com",
      "tel:+15551234",
    ]) {
      expect(parseHttpUrl(value)).toBeNull();
    }
  });

  it("rejects unparseable input", () => {
    expect(parseHttpUrl("not a url")).toBeNull();
    expect(parseHttpUrl("")).toBeNull();
  });

  it("resolves against a base, so relative hrefs and Location headers both work", () => {
    expect(parseHttpUrl("/about", "http://example.com/docs/x")?.href)
      .toBe("http://example.com/about");
    expect(parseHttpUrl("../up", "http://example.com/a/b/c")?.href)
      .toBe("http://example.com/a/up");
    expect(parseHttpUrl("sibling", "http://example.com/a/b")?.href)
      .toBe("http://example.com/a/sibling");
  });

  it("refuses URLs past the length cap", () => {
    const long = `http://example.com/${"a".repeat(MAX_URL_LENGTH)}`;
    expect(long.length).toBeGreaterThan(MAX_URL_LENGTH);
    expect(parseHttpUrl(long)).toBeNull();
  });
});

describe("isTrackingParam", () => {
  it("matches known click ids and whole utm_-style families", () => {
    expect(isTrackingParam("utm_source")).toBe(true);
    expect(isTrackingParam("utm_anything_at_all")).toBe(true);
    expect(isTrackingParam("gclid")).toBe(true);
    expect(isTrackingParam("fbclid")).toBe(true);
    expect(isTrackingParam("UTM_Campaign")).toBe(true);
  });

  //The conservative half of the policy, asserted directly rather than left implicit:
  //stripping one of these would merge genuinely distinct pages into one frontier entry.
  it("leaves parameters that commonly select real content", () => {
    for (const name of ["q", "id", "page", "ref", "source", "search", "p", "lang"]) {
      expect(isTrackingParam(name)).toBe(false);
    }
  });
});

describe("normalizeUrl — what `new URL` already handles", () => {
  it("lowercases the scheme and host but not the path", () => {
    //Path case is preserved because paths are case-sensitive on most servers: /About and
    ///about can be two different documents.
    expect(normalizeUrl("HTTP://Example.COM/About")).toBe("http://example.com/About");
  });

  it("drops the default port and keeps a non-default one", () => {
    expect(normalizeUrl("http://example.com:80/a")).toBe("http://example.com/a");
    expect(normalizeUrl("https://example.com:443/a")).toBe("https://example.com/a");
    expect(normalizeUrl("http://example.com:8080/a")).toBe("http://example.com:8080/a");
  });

  it("resolves dot segments", () => {
    expect(normalizeUrl("http://example.com/a/b/../c")).toBe("http://example.com/a/c");
    expect(normalizeUrl("http://example.com/a/./b")).toBe("http://example.com/a/b");
  });
});

describe("normalizeUrl — the policy choices", () => {
  it("supplies a root path, so the bare origin and the origin with a slash agree", () => {
    expect(normalizeUrl("http://example.com")).toBe("http://example.com/");
    expect(normalizeUrl("http://example.com/")).toBe("http://example.com/");
  });

  it("strips the fragment, since it never reaches the server", () => {
    expect(normalizeUrl("http://example.com/p#section-4")).toBe("http://example.com/p");
    //One page with fifty anchors on it must not become fifty frontier entries.
    expect(normalizeUrl("http://example.com/p#a")).toBe(normalizeUrl("http://example.com/p#b"));
  });

  it("strips credentials, which are not part of a page's identity", () => {
    expect(normalizeUrl("http://user:secret@example.com/p")).toBe("http://example.com/p");
  });

  it("sorts query parameters so ordering can't create duplicates", () => {
    expect(normalizeUrl("http://example.com/p?b=2&a=1")).toBe("http://example.com/p?a=1&b=2");
    expect(normalizeUrl("http://example.com/p?a=1&b=2"))
      .toBe(normalizeUrl("http://example.com/p?b=2&a=1"));
  });

  it("orders repeated parameters by value, so the sort is total", () => {
    expect(normalizeUrl("http://example.com/p?t=b&t=a")).toBe("http://example.com/p?t=a&t=b");
  });

  it("removes tracking parameters and the '?' they leave behind", () => {
    expect(normalizeUrl("http://example.com/p?utm_source=news&utm_medium=email"))
      .toBe("http://example.com/p");
    expect(normalizeUrl("http://example.com/p?utm_source=news&q=cats"))
      .toBe("http://example.com/p?q=cats");
    expect(normalizeUrl("http://example.com/p?")).toBe("http://example.com/p");
  });

  it("collapses the campaign variants of one page to a single key", () => {
    const key = normalizeUrl("http://example.com/post?id=7");
    expect(normalizeUrl("http://example.com/post?id=7&utm_source=twitter")).toBe(key);
    expect(normalizeUrl("http://example.com/post?utm_campaign=spring&id=7")).toBe(key);
    expect(normalizeUrl("http://example.com/post?id=7&fbclid=abc123")).toBe(key);
  });

  //The deliberate non-rule. Servers disagree about whether /docs and /docs/ are the same
  //resource — many answer one with a 301 and the other with a 404 — so guessing would
  //cost us real pages.
  it("leaves the trailing slash on a non-empty path alone", () => {
    expect(normalizeUrl("http://example.com/docs/")).toBe("http://example.com/docs/");
    expect(normalizeUrl("http://example.com/docs")).toBe("http://example.com/docs");
  });

  it("returns null for anything not crawlable", () => {
    expect(normalizeUrl("javascript:void(0)")).toBeNull();
    expect(normalizeUrl("#anchor-only")).toBeNull();
    expect(normalizeUrl("mailto:a@b.com")).toBeNull();
  });

  it("resolves relative values against a base", () => {
    expect(normalizeUrl("/x?b=1&a=2", "http://example.com/deep/page"))
      .toBe("http://example.com/x?a=2&b=1");
  });

  //Re-encoding can lengthen a URL, so the cap is re-checked on the way out rather than
  //only on the way in. URLSearchParams serializes with form-urlencoding, whose safe set is
  //much smaller than the URL parser's — "!" survives parsing untouched and comes back out
  //as "%21", tripling in size.
  it("re-checks the length cap after normalizing", () => {
    const url = `http://example.com/?v=${"!".repeat(1000)}`;

    expect(url.length).toBeLessThanOrEqual(MAX_URL_LENGTH);
    expect(normalizeUrl(url)).toBeNull();
    //The same URL just under the growth threshold still normalizes fine, so the cap is
    //rejecting length rather than the character.
    expect(normalizeUrl(`http://example.com/?v=${"!".repeat(600)}`)).not.toBeNull();
  });
});
