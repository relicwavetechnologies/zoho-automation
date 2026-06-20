"""
Web Search Quality Layer
========================

Post-processing that lifts raw SERP-snippet results (what every search-only
provider — ddgs, searxng, brave-free, serper — returns) up to the quality of a
purpose-built agentic search API. Pure post-processing over the canonical
result shape produced by every ``WebSearchProvider.search()``::

    {"success": True, "data": {"web": [
        {"title": str, "url": str, "description": str, "position": int}, ...
    ]}}

Three stages, each independently toggleable via ``web.quality.*`` config:

1. **Dedupe** — URL canonicalization (drop tracking params, fragments,
   default ports, trailing slash) + de-duplication, keeping the best-ranked
   occurrence. SERP federation routinely surfaces the same page twice.

2. **Enrich** — concurrently fetch the top-N result pages and extract clean
   main-text (``content``) + meta description, replacing the thin ~150-char
   snippet the model would otherwise reason over. This is the single biggest
   quality lever and mirrors the advance-backend ``WebSearchService`` page-
   context pass that made its Serper path good.

3. **Rerank** — lexical relevance rerank using the *enriched* text, so results
   whose real content actually matches the query float up even when the
   upstream engine ordered them poorly.

Zero new dependencies: ``httpx`` (already a core dep) + stdlib only. Stays
sync-callable (``enhance_search_results``) so the sync ``web_search_tool`` can
use it without event-loop entanglement; concurrency comes from a small thread
pool. SSRF-safe — every fetch target is checked through
:func:`tools.url_safety.is_safe_url`.
"""

from __future__ import annotations

import html
import logging
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

logger = logging.getLogger(__name__)

# ── Defaults (overridable via web.quality.* in config.yaml) ──────────────────
# Content enrichment defaults OFF: web search is step 1 of the two-step flow
# (search → links, then web_extract → full content). The dedupe + rerank stages
# run by default to improve the *link* ordering; enrichment (fetching page
# bodies inside search) is opt-in via web.quality.enrich for callers who want a
# one-shot result. The free built-in extractor (plugins/web/native_extract)
# provides the step-2 content extraction for free.
DEFAULT_ENRICH = False
DEFAULT_ENRICH_TOP_N = 3
DEFAULT_MAX_CHARS = 1500
DEFAULT_RERANK = True
DEFAULT_FETCH_TIMEOUT = 8.0
DEFAULT_MAX_FETCH_BYTES = 2_000_000  # cap downloaded HTML per page (~2 MB)

_FETCH_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

# Query params that never identify content — stripped during canonicalization.
_TRACKING_PARAM_RE = re.compile(
    r"^(utm_|ic_|mc_|pk_|hsa_|_hs|vero_|trk_|ga_)|"
    r"^(gclid|fbclid|msclkid|dclid|yclid|igshid|mkt_tok|ref|ref_src|"
    r"ref_url|referrer|source|cmpid|campaign|spm)$",
    re.IGNORECASE,
)

# Blocks whose text is chrome/boilerplate, not content. Removed before extract.
_DROP_BLOCK_RE = re.compile(
    r"<(script|style|noscript|svg|template|head|nav|header|footer|aside|form)\b[^>]*>"
    r".*?</\1>",
    re.IGNORECASE | re.DOTALL,
)
_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
_MAIN_RE = re.compile(r"<(main|article)\b[^>]*>(.*?)</\1>", re.IGNORECASE | re.DOTALL)
_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
_META_DESC_RE = re.compile(
    r"""<meta\s+[^>]*?(?:name|property)\s*=\s*["'](?:description|og:description)["']"""
    r"""[^>]*?content\s*=\s*["'](.*?)["']""",
    re.IGNORECASE | re.DOTALL,
)
_BLOCK_TAG_RE = re.compile(
    r"</?(p|div|br|li|ul|ol|tr|h[1-6]|section|blockquote|pre)\b[^>]*>",
    re.IGNORECASE,
)
_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"[ \t\f\v]+")
_BLANKLINES_RE = re.compile(r"\n{3,}")
_WORD_RE = re.compile(r"[a-z0-9]+")

# Very common English words excluded from the lexical rerank signal.
_STOPWORDS = frozenset(
    "the a an and or of to in for on at is are was were be been being with "
    "by as it this that these those from how what when where why who which "
    "do does did i you we they he she his her their our your my".split()
)


# ── Config ────────────────────────────────────────────────────────────────────
def _load_quality_config() -> Dict[str, Any]:
    """Read the ``web.quality`` sub-section from config.yaml (best-effort)."""
    try:
        from tools.web_tools import _load_web_config

        q = _load_web_config().get("quality", {})
        return q if isinstance(q, dict) else {}
    except Exception:  # noqa: BLE001 — config is optional
        return {}


def _cfg_bool(cfg: Dict[str, Any], key: str, default: bool) -> bool:
    val = cfg.get(key)
    if isinstance(val, bool):
        return val
    if isinstance(val, str):
        return val.strip().lower() in {"1", "true", "yes", "on"}
    return default


def _cfg_num(cfg: Dict[str, Any], key: str, default: float) -> float:
    val = cfg.get(key)
    if isinstance(val, (int, float)):
        return float(val)
    if isinstance(val, str):
        try:
            return float(val.strip())
        except ValueError:
            return default
    return default


# ── URL canonicalization + dedupe ────────────────────────────────────────────
def normalize_url(url: str) -> str:
    """Canonicalize a URL for dedupe: lowercase host, strip default port,
    drop tracking query params + fragment, collapse trailing slash.

    Returns the original string unchanged if it can't be parsed.
    """
    if not url or not isinstance(url, str):
        return url or ""
    try:
        parts = urlsplit(url.strip())
    except ValueError:
        return url.strip()
    if not parts.scheme or not parts.netloc:
        return url.strip()

    scheme = parts.scheme.lower()
    host = parts.hostname or ""
    host = host.lower()
    if host.startswith("www."):
        host = host[4:]
    netloc = host
    # Preserve non-default ports only.
    if parts.port and not (
        (scheme == "http" and parts.port == 80)
        or (scheme == "https" and parts.port == 443)
    ):
        netloc = f"{host}:{parts.port}"

    kept = [
        (k, v)
        for k, v in parse_qsl(parts.query, keep_blank_values=False)
        if not _TRACKING_PARAM_RE.match(k)
    ]
    query = urlencode(sorted(kept))

    path = parts.path or "/"
    if len(path) > 1 and path.endswith("/"):
        path = path.rstrip("/")

    return urlunsplit((scheme, netloc, path, query, ""))


def dedupe_web_results(results: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Drop duplicate results by canonical URL, keeping the first (best-ranked)
    occurrence. Positions are renumbered 1..N over the survivors.
    """
    seen: set[str] = set()
    out: List[Dict[str, Any]] = []
    for r in results:
        key = normalize_url(str(r.get("url", "")))
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(r)
    for i, r in enumerate(out):
        r["position"] = i + 1
    return out


# ── Content extraction (regex; no bs4/lxml dependency) ───────────────────────
def _strip_to_text(fragment: str) -> str:
    """Turn an HTML fragment into readable plain text."""
    fragment = _BLOCK_TAG_RE.sub("\n", fragment)
    fragment = _TAG_RE.sub(" ", fragment)
    fragment = html.unescape(fragment)
    fragment = _WS_RE.sub(" ", fragment)
    fragment = "\n".join(line.strip() for line in fragment.split("\n"))
    fragment = _BLANKLINES_RE.sub("\n\n", fragment)
    return fragment.strip()


def _truncate(text: str, max_chars: int) -> str:
    """Truncate to ``max_chars`` on a word boundary, appending an ellipsis."""
    if not max_chars or len(text) <= max_chars:
        return text
    clipped = text[:max_chars]
    cut = clipped.rfind(" ")
    if cut > max_chars * 0.6:
        clipped = clipped[:cut]
    return clipped.rstrip() + "…"


def _extract_with_trafilatura(raw_html: str) -> str:
    """Main-text via trafilatura (benchmark-leading boilerplate removal).

    Optional dependency: returns "" when trafilatura isn't installed or finds
    no content, so the caller falls back to the regex extractor.
    """
    try:
        import trafilatura
    except Exception:  # noqa: BLE001 — optional dep
        return ""
    try:
        text = trafilatura.extract(
            raw_html,
            include_comments=False,
            include_tables=False,
            favor_precision=True,
            no_fallback=False,
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("trafilatura.extract failed: %s", exc)
        return ""
    return (text or "").strip()


def extract_main_text(
    raw_html: str, max_chars: int = DEFAULT_MAX_CHARS
) -> Tuple[str, str, str]:
    """Extract ``(title, meta_description, excerpt)`` from a raw HTML document.

    Content extraction prefers **trafilatura** (clean main-text, strips site
    chrome/nav/infoboxes); falls back to a dependency-free regex extractor that
    prefers ``<main>``/``<article>`` content, else the de-chromed body. Title
    and meta description always come from the regex pass (cheap, reliable).
    Truncates the excerpt on a word boundary.
    """
    if not raw_html:
        return "", "", ""

    title_m = _TITLE_RE.search(raw_html)
    title = _strip_to_text(title_m.group(1)) if title_m else ""

    desc_m = _META_DESC_RE.search(raw_html)
    meta_desc = html.unescape(desc_m.group(1).strip()) if desc_m else ""

    text = _extract_with_trafilatura(raw_html)
    if not text:
        body = _COMMENT_RE.sub(" ", raw_html)
        body = _DROP_BLOCK_RE.sub(" ", body)
        main_m = _MAIN_RE.search(body)
        text = _strip_to_text(main_m.group(2) if main_m else body)

    return title, meta_desc, _truncate(text, max_chars)


def _fetch_and_extract(
    url: str, *, timeout: float, max_chars: int
) -> Optional[Dict[str, str]]:
    """Fetch one URL and return ``{title, meta_description, content}`` or None."""
    try:
        from tools.url_safety import is_safe_url

        if not is_safe_url(url):
            return None
    except Exception:  # noqa: BLE001 — if the guard is unavailable, skip fetch
        return None

    try:
        import httpx

        with httpx.Client(
            follow_redirects=True, timeout=timeout, headers=_FETCH_HEADERS
        ) as client:
            with client.stream("GET", url) as resp:
                ctype = resp.headers.get("content-type", "")
                if "html" not in ctype and "text" not in ctype and ctype:
                    return None
                chunks: List[bytes] = []
                total = 0
                for chunk in resp.iter_bytes():
                    chunks.append(chunk)
                    total += len(chunk)
                    if total >= DEFAULT_MAX_FETCH_BYTES:
                        break
                if resp.status_code >= 400:
                    return None
                raw = b"".join(chunks).decode(resp.encoding or "utf-8", "replace")
    except Exception as exc:  # noqa: BLE001 — page failures are non-fatal
        logger.debug("enrich fetch failed for %s: %s", url, exc)
        return None

    title, meta_desc, content = extract_main_text(raw, max_chars=max_chars)
    if not content:
        return None
    return {"title": title, "meta_description": meta_desc, "content": content}


def fetch_page_content(
    url: str,
    *,
    timeout: float = DEFAULT_FETCH_TIMEOUT,
    max_chars: int = 0,
) -> Optional[Dict[str, str]]:
    """Public: fetch a single URL and return ``{title, meta_description,
    content}`` (clean main-text via trafilatura, regex fallback) or None on
    failure. ``max_chars=0`` returns the full extracted text — used by the free
    built-in extract provider for the step-2 content read. SSRF-safe.
    """
    return _fetch_and_extract(url, timeout=timeout, max_chars=max_chars)


def enrich_results(
    results: List[Dict[str, Any]],
    *,
    top_n: int = DEFAULT_ENRICH_TOP_N,
    max_chars: int = DEFAULT_MAX_CHARS,
    timeout: float = DEFAULT_FETCH_TIMEOUT,
) -> List[Dict[str, Any]]:
    """Concurrently fetch the top-N results and attach extracted page content.

    Mutates and returns ``results``. Each enriched item gains:
      - ``content``: clean main-text excerpt (the model's primary signal)
      - ``meta_description``: page meta description when present
      - ``page_fetched``: bool — whether enrichment succeeded for this item
    Items past ``top_n`` (and any that fail) keep only their SERP snippet.
    """
    targets = [
        (i, str(r.get("url", "")))
        for i, r in enumerate(results[:top_n])
        if str(r.get("url", "")).startswith(("http://", "https://"))
    ]
    if not targets:
        return results

    workers = min(len(targets), 6)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(
                _fetch_and_extract, url, timeout=timeout, max_chars=max_chars
            ): idx
            for idx, url in targets
        }
        for fut in as_completed(futures):
            idx = futures[fut]
            try:
                payload = fut.result()
            except Exception:  # noqa: BLE001
                payload = None
            if not payload:
                results[idx]["page_fetched"] = False
                continue
            results[idx]["content"] = payload["content"]
            if payload["meta_description"]:
                results[idx]["meta_description"] = payload["meta_description"]
            # Upgrade a missing/empty title from the fetched page.
            if payload["title"] and not str(results[idx].get("title", "")).strip():
                results[idx]["title"] = payload["title"]
            results[idx]["page_fetched"] = True
    return results


# ── Lexical rerank ────────────────────────────────────────────────────────────
def _tokens(text: str) -> List[str]:
    return [t for t in _WORD_RE.findall((text or "").lower()) if t not in _STOPWORDS]


# Relative weight of the lexical signal vs the engine's own ranking prior.
# The engine prior is reciprocal rank (pos1=1.0, pos2=0.5, pos3=0.33…); the
# lexical signal is normalized to [0, 1] and scaled by this. Kept < 1 so a
# strongly-matching lower result can *refine* the order (overtake a weak
# neighbour) but cannot leapfrog a well-ranked top result on keyword density
# alone — which is exactly how SEO/boilerplate junk used to reach #1.
_LEXICAL_WEIGHT = 0.5


def _lexical_relevance(query_terms: set, r: Dict[str, Any]) -> float:
    """Normalized [0, 1] lexical match of a result against the query terms,
    using title (weighted), snippet, and any enriched page content."""
    title_t = _tokens(str(r.get("title", "")))
    desc_t = _tokens(str(r.get("description", "")))
    content_t = _tokens(str(r.get("content", "")))

    n_terms = len(query_terms)
    if n_terms == 0:
        return 0.0

    present = query_terms & (set(title_t) | set(desc_t) | set(content_t))
    coverage = len(present) / n_terms  # distinct query terms found anywhere

    title_hits = sum(1 for t in title_t if t in query_terms)
    title_norm = min(title_hits / n_terms, 1.0)  # query terms in the title

    content_hits = sum(1 for t in content_t if t in query_terms)
    density = min(content_hits / 25.0, 1.0)  # on-topic density of body text

    return 0.5 * coverage + 0.3 * title_norm + 0.2 * density


def rerank_results(
    query: str, results: List[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    """Rerank by **rank fusion**: the engine's own reciprocal-rank prior plus a
    weighted, normalized lexical relevance signal computed over the enriched
    content. The engine prior dominates (it already encodes authority/quality),
    so this refines the order — surfacing results whose real content matches the
    query — without letting keyword-dense boilerplate overtake a well-ranked
    authoritative result. Ties preserve the upstream order. Positions renumbered.
    """
    q_terms = set(_tokens(query))
    if not q_terms or len(results) < 2:
        return results

    def fused(i: int) -> float:
        r = results[i]
        engine_pos = int(r.get("position", i + 1) or (i + 1))
        engine_prior = 1.0 / max(engine_pos, 1)
        return engine_prior + _LEXICAL_WEIGHT * _lexical_relevance(q_terms, r)

    # Sort by fused score desc; ties fall back to original index (stable).
    order = sorted(range(len(results)), key=lambda i: (-fused(i), i))
    reranked = [results[i] for i in order]
    for i, r in enumerate(reranked):
        r["position"] = i + 1
    return reranked


# ── Public orchestrator ──────────────────────────────────────────────────────
def enhance_search_results(
    query: str,
    response: Dict[str, Any],
    *,
    enrich: Optional[bool] = None,
    rerank: Optional[bool] = None,
    top_n: Optional[int] = None,
    max_chars: Optional[int] = None,
    timeout: Optional[float] = None,
) -> Dict[str, Any]:
    """Apply the quality layer to a provider ``search()`` response in place.

    Safe no-op when the response is an error, has no web results, or the
    feature is disabled in config. Explicit kwargs override config; config
    overrides the module defaults.
    """
    if not isinstance(response, dict) or not response.get("success"):
        return response
    web = response.get("data", {}).get("web")
    if not isinstance(web, list) or not web:
        return response

    cfg = _load_quality_config()
    do_enrich = DEFAULT_ENRICH if enrich is None else enrich
    do_rerank = DEFAULT_RERANK if rerank is None else rerank
    if enrich is None:
        do_enrich = _cfg_bool(cfg, "enrich", DEFAULT_ENRICH)
    if rerank is None:
        do_rerank = _cfg_bool(cfg, "rerank", DEFAULT_RERANK)
    n = int(top_n if top_n is not None else _cfg_num(cfg, "enrich_top_n", DEFAULT_ENRICH_TOP_N))
    chars = int(max_chars if max_chars is not None else _cfg_num(cfg, "max_chars", DEFAULT_MAX_CHARS))
    to = timeout if timeout is not None else _cfg_num(cfg, "fetch_timeout", DEFAULT_FETCH_TIMEOUT)

    web = dedupe_web_results(web)
    if do_enrich and n > 0:
        web = enrich_results(web, top_n=n, max_chars=chars, timeout=to)
    if do_rerank:
        web = rerank_results(query, web)

    response["data"]["web"] = web
    return response
