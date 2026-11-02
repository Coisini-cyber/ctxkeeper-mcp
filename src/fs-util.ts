import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { FileInfo } from "./types.js";
import { toPosix } from "./paths.js";

export const IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".ctxkeeper",
  "node_modules",
  "bower_components",
  "dist",
  "build",
  "out",
  "output",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".parcel-cache",
  "target",
  "vendor",
  "coverage",
  ".venv",
  "venv",
  "env",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".idea",
  ".vs",
  ".vscode",
  ".gradle",
  "bin",
  "obj",
  "tmp",
  "temp",
  "logs",
  "Pods",
  "DerivedData",
  ".terraform",
]);

export const LANG_BY_EXT: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  py: "Python",
  rb: "Ruby",
  rs: "Rust",
  go: "Go",
  java: "Java",
  kt: "Kotlin",
  kts: "Kotlin",
  c: "C",
  h: "C",
  cc: "C++",
  cpp: "C++",
  hpp: "C++",
  cs: "C#",
  php: "PHP",
  swift: "Swift",
  m: "Objective-C",
  mm: "Objective-C",
  scala: "Scala",
  lua: "Lua",
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  ps1: "PowerShell",
  bat: "Batch",
  cmd: "Batch",
  sql: "SQL",
  html: "HTML",
  css: "CSS",
  scss: "SCSS",
  sass: "SCSS",
  less: "LESS",
  vue: "Vue",
  svelte: "Svelte",
  astro: "Astro",
  dart: "Dart",
  ex: "Elixir",
  exs: "Elixir",
  erl: "Erlang",
  hs: "Haskell",
  clj: "Clojure",
  cljs: "Clojure",
  zig: "Zig",
  nim: "Nim",
  jl: "Julia",
  r: "R",
  sol: "Solidity",
};

const TEXT_EXTS = new Set([
  ...Object.keys(LANG_BY_EXT),
  "json",
  "jsonc",
  "json5",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "properties",
  "md",
  "mdx",
  "txt",
  "rst",
  "tex",
  "proto",
  "graphql",
  "gql",
  "prisma",
  "env.example",
  "gitignore",
  "dockerignore",
  "editorconfig",
]);

const SPECIAL_TEXT_NAMES = new Set([
  "Makefile",
  "makefile",
  "Dockerfile",
  "Containerfile",
  "Procfile",
  "Gemfile",
  "Rakefile",
  "CMakeLists.txt",
  "Justfile",
  "justfile",
  "LICENSE",
  "NOTICE",
  "AGENTS.md",
  "CLAUDE.md",
  "README",
  "README.md",
]);

const SENSITIVE = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)[^/]*\.(pem|key|p12|pfx|jks|keystore)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.|$)/i,
  /(^|\/)(\.npmrc|\.pypirc|\.netrc|credentials|secrets?\.(json|ya?ml|toml))$/i,
];

export function isSensitive(rel: string): boolean {
  const posix = toPosix(rel);
  return SENSITIVE.some((re) => re.test(posix));
}

export function extOf(name: string): string {
  const base = name.toLowerCase();
  if (base.endsWith(".env.example")) return "env.example";
  const idx = base.lastIndexOf(".");
  return idx > 0 ? base.slice(idx + 1) : "";
}

export function isTextCandidate(name: string): boolean {
  if (SPECIAL_TEXT_NAMES.has(name)) return true;
  return TEXT_EXTS.has(extOf(name));
}

export interface ListOptions {
  maxFiles?: number;
  maxDepth?: number;
}

/** Deterministic project walk. Never follows symlinks, never leaves the root. */
export function listProjectFiles(root: string, opts: ListOptions = {}): {
  files: FileInfo[];
  truncated: boolean;
} {
  const maxFiles = opts.maxFiles ?? 20_000;
  const maxDepth = opts.maxDepth ?? 14;
  const files: FileInfo[] = [];
  let truncated = false;

  const walk = (dir: string, depth: number): void => {
    if (truncated || depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (truncated) return;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith(".") && entry.name !== ".github" && entry.name !== ".claude") {
          continue;
        }
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isTextCandidate(entry.name)) continue;
      if (isSensitive(entry.name)) continue;
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.size > 2_000_000) continue;
      files.push({
        rel: toPosix(path.relative(root, full)),
        size: st.size,
        ext: extOf(entry.name),
        mtimeMs: st.mtimeMs,
      });
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
    }
  };

  walk(root, 0);
  return { files, truncated };
}
