import { Feature, TenantConfig, ValidationViolation } from '../types';

const SOLUTION_TERMS = [
  'button', 'click', 'screen', 'field', 'form', 'dropdown', 'checkbox',
  'modal', 'dialog', 'tab', 'panel', 'page', 'ui', 'interface', 'api',
  'database', 'table', 'column', 'query', 'endpoint', 'webhook', 'payload',
  'javascript', 'css', 'html', 'react', 'angular', 'node', 'python',
];

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

function extractRoleFromDescription(description: string): string | null {
  const match = description.match(/^As an?\s+(.+?),\s*I need to\s+/i);
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

export function validateFeatures(features: Feature[], config: TenantConfig): ValidationViolation[] {
  const violations: ValidationViolation[] = [];

  for (const feature of features) {
    // Check description format
    if (!feature.description.match(/^As a .+, I need to .+ so that .+/i)) {
      violations.push({
        featureId: feature.id,
        field: 'description',
        message: 'Description must follow "As a [role], I need to [action] so that [benefit]" format',
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
    for (const ar of feature.acceptanceRequirements) {
      if (!ar.given || !ar.when || !ar.then) {
        violations.push({
          featureId: feature.id,
          field: 'acceptanceRequirements',
          message: 'AR missing GIVEN, WHEN, or THEN clause',
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
    }
  }

  return violations;
}
