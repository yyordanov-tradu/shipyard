# Serena — capabilities and how shipyard uses it

Serena is the **micro / symbol-level** code-intelligence tool in shipyard's tooling bible
([docs/tooling.md](tooling.md)): exact definitions, all callers, call hierarchy, types,
diagnostics, and the precise tests a change breaks. It is the owner of those questions in the
**implement** stage's per-task subagents (and an optional secondary check in the code gate).

Serena is an MCP toolkit built on the Language Server Protocol. Unlike a bare LSP bridge, it
**auto-manages the language servers** for most of its 40+ languages — it downloads and installs
the server it needs on first use, so a polyglot repo works with little or no manual setup.

- Source: <https://github.com/oraios/serena>
- License: MIT

> **shipyard ships none of this.** Like graphify, Serena is wired **per target repo** in that
> repo's `.mcp.json`, never inside shipyard — shipyard stays generic. It is **optional**: the
> implement stage runs today without it and falls back to ripgrep.

---

## 1. Install (per developer, once)

```bash
uv tool install -p 3.13 serena-agent
```

(You can also run it without installing via `uvx --from git+https://github.com/oraios/serena serena …`.)

## 2. Language servers — mostly automatic

Serena downloads and manages the language server for most languages on first use, so there is
**no per-language install step** for the common ones (Python, TypeScript/JavaScript, Go, Rust, …).
A few languages need a server provided manually (e.g. Perl, Crystal, Fortran); Serena's
[Language Support](https://oraios.github.io/serena/01-about/020_programming-languages.html) page
flags those in its notes. This is the main reason shipyard uses Serena over a bring-your-own-server
bridge: less setup across a mixed-language repo.

## 3. Wire it into the TARGET repo (Claude Code)

Run from inside the repo you will implement in (not shipyard). Easiest is the helper:

```bash
serena setup claude-code
```

Or add it explicitly (per-project scope):

```bash
claude mcp add serena -- serena start-mcp-server --context claude-code --project "$(pwd)"
```

For a user-wide install instead, use `--scope user` and `--project-from-cwd`:

```bash
claude mcp add --scope user serena -- serena start-mcp-server --context claude-code --project-from-cwd
```

Either way this registers Serena as an MCP server whose tools surface as `mcp__serena__*`.

## 4. Keep edits with Claude Code (retrieval only)

**shipyard rule:** use Serena's **retrieval** tools only — find-symbol, find-references,
call-hierarchy, types, diagnostics. Serena *can* edit; shipyard never uses that, because
**Claude Code is the single editor** (see [docs/tooling.md](tooling.md)). The implement per-task
subagent is given Serena but **not** graphify, and **not** Serena's edit tools.

Serena restricts its exposed tools through **modes** (and config in `serena_config.yml` /
`.serena/project.yml`). To enforce retrieval-only, run it under a mode that excludes the editing
tools — create one once and activate it:

```bash
serena mode create read-only
serena mode edit read-only        # remove the file-editing tools from this mode
```

Then start the server with it (`--mode read-only` replaces defaults, `--add-mode read-only` adds
on top), or set it in `serena_config.yml` under `base_modes:`. See Serena's
[configuration docs](https://oraios.github.io/serena/02-usage/050_configuration.html) for the
exact tool-exclusion keys. (Enforcing this is recommended but optional — the skill prompts already
instruct subagents to use retrieval only.)

## 5. Verify

After setup, ask Serena to list its tools, or run a find-references in the target repo and confirm
it returns symbol-level results. If Serena is absent or misconfigured, the implement stage degrades
to ripgrep and says so — it never blocks.

---

## 6. Where Serena fits in the pipeline

```
Jira ticket → plan → [PLAN GATE] → implement → [CODE GATE]
              graphify  graphify     ^^^^^^^^^   graphify (+ Serena optional)
                                     Serena (per-task subagents)
```

- **implement** is the home of Serena: the lead does macro stream analysis with graphify, then
  each per-task subagent uses Serena for the micro loop — locate the symbol, find all callers,
  check types/diagnostics, and (via call-hierarchy) find the tests a change impacts.
- **code gate** may use Serena as an *optional secondary* check — "are all callers of this changed
  symbol updated?" — but graphify stays primary there.
- **plan** and **plan gate** do not use it (those are macro/graphify questions).

**Short version: graphify maps, Serena locates, Claude Code edits.** When Serena is absent, the
implement stage degrades to ripgrep and says so — it never blocks.
