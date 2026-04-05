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
  };
  if (!next.defaultProjectKey || next.defaultProjectKey === '*') {
    delete next.defaultProjectKey;
  }
  await entitySet(KEYS.userPreferences(accountId), next);
  return next;
}
