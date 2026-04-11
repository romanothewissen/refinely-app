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

export function formatGenerationFeatureTarget(featureTarget?: number): string {
  return typeof featureTarget === 'number' ? `Forecast ${featureTarget}` : 'Assessing';
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
  const plannedQuestions = typeof input.plannedQuestions === 'number'
    ? input.plannedQuestions
    : typeof profile?.recommendedInitialCount === 'number'
      ? profile.recommendedInitialCount
      : typeof advisory?.recommendedInitialCount === 'number'
        ? advisory.recommendedInitialCount
        : 0;
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

export function getSourceContextChips(input?: {
  projectCount?: number;
  domainContextApplied?: boolean;
  attachmentIncluded?: boolean;
  wiDocsCount?: number;
  similarStoriesCount?: number;
} | null): string[] {
  if (!input) return [];

  const chips: string[] = [];
  if (typeof input.projectCount === 'number' && input.projectCount > 0) {
    chips.push(input.projectCount === 1 ? '1 project' : `${input.projectCount} projects`);
  }
  if (input.domainContextApplied) chips.push('Guidance on');
  if (input.attachmentIncluded) chips.push('Attachment included');
  if (typeof input.wiDocsCount === 'number' && input.wiDocsCount > 0) {
    chips.push(input.wiDocsCount === 1 ? '1 work instruction' : `${input.wiDocsCount} work instructions`);
  }
  if (typeof input.similarStoriesCount === 'number' && input.similarStoriesCount > 0) {
    chips.push(input.similarStoriesCount === 1 ? '1 similar story' : `${input.similarStoriesCount} similar stories`);
  }
  return chips;
}
