//If every other detection method fails, this is what gets used as a last resort.
export const DEFAULT_CHARSET = "utf-8";

//Defines how many bytes from the start of the response to scan when hunting for a <meta charset> tag
export const META_PRESCAN_BYTES = 1024;

//A union type — TypeScript's way of saying "this value must be exactly one of these four specific strings, nothing else."
export type CharsetSource = "bom" | "header" | "meta" | "default";

//The shape of what this module hands back after decoding:
export interface DecodedBody {
  text: string;
  charset: string;
  source: CharsetSource;
}

//Takes the raw response bytes (Uint8Array — a raw array of byte values, before any text interpretation) 
// plus an optional charset string that may have come from the HTTP Content-Type header.
export function decodeBody(bytes: Uint8Array, headerCharset?: string): DecodedBody {
  //Step 1 — check for a BOM.
  const bom = detectBom(bytes);
  if (bom) {
    return decodeWith(bytes, bom, "bom");
  }

  //Step 2 — try the HTTP header's charset,
  if (headerCharset) {
    const decoded = tryDecodeWith(bytes, headerCharset, "header");
    if (decoded) return decoded;
  }

  //Step 3 — scan the page's own HTML for a <meta charset> declaration.
  const meta = sniffMetaCharset(bytes);
  if (meta) {
    const decoded = tryDecodeWith(bytes, meta, "meta");
    if (decoded) return decoded;
  }

  //Step 4 — give up and use UTF-8.
  return decodeWith(bytes, DEFAULT_CHARSET, "default");
}

//Checks whether the response's raw bytes begin with a byte-order mark, and if so, tells you which encoding that BOM implies.
export function detectBom(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return "utf-8";
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  return null;
}

//Scans the first 1024 bytes of the page's HTML looking for a <meta charset="..."> (or the older http-equiv variant) declaration,
//  and returns whatever charset name it finds written there. This is what lets decodeBody respect what the page's own author declared, 
// when there's no BOM and no usable header.
export function sniffMetaCharset(bytes: Uint8Array): string | null {
  const prefix = Buffer.from(
    bytes.subarray(0, META_PRESCAN_BYTES),
  ).toString("latin1");

  const withoutComments = prefix.replace(/<!--[\s\S]*?-->/g, " ").split("<!--")[0];

  const match = /<meta\b[^>]*?\bcharset\s*=\s*["']?\s*([a-z0-9_\-:.+]+)/i.exec(
    withoutComments,
  );

  return match ? match[1] : null;
}

//Extracts the charset= value out of an HTTP Content-Type header string. This exists because the fetcher's own content-type parser throws that detail away, 
// so this function is what recovers it separately when decodeBody wants to try the header-declared charset.
export function parseCharsetParam(header: string | null): string | undefined {
  if (!header) return undefined;

  const match = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(header);
  return match ? match[1].trim().toLowerCase() || undefined : undefined;
}

//A safety gate used inside decodeBody's fallback chain — it checks whether a candidate charset label is actually usable before attempting to decode with it, 
// so an invalid or unrecognized label (like a typo in a page's <meta> tag) doesn't blow up the whole process; it just quietly signals "skip me" so the chain can move to the next option.
function tryDecodeWith(
  bytes: Uint8Array,
  label: string,
  source: CharsetSource,
): DecodedBody | null {
  return supportsCharset(label) ? decodeWith(bytes, label, source) : null;
}

//Does the actual decoding work — takes the raw bytes and a chosen charset label, and produces the final decoded text plus the standardized name of the encoding it really used.
function decodeWith(bytes: Uint8Array, label: string, source: CharsetSource): DecodedBody {
  const decoder = new TextDecoder(label);
  return { text: decoder.decode(bytes), charset: decoder.encoding, source };
}

//Answers a single yes/no question for tryDecodeWith: "does this JavaScript runtime actually recognize this charset label at all?"
function supportsCharset(label: string): boolean {
  try {
    new TextDecoder(label);
    return true;
  } catch {
    return false;
  }
}
