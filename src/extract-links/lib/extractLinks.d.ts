export interface ExtractLinksInit {
  /** Defaults to "html". */
  mode?: 'html' | 'md';

  /**
   * Hostnames whose links should be ignored.
   *
   * `example.com` matches both the apex domain and its subdomains.
   * `*.example.com` matches subdomains only.
   */
  excludeDomains?: string[];

  /**
   * Base used to turn relative references into absolute URLs.
   *
   * In a browser, document.baseURI/location.href is used as a fallback. In
   * Node.js, this is required for relative links unless the source contains an
   * absolute HTML <base href> element.
   */
  baseURL?: string | URL;
}

export interface ExtractedLink {
  tag: 'a' | 'img' | string | null;
  attribute: 'href' | 'src' | string | null;
  anchorText: string | null;
  literalMatch: string;

  /**
   * Decoded query parameters from fullUrl. Repeated parameter names map to
   * string arrays. Omitted when the URL has no query parameters.
   */
  urlParams?: Record<string, unknown>;

  /** Absolute resolved URL, including query parameters. */
  fullUrl: string;

  /** Absolute resolved URL with its query string removed. */
  cleanUrl: string;

  /** Number of occurrences of this exact literalMatch in the source. */
  literalCount: number;

  /** Number of occurrences resolving to this exact fullUrl. */
  fullCount: number;

  /** Number of occurrences resolving to this cleanUrl. */
  cleanCount: number;
}

export declare function extractLinks(
  source: string,
  init?: ExtractLinksInit,
): ExtractedLink[];

export default extractLinks;
