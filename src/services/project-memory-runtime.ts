import type {
  ProjectMemoryArtifactHeader,
  ProjectMemorySelection,
  V2MemoryStatus,
} from '../v2/types';
import {
  getProjectMemoryHeaderForProjects,
  getProjectMemorySelectionForStage,
  queueProjectMemoryRefreshForProjects,
} from './project-memory';

type ProjectMemoryStage = 'discover' | 'discovery_synthesis' | 'final_generation' | 'coverage_repair';

interface LoadProjectMemoryRuntimeContextInput {
  projectKeys: string[];
  memoryStage?: ProjectMemoryStage;
  requestedBy?: string;
  loadHeader?: typeof getProjectMemoryHeaderForProjects;
  loadSelection?: typeof getProjectMemorySelectionForStage;
  queueRefresh?: typeof queueProjectMemoryRefreshForProjects;
  logWarning?: (message: string, detail: string) => void;
}

interface ProjectMemoryRuntimeContext {
  memoryHeader: ProjectMemoryArtifactHeader;
  memoryStatus: V2MemoryStatus;
  memoryArtifactVersion?: string;
  memorySelection: ProjectMemorySelection | null;
}

export class ProjectMemoryRuntimeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectMemoryRuntimeUnavailableError';
  }
}

const EMPTY_PROJECT_MEMORY_HEADER: ProjectMemoryArtifactHeader = {
  roles: [],
  businessObjects: [],
  workflowCues: [],
  arStyleHint: '',
  freshness: 'missing',
  builtAt: null,
};

function detailFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'Unknown project memory error');
}

export async function loadProjectMemoryRuntimeContext(
  input: LoadProjectMemoryRuntimeContextInput,
): Promise<ProjectMemoryRuntimeContext> {
  if (!input.projectKeys.length) {
    return {
      memoryHeader: EMPTY_PROJECT_MEMORY_HEADER,
      memoryStatus: 'missing',
      memorySelection: null,
    };
  }

  const loadHeader = input.loadHeader ?? getProjectMemoryHeaderForProjects;
  const loadSelection = input.loadSelection ?? getProjectMemorySelectionForStage;
  const queueRefresh = input.queueRefresh ?? queueProjectMemoryRefreshForProjects;
  const logWarning = input.logWarning ?? ((message: string, detail: string) => {
    console.warn(message, detail);
  });

  try {
    const [{ header, status, artifactVersion }, memorySelection] = await Promise.all([
      loadHeader(input.projectKeys),
      input.memoryStage
        ? loadSelection(input.projectKeys, input.memoryStage)
        : Promise.resolve(null),
    ]);

    if (status === 'missing' || !artifactVersion) {
      throw new ProjectMemoryRuntimeUnavailableError(
        'Compiled project memory is not available for the selected project. Refresh project memory in Settings and try again.',
      );
    }
    if (input.memoryStage && !memorySelection) {
      throw new ProjectMemoryRuntimeUnavailableError(
        'Compiled project memory is incomplete for the selected project. Refresh project memory in Settings and try again.',
      );
    }

    if (status !== 'fresh') {
      try {
        await queueRefresh(input.projectKeys, 'weekly', input.requestedBy
          ? { requestedBy: input.requestedBy }
          : undefined);
      } catch (error) {
        logWarning(
          '[project-memory] Failed to queue a background refresh; continuing without blocking the run.',
          detailFromError(error),
        );
      }
    }

    return {
      memoryHeader: header,
      memoryStatus: status,
      memoryArtifactVersion: artifactVersion,
      memorySelection,
    };
  } catch (error) {
    if (error instanceof ProjectMemoryRuntimeUnavailableError) {
      throw error;
    }
    const detail = detailFromError(error);
    logWarning(
      '[project-memory] Failed to load compiled project memory required for this run.',
      detail,
    );
    throw new ProjectMemoryRuntimeUnavailableError(
      `Compiled project memory could not be loaded for the selected project. Refresh project memory in Settings and try again. Technical detail: ${detail}`,
    );
  }
}
