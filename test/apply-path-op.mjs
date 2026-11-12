/**
 * Apply a settings path op immutably. `set` creates missing parents; `unset`
 * removes the leaf and ignores missing paths.
 * @param {unknown} value - the current document (or subtree).
 * @param {string[]} path - the op's path, from the document root.
 * @param {{ op: string, value?: unknown }} op - the mutation op.
 * @returns {unknown} the next document (or subtree); inputs are never mutated.
 */
export function applyPathOp(value, path, op) {
  if (path.length === 0) return op.op === "set" ? op.value : undefined;
  const [head, ...rest] = path;
  const base =
    value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
  const child = applyPathOp(Object.hasOwn(base, head) ? base[head] : undefined, rest, op);
  const next = { ...base };
  if (child === undefined) delete next[head];
  else next[head] = child;
  return next;
}
