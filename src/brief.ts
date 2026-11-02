import { scanRepoCached } from "./scan.js";
import { LANG_BY_EXT } from "./fs-util.js";
import { toPosix, type Config } from "./paths.js";
import type { Memory } from "./types.js";
import type { StoreHub } from "./store.js";
import { estimateTokens, oneLine, truncate } from "./text.js";

export interface BriefResult {
  text: string;
  estimatedTokens: number;
  counts: {
    files: number;
    memories: number;
    todos: number;
    worklogs: number;
  };
}

function pct(part: number, total: number): string {
  if (total <= 0) return "0%";
  return `${Math.round((part / total) * 100)}%`;
}

function languageLine(cfg: Config): { stack: string; name: string } {
  const scan = scanRepoCached(cfg);
  const name =
    scan.manifests.find((m) => m.name)?.name?.split("/").pop() ||
    toPosix(cfg.root).split("/").filter(Boolean).pop() ||
    "project";
  const totalLoc = scan.loc || 1;
  const langs = scan.languages
    .slice(0, 3)
    .map((l) => {
      const label = LANG_BY_EXT[l.ext] ?? l.ext;
      return `${label} ${pct(l.loc, totalLoc)}`;
    })
    .join(" · ");
  const meta = [
    `${scan.files.toLocaleString("en-US")} files`,
    scan.loc >= 1000 ? `~${(scan.loc / 1000).toFixed(1)}k LOC` : `${scan.loc} LOC`,
    scan.truncated ? "scan capped" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const fw = scan.frameworks.length ? ` · ${scan.frameworks.slice(0, 5).join(", ")}` : "";
  return { stack: `${langs || "unknown language"}${fw} · ${meta}`, name };
}

function commandList(cfg: Config, commandMemories: Memory[]): string[] {
  const scan = scanRepoCached(cfg);
  const out: string[] = [];
  const add = (label: string, cmd: string) => {
    if (!cmd || out.some((x) => x.endsWith(`\`${cmd}\``))) return;
    out.push(`- ${label}: \`${cmd}\``);
  };

  const pkg = scan.manifests.find((m) => m.file === "package.json");
  if (pkg) {
    const pm = pkg.packageManager?.split("@")[0] || "npm";
    const prefixes: Record<string, string> = {
      pnpm: "pnpm",
      yarn: "yarn",
      bun: "bun",
      npm: "npm run",
    };
    const prefix = prefixes[pm] ?? "npm run";
    const order = ["dev", "build", "test", "lint", "typecheck", "check", "start"];
    const entries = Object.entries(pkg.scripts);
    entries.sort((a, b) => {
      const ia = order.indexOf(a[0]);
      const ib = order.indexOf(b[0]);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
    for (const [name, cmd] of entries.slice(0, 8)) {
      add(name, `${prefix} ${name}`);
      void cmd;
    }
  }
  const make = scan.manifests.find((m) => m.file === "Makefile");
  if (make) for (const name of Object.keys(make.scripts).slice(0, 6)) add(`make ${name}`, `make ${name}`);
  if (scan.manifests.some((m) => m.file === "Cargo.toml")) {
    add("build", "cargo build");
    add("test", "cargo test");
  }
  if (scan.manifests.some((m) => m.file === "go.mod")) {
    add("build", "go build ./...");
    add("test", "go test ./...");
  }
  if (
    scan.manifests.some((m) => m.file === "pyproject.toml" || m.file === "requirements.txt") &&
    !pkg
  ) {
    add("test", "pytest");
  }
  for (const m of commandMemories.slice(0, 4)) {
    const cmd = m.content.trim().split(/\r?\n/)[0] ?? "";
    if (cmd) add(oneLine(m.title, 40), oneLine(cmd, 120));
  }
  return out.slice(0, 12);
}

function structureLine(cfg: Config): string {
  const scan = scanRepoCached(cfg);
  return scan.topLevel
    .slice(0, 18)
    .map((e) => (e.kind === "dir" ? `${e.name}/ (${e.files ?? 0})` : e.name))
    .join(" · ");
}

function memoryBullet(m: Memory, detail: number): string {
  return `- [${m.id}] **${m.title}** — ${oneLine(m.content, detail)}`;
}

export function buildBrief(
  cfg: Config,
  hub: StoreHub,
  opts: { budgetTokens?: number } = {},
): BriefResult {
  const budgetTokens = Math.min(8000, Math.max(400, opts.budgetTokens ?? 1200));
  const maxChars = budgetTokens * 3;
  const scan = scanRepoCached(cfg);
  const { stack, name } = languageLine(cfg);

  const projectMemories = hub.project.memoriesAll().filter((m) => !m.archived);
  const globalMemories = hub.global.memoriesAll().filter((m) => !m.archived);
  const todos = projectMemories
    .filter((m) => m.type === "todo" && !m.done)
    .sort((a, b) => b.importance - a.importance || Date.parse(a.created) - Date.parse(b.created));
  const decisions = projectMemories
    .filter((m) => m.type === "decision")
    .sort(
      (a, b) =>
        b.importance - a.importance || Date.parse(b.updated) - Date.parse(a.updated),
    );
  const gotchas = projectMemories
    .filter((m) => m.type === "gotcha")
    .sort((a, b) => b.importance - a.importance || Date.parse(b.updated) - Date.parse(a.updated));
  const facts = projectMemories
    .filter((m) => m.type === "fact" || m.type === "note")
    .sort((a, b) => b.importance - a.importance || Date.parse(b.updated) - Date.parse(a.updated));
  const commandMemories = projectMemories.filter((m) => m.type === "command");
  const logs = hub.worklogs(5);
  const globalTop = globalMemories
    .filter((m) => m.type === "fact" || m.type === "decision" || m.type === "gotcha")
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 3);

  const git = scan.git;
  const gitLine = git.available
    ? `${git.branch ?? "?"}${git.dirty ? ` · ${git.dirty} uncommitted` : " · clean"}`
    : "no git";
  const header = `# Project brief: ${name}\n${cfg.root} · ${gitLine} · ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
  const stackSection = `stack: ${stack}`;
  const readFirst = [...scan.readFirst, ...scan.keyDocs]
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .slice(0, 8);

  const render = (detail: number): string[] => {
    const parts: string[] = [header, "", stackSection];
    if (readFirst.length) parts.push(`read first: ${readFirst.map((f) => `\`${f}\``).join(", ")}`);
    const cmds = commandList(cfg, commandMemories);
    if (cmds.length) parts.push("", "## Commands", ...cmds);
    if (todos.length) {
      parts.push("", `## Open TODOs (${todos.length})`);
      parts.push(...todos.slice(0, 12).map((m) => memoryBullet(m, detail)));
      if (todos.length > 12) parts.push(`- … ${todos.length - 12} more (use \`recall\` with types=["todo"])`);
    }
    if (decisions.length) {
      parts.push("", `## Decisions (${decisions.length})`);
      parts.push(...decisions.slice(0, 10).map((m) => memoryBullet(m, detail)));
    }
    if (gotchas.length) {
      parts.push("", `## Gotchas (${gotchas.length})`);
      parts.push(...gotchas.slice(0, 10).map((m) => memoryBullet(m, detail)));
    }
    if (facts.length) {
      parts.push("", "## Notes");
      parts.push(...facts.slice(0, 6).map((m) => memoryBullet(m, detail)));
    }
    if (logs.length) {
      parts.push("", "## Recent work");
      for (const log of logs) {
        const date = log.created.slice(0, 10);
        const files = log.files.length ? ` · files: ${log.files.slice(0, 4).join(", ")}` : "";
        const next = log.nextSteps.length
          ? ` · next: ${log.nextSteps.slice(0, 3).map((s) => oneLine(s, 90)).join("; ")}`
          : "";
        parts.push(`- ${date} [${log.outcome}] ${oneLine(log.summary, detail + 40)}${files}${next}`);
      }
    }
    if (globalTop.length) {
      parts.push("", "## Global preferences");
      parts.push(...globalTop.map((m) => memoryBullet(m, detail)));
    }
    const structure = structureLine(cfg);
    if (structure) parts.push("", "## Structure", structure);
    const commits = git.available ? git.commits.slice(0, 3) : [];
    if (commits.length) {
      parts.push("", "## Latest commits");
      parts.push(...commits.map((c) => `- ${c.date} ${c.hash} ${oneLine(c.subject, 100)}`));
    }
    return parts;
  };

  let sections = render(260);
  let text = sections.join("\n");
  if (text.length > maxChars) {
    sections = render(120);
    text = sections.join("\n");
  }
  if (text.length > maxChars) {
    // Drop optional tail sections before truncating meaningful content.
    const cutoff = sections.findIndex((s) => s === "## Structure");
    if (cutoff > 0) {
      sections = sections.slice(0, cutoff);
      text = sections.join("\n");
    }
  }
  if (text.length > maxChars) {
    const recent = sections.findIndex((s) => s === "## Recent work");
    if (recent > 0) {
      sections = sections.slice(0, recent);
      text = sections.join("\n");
    }
  }
  if (text.length > maxChars) text = truncate(text, maxChars, "\n… [brief truncated to budget]");

  text += `\n\n---\nNext: call \`context_pack\` with a concrete question before broad greps; use \`remember\` for decisions/gotchas and \`log_work\` when you finish.`;

  const counts = {
    files: scan.files,
    memories: projectMemories.length + globalMemories.length,
    todos: todos.length,
    worklogs: logs.length,
  };
  return { text, estimatedTokens: estimateTokens(text), counts };
}
