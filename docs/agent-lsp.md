# agent-lsp — capabilities and how shipyard uses it

`agent-lsp` is the **micro / symbol-level** code-intelligence tool in shipyard's tooling
bible ([docs/tooling.md](tooling.md)): exact definitions, all callers, call hierarchy, types,
diagnostics, and the precise tests a change breaks. It is the owner of those questions in the
**implement** stage's per-task subagents (and an optional secondary check in the code gate).

It is an MCP server that **orchestrates real language servers** (one per language) behind a
single MCP interface, so an agent gets compiler-grade answers instead of text search.

- Source: <https://github.com/blackwell-systems/agent-lsp> (MCP server, ~65 tools, 30+ languages)
- License: MIT

> **shipyard ships none of this.** Like graphify, agent-lsp is wired **per target repo** in
> that repo's `.mcp.json`, never inside shipyard — shipyard stays generic. It is **optional**:
> the implement stage runs today without it and falls back to ripgrep.

---

## 1. Install (per developer, once)

Install the binary (pick one):

```bash
curl -fsSL https://raw.githubusercontent.com/blackwell-systems/agent-lsp/main/install.sh | sh
# or
brew install blackwell-systems/tap/agent-lsp
# or
npm install -g @blackwell-systems/agent-lsp
# or
pip install agent-lsp
# or
go install github.com/blackwell-systems/agent-lsp/cmd/agent-lsp@latest
```

Windows: `iwr -useb https://raw.githubusercontent.com/blackwell-systems/agent-lsp/main/install.ps1 | iex`
(or `scoop install blackwell-systems/agent-lsp`, or `winget install BlackwellSystems.agent-lsp`).

## 2. Install a language server for each language you work in

agent-lsp orchestrates language servers; it does not bundle them. Install one per language
present in the target repo:

| Language | Install command |
|---|---|
| TypeScript / JavaScript | `npm i -g typescript-language-server typescript` |
| Python | `npm i -g pyright` |
| Go | `go install golang.org/x/tools/gopls@latest` |
| Rust | `rustup component add rust-analyzer` |
| C / C++ | `apt install clangd` (or `brew install llvm`) |
| Ruby | `gem install solargraph` |

## 3. Wire it into the TARGET repo's `.mcp.json`

Run from inside the repo you will implement in (not shipyard):

```bash
cd /path/to/target-repo
agent-lsp init        # auto-generates the .mcp.json block
```

Or write it by hand at the repo root (`.mcp.json`). The arg format is
`language:server-binary` with comma-separated server arguments:

```json
{
  "mcpServers": {
    "lsp": {
      "type": "stdio",
      "command": "agent-lsp",
      "args": [
        "go:gopls",
        "typescript:typescript-language-server,--stdio",
        "python:pyright-langserver,--stdio"
      ]
    }
  }
}
```

The MCP server key (`lsp` above) is arbitrary — its tools surface as `mcp__<key>__*`.

## 4. Allow the tools (and keep edits with Claude Code)

In `~/.claude/settings.json` (or the project's settings):

```json
{ "permissions": { "allow": ["mcp__lsp__*"] } }
```

**shipyard rule:** use agent-lsp's **retrieval** tools only — go-to-definition,
find-references, call-hierarchy, types, diagnostics. agent-lsp *can* edit; shipyard never uses
that, because **Claude Code is the single editor** (see [docs/tooling.md](tooling.md)). The
implement per-task subagent is given agent-lsp but **not** graphify and **not** agent-lsp's edit
tools. The wildcard above allows everything for convenience; to enforce the rule by permission,
allow only the read tools instead of `*`.

## 5. Verify

```bash
agent-lsp doctor      # probes the configured language servers and reports capabilities
```

---

## 6. Where agent-lsp fits in the pipeline

```
Jira ticket → plan → [PLAN GATE] → implement → [CODE GATE]
              graphify  graphify     ^^^^^^^^^   graphify (+ agent-lsp optional)
                                     agent-lsp (per-task subagents)
```

- **implement** is the home of agent-lsp: the lead does macro stream analysis with graphify,
  then each per-task subagent uses agent-lsp for the micro loop — locate the symbol, find all
  callers, check types/diagnostics, and (via call-hierarchy) find the tests a change impacts.
- **code gate** may use agent-lsp as an *optional secondary* check — "are all callers of this
  changed symbol updated?" — but graphify stays primary there.
- **plan** and **plan gate** do not use it (those are macro/graphify questions).

**Short version: graphify maps, agent-lsp gives eyes, Claude Code edits.** When agent-lsp is
absent, the implement stage degrades to ripgrep and says so — it never blocks.
