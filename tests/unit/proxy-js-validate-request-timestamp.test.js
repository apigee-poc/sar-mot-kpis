const { expect } = require('chai');
const { load, runInApigee } = require('./helpers/jsc');

const {
  validateRequestTimestamp, parseIsoUtc, resolveMaxSkewSeconds, DEFAULT_MAX_CLOCK_SKEW_SECONDS
} = load('validateRequestTimestamp.js');

// Injected gateway clock: 2026-11-11T08:30:00.000Z
const NOW = Date.UTC(2026, 10, 11, 8, 30, 0, 0);
const valid = (value, skew) => validateRequestTimestamp(value, NOW, skew);

describe('proxy JS: validateRequestTimestamp (ERR-400-TIMESTAMP)', () => {
  describe('constants', () => {
    it('defaults to 300 seconds', () => {
      expect(DEFAULT_MAX_CLOCK_SKEW_SECONDS).to.equal(300);
    });
  });

  describe('format', () => {
    it('accepts a UTC timestamp without fraction', () => {
      expect(valid('2026-11-11T08:30:00Z')).to.equal(true);
    });

    [['1', '2026-11-11T08:30:00.5Z'], ['2', '2026-11-11T08:30:00.50Z'], ['3', '2026-11-11T08:30:00.500Z']].forEach(([n, ts]) => {
      it(`accepts ${n} fraction digit(s)`, () => {
        expect(valid(ts)).to.equal(true);
      });
    });

    const bad = {
      'missing header (undefined)': undefined,
      'missing header (null)': null,
      'empty string': '',
      'blank string': '   ',
      'number': 1762850000000,
      'boolean': true,
      'plain object': {},
      'no Z suffix': '2026-11-11T08:30:00',
      'offset +00:00 instead of Z': '2026-11-11T08:30:00+00:00',
      'offset +03:00': '2026-11-11T11:30:00+03:00',
      'lowercase t': '2026-11-11t08:30:00Z',
      'lowercase z': '2026-11-11T08:30:00z',
      'space instead of T': '2026-11-11 08:30:00Z',
      'date only': '2026-11-11',
      'time only': '08:30:00Z',
      '4 fraction digits': '2026-11-11T08:30:00.1234Z',
      '6 fraction digits': '2026-11-11T08:30:00.123456Z',
      'empty fraction': '2026-11-11T08:30:00.Z',
      'missing seconds': '2026-11-11T08:30Z',
      'leading space': ' 2026-11-11T08:30:00Z',
      'trailing space': '2026-11-11T08:30:00Z ',
      'epoch seconds as text': '1762850000',
      'two-digit year': '26-11-11T08:30:00Z'
    };
    Object.keys(bad).forEach((name) => {
      it(`rejects ${name}`, () => {
        expect(valid(bad[name])).to.equal(false);
        expect(parseIsoUtc(bad[name])).to.equal(null);
      });
    });
  });

  describe('calendar validity', () => {
    const invalid = {
      'month 13': '2026-13-11T08:30:00Z',
      'month 00': '2026-00-11T08:30:00Z',
      'day 00': '2026-11-00T08:30:00Z',
      'Feb 30': '2026-02-30T08:30:00Z',
      'Feb 29 in a non-leap year': '2026-02-29T08:30:00Z',
      'Feb 29 in 1900 (century, not leap)': '1900-02-29T08:30:00Z',
      'Feb 29 in 2100 (century, not leap)': '2100-02-29T08:30:00Z',
      'Apr 31': '2026-04-31T08:30:00Z',
      'day 32': '2026-01-32T08:30:00Z',
      'hour 24': '2026-11-11T24:00:00Z',
      'minute 60': '2026-11-11T08:60:00Z',
      'second 60 (leap second)': '2026-11-11T08:30:60Z'
    };
    Object.keys(invalid).forEach((name) => {
      it(`rejects ${name}`, () => {
        expect(parseIsoUtc(invalid[name])).to.equal(null);
        // Even with a huge skew allowance an impossible date is still invalid.
        expect(valid(invalid[name], 999999999)).to.equal(false);
      });
    });

    it('parses Feb 29 in a leap year (2024, 2000)', () => {
      expect(parseIsoUtc('2024-02-29T00:00:00Z')).to.equal(Date.UTC(2024, 1, 29));
      expect(parseIsoUtc('2000-02-29T00:00:00Z')).to.equal(Date.UTC(2000, 1, 29));
    });

    it('accepts the last valid day of every month and rejects the day after', () => {
      const last = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      last.forEach((d, i) => {
        const mm = String(i + 1).padStart(2, '0');
        expect(parseIsoUtc(`2026-${mm}-${d}T23:59:59Z`), `month ${mm}`).to.equal(Date.UTC(2026, i, d, 23, 59, 59));
        expect(parseIsoUtc(`2026-${mm}-${d + 1}T00:00:00Z`), `month ${mm} + 1 day`).to.equal(null);
      });
    });

    it('accepts a valid leap day that is inside the skew window', () => {
      const now = Date.UTC(2024, 1, 29, 12, 0, 0);
      expect(validateRequestTimestamp('2024-02-29T12:00:00Z', now, 300)).to.equal(true);
    });

    it('converts fractions to milliseconds (padding on the right)', () => {
      const base = Date.UTC(2026, 10, 11, 8, 30, 0);
      expect(parseIsoUtc('2026-11-11T08:30:00.5Z')).to.equal(base + 500);
      expect(parseIsoUtc('2026-11-11T08:30:00.05Z')).to.equal(base + 50);
      expect(parseIsoUtc('2026-11-11T08:30:00.005Z')).to.equal(base + 5);
      expect(parseIsoUtc('2026-11-11T08:30:00.000Z')).to.equal(base);
    });
  });

  describe('clock skew (default 300 s, both directions, inclusive)', () => {
    it('accepts exactly now', () => {
      expect(valid('2026-11-11T08:30:00Z')).to.equal(true);
    });
    it('accepts exactly +300 s', () => {
      expect(valid('2026-11-11T08:35:00Z')).to.equal(true);
      expect(valid('2026-11-11T08:35:00.000Z')).to.equal(true);
    });
    it('accepts exactly -300 s', () => {
      expect(valid('2026-11-11T08:25:00Z')).to.equal(true);
    });
    it('rejects +300 s + 1 ms', () => {
      expect(valid('2026-11-11T08:35:00.001Z')).to.equal(false);
    });
    it('rejects +301 s', () => {
      expect(valid('2026-11-11T08:35:01Z')).to.equal(false);
    });
    it('rejects -300 s - 1 ms', () => {
      expect(valid('2026-11-11T08:24:59.999Z')).to.equal(false);
    });
    it('rejects -301 s', () => {
      expect(valid('2026-11-11T08:24:59Z')).to.equal(false);
    });
    it('rejects far past', () => {
      expect(valid('2000-01-01T00:00:00Z')).to.equal(false);
      expect(valid('1970-01-01T00:00:00Z')).to.equal(false);
    });
    it('rejects far future', () => {
      expect(valid('2099-12-31T23:59:59Z')).to.equal(false);
      expect(valid('9999-12-31T23:59:59Z')).to.equal(false);
    });
    it('handles a day/year boundary (skew crosses midnight)', () => {
      const now = Date.UTC(2026, 11, 31, 23, 59, 0);
      expect(validateRequestTimestamp('2027-01-01T00:02:00Z', now, 300)).to.equal(true);
      expect(validateRequestTimestamp('2027-01-01T00:04:00Z', now, 300)).to.equal(true);
      expect(validateRequestTimestamp('2027-01-01T00:04:01Z', now, 300)).to.equal(false);
    });
    it('rejects when the injected clock is not a number (safe failure)', () => {
      expect(validateRequestTimestamp('2026-11-11T08:30:00Z', NaN, 300)).to.equal(false);
      expect(validateRequestTimestamp('2026-11-11T08:30:00Z', undefined, 300)).to.equal(false);
    });
  });

  describe('maxClockSkewSeconds', () => {
    it('uses a configured value (string, as KVM returns it)', () => {
      expect(valid('2026-11-11T08:31:00Z', '60')).to.equal(true);
      expect(valid('2026-11-11T08:31:01Z', '60')).to.equal(false);
      expect(valid('2026-11-11T08:45:00Z', '900')).to.equal(true);
      expect(valid('2026-11-11T08:45:01Z', '900')).to.equal(false);
    });
    it('accepts a numeric configured value', () => {
      expect(valid('2026-11-11T08:31:00Z', 60)).to.equal(true);
      expect(valid('2026-11-11T08:31:01Z', 60)).to.equal(false);
    });
    it('0 means no skew at all (a valid zero, not the default)', () => {
      expect(resolveMaxSkewSeconds('0')).to.equal(0);
      expect(valid('2026-11-11T08:30:00Z', '0')).to.equal(true);
      expect(valid('2026-11-11T08:30:01Z', '0')).to.equal(false);
      expect(valid('2026-11-11T08:29:59Z', '0')).to.equal(false);
    });
    it('keeps leading zeros as decimal', () => {
      expect(resolveMaxSkewSeconds('0060')).to.equal(60);
    });
    [
      ['missing (null)', null],
      ['missing (undefined)', undefined],
      ['empty string', ''],
      ['non-numeric', 'abc'],
      ['negative', '-5'],
      ['negative number', -5],
      ['decimal', '1.5'],
      ['exponent', '1e3'],
      ['padded with spaces', ' 60 '],
      ['plus sign', '+60'],
      ['NaN', NaN]
    ].forEach(([name, cfg]) => {
      it(`falls back to 300 when ${name}`, () => {
        expect(resolveMaxSkewSeconds(cfg)).to.equal(300);
        expect(valid('2026-11-11T08:35:00Z', cfg)).to.equal(true);
        expect(valid('2026-11-11T08:35:01Z', cfg)).to.equal(false);
      });
    });
  });

  describe('as run in Apigee (flag contract)', () => {
    const run = (header, skew, now) => runInApigee('validateRequestTimestamp.js', {
      'request.header.X-Request-Timestamp': header,
      'config.maxClockSkewSeconds': skew
    }, now);

    it('sets custom.timestampValid to the string "true" for a good timestamp', () => {
      expect(run('2026-11-11T08:30:00Z', '300', NOW)).to.deep.equal({ 'custom.timestampValid': 'true' });
    });
    it('sets the string "false" for a bad timestamp (flow tests != "true")', () => {
      expect(run('not-a-date', '300', NOW)).to.deep.equal({ 'custom.timestampValid': 'false' });
      expect(run(null, '300', NOW)).to.deep.equal({ 'custom.timestampValid': 'false' });
    });
    it('honours config.maxClockSkewSeconds and falls back when it is unresolved', () => {
      expect(run('2026-11-11T08:31:01Z', '60', NOW)['custom.timestampValid']).to.equal('false');
      expect(run('2026-11-11T08:31:00Z', '60', NOW)['custom.timestampValid']).to.equal('true');
      expect(run('2026-11-11T08:35:00Z', null, NOW)['custom.timestampValid']).to.equal('true');
    });
    it('reads the real clock when nothing is pinned', () => {
      const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      expect(run(ts, '300')['custom.timestampValid']).to.equal('true');
      expect(run('2000-01-01T00:00:00Z', '300')['custom.timestampValid']).to.equal('false');
    });
  });
});
