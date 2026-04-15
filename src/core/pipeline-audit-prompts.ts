/**
 * Templates for pasting a PipelineAuditBundle into an external reviewer model.
 * Keep in sync with PipelineAuditBundle in types.ts.
 */

export const PIPELINE_AUDIT_REVIEWER_OUTPUT_SCHEMA = `{
  "summary": ["string — 5–10 bullets"],
  "assertions": {
    "clarifyOrder": { "status": "pass|fail|uncertain", "evidence": "string" },
    "arCompleteness": { "status": "pass|fail|uncertain", "evidence": "string" },
    "duplicateCapabilityControl": { "status": "pass|fail|uncertain", "evidence": "string" },
    "sharedEvidenceReuse": { "status": "pass|fail|uncertain", "evidence": "string" }
  },
  "scores": {
    "triageSizing": { "score": 1, "confidence": "low|medium|high", "rationale": "string" },
    "discoveryDepth": { "score": 1, "confidence": "low|medium|high", "rationale": "string" },
    "questionQuality": { "score": 1, "confidence": "low|medium|high", "rationale": "string" },
    "answerUse": { "score": 1, "confidence": "low|medium|high", "rationale": "string" },
    "coverageVsAsk": { "score": 1, "confidence": "low|medium|high", "rationale": "string" },
    "arQuality": { "score": 1, "confidence": "low|medium|high", "rationale": "string" },
    "overlapDedup": { "score": 1, "confidence": "low|medium|high", "rationale": "string" },
    "traceability": { "score": 1, "confidence": "low|medium|high", "rationale": "string" },
    "riskFlags": { "score": 1, "confidence": "low|medium|high", "rationale": "string" }
  },
  "findings": [
    {
      "severity": "blocker|major|minor",
      "area": "string",
      "evidence": "string — quote ids or short excerpts from the bundle",
      "recommendation": "string"
    }
  ],
  "gaps": ["string — concrete missing backlog themes"],
  "prompt_feedback": ["string — optional improvements to pipeline instructions"]
}`;

export const PIPELINE_AUDIT_REVIEWER_SYSTEM = `You are an expert product manager and QA auditor reviewing an AI pipeline that turns a business requirement into user stories with GIVEN/WHEN/THEN acceptance requirements.

You will receive one JSON object: a "PipelineAuditBundle" with user inputs, retrieved discovery context (work instructions, similar stories, domain context), an ordered list of LLM calls (masked prompts and model responses), and structured outputs (clarify questions, optional sufficiency evaluation, generated features).

Score each dimension from 1 (poor) to 5 (excellent). Be specific: cite feature ids, question text, or prompt phases when giving evidence.
Additionally evaluate these required assertions:
- clarifyOrder: Do clarify questions follow the intended discovery sequence (roles/personas -> trigger/context -> flow -> rules/exceptions -> success/measurement) with minimal drift?
- arCompleteness: Are acceptance requirements complete for most generated features (not zeroed-out fallback for all)?
- duplicateCapabilityControl: Does output avoid splitting the same capability into redundant role-variant features unless behavior materially differs?
- sharedEvidenceReuse: Does generation appear to reuse clarify-stage shared evidence rather than re-building unrelated retrieval context?

Respond with ONLY valid JSON matching the schema provided in the user message. No markdown fences or prose outside JSON.`;

export function buildPipelineAuditReviewerUserMessage(bundleJson: string): string {
  return [
    'Audit the following PipelineAuditBundle.',
    '',
    'Output JSON must match this schema:',
    PIPELINE_AUDIT_REVIEWER_OUTPUT_SCHEMA,
    '',
    'PIPELINE_AUDIT_BUNDLE_JSON:',
    bundleJson,
  ].join('\n');
}

export function buildPipelineAuditReviewerPack(): {
  systemPrompt: string;
  userMessageTemplate: string;
  outputSchemaJson: string;
} {
  return {
    systemPrompt: PIPELINE_AUDIT_REVIEWER_SYSTEM,
    userMessageTemplate: [
      'Audit the following PipelineAuditBundle. Replace BUNDLE_JSON below with the exported bundle JSON.',
      '',
      'Output JSON must match this schema:',
      PIPELINE_AUDIT_REVIEWER_OUTPUT_SCHEMA,
      '',
      'PIPELINE_AUDIT_BUNDLE_JSON:',
      'BUNDLE_JSON',
    ].join('\n'),
    outputSchemaJson: PIPELINE_AUDIT_REVIEWER_OUTPUT_SCHEMA,
  };
}
