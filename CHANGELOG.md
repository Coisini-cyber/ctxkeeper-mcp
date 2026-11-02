# Changelog

All notable changes to this project will be documented here.

## [0.1.0] - 2026-11-02

First public release.

### Added

- Local-first MCP server over stdio with 8 tools: `project_brief`, `context_pack`,
  `recall`, `remember`, `forget`, `todo`, `log_work`, `status`.
- Append-only JSONL memory store with replay, deduplication, archiving, and
  reversible todo completion.
- Token-budgeted project brief with stack/command detection, git state, TODOs,
  decisions, gotchas, recent work, and repository structure.
- Context packer with per-file budgets, best-window selection, `path:line`
  citations, and memory-to-code bridging for cross-language queries.
- CJK-aware tokenization and identifier splitting for English/camelCase/snake_case.
- Read-only code access: ignore rules, sensitive-file exclusions, and
  high-confidence credential redaction.
- MCP resource `ctxkeeper://brief`, prompt `onboard`, and server instructions.
- 10 end-to-end tests using the official MCP SDK client over real stdio.
- CI matrix for Node 20 and 22, MIT license, security policy, and issue templates.
