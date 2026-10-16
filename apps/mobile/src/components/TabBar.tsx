import { fontSize, fontWeight, radius, size, space } from '@ogc/ui';
import { type ReactNode, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMessaging } from '../messaging/messaging-context';
import { type Route, type Tab, isTab, useNavigation } from '../navigation';
import { InTabsContext } from '../screens/Screen';
import { Icon, type IconName } from './Icon';
import { color, themedStyles } from '../theme';

const ITEMS: Record<Tab, { label: string; icon: IconName }> = {
  home: { label: 'Home', icon: 'home' },
  messages: { label: 'Chats', icon: 'chat' },
  contacts: { label: 'Contacts', icon: 'contacts' },
  communities: { label: 'Communities', icon: 'community' },
  profile: { label: 'You', icon: 'user' },
};

/** Left and right of the central "create" button. */
const LEFT: Tab[] = ['home', 'messages'];
const RIGHT: Tab[] = ['contacts', 'communities', 'profile'];

/** What the central button can start — each one an existing screen. */
const CREATE: { label: string; hint: string; icon: IconName; route: Route }[] = [
  {
    label: 'New chat',
    hint: 'Message one of your contacts',
    icon: 'chat',
    route: { name: 'new-conversation' },
  },
  {
    label: 'New group',
    hint: 'End-to-end encrypted',
    icon: 'community',
    route: { name: 'new-group' },
  },
  {
    label: 'New channel',
    hint: 'Share updates with a community',
    icon: 'megaphone',
    route: { name: 'new-channel' },
  },
  { label: 'Start a call', hint: 'Voice or video', icon: 'phone', route: { name: 'calls' } },
  {
    label: 'Find by OGC ID',
    hint: 'Add someone as a contact',
    icon: 'userPlus',
    route: { name: 'discover' },
  },
];

function TabItem({ tab, active }: { tab: Tab; active: Tab }) {
  const nav = useNavigation();
  const { unreadTotal } = useMessaging();
  const item = ITEMS[tab];
  const selected = tab === active;
  const count = tab === 'messages' ? unreadTotal : 0;
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      accessibilityLabel={count > 0 ? `${item.label}, ${String(count)} unread` : item.label}
      style={({ pressed }) => [styles.item, pressed && styles.pressed]}
      onPress={() => {
        if (!selected || nav.canGoBack) nav.tab(tab);
      }}
    >
      <View style={[styles.indicator, selected && styles.indicatorActive]} />
      <View>
        <Icon
          name={item.icon}
          size={24}
          tint={selected ? color.accent : color.textMuted}
          strokeWidth={selected ? 2 : 1.75}
        />
        {count > 0 ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{count > 99 ? '99+' : count}</Text>
          </View>
        ) : null}
      </View>
      <Text
        style={[styles.label, selected && styles.labelActive]}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.75}
        maxFontSizeMultiplier={1.3}
      >
        {item.label}
      </Text>
    </Pressable>
  );
}

/** The "create" sheet opened by the central button. */
function CreateSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigation();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close" />
      <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, space[4]) }]}>
        <View style={styles.handle} />
        <Text style={styles.sheetTitle} accessibilityRole="header">
          Create
        </Text>
        {CREATE.map((action) => (
          <Pressable
            key={action.label}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            onPress={() => {
              onClose();
              nav.push(action.route);
            }}
            style={({ pressed }) => [styles.sheetRow, pressed && styles.sheetRowPressed]}
          >
            <View style={styles.sheetIcon}>
              <Icon name={action.icon} size={20} tint={color.accent} />
            </View>
            <View style={styles.sheetText}>
              <Text style={styles.sheetLabel}>{action.label}</Text>
              <Text style={styles.sheetHint}>{action.hint}</Text>
            </View>
            <Icon name="chevronRight" size={18} tint={color.textMuted} />
          </Pressable>
        ))}
      </View>
    </Modal>
  );
}

/**
 * Bottom navigation: the five destinations, gold for the selected one, real unread counts,
 * and a central gold "create" button for new chats, groups, channels, calls and contacts.
 */
export function TabBar({ active }: { active: Tab }) {
  const insets = useSafeAreaInsets();
  const [creating, setCreating] = useState(false);
  return (
    <>
      <View
        style={[styles.bar, { paddingBottom: Math.max(insets.bottom, space[2]) }]}
        accessibilityRole="tablist"
      >
        {LEFT.map((tab) => (
          <TabItem key={tab} tab={tab} active={active} />
        ))}
        <View style={styles.createSlot}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Create"
            accessibilityHint="New chat, group, channel or call"
            onPress={() => {
              setCreating(true);
            }}
            style={({ pressed }) => [styles.create, pressed && styles.createPressed]}
          >
            <Icon name="plus" size={26} tint={color.accent} strokeWidth={2.25} />
          </Pressable>
        </View>
        {RIGHT.map((tab) => (
          <TabItem key={tab} tab={tab} active={active} />
        ))}
      </View>
      <CreateSheet
        open={creating}
        onClose={() => {
          setCreating(false);
        }}
      />
    </>
  );
}

/** Wraps a signed-in screen: destinations get the tab bar below them. */
export function TabShell({ route, children }: { route: Route; children: ReactNode }) {
  if (!isTab(route.name)) return <>{children}</>;
  return (
    <View style={styles.shell}>
      <InTabsContext value>
        <View style={styles.content}>{children}</View>
      </InTabsContext>
      <TabBar active={route.name} />
    </View>
  );
}

const styles = themedStyles(() =>
  StyleSheet.create({
    shell: { flex: 1, backgroundColor: color.background },
    content: { flex: 1 },
    bar: {
      flexDirection: 'row',
      paddingTop: 2,
      backgroundColor: color.surface,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: color.borderStrong,
    },
    item: {
      flex: 1,
      minHeight: size.tabBar - 8,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 3,
      paddingHorizontal: 1,
    },
    pressed: { opacity: 0.7 },
    indicator: { position: 'absolute', top: 0, width: 28, height: 2, borderRadius: 1 },
    indicatorActive: { backgroundColor: color.accent },
    label: { color: color.textMuted, fontSize: 11, fontWeight: fontWeight.medium },
    labelActive: { color: color.accent, fontWeight: fontWeight.semibold },
    badge: {
      position: 'absolute',
      top: -4,
      right: -10,
      minWidth: 18,
      height: 18,
      paddingHorizontal: 4,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: color.accent,
      borderRadius: 9,
      borderWidth: 2,
      borderColor: color.surface,
    },
    badgeText: { color: color.onAccent, fontSize: 10, fontWeight: fontWeight.bold },
    createSlot: { width: 58, alignItems: 'center' },
    create: {
      width: 52,
      height: 52,
      marginTop: -16,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: color.accentSubtle,
      borderWidth: 2,
      borderColor: color.accent,
      borderRadius: 26,
      shadowColor: color.accent,
      shadowOpacity: 0.35,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 0 },
      elevation: 6,
    },
    createPressed: { backgroundColor: color.accentSubtle },
    scrim: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.6)' },
    sheet: {
      gap: space[1],
      paddingHorizontal: space[4],
      paddingTop: space[2],
      backgroundColor: color.surfaceRaised,
      borderTopLeftRadius: radius.xl,
      borderTopRightRadius: radius.xl,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: color.borderStrong,
    },
    handle: {
      alignSelf: 'center',
      width: 40,
      height: 4,
      marginBottom: space[2],
      backgroundColor: color.borderStrong,
      borderRadius: 2,
    },
    sheetTitle: {
      marginBottom: space[1],
      paddingHorizontal: space[2],
      color: color.textPrimary,
      fontSize: fontSize.lg,
      fontWeight: fontWeight.semibold,
    },
    sheetRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space[3],
      minHeight: 60,
      paddingHorizontal: space[2],
      borderRadius: radius.md,
    },
    sheetRowPressed: { backgroundColor: color.surfaceHover },
    sheetIcon: {
      width: 40,
      height: 40,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: color.accentSubtle,
      borderRadius: 20,
    },
    sheetText: { flex: 1, gap: 2 },
    sheetLabel: { color: color.textPrimary, fontSize: fontSize.md, fontWeight: fontWeight.medium },
    sheetHint: { color: color.textMuted, fontSize: fontSize.sm },
  }),
);
