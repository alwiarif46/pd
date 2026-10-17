/** What can take focus inside a row element (the row's own link or button). */
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The focusable element for a row of the open tab, found by id: the element marked `data-row`, `data-row-id`
 * or `data-activity` (the Schedule port's table rows and calendar bars) when it is focusable itself, else the
 * first focusable element inside it. Null when no element on the page is marked with the id.
 */
export function rowElement(rowId: string, root: ParentNode = document): HTMLElement | null {
  const id = rowId.replace(/["\\]/g, '\\$&');
  const marked = root.querySelector<HTMLElement>(`[data-row="${id}"], [data-row-id="${id}"], [data-activity="${id}"]`);
  if (!marked) return null;
  return marked.matches(FOCUSABLE) ? marked : (marked.querySelector<HTMLElement>(FOCUSABLE) ?? marked);
}

/** The element that had focus when the slider opened, and the row it was opened for. */
export interface Opener {
  element: HTMLElement;
  rowId: string;
}

/** The focused element now, as the slider's opener; null when nothing but the page has focus. */
export function currentOpener(rowId: string): Opener | null {
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? { element: active, rowId } : null;
}

/**
 * Where focus goes when the slider closes (09 s5.17: "the container returns it to the row"): the opener, when
 * it is still on the page and the slider still shows the row it was opened for; otherwise the shown row's
 * element (after a jump to another row, or when the opener is gone); otherwise the opener if it is still there.
 */
export function returnTarget(opener: Opener | null, rowId: string): HTMLElement | null {
  const live = opener?.element.isConnected ? opener.element : null;
  if (live && opener?.rowId === rowId) return live;
  return rowElement(rowId) ?? live;
}
