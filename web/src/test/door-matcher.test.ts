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

  it('auto-selects the highest-scoring candidate when below confidence threshold and flags for review', () => {
    const res = matchDoorGroup(
      {
        id: 'g-3',
        room_name: 'ENSUITE',
        classification: 'NON RATED',
        leaf: 'CAVITY SINGLE',
        door_size: '2040x820',
      },
      sets
    );

    expect(res.matchStatus).toBe('auto');
    expect(res.matchedSetId).toBe('set-bath-cav');
    expect(res.matchReason).toContain('review');
    expect(res.topCandidates).toHaveLength(1);
    expect(res.topCandidates[0].set.id).toBe('set-bath-cav');
  });
});
