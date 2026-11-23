import { useCallback, useEffect, useState } from "react";
import { getDb } from "./index";
import { onDbChange } from "./changes";
import { getChat, listChats, listMessages } from "./queries";
import type { ChatRow, GroupRow, MessageRow } from "./types";
import { getGroup } from "./groups";

function useLive<T>(load: () => Promise<T>, initial: T, filter?: (peers: Set<string>) => boolean) {
  const [value, setValue] = useState<T>(initial);
  const reload = useCallback(() => {
    load().then(setValue).catch((err) => console.warn("local db read failed", err));
  }, [load]);
  useEffect(() => {
    reload();
    return onDbChange((peers) => {
      if (!filter || filter(peers)) reload();
    });
  }, [reload, filter]);
  return [value, reload] as const;
}

export function useChats() {
  const load = useCallback(() => listChats(getDb()), []);
  return useLive<ChatRow[]>(load, []);
}

export function useMessages(peerId: string) {
  const load = useCallback(() => listMessages(getDb(), peerId), [peerId]);
  const filter = useCallback((peers: Set<string>) => peers.has(peerId), [peerId]);
  return useLive<MessageRow[]>(load, [], filter);
}

export function useChat(peerId: string) {
  const load = useCallback(() => getChat(getDb(), peerId), [peerId]);
  const filter = useCallback((peers: Set<string>) => peers.has(peerId), [peerId]);
  return useLive<ChatRow | null>(load, null, filter);
}

export function useGroup(groupId: string) {
  const load = useCallback(() => getGroup(getDb(), groupId), [groupId]);
  const filter = useCallback((peers: Set<string>) => peers.has(groupId), [groupId]);
  return useLive<GroupRow | null>(load, null, filter);
}
