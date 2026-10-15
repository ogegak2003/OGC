import type { OgcId, OwnProfile } from '@ogc/types';
import { LOGO_TAGLINE, color, fontSize, fontWeight, radius, space } from '@ogc/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import GLOBE from '../../assets/welcome-globe.jpg';
import { useAuth } from '../auth/AuthProvider';
import { Icon, type IconName } from '../components/Icon';
import { Avatar, OgcIdText, useCopy } from '../components/identity';
import { shareIdentity } from '../lib/share';
import { OgcLogo } from '../components/OgcLogo';
import {
  EmptyState,
  IconButton,
  ListGroup,
  Notice,
  SectionHeader,
  Skeleton,
  SkeletonRows,
} from '../components/ui';
import { errorMessage } from '../lib/errors';
import { useResource } from '../lib/use-resource';
import { useMessaging } from '../messaging/messaging-context';
import { type Route, type Tab, useNavigation } from '../navigation';
import { ConversationRow } from './messaging/MessagesScreen';

const RECENT = 5;
/** Direct-conversation peers whose presence the home screen watches (online dots). */
const PRESENCE_WATCH = 50;
/** Content column (matches the other screens); wider screens centre it. */
const MAX_WIDTH = 560;

interface Shortcut {
  label: string;
  hint: string;
  icon: IconName;
  open: { tab: Tab } | { route: Route };
}

const SHORTCUTS: Shortcut[] = [
  { label: 'Messages', hint: 'Chat privately', icon: 'chat', open: { tab: 'messages' } },
  { label: 'Groups', hint: 'Build together', icon: 'community', open: { tab: 'communities' } },
  {
    label: 'Channels',
    hint: 'Discover & join',
    icon: 'megaphone',
    open: { route: { name: 'channels' } },
  },
  { label: 'Calls', hint: 'Voice & video', icon: 'phone', open: { route: { name: 'calls' } } },
];

function greeting(now = new Date()): string {
  const hour = now.getHours();
  if (hour < 5) return 'Good evening';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** What the profile is missing, from the profile itself (display name is always set). */
function missingProfileParts(profile: OwnProfile): string[] {
  const missing: string[] = [];
  if (!profile.avatarUrl) missing.push('Add a profile photo');
  if (!profile.bio?.trim()) missing.push('Write a short bio');
  return missing;
}

function ProfileProgress({ profile }: { profile: OwnProfile }) {
  const nav = useNavigation();
  const missing = missingProfileParts(profile);
  if (missing.length === 0) return null;
  const total = 3;
  const done = total - missing.length;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Complete your profile, ${String(done)} of ${String(total)} done`}
      onPress={() => {
        nav.push({ name: 'edit-profile' });
      }}
      style={({ pressed }) => [styles.progress, pressed && styles.pressed]}
    >
      <View style={styles.progressTop}>
        <Text style={styles.progressTitle}>Complete your profile</Text>
        <Text style={styles.progressCount}>
          {done}/{total}
        </Text>
      </View>
      <View style={styles.track}>
        <View style={[styles.fill, { flex: done }]} />
        <View style={{ flex: total - done }} />
      </View>
      <Text style={styles.progressHint}>{missing.join(' · ')}</Text>
    </Pressable>
  );
}

/** Messages, Groups, Channels and Calls: four across on most phones, 2×2 on the narrowest. */
function Shortcuts({ columns }: { columns: 2 | 4 }) {
  const nav = useNavigation();
  const { unreadTotal } = useMessaging();
  return (
    <View style={styles.shortcuts}>
      {SHORTCUTS.map((item) => {
        const unread = item.label === 'Messages' ? unreadTotal : 0;
        return (
          <Pressable
            key={item.label}
            accessibilityRole="button"
            accessibilityLabel={
              unread > 0 ? `${item.label}, ${String(unread)} unread` : `${item.label}, ${item.hint}`
            }
            onPress={() => {
              if ('tab' in item.open) nav.tab(item.open.tab);
              else nav.push(item.open.route);
            }}
            style={({ pressed }) => [
              styles.shortcut,
              columns === 2 ? styles.shortcutHalf : styles.shortcutQuarter,
              pressed && styles.shortcutPressed,
            ]}
          >
            <View style={styles.shortcutIcon}>
              <Icon name={item.icon} size={20} tint={color.accent} strokeWidth={2} />
              {unread > 0 ? (
                <View style={styles.shortcutBadge}>
                  <Text style={styles.shortcutBadgeText}>{unread > 99 ? '99+' : unread}</Text>
                </View>
              ) : null}
            </View>
            <Text
              style={styles.shortcutLabel}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.85}
            >
              {item.label}
            </Text>
            <View style={styles.shortcutBottom}>
              <Text style={styles.shortcutHint} numberOfLines={2}>
                {item.hint}
              </Text>
              {columns === 2 ? (
                <Icon name="arrowRight" size={14} tint={color.textSecondary} />
              ) : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

function IdentityChip({
  icon,
  label,
  onPress,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
    >
      <Icon name={icon} size={16} tint={color.accent} />
      <Text style={styles.chipText} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Your Global Identity: the OGC ID with copy, share, QR, and finding others by theirs. */
function GlobalIdentity({ ogcId, displayName }: { ogcId: OgcId; displayName: string }) {
  const nav = useNavigation();
  const [copied, copy] = useCopy();
  return (
    <View style={styles.identity}>
      <Image source={GLOBE} style={styles.identityGlobe} resizeMode="cover" accessible={false} />
      <View style={styles.identityTop}>
        <View style={styles.identityIcon}>
          <Icon name="globe" size={24} tint={color.accent} />
        </View>
        <View style={styles.identityText}>
          <Text style={styles.identityTitle} accessibilityRole="header">
            Your Global Identity
          </Text>
          <Text style={styles.identitySub}>One ID. Endless possibilities.</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Show my QR code"
          onPress={() => {
            nav.push({ name: 'my-qr' });
          }}
          hitSlop={6}
          style={({ pressed }) => [styles.qrButton, pressed && styles.chipPressed]}
        >
          <Icon name="qr" size={22} tint={color.accent} />
        </Pressable>
      </View>
      <View style={styles.identityId}>
        <Text style={styles.overline}>YOUR OGC ID</Text>
        <OgcIdText ogcId={ogcId} size="lg" />
      </View>
      <View style={styles.chips}>
        <IdentityChip
          icon={copied ? 'check' : 'copy'}
          label={copied ? 'Copied' : 'Copy ID'}
          onPress={() => {
            copy(ogcId);
          }}
        />
        <IdentityChip
          icon="share"
          label="Share"
          onPress={() => void shareIdentity(ogcId, displayName)}
        />
        <IdentityChip
          icon="userPlus"
          label="Find by OGC ID"
          onPress={() => {
            nav.push({ name: 'discover' });
          }}
        />
      </View>
    </View>
  );
}

function RecentChats() {
  const nav = useNavigation();
  const { conversations, status, error, retry, watchPresence } = useMessaging();
  const recent = conversations.slice(0, RECENT);
  const peers = useMemo(
    () =>
      conversations
        .slice(0, PRESENCE_WATCH)
        .flatMap((c) => (c.peer && !c.blockedByMe ? [c.peer.ogcId] : [])),
    [conversations],
  );
  // Online dots on recent chats come from real presence (shared only between chat partners).
  useEffect(() => {
    if (peers.length > 0) watchPresence(peers);
  }, [peers, watchPresence]);

  return (
    <>
      <SectionHeader
        title="Recent chats"
        action={
          conversations.length > 0
            ? {
                label: 'See all',
                onPress: () => {
                  nav.tab('messages');
                },
              }
            : undefined
        }
      />
      {status === 'error' ? (
        <Notice action={{ label: 'Retry', onPress: retry }}>
          Secure messaging could not start on this device. {error}
        </Notice>
      ) : status === 'starting' || status === 'idle' ? (
        <View style={styles.listSurface}>
          <SkeletonRows count={3} label="Loading your conversations" />
        </View>
      ) : recent.length === 0 ? (
        <View style={styles.listSurface}>
          <EmptyState
            icon="chat"
            title="No conversations yet"
            body="Add a contact by their OGC ID, then start an end-to-end encrypted chat."
            action={{
              label: 'Find someone',
              icon: 'userPlus',
              onPress: () => {
                nav.push({ name: 'discover' });
              },
            }}
          />
        </View>
      ) : (
        <ListGroup>
          {recent.map((conversation) => (
            <ConversationRow key={conversation.id} conversation={conversation} />
          ))}
        </ListGroup>
      )}
    </>
  );
}

/** The Earth behind the top of the screen, darkened so text keeps its contrast. */
function EarthBackdrop({ width }: { width: number }) {
  const [failed, setFailed] = useState(false);
  const size = Math.min(width * 1.25, 720);
  const height = size * 0.78;
  if (failed) return null;
  return (
    <View
      style={[styles.backdrop, { height }]}
      pointerEvents="none"
      accessible={false}
      importantForAccessibility="no-hide-descendants"
    >
      <Image
        source={GLOBE}
        style={{
          position: 'absolute',
          width: size,
          height: size,
          top: -size * 0.16,
          right: -size * 0.42,
          opacity: 0.9,
        }}
        resizeMode="contain"
        fadeDuration={0}
        onError={() => {
          setFailed(true);
        }}
      />
      <Svg style={StyleSheet.absoluteFill} width="100%" height="100%" preserveAspectRatio="none">
        <Defs>
          <LinearGradient id="home-left" x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0" stopColor={color.background} stopOpacity={0.92} />
            <Stop offset="0.55" stopColor={color.background} stopOpacity={0.55} />
            <Stop offset="1" stopColor={color.background} stopOpacity={0.15} />
          </LinearGradient>
          <LinearGradient id="home-bottom" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0.45" stopColor={color.background} stopOpacity={0} />
            <Stop offset="1" stopColor={color.background} stopOpacity={1} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#home-left)" />
        <Rect width="100%" height="100%" fill="url(#home-bottom)" />
      </Svg>
    </View>
  );
}

/** The signed-in hub: greeting, shortcuts, your OGC identity and the latest conversations. */
export function HomeScreen() {
  const { client, state: auth } = useAuth();
  const nav = useNavigation();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { notificationsUnread, connection, status } = useMessaging();
  const load = useCallback(() => client.profile(), [client]);
  const { state, reload } = useResource(load);
  const account = auth.status === 'signed-in' ? auth.account : undefined;
  const name = state.status === 'ready' ? state.data.displayName : (account?.displayName ?? '');
  const columns = Math.min(width, MAX_WIDTH) - space[5] * 2 >= 340 ? 4 : 2;
  const online = connection === 'online';

  return (
    <View style={styles.root}>
      <EarthBackdrop width={width} />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + space[3] }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.inner}>
          <View style={styles.top}>
            <View
              style={styles.brand}
              accessible
              accessibilityRole="header"
              accessibilityLabel="OGC"
            >
              <OgcLogo height={30} />
              <Text style={styles.tagline} numberOfLines={2}>
                {LOGO_TAGLINE.replace(' WITHOUT', '\nWITHOUT')}
              </Text>
            </View>
            <View style={styles.topActions}>
              <IconButton
                icon="search"
                label="Search"
                onPress={() => {
                  nav.push({ name: 'search' });
                }}
              />
              <IconButton
                icon="bell"
                label={
                  notificationsUnread > 0
                    ? `Notifications, ${String(notificationsUnread)} new`
                    : 'Notifications'
                }
                badge={notificationsUnread}
                onPress={() => {
                  nav.push({ name: 'notifications' });
                }}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Your profile and settings"
                onPress={() => {
                  nav.tab('profile');
                }}
                style={styles.me}
              >
                <Avatar
                  url={state.status === 'ready' ? state.data.avatarUrl : null}
                  name={name}
                  size={36}
                  ring
                />
                {status === 'ready' ? (
                  <View style={[styles.meDot, online ? styles.dotOnline : styles.dotOffline]} />
                ) : null}
              </Pressable>
            </View>
          </View>

          {state.status === 'loading' ? (
            <View style={styles.greetingSkeleton} accessibilityLabel="Loading your profile">
              <Skeleton width="45%" height={20} />
              <Skeleton width="70%" height={32} />
            </View>
          ) : state.status === 'error' ? (
            <Notice action={{ label: 'Retry', onPress: reload }}>
              {errorMessage(state.error)}
            </Notice>
          ) : (
            <View style={styles.greetingBlock}>
              {status === 'ready' ? (
                <View
                  style={styles.statusPill}
                  accessible
                  accessibilityLabel={online ? 'Connected' : 'Reconnecting'}
                >
                  <View style={[styles.pillDot, online ? styles.dotOnline : styles.dotOffline]} />
                  <Text style={styles.pillText}>{online ? 'Online' : 'Reconnecting'}</Text>
                </View>
              ) : null}
              <Text style={styles.greeting}>{greeting()},</Text>
              <Text
                style={styles.name}
                accessibilityRole="header"
                numberOfLines={2}
                adjustsFontSizeToFit
                minimumFontScale={0.75}
              >
                {state.data.displayName}
              </Text>
              <Text style={styles.lead}>
                Stay connected with the people who matter, anywhere in the world.
              </Text>
            </View>
          )}

          {connection === 'offline' && status === 'ready' ? (
            <Notice tone="warning">Offline — reconnecting. Messages you send are queued.</Notice>
          ) : null}

          <Shortcuts columns={columns} />

          {state.status === 'ready' ? (
            <>
              <GlobalIdentity ogcId={state.data.ogcId} displayName={state.data.displayName} />
              {state.data.bio ? (
                <Text style={styles.bio} numberOfLines={3}>
                  {state.data.bio}
                </Text>
              ) : null}
              <ProfileProgress profile={state.data} />
            </>
          ) : null}

          <RecentChats />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.background, overflow: 'hidden' },
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, overflow: 'hidden' },
  content: { flexGrow: 1, paddingHorizontal: space[5], paddingBottom: space[8] },
  inner: { width: '100%', maxWidth: MAX_WIDTH, alignSelf: 'center', gap: space[5] },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  brand: { flexShrink: 1, gap: 4 },
  tagline: {
    color: color.textPrimary,
    fontSize: 7.5,
    lineHeight: 10,
    fontWeight: fontWeight.medium,
    letterSpacing: 1.6,
    opacity: 0.85,
  },
  topActions: { flexDirection: 'row', alignItems: 'center' },
  me: { marginLeft: space[1], padding: 3 },
  meDot: {
    position: 'absolute',
    right: 2,
    bottom: 2,
    width: 11,
    height: 11,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: color.background,
  },
  dotOnline: { backgroundColor: color.success },
  dotOffline: { backgroundColor: color.textMuted },
  greetingSkeleton: { gap: space[3], paddingTop: space[4] },
  greetingBlock: { paddingTop: space[4], gap: space[1] },
  statusPill: {
    position: 'absolute',
    top: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: space[3],
    paddingVertical: 5,
    backgroundColor: 'rgba(20, 20, 24, 0.8)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.borderStrong,
    borderRadius: radius.full,
  },
  pillDot: { width: 8, height: 8, borderRadius: 4 },
  pillText: { color: color.textPrimary, fontSize: fontSize.xs, fontWeight: fontWeight.medium },
  greeting: {
    marginTop: space[4],
    color: color.accent,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.medium,
  },
  name: {
    color: color.textPrimary,
    fontSize: fontSize['3xl'],
    fontWeight: fontWeight.bold,
    letterSpacing: -0.6,
    lineHeight: 40,
  },
  lead: {
    maxWidth: 300,
    marginTop: space[1],
    color: color.textSecondary,
    fontSize: fontSize.md,
    lineHeight: 22,
  },
  bio: { color: color.textSecondary, fontSize: fontSize.sm, lineHeight: 20 },
  shortcuts: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2] },
  shortcut: {
    minHeight: 112,
    gap: space[2],
    padding: space[3],
    backgroundColor: 'rgba(20, 22, 30, 0.88)',
    borderWidth: 1,
    borderColor: color.borderStrong,
    borderRadius: radius.lg,
  },
  shortcutQuarter: { flexGrow: 1, flexBasis: '22%' },
  shortcutHalf: { flexGrow: 1, flexBasis: '46%' },
  shortcutPressed: { borderColor: color.accent, backgroundColor: color.surfaceRaised },
  shortcutIcon: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.accentSubtle,
    borderWidth: 1,
    borderColor: color.accentBorder,
    borderRadius: 19,
  },
  shortcutBadge: {
    position: 'absolute',
    top: -5,
    right: -8,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.accent,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: color.background,
  },
  shortcutBadgeText: { color: color.onAccent, fontSize: 10, fontWeight: fontWeight.bold },
  shortcutLabel: {
    color: color.textPrimary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
  shortcutBottom: { flexDirection: 'row', alignItems: 'flex-end', gap: 4, marginTop: 'auto' },
  shortcutHint: { flex: 1, color: color.textSecondary, fontSize: 11, lineHeight: 14 },
  identity: {
    gap: space[4],
    padding: space[4],
    overflow: 'hidden',
    backgroundColor: '#0E1220',
    borderWidth: 1,
    borderColor: color.accent,
    borderRadius: radius.xl,
  },
  identityGlobe: {
    position: 'absolute',
    top: -40,
    right: -70,
    width: 200,
    height: 200,
    opacity: 0.35,
  },
  identityTop: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
  identityIcon: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: color.accentBorder,
    borderRadius: 22,
  },
  identityText: { flex: 1, gap: 2 },
  identityTitle: {
    color: color.accentHighlight,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
  },
  identitySub: { color: color.textSecondary, fontSize: fontSize.sm },
  qrButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(11, 11, 13, 0.6)',
    borderWidth: 1,
    borderColor: color.accentBorder,
    borderRadius: radius.md,
  },
  identityId: { gap: space[1] },
  overline: {
    color: color.accent,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    letterSpacing: 1.8,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2] },
  chip: {
    flexGrow: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: 40,
    paddingHorizontal: space[3],
    backgroundColor: 'rgba(11, 11, 13, 0.55)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.borderStrong,
    borderRadius: radius.full,
  },
  chipPressed: { backgroundColor: color.accentSubtle },
  chipText: { color: color.textPrimary, fontSize: fontSize.sm, fontWeight: fontWeight.medium },
  pressed: { opacity: 0.8 },
  progress: {
    gap: space[2],
    padding: space[4],
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.lg,
  },
  progressTop: { flexDirection: 'row', justifyContent: 'space-between' },
  progressTitle: {
    color: color.textPrimary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  progressCount: { color: color.accent, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
  track: {
    flexDirection: 'row',
    height: 6,
    borderRadius: 3,
    backgroundColor: color.surfaceHover,
    overflow: 'hidden',
  },
  fill: { height: 6, borderRadius: 3, backgroundColor: color.accent },
  progressHint: { color: color.textMuted, fontSize: fontSize.sm },
  listSurface: {
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.lg,
  },
});
