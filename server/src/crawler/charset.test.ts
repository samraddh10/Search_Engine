//Charset tests work on byte arrays rather than strings, because the whole point of the
//module is what happens *before* there is a string. Writing these against text would
//assume the answer.
//
//0xE9 is the discriminator used throughout: it's "é" in windows-1252 and an invalid lone
//continuation byte in UTF-8, so a wrong decode shows up as U+FFFD rather than as a subtly
//different character that an assertion might wave through.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHARSET,
  META_PRESCAN_BYTES,
  decodeBody,
  detectBom,
  parseCharsetParam,
  sniffMetaCharset,
} from "./charset.js";

const REPLACEMENT = "�";

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function latin1(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "latin1"));
}

describe("detectBom", () => {
  it("recognizes the three byte-order marks", () => {
    expect(detectBom(bytes(0xef, 0xbb, 0xbf, 0x68))).toBe("utf-8");
    expect(detectBom(bytes(0xff, 0xfe, 0x68, 0x00))).toBe("utf-16le");
    expect(detectBom(bytes(0xfe, 0xff, 0x00, 0x68))).toBe("utf-16be");
  });

  it("reports nothing for a body without one", () => {
    expect(detectBom(latin1("<html>"))).toBeNull();
    expect(detectBom(bytes())).toBeNull();
    //A truncated mark is not a mark.
    expect(detectBom(bytes(0xef))).toBeNull();
  });
});

describe("sniffMetaCharset", () => {
  it("finds the short form", () => {
    expect(sniffMetaCharset(latin1('<html><meta charset="windows-1252">')))
      .toBe("windows-1252");
  });

  it("finds the http-equiv form", () => {
    const html =
      '<html><meta http-equiv="Content-Type" content="text/html; charset=shift_jis">';
    expect(sniffMetaCharset(latin1(html))).toBe("shift_jis");
  });

  it("tolerates unquoted values and odd spacing", () => {
    expect(sniffMetaCharset(latin1("<meta charset = utf-8 >"))).toBe("utf-8");
    expect(sniffMetaCharset(latin1("<META CHARSET='EUC-KR'>"))).toBe("EUC-KR");
  });

  //A commented-out declaration is markup the browser never applies. Honouring one would
  //decode the entire document with an encoding the author had explicitly disabled.
  it("ignores a declaration inside a comment", () => {
    expect(sniffMetaCharset(latin1('<!-- <meta charset="shift_jis"> -->'))).toBeNull();
    expect(sniffMetaCharset(latin1('<!-- old --><meta charset="big5">'))).toBe("big5");
  });

  it("ignores an unterminated comment and everything after it", () => {
    expect(sniffMetaCharset(latin1('<!-- <meta charset="big5">'))).toBeNull();
  });

  //The spec requires the declaration inside the first 1024 bytes precisely so a decoder
  //need not buffer the document, and a page ignoring that has already broken browsers.
  it("does not look past the prescan window", () => {
    const padding = " ".repeat(META_PRESCAN_BYTES);
    expect(sniffMetaCharset(latin1(`${padding}<meta charset="big5">`))).toBeNull();
  });

  it("reports nothing when the page declares nothing", () => {
    expect(sniffMetaCharset(latin1("<html><head><title>x</title></head>"))).toBeNull();
  });
});

describe("parseCharsetParam", () => {
  it("pulls the charset out of a Content-Type header", () => {
    expect(parseCharsetParam("text/html; charset=utf-8")).toBe("utf-8");
    expect(parseCharsetParam("text/html;charset=ISO-8859-1")).toBe("iso-8859-1");
    //RFC 9110 permits quoting the parameter value; TextDecoder would reject the quotes.
    expect(parseCharsetParam('text/html; charset="utf-8"')).toBe("utf-8");
  });

  it("returns undefined when there is no charset to find", () => {
    expect(parseCharsetParam("text/html")).toBeUndefined();
    expect(parseCharsetParam(null)).toBeUndefined();
    expect(parseCharsetParam("")).toBeUndefined();
  });
});

describe("decodeBody — precedence", () => {
  //In-band and unambiguous beats a header the server may simply have misconfigured.
  it("lets a BOM override a contradicting header", () => {
    const utf8Bom = bytes(0xef, 0xbb, 0xbf, 0x68, 0x69);
    const decoded = decodeBody(utf8Bom, "windows-1252");

    expect(decoded.source).toBe("bom");
    expect(decoded.charset).toBe("utf-8");
    //The mark itself is consumed, not decoded into the visible "ï»¿" that a windows-1252
    //decoder would have produced from those same three bytes.
    expect(decoded.text).toBe("hi");
  });

  it("uses the header when there is no BOM", () => {
    const decoded = decodeBody(bytes(0xe9, 0x74, 0xe9), "iso-8859-1");

    expect(decoded.source).toBe("header");
    //Reported in TextDecoder's canonical spelling: iso-8859-1 *is* windows-1252 per the
    //Encoding Standard, and saying so is more honest than echoing the label back.
    expect(decoded.charset).toBe("windows-1252");
    expect(decoded.text).toBe("été");
  });

  //The header was chosen by whatever actually served the file; the <meta> may be a
  //leftover from the template the page was built from.
  it("prefers the header over a contradicting meta", () => {
    const html = latin1('<meta charset="windows-1252"><p>hi</p>');
    const decoded = decodeBody(html, "utf-8");

    expect(decoded.source).toBe("header");
    expect(decoded.charset).toBe("utf-8");
  });

  it("falls back to meta when the header is silent", () => {
    const html = new Uint8Array([
      ...latin1('<meta charset="iso-8859-1"><p>'),
      0xe9,
      ...latin1("</p>"),
    ]);
    const decoded = decodeBody(html);

    expect(decoded.source).toBe("meta");
    expect(decoded.charset).toBe("windows-1252");
    expect(decoded.text).toContain("é");
  });

  it("defaults to UTF-8 when nothing declares anything", () => {
    const decoded = decodeBody(new Uint8Array(Buffer.from("héllo", "utf-8")));

    expect(decoded.source).toBe("default");
    expect(decoded.charset).toBe(DEFAULT_CHARSET);
    expect(decoded.text).toBe("héllo");
  });
});

describe("decodeBody — bad input", () => {
  //A page with a typo'd charset is still a page worth indexing, so an unknown label falls
  //through to the next rule instead of failing the whole fetch.
  it("falls through a header label the runtime doesn't know", () => {
    const html = new Uint8Array([
      ...latin1('<meta charset="windows-1252"><p>'),
      0xe9,
      ...latin1("</p>"),
    ]);
    const decoded = decodeBody(html, "utf-9000");

    expect(decoded.source).toBe("meta");
    expect(decoded.text).toContain("é");
  });

  it("falls all the way to the default when every declared label is unusable", () => {
    const decoded = decodeBody(latin1('<meta charset="nonsense">hi'), "also-nonsense");

    expect(decoded.source).toBe("default");
    expect(decoded.charset).toBe(DEFAULT_CHARSET);
  });

  //fatal is deliberately off: three bad bytes in a 40KB body should cost three characters,
  //not the whole document.
  it("substitutes rather than throwing on malformed bytes", () => {
    const decoded = decodeBody(bytes(0x68, 0xe9, 0x69), "utf-8");

    expect(decoded.text).toBe(`h${REPLACEMENT}i`);
  });

  it("handles an empty body", () => {
    const decoded = decodeBody(new Uint8Array(0));

    expect(decoded.text).toBe("");
    expect(decoded.source).toBe("default");
  });
});
