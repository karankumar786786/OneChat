import { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { Image } from "expo-image";
import { useQueryClient } from "@tanstack/react-query";
import { api, unwrap } from "@/api/client";
import { uploadFile, type PickedFile } from "@/files/upload";
import { Button } from "@/ui/components";
import { colors, radius, space } from "@/ui/theme";

const BACKGROUNDS = ["#4169E1", "#0EA5E9", "#10B981", "#F59E0B", "#EF4444", "#EC4899", "#111827"];

export default function NewStatus() {
  const [mode, setMode] = useState<"text" | "media">("text");
  const [text, setText] = useState("");
  const [bg, setBg] = useState(BACKGROUNDS[0]!);
  const [media, setMedia] = useState<(PickedFile & { kind: "image" | "video" }) | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const qc = useQueryClient();

  async function pick() {
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images", "videos"], quality: 0.85, videoMaxDuration: 30 });
    const a = r.assets?.[0];
    if (r.canceled || !a) return;
    const kind = a.type === "video" ? "video" : "image";
    setMedia({ kind, uri: a.uri, name: a.fileName ?? `status.${kind === "video" ? "mp4" : "jpg"}`, mime: a.mimeType ?? (kind === "video" ? "video/mp4" : "image/jpeg"), size: a.fileSize ?? 0 });
    setMode("media");
  }

  async function post() {
    setBusy(true);
    try {
      if (mode === "text") {
        await unwrap(api.POST("/statuses", { body: { type: "text", text: text.trim(), bg } }));
      } else if (media) {
        const file = await uploadFile(media, "status");
        await unwrap(api.POST("/statuses", { body: { type: media.kind, fileId: file.id, text: text.trim() || undefined } }));
      }
      await qc.invalidateQueries({ queryKey: ["myStatuses"] });
      router.back();
    } catch (e) {
      Alert.alert("Could not post", e instanceof Error ? e.message : "Try again");
    } finally {
      setBusy(false);
    }
  }

  const canPost = mode === "text" ? Boolean(text.trim()) : Boolean(media);

  return (
    <ScrollView contentContainerStyle={{ padding: space(4), gap: space(4) }} keyboardShouldPersistTaps="handled">
      <View style={styles.segment}>
        {(["text", "media"] as const).map((m) => (
          <Pressable key={m} style={[styles.segmentBtn, mode === m && styles.segmentActive]} onPress={() => (m === "media" && !media ? pick() : setMode(m))}>
            <Text style={[styles.segmentText, mode === m && { color: "#fff" }]}>{m === "text" ? "Text" : "Photo / video"}</Text>
          </Pressable>
        ))}
      </View>

      {mode === "text" ? (
        <>
          <View style={[styles.preview, { backgroundColor: bg }]}>
            <TextInput keyboardAppearance="dark" style={styles.previewInput} value={text} onChangeText={setText} placeholder="Type a status" placeholderTextColor="rgba(255,255,255,0.7)" multiline maxLength={700} autoFocus />
          </View>
          <View style={styles.swatches}>
            {BACKGROUNDS.map((c) => (
              <Pressable key={c} onPress={() => setBg(c)} style={[styles.swatch, { backgroundColor: c }, bg === c && styles.swatchActive]} />
            ))}
          </View>
        </>
      ) : media ? (
        <>
          <Pressable onPress={pick}>
            {media.kind === "image" ? (
              <Image source={{ uri: media.uri }} style={styles.media} contentFit="cover" />
            ) : (
              <View style={[styles.media, { alignItems: "center", justifyContent: "center", backgroundColor: "#111" }]}>
                <Text style={{ color: "#fff" }}>🎥 {media.name}</Text>
              </View>
            )}
          </Pressable>
          <TextInput keyboardAppearance="dark" style={styles.caption} value={text} onChangeText={setText} placeholder="Add a caption" placeholderTextColor={colors.muted} maxLength={700} />
        </>
      ) : null}

      <Button title="Share status" onPress={post} loading={busy} disabled={!canPost} />
      <Text style={styles.note}>Visible to people you chat with. It disappears after 24 hours.</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  segment: { flexDirection: "row", backgroundColor: colors.card, borderRadius: radius.md, padding: 4 },
  segmentBtn: { flex: 1, height: 38, alignItems: "center", justifyContent: "center", borderRadius: radius.sm },
  segmentActive: { backgroundColor: colors.primary },
  segmentText: { fontWeight: "600", color: colors.text },
  preview: { height: 320, borderRadius: radius.lg, padding: space(6), justifyContent: "center" },
  previewInput: { color: "#fff", fontSize: 26, fontWeight: "700", textAlign: "center" },
  swatches: { flexDirection: "row", justifyContent: "center", gap: space(3) },
  swatch: { width: 32, height: 32, borderRadius: 16 },
  swatchActive: { borderWidth: 3, borderColor: colors.text },
  media: { height: 360, borderRadius: radius.lg, width: "100%" },
  caption: { height: 48, borderRadius: radius.md, backgroundColor: colors.elevated, borderWidth: 1, borderColor: colors.border, paddingHorizontal: space(3), fontSize: 16, color: colors.text },
  note: { textAlign: "center", color: colors.muted, fontSize: 13 },
});
