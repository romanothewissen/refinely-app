/**
 * Work instruction ingestion: document text extraction -> chunks -> BM25 retrieval.
 *
 * Uses pdf-parse (npm) for PDFs and xlsx (npm) for spreadsheets.
 * Uses BM25 scoring for retrieval (no embeddings needed for small corpora).
 * Stores in Forge Object Store.
 */

import { v4 as uuidv4 } from 'uuid';
import { WiChunk, WiDoc } from '../types';
import { objectRead, objectWrite, objectDelete, entityGet, entitySet, KEYS } from '../services/cache';
import { extractDocumentText } from './document-parser';

interface WiCache {
  docs: WiDoc[];
  chunks: StoredWiChunk[];
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
  text: string;
  tokenCount: number;
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
  const chunks = chunkText(text).map((chunkText, idx): StoredWiChunk => ({
    docId,
    chunkIndex: idx,
    text: chunkText,
    tokenCount: Math.ceil(chunkText.length / 4),
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
  } catch (error) {
    await objectDelete(KEYS.wiChunksForDoc(docId));
    await saveDocMetadata(docs.filter(d => d.docId !== docId));
    throw error;
  }

  return { docId, chunkCount: chunks.length, duplicate: false };
}

// ─── Retrieval ────────────────────────────────────────────────────────────────

export async function retrieveWiContext(
  query: string,
  topK = 8,
  maxChars = 100000,
  projectKey: string = '*',
): Promise<WiContextResult> {
  const cache = await loadCache();
  if (!cache.chunks.length) return { text: '', docs: [], chunks: [] };
  const docsById = new Map(cache.docs.map(doc => [doc.docId, doc]));

  const allowedDocIds = new Set(
    cache.docs
      .filter(doc => docMatchesProject(doc, projectKey))
      .map(doc => doc.docId),
  );
  const scopedChunks = cache.chunks.filter(chunk => allowedDocIds.has(chunk.docId));
  if (!scopedChunks.length) return { text: '', docs: [], chunks: [] };

  const scored = bm25Score(query, scopedChunks);
  const top = scored.slice(0, topK);
  const parts = top.map(c => c.text);
  const referencedDocIds = new Set(top.map(c => c.docId));
  const docs = cache.docs.filter(doc => referencedDocIds.has(doc.docId) && docMatchesProject(doc, projectKey));
  const chunks = top.map(chunk => hydrateChunk(chunk, docsById));

  let result = parts.join('\n\n---\n\n');
  if (result.length > maxChars) result = result.slice(0, maxChars);
  return { text: result, docs, chunks };
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
}

// ─── Text chunking ────────────────────────────────────────────────────────────

function chunkText(text: string, maxChars = 800, minChars = 200): string[] {
  const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    if (current.length + para.length + 2 <= maxChars) {
      current = current ? `${current}\n\n${para}` : para;
    } else {
      if (current.length >= minChars) chunks.push(current);
      current = para.length > maxChars ? para.slice(0, maxChars) : para;
    }
  }

  if (current.length >= minChars) chunks.push(current);
  return chunks;
}

// ─── BM25 scoring ─────────────────────────────────────────────────────────────

function bm25Score(query: string, chunks: StoredWiChunk[]): StoredWiChunk[] {
  const k1 = 1.5, b = 0.75;
  const queryTerms = tokenize(query);
  const avgLen = chunks.reduce((s, c) => s + c.tokenCount, 0) / (chunks.length || 1);

  const scored = chunks.map(chunk => {
    const terms = tokenize(chunk.text);
    const termFreq = buildTermFreq(terms);
    const docLen = terms.length;

    let score = 0;
    for (const term of queryTerms) {
      const tf = termFreq[term] ?? 0;
      if (tf === 0) continue;
      const idf = Math.log((chunks.length + 1) / (1 + countDocsWithTerm(term, chunks)));
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * docLen / avgLen)));
    }

    return { chunk, score };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(s => s.chunk);
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
  return chunks.filter(c => c.text.toLowerCase().includes(term)).length;
}

// ─── Cache helpers ────────────────────────────────────────────────────────────

async function loadCache(): Promise<WiCache> {
  const docs = await loadDocs();
  if (!docs.length) return { docs: [], chunks: [] };
  const chunks = await loadChunksForDocs(docs);
  return { docs, chunks };
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
  const allChunks: StoredWiChunk[] = [];

  for (const doc of docs) {
    const stored = await objectRead<StoredWiChunk[] | { chunks?: Array<StoredWiChunk | WiChunk> }>(KEYS.wiChunksForDoc(doc.docId));
    const chunks = normalizeStoredChunks(stored);
    allChunks.push(...chunks);
  }

  return allChunks;
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
    text,
    tokenCount: Number(chunk.tokenCount ?? Math.ceil(text.length / 4)),
  };
}

function hydrateChunk(chunk: StoredWiChunk, docsById: Map<string, WiDoc>): WiChunk {
  const doc = docsById.get(chunk.docId);
  return {
    docId: chunk.docId,
    filename: doc?.filename ?? 'Unknown document',
    revision: doc?.revision ?? '',
    chunkIndex: chunk.chunkIndex,
    text: chunk.text,
    tokenCount: chunk.tokenCount,
  };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function hashText(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}
