import { useCallback, useEffect, useState } from 'react';
import { ipcRenderer } from 'electron';
import { Grid, GridAddOrUpdateResult, IPC_CHANNELS } from '../../shared/types';

export function useGrids() {
  const [grids, setGrids] = useState<Grid[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const data = await ipcRenderer.invoke(IPC_CHANNELS.GET_GRIDS);
    setGrids(data);
  }, []);

  useEffect(() => {
    const load = async () => {
      try {
        await refresh();
      } catch (err: any) {
        setError(err.message || 'Failed to load grids');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [refresh]);

  const getGrid = (id: string) => grids.find((g) => g.id === id);

  const addOrUpdateGrid = useCallback(async (loginUri: string): Promise<GridAddOrUpdateResult> => {
    const result: GridAddOrUpdateResult = await ipcRenderer.invoke(IPC_CHANNELS.GRIDS_ADD_OR_UPDATE, loginUri);
    if (result.grid) await refresh();
    return result;
  }, [refresh]);

  return { grids, loading, error, getGrid, addOrUpdateGrid };
}
