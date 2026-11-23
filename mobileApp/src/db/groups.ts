import type { Db, GroupMemberRow, GroupRow } from "./types";
import { ensureChat } from "./queries";

/** Shape of GET /groups (summary) and GET /groups/{id} (details) responses. */
export interface GroupFromApi {
  id: string;
  name: string;
  description: string | null;
  avatarFileId: string | null;
  avatarUrl: string | null;
  onlyAdminsCanSend: boolean;
  onlyAdminsCanEditInfo: boolean;
  createdById: string;
  myRole: "member" | "admin";
  mutedUntil: string | null;
  members?: { user: { id: string; username: string; displayName: string | null; avatarFileId: string | null; avatarUrl: string | null }; role: "member" | "admin"; isCreator: boolean }[];
}

/** Stores what the server says about a group, and makes sure it has a chat row. */
export async function saveGroup(db: Db, g: GroupFromApi) {
  const members: GroupMemberRow[] | null = g.members
    ? g.members.map((m) => ({ ...m.user, role: m.role, isCreator: m.isCreator }))
    : null;
  await db.run(
    `INSERT INTO groups (id, name, description, avatarFileId, avatarUrl, onlyAdminsCanSend, onlyAdminsCanEditInfo, createdById, myRole, isMember, mutedUntil, membersJson)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, COALESCE(?, '[]'))
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, description = excluded.description, avatarFileId = excluded.avatarFileId,
       avatarUrl = excluded.avatarUrl, onlyAdminsCanSend = excluded.onlyAdminsCanSend,
       onlyAdminsCanEditInfo = excluded.onlyAdminsCanEditInfo, createdById = excluded.createdById,
       myRole = excluded.myRole, isMember = 1, mutedUntil = excluded.mutedUntil,
       membersJson = COALESCE(?, groups.membersJson)`,
    [
      g.id, g.name, g.description, g.avatarFileId, g.avatarUrl, g.onlyAdminsCanSend ? 1 : 0, g.onlyAdminsCanEditInfo ? 1 : 0,
      g.createdById, g.myRole, g.mutedUntil, members ? JSON.stringify(members) : null, members ? JSON.stringify(members) : null,
    ],
  );
  await ensureChat(db, g.id, { kind: "group", displayName: g.name, avatarFileId: g.avatarFileId, avatarUrl: g.avatarUrl });
  await db.run("UPDATE chats SET displayName = ?, avatarFileId = ?, avatarUrl = ? WHERE peerId = ?", [g.name, g.avatarFileId, g.avatarUrl, g.id]);
}

export async function markNotMember(db: Db, groupId: string) {
  await db.run("UPDATE groups SET isMember = 0, myRole = 'member' WHERE id = ?", [groupId]);
}

export function getGroup(db: Db, id: string) {
  return db.first<GroupRow>("SELECT * FROM groups WHERE id = ?", [id]);
}

export function membersOf(g: GroupRow | null): GroupMemberRow[] {
  if (!g) return [];
  try {
    return JSON.parse(g.membersJson) as GroupMemberRow[];
  } catch {
    return [];
  }
}

export async function isGroupAdmin(db: Db, groupId: string, userId: string) {
  return membersOf(await getGroup(db, groupId)).some((m) => m.id === userId && m.role === "admin");
}

export async function memberName(db: Db, groupId: string, userId: string) {
  const m = membersOf(await getGroup(db, groupId)).find((x) => x.id === userId);
  return m ? m.displayName || `@${m.username}` : null;
}
