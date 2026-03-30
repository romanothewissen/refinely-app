/**
 * Jira metadata discovery for the settings wizard.
 * Uses asUser().requestJira so Browse projects and other permissions match the signed-in user.
 */

import { asUser, assumeTrustedRoute } from '@forge/api';

export interface JiraProject {
  id: string;
  key: string;
  name: string;
  projectTypeKey: string;
}

export interface JiraIssueType {
  id: string;
  name: string;
  description: string;
}

export interface JiraStatus {
  id: string;
  name: string;
  statusCategory: { name: string };
}

export interface JiraField {
  id: string;
  name: string;
  custom: boolean;
  schema?: { type: string };
}

interface PageBeanProjects {
  values?: JiraProject[];
  isLast?: boolean;
}

export async function discoverProjects(): Promise<JiraProject[]> {
  // Use GET /rest/api/3/project/search (paginated). The deprecated GET /rest/api/3/project
  // does not document maxResults; passing it can yield an empty list even when projects exist.
  const all: JiraProject[] = [];
  let startAt = 0;
  const maxResults = 50;
  let isLast = false;
  do {
    const path = `/rest/api/3/project/search?startAt=${startAt}&maxResults=${maxResults}`;
    const response = await asUser().requestJira(assumeTrustedRoute(path));
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`Jira projects request failed (${response.status}): ${raw.slice(0, 200)}`);
    }
    let data: PageBeanProjects;
    try {
      data = JSON.parse(raw) as PageBeanProjects;
    } catch {
      throw new Error('Jira projects response was not valid JSON');
    }
    const page = data.values ?? [];
    all.push(...page);
    isLast = data.isLast ?? page.length === 0;
    startAt += page.length;
    if (all.length > 5000) break;
  } while (!isLast);

  return all.sort((a, b) => (a.name || a.key).localeCompare(b.name || b.key));
}

export async function discoverIssueTypes(projectKey: string): Promise<JiraIssueType[]> {
  const response = await asUser().requestJira(assumeTrustedRoute(`/rest/api/3/issue/createmeta?projectKeys=${projectKey}&expand=projects.issuetypes`));
  const data = await response.json() as { projects?: Array<{ issuetypes?: JiraIssueType[] }> };
  return data.projects?.[0]?.issuetypes ?? [];
}

export async function discoverStatuses(projectKey: string): Promise<JiraStatus[]> {
  const response = await asUser().requestJira(assumeTrustedRoute(`/rest/api/3/project/${projectKey}/statuses`));
  const data = await response.json() as Array<{ statuses?: JiraStatus[] }>;
  // Flatten statuses from all issue types, deduplicate by name
  const seen = new Set<string>();
  const statuses: JiraStatus[] = [];
  for (const issueTypeStatuses of data) {
    for (const status of issueTypeStatuses.statuses ?? []) {
      if (!seen.has(status.name)) {
        seen.add(status.name);
        statuses.push(status);
      }
    }
  }
  return statuses;
}

export async function discoverCustomFields(): Promise<JiraField[]> {
  const response = await asUser().requestJira(assumeTrustedRoute('/rest/api/3/field'));
  const data = await response.json() as JiraField[];
  return data.filter(f => f.custom);
}

export async function discoverAll(projectKey?: string) {
  const [projects, fields] = await Promise.all([
    discoverProjects(),
    discoverCustomFields(),
  ]);

  let issueTypes: JiraIssueType[] = [];
  let statuses: JiraStatus[] = [];

  if (projectKey) {
    [issueTypes, statuses] = await Promise.all([
      discoverIssueTypes(projectKey),
      discoverStatuses(projectKey),
    ]);
  }

  return { projects, fields, issueTypes, statuses };
}

