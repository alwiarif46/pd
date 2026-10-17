// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { returnTarget } from './focus-return';

afterEach(() => {
  document.body.innerHTML = '';
});

function button(label: string) {
  const el = document.createElement('button');
  el.textContent = label;
  document.body.appendChild(el);
  return el;
}

describe('returnTarget with a tab-supplied finder', () => {
  it('prefers the live opener of the same row, without asking the finder', () => {
    const opener = button('open');
    let asked = false;
    const found = returnTarget({ element: opener, rowId: 'r1' }, 'r1', () => {
      asked = true;
      return button('other');
    });
    expect(found).toBe(opener);
    expect(asked).toBe(false);
  });

  it('asks the finder when the opener is gone or the row changed', () => {
    const opener = button('open');
    const target = button('row 2');
    opener.remove();
    expect(returnTarget({ element: opener, rowId: 'r1' }, 'r1', (id) => (id === 'r1' ? target : null))).toBe(target);
    const live = button('live');
    expect(returnTarget({ element: live, rowId: 'r1' }, 'r2', (id) => (id === 'r2' ? target : null))).toBe(target);
  });

  it('falls back to the data attributes, then to a live opener', () => {
    const marked = button('marked');
    marked.setAttribute('data-row', 'r2');
    const live = button('live');
    expect(returnTarget({ element: live, rowId: 'r1' }, 'r2', () => null)).toBe(marked);
    expect(returnTarget({ element: live, rowId: 'r1' }, 'r3', () => null)).toBe(live);
  });
});
