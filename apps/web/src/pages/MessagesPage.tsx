import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { AppShell } from '../components/AppShell';
import { ConversationList } from '../components/messaging/ConversationList';
import { ConversationPanel } from '../components/messaging/ConversationPanel';
import { NewConversationDialog } from '../components/messaging/Dialogs';
import { CreateGroupDialog } from '../components/groups/CreateGroupDialog';
import styles from '../components/messaging/messaging.module.css';
import { Alert } from '../components/ui';
import { useMessaging } from '../messaging/messaging-context';

/**
 * `/messages` and `/messages/:conversationId`: conversation list beside the
 * open conversation on wide screens; one at a time on phones.
 */
export function MessagesPage() {
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const { conversations, engine, status, error } = useMessaging();
  const [creating, setCreating] = useState(false);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const conversation = conversationId
    ? conversations.find((c) => c.id === conversationId)
    : undefined;

  // A conversation opened by link may not be in the cached list yet.
  useEffect(() => {
    if (!engine || !conversationId || conversation) return;
    void engine.refreshConversations().catch(() => undefined);
  }, [engine, conversationId, conversation]);

  return (
    <AppShell title="Messages" layout="full">
      <div className={[styles.layout, conversationId ? styles.showPanel : ''].join(' ')}>
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
          <ConversationPanel key={conversation.id} conversation={conversation} />
        ) : (
          <section className={styles.panelEmpty} aria-label="No conversation selected">
            {status === 'error' ? (
              <Alert>Secure messaging could not start on this device. {error}</Alert>
            ) : conversationId && status === 'ready' ? (
              <p className={styles.sidebarNote}>This conversation isn’t available.</p>
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
