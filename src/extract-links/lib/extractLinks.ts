/**
 * Extract URL-like links from HTML or Markdown source.
 *
 * The extractor is intentionally dependency-free and works in Node.js and
 * modern browsers. It recognizes structured HTML/Markdown links as well as
 * CSS URLs, srcset entries, meta refresh URLs, autolinks, bare absolute URLs,
 * and URL-like quoted strings commonly found in JSON or JavaScript snippets.
 *
 * Relative references require a base URL. The base is selected in this order:
 *   1. init.baseURL
 *   2. an HTML <base href="..."> element
 *   3. document.baseURI / location.href in a browser
 *
 * @typedef {Object} ExtractLinksInit
 * @property {'html'|'md'} [mode='html']
 * @property {string[]} [excludeDomains=[]]
 *   Hostnames to ignore. `example.com` also excludes its subdomains.
 *   `*.example.com` excludes subdomains but not the apex domain.
 * @property {string|URL} [baseURL]
 *   Required in Node.js when the source contains relative links and does not
 *   provide an absolute HTML <base href>.
 *
 * @typedef {Object} ExtractedLink
 * @property {'a'|'img'|string|null} tag
 * @property {'href'|'src'|string|null} attribute
 * @property {string|null} anchorText
 * @property {string} literalMatch
 * @property {Record<string, unknown>} [urlParams]
 * @property {string} fullUrl
 * @property {string} cleanUrl
 * @property {number} literalCount
 * @property {number} fullCount
 * @property {number} cleanCount
 */

const URL_ATTRIBUTES = new Set([
  'action',
  'background',
  'cite',
  'classid',
  'codebase',
  'data',
  'formaction',
  'href',
  'icon',
  'imagesrc',
  'itemid',
  'longdesc',
  'manifest',
  'poster',
  'profile',
  'src',
  'usemap',
  'xlink:href',
  'xml:base',
]);

const URL_LIST_ATTRIBUTES = new Set(['archive', 'ping']);
const SRCSET_ATTRIBUTES = new Set(['imagesrcset', 'srcset']);
const BLOCKED_SCHEMES = new Set(['data:', 'javascript:', 'vbscript:']);

/**
 * @param {string} source
 * @param {ExtractLinksInit} [init]
 * @returns {ExtractedLink[]}
 */
export function extractLinks(source: string, init = {}) {
  if (typeof source !== 'string') {
    throw new TypeError(`extractLinks: source must be a string; received ${typeof source}`);
  }

  const mode = init.mode ?? 'html';
  if (mode !== 'html' && mode !== 'md') {
    throw new TypeError(`extractLinks: init.mode must be "html" or "md"; received ${JSON.stringify(mode)}`);
  }

  if (init.excludeDomains != null && !Array.isArray(init.excludeDomains)) {
    throw new TypeError('extractLinks: init.excludeDomains must be an array of domain names');
  }

  /** @type {Candidate[]} */
  const candidates = [];
  /** @type {Map<string, number>} */
  const occurrenceIndex = new Map();

  const addCandidate = (candidate) => {
    const literal = candidate.literalMatch;
    if (typeof literal !== 'string' || literal.length === 0) return;

    const start = Number.isFinite(candidate.start) ? candidate.start : Number.MAX_SAFE_INTEGER;
    const end = Number.isFinite(candidate.end) ? candidate.end : start + literal.length;
    const key = `${start}:${end}:${literal}`;
    const existingIndex = occurrenceIndex.get(key);

    if (existingIndex == null) {
      occurrenceIndex.set(key, candidates.length);
      candidates.push({
        tag: null,
        attribute: null,
        anchorText: null,
        value: literal,
        literalMatch: literal,
        start,
        end,
        priority: 0,
        literalOccurrence: true,
        ...candidate,
      });
      return;
    }

    const existing = candidates[existingIndex];
    if ((candidate.priority ?? 0) > (existing.priority ?? 0)) {
      candidates[existingIndex] = {
        ...existing,
        ...candidate,
        start,
        end,
        literalMatch: literal,
      };
      return;
    }

    // Keep the higher-priority source, but fill missing metadata when possible.
    if (existing.tag == null && candidate.tag != null) existing.tag = candidate.tag;
    if (existing.attribute == null && candidate.attribute != null) existing.attribute = candidate.attribute;
    if (existing.anchorText == null && candidate.anchorText != null) existing.anchorText = candidate.anchorText;
  };

  const htmlInfo = collectHtmlLinks(source, addCandidate);

  if (mode === 'md') {
    collectMarkdownLinks(source, addCandidate);
  }

  collectCssLinks(source, addCandidate);
  collectBareUrls(source, addCandidate);
  collectQuotedUrlLikeStrings(source, addCandidate, htmlInfo.tagRanges);

  const baseURL = chooseBaseURL(init.baseURL, htmlInfo.baseHref);
  const exclusions = compileDomainExclusions(init.excludeDomains ?? []);

  candidates.sort((a, b) => a.start - b.start || b.priority - a.priority || a.end - b.end);

  /** @type {Map<string, number>} */
  const literalCounts = new Map();
  for (const candidate of candidates) {
    if (!candidate.literalOccurrence) continue;
    literalCounts.set(
      candidate.literalMatch,
      (literalCounts.get(candidate.literalMatch) ?? 0) + 1,
    );
  }

  /** @type {Array<{candidate:Candidate,url:URL,fullUrl:string,cleanUrl:string}>} */
  const occurrences = [];

  for (const candidate of candidates) {
    const resolved = resolveReference(candidate.value, baseURL);
    if (resolved.kind === 'skip') continue;

    if (resolved.kind === 'relative-without-base') {
      throw new TypeError(
        `extractLinks: cannot resolve relative link ${JSON.stringify(candidate.literalMatch)} ` +
        'without an absolute base URL. Pass init.baseURL or include an absolute <base href> element.',
      );
    }

    if (isExcludedHostname(resolved.url.hostname, exclusions)) continue;

    const fullUrl = resolved.url.href;
    const clean = new URL(fullUrl);
    clean.search = '';

    occurrences.push({
      candidate,
      url: resolved.url,
      fullUrl,
      cleanUrl: clean.href,
    });
  }

  /** @type {Map<string, number>} */
  const fullCounts = new Map();
  /** @type {Map<string, number>} */
  const cleanCounts = new Map();

  for (const occurrence of occurrences) {
    fullCounts.set(occurrence.fullUrl, (fullCounts.get(occurrence.fullUrl) ?? 0) + 1);
    cleanCounts.set(occurrence.cleanUrl, (cleanCounts.get(occurrence.cleanUrl) ?? 0) + 1);
  }

  /** @type {Map<string, ExtractedLink>} */
  const byFullUrl = new Map();

  for (const occurrence of occurrences) {
    if (byFullUrl.has(occurrence.fullUrl)) continue;

    const { candidate, url, fullUrl, cleanUrl } = occurrence;
    const urlParams = searchParamsToRecord(url.searchParams);

    byFullUrl.set(fullUrl, {
      tag: candidate.tag,
      attribute: candidate.attribute,
      anchorText: candidate.anchorText,
      literalMatch: candidate.literalMatch,
      ...(urlParams == null ? {} : { urlParams }),
      fullUrl,
      cleanUrl,
      literalCount: literalCounts.get(candidate.literalMatch) ?? 0,
      fullCount: fullCounts.get(fullUrl) ?? 0,
      cleanCount: cleanCounts.get(cleanUrl) ?? 0,
    });
  }

  return [...byFullUrl.values()];
}

export default extractLinks;

/**
 * @typedef {Object} Candidate
 * @property {string|null} tag
 * @property {string|null} attribute
 * @property {string|null} anchorText
 * @property {string} literalMatch
 * @property {string} value
 * @property {number} start
 * @property {number} end
 * @property {number} priority
 * @property {boolean} literalOccurrence
 */

/**
 * @param {string} source
 * @param {(candidate: Candidate) => void} add
 */
function collectHtmlLinks(source: string, add) {
  let baseHref = null;
  const lowerSource = source.toLowerCase();
  /** @type {Array<[number, number]>} */
  const tagRanges = [];

  for (const tagToken of scanHtmlTags(source)) {
    tagRanges.push([tagToken.start, tagToken.end]);
    if (tagToken.closing) continue;

    const tag = tagToken.name;
    const attrs = parseHtmlAttributes(tagToken.raw, tagToken.start);
    const attrByName = new Map(attrs.map((attr) => [attr.name, attr]));

    if (tag === 'base' && baseHref == null) {
      const href = attrByName.get('href');
      if (href?.value) baseHref = decodeHtmlEntities(href.value.trim());
    }

    let anchorText = null;
    if (tag === 'a') {
      const closeStart = lowerSource.indexOf('</a', tagToken.end);
      if (closeStart !== -1) {
        anchorText = htmlToPlainText(source.slice(tagToken.end, closeStart));
      }
    }

    for (const attr of attrs) {
      const attribute = attr.name;
      const rawValue = attr.value;
      if (rawValue == null) continue;

      if (URL_ATTRIBUTES.has(attribute)) {
        add({
          tag,
          attribute,
          anchorText: tag === 'a' ? anchorText : null,
          literalMatch: rawValue,
          value: decodeHtmlEntities(rawValue),
          start: attr.valueStart,
          end: attr.valueEnd,
          priority: 100,
          literalOccurrence: true,
        });
        continue;
      }

      if (URL_LIST_ATTRIBUTES.has(attribute)) {
        for (const token of splitWhitespaceTokens(rawValue, attr.valueStart)) {
          add({
            tag,
            attribute,
            anchorText: tag === 'a' ? anchorText : null,
            literalMatch: token.value,
            value: decodeHtmlEntities(token.value),
            start: token.start,
            end: token.end,
            priority: 100,
            literalOccurrence: true,
          });
        }
        continue;
      }

      if (SRCSET_ATTRIBUTES.has(attribute)) {
        for (const token of parseSrcset(rawValue, attr.valueStart)) {
          add({
            tag,
            attribute,
            anchorText: null,
            literalMatch: token.value,
            value: decodeHtmlEntities(token.value),
            start: token.start,
            end: token.end,
            priority: 100,
            literalOccurrence: true,
          });
        }
        continue;
      }

      if (tag === 'meta' && attribute === 'content') {
        const httpEquiv = attrByName.get('http-equiv')?.value?.trim().toLowerCase();
        if (httpEquiv === 'refresh') {
          const refresh = parseMetaRefresh(rawValue, attr.valueStart);
          if (refresh) {
            add({
              tag,
              attribute,
              anchorText: null,
              literalMatch: refresh.value,
              value: decodeHtmlEntities(refresh.value),
              start: refresh.start,
              end: refresh.end,
              priority: 100,
              literalOccurrence: true,
            });
          }
          continue;
        }

        const metaKey = (
          attrByName.get('property')?.value ??
          attrByName.get('name')?.value ??
          attrByName.get('itemprop')?.value ??
          ''
        ).trim().toLowerCase();

        const decodedValue = decodeHtmlEntities(rawValue.trim());
        if (isUrlMetaKey(metaKey) && looksLikeUrlReference(decodedValue)) {
          const leadingWhitespace = rawValue.length - rawValue.trimStart().length;
          const literal = rawValue.trim();
          add({
            tag,
            attribute,
            anchorText: null,
            literalMatch: literal,
            value: decodedValue,
            start: attr.valueStart + leadingWhitespace,
            end: attr.valueStart + leadingWhitespace + literal.length,
            priority: 100,
            literalOccurrence: true,
          });
        }
      }
    }
  }

  return { baseHref, tagRanges };
}

/**
 * @param {string} source
 */
function* scanHtmlTags(source) {
  let cursor = 0;

  while (cursor < source.length) {
    const start = source.indexOf('<', cursor);
    if (start === -1) return;

    if (source.startsWith('<!--', start)) {
      const commentEnd = source.indexOf('-->', start + 4);
      cursor = commentEnd === -1 ? source.length : commentEnd + 3;
      continue;
    }

    const next = source[start + 1];
    if (!next || (!/[A-Za-z/!?]/.test(next))) {
      cursor = start + 1;
      continue;
    }

    let quote = null;
    let escaped = false;
    let end = start + 1;

    for (; end < source.length; end += 1) {
      const char = source[end];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (quote && char === '\\') {
        escaped = true;
        continue;
      }

      if (quote) {
        if (char === quote) quote = null;
        continue;
      }

      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }

      if (char === '>') break;
    }

    if (end >= source.length) return;

    const raw = source.slice(start, end + 1);
    const match = raw.match(/^<\s*(\/?)\s*([A-Za-z][\w:-]*)/);
    cursor = end + 1;
    if (!match) continue;

    yield {
      raw,
      start,
      end: end + 1,
      closing: match[1] === '/',
      name: match[2].toLowerCase(),
    };
  }
}

/**
 * @param {string} rawTag
 * @param {number} absoluteStart
 */
function parseHtmlAttributes(rawTag, absoluteStart) {
  /** @type {Array<{name:string,value:string|null,valueStart:number,valueEnd:number}>} */
  const attrs = [];
  let i = 1;

  while (i < rawTag.length && /\s/.test(rawTag[i])) i += 1;
  if (rawTag[i] === '/') i += 1;
  while (i < rawTag.length && /\s/.test(rawTag[i])) i += 1;
  while (i < rawTag.length && /[^\s/>]/.test(rawTag[i])) i += 1;

  while (i < rawTag.length) {
    while (i < rawTag.length && /\s/.test(rawTag[i])) i += 1;
    if (rawTag[i] === '>' || (rawTag[i] === '/' && rawTag[i + 1] === '>')) break;

    const nameStart = i;
    while (i < rawTag.length && /[^\s=/>]/.test(rawTag[i])) i += 1;
    if (i === nameStart) {
      i += 1;
      continue;
    }

    const name = rawTag.slice(nameStart, i).toLowerCase();
    while (i < rawTag.length && /\s/.test(rawTag[i])) i += 1;

    if (rawTag[i] !== '=') {
      attrs.push({
        name,
        value: null,
        valueStart: absoluteStart + i,
        valueEnd: absoluteStart + i,
      });
      continue;
    }

    i += 1;
    while (i < rawTag.length && /\s/.test(rawTag[i])) i += 1;

    const quote = rawTag[i] === '"' || rawTag[i] === "'" ? rawTag[i] : null;
    if (quote) i += 1;

    const valueStartLocal = i;
    if (quote) {
      while (i < rawTag.length && rawTag[i] !== quote) i += 1;
    } else {
      while (i < rawTag.length && /[^\s>]/.test(rawTag[i])) i += 1;
    }

    const valueEndLocal = i;
    attrs.push({
      name,
      value: rawTag.slice(valueStartLocal, valueEndLocal),
      valueStart: absoluteStart + valueStartLocal,
      valueEnd: absoluteStart + valueEndLocal,
    });

    if (quote && rawTag[i] === quote) i += 1;
  }

  return attrs;
}

/**
 * @param {string} source
 * @param {(candidate: Candidate) => void} add
 */
function collectMarkdownLinks(source, add) {
  const definitions = collectMarkdownDefinitions(source, add);

  for (let i = 0; i < source.length; i += 1) {
    if (isInsideRanges(i, definitions.ranges)) continue;

    const isImage = source[i] === '!' && source[i + 1] === '[';
    const isLink = source[i] === '[';
    if (!isImage && !isLink) continue;
    if (isEscaped(source, i)) continue;

    const labelStart = i + (isImage ? 2 : 1);
    const labelEnd = findUnescaped(source, ']', labelStart);
    if (labelEnd === -1) continue;

    const rawLabel = source.slice(labelStart, labelEnd);
    const tag = isImage ? 'img' : 'a';
    const attribute = isImage ? 'src' : 'href';
    const anchorText = markdownToPlainText(rawLabel);
    let cursor = labelEnd + 1;

    if (source[cursor] === '(') {
      const destination = parseMarkdownInlineDestination(source, cursor);
      if (destination) {
        add({
          tag,
          attribute,
          anchorText,
          literalMatch: destination.literal,
          value: decodeMarkdownDestination(destination.literal),
          start: destination.start,
          end: destination.end,
          priority: 95,
          literalOccurrence: true,
        });
        i = destination.closeIndex;
      }
      continue;
    }

    let referenceId = null;
    let referenceEnd = labelEnd;
    if (source[cursor] === '[') {
      const idEnd = findUnescaped(source, ']', cursor + 1);
      if (idEnd !== -1) {
        const explicit = source.slice(cursor + 1, idEnd);
        referenceId = explicit.length > 0 ? explicit : rawLabel;
        referenceEnd = idEnd;
      }
    } else {
      referenceId = rawLabel;
    }

    if (referenceId != null) {
      const definition = definitions.byId.get(normalizeReferenceId(referenceId));
      if (definition) {
        add({
          tag,
          attribute,
          anchorText,
          literalMatch: definition.literal,
          value: definition.value,
          start: i,
          end: referenceEnd + 1,
          priority: 94,
          literalOccurrence: false,
        });
        i = referenceEnd;
      }
    }
  }

  // Markdown autolinks: <https://example.com> and <//example.com/path>.
  const autolinkRe = /<((?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|\/\/|www\.)[^<>\s]+)>/g;
  for (const match of source.matchAll(autolinkRe)) {
    const start = match.index + 1;
    add({
      tag: 'a',
      attribute: 'href',
      anchorText: match[1],
      literalMatch: match[1],
      value: decodeMarkdownDestination(match[1]),
      start,
      end: start + match[1].length,
      priority: 93,
      literalOccurrence: true,
    });
  }
}

/**
 * @param {string} source
 * @param {(candidate: Candidate) => void} add
 */
function collectMarkdownDefinitions(source, add) {
  const byId = new Map();
  const ranges = [];
  const re = /^( {0,3})\[([^\]\n]+)\]:[ \t]*(?:<([^>\n]+)>|([^\s\n]+))(?:[ \t]+(?:(?:"[^"]*")|(?:'[^']*')|(?:\([^)]*\))))?[ \t]*$/gm;

  for (const match of source.matchAll(re)) {
    const literal = match[3] ?? match[4];
    const whole = match[0];
    const destinationOffset = whole.indexOf(literal);
    const start = match.index + destinationOffset;
    const value = decodeMarkdownDestination(literal);

    byId.set(normalizeReferenceId(match[2]), { literal, value });
    ranges.push([match.index, match.index + whole.length]);

    add({
      tag: 'a',
      attribute: 'href',
      anchorText: null,
      literalMatch: literal,
      value,
      start,
      end: start + literal.length,
      priority: 92,
      literalOccurrence: true,
    });
  }

  return { byId, ranges };
}

/**
 * @param {string} source
 * @param {number} openParenIndex
 */
function parseMarkdownInlineDestination(source, openParenIndex) {
  let i = openParenIndex + 1;
  while (i < source.length && /[ \t\n]/.test(source[i])) i += 1;
  if (i >= source.length) return null;

  if (source[i] === '<') {
    const start = i + 1;
    const end = findUnescaped(source, '>', start);
    if (end === -1) return null;

    let cursor = end + 1;
    while (cursor < source.length && /[ \t\n]/.test(source[cursor])) cursor += 1;
    cursor = skipMarkdownOptionalTitle(source, cursor);
    while (cursor < source.length && /[ \t\n]/.test(source[cursor])) cursor += 1;
    if (source[cursor] !== ')') return null;

    return {
      literal: source.slice(start, end),
      start,
      end,
      closeIndex: cursor,
    };
  }

  const start = i;
  let nested = 0;
  let escaped = false;

  for (; i < source.length; i += 1) {
    const char = source[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '(') {
      nested += 1;
      continue;
    }
    if (char === ')') {
      if (nested === 0) {
        return {
          literal: source.slice(start, i),
          start,
          end: i,
          closeIndex: i,
        };
      }
      nested -= 1;
      continue;
    }
    if (/\s/.test(char) && nested === 0) {
      const end = i;
      while (i < source.length && /[ \t\n]/.test(source[i])) i += 1;
      i = skipMarkdownOptionalTitle(source, i);
      while (i < source.length && /[ \t\n]/.test(source[i])) i += 1;
      if (source[i] !== ')') return null;
      return {
        literal: source.slice(start, end),
        start,
        end,
        closeIndex: i,
      };
    }
  }

  return null;
}

/**
 * @param {string} source
 * @param {number} index
 */
function skipMarkdownOptionalTitle(source, index) {
  const opener = source[index];
  const closer = opener === '(' ? ')' : opener;
  if (opener !== '"' && opener !== "'" && opener !== '(') return index;

  let escaped = false;
  for (let i = index + 1; i < source.length; i += 1) {
    const char = source[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === closer) return i + 1;
  }
  return index;
}

/**
 * @param {string} source
 * @param {(candidate: Candidate) => void} add
 */
function collectCssLinks(source, add) {
  const urlRe = /url\(\s*(?:(['"])([\s\S]*?)\1|([^)]*?))\s*\)/gi;
  for (const match of source.matchAll(urlRe)) {
    const literal = (match[2] ?? match[3] ?? '').trim();
    if (!literal) continue;
    const localOffset = match[0].indexOf(literal);
    const start = match.index + localOffset;
    add({
      tag: 'style',
      attribute: 'url',
      anchorText: null,
      literalMatch: literal,
      value: decodeCssUrl(literal),
      start,
      end: start + literal.length,
      priority: 85,
      literalOccurrence: true,
    });
  }

  const importRe = /@import\s+(['"])(.*?)\1/gi;
  for (const match of source.matchAll(importRe)) {
    const literal = match[2].trim();
    if (!literal) continue;
    const localOffset = match[0].indexOf(match[2]);
    const start = match.index + localOffset;
    add({
      tag: 'style',
      attribute: '@import',
      anchorText: null,
      literalMatch: literal,
      value: decodeCssUrl(literal),
      start,
      end: start + literal.length,
      priority: 84,
      literalOccurrence: true,
    });
  }
}

/**
 * @param {string} source
 * @param {(candidate: Candidate) => void} add
 */
function collectBareUrls(source, add) {
  const patterns = [
    /\b(?:https?|ftps?|wss?|file):\/\/[^\s<>"'`]+/gi,
    /\b(?:mailto|tel):[^\s<>"'`]+/gi,
    /(^|[^:\w])\/\/(?:localhost|(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,}|\[[0-9a-f:]+\])(?::\d+)?[^\s<>"'`]*/giu,
    /\bwww\.(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,}(?::\d+)?[^\s<>"'`]*/giu,
    /\bhttps?:\\\/\\\/[^\s<>"'`]+/gi,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      let literal = match[0];
      let start = match.index;

      if (pattern === patterns[2]) {
        const prefix = match[1] ?? '';
        literal = match[0].slice(prefix.length);
        start += prefix.length;
      }

      literal = trimBareUrl(literal);
      if (!literal) continue;

      add({
        tag: null,
        attribute: null,
        anchorText: null,
        literalMatch: literal,
        value: decodeEscapedSlashes(literal),
        start,
        end: start + literal.length,
        priority: 20,
        literalOccurrence: true,
      });
    }
  }
}

/**
 * Finds URL-like complete string literals such as fetch('/api/items') or
 * {"image":"../assets/photo.webp"}. Bare absolute URLs are handled by the
 * separate scanner, while this pass adds relative references.
 *
 * @param {string} source
 * @param {(candidate: Candidate) => void} add
 */
function collectQuotedUrlLikeStrings(source, add, tagRanges = []) {
  const re = /(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  let rangeIndex = 0;

  for (const match of source.matchAll(re)) {
    while (rangeIndex < tagRanges.length && tagRanges[rangeIndex][1] <= match.index) {
      rangeIndex += 1;
    }
    const activeRange = tagRanges[rangeIndex];
    if (activeRange && activeRange[0] <= match.index && match.index < activeRange[1]) {
      continue;
    }

    const raw = match[2];
    if (!raw || (match[1] === '`' && raw.includes('${'))) continue;

    const decoded = decodeJavaScriptString(raw, match[1]);
    const trimmed = decoded.trim();
    if (!looksLikeUrlReference(trimmed)) continue;

    const rawTrimStart = raw.search(/\S/);
    const rawTrimmed = raw.trim();
    const start = match.index + 1 + Math.max(0, rawTrimStart);

    add({
      tag: null,
      attribute: null,
      anchorText: null,
      literalMatch: rawTrimmed,
      value: trimmed,
      start,
      end: start + rawTrimmed.length,
      priority: 30,
      literalOccurrence: true,
    });
  }
}

/**
 * @param {string|URL|undefined} explicitBase
 * @param {string|null} htmlBase
 */
function chooseBaseURL(explicitBase, htmlBase) {
  const browserBase =
    typeof document !== 'undefined' && document.baseURI
      ? document.baseURI
      : typeof location !== 'undefined' && location.href
        ? location.href
        : null;

  if (explicitBase != null) {
    try {
      return new URL(explicitBase instanceof URL ? explicitBase.href : String(explicitBase), browserBase ?? undefined);
    } catch {
      throw new TypeError(`extractLinks: init.baseURL must resolve to an absolute URL; received ${JSON.stringify(String(explicitBase))}`);
    }
  }

  if (htmlBase) {
    try {
      return new URL(htmlBase, browserBase ?? undefined);
    } catch {
      // An HTML base can itself be relative; without an ambient browser base it
      // cannot establish an absolute document URL.
    }
  }

  if (browserBase) return new URL(browserBase);
  return null;
}

/**
 * @param {string} rawValue
 * @param {URL|null} baseURL
 */
function resolveReference(rawValue, baseURL) {
  let value = String(rawValue).trim();
  if (!value) return { kind: 'skip' };

  value = decodeHtmlEntities(decodeEscapedSlashes(value));
  value = stripMatchingWrappers(value);

  if (!value || /^\{[{%]|[}%]\}$/.test(value)) return { kind: 'skip' };
  if (/^www\./i.test(value)) value = `https://${value}`;
  if (/^\\{2}/.test(value)) value = value.replace(/^\\+/, '//');

  const scheme = value.match(/^([A-Za-z][A-Za-z0-9+.-]*:)/)?.[1]?.toLowerCase();
  if (scheme && BLOCKED_SCHEMES.has(scheme)) return { kind: 'skip' };

  if (value.startsWith('//')) {
    const protocol = baseURL && /^(?:https?|ftp):$/.test(baseURL.protocol)
      ? baseURL.protocol
      : 'https:';
    try {
      return { kind: 'resolved', url: new URL(`${protocol}${value}`) };
    } catch {
      return { kind: 'skip' };
    }
  }

  try {
    if (scheme) return { kind: 'resolved', url: new URL(value) };
    if (!baseURL) return { kind: 'relative-without-base' };
    return { kind: 'resolved', url: new URL(value, baseURL) };
  } catch {
    return { kind: 'skip' };
  }
}

/**
 * Convert URLSearchParams into a plain record. Repeated keys become arrays in
 * source order. Returns null when the URL has no query parameters.
 *
 * @param {URLSearchParams} searchParams
 * @returns {Record<string, string|string[]>|null}
 */
function searchParamsToRecord(searchParams) {
  /** @type {Map<string, string|string[]>} */
  const values = new Map();

  for (const [key, value] of searchParams) {
    const existing = values.get(key);
    if (existing == null) values.set(key, value);
    else if (Array.isArray(existing)) existing.push(value);
    else values.set(key, [existing, value]);
  }

  return values.size === 0 ? null : Object.fromEntries(values);
}

/** @param {string} key */
function isUrlMetaKey(key) {
  if (!key) return false;
  return /(?:^|[:._-])(?:url|image|video|audio|player|thumbnail|logo|icon)(?:$|[:._-])/i.test(key) ||
    /^(?:contenturl|embedurl|thumbnailurl)$/i.test(key);
}

/**
 * @param {string[]} domains
 */
function compileDomainExclusions(domains) {
  return domains
    .map((entry) => String(entry).trim().toLowerCase())
    .filter(Boolean)
    .map((entry) => {
      const subdomainsOnly = entry.startsWith('*.');
      let value = subdomainsOnly ? entry.slice(2) : entry.replace(/^\./, '');

      try {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
          value = new URL(value).hostname;
        } else {
          value = new URL(`https://${value}`).hostname;
        }
      } catch {
        value = value.split('/')[0].split(':')[0];
      }

      return { hostname: value.replace(/\.$/, ''), subdomainsOnly };
    })
    .filter((entry) => entry.hostname);
}

/**
 * @param {string} hostname
 * @param {Array<{hostname:string,subdomainsOnly:boolean}>} exclusions
 */
function isExcludedHostname(hostname, exclusions) {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return exclusions.some(({ hostname: excluded, subdomainsOnly }) => {
    if (subdomainsOnly) return normalized.endsWith(`.${excluded}`);
    return normalized === excluded || normalized.endsWith(`.${excluded}`);
  });
}

/** @param {string} value */
function decodeHtmlEntities(value) {
  const named = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: '\u00a0',
    quot: '"',
  };

  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const hex = body[1]?.toLowerCase() === 'x';
      const codePoint = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(codePoint)) return whole;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return whole;
      }
    }
    return named[body.toLowerCase()] ?? whole;
  });
}

/** @param {string} value */
function decodeMarkdownDestination(value) {
  return decodeHtmlEntities(value.replace(/\\([!"#$%&'()*+,./:;<=>?@[\]^_`{|}~-])/g, '$1'));
}

/** @param {string} value */
function decodeCssUrl(value) {
  return decodeHtmlEntities(
    value
      .replace(/\\([()'"\\ ])/g, '$1')
      .replace(/\\([0-9a-f]{1,6})\s?/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16))),
  );
}

/** @param {string} value */
function decodeEscapedSlashes(value) {
  return value.replace(/\\\//g, '/');
}

/**
 * This deliberately handles only the escapes that matter for URL-like strings;
 * it does not evaluate JavaScript.
 * @param {string} value
 * @param {string} quote
 */
function decodeJavaScriptString(value, quote) {
  return value
    .replace(/\\u\{([0-9a-f]+)\}/gi, (_, hex) => safeCodePoint(hex))
    .replace(/\\u([0-9a-f]{4})/gi, (_, hex) => safeCodePoint(hex))
    .replace(/\\x([0-9a-f]{2})/gi, (_, hex) => safeCodePoint(hex))
    .replace(/\\\//g, '/')
    .replace(new RegExp(`\\\\${escapeRegExp(quote)}`, 'g'), quote)
    .replace(/\\\\/g, '\\');
}

/** @param {string} hex */
function safeCodePoint(hex) {
  try {
    return String.fromCodePoint(Number.parseInt(hex, 16));
  } catch {
    return '';
  }
}

/** @param {string} value */
function stripMatchingWrappers(value) {
  let result = value.trim();
  const pairs = new Map([
    ['<', '>'],
    ['"', '"'],
    ["'", "'"],
  ]);
  const closer = pairs.get(result[0]);
  if (closer && result.at(-1) === closer) result = result.slice(1, -1).trim();
  return result;
}

/** @param {string} value */
function looksLikeUrlReference(value) {
  if (!value || /\s/.test(value)) return false;
  if (/^(?:data|javascript|vbscript):/i.test(value)) return false;
  if (/^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/|\/|\.\/|\.\.\/|#|\?)/.test(value)) return true;
  if (/^www\./i.test(value)) return true;
  if (/^[\p{L}\p{N}@%+._~-]+(?:\/[\p{L}\p{N}@%+._~!$&'()*+,;=:-]+)+(?:[?#].*)?$/u.test(value)) return true;
  return /^[\p{L}\p{N}@%+_-]+\.(?:avif|css|csv|gif|htm|html|ico|jpeg|jpg|js|json|mjs|md|pdf|php|png|svg|txt|webp|xml)(?:[?#].*)?$/iu.test(value);
}

/** @param {string} value */
function trimBareUrl(value) {
  let result = value;
  while (/[.,;:!?]$/.test(result)) result = result.slice(0, -1);

  const pairs = [
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
  ];
  for (const [open, close] of pairs) {
    while (result.endsWith(close) && countChar(result, close) > countChar(result, open)) {
      result = result.slice(0, -1);
    }
  }

  return result;
}

/** @param {string} value @param {string} char */
function countChar(value, char) {
  let count = 0;
  for (const current of value) if (current === char) count += 1;
  return count;
}

/** @param {string} value @param {number} absoluteStart */
function splitWhitespaceTokens(value, absoluteStart) {
  const tokens = [];
  const re = /\S+/g;
  for (const match of value.matchAll(re)) {
    tokens.push({
      value: match[0],
      start: absoluteStart + match.index,
      end: absoluteStart + match.index + match[0].length,
    });
  }
  return tokens;
}

/** @param {string} value @param {number} absoluteStart */
function parseSrcset(value, absoluteStart) {
  const tokens = [];
  let segmentStart = 0;

  for (let i = 0; i <= value.length; i += 1) {
    if (i !== value.length && value[i] !== ',') continue;
    const segment = value.slice(segmentStart, i);
    const match = segment.match(/^\s*(\S+)/);
    if (match && !/^data:/i.test(match[1])) {
      const localStart = segmentStart + segment.indexOf(match[1]);
      tokens.push({
        value: match[1],
        start: absoluteStart + localStart,
        end: absoluteStart + localStart + match[1].length,
      });
    }
    segmentStart = i + 1;
  }

  return tokens;
}

/** @param {string} value @param {number} absoluteStart */
function parseMetaRefresh(value, absoluteStart) {
  const match = value.match(/^\s*\d+(?:\.\d+)?\s*;\s*url\s*=\s*(?:"([^"]*)"|'([^']*)'|(.+?))\s*$/i);
  if (!match) return null;
  const literal = match[1] ?? match[2] ?? match[3];
  const localStart = value.indexOf(literal);
  return {
    value: literal,
    start: absoluteStart + localStart,
    end: absoluteStart + localStart + literal.length,
  };
}

/** @param {string} source @param {string} target @param {number} start */
function findUnescaped(source, target, start) {
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === target && !isEscaped(source, i)) return i;
  }
  return -1;
}

/** @param {string} source @param {number} index */
function isEscaped(source, index) {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && source[i] === '\\'; i -= 1) slashes += 1;
  return slashes % 2 === 1;
}

/** @param {string} value */
function normalizeReferenceId(value) {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** @param {number} index @param {Array<[number,number]>} ranges */
function isInsideRanges(index, ranges) {
  return ranges.some(([start, end]) => index >= start && index < end);
}

/** @param {string} value */
function htmlToPlainText(value) {
  const withoutTags = value.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, ' ');
  const decoded = decodeHtmlEntities(withoutTags).replace(/\u00a0/g, ' ');
  const normalized = decoded.replace(/\s+/g, ' ').trim();
  return normalized || null;
}

/** @param {string} value */
function markdownToPlainText(value) {
  const normalized = value
    .replace(/\\([!"#$%&'()*+,./:;<=>?@[\]^_`{|}~-])/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized || null;
}

/** @param {string} value */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
