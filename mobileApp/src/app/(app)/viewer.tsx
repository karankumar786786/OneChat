import { Pressable, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";

/** Full-screen photo: profile pictures, group icons and image messages. */
export default function Viewer() {
  const { url, cacheKey, title } = useLocalSearchParams<{ url: string; cacheKey?: string; title?: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.screen}>
      <Image source={{ uri: url, cacheKey: cacheKey || undefined }} style={StyleSheet.absoluteFill} contentFit="contain" />
      <View style={[styles.bar, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="close" size={28} color="#fff" />
        </Pressable>
        {title ? <Text style={styles.title} numberOfLines={1}>{title}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000" },
  bar: { position: "absolute", left: 0, right: 0, top: 0, flexDirection: "row", alignItems: "center", gap: 16, paddingHorizontal: 16, paddingBottom: 12, backgroundColor: "rgba(0,0,0,0.35)" },
  title: { color: "#fff", fontSize: 17, lineHeight: 23, fontWeight: "600", flexShrink: 1 },
});
