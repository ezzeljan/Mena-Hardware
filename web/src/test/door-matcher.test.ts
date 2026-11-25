import { describe, expect, it } from 'vitest';
import type { StandardSet } from '@/types/database';
import {
  matchDoorGroup,
  normalizeClass,
  normalizeRoomTokens,
  normalizeSize,
} from '@/features/projects/doorMatcher';

function makeSet(overrides: Partial<StandardSet>): StandardSet {
  return {
    id: overrides.id ?? 'set-1',
    room_name: overrides.room_name ?? 'UNIT ENTRY',
    classification: overrides.classification ?? 'FIRE RATED',
    leaf: overrides.leaf ?? 'SINGLE',
    door_size: overrides.door_size ?? '2040 x 920',
    active: overrides.active ?? true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

describe('doorMatcher helpers', () => {
  it('normalizes classification, size, and room tokens', () => {
    expect(normalizeClass('FR')).toBe('FIRE RATED');
    expect(normalizeClass('FIRE RATED - PIVOT')).toBe('FIRE RATED');
    expect(normalizeClass('non-rated')).toBe('NON RATED');
    expect(normalizeSize('2040 x 920')).toBe('2040x920');
    expect(normalizeRoomTokens('COMMS CBD - B1')).toEqual(['COMMS', 'CUPBOARD']);
  });

  it('drops zone and level words, joins synonyms, keeps each word once', () => {
    expect(normalizeRoomTokens('Apartments - Ensuite/Bathroom')).toEqual(['BATHROOM']);
    expect(normalizeRoomTokens('Fire Egress - Stair 03')).toEqual(['FIRE', 'EGRESS', 'STAIR']);
    expect(normalizeRoomTokens('Services cupboard - B1 & B2')).toEqual(['SERVICES', 'CUPBOARD']);
    expect(normalizeRoomTokens('Residential - Fire Exit')).toEqual(['FIRE', 'EGRESS']);
    expect(normalizeRoomTokens('Resident Storage - B2')).toEqual(['STORE']);
    expect(normalizeRoomTokens('Switchroom')).toEqual(['SWITCHBOARD', 'ROOM']);
    // Only zone words: kept, so the name still matches something.
    expect(normalizeRoomTokens('Residential')).toEqual(['RESIDENTIAL']);
  });
});

describe('matchDoorGroup', () => {
  const sets: StandardSet[] = [
    makeSet({ id: 'set-comms-fr', room_name: 'COMMS ROOM', classification: 'FIRE RATED', leaf: 'SINGLE' }),
    makeSet({ id: 'set-comms-nr', room_name: 'COMMS CBD', classification: 'NON RATED', leaf: 'DOUBLE' }),
    makeSet({ id: 'set-bath-cav', room_name: 'BATHROOM', classification: 'NON RATED', leaf: 'CAVITY SINGLE' }),
    makeSet({ id: 'set-inactive', room_name: 'BATHROOM', classification: 'NON RATED', leaf: 'SINGLE', active: false }),
  ];

  it('auto-matches exact/near room names when classification and leaf match', () => {
    const res = matchDoorGroup(
      {
        id: 'g-1',
        room_name: 'COMMS ROOM - B1',
        classification: 'FIRE RATED',
        leaf: 'SINGLE',
        door_size: '2040x920',
      },
      sets
    );

    expect(res.matchStatus).toBe('auto');
    expect(res.matchedSetId).toBe('set-comms-fr');
    expect(res.matchScore).toBeGreaterThanOrEqual(0.72);
    expect(res.matchReason).toContain('classification ✓');
    expect(res.matchReason).toContain('leaf ✓');
  });

  it('hard-filters out sets with mismatched classification or leaf', () => {
    const res = matchDoorGroup(
      {
        id: 'g-2',
        room_name: 'BATHROOM',
        classification: 'NON RATED',
        leaf: 'SINGLE',
        door_size: '2040x920',
      },
      sets
    );

    expect(res.matchStatus).toBe('unmatched');
    expect(res.matchedSetId).toBeNull();
    expect(res.topCandidates).toHaveLength(0);
  });

  it('does not guess when no room word matches; the candidates are still offered', () => {
    const res = matchDoorGroup(
      {
        id: 'g-3',
        room_name: 'Apartments - Pantry',
        classification: 'NON RATED',
        leaf: 'CAVITY SINGLE',
        door_size: '2040x820',
      },
      sets
    );

    expect(res.matchStatus).toBe('unmatched');
    expect(res.matchedSetId).toBeNull();
    expect(res.matchReason).toContain('choose a set');
    expect(res.topCandidates.map((c) => c.set.id)).toEqual(['set-bath-cav']);
  });

  it('matches quotation room names to set names despite zones, numbers, synonyms and typos', () => {
    const more: StandardSet[] = [
      makeSet({ id: 'set-bath', room_name: 'BATHROOM', classification: 'NON RATED', leaf: 'SINGLE' }),
      makeSet({ id: 'set-acc', room_name: 'ACCESSIBLE BATHROOM', classification: 'NON RATED', leaf: 'SINGLE' }),
      makeSet({ id: 'set-msb', room_name: 'MAIN SWITCHBOARD ROOM', classification: 'FIRE RATED', leaf: 'SINGLE' }),
      makeSet({ id: 'set-stair', room_name: 'FIRE STAIR', classification: 'FIRE RATED', leaf: 'SINGLE' }),
    ];
    const pick = (room_name: string, classification: string) =>
      matchDoorGroup({ id: 'g', room_name, classification, leaf: 'SINGLE', door_size: '2340x870' }, more);

    const ensuite = pick('Apartments - Ensuite/Bathroom', 'NON RATED');
    expect(ensuite.matchedSetId).toBe('set-bath');
    expect(ensuite.matchScore).toBeGreaterThanOrEqual(0.72);
    expect(pick('Accesible Bathroom L8', 'NON RATED').matchedSetId).toBe('set-acc');
    expect(pick('Switchroom', 'FIRE RATED').matchedSetId).toBe('set-msb');
    const stair = pick('Residential - Fire Stair', 'FIRE RATED');
    expect(stair.matchedSetId).toBe('set-stair');
    expect(stair.matchScore).toBeGreaterThanOrEqual(0.72);
  });

  it('does not count a generic word alone as a strong match, and flags ties for review', () => {
    const more: StandardSet[] = [
      makeSet({ id: 'set-comms-room', room_name: 'COMMS ROOM', classification: 'FIRE RATED', leaf: 'SINGLE' }),
      makeSet({ id: 'set-egress', room_name: 'FIRE EGRESS DOOR', classification: 'FIRE RATED', leaf: 'SINGLE' }),
      makeSet({ id: 'set-stair', room_name: 'FIRE STAIR', classification: 'FIRE RATED', leaf: 'SINGLE' }),
    ];
    const pick = (room_name: string) =>
      matchDoorGroup({ id: 'g', room_name, classification: 'FIRE RATED', leaf: 'SINGLE', door_size: '2340x870' }, more);

    const room = pick('Residential - Room');
    expect(room.matchedSetId).toBe('set-comms-room');
    expect(room.matchScore).toBeLessThan(0.72);

    // Equal on the main words; FIRE STAIR shares more of the name overall.
    expect(pick('Fire Egress - Stair 02').matchedSetId).toBe('set-stair');

    // Zone words break a tie: "Apartments - Entry" is the APT ENTRY set.
    const entries: StandardSet[] = [
      makeSet({ id: 'set-entry', room_name: 'ENTRY', classification: 'FIRE RATED', leaf: 'SINGLE' }),
      makeSet({ id: 'set-apt-entry', room_name: 'APT ENTRY', classification: 'FIRE RATED', leaf: 'SINGLE' }),
    ];
    const apt = matchDoorGroup(
      { id: 'g', room_name: 'Apartments - Entry', classification: 'FIRE RATED', leaf: 'SINGLE', door_size: '2395x970' },
      entries
    );
    expect(apt.matchedSetId).toBe('set-apt-entry');
    expect(apt.matchScore).toBeGreaterThanOrEqual(0.72);

    // A real tie (same words, nothing to tell them apart) needs a look.
    const twins: StandardSet[] = [
      makeSet({ id: 'set-a', room_name: 'STORE ROOM', classification: 'FIRE RATED', leaf: 'SINGLE' }),
      makeSet({ id: 'set-b', room_name: 'STORAGE ROOM', classification: 'FIRE RATED', leaf: 'SINGLE' }),
    ];
    const tie = matchDoorGroup(
      { id: 'g', room_name: 'Store Room', classification: 'FIRE RATED', leaf: 'SINGLE', door_size: '2040x920' },
      twins
    );
    expect(tie.matchedSetId).toBe('set-a'); // exact name wins outright
    const tie2 = matchDoorGroup(
      { id: 'g', room_name: 'Storeroom', classification: 'FIRE RATED', leaf: 'SINGLE', door_size: '2040x920' },
      twins
    );
    expect(tie2.matchScore).toBeLessThan(0.72);
    expect(tie2.matchReason).toMatch(/^Tied with/);
  });

  it('auto-selects a partial room match below the confidence threshold and flags it for review', () => {
    const res = matchDoorGroup(
      {
        id: 'g-4',
        room_name: 'RESIDENTIAL COMMS RISER',
        classification: 'FIRE RATED',
        leaf: 'SINGLE',
        door_size: '2340x870',
      },
      sets
    );

    expect(res.matchStatus).toBe('auto');
    expect(res.matchedSetId).toBe('set-comms-fr');
    expect(res.matchScore).toBeLessThan(0.72);
    expect(res.matchReason).toContain('review');
  });

  it('falls back to a related leaf type, scored low so it needs a look', () => {
    const res = matchDoorGroup(
      {
        id: 'g-5',
        room_name: 'APARTMENTS - BATHROOM',
        classification: 'NON RATED',
        leaf: 'CAVITY DOUBLE',
        door_size: '2340x525+525',
      },
      sets
    );

    expect(res.matchStatus).toBe('auto');
    expect(res.matchedSetId).toBe('set-bath-cav');
    expect(res.matchScore).toBeLessThan(0.72);
    expect(res.matchReason).toContain('leaf fallback: set is CAVITY SINGLE, door is CAVITY DOUBLE');
    expect(res.topCandidates[0].leafFallback).toBe(true);
  });

  it('prefers a set of the same leaf type over a fallback when one matches the room', () => {
    const withDouble = [
      ...sets,
      makeSet({ id: 'set-bath-cav-dbl', room_name: 'BATHROOM', classification: 'NON RATED', leaf: 'CAVITY DOUBLE' }),
    ];
    const res = matchDoorGroup(
      {
        id: 'g-6',
        room_name: 'BATHROOM',
        classification: 'NON RATED',
        leaf: 'CAVITY DOUBLE',
        door_size: '2340x525+525',
      },
      withDouble
    );
    expect(res.matchedSetId).toBe('set-bath-cav-dbl');
    expect(res.topCandidates.every((c) => !c.leafFallback)).toBe(true);
  });
});
