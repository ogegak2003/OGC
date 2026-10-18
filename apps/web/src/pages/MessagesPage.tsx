import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { AppShell } from '../components/AppShell';
import { ConversationList } from '../components/messaging/ConversationList';
import { ErrorState } from '../components/ErrorState';
import { ConversationDetails } from '../components/messaging/ConversationDetails';
import { ConversationPanel } from '../components/messaging/ConversationPanel';
import { NewConversationDialog } from '../components/messaging/Dialogs';
import { CreateGroupDialog } from '../components/groups/CreateGroupDialog';
import styles from '../components/messaging/messaging.module.css';
import { Alert } from '../components/ui';
import { useMessaging } from '../messaging/messaging-context';
import { INSECURE_CONTEXT_ERROR } from '../messaging/secure-context';
import { Icon } from '../components/Icon';

/** A layout choice remembered in this browser (storage failures just keep the default). */
function useRememberedToggle(key: string, initial: boolean): [boolean, () => void, () => void] {
  const [value, setValue] = useState(() => {
    try {
      const saved = window.localStorage.getItem(key);
      return saved === null ? initial : saved === 'true';
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, String(next));
      } catch {
        // The choice lasts for this visit.
      }
    },
    [key],
  );
  const toggle = useCallback(() => {
    set(!value);
  }, [set, value]);
  const off = useCallback(() => {
    set(false);
  }, [set]);
  return [value, toggle, off];
}

/**
 * `/messages` and `/messages/:conversationId`: a messaging workspace. Wide screens show the
 * conversation list, the open conversation and (optionally) its details panel; the list and
 * the details can be collapsed so the conversation gets the room. Phones show one at a time.
 */
export function MessagesPage() {
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const { conversations, engine, status, error } = useMessaging();
  const [creating, setCreating] = useState(false);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [listCollapsed, toggleList] = useRememberedToggle('ogc.messages.listCollapsed', false);
  const [detailsOpen, toggleDetails, closeDetails] = useRememberedToggle(
    'ogc.messages.details',
    false,
  );
  const conversation = conversationId
    ? conversations.find((c) => c.id === conversationId)
    : undefined;

  // A conversation opened by link may not be in the cached list yet.
  useEffect(() => {
    if (!engine || !conversationId || conversation) return;
    void engine.refreshConversations().catch(() => undefined);
  }, [engine, conversationId, conversation]);

  return (
    <AppShell title="Messages" layout="full" focused={Boolean(conversationId)}>
      <div
        className={[
          styles.layout,
          conversationId ? styles.showPanel : '',
          listCollapsed ? styles.listCollapsed : '',
          conversation && detailsOpen ? styles.withDetails : '',
        ].join(' ')}
      >
        <ConversationList
          activeId={conversationId}
          onNewConversation={() => {
            setCreating(true);
          }}
          onNewGroup={() => {
            setCreatingGroup(true);
          }}
        />
        {conversation ? (
          <ConversationPanel
            key={conversation.id}
            conversation={conversation}
            workspace={{
              listCollapsed,
              onToggleList: toggleList,
              detailsOpen,
              onToggleDetails: toggleDetails,
            }}
          />
        ) : (
          <section className={styles.panelEmpty} aria-label="No conversation selected">
            {conversationId && status !== 'ready' ? (
              // Phones show this panel without the list: always offer the way back (the
              // "not available" state below has its own).
              <Link to="/messages" className={styles.back} aria-label="Back to conversations">
                <Icon name="back" size={22} />
              </Link>
            ) : null}
            {status === 'error' ? (
              <Alert>
                {error === INSECURE_CONTEXT_ERROR
                  ? error
                  : `Secure messaging could not start on this device. ${error ?? ''}`}
              </Alert>
            ) : conversationId && status === 'ready' ? (
              <ErrorState
                kind="not-found"
                title="Conversation not available"
                home={{ to: '/messages', label: 'Back to conversations', icon: 'chat' }}
              >
                <p>
                  It may have been deleted or you may have left it, or the link may be wrong.
                  Conversations only open on devices that are part of them.
                </p>
              </ErrorState>
            ) : conversationId ? (
              <p className={styles.sidebarNote} role="status">
                Opening conversation…
              </p>
            ) : (
              <>
                <p className={styles.emptyTitle}>Private by design</p>
                <p className={styles.sidebarNote}>
                  Choose a conversation or start a new one. OGC messages are end-to-end encrypted on
                  your devices.
                </p>
              </>
            )}
          </section>
        )}
        {conversation && detailsOpen ? (
          <ConversationDetails
            key={`details-${conversation.id}`}
            conversation={conversation}
            onClose={closeDetails}
          />
        ) : null}
      </div>
      {creating ? (
        <NewConversationDialog
          onClose={() => {
            setCreating(false);
          }}
          onOpened={(opened) => {
            setCreating(false);
            void navigate(`/messages/${opened.id}`);
          }}
        />
      ) : null}
      {creatingGroup ? (
        <CreateGroupDialog
          onClose={() => {
            setCreatingGroup(false);
          }}
          onCreated={(created) => {
            setCreatingGroup(false);
            void navigate(`/messages/${created.id}`);
          }}
        />
      ) : null}
    </AppShell>
  );
}
