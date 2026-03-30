import React, { useState, useEffect } from 'react';
import { X, LayoutDashboard, UserPlus, UserCircle, Type, Activity, CheckCircle, AlertCircle, ExternalLink } from 'lucide-react';
import { api } from './hooks/useForge';
import { view, router } from '@forge/bridge';

interface JiraModalProps {
  onClose: () => void;
  onCreate: (formData: Record<string, any>) => void;
  feature?: any;
  originIssueKey?: string;
}

type ModalState = 'form' | 'creating' | 'success' | 'error';

export function JiraModal({ onClose, onCreate, feature, originIssueKey }: JiraModalProps) {
  const [projectKey, setProjectKey] = useState('');
  const [issueType, setIssueType] = useState('Story');
  const [projects, setProjects] = useState<{ key: string; name: string }[]>([]);
  const [state, setState] = useState<ModalState>('form');
  const [result, setResult] = useState<{ key: string; url?: string; linkedTo?: string | null; linkError?: string | null } | null>(null);
  const [error, setError] = useState('');
  const [accountId, setAccountId] = useState('');

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
          setProjectKey(jiraRes.projects[0]?.key ?? '');
        }
        if (ctx?.accountId) setAccountId(ctx.accountId);
      } catch {}
    })();
  }, []);

  const handleCreate = async () => {
    if (!projectKey) return;
    setState('creating');
    try {
      const res = await api.createIssue({
        feature,
        projectKey,
        issueType,
        reporterAccountId: accountId || undefined,
        originIssueKey,
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
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/20" onClick={state === 'form' ? onClose : undefined} />

      <div className="relative bg-white w-full max-w-md rounded-lg shadow-[var(--rf-shadow-lg)] flex flex-col overflow-hidden slide-up border border-[var(--rf-border)]">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center">
              <Activity className="w-4 h-4 text-blue-600" />
            </div>
            <h2 className="text-base font-semibold text-slate-800">Push to Jira</h2>
          </div>
          {state !== 'creating' && (
            <button onClick={onClose} className="p-1.5 hover:bg-slate-100 text-slate-400 rounded-lg transition">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Body */}
        <div className="px-6 py-5">

          {/* FORM STATE */}
          {state === 'form' && (
            <div className="space-y-4">
              {/* Feature preview */}
              <div className="bg-slate-50 rounded-xl p-3 border border-slate-200">
                <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Feature</p>
                <p className="text-sm font-medium text-slate-800 line-clamp-2">{feature?.title || feature?.summary}</p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                {/* Project */}
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-600 flex items-center gap-1.5">
                    <LayoutDashboard className="w-3.5 h-3.5 text-slate-400" /> Project
                  </label>
                  {projects.length > 0 ? (
                    <select
                      value={projectKey}
                      onChange={e => setProjectKey(e.target.value)}
                      className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition"
                    >
                      {projects.map(p => <option key={p.key} value={p.key}>{p.key} — {p.name}</option>)}
                    </select>
                  ) : (
                    <input
                      value={projectKey}
                      onChange={e => setProjectKey(e.target.value)}
                      placeholder="e.g. PROJ"
                      className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition"
                    />
                  )}
                </div>

                {/* Issue type */}
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-600 flex items-center gap-1.5">
                    <Type className="w-3.5 h-3.5 text-slate-400" /> Issue Type
                  </label>
                  <select
                    value={issueType}
                    onChange={e => setIssueType(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition"
                  >
                    <option>Story</option>
                    <option>Task</option>
                    <option>Bug</option>
                    <option>Epic</option>
                  </select>
                </div>
              </div>

            </div>
          )}

          {/* CREATING STATE */}
          {state === 'creating' && (
            <div className="flex flex-col items-center justify-center py-10 gap-4">
              <div className="w-14 h-14 rounded-full bg-blue-50 flex items-center justify-center">
                <div className="w-8 h-8 border-[3px] border-blue-200 border-t-blue-600 rounded-full spin-slow" />
              </div>
              <div className="text-center">
                <p className="font-semibold text-slate-800">Creating in Jira…</p>
                <p className="text-sm text-slate-400 mt-1">Setting up the story, description and acceptance criteria</p>
              </div>
              <div className="dot-bounce text-blue-400">
                <span /><span /><span />
              </div>
            </div>
          )}

          {/* SUCCESS STATE */}
          {state === 'success' && result && (
            <div className="flex flex-col items-center justify-center py-8 gap-4 fade-in">
              <div className="w-14 h-14 rounded-full bg-green-50 border border-green-200 flex items-center justify-center">
                <CheckCircle className="w-7 h-7 text-green-600" />
              </div>
              <div className="text-center">
                <p className="font-bold text-slate-800 text-lg">Created successfully!</p>
                <p className="text-sm text-slate-500 mt-1">Jira story <span className="font-mono font-bold text-blue-700">{result.key}</span> has been created</p>
              </div>

              <div className="w-full bg-slate-50 border border-slate-200 rounded-xl p-4 text-sm space-y-2">
                <div className="flex justify-between items-center">
                  <span className="text-slate-500">Issue Key</span>
                  <button
                    onClick={() => result.url ? router.navigate(result.url) : null}
                    className="font-mono font-bold text-blue-700 hover:text-blue-900 underline underline-offset-4 decoration-blue-200 hover:decoration-blue-700 transition"
                  >
                    {result.key}
                  </button>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-slate-500">Project</span>
                  <span className="font-semibold text-slate-700">{projectKey}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-slate-500">Type</span>
                  <span className="font-semibold text-slate-700">{issueType}</span>
                </div>
                {originIssueKey && (
                  <div className="pt-1 border-t border-slate-200 space-y-1">
                    {result?.linkedTo ? (
                      <div className="flex justify-between items-center">
                        <span className="text-slate-500">Linked to</span>
                        <span className="font-mono font-bold text-indigo-600">{result.linkedTo}</span>
                      </div>
                    ) : (
                      <div className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                        <span className="font-semibold">Link not created.</span>{' '}
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
                  className="flex items-center gap-2 text-blue-600 hover:text-blue-800 text-sm font-semibold transition"
                >
                  Open {result.key} in Jira <ExternalLink className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )}

          {/* ERROR STATE */}
          {state === 'error' && (
            <div className="flex flex-col items-center justify-center py-8 gap-4 fade-in">
              <div className="w-14 h-14 rounded-full bg-red-50 border border-red-200 flex items-center justify-center">
                <AlertCircle className="w-7 h-7 text-red-500" />
              </div>
              <div className="text-center">
                <p className="font-bold text-slate-800">Creation failed</p>
                <p className="text-sm text-slate-500 mt-1 max-w-xs">{error}</p>
              </div>
              <button
                onClick={() => setState('form')}
                className="px-4 py-2 text-sm font-semibold text-white bg-slate-800 hover:bg-slate-900 rounded-lg transition"
              >
                Try again
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        {state === 'form' && (
          <div className="px-6 py-4 border-t border-slate-100 flex items-center justify-end gap-3">
            <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition">
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={!projectKey}
              className="px-5 py-2 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg transition shadow-sm active:scale-[0.98]"
            >
              Create in Jira
            </button>
          </div>
        )}
        {state === 'success' && result && (
          <div className="px-6 py-4 border-t border-slate-100 flex justify-end">
            <button onClick={() => { onCreate(result); onClose(); }} className="px-5 py-2 text-sm font-semibold text-white bg-green-600 hover:bg-green-700 rounded-lg transition">
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
