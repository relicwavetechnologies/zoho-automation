# Semrush capability matrix

Divo Semrush is **web-session only** (`www.semrush.com`). No `api.semrush.com` path.

**Required env:** `SEMRUSH_WEB_API_KEY`, `SEMRUSH_WEB_COOKIE`, `SEMRUSH_TIMEOUT_MS`

| Divo operation | Semrush recipe | Status |
| --- | --- | --- |
| `domain_overview` | `POST /dpa/rpc` · `ranks.Ranks` · `organic.overview` | Wired |
| `backlinks_comparison` | `POST /backlinks/webapi2/` · `type=backlinks_comparison` | Wired |
| `keyword_position_trend` | `POST /dpa/rpc` · `organic.KeywordPositionTrend` · `organic.positions` | Wired |
| `organic_growth_export` / compare-periods | `POST /dpa/rpc` · `export.Get` · `organic.overviewtrendbatch` | Not wired — live probe returns `Unknown report name` |
| `organic_positions`, `domain_comparison`, `keyword_gap`, `keyword_research`, `organic_position_trend` | Official API (removed) | Removed |
| AI Visibility / Prompt Research / etc. | UI-only | Not registered |

**Also wired:** `semrush` gateway tool, `divo-semrush-seo-research` skill, governed `dataExport` replay (`semrush_snapshot`), `scripts/validate-semrush-web.ts`
