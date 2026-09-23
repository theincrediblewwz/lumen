import type { EdgeReviewStatus, KnowledgeStatus } from '@/types/domain';

export const colors = {
  canvas: '#F6F1E8',
  canvasDot: '#DDD5C8',
  surface: '#FFFCF7',
  surfaceStrong: '#FFFFFF',
  ink: '#20201F',
  inkMuted: '#77736D',
  line: '#D8D0C4',
  lineStrong: '#B8AEA0',
  coral: '#EA715F',
  coralSoft: '#FBE7E2',
  blue: '#5D82D7',
  blueSoft: '#E7EEFC',
  green: '#5D9A78',
  greenSoft: '#E3F1E8',
  amber: '#D29A3F',
  amberSoft: '#F8EEDB',
  gray: '#9A9893',
  graySoft: '#EEECE8',
  white: '#FFFFFF',
  scrim: 'rgba(32, 32, 31, 0.18)',
} as const;

export const statusColor: Record<KnowledgeStatus, string> = {
  essential: colors.coral,
  learning: colors.blue,
  mastered: colors.green,
  uncertain: colors.amber,
  optional: colors.gray,
};

export const statusSoftColor: Record<KnowledgeStatus, string> = {
  essential: colors.coralSoft,
  learning: colors.blueSoft,
  mastered: colors.greenSoft,
  uncertain: colors.amberSoft,
  optional: colors.graySoft,
};

export const edgeReviewColor: Record<EdgeReviewStatus, string> = {
  unverified: colors.lineStrong,
  learner_supported: colors.green,
  disputed: colors.amber,
};

export const radii = {
  small: 12,
  medium: 18,
  large: 26,
  floating: 30,
} as const;

export const floatingShadow = '0 10px 30px rgba(55, 48, 40, 0.14)';

