import { asUser, assumeTrustedRoute } from '@forge/api';
import { getTierModel } from '../services/billing';
import {
  buildCombinedDomainContext,
  getCombinedPersonaRoles,
  retrieveScopedSimilarStories,
  retrieveScopedWiContext,
  summarizeReferencedSimilarStories,
  summarizeReferencedWiSections,
} from '../services/project-selection';
import type {
  AcceptanceRequirement,
  ProjectArMapping,
  ProjectFieldMapping,
  QuickRefineAnswer,
  QuickRefineApplyResult,
  QuickRefineContextMeta,
  QuickRefineDraft,
  QuickRefineIssueContext,
  QuickRefineIssueFields,
  QuickRefineQuestion,
  QuickRefineSurface,
  SimilarStory,
  SplitCandidate,
  TenantConfig,
  TokenUsageSummary,
  WiChunk,
  WiDoc,
} from '../types';
import { callLlmJsonWithUsage } from './llm';
import { buildAdfContentOnly, buildAdfDocument, createFeatureIssue, createIssueLink } from './jira-creator';
import {
  buildWorkInstructionInsightArtifact,
  formatWorkInstructionInsightsForPrompt,
  getWorkInstructionInsightCount,
} from './wi-insights';
import { repairAcceptanceRequirements } from './feature-output';

interface QuickRefineRawIssueFields {
  summary?: unknown;
  description?: unknown;
  acceptance_requirements?: unknown[];
  acceptanceRequirements?: unknown[];
}

interface QuickRefineGenerationResponse {
  currentIssue?: QuickRefineRawIssueFields;
  splitCandidates?: Array<QuickRefineRawIssueFields & {
    id?: unknown;
    issueType?: unknown;
    selected?: unknown;
    storyPoints?: unknown;
    reason?: unknown;
  }>;
  changeSummary?: unknown[];
  handoffRecommended?: unknown;
  handoffReason?: unknown;
}

interface QuickRefineQuestionResponse {
  questions?: Array<{
    id?: unknown;
    question?: unknown;
    suggestions?: unknown[];
  }>;
}

const QUICK_REFINE_WI_TOP_K = 2;
const QUICK_REFINE_WI_MAX_CHARS = 2500;
const QUICK_REFINE_SIMILAR_MAX_RESULTS = 2;
const QUICK_REFINE_GENERIC_ACTOR_PATTERN = /\b(user|users|team|member|staff|operator|personnel|user group)\b/i;
const QUICK_REFINE_PERMISSION_ACTOR_PATTERN = /\b(permission set|permission sets|profile|profiles|role|roles|read access|write access|create access|modify access|edit access|view access)\b/i;

function buildProviderOpts(config: TenantConfig) {
  return {
    provider: config.generatorConfig.provider,
    anthropicApiKey: config.generatorConfig.anthropicApiKey,
    anthropicBaseUrl: config.generatorConfig.anthropicBaseUrl,
    geminiApiKey: config.generatorConfig.geminiApiKey,
    geminiBaseUrl: config.generatorConfig.geminiBaseUrl,
    openaiApiKey: config.generatorConfig.openaiApiKey,
    openaiBaseUrl: config.generatorConfig.openaiBaseUrl,
    openaiCompatibleApiKey: config.generatorConfig.openaiCompatibleApiKey,
    openaiCompatibleBaseUrl: config.generatorConfig.openaiCompatibleBaseUrl,
    azureOpenAIApiKey: config.generatorConfig.azureOpenAIApiKey,
    azureOpenAIBaseUrl: config.generatorConfig.azureOpenAIBaseUrl,
    azureOpenAIApiVersion: config.generatorConfig.azureOpenAIApiVersion,
    ollamaApiKey: config.generatorConfig.ollamaApiKey,
    ollamaBaseUrl: config.generatorConfig.ollamaBaseUrl,
    groqApiKey: config.generatorConfig.groqApiKey,
    groqBaseUrl: config.generatorConfig.groqBaseUrl,
    modelCatalogs: config.generatorConfig.modelCatalogs,
  };
}

function resolveQuickRefineModel(
  config: TenantConfig,
  fallbackField: 'clarifyModel' | 'refineModel',
  modelOverride?: string,
) {
  const requestedModel = String(modelOverride ?? '').trim() || config.generatorConfig[fallbackField];
  return getTierModel(requestedModel, config.tier);
}

function normalizeFieldIds(fieldIds: Array<string | null | undefined> = []) {
  return [...new Set(fieldIds.map((id) => String(id ?? '').trim()).filter(Boolean))];
}

function normalizeProjectArMapping(arMapping?: Partial<ProjectArMapping>): ProjectArMapping {
  const outputMappings: ProjectFieldMapping = {
    summaryFieldId: String(arMapping?.outputMappings?.summaryFieldId || arMapping?.inputMappings?.summaryFieldId || 'summary'),
    descriptionFieldId: String(arMapping?.outputMappings?.descriptionFieldId || arMapping?.inputMappings?.descriptionFieldId || 'description'),
    arFieldIds: normalizeFieldIds(
      arMapping?.outputMappings?.arFieldIds?.length
        ? arMapping.outputMappings.arFieldIds
        : arMapping?.iterativeFieldIds?.length
          ? arMapping.iterativeFieldIds
          : arMapping?.consolidatedFieldId
            ? [arMapping.consolidatedFieldId]
            : [],
    ),
  };
  const inputMappings: ProjectFieldMapping = {
    summaryFieldId: String(arMapping?.inputMappings?.summaryFieldId || outputMappings.summaryFieldId || 'summary'),
    descriptionFieldId: String(arMapping?.inputMappings?.descriptionFieldId || outputMappings.descriptionFieldId || 'description'),
    arFieldIds: normalizeFieldIds(
      arMapping?.inputMappings?.arFieldIds?.length
        ? arMapping.inputMappings.arFieldIds
        : outputMappings.arFieldIds,
    ),
  };

  return {
    projectKey: String(arMapping?.projectKey || '*'),
    issueType: String(arMapping?.issueType || '*'),
    mode: outputMappings.arFieldIds.length > 1 ? 'iterative' : (arMapping?.mode || 'consolidated'),
    consolidatedFieldId: outputMappings.arFieldIds[0] || outputMappings.descriptionFieldId || 'description',
    iterativeFieldIds: outputMappings.arFieldIds,
    inputMappings,
    outputMappings,
    issueLinkType: String(arMapping?.issueLinkType || 'Relates to'),
  };
}

export function resolveQuickRefineProjectMapping(
  config: Pick<TenantConfig, 'arMappings' | 'issueLinkType'>,
  projectKey: string,
  issueType?: string,
): ProjectArMapping {
  const mappings = Array.isArray(config?.arMappings) ? config.arMappings : [];
  const normalizedIssueType = String(issueType ?? '*').trim() || '*';
  const exact = mappings.find((mapping) => mapping.projectKey === projectKey && String(mapping.issueType ?? '*') === normalizedIssueType);
  if (exact) return normalizeProjectArMapping(exact);
  const projectFallback = mappings.find((mapping) => mapping.projectKey === projectKey && String(mapping.issueType ?? '*') === '*');
  if (projectFallback) return normalizeProjectArMapping(projectFallback);
  const globalExact = mappings.find((mapping) => mapping.projectKey === '*' && String(mapping.issueType ?? '*') === normalizedIssueType);
  if (globalExact) return normalizeProjectArMapping(globalExact);
  const globalFallback = mappings.find((mapping) => mapping.projectKey === '*' && String(mapping.issueType ?? '*') === '*');
  return normalizeProjectArMapping(globalFallback || { projectKey, issueType, issueLinkType: config.issueLinkType || 'Relates to' });
}

function extractText(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join('\n').trim();
  if (typeof value === 'object') {
    const obj = value as { text?: unknown; content?: unknown[] };
    if (typeof obj.text === 'string') return obj.text.trim();
    if (Array.isArray(obj.content)) return obj.content.map(extractText).filter(Boolean).join('\n').trim();
  }
  return '';
}

function sanitizeClause(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeSentence(value: string): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim().replace(/^[,.;:\s]+|[,.;:\s]+$/g, '');
  return text;
}

function normalizeBenefit(value: string): string {
  return normalizeSentence(value)
    .replace(/^this\s+(?:ensures|allows|helps|means)\s+/i, '')
    .replace(/^to\s+/i, '');
}

function ensureTrailingPeriod(value: string): string {
  const text = normalizeSentence(value);
  if (!text) return '';
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function toSentenceCase(value: string): string {
  const text = normalizeSentence(value);
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function parseStoryLikeDescription(value: string): { role: string; action: string; benefit: string; prefersNeedTo: boolean } | null {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const strictMatch = text.match(/^As an?\s+(.+?),\s*I need(?:\s+to)?\s+(.+?)\s+so that\s+(.+)$/i);
  if (strictMatch) {
    return {
      role: normalizeSentence(strictMatch[1]),
      action: normalizeSentence(strictMatch[2]),
      benefit: normalizeSentence(strictMatch[3]),
      prefersNeedTo: /\bI need to\b/i.test(text),
    };
  }

  const looseMatch = text.match(/^As an?\s+(.+?),\s*I (need(?:\s+to)?|want to)\s+(.+)$/i);
  if (looseMatch) {
    const role = normalizeSentence(looseMatch[1]);
    const remainder = looseMatch[3].trim();
    const [firstSentence = '', ...rest] = remainder.split(/(?<=[.!?])\s+/);
    const sentence = normalizeSentence(firstSentence);
    const benefit = normalizeSentence(rest.join(' '));
    const prefersNeedTo = /\bto\b/i.test(looseMatch[2]);

    if (!sentence) return null;
    if (/so that/i.test(sentence)) {
      const [actionPart, benefitPart] = sentence.split(/\s+so that\s+/i);
      return {
        role,
        action: normalizeSentence(actionPart),
        benefit: normalizeSentence([benefitPart, benefit].filter(Boolean).join(' ')),
        prefersNeedTo,
      };
    }

    return {
      role,
      action: sentence,
      benefit,
      prefersNeedTo,
    };
  }

  return null;
}

export function ensureUserStoryDescription(value: unknown, fallback?: string): string {
  const attempt = parseStoryLikeDescription(String(value ?? ''));
  const fallbackAttempt = parseStoryLikeDescription(String(fallback ?? ''));
  const source = attempt ?? fallbackAttempt;

  if (!source) {
    throw new Error('Quick refine description must follow "As a [role], I need [action] so that [benefit]".');
  }

  const role = normalizeSentence(source.role);
  const action = normalizeSentence(source.action);
  const benefit = normalizeBenefit(source.benefit) || 'the intended business outcome is achieved';
  if (!role || !action || !benefit) {
    throw new Error('Quick refine description is missing a role, action, or benefit.');
  }

  return `As a ${toSentenceCase(role)}, I need${source.prefersNeedTo ? ' to' : ''} ${action} so that ${ensureTrailingPeriod(benefit)}`;
}

function parseArString(text: string): AcceptanceRequirement {
  const trimmed = text.trim();
  const givenMatch = trimmed.match(/GIVEN\s+([\s\S]+?)(?=\s+(?:WHEN|THEN)\b|$)/i);
  const whenMatch = trimmed.match(/WHEN\s+([\s\S]+?)(?=\s+THEN\b|$)/i);
  const thenMatch = trimmed.match(/THEN\s+([\s\S]+)$/i);

  return {
    given: sanitizeClause(givenMatch?.[1] ?? ''),
    when: sanitizeClause(whenMatch?.[1] ?? ''),
    then: sanitizeClause(thenMatch?.[1] ?? trimmed.replace(/^(GIVEN|WHEN|THEN)\s+/i, '')),
  };
}

function normalizeAcceptanceRequirements(raw: unknown[] = []): AcceptanceRequirement[] {
  const parsed = raw.flatMap((entry) => {
    if (!entry) return [];
    if (typeof entry === 'string') {
      const text = entry.trim();
      if (!text) return [];
      return text
        .split(/\n(?=GIVEN\b)/i)
        .map((part) => parseArString(part));
    }
    if (typeof entry === 'object') {
      const obj = entry as Record<string, unknown>;
      return [{
        given: sanitizeClause(obj.given ?? obj.Given ?? ''),
        when: sanitizeClause(obj.when ?? obj.When ?? ''),
        then: sanitizeClause(obj.then ?? obj.Then ?? ''),
      }];
    }
    return [];
  });

  return repairAcceptanceRequirements(parsed);
}

export function splitDescriptionAndArs(text: string): { description: string; acceptanceRequirements: AcceptanceRequirement[] } {
  const normalized = String(text ?? '').trim();
  if (!normalized) {
    return {
      description: '',
      acceptanceRequirements: [],
    };
  }

  const headingMatch = normalized.match(/\n+Acceptance Requirements\s*:?\s*\n+/i);
  if (headingMatch?.index !== undefined) {
    const description = normalized.slice(0, headingMatch.index).trim();
    const arText = normalized.slice(headingMatch.index + headingMatch[0].length).trim();
    return {
      description,
      acceptanceRequirements: parseAcceptanceRequirementsFromText(arText),
    };
  }

  if (/\bGIVEN\b[\s\S]+\bWHEN\b[\s\S]+\bTHEN\b/i.test(normalized)) {
    const firstArIndex = normalized.search(/\bGIVEN\b/i);
    if (firstArIndex > 0) {
      return {
        description: normalized.slice(0, firstArIndex).trim(),
        acceptanceRequirements: parseAcceptanceRequirementsFromText(normalized.slice(firstArIndex)),
      };
    }
  }

  return {
    description: normalized,
    acceptanceRequirements: [],
  };
}

export function parseAcceptanceRequirementsFromText(text: string): AcceptanceRequirement[] {
  const normalized = String(text ?? '').trim();
  if (!normalized) return [];

  const blocks = normalized
    .split(/\n(?=GIVEN\b)/i)
    .map((part) => part.trim())
    .filter(Boolean);

  if (!blocks.length) return [];
  return repairAcceptanceRequirements(blocks.map((block) => parseArString(block)));
}

export function buildQuickRefineReadFields(mapping: ProjectFieldMapping): string[] {
  return [
    'summary',
    'description',
    'issuetype',
    'project',
    mapping.summaryFieldId,
    mapping.descriptionFieldId,
    ...mapping.arFieldIds,
  ].filter(Boolean).filter((value, index, values) => values.indexOf(value) === index);
}

function buildRequirementText(issue: QuickRefineIssueFields, answers: QuickRefineAnswer[] = []): string {
  const parts = [
    issue.summary ? `SUMMARY: ${issue.summary}` : '',
    issue.description ? `DESCRIPTION:\n${issue.description}` : '',
    issue.acceptanceRequirements.length
      ? `ACCEPTANCE REQUIREMENTS:\n${issue.acceptanceRequirements.map((ar) => `GIVEN ${ar.given} WHEN ${ar.when} THEN ${ar.then}`).join('\n')}`
      : '',
    answers.length
      ? `QUICK CLARIFICATION Q&A:\n${answers.map((answer) => `Q: ${answer.question}\nA: ${answer.answer}`).join('\n\n')}`
      : '',
  ].filter(Boolean);

  return parts.join('\n\n');
}

function buildContextMessage(input: {
  issueKey: string;
  issueType: string;
  originalIssue: QuickRefineIssueFields;
  domainContext: string;
  similarStories: Array<{ key: string; summary: string }>;
  wiContextText: string;
  wiInsightsText?: string;
  answers?: QuickRefineAnswer[];
}): string {
  const sections = [
    `ISSUE KEY: ${input.issueKey}`,
    `ISSUE TYPE: ${input.issueType}`,
    buildRequirementText(input.originalIssue, input.answers ?? []),
  ];

  if (input.domainContext.trim()) {
    sections.push(`DOMAIN CONTEXT:\n${input.domainContext.trim().slice(0, 4000)}`);
  }
  if (input.similarStories.length) {
    sections.push(`SIMILAR BACKLOG SIGNAL:\n${input.similarStories.map((story) => `- ${story.key}: ${story.summary}`).join('\n')}`);
  }
  if (input.wiInsightsText?.trim()) {
    sections.push(`WORK INSTRUCTION INSIGHTS:\n${input.wiInsightsText.trim().slice(0, 5000)}`);
  }
  if (input.wiContextText.trim()) {
    sections.push(`WORK INSTRUCTION SIGNAL:\n${input.wiContextText.trim().slice(0, 5000)}`);
  }

  return sections.filter(Boolean).join('\n\n---\n\n');
}

function buildQuickRefineQuestionsPrompt(
  domainContext: string,
  domainRoles: string[],
  suggestedQuestionCount?: number,
): string {
  return `You are a principal business analyst preparing a very short clarification step before rewriting a Jira issue.

${domainContext.trim() ? `DOMAIN CONTEXT:\n${domainContext.trim()}\n` : ''}
${domainRoles.length ? `DOMAIN ROLES: ${domainRoles.join(', ')}\n` : ''}
${typeof suggestedQuestionCount === 'number' && suggestedQuestionCount > 0
    ? `TRIAGE SIGNAL: prior assessment suggests about ${suggestedQuestionCount} focused follow-up question${suggestedQuestionCount === 1 ? '' : 's'}.\n`
    : ''}
RULES:
- Ask at most 3 questions.
- Ask only the minimum questions needed to improve the rewrite quality.
- Questions must be concrete, specific to the actual issue, and answerable in one short response.
- Prefer business scope, actor, trigger, rule, and exception clarity over implementation detail.
- Include 2-4 short suggestion chips per question when they help.

Return JSON only:
{
  "questions": [
    {
      "id": "q1",
      "question": "specific question",
      "suggestions": ["option 1", "option 2", "option 3"]
    }
  ]
}`;
}

function buildQuickRefineRewritePrompt(domainContext: string, domainRoles: string[], mode: 'rewrite' | 'refine'): string {
  const modeInstruction = mode === 'refine'
    ? 'You are updating an existing quick-refine draft from new user instructions.'
    : 'You are rewriting an existing Jira issue into a clearer, backlog-ready artifact.';

  return `${modeInstruction}

${domainContext.trim() ? `DOMAIN CONTEXT:\n${domainContext.trim()}\n` : ''}
${domainRoles.length ? `DOMAIN ROLES: ${domainRoles.join(', ')}\n` : ''}
RULES:
- Improve clarity, scope, and testability without inventing new product scope unless the issue or answers clearly imply it.
- Keep the current issue as one rewritten item in "currentIssue".
- You may propose up to 3 "splitCandidates" only when the issue currently bundles multiple independently deliverable capabilities.
- Use business-friendly language. Avoid implementation detail unless the issue explicitly requires it.
- Every description MUST strictly follow: "As a [role], I need [action] so that [benefit]".
- Do not add any extra explanation before or after the user story sentence.
- acceptance_requirements must be complete GIVEN / WHEN / THEN triples.
- Translate technical event wording into plain business language. Prefer customer communications, open cases, approvals, routing, and outcomes over inbox names, subject lines, reference IDs, matching logic, append operations, or system internals.
- If the issue still needs the full Refinely workflow, set handoffRecommended to true and explain why in handoffReason, but still return the best possible draft.

Return JSON only:
{
  "currentIssue": {
    "summary": "rewritten summary",
    "description": "rewritten description",
    "acceptance_requirements": [
      { "given": "...", "when": "...", "then": "..." }
    ]
  },
  "splitCandidates": [
    {
      "id": "split-1",
      "summary": "candidate summary",
      "description": "candidate description",
      "acceptance_requirements": [
        { "given": "...", "when": "...", "then": "..." }
      ],
      "issueType": "Story",
      "selected": true,
      "reason": "why this should be split out"
    }
  ],
  "changeSummary": ["short bullet"],
  "handoffRecommended": false,
  "handoffReason": ""
}`;
}

function normalizeTriageQuestions(raw: QuickRefineQuestionResponse['questions']): QuickRefineQuestion[] {
  return (raw ?? [])
    .map((question, index) => {
      const text = String(question?.question ?? '').trim();
      if (!text) return null;
      const suggestions = Array.isArray(question?.suggestions)
        ? question!.suggestions!.map((value) => String(value ?? '').trim()).filter(Boolean).slice(0, 4)
        : [];
      return {
        id: String(question?.id ?? `q${index + 1}`),
        question: text,
        suggestions,
      };
    })
    .filter((value): value is QuickRefineQuestion => Boolean(value))
    .slice(0, 3);
}

function quickRefineText(issue: QuickRefineIssueFields): string {
  return [issue.summary, issue.description].filter(Boolean).join('\n').trim();
}

function getQuickRefineHeuristicClarifyReason(issue: QuickRefineIssueFields): string | null {
  const summary = issue.summary.trim();
  const description = issue.description.trim();
  const text = quickRefineText(issue).toLowerCase();
  if (!summary || summary.length < 12) return 'The issue summary is too thin for a confident rewrite.';
  if (!description || description.length < 120) return 'The issue description is still too short for a confident rewrite.';
  if (issue.acceptanceRequirements.length === 0 && description.length < 220) return 'A little more detail will improve the rewrite quality.';
  if (/\b(tbd|todo|need details|figure out|something like|etc\.?)\b/.test(text)) return 'The issue still contains placeholder language that needs clarification.';
  if ((text.match(/\?/g) ?? []).length >= 3) return 'The issue reads as open questions rather than settled scope.';
  return null;
}

export function detectQuickRefineActorAmbiguity(issue: QuickRefineIssueFields): boolean {
  const text = quickRefineText(issue);
  if (!text.trim()) return false;
  if (parseStoryLikeDescription(issue.description) || parseStoryLikeDescription(issue.summary)) return false;
  if (!QUICK_REFINE_PERMISSION_ACTOR_PATTERN.test(text)) return false;

  const hasGenericActor = QUICK_REFINE_GENERIC_ACTOR_PATTERN.test(text);
  const hasNamedActor = /\b(administrator|manager|planner|dispatcher|technician|specialist|analyst|operator|supervisor|coordinator|lead|director|reviewer|approver|scheduler|engineer|owner|agent)\b/i.test(text);
  return hasGenericActor || !hasNamedActor;
}

function shouldHandoffQuickRefine(issue: QuickRefineIssueFields): boolean {
  const text = quickRefineText(issue).toLowerCase();
  const broadSignals = [
    /\b(epic|initiative|roadmap|program)\b/,
    /\bmultiple workflows?\b/,
    /\bend to end\b/,
    /\bfull process\b/,
    /\bentire journey\b/,
    /\bmultiple teams\b/,
  ];
  const numberedBullets = (text.match(/\n\s*(?:\d+\.|-|\*)\s+/g) ?? []).length;
  return broadSignals.some((pattern) => pattern.test(text)) || numberedBullets >= 6 || text.length > 6000;
}

function normalizeIssueFields(raw: QuickRefineRawIssueFields | undefined, fallback: QuickRefineIssueFields): QuickRefineIssueFields {
  const snakeArs = raw?.acceptance_requirements;
  const camelArs = raw?.acceptanceRequirements;
  const rawArs = Array.isArray(snakeArs) && snakeArs.length
    ? snakeArs
    : Array.isArray(camelArs)
      ? camelArs
      : [];

  const summary = String(raw?.summary ?? fallback.summary).trim();
  const description = ensureUserStoryDescription(raw?.description ?? fallback.description, fallback.description);
  const acceptanceRequirements = normalizeAcceptanceRequirements(rawArs).length
    ? normalizeAcceptanceRequirements(rawArs)
    : fallback.acceptanceRequirements;

  return {
    summary: summary || fallback.summary,
    description: description || fallback.description,
    acceptanceRequirements,
  };
}

function normalizeSplitCandidates(raw: QuickRefineGenerationResponse['splitCandidates']): SplitCandidate[] {
  return (raw ?? [])
    .map((candidate, index) => {
      const summary = String(candidate?.summary ?? '').trim();
      const rawDescription = String(candidate?.description ?? '').trim();
      if (!summary && !rawDescription) return null;
      const description = ensureUserStoryDescription(rawDescription, summary ? `As a user, I need handling of ${summary.toLowerCase()} so that the requested outcome is achieved.` : '');
      const rawArs = Array.isArray(candidate?.acceptance_requirements) && candidate.acceptance_requirements.length
        ? candidate.acceptance_requirements
        : Array.isArray(candidate?.acceptanceRequirements)
          ? candidate.acceptanceRequirements
          : [];

      const nextCandidate: SplitCandidate = {
        id: String(candidate?.id ?? `split-${index + 1}`),
        summary,
        description,
        acceptanceRequirements: normalizeAcceptanceRequirements(rawArs),
        issueType: String(candidate?.issueType ?? 'Story').trim() || 'Story',
        selected: candidate?.selected === false ? false : true,
        storyPoints: typeof candidate?.storyPoints === 'number' ? candidate.storyPoints : undefined,
        reason: String(candidate?.reason ?? '').trim() || undefined,
      };
      return nextCandidate;
    })
    .filter((value): value is SplitCandidate => value !== null)
    .slice(0, 3);
}

function buildTokenUsage(stage: string, usage: { input: number; output: number }): TokenUsageSummary {
  return {
    input: usage.input,
    output: usage.output,
    total: usage.input + usage.output,
    byStage: {
      [stage]: {
        input: usage.input,
        output: usage.output,
        total: usage.input + usage.output,
      },
    },
  };
}

function mergeTokenUsage(
  base: TokenUsageSummary | undefined,
  next: TokenUsageSummary,
): TokenUsageSummary {
  if (!base) return next;
  return {
    input: base.input + next.input,
    output: base.output + next.output,
    total: base.total + next.total,
    byStage: {
      ...(base.byStage ?? {}),
      ...(next.byStage ?? {}),
    },
  };
}

function buildQuickRefineSessionDraft(
  originalIssue: QuickRefineIssueFields,
  diffBaseIssue: QuickRefineIssueFields,
  contextMeta: QuickRefineContextMeta,
  answers: QuickRefineAnswer[],
  response: QuickRefineGenerationResponse,
  usage: TokenUsageSummary,
): QuickRefineDraft {
  return {
    currentIssue: normalizeIssueFields(response.currentIssue, originalIssue),
    diffBaseIssue,
    splitCandidates: normalizeSplitCandidates(response.splitCandidates),
    clarifyAnswers: answers,
    contextMeta,
    tokenUsage: usage,
    changeSummary: Array.isArray(response.changeSummary)
      ? response.changeSummary.map((item) => String(item ?? '').trim()).filter(Boolean).slice(0, 5)
      : [],
    handoffRecommended: Boolean(response.handoffRecommended),
    handoffReason: String(response.handoffReason ?? '').trim() || undefined,
    updatedAt: new Date().toISOString(),
  };
}

function enrichQuickRefineContextMeta(
  contextMeta: QuickRefineContextMeta,
  wiContext: { docs: WiDoc[]; chunks: WiChunk[]; linkedDocs?: WiDoc[] },
  similarStories: SimilarStory[],
): QuickRefineContextMeta {
  const wiInsights = buildWorkInstructionInsightArtifact(wiContext.chunks);
  return {
    ...contextMeta,
    wiDocsCount: wiContext.docs.length,
    linkedWiDocCount: wiContext.linkedDocs?.length ?? wiContext.docs.length,
    retrievedWiDocCount: wiContext.docs.length,
    retrievedWiChunkCount: wiContext.chunks.length,
    wiInsightCount: getWorkInstructionInsightCount(wiInsights),
    referencedWiDocs: wiContext.docs.map((doc) => ({
      docId: doc.docId,
      filename: doc.filename,
      chunkCount: doc.chunkCount,
    })),
    referencedWiSections: summarizeReferencedWiSections(wiContext.chunks, 140),
    wiInsights,
    similarStoriesCount: similarStories.length,
    referencedSimilarStories: summarizeReferencedSimilarStories(similarStories),
  };
}

async function resolveQuickRefineSignals(opts: {
  issue: QuickRefineIssueFields;
  answers?: QuickRefineAnswer[];
  config: TenantConfig;
  projectKeys: string[];
}) {
  const requirement = buildRequirementText(opts.issue, opts.answers ?? []);
  const [wiContext, similarStories] = await Promise.all([
    retrieveScopedWiContext(
      requirement,
      QUICK_REFINE_WI_TOP_K,
      QUICK_REFINE_WI_MAX_CHARS,
      opts.projectKeys,
    ),
    retrieveScopedSimilarStories({
      requirement,
      clarifyAnswers: (opts.answers ?? []).map((answer) => ({
        question: answer.question,
        answer: answer.answer,
        selectedSuggestions: answer.selectedSuggestions,
      })),
      config: opts.config,
      projectKeys: opts.projectKeys,
      maxResults: QUICK_REFINE_SIMILAR_MAX_RESULTS,
    }),
  ]);

  return { wiContext, similarStories };
}

function buildWriteFields(issue: QuickRefineIssueFields, mapping: ProjectFieldMapping) {
  const featureLike = {
    id: 'quick-refine-current',
    summary: issue.summary,
    description: issue.description,
    acceptanceRequirements: issue.acceptanceRequirements,
  };

  const arFieldIds = normalizeFieldIds(mapping.arFieldIds);
  const descriptionFieldId = mapping.descriptionFieldId || 'description';
  const fields: Record<string, unknown> = {
    summary: issue.summary.slice(0, 255),
  };

  if (mapping.summaryFieldId && mapping.summaryFieldId !== 'summary') {
    fields[mapping.summaryFieldId] = issue.summary.slice(0, 255);
  }

  const iterativeMode = arFieldIds.length > 1;
  const mappedArEntries = iterativeMode
    ? arFieldIds.map((fieldId, index) => ({ fieldId, ar: issue.acceptanceRequirements[index] ?? null }))
    : [];
  const descriptionArs = iterativeMode
    ? issue.acceptanceRequirements.filter((_, index) => {
        if (index >= arFieldIds.length) return true;
        const mappedFieldId = arFieldIds[index];
        return mappedFieldId === descriptionFieldId || mappedFieldId === 'description';
      })
    : (arFieldIds.includes(descriptionFieldId) || arFieldIds.includes('description'))
      ? issue.acceptanceRequirements
      : [];

  const descriptionDoc = buildAdfDocument(featureLike, descriptionArs);
  fields.description = descriptionFieldId === 'description'
    ? descriptionDoc
    : buildAdfDocument(featureLike, []);

  if (descriptionFieldId && descriptionFieldId !== 'description') {
    fields[descriptionFieldId] = descriptionDoc;
  }

  if (iterativeMode) {
    for (const entry of mappedArEntries) {
      if (!entry.fieldId || !entry.ar) continue;
      if (entry.fieldId === descriptionFieldId || entry.fieldId === 'description') continue;
      fields[entry.fieldId] = buildAdfContentOnly([entry.ar]);
    }
  } else {
    const arDoc = buildAdfContentOnly(issue.acceptanceRequirements);
    for (const fieldId of arFieldIds) {
      if (!fieldId || fieldId === descriptionFieldId) continue;
      if (fieldId === 'description') {
        fields.description = buildAdfDocument(featureLike, issue.acceptanceRequirements);
        continue;
      }
      fields[fieldId] = arDoc;
    }
  }

  return fields;
}

export async function loadQuickRefineIssueContext(opts: {
  issueKey: string;
  surface: QuickRefineSurface;
  config: TenantConfig;
  projectKeys: string[];
}): Promise<QuickRefineIssueContext> {
  const initialProjectKey = opts.projectKeys[0] ?? opts.issueKey.split('-')[0] ?? '*';
  const initialMapping = resolveQuickRefineProjectMapping(opts.config, initialProjectKey);
  const readFields = buildQuickRefineReadFields(initialMapping.inputMappings);

  const fetchIssue = async (fields: string[]) => {
    const issueRes = await asUser().requestJira(
      assumeTrustedRoute(`/rest/api/3/issue/${opts.issueKey}?fields=${encodeURIComponent(fields.join(','))}`),
    );
    if (!issueRes.ok) {
      const body = await issueRes.text().catch(() => `HTTP ${issueRes.status}`);
      throw new Error(`Could not load issue ${opts.issueKey}: ${body}`);
    }
    return issueRes.json() as Promise<{
      id?: string;
      key?: string;
      fields?: Record<string, unknown>;
    }>;
  };

  let issue = await fetchIssue(readFields);
  const projectKey = String((issue.fields?.project as { key?: unknown } | undefined)?.key ?? initialProjectKey).trim() || initialProjectKey;
  const issueType = String((issue.fields?.issuetype as { name?: unknown } | undefined)?.name ?? '*').trim() || '*';
  const mapping = resolveQuickRefineProjectMapping(opts.config, projectKey, issueType);
  const activeFieldMapping = mapping.inputMappings;
  const outputFieldMapping = mapping.outputMappings;
  const resolvedReadFields = buildQuickRefineReadFields(activeFieldMapping);
  const needsRefetch = resolvedReadFields.some((fieldId) => !(issue.fields && Object.prototype.hasOwnProperty.call(issue.fields, fieldId)));

  if (needsRefetch) {
    issue = await fetchIssue(resolvedReadFields);
  }

  const summarySource = extractText(issue.fields?.[activeFieldMapping.summaryFieldId]) || extractText(issue.fields?.summary);
  const descriptionSource = extractText(issue.fields?.[activeFieldMapping.descriptionFieldId]) || extractText(issue.fields?.description);
  const descriptionSplit = splitDescriptionAndArs(descriptionSource);
  const arSources = normalizeFieldIds(activeFieldMapping.arFieldIds)
    .map((fieldId) => extractText(issue.fields?.[fieldId]))
    .filter(Boolean);
  const acceptanceRequirements = arSources.length
    ? parseAcceptanceRequirementsFromText(arSources.join('\n\n'))
    : descriptionSplit.acceptanceRequirements;

  const originalIssue: QuickRefineIssueFields = {
    summary: summarySource,
    description: descriptionSplit.description,
    acceptanceRequirements,
  };

  const domainContext = buildCombinedDomainContext(opts.config, [projectKey]);
  const domainRoles = getCombinedPersonaRoles(opts.config, [projectKey]).map((role) => role.role).filter(Boolean);

  const contextMeta: QuickRefineContextMeta = {
    issueKey: opts.issueKey,
    issueType,
    projectKey,
    projectKeys: [projectKey],
    projectCount: 1,
    domainRolesUsed: domainRoles,
    domainContextApplied: Boolean(domainContext.trim()),
    wiDocsCount: 0,
    linkedWiDocCount: 0,
    retrievedWiDocCount: 0,
    retrievedWiChunkCount: 0,
    wiInsightCount: 0,
    referencedWiDocs: [],
    referencedWiSections: [],
    activeFieldMapping,
    outputFieldMapping,
    similarStoriesCount: 0,
    referencedSimilarStories: [],
  };

  return {
    surface: opts.surface,
    issueKey: opts.issueKey,
    issueId: issue.id ? String(issue.id) : undefined,
    projectKey,
    issueType,
    originalIssue,
    fieldMapping: activeFieldMapping,
    outputFieldMapping,
    linkType: mapping.issueLinkType || opts.config.issueLinkType || 'Relates to',
    contextMeta,
  };
}

export async function startQuickRefine(opts: {
  context: QuickRefineIssueContext;
  config: TenantConfig;
  modelOverride?: string;
}): Promise<
  | { route: 'clarify'; questions: QuickRefineQuestion[]; reason?: string; tokenUsage: TokenUsageSummary }
  | { route: 'handoff'; reason: string; tokenUsage: TokenUsageSummary }
  | { route: 'rewrite'; draft: QuickRefineDraft }
> {
  if (shouldHandoffQuickRefine(opts.context.originalIssue)) {
    return {
      route: 'handoff',
      reason: 'This issue looks broad enough that the full Refinely workflow will produce a better result.',
      tokenUsage: {
        input: 0,
        output: 0,
        total: 0,
      },
    };
  }

  const projectKeys = [opts.context.projectKey];
  const domainContext = buildCombinedDomainContext(opts.config, projectKeys);
  const domainRoles = getCombinedPersonaRoles(opts.config, projectKeys).map((role) => role.role).filter(Boolean);
  const heuristicClarifyReason = getQuickRefineHeuristicClarifyReason(opts.context.originalIssue);
  const clarifyAssessment = heuristicClarifyReason
    ? { shouldClarify: true as const, reason: heuristicClarifyReason, suggestedQuestionCount: undefined }
    : { shouldClarify: false as const };

  if (clarifyAssessment.shouldClarify) {
    const questionsResult = await callLlmJsonWithUsage<QuickRefineQuestionResponse>({
      model: resolveQuickRefineModel(opts.config, 'clarifyModel', opts.modelOverride),
      systemPrompt: buildQuickRefineQuestionsPrompt(
        domainContext,
        domainRoles,
        clarifyAssessment.suggestedQuestionCount,
      ),
      userMessage: buildContextMessage({
        issueKey: opts.context.issueKey,
        issueType: opts.context.issueType,
        originalIssue: opts.context.originalIssue,
        domainContext,
        similarStories: [],
        wiContextText: '',
      }),
      maxTokens: 1100,
      reasoningEffort: 'low',
      ...buildProviderOpts(opts.config),
    });
    const questions = normalizeTriageQuestions(questionsResult.data.questions);
    return {
      route: 'clarify',
      reason: clarifyAssessment.reason || 'A little more specificity will improve the quick rewrite.',
      questions,
      tokenUsage: mergeTokenUsage(
        undefined,
        buildTokenUsage('quick_refine_questions', questionsResult.usage),
      ),
    };
  }

  const { wiContext, similarStories } = await resolveQuickRefineSignals({
    issue: opts.context.originalIssue,
    config: opts.config,
    projectKeys,
  });
  const wiInsights = buildWorkInstructionInsightArtifact(wiContext.chunks);

  const rewrite = await callLlmJsonWithUsage<QuickRefineGenerationResponse>({
    model: resolveQuickRefineModel(opts.config, 'refineModel', opts.modelOverride),
    systemPrompt: buildQuickRefineRewritePrompt(domainContext, domainRoles, 'rewrite'),
    userMessage: buildContextMessage({
      issueKey: opts.context.issueKey,
      issueType: opts.context.issueType,
      originalIssue: opts.context.originalIssue,
      domainContext,
      similarStories,
      wiInsightsText: formatWorkInstructionInsightsForPrompt(wiInsights),
      wiContextText: wiContext.text,
    }),
    maxTokens: Math.min(opts.config.generatorConfig.maxTokens, 2000),
    reasoningEffort: 'low',
    ...buildProviderOpts(opts.config),
  });

  return {
    route: 'rewrite',
    draft: buildQuickRefineSessionDraft(
      opts.context.originalIssue,
      opts.context.originalIssue,
      enrichQuickRefineContextMeta(opts.context.contextMeta, wiContext, similarStories),
      [],
      rewrite.data,
      buildTokenUsage('quick_refine_rewrite', rewrite.usage),
    ),
  };
}

export async function submitQuickRefineAnswers(opts: {
  context: QuickRefineIssueContext;
  answers: QuickRefineAnswer[];
  config: TenantConfig;
  modelOverride?: string;
}): Promise<QuickRefineDraft> {
  const projectKeys = [opts.context.projectKey];
  const domainContext = buildCombinedDomainContext(opts.config, projectKeys);
  const domainRoles = getCombinedPersonaRoles(opts.config, projectKeys).map((role) => role.role).filter(Boolean);
  const { wiContext, similarStories } = await resolveQuickRefineSignals({
    issue: opts.context.originalIssue,
    answers: opts.answers,
    config: opts.config,
    projectKeys,
  });
  const wiInsights = buildWorkInstructionInsightArtifact(wiContext.chunks);
  const contextMeta = enrichQuickRefineContextMeta(opts.context.contextMeta, wiContext, similarStories);

  const rewrite = await callLlmJsonWithUsage<QuickRefineGenerationResponse>({
    model: resolveQuickRefineModel(opts.config, 'refineModel', opts.modelOverride),
    systemPrompt: buildQuickRefineRewritePrompt(domainContext, domainRoles, 'rewrite'),
    userMessage: buildContextMessage({
      issueKey: opts.context.issueKey,
      issueType: opts.context.issueType,
      originalIssue: opts.context.originalIssue,
      domainContext,
      similarStories,
      wiInsightsText: formatWorkInstructionInsightsForPrompt(wiInsights),
      wiContextText: wiContext.text,
      answers: opts.answers,
    }),
    maxTokens: Math.min(opts.config.generatorConfig.maxTokens, 5000),
    reasoningEffort: 'medium',
    ...buildProviderOpts(opts.config),
  });

  return buildQuickRefineSessionDraft(
    opts.context.originalIssue,
    opts.context.originalIssue,
    contextMeta,
    opts.answers,
    rewrite.data,
    buildTokenUsage('quick_refine_answered_rewrite', rewrite.usage),
  );
}

export async function refineQuickRefineDraft(opts: {
  context: QuickRefineIssueContext;
  draft: QuickRefineDraft;
  instructions: string;
  config: TenantConfig;
  modelOverride?: string;
}): Promise<QuickRefineDraft> {
  const projectKeys = [opts.context.projectKey];
  const domainContext = buildCombinedDomainContext(opts.config, projectKeys);
  const domainRoles = getCombinedPersonaRoles(opts.config, projectKeys).map((role) => role.role).filter(Boolean);
  const answers = opts.draft.clarifyAnswers ?? [];
  const { wiContext, similarStories } = await resolveQuickRefineSignals({
    issue: opts.draft.currentIssue,
    answers,
    config: opts.config,
    projectKeys,
  });
  const wiInsights = buildWorkInstructionInsightArtifact(wiContext.chunks);
  const contextMeta = enrichQuickRefineContextMeta(opts.draft.contextMeta ?? opts.context.contextMeta, wiContext, similarStories);

  const rewrite = await callLlmJsonWithUsage<QuickRefineGenerationResponse>({
    model: resolveQuickRefineModel(opts.config, 'refineModel', opts.modelOverride),
    systemPrompt: buildQuickRefineRewritePrompt(domainContext, domainRoles, 'refine'),
    userMessage: [
      buildContextMessage({
        issueKey: opts.context.issueKey,
        issueType: opts.context.issueType,
        originalIssue: opts.draft.currentIssue,
        domainContext,
        similarStories,
        wiInsightsText: formatWorkInstructionInsightsForPrompt(wiInsights),
        wiContextText: wiContext.text,
        answers,
      }),
      `USER INSTRUCTIONS: ${opts.instructions.trim()}`,
      `ORIGINAL ISSUE:\n${JSON.stringify(opts.context.originalIssue, null, 2)}`,
      `CURRENT QUICK-REFINE DRAFT:\n${JSON.stringify(opts.draft, null, 2)}`,
    ].join('\n\n'),
    maxTokens: Math.min(opts.config.generatorConfig.maxTokens, 5000),
    reasoningEffort: 'medium',
    ...buildProviderOpts(opts.config),
  });

  return buildQuickRefineSessionDraft(
    opts.context.originalIssue,
    opts.draft.currentIssue,
    contextMeta,
    answers,
    rewrite.data,
    mergeTokenUsage(opts.draft.tokenUsage, buildTokenUsage('quick_refine_refine', rewrite.usage)),
  );
}

export { resolveQuickRefineModel };

async function updateExistingIssue(issueKey: string, fields: Record<string, unknown>) {
  const res = await asUser().requestJira(assumeTrustedRoute(`/rest/api/3/issue/${issueKey}`), {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => `HTTP ${res.status}`);
    throw new Error(`Issue update failed (${res.status}): ${body}`);
  }
}

export async function applyQuickRefine(opts: {
  issueKey: string;
  projectKey: string;
  draft: QuickRefineDraft;
  reporterAccountId: string;
  currentIssueMapping: ProjectFieldMapping;
  createIssueMapping: ProjectArMapping;
  linkType: string;
}): Promise<QuickRefineApplyResult> {
  const currentIssueFields = buildWriteFields(opts.draft.currentIssue, opts.currentIssueMapping);
  await updateExistingIssue(opts.issueKey, currentIssueFields);

  const createdIssues: QuickRefineApplyResult['createdIssues'] = [];
  const linkErrors: QuickRefineApplyResult['linkErrors'] = [];
  const selectedCandidates = (opts.draft.splitCandidates ?? []).filter((candidate) => candidate.selected);

  for (const candidate of selectedCandidates) {
    const featureLike = {
      id: candidate.id,
      summary: candidate.summary,
      description: candidate.description,
      acceptanceRequirements: candidate.acceptanceRequirements,
    };
    const created = await createFeatureIssue({
      feature: featureLike,
      projectKey: opts.projectKey,
      issueType: candidate.issueType || 'Story',
      reporterAccountId: opts.reporterAccountId,
      arMapping: opts.createIssueMapping,
    });
    createdIssues.push({
      candidateId: candidate.id,
      issueKey: created.issueKey,
      issueUrl: created.issueUrl,
    });

    try {
      await createIssueLink({
        inwardIssueKey: opts.issueKey,
        outwardIssueKey: created.issueKey,
        linkType: opts.linkType,
      });
    } catch (error) {
      linkErrors.push({
        candidateId: candidate.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    updatedIssueKey: opts.issueKey,
    createdIssues,
    linkErrors,
  };
}
