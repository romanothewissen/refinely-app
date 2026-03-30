/**
 * Forge Queue Consumer: async clarifying question generation.
 *
 * Runs with 900s timeout — allows slow thinking models (e.g. Gemini 2.5 Pro)
 * to generate high-quality clarifying questions without hitting the 25s
 * resolver limit.
 *
 * Result is stored in Forge Storage; the frontend polls getClarifyResult.
 */

import { ClarifyContextMeta, ClarifyEvent } from '../types';
import { generateClarifyingQuestions } from '../core/story-generator';
import { retrieveWiContext } from '../core/wi-ingestion';
import { getEffectiveTier } from '../services/billing';
import { entitySet, KEYS } from '../services/cache';

export async function handler(event: { body: ClarifyEvent }) {
  const { sessionId, requirement, attachmentText, license, config: eventConfig, projectKey } = event.body;
  
  // Resolve project-specific context
  const relevantContext = eventConfig.domainContexts?.find(c => c.projectKey === projectKey) 
    || eventConfig.domainContexts?.find(c => c.projectKey === '*')
    || { context: eventConfig.domainContext || '' };
    
  const config = { 
    ...eventConfig, 
    domainContext: relevantContext.context,
    tier: getEffectiveTier(eventConfig, { license }) 
  };

  try {
    const wiContext = config.wiConfig.enabled
      ? await retrieveWiContext(requirement, 4, 20000, projectKey)
      : { text: '', docs: [] };

    const questions = await generateClarifyingQuestions({
      requirement,
      attachmentText,
      wiContextText: wiContext.text,
      config,
    });

    const clarifyContext: ClarifyContextMeta = {
      projectKey,
      domainRolesUsed: config.domainRoles ?? [],
      domainContextApplied: Boolean(config.domainContext?.trim()),
      attachmentIncluded: Boolean(attachmentText?.trim()),
      wiDocsCount: wiContext.docs.length,
      referencedWiDocs: wiContext.docs.slice(0, 12).map(doc => ({
        docId: doc.docId,
        filename: doc.filename,
        chunkCount: doc.chunkCount,
      })),
      usesGoldenExamples: false,
      usesSimilarStories: false,
    };

    await entitySet(KEYS.clarifyProgress(sessionId), {
      type: 'complete',
      questions,
      contextMeta: clarifyContext,
      updatedAt: Date.now(),
    });
  } catch (err) {
    console.error('[clarify-queue] Error:', err);
    await entitySet(KEYS.clarifyProgress(sessionId), {
      type: 'error',
      error: err instanceof Error ? err.message : 'Clarify failed',
      updatedAt: Date.now(),
    });
  }
}
