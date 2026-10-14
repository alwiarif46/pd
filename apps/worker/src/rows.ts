/**
 * Fails the job when an update by id did not change exactly one row: the row was deleted,
 * belongs to another organization, or the payload is wrong. Without this the update would
 * be lost silently.
 */
export function expectOneRow(what: string, rows: readonly unknown[]): void {
  if (rows.length !== 1) {
    const message = `Expected to update one ${what}, updated ${rows.length}`;
    console.error(message);
    throw new Error(message);
  }
}
