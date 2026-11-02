# Contributing

Thanks for taking a look at `ctxkeeper`.

## Development

```bash
git clone https://github.com/Coisini-cyber/ctxkeeper-mcp.git
cd ctxkeeper-mcp
npm install
npm run build
npm test
npm run demo -- . "how does the store work"
```

Requirements: Node.js >= 20.11.

## What to work on

Good first issues:

- Retrieval quality: better tokenization, stemming, or ranking.
- Large-repo performance: incremental file index, ignore rules.
- More language/framework detection in `src/scan.ts`.
- Tests for concurrency (two server processes writing to one store).
- Docs: real-world examples, client integrations.

Please open an issue before a large change so we can agree on the shape.

## Design constraints

Keep these invariants unless there is a strong reason:

1. **Local-first**: no network calls, no API keys, no telemetry.
2. **No native dependencies**: the store is append-only JSONL.
3. **Read-only code access**: never execute user code or arbitrary shell commands.
4. **Token-aware**: every context-producing tool has a budget and degrades gracefully.
5. **Recoverable**: archiving is reversible; events are append-only.

## Pull requests

- Keep commits focused and use conventional prefixes (`feat:`, `fix:`, `docs:`).
- Add or update a test in `tests/e2e.test.mjs` for behaviour changes.
- Run `npm test` before opening the PR.
- By contributing you agree that your work is licensed under the MIT license.
