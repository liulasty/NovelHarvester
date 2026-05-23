# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run workflow            # Interactive scrape + merge
npm run workflow:list       # List configured targets
node novel-workflow.js <id> # Run target by ID (e.g., xnl, nzxs-xsz)
node novel-workflow.js <id> 5  # First 5 chapters only (test run)

npm run dev:web             # Dev: Vite frontend + Express API concurrently
npm run build:web           # Build frontend for production
npm run start:web           # Production: single Express process (requires build first)

# Direct scraper usage (bypassing workflow):
node gaode/<site>/scrape-<site>.js <url> --out-dir=novel-output/<dir> --merge

# Merge only:
node merge-novel.js --dir=novel-output/<dir> --title=<title>
```

Env vars: `NOVEL_WEB_PORT` (default 3001), `NOVEL_WEB_HOST` (default 127.0.0.1).

## Architecture

**Playwright-based novel scraper pipeline:** discover chapter list → scrape each chapter → merge into one file. Optional web dashboard (React + Express) for managing targets and tasks.

```
gaode/<site>/scrape-<site>.js   # Site-specific scraper (Playwright)
  ↓
lib/orchestrator/                # Shared orchestration layer
  ├── registry.js                # SCRAPER_TO_SCRIPT_REL: maps scraper keys to script paths
  ├── targets.js                 # Config I/O (novel-targets.json), validation, atomic writes
  └── plan.js                    # Builds spawn args from target config + registry
  ↓
novel-workflow.js                # CLI entry: interactive or by ID (reads targets, spawns scraper)
merge-novel.js                   # Chapter merger (chapters/ → merged/, dual CLI + require)
  ↓
web/                             # Optional web dashboard
  ├── server/index.js            # Express API (targets CRUD, task manager, outputs)
  └── client/                    # Vite + React 19 app
```

All scrapers use `headless: chromium` via Playwright. Chapter files follow `001_title.txt` naming, stored under `chapters/`. Merged output goes to `merged/{bookTitle}.txt` (falls back to `全文合并.txt` when no title).

## Scraper Registry

Add a new site in 3 places:

1. `gaode/<site>/scrape-<site>.js` — the scraper script
2. `lib/orchestrator/registry.js` — add entry to `SCRAPER_TO_SCRIPT_REL`
3. `novel-targets.json` — add target with `scraper` key matching registry entry

Each scraper accepts CLI flags: `--out-dir=`, `--merge`, `--merge-title=`, and positional `[url] [maxChapters]`. The `merge-novel.js` module is shared via `require` (not re-implemented per site).

## Key Conventions

| Convention | Detail |
|---|---|
| Output layout | `novel-output/<id>/chapters/001_*.txt` + `merged/{书名}.txt` |
| Chunk detection | `CHAPTER_FILE_RE` = `/^(\d+)_(.+)\.txt$/i`, sorted numerically |
| Manifest | `chapters_manifest.json` in output dir (auto-discovered chapter list) |
| Web concurrency | Max 3 concurrent tasks, FIFO queue, SSE log streaming |
| Targets config | `novel-targets.json` at project root, validated on read/write, atomic rename |
| Legacy HTTP | `serve-novel.js`, `srv.js`, `srv.py` — candidates for cleanup (see docs/todo.md) |

## Complex Scraper Patterns (shuwen6)

The shuwen6 scraper at `gaode/shuwen6/scrape-shuwen6.js` demonstrates two advanced patterns used by some sites:

- **`.wen` script decoding**: Finds `initTxt("...")` in page HTML → fetches `.wen` file via Playwright request → executes in `vm.runInNewContext` with injected `_txt_call` callback → applies `replace` regex patterns → falls back to DOM extraction if result < 50 chars
- **TImg image mapping**: Some sites embed censored chars as base64 `img.TImg`; `timg-map.json` maps src → character; unmapped images show as `□` and are logged to `failed_chapters.json` for retry
- **Directory pagination**: Some sites have N-page chapter lists; see `collectCatalogPageUrls()` for the pattern (page counting via DOM text, sequential fetch until empty streak)

The `failed_chapters.json` (v2 format with `kind: extraction_error` / `kind: timg_unmapped`) enables targeted retry via `--retry-failed` flag.
