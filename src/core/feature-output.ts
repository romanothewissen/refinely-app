import { v4 as uuidv4 } from 'uuid';

import type {
  AcceptanceRequirement,
  ClarifyAnswer,
  Feature,
  FeatureActorSource,
  FeatureClass,
  FeatureConfidence,
} from '../types';
import { hasIncompleteAcceptanceRequirements } from './ar-validation';

interface RawFeature {
  id?: string;
  summary?: string;
  description?: string;
  acceptance_requirements?: unknown[];
  acceptanceRequirements?: unknown[];
  suggested_story_points?: number;
  process_code?: string;
  feature_class?: unknown;
  featureClass?: unknown;
  actor_source?: unknown;
  actorSource?: unknown;
  confidence?: unknown;
}

interface RoleGroundingContext {
  requirement?: string;
  clarifyAnswers?: ClarifyAnswer[];
  domainRoles?: string[];
}

const VALID_FEATURE_CLASSES = new Set<FeatureClass>(['business_capability', 'technical_enabler', 'cross_cutting_rule']);
const VALID_FEATURE_CONFIDENCE = new Set<FeatureConfidence>(['confirmed', 'assumption_applied']);
const VALID_ACTOR_SOURCES = new Set<FeatureActorSource>(['prompt', 'clarify', 'workspace_role', 'fallback']);
const INCOMPLETE_AR_RETRY_MESSAGE = 'Acceptance requirements could not be completed automatically. Retry this feature to finish its ARs.';

const TECHNICAL_FEATURE_TERMS = [
  'integration', 'ingest', 'ingestion', 'parse', 'parsing', 'sync', 'synchronization', 'transmission',
  'payload', 'logfile', 'mapping', 'transform', 'monitor integration', 'integration status', 'data flow',
  'external source', 'external system', 'event processing', 'processing pipeline', 'automated processing',
  'event notification', 'polling mechanism', 'queue', 'batch processing',
];

const CROSS_CUTTING_FEATURE_TERMS = [
  'audit', 'audit trail', 'permission', 'permissions', 'access policy', 'role-based access',
  'traceability', 'compliance', 'retention', 'cannot be deleted', 'must not be deleted',
  'non-deletion', 'immutable history', 'historical integrity',
];

function sanitizeClause(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function hasAnyArContent(ar: { given?: string; when?: string; then?: string }): boolean {
  return Boolean(ar.given?.trim() || ar.when?.trim() || ar.then?.trim());
}

function hasCompleteArClauses(ar: { given?: string; when?: string; then?: string }): boolean {
  return Boolean(ar.given?.trim() && ar.when?.trim() && ar.then?.trim());
}

function clausesEqualOrMissing(left: string, right: string): boolean {
  if (!left || !right) return true;
  return left.toLowerCase() === right.toLowerCase();
}

function canMergeArFragments(pending: AcceptanceRequirement, incoming: AcceptanceRequirement): boolean {
  if (hasCompleteArClauses(pending) || !hasAnyArContent(incoming)) return false;

  const fillsMissingClause =
    (!pending.given && !!incoming.given) ||
    (!pending.when && !!incoming.when) ||
    (!pending.then && !!incoming.then);

  if (!fillsMissingClause) return false;

  return clausesEqualOrMissing(pending.given, incoming.given)
    && clausesEqualOrMissing(pending.when, incoming.when)
    && clausesEqualOrMissing(pending.then, incoming.then);
}

function mergeArFragments(pending: AcceptanceRequirement, incoming: AcceptanceRequirement): AcceptanceRequirement {
  return {
    given: pending.given || incoming.given,
    when: pending.when || incoming.when,
    then: pending.then || incoming.then,
  };
}

function parseArString(value: string): AcceptanceRequirement {
  const text = value.trim();
  const givenMatch = text.match(/GIVEN\s+([\s\S]+?)(?=\s+(?:WHEN|THEN)\b|$)/i);
  const whenMatch = text.match(/WHEN\s+([\s\S]+?)(?=\s+THEN\b|$)/i);
  const thenMatch = text.match(/THEN\s+([\s\S]+)$/i);

  let given = sanitizeClause(givenMatch?.[1] ?? '');
  let when = sanitizeClause(whenMatch?.[1] ?? '');
  let then = sanitizeClause(thenMatch?.[1] ?? '');

  given = sanitizeClause(given.replace(/^(GIVEN|WHEN|THEN)\s+/i, ''));
  when = sanitizeClause(when.replace(/^(GIVEN|WHEN|THEN)\s+/i, ''));
  then = sanitizeClause(then.replace(/^(GIVEN|WHEN|THEN)\s+/i, ''));

  if (given || when || then) {
    return { given, when, then };
  }

  return { given: '', when: '', then: sanitizeClause(text.replace(/^(GIVEN|WHEN|THEN)\s+/i, '')) };
}

export function repairAcceptanceRequirements(
  ars: Array<{ given?: string; when?: string; then?: string }>,
): AcceptanceRequirement[] {
  const repaired: AcceptanceRequirement[] = [];
  let pending: AcceptanceRequirement | null = null;

  for (const rawAr of ars) {
    const fragment: AcceptanceRequirement = {
      given: sanitizeClause(rawAr.given),
      when: sanitizeClause(rawAr.when),
      then: sanitizeClause(rawAr.then),
    };

    if (!hasAnyArContent(fragment)) continue;

    if (!pending) {
      pending = fragment;
      if (hasCompleteArClauses(pending)) {
        repaired.push(pending);
        pending = null;
      }
      continue;
    }

    if (canMergeArFragments(pending, fragment)) {
      pending = mergeArFragments(pending, fragment);
      if (hasCompleteArClauses(pending)) {
        repaired.push(pending);
        pending = null;
      }
      continue;
    }

    repaired.push(pending);
    pending = fragment;
    if (hasCompleteArClauses(pending)) {
      repaired.push(pending);
      pending = null;
    }
  }

  if (pending) repaired.push(pending);

  const complete = repaired.filter(hasCompleteArClauses);
  return complete.length ? complete : repaired.filter(hasAnyArContent);
}

function getRawAcceptanceArray(raw: RawFeature): unknown[] {
  const snake = raw.acceptance_requirements;
  const camel = raw.acceptanceRequirements;
  if (Array.isArray(snake) && snake.length) return snake;
  if (Array.isArray(camel) && camel.length) return camel;
  if (Array.isArray(snake)) return snake;
  if (Array.isArray(camel)) return camel;
  return [];
}

function normaliseArs(ars: unknown[]): AcceptanceRequirement[] {
  const parsed = ars
    .map((ar) => {
      if (typeof ar === 'string') return parseArString(ar);
      if (typeof ar === 'object' && ar !== null) {
        const obj = ar as Record<string, unknown>;
        return {
          given: sanitizeClause(obj.given ?? obj.Given ?? obj.GIVEN ?? ''),
          when: sanitizeClause(obj.when ?? obj.When ?? obj.WHEN ?? ''),
          then: sanitizeClause(obj.then ?? obj.Then ?? obj.THEN ?? ''),
        };
      }
      return null;
    })
    .filter((item): item is AcceptanceRequirement => item !== null && hasAnyArContent(item));

  return repairAcceptanceRequirements(parsed);
}

function deduplicateDescription(description: string): string {
  const asAPattern = /As an?\s+/gi;
  const matches: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = asAPattern.exec(description)) !== null) {
    matches.push(match.index);
  }
  if (matches.length <= 1) return description;

  const lastStart = matches[matches.length - 1];
  const candidate = description.slice(lastStart).trim();
  if (/^As an?\s+.+,\s*I need/i.test(candidate)) return candidate;

  if (matches.length >= 2) {
    const secondLast = description.slice(matches[matches.length - 2]).trim();
    if (/^As an?\s+.+,\s*I need/i.test(secondLast)) return secondLast;
  }
  return description;
}

function normalizeDraftDescriptionText(description: string): string {
  let cleaned = deduplicateDescription(description)
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();

  cleaned = cleaned.replace(/\bso that\b\s+(.*?)\s+\bso that\b\s+\1\b/i, 'so that $1');
  return cleaned.trim();
}

function extractRoleFromDescription(description: string): string | null {
  const match = description.match(/^As an?\s+(.+?),\s*I need(?:\s+to)?\s+/i);
  return match?.[1]?.trim() || null;
}

function countMatchedPhrases(text: string, terms: string[]): number {
  const haystack = String(text ?? '').toLowerCase();
  return terms.reduce((count, term) => count + (haystack.includes(term.toLowerCase()) ? 1 : 0), 0);
}

function looksLikeTechnicalActor(role: string): boolean {
  const normalized = role.trim().toLowerCase();
  if (!normalized) return false;
  return /\b(integration|service|system|platform|pipeline|processor)\b/.test(normalized)
    && !/\b(field service|technical support|support specialist|service quality|administrator)\b/.test(normalized);
}

function normalizeFeatureClass(value: unknown): FeatureClass | undefined {
  const normalized = String(value ?? '').trim();
  return VALID_FEATURE_CLASSES.has(normalized as FeatureClass) ? normalized as FeatureClass : undefined;
}

function normalizeFeatureConfidence(value: unknown): FeatureConfidence | undefined {
  const normalized = String(value ?? '').trim();
  return VALID_FEATURE_CONFIDENCE.has(normalized as FeatureConfidence) ? normalized as FeatureConfidence : undefined;
}

function normalizeFeatureActorSource(value: unknown): FeatureActorSource | undefined {
  const normalized = String(value ?? '').trim();
  return VALID_ACTOR_SOURCES.has(normalized as FeatureActorSource) ? normalized as FeatureActorSource : undefined;
}

function determineFeatureClass(raw: RawFeature): FeatureClass {
  const explicit = normalizeFeatureClass(raw.feature_class ?? raw.featureClass);
  const content = `${raw.summary ?? ''} ${raw.description ?? ''}`;
  const role = extractRoleFromDescription(String(raw.description ?? '')) ?? '';
  const strongCrossCuttingSignal =
    countMatchedPhrases(content, CROSS_CUTTING_FEATURE_TERMS) >= 1
    || /\b(audit trail|cannot be deleted|must not be deleted|retain(?:ed|ing)? history|historical integrity)\b/i.test(content);
  const strongTechnicalSignal =
    looksLikeTechnicalActor(role)
    || countMatchedPhrases(content, TECHNICAL_FEATURE_TERMS) >= 2
    || /\b(parse|extract|ingest|monitor|poll|match|map|transform|payload|external source|external system)\b/i.test(content);

  if (explicit === 'cross_cutting_rule') return explicit;
  if (strongCrossCuttingSignal) return 'cross_cutting_rule';
  if (explicit === 'technical_enabler') return explicit;
  if (strongTechnicalSignal) return 'technical_enabler';
  return explicit ?? 'business_capability';
}

function determineActorSource(description: string, roleGrounding?: RoleGroundingContext, raw?: RawFeature): FeatureActorSource {
  const explicit = normalizeFeatureActorSource(raw?.actor_source ?? raw?.actorSource);
  if (explicit) return explicit;
  const role = extractRoleFromDescription(description)?.toLowerCase();
  if (!role || role === 'authorized user') return 'fallback';

  const requirement = String(roleGrounding?.requirement ?? '').toLowerCase();
  if (requirement.includes(role)) return 'prompt';

  const clarifyTexts = (roleGrounding?.clarifyAnswers ?? [])
    .flatMap((answer) => [answer.question, answer.answer, answer.customAnswer, ...(answer.selectedSuggestions ?? [])])
    .join(' ')
    .toLowerCase();
  if (clarifyTexts.includes(role)) return 'clarify';

  const workspaceRoles = (roleGrounding?.domainRoles ?? []).map((value) => String(value ?? '').trim().toLowerCase());
  if (workspaceRoles.includes(role)) return 'workspace_role';

  return 'fallback';
}

function determineFeatureConfidence(feature: {
  description: string;
  actorSource?: FeatureActorSource;
  raw?: RawFeature;
}): FeatureConfidence {
  const explicit = normalizeFeatureConfidence(feature.raw?.confidence);
  if (explicit) return explicit;
  if ((feature.actorSource ?? 'fallback') === 'fallback') return 'assumption_applied';
  if (/authorized user/i.test(feature.description)) return 'assumption_applied';
  return 'confirmed';
}

function featureHasCompleteAcceptanceRequirements(feature: Pick<Feature, 'acceptanceRequirements'>): boolean {
  return Array.isArray(feature.acceptanceRequirements)
    && feature.acceptanceRequirements.length > 0
    && !hasIncompleteAcceptanceRequirements(feature.acceptanceRequirements);
}

export class GenerationCancelledError extends Error {
  constructor() {
    super('Generation cancelled');
    this.name = 'GenerationCancelledError';
  }
}

export function findFeaturesMissingCompleteAcceptanceRequirements(
  features: Array<Pick<Feature, 'acceptanceRequirements'>>,
): number[] {
  return features.reduce<number[]>((indexes, feature, index) => {
    if (!featureHasCompleteAcceptanceRequirements(feature)) indexes.push(index);
    return indexes;
  }, []);
}

export function annotateFailedAcceptanceRequirementFeatures(features: Feature, failedIds: Set<string>): Feature;
export function annotateFailedAcceptanceRequirementFeatures(features: Feature[], failedIds: Set<string>): Feature[];
export function annotateFailedAcceptanceRequirementFeatures(features: Feature | Feature[], failedIds: Set<string>): Feature | Feature[] {
  const applyToFeature = (feature: Feature): Feature => {
    if (failedIds.has(feature.id)) {
      return {
        ...feature,
        arGenerationStatus: 'failed',
        arGenerationError: INCOMPLETE_AR_RETRY_MESSAGE,
      };
    }

    const nextFeature = { ...feature };
    delete nextFeature.arGenerationStatus;
    delete nextFeature.arGenerationError;
    return nextFeature;
  };

  return Array.isArray(features)
    ? features.map((feature) => applyToFeature(feature))
    : applyToFeature(features);
}

export function normaliseFeature(raw: RawFeature, roleGrounding?: RoleGroundingContext): Feature {
  const draft: Feature = {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : uuidv4(),
    summary: raw.summary ?? 'Untitled feature',
    description: raw.description ?? '',
    acceptanceRequirements: normaliseArs(getRawAcceptanceArray(raw)),
    storyPoints: raw.suggested_story_points,
    processCode: raw.process_code,
  };

  const description = normalizeDraftDescriptionText(draft.description);
  const actorSource = determineActorSource(description, roleGrounding, raw);

  return {
    ...draft,
    description,
    featureClass: determineFeatureClass({ ...raw, description }),
    actorSource,
    confidence: determineFeatureConfidence({ description, actorSource, raw }),
  };
}
