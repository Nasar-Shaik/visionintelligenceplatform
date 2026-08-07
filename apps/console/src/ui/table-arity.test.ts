/**
 * Every table's header row must have exactly as many cells as its body rows.
 *
 * ⛔ **This exists because a table with the wrong number of headers renders perfectly.** HTML lays
 * out a row with seven cells under six headers without a warning, a console error, or a layout
 * break — it just silently shifts every column after the gap under its neighbour's caption. The
 * investigations runs table shipped that way: `Detections` sat above the frame count, `Model` above
 * the detection count, and the model id had no header at all. It survived a full four-browser
 * certification because every assertion in that suite matched *text* (`60 / 60`, `yolox-nano`),
 * and text is still present when it is standing under the wrong title.
 *
 * ⚠️ **Read as source, not rendered.** Asserting this per page would need every page mounted with
 * its own fixtures, and would only ever cover the pages someone remembered to write a test for —
 * which is exactly the gap that let this through. Parsing the source covers all of them, including
 * the ones added next year, and it is the whole reason the check is worth having.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** `<Table` but not `<TableHeader`, `<TableRow`, … — the lookahead is what separates them. */
const TABLE_OPEN = /<Table(?=[\s>])/;

function tsxFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsxFilesUnder(path));
    else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.')) out.push(path);
  }
  return out;
}

interface Row {
  file: string;
  table: number;
  heads: number;
  cells: number;
}

function mismatchedRows(): Row[] {
  const bad: Row[] = [];
  for (const file of tsxFilesUnder('src')) {
    const src = readFileSync(file, 'utf8');
    const blocks = src.split(TABLE_OPEN).slice(1).map((b) => b.split('</Table>')[0] ?? '');
    blocks.forEach((block, i) => {
      const header = /<TableHeader>([\s\S]*?)<\/TableHeader>/.exec(block)?.[1] ?? '';
      const heads = (header.match(/<TableHead[\s/>]/g) ?? []).length;
      const body = /<TableBody>([\s\S]*?)<\/TableBody>/.exec(block)?.[1] ?? '';
      for (const row of body.split(/<TableRow[\s>]/).slice(1)) {
        const cells = (row.match(/<TableCell/g) ?? []).length;
        /*
         * ⚠️ A row carrying `colSpan` is deliberately one cell across the whole table — an empty
         * state or a group heading — and comparing it to the header count would be wrong. Rows
         * with no cells at all belong to a table whose body is composed elsewhere.
         */
        if (heads === 0 || cells === 0 || /colSpan/.test(row)) continue;
        if (heads !== cells) bad.push({ file, table: i + 1, heads, cells });
      }
    });
  }
  return bad;
}

describe('table column arity', () => {
  it('gives every body row exactly as many cells as its header row', () => {
    const bad = mismatchedRows();
    const detail = bad
      .map((r) => `${r.file} table #${r.table}: ${r.heads} headers vs ${r.cells} cells`)
      .join('\n');
    expect(bad, `column headers do not line up with the row beneath them:\n${detail}`).toEqual([]);
  });

  /*
   * ⚠️ The check must be able to fail. A parser that silently matched nothing — a renamed component,
   * a changed import — would pass this file forever while checking no table at all, which is the
   * failure mode that makes a green suite worse than no suite.
   */
  it('actually finds the tables it claims to be checking', () => {
    const tables = tsxFilesUnder('src')
      .map((f) => readFileSync(f, 'utf8').split(TABLE_OPEN).length - 1)
      .reduce((a, b) => a + b, 0);
    expect(tables).toBeGreaterThan(10);
  });
});
