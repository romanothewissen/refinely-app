import { ClarifyAnswer, WiChunk, WiDoc } from '../types';

/** BM25 / lexical retrieval query length cap (keep token cost predictable). */
const MAX_RETRIEVAL_QUERY_CHARS = 1200;

function clarifyAnswerSnippet(answer: ClarifyAnswer): string {
  const parts: string[] = [];
  const main = String(answer.answer ?? '').replace(/\s+/g, ' ').trim();
  const custom = String(answer.customAnswer ?? '').replace(/\s+/g, ' ').trim();
  const sug = (answer.selectedSuggestions ?? []).filter(Boolean).join('; ');
  if (main) parts.push(main);
  if (custom) parts.push(`Additional: ${custom}`);
  if (sug) parts.push(`Signals: ${sug}`);
  return parts.join(' | ');
}

/**
 * Fused query for work-instruction BM25 and similar-story lexical retrieval.
 * Includes custom clarify text and selected suggestions so retrieval matches free-text nuance.
 */
export function deriveRetrievalQuery(
  requirement: string,
  attachmentText: string,
  clarifyAnswers?: ClarifyAnswer[],
): string {
  const requirementText = requirement?.trim() ?? '';
  const attachmentSnippet = (attachmentText?.trim() ?? '').slice(0, 800).replace(/\s+/g, ' ');
  let answerBlob = '';
  if (clarifyAnswers?.length) {
    answerBlob = clarifyAnswers
      .map(clarifyAnswerSnippet)
      .filter(Boolean)
      .join(' ')
      .slice(0, 800);
  }
  const joined = [requirementText, answerBlob, attachmentSnippet].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return joined.slice(0, MAX_RETRIEVAL_QUERY_CHARS);
}

/** Short query from triage output for a narrow second WI pass (merge-after-triage). */
export function buildTriageEnrichedWiQuery(triage: {
  reasoning?: string;
  deliveryForecast?: { featureTarget: number; featureMin?: number; featureMax?: number };
} | null): string {
  if (!triage?.reasoning?.trim()) return '';
  const r = triage.reasoning.replace(/\s+/g, ' ').trim().slice(0, 450);
  const df = triage.deliveryForecast;
  const span = df
    ? `${df.featureMin ?? df.featureTarget}-${df.featureMax ?? df.featureTarget}`
    : '';
  const suffix = span ? ` Expected capability breadth: ${span} features.` : '';
  return `${r}${suffix}`.slice(0, 900);
}

export function mergeWiContextResults(
  broad: { text: string; docs: WiDoc[]; chunks: WiChunk[] },
  narrow: { text: string; docs: WiDoc[]; chunks: WiChunk[] },
  maxChars: number,
): { text: string; docs: WiDoc[]; chunks: WiChunk[] } {
  const chunkKey = (c: WiChunk) => `${c.docId}:${c.chunkIndex}`;
  const seen = new Set(broad.chunks.map(chunkKey));
  const mergedChunks = [...broad.chunks];
  for (const c of narrow.chunks) {
    const k = chunkKey(c);
    if (!seen.has(k)) {
      seen.add(k);
      mergedChunks.push(c);
    }
  }
  const docsMap = new Map(broad.docs.map((d) => [d.docId, d]));
  for (const d of narrow.docs) docsMap.set(d.docId, d);
  let text = [broad.text.trim(), narrow.text.trim()].filter(Boolean).join('\n\n---\n\n');
  if (text.length > maxChars) text = text.slice(0, maxChars);
  return { text, docs: [...docsMap.values()], chunks: mergedChunks };
}
