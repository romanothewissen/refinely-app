/**
 * Work instruction ingestion: document text extraction -> chunks -> BM25 retrieval.
 *
 * Uses pdf-parse (npm) for PDFs and xlsx (npm) for spreadsheets.
 * Uses BM25 scoring for retrieval (no embeddings needed for small corpora).
 * Stores in Forge Object Store.
 */

import { v4 as uuidv4 } from 'uuid';
import { WiChunk, WiDoc } from '../types';
import { objectRead, objectWrite, entityGet, entitySet, KEYS } from '../services/cache';

interface WiCache {
  docs: WiDoc[];
  chunks: WiChunk[];
}

interface WiContextResult {
  text: string;
  docs: WiDoc[];
  chunks: WiChunk[];
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

async function extractDocumentText(filename: string, buffer: Buffer): Promise<string> {
  const kind = detectDocumentKind(filename);

  if (kind === 'pdf') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdfParse = require('pdf-parse');
    const parsed = await pdfParse(buffer);
    return String(parsed.text ?? '');
  }

  if (kind === 'xlsx') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const XLSX = require('xlsx');
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const parts: string[] = [];
    for (const sheetName of workbook.SheetNames ?? []) {
      const worksheet = workbook.Sheets[sheetName];
      if (!worksheet) continue;
      const csv = XLSX.utils.sheet_to_csv(worksheet, { blankrows: false });
      const compact = csv.trim();
      if (compact) parts.push(`# ${sheetName}\n${compact}`);
    }
    const text = parts.join('\n\n');
    if (!text.trim()) {
      throw new Error(`The spreadsheet "${filename}" does not contain any readable cells.`);
    }
    return text;
  }

  if (kind === 'text') {
    const text = buffer.toString('utf8');
    if (!text.trim()) {
      throw new Error(`The document "${filename}" does not contain any readable text.`);
    }
    return text;
  }

  if (kind === 'email') {
    const raw = buffer.toString('utf8');
    const boundaryMatch = raw.match(/\r?\n\r?\n/);
    const boundaryIndex = boundaryMatch?.index ?? -1;
    const headerBlock = boundaryIndex >= 0 ? raw.slice(0, boundaryIndex) : '';
    const body = boundaryIndex >= 0 ? raw.slice(boundaryIndex + boundaryMatch![0].length) : raw;
    const subject = (headerBlock.match(/^Subject:\s*(.*)$/im)?.[1] ?? '').trim();
    const from = (headerBlock.match(/^From:\s*(.*)$/im)?.[1] ?? '').trim();
    const cleanedBody = body
      .split(/\r?\n/)
      .filter(line => !/^>/.test(line))
      .join('\n')
      .trim();
    const parts = [subject ? `Subject: ${subject}` : '', from ? `From: ${from}` : '', cleanedBody].filter(Boolean);
    const text = parts.join('\n\n');
    if (!text.trim()) {
      throw new Error(`The email "${filename}" does not contain any readable text.`);
    }
    return text;
  }

  throw new Error(
    `Unsupported work instruction format for "${filename}". Supported formats are PDF, XLSX, XLS, CSV, TXT, Markdown, and EML.`,
  );
}

function detectDocumentKind(filename: string): 'pdf' | 'xlsx' | 'text' | 'email' | 'unsupported' {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) return 'xlsx';
  if (lower.endsWith('.eml')) return 'email';
  if (lower.endsWith('.txt') || lower.endsWith('.csv') || lower.endsWith('.md')) return 'text';
  return 'unsupported';
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

  let result = parts.join('\n\n---\n\n');
  if (result.length > maxChars) result = result.slice(0, maxChars);
  return { text: result, docs, chunks: top };
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
