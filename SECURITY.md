# Security

`ctxkeeper` is a local stdio MCP server. It does not open network connections,
does not execute arbitrary shell commands, and does not send telemetry.

## Data location

- Project memories: `<project>/.ctxkeeper/events.jsonl`
- Global memories: `~/.ctxkeeper/global/events.jsonl`

Both are plain text. A `.gitignore` containing `*` is created inside
`.ctxkeeper/`, so memories are not committed by default. Do not store secrets,
tokens, private keys, or full source files in memories.

## Read boundaries

- Files are read only from the detected project root.
- `node_modules`, `.git`, `dist`, `build`, `target`, virtualenvs, and similar
  directories are skipped.
- `.env*`, `*.pem`, `*.key`, `id_rsa*`, `credentials`, and `secrets.*` are
  excluded from code search.
- High-confidence credential shapes (private key blocks, `sk-`, `ghp_`,
  `AKIA`, `xox`) are redacted from tool output.

## Reporting a vulnerability

Please open a private security advisory on GitHub:
https://github.com/Coisini-cyber/ctxkeeper-mcp/security/advisories/new

Do not open a public issue for a vulnerability. Please include a minimal
reproduction and the affected version.
