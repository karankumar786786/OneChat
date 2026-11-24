import { Stack } from "expo-router";
import { colors } from "@/ui/theme";

export default function AppLayout() {
  return (
    <Stack
      screenOptions={{
        headerTintColor: colors.accent,
        // Without this iOS shows the route group name "(tabs)" on back buttons.
        headerBackTitle: "Back",
        headerTitleStyle: { color: colors.text },
        headerStyle: { backgroundColor: colors.card },
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="chat/[peerId]" options={{ title: "" }} />
      <Stack.Screen name="search" options={{ title: "Find people" }} />
      <Stack.Screen name="forward" options={{ title: "Forward to…", presentation: "modal" }} />
      <Stack.Screen name="status/[userId]" options={{ headerShown: false, animation: "fade" }} />
      <Stack.Screen name="status/new" options={{ title: "New status", presentation: "modal" }} />
      <Stack.Screen name="status/mine/[id]" options={{ title: "Views & comments" }} />
      <Stack.Screen name="edit-username" options={{ title: "Change username" }} />
      <Stack.Screen name="group/new" options={{ title: "New group" }} />
      <Stack.Screen name="group/[id]/index" options={{ title: "Group info" }} />
      <Stack.Screen name="group/[id]/add" options={{ title: "Add participants" }} />
      <Stack.Screen name="message-info/[id]" options={{ title: "Message info" }} />
      <Stack.Screen name="join/[code]" options={{ title: "Group invite" }} />
      <Stack.Screen name="user/[id]" options={{ title: "Contact info" }} />
      <Stack.Screen name="viewer" options={{ headerShown: false, presentation: "fullScreenModal", animation: "fade" }} />
    </Stack>
  );
}
