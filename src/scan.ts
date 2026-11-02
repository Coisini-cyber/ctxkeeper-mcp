import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { LANG_BY_EXT, extOf, IGNORED_DIRS, listProjectFiles } from "./fs-util.js";
import { toPosix, type Config } from "./paths.js";
import type { GitInfo, ManifestInfo, RepoScan } from "./types.js";

function readText(file: string, maxBytes = 256 * 1024): string {
  try {
    const st = statSync(file);
    if (st.size > maxBytes) {
      const buf = readFileSync(file);
      return buf.subarray(0, maxBytes).toString("utf8");
    }
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function parsePackageJson(root: string): ManifestInfo | null {
  const file = path.join(root, "package.json");
  if (!existsSync(file)) return null;
  try {
    const pkg = JSON.parse(readText(file)) as Record<string, unknown>;
    const deps = Object.keys({
      ...(pkg.dependencies as Record<string, string> | undefined),
      ...(pkg.devDependencies as Record<string, string> | undefined),
    });
    return {
      file: "package.json",
      name: typeof pkg.name === "string" ? pkg.name : undefined,
      scripts: (pkg.scripts as Record<string, string> | undefined) ?? {},
      deps,
      packageManager: typeof pkg.packageManager === "string" ? pkg.packageManager : undefined,
    };
  } catch {
    return { file: "package.json", scripts: {}, deps: [] };
  }
}

function parsePyproject(root: string): ManifestInfo | null {
  const file = path.join(root, "pyproject.toml");
  if (!existsSync(file)) return null;
  const text = readText(file);
  const name = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(text)?.[1];
  const deps: string[] = [];
  const depBlock = /^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(text)?.[1];
  if (depBlock) {
    for (const m of depBlock.matchAll(/["']([A-Za-z0-9_.\-]+)/g)) {
      if (m[1]) deps.push(m[1]);
    }
  }
  return { file: "pyproject.toml", name, scripts: {}, deps, packageManager: "pip" };
}

function parseRequirements(root: string): ManifestInfo | null {
  const file = path.join(root, "requirements.txt");
  if (!existsSync(file)) return null;
  const deps = readText(file, 64 * 1024)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("-"))
    .map((l) => l.split(/[<>=!~[;\s]/)[0] ?? "")
    .filter(Boolean)
    .slice(0, 200);
  return { file: "requirements.txt", scripts: {}, deps, packageManager: "pip" };
}

function parseCargo(root: string): ManifestInfo | null {
  const file = path.join(root, "Cargo.toml");
  if (!existsSync(file)) return null;
  const text = readText(file);
  const name = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(text)?.[1];
  const deps: string[] = [];
  const section = /^\[(?:dev-|build-)?dependencies\]([\s\S]*?)(?=^\[|\z)/m.exec(text)?.[1];
  if (section) {
    for (const line of section.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z0-9_\-]+)\s*=/.exec(line);
      if (m?.[1]) deps.push(m[1]);
    }
  }
  return { file: "Cargo.toml", name, scripts: {}, deps, packageManager: "cargo" };
}

function parseGoMod(root: string): ManifestInfo | null {
  const file = path.join(root, "go.mod");
  if (!existsSync(file)) return null;
  const text = readText(file);
  const name = /^module\s+(\S+)/m.exec(text)?.[1];
  const deps = [...text.matchAll(/^\s*(?:require\s+)?([a-z0-9.\-]+\.[a-z]{2,}\/\S+)\s+v/mg)]
    .map((m) => m[1] ?? "")
    .filter(Boolean)
    .slice(0, 100);
  return { file: "go.mod", name, scripts: {}, deps, packageManager: "go" };
}

function parseComposer(root: string): ManifestInfo | null {
  const file = path.join(root, "composer.json");
  if (!existsSync(file)) return null;
  try {
    const pkg = JSON.parse(readText(file)) as Record<string, unknown>;
    return {
      file: "composer.json",
      name: typeof pkg.name === "string" ? pkg.name : undefined,
      scripts: {},
      deps: Object.keys((pkg.require as Record<string, string> | undefined) ?? {}),
      packageManager: "composer",
    };
  } catch {
    return null;
  }
}

function parseMakefile(root: string): ManifestInfo | null {
  const file = path.join(root, "Makefile");
  if (!existsSync(file)) return null;
  const scripts: Record<string, string> = {};
  for (const line of readText(file, 64 * 1024).split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_.\-]+)\s*:(?!=)/.exec(line);
    if (m?.[1] && !m[1].startsWith(".") && Object.keys(scripts).length < 30) {
      scripts[m[1]] = `make ${m[1]}`;
    }
  }
  return { file: "Makefile", scripts, deps: [] };
}

function parseDockerfile(root: string): ManifestInfo | null {
  for (const name of ["Dockerfile", "Containerfile"]) {
    const file = path.join(root, name);
    if (!existsSync(file)) continue;
    const base = /^\s*FROM\s+(\S+)/im.exec(readText(file, 32 * 1024))?.[1];
    return { file: name, scripts: {}, deps: base ? [base] : [] };
  }
  return null;
}

function parsePom(root: string): ManifestInfo | null {
  const file = path.join(root, "pom.xml");
  if (!existsSync(file)) return null;
  const text = readText(file);
  return {
    file: "pom.xml",
    name: /<artifactId>([^<]+)<\/artifactId>/.exec(text)?.[1],
    scripts: {},
    deps: [],
    packageManager: "maven",
  };
}

const FRAMEWORK_MAP: Record<string, string> = {
  next: "Next.js",
  react: "React",
  "react-dom": "React",
  vue: "Vue",
  nuxt: "Nuxt",
  svelte: "Svelte",
  "@angular/core": "Angular",
  astro: "Astro",
  express: "Express",
  fastify: "Fastify",
  "@nestjs/core": "NestJS",
  hono: "Hono",
  electron: "Electron",
  tauri: "Tauri",
  prisma: "Prisma",
  "@supabase/supabase-js": "Supabase",
  tailwindcss: "Tailwind CSS",
  django: "Django",
  flask: "Flask",
  fastapi: "FastAPI",
  sqlalchemy: "SQLAlchemy",
  pandas: "pandas",
  numpy: "NumPy",
  torch: "PyTorch",
  tensorflow: "TensorFlow",
  "spring-boot": "Spring Boot",
  rails: "Rails",
  laravel: "Laravel",
  gin: "Gin",
  echo: "Echo",
  fiber: "Fiber",
  axum: "Axum",
  tokio: "Tokio",
  actix: "Actix",
};

function detectFrameworks(manifests: ManifestInfo[], root: string): string[] {
  const deps = new Set(manifests.flatMap((m) => m.deps.map((d) => d.toLowerCase())));
  const found = new Set<string>();
  for (const [dep, label] of Object.entries(FRAMEWORK_MAP)) {
    if ([...deps].some((d) => d === dep || d.startsWith(`${dep}/`))) found.add(label);
  }
  if (existsSync(path.join(root, ".github", "workflows"))) found.add("GitHub Actions");
  if (existsSync(path.join(root, "Dockerfile")) || existsSync(path.join(root, "docker-compose.yml"))) {
    found.add("Docker");
  }
  if (existsSync(path.join(root, "terraform"))) found.add("Terraform");
  return [...found].slice(0, 12);
}

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 4 * 1024 * 1024,
  }).trim();
}

function readGit(root: string): GitInfo {
  try {
    const inside = git(root, ["rev-parse", "--is-inside-work-tree"]);
    if (inside !== "true") return { available: false, commits: [] };
    const repoTop = path.resolve(git(root, ["rev-parse", "--show-toplevel"]));
    const distance = path
      .relative(repoTop, path.resolve(root))
      .split(/[\\/]+/)
      .filter(Boolean).length;
    const home = path.resolve(homedir());
    if (
      distance > 2 ||
      (repoTop.toLowerCase() === home.toLowerCase() &&
        path.resolve(root).toLowerCase() !== home.toLowerCase())
    ) {
      return {
        available: false,
        commits: [],
        error: "project root is not a git repository root",
      };
    }
    let branch = "";
    try {
      branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
      if (branch === "HEAD") branch = git(root, ["rev-parse", "--short", "HEAD"]);
    } catch {
      branch = "unknown";
    }
    let dirty = 0;
    try {
      const status = git(root, ["status", "--porcelain=v1"]);
      dirty = status ? status.split(/\r?\n/).filter(Boolean).length : 0;
    } catch {
      /* ignore */
    }
    let remote: string | undefined;
    try {
      const raw = git(root, ["remote", "get-url", "origin"]);
      remote = raw.replace(/\/\/[^/@\s]+@/, "//");
    } catch {
      remote = undefined;
    }
    const commits: GitInfo["commits"] = [];
    try {
      const log = git(root, ["log", "-8", "--date=short", "--pretty=format:%h%x09%ad%x09%s"]);
      for (const line of log.split(/\r?\n/)) {
        const [hash, date, ...rest] = line.split("\t");
        if (hash && date) commits.push({ hash, date, subject: rest.join(" ") });
      }
    } catch {
      /* ignore */
    }
    return { available: true, branch, dirty, remote, commits };
  } catch {
    return { available: false, commits: [], error: "git not available or not a repository" };
  }
}

function topLevel(root: string): RepoScan["topLevel"] {
  const entries: RepoScan["topLevel"] = [];
  let list;
  try {
    list = readdirSync(root, { withFileTypes: true });
  } catch {
    return entries;
  }
  list.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const entry of list) {
    if (entries.length >= 24) break;
    if (IGNORED_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith(".") && entry.name !== ".github" && entry.name !== ".claude") {
      continue;
    }
    if (entry.isDirectory()) {
      let count = 0;
      const stack: { dir: string; depth: number }[] = [{ dir: path.join(root, entry.name), depth: 0 }];
      while (stack.length && count < 400) {
        const item = stack.pop();
        if (!item || item.depth > 3) continue;
        try {
          for (const child of readdirSync(item.dir, { withFileTypes: true })) {
            if (child.isDirectory()) {
              if (!child.name.startsWith(".") && !["node_modules", "dist", "build", "target", "__pycache__", ".git"].includes(child.name)) {
                stack.push({ dir: path.join(item.dir, child.name), depth: item.depth + 1 });
              }
            } else count++;
          }
        } catch {
          /* ignore */
        }
      }
      entries.push({ name: entry.name, kind: "dir", files: count });
    } else if (entry.isFile()) {
      entries.push({ name: entry.name, kind: "file" });
    }
  }
  return entries;
}

const READ_FIRST_RE = [
  /^(src\/)?(index|main|app|server|cli|bootstrap)\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|cs|php|rb)$/,
  /^(main|app|manage|server|wsgi|asgi)\.py$/,
  /^cmd\/[^/]+\/main\.go$/,
  /^src\/main\.(rs|java|kt)$/,
  /^src\/lib\.rs$/,
  /^Program\.cs$/,
  /^src\/app\.(vue|svelte)$/,
];

function readFirst(root: string, files: { rel: string }[], manifests: ManifestInfo[]): string[] {
  const out: string[] = [];
  const add = (rel: string) => {
    const norm = toPosix(rel).replace(/^\.\//, "");
    if (!norm) return;
    const top = norm.split("/")[0] ?? "";
    if (IGNORED_DIRS.has(top)) return;
    if (!out.includes(norm)) out.push(norm);
  };
  for (const m of manifests) {
    if (m.file === "package.json") {
      try {
        const pkg = JSON.parse(readText(path.join(root, "package.json"))) as Record<string, unknown>;
        const main = typeof pkg.main === "string" ? pkg.main : "";
        if (main) add(main);
        const bin = pkg.bin;
        if (typeof bin === "string") add(bin);
        else if (bin && typeof bin === "object") {
          for (const v of Object.values(bin as Record<string, string>)) add(v);
        }
      } catch {
        /* ignore */
      }
    }
  }
  for (const f of files) {
    if (out.length >= 8) break;
    if (READ_FIRST_RE.some((re) => re.test(f.rel))) add(f.rel);
  }
  return out.slice(0, 8);
}

const KEY_DOCS = [
  "README.md",
  "README",
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "ARCHITECTURE.md",
  "docs/README.md",
  "docs/index.md",
  "docs/architecture.md",
];

function keyDocs(root: string): string[] {
  return KEY_DOCS.filter((rel) => existsSync(path.join(root, rel)));
}

let cache: { root: string; at: number; data: RepoScan } | null = null;

export function invalidateScan(): void {
  cache = null;
}

export function scanRepo(cfg: Config): RepoScan {
  const { root } = cfg;
  const { files, truncated } = listProjectFiles(root);
  const manifests = [
    parsePackageJson(root),
    parsePyproject(root),
    parseRequirements(root),
    parseCargo(root),
    parseGoMod(root),
    parseComposer(root),
    parsePom(root),
    parseMakefile(root),
    parseDockerfile(root),
  ].filter((m): m is ManifestInfo => m !== null);

  const byExt = new Map<string, { files: number; loc: number }>();
  let bytes = 0;
  let totalLoc = 0;
  let readBudget = 20 * 1024 * 1024;
  let estimated = false;
  let counted = 0;

  for (const f of files) {
    bytes += f.size;
    const lang = LANG_BY_EXT[f.ext];
    if (!lang) continue;
    let loc = 0;
    if (f.size <= cfg.maxFileBytes && readBudget > 0 && counted < 5000) {
      try {
        const text = readFileSync(path.join(root, f.rel), "utf8");
        readBudget -= f.size;
        counted++;
        loc = text.split("\n").length;
      } catch {
        loc = 0;
      }
    } else {
      loc = Math.max(1, Math.ceil(f.size / 45));
      estimated = true;
    }
    totalLoc += loc;
    const cur = byExt.get(f.ext) ?? { files: 0, loc: 0 };
    cur.files++;
    cur.loc += loc;
    byExt.set(f.ext, cur);
  }

  const languages = [...byExt.entries()]
    .map(([ext, v]) => ({ ext, files: v.files, loc: v.loc, lang: LANG_BY_EXT[ext] ?? ext }))
    .sort((a, b) => b.loc - a.loc)
    .slice(0, 10)
    .map(({ ext, files: n, loc }) => ({ ext, files: n, loc }));

  return {
    root,
    generatedAt: new Date().toISOString(),
    files: files.length,
    bytes,
    loc: totalLoc,
    languages,
    manifests,
    frameworks: detectFrameworks(manifests, root),
    git: readGit(root),
    topLevel: topLevel(root),
    readFirst: readFirst(root, files, manifests),
    keyDocs: keyDocs(root),
    truncated: truncated || estimated,
  };
}

export function scanRepoCached(cfg: Config, force = false): RepoScan {
  if (!force && cache && cache.root === cfg.root && Date.now() - cache.at < cfg.cacheTtlMs) {
    return cache.data;
  }
  const data = scanRepo(cfg);
  cache = { root: cfg.root, at: Date.now(), data };
  return data;
}
