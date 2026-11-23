import { create } from "zustand";
import type { PresenceState } from "./events";

interface RealtimeState {
  connected: boolean;
  presence: Record<string, PresenceState>;
  /** 1:1 typing, keyed by the person typing. */
  typing: Record<string, number>;
  /** Group typing: groupId → (userId → since). */
  groupTyping: Record<string, Record<string, number>>;
  /** The chat currently on screen: incoming messages there are read right away. */
  activePeerId: string | null;
  setConnected(v: boolean): void;
  setPresence(list: PresenceState[]): void;
  setTyping(userId: string, on: boolean, groupId?: string): void;
  setActivePeer(id: string | null): void;
}

const TYPING_TTL_MS = 6000;
const timers: Record<string, ReturnType<typeof setTimeout>> = {};

export const useRealtime = create<RealtimeState>((set) => ({
  connected: false,
  presence: {},
  typing: {},
  groupTyping: {},
  activePeerId: null,
  setConnected: (connected) => set({ connected }),
  setPresence: (list) =>
    set((s) => ({ presence: { ...s.presence, ...Object.fromEntries(list.map((p) => [p.userId, p])) } })),
  setTyping: (userId, on, groupId) => {
    const key = groupId ? `${groupId}:${userId}` : userId;
    clearTimeout(timers[key]);
    if (on) timers[key] = setTimeout(() => useRealtime.getState().setTyping(userId, false, groupId), TYPING_TTL_MS);
    set((s) => {
      if (groupId) {
        const g = { ...(s.groupTyping[groupId] ?? {}) };
        if (on) g[userId] = Date.now();
        else delete g[userId];
        return { groupTyping: { ...s.groupTyping, [groupId]: g } };
      }
      const typing = { ...s.typing };
      if (on) typing[userId] = Date.now();
      else delete typing[userId];
      return { typing };
    });
  },
  setActivePeer: (activePeerId) => set({ activePeerId }),
}));
