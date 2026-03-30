import React, { useState, useMemo } from 'react';
import { Search, X, Clock, Pin, MessageSquare, Trash2, Edit2, Play } from 'lucide-react';
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
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={onClose} />
      
      <div className="relative bg-white w-full max-w-4xl h-[85vh] rounded-2xl shadow-2xl flex flex-col overflow-hidden slide-up border border-slate-100">
        
        {/* Header */}
        <div className="px-6 py-5 border-b border-slate-100 flex items-center gap-4 bg-slate-50/50">
          <div className="flex-1">
            <h2 className="text-xl font-bold text-slate-800 tracking-tight">Past Conversations</h2>
            <p className="text-sm text-slate-500 mt-1">Review, rename, or resume your previous feature generation sessions.</p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-200 text-slate-500 rounded-xl transition">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Search */}
        <div className="px-6 py-4 border-b border-slate-100 bg-white shadow-sm z-10 sticky top-0">
          <div className="relative">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search sessions..."
              className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-10 pr-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition shadow-inner"
            />
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto w-full custom-scrollbar bg-slate-50/30 p-6">
          {filtered.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-400 gap-3">
              <MessageSquare className="w-12 h-12 opacity-20" />
              <p>No conversations found.</p>
            </div>
          ) : (
            <div className="max-w-3xl mx-auto space-y-8">
              
              {/* Pinned Section */}
              {pinned.length > 0 && (
                <div className="space-y-3 fade-in">
                  <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2 mb-4">
                    <Pin className="w-3.5 h-3.5 text-blue-500 fill-blue-500" /> Pinned
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {pinned.map(conv => (
                      <SessionCard 
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
                </div>
              )}

              {/* Recent Section */}
              {recent.length > 0 && (
                <div className="space-y-3 fade-in">
                  <h3 className={`text-xs font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2 mb-4 ${pinned.length > 0 ? 'mt-8' : ''}`}>
                    <Clock className="w-3.5 h-3.5" /> Recent
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {recent.map(conv => (
                      <SessionCard 
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
                </div>
              )}

            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SessionCard({ conv, currentSessionId, editingId, editTitle, setEditTitle, onRestore, toggleBookmark, startEdit, saveEdit, cancelEdit, deleteConv }: any) {
  const isCurrent = conv.sessionId === currentSessionId;
  const isEditing = editingId === conv.sessionId;

  return (
    <div 
      onClick={isEditing ? undefined : onRestore}
      className={`group relative bg-white border rounded-xl p-4 transition-all duration-200 flex flex-col gap-3 ${
        isCurrent ? 'border-blue-400 shadow-[0_0_0_1px_rgba(96,165,250,0.5)] bg-blue-50/30' : 'border-slate-200 hover:border-blue-300 hover:shadow-md cursor-pointer hover:-translate-y-0.5'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 overflow-hidden flex-1 mt-0.5">
          {isEditing ? (
            <form onSubmit={(e) => saveEdit(e, conv.sessionId)} className="flex items-center gap-2 flex-1 relative z-10" onClick={e => e.stopPropagation()}>
              <input
                autoFocus
                value={editTitle}
                onChange={e => setEditTitle(e.target.value)}
                className="flex-1 bg-white border border-blue-400 rounded outline-none px-2 py-1 text-sm font-semibold text-slate-800 w-full"
              />
              <button type="button" onClick={cancelEdit} className="text-xs text-slate-500 hover:underline">cancel</button>
              <button type="submit" className="text-xs text-blue-600 font-bold hover:underline">save</button>
            </form>
          ) : (
            <h4 className={`text-sm font-semibold truncate ${isCurrent ? 'text-blue-800' : 'text-slate-700'}`}>
              {conv.title || 'Untitled session'}
            </h4>
          )}
        </div>
        
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button 
            onClick={(e) => toggleBookmark(e, conv.sessionId, conv.isPinned)}
            title={conv.isPinned ? "Unpin" : "Pin"}
            className={`p-1.5 rounded-md hover:bg-slate-100 transition-colors ${conv.isPinned ? 'text-blue-500 opacity-100' : 'text-slate-400 hover:text-blue-500'}`}
          >
            <Pin className={`w-3.5 h-3.5 ${conv.isPinned ? 'fill-current' : ''}`} />
          </button>
          {!isEditing && (
            <button onClick={(e) => startEdit(e, conv.sessionId, conv.title)} className="p-1.5 rounded-md text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-colors">
              <Edit2 className="w-3.5 h-3.5" />
            </button>
          )}
          <button onClick={(e) => deleteConv(e, conv.sessionId)} className="p-1.5 rounded-md text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
        {/* Force showing the pin if pinned even without hover */}
        {conv.isPinned && <div className="absolute top-4 right-4 group-hover:hidden"><Pin className="w-3.5 h-3.5 text-blue-500 fill-current" /></div>}
      </div>

      <div className="flex items-center justify-between mt-auto">
        <span className="text-[11px] font-medium text-slate-400">
          {new Date(conv.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
        </span>
        <div className={`flex items-center gap-1.5 text-[11px] font-bold tracking-wide uppercase px-2 py-0.5 rounded-full ${isCurrent ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-500 group-hover:bg-blue-50 group-hover:text-blue-600 transition-colors'}`}>
          {isCurrent ? 'Active Now' : <><Play className="w-3 h-3" /> Resume</>}
        </div>
      </div>
    </div>
  );
}
