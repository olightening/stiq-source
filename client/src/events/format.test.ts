import {
  fmtWhen,
  fmtWhenFromIso,
  tzShort,
  whenLine,
  recurLabel,
  copyCardText,
  buildIcs,
  buildGuestCsv,
  reminderLabel,
  relTimeShort,
} from './format';
import type {Attendee, Waitlister} from './types';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Phase-0 (frozen) functions — exercised here since no test file previously existed for them.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('fmtWhen', () => {
  it('TBD fallback when no date/time given', () => {
    expect(fmtWhen()).toEqual({
      month: '—',
      day: '·',
      dateLabel: 'Add a date',
      timeLabel: 'Add a time',
    });
  });

  it('formats a valid date + time + tz label', () => {
    // 2026-11-08 is a real Sunday — verified independently, not copied from the DC's fixture copy.
    expect(fmtWhen('2026-11-08', '19:00', 'CET (UTC+1)')).toEqual({
      month: 'NOV',
      day: '8',
      dateLabel: 'Sun, Nov 8',
      timeLabel: '19:00 CET',
    });
  });

  it('date without a time resolves the tile/date label but leaves the time TBD', () => {
    expect(fmtWhen('2026-01-15')).toEqual({
      month: 'JAN',
      day: '15',
      dateLabel: 'Thu, Jan 15',
      timeLabel: 'Add a time',
    });
  });

  it('shortens a single-word tz label the same as a parenthesized one', () => {
    expect(fmtWhen('2026-06-03', '09:30', 'UTC')).toEqual({
      month: 'JUN',
      day: '3',
      dateLabel: 'Wed, Jun 3',
      timeLabel: '09:30 UTC',
    });
  });

  it('malformed date (wrong segment count) falls back to the TBD tile but keeps a given time', () => {
    expect(fmtWhen('2026-11', '19:00')).toEqual({
      month: '—',
      day: '·',
      dateLabel: 'Add a date',
      timeLabel: '19:00',
    });
  });
});

describe('fmtWhenFromIso', () => {
  it('undefined or too-short iso → the same TBD shape as fmtWhen()', () => {
    expect(fmtWhenFromIso(undefined)).toEqual(fmtWhen());
    expect(fmtWhenFromIso('2026-11')).toEqual(fmtWhen());
  });

  it('date-only iso (no "T") resolves the date but leaves the time TBD', () => {
    expect(fmtWhenFromIso('2026-11-08', 'CET (UTC+1)')).toEqual(
      fmtWhen('2026-11-08', undefined, 'CET (UTC+1)'),
    );
  });

  it('date+time iso resolves both', () => {
    expect(fmtWhenFromIso('2026-11-08T19:00:00', 'CET (UTC+1)')).toEqual(
      fmtWhen('2026-11-08', '19:00', 'CET (UTC+1)'),
    );
  });

  it('slices exactly HH:MM regardless of seconds/millis/zone suffix', () => {
    expect(fmtWhenFromIso('2026-11-08T19:00:00.000Z').timeLabel).toBe('19:00');
  });
});

describe('tzShort', () => {
  it('takes the first space-delimited token; blank when absent', () => {
    expect(tzShort('CET (UTC+1)')).toBe('CET');
    expect(tzShort('UTC')).toBe('UTC');
    expect(tzShort(undefined)).toBe('');
    expect(tzShort('')).toBe('');
  });
});

describe('whenLine', () => {
  it('joins date + time labels with a middot', () => {
    expect(
      whenLine({month: 'NOV', day: '8', dateLabel: 'Sat, Nov 8', timeLabel: '19:00 CET'}),
    ).toBe('Sat, Nov 8 · 19:00 CET');
  });

  it('renders the TBD variant the same way', () => {
    expect(whenLine(fmtWhen())).toBe('Add a date · Add a time');
  });
});

describe('recurLabel', () => {
  it('maps weekly/monthly to their chip labels and everything else to empty', () => {
    expect(recurLabel('weekly')).toBe('Weekly');
    expect(recurLabel('monthly')).toBe('Monthly');
    expect(recurLabel('none')).toBe('');
    expect(recurLabel(undefined)).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// copyCardText — DC copyText port
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('copyCardText', () => {
  it('minimal: no title/area/description/tag/external', () => {
    expect(copyCardText({dateLabel: 'Add a date', timeLabel: 'Add a time', hasTime: false})).toBe(
      'Untitled event\nAdd a date',
    );
  });

  it('an empty-string title also falls back to "Untitled event"', () => {
    expect(
      copyCardText({title: '', dateLabel: 'Add a date', timeLabel: 'Add a time', hasTime: false}),
    ).toBe('Untitled event\nAdd a date');
  });

  it('appends the time label only when hasTime is true', () => {
    expect(
      copyCardText({
        title: 'Encrypted backups, hands-on',
        dateLabel: 'Sat, Nov 8',
        timeLabel: '19:00 CET',
        hasTime: true,
      }),
    ).toBe('Encrypted backups, hands-on\nSat, Nov 8 · 19:00 CET');
  });

  it('full: title + area + description + tag, in DC order with blank-line separators', () => {
    expect(
      copyCardText({
        title: 'Encrypted backups, hands-on',
        dateLabel: 'Sat, Nov 8',
        timeLabel: '19:00 CET',
        hasTime: true,
        area: 'Neukölln, Berlin',
        description: 'Bring a laptop and a couple of USB sticks.',
        tag: 'opsec',
      }),
    ).toBe(
      'Encrypted backups, hands-on\n' +
        'Sat, Nov 8 · 19:00 CET\n' +
        '📍 Neukölln, Berlin\n' +
        '\n' +
        'Bring a laptop and a couple of USB sticks.\n' +
        '\n' +
        '#opsec',
    );
  });

  it('description content is trimmed before being pushed', () => {
    expect(
      copyCardText({
        dateLabel: 'Add a date',
        timeLabel: 'Add a time',
        hasTime: false,
        description: '  Bring a laptop.  \n',
      }),
    ).toBe('Untitled event\nAdd a date\n\nBring a laptop.');
  });

  it('external with a link', () => {
    expect(
      copyCardText({
        dateLabel: 'Add a date',
        timeLabel: 'Add a time',
        hasTime: false,
        external: true,
        externalSource: 'Quiet Harbor',
        externalLink: 'https://example.com/event',
      }),
    ).toBe(
      'Untitled event\nAdd a date\n\n↗ Shared event — organized by Quiet Harbor · https://example.com/event',
    );
  });

  it('external without a link or source falls back to "someone else" and drops the middot', () => {
    expect(
      copyCardText({dateLabel: 'Add a date', timeLabel: 'Add a time', hasTime: false, external: true}),
    ).toBe('Untitled event\nAdd a date\n\n↗ Shared event — organized by someone else');
  });

  it('empty-after-trim area/description/tag are omitted, same as absent', () => {
    expect(
      copyCardText({
        title: 'X',
        dateLabel: 'D',
        timeLabel: 'T',
        hasTime: false,
        area: '   ',
        description: '   \n  ',
        tag: '   ',
      }),
    ).toBe('X\nD');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// buildIcs — DC addIcs port
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('buildIcs', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-19T12:00:00.000Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('builds the exact VCALENDAR/VEVENT skeleton, property order and CRLF line endings', () => {
    const ics = buildIcs({
      id: 'evt-backups-1108',
      title: 'Encrypted backups, hands-on',
      startsAt: '2026-11-08T19:00:00',
      endsAt: '2026-11-08T21:00:00',
      area: 'Neukölln, Berlin',
      description: 'Bring a laptop.',
    });
    const lines = ics.split('\r\n');
    expect(lines).toEqual([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Stiq//Events//EN',
      'CALSCALE:GREGORIAN',
      'BEGIN:VEVENT',
      'UID:evt-backups-1108@stiq',
      'DTSTAMP:20260719T120000Z',
      'DTSTART:20261108T190000Z',
      'DTEND:20261108T210000Z',
      'SUMMARY:Encrypted backups\\, hands-on',
      'LOCATION:Neukölln\\, Berlin',
      'DESCRIPTION:Bring a laptop.',
      'END:VEVENT',
      'END:VCALENDAR',
    ]);
    // every line join is a real CRLF pair — no bare LF anywhere in the output
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/\n/);
  });

  it('escapes semicolons, commas, backslashes and embedded newlines in text fields', () => {
    const ics = buildIcs({
      id: 'evt-x',
      title: 'Title; with, punctuation\\and a backslash',
      startsAt: '2026-01-01T10:00:00',
      description: 'Line one\nLine two, with a comma; and a semicolon',
    });
    const lines = ics.split('\r\n');
    expect(lines).toContain('SUMMARY:Title\\; with\\, punctuation\\\\and a backslash');
    expect(lines).toContain('DESCRIPTION:Line one\\nLine two\\, with a comma\\; and a semicolon');
    // the escaped "\n" is literal backslash-n text, not a real break — still a single physical line
    expect(lines.filter(l => l.startsWith('DESCRIPTION:'))).toHaveLength(1);
  });

  it('falls back DTEND to DTSTART when endsAt is absent (no documented default-duration rule)', () => {
    const ics = buildIcs({id: 'evt-x', startsAt: '2026-03-01T10:00:00'});
    const lines = ics.split('\r\n');
    expect(lines).toContain('DTSTART:20260301T100000Z');
    expect(lines).toContain('DTEND:20260301T100000Z');
  });

  it('omits DTSTART/DTEND/LOCATION/DESCRIPTION when absent, and falls back the title', () => {
    const ics = buildIcs({id: 'evt-bare'});
    const lines = ics.split('\r\n');
    expect(lines.some(l => l.startsWith('DTSTART:'))).toBe(false);
    expect(lines.some(l => l.startsWith('DTEND:'))).toBe(false);
    expect(lines.some(l => l.startsWith('LOCATION:'))).toBe(false);
    expect(lines.some(l => l.startsWith('DESCRIPTION:'))).toBe(false);
    expect(lines).toContain('SUMMARY:Untitled event');
    expect(lines).toContain('UID:evt-bare@stiq');
    expect(lines[0]).toBe('BEGIN:VCALENDAR');
    expect(lines[lines.length - 1]).toBe('END:VCALENDAR');
  });

  it('blank/whitespace-only area and description are treated as absent', () => {
    const ics = buildIcs({id: 'evt-x', area: '   ', description: '\n  '});
    const lines = ics.split('\r\n');
    expect(lines.some(l => l.startsWith('LOCATION:'))).toBe(false);
    expect(lines.some(l => l.startsWith('DESCRIPTION:'))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// buildGuestCsv — DC exportCsv port
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('buildGuestCsv', () => {
  const attendee = (name: string, npub: string, joinedAt: string): Attendee => ({
    who: {name, npub, grad: 'gradient-wire-form'},
    joinedAt,
  });
  const waitlister = (name: string, npub: string, position: number): Waitlister => ({
    who: {name, npub, grad: 'gradient-wire-form'},
    position,
  });

  it('emits just the header row for an empty guest list', () => {
    expect(buildGuestCsv([], [])).toBe('"name","npub","status","joined"');
  });

  it('emits a quoted row per guest with status "going" and the joinedAt in the "joined" column', () => {
    const csv = buildGuestCsv([attendee('Teal Anon', 'npub1t3a', '2026-07-01T00:00:00Z')], []);
    expect(csv.split('\r\n')).toEqual([
      '"name","npub","status","joined"',
      '"Teal Anon","npub1t3a","going","2026-07-01T00:00:00Z"',
    ]);
  });

  it('emits a waitlist row with status "waitlist" and the position in the "joined" column', () => {
    const csv = buildGuestCsv([], [waitlister('Faint Static', 'npub1fs7a', 4)]);
    expect(csv.split('\r\n')[1]).toBe('"Faint Static","npub1fs7a","waitlist","4"');
  });

  it('doubles embedded quotes and leaves commas inside a quoted cell untouched', () => {
    const csv = buildGuestCsv([attendee('Say "Hi", Anon', 'npub1x', '2026-07-01T00:00:00Z')], []);
    expect(csv.split('\r\n')[1]).toBe('"Say ""Hi"", Anon","npub1x","going","2026-07-01T00:00:00Z"');
  });

  it('lists guests before the waitlist, each preserving input order', () => {
    const csv = buildGuestCsv(
      [attendee('G1', 'npub1g1', '2026-01-01T00:00:00Z'), attendee('G2', 'npub1g2', '2026-01-02T00:00:00Z')],
      [waitlister('W1', 'npub1w1', 1), waitlister('W2', 'npub1w2', 2)],
    );
    expect(csv.split('\r\n').slice(1)).toEqual([
      '"G1","npub1g1","going","2026-01-01T00:00:00Z"',
      '"G2","npub1g2","going","2026-01-02T00:00:00Z"',
      '"W1","npub1w1","waitlist","1"',
      '"W2","npub1w2","waitlist","2"',
    ]);
  });

  it('never serializes grad, even when it is an object-shaped GradientSpec', () => {
    const withObjectGrad: Attendee = {
      who: {name: 'A', npub: 'npub1a', grad: {kind: 'linear', angle: 90} as any},
      joinedAt: '2026-01-01T00:00:00Z',
    };
    const csv = buildGuestCsv([withObjectGrad], []);
    expect(csv).not.toContain('linear');
    expect(csv).not.toContain('[object Object]');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// reminderLabel
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('reminderLabel', () => {
  it('singular unit at N===1, for every unit', () => {
    expect(reminderLabel(1, 'minutes')).toBe('Reminder set — 1 minute before it starts');
    expect(reminderLabel(1, 'hours')).toBe('Reminder set — 1 hour before it starts');
    expect(reminderLabel(1, 'days')).toBe('Reminder set — 1 day before it starts');
    expect(reminderLabel(1, 'weeks')).toBe('Reminder set — 1 week before it starts');
  });

  it('plural unit at N!==1, for every unit', () => {
    expect(reminderLabel(2, 'minutes')).toBe('Reminder set — 2 minutes before it starts');
    expect(reminderLabel(5, 'hours')).toBe('Reminder set — 5 hours before it starts');
    expect(reminderLabel(3, 'days')).toBe('Reminder set — 3 days before it starts');
    expect(reminderLabel(2, 'weeks')).toBe('Reminder set — 2 weeks before it starts');
  });

  it('N===0 also takes the plural form (never "(s)", per COPY.md pluralization rules)', () => {
    expect(reminderLabel(0, 'minutes')).toBe('Reminder set — 0 minutes before it starts');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// relTimeShort — application submittedAt
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('relTimeShort', () => {
  const NOW = Date.UTC(2026, 6, 19, 12, 0, 0);
  const isoBefore = (deltaMs: number) => new Date(NOW - deltaMs).toISOString();

  it('buckets seconds → "now"', () => {
    expect(relTimeShort(isoBefore(30_000), NOW)).toBe('now');
  });

  it('buckets minutes', () => {
    expect(relTimeShort(isoBefore(5 * 60_000), NOW)).toBe('5m');
  });

  it('buckets hours', () => {
    expect(relTimeShort(isoBefore(2 * 3_600_000), NOW)).toBe('2h');
  });

  it('buckets days', () => {
    expect(relTimeShort(isoBefore(3 * 86_400_000), NOW)).toBe('3d');
  });

  it('rolls over to months beyond 30 days, matching ui/relTime\'s "short" style', () => {
    expect(relTimeShort(isoBefore(60 * 86_400_000), NOW)).toBe('2mo');
  });

  it('defaults nowMs to the wall clock when omitted', () => {
    expect(relTimeShort(new Date(Date.now() - 5 * 60_000).toISOString())).toBe('5m');
  });
});
