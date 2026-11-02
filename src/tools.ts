import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildBrief } from "./brief.js";
import type { Config } from "./paths.js";
import { packContext } from "./pack.js";
import { invalidateScan } from "./scan.js";
import { buildStatus } from "./status.js";
import type { Memory, MemoryType } from "./types.js";
import type { StoreHub } from "./store.js";
import { oneLine, truncate } from "./text.js";

const MEMORY_TYPES = [
  "decision",
  "gotcha",
  "fact",
  "command",
  "todo",
  "note",
] as const satisfies readonly MemoryType[];

const TYPE_EMOJI: Record<MemoryType, string> = {
  decision: "DEC",
  gotcha: "WARN",
  fact: "FACT",
  command: "CMD",
  todo: "TODO",
  note: "NOTE",
};

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function fail(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: `ctxkeeper error: ${message}` }], isError: true };
}

function run(fn: () => string): ToolResult {
  try {
    return ok(fn());
  } catch (error) {
    return fail(error);
  }
}

function formatMemory(m: Memory, detail = 700): string {
  const meta = [
    m.type,
    m.scope,
    `importance ${m.importance}`,
    `updated ${m.updated.slice(0, 10)}`,
  ].join(" · ");
  const lines = [
    `- [${m.id}] **${m.title}**`,
    `  ${meta}${m.done ? " · DONE" : ""}${m.archived ? " · ARCHIVED" : ""}`,
  ];
  if (m.content.trim()) lines.push(`  ${truncate(m.content.trim(), detail).replace(/\n/g, "\n  ")}`);
  const extras: string[] = [];
  if (m.tags.length) extras.push(`tags: ${m.tags.join(", ")}`);
  if (m.files.length) extras.push(`files: ${m.files.join(", ")}`);
  if (extras.length) lines.push(`  ${extras.join(" | ")}`);
  return lines.join("\n");
}

export function registerTools(server: McpServer, cfg: Config, hub: StoreHub): void {
  server.registerTool(
    "project_brief",
    {
      title: "Project brief (call first)",
      description:
        "Start here. Returns a token-budgeted brief for this project: detected stack, run/test commands, files to read first, git state, open TODOs, decisions, gotchas, and recent work logs. Replaces exploratory file reads at session start.",
      inputSchema: {
        budget_tokens: z
          .number()
          .int()
          .min(400)
          .max(8000)
          .default(1200)
          .describe("Token budget for the brief (rough estimate, default 1200)."),
        refresh: z
          .boolean()
          .default(false)
          .describe("Force a fresh filesystem/git scan instead of using the 30s cache."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ budget_tokens, refresh }) =>
      run(() => {
        if (refresh) invalidateScan();
        return buildBrief(cfg, hub, { budgetTokens: budget_tokens }).text;
      }),
  );

  server.registerTool(
    "remember",
    {
      title: "Remember a durable fact",
      description:
        "Persist a decision, gotcha, fact, command, todo, or note to the local project store (or global store). Use this whenever the user states a preference, you make a non-obvious choice, or you discover something future sessions should know. Identical entries are deduplicated.",
      inputSchema: {
        type: z.enum(MEMORY_TYPES).describe("decision | gotcha | fact | command | todo | note"),
        title: z.string().min(3).max(200).describe("Short, searchable title."),
        content: z
          .string()
          .min(1)
          .max(20000)
          .describe("The fact itself. Include why, constraints, and file paths when useful."),
        tags: z.array(z.string().min(1).max(40)).max(20).optional(),
        files: z
          .array(z.string().min(1).max(300))
          .max(40)
          .optional()
          .describe("Related paths, relative to the project root."),
        importance: z.number().int().min(1).max(5).default(3),
        scope: z
          .enum(["project", "global"])
          .default("project")
          .describe("project = this repo only; global = every project on this machine."),
        replaces: z
          .string()
          .optional()
          .describe("ID of an older memory this supersedes (it will be archived)."),
        source: z.string().max(80).optional().describe("Optional author/agent label."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) =>
      run(() => {
        const { memory, duplicate } = hub.remember(args, args.scope);
        if (duplicate) {
          return `Already known as [${memory.id}] "${memory.title}" (${memory.type}) — no duplicate written.`;
        }
        return [
          `Saved [${memory.id}] ${TYPE_EMOJI[memory.type]} "${memory.title}" to the ${memory.scope} store.`,
          args.replaces ? `Superseded ${args.replaces}.` : "",
          memory.type === "todo"
            ? "Track it with `todo` (action=list) and close it with action=done."
            : "It will appear in `project_brief` and in relevant `context_pack` calls.",
        ]
          .filter(Boolean)
          .join("\n");
      }),
  );

  server.registerTool(
    "recall",
    {
      title: "Recall project memory",
      description:
        "Search saved memories with keyword/CJK-aware ranking (title, tags, files, content; importance and recency weighted). Filter by type, tag, or scope. Use before asking the user to repeat context.",
      inputSchema: {
        query: z.string().max(500).default("").describe("Keywords; empty returns recent/high-importance entries."),
        types: z.array(z.enum(MEMORY_TYPES)).optional(),
        tags: z.array(z.string().min(1).max(40)).max(10).optional(),
        scope: z.enum(["all", "project", "global"]).default("all"),
        include_archived: z.boolean().default(false),
        include_done: z.boolean().default(false),
        limit: z.number().int().min(1).max(50).default(8),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) =>
      run(() => {
        const hits = hub.recall({
          query: args.query,
          types: args.types,
          tags: args.tags,
          scope: args.scope,
          includeArchived: args.include_archived,
          includeDone: args.include_done,
          limit: args.limit,
        });
        if (hits.length === 0) {
          return `No memories matched "${args.query}". Try fewer keywords, another scope, or save one with \`remember\`.`;
        }
        return [
          `# Recall: ${args.query || "(recent)"} — ${hits.length} hit(s)`,
          ...hits.map(
            (h) =>
              `${formatMemory(h.memory)}${h.score > 0 ? `\n  score: ${h.score}` : ""}`,
          ),
        ].join("\n");
      }),
  );

  server.registerTool(
    "forget",
    {
      title: "Archive or restore a memory",
      description:
        "Archive a memory by ID so it stops appearing in briefs and recall. Archive is reversible: pass restore=true with the same ID. Use when a decision is superseded or a note is wrong.",
      inputSchema: {
        id: z.string().min(3).describe("Memory ID, e.g. m_lx2abc."),
        restore: z.boolean().default(false).describe("Un-archive instead of archiving."),
        scope: z.enum(["all", "project", "global"]).default("all"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ id, restore, scope }) =>
      run(() => {
        const memory = restore ? hub.restore(id, scope) : hub.forget(id, scope);
        return restore
          ? `Restored [${memory.id}] "${memory.title}".`
          : `Archived [${memory.id}] "${memory.title}". Pass restore=true to undo.`;
      }),
  );

  server.registerTool(
    "todo",
    {
      title: "Project todos",
      description:
        "Manage the durable project todo list. action=add needs title; action=list shows open items (set include_done=true for all); action=done/reopen needs id. Todos survive sessions and appear in project_brief.",
      inputSchema: {
        action: z.enum(["add", "list", "done", "reopen"]),
        id: z.string().optional().describe("Required for done/reopen."),
        title: z.string().min(3).max(200).optional().describe("Required for add."),
        content: z.string().max(4000).optional(),
        tags: z.array(z.string().min(1).max(40)).max(10).optional(),
        importance: z.number().int().min(1).max(5).default(3),
        include_done: z.boolean().default(false),
        limit: z.number().int().min(1).max(100).default(30),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) =>
      run(() => {
        if (args.action === "add") {
          if (!args.title) throw new Error("title is required for action=add.");
          const { memory, duplicate } = hub.remember(
            {
              type: "todo",
              title: args.title,
              content: args.content ?? "",
              tags: args.tags,
              importance: args.importance,
            },
            "project",
          );
          return duplicate
            ? `Todo already exists: [${memory.id}] "${memory.title}".`
            : `Added todo [${memory.id}] "${memory.title}".`;
        }
        if (args.action === "done" || args.action === "reopen") {
          if (!args.id) throw new Error(`id is required for action=${args.action}.`);
          const memory = hub.setDone(args.id, args.action === "done", "all");
          return `${args.action === "done" ? "Closed" : "Reopened"} [${memory.id}] "${memory.title}".`;
        }
        const todos = hub.project
          .memoriesAll()
          .filter((m) => m.type === "todo" && !m.archived && (args.include_done || !m.done))
          .sort((a, b) => {
            if (Number(Boolean(a.done)) !== Number(Boolean(b.done))) return a.done ? 1 : -1;
            if (b.importance !== a.importance) return b.importance - a.importance;
            return Date.parse(a.created) - Date.parse(b.created);
          })
          .slice(0, args.limit);
        if (todos.length === 0) return "No todos. Add one with action=add, title=\"...\".";
        return [
          `# Todos (${todos.length})`,
          ...todos.map(
            (m) =>
              `- [${m.done ? "x" : " "}] [${m.id}] **${m.title}**${m.content ? ` — ${oneLine(m.content, 180)}` : ""}`,
          ),
        ].join("\n");
      }),
  );

  server.registerTool(
    "log_work",
    {
      title: "Log completed work",
      description:
        "Append a short, timestamped work-log entry (what changed, which files, commands, outcome, next steps). Call this before ending a session so the next agent can resume without re-reading everything.",
      inputSchema: {
        summary: z.string().min(3).max(3000).describe("What was done and why, in 1-4 sentences."),
        files: z.array(z.string().max(300)).max(50).optional(),
        commands: z.array(z.string().max(300)).max(30).optional(),
        outcome: z.enum(["success", "partial", "failed"]).default("success"),
        duration_min: z.number().min(0).max(10_000).optional(),
        next_steps: z.array(z.string().max(300)).max(10).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) =>
      run(() => {
        const log = hub.project.addWorkLog({
          summary: args.summary,
          files: args.files,
          commands: args.commands,
          outcome: args.outcome,
          durationMin: args.duration_min,
          nextSteps: args.next_steps,
        });
        return `Logged [${log.id}] (${log.outcome}). It is now in project_brief's "Recent work".`;
      }),
  );

  server.registerTool(
    "context_pack",
    {
      title: "Pack relevant context",
      description:
        "Given a concrete question, return a token-budgeted pack of the most relevant code excerpts (with path:line citations) plus matching project memories. Use this BEFORE broad greps or reading whole files; it cuts token use and round trips.",
      inputSchema: {
        query: z
          .string()
          .min(2)
          .max(500)
          .describe("Concrete question or identifiers, e.g. \"where is the OAuth token refreshed\"."),
        budget_tokens: z.number().int().min(300).max(12000).default(1500),
        max_files: z.number().int().min(1).max(12).default(6),
        include_memories: z.boolean().default(true),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) =>
      run(() => {
        const result = packContext(cfg, hub, {
          query: args.query,
          budgetTokens: args.budget_tokens,
          maxFiles: args.max_files,
          includeMemories: args.include_memories,
        });
        return result.text;
      }),
  );

  server.registerTool(
    "status",
    {
      title: "Server and store status",
      description:
        "Show the detected project root, store paths, memory/todo/worklog counts, git state, and limits. Use when setting up the server or debugging why nothing is recalled.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () =>
      run(() => buildStatus(cfg, hub)),
  );
}
