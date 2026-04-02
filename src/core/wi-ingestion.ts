/**
 * Work instruction ingestion: PDF → chunks → hybrid retrieval.
 *
 * Uses pdf-parse (npm) for text extraction.
 * Uses BM25 scoring with optional LLM reranking for better semantic selection.
 * Stores in Forge Object Store.
 */

import { v4 as uuidv4 } from 'uuid';
import { callLlmJsonWithUsage } from './llm';
import { WiChunk, WiDoc } from '../types';
import { objectRead, objectWrite, entityGet, entitySet, KEYS } from '../services/cache';

interface WiCache {
  docs: WiDoc[];
  chunks: WiChunk[];
}

interface WiContextResult {
  text: string;
  docs: WiDoc[];
}

interface WiRerankOptions {
  enabled?: boolean;
  model: string;
  provider?: 'forge_llms' | 'gemini' | 'openai' | 'azure_openai';
  geminiApiKey?: string;
  geminiBaseUrl?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  azureOpenaiApiKey?: string;
  azureOpenaiEndpoint?: string;
  azureOpenaiDeployment?: string;
  azureOpenaiApiVersion?: string;
  shortlistSize?: number;
  timeoutMs?: number;
}

// ─── Ingest ───────────────────────────────────────────────────────────────────

export async function ingestPdf(opts: {
  filename: string;
  buffer: Buffer;
  revision?: string;
  targetProjects?: string[];
}): Promise<{ docId: string; chunkCount: number; duplicate: boolean }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfParse = require('pdf-parse');
  const parsed = await pdfParse(opts.buffer);
  const text: string = parsed.text ?? '';

  const revision = opts.revision || hashText(text).slice(0, 8);
  const cache = await loadCache();

  // Deduplication by (filename, revision)
  const exists = cache.docs.some(d => d.filename === opts.filename && d.revision === revision);
  if (exists) {
    return { docId: '', chunkCount: 0, duplicate: true };
  }

  const docId = uuidv4();
  const chunks = chunkText(text).map((chunkText, idx): WiChunk => ({
    docId,
    filename: opts.filename,
    revision,
    chunkIndex: idx,
    text: chunkText,
    tokenCount: Math.ceil(chunkText.length / 4),
  }));

  cache.docs.push({
    docId,
    filename: opts.filename,
    revision,
    chunkCount: chunks.length,
    uploadedAt: new Date().toISOString(),
    targetProjects: opts.targetProjects?.length ? opts.targetProjects : ['*'],
  });

  cache.chunks.push(...chunks);
  await saveCache(cache);

  return { docId, chunkCount: chunks.length, duplicate: false };
}

// ─── Retrieval ────────────────────────────────────────────────────────────────

export async function retrieveWiContext(
  query: string,
  topK = 8,
  maxChars = 100000,
  projectKey: string = '*',
  rerank?: WiRerankOptions,
): Promise<WiContextResult> {
  const cache = await loadCache();
  if (!cache.chunks.length) return { text: '', docs: [] };

  const allowedDocIds = new Set(
    cache.docs
      .filter(doc => docMatchesProject(doc, projectKey))
      .map(doc => doc.docId),
  );
  const scopedChunks = cache.chunks.filter(chunk => allowedDocIds.has(chunk.docId));
  if (!scopedChunks.length) return { text: '', docs: [] };

  const scored = bm25Score(query, scopedChunks);
  const shortlist = selectDiverseTopChunks(
    scored,
    Math.max(topK, Math.min(scored.length, rerank?.shortlistSize ?? Math.max(topK * 3, 12))),
    4,
  );
  const top = rerank?.enabled && shortlist.length > topK
    ? await rerankWiChunks(query, shortlist, topK, rerank)
    : selectDiverseTopChunks(shortlist, topK, 3);
  const parts = top.map(c => formatChunkForContext(c));
  const referencedDocIds = new Set(top.map(c => c.docId));
  const docs = cache.docs.filter(doc => referencedDocIds.has(doc.docId) && docMatchesProject(doc, projectKey));

  let result = parts.join('\n\n---\n\n');
  if (result.length > maxChars) result = result.slice(0, maxChars);
  return { text: result, docs };
}

async function rerankWiChunks(
  query: string,
  chunks: WiChunk[],
  topK: number,
  options: WiRerankOptions,
): Promise<WiChunk[]> {
  try {
    const numberedChunks = chunks.map((chunk, index) => ([
      `Chunk ${index + 1}`,
      `Document: ${chunk.filename} (${chunk.revision})`,
      `Excerpt: ${chunk.text.slice(0, 650)}`,
    ].join('\n')));

    const ranked = await callLlmJsonWithUsage<number[]>({
      model: options.model,
      systemPrompt: `Rank work-instruction excerpts by usefulness for understanding a business requirement.

Prioritize excerpts that best clarify:
- real process steps and states
- business rules and decision criteria
- roles, responsibilities, and approvals
- exceptions, constraints, thresholds, or timing conditions

Return only a JSON array of 1-based chunk numbers in best-first order.`,
      userMessage: `Requirement:\n${query.slice(0, 1200)}\n\nWork instruction excerpts:\n\n${numberedChunks.join('\n\n---\n\n')}`,
      maxTokens: 256,
      timeoutMs: options.timeoutMs ?? 12000,
      geminiThinkingBudget: 0,
      provider: options.provider,
      geminiApiKey: options.geminiApiKey,
      geminiBaseUrl: options.geminiBaseUrl,
      openaiApiKey: options.openaiApiKey,
      openaiBaseUrl: options.openaiBaseUrl,
      azureOpenaiApiKey: options.azureOpenaiApiKey,
      azureOpenaiEndpoint: options.azureOpenaiEndpoint,
      azureOpenaiDeployment: options.azureOpenaiDeployment,
      azureOpenaiApiVersion: options.azureOpenaiApiVersion,
    });

    if (!Array.isArray(ranked.data) || !ranked.data.length) {
      return selectDiverseTopChunks(chunks, topK, 3);
    }

    const selected = ranked.data
      .map(index => chunks[index - 1])
      .filter((chunk): chunk is WiChunk => !!chunk);

    return selectDiverseTopChunks(selected, topK, 3);
  } catch {
    return selectDiverseTopChunks(chunks, topK, 3);
  }
}

function formatChunkForContext(chunk: WiChunk): string {
  const header = `[${chunk.filename} rev ${chunk.revision}]`;
  return `${header}\n${chunk.text}`;
}

function selectDiverseTopChunks(chunks: WiChunk[], topK: number, maxPerDoc: number): WiChunk[] {
  const selected: WiChunk[] = [];
  const perDocCount = new Map<string, number>();

  for (const chunk of chunks) {
    if (selected.length >= topK) break;
    const count = perDocCount.get(chunk.docId) ?? 0;
    if (count >= maxPerDoc) continue;
    selected.push(chunk);
    perDocCount.set(chunk.docId, count + 1);
  }

  if (selected.length < topK) {
    for (const chunk of chunks) {
      if (selected.length >= topK) break;
      if (selected.includes(chunk)) continue;
      selected.push(chunk);
    }
  }

  return selected;
}

// ─── Document management ──────────────────────────────────────────────────────

export async function listDocs(projectKey: string = '*'): Promise<WiDoc[]> {
  const cache = await loadCache();
  return cache.docs.filter(doc => docMatchesProject(doc, projectKey));
}

export async function removeDoc(docId: string): Promise<void> {
  const cache = await loadCache();
  cache.docs = cache.docs.filter(d => d.docId !== docId);
  cache.chunks = cache.chunks.filter(c => c.docId !== docId);
  await saveCache(cache);
}

// ─── Text chunking ────────────────────────────────────────────────────────────

function chunkText(text: string, maxChars = 1200, minChars = 400): string[] {
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

function bm25Score(query: string, chunks: WiChunk[]): WiChunk[] {
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

function countDocsWithTerm(term: string, chunks: WiChunk[]): number {
  return chunks.filter(c => c.text.toLowerCase().includes(term)).length;
}

// ─── Cache helpers ────────────────────────────────────────────────────────────

async function loadCache(): Promise<WiCache> {
  const cached = await objectRead<WiCache>(KEYS.wiChunks);
  return cached ?? { docs: [], chunks: [] };
}

async function saveCache(cache: WiCache): Promise<void> {
  await objectWrite(KEYS.wiChunks, cache);
  await entitySet(KEYS.wiDocs, cache.docs.map(d => ({ docId: d.docId, filename: d.filename, chunkCount: d.chunkCount })));
}

function docMatchesProject(doc: WiDoc, projectKey: string): boolean {
  const targets = doc.targetProjects?.length ? doc.targetProjects : ['*'];
  return targets.includes('*') || targets.includes(projectKey);
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
