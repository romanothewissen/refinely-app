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

    // Check ARs
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
    }
  }

  return violations;
}
