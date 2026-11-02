import { readFileSync } from "node:fs";
import path from "node:path";
import { isSensitive, listProjectFiles } from "./fs-util.js";
import { toPosix, type Config } from "./paths.js";
import type { StoreHub } from "./store.js";
import {
  coverage,
  estimateTokens,
  expandTerms,
  fenceFor,
  oneLine,
  redactSecrets,
  tf,
  truncate,
  uniqueTerms,
} from "./text.js";

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "is", "are", "was", "were",
  "how", "what", "why", "for", "with", "on", "at", "by", "from", "this", "that",
  "it", "be", "as", "do", "does", "did", "can", "could", "should", "would",
  "i", "we", "you", "my", "our", "your", "me", "us", "about", "into", "when",
  "where", "which", "who", "will", "not", "no", "yes", "please", "help",
]);

const SOURCE_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "rs", "go", "java", "kt",
  "kts", "c", "h", "cc", "cpp", "hpp", "cs", "php", "swift", "scala", "lua",
  "sh", "ps1", "sql", "vue", "svelte", "dart", "ex", "exs", "zig",
]);

function queryTerms(query: string): string[] {
  const all = uniqueTerms(query);
  const filtered = all.filter((t) => !(STOPWORDS.has(t) && all.length > 2));
  return filtered.length ? filtered : all;
}

interface Candidate {
  rel: string;
  size: number;
  ext: string;
  mtimeMs: number;
  content: string;
  pathScore: number;
  score: number;
}

interface Window {
  start: number;
  end: number;
}

function findWindows(
  lines: string[],
  terms: string[],
): { windows: Window[]; hits: number; best: Window | null } {
  const hitLines: number[] = [];
  const hitTerms = new Map<number, Set<string>>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.toLowerCase() ?? "";
    const matched = terms.filter((t) => line.includes(t));
    if (matched.length) {
      hitLines.push(i);
      hitTerms.set(i, new Set(matched));
    }
    if (hitLines.length >= 400) break;
  }
  if (hitLines.length === 0) return { windows: [], hits: 0, best: null };

  // Small files are cheap: return the whole thing instead of teasing out windows.
  if (lines.length <= 70) {
    const whole = { start: 0, end: lines.length - 1 };
    return { windows: [whole], hits: hitLines.length, best: whole };
  }

  const ranges: { start: number; end: number; hits: number[] }[] = [];
  let start = Math.max(0, (hitLines[0] ?? 0) - 2);
  let end = Math.min(lines.length - 1, (hitLines[0] ?? 0) + 2);
  let currentHits: number[] = [hitLines[0] ?? 0];
  for (const hit of hitLines.slice(1)) {
    if (hit - end <= 5) {
      end = Math.min(lines.length - 1, hit + 2);
      currentHits.push(hit);
    } else {
      ranges.push({ start, end, hits: currentHits });
      start = Math.max(0, hit - 2);
      end = Math.min(lines.length - 1, hit + 2);
      currentHits = [hit];
    }
  }
  ranges.push({ start, end, hits: currentHits });

  // Prefer dense windows that cover multiple query terms, not just the first hits.
  const ranked = ranges
    .map((range) => {
      const distinct = new Set<string>();
      for (const hit of range.hits) {
        for (const term of hitTerms.get(hit) ?? []) distinct.add(term);
      }
      return { range, score: distinct.size * 10 + range.hits.length };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
  const best = ranked[0]?.range ?? null;
  const scored = ranked.map((x) => x.range).sort((a, b) => a.start - b.start);

  let totalLines = scored.reduce((sum, w) => sum + (w.end - w.start + 1), 0);
  while (totalLines > 90 && scored.length > 1) {
    const removed = scored.pop();
    if (!removed) break;
    totalLines -= removed.end - removed.start + 1;
  }
  return { windows: scored, hits: hitLines.length, best };
}

function renderWindows(rel: string, ext: string, lines: string[], windows: Window[]): string {
  const lang = fenceFor(ext);
  const blocks: string[] = [];
  for (const w of windows) {
    const body = lines.slice(w.start, w.end + 1).join("\n");
    if (!body.trim()) continue;
    blocks.push(
      `### ${rel}:${w.start + 1}-${w.end + 1}\n\`\`\`${lang}\n${body}\n\`\`\``,
    );
  }
  return blocks.join("\n\n");
}

export interface PackResult {
  text: string;
  filesScanned: number;
  filesMatched: number;
  filesIncluded: number;
  memoriesIncluded: number;
  estimatedTokens: number;
  truncated: boolean;
}

export function packContext(
  cfg: Config,
  hub: StoreHub,
  opts: { query: string; budgetTokens?: number; maxFiles?: number; includeMemories?: boolean },
): PackResult {
  if (!cfg.codeSearch) {
    throw new Error("Code search is disabled (CTXKEEPER_DISABLE_CODE_SEARCH=1).");
  }
  const query = opts.query.trim();
  if (!query) throw new Error("query must not be empty.");
  const budgetTokens = Math.min(12_000, Math.max(300, opts.budgetTokens ?? 1500));
  const maxChars = budgetTokens * 3;
  const maxFiles = Math.min(12, Math.max(1, opts.maxFiles ?? 6));
  const terms = expandTerms(queryTerms(query));
  if (terms.length === 0) throw new Error("query contains no searchable terms.");

  const { files } = listProjectFiles(cfg.root);
  const fileSet = new Set(files.map((f) => f.rel));
  const memoryHits =
    opts.includeMemories === false ? [] : hub.recall({ query, limit: 6, scope: "all" });

  // Memories often contain the bridge between a natural-language question and
  // code (e.g. Chinese question -> English identifier). Boost files they cite.
  const fileBoost = new Map<string, number>();
  const addBoost = (raw: string, weight: number) => {
    const rel = raw.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!rel || rel.startsWith("..") || /^[A-Za-z]:/.test(rel)) return;
    if (!fileSet.has(rel)) return;
    fileBoost.set(rel, (fileBoost.get(rel) ?? 0) + weight);
  };
  memoryHits.forEach((hit, index) => {
    const weight = index === 0 ? 10 : 6;
    for (const file of hit.memory.files) addBoost(file, weight);
    for (const match of hit.memory.content.matchAll(/[\w.-]+(?:\/[\w.-]+)+\.\w{1,6}/g)) {
      const found = match[0];
      if (found) addBoost(found, weight * 0.6);
    }
  });

  // A Chinese question ("事件日志怎么回放") rarely appears verbatim in English
  // code. Borrow identifiers from the matching memories to locate the window.
  const bridgeTerms = new Set(terms);
  for (const hit of memoryHits.slice(0, 3)) {
    for (const match of hit.memory.content.matchAll(/[A-Za-z][A-Za-z0-9_.-]{3,}/g)) {
      const term = match[0]?.toLowerCase();
      if (term && !STOPWORDS.has(term)) bridgeTerms.add(term);
    }
  }
  const bridgeList = [...bridgeTerms].slice(0, 80);

  const candidates: Candidate[] = [];
  let scanned = 0;
  let readBudget = 24 * 1024 * 1024;

  const pathScores = new Map<string, number>();
  for (const f of files) {
    const lower = f.rel.toLowerCase();
    const p = tf(lower, terms) * 2.5 + coverage(lower, terms) * 8;
    if (p > 0) pathScores.set(f.rel, p);
  }

  const ordered = [...files].sort((a, b) => {
    const pa = (pathScores.get(a.rel) ?? 0) + (fileBoost.get(a.rel) ?? 0);
    const pb = (pathScores.get(b.rel) ?? 0) + (fileBoost.get(b.rel) ?? 0);
    if (pb !== pa) return pb - pa;
    const sa = SOURCE_EXTS.has(a.ext) ? 1 : 0;
    const sb = SOURCE_EXTS.has(b.ext) ? 1 : 0;
    if (sb !== sa) return sb - sa;
    return a.size - b.size;
  });

  for (const f of ordered) {
    if (readBudget <= 0 || scanned >= 6000) break;
    if (f.size > cfg.maxFileBytes) continue;
    if (isSensitive(f.rel)) continue;
    let content = "";
    try {
      content = readFileSync(path.join(cfg.root, f.rel), "utf8");
    } catch {
      continue;
    }
    readBudget -= f.size;
    scanned++;
    const lower = content.toLowerCase();
    const contentTf = tf(lower, terms);
    const contentCov = coverage(lower, terms);
    const pathScore = pathScores.get(f.rel) ?? 0;
    const boost = fileBoost.get(f.rel) ?? 0;
    if (contentTf === 0 && pathScore === 0 && boost === 0) continue;
    let score = pathScore + contentTf + contentCov * 8 + boost;
    if (SOURCE_EXTS.has(f.ext)) score *= 1.15;
    if (/(^|\/)(tests?|__tests__|spec)\//.test(f.rel) || /\.(test|spec)\./.test(f.rel)) {
      score *= 0.85;
    }
    candidates.push({
      rel: toPosix(f.rel),
      size: f.size,
      ext: f.ext,
      mtimeMs: f.mtimeMs,
      content,
      pathScore,
      score,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const chosen = candidates.filter((c) => c.score > 1.5).slice(0, maxFiles);

  const memoryLines: string[] = [];
  let memoriesIncluded = 0;
  if (opts.includeMemories !== false) {
    let memoryChars = 0;
    for (const hit of memoryHits) {
      const line = `- **${hit.memory.type}** \`${hit.memory.id}\` ${hit.memory.title} — ${oneLine(
        hit.memory.content,
        320,
      )}`;
      if (memoryChars + line.length > maxChars * 0.28) break;
      memoryLines.push(line);
      memoryChars += line.length + 1;
      memoriesIncluded++;
    }
  }
  const memorySection = memoryLines.length
    ? `\n## Relevant memory\n${memoryLines.join("\n")}\n`
    : "";
  // Header, headings and footer cost roughly 420 chars; when there are no
  // memories, all of the remaining budget goes to code.
  const codeBudget = Math.max(400, maxChars - memorySection.length - 420);

  const sections: string[] = [];
  let used = 0;
  let omitted = 0;
  const perFile = Math.max(900, Math.floor(codeBudget / Math.min(Math.max(chosen.length, 1), 3)));
  for (const c of chosen) {
    const lines = c.content.split(/\r?\n/);
    const boost = fileBoost.get(c.rel) ?? 0;
    let found = findWindows(lines, terms);
    if (found.windows.length === 0 && boost > 0) {
      found = findWindows(lines, bridgeList);
    }
    if (found.windows.length === 0 && boost > 0) {
      const maxLines = Math.max(12, Math.floor(perFile / 42));
      found = {
        windows: [{ start: 0, end: Math.min(lines.length - 1, maxLines - 1) }],
        hits: 0,
        best: null,
      };
    }
    if (found.windows.length === 0) continue;
    let block = renderWindows(c.rel, c.ext, lines, found.windows);
    if (block.length > perFile && found.best) {
      block = renderWindows(c.rel, c.ext, lines, [found.best]);
    }
    if (block.length === 0) continue;
    if (
      (block.length > perFile || used + block.length > codeBudget) &&
      sections.length > 0
    ) {
      omitted++;
      continue;
    }
    const clipped =
      used + block.length > codeBudget ? truncate(block, codeBudget - used) : block;
    sections.push(clipped);
    used += clipped.length;
    if (used >= codeBudget) break;
  }

  const header = [
    `# Context pack: ${query}`,
    `root: ${cfg.root} | files scanned: ${scanned}/${files.length} | matched: ${candidates.length} | included: ${sections.length}`,
    `budget: ~${budgetTokens} tokens (estimated ${0} used)`,
  ].join("\n");

  const codeSection = sections.length
    ? `\n## Code\n\n${sections.join("\n\n")}\n`
    : "\n## Code\n\nNo focused code excerpts matched. Try different identifiers, or call `project_brief` for the repo map.\n";

  let text = `${header}${memorySection}${codeSection}`;
  if (omitted > 0) {
    text += `\n_${omitted} more matching file(s) omitted to stay within budget._\n`;
  }
  text += `\n---\nRead only the cited ranges before widening the search. Prefer \`recall\` for prior decisions and \`log_work\` when done.\n`;

  const estimatedTokens = estimateTokens(text);
  text = text.replace("estimated 0 used", `estimated ${estimatedTokens} used`);
  text = redactSecrets(text);
  if (estimateTokens(text) > budgetTokens * 1.15) {
    text = truncate(text, maxChars, "\n… [context pack truncated to budget]");
  }

  return {
    text,
    filesScanned: scanned,
    filesMatched: candidates.length,
    filesIncluded: sections.length,
    memoriesIncluded,
    estimatedTokens: estimateTokens(text),
    truncated: omitted > 0,
  };
}
