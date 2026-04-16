/**
 * Work instruction ingestion: document text extraction -> chunks -> BM25 retrieval.
 *
 * Uses pdf-parse (npm) for PDFs and text extraction for CSV/TXT/MD/EML.
 * Uses BM25 scoring for retrieval (no embeddings needed for small corpora).
 * Stores in Forge Object Store.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { v4 as uuidv4 } from 'uuid';
import { WiChunk, WiDoc, WiFacet } from '../types';
import { objectRead, objectWrite, objectDelete, entityGet, entitySet, KEYS } from '../services/cache';
import { extractDocumentText } from './document-parser';

interface WiCache {
  docs: WiDoc[];
  chunks: StoredWiChunk[];
}

/** One loaded WI corpus per queue/resolver invocation — avoids re-reading every doc from object storage on each BM25 pass. */
type WiRetrievalScope = { cache?: WiCache };
const wiRetrievalAls = new AsyncLocalStorage<WiRetrievalScope>();

export function runWithWiRetrievalCacheScope<T>(fn: () => Promise<T>): Promise<T> {
  return wiRetrievalAls.run({}, fn);
}

interface LegacyWiCache {
  docs?: WiDoc[];
  chunks?: Array<StoredWiChunk | WiChunk>;
}

interface WiContextResult {
  text: string;
  docs: WiDoc[];
  chunks: WiChunk[];
}

interface StoredWiChunk {
  docId: string;
  chunkIndex: number;
  sectionLabel?: string;
  sectionKind?: 'heading' | 'step' | 'bullet' | 'table' | 'paragraph';
  text: string;
  tokenCount: number;
  facets?: WiFacet[];
}

interface ChunkSeed {
  text: string;
  sectionLabel?: string;
  sectionKind: StoredWiChunk['sectionKind'];
}

// ─── Ingest ───────────────────────────────────────────────────────────────────

export async function ingestPdf(opts: {
  filename: string;
  buffer: Buffer;
  revision?: string;
  targetProjects?: string[];
}): Promise<{ docId: string; chunkCount: number; duplicate: boolean }> {
  const text = await extractDocumentText(opts.filename, opts.buffer);

  const revision = opts.revision || hashText(text).slice(0, 8);
  const docs = await loadDocs();

  // Deduplication by (filename, revision)
  const exists = docs.some(d => d.filename === opts.filename && d.revision === revision);
  if (exists) {
    return { docId: '', chunkCount: 0, duplicate: true };
  }

  const docId = uuidv4();
  const chunks = chunkText(text).map((chunkSeed, idx): StoredWiChunk => ({
    docId,
    chunkIndex: idx,
    sectionLabel: chunkSeed.sectionLabel,
    sectionKind: chunkSeed.sectionKind,
    text: chunkSeed.text,
    tokenCount: Math.ceil(chunkSeed.text.length / 4),
    facets: extractChunkFacets(chunkSeed.text, chunkSeed.sectionLabel),
  }));

  docs.push({
    docId,
    filename: opts.filename,
    revision,
    chunkCount: chunks.length,
    uploadedAt: new Date().toISOString(),
    targetProjects: opts.targetProjects?.length ? opts.targetProjects : ['*'],
  });

  try {
    await saveDocChunks(docId, chunks);
    await saveDocMetadata(docs);
    void invalidateCorpusCache();
  } catch (error) {
    await objectDelete(KEYS.wiChunksForDoc(docId));
    await saveDocMetadata(docs.filter(d => d.docId !== docId));
    throw error;
  }

  return { docId, chunkCount: chunks.length, duplicate: false };
}

// ─── Retrieval ────────────────────────────────────────────────────────────────

/** BM25 over the union of chunks from all matching projects in one pass (deduped chunks). */
function pickWiContextForProjectKeys(
  cache: WiCache,
  query: string,
  topK: number,
  maxChars: number,
  projectKeys: string[],
  selectedDocIds?: string[],
): WiContextResult & { linkedDocs: WiDoc[] } {
  const selectedDocIdSet = new Set((selectedDocIds ?? []).map((id) => String(id ?? '').trim()).filter(Boolean));
  const linkedDocs = cache.docs.filter((doc) => (
    !projectKeys.length || projectKeys.some((key) => docMatchesProject(doc, key))
  ));
  const scopedLinkedDocs = selectedDocIdSet.size
    ? linkedDocs.filter((doc) => selectedDocIdSet.has(doc.docId))
    : linkedDocs;

  if (!cache.chunks.length) {
    return { text: '', docs: [], chunks: [], linkedDocs: scopedLinkedDocs };
  }

  const allowedDocIds = new Set(scopedLinkedDocs.map((doc) => doc.docId));
  const scopedChunks = cache.chunks.filter((chunk) => allowedDocIds.has(chunk.docId));
  if (!scopedChunks.length) {
    return { text: '', docs: [], chunks: [], linkedDocs: scopedLinkedDocs };
  }

  const docsById = new Map(cache.docs.map((doc) => [doc.docId, doc]));
  const scored = bm25Score(query, scopedChunks);
  const topScore = scored[0]?.score ?? 0;
  const minScore = topScore * 0.2;
  const top = scored.filter((s) => s.score >= minScore).slice(0, topK).map((s) => s.chunk);
  const parts = top.map((c) => c.text);
  const referencedDocIds = new Set(top.map((c) => c.docId));
  const docs = cache.docs.filter((doc) => referencedDocIds.has(doc.docId) && allowedDocIds.has(doc.docId));
  const chunks = top.map((chunk) => hydrateChunk(chunk, docsById));

  let result = parts.join('\n\n---\n\n');
  if (result.length > maxChars) result = result.slice(0, maxChars);
  return { text: result, docs, chunks, linkedDocs: scopedLinkedDocs };
}

/** Scoped retrieval for one or more Jira projects, or the full tenant corpus when `projectKeys` is empty. */
export async function retrieveWiContextMultiProject(
  query: string,
  topK: number,
  maxChars: number,
  projectKeys: string[],
  selectedDocIds?: string[],
): Promise<WiContextResult & { linkedDocs: WiDoc[] }> {
  const cache = await loadCache();
  return pickWiContextForProjectKeys(cache, query, topK, maxChars, projectKeys, selectedDocIds);
}

export async function retrieveWiContext(
  query: string,
  topK = 8,
  maxChars = 100000,
  projectKey: string = '*',
): Promise<WiContextResult> {
  const cache = await loadCache();
  const picked = pickWiContextForProjectKeys(cache, query, topK, maxChars, [projectKey]);
  return { text: picked.text, docs: picked.docs, chunks: picked.chunks };
}

// ─── Document management ──────────────────────────────────────────────────────

export async function listDocs(projectKey: string = '*', opts?: { exactOnly?: boolean }): Promise<WiDoc[]> {
  const docs = await loadDocs();
  return docs.filter(doc => opts?.exactOnly ? docMatchesProjectExactly(doc, projectKey) : docMatchesProject(doc, projectKey));
}

export async function removeDoc(docId: string): Promise<void> {
  const docs = await loadDocs();
  const nextDocs = docs.filter(d => d.docId !== docId);
  await saveDocMetadata(nextDocs);
  await objectDelete(KEYS.wiChunksForDoc(docId));
  void invalidateCorpusCache();
}

// ─── Text chunking ────────────────────────────────────────────────────────────

function chunkText(text: string, maxChars = 800, minChars = 180): ChunkSeed[] {
  const normalized = text.replace(/\r/g, '').trim();
  if (!normalized) return [];

  const lines = normalized.split('\n');
  const seeds: ChunkSeed[] = [];
  let currentLabel = '';
  let paragraphBuffer: string[] = [];

  const flushParagraphBuffer = () => {
    if (!paragraphBuffer.length) return;
    const blocks = paragraphBuffer.join('\n').split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
    for (const block of blocks) {
      seeds.push({
        text: block,
        sectionLabel: currentLabel || detectSectionLabel(block),
        sectionKind: detectSectionKind(block),
      });
    }
    paragraphBuffer = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      paragraphBuffer.push('');
      continue;
    }
    if (isHeadingLine(line)) {
      flushParagraphBuffer();
      currentLabel = normalizeHeading(line);
      continue;
    }
    if (isStandaloneStructuredLine(line)) {
      flushParagraphBuffer();
      seeds.push({
        text: line,
        sectionLabel: currentLabel || detectSectionLabel(line),
        sectionKind: detectSectionKind(line),
      });
      continue;
    }
    paragraphBuffer.push(line);
  }
  flushParagraphBuffer();

  return mergeChunkSeeds(seeds, maxChars, minChars);
}

// ─── BM25 scoring ─────────────────────────────────────────────────────────────

function bm25Score(query: string, chunks: StoredWiChunk[]): { chunk: StoredWiChunk; score: number }[] {
  const k1 = 1.5, b = 0.75;
  const queryTerms = tokenize(query);
  const avgLen = chunks.reduce((s, c) => s + c.tokenCount, 0) / (chunks.length || 1);
  const queryScores = buildTermFreq(queryTerms);

  const scored = chunks.map(chunk => {
    const terms = tokenize(`${chunk.sectionLabel ?? ''} ${chunk.text}`);
    const termFreq = buildTermFreq(terms);
    const docLen = terms.length;

    let score = 0;
    for (const term of queryTerms) {
      const tf = termFreq[term] ?? 0;
      if (tf === 0) continue;
      const idf = Math.log((chunks.length + 1) / (1 + countDocsWithTerm(term, chunks)));
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * docLen / avgLen)));
    }

    score += chunkFacetScore(chunk, queryScores, queryTerms);
    score += chunkSectionBoost(chunk, queryTerms);

    return { chunk, score };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score);
}

function tokenize(text: string): string[] {
  const stopWords = new Set(['the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'is', 'are', 'was', 'be', 'been', 'with', 'that', 'this', 'from', 'by', 'as', 'it', 'its']);
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w));
}

function buildTermFreq(terms: string[]): Record<string, number> {
  const freq: Record<string, number> = {};
  for (const t of terms) freq[t] = (freq[t] ?? 0) + 1;
  return freq;
}

function countDocsWithTerm(term: string, chunks: StoredWiChunk[]): number {
  return chunks.filter(c => `${c.sectionLabel ?? ''} ${c.text}`.toLowerCase().includes(term)).length;
}

// ─── Cache helpers ────────────────────────────────────────────────────────────

async function loadWiCacheCold(): Promise<WiCache> {
  const docs = await loadDocs();
  if (!docs.length) return { docs: [], chunks: [] };
  const chunks = await loadChunksForDocs(docs);
  return { docs, chunks };
}

async function loadCache(): Promise<WiCache> {
  // 1. Within-invocation ALS cache (avoids re-reads within the same queue handler).
  const store = wiRetrievalAls.getStore();
  if (store?.cache) return store.cache;

  // 2. Cross-invocation consolidated cache (avoids the 4–5 separate KVS reads that occur when
  //    clarify, sufficiency, and generation each cold-load the same unchanged corpus).
  try {
    const cached = await entityGet<{ cache: WiCache; expiresAt: number }>(KEYS.wiCorpusCache);
    if (cached && cached.expiresAt > Date.now()) {
      if (store) store.cache = cached.cache;
      return cached.cache;
    }
  } catch {
    // Ignore read errors — fall through to cold load.
  }

  // 3. Full cold load from per-doc KVS entries.
  const freshCache = await loadWiCacheCold();
  if (store) store.cache = freshCache;

  // Populate cross-invocation cache for subsequent pipeline stages (30-min TTL).
  // Fire-and-forget — do not block the pipeline on cache write.
  void entitySet(KEYS.wiCorpusCache, { cache: freshCache, expiresAt: Date.now() + 30 * 60 * 1000 }).catch(() => {});

  return freshCache;
}

/** Invalidates the cross-invocation corpus cache. Call after any doc ingestion or removal. */
async function invalidateCorpusCache(): Promise<void> {
  try {
    await objectDelete(KEYS.wiCorpusCache);
  } catch {
    // Best-effort — a stale cache will self-expire within 30 minutes.
  }
}

async function loadDocs(): Promise<WiDoc[]> {
  const legacy = await objectRead<LegacyWiCache>(KEYS.wiChunks);
  if (legacy) {
    const docs = normalizeWiDocs(legacy.docs);
    const chunks = normalizeStoredChunks(legacy.chunks);
    await saveDocMetadata(docs);
    await saveChunkBatches(groupChunksByDoc(chunks));
    await objectDelete(KEYS.wiChunks);
    return docs;
  }

  const stored = await entityGet<unknown>(KEYS.wiDocs);
  return normalizeWiDocs(stored);
}

async function saveDocMetadata(docs: WiDoc[]): Promise<void> {
  await entitySet(KEYS.wiDocs, docs);
}

async function loadChunksForDocs(docs: WiDoc[]): Promise<StoredWiChunk[]> {
  const batches = await Promise.all(
    docs.map(async (doc) => {
      const stored = await objectRead<StoredWiChunk[] | { chunks?: Array<StoredWiChunk | WiChunk> }>(
        KEYS.wiChunksForDoc(doc.docId),
      );
      return normalizeStoredChunks(stored);
    }),
  );
  return batches.flat();
}

async function saveDocChunks(docId: string, chunks: StoredWiChunk[]): Promise<void> {
  const ok = await objectWrite(KEYS.wiChunksForDoc(docId), chunks);
  if (!ok) {
    throw new Error('Work instruction storage is full. Remove an existing document or reduce the size of the uploaded files.');
  }
}

async function saveChunkBatches(chunksByDoc: Map<string, StoredWiChunk[]>): Promise<void> {
  for (const [docId, chunks] of chunksByDoc.entries()) {
    await saveDocChunks(docId, chunks);
  }
}

function docMatchesProject(doc: WiDoc, projectKey: string): boolean {
  const targets = doc.targetProjects?.length ? doc.targetProjects : ['*'];
  return targets.includes('*') || targets.includes(projectKey);
}

function docMatchesProjectExactly(doc: WiDoc, projectKey: string): boolean {
  const targets = doc.targetProjects?.length ? doc.targetProjects : ['*'];
  if (projectKey === '*') return targets.includes('*');
  return targets.includes(projectKey);
}

function normalizeWiDocs(value: unknown): WiDoc[] {
  const rawDocs: unknown[] = Array.isArray(value)
    ? value
    : Array.isArray((value as { docs?: unknown } | null | undefined)?.docs)
      ? ((value as { docs?: unknown }).docs as unknown[])
      : [];

  return rawDocs
    .map(doc => normaliseWiDoc(doc as WiDoc | Record<string, unknown>))
    .filter((doc): doc is WiDoc => Boolean(doc.docId));
}

function groupChunksByDoc(chunks: StoredWiChunk[]): Map<string, StoredWiChunk[]> {
  const grouped = new Map<string, StoredWiChunk[]>();
  for (const chunk of chunks) {
    const current = grouped.get(chunk.docId) ?? [];
    current.push(chunk);
    grouped.set(chunk.docId, current);
  }
  return grouped;
}

function normalizeStoredChunks(value: unknown): StoredWiChunk[] {
  const rawChunks: unknown[] = Array.isArray(value)
    ? value
    : Array.isArray((value as { chunks?: unknown } | null | undefined)?.chunks)
      ? ((value as { chunks?: unknown }).chunks as unknown[])
      : [];

  return rawChunks
    .map(chunk => normaliseStoredChunk(chunk as StoredWiChunk | WiChunk | Record<string, unknown>))
    .filter((chunk): chunk is StoredWiChunk => Boolean(chunk));
}

function normaliseWiDoc(doc: WiDoc | Record<string, unknown>): WiDoc {
  return {
    docId: String(doc.docId ?? '').trim(),
    filename: String(doc.filename ?? '').trim(),
    revision: String(doc.revision ?? '').trim(),
    chunkCount: Number(doc.chunkCount ?? 0),
    uploadedAt: String(doc.uploadedAt ?? new Date().toISOString()),
    targetProjects: Array.isArray(doc.targetProjects)
      ? doc.targetProjects.map(project => String(project)).filter(Boolean)
      : undefined,
  };
}

function normaliseStoredChunk(chunk: StoredWiChunk | WiChunk | Record<string, unknown>): StoredWiChunk | null {
  const docId = String(chunk.docId ?? '').trim();
  const text = String(chunk.text ?? '').trim();
  if (!docId || !text) return null;
  return {
    docId,
    chunkIndex: Number(chunk.chunkIndex ?? 0),
    sectionLabel: typeof chunk.sectionLabel === 'string' ? String(chunk.sectionLabel).trim() || undefined : undefined,
    sectionKind: normalizeSectionKind(chunk.sectionKind),
    text,
    tokenCount: Number(chunk.tokenCount ?? Math.ceil(text.length / 4)),
    facets: normalizeWiFacets(chunk.facets),
  };
}

function hydrateChunk(chunk: StoredWiChunk, docsById: Map<string, WiDoc>): WiChunk {
  const doc = docsById.get(chunk.docId);
  return {
    docId: chunk.docId,
    filename: doc?.filename ?? 'Unknown document',
    revision: doc?.revision ?? '',
    chunkIndex: chunk.chunkIndex,
    sectionLabel: chunk.sectionLabel,
    sectionKind: chunk.sectionKind,
    text: chunk.text,
    tokenCount: chunk.tokenCount,
    facets: chunk.facets,
  };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function mergeChunkSeeds(seeds: ChunkSeed[], maxChars: number, minChars: number): ChunkSeed[] {
  const merged: ChunkSeed[] = [];
  let current: ChunkSeed | null = null;

  const pushCurrent = () => {
    if (!current?.text.trim()) return;
    if (current.text.length < minChars && merged.length > 0) {
      const last = merged[merged.length - 1];
      if (last.text.length + current.text.length + 2 <= maxChars) {
        last.text = `${last.text}\n\n${current.text}`.trim();
        current = null;
        return;
      }
    }
    merged.push(current);
    current = null;
  };

  for (const seed of seeds) {
    const trimmed = seed.text.trim();
    if (!trimmed) continue;
    if (trimmed.length > maxChars) {
      pushCurrent();
      for (let start = 0; start < trimmed.length; start += maxChars) {
        merged.push({
          ...seed,
          text: trimmed.slice(start, start + maxChars).trim(),
        });
      }
      continue;
    }
    if (!current) {
      current = { ...seed, text: trimmed };
      continue;
    }
    const compatibleSection = current.sectionLabel === seed.sectionLabel && current.sectionKind === seed.sectionKind;
    if (compatibleSection && current.text.length + trimmed.length + 2 <= maxChars) {
      current.text = `${current.text}\n\n${trimmed}`;
      continue;
    }
    pushCurrent();
    current = { ...seed, text: trimmed };
  }
  pushCurrent();
  return merged;
}

function isHeadingLine(line: string): boolean {
  if (!line) return false;
  return /^#{1,6}\s+/.test(line)
    || /^[A-Z][A-Z0-9\s/&-]{3,}$/.test(line)
    || /:$/.test(line) && line.length <= 90;
}

function normalizeHeading(line: string): string {
  return line.replace(/^#{1,6}\s+/, '').replace(/:$/, '').trim();
}

function detectSectionLabel(text: string): string | undefined {
  const firstLine = text.split('\n')[0]?.trim() ?? '';
  if (firstLine.length >= 4 && firstLine.length <= 90 && /:$/.test(firstLine)) {
    return firstLine.replace(/:$/, '').trim();
  }
  return undefined;
}

function isStandaloneStructuredLine(line: string): boolean {
  return detectSectionKind(line) !== 'paragraph';
}

function detectSectionKind(text: string): StoredWiChunk['sectionKind'] {
  const trimmed = text.trim();
  if (/^\|.+\|$/.test(trimmed)) return 'table';
  if (/^(step\s*\d+|\d+[.)])\s+/i.test(trimmed)) return 'step';
  if (/^[-*•]\s+/.test(trimmed)) return 'bullet';
  return 'paragraph';
}

function extractChunkFacets(text: string, sectionLabel?: string): WiFacet[] {
  const facets: WiFacet[] = [];
  const lowered = `${sectionLabel ?? ''} ${text}`.toLowerCase();
  const add = (kind: WiFacet['kind'], value: string, confidence: WiFacet['confidence'] = 'medium') => {
    if (!value.trim()) return;
    const normalized = value.trim().toLowerCase();
    if (facets.some((facet) => facet.kind === kind && facet.value.toLowerCase() === normalized)) return;
    facets.push({ kind, value: value.trim(), confidence });
  };

  const actorMatches = text.match(/\b(?:as|by|for)\s+(?:an?|the)?\s*([A-Z][A-Za-z0-9/\-\s]{2,60})/g) ?? [];
  actorMatches.slice(0, 3).forEach((match) => add('actor', match.replace(/\b(?:as|by|for)\s+/i, '').replace(/^(?:an?|the)\s+/i, '').trim(), 'low'));

  const actionTerms = ['create', 'update', 'review', 'approve', 'plan', 'quote', 'schedule', 'sequence', 'ship', 'order', 'install', 'deinstall', 'cancel', 'reopen', 'complete'];
  actionTerms.forEach((term) => {
    if (lowered.includes(term)) add('action', term);
  });

  const sectionHints: Array<[RegExp, WiFacet['kind'], string]> = [
    [/\binput|required information|must include|capture\b/i, 'input', sectionLabel || 'required inputs'],
    [/\boutput|result|generate|created\b/i, 'output', sectionLabel || 'outputs'],
    [/\bif\b|\bonly when\b|\bmust\b|\bcannot\b/i, 'rule', sectionLabel || 'business rule'],
    [/\bstatus\b|\bstate\b|\btransition\b|\bmove to\b|\badvance\b/i, 'transition', sectionLabel || 'state transition'],
    [/\bexception\b|\berror\b|\bmissing\b|\bmanual review\b|\bfallback\b/i, 'exception', sectionLabel || 'exception handling'],
    [/\bsequence\b|\border\b|\bpredecessor\b|\bdependency\b|\bbefore\b|\bafter\b/i, 'sequence', sectionLabel || 'sequencing'],
    [/\bmultiple plans\b|\bsplit plan\b|\bnew plan\b|\bseparate plan\b|\bsingle plan\b/i, 'split_decision', sectionLabel || 'single vs multiple plan rules'],
  ];
  sectionHints.forEach(([pattern, kind, value]) => {
    if (pattern.test(lowered)) add(kind, value);
  });

  return facets.slice(0, 8);
}

function chunkFacetScore(chunk: StoredWiChunk, queryScores: Record<string, number>, queryTerms: string[]): number {
  const facets = chunk.facets ?? [];
  let score = 0;
  for (const facet of facets) {
    const facetTerms = tokenize(facet.value);
    const overlap = facetTerms.filter((term) => queryScores[term] > 0).length;
    if (!overlap) continue;
    const confidenceBoost = facet.confidence === 'high' ? 1.2 : facet.confidence === 'low' ? 0.6 : 0.9;
    score += overlap * confidenceBoost;
    if (facet.kind === 'sequence' && queryTerms.some((term) => ['sequence', 'dependency', 'dependencies', 'order'].includes(term))) score += 1.1;
    if (facet.kind === 'split_decision' && queryTerms.some((term) => ['multiple', 'split', 'single', 'plan'].includes(term))) score += 1.1;
  }
  return score;
}

function chunkSectionBoost(chunk: StoredWiChunk, queryTerms: string[]): number {
  const label = chunk.sectionLabel?.toLowerCase() ?? '';
  if (!label) return 0;
  let score = 0;
  if (queryTerms.some((term) => label.includes(term))) score += 1.5;
  if (chunk.sectionKind === 'step') score += 0.25;
  if (chunk.sectionKind === 'heading') score += 0.15;
  if (label.includes('sequence') || label.includes('dependency')) score += 0.4;
  if (label.includes('exception') || label.includes('approval')) score += 0.3;
  return score;
}

function normalizeSectionKind(value: unknown): StoredWiChunk['sectionKind'] {
  return value === 'heading' || value === 'step' || value === 'bullet' || value === 'table' || value === 'paragraph'
    ? value
    : undefined;
}

function normalizeWiFacets(value: unknown): WiFacet[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const facets = value
    .map((entry) => {
      const kind = typeof (entry as WiFacet | null | undefined)?.kind === 'string' ? (entry as WiFacet).kind : null;
      const facetValue = typeof (entry as WiFacet | null | undefined)?.value === 'string' ? (entry as WiFacet).value.trim() : '';
      if (!kind || !facetValue) return null;
      const confidence = (entry as WiFacet).confidence;
      return {
        kind,
        value: facetValue,
        ...(confidence === 'low' || confidence === 'medium' || confidence === 'high' ? { confidence } : {}),
      } as WiFacet;
    })
    .filter((facet): facet is WiFacet => Boolean(facet));
  return facets.length ? facets : undefined;
}

function hashText(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}
