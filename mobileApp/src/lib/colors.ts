/** Stable per-person colour for sender names in groups. */
// Bright enough to read on the dark bubbles.
const PALETTE = ["#FF8A65", "#69DB7C", "#74C0FC", "#DA77F2", "#F783AC", "#3BC9DB", "#FFD43B", "#B197FC"];

export function nameColor(userId: string) {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length]!;
}
