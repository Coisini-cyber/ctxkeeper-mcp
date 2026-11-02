export type MemoryType =
  | "decision"
  | "gotcha"
  | "fact"
  | "command"
  | "todo"
  | "note";

export type Scope = "project" | "global";

export interface Memory {
  id: string;
  type: MemoryType;
  title: string;
  content: string;
  tags: string[];
  files: string[];
  importance: number;
  scope: Scope;
  created: string;
  updated: string;
  archived?: boolean;
  done?: boolean;
  source?: string;
  replaces?: string;
}

export interface WorkLog {
  id: string;
  summary: string;
  files: string[];
  commands: string[];
  outcome: "success" | "partial" | "failed";
  durationMin?: number;
  nextSteps: string[];
  created: string;
  scope: Scope;
}

export interface StoreEvent {
  v: 1;
  ts: string;
  kind: "memory.add" | "memory.archive" | "memory.unarchive" | "todo.set" | "worklog.add";
  data: unknown;
}

export interface GitInfo {
  available: boolean;
  branch?: string;
  dirty?: number;
  remote?: string;
  commits: { hash: string; date: string; subject: string }[];
  error?: string;
}

export interface ManifestInfo {
  file: string;
  name?: string;
  scripts: Record<string, string>;
  deps: string[];
  packageManager?: string;
}

export interface FileInfo {
  rel: string;
  size: number;
  ext: string;
  mtimeMs: number;
}

export interface RepoScan {
  root: string;
  generatedAt: string;
  files: number;
  bytes: number;
  loc: number;
  languages: { ext: string; files: number; loc: number }[];
  manifests: ManifestInfo[];
  frameworks: string[];
  git: GitInfo;
  topLevel: { name: string; kind: "dir" | "file"; files?: number }[];
  readFirst: string[];
  keyDocs: string[];
  truncated: boolean;
}
