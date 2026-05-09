import React, { useState } from 'react';
import { TextInput, PasswordInput, NativeSelect, Checkbox, Button, Paper, Group, Title, Alert, Text } from '@mantine/core';
import { Grid, Account, GridAddOrUpdateResult } from '../../shared/types';

const ADD_NEW_GRID = '__add_new_grid__';

interface LoginFormProps {
  grids: Grid[];
  onSubmit?: (gridId: string, firstName: string, lastName: string, password: string, savePassword: boolean) => void;
  onLogin?: (password?: string, startLocation?: string, regionName?: string, startLocationType?: 'last' | 'home' | 'custom') => void;  // Login to metaverse
  onCancel: () => void;
  onRemove?: () => void;
  onAddOrUpdateGrid?: (loginUri: string) => Promise<GridAddOrUpdateResult>;
  error: string | null;
  account?: Account | null;  // Pre-populated account for login mode
}

type NewGridStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'ok'; status: 'added' | 'updated' | 'unchanged' | 'unchanged-stale'; message: string; gridId: string }
  | { kind: 'error'; message: string };

function statusMessageFor(result: GridAddOrUpdateResult): string {
  switch (result.status) {
    case 'added': return `Added "${result.grid?.name}"`;
    case 'updated': return `Updated "${result.grid?.name}"`;
    case 'unchanged': return `Already in your list ("${result.grid?.name}")`;
    case 'unchanged-stale': return `Already in your list ("${result.grid?.name}") — couldn't refresh${result.error ? `: ${result.error}` : ''}`;
    case 'invalid-url': return result.error || 'Invalid URL';
    case 'unreachable': return result.error || "Couldn't reach grid";
    case 'bad-response': return result.error || 'Bad response from grid';
  }
}

export const LoginForm: React.FC<LoginFormProps> = ({
  grids,
  onSubmit,
  onLogin,
  onCancel,
  onRemove,
  onAddOrUpdateGrid,
  error,
  account,
}) => {
  const isLaunchMode = !!account;
  const hasPassword = isLaunchMode && !!account.password;

  const defaultGridId = grids.find(g => g.nick === 'agni')?.id || grids[0]?.id || '';
  const [selectedGridId, setSelectedGridId] = useState(account?.gridId || defaultGridId);
  const [firstName, setFirstName] = useState(account?.firstName || '');
  const [lastName, setLastName] = useState(account?.lastName || 'Resident');
  const [password, setPassword] = useState(account?.password || '');
  const [savePassword, setSavePassword] = useState(false);
  const savedLocation = account?.lastRegion || '';
  const [startLocationType, setStartLocationType] = useState<'last' | 'home' | 'custom'>(account?.startLocationType || (savedLocation ? 'custom' : 'last'));
  const [customLocation, setCustomLocation] = useState(savedLocation);

  const [newGridUri, setNewGridUri] = useState('');
  const [newGridStatus, setNewGridStatus] = useState<NewGridStatus>({ kind: 'idle' });
  const isAddingGrid = selectedGridId === ADD_NEW_GRID;

  const handleCheckGrid = async () => {
    if (!onAddOrUpdateGrid) return;
    const trimmed = newGridUri.trim();
    if (!trimmed) return;
    setNewGridStatus({ kind: 'checking' });
    try {
      const result = await onAddOrUpdateGrid(trimmed);
      const message = statusMessageFor(result);
      if (result.grid) {
        setNewGridStatus({ kind: 'ok', status: result.status as any, message, gridId: result.grid.id });
        setSelectedGridId(result.grid.id);
      } else {
        setNewGridStatus({ kind: 'error', message });
      }
    } catch (e: any) {
      setNewGridStatus({ kind: 'error', message: e?.message || 'Failed to check grid' });
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Default action is login only (not launch viewer)
    if (isLaunchMode && onLogin) {
      let startLocation: string | undefined;
      if (startLocationType === 'home') {
        startLocation = 'home';
      } else if (startLocationType === 'custom' && customLocation.trim()) {
        startLocation = `uri:${customLocation.trim()}&128&128&0`;
      }
      // 'last' is the default, no need to pass it
      const regionName = startLocationType === 'custom' ? customLocation.trim() : undefined;
      onLogin(password || undefined, startLocation, regionName, startLocationType);
    } else if (onSubmit && selectedGridId && selectedGridId !== ADD_NEW_GRID && firstName.trim() && lastName.trim() && password) {
      onSubmit(selectedGridId, firstName.trim(), lastName.trim(), password, savePassword);
    }
  };

  const selectedGrid = grids.find(g => g.id === selectedGridId);
  const gridIsValid = !!selectedGridId && selectedGridId !== ADD_NEW_GRID;
  const canSubmit = isLaunchMode
    ? (hasPassword || password.length > 0)
    : (gridIsValid && firstName && lastName && password);

  const gridOptions = [
    ...grids.map((grid) => ({ value: grid.id, label: grid.name })),
    ...(onAddOrUpdateGrid ? [{ value: ADD_NEW_GRID, label: '+ Add new grid…' }] : []),
  ];

  const statusColor: Record<NewGridStatus['kind'], string> = {
    idle: 'dimmed',
    checking: 'dimmed',
    ok: 'teal',
    error: 'red',
  };

  return (
    <Paper bg="var(--mantine-color-dark-6)" radius="md" p="lg" mb="lg">
      <Title order={3} mb="md">{isLaunchMode ? 'Login' : 'Add Account'}</Title>

      {error && <Alert color="red" mb="md">{error}</Alert>}

      <form onSubmit={handleSubmit}>
        {isLaunchMode ? (
          <TextInput
            label="Grid"
            value={selectedGrid?.name || ''}
            disabled
            mb="md"
          />
        ) : (
          <NativeSelect
            label="Grid"
            value={selectedGridId}
            onChange={(e) => {
              const v = e.currentTarget.value;
              setSelectedGridId(v);
              setNewGridUri('');
              setNewGridStatus({ kind: 'idle' });
            }}
            data={gridOptions}
            required
            mb={isAddingGrid ? 'xs' : 'md'}
          />
        )}

        {!isLaunchMode && isAddingGrid && (
          <>
            <Group align="flex-end" gap="xs" mb="xs">
              <TextInput
                label="Login URI"
                placeholder="https://grid.example.com:8002/"
                value={newGridUri}
                onChange={(e) => setNewGridUri(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleCheckGrid();
                  }
                }}
                autoFocus
                style={{ flex: 1 }}
              />
              <Button
                onClick={handleCheckGrid}
                disabled={!newGridUri.trim() || newGridStatus.kind === 'checking'}
              >
                {newGridStatus.kind === 'checking' ? 'Checking…' : 'Check'}
              </Button>
            </Group>
            {newGridStatus.kind !== 'ok' && (
              <Text size="xs" c={statusColor[newGridStatus.kind]} mb="md">
                {newGridStatus.kind === 'idle' && 'Paste a grid login URI and click Check.'}
                {newGridStatus.kind === 'checking' && 'Checking…'}
                {newGridStatus.kind === 'error' && newGridStatus.message}
              </Text>
            )}
          </>
        )}

        {!isLaunchMode && newGridStatus.kind === 'ok' && (
          <Text size="xs" c="teal" mb="md">{newGridStatus.message}</Text>
        )}

        <Group grow mb="md">
          <TextInput
            label="First Name"
            value={firstName}
            onChange={(e) => setFirstName(e.currentTarget.value)}
            placeholder="First"
            required
            disabled={isLaunchMode}
          />
          <TextInput
            label="Last Name"
            value={lastName}
            onChange={(e) => setLastName(e.currentTarget.value)}
            placeholder="Last"
            required
            disabled={isLaunchMode}
          />
        </Group>

        <PasswordInput
          label="Password"
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
          placeholder={hasPassword ? 'Using saved password' : 'Password'}
          required={!hasPassword && password.length === 0}
          description={hasPassword && !password ? 'Leave blank to use saved password' : undefined}
          mb="md"
        />

        {isLaunchMode && (
          <>
            <NativeSelect
              label="Start Location"
              value={startLocationType}
              onChange={(e) => setStartLocationType(e.currentTarget.value as 'last' | 'home' | 'custom')}
              data={[
                { value: 'last', label: 'My Last Location' },
                { value: 'home', label: 'My Home' },
                { value: 'custom', label: 'Region Name...' },
              ]}
              mb="md"
            />
            {startLocationType === 'custom' && (
              <TextInput
                placeholder="Region Name"
                value={customLocation}
                onChange={(e) => setCustomLocation(e.currentTarget.value)}
                mb="md"
              />
            )}
          </>
        )}

        {!isLaunchMode && (
          <Checkbox
            label="Save password"
            checked={savePassword}
            onChange={(e) => setSavePassword(e.currentTarget.checked)}
            mb="md"
          />
        )}

        <Group mt="md">
          <Button type="submit" disabled={!canSubmit}>
            {isLaunchMode ? 'Login' : 'Save Account'}
          </Button>
          {isLaunchMode && onRemove && (
            <Button color="red" onClick={onRemove}>
              Remove
            </Button>
          )}
          {!isLaunchMode && (
            <Button variant="default" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </Group>
      </form>
    </Paper>
  );
};
