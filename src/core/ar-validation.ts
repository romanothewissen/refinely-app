export function isCompleteAcceptanceRequirement(
  ar: { given?: string; when?: string; then?: string } | null | undefined,
): boolean {
  return Boolean(ar?.given?.trim() && ar?.when?.trim() && ar?.then?.trim());
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
