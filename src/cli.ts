import { buildBrief } from "./brief.js";
import { packContext } from "./pack.js";
import { loadConfig } from "./paths.js";
import { buildStatus } from "./status.js";
import { StoreHub } from "./store.js";
import { VERSION } from "./version.js";

const HELP = `ctxkeeper ${VERSION} — local-first project memory for AI coding agents

Usage:
  ctxkeeper                      start the MCP stdio server (used by clients)
  ctxkeeper --brief              print the project brief
  ctxkeeper --pack "question"    print a token-budgeted context pack
  ctxkeeper --doctor             show root, store paths, and counts
  ctxkeeper --version            print the version
  ctxkeeper --help               show this help

Options:
  --tokens=N    token budget (brief default 1200, pack default 1500)
  --files=N     max files for --pack (default 6)

Environment:
  CTXKEEPER_ROOT          force the project root
  CTXKEEPER_DIR           project store directory
  CTXKEEPER_GLOBAL_DIR    global store directory
  CTXKEEPER_MAX_FILE_KB   max file size read into context (default 300)
  CTXKEEPER_DISABLE_CODE_SEARCH=1   expose memory tools only

Examples:
  ctxkeeper --brief
  ctxkeeper --pack "where is the token refreshed?"
  ctxkeeper --doctor
`;

function flagValue(args: string[], name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1) {
    const next = args[idx + 1];
    if (next && !next.startsWith("-")) return next;
  }
  return undefined;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

/**
 * Handle CLI-only commands. Returns true when the process should exit
 * instead of starting the stdio server.
 */
export function runCli(args: string[]): boolean {
  if (args.length === 0) return false;

  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(HELP);
    return true;
  }
  if (args.includes("--version") || args.includes("-V")) {
    process.stdout.write(`${VERSION}\n`);
    return true;
  }

  const wantsBrief = args.includes("--brief");
  const wantsPack = args.includes("--pack");
  const wantsDoctor = args.includes("--doctor");
  if (!wantsBrief && !wantsPack && !wantsDoctor) return false;

  const cfg = loadConfig();
  const hub = new StoreHub(cfg.projectDir, cfg.globalDir);
  try {
    hub.init();
  } catch (error) {
    process.stderr.write(
      `ctxkeeper: cannot initialize store at ${cfg.projectDir}: ${String(error)}\n`,
    );
    process.exitCode = 1;
    return true;
  }

  try {
    if (wantsDoctor) {
      process.stdout.write(`${buildStatus(cfg, hub)}\n`);
      return true;
    }

    if (wantsBrief) {
      const budget = positiveInt(flagValue(args, "tokens"), 1200);
      process.stdout.write(`${buildBrief(cfg, hub, { budgetTokens: budget }).text}\n`);
      return true;
    }

    const packIndex = args.indexOf("--pack");
    const query = args
      .slice(packIndex + 1)
      .filter((a) => !a.startsWith("-") && !/^\d+$/.test(a))
      .join(" ")
      .trim();
    if (!query) {
      process.stderr.write('ctxkeeper: --pack needs a question, e.g. --pack "where is auth?"\n');
      process.exitCode = 1;
      return true;
    }
    const result = packContext(cfg, hub, {
      query,
      budgetTokens: positiveInt(flagValue(args, "tokens"), 1500),
      maxFiles: positiveInt(flagValue(args, "files"), 6),
    });
    process.stdout.write(`${result.text}\n`);
    return true;
  } catch (error) {
    process.stderr.write(`ctxkeeper: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return true;
  }
}
