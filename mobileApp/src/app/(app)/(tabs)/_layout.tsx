import { Tabs } from "expo-router/js-tabs";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@/ui/theme";

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: { backgroundColor: colors.card, borderTopColor: colors.border },
        sceneStyle: { backgroundColor: colors.bg },
        headerTitleStyle: { color: colors.text, fontWeight: "700" },
        headerStyle: { backgroundColor: colors.card },
      }}
    >
      <Tabs.Screen name="chats" options={{ title: "Chats", tabBarIcon: ({ color, size }) => <Ionicons name="chatbubbles" color={String(color)} size={size} /> }} />
      <Tabs.Screen name="status" options={{ title: "Status", tabBarIcon: ({ color, size }) => <Ionicons name="aperture" color={String(color)} size={size} /> }} />
      <Tabs.Screen name="settings" options={{ title: "Settings", tabBarIcon: ({ color, size }) => <Ionicons name="settings" color={String(color)} size={size} /> }} />
    </Tabs>
  );
}
