# graphify — capabilities and how shipyard uses it

graphify turns a folder of files into a **knowledge graph** you can ask questions about.

Code is parsed **locally** with tree-sitter — no API calls, no code leaves the machine. Docs,
PDFs, images, and video are sent to an LLM for meaning (or transcribed locally for audio/video).
The result is a persistent graph: nodes are concepts/files/symbols, edges are the relationships
between them, with an honest audit trail (`EXTRACTED` / `INFERRED` / `AMBIGUOUS`).

**Why it matters here:** instead of grepping a strange codebase file by file, an agent asks
graphify *"what connects auth to the database?"* and gets the answer plus the path through the
graph. shipyard's review gates use this to ground their experts in how the code is **actually**
built, not how the plan says it is.

- Source: <https://github.com/safishamsi/graphify> (PyPI package `graphifyy`, CLI `graphify`)
- License: MIT

---

## 1. What it can do (full capability list)

### Inputs it understands
- **Code (36 tree-sitter grammars):** Python, TypeScript, JavaScript, Go, Rust, Java, C/C++,
  Ruby, C#, Kotlin, PHP, Swift, Lua, Zig, PowerShell, Elixir, MATLAB, Julia, Vue, Svelte,
  Groovy, Dart, SQL, Fortran, Pascal, Bash, JSON, Salesforce Apex, BYOND DreamMaker, and more.
- **Docs:** Markdown, MDX, HTML, plain text, reStructuredText, YAML.
- **Office / Google Workspace:** `.docx`, `.xlsx`; Google Docs/Sheets/Slides (needs `gws` auth).
- **Media:** PDF, PNG/JPG/WebP/GIF, MP4/MOV/MP3/WAV, and YouTube URLs.
- **Infrastructure:** Terraform/HCL, live PostgreSQL introspection, Rust Cargo workspaces, MCP configs.

### Outputs it produces (in `graphify-out/`)
- `graph.html` — interactive graph: clickable nodes, filtering, search.
- `GRAPH_REPORT.md` — plain-language report: god nodes (most-connected concepts), surprising
  connections, design rationale pulled from comments, confidence tags, suggested questions.
- `graph.json` — the raw graph (this is what queries and the MCP server read).
- Optional exports: Obsidian vault, markdown wiki, SVG, GraphML (Gephi/yEd), Neo4j/FalkorDB
  Cypher, callflow diagrams.

### Things you can ask it
- `graphify query "<question>"` — broad context (BFS), or `--dfs` to trace one path.
- `graphify path "A" "B"` — shortest path between two concepts.
- `graphify explain "X"` — plain-language explanation of one node.
- `graphify prs` / `graphify prs --triage` / `--conflicts` — PR impact analysis and AI-ranked queue.

### How it stays current
- `--update` re-extracts only changed files (incremental, cheap).
- `--watch` auto-rebuilds on file change (AST-only, no LLM cost).
- `graphify hook install` — post-commit/post-checkout git hooks rebuild the graph automatically,
  plus a merge driver so `graph.json` never conflicts.
- `graphify global ...` — register many project graphs and query across them with `--global`.

---

## 2. The two ways Claude Code talks to graphify

These are **distinct**. A project can have one, both, or neither.

**A. MCP server (preferred for agents).** Run `python -m graphify.serve graphify-out/graph.json`.
It exposes typed tools the agent calls directly:
- `query_graph`, `get_node`, `get_neighbors`, `shortest_path` (plus `list_prs`, `get_pr_impact`,
  `triage_prs`).
- Register it in the **target repo's** `.mcp.json`. Because graphify installs via `uv tool`, the
  command must point at graphify's own interpreter
  (e.g. `~/.local/share/uv/tools/graphifyy/bin/python`), not a bare `python`.
- HTTP mode is available for shared/team use: `--transport http --port 8080 --api-key "$SECRET"`.

**B. Skill + CLI + hook.** `graphify <platform> install` (e.g. `graphify claude install`) writes a
guidance section into `CLAUDE.md` and a PreToolUse hook that nudges the agent to run the
`graphify query` / `path` / `explain` CLI before grepping. The local `/graphify` skill drives the
full build pipeline from inside a Claude Code session.

**Access order an agent should prefer:** MCP tools → CLI → read `graph.json` directly →
fall back to `smart-explore`/grep if graphify is absent. Never block on graphify being missing.

---

## 3. Install (per developer, once)

```bash
uv tool install graphifyy        # or: graphify with extras, e.g. "graphifyy[pdf,office,mcp]"
graphify install                 # wires the /graphify skill + hook into Claude Code
```

Useful extras: `[pdf]`, `[office]`, `[video]`, `[mcp]`, `[neo4j]`, `[falkordb]`, `[postgres]`,
`[gemini]`/`[anthropic]`/`[openai]`/`[ollama]`/`[bedrock]`/`[azure]`, or `[all]`.

Privacy note: code is local-only. Docs/PDFs/images go to whichever LLM backend is configured
(auto-detected from env vars: Gemini → Kimi → Claude → OpenAI → DeepSeek → Azure → Bedrock →
Ollama). No telemetry. Query log lives at `~/.cache/graphify-queries.log` (disable with
`GRAPHIFY_QUERY_LOG_DISABLE=1`).

---

## 4. Per-project wiring (in the target repo, not in shipyard)

shipyard stays generic. Each project it reviews brings its own graph. In the **target repo**:

1. Build the graph once: `graphify .` (or let the gate run `graphify update .`).
2. (Recommended) auto-keep-fresh: `graphify hook install`.
3. (Recommended) register the MCP server in that repo's `.mcp.json` so experts get typed tools.
4. Commit `graphify-out/` so teammates and agents read the graph immediately.
   Add `graphify-out/cost.json` to `.gitignore`.

---

## 5. Where graphify fits in the shipyard pipeline

```
spec → plan → [PLAN GATE] → implement → [CODE GATE]
              plan-readiness            expert-panel
                -review                   -review
              ^^^ graphify              ^^^ graphify
```

graphify is a **review-side / planning-side tool**. It answers *"how is this built?"* (the map).
It is **not** used during `implement` — there, Serena locates symbols and Claude Code edits.
Rule of thumb: **graphify maps, Serena locates, Claude Code edits.**

---

## 6. Which skills should use graphify (and how)

| Skill | Uses graphify? | What it should do |
|---|---|---|
| **`plan-readiness-review`** (plan gate) | **Yes — already wired** | Launcher runs `graphify update <repo>` before the panel so the graph is fresh. Experts query the graph to check the plan against how the code really works. Falls back to smart-explore/grep if graphify is absent; records which mode was used in the report. |
| **`expert-panel-review`** (code gate) | **Yes — already wired** | Each domain expert grounds findings in the real codebase via graphify (MCP tools or CLI) instead of trusting the diff alone. Same fallback chain. |
| **`plan`** (planned) | **Yes — natural fit** | A plan should be written against the real architecture. Query graphify while drafting so the plan names real files/modules and respects existing boundaries. This is the "helicopter view" before committing to a design. |
| **`spec`** (planned) | Optional | Only if the spec touches existing code; usually spec is intent-first and code-agnostic. |
| **`implement`** (planned) | **No** | Use Serena for symbol-level find/navigate and Claude Code to edit. graphify is too coarse for line-level edits and is a planning/review tool by design. |

**General Claude Code rule (any project):** if `graphify-out/graph.json` exists and the user asks
a question about the codebase ("how does X work?", "what calls Y?", "trace the flow through Z"),
treat it as a graphify query **first** — run `graphify query` before reading files one by one.
This is what the installed `/graphify` skill and the PreToolUse hook enforce.

---

## 7. Quick command reference

```bash
# Build / refresh
graphify .                      # full build of current dir
graphify . --update             # incremental: only changed files
graphify . --cluster-only       # re-cluster existing graph, no re-extract
graphify . --no-viz             # skip HTML (use for >5000-node graphs)
graphify . --mode deep          # richer inferred edges

# Ask
graphify query "what connects auth to the database?"
graphify query "..." --dfs --budget 1500
graphify path "UserService" "DatabasePool"
graphify explain "RateLimiter"

# PRs
graphify prs --triage

# Serve to agents
python -m graphify.serve graphify-out/graph.json                  # stdio (local)
python -m graphify.serve graphify-out/graph.json --transport http --port 8080

# Keep fresh
graphify hook install           # rebuild on commit/checkout + merge driver

# Exports
graphify . --neo4j-push bolt://localhost:7687
graphify . --obsidian --wiki --graphml --svg
```

---

## 8. Gotchas

- **HTML > 5000 nodes** is heavy — graphify auto-aggregates to a community view, or use `--no-viz`.
- **Fewer nodes after a refactor** is expected; `--force` to overwrite a smaller graph.
- **`.mcp.json` interpreter** must be graphify's uv-tool python, not a bare `python`.
- **Conflict markers in `graph.json`** → install the merge driver (`graphify hook install`).
- graphify reads only `GEMINI_API_KEY`/`GOOGLE_API_KEY` automatically inside a Claude Code skill
  run; for other backends, set the key and pass `--backend` in headless/CI flows.
```
