import { useState, useEffect } from 'react';
import { ipcRenderer } from 'electron';
import { ViewerInstance, IPC_CHANNELS } from '../../shared/types';
import { isInstanceRunning } from '../components/StatusIndicator';

export function useViewers() {
  const [instances, setInstances] = useState<ViewerInstance[]>([]);

  // Load initial instances
  useEffect(() => {
    const load = async () => {
      const data = await ipcRenderer.invoke(IPC_CHANNELS.GET_INSTANCES);
      setInstances(data);
    };
    load();
  }, []);

  // Listen for status updates
  useEffect(() => {
    const handleStatusUpdate = (_: any, instance: ViewerInstance) => {
      setInstances((prev) => {
        // Remove instance if it's fully disconnected
        if (instance.connectionState === 'disconnected' && instance.status === 'disconnected') {
          return prev.filter((i) => i.id !== instance.id);
        }

        const index = prev.findIndex((i) => i.id === instance.id);
        if (index >= 0) {
          const updated = [...prev];
          updated[index] = instance;
          return updated;
        }
        return [...prev, instance];
      });
    };

    ipcRenderer.on(IPC_CHANNELS.VIEWER_STATUS_UPDATE, handleStatusUpdate);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.VIEWER_STATUS_UPDATE, handleStatusUpdate);
    };
  }, []);

  // Refresh instances periodically
  useEffect(() => {
    const interval = setInterval(async () => {
      const data: ViewerInstance[] = await ipcRenderer.invoke(IPC_CHANNELS.GET_INSTANCES);
      setInstances((prev) => {
        // Preserve 'disconnecting' state for instances being stopped
        // (they may have been removed from backend already)
        const disconnecting = prev.filter((i) => i.connectionState === 'disconnecting');
        const disconnectingIds = new Set(disconnecting.map((i) => i.id));

        // Merge: keep disconnecting instances, add/update others from backend
        const fromBackend = data.filter((i) => !disconnectingIds.has(i.id));
        return [...disconnecting, ...fromBackend];
      });
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const launchViewer = async (
    accountId: string,
    password?: string,
    options?: { startLocation?: string }
  ): Promise<ViewerInstance> => {
    const instance = await ipcRenderer.invoke(IPC_CHANNELS.LAUNCH_VIEWER, {
      accountId,
      password,
      startLocation: options?.startLocation,
    });
    // Only add if not already added via status-update event
    setInstances((prev) => {
      const exists = prev.some((i) => i.id === instance.id);
      return exists ? prev : [...prev, instance];
    });
    return instance;
  };

  const stopViewer = async (instanceId: string): Promise<void> => {
    // Optimistically update UI to show disconnecting state immediately
    setInstances((prev) =>
      prev.map((i) =>
        i.id === instanceId ? { ...i, connectionState: 'disconnecting' as const } : i
      )
    );
    await ipcRenderer.invoke(IPC_CHANNELS.STOP_VIEWER, instanceId);
  };

  const launchFirestormForInstance = async (instanceId: string): Promise<void> => {
    await ipcRenderer.invoke(IPC_CHANNELS.LAUNCH_FIRESTORM_FOR_INSTANCE, instanceId);
  };

  const launchGodotViewerForInstance = async (instanceId: string, vrMode = false): Promise<void> => {
    await ipcRenderer.invoke(IPC_CHANNELS.LAUNCH_GODOT_VIEWER_FOR_INSTANCE, instanceId, vrMode);
  };

  const launchUnrealViewerForInstance = async (instanceId: string): Promise<void> => {
    await ipcRenderer.invoke(IPC_CHANNELS.LAUNCH_UNREAL_VIEWER_FOR_INSTANCE, instanceId);
  };

  const getInstanceForAccount = (accountId: string) =>
    instances.find((i) => i.accountId === accountId);

  return {
    instances,
    launchViewer,
    launchFirestormForInstance,
    launchGodotViewerForInstance,
    launchUnrealViewerForInstance,
    stopViewer,
    getInstanceForAccount,
    isRunning: isInstanceRunning,
  };
}
