/**
 * A strict RFC 4180 reader for tests, written independently of
 * `shared/utils/csv.ts` so export tests check what a CSV consumer would
 * actually read back rather than comparing against the writer's own logic.
 *
 * Requires CRLF record endings (a final CRLF included) and rejects anything
 * malformed — a stray quote, a bare LF, text after a closing quote — so a
 * writer bug shows up as a parse failure, not as a silently shifted value.
 */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let i = 0;
  let atFieldStart = true;

  const endField = () => {
    record.push(field);
    field = "";
    atFieldStart = true;
  };

  while (i < text.length) {
    const char = text[i];

    if (atFieldStart && char === '"') {
      // Quoted field: runs to the closing quote; `""` is a literal quote.
      i++;
      for (;;) {
        if (i >= text.length) throw new Error("parseCsv: unterminated quoted field");
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        field += text[i++];
      }
      atFieldStart = false;
      if (i < text.length && text[i] !== "," && text[i] !== "\r") {
        throw new Error(`parseCsv: unexpected text after a quoted field at ${i}`);
      }
      continue;
    }

    if (char === ",") {
      endField();
      i++;
      continue;
    }

    if (char === "\r") {
      if (text[i + 1] !== "\n") throw new Error(`parseCsv: bare CR at ${i}`);
      endField();
      records.push(record);
      record = [];
      i += 2;
      continue;
    }

    if (char === "\n") throw new Error(`parseCsv: bare LF at ${i}`);
    if (char === '"') throw new Error(`parseCsv: quote inside an unquoted field at ${i}`);

    field += char;
    atFieldStart = false;
    i++;
  }

  if (field !== "" || record.length > 0) {
    throw new Error("parseCsv: the last record is not terminated by CRLF");
  }

  return records;
}

/** Characters that start a formula in some spreadsheet (see `shared/utils/csv.ts`). */
const FORMULA_START = /^[=+\-@\t\r\uFF1D\uFF0B\uFF0D\uFF20]/;
const PLAIN_NUMERAL = /^-?\d+(\.\d+)?$/;

/**
 * Cells of a parsed CSV that a spreadsheet could evaluate: they start — after
 * any leading whitespace an importer might trim — with a formula character,
 * and are not a plain numeral (a negative amount is a number, not a formula).
 * Deliberately independent of the writer's own check.
 */
export function formulaCells(records: string[][]): string[] {
  return records
    .flat()
    .filter(
      (cell) =>
        (FORMULA_START.test(cell) || FORMULA_START.test(cell.trimStart())) &&
        !PLAIN_NUMERAL.test(cell),
    );
}
