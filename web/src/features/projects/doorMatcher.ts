import type { DoorGroup, StandardSet } from '@/types/database';

export interface MatchCandidate {
  set: StandardSet;
  score: number;
  reason: string;
}

export interface GroupMatchResult {
  groupId: string;
  matchedSetId: string | null;
  matchStatus: 'auto' | 'unmatched';
  matchScore: number | null;
  matchReason: string;
  topCandidates: MatchCandidate[];
}

const AUTO_MATCH_THRESHOLD = 0.72;

const ABBREVIATION_MAP: Record<string, string> = {
  CBD: 'CUPBOARD',
  CPBD: 'CUPBOARD',
  ELEC: 'ELECTRICAL',
  ACC: 'ACCESSIBLE',
  WC: 'TOILET',
  APT: 'APARTMENT',
  RESI: 'RESIDENTIAL',
  COMM: 'COMMERCIAL',
  SERV: 'SERVICES',
  STOR: 'STORE',
  ENG: 'ENGINE',
  MECH: 'MECHANICAL',
  FIRE: 'FIRE',
  STAIR: 'STAIR',
};

const LOCATION_NOISE_TOKENS = new Set([
  'B1',
  'B2',
  'B3',
  'BM',
  'GL',
  'GF',
  'L1',
  'L2',
  'L3',
  'L4',
  'LVL',
  'LEVEL',
  'GROUND',
  'BASEMENT',
  'EAST',
  'WEST',
  'NORTH',
  'SOUTH',
]);

export function normalizeClass(raw: string | null | undefined): string {
  const s = (raw ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (!s) return '';
  if (s === 'FR' || s.startsWith('FIRE RATED')) return 'FIRE RATED';
  if (s === 'NR' || s === 'NON-RATED' || s.startsWith('NON RATED')) return 'NON RATED';
  return s;
}

export function normalizeLeafType(raw: string | null | undefined): string {
  return (raw ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
}

export function normalizeSize(raw: string | null | undefined): string {
  return (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s*x\s*/g, 'x')
    .replace(/\s+/g, '');
}

export function normalizeRoomTokens(raw: string): string[] {
  const cleaned = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
  if (!cleaned) return [];

  const tokens: string[] = [];
  for (const part of cleaned.split(/\s+/)) {
    if (!part || LOCATION_NOISE_TOKENS.has(part)) continue;
    tokens.push(ABBREVIATION_MAP[part] ?? part);
  }
  return tokens;
}

function computeRoomSimilarity(
  groupRoom: string,
  setRoom: string
): { similarity: number; label: string } {
  const gNorm = groupRoom.trim().toUpperCase().replace(/\s+/g, ' ');
  const sNorm = setRoom.trim().toUpperCase().replace(/\s+/g, ' ');
  if (!gNorm || !sNorm) return { similarity: 0, label: 'empty room' };

  if (gNorm === sNorm) {
    return { similarity: 1, label: 'exact room match' };
  }

  const gTokens = normalizeRoomTokens(gNorm);
  const sTokens = normalizeRoomTokens(sNorm);
  const gJoined = gTokens.join(' ');
  const sJoined = sTokens.join(' ');

  if (gJoined && sJoined && gJoined === sJoined) {
    return { similarity: 0.96, label: `"${gNorm}" = "${sNorm}"` };
  }

  if (
    gJoined &&
    sJoined &&
    (gJoined.includes(sJoined) || sJoined.includes(gJoined))
  ) {
    const ratio =
      Math.min(gJoined.length, sJoined.length) /
      Math.max(gJoined.length, sJoined.length);
    const sim = 0.8 + 0.15 * ratio;
    return { similarity: sim, label: `"${gNorm}" ≈ "${sNorm}"` };
  }

  const setA = new Set(gTokens);
  const setB = new Set(sTokens);
  if (setA.size === 0 || setB.size === 0) {
    return { similarity: 0, label: 'no matching tokens' };
  }

  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  if (intersection === 0) {
    return { similarity: 0, label: 'no room token overlap' };
  }

  const union = new Set([...setA, ...setB]).size;
  const jaccard = intersection / union;
  return {
    similarity: jaccard,
    label: `"${gNorm}" ≈ "${sNorm}" (${Math.round(jaccard * 100)}%)`,
  };
}

export function matchDoorGroup(
  group: Pick<
    DoorGroup,
    'id' | 'room_name' | 'classification' | 'leaf' | 'door_size'
  >,
  standardSets: StandardSet[]
): GroupMatchResult {
  const gClass = normalizeClass(group.classification);
  const gLeaf = normalizeLeafType(group.leaf);
  const gSize = normalizeSize(group.door_size);

  const candidates: MatchCandidate[] = [];

  for (const set of standardSets) {
    if (!set.active) continue;

    const sClass = normalizeClass(set.classification);
    const sLeaf = normalizeLeafType(set.leaf);
    const sSize = normalizeSize(set.door_size);

    // Hard filter 1: classification must match when both are known
    if (gClass && sClass && gClass !== sClass) continue;

    // Hard filter 2: leaf must match when group leaf is known (allow blank set.leaf only as weak fallback)
    if (gLeaf && sLeaf && gLeaf !== sLeaf) continue;

    let score = 0;
    const reasons: string[] = [];

    if (gClass && sClass && gClass === sClass) {
      score += 0.15;
      reasons.push(`classification ✓ (${gClass})`);
    }

    if (gLeaf && sLeaf && gLeaf === sLeaf) {
      score += 0.15;
      reasons.push(`leaf ✓ (${gLeaf})`);
    } else if (!sLeaf) {
      score += 0.05;
      reasons.push('leaf (generic set)');
    }

    const roomMatch = computeRoomSimilarity(group.room_name, set.room_name);
    score += 0.6 * roomMatch.similarity;
    reasons.push(`room: ${roomMatch.label}`);

    if (gSize && sSize && gSize === sSize) {
      score += 0.1;
      reasons.push(`size ✓ (${gSize})`);
    }

    const roundedScore = Math.round(score * 10000) / 10000;
    candidates.push({
      set,
      score: roundedScore,
      reason: reasons.join(', '),
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const topCandidates = candidates.slice(0, 3);
  const best = topCandidates[0];

  if (best) {
    const isLowConfidence = best.score < AUTO_MATCH_THRESHOLD
    return {
      groupId: group.id,
      matchedSetId: best.set.id,
      matchStatus: 'auto',
      matchScore: best.score,
      matchReason: isLowConfidence
        ? `Best match (${Math.round(best.score * 100)}% — review): ${best.reason}`
        : best.reason,
      topCandidates,
    }
  }

  return {
    groupId: group.id,
    matchedSetId: null,
    matchStatus: 'unmatched',
    matchScore: null,
    matchReason: 'No standard sets matched classification and leaf',
    topCandidates,
  }
}
