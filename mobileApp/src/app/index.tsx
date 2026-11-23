import { Redirect } from "expo-router";
import { useAuth } from "@/auth/store";

/** "/" sends people to the right place for their sign-in state. */
export default function Index() {
  const status = useAuth((s) => s.status);
  const hasUsername = useAuth((s) => Boolean(s.me?.username));
  if (status !== "signedIn") return <Redirect href="/login" />;
  if (!hasUsername) return <Redirect href="/username" />;
  return <Redirect href="/chats" />;
}
