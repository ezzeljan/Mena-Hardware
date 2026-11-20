import type { DoorGroup, StandardSet } from '@/types/database'

export interface MatchCandidate {
  set: StandardSet
  score: number
  reason: string
  /** How well the room names match, 0..1 (0 = no word in common). */
  roomSimilarity: number
  /** Tie-breaker: room words in common counting zone words (APT, RESIDENTIAL). */
  zoneOverlap: number
  /** True when the set's leaf type stands in for the door's (see LEAF_FALLBACKS). */
  leafFallback?: boolean
}

export interface GroupMatchResult {
  groupId: string
  matchedSetId: string | null
  matchStatus: 'auto' | 'unmatched'
  matchScore: number | null
  matchReason: string
  topCandidates: MatchCandidate[]
}

/** Auto matches scoring below this need individual review (not bulk-confirmable). */
export const AUTO_MATCH_THRESHOLD = 0.72

/**
 * When no set of the door's own leaf type has a matching room, sets of these
 * leaf types are offered instead, scored lower so they always need a look.
 */
export const LEAF_FALLBACKS: Record<string, string[]> = {
  'CAVITY DOUBLE': ['CAVITY SINGLE'],
  'CAVITY SINGLE': ['CAVITY DOUBLE'],
  TRIPLE: ['DOUBLE'],
}
const LEAF_FALLBACK_PENALTY = 0.1

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
}

/**
 * Same-meaning room words, compared as one (after abbreviations). Only used
 * for matching: door groups keep the room name as written in the quotation.
 */
const ROOM_SYNONYMS: Record<string, string[]> = {
  ENSUITE: ['BATHROOM'],
  ENSUITES: ['BATHROOM'],
  WASHROOM: ['BATHROOM'],
  BATH: ['BATHROOM'],
  STORAGE: ['STORE'],
  STOREROOM: ['STORE'],
  GARBAGE: ['WASTE'],
  RUBBISH: ['WASTE'],
  BIN: ['WASTE'],
  SWITCHROOM: ['SWITCHBOARD', 'ROOM'],
  SWITCH: ['SWITCHBOARD'],
  EXIT: ['EGRESS'],
  COMMUNICATIONS: ['COMMS'],
  COMMUNICATION: ['COMMS'],
  COMM: ['COMMS'],
  HYDRANT: ['HYD'],
  CUPBD: ['CUPBOARD'],
  CUPBOARDS: ['CUPBOARD'],
}

/**
 * Zone words that say where a room is, not what it is ("APARTMENTS - BEDROOM",
 * "RESIDENTIAL - FIRE STAIR"). Dropped unless they are the only words.
 */
const ZONE_TOKENS = new Set(['APARTMENT', 'APARTMENTS', 'RESIDENTIAL', 'RESIDENT', 'DOOR', 'DOORS'])

/** Words that say little on their own ("ROOM", "CUPBOARD"): never a match by themselves. */
const GENERIC_TOKENS = new Set(['ROOM', 'CUPBOARD', 'AREA', 'SPACE'])

/** Level and number words: "STAIR 03", "L8", "B1 & B2". */
const NUMBER_TOKEN = /^(\d+[A-Z]?|[LBG]\d+[A-Z]?|LVL\d*|LEVEL\d*)$/

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
])

export function normalizeClass(raw: string | null | undefined): string {
  const s = (raw ?? '').trim().toUpperCase().replace(/\s+/g, ' ')
  if (!s) return ''
  if (s === 'FR' || s.startsWith('FIRE RATED')) return 'FIRE RATED'
  if (s === 'NR' || s === 'NON-RATED' || s.startsWith('NON RATED')) return 'NON RATED'
  return s
}

export function normalizeLeafType(raw: string | null | undefined): string {
  return (raw ?? '').trim().toUpperCase().replace(/\s+/g, ' ')
}

export function normalizeSize(raw: string | null | undefined): string {
  return (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s*x\s*/g, 'x')
    .replace(/\s+/g, '')
}

/**
 * A room name as comparable words: abbreviations expanded, synonyms joined,
 * level / number and zone words dropped, each word once.
 */
export function normalizeRoomTokens(raw: string, keepZones = false): string[] {
  const cleaned = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
  if (!cleaned) return []

  const all: string[] = []
  for (const part of cleaned.split(/\s+/)) {
    if (!part || LOCATION_NOISE_TOKENS.has(part) || NUMBER_TOKEN.test(part)) continue
    const word = ABBREVIATION_MAP[part] ?? part
    all.push(...(ROOM_SYNONYMS[word] ?? [word]))
  }
  const meaningful = keepZones ? all : all.filter((t) => !ZONE_TOKENS.has(t))
  return [...new Set(meaningful.length > 0 ? meaningful : all)]
}

/**
 * Breaks a tie between sets on the zone words too: "Apartments - Entry" is
 * closer to "APT ENTRY" than to "ENTRY". Share of words in common, 0..1.
 */
function zoneAwareOverlap(groupRoom: string, setRoom: string): number {
  const g = normalizeRoomTokens(groupRoom, true)
  const s = normalizeRoomTokens(setRoom, true)
  if (g.length === 0 || s.length === 0) return 0
  const common = g.filter((x) => s.some((y) => sameWord(x, y))).length
  return common / (g.length + s.length - common)
}

/** At most one letter apart (insert, delete or change): catches "ACCESIBLE". */
function oneEditApart(a: string, b: string): boolean {
  if (a === b) return true
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0
  let j = 0
  let edits = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++
      j++
      continue
    }
    if (++edits > 1) return false
    if (a.length > b.length) i++
    else if (b.length > a.length) j++
    else {
      i++
      j++
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1
}

/** Same word, allowing a one-letter typo in words of 5+ letters. */
function sameWord(a: string, b: string): boolean {
  return a === b || (a.length >= 5 && b.length >= 5 && oneEditApart(a, b))
}

function computeRoomSimilarity(
  groupRoom: string,
  setRoom: string,
): { similarity: number; label: string } {
  const gNorm = groupRoom.trim().toUpperCase().replace(/\s+/g, ' ')
  const sNorm = setRoom.trim().toUpperCase().replace(/\s+/g, ' ')
  if (!gNorm || !sNorm) return { similarity: 0, label: 'empty room' }

  if (gNorm === sNorm) {
    return { similarity: 1, label: 'exact room match' }
  }

  const gTokens = normalizeRoomTokens(gNorm)
  const sTokens = normalizeRoomTokens(sNorm)
  if (gTokens.length === 0 || sTokens.length === 0) {
    return { similarity: 0, label: 'no matching tokens' }
  }

  // Same words (in any order, typos allowed).
  const covers = (xs: string[], ys: string[]) => xs.every((x) => ys.some((y) => sameWord(x, y)))
  if (gTokens.length === sTokens.length && covers(gTokens, sTokens)) {
    return { similarity: 0.96, label: `"${gNorm}" = "${sNorm}"` }
  }

  // One name's words all appear in the other's (not when those are only
  // generic words: "Residential - Room" is not a "COMMS ROOM").
  const specific = (xs: string[]) => xs.some((x) => !GENERIC_TOKENS.has(x))
  if (
    (covers(gTokens, sTokens) && specific(gTokens)) ||
    (covers(sTokens, gTokens) && specific(sTokens))
  ) {
    const ratio =
      Math.min(gTokens.length, sTokens.length) / Math.max(gTokens.length, sTokens.length)
    const sim = 0.8 + 0.15 * ratio
    return { similarity: sim, label: `"${gNorm}" ≈ "${sNorm}"` }
  }

  const intersection = gTokens.filter((g) => sTokens.some((s) => sameWord(g, s))).length
  if (intersection === 0) {
    return { similarity: 0, label: 'no room token overlap' }
  }

  const union = gTokens.length + sTokens.length - intersection
  const jaccard = intersection / union
  return {
    similarity: jaccard,
    label: `"${gNorm}" ≈ "${sNorm}" (${Math.round(jaccard * 100)}%)`,
  }
}

export function matchDoorGroup(
  group: Pick<DoorGroup, 'id' | 'room_name' | 'classification' | 'leaf' | 'door_size'>,
  standardSets: StandardSet[],
): GroupMatchResult {
  const gClass = normalizeClass(group.classification)
  const gLeaf = normalizeLeafType(group.leaf)
  const gSize = normalizeSize(group.door_size)

  const score = (fallbackLeaves: string[] | null): MatchCandidate[] => {
    const candidates: MatchCandidate[] = []

    for (const set of standardSets) {
      if (!set.active) continue

      const sClass = normalizeClass(set.classification)
      const sLeaf = normalizeLeafType(set.leaf)
      const sSize = normalizeSize(set.door_size)

      // Hard filter 1: classification must match when both are known
      if (gClass && sClass && gClass !== sClass) continue

      // Hard filter 2: leaf must match when group leaf is known (allow blank set.leaf only as weak fallback).
      // In a fallback pass, only sets of the fallback leaf types.
      if (fallbackLeaves) {
        if (!fallbackLeaves.includes(sLeaf)) continue
      } else if (gLeaf && sLeaf && gLeaf !== sLeaf) continue

      let score = 0
      const reasons: string[] = []

      if (gClass && sClass && gClass === sClass) {
        score += 0.15
        reasons.push(`classification ✓ (${gClass})`)
      }

      if (gLeaf && sLeaf && gLeaf === sLeaf) {
        score += 0.15
        reasons.push(`leaf ✓ (${gLeaf})`)
      } else if (fallbackLeaves) {
        score -= LEAF_FALLBACK_PENALTY
        reasons.push(`leaf fallback: set is ${sLeaf}, door is ${gLeaf}`)
      } else if (!sLeaf) {
        score += 0.05
        reasons.push('leaf (generic set)')
      }

      const roomMatch = computeRoomSimilarity(group.room_name, set.room_name)
      score += 0.6 * roomMatch.similarity
      reasons.push(`room: ${roomMatch.label}`)

      if (gSize && sSize && gSize === sSize) {
        score += 0.1
        reasons.push(`size ✓ (${gSize})`)
      }

      const roundedScore = Math.round(score * 10000) / 10000
      candidates.push({
        set,
        score: roundedScore,
        reason: reasons.join(', '),
        roomSimilarity: roomMatch.similarity,
        zoneOverlap: zoneAwareOverlap(group.room_name, set.room_name),
        ...(fallbackLeaves ? { leafFallback: true } : {}),
      })
    }
    return candidates
  }

  let candidates = score(null)
  // Leaf fallback: no set of the door's own leaf type has a matching room.
  const fallbackLeaves = LEAF_FALLBACKS[gLeaf]
  if (fallbackLeaves && !candidates.some((c) => c.roomSimilarity > 0)) {
    candidates = [...candidates, ...score(fallbackLeaves)]
  }

  candidates.sort(
    (a, b) =>
      b.score - a.score || b.zoneOverlap - a.zoneOverlap || b.roomSimilarity - a.roomSimilarity,
  )
  const topCandidates = candidates.slice(0, 3)
  const best = topCandidates[0]

  // No room word in common with any set: don't guess (the first set would win
  // a tie); the estimator picks from the candidates.
  if (best && best.roomSimilarity === 0) {
    return {
      groupId: group.id,
      matchedSetId: null,
      matchStatus: 'unmatched',
      matchScore: null,
      matchReason: `No standard set's room name matches "${group.room_name}" — choose a set`,
      topCandidates,
    }
  }

  if (best) {
    // A tie with a differently named set: the order of the sets would decide,
    // so it always needs a look (score held just under the confident line).
    const rival = topCandidates.find(
      (c) =>
        c !== best &&
        c.score === best.score &&
        c.zoneOverlap === best.zoneOverlap &&
        c.set.room_name !== best.set.room_name,
    )
    if (rival) {
      return {
        groupId: group.id,
        matchedSetId: best.set.id,
        matchStatus: 'auto',
        matchScore: Math.min(best.score, Math.round((AUTO_MATCH_THRESHOLD - 0.01) * 100) / 100),
        matchReason: `Tied with ${rival.set.room_name} (${Math.round(best.score * 100)}% each — review): ${best.reason}`,
        topCandidates,
      }
    }
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
