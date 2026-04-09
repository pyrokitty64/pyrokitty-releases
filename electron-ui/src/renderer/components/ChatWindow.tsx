import React, { useState, useCallback } from 'react';
import { ipcRenderer } from 'electron';
import { ChatPanel } from './ChatPanel';
import { MiniMap } from './MiniMap';
import { VoiceBar } from './VoiceBar';
import { ConnectionState, IPC_CHANNELS, displayName } from '../../shared/types';
import { useChat } from '../hooks/useChat';
import { useFriends } from '../hooks/useFriends';
import { useGroups } from '../hooks/useGroups';
import { useNearbyAvatars } from '../hooks/useNearbyAvatars';
import { useRegionInfo } from '../hooks/useRegionInfo';
import { useInventorySync } from '../hooks/useInventorySync';
import { useUserContextMenu } from '../hooks/useUserContextMenu';
import { useGroupContextMenu } from '../hooks/useGroupContextMenu';

type Tab = 'nearby' | 'messages' | 'groups';

interface ChatWindowProps {
  instanceId: string | null;
  connectionState: ConnectionState;
}

export const ChatWindow: React.FC<ChatWindowProps> = ({
  instanceId,
  connectionState,
}) => {
  const [activeTab, setActiveTab] = useState<Tab>('nearby');
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());

  const {
    nearbyMessages,
    sessions,
    activeSessionId,
    sendNearbyChat,
    sendIM,
    sendGroupMessage,
    startIMSession,
    startGroupChat,
    selectSession,
    getSessionMessages,
    dismissSession,
    clearSessionHistory,
  } = useChat({ instanceId });

  const { onlineFriends, offlineFriends } = useFriends({ instanceId });
  const { groups } = useGroups({ instanceId });
  const { nearbyAvatars } = useNearbyAvatars({ instanceId });
  const { regionInfo } = useRegionInfo({ instanceId });
  const { status: syncStatus, startSync, openFolder: openSyncFolder } = useInventorySync({ instanceId });

  const handleUserContextMenu = useUserContextMenu();
  const handleGroupContextMenu = useGroupContextMenu();

  const toggleSection = (section: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  };

  const handleTeleport = useCallback((x: number, y: number, z: number) => {
    if (instanceId) {
      ipcRenderer.invoke(IPC_CHANNELS.TELEPORT_LOCAL, instanceId, x, y, z);
    }
  }, [instanceId]);

  const isConnected = connectionState === 'metaverse_connected' || connectionState === 'viewer_connected';

  if (!isConnected) {
    return (
      <div className="chat-window disconnected">
        <div className="chat-disconnected-message">
          {connectionState === 'logging_in' ? 'Logging in...' :
           connectionState === 'handoff_in_progress' ? 'Connecting to viewer...' :
           'Not connected'}
        </div>
      </div>
    );
  }

  const imSessions = sessions.filter((s) => s.type === 'im');
  const groupSessions = sessions.filter((s) => s.type === 'group');

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const activeSessionMessages = activeSessionId ? getSessionMessages(activeSessionId) : [];

  const handleSendSessionMessage = (message: string) => {
    if (!activeSession) return;
    if (activeSession.type === 'im' && activeSession.participantId) {
      sendIM(activeSession.participantId, message);
    } else if (activeSession.type === 'group' && activeSession.groupId) {
      sendGroupMessage(activeSession.groupId, message);
    }
  };

  // Get IM session for a friend
  const getIMSessionForFriend = (friendId: string) => {
    return imSessions.find((s) => s.participantId === friendId);
  };

  // Get group session
  const getGroupSession = (groupId: string) => {
    return groupSessions.find((s) => s.groupId === groupId);
  };

  // Resolve session display name: prefer friend name by UUID, then session name
  const allFriends = [...onlineFriends, ...offlineFriends];
  const friendById = new Map(allFriends.map((f) => [f.id, f]));
  const sessionDisplayName = (s: { participantId?: string; name: string }): string => {
    const friend = s.participantId ? friendById.get(s.participantId) : undefined;
    return displayName(friend?.name || s.name);
  };

  // Shared friend list renderer
  const renderFriendList = (friends: typeof onlineFriends, statusClass: 'online' | 'offline') =>
    friends.map((friend) => {
      const session = getIMSessionForFriend(friend.id);
      const isActive = session?.id === activeSessionId;
      return (
        <div
          key={friend.id}
          className={`split-sidebar-item ${isActive ? 'active' : ''} ${session ? 'has-session' : ''}`}
          onClick={() => {
            if (session) {
              selectSession(session.id);
            } else {
              startIMSession(friend.id, friend.name);
            }
          }}
        >
          <span className={`friend-status-dot ${statusClass}`} />
          <span className="split-sidebar-name" onContextMenu={(e) => handleUserContextMenu(e, friend.id, friend.name)}>{displayName(friend.name) || friend.id}</span>
          {session && session.unreadCount > 0 && (
            <span className="split-sidebar-badge">{session.unreadCount}</span>
          )}
        </div>
      );
    });

  // Shared session chat area renderer
  const renderSessionChat = (sessionType: 'im' | 'group', emptyText: string) => (
    <div className="split-main" onClick={() => activeSessionId && selectSession(activeSessionId)}>
      {activeSession && activeSession.type === sessionType ? (
        <ChatPanel
          messages={activeSessionMessages}
          onSendMessage={handleSendSessionMessage}
          title={sessionDisplayName(activeSession)}
          placeholder={`Message ${sessionDisplayName(activeSession)}...`}
          onClear={() => clearSessionHistory(activeSession.id)}
        />
      ) : (
        <div className="split-main-empty">{emptyText}</div>
      )}
    </div>
  );

  // IM sessions with non-friends (recent chats from nearby avatars, etc.)
  const friendIds = new Set(allFriends.map((f) => f.id));
  const nonFriendSessions = imSessions
    .filter((s) => s.participantId && !friendIds.has(s.participantId))
    .sort((a, b) => (b.lastMessageTime || 0) - (a.lastMessageTime || 0));

  // Count unread for tabs
  const imUnread = imSessions.reduce((sum, s) => sum + s.unreadCount, 0);
  const groupUnread = groupSessions.reduce((sum, s) => sum + s.unreadCount, 0);

  return (
    <div className="chat-window">
      {/* Tab bar */}
      <div className="chat-tabs">
        <button
          className={`chat-tab ${activeTab === 'nearby' ? 'active' : ''}`}
          onClick={() => setActiveTab('nearby')}
        >
          Nearby
        </button>
        <button
          className={`chat-tab ${activeTab === 'messages' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('messages');
            // Mark active session as read when switching to Messages tab
            if (activeSessionId && activeSession?.type === 'im') {
              selectSession(activeSessionId);
            }
          }}
        >
          Messages
          {imUnread > 0 && <span className="chat-tab-badge">{imUnread}</span>}
        </button>
        <button
          className={`chat-tab ${activeTab === 'groups' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('groups');
            // Mark active session as read when switching to Groups tab
            if (activeSessionId && activeSession?.type === 'group') {
              selectSession(activeSessionId);
            }
          }}
        >
          Groups ({groups.length})
          {groupUnread > 0 && <span className="chat-tab-badge">{groupUnread}</span>}
        </button>
      </div>

      {/* Voice bar */}
      <VoiceBar activeInstanceId={instanceId} />

      {/* Inventory sync bar */}
      <div className="sync-bar">
        <span className="sync-status">
          {syncStatus.phase === 'idle' && 'Sync: idle'}
          {syncStatus.phase === 'preparing' && 'Sync: preparing...'}
          {syncStatus.phase === 'downloading' && `Downloading ${syncStatus.current}/${syncStatus.total}`}
          {syncStatus.phase === 'uploading' && `Uploading ${syncStatus.current}/${syncStatus.total}`}
          {syncStatus.phase === 'done' && 'Sync: complete'}
          {syncStatus.phase === 'error' && `Sync error: ${syncStatus.error}`}
        </span>
        {syncStatus.uploadCost === 0 && <span className="sync-uploads-free">uploads free</span>}
        {syncStatus.uploadCost > 0 && <span className="sync-uploads-paid">uploads L${syncStatus.uploadCost}</span>}
        <button
          className="sync-btn"
          onClick={startSync}
          disabled={syncStatus.phase === 'downloading' || syncStatus.phase === 'uploading' || syncStatus.phase === 'preparing'}
        >
          Sync Now
        </button>
        <button className="sync-btn" onClick={openSyncFolder}>
          Inventory
        </button>
      </div>

      {/* Tab content */}
      <div className="chat-content">
        {activeTab === 'nearby' && (
          <div className="split-panel">
            {/* Nearby avatars sidebar */}
            <div className="split-sidebar">
              <div className="split-sidebar-section">
                <div className="split-sidebar-header">Nearby ({nearbyAvatars.length})</div>
                {nearbyAvatars.length === 0 ? (
                  <div className="split-sidebar-empty">No avatars nearby</div>
                ) : (
                  nearbyAvatars.map((avatar) => (
                    <div
                      key={avatar.id}
                      className="split-sidebar-item"
                      title={avatar.title || undefined}
                      onClick={() => {
                        startIMSession(avatar.id, avatar.name);
                        setActiveTab('messages');
                      }}
                    >
                      <span className="avatar-status-dot" />
                      <span className="split-sidebar-name" onContextMenu={(e) => handleUserContextMenu(e, avatar.id, avatar.name)}>{displayName(avatar.name)}</span>
                    </div>
                  ))
                )}
              </div>
              <div className="split-sidebar-map">
                <MiniMap
                  regionInfo={regionInfo}
                  nearbyAvatars={nearbyAvatars}
                  onAvatarClick={(avatar) => {
                    startIMSession(avatar.id, avatar.name);
                    setActiveTab('messages');
                  }}
                  onTeleport={handleTeleport}
                />
              </div>
            </div>

            {/* Chat area */}
            <div className="split-main">
              <ChatPanel
                messages={nearbyMessages}
                onSendMessage={(msg, type) => sendNearbyChat(msg, type || 'normal')}
                title="Nearby Chat"
                placeholder="Say something..."
                showChatTypes={true}
                onClear={() => clearSessionHistory('nearby')}
              />
            </div>
          </div>
        )}

        {activeTab === 'messages' && (
          <div className="split-panel">
            {/* Friends sidebar */}
            <div className="split-sidebar">
              <div className="split-sidebar-section">
                <div className="split-sidebar-header collapsible" onClick={() => toggleSection('friends-online')}>
                  <span className={`collapse-arrow ${collapsedSections.has('friends-online') ? 'collapsed' : ''}`}>{'\u25BE'}</span>
                  Friends Online ({onlineFriends.length})
                </div>
                {!collapsedSections.has('friends-online') && (
                  onlineFriends.length === 0 ? (
                    <div className="split-sidebar-empty">No friends online</div>
                  ) : renderFriendList(onlineFriends, 'online')
                )}
              </div>
              <div className="split-sidebar-section">
                <div className="split-sidebar-header collapsible" onClick={() => toggleSection('friends-offline')}>
                  <span className={`collapse-arrow ${collapsedSections.has('friends-offline') ? 'collapsed' : ''}`}>{'\u25BE'}</span>
                  Friends Offline ({offlineFriends.length})
                </div>
                {!collapsedSections.has('friends-offline') && renderFriendList(offlineFriends, 'offline')}
              </div>
              {nonFriendSessions.length > 0 && (
                <div className="split-sidebar-section">
                  <div className="split-sidebar-header">Recent ({nonFriendSessions.length})</div>
                  {nonFriendSessions.map((s) => {
                    const isActive = s.id === activeSessionId;
                    return (
                      <div
                        key={s.id}
                        className={`split-sidebar-item ${isActive ? 'active' : ''} has-session`}
                        onClick={() => selectSession(s.id)}
                      >
                        <span className="avatar-status-dot" />
                        <span className="split-sidebar-name" onContextMenu={(e) => s.participantId && handleUserContextMenu(e, s.participantId, s.name)}>{sessionDisplayName(s)}</span>
                        {s.unreadCount > 0 && (
                          <span className="split-sidebar-badge">{s.unreadCount}</span>
                        )}
                        <span
                          className="split-sidebar-dismiss"
                          onClick={(e) => {
                            e.stopPropagation();
                            dismissSession(s.id);
                          }}
                        >
                          &times;
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Chat area */}
            {renderSessionChat('im', 'Select a conversation to start chatting')}
          </div>
        )}

        {activeTab === 'groups' && (
          <div className="split-panel">
            {/* Groups sidebar */}
            <div className="split-sidebar">
              <div className="split-sidebar-section">
                <div className="split-sidebar-header">My Groups</div>
                {groups.length === 0 ? (
                  <div className="split-sidebar-empty">No groups</div>
                ) : (
                  groups.map((group) => {
                    const session = getGroupSession(group.id);
                    const isActive = session?.id === activeSessionId;
                    return (
                      <div
                        key={group.id}
                        className={`split-sidebar-item ${isActive ? 'active' : ''} ${session ? 'has-session' : ''}`}
                        onClick={() => {
                          if (session) {
                            selectSession(session.id);
                          } else {
                            startGroupChat(group.id);
                          }
                        }}
                      >
                        <span className="split-sidebar-name" onContextMenu={(e) => handleGroupContextMenu(e, group.id, group.name)}>{group.name}</span>
                        {session && session.unreadCount > 0 && (
                          <span className="split-sidebar-badge">{session.unreadCount}</span>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* Chat area */}
            {renderSessionChat('group', 'Select a group to start chatting')}
          </div>
        )}
      </div>
    </div>
  );
};
