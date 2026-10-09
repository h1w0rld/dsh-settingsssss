---
name: obsidian-dataweave
description: "Use when Obsidian или NotebookLM→vault: «обработай заметку», импорт research из NotebookLM, docx-импорт, атомизация/zettelkasten, wiki init/compile/lint, поиск по заметкам и recall. Смежные: вопросы к NotebookLM без Obsidian — notebooklm."
trigger_phrases:
  - process note
  - enrich note
  - atomize note
  - docx import
  - обработай заметку
  - обработай документ
  - импортируй документ
  - zettelkasten правила
  - process contacts
  - обработай контакты
  - networking contacts
  - process notebook
  - обработай ноутбук
  - pull from notebooklm
  - забери из notebooklm
  - импортируй ноутбук
  - notebooklm to obsidian
  - notebooklm login
  - залогинься в notebooklm
  - авторизуйся в notebooklm
  - run research in notebook
  - запусти ресерч в ноутбуке
  - deep research into notebook
  - дип ресерч в ноутбук
  - dedupe notebook sources
  - почисти дубли в ноутбуке
  - clean up duplicate sources
  - fix broken research import
  - init wiki
  - создай вики
  - ingest into wiki
  - залей в вики
  - compile wiki
  - собери вики
  - update wiki page
  - обнови вики
  - lint wiki
  - проверь вики
  - wiki по проекту
  - search notes
  - найди в заметках
  - поиск по заметкам
  - search the vault
  - поиск по вики
  - rebuild memory index
  - перестрой индекс памяти
  - recall
  - вспомни
  - what do we know about
  - что мы знаем про
---

# ObsidianDataWeave Claude Adapter

Use the repo-local `AGENTS.md` as the primary contract.

## Intent Mapping

- Process a source `.docx` document:
  `python3 scripts/process.py "Document.docx"`
- Process a curated NotebookLM notebook (direct NotebookLM control):
  `python3 scripts/process_notebook.py "<notebook_id>"`
  Optional: `--include-sources`, `--include-mindmap`, `--profile <name>`.
- Fetch NotebookLM notes without atomization:
  `python3 scripts/fetch_notebook.py "<notebook_id>"`
- Process a personal note:
  `python3 scripts/process_note.py "Note Title"`
- Process a contacts/networking note:
  `python3 scripts/process_contacts.py "Contacts Note"`
- Run duplicate review:
  `python3 scripts/dedup_vault.py --dry-run`
- Run deep research directly into an existing NotebookLM notebook (safe — bypasses upstream CLI retry duplication bug):
  `python3 scripts/research_notebook.py run "<notebook_id>" "<query>"`
- Clean up duplicate / error-state sources in a NotebookLM notebook:
  `python3 scripts/research_notebook.py dedupe "<notebook_id>" --dry-run`
- Validate setup:
  `python3 scripts/doctor.py`
- Initialize a new LLM Wiki space:
  `python3 scripts/wiki_init.py <slug> --mode project --title "Project Name"`
  Modes: `project` (fixed core pages) or `corpus` (entities-only).
  Add `--lang ru` (or `--lang en`) to pick template language; defaults to
  `[wiki].default_lang` from `config.toml` (`en` if unset). Each language has
  its own `templates/wiki/<lang>/` tree — affects SCHEMA, index, log, raw
  README, and core-page stubs. Different langs coexist fine within one vault.
- Ingest raw inputs into a wiki-space:
  `python3 scripts/wiki_ingest.py <slug> <file-or-dir> --kind {articles|docs|transcripts|assets}`
- Compile the wiki (LLM merges raw into pages):
  `python3 scripts/wiki_compile.py <slug> --since-last-compile`
  Add `--dry-run` to print the prompt without calling the backend.
- Update one page from a single new raw input (incremental):
  `python3 scripts/wiki_update.py <slug> raw/docs/<file>.md`
- Lint a wiki-space (or all of them):
  `python3 scripts/wiki_lint.py [<slug>] [--strict]`
- Search the vault memory (FTS5 full-text, agents should prefer `--json`):
  `python3 scripts/memory_index.py search "<query>" --json [--limit 10] [--prefix] [--folder X] [--tag Y]`
- Rebuild / refresh the memory index:
  `python3 scripts/memory_index.py build` (full) or `update` (incremental)
- Upgrade an existing install after `git pull` (config + index migration):
  `python3 scripts/migrate.py`

## Memory protocol (MUST)

The FTS5 vault memory is the recall layer — use it, do not treat it as
optional. See `AGENTS.md` → "Memory protocol (MUST)" for the full contract.
In short:

1. **Ensure it exists.** Run `memory_index.py status`; if `exists: false`,
   run `memory_index.py build` once (the index never self-creates on the
   first write — `vault_writer` prints a `NOTE:` hint when it is missing).
2. **Search before answering or writing.** Before answering questions about
   vault/wiki content, and before `wiki_compile.py` / `wiki_update.py`, run
   `memory_index.py search "<query>" --json` first.
3. **Self-heal.** On `index not built yet` → `build`, then retry.

## NotebookLM Workflow (direct control)

The user curates material inside NotebookLM: adds sources, chats with them,
saves relevant answers as notes (`notebooklm ask ... --save-as-note` or via
the web UI), and creates notes manually. When ready, running
`process_notebook.py <notebook_id>` pulls every note as a single batch and
feeds it to `atomize.py`, which sees the whole corpus at once and builds
wikilinks **between** notes from different sources. Mind maps become the
scaffold for the MOC; source fulltext (if requested) provides extra context.

Prerequisites (one-time per machine):
- `notebooklm-py[browser]` installed in a venv (system pip is blocked by PEP 668 on Arch/Debian)
- Playwright Chromium installed for that venv
- A saved NotebookLM session at `~/.notebooklm/storage_state.json` (produced by `notebooklm login`)

## How "being logged in" actually works

The NotebookLM session is a file on disk (`~/.notebooklm/storage_state.json`
plus a persistent browser profile at `~/.notebooklm/browser_profile/`). The
agent does **not** hold any auth state in memory — every run of
`fetch_notebook.py` / `process_notebook.py` re-reads that file and is
authenticated iff it exists.

Consequence: once the user has logged in once, **no browser prompt is
needed on subsequent runs**. The agent should never suggest re-running
`notebooklm login` unless the preflight marker below fires or the user
asks for it explicitly (cookies expired, switching accounts, etc.).

## Handling NotebookLM Auth Errors

`fetch_notebook.py` (and therefore `process_notebook.py`) does a preflight
check via `check_auth_or_exit()`. If `storage_state.json` is missing at any
of the default locations, it exits with code `2` and prints
`NOTEBOOKLM_AUTH_REQUIRED: ...` on stderr **before** touching the
NotebookLM client. When you see that marker, the user has never logged in
on this machine (or the file was deleted).

`scripts/notebooklm_setup.py` automates dependency install but intentionally
keeps login as a separate manual step, because `notebooklm login` opens a
browser AND then blocks on `input()` waiting for the user to press ENTER in
a real terminal. Running the login step from Claude Code's shell (or any
non-TTY subprocess) aborts immediately with `Aborted!`. The setup script
detects this and refuses with exit code `3` when stdin is not a TTY.

Agent protocol when you see `NOTEBOOKLM_AUTH_REQUIRED`:

1. Tell the user briefly in Russian: «NotebookLM не настроен — ставлю зависимости, а логин нужно сделать самому в отдельном терминале, потому что `notebooklm login` требует настоящий TTY».
2. Ensure a project venv exists (`.venv/`). If it does not:
   `python3 -m venv .venv`
3. Run the dependency installer via the venv's Python (safe in non-TTY, no login attempted):
   `.venv/bin/python scripts/notebooklm_setup.py --skip-login`
   It may take a minute on first run (Chromium download is ~150MB).
   If it exits non-zero, show the user its stderr and stop — do not try to recover by running individual pip/playwright commands.
4. Ask the user to open a **separate terminal window** and run:
   ```
   cd <repo> && .venv/bin/notebooklm login
   ```
   They should sign in to Google in the Chromium window, wait for the NotebookLM homepage to load, then return to that terminal and press ENTER.
5. When the user confirms they pressed ENTER, re-run the preflight by retrying the original `process_notebook.py <notebook_id>` command (or just check that `~/.notebooklm/storage_state.json` now exists).
6. If the preflight no longer fires, proceed silently — no further login prompts. The session is reused across runs until cookies expire.

If the session later expires, `fetch_notebook.py` may fail deeper in the
pipeline (not via the `NOTEBOOKLM_AUTH_REQUIRED` marker, since the file
still exists). In that case, delete `~/.notebooklm/storage_state.json`
only after confirming with the user, and repeat steps 4–5 above.

## Deep research via research_notebook.py (do not use the upstream CLI directly)

**Do not invoke `notebooklm source add-research "<query>" --mode deep --import-all`.**
The upstream CLI wraps `client.research.import_sources()` in a retry loop that
re-imports the full source list on every RPC timeout, without deduping against
the notebook's existing sources. Result: notebooks end up with N× duplicates
after N retries. Concretely we hit 392 sources instead of ~78 in one run.
Bug is tracked upstream as `teng-lin/notebooklm-py` issue #241.

Use `scripts/research_notebook.py run` instead. It calls the `notebooklm-py`
Python library directly, which upstream explicitly documents as
*one-shot behavior*, so IMPORT_RESEARCH is a single call and cannot duplicate:

```
python3 scripts/research_notebook.py run "<notebook_id>" "<query>"
```

Options: `--mode fast|deep` (default deep), `--source web|drive`,
`--max-sources N`, `--poll-interval`/`--poll-timeout`, `--profile <name>`,
`--dry-run` (plan only).

If a notebook was already poisoned by the broken CLI, clean it up:

```
python3 scripts/research_notebook.py dedupe "<notebook_id>" --dry-run
python3 scripts/research_notebook.py dedupe "<notebook_id>" --include-error --non-interactive
```

`dedupe` groups sources by URL (with title as fallback), keeps the first
occurrence of each group, and can optionally delete sources stuck in error
state. Always preview with `--dry-run` before running destructive deletes.

## LLM Wiki

A separate **compiled knowledge layer** (Karpathy-style) that lives next
to atomic notes inside the same vault but in a strictly isolated folder:
`<vault>/<wiki_folder>/<project-slug>/`. Wiki pages never appear outside
this folder; atomic notes never appear inside it. The folder name comes
from `[wiki].wiki_folder` in `config.toml` (default `"LLM Wiki"`).

The wiki has three layers:

- **raw/** — immutable inputs (articles, docs, transcripts, assets)
  added by `wiki_ingest.py`. Never modified by any script.
- **pages/ entities/ concepts/ comparisons/ queries/** — compiled
  knowledge layer. `wiki_compile.py` reads raw + the existing wiki
  snapshot, calls the LLM, and merges the result back. Existing
  wikilinks are preserved across compile passes (load-bearing safety
  property — `WIKI_LINKS_LOST` exit 5 if violated).
- **SCHEMA.md / index.md / log.md** — meta layer. SCHEMA is frozen
  after init; index is regenerated each compile; log is append-only.

Two modes:

- **project mode** — fixed core pages (overview, architecture,
  components, workflows, goals-and-roadmap, glossary, open-questions).
  Use for documenting a single coherent system.
- **corpus mode** — only entities/concepts grow as raw is added. Use
  for a reading-list-style knowledge base.

**Critical isolation rule:** `wiki_compile.py` does **not** read atomic
notes, MOCs, or contacts. Wiki pages link only to other pages in the
same wiki-space (or to `[[?slug]]` open-question markers).

Typical workflow:

```
wiki_init.py demo --mode project --title "Demo Project"
wiki_ingest.py demo path/to/article.md --kind articles
wiki_compile.py demo --since-last-compile
wiki_lint.py demo --strict
```

**Template language.** `wiki_init.py` ships templates in English (`en`)
and Russian (`ru`). Pick per-invocation with `--lang ru`, or set
`[wiki].default_lang` in `config.toml`. Choice only affects on-disk prose
of meta files and core-page stubs — wiki structure, frontmatter contract,
and pipeline behavior are language-agnostic.

## Rules
- Prefer the repository's `AGENTS.md`, `rules/*.md`, and script help output over global instructions.
- Treat this file as a Claude-specific entrypoint, not as the canonical source of project behavior.
- Reuse the same local commands that Codex would run from the repository.
