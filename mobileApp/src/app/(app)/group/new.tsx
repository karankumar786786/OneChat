import { useLayoutEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useNavigation, useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { api, unwrap, ApiError } from "@/api/client";
import { getDb } from "@/db";
import { saveGroup } from "@/db/groups";
import { emitDbChange } from "@/db/changes";
import { uploadFile } from "@/files/upload";
import { MemberPicker } from "@/ui/MemberPicker";
import { Avatar, Button, Field } from "@/ui/components";
import { colors, radius, space } from "@/ui/theme";

/** Step 1: pick people. Step 2: name, description and icon. Also: join with an invite code. */
export default function NewGroup() {
  const [step, setStep] = useState<1 | 2>(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState<{ uri: string; name: string; mime: string; size: number } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const navigation = useNavigation();
  const router = useRouter();

  useLayoutEffect(() => {
    navigation.setOptions({
      title: step === 1 ? "New group" : "Group details",
      headerRight: () =>
        step === 1 ? (
          <Pressable disabled={selected.size === 0} onPress={() => setStep(2)} hitSlop={10}>
            <Text style={{ color: selected.size ? colors.accent : colors.muted, fontWeight: "700", fontSize: 16 }}>
              Next{selected.size ? ` (${selected.size})` : ""}
            </Text>
          </Pressable>
        ) : null,
    });
  }, [navigation, step, selected]);

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  async function pickIcon() {
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsEditing: true, aspect: [1, 1], quality: 0.8 });
    const a = r.assets?.[0];
    if (!r.canceled && a) setIcon({ uri: a.uri, name: a.fileName ?? "group.jpg", mime: a.mimeType ?? "image/jpeg", size: a.fileSize ?? 0 });
  }

  async function create() {
    setBusy(true);
    try {
      const avatarFileId = icon ? (await uploadFile(icon, "avatar")).id : null;
      const group = await unwrap(
        api.POST("/groups", { body: { name: name.trim(), description: description.trim() || null, avatarFileId, memberIds: [...selected] } }),
      );
      await saveGroup(getDb(), group);
      emitDbChange([group.id]);
      router.replace(`/chat/${group.id}`);
    } catch (e) {
      Alert.alert("Could not create the group", e instanceof ApiError ? e.message : "Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (step === 1) {
    return (
      <MemberPicker
        selected={selected}
        onToggle={toggle}
        header={
          <View style={styles.joinBox}>
            <Text style={styles.joinLabel}>Have an invite code?</Text>
            <View style={{ flexDirection: "row", gap: space(2), alignItems: "center" }}>
              <View style={{ flex: 1 }}>
                <Field value={code} onChangeText={(t) => setCode(t.trim())} placeholder="Paste code or link" autoCapitalize="none" autoCorrect={false} />
              </View>
              <Button
                title="Open"
                variant="ghost"
                disabled={code.length < 8}
                onPress={() => router.push(`/join/${encodeURIComponent(code.split("/").pop() ?? code)}`)}
              />
            </View>
          </View>
        }
      />
    );
  }

  return (
    <ScrollView contentContainerStyle={{ padding: space(4), gap: space(4) }} keyboardShouldPersistTaps="handled">
      <Pressable onPress={pickIcon} style={{ alignItems: "center", gap: space(2) }}>
        <Avatar name={name || "?"} url={icon?.uri} size={84} group />
        <Text style={{ color: colors.accent }}>{icon ? "Change icon" : "Add group icon"}</Text>
      </Pressable>
      <Field label="Group name" value={name} onChangeText={setName} placeholder="e.g. Weekend trip" maxLength={100} autoFocus />
      <Field label="Description (optional)" value={description} onChangeText={setDescription} placeholder="What is this group about?" maxLength={512} multiline style={{ height: 80, paddingTop: 12 }} />
      <Text style={styles.note}>{selected.size} participant{selected.size === 1 ? "" : "s"} plus you. You will be the group admin.</Text>
      <Button title="Create group" onPress={create} loading={busy} disabled={!name.trim()} />
      <Button title="Back to participants" variant="ghost" onPress={() => setStep(1)} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  joinBox: { backgroundColor: colors.card, borderRadius: radius.md, padding: space(3), gap: space(2) },
  joinLabel: { fontSize: 13, fontWeight: "700", color: colors.muted },
  note: { color: colors.muted, textAlign: "center" },
});
