// Member colours (members.color is a 0-based index), same order as the mockups and the
// puzzle screen. Students without a group use the neutral sand colour.
export const MEMBER_COLORS = ['#F0544F', '#22A559', '#3B82F6', '#9B51E0', '#F2A20C', '#E64C9A'];
export const NEUTRAL_COLOR = '#B4AC9E';

export function memberColor(color) {
  return Number.isInteger(color) && color >= 0 ? MEMBER_COLORS[color % MEMBER_COLORS.length] : NEUTRAL_COLOR;
}
