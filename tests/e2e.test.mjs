import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = path.resolve("dist/index.js");

function makeFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "ctxkeeper-"));
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name: "fixture-app",
        version: "1.0.0",
        scripts: { build: "tsc -p .", test: "node --test", dev: "tsx watch src/index.ts" },
        dependencies: { express: "^4.19.0" },
      },
      null,
      2,
    ),
  );
  writeFileSync(path.join(dir, "README.md"), "# Fixture App\n\nA tiny auth service.\n");
  writeFileSync(
    path.join(dir, "src", "auth.ts"),
    [
      "// Token helpers for the fixture service.",
      "export interface Session { token: string; expiresAt: number }",
      "",
      "export function refreshToken(session: Session): Session {",
      "  // REFRESH_MARKER_42 rotates the token before expiry.",
      "  return { ...session, token: session.token + ':refreshed' };",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(dir, "src", "index.ts"),
    [
      "import { refreshToken } from './auth.js';",
      "const session = { token: 'abc', expiresAt: 0 };",
      "console.log(refreshToken(session));",
      "",
    ].join("\n"),
  );
  writeFileSync(path.join(dir, ".env"), "SECRET_DO_NOT_LEAK=super-secret-value\n");
  return dir;
}

function textOf(result) {
  return (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

test("ctxkeeper end-to-end over stdio", async (t) => {
  const root = makeFixture();
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => typeof v === "string"),
  );
  env.CTXKEEPER_ROOT = root;
  env.CTXKEEPER_DIR = path.join(root, ".ctxkeeper");
  env.CTXKEEPER_GLOBAL_DIR = path.join(root, ".ctxkeeper-global");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env,
    cwd: root,
    stderr: "pipe",
  });
  const client = new Client({ name: "ctxkeeper-test", version: "0.0.1" });
  await client.connect(transport);

  try {
    await t.test("advertises the expected tools and instructions", async () => {
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map((tool) => tool.name).sort(),
        [
          "context_pack",
          "forget",
          "log_work",
          "project_brief",
          "recall",
          "remember",
          "status",
          "todo",
        ],
      );
      const init = client.getServerVersion();
      assert.equal(init?.name, "ctxkeeper");
      assert.ok(client.getInstructions()?.includes("project_brief"));
      for (const tool of tools) {
        assert.ok(tool.description && tool.description.length > 20, `${tool.name} has a description`);
        assert.ok(tool.inputSchema, `${tool.name} has an input schema`);
      }
    });

    await t.test("project_brief detects stack, commands and files", async () => {
      const res = await client.callTool({
        name: "project_brief",
        arguments: { budget_tokens: 1200 },
      });
      assert.ok(!res.isError, textOf(res));
      const text = textOf(res);
      assert.match(text, /fixture-app/);
      assert.match(text, /TypeScript/);
      assert.match(text, /Express/);
      assert.match(text, /npm run build/);
      assert.match(text, /npm run test/);
      assert.match(text, /src\/index\.ts|src\/auth\.ts/);
      assert.ok(text.length < 1200 * 3 + 500, "brief respects its budget");
    });

    await t.test("remember deduplicates and recall ranks", async () => {
      const first = await client.callTool({
        name: "remember",
        arguments: {
          type: "decision",
          title: "Refresh tokens before expiry",
          content: "Sessions must call refreshToken 60s before expiresAt; see src/auth.ts.",
          tags: ["auth", "session"],
          files: ["src/auth.ts"],
          importance: 4,
        },
      });
      assert.ok(!first.isError, textOf(first));
      const id = /\[(m_[a-z0-9]+)\]/.exec(textOf(first))?.[1];
      assert.ok(id, "returns a memory id");

      const duplicate = await client.callTool({
        name: "remember",
        arguments: {
          type: "decision",
          title: "Refresh tokens before expiry",
          content: "Sessions must call refreshToken 60s before expiresAt; see src/auth.ts.",
        },
      });
      assert.match(textOf(duplicate), /no duplicate written/);

      const hit = await client.callTool({
        name: "recall",
        arguments: { query: "refresh token expiry", limit: 5 },
      });
      assert.ok(!hit.isError, textOf(hit));
      assert.match(textOf(hit), /Refresh tokens before expiry/);
      assert.match(textOf(hit), /src\/auth\.ts/);
    });

    await t.test("todo lifecycle", async () => {
      const add = await client.callTool({
        name: "todo",
        arguments: { action: "add", title: "Add refresh endpoint", content: "POST /auth/refresh", importance: 5 },
      });
      assert.match(textOf(add), /Added todo \[(m_[a-z0-9]+)\]/);
      const id = /\[(m_[a-z0-9]+)\]/.exec(textOf(add))?.[1];

      const list = await client.callTool({ name: "todo", arguments: { action: "list" } });
      assert.match(textOf(list), /Add refresh endpoint/);
      assert.match(textOf(list), /\[ \]/);

      const done = await client.callTool({ name: "todo", arguments: { action: "done", id } });
      assert.match(textOf(done), /Closed/);

      const open = await client.callTool({ name: "todo", arguments: { action: "list" } });
      assert.doesNotMatch(textOf(open), /Add refresh endpoint/);

      const all = await client.callTool({
        name: "todo",
        arguments: { action: "list", include_done: true },
      });
      assert.match(textOf(all), /\[x\].*Add refresh endpoint/);
    });

    await t.test("context_pack returns focused excerpts and never leaks .env", async () => {
      const res = await client.callTool({
        name: "context_pack",
        arguments: { query: "REFRESH_MARKER_42", budget_tokens: 1200 },
      });
      assert.ok(!res.isError, textOf(res));
      const text = textOf(res);
      assert.match(text, /src\/auth\.ts:\d+-\d+/);
      assert.match(text, /REFRESH_MARKER_42/);
      assert.match(text, /estimated \d+ used/);

      const leak = await client.callTool({
        name: "context_pack",
        arguments: { query: "SECRET_DO_NOT_LEAK", budget_tokens: 800 },
      });
      assert.doesNotMatch(textOf(leak), /super-secret-value/);
      assert.doesNotMatch(textOf(leak), /\.env/);
    });

    await t.test("context_pack bridges a Chinese query through memory to code", async () => {
      await client.callTool({
        name: "remember",
        arguments: {
          type: "decision",
          title: "刷新令牌的实现位置",
          content: "刷新令牌时调用 refreshToken，具体实现见 src/auth.ts。",
          files: ["src/auth.ts"],
          tags: ["认证"],
          importance: 4,
        },
      });
      const res = await client.callTool({
        name: "context_pack",
        arguments: { query: "刷新令牌在哪里实现", budget_tokens: 1000 },
      });
      const text = textOf(res);
      assert.match(text, /src\/auth\.ts/);
      assert.match(text, /refreshToken/);
    });

    await t.test("log_work appears in the brief", async () => {
      const log = await client.callTool({
        name: "log_work",
        arguments: {
          summary: "Implemented token refresh and wired it into the index entrypoint.",
          files: ["src/auth.ts", "src/index.ts"],
          commands: ["npm test"],
          outcome: "success",
          next_steps: ["Add the refresh endpoint"],
        },
      });
      assert.match(textOf(log), /Logged \[(w_[a-z0-9]+)\]/);

      const brief = await client.callTool({
        name: "project_brief",
        arguments: { budget_tokens: 2000, refresh: true },
      });
      const text = textOf(brief);
      assert.match(text, /Recent work/);
      assert.match(text, /Implemented token refresh/);
      assert.match(text, /next: Add the refresh endpoint/);
    });

    await t.test("forget archives and can restore", async () => {
      const list = await client.callTool({
        name: "recall",
        arguments: { query: "Refresh tokens", limit: 5 },
      });
      const id = /\[(m_[a-z0-9]+)\]/.exec(textOf(list))?.[1];
      assert.ok(id);

      const forget = await client.callTool({
        name: "forget",
        arguments: { id },
      });
      assert.match(textOf(forget), /Archived/);

      const gone = await client.callTool({
        name: "recall",
        arguments: { query: "Refresh tokens", limit: 5 },
      });
      assert.doesNotMatch(textOf(gone), new RegExp(id));

      const restore = await client.callTool({
        name: "forget",
        arguments: { id, restore: true },
      });
      assert.match(textOf(restore), /Restored/);

      const back = await client.callTool({
        name: "recall",
        arguments: { query: "Refresh tokens", limit: 5 },
      });
      assert.match(textOf(back), new RegExp(id));
    });

    await t.test("status and resource expose diagnostics", async () => {
      const status = await client.callTool({ name: "status", arguments: {} });
      const text = textOf(status);
      assert.match(text, /ctxkeeper 0\.1\.0/);
      assert.match(text, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(text, /active memories/);

      const resources = await client.listResources();
      assert.ok(resources.resources.some((r) => r.uri === "ctxkeeper://brief"));

      const brief = await client.readResource({ uri: "ctxkeeper://brief" });
      const content = brief.contents[0];
      assert.equal(content.mimeType, "text/markdown");
      assert.match(content.text, /Project brief/);
    });
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});
