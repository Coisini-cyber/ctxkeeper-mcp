#!/usr/bin/env node
/**
 * Dev helper: connect to the built server over stdio and print a brief,
 * a context pack, and status. Usage:
 *   node scripts/demo.mjs [projectRoot] ["question"]
 */
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(process.argv[2] ?? process.cwd());
const question = process.argv[3] ?? "how does the server work";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve("dist/index.js")],
  cwd: root,
  env: { ...process.env, CTXKEEPER_ROOT: root },
  stderr: "inherit",
});
const client = new Client({ name: "ctxkeeper-demo", version: "0.0.1" });
await client.connect(transport);

const show = async (name, args) => {
  const started = Date.now();
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  console.log(`\n===== ${name} (${Date.now() - started} ms) =====\n`);
  console.log(text);
};

await show("status", {});
await show("project_brief", { budget_tokens: 1200 });
await show("context_pack", { query: question, budget_tokens: 1200, max_files: 4 });
await client.close();
