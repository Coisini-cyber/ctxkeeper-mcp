const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;

/** Split identifiers (camelCase, snake_case, kebab-case) into searchable terms. */
export function identifierParts(word: string): string[] {
  const parts: string[] = [];
  for (const chunk of word.split(/[_\-./\\]+/)) {
    if (!chunk) continue;
    const camel = chunk
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/\s+/)
      .filter(Boolean);
    parts.push(...camel);
  }
  return parts;
}

/**
 * Tokenize mixed English/Chinese text. CJK runs also emit bigrams so that
 * Chinese queries match without a dictionary-based segmenter.
 */
export function tokenize(input: string): string[] {
  const out: string[] = [];
  const text = input.toLowerCase();
  for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const word = match[0];
    if (!word) continue;
    if (CJK.test(word)) {
      out.push(word);
      if (word.length > 2) {
        for (let i = 0; i < word.length - 1; i++) out.push(word.slice(i, i + 2));
      } else if (word.length === 2) {
        out.push(word);
      }
      continue;
    }
    for (const part of identifierParts(word)) {
      if (part.length >= 2 || /^\d+$/.test(part)) out.push(part.toLowerCase());
    }
    if (out.length === 0 && word.length > 0) out.push(word);
  }
  return out;
}

export function uniqueTerms(input: string): string[] {
  return [...new Set(tokenize(input))].filter((t) => t.length > 0);
}

/**
 * Light stemming for English query terms so "scored"/"scoring" still match
 * "score" in code. Chinese terms are already handled as bigrams.
 */
export function expandTerms(terms: string[]): string[] {
  const out = new Set<string>();
  for (const t of terms) {
    out.add(t);
    if (t.length > 4 && t.endsWith("ies")) out.add(t.slice(0, -3) + "y");
    if (t.length > 4 && t.endsWith("ed")) {
      out.add(t.slice(0, -2));
      out.add(t.slice(0, -1));
    }
    if (t.length > 5 && t.endsWith("ing")) {
      out.add(t.slice(0, -3));
      out.add(t.slice(0, -3) + "e");
    }
    if (t.length > 4 && t.endsWith("s") && !t.endsWith("ss")) out.add(t.slice(0, -1));
  }
  return [...out];
}

export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1 && count < 50) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/** Soft term-frequency: repeated matches matter, but with diminishing returns. */
export function tf(haystack: string, terms: string[]): number {
  const lower = haystack.toLowerCase();
  let score = 0;
  for (const term of terms) {
    const c = countOccurrences(lower, term);
    if (c > 0) score += 1 + Math.log(c);
  }
  return score;
}

export function coverage(haystack: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const lower = haystack.toLowerCase();
  let hit = 0;
  for (const term of terms) if (lower.includes(term)) hit++;
  return hit / terms.length;
}

export function recencyBoost(iso: string, now = Date.now()): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0.8;
  const days = Math.max(0, (now - t) / 86_400_000);
  return 0.7 + 0.3 * Math.exp(-days / 45);
}

export function truncate(text: string, maxChars: number, marker = "\n… [truncated]"): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  let cut = text.slice(0, Math.max(0, maxChars - marker.length));
  const nl = cut.lastIndexOf("\n");
  if (nl > maxChars * 0.5) cut = cut.slice(0, nl);
  return cut + marker;
}

export function oneLine(text: string, maxChars = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return truncate(flat, maxChars, "…");
}

export function estimateTokens(text: string): number {
  // Conservative for mixed Chinese/English: ~3 chars per token.
  return Math.ceil(text.length / 3);
}

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
];

/** Redact only high-confidence credential shapes, to avoid mangling code. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[REDACTED]");
  return out;
}

export function fenceFor(ext: string): string {
  const map: Record<string, string> = {
    ts: "ts",
    tsx: "tsx",
    js: "js",
    jsx: "jsx",
    mjs: "js",
    cjs: "js",
    py: "python",
    rb: "ruby",
    rs: "rust",
    go: "go",
    java: "java",
    kt: "kotlin",
    kts: "kotlin",
    c: "c",
    h: "c",
    cc: "cpp",
    cpp: "cpp",
    hpp: "cpp",
    cs: "csharp",
    php: "php",
    swift: "swift",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    ps1: "powershell",
    sql: "sql",
    json: "json",
    jsonc: "jsonc",
    yml: "yaml",
    yaml: "yaml",
    toml: "toml",
    md: "md",
    html: "html",
    css: "css",
    scss: "scss",
    vue: "vue",
    svelte: "svelte",
    lua: "lua",
    dart: "dart",
    tex: "tex",
    proto: "proto",
    graphql: "graphql",
  };
  return map[ext] ?? "";
}
