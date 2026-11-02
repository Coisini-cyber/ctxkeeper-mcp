import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import path from "node:path";
import type { Memory, MemoryType, Scope, StoreEvent, WorkLog } from "./types.js";
import { recencyBoost, tf, uniqueTerms } from "./text.js";

export interface RecallOptions {
  query?: string;
  types?: MemoryType[];
  tags?: string[];
  scope?: Scope | "all";
  includeArchived?: boolean;
  includeDone?: boolean;
  limit?: number;
}

export interface RecallHit {
  memory: Memory;
  scope: Scope;
  score: number;
}

function newId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 7);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

function fingerprint(type: string, title: string, content: string): string {
  const norm = `${type}\n${title}\n${content}`
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha1").update(norm).digest("hex");
}

export class Store {
  readonly scope: Scope;
  readonly dir: string;
  readonly file: string;
  private memories = new Map<string, Memory>();
  private worklogs: WorkLog[] = [];
  private size = -1;
  private mtimeMs = -1;
  private badLines = 0;
  private seenLogs = new Set<string>();
  private initialized = false;

  constructor(scope: Scope, dir: string) {
    this.scope = scope;
    this.dir = dir;
    this.file = path.join(dir, "events.jsonl");
  }

  init(): void {
    if (!this.initialized) {
      mkdirSync(this.dir, { recursive: true });
      const ignoreFile = path.join(this.dir, ".gitignore");
      if (!existsSync(ignoreFile)) {
        try {
          appendFileSync(ignoreFile, "*\n", "utf8");
        } catch {
          /* best effort */
        }
      }
      this.initialized = true;
    }
    // Cheap stat + conditional reload keeps multiple clients in sync.
    this.refresh();
  }

  /** Reload if another client appended since the last read. */
  refresh(force = false): void {
    let size = 0;
    let mtimeMs = 0;
    try {
      const st = statSync(this.file);
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      this.size = 0;
      this.mtimeMs = 0;
      return;
    }
    if (!force && size === this.size && mtimeMs === this.mtimeMs) return;
    this.memories.clear();
    this.worklogs = [];
    this.seenLogs.clear();
    this.badLines = 0;
    this.size = size;
    this.mtimeMs = mtimeMs;

    let raw = "";
    try {
      raw = readFileSync(this.file, "utf8");
    } catch {
      return;
    }
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        this.apply(JSON.parse(line) as StoreEvent);
      } catch {
        this.badLines++;
      }
    }
  }

  private apply(event: StoreEvent): void {
    if (!event || event.v !== 1) return;
    switch (event.kind) {
      case "memory.add": {
        const m = event.data as Memory;
        if (m && typeof m.id === "string") this.memories.set(m.id, m);
        break;
      }
      case "memory.archive": {
        const { id } = event.data as { id: string };
        const m = this.memories.get(id);
        if (m) {
          m.archived = true;
          m.updated = event.ts;
        }
        break;
      }
      case "memory.unarchive": {
        const { id } = event.data as { id: string };
        const m = this.memories.get(id);
        if (m) {
          m.archived = false;
          m.updated = event.ts;
        }
        break;
      }
      case "todo.set": {
        const { id, done } = event.data as { id: string; done: boolean };
        const m = this.memories.get(id);
        if (m) {
          m.done = done;
          m.updated = event.ts;
        }
        break;
      }
      case "worklog.add": {
        const log = event.data as WorkLog;
        if (log && typeof log.id === "string" && !this.seenLogs.has(log.id)) {
          this.seenLogs.add(log.id);
          this.worklogs.push(log);
        }
        break;
      }
      default:
        break;
    }
  }

  private append(kind: StoreEvent["kind"], data: unknown): StoreEvent {
    this.init();
    const event: StoreEvent = { v: 1, ts: new Date().toISOString(), kind, data };
    appendFileSync(this.file, JSON.stringify(event) + "\n", "utf8");
    this.apply(event);
    try {
      const st = statSync(this.file);
      this.size = st.size;
      this.mtimeMs = st.mtimeMs;
    } catch {
      /* ignore */
    }
    return event;
  }

  addMemory(input: {
    type: MemoryType;
    title: string;
    content: string;
    tags?: string[];
    files?: string[];
    importance?: number;
    source?: string;
    replaces?: string;
  }): { memory: Memory; duplicate: boolean } {
    this.init();
    const title = input.title.trim();
    const content = input.content.trim();
    const fp = fingerprint(input.type, title, content);
    for (const m of this.memories.values()) {
      if (m.archived) continue;
      if (fingerprint(m.type, m.title, m.content) === fp) {
        return { memory: m, duplicate: true };
      }
    }

    if (input.replaces) {
      const old = this.memories.get(input.replaces);
      if (old && !old.archived) {
        this.append("memory.archive", { id: old.id });
      }
    }

    const now = new Date().toISOString();
    const memory: Memory = {
      id: newId("m"),
      type: input.type,
      title,
      content,
      tags: (input.tags ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 20),
      files: (input.files ?? []).map((f) => f.trim()).filter(Boolean).slice(0, 40),
      importance: Math.min(5, Math.max(1, Math.round(input.importance ?? 3))),
      scope: this.scope,
      created: now,
      updated: now,
      source: input.source?.slice(0, 80),
      ...(input.replaces ? { replaces: input.replaces } : {}),
    };
    this.append("memory.add", memory);
    return { memory, duplicate: false };
  }

  archive(id: string): Memory {
    this.init();
    const m = this.memories.get(id);
    if (!m) throw new Error(`No memory with id "${id}" in the ${this.scope} store.`);
    if (!m.archived) this.append("memory.archive", { id });
    return m;
  }

  unarchive(id: string): Memory {
    this.init();
    const m = this.memories.get(id);
    if (!m) throw new Error(`No memory with id "${id}" in the ${this.scope} store.`);
    if (m.archived) this.append("memory.unarchive", { id });
    return m;
  }

  setDone(id: string, done: boolean): Memory {
    this.init();
    const m = this.memories.get(id);
    if (!m) throw new Error(`No memory with id "${id}" in the ${this.scope} store.`);
    if (m.type !== "todo") throw new Error(`Memory "${id}" is a ${m.type}, not a todo.`);
    this.append("todo.set", { id, done });
    return m;
  }

  addWorkLog(input: {
    summary: string;
    files?: string[];
    commands?: string[];
    outcome?: WorkLog["outcome"];
    durationMin?: number;
    nextSteps?: string[];
  }): WorkLog {
    this.init();
    const log: WorkLog = {
      id: newId("w"),
      summary: input.summary.trim(),
      files: (input.files ?? []).slice(0, 50),
      commands: (input.commands ?? []).slice(0, 30),
      outcome: input.outcome ?? "success",
      durationMin: input.durationMin,
      nextSteps: (input.nextSteps ?? []).slice(0, 10),
      created: new Date().toISOString(),
      scope: this.scope,
    };
    this.append("worklog.add", log);
    return log;
  }

  memoriesAll(): Memory[] {
    this.init();
    return [...this.memories.values()];
  }

  worklogsAll(): WorkLog[] {
    this.init();
    return [...this.worklogs];
  }

  stats(): { memories: number; archived: number; openTodos: number; worklogs: number; badLines: number } {
    const all = this.memoriesAll();
    const archived = all.filter((m) => m.archived).length;
    const openTodos = all.filter((m) => m.type === "todo" && !m.archived && !m.done).length;
    return {
      memories: all.filter((m) => !m.archived).length,
      archived,
      openTodos,
      worklogs: this.worklogs.length,
      badLines: this.badLines,
    };
  }
}

export class StoreHub {
  readonly project: Store;
  readonly global: Store;

  constructor(projectDir: string, globalDir: string) {
    this.project = new Store("project", projectDir);
    this.global = new Store("global", globalDir);
  }

  init(): void {
    this.project.init();
    this.global.init();
  }

  private stores(scope: Scope | "all"): Store[] {
    if (scope === "project") return [this.project];
    if (scope === "global") return [this.global];
    return [this.project, this.global];
  }

  remember(
    input: Parameters<Store["addMemory"]>[0],
    scope: Scope,
  ): { memory: Memory; duplicate: boolean } {
    return (scope === "global" ? this.global : this.project).addMemory(input);
  }

  forget(id: string, scope: "project" | "global" | "all" = "all"): Memory {
    for (const store of this.stores(scope)) {
      try {
        return store.archive(id);
      } catch {
        /* try next */
      }
    }
    throw new Error(`No memory with id "${id}" in scope "${scope}".`);
  }

  restore(id: string, scope: "project" | "global" | "all" = "all"): Memory {
    for (const store of this.stores(scope)) {
      try {
        return store.unarchive(id);
      } catch {
        /* try next */
      }
    }
    throw new Error(`No memory with id "${id}" in scope "${scope}".`);
  }

  setDone(id: string, done: boolean, scope: Scope | "all" = "all"): Memory {
    for (const store of this.stores(scope)) {
      try {
        return store.setDone(id, done);
      } catch (err) {
        if (err instanceof Error && err.message.includes("not a todo")) throw err;
      }
    }
    throw new Error(`No memory with id "${id}".`);
  }

  recall(opts: RecallOptions = {}): RecallHit[] {
    const query = (opts.query ?? "").trim();
    const terms = uniqueTerms(query);
    const limit = Math.min(50, Math.max(1, opts.limit ?? 8));
    const hits: RecallHit[] = [];

    for (const store of this.stores(opts.scope ?? "all")) {
      for (const memory of store.memoriesAll()) {
        if (memory.archived && !opts.includeArchived) continue;
        if (memory.type === "todo" && memory.done && !opts.includeDone) continue;
        if (opts.types?.length && !opts.types.includes(memory.type)) continue;
        if (
          opts.tags?.length &&
          !opts.tags.every((tag) =>
            memory.tags.some((t) => t.toLowerCase() === tag.toLowerCase()),
          )
        ) {
          continue;
        }

        let score = 0;
        if (terms.length > 0) {
          const titleScore = tf(memory.title, terms) * 4;
          const tagScore = tf(memory.tags.join(" "), terms) * 3;
          const fileScore = tf(memory.files.join(" "), terms) * 2.5;
          const contentScore = tf(memory.content, terms);
          score = titleScore + tagScore + fileScore + contentScore;
          const haystack = `${memory.title} ${memory.tags.join(" ")} ${memory.files.join(" ")} ${memory.content}`;
          const covered = terms.filter((t) => haystack.toLowerCase().includes(t)).length / terms.length;
          if (terms.length <= 12 && covered < 0.25) score *= 0.3;
          if (memory.title.toLowerCase().includes(query.toLowerCase())) score *= 1.5;
          if (score <= 0) continue;
        }

        score *= 1 + 0.15 * (memory.importance - 3);
        score *= recencyBoost(memory.updated);
        hits.push({ memory, scope: store.scope, score: Math.round(score * 100) / 100 });
      }
    }

    hits.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.memory.importance !== a.memory.importance) {
        return b.memory.importance - a.memory.importance;
      }
      return Date.parse(b.memory.updated) - Date.parse(a.memory.updated);
    });
    if (terms.length > 0 && (hits[0]?.score ?? 0) > 0) {
      // Drop long-tail matches that only share one common word with the query.
      const floor = Math.max(0.5, (hits[0]?.score ?? 0) * 0.08);
      return hits.filter((h) => h.score >= floor).slice(0, limit);
    }
    return hits.slice(0, limit);
  }

  worklogs(limit = 6): WorkLog[] {
    return [...this.project.worklogsAll(), ...this.global.worklogsAll()]
      .sort((a, b) => Date.parse(b.created) - Date.parse(a.created))
      .slice(0, limit);
  }

  stats(): { project: ReturnType<Store["stats"]>; global: ReturnType<Store["stats"]> } {
    return { project: this.project.stats(), global: this.global.stats() };
  }
}
