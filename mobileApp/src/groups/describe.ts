/** Turns a group.update event into the system line shown in the chat ("@a added @b"). */
export interface GroupUpdate {
  groupId: string;
  action: "created" | "added" | "removed" | "left" | "joined" | "promoted" | "demoted" | "info" | "settings";
  actor: { id: string; username: string };
  targets: { id: string; username: string }[];
  changes: {
    name?: string;
    description?: string | null;
    avatarFileId?: string | null;
    onlyAdminsCanSend?: boolean;
    onlyAdminsCanEditInfo?: boolean;
  } | null;
  at: string;
}

export function describeGroupUpdate(u: GroupUpdate, myId: string | null): string {
  const who = (p: { id: string; username: string }) => (p.id === myId ? "You" : `@${p.username}`);
  const list = (ps: { id: string; username: string }[]) => ps.map(who).join(", ");
  const actor = who(u.actor);
  const c = u.changes ?? {};
  switch (u.action) {
    case "created":
      return `${actor} created group "${c.name ?? ""}"`;
    case "added":
      return `${actor} added ${list(u.targets)}`;
    case "removed":
      return `${actor} removed ${list(u.targets)}`;
    case "left":
      return `${actor} left`;
    case "joined":
      return `${actor} joined using this group's invite link`;
    case "promoted":
      return u.targets.some((t) => t.id === myId) ? "You're now an admin" : `${list(u.targets)} is now an admin`;
    case "demoted":
      return u.targets.some((t) => t.id === myId) ? "You're no longer an admin" : `${list(u.targets)} is no longer an admin`;
    case "info": {
      const parts: string[] = [];
      if (c.name !== undefined) parts.push(`${actor} changed the group name to "${c.name}"`);
      if (c.description !== undefined) parts.push(`${actor} changed the group description`);
      if (c.avatarFileId !== undefined) parts.push(c.avatarFileId ? `${actor} changed this group's icon` : `${actor} removed this group's icon`);
      return parts.join("\n") || `${actor} updated the group`;
    }
    case "settings": {
      const parts: string[] = [];
      if (c.onlyAdminsCanSend !== undefined) {
        parts.push(`${actor} changed this group's settings to allow ${c.onlyAdminsCanSend ? "only admins" : "all members"} to send messages`);
      }
      if (c.onlyAdminsCanEditInfo !== undefined) {
        parts.push(`${actor} changed this group's settings to allow ${c.onlyAdminsCanEditInfo ? "only admins" : "all members"} to edit this group's info`);
      }
      return parts.join("\n") || `${actor} changed this group's settings`;
    }
  }
}

/** Whether this update means the current user is no longer / again a member. */
export function membershipChange(u: GroupUpdate, myId: string | null): "left" | "joined" | null {
  if (!myId) return null;
  if (u.action === "removed" && u.targets.some((t) => t.id === myId)) return "left";
  if (u.action === "left" && u.actor.id === myId) return "left";
  if ((u.action === "added" || u.action === "created") && u.targets.some((t) => t.id === myId)) return "joined";
  if (u.action === "joined" && u.actor.id === myId) return "joined";
  if (u.action === "created" && u.actor.id === myId) return "joined";
  return null;
}
