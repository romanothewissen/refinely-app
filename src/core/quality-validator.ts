import { AcceptanceRequirement, Feature, TenantConfig, ValidationViolation } from '../types';

const SOLUTION_TERMS = [
  'button', 'click', 'screen', 'field', 'form', 'dropdown', 'checkbox',
  'modal', 'dialog', 'tab', 'panel', 'page', 'ui', 'interface', 'api',
  'database', 'table', 'column', 'query', 'endpoint', 'webhook', 'payload',
  'javascript', 'css', 'html', 'react', 'angular', 'node', 'python',
];

const IMPLEMENTATION_FLAVORED_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bdesignated inbox\b/i, label: 'named intake source' },
  { pattern: /\bsubject(?: line)?\b/i, label: 'message metadata field' },
  { pattern: /\b(?:case|reference)\s+(?:id|identifier)\b/i, label: 'record identifier' },
  { pattern: /\bemail content\b/i, label: 'message content field' },
  { pattern: /\bappend(?:ed|s)?\b/i, label: 'append operation' },
  { pattern: /\bthe system\s+(?:identifies|matches|parses|reads|extracts|detects|appends)\b/i, label: 'system action wording' },
  { pattern: /\bkeyword(?:s|\s+matching|\s+detection|\s+based)?\b/i, label: 'keyword mechanism language' },
  { pattern: /\bcontains\s+(?:\w+\s+){0,3}(?:keyword|pattern|term|phrase)\b/i, label: 'pattern-match mechanism language' },
  { pattern: /\bnot\s+(?:a|an)\s+\w+\s+(?:issue|case|inquiry|request|type|category)\b/i, label: 'negative classification framing' },
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
const AR_MIN_TOTAL_WORDS = 12;
const AR_SUMMARY_TAUTOLOGY_JACCARD_THRESHOLD = 0.75;
const AR_COUNT_FLOOR_STORY_POINTS = 5;
const AR_COUNT_FLOOR_MIN_ARS = 3;

const GENERIC_ROLE_DENYLIST_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bas\s+an?\s+any\s+authori[sz]ed\s+users?\b/i, label: 'any authorized user' },
  { pattern: /\bas\s+an?\s+any\s+authori[sz]ed\b/i, label: 'composite "any authorized …" actor' },
  { pattern: /\bas\s+an?\s+authori[sz]ed\s+.+?\s+(?:member|person|user|party)\b/i, label: 'generic authorized member bucket' },
  { pattern: /\bas\s+an?\s+authori[sz]ed\s+\w+\s+team\s+member\b/i, label: 'generic authorized team member' },
  { pattern: /\bas\s+an?\s+\w+\s+team\s+member\b/i, label: 'generic team member' },
  { pattern: /\bas\s+an?\s+member\s+of\s+the\b/i, label: 'generic member of team' },
  { pattern: /\bas\s+an?\s+various\s+roles?\b/i, label: 'various roles' },
  { pattern: /\bas\s+an?\s+different\s+roles?\b/i, label: 'different roles' },
  { pattern: /\bas\s+an?\s+(?:anyone|someone|everyone)\b/i, label: 'undefined actor' },
  { pattern: /\bas\s+a\s+user\b/i, label: 'generic "user" actor' },
];

// Detects THEN clauses that express mere persistence/crud rather than business capability.
// These patterns are structural and domain-agnostic — they match regardless of the business domain.
const CRUD_FLAVORED_THEN_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bis\s+added\s+to\s+the\b/i, label: 'persistence: added to' },
  { pattern: /\bis\s+created\s+and\s+linked?\b/i, label: 'persistence: created and linked' },
  { pattern: /\breflects\s+the\b/i, label: 'persistence: reflects the' },
  { pattern: /\bis\s+updated\s+to\s+\w/i, label: 'persistence: status update' },
  { pattern: /\bis\s+visible\s+from\s+the\b/i, label: 'persistence: visible from' },
  { pattern: /\bincludes\s+(?:the\s+)?(?:new|updated|required)\b/i, label: 'persistence: includes' },
  { pattern: /\bare\s+created\s+based\s+on\b/i, label: 'persistence: created based on' },
  { pattern: /\bis\s+not\s+automatically\s+\w/i, label: 'persistence: not automatically updated' },
];

// Detects WHEN clauses that describe a CRUD action rather than a business moment or trigger.
const WHEN_CRUD_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b(?:adds?|removes?|creates?|updates?|deletes?|modifies?)\s+(?:an?\s+)?\w+\s+(?:to|from|on|in)\s+(?:the\s+)?/i, label: 'CRUD action in WHEN' },
];

const CRUD_THEN_THRESHOLD = 0.5; // Flag when ≥50% of ARs match a CRUD-THEN pattern
const WHEN_CRUD_THRESHOLD = 0.6; // Flag when ≥60% of WHEN clauses match a CRUD pattern
const AR_DEDUP_STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'by', 'with', 'from', 'for',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'has', 'have', 'had', 'does', 'do', 'did',
  'that', 'which', 'this', 'these', 'those', 'it', 'its', 'as', 'into', 'onto',
]);

// Extracts 4+ char domain-content tokens from the action+benefit clause of a
// user-story description ("As a X, I need Y so that Z"), stripping scaffolding
// and abstract process verbs so we're left with the business nouns that should
// appear in THEN clauses.
const DESCRIPTION_NOUN_STOPWORDS = new Set([
  'that', 'this', 'with', 'from', 'will', 'have', 'been', 'when', 'then', 'than',
  'they', 'them', 'their', 'there', 'what', 'which', 'where', 'were', 'each', 'also',
  'into', 'such', 'only', 'both', 'most', 'some', 'more', 'over', 'other', 'after',
  'before', 'during', 'through', 'between', 'about', 'under', 'should', 'would',
  'could', 'must', 'shall', 'need', 'used', 'using', 'able', 'allow', 'ensure',
  'verify', 'confirm', 'validate', 'manage', 'track', 'maintain', 'process', 'support',
  'provide', 'create', 'update', 'delete', 'access', 'view', 'review', 'submit',
  'request', 'perform', 'complete', 'accomplish', 'facilitate', 'enable', 'without',
]);

function extractDescriptionConcreteNouns(description: string): Set<string> {
  const stripped = description
    .replace(/^as\s+an?\s+[^,]+,\s*/i, '')
    .replace(/\bi\s+need(?:\s+to)?\s+/i, '')
    .replace(/\bso\s+that\b.*/i, '')
    .toLowerCase();
  return new Set((stripped.match(/\b[a-z]{4,}\b/g) ?? []).filter(w => !DESCRIPTION_NOUN_STOPWORDS.has(w)));
}

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

function containsFirstPersonLanguage(text: string): boolean {
  return /\b(i|me|my|mine|we|our|ours|us)\b/i.test(String(text ?? ''));
}

function countWords(text: string): number {
  return String(text ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .length;
}

function extractActorRoleFromDescription(description: string): string {
  const match = String(description ?? '').match(/^As an?\s+(.+?),\s*I need/i);
  return (match?.[1] ?? '').trim().toLowerCase();
}

export function textLooksTruncated(text: string): boolean {
  return clauseEndsOnStopWord(String(text ?? ''));
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

function tokenizeThenClause(text: string): Set<string> {
  const cleaned = String(text ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
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

    if (textLooksTruncated(feature.description)) {
      violations.push({
        featureId: feature.id,
        field: 'description',
        message: 'Description appears truncated',
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

    // Role deny-list: generic/undefined actor phrases that indicate the LLM
    // failed to resolve a grounded role.
    for (const entry of GENERIC_ROLE_DENYLIST_PATTERNS) {
      if (entry.pattern.test(feature.description)) {
        violations.push({
          featureId: feature.id,
          field: 'description',
          message: `Description uses generic actor label "${entry.label}"; resolve to a grounded role from evidence or configured domain roles`,
        });
        break;
      }
    }

    // AR count floor: substantive features (>= 5 story points) need enough ARs
    // to actually cover their behavioral surface.
    if (
      typeof feature.storyPoints === 'number'
      && feature.storyPoints >= AR_COUNT_FLOOR_STORY_POINTS
      && feature.acceptanceRequirements.length < AR_COUNT_FLOOR_MIN_ARS
    ) {
      violations.push({
        featureId: feature.id,
        field: 'acceptanceRequirements',
        message: `Feature estimated at ${feature.storyPoints} points has only ${feature.acceptanceRequirements.length} acceptance requirement(s); expect at least ${AR_COUNT_FLOOR_MIN_ARS}`,
      });
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

    const featureActorRole = extractActorRoleFromDescription(feature.description);
    const summaryTokenSet = tokenizeFeatureForOverlap(feature.summary ?? '');
    const descriptionNouns = extractDescriptionConcreteNouns(feature.description);
    let repeatedWhenActorCount = 0;
    let tautologicalThenCount = 0;
    let abstractThenCount = 0;

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

      const combinedArText = `${ar.given} ${ar.when} ${ar.then}`;
      if (containsFirstPersonLanguage(combinedArText)) {
        violations.push({
          featureId: feature.id,
          field: 'acceptanceRequirements',
          message: 'AR uses first-person language; use objective third-person business phrasing',
        });
      }

      if (countWords(combinedArText) < AR_MIN_TOTAL_WORDS) {
        violations.push({
          featureId: feature.id,
          field: 'acceptanceRequirements',
          message: `AR appears too short to be testable (fewer than ${AR_MIN_TOTAL_WORDS} words)`,
        });
      }

      if (featureActorRole && String(ar.when ?? '').toLowerCase().includes(featureActorRole)) {
        repeatedWhenActorCount += 1;
      }

      if (summaryTokenSet.size) {
        const thenTokens = tokenizeThenClause(ar.then);
        if (thenTokens.size) {
          const similarity = jaccardSimilarity(thenTokens, summaryTokenSet);
          if (similarity >= AR_SUMMARY_TAUTOLOGY_JACCARD_THRESHOLD) {
            tautologicalThenCount += 1;
          }
        }
      }

      // Check for solution language in ARs
      const arText = combinedArText.toLowerCase();
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

      // Depth-anchoring: THEN clause should contain at least one concrete noun
      // from the feature description scope, not just abstract process verbs.
      if (descriptionNouns.size > 0) {
        const thenLower = String(ar.then ?? '').toLowerCase();
        const thenHasAnchor = [...descriptionNouns].some(noun => thenLower.includes(noun));
        if (!thenHasAnchor) {
          abstractThenCount += 1;
        }
      }

    }

    if (
      feature.acceptanceRequirements.length >= 4
      && featureActorRole
      && repeatedWhenActorCount >= feature.acceptanceRequirements.length - 1
    ) {
      violations.push({
        featureId: feature.id,
        field: 'acceptanceRequirements',
        message: 'AR WHEN clauses over-repeat the same actor label; prefer role-neutral continuation where actor does not change',
      });
    }

    if (
      feature.acceptanceRequirements.length >= 2
      && tautologicalThenCount >= Math.ceil(feature.acceptanceRequirements.length * 0.75)
    ) {
      violations.push({
        featureId: feature.id,
        field: 'acceptanceRequirements',
        message: 'AR THEN clauses paraphrase the feature summary instead of describing distinct verifiable outcomes',
      });
    }

    if (
      feature.acceptanceRequirements.length >= 2
      && descriptionNouns.size > 0
      && abstractThenCount >= Math.ceil(feature.acceptanceRequirements.length * 0.5)
    ) {
      violations.push({
        featureId: feature.id,
        field: 'acceptanceRequirements',
        message: 'AR THEN clauses lack concrete business anchors from the feature scope; prefer specific business nouns over abstract verbs (validate, ensure, verify, confirm)',
      });
    }

    // CRUD-THEN detection: flag features where too many THEN clauses express
    // persistence rather than business capability.
    if (feature.acceptanceRequirements.length >= 2) {
      let crudThenCount = 0;
      for (const ar of feature.acceptanceRequirements) {
        const thenText = String(ar.then ?? '');
        for (const entry of CRUD_FLAVORED_THEN_PATTERNS) {
          if (entry.pattern.test(thenText)) {
            crudThenCount += 1;
            break;
          }
        }
      }
      if (crudThenCount >= Math.ceil(feature.acceptanceRequirements.length * CRUD_THEN_THRESHOLD)) {
        violations.push({
          featureId: feature.id,
          field: 'acceptanceRequirements',
          message: 'AR THEN clauses express persistence/crud outcomes rather than business capabilities; reframe to state what the feature enables, decides, enforces, or makes possible',
        });
      }
    }

    // WHEN-CRUD detection: flag features where too many WHEN clauses describe
    // CRUD actions rather than business moments or triggers.
    if (feature.acceptanceRequirements.length >= 2) {
      let whenCrudCount = 0;
      for (const ar of feature.acceptanceRequirements) {
        const whenText = String(ar.when ?? '');
        for (const entry of WHEN_CRUD_PATTERNS) {
          if (entry.pattern.test(whenText)) {
            whenCrudCount += 1;
            break;
          }
        }
      }
      if (whenCrudCount >= Math.ceil(feature.acceptanceRequirements.length * WHEN_CRUD_THRESHOLD)) {
        violations.push({
          featureId: feature.id,
          field: 'acceptanceRequirements',
          message: 'AR WHEN clauses describe CRUD actions rather than business moments or triggers; reframe to express the business situation that triggers the behavior',
        });
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
