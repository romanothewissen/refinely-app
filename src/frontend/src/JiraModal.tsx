import React, { useState, useEffect } from 'react';
import { X, LayoutDashboard, Type, Activity, CheckCircle, AlertCircle, ExternalLink } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { api } from './hooks/useForge';
import { view, router } from '@forge/bridge';

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
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" 
        onClick={state === 'form' ? onClose : undefined} 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      />

      <motion.div 
        className="relative bg-white w-full max-w-md rounded-2xl shadow-2xl flex flex-col overflow-hidden border border-slate-200"
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      >
        {/* Header */}
        <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-50 border border-blue-100 shadow-sm flex items-center justify-center">
              <Activity className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900 tracking-tight">Push to Jira</h2>
            </div>
          </div>
          {state !== 'creating' && (
            <motion.button 
              onClick={onClose} 
              className="p-2 hover:bg-slate-200 text-slate-500 rounded-xl transition"
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
              <div className="bg-slate-50 rounded-xl p-4 border border-slate-200 shadow-inner">
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Feature to Create</p>
                <p className="text-sm font-bold text-slate-900 line-clamp-2 leading-snug">{feature?.title || feature?.summary}</p>
              </div>

              <div className="grid grid-cols-2 gap-5">
                {/* Project */}
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-700 flex items-center gap-2">
                    <LayoutDashboard className="w-4 h-4 text-blue-500" /> Project
                  </label>
                  {projects.length > 0 ? (
                    <select
                      value={projectKey}
                      onChange={e => setProjectKey(e.target.value)}
                      className="w-full bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-sm font-medium text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition shadow-sm"
                    >
                      {projects.map(p => <option key={p.key} value={p.key}>{p.key} — {p.name}</option>)}
                    </select>
                  ) : (
                    <input
                      value={projectKey}
                      onChange={e => setProjectKey(e.target.value)}
                      placeholder="e.g. PROJ"
                      className="w-full bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-sm font-medium text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition shadow-sm"
                    />
                  )}
                </div>

                {/* Issue type */}
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-700 flex items-center gap-2">
                    <Type className="w-4 h-4 text-blue-500" /> Issue Type
                  </label>
                  <select
                    value={issueType}
                    onChange={e => setIssueType(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-sm font-medium text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition shadow-sm"
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
            <motion.div 
              className="flex flex-col items-center justify-center py-10 gap-6"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
            >
              <div className="relative">
                <div className="w-16 h-16 rounded-2xl bg-blue-50 border border-blue-100 flex items-center justify-center shadow-inner">
                  <div className="w-8 h-8 border-[3px] border-blue-200 border-t-blue-600 rounded-full spin-slow" />
                </div>
                <div className="absolute -inset-2 bg-blue-500/10 rounded-3xl animate-pulse" />
              </div>
              <div className="text-center space-y-1">
                <p className="font-bold text-slate-900 text-lg tracking-tight">Creating in Jira…</p>
                <p className="text-sm font-medium text-slate-500 max-w-[200px] mx-auto leading-relaxed">Setting up the story, description and acceptance criteria</p>
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
              <div className="w-16 h-16 rounded-2xl bg-emerald-50 border border-emerald-200 flex items-center justify-center shadow-inner shadow-emerald-500/10">
                <CheckCircle className="w-8 h-8 text-emerald-600" />
              </div>
              <div className="text-center">
                <p className="font-black text-slate-900 text-xl tracking-tight">Created Successfully!</p>
                <p className="text-sm font-medium text-slate-500 mt-2">Jira issue <span className="font-mono font-bold text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded">{result.key}</span> is ready</p>
              </div>

              <div className="w-full bg-slate-50 border border-slate-200 rounded-2xl p-5 text-sm space-y-3 shadow-inner">
                <div className="flex justify-between items-center pb-3 border-b border-slate-200">
                  <span className="text-slate-500 font-semibold">Issue Key</span>
                  <button
                    onClick={() => result.url ? router.navigate(result.url) : null}
                    className="font-mono font-bold text-blue-700 hover:text-blue-800 transition"
                  >
                    {result.key}
                  </button>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-slate-500 font-semibold">Project</span>
                  <span className="font-bold text-slate-900">{projectKey}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-slate-500 font-semibold">Type</span>
                  <span className="font-bold text-slate-900">{issueType}</span>
                </div>
                {originIssueKey && (
                  <div className="pt-3 border-t border-slate-200 mt-1">
                    {result?.linkedTo ? (
                      <div className="flex justify-between items-center">
                        <span className="text-slate-500 font-semibold">Linked to</span>
                        <span className="font-mono font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-md border border-indigo-100">{result.linkedTo}</span>
                      </div>
                    ) : (
                      <div className="text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
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
                  className="flex items-center justify-center gap-2 w-full py-3 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-xl text-sm font-bold transition border border-blue-200"
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
              <div className="w-16 h-16 rounded-2xl bg-rose-50 border border-rose-200 flex items-center justify-center shadow-inner shadow-rose-500/10">
                <AlertCircle className="w-8 h-8 text-rose-600" />
              </div>
              <div className="text-center space-y-2">
                <p className="font-black text-slate-900 text-lg">Creation Failed</p>
                <div className="bg-rose-50 border border-rose-100 rounded-xl p-3 max-w-sm">
                  <p className="text-xs font-medium text-rose-700 leading-relaxed">{error}</p>
                </div>
              </div>
              <button
                onClick={() => setState('form')}
                className="mt-2 px-6 py-2.5 text-sm font-bold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 hover:text-slate-900 rounded-xl transition shadow-sm"
              >
                Try Again
              </button>
            </motion.div>
          )}
        </div>

        {/* Footer */}
        {state === 'form' && (
          <div className="px-6 py-5 border-t border-slate-100 flex items-center justify-end gap-3 bg-slate-50/50">
            <button onClick={onClose} className="px-5 py-2.5 text-sm font-bold text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 rounded-xl transition shadow-sm">
              Cancel
            </button>
            <motion.button
              onClick={handleCreate}
              disabled={!projectKey}
              className="px-6 py-2.5 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:bg-slate-400 rounded-xl transition shadow-md shadow-blue-600/20"
              whileTap={{ scale: 0.98 }}
            >
              Create in Jira
            </motion.button>
          </div>
        )}
        {state === 'success' && result && (
          <div className="px-6 py-5 border-t border-slate-100 flex justify-end bg-slate-50/50">
            <motion.button 
              onClick={() => { onCreate(result); onClose(); }} 
              className="px-8 py-2.5 text-sm font-bold text-white bg-slate-900 hover:bg-black rounded-xl transition shadow-md"
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
