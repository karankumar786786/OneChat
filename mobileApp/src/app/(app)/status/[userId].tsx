import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Animated, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { useVideoPlayer, VideoView } from "expo-video";
import { Ionicons } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useAuth } from "@/auth/store";
import { useMyStatuses, useStatusFeed } from "@/status/queries";
import { Avatar } from "@/ui/components";
import { space } from "@/ui/theme";
import { timeLabel } from "@/lib/format";
import type { Schemas } from "@/api/client";

type AnyStatus = Schemas["Status"] & { viewedByMe?: boolean; myReaction?: string | null; viewCount?: number; commentCount?: number };

const PHOTO_MS = 5000;
const VIDEO_MAX_MS = 30_000;
const QUICK = ["❤️", "😂", "😮", "😢", "👏", "🔥"];

export default function StatusViewer() {
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const me = useAuth((s) => s.me!);
  const isMine = userId === me.id;
  const feed = useStatusFeed();
  const mine = useMyStatuses();
  const router = useRouter();
  const qc = useQueryClient();
  const insets = useSafeAreaInsets();

  const entry = feed.data?.find((e) => e.user.id === userId);
  const statuses: AnyStatus[] = useMemo(() => (isMine ? (mine.data ?? []) : (entry?.statuses ?? [])), [isMine, mine.data, entry]);
  const owner = isMine ? me : entry?.user;

  // Start at the first unviewed status.
  const [index, setIndex] = useState(() => Math.max(0, statuses.findIndex((s) => !s.viewedByMe)));
  const [paused, setPaused] = useState(false);
  const [comment, setComment] = useState("");
  const progress = useRef(new Animated.Value(0)).current;
  const viewed = useRef(new Set<string>());
  const current = statuses[index];

  const next = () => (index < statuses.length - 1 ? setIndex(index + 1) : router.back());
  const prev = () => setIndex(Math.max(0, index - 1));

  // Log the view once per status.
  useEffect(() => {
    if (!current || isMine || current.viewedByMe || viewed.current.has(current.id)) return;
    viewed.current.add(current.id);
    void api.POST("/statuses/{id}/view", { params: { path: { id: current.id } } });
  }, [current, isMine]);

  useEffect(() => () => void qc.invalidateQueries({ queryKey: ["statusFeed"] }), [qc]);

  // Progress bar timer.
  useEffect(() => {
    if (!current || paused) return;
    progress.setValue(0);
    const anim = Animated.timing(progress, {
      toValue: 1,
      duration: current.type === "video" ? VIDEO_MAX_MS : PHOTO_MS,
      useNativeDriver: false,
    });
    anim.start(({ finished }) => finished && next());
    return () => anim.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, paused]);

  if (!current || !owner) {
    return (
      <View style={[styles.screen, { justifyContent: "center", alignItems: "center" }]}>
        <Text style={styles.white}>{feed.isLoading || mine.isLoading ? "Loading…" : "No status to show"}</Text>
      </View>
    );
  }

  async function sendReaction(emoji: string) {
    await api.POST("/statuses/{id}/react", { params: { path: { id: current!.id } }, body: { emoji: current!.myReaction === emoji ? null : emoji } });
    void qc.invalidateQueries({ queryKey: ["statusFeed"] });
  }

  async function sendComment() {
    const text = comment.trim();
    if (!text) return;
    setComment("");
    const { error } = await api.POST("/statuses/{id}/comments", { params: { path: { id: current!.id } }, body: { text } });
    if (error) Alert.alert("Could not send", "Try again.");
    else Alert.alert("Sent", "Only the owner can see your comment.");
    setPaused(false);
  }

  async function remove() {
    await api.DELETE("/statuses/{id}", { params: { path: { id: current!.id } } });
    await qc.invalidateQueries({ queryKey: ["myStatuses"] });
    if (statuses.length <= 1) router.back();
    else setIndex(Math.max(0, index - 1));
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={[styles.content, current.type === "text" && { backgroundColor: current.bg ?? "#4169E1" }]}>
        {current.type === "text" ? <Text style={styles.bigText}>{current.text}</Text> : null}
        {current.type === "image" && current.media?.url ? (
          <Image source={{ uri: current.media.url, cacheKey: current.media.fileId }} style={StyleSheet.absoluteFill} contentFit="contain" />
        ) : null}
        {current.type === "video" && current.media?.url ? <StatusVideo key={current.id} url={current.media.url} onEnd={next} /> : null}
        {current.type !== "text" && current.text ? <Text style={[styles.caption, { bottom: insets.bottom + 110 }]}>{current.text}</Text> : null}
      </View>

      {/* Tap zones */}
      <View style={[StyleSheet.absoluteFill, { flexDirection: "row", top: 100, bottom: 140 }]}>
        <Pressable style={{ flex: 1 }} onPress={prev} onLongPress={() => setPaused(true)} onPressOut={() => setPaused(false)} />
        <Pressable style={{ flex: 2 }} onPress={next} onLongPress={() => setPaused(true)} onPressOut={() => setPaused(false)} />
      </View>

      <View style={[styles.top, { paddingTop: insets.top + space(2) }]}>
        <View style={styles.bars}>
          {statuses.map((s, i) => (
            <View key={s.id} style={styles.barTrack}>
              <Animated.View
                style={[
                  styles.barFill,
                  { width: i < index ? "100%" : i === index ? progress.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }) : "0%" },
                ]}
              />
            </View>
          ))}
        </View>
        <View style={styles.header}>
          <Avatar name={owner.username} url={owner.avatarUrl} cacheKey={owner.avatarFileId} size={36} />
          <View style={{ flex: 1 }}>
            <Text style={styles.white}>{isMine ? "My status" : owner.displayName || `@${owner.username}`}</Text>
            <Text style={styles.dim}>{timeLabel(current.createdAt)}</Text>
          </View>
          {isMine ? (
            <Pressable onPress={remove} hitSlop={10}>
              <Ionicons name="trash-outline" size={22} color="#fff" />
            </Pressable>
          ) : null}
          <Pressable onPress={() => router.back()} hitSlop={10}>
            <Ionicons name="close" size={26} color="#fff" />
          </Pressable>
        </View>
      </View>

      <View style={[styles.bottom, { paddingBottom: insets.bottom + space(3) }]}>
        {isMine ? (
          <Pressable style={styles.viewsBtn} onPress={() => router.push(`/status/mine/${current.id}`)}>
            <Ionicons name="eye" size={18} color="#fff" />
            <Text style={styles.white}>
              {current.viewCount ?? 0} views · {current.commentCount ?? 0} comments
            </Text>
          </Pressable>
        ) : (
          <>
            <View style={styles.quick}>
              {QUICK.map((e) => (
                <Pressable key={e} onPress={() => sendReaction(e)} style={[styles.quickBtn, current.myReaction === e && styles.quickActive]}>
                  <Text style={{ fontSize: 24 }}>{e}</Text>
                </Pressable>
              ))}
            </View>
            <View style={styles.commentRow}>
              <TextInput
                keyboardAppearance="dark"
                style={styles.commentInput}
                value={comment}
                onChangeText={setComment}
                onFocus={() => setPaused(true)}
                onBlur={() => setPaused(false)}
                placeholder="Comment privately…"
                placeholderTextColor="rgba(255,255,255,0.6)"
                maxLength={500}
                onSubmitEditing={sendComment}
                returnKeyType="send"
              />
              <Pressable onPress={sendComment} hitSlop={8}>
                <Ionicons name="send" size={22} color="#fff" />
              </Pressable>
            </View>
          </>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

function StatusVideo({ url, onEnd }: { url: string; onEnd: () => void }) {
  const player = useVideoPlayer(url, (p) => {
    p.loop = false;
    p.play();
  });
  useEffect(() => {
    const sub = player.addListener("playToEnd", onEnd);
    return () => sub.remove();
  }, [player, onEnd]);
  return <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="contain" nativeControls={false} />;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000" },
  content: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", padding: space(8) },
  bigText: { color: "#fff", fontSize: 30, fontWeight: "700", textAlign: "center" },
  caption: { position: "absolute", left: space(4), right: space(4), color: "#fff", fontSize: 16, textAlign: "center", backgroundColor: "rgba(0,0,0,0.45)", padding: space(2), borderRadius: 10, overflow: "hidden" },
  top: { position: "absolute", left: 0, right: 0, top: 0, paddingHorizontal: space(3), gap: space(3) },
  bars: { flexDirection: "row", gap: 4 },
  barTrack: { flex: 1, height: 3, borderRadius: 2, backgroundColor: "rgba(255,255,255,0.35)", overflow: "hidden" },
  barFill: { height: 3, backgroundColor: "#fff" },
  header: { flexDirection: "row", alignItems: "center", gap: space(3) },
  white: { color: "#fff", fontSize: 15, fontWeight: "600" },
  dim: { color: "rgba(255,255,255,0.75)", fontSize: 12 },
  bottom: { position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: space(4), gap: space(3) },
  quick: { flexDirection: "row", justifyContent: "space-around" },
  quickBtn: { padding: space(1), borderRadius: 999 },
  quickActive: { backgroundColor: "rgba(255,255,255,0.25)" },
  commentRow: { flexDirection: "row", alignItems: "center", gap: space(3), borderWidth: 1, borderColor: "rgba(255,255,255,0.5)", borderRadius: 999, paddingHorizontal: space(4), height: 46 },
  commentInput: { flex: 1, color: "#fff", fontSize: 15 },
  viewsBtn: { flexDirection: "row", alignItems: "center", alignSelf: "center", gap: space(2), backgroundColor: "rgba(255,255,255,0.18)", paddingHorizontal: space(4), paddingVertical: space(2), borderRadius: 999 },
});
