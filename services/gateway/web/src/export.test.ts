import { describe, expect, it } from 'vitest';
import { xmlText } from './export';

describe('xmlText', () => {
  it('escapes markup and drops characters XML 1.0 does not allow', () => {
    expect(xmlText('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
    expect(xmlText('bell\u0007 tab\t line\n cr\r vt\u000b ff\u000c esc\u001b nul\u0000 ￿')).toBe(
      'bell tab\t line\n cr\r vt ff esc nul ',
    );
  });
});
