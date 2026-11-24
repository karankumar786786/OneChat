import { StyleSheet } from "react-native";
import { colors, space } from "./theme";

export const authStyles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  wrap: { flex: 1, justifyContent: "center", padding: space(6), gap: space(4) },
  title: { fontSize: 30, fontWeight: "800", color: colors.text },
  subtitle: { fontSize: 15, color: colors.muted, marginTop: -space(2) },
  notice: { backgroundColor: colors.warningBg, color: colors.warningText, padding: space(3), borderRadius: 10, overflow: "hidden" },
  link: { color: colors.accent, textAlign: "center", fontSize: 15, marginTop: space(2) },
});
