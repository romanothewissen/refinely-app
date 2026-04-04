import re

with open('src/frontend/src/SettingsView.tsx', 'r') as f:
    content = f.read()

state_additions = """
  const [issueTypes, setIssueTypes] = useState<any[]>([]);
  const [activeIssueType, setActiveIssueType] = useState<string>('*');
  const [isLoadingIssueTypes, setIsLoadingIssueTypes] = useState(false);

  useEffect(() => {
    let active = true;
    if (!activeArProj || activeArProj === '*') {
      setIssueTypes([]);
      setActiveIssueType('*');
      return;
    }
    setIsLoadingIssueTypes(true);
    api.discoverIssueTypes(activeArProj)
       .then((res: any) => {
         if(active) {
           setIssueTypes(res.issueTypes || []);
         }
       })
       .finally(() => { if(active) setIsLoadingIssueTypes(false); });
    return () => { active = false; };
  }, [activeArProj]);

  const currentMapping = useMemo(() => {
    const existing = arMappings.find((m: any) => m.projectKey === activeArProj && ((m.issueType || '*') === activeIssueType));
    if (existing) return normalizeProjectArMapping(existing);
    
    const fallback = arMappings.find((m: any) => m.projectKey === activeArProj && (!m.issueType || m.issueType === '*'));
    return normalizeProjectArMapping({ ...(fallback || {}), projectKey: activeArProj, issueType: activeIssueType });
  }, [arMappings, activeArProj, activeIssueType]);

  const updateMapping = (p: any) => {
    const idx = arMappings.findIndex((m: any) => m.projectKey === activeArProj && ((m.issueType || '*') === activeIssueType));
    const upd = normalizeProjectArMapping({ ...currentMapping, ...p, projectKey: activeArProj, issueType: activeIssueType });
    if (idx >= 0) { const l = [...arMappings]; l[idx] = upd; setArMappings(l); }
    else setArMappings([...arMappings, upd]);
  };

  const projectFields = useMemo(() => {
    if (activeIssueType === '*') {
      const seen = new Set<string>();
      const all: any[] = [];
      issueTypes.forEach(it => {
        Object.values(it.fields || {}).forEach((f: any) => {
          if (!seen.has(f.id)) { seen.add(f.id); all.push(f); }
        });
      });
      return all.length > 0 ? all : customFields;
    } else {
      const it = issueTypes.find(t => t.id === activeIssueType);
      if (!it || !it.fields) return customFields;
      return Object.entries(it.fields).map(([key, val]: any) => ({
        id: key,
        name: val.name,
        custom: val.custom
      }));
    }
  }, [issueTypes, activeIssueType, customFields]);
"""

# Replace currentMapping / updateMapping block safely
old_block = """  const currentMapping = useMemo(() => {
    const existing = arMappings.find((m: any) => m.projectKey === activeArProj);
    return normalizeProjectArMapping(existing || { projectKey: activeArProj });
  }, [arMappings, activeArProj]);"""

# Replace this exact section, plus updateMapping but not context:
def replacer(m):
    return state_additions.strip() + "\n"

# Only replace definitions of currentMapping and updateMapping
content = content.replace(old_block, state_additions.strip())

# The original updateMapping:
old_update = """  const updateMapping = (p: any) => {
    const idx = arMappings.findIndex((m: any) => m.projectKey === activeArProj);
    const upd = normalizeProjectArMapping({ ...currentMapping, ...p, projectKey: activeArProj });
    if (idx >= 0) { const l = [...arMappings]; l[idx] = upd; setArMappings(l); }
    else setArMappings([...arMappings, upd]);
  };"""

content = content.replace(old_update, "")

ui_injection = """
                 <div className="flex flex-wrap items-center gap-3 mt-4">
                    <span className="text-[13px] font-bold text-[var(--rf-text)] pr-2">Issue Type Mapping:</span>
                    <div className="relative">
                      <select 
                        value={activeIssueType}
                        onChange={e => setActiveIssueType(e.target.value)}
                        className="appearance-none bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-lg text-[13px] font-semibold pl-3 pr-8 py-1.5 focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] outline-none"
                      >
                        <option value="*">General (All Types)</option>
                        {issueTypes.map((it: any) => (
                          <option key={it.id} value={it.id}>{it.name}</option>
                        ))}
                      </select>
                      <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--rf-text-tertiary)] pointer-events-none" />
                    </div>
                    {isLoadingIssueTypes && <span className="text-xs text-[var(--rf-text-tertiary)] ml-2">Loading types...</span>}
                  </div>

                 <div className="mt-4 grid grid-cols-1 gap-4">
                   <FieldMappingEditor
"""

content = content.replace('<div className="mt-4 grid grid-cols-1 gap-4">\n                   <FieldMappingEditor', ui_injection)
content = content.replace('customFields={customFields}\n                   />', 'customFields={projectFields}\n                   />')

with open('src/frontend/src/SettingsView.tsx', 'w') as f:
    f.write(content)

