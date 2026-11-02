import type { Config } from "./paths.js";
import { scanRepoCached } from "./scan.js";
import type { StoreHub } from "./store.js";
import { VERSION } from "./version.js";

/** Shared by the `status` MCP tool and the `--doctor` CLI command. */
export function buildStatus(cfg: Config, hub: StoreHub): string {
  const stats = hub.stats();
  const scan = scanRepoCached(cfg);
  return [
    `# ctxkeeper ${VERSION}`,
    `root: ${cfg.root}`,
    `project store: ${cfg.projectDir}`,
    `global store: ${cfg.globalDir}`,
    `project: ${stats.project.memories} active memories · ${stats.project.openTodos} open todos · ${stats.project.worklogs} worklogs · ${stats.project.badLines} bad log lines`,
    `global: ${stats.global.memories} active memories · ${stats.global.worklogs} worklogs`,
    `git: ${scan.git.available ? `${scan.git.branch} (${scan.git.dirty ?? 0} uncommitted)` : "unavailable"}`,
    `scan: ${scan.files} files, ~${scan.loc} LOC${scan.truncated ? " (capped)" : ""}`,
    `code search: ${cfg.codeSearch ? "on" : "off"} · max file ${Math.round(cfg.maxFileBytes / 1024)} KB`,
    `root override: ${process.env.CTXKEEPER_ROOT ? "CTXKEEPER_ROOT" : "auto-detected"}`,
  ].join("\n");
}
