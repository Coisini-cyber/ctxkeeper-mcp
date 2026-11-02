#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildBrief } from "./brief.js";
import { loadConfig } from "./paths.js";
import { StoreHub } from "./store.js";
import { registerTools } from "./tools.js";
import { SERVER_NAME, VERSION } from "./version.js";

const cfg = loadConfig();
const hub = new StoreHub(cfg.projectDir, cfg.globalDir);
try {
  hub.init();
} catch (error) {
  process.stderr.write(
    `ctxkeeper: cannot initialize store at ${cfg.projectDir}: ${String(error)}\n` +
      `Set CTXKEEPER_DIR to a writable directory, or CTXKEEPER_ROOT to the project root.\n`,
  );
  process.exit(1);
}

const server = new McpServer(
  { name: SERVER_NAME, version: VERSION },
  {
    instructions: [
      "ctxkeeper is this project's durable memory. Workflow:",
      "1) At session start call `project_brief` (it replaces exploratory reads and returns stack, commands, TODOs, decisions, gotchas, recent work).",
      "2) Before broad greps or reading whole files call `context_pack` with a concrete question; it returns only relevant excerpts with path:line citations.",
      "3) When the user states a preference or you make a non-obvious decision, call `remember` (type=decision|gotcha|fact|command). Track pending work with `todo`.",
      "4) Before finishing, call `log_work` with what changed, files touched, commands run, and next steps.",
      "Keep stored entries concise and factual. Never store secrets, credentials, or full source files.",
    ].join("\n"),
  },
);

registerTools(server, cfg, hub);

server.registerResource(
  "project_brief",
  "ctxkeeper://brief",
  {
    title: "Project brief",
    description:
      "A token-budgeted onboarding brief for the current project (stack, commands, TODOs, decisions, gotchas, recent work).",
    mimeType: "text/markdown",
  },
  async (uri) => {
    const brief = buildBrief(cfg, hub, { budgetTokens: 1500 });
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: brief.text,
        },
      ],
    };
  },
);

server.registerPrompt(
  "onboard",
  {
    title: "Onboard this project",
    description: "Ask the agent to load the project brief and summarize the current state.",
  },
  async () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            "Use the ctxkeeper tools to get up to speed on this project:",
            "1. Call `project_brief`.",
            "2. Summarize the stack, how to run/test it, open TODOs, active decisions, and gotchas in under 15 lines.",
            "3. Ask me what to work on next. Do not read files or run commands until you have the brief.",
          ].join("\n"),
        },
      },
    ],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport).catch((error: unknown) => {
  process.stderr.write(`ctxkeeper failed to start: ${String(error)}\n`);
  process.exit(1);
});
