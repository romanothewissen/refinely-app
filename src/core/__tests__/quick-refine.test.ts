import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildQuickRefineReadFields,
  detectQuickRefineActorAmbiguity,
  ensureUserStoryDescription,
  parseAcceptanceRequirementsFromText,
  resolveQuickRefineModel,
  resolveQuickRefineProjectMapping,
  splitDescriptionAndArs,
} from '../quick-refine';

test('resolveQuickRefineProjectMapping prefers project and issue-type specific mappings', () => {
  const mapping = resolveQuickRefineProjectMapping({
    issueLinkType: 'Relates to',
    arMappings: [
      {
        projectKey: '*',
        issueType: '*',
        mode: 'consolidated',
        consolidatedFieldId: 'description',
        iterativeFieldIds: [],
        inputMappings: {
          summaryFieldId: 'summary',
          descriptionFieldId: 'description',
          arFieldIds: [],
        },
        outputMappings: {
          summaryFieldId: 'summary',
          descriptionFieldId: 'description',
          arFieldIds: [],
        },
      },
      {
        projectKey: 'ABC',
        issueType: 'Story',
        mode: 'iterative',
        consolidatedFieldId: 'customfield_10010',
        iterativeFieldIds: ['customfield_10010', 'customfield_10011'],
        inputMappings: {
          summaryFieldId: 'summary',
          descriptionFieldId: 'customfield_10012',
          arFieldIds: ['customfield_10010', 'customfield_10011'],
        },
        outputMappings: {
          summaryFieldId: 'summary',
          descriptionFieldId: 'description',
          arFieldIds: ['customfield_10020', 'customfield_10021'],
        },
        issueLinkType: 'Blocks',
      },
    ],
  }, 'ABC', 'Story');

  assert.equal(mapping.issueLinkType, 'Blocks');
  assert.equal(mapping.inputMappings.descriptionFieldId, 'customfield_10012');
  assert.deepEqual(mapping.outputMappings.arFieldIds, ['customfield_10020', 'customfield_10021']);
});

test('splitDescriptionAndArs separates embedded acceptance requirements from description text', () => {
  const result = splitDescriptionAndArs(`As a coordinator, I need to review the request so that the right team can act on it.

Acceptance Requirements

GIVEN a coordinator is reviewing a request WHEN the request is complete THEN the request is ready for assignment.
GIVEN a coordinator is reviewing a request WHEN required information is missing THEN the request stays open for clarification.`);

  assert.match(result.description, /^As a coordinator/);
  assert.equal(result.acceptanceRequirements.length, 2);
  assert.match(result.acceptanceRequirements[0]?.then ?? '', /ready for assignment/i);
});

test('parseAcceptanceRequirementsFromText parses multiple GIVEN/WHEN/THEN blocks', () => {
  const ars = parseAcceptanceRequirementsFromText(`GIVEN a user has entered valid data WHEN the draft is saved THEN the issue stores the rewritten content.
GIVEN required context is missing WHEN quick refine runs THEN the app asks focused clarification questions.`);

  assert.equal(ars.length, 2);
  assert.match(ars[1]?.when ?? '', /quick refine runs/i);
});

test('ensureUserStoryDescription normalizes loose story phrasing into strict user-story format', () => {
  const description = ensureUserStoryDescription(
    'As a System Administrator, I want to restrict create and update access to IM&T records. This ensures data integrity.',
  );

  assert.equal(
    description,
    'As a System Administrator, I need to restrict create and update access to IM&T records so that data integrity.',
  );
});

test('detectQuickRefineActorAmbiguity flags permission-driven requirements without a named actor', () => {
  const ambiguous = detectQuickRefineActorAmbiguity({
    summary: 'Restrict IM&T tool maintenance access',
    description: `The system shall be configured to only allow users with a specific permission set to create/modify IM&T/Tools (Equipment) Records.

All other Roles/Profiles/Permission sets for the system shall have Read access only IM&T/Tools (Equipment) Records.`,
    acceptanceRequirements: [],
  });

  assert.equal(ambiguous, true);
});

test('detectQuickRefineActorAmbiguity ignores requirements that already name the actor in story form', () => {
  const ambiguous = detectQuickRefineActorAmbiguity({
    summary: 'Restrict IM&T tool maintenance access',
    description: 'As a System Administrator, I need to manage IM&T tool record permissions so that only authorized users can edit records.',
    acceptanceRequirements: [],
  });

  assert.equal(ambiguous, false);
});

test('buildQuickRefineReadFields includes mapped fields only once', () => {
  const fields = buildQuickRefineReadFields({
    summaryFieldId: 'summary',
    descriptionFieldId: 'description',
    arFieldIds: ['description', 'customfield_10015', 'customfield_10015'],
  });

  assert.equal(fields.filter((field) => field === 'description').length, 1);
  assert.equal(fields.includes('customfield_10015'), true);
});

test('resolveQuickRefineModel prefers the override and still applies tier downgrades', () => {
  const model = resolveQuickRefineModel({
    tier: 'free',
    generatorConfig: {
      provider: 'openai',
      modelStrategy: 'simple',
      bucketClasses: {
        discovery: 'flash',
        generation: 'pro',
        refinement: 'flash',
      },
      modelStrategyVersion: 'test',
      decompositionModel: 'gpt-4.1',
      arModel: 'gpt-4.1',
      clarifyModel: 'gpt-4.1-mini',
      refineModel: 'gpt-4.1-mini',
      evaluateModel: 'gpt-4.1-mini',
      triageModel: 'gpt-4.1-mini',
      themeModel: 'gpt-4.1-mini',
      maxTokens: 8192,
    },
    goldSources: [],
    domainContext: '',
    domainRoles: [],
    processTaxonomyEnabled: false,
    processTaxonomy: [],
    branding: {
      appTitle: 'Refinely',
      logoUrl: null,
      primaryColor: '#000000',
      secondaryColor: '#111111',
    },
    similarityConfig: {
      threshold: 0.24,
      useLlmRerank: true,
    },
    wiConfig: {
      enabled: true,
      topKChunks: 8,
      maxChars: 100000,
    },
    compliance: {
      enabled: false,
      transparencyReportsEnabled: false,
      piiMaskingEnabled: false,
      auditTrailEnabled: false,
    },
    issueLinkType: 'Relates to',
    arMappings: [],
    domainContexts: [],
    backlogStatusScopes: [],
  } as any, 'refineModel', 'gpt-4.1') ;

  assert.equal(model, 'gpt-4.1-mini');
});
