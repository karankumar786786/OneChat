import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle } from "react-native";
import { colors, radius, space } from "./theme";
import type { Tick } from "../db/types";

export function Avatar({ name, url, cacheKey, size = 44, online, ring, group }: {
  name?: string | null;
  url?: string | null;
  cacheKey?: string | null;
  size?: number;
  online?: boolean;
  ring?: "unseen" | "seen";
  /** Groups without an icon show a people glyph instead of initials. */
  group?: boolean;
}) {
  const initials = (name ?? "?").replace(/^@/, "").slice(0, 2).toUpperCase();
  const ringColor = ring === "unseen" ? colors.ring : ring === "seen" ? colors.ringSeen : "transparent";
  return (
    <View style={{ width: size + 6, height: size + 6, borderRadius: (size + 6) / 2, borderWidth: ring ? 2 : 0, borderColor: ringColor, alignItems: "center", justifyContent: "center" }}>
      {url ? (
        <Image source={{ uri: url, cacheKey: cacheKey ?? undefined }} style={{ width: size, height: size, borderRadius: size / 2 }} />
      ) : (
        <View style={[styles.avatarFallback, { width: size, height: size, borderRadius: size / 2 }]}>
          {group ? (
            <Ionicons name="people" size={size / 2} color={colors.primary} />
          ) : (
            <Text style={{ color: colors.primary, fontWeight: "700", fontSize: size / 2.6 }}>{initials}</Text>
          )}
        </View>
      )}
      {online ? <View style={styles.onlineDot} /> : null}
    </View>
  );
}

export function Ticks({ tick }: { tick: Tick }) {
  if (tick === "pending") return <Text style={styles.tick}>🕓</Text>;
  if (tick === "failed") return <Text style={[styles.tick, { color: colors.danger }]}>!</Text>;
  if (tick === "sent") return <Text style={styles.tick}>✓</Text>;
  if (tick === "delivered") return <Text style={styles.tick}>✓✓</Text>;
  if (tick === "read") return <Text style={[styles.tick, { color: colors.read }]}>✓✓</Text>;
  return null;
}

export function Button({ title, onPress, loading, variant = "primary", style, disabled }: {
  title: string;
  onPress: () => void;
  loading?: boolean;
  variant?: "primary" | "ghost" | "danger";
  style?: ViewStyle;
  disabled?: boolean;
}) {
  const bg = variant === "primary" ? colors.primary : "transparent";
  const fg = variant === "primary" ? colors.primaryText : variant === "danger" ? colors.danger : colors.primary;
  return (
    <Pressable
      onPress={onPress}
      disabled={loading || disabled}
      style={({ pressed }) => [styles.button, { backgroundColor: bg, opacity: pressed || disabled ? 0.6 : 1 }, style]}
    >
      {loading ? <ActivityIndicator color={fg} /> : <Text style={[styles.buttonText, { color: fg }]}>{title}</Text>}
    </Pressable>
  );
}

export function Field(props: TextInputProps & { label?: string; error?: string | null; hint?: string | null }) {
  const { label, error, hint, style, ...rest } = props;
  return (
    <View style={{ gap: space(1) }}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <TextInput placeholderTextColor={colors.muted} style={[styles.input, error ? { borderColor: colors.danger } : null, style]} {...rest} />
      {error ? <Text style={styles.error}>{error}</Text> : hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

export function Empty({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      {subtitle ? <Text style={styles.emptySub}>{subtitle}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  avatarFallback: { backgroundColor: "#E7E6FF", alignItems: "center", justifyContent: "center" },
  onlineDot: { position: "absolute", right: 2, bottom: 2, width: 12, height: 12, borderRadius: 6, backgroundColor: colors.online, borderWidth: 2, borderColor: colors.card },
  tick: { fontSize: 11, color: colors.muted, marginLeft: 4 },
  button: { height: 48, borderRadius: radius.md, alignItems: "center", justifyContent: "center", paddingHorizontal: space(4) },
  buttonText: { fontSize: 16, fontWeight: "600" },
  label: { fontSize: 13, color: colors.muted, fontWeight: "600" },
  input: { height: 48, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, paddingHorizontal: space(3), fontSize: 16, color: colors.text },
  error: { color: colors.danger, fontSize: 13 },
  hint: { color: colors.muted, fontSize: 13 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: space(8), gap: space(2) },
  emptyTitle: { fontSize: 17, fontWeight: "600", color: colors.text, textAlign: "center" },
  emptySub: { fontSize: 14, color: colors.muted, textAlign: "center" },
});
