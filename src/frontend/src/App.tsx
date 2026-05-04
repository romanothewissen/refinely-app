import React, { useEffect, useState } from 'react';
import { view } from '@forge/bridge';
import QuickRefineApp, { type QuickRefineViewState } from './QuickRefineApp';
import V2WorkspaceApp from './V2WorkspaceApp';

function detectQuickRefineSurface(ctx: any): 'issue-panel' | 'issue-action' | null {
  const moduleKey = String(
    ctx?.moduleKey
    || ctx?.extension?.moduleKey
    || ctx?.localId
    || '',
  );

  if (moduleKey.includes('quick-refine-issue-panel')) return 'issue-panel';
  return null;
}

export default function App() {
  const [surface, setSurface] = useState<'issue-panel' | 'issue-action' | null>(null);
  const [ready, setReady] = useState(false);
  const [openWorkspaceApp, setOpenWorkspaceApp] = useState(false);
  const [launchMode, setLaunchMode] = useState<'generate' | 'settings'>('generate');
  const [settingsSurface, setSettingsSurface] = useState<'workspace' | 'project'>('workspace');
  const [settingsTab, setSettingsTab] = useState<'models' | 'jira' | 'domain' | 'compliance'>('models');
  const [prefillRequirement, setPrefillRequirement] = useState('');
  const [quickRefineViewState, setQuickRefineViewState] = useState<QuickRefineViewState | null>(null);
  const [returnToQuickRefine, setReturnToQuickRefine] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void view.getContext()
      .then((ctx: any) => {
        if (!cancelled) setSurface(detectQuickRefineSurface(ctx));
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) return <div className="h-full w-full" />;

  if (surface && !openWorkspaceApp) {
    return (
      <QuickRefineApp
        surface={surface}
        initialState={quickRefineViewState}
        onStateChange={setQuickRefineViewState}
        onOpenFullWorkflow={(prefillInstruction) => {
          setPrefillRequirement(String(prefillInstruction ?? '').trim());
          setLaunchMode('generate');
          setSettingsSurface('workspace');
          setSettingsTab('models');
          setReturnToQuickRefine(false);
          setOpenWorkspaceApp(true);
        }}
        onOpenSettings={() => {
          setLaunchMode('settings');
          setSettingsSurface('project');
          setSettingsTab('jira');
          setReturnToQuickRefine(true);
          setOpenWorkspaceApp(true);
        }}
      />
    );
  }

  return (
    <V2WorkspaceApp
      initialViewMode={launchMode}
      initialSettingsSurface={settingsSurface}
      initialSettingsTab={settingsTab}
      initialRequirement={prefillRequirement}
      onCloseSettings={returnToQuickRefine ? () => {
        setOpenWorkspaceApp(false);
        setReturnToQuickRefine(false);
      } : undefined}
    />
  );
}
