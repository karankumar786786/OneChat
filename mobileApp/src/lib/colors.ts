/** Stable per-person colour for sender names in groups. */
const PALETTE = ["#D9480F", "#2B8A3E", "#1971C2", "#9C36B5", "#C2255C", "#0C8599", "#E67700", "#5F3DC4"];

export function nameColor(userId: string) {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length]!;
}
