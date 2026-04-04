import React, { useState, useEffect } from 'react';
import { X, LayoutDashboard, Type, Activity, CheckCircle, AlertCircle, ExternalLink, ChevronDown } from 'lucide-react';
import { motion } from 'framer-motion';
import { api } from './hooks/useForge';
import { view, router } from '@forge/bridge';
import { SearchableSelect } from './components/SearchableSelect';

interface JiraModalProps {
  onClose: () => void;
  onCreate: (formData: Record<string, any>) => void;
  feature?: any;
  originIssueKey?: string;
  sessionId?: string;
  defaultProjectKey?: string;
}

type ModalState = 'form' | 'creating' | 'success' | 'error';

export function JiraModal({ onClose, onCreate, feature, originIssueKey, sessionId, defaultProjectKey }: JiraModalProps) {
  const [projectKey, setProjectKey] = useState('');
  const [issueType, setIssueType] = useState('Story');
  const [projects, setProjects] = useState<{ key: string; name: string }[]>([]);
  const [state, setState] = useState<ModalState>('form');
  const [result, setResult] = useState<{ key: string; url?: string; linkedTo?: string | null; linkError?: string | null } | null>(null);
  const [error, setError] = useState('');
  const [accountId, setAccountId] = useState('');
  const projectOptions = projects.map((project) => ({
    value: project.key,
    label: `${project.key} · ${project.name}`,
    description: project.name,
  }));

  useEffect(() => {
    // Fetch available projects + current user accountId
    (async () => {
      try {
        const [jiraRes, ctx] = await Promise.all([
          api.discoverJira() as any,
          view.getContext() as any,
        ]);
        if (jiraRes?.success && jiraRes.projects?.length > 0) {
          setProjects(jiraRes.projects);
          const preferredProject =
            (defaultProjectKey && defaultProjectKey !== '*' && jiraRes.projects.find((p: any) => p.key === defaultProjectKey)?.key) ||
            jiraRes.projects[0]?.key ||
            '';
          setProjectKey(preferredProject);
        }
        if (ctx?.accountId) setAccountId(ctx.accountId);
      } catch {}
    })();
  }, [defaultProjectKey]);

  const handleCreate = async () => {
    if (!projectKey) return;
    setState('creating');
    try {
      const res = await api.createIssue({
        feature,
        featureId: feature?.id,
        projectKey,
        issueType,
        reporterAccountId: accountId || undefined,
        originIssueKey,
        sessionId,
      }) as any;

      if (res.success) {
        setResult({ key: res.issueKey, url: res.issueUrl, linkedTo: res.linkedTo, linkError: res.linkError });
        setState('success');
      } else {
        setError(res.error ?? 'Unknown error');
        setState('error');
      }
    } catch (err: any) {
      setError(err?.message ?? String(err));
      setState('error');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 sm:p-6">
      <motion.div 
        className="absolute inset-0 bg-[var(--rf-text)]/40 backdrop-blur-sm" 
        onClick={state === 'form' ? onClose : undefined} 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      />

      <motion.div 
        className="relative rf-glass-card w-full max-w-md flex flex-col overflow-hidden"
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      >
        {/* Header */}
        <div className="px-6 py-5 border-b border-[var(--rf-border-subtle)] flex items-center justify-between bg-white/40 backdrop-blur-sm">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[var(--rf-brand-subtle)] border border-[var(--rf-border)] flex items-center justify-center">
              <Activity className="w-5 h-5 text-[var(--rf-brand)]" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-[var(--rf-text)] tracking-tight">Push to Jira</h2>
            </div>
          </div>
          {state !== 'creating' && (
            <motion.button 
              onClick={onClose} 
              className="p-2 hover:bg-white/60 text-[var(--rf-text-tertiary)] rounded-xl transition"
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
            >
              <X className="w-5 h-5" />
            </motion.button>
          )}
        </div>

        {/* Body */}
        <div className="px-6 py-6">

          {/* FORM STATE */}
          {state === 'form' && (
            <div className="space-y-6">
              {/* Feature preview */}
              <div className="bg-white/55 rounded-xl p-4 border border-[var(--rf-border)] backdrop-blur-sm">
                <p className="text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest mb-2">Feature to Create</p>
                <p className="text-sm font-bold text-[var(--rf-text)] line-clamp-2 leading-snug">{feature?.title || feature?.summary}</p>
              </div>

              <div className="grid grid-cols-2 gap-5">
                {/* Project */}
                <div className="space-y-2">
                  <label className="text-xs font-bold text-[var(--rf-text-secondary)] flex items-center gap-2">
                    <LayoutDashboard className="w-4 h-4 text-[var(--rf-brand)]" /> Project
                  </label>
                  {projects.length > 0 ? (
                    <SearchableSelect
                      value={projectKey}
                      onChange={setProjectKey}
                      options={projectOptions}
                      placeholder="Select project"
                      searchPlaceholder="Search projects..."
                      buttonClassName="bg-white"
                    />
                  ) : (
                    <input
                      value={projectKey}
                      onChange={e => setProjectKey(e.target.value)}
                      placeholder="e.g. PROJ"
                      className="w-full bg-white/65 border border-[var(--rf-border)] rounded-xl px-4 py-2.5 text-sm font-medium text-[var(--rf-text)] focus:outline-none focus:ring-2 focus:ring-[var(--rf-brand-subtle)] focus:border-[var(--rf-brand)] transition backdrop-blur-sm"
                    />
                  )}
                </div>

                {/* Issue type */}
                <div className="space-y-2">
                  <label className="text-xs font-bold text-[var(--rf-text-secondary)] flex items-center gap-2">
                    <Type className="w-4 h-4 text-[var(--rf-brand)]" /> Issue Type
                  </label>
                  <div className="relative">
                    <select
                      value={issueType}
                      onChange={e => setIssueType(e.target.value)}
                      className="appearance-none pr-7 w-full bg-white/65 border border-[var(--rf-border)] rounded-xl px-4 py-2.5 text-sm font-medium text-[var(--rf-text)] focus:outline-none focus:ring-2 focus:ring-[var(--rf-brand-subtle)] focus:border-[var(--rf-brand)] transition backdrop-blur-sm"
                    >
                      <option>Story</option>
                      <option>Task</option>
                      <option>Bug</option>
                      <option>Epic</option>
                    </select>
                    <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--rf-sidebar-text-muted)] pointer-events-none" />
                  </div>
                </div>
              </div>

            </div>
          )}

          {/* CREATING STATE */}
          {state === 'creating' && (
            <motion.div 
              className="flex flex-col items-center justify-center py-10 gap-6"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
            >
              <div className="relative">
                <div className="w-16 h-16 rounded-2xl bg-[var(--rf-brand-subtle)] border border-[var(--rf-border)] flex items-center justify-center">
                  <div className="w-8 h-8 border-[3px] border-[rgba(43,89,74,0.12)] border-t-[var(--rf-brand)] rounded-full spin-slow" />
                </div>
                <div className="absolute -inset-2 bg-[var(--rf-brand-muted)]/10 rounded-3xl animate-pulse" />
              </div>
              <div className="text-center space-y-1">
                <p className="font-bold text-[var(--rf-text)] text-lg tracking-tight">Creating in Jira…</p>
                <p className="text-sm font-medium text-[var(--rf-text-tertiary)] max-w-[200px] mx-auto leading-relaxed">Setting up the story, description and acceptance criteria</p>
              </div>
            </motion.div>
          )}

          {/* SUCCESS STATE */}
          {state === 'success' && result && (
            <motion.div 
              className="flex flex-col items-center justify-center py-6 gap-6"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
            >
              <div className="w-16 h-16 rounded-2xl bg-[var(--rf-success-subtle)] border border-[var(--rf-success-subtle)] flex items-center justify-center">
                <CheckCircle className="w-8 h-8 text-[var(--rf-success)]" />
              </div>
              <div className="text-center">
                <p className="font-black text-[var(--rf-text)] text-xl tracking-tight">Created Successfully!</p>
                <p className="text-sm font-medium text-[var(--rf-text-tertiary)] mt-2">Jira issue <span className="font-mono font-bold text-[var(--rf-brand)] bg-[var(--rf-brand-muted)] px-1.5 py-0.5 rounded">{result.key}</span> is ready</p>
              </div>

              <div className="w-full bg-white/55 border border-[var(--rf-border)] rounded-2xl p-5 text-sm space-y-3 backdrop-blur-sm">
                <div className="flex justify-between items-center pb-3 border-b border-[var(--rf-border)]">
                  <span className="text-[var(--rf-text-tertiary)] font-semibold">Issue Key</span>
                  <button
                    onClick={() => result.url ? router.navigate(result.url) : null}
                    className="font-mono font-bold text-[var(--rf-brand-hover)] hover:text-[var(--rf-brand)] transition"
                  >
                    {result.key}
                  </button>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-[var(--rf-text-tertiary)] font-semibold">Project</span>
                  <span className="font-bold text-[var(--rf-text)]">{projectKey}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-[var(--rf-text-tertiary)] font-semibold">Type</span>
                  <span className="font-bold text-[var(--rf-text)]">{issueType}</span>
                </div>
                {originIssueKey && (
                  <div className="pt-3 border-t border-[var(--rf-border)] mt-1">
                    {result?.linkedTo ? (
                      <div className="flex justify-between items-center">
                        <span className="text-[var(--rf-text-tertiary)] font-semibold">Linked to</span>
                        <span className="font-mono font-bold text-[var(--rf-brand-hover)] bg-[var(--rf-brand-muted)] px-2 py-0.5 rounded-lg border border-[rgba(43,89,74,0.12)]">{result.linkedTo}</span>
                      </div>
                    ) : (
                      <div className="text-xs font-medium text-[var(--rf-warning)] bg-[var(--rf-warning-subtle)] border border-[rgba(179,94,48,0.18)] rounded-xl px-4 py-3">
                        <span className="font-bold block mb-1">Link not created.</span>
                        {result?.linkError
                          ? result.linkError.replace(/^Issue link creation failed \(\d+\): /, '')
                          : 'Check the link type in Settings → Jira → Issue Linking.'}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {result.url && (
                <button
                  onClick={() => router.navigate(result.url!)}
                  className="flex items-center justify-center gap-2 w-full py-3 bg-[var(--rf-brand-muted)] hover:bg-[var(--rf-brand-subtle)] text-[var(--rf-brand-hover)] rounded-xl text-sm font-bold transition border border-[var(--rf-brand-subtle)]"
                >
                  Open in Jira <ExternalLink className="w-4 h-4" />
                </button>
              )}
            </motion.div>
          )}

          {/* ERROR STATE */}
          {state === 'error' && (
            <motion.div 
              className="flex flex-col items-center justify-center py-8 gap-5"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
            >
              <div className="w-16 h-16 rounded-2xl bg-[var(--rf-danger-subtle)] border border-[var(--rf-danger-subtle)] flex items-center justify-center shadow-inner shadow-rose-500/10">
                <AlertCircle className="w-8 h-8 text-[var(--rf-danger)]" />
              </div>
              <div className="text-center space-y-2">
                <p className="font-black text-[var(--rf-text)] text-lg">Creation Failed</p>
                <div className="bg-[var(--rf-danger-subtle)] border border-[rgba(158,62,71,0.12)] rounded-xl p-3 max-w-sm">
                  <p className="text-xs font-medium text-[var(--rf-danger)] leading-relaxed">{error}</p>
                </div>
              </div>
              <button
                onClick={() => setState('form')}
                className="mt-2 px-6 py-2.5 text-sm font-bold text-[var(--rf-text-secondary)] bg-white/70 border border-[var(--rf-border)] hover:bg-white/90 hover:text-[var(--rf-text)] rounded-xl transition backdrop-blur-sm"
              >
                Try Again
              </button>
            </motion.div>
          )}
        </div>

        {/* Footer */}
        {state === 'form' && (
          <div className="px-6 py-5 border-t border-[var(--rf-border-subtle)] flex items-center justify-end gap-3 bg-white/35 backdrop-blur-sm">
            <button onClick={onClose} className="px-5 py-2.5 text-sm font-bold text-[var(--rf-text-secondary)] bg-white/70 border border-[var(--rf-border)] hover:bg-white/90 rounded-xl transition backdrop-blur-sm">
              Cancel
            </button>
            <motion.button
              onClick={handleCreate}
              disabled={!projectKey}
              className="px-6 py-2.5 text-sm font-bold text-white bg-[var(--rf-brand)] hover:bg-[var(--rf-brand-hover)] disabled:opacity-50 disabled:bg-[var(--rf-border-strong)] rounded-xl transition shadow-md shadow-[var(--rf-brand)]/20"
              whileTap={{ scale: 0.98 }}
            >
              Create in Jira
            </motion.button>
          </div>
        )}
        {state === 'success' && result && (
          <div className="px-6 py-5 border-t border-[var(--rf-border-subtle)] flex justify-end bg-white/35 backdrop-blur-sm">
            <motion.button 
              onClick={() => { onCreate(result); onClose(); }} 
              className="px-8 py-2.5 text-sm font-bold text-white bg-[var(--rf-text)] hover:bg-black rounded-xl transition shadow-md"
              whileTap={{ scale: 0.98 }}
            >
              Done
            </motion.button>
          </div>
        )}
      </motion.div>
    </div>
  );
}
