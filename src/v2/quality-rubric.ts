import type { V2BenchmarkExample, V2BenchmarkSignals } from './types';

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[midpoint - 1] + sorted[midpoint]) / 2
    : sorted[midpoint] ?? 0;
}

function average(values: number[]): number {
  return values.length
    ? Number((values.reduce((sum, next) => sum + next, 0) / values.length).toFixed(2))
    : 0;
}

function normalizeText(value: string): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function deriveBenchmarkSignals(examples: V2BenchmarkExample[]): V2BenchmarkSignals {
  const arCounts: number[] = [];
  const arLengths: number[] = [];
  const descriptionLengths: number[] = [];
  const summaryLengths: number[] = [];
  let decisionLogic = 0;
  let fallbackHandling = 0;
  let manualOverrideHandling = 0;
  let negativeConstraints = 0;
  let scenarioCoverage = 0;
  const distribution = new Map<number, number>();

  examples.forEach((example) => {
    const ars = example.acceptanceRequirements.map(normalizeText).filter(Boolean);
    if (ars.length) {
      arCounts.push(ars.length);
      distribution.set(ars.length, (distribution.get(ars.length) ?? 0) + 1);
      if (ars.length >= 4) scenarioCoverage += 1;
    }
    ars.forEach((ar) => {
      arLengths.push(ar.length);
      const lower = ar.toLowerCase();
      if (lower.includes('following logic') || lower.includes('must be used')) decisionLogic += 1;
      if (/\b(if no|fallback|otherwise|when no|without)\b/i.test(lower)) fallbackHandling += 1;
      if (/\bmanual|manually|override\b/i.test(lower)) manualOverrideHandling += 1;
      if (/\bmust not|cannot|no\b/i.test(lower)) negativeConstraints += 1;
    });
    descriptionLengths.push(normalizeText(example.description).length);
    summaryLengths.push(normalizeText(example.summary).length);
  });

  const totalArs = arLengths.length || 1;
  return {
    storyCount: examples.length,
    acceptanceRequirementCount: {
      min: arCounts.length ? Math.min(...arCounts) : 0,
      max: arCounts.length ? Math.max(...arCounts) : 0,
      avg: average(arCounts),
      median: median(arCounts),
      distribution: Object.fromEntries([...distribution.entries()].sort((left, right) => left[0] - right[0])),
    },
    averageDescriptionLength: average(descriptionLengths),
    averageSummaryLength: average(summaryLengths),
    averageAcceptanceRequirementLength: average(arLengths),
    rates: {
      decisionLogic: Number((decisionLogic / totalArs).toFixed(2)),
      fallbackHandling: Number((fallbackHandling / totalArs).toFixed(2)),
      manualOverrideHandling: Number((manualOverrideHandling / totalArs).toFixed(2)),
      negativeConstraints: Number((negativeConstraints / totalArs).toFixed(2)),
      scenarioCoverage: Number((scenarioCoverage / (examples.length || 1)).toFixed(2)),
    },
  };
}
