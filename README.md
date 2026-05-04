# notebooklm-mcp

Personal MCP server that gives Claude (Claude Code, Claude Desktop, or any MCP-compatible client) access to your Google NotebookLM, by driving a real Chrome session via Playwright. No third-party intermediaries — your data flows only between your machine and `notebooklm.google.com`.

## Why

Google has no public NotebookLM API. Existing community MCPs reverse-engineer internal endpoints or extract cookies; you're trusting someone else's code with your Google session. This one is small enough to read in 10 minutes (~500 LOC across 3 files) and depends only on `@modelcontextprotocol/sdk` (Anthropic) and `playwright` (Microsoft).

## Tools exposed

| Tool | What it does |
|---|---|
| `list_notebooks` | Returns all notebooks with id, title, emoji, metadata |
| `list_sources` | Returns sources attached to a notebook with stable indices |
| `get_source_text` | Reads full text of a source from the NotebookLM viewer |
| `create_notebook` | Creates a new empty notebook, optionally renames it |
| `query_notebook` | Asks a question; returns the assistant's answer (~30s typical) |
| `add_source` | Adds a URL or pasted text as a new source |
| `delete_source` | Removes a source from a notebook (destructive) |
| `rename_source` | Renames a source |
| `delete_notebook` | Permanently deletes an entire notebook (destructive) |
| `rename_notebook` | Renames a notebook |
| `generate_studio` | Triggers Studio artifact generation (Audio Overview, Mind Map, Slide Deck, Video Overview, Reports, Flashcards, Quiz, Infographic, Data Table). Returns immediately — generation runs server-side for 30s–5min. |

Selectors live in `src/notebooklm.ts` only. Expect to tweak them when Google ships UI changes.

## Setup

```bash
git clone <this repo>
cd notebooklm-mcp
./setup.sh           # npm install, playwright chromium, build
npm run login        # one-time: signs into Google in a visible browser
```

The Chrome profile (cookies, session) lives at `~/.notebooklm-mcp/chrome-profile/` (override with `NOTEBOOKLM_PROFILE_DIR`).

## Wire into Claude Code

```bash
# global (all projects)
claude mcp add --scope user notebooklm -- node "$(pwd)/dist/server.js"
```

Or edit `~/.claude.json`:

```json
{
  "mcpServers": {
    "notebooklm": {
      "command": "node",
      "args": ["/absolute/path/to/notebooklm-mcp/dist/server.js"]
    }
  }
}
```

## Wire into Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "notebooklm": {
      "command": "node",
      "args": ["/absolute/path/to/notebooklm-mcp/dist/server.js"]
    }
  }
}
```

Restart Claude Desktop.

## When the Google session expires

You'll see a `Not logged in. Run npm run login...` error from any tool call. Re-run `npm run login` once and the session is refreshed.

## When NotebookLM ships a UI change

Selectors live in `src/notebooklm.ts` only. Use `NOTEBOOK_ID=<uuid> npx tsx src/inspect-source.ts` to dump real DOM and update selectors.

## Security notes

- stdio transport, local only — no network exposure beyond NotebookLM itself.
- Profile dir contains your Google session cookies; treat it like an SSH key. The `.gitignore` already excludes it but it lives outside the repo by default.
- Two runtime deps: `@modelcontextprotocol/sdk` (Anthropic) + `playwright` (Microsoft). Audit `node_modules` if you want to know everything in the path.

## License

MIT
