import React from 'react';
import type { AcceptanceRequirement } from './types';

export type DiffToken = { text: string; type: 'same' | 'added' | 'removed' };
export type ArDiffRow =
  | { type: 'matched'; proposed: AcceptanceRequirement; oldAr: AcceptanceRequirement; oldIndex: number; newIndex: number }
  | { type: 'added'; proposed: AcceptanceRequirement; newIndex: number }
  | { type: 'removed'; oldAr: AcceptanceRequirement; oldIndex: number };

function tokenizeDiffText(text: string): string[] {
  return (text || '').match(/\s+|[^\s]+/g) ?? [];
}

function isWhitespaceToken(text: string): boolean {
  return text.trim().length === 0;
}

function wordDiff(oldText: string, newText: string): DiffToken[] {
  const oldWords = tokenizeDiffText(oldText);
  const newWords = tokenizeDiffText(newText);
  const m = oldWords.length;
  const n = newWords.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] = oldWords[i] === newWords[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const tokens: DiffToken[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldWords[i] === newWords[j]) {
      tokens.push({ text: newWords[j], type: 'same' });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      tokens.push({ text: oldWords[i], type: 'removed' });
      i += 1;
    } else {
      tokens.push({ text: newWords[j], type: 'added' });
      j += 1;
    }
  }
  while (i < m) tokens.push({ text: oldWords[i++], type: 'removed' });
  while (j < n) tokens.push({ text: newWords[j++], type: 'added' });
  return tokens;
}

export function DiffText({
  oldText,
  newText,
  fullHighlight = false,
  mode = 'redline',
}: {
  oldText: string;
  newText: string;
  fullHighlight?: boolean;
  mode?: 'redline' | 'blackline';
}) {
  if (mode === 'blackline') return <span>{newText}</span>;
  if (fullHighlight) {
    return (
      <span className="rounded-md border border-[rgba(46,125,86,0.18)] bg-[rgba(46,125,86,0.12)] px-1.5 py-0.5 font-medium text-[var(--rf-success)]">
        {newText}
      </span>
    );
  }
  const tokens = wordDiff(oldText, newText);
  return (
    <span className="leading-7">
      {tokens.map((tok, index) => {
        if (tok.type === 'same') return <span key={index}>{tok.text}</span>;
        if (isWhitespaceToken(tok.text)) return <span key={index}>{tok.text}</span>;
        if (tok.type === 'added') {
          return (
            <mark
              key={index}
              className="rounded-[6px] border border-[rgba(46,125,86,0.16)] bg-[rgba(46,125,86,0.14)] px-1 py-0.5 font-medium text-[var(--rf-success)] not-italic shadow-[inset_0_0_0_1px_rgba(255,255,255,0.3)]"
            >
              {tok.text}
            </mark>
          );
        }
        return (
          <span
            key={index}
            className="rounded-[6px] border border-[rgba(155,53,69,0.16)] bg-[rgba(155,53,69,0.14)] px-1 py-0.5 font-medium text-[#7d2232] line-through decoration-[#7d2232] decoration-2"
          >
            {tok.text}
          </span>
        );
      })}
    </span>
  );
}

function normaliseWhitespace(text: string): string {
  return (text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function tokenSet(text: string): Set<string> {
  const tokens = normaliseWhitespace(text)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2);
  return new Set(tokens);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = new Set([...a, ...b]).size;
  return union ? intersection / union : 0;
}

function arSimilarity(left: AcceptanceRequirement, right: AcceptanceRequirement): number {
  const leftText = `${left.given} ${left.when} ${left.then}`.trim();
  const rightText = `${right.given} ${right.when} ${right.then}`.trim();
  if (normaliseWhitespace(leftText) === normaliseWhitespace(rightText)) return 1;

  const leftComplete = Boolean(left.given.trim() && left.when.trim() && left.then.trim());
  const rightComplete = Boolean(right.given.trim() && right.when.trim() && right.then.trim());
  const wholeScore = jaccard(tokenSet(leftText), tokenSet(rightText));
  const givenScore = jaccard(tokenSet(left.given), tokenSet(right.given));
  const whenScore = jaccard(tokenSet(left.when), tokenSet(right.when));
  const thenScore = jaccard(tokenSet(left.then), tokenSet(right.then));
  const blendedScore = Math.max(wholeScore, ((givenScore + whenScore + thenScore) / 3) * 0.8 + wholeScore * 0.2);
  if (leftComplete !== rightComplete) return blendedScore * 0.22;
  if (!leftComplete && !rightComplete) return blendedScore * 0.55;
  return blendedScore;
}

export function alignAcceptanceRequirementsDetailed(
  original: AcceptanceRequirement[],
  proposed: AcceptanceRequirement[],
): ArDiffRow[] {
  const rows: ArDiffRow[] = [];
  const m = original.length;
  const n = proposed.length;
  const gapCost = 0.55;
  const matchThreshold = 0.24;
  const lowSimilarityPenalty = 1.35;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array.from({ length: n + 1 }, () => Number.POSITIVE_INFINITY));

  dp[m][n] = 0;
  for (let i = m; i >= 0; i -= 1) {
    for (let j = n; j >= 0; j -= 1) {
      if (i < m) dp[i][j] = Math.min(dp[i][j], gapCost + dp[i + 1][j]);
      if (j < n) dp[i][j] = Math.min(dp[i][j], gapCost + dp[i][j + 1]);
      if (i < m && j < n) {
        const similarity = arSimilarity(original[i], proposed[j]);
        const matchCost = similarity >= matchThreshold ? (1 - similarity) * 0.9 : lowSimilarityPenalty;
        dp[i][j] = Math.min(dp[i][j], matchCost + dp[i + 1][j + 1]);
      }
    }
  }

  let i = 0;
  let j = 0;
  while (i < m || j < n) {
    const removeCost = i < m ? gapCost + dp[i + 1][j] : Number.POSITIVE_INFINITY;
    const addCost = j < n ? gapCost + dp[i][j + 1] : Number.POSITIVE_INFINITY;
    const similarity = i < m && j < n ? arSimilarity(original[i], proposed[j]) : 0;
    const matchCost = i < m && j < n
      ? (similarity >= matchThreshold ? (1 - similarity) * 0.9 : lowSimilarityPenalty) + dp[i + 1][j + 1]
      : Number.POSITIVE_INFINITY;

    if (i < m && j < n && matchCost <= addCost && matchCost <= removeCost) {
      rows.push({ type: 'matched', proposed: proposed[j], oldAr: original[i], oldIndex: i, newIndex: j });
      i += 1;
      j += 1;
      continue;
    }

    if (i < m && removeCost <= addCost) {
      rows.push({ type: 'removed', oldAr: original[i], oldIndex: i });
      i += 1;
      continue;
    }

    if (j < n) {
      rows.push({ type: 'added', proposed: proposed[j], newIndex: j });
      j += 1;
    }
  }

  return rows;
}
