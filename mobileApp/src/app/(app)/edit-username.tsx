import { View } from "react-native";
import { useRouter } from "expo-router";
import { UsernameForm } from "@/ui/UsernameForm";
import { space } from "@/ui/theme";

export default function EditUsername() {
  const router = useRouter();
  return (
    <View style={{ padding: space(4) }}>
      <UsernameForm onDone={() => router.back()} />
    </View>
  );
}
