# How ctxkeeper compares

There is no shortage of memory and context tools. They solve different layers of the problem, and many work well together with `ctxkeeper`.

| Approach | What it is good at | Where it stops | Use together? |
| --- | --- | --- | --- |
| **`AGENTS.md` / `CLAUDE.md`** | Stable, human-curated project rules | Static; no retrieval, no token budget, no write loop | Yes — keep rules there, put evolving state in ctxkeeper |
| **Official Memory server / knowledge-graph memory** | General facts and entity relationships | Not project-specific; no code-window packing; often graph-shaped | Yes, for cross-domain facts |
| **mem0 / Letta-style memory layers** | Semantic long-term memory, often with hosted/vector infrastructure | Extra service, embeddings, API keys; usually conversation-shaped | Yes, if you already run one |
| **Graphify / Serena-style code intelligence** | AST/graph/semantic navigation of a codebase | Different layer: it indexes code, not decisions, commands, or handoffs | Yes — use both; ctxkeeper cites files, it does not replace a code graph |
| **Context7** | Version-specific library documentation | Docs, not your repository's state | Yes |
| **`ctxkeeper`** | Project decisions, gotchas, commands, TODOs, recent work; token-budgeted code windows with citations | Lexical retrieval; no embeddings; capped scan size | — |

## The distinction that matters

Most tools answer one of these:

1. **"What is true about this library?"** → documentation servers.
2. **"Where is this symbol defined?"** → code graph / LSP / semantic index.
3. **"What did we decide, and what should I read next?"** → project memory + context packing.

`ctxkeeper` is deliberately (3). It is small on purpose: 8 tools, one append-only file, no services. If you need (1) or (2), use the specialized tools; ctxkeeper will make them cheaper to call by narrowing the context first.

## When not to use it

- You want a shared, multi-user memory service with SSO and permissions.
- You need semantic recall over paraphrases today.
- Your repository is a multi-million-line monorepo and you cannot wait for the incremental index.
- You want the agent to execute commands or edit files. That is the job of your coding agent, not this server.
