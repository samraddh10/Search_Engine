import * as cheerio from "cheerio";
//import type { CheerioAPI } — the type keyword here means this import is only used for TypeScript type-checking, and gets completely erased at compile time
import type { CheerioAPI } from "cheerio";
import { USER_AGENT_TOKEN } from "./fetcher.js";
import { normalizeUrl, parseHttpUrl } from "./url.js";

export const PARSE_DEFAULTS = {
  maxLinks: 1_000,
  maxTextChars: 200_000,
  maxTitleChars: 300,
  maxDescriptionChars: 500,
} as const;

//All four fields have ?, meaning none are required — if omitted,
export interface ParseOptions {
  maxLinks?: number;
  maxTextChars?: number;
  maxTitleChars?: number;
  maxDescriptionChars?: number;
}

//The full output shape this whole file produces.
export interface ParsedPage {
  url: string;
  canonicalUrl: string | null;
  title: string;
  text: string;
  lang: string | null;
  description: string | null;
  links: readonly string[];
  noindex: boolean;
  nofollow: boolean;
}

const NEVER_CONTENT =
  "script, style, noscript, template, iframe, object, embed, svg, canvas, " +
  "form, button, input, select, textarea, " +
  "nav, aside, [aria-hidden='true'], [hidden], " +
  "[role='navigation'], [role='banner'], [role='contentinfo'], [role='search']";

const BOILERPLATE_WHEN_UNSCOPED = "header, footer";

const BLOCK_TAGS: ReadonlySet<string> = new Set([
  "address", "article", "aside", "blockquote", "body", "caption", "center", "dd",
  "details", "dialog", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer",
  "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "li", "main",
  "menu", "nav", "ol", "p", "pre", "section", "summary", "table", "tbody", "td",
  "tfoot", "th", "thead", "tr", "ul",
]);

interface DomNode {
  type: string;
  name?: string;
  data?: string;
  children?: DomNode[];
}

//parseHtml — the main entry point
//Takes the raw HTML string, the page's final URL, and an optional options object (defaulting to an empty object {} if not provided at all).
export function parseHtml(
  html: string,
  pageUrl: string,
  options: ParseOptions = {},
): ParsedPage | null {

  //Destructuring with defaults
  const {
    maxLinks = PARSE_DEFAULTS.maxLinks,
    maxTextChars = PARSE_DEFAULTS.maxTextChars,
    maxTitleChars = PARSE_DEFAULTS.maxTitleChars,
    maxDescriptionChars = PARSE_DEFAULTS.maxDescriptionChars,
  } = options;

  const pageUrlNormalized = normalizeUrl(pageUrl);
  if (!pageUrlNormalized) return null;

  //Parses the raw HTML string into a queryable tree structure. The result, conventionally named $ (matching jQuery's naming convention, 
  // since Cheerio deliberately mimics jQuery's API), is what lets you write things like $("title") to find elements.
  const $ = cheerio.load(html);

  //$("base[href]") — a CSS attribute selector: find any <base> tag that has an href attribute.
  //.first() — in case there are multiple (malformed HTML), only take the first one
  //.attr("href") — reads that attribute's value; returns undefined if no such element exists.
  const baseHref = $("base[href]").first().attr("href");
  const base =
    (baseHref ? parseHttpUrl(baseHref, pageUrlNormalized) : null)?.href
    //?? pageUrlNormalized — the nullish coalescing operator: if the left side ended up null or undefined
    //fall back to using the page's own URL as the base for resolving all relative links.
    ?? pageUrlNormalized;

  const directives = robotsDirectives($);

  //If the page-wide nofollow directive is set, skip extracting links entirely (return an empty array) — otherwise call extractLinks
  const links = directives.nofollow
    ? []
    : extractLinks($, base, pageUrlNormalized, maxLinks);

  const title = cleanInline(
    //Tries to get the page's <title> text first; || means if that's an empty string (falsy in JS), fall back to the first <h1>'s text instead.
    //Passed through cleanInline (explained below) to normalize whitespace and enforce the length cap.
    $("title").first().text() || $("h1").first().text(),
    maxTitleChars,
  );
  const description = extractDescription($, maxDescriptionChars);
  const lang = extractLang($);

  const text = extractText($, maxTextChars);

  //Assembles and returns the final ParsedPage object.
  return {
    url: pageUrlNormalized,
    canonicalUrl: extractCanonical($, base),
    title,
    text,
    lang,
    description,
    links,
    noindex: directives.noindex,
    nofollow: directives.nofollow,
  };
}

function extractText($: CheerioAPI, maxTextChars: number): string {
  //$("main, [role='main']") — finds every element that's either a <main> tag or has role="main"
  //  (a way some non-semantic markup signals the same meaning).
  const main = $("main, [role='main']");
  const article = main.length === 1 ? null : $("article");

  const scope = main.length === 1 ? main : article?.length === 1 ? article : null;
  //root = scope ?? $("body") — if scope is null (no clear content area found), fall back to the whole <body>.
  const root = scope ?? $("body");

  root.find(NEVER_CONTENT).remove();
  if (!scope) root.find(BOILERPLATE_WHEN_UNSCOPED).remove();

  //root[0] — Cheerio collections support array-style indexing to get the raw underlying DOM node.
  //as unknown as DomNode — a TypeScript type assertion, forcing the compiler to treat this value as your hand-written DomNode type.
  const node = root[0] as unknown as DomNode | undefined;
  if (!node) return "";

  //out is an accumulator array that collectText will fill in (passed by reference — a common pattern for building up results during
  //  recursion without repeatedly creating and merging new arrays)
  const out: string[] = [];
  collectText(node, out);

//out.join("") glues all the accumulated text/separator pieces into one string, which then gets cleaned and truncated.
  return truncateAtBoundary(cleanBlock(out.join("")), maxTextChars);
}

//Base case: if this node is a plain text node, push its text content onto the accumulator and stop recursing (a text node has no children). 
// ?? "" guards against data being undefined.
function collectText(node: DomNode, out: string[]): void {
  if (node.type === "text") {
    out.push(node.data ?? "");
    return;
  }

  //Skip anything that's not a real element
  if (node.type !== "tag") return;

  if (node.name === "br") {
    out.push("\n");
    return;
  }

  const isBlock = node.name !== undefined && BLOCK_TAGS.has(node.name);
  if (isBlock) out.push("\n");
  for (const child of node.children ?? []) collectText(child, out);
  if (isBlock) out.push("\n");
}

function extractLinks(
  $: CheerioAPI,
  base: string,
  selfUrl: string,
  maxLinks: number,
): string[] {
  //seen is pre-populated with the page's own URL
  //links will collect the final output array.
  const seen = new Set<string>([selfUrl]);
  const links: string[] = [];

  for (const element of $("a[href]").toArray()) {
    if (links.length >= maxLinks) break;

    const rel = ($(element).attr("rel") ?? "").toLowerCase();
    if (/(^|\s)nofollow(\s|$)/.test(rel)) continue;

    const href = $(element).attr("href");
    if (!href) continue;

    //Runs the raw href through normalizeUrl (relative to base). If it comes back null (invalid, wrong scheme like javascript:, etc.) 
    // or has already been seen (duplicate link on the same page), skip it. 
    // Otherwise, record it as seen and add it to the results.
    const normalized = normalizeUrl(href, base);
    if (!normalized || seen.has(normalized)) continue;

    seen.add(normalized);
    links.push(normalized);
  }

  return links;
}

//Finds a <link> tag whose rel attribute list includes the token canonical (the ~= selector, as explained in the comments), 
// takes the first match's href, and if present, normalizes it. Returns null if no such tag exists, or implicitly if normalizeUrl itself returns null.
function extractCanonical($: CheerioAPI, base: string): string | null {
  const href = $('link[rel~="canonical"]').first().attr("href");
  return href ? normalizeUrl(href, base) : null;
}

//Sets up two accumulator strings — one for generic "robots" directives, one for directives specifically addressed to this crawler's own bot name.
//robotsDirectives — Reads the page's <meta name="robots"> tags (both the generic version and any version specifically addressed to this crawler)
//  and translates them into simple noindex/nofollow boolean flags for the rest of the code to use.
function robotsDirectives($: CheerioAPI): { noindex: boolean; nofollow: boolean } {
  const token = USER_AGENT_TOKEN.toLowerCase();
  let generic = "";
  let specific = "";

  for (const element of $("meta[name][content]").toArray()) {
    const name = ($(element).attr("name") ?? "").trim().toLowerCase();
    const content = `,${($(element).attr("content") ?? "").toLowerCase()}`;

    if (name === "robots") generic += content;
    else if (name === token) specific += content;
  }

  //specific || generic — if the crawler-specific directive string is non-empty, use it (it wins); otherwise fall back to the generic one.
  const directives = specific || generic;
  //three regex checks, each looking for a standalone directive word sandwiched between commas or string edges
  //"none" is checked first because — per the comment — it's shorthand in the actual robots meta spec for 
  // "noindex AND nofollow together," so both returned booleans OR in that check.
  const none = /(^|,)\s*none\s*(,|$)/.test(directives);

  return {
    noindex: none || /(^|,)\s*noindex\s*(,|$)/.test(directives),
    nofollow: none || /(^|,)\s*nofollow\s*(,|$)/.test(directives),
  };
}

//Tries the standard <meta name="description"> first; ?? falls back to the Open Graph variant (og:description, a widely-used convention for how social platforms preview links)
//  if the first is missing. Cleans whatever was found (or uses empty string if neither existed), then cleaned || null converts an empty result into an explicit null rather than returning an empty string.
function extractDescription($: CheerioAPI, maxChars: number): string | null {
  const meta =
    $('meta[name="description"]').first().attr("content")
    ?? $('meta[property="og:description"]').first().attr("content");

  const cleaned = meta ? cleanInline(meta, maxChars) : "";
  return cleaned || null;
}

function extractLang($: CheerioAPI): string | null {
  const raw = $("html").attr("lang")?.trim().toLowerCase();
  if (!raw) return null;

  return /^[a-z]{1,8}(-[a-z0-9]{1,8})*$/.test(raw) ? raw : null;
}

//Three chained .replace() calls (chaining works because each .replace() returns a new string, which the next .replace() is immediately called on):
function normalizeWhitespace(text: string): string {
  return text
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, " ")
    .replace(/[\u00AD\u200B-\u200D\uFEFF]/g, "")
    .replace(/\r\n?/g, "\n");
}

function cleanInline(text: string, maxChars: number): string {
  const cleaned = normalizeWhitespace(text).replace(/\s+/g, " ").trim();
  return cleaned.length > maxChars ? cleaned.slice(0, maxChars).trimEnd() : cleaned;
}

function cleanBlock(text: string): string {
  return normalizeWhitespace(text)
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n[ \n]*/g, "\n")
    .trim();
}

function truncateAtBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const slice = text.slice(0, maxChars);
  const boundary = Math.max(slice.lastIndexOf(" "), slice.lastIndexOf("\n"));

  return (boundary > maxChars * 0.9 ? slice.slice(0, boundary) : slice).trimEnd();
}
