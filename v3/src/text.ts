const STOP_WORDS = new Set([
  'able',
  'about',
  'after',
  'allow',
  'also',
  'and',
  'are',
  'for',
  'from',
  'have',
  'into',
  'need',
  'needs',
  'that',
  'the',
  'their',
  'then',
  'this',
  'through',
  'when',
  'where',
  'while',
  'with',
]);

export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(' ')
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

export function uniqueTokens(value: string): string[] {
  return Array.from(new Set(tokenize(value)));
}

export function overlapScore(query: string, target: string, weight = 1): number {
  const queryTokens = uniqueTokens(query);
  if (!queryTokens.length) return 0;
  const targetTokens = new Set(uniqueTokens(target));
  const matches = queryTokens.filter((token) => targetTokens.has(token)).length;
  return (matches / queryTokens.length) * weight;
}

export function splitSentences(value: string): string[] {
  return value
    .split(/(?<=[.!?])\s+|\n+/)
    .map((line) => line.replace(/^[-*\d.)\s]+/, '').trim())
    .filter((line) => line.length >= 20);
}

export function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

export function toSentenceCase(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

export function compact(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 13)).trimEnd()}...[trimmed]`;
}

