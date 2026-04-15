import { UserPreferences } from '../types';
import { entityGet, entitySet, KEYS } from './cache';

export async function getUserPreferences(accountId: string): Promise<UserPreferences> {
  if (!accountId) return {};
  return await entityGet<UserPreferences>(KEYS.userPreferences(accountId)) ?? {};
}

export async function saveUserPreferences(accountId: string, patch: Partial<UserPreferences>): Promise<UserPreferences> {
  if (!accountId) return {};
  const current = await getUserPreferences(accountId);
  const next: UserPreferences = {
    ...current,
    ...patch,
    quickRefineModelByProvider: {
      ...(current.quickRefineModelByProvider ?? {}),
      ...(patch.quickRefineModelByProvider ?? {}),
    },
  };
  if (!next.defaultProjectKey || next.defaultProjectKey === '*') {
    delete next.defaultProjectKey;
  }
  if (next.pipelineProfile !== 'fast' && next.pipelineProfile !== 'balanced' && next.pipelineProfile !== 'quality') {
    delete next.pipelineProfile;
  }
  if (next.quickRefineModelByProvider) {
    Object.entries(next.quickRefineModelByProvider).forEach(([provider, model]) => {
      if (!model?.trim()) {
        delete next.quickRefineModelByProvider?.[provider as keyof typeof next.quickRefineModelByProvider];
      }
    });
    if (!Object.keys(next.quickRefineModelByProvider).length) {
      delete next.quickRefineModelByProvider;
    }
  }
  await entitySet(KEYS.userPreferences(accountId), next);
  return next;
}
