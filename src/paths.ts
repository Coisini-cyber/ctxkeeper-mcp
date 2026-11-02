import { existsSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

export interface Config {
  root: string;
  projectDir: string;
  globalDir: string;
  maxFileBytes: number;
  codeSearch: boolean;
  cacheTtlMs: number;
}

const MANIFESTS = [
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  "Gemfile",
  "CMakeLists.txt",
  "Makefile",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
];

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function hasManifest(dir: string): boolean {
  return MANIFESTS.some((m) => existsSync(path.join(dir, m)));
}

/**
 * Walk up from cwd looking for a project marker. Prefers an explicit
 * CTXKEEPER_ROOT, then .git / .ctxkeeper / a known manifest.
 */
export function detectRoot(start = process.cwd()): string {
  const explicit = process.env.CTXKEEPER_ROOT?.trim();
  if (explicit) return path.resolve(explicit);

  let dir = path.resolve(start);
  const fallback = dir;
  const home = path.resolve(homedir());
  for (let i = 0; i < 12; i++) {
    if (existsSync(path.join(dir, ".ctxkeeper")) || hasManifest(dir)) {
      return dir;
    }
    // A repo marker is a good root, but never adopt the user's home directory
    // (often an incidental dotfiles repo) or a temp directory as a project.
    if (existsSync(path.join(dir, ".git")) && dir !== home && !isTempLike(dir)) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir || dir === home) break;
    dir = parent;
  }
  return fallback;
}

function isTempLike(dir: string): boolean {
  const p = path.resolve(dir).toLowerCase();
  const tmp = path.resolve(tmpdir()).toLowerCase();
  return p === tmp || p.startsWith(tmp + path.sep);
}

export function loadConfig(): Config {
  const root = detectRoot();
  const projectDir = path.resolve(
    process.env.CTXKEEPER_DIR?.trim() || path.join(root, ".ctxkeeper"),
  );
  const globalDir = path.resolve(
    process.env.CTXKEEPER_GLOBAL_DIR?.trim() ||
      path.join(homedir(), ".ctxkeeper", "global"),
  );
  const maxKb = Number(process.env.CTXKEEPER_MAX_FILE_KB ?? "300");
  return {
    root,
    projectDir,
    globalDir,
    maxFileBytes: Number.isFinite(maxKb) && maxKb > 0 ? maxKb * 1024 : 300 * 1024,
    codeSearch: process.env.CTXKEEPER_DISABLE_CODE_SEARCH !== "1",
    cacheTtlMs: 30_000,
  };
}

/** Ensure a path stays inside the configured root. */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}
