/** Obsidian components have a chainable .then() method. Never return a component
 * from Promise cleanup: Promise assimilation repeatedly resolves it to itself. */
export function finishUiAction(work: Promise<void>, cleanup: () => unknown): Promise<void> {
  return work.finally(() => { cleanup(); });
}
