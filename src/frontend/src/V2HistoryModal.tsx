import React from 'react';
import { Clock, Play, Trash2, X } from 'lucide-react';
import { motion } from 'framer-motion';

export interface V2HistoryEntry {
  sessionId: string;
  title: string;
  requirement: string;
  status: string;
  updatedAt: string;
}

export function V2HistoryModal({
  onClose,
  onRestore,
  onDelete,
  conversations,
  currentSessionId,
}: {
  onClose: () => void;
  onRestore: (sessionId: string) => Promise<void> | void;
  onDelete: (sessionId: string) => Promise<void> | void;
  conversations: V2HistoryEntry[];
  currentSessionId: string;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      <motion.div
        className="absolute inset-0 bg-[rgba(30,40,35,0.35)] backdrop-blur-md"
        onClick={onClose}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      />
      <motion.div
        className="relative rf-glass-card w-full max-w-4xl h-[80vh] flex flex-col overflow-hidden"
        initial={{ opacity: 0, scale: 0.96, y: 18 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 18 }}
        transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="px-5 py-4 border-b border-[var(--rf-border-subtle)] flex items-center justify-between gap-4 bg-white/55 backdrop-blur-xl">
          <div>
            <h2 className="text-lg font-bold text-[var(--rf-text)] tracking-tight">V2 Sessions</h2>
            <p className="mt-1 text-xs font-medium text-[var(--rf-text-tertiary)]">Resume or remove recent scope refinement runs.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-xl text-[var(--rf-text-tertiary)] hover:bg-white/60 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar p-4 sm:p-5">
          {conversations.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center gap-3 text-[var(--rf-text-tertiary)]">
              <Clock className="w-8 h-8 text-[var(--rf-border-strong)]" />
              <p className="text-sm font-medium">No V2 sessions yet.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {conversations.map((conversation) => {
                const isCurrent = conversation.sessionId === currentSessionId;
                return (
                  <div
                    key={conversation.sessionId}
                    className={`rounded-[20px] border p-4 flex flex-col gap-3 backdrop-blur-sm ${
                      isCurrent
                        ? 'border-[var(--rf-brand)] bg-white/86 shadow-[0_4px_20px_-4px_rgba(43,89,74,0.14)]'
                        : 'border-[var(--rf-border)] bg-white/78'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-[var(--rf-text)] leading-snug">
                          {conversation.title || 'Untitled V2 session'}
                        </div>
                        <div className="mt-1 text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--rf-text-tertiary)]">
                          {conversation.status.replace(/_/g, ' ')}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void onDelete(conversation.sessionId)}
                        className="p-1.5 rounded-lg text-[var(--rf-text-tertiary)] hover:text-[var(--rf-danger)] hover:bg-[var(--rf-danger-subtle)] transition-colors"
                        title="Delete session"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>

                    <div className="text-xs leading-5 text-[var(--rf-text-secondary)] line-clamp-4">
                      {conversation.requirement.replace(/\s+/g, ' ').trim()}
                    </div>

                    <div className="mt-auto flex items-center justify-between gap-3 pt-1">
                      <span className="text-xs font-medium text-[var(--rf-text-tertiary)]">
                        {new Date(conversation.updatedAt).toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                      </span>
                      <button
                        type="button"
                        onClick={() => void onRestore(conversation.sessionId)}
                        className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-bold transition ${
                          isCurrent
                            ? 'bg-[var(--rf-brand-subtle)] text-[var(--rf-brand)]'
                            : 'bg-[var(--rf-brand)] text-white hover:bg-[var(--rf-brand-hover)]'
                        }`}
                      >
                        <Play className="w-3 h-3" />
                        {isCurrent ? 'Active now' : 'Resume'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
}
