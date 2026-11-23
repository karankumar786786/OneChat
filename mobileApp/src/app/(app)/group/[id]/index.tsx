import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Share, StyleSheet, Switch, Text, View } from "react-native";
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
import type { GroupMemberRow } from "@/db/types";

export default function GroupInfo() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [group] = useGroup(id);
  const myId = useAuth((s) => s.me?.id ?? "");
  const router = useRouter();
  const members = membersOf(group);
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
      Alert.alert("Could not update the group", e instanceof ApiError ? e.message : "Check your connection and try again.");
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

  function memberActions(m: GroupMemberRow) {
    if (m.id === myId) return;
    const label = m.displayName || `@${m.username}`;
    const buttons: { text: string; style?: "destructive" | "cancel"; onPress?: () => void }[] = [
      { text: `Message ${label}`, onPress: () => router.push(`/chat/${m.id}`) },
    ];
    if (isAdmin && isMember && !m.isCreator) {
      buttons.push(
        m.role === "admin"
          ? { text: "Dismiss as admin", onPress: () => void run(() => unwrap(api.DELETE("/groups/{id}/admins/{userId}", { params: { path: { id, userId: m.id } } }))) }
          : { text: "Make group admin", onPress: () => void run(() => unwrap(api.POST("/groups/{id}/admins/{userId}", { params: { path: { id, userId: m.id } } }))) },
        {
          text: `Remove ${label}`,
          style: "destructive",
          onPress: () => void run(async () => void (await api.DELETE("/groups/{id}/members/{userId}", { params: { path: { id, userId: m.id } } }))),
        },
      );
    }
    buttons.push({ text: "Cancel", style: "cancel" });
    Alert.alert(label, undefined, buttons);
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
        <Pressable disabled={!canEdit} onPress={changeIcon} style={{ alignItems: "center", gap: space(2) }}>
          <Avatar name={group.name} url={group.avatarUrl} cacheKey={group.avatarFileId} size={96} group />
          {canEdit ? <Text style={{ color: colors.primary }}>Change group icon</Text> : null}
        </Pressable>
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
            <Switch value={group.onlyAdminsCanSend === 1} onValueChange={(v) => void run(() => unwrap(api.PATCH("/groups/{id}/settings", { ...path, body: { onlyAdminsCanSend: v } })))} />
          </Row>
          <Row label="Only admins can edit group info">
            <Switch value={group.onlyAdminsCanEditInfo === 1} onValueChange={(v) => void run(() => unwrap(api.PATCH("/groups/{id}/settings", { ...path, body: { onlyAdminsCanEditInfo: v } })))} />
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
          <Pressable style={styles.member} onPress={() => router.push(`/group/${id}/add`)}>
            <View style={styles.addIcon}>
              <Ionicons name="person-add" size={18} color="#fff" />
            </View>
            <Text style={{ color: colors.primary, fontWeight: "600", fontSize: 16 }}>Add participants</Text>
          </Pressable>
        ) : null}
        {members.map((m) => (
          <Pressable key={m.id} style={styles.member} onPress={() => memberActions(m)}>
            <Avatar name={m.username} url={m.avatarUrl} cacheKey={m.avatarFileId} size={40} />
            <View style={{ flex: 1 }}>
              <Text style={styles.memberName}>{m.id === myId ? "You" : m.displayName || `@${m.username}`}</Text>
              {m.displayName && m.id !== myId ? <Text style={styles.muted}>@{m.username}</Text> : null}
            </View>
            {m.role === "admin" ? <Text style={styles.badge}>Group admin</Text> : null}
          </Pressable>
        ))}
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
  title: { fontSize: 22, fontWeight: "700", color: colors.text, marginTop: space(2) },
  muted: { color: colors.muted, fontSize: 13 },
  section: { fontSize: 13, fontWeight: "700", color: colors.muted, textTransform: "uppercase" },
  row: { flexDirection: "row", alignItems: "center", gap: space(3) },
  link: { color: colors.primary, fontSize: 14 },
  member: { flexDirection: "row", alignItems: "center", gap: space(3), paddingHorizontal: space(4), paddingVertical: space(2.5) },
  memberName: { fontSize: 16, fontWeight: "600", color: colors.text },
  badge: { fontSize: 11, color: colors.primary, borderWidth: 1, borderColor: colors.primary, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, overflow: "hidden" },
  addIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
});
