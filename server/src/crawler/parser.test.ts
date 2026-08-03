import { describe, expect, it } from "vitest";
import { PARSE_DEFAULTS, parseHtml } from "./parser.js";

const PAGE_URL = "http://example.com/docs/page";

//parseHtml returns null only for an unusable page URL, which every test here supplies
//correctly. Unwrapping through this helper keeps the null check out of forty assertions.
function parse(html: string, url = PAGE_URL, options = {}) {
  const parsed = parseHtml(html, url, options);
  if (!parsed) throw new Error("expected parseHtml to succeed");
  return parsed;
}

function doc(head: string, body: string): string {
  return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
}

describe("parseHtml — title", () => {
  it("reads <title> and collapses its whitespace", () => {
    const parsed = parse(doc("<title>  Search\n  Engines  </title>", "<p>x</p>"));
    expect(parsed.title).toBe("Search Engines");
  });

  it("falls back to the first <h1> when there is no title", () => {
    expect(parse(doc("", "<h1>Fallback Heading</h1>")).title).toBe("Fallback Heading");
  });

  it("is an empty string when the page offers neither", () => {
    expect(parse(doc("", "<p>x</p>")).title).toBe("");
  });

  it("truncates an absurdly long title", () => {
    const parsed = parse(doc(`<title>${"a".repeat(500)}</title>`, ""), PAGE_URL, {
      maxTitleChars: 20,
    });
    expect(parsed.title).toHaveLength(20);
  });
});

describe("parseHtml — text extraction", () => {
  //The bug this exists to prevent: cheerio's .text() concatenates raw text nodes with
  //nothing between them, so two paragraphs fuse into one nonsense token that the Phase 2
  //tokenizer would faithfully index.
  it("separates block elements instead of fusing their text", () => {
    const parsed = parse(doc("", "<p>Apples</p><p>Oranges</p>"));

    expect(parsed.text).not.toContain("ApplesOranges");
    expect(parsed.text).toBe("Apples\nOranges");
  });

  //The mirror-image mistake. A browser really does render this as "ab", so inserting a
  //separator would invent a word boundary the page doesn't have.
  it("does not separate inline elements", () => {
    expect(parse(doc("", "<p><span>hel</span><em>lo</em></p>")).text).toBe("hello");
  });

  it("treats <br> as a break", () => {
    expect(parse(doc("", "<p>one<br>two</p>")).text).toBe("one\ntwo");
  });

  //Minified JavaScript is a dense wall of identifiers. Left in, it would dominate the term
  //frequencies of whatever document it came from.
  it("excludes script and style content", () => {
    const parsed = parse(
      doc(
        "<style>.cls{color:red}</style>",
        "<p>Real text</p><script>var secretToken = 42;</script>",
      ),
    );

    expect(parsed.text).toBe("Real text");
    expect(parsed.text).not.toContain("secretToken");
    expect(parsed.text).not.toContain("color");
  });

  it("strips site chrome when the page never said where its content was", () => {
    const parsed = parse(
      doc(
        "",
        "<header>Site Name</header><nav>Home About</nav>" +
          "<p>Article body</p>" +
          "<aside>Related links</aside><footer>Copyright 2026</footer>",
      ),
    );

    expect(parsed.text).toBe("Article body");
  });

  //A page that marked up <main> has already answered the question, so a <header> inside it
  //is almost always the headline and byline — real content we'd rather not throw away.
  it("keeps a header inside an explicit <main>", () => {
    const parsed = parse(
      doc(
        "",
        "<header>Site Name</header>" +
          "<main><header>Headline</header><p>Body</p></main>" +
          "<footer>Copyright</footer>",
      ),
    );

    expect(parsed.text).toBe("Headline\nBody");
    expect(parsed.text).not.toContain("Site Name");
  });

  it("still strips nav from inside a scoped main", () => {
    const parsed = parse(doc("", "<main><nav>Breadcrumb</nav><p>Body</p></main>"));
    expect(parsed.text).toBe("Body");
  });

  it("scopes to a single <article>", () => {
    const parsed = parse(doc("", "<p>Intro</p><article><p>The post</p></article>"));
    expect(parsed.text).toBe("The post");
  });

  //A blog index is a list of many <article> elements. Taking the first would index one
  //teaser and silently discard the rest of the page.
  it("falls back to the body when several articles make the scope ambiguous", () => {
    const parsed = parse(
      doc("", "<article><p>First</p></article><article><p>Second</p></article>"),
    );

    expect(parsed.text).toContain("First");
    expect(parsed.text).toContain("Second");
  });

  it("decodes entities", () => {
    expect(parse(doc("", "<p>Tom &amp; Jerry &lt;3</p>")).text).toBe("Tom & Jerry <3");
  });

  //A non-breaking space is a different codepoint from a space, so a tokenizer splitting on
  ///\s/ would see "New York" as a single token.
  it("normalizes invisible characters that would corrupt tokenization", () => {
    const parsed = parse(doc("", "<p>New&nbsp;York&shy;shire&#8203;!</p>"));

    expect(parsed.text).toBe("New Yorkshire!");
    expect(parsed.text).not.toMatch(/[ ­​]/);
  });

  it("collapses runs of whitespace and stray blank lines", () => {
    const parsed = parse(doc("", "<div><div><p>a</p></div></div>\n\n\n<p>b   c</p>"));
    expect(parsed.text).toBe("a\nb c");
  });

  it("truncates long text at a word boundary", () => {
    const parsed = parse(doc("", "<p>aaa bbb ccc ddd eee fff ggg</p>"), PAGE_URL, {
      maxTextChars: 20,
    });

    expect(parsed.text.length).toBeLessThanOrEqual(20);
    //The point of the boundary: a hard cut would leave a fragment like "ee" as a real term
    //in the index, pointing at a word that isn't on the page.
    expect(parsed.text).toBe("aaa bbb ccc ddd eee");
  });
});

describe("parseHtml — links", () => {
  it("resolves relative hrefs against the page URL", () => {
    const parsed = parse(
      doc("", '<a href="/about">a</a><a href="sibling">b</a><a href="../up">c</a>'),
    );

    expect(parsed.links).toEqual([
      "http://example.com/about",
      "http://example.com/docs/sibling",
      "http://example.com/up",
    ]);
  });

  //THE ordering test. Pruning runs before text extraction but must run *after* link
  //extraction: site navigation is precisely how a crawler reaches the rest of a site, so
  //pruning first would leave the frontier with only the links inside body copy.
  it("collects links from chrome that text extraction throws away", () => {
    const parsed = parse(
      doc(
        "",
        '<nav><a href="/section">Section</a></nav>' +
          "<p>Body</p>" +
          '<footer><a href="/legal">Legal</a></footer>',
      ),
    );

    expect(parsed.text).toBe("Body");
    expect(parsed.links).toEqual([
      "http://example.com/section",
      "http://example.com/legal",
    ]);
  });

  it("drops non-crawlable schemes without a separate blocklist", () => {
    const parsed = parse(
      doc(
        "",
        '<a href="mailto:a@b.com">m</a><a href="javascript:void(0)">j</a>' +
          '<a href="/real">r</a>',
      ),
    );

    expect(parsed.links).toEqual(["http://example.com/real"]);
  });

  //A fragment-only href resolves to the page itself once the fragment is stripped, so
  //without this rule every "back to top" anchor would emit the current URL as a discovery.
  it("drops links back to the page itself", () => {
    const parsed = parse(
      doc(
        "",
        '<a href="#top">top</a><a href="/docs/page">self</a>' +
          '<a href="/docs/page?x=1">not self</a><a href="/other">other</a>',
      ),
    );

    expect(parsed.links).toEqual([
      "http://example.com/docs/page?x=1",
      "http://example.com/other",
    ]);
  });

  it("canonicalizes and deduplicates, preserving document order", () => {
    const parsed = parse(
      doc(
        "",
        '<a href="/b?y=2&x=1">1</a><a href="/a">2</a>' +
          '<a href="/b?x=1&y=2">3</a><a href="/a#frag">4</a>',
      ),
    );

    expect(parsed.links).toEqual([
      "http://example.com/b?x=1&y=2",
      "http://example.com/a",
    ]);
  });

  it("strips tracking parameters from extracted links", () => {
    const parsed = parse(doc("", '<a href="/post?id=7&utm_source=rss">p</a>'));
    expect(parsed.links).toEqual(["http://example.com/post?id=7"]);
  });

  it("honours <base href>", () => {
    const parsed = parse(
      doc('<base href="http://cdn.example.net/v2/">', '<a href="asset">a</a>'),
    );

    expect(parsed.links).toEqual(["http://cdn.example.net/v2/asset"]);
  });

  it("resolves a relative <base href> against the page URL", () => {
    const parsed = parse(doc('<base href="/root/">', '<a href="asset">a</a>'));
    expect(parsed.links).toEqual(["http://example.com/root/asset"]);
  });

  it("skips rel=nofollow links", () => {
    const parsed = parse(
      doc(
        "",
        '<a href="/skip" rel="nofollow">s</a>' +
          '<a href="/skip2" rel="noopener NOFOLLOW">s</a>' +
          '<a href="/keep" rel="noopener">k</a>',
      ),
    );

    expect(parsed.links).toEqual(["http://example.com/keep"]);
  });

  //"nofollower" is not "nofollow" — a substring match here would silently drop real links.
  it("does not match nofollow as a substring of another rel token", () => {
    const parsed = parse(doc("", '<a href="/keep" rel="nofollower">k</a>'));
    expect(parsed.links).toEqual(["http://example.com/keep"]);
  });

  it("caps the number of links", () => {
    const anchors = Array.from({ length: 50 }, (_, i) => `<a href="/p${i}">l</a>`).join("");
    const parsed = parse(doc("", anchors), PAGE_URL, { maxLinks: 10 });

    expect(parsed.links).toHaveLength(10);
    expect(PARSE_DEFAULTS.maxLinks).toBeGreaterThan(10);
  });
});

describe("parseHtml — metadata", () => {
  it("extracts and canonicalizes rel=canonical", () => {
    const parsed = parse(doc('<link rel="canonical" href="/docs/page?b=2&a=1">', ""));
    expect(parsed.canonicalUrl).toBe("http://example.com/docs/page?a=1&b=2");
  });

  it("handles canonical among several rel tokens", () => {
    const parsed = parse(doc('<link rel="alternate canonical" href="/x">', ""));
    expect(parsed.canonicalUrl).toBe("http://example.com/x");
  });

  //Kept separate from `url` rather than substituted: honouring a canonical means trusting
  //a page's self-report about a URL we may never have fetched, which is 1.6's call.
  it("reports the fetched URL as `url` regardless of the canonical", () => {
    const parsed = parse(doc('<link rel="canonical" href="/other">', ""));

    expect(parsed.url).toBe(PAGE_URL);
    expect(parsed.canonicalUrl).toBe("http://example.com/other");
  });

  it("reports null for a missing or unusable canonical", () => {
    expect(parse(doc("", "")).canonicalUrl).toBeNull();
    expect(parse(doc('<link rel="canonical" href="javascript:0">', "")).canonicalUrl)
      .toBeNull();
  });

  it("reads meta robots directives", () => {
    const parsed = parse(doc('<meta name="robots" content="noindex, nofollow">', ""));

    expect(parsed.noindex).toBe(true);
    expect(parsed.nofollow).toBe(true);
  });

  it("treats content=none as noindex plus nofollow", () => {
    const parsed = parse(doc('<meta name="ROBOTS" content="none">', ""));

    expect(parsed.noindex).toBe(true);
    expect(parsed.nofollow).toBe(true);
  });

  //Naming a bot is how a site grants it an exception; reading only the generic directive
  //would ignore that and block ourselves out of a site that had let us in.
  it("lets a directive naming our own token override the generic one", () => {
    const parsed = parse(
      doc(
        '<meta name="robots" content="noindex, nofollow">' +
          '<meta name="SearchEngine2Bot" content="all">',
        "",
      ),
    );

    expect(parsed.noindex).toBe(false);
    expect(parsed.nofollow).toBe(false);
  });

  //nofollow is applied here rather than merely reported, because dropping the links is
  //unambiguous — unlike noindex, which is about storage and so belongs to 1.6.
  it("suppresses all links under a page-level nofollow", () => {
    const parsed = parse(
      doc('<meta name="robots" content="nofollow">', '<a href="/x">x</a>'),
    );

    expect(parsed.links).toEqual([]);
  });

  it("still extracts text and links under noindex alone", () => {
    const parsed = parse(
      doc('<meta name="robots" content="noindex">', '<p>Body</p><a href="/x">x</a>'),
    );

    expect(parsed.noindex).toBe(true);
    //"x" is the anchor's own text, and <a> is inline — so it joins the body text rather
    //than being separated from it. Only <p> contributes the break.
    expect(parsed.text).toBe("Body\nx");
    expect(parsed.links).toEqual(["http://example.com/x"]);
  });

  it("defaults both directives to false", () => {
    const parsed = parse(doc("", "<p>x</p>"));

    expect(parsed.noindex).toBe(false);
    expect(parsed.nofollow).toBe(false);
  });

  it("reads the language tag whole, region included", () => {
    expect(parseHtml('<html lang="en-US"><body>x</body></html>', PAGE_URL)?.lang)
      .toBe("en-us");
    expect(parseHtml('<html lang="pt-BR"><body>x</body></html>', PAGE_URL)?.lang)
      .toBe("pt-br");
  });

  //`lang` is author-supplied and routinely holds template placeholders, which would
  //otherwise be written into documents.lang and consulted by Phase 2.
  it("rejects a lang attribute that isn't shaped like a BCP-47 tag", () => {
    for (const value of ["{{locale}}", "en_US", "english language", ""]) {
      expect(parseHtml(`<html lang="${value}"><body>x</body></html>`, PAGE_URL)?.lang)
        .toBeNull();
    }
  });

  it("reports null lang when the attribute is absent", () => {
    expect(parse(doc("", "<p>x</p>")).lang).toBeNull();
  });

  it("extracts a description, preferring the standard meta over og:", () => {
    expect(parse(doc('<meta name="description" content="  A page.  ">', "")).description)
      .toBe("A page.");
    expect(parse(doc('<meta property="og:description" content="Social.">', "")).description)
      .toBe("Social.");
    expect(
      parse(
        doc(
          '<meta property="og:description" content="Social."><meta name="description" content="Standard.">',
          "",
        ),
      ).description,
    ).toBe("Standard.");
  });

  it("reports null for a missing or empty description", () => {
    expect(parse(doc("", "")).description).toBeNull();
    expect(parse(doc('<meta name="description" content="   ">', "")).description).toBeNull();
  });
});

describe("parseHtml — edges", () => {
  it("returns null when the page URL itself is unusable", () => {
    expect(parseHtml("<p>x</p>", "not a url")).toBeNull();
    expect(parseHtml("<p>x</p>", "ftp://example.com/x")).toBeNull();
  });

  it("normalizes the page URL it reports", () => {
    const parsed = parse(doc("", ""), "HTTP://Example.com/docs/page?utm_source=x#frag");
    expect(parsed.url).toBe("http://example.com/docs/page");
  });

  //Relative links must resolve against where the document actually came from, which is why
  //callers pass the fetcher's post-redirect URL rather than the requested one.
  it("resolves links against the URL it was given, not a guess", () => {
    const parsed = parse(doc("", '<a href="x">x</a>'), "http://moved.example.org/a/b");
    expect(parsed.links).toEqual(["http://moved.example.org/a/x"]);
  });

  //cheerio's parser accepts any byte sequence the way a browser does, so parsing proper
  //cannot fail — only the URL check can.
  it("survives malformed and empty markup", () => {
    expect(parse("<p>unclosed<div><a href='/x'>link", PAGE_URL).links)
      .toEqual(["http://example.com/x"]);
    expect(parse("", PAGE_URL).text).toBe("");
    expect(parse("just bare text", PAGE_URL).text).toBe("just bare text");
  });
});
