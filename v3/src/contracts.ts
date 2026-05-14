export type V3SourceKind = 'work_instruction' | 'backlog_example' | 'project_context' | 'document';

export type V3Provenance =
  | 'requirement'
  | 'work_instruction'
  | 'project_context'
  | 'document'
  | 'backlog_pattern'
  | 'golden_example'
  | 'assumption';

export type V3ContextCardKind =
  | 'role'
  | 'business_object'
  | 'workflow_step'
  | 'business_rule'
  | 'exception'
  | 'definition'
  | 'decision'
  | 'constraint'
  | 'project_convention'
  | 'status'
  | 'gherkin_example'
  | 'similar_story';

export interface V3WorkInstruction {
  id: string;
  title: string;
  text: string;
}

export interface V3ProjectContext {
  id: string;
  title: string;
  text: string;
  projectKey?: string;
  kind?: V3ContextCardKind;
}

export interface V3ProjectDocument {
  id: string;
  title: string;
  text: string;
  sourceId?: string;
  filename?: string;
  section?: string;
  projectKey?: string;
  kind?: V3ContextCardKind;
}

export interface V3BacklogExample {
  key: string;
  summary: string;
  description: string;
  acceptanceRequirements: V3AcceptanceRequirement[];
}

export interface V3ContextCard {
  id: string;
  sourceId: string;
  sourceKind: V3SourceKind;
  kind: V3ContextCardKind;
  title: string;
  text: string;
  keywords: string[];
  weight: number;
}

export interface V3RetrievedContextCard extends V3ContextCard {
  score: number;
}

export interface V3ContextPack {
  cards: V3RetrievedContextCard[];
  estimatedTokens: number;
  sourceMix: {
    workInstructionCards: number;
    backlogCards: number;
    projectContextCards?: number;
    documentCards?: number;
  };
}

export interface V3EvidenceRef {
  cardId: string;
  sourceId: string;
  reason: string;
}

export interface V3CapabilityCandidate {
  id: string;
  label: string;
  businessOutcome: string;
  rationale: string;
  requirementEvidence: string[];
  neededEvidence: string[];
  acceptanceFocus: string[];
  provenance: V3Provenance;
}

export interface V3SizingCapabilityCandidate {
  label: string;
  splitRationale: string;
  mergeRisk: string;
  confidence: 'low' | 'medium' | 'high';
  requirementEvidence: string[];
}

export interface V3CapabilitySizingAssessment {
  clarity: 'clear' | 'mixed' | 'vague';
  complexity: 'simple' | 'moderate' | 'complex';
  ambiguityLevel: 'low' | 'medium' | 'high';
  recommendedFeatureRange: {
    min: number;
    max: number;
  };
  decompositionStyle: 'single_capability' | 'grouped_capabilities' | 'workflow_slices' | 'mixed';
  candidateCapabilities: V3SizingCapabilityCandidate[];
  capabilitiesLikelyMissingIfOmitted: string[];
  openQuestions: string[];
  reasoningSummary: string;
}

export interface V3CapabilityPlan {
  capabilities: V3CapabilityCandidate[];
  openQuestions: string[];
  assumptions: string[];
  complexity: 'simple' | 'moderate' | 'complex';
  sizingAssessment?: V3CapabilitySizingAssessment;
}

export interface V3AcceptanceRequirement {
  id?: string;
  given: string;
  when: string;
  then: string;
  provenance?: V3Provenance;
  evidenceRefs?: V3EvidenceRef[];
}

export interface V3GeneratedFeature {
  id?: string;
  summary: string;
  businessOutcome: string;
  description: string;
  acceptanceRequirements: V3AcceptanceRequirement[];
  provenance?: V3Provenance;
  evidenceRefs: V3EvidenceRef[];
  assumptions: string[];
  openQuestions: string[];
}

export interface V3GeneratedDraft {
  features: V3GeneratedFeature[];
  confidence: 'low' | 'medium' | 'high';
  blockingQuestions: string[];
}

export interface V3PipelineInput {
  requirement: string;
  workInstructions: V3WorkInstruction[];
  backlogExamples: V3BacklogExample[];
  projectContext?: V3ProjectContext[];
  documents?: V3ProjectDocument[];
  maxContextCards?: number;
}

export interface V3ValidationIssue {
  code:
    | 'missing_feature'
    | 'missing_business_outcome'
    | 'invalid_gherkin'
    | 'technical_language'
    | 'unsupported_role_in_ar'
    | 'solution_language'
    | 'context_overreach'
    | 'generic_outcome'
    | 'thin_acceptance_requirement'
    | 'vague_acceptance_requirement'
    | 'duplicate_acceptance_requirement'
    | 'confidence_mismatch'
    | 'missing_evidence'
    | 'missing_work_instruction_grounding'
    | 'missing_project_context_grounding'
    | 'missing_document_grounding'
    | 'missing_backlog_grounding';
  path: string;
  message: string;
}

export interface V3PipelineResult {
  requirement: string;
  capabilityPlan: V3CapabilityPlan;
  draft: V3GeneratedDraft;
  contextPack: V3ContextPack;
  validation: {
    passed: boolean;
    issues: V3ValidationIssue[];
  };
  diagnostics: {
    compiledCards: number;
    contextCardsUsed: number;
    estimatedContextTokens: number;
    planner: string;
    generator: string;
  };
}

export interface V3Planner {
  name: string;
  plan(input: {
    requirement: string;
  }): Promise<V3CapabilityPlan>;
}

export interface V3Generator {
  name: string;
  generate(input: {
    requirement: string;
    capabilityPlan: V3CapabilityPlan;
    contextPack: V3ContextPack;
  }): Promise<V3GeneratedDraft>;
}
