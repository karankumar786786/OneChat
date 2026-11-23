import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Alert, FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { useChat, useGroup, useMessages } from "@/db/hooks";
import { useRealtime } from "@/realtime/store";
import { emitTyping, loadGroup, markChatRead, queryPresence } from "@/realtime/socket";
import { deleteForEveryone, deleteForMe, react, sendFile, sendText, type ChatTarget } from "@/chat/actions";
import { MessageBubble } from "@/chat/MessageBubble";
import { api } from "@/api/client";
import { useAuth } from "@/auth/store";
import { Avatar } from "@/ui/components";
import { colors, radius, space } from "@/ui/theme";
import { lastSeenLabel } from "@/lib/format";
import type { GroupMemberRow, MessageRow } from "@/db/types";
import { getDb } from "@/db";
import { deleteChat, deleteChatHistory } from "@/db/queries";
import { membersOf } from "@/db/groups";
import { emitDbChange } from "@/db/changes";

const REACTIONS = ["❤️", "👍", "😂", "😮", "😢", "🙏"];
const TYPING_REFRESH_MS = 3000;
const TYPING_IDLE_MS = 2500;
const EMPTY: Record<string, number> = {};

export default function ChatScreen() {
  const { peerId } = useLocalSearchParams<{ peerId: string }>();
  const [chat] = useChat(peerId);
  const [group] = useGroup(peerId);
  const [messages] = useMessages(peerId);
  const myId = useAuth((s) => s.me?.id ?? "");
  const isGroup = chat?.kind === "group";
  const target: ChatTarget = useMemo(() => ({ id: peerId, kind: isGroup ? "group" : "direct" }), [peerId, isGroup]);

  const presence = useRealtime((s) => s.presence[peerId]);
  const typing = useRealtime((s) => Boolean(s.typing[peerId]));
  const groupTyping = useRealtime((s) => s.groupTyping[peerId] ?? EMPTY);
  const navigation = useNavigation();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [text, setText] = useState("");
  const [replyTo, setReplyTo] = useState<MessageRow | null>(null);
  const [selected, setSelected] = useState<MessageRow | null>(null);
  const [blocked, setBlocked] = useState(false);
  const typingState = useRef({ lastSent: 0, idle: undefined as ReturnType<typeof setTimeout> | undefined });

  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const members = useMemo(() => membersOf(group), [group]);
  const memberMap = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const name = chat?.displayName || (chat?.username ? `@${chat.username}` : "");
  const amAdmin = group?.myRole === "admin";
  const isMember = !isGroup || group?.isMember !== 0;
  const canSend = isMember && !(isGroup && group?.onlyAdminsCanSend === 1 && !amAdmin);

  const memberLabel = (id: string | null | undefined) => {
    if (!id) return "";
    const m = memberMap.get(id);
    return m ? m.displayName || `@${m.username}` : "Someone";
  };

  // While this chat is on screen, incoming messages are read immediately (blue ticks).
  useFocusEffect(
    useCallback(() => {
      useRealtime.getState().setActivePeer(peerId);
      void markChatRead(peerId);
      if (isGroup) {
        void loadGroup(peerId);
      } else {
        void queryPresence([peerId]);
        api.GET("/blocks").then(({ data }) => setBlocked(Boolean(data?.users.some((u) => u.id === peerId))));
      }
      return () => useRealtime.getState().setActivePeer(null);
    }, [peerId, isGroup]),
  );

  const toggleBlock = useCallback(async () => {
    const path = { params: { path: { userId: peerId } } };
    if (blocked) await api.DELETE("/blocks/{userId}", path);
    else await api.POST("/blocks/{userId}", path);
    setBlocked(!blocked);
  }, [blocked, peerId]);

  const subtitle = useMemo(() => {
    if (isGroup) {
      const typers = Object.keys(groupTyping).filter((id) => id !== myId);
      if (typers.length === 1) return `${memberLabel(typers[0])} is typing…`;
      if (typers.length > 1) return `${typers.length} people are typing…`;
      if (!isMember) return "You're no longer a participant";
      return members.length ? members.map((m) => (m.id === myId ? "You" : m.displayName || m.username)).join(", ") : "tap for group info";
    }
    if (blocked) return "blocked";
    if (typing) return "typing…";
    return lastSeenLabel(Boolean(presence?.online), presence?.lastSeenAt ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isGroup, groupTyping, members, myId, isMember, blocked, typing, presence]);

  useLayoutEffect(() => {
    const highlighted = isGroup ? Object.keys(groupTyping).length > 0 : typing || Boolean(presence?.online);
    navigation.setOptions({
      headerTitle: () => (
        <Pressable
          disabled={!isGroup}
          onPress={() => router.push(`/group/${peerId}`)}
          style={{ flexDirection: "row", alignItems: "center", gap: space(2), maxWidth: 240 }}
        >
          <Avatar name={isGroup ? name : chat?.username} url={chat?.avatarUrl} cacheKey={chat?.avatarFileId} size={32} group={isGroup} />
          <View style={{ flexShrink: 1 }}>
            <Text style={styles.headerName} numberOfLines={1}>{name}</Text>
            <Text style={[styles.headerSub, highlighted && { color: colors.primary }]} numberOfLines={1}>{subtitle}</Text>
          </View>
        </Pressable>
      ),
      headerRight: () => (
        <Pressable
          hitSlop={12}
          onPress={() => {
            const clear = { text: "Clear chat on this phone", style: "destructive" as const, onPress: () => void deleteChatHistory(getDb(), peerId).then(() => emitDbChange([peerId])) };
            if (isGroup) {
              Alert.alert(name, undefined, [
                { text: "Group info", onPress: () => router.push(`/group/${peerId}`) },
                clear,
                ...(isMember
                  ? []
                  : [{ text: "Delete group", style: "destructive" as const, onPress: () => void deleteChat(getDb(), peerId).then(() => { emitDbChange([peerId]); router.back(); }) }]),
                { text: "Cancel", style: "cancel" },
              ]);
            } else {
              Alert.alert(name, undefined, [
                { text: blocked ? "Unblock" : "Block", style: blocked ? "default" : "destructive", onPress: toggleBlock },
                clear,
                { text: "Cancel", style: "cancel" },
              ]);
            }
          }}
        >
          <Ionicons name="ellipsis-vertical" size={20} color={colors.primary} />
        </Pressable>
      ),
    });
  }, [navigation, router, chat, name, subtitle, isGroup, isMember, blocked, toggleBlock, peerId, typing, presence, groupTyping]);

  // Stop announcing "typing" when leaving the screen.
  useEffect(() => () => clearTimeout(typingState.current.idle), []);

  function onChangeText(t: string) {
    setText(t);
    const s = typingState.current;
    if (t && Date.now() - s.lastSent > TYPING_REFRESH_MS) {
      emitTyping(target, true);
      s.lastSent = Date.now();
    }
    clearTimeout(s.idle);
    s.idle = setTimeout(() => {
      emitTyping(target, false);
      s.lastSent = 0;
    }, TYPING_IDLE_MS);
  }

  async function send() {
    const body = text.trim();
    if (!body) return;
    setText("");
    const reply = replyTo?.id;
    setReplyTo(null);
    clearTimeout(typingState.current.idle);
    emitTyping(target, false);
    typingState.current.lastSent = 0;
    await sendText(target, body, reply);
  }

  async function attach() {
    Alert.alert("Send a file", undefined, [
      {
        text: "Photo or video",
        onPress: async () => {
          const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images", "videos"], quality: 0.85 });
          const a = r.assets?.[0];
          if (r.canceled || !a) return;
          await sendFile(target, { uri: a.uri, name: a.fileName ?? `media-${Date.now()}.${a.type === "video" ? "mp4" : "jpg"}`, mime: a.mimeType ?? (a.type === "video" ? "video/mp4" : "image/jpeg"), size: a.fileSize ?? 0 }, text.trim() || undefined, replyTo?.id);
          setText("");
          setReplyTo(null);
        },
      },
      {
        text: "Document",
        onPress: async () => {
          const r = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
          const a = r.assets?.[0];
          if (r.canceled || !a) return;
          await sendFile(target, { uri: a.uri, name: a.name, mime: a.mimeType ?? "application/octet-stream", size: a.size ?? 0 }, text.trim() || undefined, replyTo?.id);
          setText("");
          setReplyTo(null);
        },
      },
      { text: "Cancel", style: "cancel" },
    ]);
  }

  const closeMenu = () => setSelected(null);
  const replyName = (m: MessageRow) => (m.fromMe ? "You" : isGroup ? memberLabel(m.senderId) : name);

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={Platform.OS === "ios" ? insets.top + 44 : 0}>
      <FlatList
        inverted
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ padding: space(3), gap: space(1) }}
        renderItem={({ item }) => (
          <MessageBubble
            message={item}
            replied={item.replyTo ? byId.get(item.replyTo) : undefined}
            replyName={replyName}
            sender={isGroup && !item.fromMe ? memberMap.get(item.senderId ?? "") ?? null : null}
            showSender={isGroup}
            myId={myId}
            onLongPress={() => item.kind !== "system" && setSelected(item)}
          />
        )}
      />

      {!isGroup && blocked ? (
        <Pressable style={[styles.notice, { paddingBottom: insets.bottom + space(3) }]} onPress={toggleBlock}>
          <Text style={{ color: colors.primary, fontWeight: "600" }}>You blocked this user. Tap to unblock.</Text>
        </Pressable>
      ) : !isMember ? (
        <View style={[styles.notice, { paddingBottom: insets.bottom + space(3) }]}>
          <Text style={styles.noticeText}>You can't send messages to this group because you're no longer a participant.</Text>
        </View>
      ) : !canSend ? (
        <View style={[styles.notice, { paddingBottom: insets.bottom + space(3) }]}>
          <Text style={styles.noticeText}>Only admins can send messages</Text>
        </View>
      ) : (
        <View style={[styles.composer, { paddingBottom: insets.bottom + space(2) }]}>
          {replyTo ? (
            <View style={styles.replyBar}>
              <View style={{ flex: 1 }}>
                <Text style={styles.replyLabel}>Replying to {replyTo.fromMe ? "yourself" : replyName(replyTo)}</Text>
                <Text numberOfLines={1} style={styles.replyText}>{replyTo.text ?? "📎 File"}</Text>
              </View>
              <Pressable onPress={() => setReplyTo(null)} hitSlop={10}>
                <Ionicons name="close" size={18} color={colors.muted} />
              </Pressable>
            </View>
          ) : null}
          {isGroup ? <MentionSuggestions text={text} members={members} myId={myId} onPick={(u) => setText(text.replace(/@([a-z0-9_.]*)$/i, `@${u} `))} /> : null}
          <View style={styles.inputRow}>
            <Pressable onPress={attach} hitSlop={8} style={styles.iconBtn}>
              <Ionicons name="attach" size={24} color={colors.primary} />
            </Pressable>
            <TextInput style={styles.input} value={text} onChangeText={onChangeText} placeholder="Message" placeholderTextColor={colors.muted} multiline maxLength={4000} />
            <Pressable onPress={send} disabled={!text.trim()} style={[styles.sendBtn, !text.trim() && { opacity: 0.4 }]}>
              <Ionicons name="send" size={18} color="#fff" />
            </Pressable>
          </View>
        </View>
      )}

      <Modal visible={Boolean(selected)} transparent animationType="fade" onRequestClose={closeMenu}>
        <Pressable style={styles.backdrop} onPress={closeMenu}>
          {selected ? (
            <View style={styles.menu}>
              {!selected.deleted && isMember ? (
                <View style={styles.reactRow}>
                  {REACTIONS.map((e) => (
                    <Pressable key={e} onPress={() => { void react(target, selected, e); closeMenu(); }} style={[styles.reactBtn, selected.myReaction === e && { backgroundColor: "#E7E6FF" }]}>
                      <Text style={{ fontSize: 26 }}>{e}</Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}
              {!selected.deleted && canSend ? <MenuItem icon="arrow-undo" label="Reply" onPress={() => { setReplyTo(selected); closeMenu(); }} /> : null}
              {!selected.deleted && selected.tick !== "pending" && selected.tick !== "failed" ? (
                <MenuItem icon="arrow-redo" label="Forward" onPress={() => { closeMenu(); router.push({ pathname: "/forward", params: { messageId: selected.id } }); }} />
              ) : null}
              {isGroup && selected.fromMe && !selected.deleted ? (
                <MenuItem icon="information-circle-outline" label="Info" onPress={() => { closeMenu(); router.push(`/message-info/${selected.id}`); }} />
              ) : null}
              {!selected.deleted && isMember && (selected.fromMe || (isGroup && amAdmin)) ? (
                <MenuItem
                  icon="trash"
                  label={selected.fromMe ? "Delete for everyone" : "Delete for everyone (admin)"}
                  danger
                  onPress={async () => {
                    const m = selected;
                    closeMenu();
                    const res = await deleteForEveryone(target, m);
                    if (res && !res.ok) Alert.alert("Could not delete", res.error.message);
                  }}
                />
              ) : null}
              <MenuItem icon="trash-outline" label="Delete for me" danger onPress={() => { void deleteForMe(selected); closeMenu(); }} />
            </View>
          ) : null}
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
  );
}

/** Shown while typing "@…" in a group: tap a member to complete the mention. */
function MentionSuggestions({ text, members, myId, onPick }: { text: string; members: GroupMemberRow[]; myId: string; onPick: (username: string) => void }) {
  const q = /@([a-z0-9_.]*)$/i.exec(text)?.[1]?.toLowerCase();
  if (q === undefined) return null;
  const matches = members.filter((m) => m.id !== myId && m.username.startsWith(q)).slice(0, 5);
  if (!matches.length) return null;
  return (
    <View style={styles.mentions}>
      {matches.map((m) => (
        <Pressable key={m.id} onPress={() => onPick(m.username)} style={styles.mentionRow}>
          <Avatar name={m.username} url={m.avatarUrl} cacheKey={m.avatarFileId} size={24} />
          <Text style={{ color: colors.text }}>@{m.username}</Text>
          {m.displayName ? <Text style={{ color: colors.muted }}>{m.displayName}</Text> : null}
        </Pressable>
      ))}
    </View>
  );
}

function MenuItem({ icon, label, onPress, danger }: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void; danger?: boolean }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.menuItem, pressed && { backgroundColor: "#F1F2F6" }]}>
      <Ionicons name={icon} size={18} color={danger ? colors.danger : colors.text} />
      <Text style={{ fontSize: 16, color: danger ? colors.danger : colors.text }}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  headerName: { fontSize: 16, fontWeight: "700", color: colors.text },
  headerSub: { fontSize: 12, color: colors.muted },
  composer: { backgroundColor: colors.card, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: space(2), paddingHorizontal: space(2), gap: space(2) },
  inputRow: { flexDirection: "row", alignItems: "flex-end", gap: space(2) },
  iconBtn: { height: 40, justifyContent: "center", paddingHorizontal: space(1) },
  input: { flex: 1, minHeight: 40, maxHeight: 120, borderRadius: radius.lg, backgroundColor: colors.bg, paddingHorizontal: space(3), paddingTop: 10, paddingBottom: 10, fontSize: 16, color: colors.text },
  sendBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
  replyBar: { flexDirection: "row", alignItems: "center", gap: space(2), borderLeftWidth: 3, borderLeftColor: colors.primary, backgroundColor: colors.bg, borderRadius: radius.sm, padding: space(2) },
  replyLabel: { fontSize: 12, fontWeight: "700", color: colors.primary },
  replyText: { fontSize: 13, color: colors.muted },
  notice: { alignItems: "center", padding: space(3), backgroundColor: colors.card, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  noticeText: { color: colors.muted, textAlign: "center" },
  mentions: { backgroundColor: colors.bg, borderRadius: radius.md, paddingVertical: space(1) },
  mentionRow: { flexDirection: "row", alignItems: "center", gap: space(2), paddingHorizontal: space(3), paddingVertical: space(2) },
  backdrop: { flex: 1, backgroundColor: "rgba(10,12,20,0.35)", justifyContent: "center", padding: space(6) },
  menu: { backgroundColor: colors.card, borderRadius: radius.lg, paddingVertical: space(2), overflow: "hidden" },
  reactRow: { flexDirection: "row", justifyContent: "space-around", paddingHorizontal: space(2), paddingBottom: space(2), borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  reactBtn: { padding: space(1), borderRadius: radius.pill },
  menuItem: { flexDirection: "row", alignItems: "center", gap: space(3), paddingHorizontal: space(4), paddingVertical: space(3) },
});
