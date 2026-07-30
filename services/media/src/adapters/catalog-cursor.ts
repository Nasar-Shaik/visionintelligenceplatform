/**
 * Opaque forward-cursor codec for the media catalog (P2-2 G-2). A cursor encodes the last row's
 * keyset `(sortKey, id)` so the next page continues strictly after it (newest-first). Base64url,
 * no PII — same pattern as the events store.
 */
export interface CatalogCursor {
  sortKey: string;
  id: string;
}

export function encodeCursor(c: CatalogCursor): string {
  return Buffer.from(`${c.sortKey}|${c.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): CatalogCursor | undefined {
  try {
    const [sortKey, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
    return sortKey && id ? { sortKey, id } : undefined;
  } catch {
    return undefined;
  }
}
