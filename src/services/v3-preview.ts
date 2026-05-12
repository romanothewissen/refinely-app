import { discoverIssueTypes, discoverStatuses } from '../core/jira-discovery';
import {
  buildCombinedDomainContext,
  getCombinedPersonaRoles,
  normalizeProjectKeys,
  retrieveScopedSimilarStories,
  retrieveScopedWiContext,
} from './project-selection';
import { loadProjectMemoryRuntimeContext } from './project-memory-runtime';
import type { SimilarStory, TenantConfig, WiChunk } from '../types';

interface V3JiraProjectMetadata {
  projects: Array<{ id?: string; key: string; name?: string; projectTypeKey?: string }>;
  issueTypes: Array<{ id: string; name: string; description?: string }>;
  statuses: Array<{ id: string; name: string; statusCategory?: { name?: string } }>;
}

type V3ContextKind =
  | 'role'
  | 'business_object'
  | 'workflow_step'
  | 'business_rule'
  | 'exception'
  | 'definition'
  | 'decision'
  | 'constraint'
  | 'project_convention'
  | 'status';

interface ForgeV3PreviewInput {
  requirement: string;
  config: TenantConfig;
  projectKey?: string;
  projectKeys?: string[];
  accountId?: string;
  selectedDocIds?: string[];
  maxContextCards?: number;
  provider?: 'heuristic' | 'gemini';
  jsaText?: string;
}

interface V3BacklogExampleInput {
  key: string;
  summary: string;
  description: string;
  acceptanceRequirements: Array<{
    given: string;
    when: string;
    then: string;
  }>;
}

interface V3ProjectContextInput {
  id: string;
  title: string;
  text: string;
  projectKey?: string;
  kind?: V3ContextKind;
}

interface V3DocumentInput {
  id: string;
  sourceId?: string;
  title: string;
  filename?: string;
  section?: string;
  text: string;
  projectKey?: string;
  kind?: V3ContextKind;
}

interface V3Runtime {
  runV3Pipeline: (input: unknown, generator?: unknown, planner?: unknown) => Promise<unknown>;
  scoreV3Result: (result: unknown, jsaText?: string) => unknown;
  HeuristicGenerator: new () => unknown;
  HeuristicPlanner: new () => unknown;
  GeminiJsonGenerator: new (options: {
    apiKey: string;
    model?: string;
    baseUrl?: string;
    maxOutputTokens?: number;
    thinkingBudget?: number;
  }) => unknown;
  GeminiFlashPlanner: new (options: {
    apiKey: string;
    model?: string;
    baseUrl?: string;
    maxOutputTokens?: number;
    thinkingBudget?: number;
  }) => unknown;
}

interface ForgeV3SourcesSummary {
  projectKeys: string[];
  primaryProjectKey: string;
  documentCount: number;
  documentChunkCount: number;
  similarStoryCount: number;
  projectContextCount: number;
  memoryStatus?: string;
  memoryArtifactVersion?: string;
}

interface ForgeV3PreviewResult {
  result: unknown;
  score: unknown;
  sources: ForgeV3SourcesSummary;
}

function loadV3Runtime(): V3Runtime {
  const pipeline = require('../../v3/dist/src/pipeline.js');
  const scoring = require('../../v3/dist/src/scoring.js');
  const generator = require('../../v3/dist/src/generator.js');
  const planner = require('../../v3/dist/src/planner.js');
  return {
    runV3Pipeline: pipeline.runV3Pipeline,
    scoreV3Result: scoring.scoreV3Result,
    HeuristicGenerator: generator.HeuristicGenerator,
    HeuristicPlanner: planner.HeuristicPlanner,
    GeminiJsonGenerator: generator.GeminiJsonGenerator,
    GeminiFlashPlanner: planner.GeminiFlashPlanner,
  };
}

function compactText(value: string, maxChars = 1200): string {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 3)}...` : normalized;
}

function pushContext(
  cards: V3ProjectContextInput[],
  input: V3ProjectContextInput,
) {
  if (!input.text.trim()) return;
  cards.push({
    ...input,
    text: compactText(input.text),
  });
}

function parseAcceptanceCriteria(story: SimilarStory): V3BacklogExampleInput['acceptanceRequirements'] {
  const text = String(story.acceptanceCriteria ?? '').trim();
  if (!text) return [];
  const normalized = text.replace(/\r/g, '');
  const gwtMatch = normalized.match(/\bgiven\b([\s\S]+?)\bwhen\b([\s\S]+?)\bthen\b([\s\S]+)/i);
  if (gwtMatch) {
    return [{
      given: compactText(gwtMatch[1] ?? '', 220),
      when: compactText(gwtMatch[2] ?? '', 220),
      then: compactText(gwtMatch[3] ?? '', 260),
    }];
  }

  return normalized
    .split(/\n+/)
    .map((line) => line.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 4)
    .map((line) => ({
      given: `a comparable backlog story ${story.key} is in scope`,
      when: 'the acceptance pattern is considered for refinement',
      then: compactText(line, 260),
    }));
}

function mapSimilarStories(stories: SimilarStory[]): V3BacklogExampleInput[] {
  return stories.map((story) => ({
    key: story.key,
    summary: story.summary,
    description: compactText([story.description, story.acceptanceCriteria].filter(Boolean).join('\n\n'), 1000),
    acceptanceRequirements: parseAcceptanceCriteria(story),
  }));
}

function mapDocumentChunks(chunks: WiChunk[], projectKey: string): V3DocumentInput[] {
  return chunks.map((chunk) => ({
    id: `${chunk.docId}:chunk:${chunk.chunkIndex}`,
    sourceId: chunk.docId,
    title: chunk.filename,
    filename: chunk.filename,
    section: chunk.sectionLabel ?? `Chunk ${chunk.chunkIndex + 1}`,
    text: compactText(chunk.text, 1200),
    projectKey,
    kind: inferDocumentKindFromFacets(chunk),
  }));
}

function inferDocumentKindFromFacets(chunk: WiChunk): V3ContextKind | undefined {
  const kinds = new Set((chunk.facets ?? []).map((facet) => facet.kind));
  if (kinds.has('exception')) return 'exception';
  if (kinds.has('split_decision')) return 'decision';
  if (kinds.has('rule')) return 'business_rule';
  if (kinds.has('transition') || kinds.has('sequence')) return 'workflow_step';
  if (kinds.has('actor')) return 'role';
  if (kinds.has('object')) return 'business_object';
  if (kinds.has('output') || kinds.has('input')) return 'definition';
  return undefined;
}

function addMemorySelectionCards(
  cards: V3ProjectContextInput[],
  projectKeys: string[],
  memorySelection: any,
) {
  if (!memorySelection) return;
  const projectKey = projectKeys[0];
  const addList = (id: string, title: string, kind: V3ContextKind, values?: string[]) => {
    const text = (values ?? []).filter(Boolean).join('; ');
    pushContext(cards, { id, title, kind, text, projectKey });
  };

  addList('memory-roles', 'Project memory roles', 'role', memorySelection.roles);
  addList('memory-objects', 'Project memory business objects', 'business_object', memorySelection.objects);
  addList('memory-workflow-patterns', 'Project memory workflow patterns', 'workflow_step', memorySelection.workflow_patterns);
  addList('memory-lifecycle-states', 'Project memory lifecycle states', 'status', memorySelection.lifecycle_states);
  addList('memory-business-rules', 'Project memory business rules', 'business_rule', memorySelection.business_rules);
  addList('memory-exceptions', 'Project memory exceptions', 'exception', memorySelection.exception_patterns);
  addList('memory-retrieval-hints', 'Project memory retrieval hints', 'project_convention', memorySelection.retrieval_hints);

  const wiMemory = memorySelection.wi_memory;
  if (wiMemory) {
    addList('memory-wi-facts', 'Project document resolved facts', 'definition', wiMemory.resolvedFacts);
    addList('memory-wi-steps', 'Project document workflow steps', 'workflow_step', wiMemory.workflowSteps);
    addList('memory-wi-rules', 'Project document business rules', 'business_rule', wiMemory.businessRules);
    addList('memory-wi-exceptions', 'Project document exceptions', 'exception', wiMemory.exceptions);
    addList('memory-wi-must-cover', 'Project document must-cover behaviors', 'constraint', wiMemory.mustCoverBehaviors);
  }
}

function buildJiraProjectContext(input: {
  projectKeys: string[];
  jiraData: V3JiraProjectMetadata;
  domainContext: string;
  personaRoles: ReturnType<typeof getCombinedPersonaRoles>;
  memoryRuntime?: Awaited<ReturnType<typeof loadProjectMemoryRuntimeContext>>;
}): V3ProjectContextInput[] {
  const cards: V3ProjectContextInput[] = [];
  const primaryProjectKey = input.projectKeys[0];
  const primaryProject = input.jiraData.projects.find((project) => project.key === primaryProjectKey);

  pushContext(cards, {
    id: `jira-project-${primaryProjectKey}`,
    title: 'Jira project metadata',
    projectKey: primaryProjectKey,
    kind: 'definition',
    text: [
      primaryProject ? `Project ${primaryProject.key}: ${primaryProject.name}` : `Project ${primaryProjectKey}`,
      primaryProject?.projectTypeKey ? `Type: ${primaryProject.projectTypeKey}` : '',
      input.projectKeys.length > 1 ? `Additional selected projects: ${input.projectKeys.slice(1).join(', ')}` : '',
    ].filter(Boolean).join('. '),
  });

  pushContext(cards, {
    id: `jira-issue-types-${primaryProjectKey}`,
    title: 'Jira issue types',
    projectKey: primaryProjectKey,
    kind: 'definition',
    text: input.jiraData.issueTypes
      .map((issueType) => `${issueType.name}${issueType.description ? `: ${issueType.description}` : ''}`)
      .join('; '),
  });

  pushContext(cards, {
    id: `jira-statuses-${primaryProjectKey}`,
    title: 'Jira workflow statuses',
    projectKey: primaryProjectKey,
    kind: 'status',
    text: input.jiraData.statuses
      .map((status) => `${status.name}${status.statusCategory?.name ? ` (${status.statusCategory.name})` : ''}`)
      .join('; '),
  });

  pushContext(cards, {
    id: `configured-domain-context-${primaryProjectKey}`,
    title: 'Configured project domain context',
    projectKey: primaryProjectKey,
    kind: 'project_convention',
    text: input.domainContext,
  });

  input.personaRoles.forEach((role, index) => {
    pushContext(cards, {
      id: `configured-role-${index + 1}`,
      title: `Configured project role: ${role.role || 'Unnamed role'}`,
      projectKey: primaryProjectKey,
      kind: 'role',
      text: [role.role, role.activities].filter(Boolean).join(': '),
    });
  });

  const header = input.memoryRuntime?.memoryHeader;
  if (header) {
    pushContext(cards, {
      id: `project-memory-header-${primaryProjectKey}`,
      title: 'Compiled project memory summary',
      projectKey: primaryProjectKey,
      kind: 'project_convention',
      text: [
        header.roles.length ? `Roles: ${header.roles.join(', ')}` : '',
        header.businessObjects.length ? `Business objects: ${header.businessObjects.join(', ')}` : '',
        header.workflowCues.length ? `Workflow cues: ${header.workflowCues.join(', ')}` : '',
        header.arStyleHint ? `Acceptance style: ${header.arStyleHint}` : '',
      ].filter(Boolean).join('. '),
    });
  }
  addMemorySelectionCards(cards, input.projectKeys, input.memoryRuntime?.memorySelection);

  return cards;
}

async function discoverV3ProjectMetadata(projectKey: string): Promise<V3JiraProjectMetadata> {
  const [issueTypesResult, statusesResult] = await Promise.allSettled([
    discoverIssueTypes(projectKey),
    discoverStatuses(projectKey),
  ]);

  return {
    projects: [{ key: projectKey }],
    issueTypes: issueTypesResult.status === 'fulfilled' ? issueTypesResult.value : [],
    statuses: statusesResult.status === 'fulfilled' ? statusesResult.value : [],
  };
}

function shouldUseGemini(provider?: 'heuristic' | 'gemini'): boolean {
  if (provider === 'heuristic') return false;
  if (provider === 'gemini') return true;
  // Forge resolver invocations have a hard 25s limit for Custom UI calls.
  // Keep the pilot synchronous and responsive by defaulting to the local V3 engine;
  // explicit Gemini runs should move behind an async queue before becoming default.
  return false;
}

function geminiApiKey(): string {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
}

export async function runForgeV3Preview(input: ForgeV3PreviewInput): Promise<ForgeV3PreviewResult> {
  const startedAt = Date.now();
  const requirement = String(input.requirement ?? '').trim();
  if (!requirement) throw new Error('Requirement is required.');

  const projectKeys = normalizeProjectKeys(input.projectKey, input.projectKeys);
  const primaryProjectKey = projectKeys[0];
  if (!primaryProjectKey) throw new Error('Select a Jira project before running V3 Preview.');

  const [jiraData, wiContext, similarStories, memoryRuntime] = await Promise.all([
    discoverV3ProjectMetadata(primaryProjectKey),
    retrieveScopedWiContext(requirement, 10, 12000, projectKeys, input.selectedDocIds),
    retrieveScopedSimilarStories({
      requirement,
      config: input.config,
      projectKeys,
      maxResults: 8,
    }),
    loadProjectMemoryRuntimeContext({
      projectKeys,
      memoryStage: 'final_generation',
      requestedBy: input.accountId,
      logWarning: () => undefined,
    }).catch(() => null),
  ]);

  const domainContext = buildCombinedDomainContext(input.config, projectKeys);
  const personaRoles = getCombinedPersonaRoles(input.config, projectKeys);
  const projectContext = buildJiraProjectContext({
    projectKeys,
    jiraData,
    domainContext,
    personaRoles,
    memoryRuntime: memoryRuntime ?? undefined,
  });
  const documents = mapDocumentChunks(wiContext.chunks, primaryProjectKey);
  const backlogExamples = mapSimilarStories(similarStories);
  const runtime = loadV3Runtime();
  const apiKey = geminiApiKey();
  const useGemini = shouldUseGemini(input.provider) && Boolean(apiKey);
  const options = {
    apiKey,
    model: process.env.REFINELY_V3_GEMINI_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    baseUrl: process.env.GEMINI_BASE_URL,
    thinkingBudget: Number(process.env.REFINELY_V3_THINKING_BUDGET ?? 2048),
  };
  const planner = useGemini ? new runtime.GeminiFlashPlanner(options) : new runtime.HeuristicPlanner();
  const generator = useGemini ? new runtime.GeminiJsonGenerator(options) : new runtime.HeuristicGenerator();

  const result = await runtime.runV3Pipeline({
    requirement,
    workInstructions: [],
    backlogExamples,
    projectContext,
    documents,
    maxContextCards: input.maxContextCards ?? 14,
  }, generator, planner);
  const score = runtime.scoreV3Result(result, input.jsaText);
  console.info('[v3-preview] completed', {
    projectKeys,
    durationMs: Date.now() - startedAt,
    documents: documents.length,
    backlogExamples: backlogExamples.length,
    projectContext: projectContext.length,
    provider: useGemini ? 'gemini' : 'heuristic',
  });

  return {
    result,
    score,
    sources: {
      projectKeys,
      primaryProjectKey,
      documentCount: wiContext.docs.length,
      documentChunkCount: wiContext.chunks.length,
      similarStoryCount: similarStories.length,
      projectContextCount: projectContext.length,
      memoryStatus: memoryRuntime?.memoryStatus,
      memoryArtifactVersion: memoryRuntime?.memoryArtifactVersion,
    },
  };
}

export const __testV3PreviewAdapter = {
  buildJiraProjectContext,
  mapDocumentChunks,
  mapSimilarStories,
};
