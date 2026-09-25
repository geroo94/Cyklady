/**
 * @file Różnicowa synchronizacja stanu: podzbiór JSON Patch (RFC 6902).
 *
 * `diffJson(przed, po)` zwraca listę operacji `add` / `replace` / `remove`
 * ze ścieżkami JSON Pointer (RFC 6901), a `applyPatch` nakłada je bez
 * mutowania dokumentu, współdzieląc niezmienione gałęzie.
 *
 * Tablice o tej samej długości porównujemy element po elemencie. Tablica,
 * która zmieniła długość, jest podmieniana w całości. W stanie gry tablice
 * są krótkie (sloty, kolejki, trasy), więc to prosty i wystarczający kompromis.
 */

export type PatchOp =
  | { readonly op: 'add' | 'replace'; readonly path: string; readonly value: unknown }
  | { readonly op: 'remove'; readonly path: string };

type JsonObject = { readonly [key: string]: unknown };

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const escapeSegment = (segment: string): string => segment.replaceAll('~', '~0').replaceAll('/', '~1');
const unescapeSegment = (segment: string): string => segment.replaceAll('~1', '/').replaceAll('~0', '~');

/** Głęboka równość wartości zgodnych z JSON. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => jsonEqual(item, b[i]));
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]));
  }
  return false;
}

/** Operacje, które zamieniają `before` w `after`. */
export function diffJson(before: unknown, after: unknown, path = ''): PatchOp[] {
  if (jsonEqual(before, after)) return [];
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    return before.flatMap((item, i) => diffJson(item, after[i], `${path}/${i}`));
  }
  if (isObject(before) && isObject(after)) {
    const ops: PatchOp[] = [];
    for (const key of Object.keys(before)) {
      if (!Object.hasOwn(after, key)) ops.push({ op: 'remove', path: `${path}/${escapeSegment(key)}` });
    }
    for (const key of Object.keys(after)) {
      const childPath = `${path}/${escapeSegment(key)}`;
      if (!Object.hasOwn(before, key)) ops.push({ op: 'add', path: childPath, value: after[key] });
      else ops.push(...diffJson(before[key], after[key], childPath));
    }
    return ops;
  }
  return [{ op: 'replace', path, value: after }];
}

/** Nakłada operacje na dokument i zwraca nowy dokument (wejście pozostaje nietknięte). */
export function applyPatch<T>(document: T, ops: readonly PatchOp[]): T {
  let result: unknown = document;
  for (const op of ops) result = applyOne(result, op);
  return result as T;
}

function applyOne(document: unknown, op: PatchOp): unknown {
  if (op.path === '') {
    if (op.op === 'remove') throw new Error('Nie można usunąć korzenia dokumentu');
    return op.value;
  }
  if (!op.path.startsWith('/')) throw new Error(`Niepoprawna ścieżka JSON Pointer: ${op.path}`);
  const segments = op.path.slice(1).split('/').map(unescapeSegment);
  return setIn(document, segments, op);
}

function setIn(node: unknown, segments: readonly string[], op: PatchOp): unknown {
  const [head, ...rest] = segments;
  if (head === undefined) throw new Error('Pusta ścieżka');
  if (Array.isArray(node)) {
    const index = Number(head);
    if (!Number.isInteger(index) || index < 0 || index >= node.length) throw new Error(`Indeks poza tablicą: ${head}`);
    const copy = [...node];
    if (rest.length > 0) copy[index] = setIn(node[index], rest, op);
    else if (op.op === 'remove') copy.splice(index, 1);
    else copy[index] = op.value;
    return copy;
  }
  if (!isObject(node)) throw new Error(`Ścieżka prowadzi przez wartość prostą przy „${head}”`);
  if (rest.length > 0) {
    if (!Object.hasOwn(node, head)) throw new Error(`Brak klucza „${head}”`);
    return { ...node, [head]: setIn(node[head], rest, op) };
  }
  if (op.op === 'remove') {
    const { [head]: _removed, ...others } = node;
    return others;
  }
  if (op.op === 'replace' && !Object.hasOwn(node, head)) throw new Error(`Brak klucza „${head}” do podmiany`);
  return { ...node, [head]: op.value };
}
