import React, { useState, useMemo } from 'react';
import { Search, X, Clock, Pin, MessageSquare, Trash2, Edit2, Play } from 'lucide-react';
import { motion } from 'framer-motion';
import { api } from './hooks/useForge';

interface HistoryModalProps {
  onClose: () => void;
  onRestore: (sessionId: string) => void;
  conversations: any[];
  currentSessionId: string;
  refreshHistory: () => Promise<void>;
}

export function HistoryModal({ onClose, onRestore, conversations, currentSessionId, refreshHistory }: HistoryModalProps) {
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');

  // Derived state
  const filtered = useMemo(() => {
    let list = conversations;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(c => (c.title || 'Untitled session').toLowerCase().includes(q));
    }
    return [...list].sort((a, b) => {
      if (a.isPinned && !b.isPinned) return -1;
      if (!a.isPinned && b.isPinned) return 1;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
  }, [conversations, search]);

  const toggleBookmark = async (e: React.MouseEvent, sid: string, isPinned: boolean) => {
    e.stopPropagation();
    await api.toggleBookmark(sid, !isPinned);
    await refreshHistory();
  };

  const startEdit = (e: React.MouseEvent, id: string, currTitle: string) => {
    e.stopPropagation();
    setEditingId(id);
    setEditTitle(currTitle || 'Untitled session');
  };

  const saveEdit = async (e: React.FormEvent | React.MouseEvent, id: string) => {
    e.stopPropagation();
    e.preventDefault();
    if (editTitle.trim()) {
      await api.renameConversation(id, editTitle.trim());
      await refreshHistory();
    }
    setEditingId(null);
  };

  const deleteConv = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (window.confirm('Delete session?')) {
      await api.deleteConversation(id);
      await refreshHistory();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <motion.div className="absolute inset-0 bg-slate-900/40 backdrop-blur-xs" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} />

      <motion.div 
        className="relative bg-white w-full max-w-2xl h-[80vh] rounded-xl shadow-2xl flex flex-col overflow-hidden border border-slate-200"
        initial={{ opacity: 0, scale: 0.98, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
      >
        {/* Header */}
        <div className="px-4 h-14 border-b border-slate-100 flex items-center justify-between bg-white sticky top-0 z-20">
          <div>
            <h2 className="text-sm font-bold text-slate-800 tracking-tight">Conversation History</h2>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-slate-100 text-slate-400 rounded-lg transition"><X className="w-4 h-4" /></button>
        </div>

        {/* Search */}
        <div className="px-4 py-2.5 border-b border-slate-50 bg-slate-50/50">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search sessions..."
              className="w-full bg-white border border-slate-200 rounded-lg pl-9 pr-3 py-1.5 text-xs font-medium focus:ring-1 focus:ring-blue-400 focus:border-blue-400 outline-none transition"
            />
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto w-full custom-scrollbar p-2">
          {filtered.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-400 gap-2">
              <MessageSquare className="w-8 h-8 opacity-20" />
              <p className="text-xs font-medium">No sessions found</p>
            </div>
          ) : (
            <div className="space-y-px">
              {filtered.map((conv, idx) => (
                <SessionRow 
                  key={conv.sessionId}
                  conv={conv} 
                  currentSessionId={currentSessionId}
                  editingId={editingId}
                  editTitle={editTitle}
                  setEditTitle={setEditTitle}
                  onRestore={() => { onRestore(conv.sessionId); onClose(); }}
                  toggleBookmark={toggleBookmark}
                  startEdit={startEdit}
                  saveEdit={saveEdit}
                  cancelEdit={(e: any) => { e.stopPropagation(); setEditingId(null); }}
                  deleteConv={deleteConv}
                />
              ))}
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
}

function SessionRow({ conv, currentSessionId, editingId, editTitle, setEditTitle, onRestore, toggleBookmark, startEdit, saveEdit, cancelEdit, deleteConv }: any) {
  const isCurrent = conv.sessionId === currentSessionId;
  const isEditing = editingId === conv.sessionId;

  return (
    <div 
      onClick={isEditing ? undefined : onRestore}
      className={`group relative px-3 py-2 rounded-lg flex items-center justify-between gap-3 transition-colors ${
        isCurrent ? 'bg-blue-50/50' : 'hover:bg-slate-50 cursor-pointer'
      }`}
    >
      <div className="flex items-center gap-3 overflow-hidden flex-1">
        <button 
          onClick={(e) => toggleBookmark(e, conv.sessionId, conv.isPinned)}
          className={`shrink-0 transition ${conv.isPinned ? 'text-blue-500' : 'text-slate-200 group-hover:text-slate-400'}`}
        >
          <Pin className={`w-3.5 h-3.5 ${conv.isPinned ? 'fill-current' : ''}`} />
        </button>

        <div className="min-w-0 flex-1">
          {isEditing ? (
            <form onSubmit={(e) => saveEdit(e, conv.sessionId)} className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
              <input
                autoFocus
                value={editTitle}
                onChange={e => setEditTitle(e.target.value)}
                className="flex-1 bg-white border border-blue-400 rounded-md outline-none px-2 py-1 text-xs font-bold text-slate-800"
              />
              <button type="submit" className="text-[10px] font-bold text-blue-600 hover:underline">Save</button>
            </form>
          ) : (
            <div className="flex items-center gap-2 overflow-hidden">
              <h4 className={`text-[13px] font-semibold truncate ${isCurrent ? 'text-blue-700' : 'text-slate-700'}`}>
                {conv.title || 'Untitled session'}
              </h4>
              {conv.lastTurnType && (
                <span className="shrink-0 text-[9px] font-bold uppercase tracking-wider text-slate-400 opacity-60">
                  {conv.lastTurnType}
                </span>
              )}
            </div>
          )}
          <div className="flex items-center gap-2 mt-0.5 text-[10px] text-slate-400 font-medium">
            <span>{new Date(conv.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
            {conv.lastFeatureCount > 0 && (
              <>
                <span className="opacity-40">·</span>
                <span>{conv.lastFeatureCount} feature{conv.lastFeatureCount !== 1 ? 's' : ''}</span>
              </>
            )}
            {isCurrent && <span className="text-blue-500 font-bold ml-1 uppercase text-[8px] tracking-widest bg-blue-100/50 px-1 rounded">Active</span>}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        {!isEditing && (
          <button onClick={(e) => startEdit(e, conv.sessionId, conv.title)} className="p-1 text-slate-400 hover:text-blue-500 rounded transition">
            <Edit2 className="w-3 h-3" />
          </button>
        )}
        <button onClick={(e) => deleteConv(e, conv.sessionId)} className="p-1 text-slate-400 hover:text-rose-500 rounded transition">
          <Trash2 className="w-3 h-3" />
        </button>
        <div className="ml-1 px-2 py-1 bg-slate-100 rounded text-[9px] font-bold text-slate-500 uppercase tracking-wider group-hover:bg-blue-600 group-hover:text-white transition">
          Resume
        </div>
      </div>
    </div>
  );
}
