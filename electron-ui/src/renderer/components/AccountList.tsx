import React from 'react';
import { Text } from '@mantine/core';
import { Account, Grid, ViewerInstance } from '../../shared/types';
import { StatusIndicator, isInstanceRunning, isDisconnecting } from './StatusIndicator';

interface AccountListProps {
  accounts: Account[];
  grids: Grid[];
  instances: ViewerInstance[];
  selectedAccountId: string | null;
  onSelectAccount: (accountId: string) => void;
  onAddAccount: () => void;
  onStopInstance: (instanceId: string) => void;
  onLoginAccount: (accountId: string) => void;
  onLaunchFirestorm: (instanceId: string) => void;
  onLaunchGodotViewer: (instanceId: string, vrMode?: boolean) => void;
  onLaunchUnrealViewer: (instanceId: string) => void;
}

export const AccountList: React.FC<AccountListProps> = ({
  accounts,
  grids,
  instances,
  selectedAccountId,
  onSelectAccount,
  onAddAccount,
  onStopInstance,
  onLoginAccount,
  onLaunchFirestorm,
  onLaunchGodotViewer,
  onLaunchUnrealViewer,
}) => {
  const getInstanceForAccount = (accountId: string): ViewerInstance | undefined => {
    return instances.find((i) => i.accountId === accountId);
  };

  const getGridName = (gridId: string): string => {
    return grids.find((g) => g.id === gridId)?.name || 'Unknown Grid';
  };

  return (
    <div className="account-list-container">
      <h2>Accounts</h2>
      <div className="account-list">
        {accounts.length === 0 ? (
          <Text c="dimmed" ta="center" py="xl">No accounts yet</Text>
        ) : (
          accounts.map((account) => {
            const instance = getInstanceForAccount(account.id);
            const running = isInstanceRunning(instance);
            const stopping = isDisconnecting(instance);

            const isMetaverseOnly = instance?.connectionState === 'metaverse_connected';
            const canLaunchViewer = isMetaverseOnly && !!instance?.regionName && !stopping;

            return (
              <div
                key={account.id}
                className={`account-item ${selectedAccountId === account.id ? 'selected' : ''} ${running ? 'running' : ''}`}
                onClick={() => onSelectAccount(account.id)}
              >
                <div className="account-name">
                  {account.firstName} {account.lastName}
                </div>
                <div className="account-grid">
                  {getGridName(account.gridId)}
                </div>
                <div className="account-status-row">
                  <StatusIndicator instance={instance} />
                  {running && instance ? (
                    <button
                      className="account-stop-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        onStopInstance(instance.id);
                      }}
                      disabled={stopping}
                      title={stopping ? 'Stopping...' : 'Logout'}
                    >
                      {stopping ? '...' : 'Logout'}
                    </button>
                  ) : !running && account.password ? (
                    <button
                      className="account-login-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectAccount(account.id);
                        onLoginAccount(account.id);
                      }}
                      title="Login"
                    >
                      Login
                    </button>
                  ) : null}
                </div>
                {instance?.regionName ? (
                  <div className="account-region">
                    {instance.regionName}
                  </div>
                ) : (
                  <div className="account-region offline">
                    {account.startLocationType === 'home' ? 'My Home'
                      : account.startLocationType === 'custom' && account.lastRegion ? account.lastRegion
                      : 'My Last Location'}
                  </div>
                )}
                {isMetaverseOnly && instance && selectedAccountId === account.id && (
                  <div className="account-viewer-buttons">
                    <button
                      className="account-launch-btn account-launch-unreal"
                      onClick={(e) => {
                        e.stopPropagation();
                        onLaunchUnrealViewer(instance.id);
                      }}
                      disabled={!canLaunchViewer}
                      title="Launch Unreal Engine 5 viewer"
                    >
                      {instance.unrealBridgeActive ? 'Stop Unreal' : 'Unreal'}
                    </button>
                    <button
                      className="account-launch-btn account-launch-godot"
                      onClick={(e) => {
                        e.stopPropagation();
                        onLaunchGodotViewer(instance.id);
                      }}
                      disabled={!canLaunchViewer}
                    >
                      {instance.godotBridgeActive ? 'Stop Godot' : 'Godot'}
                    </button>
                    <button
                      className="account-launch-btn account-launch-godot-vr"
                      onClick={(e) => {
                        e.stopPropagation();
                        onLaunchGodotViewer(instance.id, true);
                      }}
                      disabled={!canLaunchViewer}
                      title="Launch Godot viewer in VR mode (requires OpenXR headset)"
                    >
                      Godot VR
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
      <div className="add-account-btn" onClick={onAddAccount}>
        + Add Account
      </div>
    </div>
  );
};
