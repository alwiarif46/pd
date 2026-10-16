import { describe, expect, it } from 'vitest';
import {
  classifyDateHit,
  dateLabel,
  factKeyOf,
  parseDay,
  planTabSupersede,
  readDateChange,
  sameTabValue,
  type TabExisting,
} from './amendment-tabs';
import { inferActivityKind } from './schedule';

describe('factKeyOf', () => {
  it('maps the bid-summary fields and their spellings to a key', () => {
    expect(factKeyOf('agency')).toBe('agency');
    expect(factKeyOf('Agency')).toBe('agency');
    expect(factKeyOf('solicitationNumber')).toBe('solicitation_number');
    expect(factKeyOf('solicitation_number')).toBe('solicitation_number');
    expect(factKeyOf('Solicitation Number')).toBe('solicitation_number');
    expect(factKeyOf('naics')).toBe('naics');
    expect(factKeyOf('NAICS code')).toBe('naics');
    expect(factKeyOf('setAside')).toBe('set_aside');
    expect(factKeyOf('set-aside')).toBe('set_aside');
    expect(factKeyOf('contractType')).toBe('contract_type');
    expect(factKeyOf('periodOfPerformance')).toBe('pop');
    expect(factKeyOf('pop')).toBe('pop');
    expect(factKeyOf('placeOfPerformance')).toBe('place');
    expect(factKeyOf('place')).toBe('place');
    expect(factKeyOf('submissionMethod')).toBe('submission_method');
    expect(factKeyOf('contractingOfficer')).toBe('contracting_officer');
  });

  it('puts anything else under other', () => {
    expect(factKeyOf('bidType')).toBe('other');
    expect(factKeyOf('dueDate')).toBe('other');
    expect(factKeyOf('Lunch')).toBe('other');
    expect(factKeyOf('')).toBe('other');
  });
});

describe('parseDay', () => {
  it('reads ISO, numeric, and month-name dates', () => {
    expect(parseDay('Proposals are due 2026-12-15.')).toBe('2026-12-15');
    expect(parseDay('Questions by 12/15/2026.')).toBe('2026-12-15');
    expect(parseDay('Site visit on 3-4-26.')).toBe('2026-03-04');
    expect(parseDay('Offers are due December 15, 2026 at 2:00 PM.')).toBe('2026-12-15');
    expect(parseDay('Offers are due Dec. 15, 2026.')).toBe('2026-12-15');
    expect(parseDay('Offers are due 15 December 2026.')).toBe('2026-12-15');
    expect(parseDay('Offers due Sept 3 2026')).toBe('2026-09-03');
  });

  it('takes the new date of a "from X to Y" change', () => {
    expect(parseDay('The proposal due date is changed from 12/15/2026 to 12/22/2026.')).toBe('2026-12-22');
    expect(parseDay('Proposals due date is extended from December 15, 2026 to January 5, 2027.')).toBe('2027-01-05');
  });

  it('refuses impossible days and sentences without a date', () => {
    expect(parseDay('Due 2026-02-30.')).toBeNull();
    expect(parseDay('Due 13/45/2026.')).toBeNull();
    expect(parseDay('Offers close at 2:00 p.m. local time.')).toBeNull();
    expect(parseDay('Proposals are due as stated in Section A.')).toBeNull();
  });
});

describe('classifyDateHit', () => {
  it('classifies a dated sentence by what it names', () => {
    expect(classifyDateHit('Proposals are due 2026-12-15.')).toEqual({ dateKey: 'proposal_due', day: '2026-12-15' });
    expect(classifyDateHit('Offers will be received until December 22, 2026.')).toEqual({ dateKey: 'proposal_due', day: '2026-12-22' });
    expect(classifyDateHit('The closing date is 12/15/2026.')).toEqual({ dateKey: 'proposal_due', day: '2026-12-15' });
    expect(classifyDateHit('Questions are due 2026-11-01.')).toEqual({ dateKey: 'questions_due', day: '2026-11-01' });
    expect(classifyDateHit('Questions about the proposal are due 2026-11-01.')).toEqual({ dateKey: 'questions_due', day: '2026-11-01' });
    expect(classifyDateHit('A site visit will be held 2026-10-30.')).toEqual({ dateKey: 'site_visit', day: '2026-10-30' });
    expect(classifyDateHit('Oral presentations are scheduled for 2027-01-10.')).toEqual({ dateKey: 'orals', day: '2027-01-10' });
    expect(classifyDateHit('The kickoff is 2027-03-01.')).toEqual({ dateKey: 'other', day: '2027-03-01' });
  });

  it('keys a sentence only when it holds a date', () => {
    expect(classifyDateHit('Proposals are due as stated in Section A.')).toEqual({ dateKey: 'other', day: null });
    expect(classifyDateHit('Offers close at 2:00 p.m. local time.')).toEqual({ dateKey: 'other', day: null });
  });
});

describe('dateLabel', () => {
  it('names each key so its kind follows from the label', () => {
    expect(inferActivityKind(dateLabel('proposal_due', 'solicitation')).kind).toBe('submission');
    expect(inferActivityKind(dateLabel('questions_due', 'amendment')).kind).toBe('milestone');
    expect(inferActivityKind(dateLabel('site_visit', 'amendment')).kind).toBe('milestone');
    expect(dateLabel('other', 'solicitation')).toBe('Date from solicitation');
    expect(dateLabel('other', 'amendment')).toBe('Date from amendment');
  });
});

describe('readDateChange', () => {
  it('reads a stored change and refuses anything else', () => {
    const change = { previousDue: '2026-12-15', nextDue: '2026-12-22', sourcePage: 1, sourceQuote: 'Due 2026-12-22.', resolvedAt: null };
    expect(readDateChange(change)).toEqual(change);
    expect(readDateChange({ ...change, previousDue: null })).toEqual({ ...change, previousDue: null });
    expect(readDateChange(null)).toBeNull();
    expect(readDateChange({ nextDue: 'soon' })).toBeNull();
    expect(readDateChange('2026-12-22')).toBeNull();
  });
});

describe('sameTabValue', () => {
  it('ignores case, spacing, and closing punctuation', () => {
    expect(sameTabValue('Department of the Army', ' department  of the army. ')).toBe(true);
    expect(sameTabValue('Army', 'Navy')).toBe(false);
  });
});

const row = (id: string, key: string, amendmentNo: number, overrides: Partial<TabExisting> = {}): TabExisting => ({
  id, key, amendmentNo, touched: false, value: `value of ${id}`, ...overrides,
});

describe('planTabSupersede', () => {
  it('supersedes untouched lower rows automatically', () => {
    const plan = planTabSupersede([row('o1', 'agency', 0), row('o2', 'agency', 1)], [{ key: 'agency', value: 'Navy' }], 2);
    expect(plan).toEqual([{ index: 0, key: 'agency', status: 'active', supersededBy: null, closes: ['o1', 'o2'], proposes: [], replaces: [] }]);
  });

  it('proposes the replacement of a row a user touched; the untouched ones wait for the insert', () => {
    const plan = planTabSupersede([row('o1', 'agency', 0, { touched: true }), row('o2', 'agency', 0)], [{ key: 'agency', value: 'Navy' }], 2);
    expect(plan).toEqual([{ index: 0, key: 'agency', status: 'proposed', supersededBy: null, closes: [], proposes: ['o1', 'o2'], replaces: [] }]);
  });

  it('inserts a row already superseded when a higher amendment wrote the key', () => {
    const plan = planTabSupersede([row('o1', 'agency', 0), row('h3', 'agency', 3), row('h4', 'agency', 4)], [{ key: 'agency', value: 'Navy' }], 2);
    expect(plan).toEqual([{ index: 0, key: 'agency', status: 'superseded', supersededBy: { id: 'h4', amendmentNo: 4 }, closes: [], proposes: [], replaces: [] }]);
  });

  it('only ever adds rows keyed other, and rows of a key the run already used', () => {
    const plan = planTabSupersede([row('o1', 'other', 0), row('o2', 'naics', 0)], [
      { key: 'other', value: 'x' },
      { key: 'naics', value: '541512' },
      { key: 'naics', value: '541511' },
    ], 2);
    expect(plan).toEqual([
      { index: 0, key: 'other', status: 'active', supersededBy: null, closes: [], proposes: [], replaces: [] },
      { index: 1, key: 'naics', status: 'active', supersededBy: null, closes: ['o2'], proposes: [], replaces: [] },
      { index: 2, key: 'other', status: 'active', supersededBy: null, closes: [], proposes: [], replaces: [] },
    ]);
  });

  it('adds a row whose key nothing holds yet', () => {
    expect(planTabSupersede([], [{ key: 'pop', value: '12 months' }], 1)).toEqual([
      { index: 0, key: 'pop', status: 'active', supersededBy: null, closes: [], proposes: [], replaces: [] },
    ]);
  });

  it('skips a restatement: every lower row on the key already has the value', () => {
    const plan = planTabSupersede([row('o1', 'agency', 0, { value: 'Department of the Army', touched: true })], [{ key: 'agency', value: 'department of the army' }], 2);
    expect(plan).toEqual([{ index: 0, key: 'agency', status: 'skip', supersededBy: null, closes: [], proposes: [], replaces: [] }]);
  });

  it('gives the same active rows whichever amendment finishes first', () => {
    const original = row('o', 'agency', 0);
    // In order: 2 then 3.
    const two = planTabSupersede([original], [{ key: 'agency', value: 'B' }], 2);
    expect(two[0]).toMatchObject({ status: 'active', closes: ['o'] });
    const three = planTabSupersede([row('r2', 'agency', 2, { value: 'B' })], [{ key: 'agency', value: 'C' }], 3);
    expect(three[0]).toMatchObject({ status: 'active', closes: ['r2'] });
    // Out of order: 3 then 2.
    const threeFirst = planTabSupersede([original], [{ key: 'agency', value: 'C' }], 3);
    expect(threeFirst[0]).toMatchObject({ status: 'active', closes: ['o'] });
    const twoLate = planTabSupersede([row('r3', 'agency', 3, { value: 'C' })], [{ key: 'agency', value: 'B' }], 2);
    expect(twoLate[0]).toMatchObject({ status: 'superseded', supersededBy: { id: 'r3', amendmentNo: 3 } });
  });

  describe('open proposals (a lower or higher amendment proposed on the key)', () => {
    const touched = row('b', 'agency', 0, { touched: true, value: 'Army' });
    const open = (id: string, amendmentNo: number, value: string) => ({ id, key: 'agency', amendmentNo, value });

    it('a higher amendment replaces a lower open proposal and proposes against the touched row', () => {
      expect(planTabSupersede([touched], [{ key: 'agency', value: 'Air Force' }], 3, [open('p2', 2, 'Navy')])).toEqual([
        { index: 0, key: 'agency', status: 'proposed', supersededBy: null, closes: [], proposes: ['b'], replaces: ['p2'] },
      ]);
    });

    it('a lower amendment goes in already superseded by a higher open proposal', () => {
      expect(planTabSupersede([touched], [{ key: 'agency', value: 'Navy' }], 2, [open('p3', 3, 'Air Force')])).toEqual([
        { index: 0, key: 'agency', status: 'superseded', supersededBy: { id: 'p3', amendmentNo: 3 }, closes: [], proposes: [], replaces: [] },
      ]);
    });

    it('restating the open proposal is skipped; restating the row in force withdraws the proposal', () => {
      expect(planTabSupersede([touched], [{ key: 'agency', value: 'navy' }], 3, [open('p2', 2, 'Navy')])[0])
        .toMatchObject({ status: 'skip', replaces: [] });
      expect(planTabSupersede([touched], [{ key: 'agency', value: 'Army' }], 3, [open('p2', 2, 'Navy')])[0])
        .toMatchObject({ status: 'skip', replaces: ['p2'] });
    });

    it('with the touched row gone, the new row is in force and the open proposal is replaced', () => {
      expect(planTabSupersede([row('u', 'agency', 0)], [{ key: 'agency', value: 'Air Force' }], 3, [open('p2', 2, 'Navy')])).toEqual([
        { index: 0, key: 'agency', status: 'active', supersededBy: null, closes: ['u'], proposes: [], replaces: ['p2'] },
      ]);
    });

    it('ends with the highest amendment proposed, whichever runs first', () => {
      // In order: 2 proposes, then 3 replaces it.
      expect(planTabSupersede([touched], [{ key: 'agency', value: 'Navy' }], 2)[0]).toMatchObject({ status: 'proposed', proposes: ['b'] });
      expect(planTabSupersede([touched], [{ key: 'agency', value: 'Air Force' }], 3, [open('p2', 2, 'Navy')])[0])
        .toMatchObject({ status: 'proposed', replaces: ['p2'] });
      // Out of order: 3 proposes, then 2 goes in superseded by it.
      expect(planTabSupersede([touched], [{ key: 'agency', value: 'Air Force' }], 3)[0]).toMatchObject({ status: 'proposed', proposes: ['b'] });
      expect(planTabSupersede([touched], [{ key: 'agency', value: 'Navy' }], 2, [open('p3', 3, 'Air Force')])[0])
        .toMatchObject({ status: 'superseded', supersededBy: { id: 'p3', amendmentNo: 3 } });
    });
  });
});
