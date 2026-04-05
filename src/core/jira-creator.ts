/**
 * Create Jira issues from generated features.
 * Converts descriptions and ARs to Atlassian Document Format (ADF).
 */

import { asUser, assumeTrustedRoute } from '@forge/api';
import { Feature, ProjectArMapping, ProjectFieldMapping } from '../types';
import { appendComplianceAuditEvent } from '../services/compliance';
import { getConfig } from '../services/tenant-config';

export interface CreateIssueResult {
  issueKey: string;
  issueUrl: string;
}

export async function createFeatureIssue(opts: {
  feature: Feature;
  projectKey: string;
  issueType: string;
  reporterAccountId: string;
  assigneeAccountId?: string;
  arMapping?: Partial<ProjectArMapping> & {
    inputMappings?: Partial<ProjectFieldMapping>;
    outputMappings?: Partial<ProjectFieldMapping>;
  };
}): Promise<CreateIssueResult> {
  const { feature, projectKey, issueType, reporterAccountId, assigneeAccountId, arMapping } = opts;
  const mapping = normalizeProjectArMapping(arMapping);

  // Story points vary per site (custom field); omit here to avoid invalid field errors.
  const body = {
    fields: {
      project: { key: projectKey },
      issuetype: { name: issueType },
      summary: feature.summary.slice(0, 255),
      reporter: { id: reporterAccountId },
      ...(assigneeAccountId ? { assignee: { id: assigneeAccountId } } : {}),
    } as any,
  };

  const outputMappings = mapping.outputMappings;
  const descriptionFieldId = outputMappings.descriptionFieldId || 'description';
  const arFieldIds = normalizeFieldIds(outputMappings.arFieldIds);
  const iterativeMode = arFieldIds.length > 1;
  const mappedArEntries = iterativeMode
    ? arFieldIds.map((fieldId, index) => ({ fieldId, ar: feature.acceptanceRequirements[index] ?? null }))
    : [];
  const descriptionArs = iterativeMode
    ? [
        ...feature.acceptanceRequirements.filter((_, index) => {
          if (index >= arFieldIds.length) return true;
          const mappedFieldId = arFieldIds[index];
          return mappedFieldId === descriptionFieldId || mappedFieldId === 'description';
        }),
      ]
    : (arFieldIds.includes(descriptionFieldId) || arFieldIds.includes('description'))
      ? feature.acceptanceRequirements
      : [];
  const descriptionDoc = buildAdfDocument(feature, descriptionArs);

  body.fields.description = descriptionFieldId === 'description'
    ? descriptionDoc
    : buildAdfDocument(feature, []);

  if (descriptionFieldId && descriptionFieldId !== 'description') {
    body.fields[descriptionFieldId] = descriptionDoc;
  }

  if (iterativeMode) {
    for (const entry of mappedArEntries) {
      if (!entry.fieldId || !entry.ar) continue;
      if (entry.fieldId === descriptionFieldId || entry.fieldId === 'description') continue;
      body.fields[entry.fieldId] = buildAdfContentOnly([entry.ar]);
    }
  } else {
    const arDoc = buildAdfContentOnly(feature.acceptanceRequirements);
    for (const fieldId of arFieldIds) {
      if (!fieldId || fieldId === descriptionFieldId) continue;
      if (fieldId === 'description') {
        body.fields.description = buildAdfDocument(feature, feature.acceptanceRequirements);
        continue;
      }
      body.fields[fieldId] = arDoc;
    }
  }

  const response = await asUser().requestJira(assumeTrustedRoute('/rest/api/3/issue'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await response.json() as { key?: string; self?: string; errors?: Record<string, string> };

  if (!data.key) {
    throw new Error(`Jira issue creation failed: ${JSON.stringify(data.errors ?? data)}`);
  }

  const baseUrl = await getBaseUrl();
  const issueUrl = `${baseUrl}/browse/${data.key}`;

  try {
    const config = await getConfig();
    if (config.compliance?.enabled && config.compliance?.auditTrailEnabled) {
      await appendComplianceAuditEvent({
        actorAccountId: reporterAccountId,
        category: 'runtime',
        action: 'JIRA_ISSUE_CREATED',
        details: { issueKey: data.key, projectKey, issueType },
        enabled: true,
      });
    }
  } catch (err) {
    console.warn('[createFeatureIssue] Failed to log compliance event', err);
  }

  return {
    issueKey: data.key,
    issueUrl,
  };
}

function normalizeProjectArMapping(
  arMapping?: Partial<ProjectArMapping> & {
    inputMappings?: Partial<ProjectFieldMapping>;
    outputMappings?: Partial<ProjectFieldMapping>;
  },
): ProjectArMapping {
  const legacyOutputArFieldIds = normalizeFieldIds(
    arMapping?.mode === 'iterative'
      ? arMapping?.iterativeFieldIds
      : arMapping?.consolidatedFieldId
        ? [arMapping.consolidatedFieldId]
        : [],
  );
  const hasOutputArFieldIds = Boolean(arMapping?.outputMappings && Object.prototype.hasOwnProperty.call(arMapping.outputMappings, 'arFieldIds'));
  const hasInputArFieldIds = Boolean(arMapping?.inputMappings && Object.prototype.hasOwnProperty.call(arMapping.inputMappings, 'arFieldIds'));
  const outputArFieldIds = hasOutputArFieldIds
    ? normalizeFieldIds(arMapping?.outputMappings?.arFieldIds)
    : legacyOutputArFieldIds;
  const inputArFieldIds = hasInputArFieldIds
    ? normalizeFieldIds(arMapping?.inputMappings?.arFieldIds)
    : outputArFieldIds;
  const outputMappings: ProjectFieldMapping = {
    summaryFieldId: arMapping?.outputMappings?.summaryFieldId || 'summary',
    descriptionFieldId: arMapping?.outputMappings?.descriptionFieldId || 'description',
    arFieldIds: outputArFieldIds,
  };
  const inputMappings: ProjectFieldMapping = {
    summaryFieldId: arMapping?.inputMappings?.summaryFieldId || 'summary',
    descriptionFieldId: arMapping?.inputMappings?.descriptionFieldId || 'description',
    arFieldIds: inputArFieldIds,
  };

  return {
    projectKey: arMapping?.projectKey || '*',
    mode: outputMappings.arFieldIds.length > 1 ? 'iterative' : (arMapping?.mode || 'consolidated'),
    consolidatedFieldId: outputMappings.arFieldIds[0] || outputMappings.descriptionFieldId || 'description',
    iterativeFieldIds: outputMappings.arFieldIds,
    inputMappings,
    outputMappings,
    issueLinkType: arMapping?.issueLinkType || 'Relates to',
  };
}

function normalizeFieldIds(fieldIds: Array<string | null | undefined> = []) {
  return [...new Set(fieldIds.map(id => id?.trim()).filter((id): id is string => Boolean(id)))];
}

export async function createIssueLink(opts: {
  inwardIssueKey: string;
  outwardIssueKey: string;
  linkType: string;
}): Promise<void> {
  const { inwardIssueKey, outwardIssueKey, linkType } = opts;
  const res = await asUser().requestJira(assumeTrustedRoute('/rest/api/3/issueLink'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: { name: linkType },
      inwardIssue: { key: inwardIssueKey },
      outwardIssue: { key: outwardIssueKey },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => `HTTP ${res.status}`);
    throw new Error(`Issue link creation failed (${res.status}): ${body}`);
  }
}

export async function getIssueLinkTypes(): Promise<Array<{ id: string; name: string; inward: string; outward: string }>> {
  const res = await asUser().requestJira(assumeTrustedRoute('/rest/api/3/issueLinkType'));
  const data = await res.json() as { issueLinkTypes?: Array<{ id: string; name: string; inward: string; outward: string }> };
  return data.issueLinkTypes ?? [];
}

export async function searchUsers(query: string): Promise<Array<{ accountId: string; displayName: string; emailAddress?: string }>> {
  const response = await asUser().requestJira(assumeTrustedRoute(`/rest/api/3/user/search?query=${encodeURIComponent(query)}&maxResults=10`));
  return response.json();
}

// ─── ADF Helpers ──────────────────────────────────────────────────────────────

function buildAdfDocument(feature: Feature, ars: any[]) {
  const nodes: unknown[] = [];

  // Description
  if (feature.description) {
    nodes.push({
      type: 'paragraph',
      content: [{ type: 'text', text: feature.description }],
    });
  }

  // Acceptance Requirements
  if (ars.length) {
    nodes.push({
      type: 'heading',
      attrs: { level: 3 },
      content: [{ type: 'text', text: 'Acceptance Requirements' }],
    });

    for (const ar of ars) {
      nodes.push(buildSingleArAdf(ar));
    }
  }

  // Process code if present
  if (feature.processCode) {
    nodes.push({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Process Code: ', marks: [{ type: 'strong' }] },
        { type: 'text', text: feature.processCode },
      ],
    });
  }

  return { version: 1, type: 'doc', content: nodes };
}

function buildSingleArAdf(ar: any) {
  const content: any[] = [];
  if (ar.given?.trim()) {
    content.push({ type: 'text', text: 'GIVEN ', marks: [{ type: 'strong' }] });
    content.push({ type: 'text', text: ar.given });
    content.push({ type: 'hardBreak' });
  }
  if (ar.when?.trim()) {
    content.push({ type: 'text', text: 'WHEN ', marks: [{ type: 'strong' }] });
    content.push({ type: 'text', text: ar.when });
    content.push({ type: 'hardBreak' });
  }
  content.push({ type: 'text', text: 'THEN ', marks: [{ type: 'strong' }] });
  content.push({ type: 'text', text: ar.then });

  return {
    type: 'paragraph',
    content
  };
}

function buildAdfContentOnly(ars: any[]) {
  const nodes = ars.map(ar => buildSingleArAdf(ar));
  // Insert blank lines between ARs if requested
  const spacedNodes: any[] = [];
  nodes.forEach((node, i) => {
    spacedNodes.push(node);
    if (i < nodes.length - 1) {
      spacedNodes.push({ type: 'paragraph', content: [] });
    }
  });
  return { version: 1, type: 'doc', content: spacedNodes };
}

async function getBaseUrl(): Promise<string> {
  try {
    const res = await asUser().requestJira(assumeTrustedRoute('/rest/api/3/serverInfo'));
    const data = await res.json() as { baseUrl?: string };
    return data.baseUrl ?? 'https://your-site.atlassian.net';
  } catch {
    return 'https://your-site.atlassian.net';
  }
}
