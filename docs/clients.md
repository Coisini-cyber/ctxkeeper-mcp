# Client setup

`ctxkeeper` is a standard **stdio MCP server**. Any client that can launch a local
process works. The only requirement is Node.js ≥ 20.11.

Replace `/absolute/path/to/ctxkeeper-mcp/dist/index.js` with the real path on
your machine. On Windows use forward slashes or escaped backslashes.

> **Do not set `cwd` unless you want to pin a project.** The server detects the
> project root from the workspace, so one global entry works in every repository.

## OpenCode

Global config: `~/.config/opencode/opencode.json`
(Windows: `C:\Users\<you>\.config\opencode\opencode.json`)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "ctxkeeper": {
      "type": "local",
      "command": ["node", "/absolute/path/to/ctxkeeper-mcp/dist/index.js"],
      "enabled": true,
      "timeout": 20000
    }
  }
}
```

Verify: `opencode mcp list` → `✓ ctxkeeper connected`.

## Claude Code

Project-scoped `.mcp.json` in the repository root:

```json
{
  "mcpServers": {
    "ctxkeeper": {
      "command": "node",
      "args": ["/absolute/path/to/ctxkeeper-mcp/dist/index.js"]
    }
  }
}
```

Or add it with the CLI (adjust the path):

```bash
claude mcp add ctxkeeper -- node /absolute/path/to/ctxkeeper-mcp/dist/index.js
```

## Claude Desktop

`claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "ctxkeeper": {
      "command": "node",
      "args": ["/absolute/path/to/ctxkeeper-mcp/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop after editing.

## Cursor

Project config `.cursor/mcp.json` (or the global equivalent):

```json
{
  "mcpServers": {
    "ctxkeeper": {
      "command": "node",
      "args": ["/absolute/path/to/ctxkeeper-mcp/dist/index.js"]
    }
  }
}
```

## VS Code

`.vscode/mcp.json` uses the `servers` key:

```json
{
  "servers": {
    "ctxkeeper": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/ctxkeeper-mcp/dist/index.js"]
    }
  }
}
```

## Windsurf

`mcp_config.json`:

```json
{
  "mcpServers": {
    "ctxkeeper": {
      "command": "node",
      "args": ["/absolute/path/to/ctxkeeper-mcp/dist/index.js"]
    }
  }
}
```

## No clone: install from GitHub

If you do not want to clone and build manually, point the client at the repository:

```json
{
  "mcpServers": {
    "ctxkeeper": {
      "command": "npx",
      "args": ["-y", "github:Coisini-cyber/ctxkeeper-mcp"]
    }
  }
}
```

The first launch installs and builds; later launches reuse the npm cache. A local
clone starts faster and is recommended for daily use.

## Verify before connecting

```bash
node /absolute/path/to/ctxkeeper-mcp/dist/index.js --version
node /absolute/path/to/ctxkeeper-mcp/dist/index.js --doctor
node /absolute/path/to/ctxkeeper-mcp/dist/index.js --brief
```

If `--doctor` shows the wrong root, set `CTXKEEPER_ROOT` explicitly.

## Make the agent use it

Add this to `AGENTS.md` / `CLAUDE.md`:

```markdown
## Project memory (ctxkeeper)
- At the start of every session, call `ctxkeeper_project_brief` before reading files or grepping.
- To locate code, call `ctxkeeper_context_pack` with a concrete question, then read only the cited ranges.
- Save confirmed decisions and gotchas with `ctxkeeper_remember`; track work with `ctxkeeper_todo`.
- Before finishing, call `ctxkeeper_log_work` with files and next steps.
```
