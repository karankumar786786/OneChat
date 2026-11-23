/**
 * Black + royal blue.
 * `primary` (royal blue) fills buttons, badges and your bubbles; white text on it is AA.
 * `accent` is the same blue lightened for text and icons on black, where pure royal blue
 * would fall just under AA contrast.
 */
export const colors = {
  bg: "#000000",
  card: "#0D0F14",
  elevated: "#161922",
  pressed: "#1B1F2A",
  text: "#F1F3F9",
  muted: "#8B92A6",
  border: "#232734",
  primary: "#4169E1",
  primarySoft: "#1A2650",
  primaryText: "#FFFFFF",
  accent: "#6E8EF5",
  /** Names, mentions and quotes inside bubbles (readable on both bubble colours). */
  onBubbleAccent: "#9DB4FF",
  mine: "#1F3D99",
  theirs: "#161922",
  /** Time and ticks on your (blue) bubbles. */
  bubbleMeta: "rgba(255,255,255,0.62)",
  online: "#22C55E",
  danger: "#F05252",
  read: "#5CC8FF",
  ring: "#4169E1",
  ringSeen: "#3A4050",
  overlay: "rgba(0,0,0,0.65)",
  warningBg: "#2A2110",
  warningText: "#FBBF24",
};

export const radius = { sm: 8, md: 12, lg: 18, pill: 999 };
export const space = (n: number) => n * 4;
