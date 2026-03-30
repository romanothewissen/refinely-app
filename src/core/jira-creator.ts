/**
 * Create Jira issues from generated features.
 * Converts descriptions and ARs to Atlassian Document Format (ADF).
 */

import { asUser, assumeTrustedRoute } from '@forge/api';
import { Feature } from '../types';

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
  arMapping?: {
    mode: 'consolidated' | 'iterative';
    consolidatedFieldId: string;
    iterativeFieldIds: string[];
  };
}): Promise<CreateIssueResult> {
  const { feature, projectKey, issueType, reporterAccountId, assigneeAccountId, arMapping } = opts;

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

  const mode = arMapping?.mode || 'consolidated';
  const consolidatedFieldId = arMapping?.consolidatedFieldId || 'description';
  const iterativeFieldIds = arMapping?.iterativeFieldIds || [];

  if (mode === 'consolidated') {
    // Current behavior: Map to a single field (default Description)
    if (consolidatedFieldId === 'description') {
      body.fields.description = buildAdfDocument(feature, true);
    } else {
      // User mapping to a custom field
      body.fields.description = buildAdfDocument(feature, false);
      body.fields[consolidatedFieldId] = buildAdfContentOnly(feature.acceptanceRequirements);
    }
  } else {
    // Mapping each AR to a specific field
    body.fields.description = buildAdfDocument(feature, false); // No ARs in description
    feature.acceptanceRequirements.forEach((ar, idx) => {
      const fieldId = iterativeFieldIds[idx];
      if (fieldId) {
        body.fields[fieldId] = buildSingleArAdf(ar);
      }
    });
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
  return {
    issueKey: data.key,
    issueUrl: `${baseUrl}/browse/${data.key}`,
  };
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

function buildAdfDocument(feature: Feature, includeArs: boolean) {
  const nodes: unknown[] = [];

  // Description
  if (feature.description) {
    nodes.push({
      type: 'paragraph',
      content: [{ type: 'text', text: feature.description }],
    });
  }

  // Acceptance Requirements
  if (includeArs && feature.acceptanceRequirements.length) {
    nodes.push({
      type: 'heading',
      attrs: { level: 3 },
      content: [{ type: 'text', text: 'Acceptance Requirements' }],
    });

    for (const ar of feature.acceptanceRequirements) {
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
