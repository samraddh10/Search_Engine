// url parsing and cananonicalization
export const MAX_URL_LENGTH = 2048;

const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  "gclid", "dclid", "gbraid", "wbraid",
  "fbclid", "msclkid", "yclid", "twclid", "ttclid", "igshid",
  "mc_cid", "mc_eid",
  "_hsenc", "_hsmi", "hsctatracking",
  "vero_id", "vero_conv", "oly_anon_id", "oly_enc_id",
  "s_kwcid", "ef_id", "_openstat",
]);

const TRACKING_PREFIXES = ["utm_", "pk_", "piwik_", "matomo_", "mtm_"];

export function isTrackingParam(name: string): boolean {
  const key = name.toLowerCase();
  if (TRACKING_PARAMS.has(key)) return true;
  return TRACKING_PREFIXES.some((prefix) => key.startsWith(prefix));
}

//base?: string | URL — the ? means this parameter is optional. It can be either a plain string or an already-parsed URL object.
//parseHttpUrl has one job: take some raw string, and tell you whether it's a usable, safe, absolute web URL — returning either a parsed URL object, or null if it isn't.
export function parseHttpUrl(value: string, base?: string | URL): URL | null {
  if (value.length > MAX_URL_LENGTH) return null;

  let url: URL;
  try {
  //new URL(value, base) — JavaScript's built-in URL parser. If value is relative (like /about), it resolves it against base. If base is undefined (not provided), 
  // it behaves as if you called new URL(value) with no second argument at all
    url = new URL(value, base);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  return url;
}

//Where parseHttpUrl only asks "is this a valid, safe URL?", normalizeUrl asks "what is the ONE canonical string that represents the page this URL points to?"
//That canonical string is what gets used as the dedup key — the thing the frontier checks in Redis to decide "have I already crawled this page?"
//So this function's whole purpose is: take any of the many different-looking URLs that could point at the same page, and always produce the exact same output string for all of them.
export function normalizeUrl(value: string, base?: string | URL): string | null {
  const url = parseHttpUrl(value, base);
  if (!url) return null;

  //Wipes the #fragment part of the URL. Fragments (#section-2) are never actually sent in the HTTP request to the server
  url.hash = "";

  //URLs can technically embed credentials like http://alice:hunter2@example.com. These get wiped because (a) they say nothing about what the page content is, and (b) 
  // leaving them in would mean writing someone's literal password into your documents.url column and into every log line that ever prints that URL — a real, if unlikely, security leak.
  url.username = "";
  url.password = "";

  //Treats http://example.com (no path at all) the same as http://example.com/ (path is just /) — they're the same page.
  if (url.pathname === "") url.pathname = "/";

  const params = [...url.searchParams].filter(
    ([name]) => name !== "" && !isTrackingParam(name),
  );

  params.sort((a, b) => (a[0] === b[0] ? compare(a[1], b[1]) : compare(a[0], b[0])));

  //Clears the entire query string, then rebuilds it fresh from the filtered, sorted array.
  //this also cleans up a bare trailing ? with nothing after it (/page? → /page), since if there are zero params to append, url.search just stays empty.
  url.search = "";
  for (const [name, paramValue] of params) url.searchParams.append(name, paramValue);

  return url.href.length > MAX_URL_LENGTH ? null : url.href;
}

function compare(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
