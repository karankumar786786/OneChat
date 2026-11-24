import { useCallback, useEffect, useState } from "react";
import { ActionSheetIOS, Alert, Platform, Pressable, ScrollView, Share, StyleSheet, Switch, Text, View } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import * as Linking from "expo-linking";
import { Ionicons } from "@expo/vector-icons";
import { api, unwrap, ApiError } from "@/api/client";
import { useAuth } from "@/auth/store";
import { getDb } from "@/db";
import { markNotMember, membersOf, saveGroup, type GroupFromApi } from "@/db/groups";
import { deleteChat } from "@/db/queries";
import { emitDbChange } from "@/db/changes";
import { useGroup } from "@/db/hooks";
import { loadGroup } from "@/realtime/socket";
import { uploadFile } from "@/files/upload";
import { Avatar, Button, Field } from "@/ui/components";
import { colors, radius, space } from "@/ui/theme";
import { openImage } from "@/ui/openImage";
import { uploadErrorMessage } from "@/profile/photo";
import type { GroupMemberRow } from "@/db/types";

export default function GroupInfo() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [group] = useGroup(id);
  const myId = useAuth((s) => s.me?.id ?? "");
  const router = useRouter();
  const members = membersOf(group);
  // You first, then admins, then everyone else by name (as WhatsApp lists them).
  const sortedMembers = [...members].sort((a, b) => {
    if (a.id === myId) return -1;
    if (b.id === myId) return 1;
    if (a.role !== b.role) return a.role === "admin" ? -1 : 1;
    return (a.displayName || a.username).localeCompare(b.displayName || b.username);
  });
  const isAdmin = group?.myRole === "admin";
  const isMember = group?.isMember === 1;
  const canEdit = isMember && (isAdmin || group?.onlyAdminsCanEditInfo === 0);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [invite, setInvite] = useState<string | null>(null);

  useFocusEffect(useCallback(() => void loadGroup(id), [id]));
  useEffect(() => {
    setName(group?.name ?? "");
    setDescription(group?.description ?? "");
  }, [group?.name, group?.description]);

  /** Runs a group API call; the response (full group details) refreshes the local copy. */
  async function run(call: () => Promise<GroupFromApi | void>) {
    try {
      const updated = await call();
      if (updated) await saveGroup(getDb(), updated);
      else await loadGroup(id);
      emitDbChange([id]);
    } catch (e) {
      Alert.alert("Could not update the group", e instanceof ApiError ? uploadErrorMessage(e) : "Check your connection and try again.");
    }
  }

  const path = { params: { path: { id } } };

  async function changeIcon() {
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsEditing: true, aspect: [1, 1], quality: 0.8 });
    const a = r.assets?.[0];
    if (r.canceled || !a) return;
    await run(async () => {
      const file = await uploadFile({ uri: a.uri, name: a.fileName ?? "group.jpg", mime: a.mimeType ?? "image/jpeg", size: a.fileSize ?? 0 }, "avatar");
      return unwrap(api.PATCH("/groups/{id}", { ...path, body: { avatarFileId: file.id } }));
    });
  }

  async function showInvite(reset = false) {
    try {
      const { code } = await unwrap(reset ? api.POST("/groups/{id}/invite/reset", path) : api.GET("/groups/{id}/invite", path));
      setInvite(code);
    } catch (e) {
      Alert.alert("Invite link", e instanceof ApiError ? e.message : "Could not load the link");
    }
  }

  const inviteUrl = invite ? Linking.createURL(`/join/${invite}`) : null;

  /** WhatsApp-style action sheet for a participant. Admin actions only appear for admins. */
  function memberActions(m: GroupMemberRow) {
    if (m.id === myId) return router.push(`/user/${m.id}`);
    const label = m.displayName || `@${m.username}`;
    const memberPath = { params: { path: { id, userId: m.id } } };
    const actions: { text: string; destructive?: boolean; run: () => void }[] = [
      { text: `Message ${label}`, run: () => router.push(`/chat/${m.id}`) },
      { text: `View ${label}`, run: () => router.push(`/user/${m.id}`) },
    ];
    if (isAdmin && isMember && !m.isCreator) {
      actions.push(
        m.role === "admin"
          ? { text: "Dismiss as admin", run: () => void run(() => unwrap(api.DELETE("/groups/{id}/admins/{userId}", memberPath))) }
          : { text: "Make group admin", run: () => void run(() => unwrap(api.POST("/groups/{id}/admins/{userId}", memberPath))) },
        {
          text: `Remove ${label}`,
          destructive: true,
          run: () =>
            Alert.alert(`Remove ${label} from "${group?.name}"?`, undefined, [
              { text: "Cancel", style: "cancel" },
              {
                text: "Remove",
                style: "destructive",
                onPress: () => void run(async () => void (await unwrap(api.DELETE("/groups/{id}/members/{userId}", memberPath)))),
              },
            ]),
        },
      );
    }
    if (Platform.OS === "ios") {
      const options = [...actions.map((a) => a.text), "Cancel"];
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: label,
          options,
          cancelButtonIndex: options.length - 1,
          destructiveButtonIndex: actions.findIndex((a) => a.destructive),
          userInterfaceStyle: "dark",
        },
        (i) => actions[i]?.run(),
      );
    } else {
      Alert.alert(label, undefined, [
        ...actions.map((a) => ({ text: a.text, style: a.destructive ? ("destructive" as const) : undefined, onPress: a.run })),
        { text: "Cancel", style: "cancel" as const },
      ]);
    }
  }

  async function shareInvite() {
    try {
      const { code } = await unwrap(api.GET("/groups/{id}/invite", path));
      setInvite(code);
      const url = Linking.createURL(`/join/${code}`);
      await Share.share({ message: `Join my group "${group?.name}": ${url}` });
    } catch (e) {
      Alert.alert("Invite link", e instanceof ApiError ? e.message : "Could not load the link");
    }
  }

  function exitGroup() {
    Alert.alert("Exit group?", "You will stop receiving messages from this group.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Exit group",
        style: "destructive",
        onPress: async () => {
          const res = await api.POST("/groups/{id}/leave", path);
          if (!res.response.ok) return Alert.alert("Could not leave", "Try again.");
          await markNotMember(getDb(), id);
          emitDbChange([id]);
        },
      },
    ]);
  }

  if (!group) return <View style={{ flex: 1 }} />;
  const muted = Boolean(group.mutedUntil && new Date(group.mutedUntil) > new Date());

  return (
    <ScrollView contentContainerStyle={{ padding: space(4), gap: space(4), paddingBottom: space(12) }}>
      <View style={[styles.card, { alignItems: "center" }]}>
        <Pressable
          disabled={!group.avatarUrl && !canEdit}
          onPress={() => (group.avatarUrl ? openImage(group.avatarUrl, { cacheKey: group.avatarFileId, title: group.name }) : changeIcon())}
        >
          <Avatar name={group.name} url={group.avatarUrl} cacheKey={group.avatarFileId} size={96} group />
        </Pressable>
        {canEdit ? (
          <Pressable onPress={changeIcon}>
            <Text style={{ color: colors.accent }}>{group.avatarUrl ? "Change group icon" : "Add group icon"}</Text>
          </Pressable>
        ) : null}
        <Text style={styles.title}>{group.name}</Text>
        <Text style={styles.muted}>Group · {members.length} participants</Text>
      </View>

      {canEdit ? (
        <View style={styles.card}>
          <Field label="Group name" value={name} onChangeText={setName} maxLength={100} />
          <Field label="Description" value={description} onChangeText={setDescription} maxLength={512} multiline style={{ height: 72, paddingTop: 12 }} placeholder="Add group description" />
          <Button
            title="Save"
            disabled={!name.trim() || (name === group.name && description === (group.description ?? ""))}
            onPress={() => void run(() => unwrap(api.PATCH("/groups/{id}", { ...path, body: { name: name.trim(), description: description.trim() || null } })))}
          />
        </View>
      ) : group.description ? (
        <View style={styles.card}>
          <Text style={styles.section}>Description</Text>
          <Text style={{ color: colors.text }}>{group.description}</Text>
        </View>
      ) : null}

      {isMember ? (
        <View style={styles.card}>
          <Row label="Mute notifications" hint="@mentions still notify you">
            <Switch
              trackColor={{ true: colors.primary, false: colors.border }}
              value={muted}
              onValueChange={(on) =>
                void run(async () => {
                  const until = on ? new Date(Date.now() + 365 * 86_400_000).toISOString() : null;
                  const summary = await unwrap(api.PUT("/groups/{id}/mute", { ...path, body: { until } }));
                  await getDb().run("UPDATE groups SET mutedUntil = ? WHERE id = ?", [summary.mutedUntil, id]);
                })
              }
            />
          </Row>
        </View>
      ) : null}

      {isAdmin && isMember ? (
        <View style={styles.card}>
          <Text style={styles.section}>Group settings (admins)</Text>
          <Row label="Only admins can send messages">
            <Switch trackColor={{ true: colors.primary, false: colors.border }} value={group.onlyAdminsCanSend === 1} onValueChange={(v) => void run(() => unwrap(api.PATCH("/groups/{id}/settings", { ...path, body: { onlyAdminsCanSend: v } })))} />
          </Row>
          <Row label="Only admins can edit group info">
            <Switch trackColor={{ true: colors.primary, false: colors.border }} value={group.onlyAdminsCanEditInfo === 1} onValueChange={(v) => void run(() => unwrap(api.PATCH("/groups/{id}/settings", { ...path, body: { onlyAdminsCanEditInfo: v } })))} />
          </Row>
          <Text style={styles.section}>Invite via link</Text>
          {inviteUrl ? (
            <>
              <Text selectable style={styles.link}>{inviteUrl}</Text>
              <Text style={styles.muted}>Invite code: {invite}</Text>
              <View style={{ flexDirection: "row", gap: space(2) }}>
                <Button title="Share link" style={{ flex: 1 }} onPress={() => void Share.share({ message: `Join my group "${group.name}": ${inviteUrl}` })} />
                <Button
                  title="Reset"
                  variant="danger"
                  onPress={() =>
                    Alert.alert("Reset link?", "The current link will stop working.", [
                      { text: "Cancel", style: "cancel" },
                      { text: "Reset link", style: "destructive", onPress: () => void showInvite(true) },
                    ])
                  }
                />
              </View>
            </>
          ) : (
            <Button title="Show invite link" variant="ghost" onPress={() => void showInvite()} />
          )}
        </View>
      ) : null}

      <View style={[styles.card, { paddingHorizontal: 0 }]}>
        <Text style={[styles.section, { paddingHorizontal: space(4) }]}>{members.length} participants</Text>
        {isAdmin && isMember ? (
          <>
            <Pressable style={styles.member} onPress={() => router.push(`/group/${id}/add`)} accessibilityRole="button">
              <View style={styles.addIcon}>
                <Ionicons name="person-add" size={18} color="#fff" />
              </View>
              <Text style={styles.actionText}>Add participants</Text>
            </Pressable>
            <Pressable style={styles.member} onPress={shareInvite} accessibilityRole="button">
              <View style={styles.addIcon}>
                <Ionicons name="link" size={18} color="#fff" />
              </View>
              <Text style={styles.actionText}>Invite via link</Text>
            </Pressable>
          </>
        ) : isMember ? (
          <Text style={[styles.muted, { paddingHorizontal: space(4) }]}>
            Only group admins can add or remove participants and change admins.
          </Text>
        ) : null}
        {sortedMembers.map((m) => {
          const label = m.id === myId ? "You" : m.displayName || `@${m.username}`;
          const manageable = isAdmin && isMember && m.id !== myId;
          return (
            <Pressable
              key={m.id}
              style={({ pressed }) => [styles.member, pressed && { backgroundColor: colors.pressed }]}
              onPress={() => memberActions(m)}
              accessibilityRole="button"
              accessibilityLabel={`${label}${m.role === "admin" ? ", group admin" : ""}`}
              accessibilityHint={manageable ? "Opens actions: message, view, admin, remove" : "Opens options"}
            >
              <Avatar name={m.displayName || m.username} url={m.avatarUrl} cacheKey={m.avatarFileId} size={40} />
              <View style={{ flex: 1 }}>
                <Text style={styles.memberName} numberOfLines={1}>{label}</Text>
                <Text style={styles.muted} numberOfLines={1}>@{m.username}</Text>
              </View>
              <View style={{ alignItems: "flex-end", gap: 4 }}>
                {m.role === "admin" ? <Text style={styles.badge}>Group admin</Text> : null}
                {m.isCreator ? <Text style={styles.creator}>Creator</Text> : null}
              </View>
              {manageable ? <Ionicons name="ellipsis-horizontal" size={20} color={colors.muted} /> : null}
            </Pressable>
          );
        })}
      </View>

      {isMember ? (
        <Button title="Exit group" variant="danger" onPress={exitGroup} />
      ) : (
        <>
          <Text style={[styles.muted, { textAlign: "center" }]}>You're no longer a participant in this group.</Text>
          <Button
            title="Delete group"
            variant="danger"
            onPress={() => void deleteChat(getDb(), id).then(() => { emitDbChange([id]); router.dismissAll(); })}
          />
        </>
      )}
    </ScrollView>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <View style={styles.row}>
      <View style={{ flex: 1 }}>
        <Text style={{ color: colors.text, fontSize: 15 }}>{label}</Text>
        {hint ? <Text style={styles.muted}>{hint}</Text> : null}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: space(4), gap: space(3) },
  title: { fontSize: 22, lineHeight: 30, fontWeight: "700", color: colors.text, marginTop: space(2) },
  muted: { color: colors.muted, fontSize: 13 },
  section: { fontSize: 13, fontWeight: "700", color: colors.muted, textTransform: "uppercase" },
  row: { flexDirection: "row", alignItems: "center", gap: space(3) },
  link: { color: colors.accent, fontSize: 14 },
  member: { flexDirection: "row", alignItems: "center", gap: space(3), paddingHorizontal: space(4), paddingVertical: space(2.5) },
  memberName: { fontSize: 16, lineHeight: 22, fontWeight: "600", color: colors.text },
  badge: { fontSize: 11, color: colors.accent, borderWidth: 1, borderColor: colors.accent, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, overflow: "hidden" },
  actionText: { color: colors.accent, fontWeight: "600", fontSize: 16 },
  creator: { fontSize: 11, color: colors.muted },
  addIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
});
