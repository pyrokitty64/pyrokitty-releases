import React, { useState, useEffect } from 'react';
import { ipcRenderer } from 'electron';
import { MantineProvider, Alert } from '@mantine/core';
import { theme } from './theme';
import { useGrids, useAccounts, useViewers } from './hooks';
import { AccountList } from './components/AccountList';
import { LoginForm } from './components/LoginForm';
import { Welcome } from './components/Welcome';
import { ConfirmDialog } from './components/ConfirmDialog';
import { MfaModal } from './components/MfaModal';
import { ChatWindow } from './components/ChatWindow';
import { Account, IPC_CHANNELS } from '../shared/types';

type View = 'account' | 'add-account';

export const App: React.FC = () => {
  const { grids } = useGrids();
  const { accounts, addAccount, updateAccount, removeAccount, getAccount } = useAccounts();
  const { instances, launchViewer, launchFirestormForInstance, launchGodotViewerForInstance, launchUnrealViewerForInstance, stopViewer, getInstanceForAccount, isRunning } = useViewers();

  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [currentView, setCurrentView] = useState<View>('account');
  const [error, setError] = useState<string | null>(null);
  const [confirmRemoveOpen, setConfirmRemoveOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mfaState, setMfaState] = useState<{ instanceId: string } | null>(null);

  // Listen for MFA challenges from main process
  useEffect(() => {
    const handler = (_event: any, data: { instanceId: string }) => {
      setMfaState({ instanceId: data.instanceId });
    };
    ipcRenderer.on(IPC_CHANNELS.MFA_REQUIRED, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.MFA_REQUIRED, handler);
    };
  }, []);

  const handleMfaSubmit = async (token: string, remember: boolean) => {
    if (!mfaState) return;
    await ipcRenderer.invoke(IPC_CHANNELS.MFA_SUBMIT, mfaState.instanceId, token, remember);
    setMfaState(null);
  };

  const selectedAccount = getAccount(selectedAccountId || '') || null;
  const selectedInstance = getInstanceForAccount(selectedAccountId || '') || null;
  const activeInstanceId = selectedInstance?.id || null;

  // Sync selected account to map window for teleport targeting
  useEffect(() => {
    ipcRenderer.send(IPC_CHANNELS.MAP_SELECTED_ACCOUNT, activeInstanceId);
  }, [activeInstanceId]);

  const handleSelectAccount = (accountId: string) => {
    setSelectedAccountId(accountId);
    setCurrentView('account');
    setError(null);
  };

  const handleAddAccount = () => {
    setCurrentView('add-account');
    setSelectedAccountId(null);
    setError(null);
  };

  const handleSaveAccount = async (gridId: string, firstName: string, lastName: string, password: string, savePassword: boolean) => {
    try {
      const newAccount = await addAccount(gridId, firstName, lastName, password, savePassword);
      setSelectedAccountId(newAccount.id);
      setCurrentView('account');
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Failed to save account');
    }
  };

  const handleRemoveAccount = () => {
    if (!selectedAccountId) return;
    setConfirmRemoveOpen(true);
  };

  const confirmRemoveAccount = async () => {
    if (!selectedAccountId) return;
    try {
      await removeAccount(selectedAccountId);
      setSelectedAccountId(null);
    } catch (err: any) {
      setError(err.message || 'Failed to remove account');
    }
  };

  // Login to metaverse only (no viewer launch)
  const handleLogin = async (password?: string, startLocation?: string, regionName?: string, startLocationType?: 'last' | 'home' | 'custom') => {
    if (!selectedAccountId) return;

    try {
      const updates: Partial<Account> = {};
      if (password) updates.password = password;
      if (regionName !== undefined) updates.lastRegion = regionName || undefined;
      if (startLocationType) updates.startLocationType = startLocationType;
      if (Object.keys(updates).length > 0) await updateAccount(selectedAccountId, updates);

      await launchViewer(selectedAccountId, password, { startLocation });
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Failed to login');
    }
  };

  const handleStopViewer = async (instanceId?: string) => {
    const id = instanceId || selectedInstance?.id;
    if (!id) return;

    try {
      await stopViewer(id);
    } catch (err: any) {
      setError(err.message || 'Failed to stop viewer');
    }
  };

  // Determine if we should show chat panel
  const connectionState = selectedInstance?.connectionState || 'disconnected';
  const canShowChat = selectedInstance && ['metaverse_connected', 'viewer_connected', 'logging_in', 'handoff_in_progress', 'mfa_pending'].includes(connectionState);

  return (
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <div className="app">
        <header className="header">
          <h1>PyroKitty</h1>
          <div className="header-actions">
            <button
              className="header-btn"
              onClick={() => ipcRenderer.invoke(IPC_CHANNELS.MAP_OPEN)}
              title="Open World Map"
            >
              Map
            </button>
            <span className="header-info">
              {instances.filter(isRunning).length} account(s) connected
            </span>
          </div>
        </header>

        <div className="main-content">
          <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
            <div className="sidebar-content">
              <AccountList
                accounts={accounts}
                grids={grids}
                instances={instances}
                selectedAccountId={selectedAccountId}
                onSelectAccount={handleSelectAccount}
                onAddAccount={handleAddAccount}
                onStopInstance={handleStopViewer}
                onLoginAccount={(accountId) => launchViewer(accountId)}
                onLaunchFirestorm={launchFirestormForInstance}
                onLaunchGodotViewer={launchGodotViewerForInstance}
                onLaunchUnrealViewer={launchUnrealViewerForInstance}
              />
            </div>
          </aside>
          <button
            className="sidebar-toggle"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            title={sidebarCollapsed ? 'Show accounts' : 'Hide accounts'}
          >
            {sidebarCollapsed ? '\u25B6' : '\u25C0'}
          </button>

          <main className="content">
            {error && <Alert color="red" mb="md">{error}</Alert>}
            {selectedInstance?.statusMessage && <Alert color="orange" mb="md">{selectedInstance.statusMessage}</Alert>}

            {currentView === 'add-account' ? (
              <LoginForm
                key="add-account"
                grids={grids}
                onSubmit={handleSaveAccount}
                onCancel={() => setCurrentView('account')}
                error={null}
              />
            ) : selectedAccount && canShowChat ? (
              <ChatWindow
                instanceId={activeInstanceId}
                connectionState={connectionState}
              />
            ) : selectedAccount ? (
              <LoginForm
                key={selectedAccount.id}
                grids={grids}
                account={selectedAccount}
                onLogin={handleLogin}
                onCancel={() => setSelectedAccountId(null)}
                onRemove={handleRemoveAccount}
                error={null}
              />
            ) : (
              <Welcome />
            )}
          </main>
        </div>
      </div>

      <ConfirmDialog
        opened={confirmRemoveOpen}
        onClose={() => setConfirmRemoveOpen(false)}
        onConfirm={confirmRemoveAccount}
        title="Remove Account"
        message="Are you sure you want to remove this account?"
        confirmLabel="Remove"
      />

      <MfaModal
        opened={mfaState !== null}
        onClose={() => setMfaState(null)}
        onSubmit={handleMfaSubmit}
        accountName={selectedAccount ? `${selectedAccount.firstName} ${selectedAccount.lastName}` : undefined}
      />
    </MantineProvider>
  );
};
