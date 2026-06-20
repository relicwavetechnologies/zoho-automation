"""
Web search quality eval harness.

Runs a fixed query set through three pipelines and dumps a side-by-side report
plus full JSON for judging:

  1. free-raw       : ddgs provider, no quality layer (status-quo free path)
  2. free+quality   : ddgs provider + quality layer (dedupe/enrich/rerank)
  3. serper-raw     : serper provider, no quality layer (advance-backend-ish)
  4. serper+quality : serper provider + quality layer

Usage:
  SERPER_API_KEY=... .venv/bin/python scripts/eval_web_search.py
  SERPER_API_KEY=... .venv/bin/python scripts/eval_web_search.py "custom query"

Gentle on ddgs (sequential + small sleep) to dodge its aggressive rate limits.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from plugins.web.ddgs.provider import DDGSWebSearchProvider  # noqa: E402
from plugins.web.serper.provider import SerperWebSearchProvider  # noqa: E402
from tools.web_quality import enhance_search_results  # noqa: E402

DEFAULT_QUERIES = [
    "anthropic claude opus 4.5 release date and pricing",
    "how does retrieval augmented generation reduce hallucination",
    "best practices for postgres connection pooling in node.js 2025",
    "what is the capital of Australia",
    "langgraph vs vercel ai sdk for agent orchestration",
]

LIMIT = 6
ENRICH_TOP_N = 3


def _summ(label: str, resp: dict, elapsed: float) -> dict:
    web = resp.get("data", {}).get("web", []) if resp.get("success") else []
    rows = []
    for r in web:
        content = r.get("content", "")
        rows.append(
            {
                "pos": r.get("position"),
                "title": (r.get("title") or "")[:80],
                "url": r.get("url", ""),
                "desc_len": len(r.get("description") or ""),
                "content_len": len(content),
                "fetched": r.get("page_fetched", None),
                "snippet": (content or r.get("description") or "")[:240],
            }
        )
    return {
        "label": label,
        "ok": bool(resp.get("success")),
        "error": resp.get("error"),
        "elapsed_s": round(elapsed, 2),
        "n": len(web),
        "answer": resp.get("data", {}).get("answer", "") if resp.get("success") else "",
        "results": rows,
    }


def _run(provider, query, *, quality: bool) -> tuple:
    t0 = time.time()
    try:
        resp = provider.search(query, LIMIT)
        if quality and resp.get("success"):
            resp = enhance_search_results(
                query, resp, enrich=True, rerank=True, top_n=ENRICH_TOP_N
            )
    except Exception as exc:  # noqa: BLE001
        resp = {"success": False, "error": f"{type(exc).__name__}: {exc}"}
    return resp, time.time() - t0


def main() -> None:
    queries = sys.argv[1:] or DEFAULT_QUERIES
    have_serper = bool(os.getenv("SERPER_API_KEY", "").strip())
    if not have_serper:
        print("⚠  SERPER_API_KEY not set — serper pipelines will be skipped.\n")

    ddgs = DDGSWebSearchProvider()
    serper = SerperWebSearchProvider()
    report = []

    for q in queries:
        print(f"\n{'='*90}\nQUERY: {q}\n{'='*90}")
        entry = {"query": q, "pipelines": []}

        pipelines = [("free-raw", ddgs, False), ("free+quality", ddgs, True)]
        if have_serper:
            pipelines += [
                ("serper-raw", serper, False),
                ("serper+quality", serper, True),
            ]

        for label, prov, quality in pipelines:
            resp, elapsed = _run(prov, q, quality=quality)
            s = _summ(label, resp, elapsed)
            entry["pipelines"].append(s)
            head = f"  [{label:<15}] ok={s['ok']} n={s['n']} {s['elapsed_s']}s"
            if s["answer"]:
                head += f"  answer={s['answer'][:60]!r}"
            if s["error"]:
                head += f"  ERROR={s['error']}"
            print(head)
            for r in s["results"][:LIMIT]:
                fetched = (
                    "✓" if r["fetched"] else ("·" if r["fetched"] is False else " ")
                )
                print(
                    f"      {r['pos']}. {fetched} c={r['content_len']:>5} "
                    f"d={r['desc_len']:>4}  {r['title']}"
                )
            time.sleep(1.0)  # be gentle on ddgs between pipelines

        report.append(entry)
        time.sleep(1.5)  # and between queries

    out = Path(__file__).resolve().parent.parent / "scripts" / "eval_web_search_report.json"
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(f"\n\nFull report written to: {out}")


if __name__ == "__main__":
    main()
