const TRUNCATION_TAIL = /\b(the|a|an|and|or|with|for|to|from|that|this|its|is|are|was|into|of|by|at|on|in)\s*\.?\s*$/i;

export function isTruncatedClause(text: string | undefined): boolean {
  if (!text) return true;
  const trimmed = text.trim();
  if (trimmed.length < 4) return true;
  return TRUNCATION_TAIL.test(trimmed);
}

export function isCompleteAcceptanceRequirement(
  ar: { given?: string; when?: string; then?: string } | null | undefined,
): boolean {
  if (!ar?.given?.trim() || !ar?.when?.trim() || !ar?.then?.trim()) return false;
  // A THEN clause that ends in an article/preposition/conjunction is almost certainly truncated
  return !isTruncatedClause(ar.then);
}

export function hasIncompleteAcceptanceRequirements(
  acceptanceRequirements: Array<{ given?: string; when?: string; then?: string } | string>,
): boolean {
  if (!Array.isArray(acceptanceRequirements) || acceptanceRequirements.length === 0) return false;

  return acceptanceRequirements.some((ar) => {
    if (typeof ar === 'string') {
      return !/\bGIVEN\b[\s\S]*\bWHEN\b[\s\S]*\bTHEN\b/i.test(ar);
    }
    return !isCompleteAcceptanceRequirement(ar);
  });
}
