import test from 'node:test';
import assert from 'node:assert/strict';

import { detectFeatureOverlaps, validateFeatures } from '../quality-validator';
import { DEFAULT_CONFIG } from '../../types';
import type { Feature } from '../../types';

const baseConfig = DEFAULT_CONFIG;

function makeFeature(overrides: Partial<Feature>): Feature {
  return {
    id: 'feature-id',
    summary: 'Untitled',
    description: 'As a Technical Support Specialist, I need to do the thing so that outcomes happen.',
    acceptanceRequirements: [],
    ...overrides,
  };
}

test('validateFeatures flags descriptions with duplicated "so that" clauses', () => {
  const features: Feature[] = [
    makeFeature({
      id: 'feat-1',
      description: 'As a Technical Support Specialist, I need to classify cases so that issues are routed. so that the requested outcome is achieved.',
    }),
  ];

  const violations = validateFeatures(features, baseConfig);
  const hit = violations.find(v => v.field === 'description' && /duplicated "so that"/.test(v.message));
  assert.ok(hit, `expected duplicated "so that" violation, got: ${JSON.stringify(violations)}`);
});

test('validateFeatures flags AR clauses that end on a truncation stop-word', () => {
  const features: Feature[] = [
    makeFeature({
      id: 'feat-1',
      acceptanceRequirements: [
        {
          given: 'an email is received from an existing contact that clearly indicates',
          when: 'the system processes the email',
          then: 'a new case is created',
        },
      ],
    }),
  ];

  const violations = validateFeatures(features, baseConfig);
  const hit = violations.find(v => /truncated/.test(v.message));
  assert.ok(hit, `expected truncated-clause violation, got: ${JSON.stringify(violations)}`);
  assert.match(hit!.message, /GIVEN/);
});

test('validateFeatures flags truncated feature descriptions', () => {
  const features: Feature[] = [
    makeFeature({
      id: 'feat-1',
      description: 'As a Technical Support Specialist, I need to review update outcomes so that the latest known',
    }),
  ];

  const violations = validateFeatures(features, baseConfig);
  const hit = violations.find(v => /Description appears truncated/.test(v.message));
  assert.ok(hit, `expected truncated description violation, got: ${JSON.stringify(violations)}`);
});

test('validateFeatures does NOT flag AR clauses that end on a content word', () => {
  const features: Feature[] = [
    makeFeature({
      id: 'feat-1',
      acceptanceRequirements: [
        {
          given: 'a support email arrives from an existing contact describing a product issue',
          when: 'the system processes the email',
          then: 'a new case is automatically created and classified as a product issue',
        },
      ],
    }),
  ];

  const violations = validateFeatures(features, baseConfig);
  const hit = violations.find(v => /truncated/.test(v.message));
  assert.equal(hit, undefined, `did not expect a truncation violation, got: ${JSON.stringify(violations)}`);
});

test('validateFeatures flags near-duplicate acceptance requirements within the same feature', () => {
  const features: Feature[] = [
    makeFeature({
      id: 'feat-1',
      acceptanceRequirements: [
        {
          given: 'a support email arrives and its content indicates a product issue',
          when: 'the system processes the email',
          then: 'a new case is automatically created and classified as a product issue',
        },
        {
          given: 'a support email arrives and its content indicates a product issue',
          when: 'the system processes the email',
          then: 'a new case is automatically created and classified as a product issue',
        },
      ],
    }),
  ];

  const violations = validateFeatures(features, baseConfig);
  const hit = violations.find(v => /near-duplicate/.test(v.message));
  assert.ok(hit, `expected near-duplicate AR violation, got: ${JSON.stringify(violations)}`);
});

test('validateFeatures flags implementation-flavored AR wording that should stay business-facing', () => {
  const features: Feature[] = [
    makeFeature({
      id: 'feat-1',
      acceptanceRequirements: [
        {
          given: 'an email is received in a designated inbox with a unique case reference ID in its subject',
          when: 'the system identifies a matching active case',
          then: 'the email content is appended to that existing case',
        },
      ],
    }),
  ];

  const violations = validateFeatures(features, baseConfig);
  const hit = violations.find(v => /implementation-flavored wording/.test(v.message));
  assert.ok(hit, `expected implementation-flavored wording violation, got: ${JSON.stringify(violations)}`);
});

test('validateFeatures flags business-labeled features with technical/system actors', () => {
  const features: Feature[] = [
    makeFeature({
      id: 'feat-1',
      description: 'As an integration service, I need to parse uploaded records so that structured fields are extracted.',
      featureClass: 'business_capability',
    }),
  ];

  const violations = validateFeatures(features, baseConfig);
  const hit = violations.find(v => /technical\/system actor/i.test(v.message));
  assert.ok(hit, `expected technical actor / business class violation, got: ${JSON.stringify(violations)}`);
});

test('detectFeatureOverlaps flags pairs that share most content tokens', () => {
  const features: Feature[] = [
    makeFeature({
      id: 'feat-1',
      summary: 'Automatic Case Creation from Designated Support Emails',
      description: 'As a Technical Support Specialist, I need to receive automatically created cases from designated support emails so that manual case creation is eliminated.',
    }),
    makeFeature({
      id: 'feat-2',
      summary: 'Automatic Case Classification by Issue Type',
      description: 'As a Technical Support Specialist, I need incoming support emails automatically converted into cases and classified so that manual case creation and initial categorization is eliminated.',
    }),
  ];

  const overlaps = detectFeatureOverlaps(features);
  assert.ok(overlaps.length >= 1, `expected at least one overlap, got none`);
  const pair = overlaps.find(o =>
    (o.leftFeatureId === 'feat-1' && o.rightFeatureId === 'feat-2')
    || (o.leftFeatureId === 'feat-2' && o.rightFeatureId === 'feat-1')
  );
  assert.ok(pair, 'expected feat-1 / feat-2 overlap pair');
});

test('detectFeatureOverlaps flags summary-subset relationships', () => {
  const features: Feature[] = [
    makeFeature({
      id: 'feat-1',
      summary: 'Define Designated Support Inboxes',
      description: 'As a Technical Support Specialist, I need to specify which email addresses trigger automatic case creation so that only official channels generate cases.',
    }),
    makeFeature({
      id: 'feat-2',
      summary: 'Define Designated Support Inboxes for Case Creation Administration',
      description: 'As a Technical Support Specialist, I need administrative controls for designating support inboxes so that admins can manage the list.',
    }),
  ];

  const overlaps = detectFeatureOverlaps(features);
  assert.ok(overlaps.length >= 1, 'expected summary subset / overlap to fire');
});

test('detectFeatureOverlaps does NOT flag clearly distinct features', () => {
  const features: Feature[] = [
    makeFeature({
      id: 'feat-1',
      summary: 'Automatic Case Creation from Emails',
      description: 'As a Technical Support Specialist, I need incoming support emails converted into cases so that manual creation is eliminated.',
    }),
    makeFeature({
      id: 'feat-2',
      summary: 'Link Incoming Emails to Existing Cases',
      description: 'As a Technical Support Specialist, I need reply emails attached to their original cases so that communication history stays consolidated.',
    }),
    makeFeature({
      id: 'feat-3',
      summary: 'Configure Classification Keywords',
      description: 'As a Technical Support Specialist, I need to manage the keywords used for classification so that incoming items are routed correctly.',
    }),
  ];

  const overlaps = detectFeatureOverlaps(features);
  assert.equal(overlaps.length, 0, `expected no overlaps, got ${JSON.stringify(overlaps)}`);
});
