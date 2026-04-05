import re

with open('src/frontend/src/SettingsView.tsx', 'r') as f:
    content = f.read()

# 1. Update settingsNav and sidebar buttons
content = content.replace(
    """    ...(showComplianceTab ? [{ id: 'compliance', label: 'Compliance', icon: ShieldCheck, sub: 'Reports and audit trail' }] : []),""",
    """    ...(showComplianceTab ? [{ id: 'compliance', label: 'Compliance', icon: ShieldCheck, sub: 'Coming Soon' }] : []),"""
)

old_nav_button = """            {settingsNav.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg transition-all ${
                  activeTab === tab.id
                    ? 'bg-white/90 text-[var(--rf-brand)] shadow-sm border border-[rgba(43,89,74,0.10)]'
                    : 'text-[var(--rf-text-tertiary)] border border-transparent hover:bg-white/50 hover:text-[var(--rf-text-secondary)]'
                }`}
              >
                <tab.icon className={`w-3.5 h-3.5 shrink-0 ${activeTab === tab.id ? 'text-[var(--rf-brand)]' : 'text-[var(--rf-text-tertiary)]'}`} />
                <span className={`text-[13px] font-semibold leading-tight ${activeTab === tab.id ? 'text-[var(--rf-brand-hover)]' : 'text-[var(--rf-text-secondary)]'}`}>{tab.label}</span>
              </button>
            ))}"""

new_nav_button = """            {settingsNav.map((tab) => (
              <button
                key={tab.id}
                disabled={tab.id === 'compliance'}
                onClick={() => setActiveTab(tab.id as any)}
                className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg transition-all ${
                  activeTab === tab.id
                    ? 'bg-white/90 text-[var(--rf-brand)] shadow-sm border border-[rgba(43,89,74,0.10)]'
                    : 'text-[var(--rf-text-tertiary)] border border-transparent hover:bg-white/50 hover:text-[var(--rf-text-secondary)]'
                } ${tab.id === 'compliance' ? 'opacity-50 cursor-not-allowed filter grayscale' : ''}`}
              >
                <tab.icon className={`w-3.5 h-3.5 shrink-0 ${activeTab === tab.id ? 'text-[var(--rf-brand)]' : 'text-[var(--rf-text-tertiary)]'}`} />
                <div className="flex flex-col text-left">
                  <span className={`text-[13px] font-semibold leading-tight ${activeTab === tab.id ? 'text-[var(--rf-brand-hover)]' : 'text-[var(--rf-text-secondary)]'}`}>{tab.label}</span>
                  {tab.id === 'compliance' && <span className="text-[10px] font-bold text-[var(--rf-brand)] uppercase tracking-tighter mt-0.5">Coming Soon</span>}
                </div>
              </button>
            ))}"""

content = content.replace(old_nav_button, new_nav_button)

# 2. Add Save buttons to header for Jira
header_actions_old = """        <div className="flex items-center gap-3">
          {isAdmin && activeTab !== 'jira' && activeTab !== 'compliance' && ("""

header_actions_new = """        <div className="flex items-center gap-3">
          {isAdmin && activeTab === 'jira' && activeArProj !== '*' && (
            <div className="flex items-center gap-2">
              <motion.button
                onClick={() => document.getElementById('jira-save-target')?.click()}
                className="bg-white border border-[var(--rf-border)] text-[var(--rf-text-secondary)] hover:bg-[var(--rf-surface-soft)] text-[13px] font-bold px-4 py-1.5 rounded-lg shadow-sm transition-all flex items-center gap-2"
                whileTap={{ scale: 0.98 }}
              >
                <Save className="w-3.5 h-3.5" /> Save
              </motion.button>
              <motion.button
                onClick={() => document.getElementById('jira-save-rebuild-target')?.click()}
                className="bg-[var(--rf-text)] hover:bg-black text-white text-[13px] font-bold px-4 py-1.5 rounded-lg shadow-sm transition-all flex items-center gap-2"
                whileTap={{ scale: 0.98 }}
              >
                <RefreshCw className="w-3.5 h-3.5" /> Save & Rebuild
              </motion.button>
            </div>
          )}
          {isAdmin && activeTab !== 'jira' && activeTab !== 'compliance' && ("""

content = content.replace(header_actions_old, header_actions_new)

# 3. Compliance Gating Overlay
old_compliance_card = """                <div className="rf-card p-4 space-y-3">
                  <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Compliance</div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {[
                      { key: 'enabled', label: 'Compliance mode', value: complianceEnabled, set: setComplianceEnabled },
                      { key: 'transparency', label: 'Transparency reports', value: transparencyEnabled, set: setTransparencyEnabled },
                      { key: 'pii', label: 'PII masking', value: piiMaskingEnabled, set: setPiiMaskingEnabled },
                      { key: 'audit', label: 'Immutable audit trail', value: auditTrailEnabled, set: setAuditTrailEnabled },
                    ].map(item => (
                      <label key={item.key} className="flex items-center justify-between rounded-lg border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-3 py-2.5 cursor-pointer hover:bg-white transition">
                        <span className="text-sm font-medium text-[var(--rf-text-secondary)]">{item.label}</span>
                        <input
                          type="checkbox"
                          checked={item.value}
                          onChange={(e) => item.set(e.target.checked)}
                          disabled={!isAdmin}
                          className="h-4 w-4 rounded border-[var(--rf-border-strong)] text-[var(--rf-brand)] focus:ring-[var(--rf-brand)]"
                        />
                      </label>
                    ))}
                  </div>
                </div>"""

new_compliance_card = """                <div className="rf-card p-4 space-y-3 relative overflow-hidden group">
                  <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Compliance</div>
                   
                  {/* Gating Overlay */}
                  <div className="absolute inset-0 z-20 bg-[var(--rf-surface-soft)]/60 backdrop-blur-[1px] flex flex-col items-center justify-center p-6 text-center transition-all group-hover:bg-[var(--rf-surface-soft)]/80 cursor-not-allowed">
                    <div className="w-10 h-10 rounded-full bg-white flex items-center justify-center shadow-lg mb-3 border border-[var(--rf-border)]">
                      <ShieldCheck className="w-5 h-5 text-[var(--rf-brand)]" />
                    </div>
                    <div className="text-sm font-bold text-[var(--rf-text)]">Compliance controls</div>
                    <div className="text-[11px] font-bold text-[var(--rf-brand)] uppercase tracking-wider mt-1 bg-[var(--rf-brand-muted)] px-2 py-0.5 rounded border border-[rgba(43,89,74,0.1)]">Available in Advanced Edition</div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 opacity-20 pointer-events-none filter blur-[1px]">
                    {[
                      { key: 'enabled', label: 'Compliance mode', value: complianceEnabled, set: setComplianceEnabled },
                      { key: 'transparency', label: 'Transparency reports', value: transparencyEnabled, set: setTransparencyEnabled },
                      { key: 'pii', label: 'PII masking', value: piiMaskingEnabled, set: setPiiMaskingEnabled },
                      { key: 'audit', label: 'Immutable audit trail', value: auditTrailEnabled, set: setAuditTrailEnabled },
                    ].map(item => (
                      <label key={item.key} className="flex items-center justify-between rounded-lg border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-3 py-2.5">
                        <span className="text-sm font-medium text-[var(--rf-text-secondary)]">{item.label}</span>
                        <input
                          type="checkbox"
                          checked={item.value}
                          readOnly
                          className="h-4 w-4 rounded border-[var(--rf-border-strong)] text-[var(--rf-brand)] focus:ring-[var(--rf-brand)]"
                        />
                      </label>
                    ))}
                  </div>
                </div>"""

content = content.replace(old_compliance_card, new_compliance_card)

# 4. Hide original Jira Save buttons and add click targets
old_project_header = """      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-t border-[var(--rf-border)] pt-6">
        <div>
          <div className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-brand)] mb-1">Editing Project</div>
          <h4 className="text-xl font-bold text-[var(--rf-text)]">{activeArProj} Configuration</h4>
        </div>
        {isProjectAdmin && (
          <div className="flex flex-wrap gap-2">
            <motion.button 
              onClick={handleSave} 
              disabled={isSavingProject || isRefreshingBacklogCache} 
              className="bg-white border border-[var(--rf-border)] hover:bg-[var(--rf-surface-soft)] text-[13px] font-bold uppercase tracking-widest px-4 py-2.5 rounded-xl shadow-sm transition-all flex items-center gap-2 text-[var(--rf-text-secondary)]"
              whileTap={{ scale: 0.98 }}
            >
              {isSavingProject ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save
            </motion.button>
            <motion.button 
              onClick={handleSaveAndRefresh} 
              disabled={isSavingProject || isRefreshingBacklogCache} 
              className="bg-[var(--rf-text)] hover:bg-black text-white text-[13px] font-bold uppercase tracking-widest px-4 py-2.5 rounded-xl shadow-sm transition-all flex items-center gap-2"
              whileTap={{ scale: 0.98 }}
            >
              {(isSavingProject || isRefreshingBacklogCache) ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Save & Rebuild
            </motion.button>
          </div>
        )}
      </div>"""

new_project_header = """      <div style={{ display: 'none' }}>
        <button id="jira-save-target" onClick={handleSave} disabled={isSavingProject || isRefreshingBacklogCache} />
        <button id="jira-save-rebuild-target" onClick={handleSaveAndRefresh} disabled={isSavingProject || isRefreshingBacklogCache} />
      </div>"""

content = content.replace(old_project_header, new_project_header)

with open('src/frontend/src/SettingsView.tsx', 'w') as f:
    f.write(content)

