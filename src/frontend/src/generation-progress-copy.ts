import type {
  AdvisoryDiscoveryForecast,
  ClarifyProgressPayload,
  CoverageReviewAdvice,
  DiscoveryProfile,
  GenerationSizingAssessment,
} from './types';

export function getGenerationFeatureTargetLabel(): string {
  return 'Triage estimate';
}

export function formatGenerationFeatureTarget(
  featureTarget?: number,
  featureMin?: number,
  featureMax?: number,
): string {
  if (typeof featureTarget !== 'number') return 'Assessing';
  const hasBand =
    typeof featureMin === 'number'
    && typeof featureMax === 'number'
    && (featureMin !== featureTarget || featureMax !== featureTarget);
  if (hasBand) {
    return `${featureMin}–${featureMax} (centre ${featureTarget})`;
  }
  return `Forecast ${featureTarget}`;
}

/** Shown under triage feature estimate during generation to set expectations. */
export function generationTriageFeatureFootnote(): string {
  return 'Advisory band from triage — final feature count comes from decomposition.';
}

export function getDraftFeatureHeading(): string {
  return 'Draft features';
}

export function getDraftFeatureNote(): string | null {
  return null;
}

export function getSizingRunContextNote(
  sizingAssessment?: GenerationSizingAssessment | null,
): string | null {
  void sizingAssessment;
  return null;
}

export function getApprovedDraftStructureNote(): string {
  return 'Using approved feature structure';
}

export function getCoverageReviewSummary(
  coverageReview?: CoverageReviewAdvice | null,
): { label: string; tone: 'success' | 'warning'; details: string[]; heading?: string } | null {
  if (!coverageReview) return null;
  if (coverageReview.sufficient) {
    return {
      label: 'Coverage check looks complete',
      tone: 'success',
      details: [],
    };
  }

  const details = (coverageReview.missingCoverage ?? []).map((item) => String(item ?? '').trim()).filter(Boolean);
  const count = details.length || 1;
  return {
    label: `Coverage check found ${count} area${count === 1 ? '' : 's'} to review`,
    tone: 'warning',
    details,
    heading: count === 1 ? 'Gap to review' : `${count} gaps to review`,
  };
}

/**
 * Normalises discovery question counts for UI (avoids NaN, negatives, and stray strings from storage).
 */
export function coerceNonNegativeQuestionCount(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < 0) return null;
  return rounded;
}

/** Triage / sizing hint for how many questions discovery might need (advisory only). */
export function pickAdvisoryDiscoveryQuestionForecast(input: {
  advisoryForecast?: Partial<AdvisoryDiscoveryForecast> | null;
  sizingEstimatedQuestions?: unknown;
  assessmentEstimatedQuestions?: unknown;
}): number | null {
  const fromAdvisory = coerceNonNegativeQuestionCount(input.advisoryForecast?.recommendedInitialCount);
  if (fromAdvisory != null) return fromAdvisory;
  const fromSizing = coerceNonNegativeQuestionCount(input.sizingEstimatedQuestions);
  if (fromSizing != null) return fromSizing;
  return coerceNonNegativeQuestionCount(input.assessmentEstimatedQuestions);
}

/** Actual first-round question count when clarify has finished (preferred over advisory). */
export function pickFirstRoundQuestionCount(input: {
  initialQuestionCount?: unknown;
  discoveryProfile?: Partial<DiscoveryProfile> | null;
  ambiguityGeneratedQuestions?: unknown;
}): number | null {
  const fromInitial = coerceNonNegativeQuestionCount(input.initialQuestionCount);
  if (fromInitial != null) return fromInitial;
  const fromActual = coerceNonNegativeQuestionCount(input.discoveryProfile?.actualQuestionsAsked);
  if (fromActual != null) return fromActual;
  const fromProfile = coerceNonNegativeQuestionCount(input.discoveryProfile?.recommendedInitialCount);
  if (fromProfile != null) return fromProfile;
  return coerceNonNegativeQuestionCount(input.ambiguityGeneratedQuestions);
}

export function getDiscoveryProfileHeadline(
  discoveryProfile?: ClarifyProgressPayload['discoveryProfile'] | null,
): string {
  if (!discoveryProfile) return 'Assessing scope and ambiguity';

  const scopeLabel: Record<string, string> = {
    narrow: 'Narrow scope',
    moderate: 'Moderate scope',
    broad: 'Broad scope',
    very_broad: 'Very broad scope',
  };
  const ambiguityLabel: Record<string, string> = {
    low: 'Low ambiguity',
    medium: 'Moderate ambiguity',
    high: 'High ambiguity',
  };

  const scope = scopeLabel[discoveryProfile.scope] ?? discoveryProfile.scope;
  const ambiguity = ambiguityLabel[discoveryProfile.ambiguity] ?? discoveryProfile.ambiguity;
  return `${scope} / ${ambiguity}`;
}

type DiscoveryDisplayComplexity = DiscoveryProfile['complexity'];

const DISCOVERY_COMPLEXITY_ORDER: DiscoveryDisplayComplexity[] = ['low', 'medium', 'high', 'very_high'];

function bumpDiscoveryComplexity(
  value: DiscoveryDisplayComplexity,
  steps = 1,
): DiscoveryDisplayComplexity {
  const index = DISCOVERY_COMPLEXITY_ORDER.indexOf(value);
  if (index < 0) return value;
  return DISCOVERY_COMPLEXITY_ORDER[Math.min(DISCOVERY_COMPLEXITY_ORDER.length - 1, index + steps)];
}

export function getDiscoveryDisplayComplexity(input: {
  discoveryProfile?: Partial<DiscoveryProfile> | null;
  advisoryForecast?: Partial<AdvisoryDiscoveryForecast> | null;
  plannedQuestions?: number | null;
}): DiscoveryDisplayComplexity | null {
  const profile = input.discoveryProfile;
  const advisory = input.advisoryForecast;
  const base = profile?.complexity ?? advisory?.complexity ?? null;
  if (!base) return null;

  const ambiguity = profile?.ambiguity ?? advisory?.ambiguity ?? 'medium';
  const scope = profile?.scope ?? advisory?.scope ?? 'moderate';
  const plannedQuestions =
    coerceNonNegativeQuestionCount(input.plannedQuestions)
    ?? coerceNonNegativeQuestionCount(profile?.recommendedInitialCount)
    ?? coerceNonNegativeQuestionCount(advisory?.recommendedInitialCount)
    ?? 0;
  const followupCap = typeof profile?.followupCap === 'number'
    ? profile.followupCap
    : typeof advisory?.followupCap === 'number'
      ? advisory.followupCap
      : 0;

  let displayComplexity = base;

  if (ambiguity === 'high') {
    const strongDiscoveryLoad = plannedQuestions >= 10 || followupCap >= 6;
    const broadDiscoveryLoad = scope === 'broad' || scope === 'very_broad';

    if (displayComplexity === 'medium' && (strongDiscoveryLoad || broadDiscoveryLoad)) {
      displayComplexity = 'high';
    } else if (displayComplexity === 'low' && strongDiscoveryLoad) {
      displayComplexity = 'medium';
    }
  }

  if (displayComplexity === 'high' && scope === 'very_broad' && plannedQuestions >= 14 && ambiguity !== 'low') {
    displayComplexity = bumpDiscoveryComplexity(displayComplexity);
  }

  return displayComplexity;
}

export type SourceContextChip = { id: string; label: string };

export function getSourceContextChips(input?: {
  projectCount?: number;
  domainContextApplied?: boolean;
  attachmentIncluded?: boolean;
  wiDocsCount?: number;
  linkedWiDocCount?: number;
  retrievedWiDocCount?: number;
  retrievedWiChunkCount?: number;
  wiInsightCount?: number;
  similarStoriesCount?: number;
} | null): SourceContextChip[] {
  if (!input) return [];

  const chips: SourceContextChip[] = [];
  if (typeof input.projectCount === 'number' && input.projectCount > 0) {
    chips.push({
      id: 'project',
      label: input.projectCount === 1 ? '1 project' : `${input.projectCount} projects`,
    });
  }
  if (input.domainContextApplied) {
    chips.push({ id: 'guidance', label: 'Guidance on' });
  }
  if (input.attachmentIncluded) {
    chips.push({ id: 'attachment', label: 'Attachment included' });
  }
  const retrievedWiDocCount = typeof input.retrievedWiDocCount === 'number'
    ? input.retrievedWiDocCount
    : input.wiDocsCount;
  const linkedWiDocCount = typeof input.linkedWiDocCount === 'number'
    ? input.linkedWiDocCount
    : undefined;
  if (typeof linkedWiDocCount === 'number' && linkedWiDocCount > 0) {
    chips.push({
      id: 'wi',
      label: typeof retrievedWiDocCount === 'number'
        ? `${retrievedWiDocCount}/${linkedWiDocCount} work instructions retrieved`
        : linkedWiDocCount === 1
          ? '1 linked work instruction'
          : `${linkedWiDocCount} linked work instructions`,
    });
  } else if (typeof retrievedWiDocCount === 'number' && retrievedWiDocCount > 0) {
    chips.push({
      id: 'wi',
      label: retrievedWiDocCount === 1 ? '1 work instruction retrieved' : `${retrievedWiDocCount} work instructions retrieved`,
    });
  }
  if (typeof input.wiInsightCount === 'number' && input.wiInsightCount > 0) {
    chips.push({
      id: 'wi-insights',
      label: input.wiInsightCount === 1 ? '1 WI insight' : `${input.wiInsightCount} WI insights`,
    });
  }
  if (typeof input.similarStoriesCount === 'number' && input.similarStoriesCount > 0) {
    chips.push({
      id: 'similar',
      label: input.similarStoriesCount === 1 ? '1 similar story' : `${input.similarStoriesCount} similar stories`,
    });
  }
  return chips;
}
