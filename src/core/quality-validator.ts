import { AcceptanceRequirement, Feature, TenantConfig, ValidationViolation } from '../types';

const SOLUTION_TERMS = [
  'button', 'click', 'screen', 'field', 'form', 'dropdown', 'checkbox',
  'modal', 'dialog', 'tab', 'panel', 'page', 'ui', 'interface', 'api',
  'database', 'table', 'column', 'query', 'endpoint', 'webhook', 'payload',
  'javascript', 'css', 'html', 'react', 'angular', 'node', 'python',
];

const IMPLEMENTATION_FLAVORED_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bdesignated inbox\b/i, label: 'designated inbox' },
  { pattern: /\bsubject(?: line)?\b/i, label: 'subject line' },
  { pattern: /\b(?:case|reference)\s+(?:id|identifier)\b/i, label: 'reference ID' },
  { pattern: /\bemail content\b/i, label: 'email content' },
  { pattern: /\bappend(?:ed|s)?\b/i, label: 'append operation' },
  { pattern: /\bthe system\s+(?:identifies|matches|parses|reads|extracts|detects|appends)\b/i, label: 'system action wording' },
];

// Stop-words / incomplete-sentence terminators. An AR clause that ends on one of these reads as truncated.
const TRUNCATED_TRAILING_WORDS = new Set([
  'a', 'an', 'the',
  'and', 'or', 'but', 'nor',
  'for', 'to', 'of', 'in', 'on', 'at', 'by', 'with', 'from', 'into', 'onto', 'upon', 'about', 'as',
  'that', 'which', 'who', 'whom', 'whose', 'when', 'where', 'while',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'has', 'have', 'had',
  'does', 'do', 'did',
  'can', 'could', 'should', 'would', 'may', 'might', 'must', 'shall', 'will',
  'contains', 'matches', 'indicates', 'receives', 'attempts',
]);

const AR_NEAR_DUPLICATE_JACCARD_THRESHOLD = 0.85;
const AR_DEDUP_STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'by', 'with', 'from', 'for',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'has', 'have', 'had', 'does', 'do', 'did',
  'that', 'which', 'this', 'these', 'those', 'it', 'its', 'as', 'into', 'onto',
]);

// Feature-level overlap detection thresholds
const FEATURE_OVERLAP_JACCARD_THRESHOLD = 0.55;
// Overlap coefficient catches the case where one feature's content is largely contained in the
// other's even though Jaccard is diluted by distinct verbiage on each side.
const FEATURE_OVERLAP_COEFFICIENT_THRESHOLD = 0.5;
const FEATURE_OVERLAP_MIN_SHARED_TOKENS = 5;
const FEATURE_OVERLAP_SUMMARY_SUBSET_MIN_TOKENS = 2;

/** One overlap candidate between two features in the same feature set. */
export interface FeatureOverlap {
  leftFeatureId: string;
  leftSummary: string;
  rightFeatureId: string;
  rightSummary: string;
  similarity: number;
  reason: 'token_jaccard' | 'token_overlap_coefficient' | 'summary_subset';
}

const GIVEN_CONFIG_ANTI_PATTERNS = [
  /configured for/i,
  /activation type/i,
  /trigger event/i,
  /configured mode/i,
  /system (is|has been) (set|configured)/i,
];

const ROLE_HINT_WORDS = new Set([
  'user',
  'person',
  'individual',
  'professional',
  'worker',
  'staff',
  'member',
  'associate',
  'resource',
  'agent',
  'operator',
  'representative',
  'specialist',
  'technician',
  'engineer',
  'manager',
  'administrator',
  'admin',
  'dispatcher',
  'planner',
]);

const OPEN_DECISION_LEAKAGE_PATTERNS = [
  /^\s*(what|how|who|when|should|do we|does it|is it|can it)\b/i,
  /\bopen question\b/i,
  /\bto be decided\b/i,
  /\bdefine duplication criteria\b/i,
];

function looksLikeOpenDecisionText(text: string): boolean {
  const normalized = String(text ?? '').trim();
  if (!normalized) return false;
  return OPEN_DECISION_LEAKAGE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function extractRoleFromDescription(description: string): string | null {
  const match = description.match(/^As an?\s+(.+?),\s*I need(?:\s+to)?\s+/i);
  return match?.[1]?.trim() || null;
}

function normalizeRole(text: string): string {
  return (text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractLeadingRolePhrase(clause: string): string | null {
  const match = clause.match(/\b(?:a|an|the)\s+([A-Za-z][A-Za-z\s/-]{1,60}?)(?=\s+(?:has|have|is|are|was|were|needs|need|can|cannot|must|should|views|receives|creates|updates|submits|opens|reviews|approves|rejects|selects|starts|attempts|works|manages|uses|belongs)\b)/i);
  return match?.[1]?.trim() || null;
}

function looksLikeRolePhrase(text: string): boolean {
  const tokens = normalizeRole(text).split(' ').filter(Boolean);
  return tokens.some(token => ROLE_HINT_WORDS.has(token));
}

function countSoThatOccurrences(text: string): number {
  const matches = text.match(/\bso that\b/gi);
  return matches ? matches.length : 0;
}

function clauseEndsOnStopWord(clause: string): boolean {
  if (!clause) return false;
  const cleaned = clause.replace(/[.,;:!?)"'\s]+$/g, '').trim();
  if (!cleaned) return false;
  const tokens = cleaned.split(/\s+/);
  const lastToken = tokens[tokens.length - 1]?.toLowerCase().replace(/[^a-z]/g, '');
  if (!lastToken) return false;
  return TRUNCATED_TRAILING_WORDS.has(lastToken);
}

function tokenizeArForFingerprint(ar: AcceptanceRequirement): Set<string> {
  const raw = `${ar.given} ${ar.when} ${ar.then}`.toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9\s]/g, ' ');
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  const filtered = tokens.filter(token => token.length > 2 && !AR_DEDUP_STOP_WORDS.has(token));
  return new Set(filtered);
}

function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function stripUserStoryScaffolding(description: string): string {
  // Strip "As a X, I need to ... so that ..." boilerplate so the remaining tokens are the content.
  return description
    .replace(/^As an?\s+[^,]+,\s*I need(?:\s+to)?\s+/i, '')
    .replace(/\s+so that\s+.*$/i, '');
}

function tokenizeFeatureForOverlap(text: string): Set<string> {
  const cleaned = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  const filtered = tokens.filter(token => token.length > 2 && !AR_DEDUP_STOP_WORDS.has(token));
  return new Set(filtered);
}

function isTokenSubset(maybeSubset: Set<string>, container: Set<string>): boolean {
  if (maybeSubset.size < FEATURE_OVERLAP_SUMMARY_SUBSET_MIN_TOKENS) return false;
  if (maybeSubset.size >= container.size) return false;
  for (const token of maybeSubset) {
    if (!container.has(token)) return false;
  }
  return true;
}

/**
 * Detects feature-level overlap across a set of Pass 1 draft features.
 * Uses token-Jaccard over (summary + description body without scaffolding),
 * plus a summary-subset check that catches "Case Creation" ⊂ "Case Creation and Classification".
 * No embeddings, no LLM — deterministic and cheap. Returns one entry per overlapping pair.
 */
export function detectFeatureOverlaps(features: Feature[]): FeatureOverlap[] {
  if (!features.length) return [];

  const prepared = features.map((feature) => {
    const summaryText = feature.summary ?? '';
    const contentText = `${summaryText} ${stripUserStoryScaffolding(feature.description ?? '')}`;
    return {
      id: feature.id,
      summary: summaryText,
      summaryTokens: tokenizeFeatureForOverlap(summaryText),
      contentTokens: tokenizeFeatureForOverlap(contentText),
    };
  });

  const overlaps: FeatureOverlap[] = [];
  for (let i = 0; i < prepared.length; i += 1) {
    for (let j = i + 1; j < prepared.length; j += 1) {
      const left = prepared[i];
      const right = prepared[j];

      const intersection = countIntersection(left.contentTokens, right.contentTokens);
      const union = left.contentTokens.size + right.contentTokens.size - intersection;
      const jaccard = union === 0 ? 0 : intersection / union;
      const minSize = Math.min(left.contentTokens.size, right.contentTokens.size);
      const overlapCoefficient = minSize === 0 ? 0 : intersection / minSize;

      if (jaccard >= FEATURE_OVERLAP_JACCARD_THRESHOLD && intersection >= FEATURE_OVERLAP_MIN_SHARED_TOKENS) {
        overlaps.push({
          leftFeatureId: left.id,
          leftSummary: left.summary,
          rightFeatureId: right.id,
          rightSummary: right.summary,
          similarity: jaccard,
          reason: 'token_jaccard',
        });
        continue;
      }
      if (
        overlapCoefficient >= FEATURE_OVERLAP_COEFFICIENT_THRESHOLD
        && intersection >= FEATURE_OVERLAP_MIN_SHARED_TOKENS
      ) {
        overlaps.push({
          leftFeatureId: left.id,
          leftSummary: left.summary,
          rightFeatureId: right.id,
          rightSummary: right.summary,
          similarity: overlapCoefficient,
          reason: 'token_overlap_coefficient',
        });
        continue;
      }
      // Summary-subset: one summary's tokens are a strict subset of the other's (e.g. "Case Creation" ⊂ "Case Creation and Classification").
      if (isTokenSubset(left.summaryTokens, right.summaryTokens) || isTokenSubset(right.summaryTokens, left.summaryTokens)) {
        overlaps.push({
          leftFeatureId: left.id,
          leftSummary: left.summary,
          rightFeatureId: right.id,
          rightSummary: right.summary,
          similarity: jaccard,
          reason: 'summary_subset',
        });
      }
    }
  }
  return overlaps;
}

function countIntersection(left: Set<string>, right: Set<string>): number {
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  return intersection;
}

export function featureOverlapsToViolations(overlaps: FeatureOverlap[]): ValidationViolation[] {
  return overlaps.map((overlap) => {
    let message: string;
    if (overlap.reason === 'summary_subset') {
      message = `Feature overlaps with "${overlap.rightSummary}" (summary subset)`;
    } else if (overlap.reason === 'token_overlap_coefficient') {
      message = `Feature overlaps with "${overlap.rightSummary}" (content largely contained, overlap ${overlap.similarity.toFixed(2)})`;
    } else {
      message = `Feature overlaps with "${overlap.rightSummary}" (similarity ${overlap.similarity.toFixed(2)})`;
    }
    return {
      featureId: overlap.leftFeatureId,
      field: 'features',
      message,
    };
  });
}

export function validateFeatures(features: Feature[], config: TenantConfig): ValidationViolation[] {
  const violations: ValidationViolation[] = [];
  const featureRoles = features
    .map((feature) => extractRoleFromDescription(feature.description))
    .filter((role): role is string => Boolean(role));
  const hasSpecificRoleElsewhere = featureRoles.some((role) => normalizeRole(role) !== 'authorized user');
  const configuredRoles = new Set((config.domainRoles ?? []).map((role) => normalizeRole(role)).filter(Boolean));

  for (const feature of features) {
    // Check description format
    if (!feature.description.match(/^As an? .+, I need(?: to)? .+ so that .+/i)) {
      violations.push({
        featureId: feature.id,
        field: 'description',
        message: 'Description must follow "As a [role], I need [action] so that [benefit]" format',
      });
    }

    // Check for duplicated "so that" clause (regression guard for replaceFeatureRole fallback appending twice)
    if (countSoThatOccurrences(feature.description) > 1) {
      violations.push({
        featureId: feature.id,
        field: 'description',
        message: 'Description contains duplicated "so that" clause',
      });
    }

    if (looksLikeOpenDecisionText(feature.summary) || looksLikeOpenDecisionText(feature.description)) {
      violations.push({
        featureId: feature.id,
        field: 'description',
        message: 'Feature appears to include unresolved decision wording instead of a confirmed requirement',
      });
    }

    // Check for solution language in description
    const descLower = feature.description.toLowerCase();
    for (const term of SOLUTION_TERMS) {
      if (descLower.includes(term)) {
        violations.push({
          featureId: feature.id,
          field: 'description',
          message: `Contains solution language: "${term}"`,
        });
        break;
      }
    }

    // Check process code if taxonomy is enabled
    if (config.processTaxonomyEnabled && config.processTaxonomy.length) {
      const validCodes = new Set(config.processTaxonomy.map(p => p.code));
      if (!feature.processCode || !validCodes.has(feature.processCode)) {
        violations.push({
          featureId: feature.id,
          field: 'processCode',
          message: `Invalid or missing process code: "${feature.processCode}"`,
        });
      }
    }

    // Check ARs
    const featureRole = extractRoleFromDescription(feature.description);
    if (
      featureRole
      && normalizeRole(featureRole) === 'authorized user'
      && (hasSpecificRoleElsewhere || configuredRoles.size > 0)
    ) {
      violations.push({
        featureId: feature.id,
        field: 'description',
        message: 'Feature uses generic role wording even though more specific roles are available',
      });
    }
    if (feature.actorSource === 'fallback' && feature.confidence === 'confirmed') {
      violations.push({
        featureId: feature.id,
        field: 'description',
        message: 'Feature is marked confirmed even though the actor source is fallback',
      });
    }

    for (const ar of feature.acceptanceRequirements) {
      if (!ar.given || !ar.when || !ar.then) {
        violations.push({
          featureId: feature.id,
          field: 'acceptanceRequirements',
          message: 'AR missing GIVEN, WHEN, or THEN clause',
        });
      }

      // Check for truncated clauses (regression guard for trimVerboseSegment mid-sentence slicing)
      const truncatedClauses: string[] = [];
      if (clauseEndsOnStopWord(ar.given)) truncatedClauses.push('GIVEN');
      if (clauseEndsOnStopWord(ar.when)) truncatedClauses.push('WHEN');
      if (clauseEndsOnStopWord(ar.then)) truncatedClauses.push('THEN');
      if (truncatedClauses.length > 0) {
        violations.push({
          featureId: feature.id,
          field: 'acceptanceRequirements',
          message: `AR clause appears truncated (${truncatedClauses.join(', ')})`,
        });
      }

      // Check for config-state anti-patterns in GIVEN
      for (const pattern of GIVEN_CONFIG_ANTI_PATTERNS) {
        if (pattern.test(ar.given)) {
          violations.push({
            featureId: feature.id,
            field: 'acceptanceRequirements',
            message: `GIVEN clause uses configuration/system-state language: "${ar.given.slice(0, 60)}"`,
          });
          break;
        }
      }

      // Check for solution language in ARs
      const arText = `${ar.given} ${ar.when} ${ar.then}`.toLowerCase();
      for (const term of SOLUTION_TERMS) {
        if (arText.includes(term)) {
          violations.push({
            featureId: feature.id,
            field: 'acceptanceRequirements',
            message: `AR contains solution language: "${term}"`,
          });
          break;
        }
      }

      for (const entry of IMPLEMENTATION_FLAVORED_PATTERNS) {
        if (entry.pattern.test(arText)) {
          violations.push({
            featureId: feature.id,
            field: 'acceptanceRequirements',
            message: `AR contains implementation-flavored wording: "${entry.label}"`,
          });
          break;
        }
      }

      if (featureRole) {
        const leadingRole = extractLeadingRolePhrase(ar.given);
        if (leadingRole && looksLikeRolePhrase(leadingRole) && normalizeRole(leadingRole) !== normalizeRole(featureRole)) {
          violations.push({
            featureId: feature.id,
            field: 'acceptanceRequirements',
            message: `AR role wording differs from feature role "${featureRole}": "${leadingRole}"`,
          });
        }
      }

      if (looksLikeOpenDecisionText(`${ar.given} ${ar.when} ${ar.then}`)) {
        violations.push({
          featureId: feature.id,
          field: 'acceptanceRequirements',
          message: 'AR appears to include unresolved decision wording instead of a testable rule',
        });
      }

      if (feature.actorSource === 'fallback') {
        const arRole = extractLeadingRolePhrase(ar.given) || extractLeadingRolePhrase(ar.when) || extractLeadingRolePhrase(ar.then);
        if (arRole && normalizeRole(arRole) !== normalizeRole(featureRole ?? '')) {
          violations.push({
            featureId: feature.id,
            field: 'acceptanceRequirements',
            message: `AR introduces role wording "${arRole}" even though the feature actor source is fallback`,
          });
        }
      }
    }

    // Check for near-duplicate ARs within the feature
    const arFingerprints = feature.acceptanceRequirements.map(tokenizeArForFingerprint);
    const reportedPairs = new Set<string>();
    for (let i = 0; i < arFingerprints.length; i += 1) {
      for (let j = i + 1; j < arFingerprints.length; j += 1) {
        const similarity = jaccardSimilarity(arFingerprints[i], arFingerprints[j]);
        if (similarity >= AR_NEAR_DUPLICATE_JACCARD_THRESHOLD) {
          const pairKey = `${i}-${j}`;
          if (reportedPairs.has(pairKey)) continue;
          reportedPairs.add(pairKey);
          violations.push({
            featureId: feature.id,
            field: 'acceptanceRequirements',
            message: `Feature contains near-duplicate acceptance requirements (#${i + 1} and #${j + 1}, similarity ${similarity.toFixed(2)})`,
          });
        }
      }
    }
  }

  // Feature-level overlap detection (surfaces as violations so the UI sees them)
  const featureOverlaps = detectFeatureOverlaps(features);
  for (const violation of featureOverlapsToViolations(featureOverlaps)) {
    violations.push(violation);
  }

  return violations;
}
