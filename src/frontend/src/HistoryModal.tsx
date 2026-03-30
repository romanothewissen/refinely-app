import React, { useState, useMemo } from 'react';
import { Search, X, Clock, Pin, MessageSquare, Trash2, Edit2, Play } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
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
    // Sort: pinned first, then by updatedAt desc
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
    if (window.confirm('Are you sure you want to delete this session?')) {
      await api.deleteConversation(id);
      await refreshHistory();
    }
  };

  const pinned = filtered.filter(f => f.isPinned);
  const recent = filtered.filter(f => !f.isPinned);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      <motion.div 
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" 
        onClick={onClose} 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      />

      <motion.div 
        className="relative bg-white w-full max-w-4xl h-[85vh] rounded-2xl shadow-2xl flex flex-col overflow-hidden border border-slate-200"
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      >
        {/* Header */}
        <div className="px-6 py-5 border-b border-slate-100 flex items-center gap-4 bg-white/80 backdrop-blur-md sticky top-0 z-20">
          <div className="flex-1">
            <h2 className="text-xl font-bold text-slate-900 tracking-tight">Past Conversations</h2>
            <p className="text-sm font-medium text-slate-500 mt-1">Review, rename, or resume your previous feature generation sessions.</p>
          </div>
          <motion.button 
            onClick={onClose} 
            className="p-2 hover:bg-slate-100 text-slate-500 rounded-xl transition"
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
          >
            <X className="w-5 h-5" />
          </motion.button>
        </div>

        {/* Search */}
        <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50 z-10">
          <div className="relative">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search sessions..."
              className="w-full bg-white border border-slate-200 rounded-xl pl-10 pr-4 py-3 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition shadow-sm"
            />
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto w-full custom-scrollbar bg-slate-50/50 p-6">
          {filtered.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-400 gap-4">
              <div className="w-16 h-16 rounded-2xl bg-white border border-slate-200 flex items-center justify-center shadow-sm">
                <MessageSquare className="w-8 h-8 text-slate-300" />
              </div>
              <p className="text-sm font-medium text-slate-500">No conversations found.</p>
            </div>
          ) : (
            <div className="max-w-3xl mx-auto space-y-8 pb-8">
              
              {/* Pinned Section */}
              {pinned.length > 0 && (
                <div className="space-y-4 fade-in">
                  <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2 mb-4">
                    <Pin className="w-4 h-4 text-blue-500 fill-blue-500" /> Pinned
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {pinned.map((conv, idx) => (
                      <motion.div
                        key={conv.sessionId}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: idx * 0.05 }}
                      >
                        <SessionCard 
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
                      </motion.div>
                    ))}
                  </div>
                </div>
              )}

              {/* Recent Section */}
              {recent.length > 0 && (
                <div className="space-y-4 fade-in">
                  <h3 className={`text-xs font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2 mb-4 ${pinned.length > 0 ? 'mt-8' : ''}`}>
                    <Clock className="w-4 h-4" /> Recent
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {recent.map((conv, idx) => (
                      <motion.div
                        key={conv.sessionId}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: (pinned.length + idx) * 0.05 }}
                      >
                        <SessionCard 
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
                      </motion.div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
}

function SessionCard({ conv, currentSessionId, editingId, editTitle, setEditTitle, onRestore, toggleBookmark, startEdit, saveEdit, cancelEdit, deleteConv }: any) {
  const isCurrent = conv.sessionId === currentSessionId;
  const isEditing = editingId === conv.sessionId;

  return (
    <motion.div 
      onClick={isEditing ? undefined : onRestore}
      className={`group relative bg-white border rounded-2xl p-5 flex flex-col gap-4 h-full ${
        isCurrent ? 'border-blue-400 shadow-md shadow-blue-500/10 bg-blue-50/30' : 'border-slate-200 hover:border-blue-300 hover:shadow-lg cursor-pointer'
      }`}
      whileHover={!isCurrent && !isEditing ? { y: -2, scale: 1.01 } : {}}
      transition={{ duration: 0.2 }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 overflow-hidden flex-1 mt-0.5">
          {isEditing ? (
            <form onSubmit={(e) => saveEdit(e, conv.sessionId)} className="flex items-center gap-2 flex-1 relative z-10" onClick={e => e.stopPropagation()}>
              <input
                autoFocus
                value={editTitle}
                onChange={e => setEditTitle(e.target.value)}
                className="flex-1 bg-white border border-blue-400 rounded-lg outline-none px-3 py-1.5 text-sm font-bold text-slate-900 w-full focus:ring-2 focus:ring-blue-500/20"
              />
              <button type="button" onClick={cancelEdit} className="text-xs font-semibold text-slate-500 hover:text-slate-700 bg-slate-100 hover:bg-slate-200 px-2 py-1.5 rounded-md transition">Cancel</button>
              <button type="submit" className="text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 px-2 py-1.5 rounded-md transition">Save</button>
            </form>
          ) : (
            <h4 className={`text-base font-bold truncate tracking-tight ${isCurrent ? 'text-blue-900' : 'text-slate-900'}`}>
              {conv.title || 'Untitled session'}
            </h4>
          )}
        </div>
        
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button 
            onClick={(e) => toggleBookmark(e, conv.sessionId, conv.isPinned)}
            title={conv.isPinned ? "Unpin" : "Pin"}
            className={`p-1.5 rounded-lg hover:bg-slate-100 transition-colors ${conv.isPinned ? 'text-blue-600 opacity-100' : 'text-slate-400 hover:text-blue-600'}`}
          >
            <Pin className={`w-4 h-4 ${conv.isPinned ? 'fill-current' : ''}`} />
          </button>
          {!isEditing && (
            <button onClick={(e) => startEdit(e, conv.sessionId, conv.title)} className="p-1.5 rounded-lg text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-colors">
              <Edit2 className="w-4 h-4" />
            </button>
          )}
          <button onClick={(e) => deleteConv(e, conv.sessionId)} className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors">
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
        {/* Force showing the pin if pinned even without hover */}
        {conv.isPinned && <div className="absolute top-5 right-5 group-hover:hidden"><Pin className="w-4 h-4 text-blue-500 fill-current" /></div>}
      </div>

      <div className="flex items-center justify-between mt-auto pt-2">
        <span className="text-xs font-medium text-slate-500">
          {new Date(conv.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
        </span>
        <div className={`flex items-center gap-1.5 text-[10px] font-bold tracking-widest uppercase px-3 py-1 rounded-lg transition-colors ${isCurrent ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-500 group-hover:bg-blue-600 group-hover:text-white'}`}>
          {isCurrent ? 'Active Now' : <><Play className="w-3 h-3" /> Resume</>}
        </div>
      </div>
    </motion.div>
  );
}
