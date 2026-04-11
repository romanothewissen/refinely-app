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
    description: 'As an Operations Specialist, I need to do the thing so that outcomes happen.',
    acceptanceRequirements: [],
    ...overrides,
  };
}

test('validateFeatures flags descriptions with duplicated "so that" clauses', () => {
  const features: Feature[] = [
    makeFeature({
      id: 'feat-1',
      description: 'As an Operations Specialist, I need to classify records so that issues are routed. so that the requested outcome is achieved.',
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
      description: 'As an Operations Specialist, I need to review update outcomes so that the latest known state of the',
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

test('validateFeatures does not hard-fail structurally complete but semantically thin AR wording', () => {
  const features: Feature[] = [
    makeFeature({
      id: 'feat-1',
      acceptanceRequirements: [
        {
          given: 'an inbound request is ready',
          when: 'the request is processed',
          then: 'the case is created',
        },
      ],
    }),
  ];

  const violations = validateFeatures(features, baseConfig);
  const hit = violations.find(v => /processed|unresolved decision|role wording|fallback|technical\/system actor/i.test(v.message));
  assert.equal(hit, undefined, `did not expect semantic-thinness hard failure, got: ${JSON.stringify(violations)}`);
});

test('detectFeatureOverlaps flags pairs that share most content tokens', () => {
  const features: Feature[] = [
    makeFeature({
      id: 'feat-1',
      summary: 'Automatic Record Creation from Inbound Messages',
      description: 'As an Operations Specialist, I need inbound messages automatically turned into records so that manual creation is eliminated.',
    }),
    makeFeature({
      id: 'feat-2',
      summary: 'Automatic Record Classification',
      description: 'As an Operations Specialist, I need incoming messages automatically converted into records and classified so that manual creation and initial categorization are eliminated.',
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
      summary: 'Define Approved Intake Sources',
      description: 'As an Operations Specialist, I need to specify which intake sources trigger automatic record creation so that only approved channels generate records.',
    }),
    makeFeature({
      id: 'feat-2',
      summary: 'Define Approved Intake Sources for Administration',
      description: 'As an Operations Specialist, I need administrative controls for intake sources so that admins can manage the list.',
    }),
  ];

  const overlaps = detectFeatureOverlaps(features);
  assert.ok(overlaps.length >= 1, 'expected summary subset / overlap to fire');
});

test('detectFeatureOverlaps does NOT flag clearly distinct features', () => {
  const features: Feature[] = [
    makeFeature({
      id: 'feat-1',
      summary: 'Automatic Record Creation from Messages',
      description: 'As an Operations Specialist, I need incoming messages converted into records so that manual creation is eliminated.',
    }),
    makeFeature({
      id: 'feat-2',
      summary: 'Link Incoming Messages to Existing Records',
      description: 'As an Operations Specialist, I need incoming updates linked to their original records so that history stays consolidated.',
    }),
    makeFeature({
      id: 'feat-3',
      summary: 'Configure Classification Keywords',
      description: 'As an Operations Specialist, I need to manage the keywords used for classification so that incoming items are routed correctly.',
    }),
  ];

  const overlaps = detectFeatureOverlaps(features);
  assert.equal(overlaps.length, 0, `expected no overlaps, got ${JSON.stringify(overlaps)}`);
});
