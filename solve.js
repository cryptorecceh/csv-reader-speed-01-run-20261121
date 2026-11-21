// Fast drop-in for csv-reader 1.0.0 (make.fun's own reference program).
//
// Same answer as csv-reader 1.0.0's readCsv for every input {text, header}:
// {columns, rows, errors}. Same broken-row policy, byte for byte in meaning:
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled,
//     "" inside it one quote and each CRLF or lone CR inside it read as LF;
//     what follows its closing quote, up to the next comma or line break, is
//     appended as it stands (quote_junk, when the field ends); a quote that
//     never closes is a literal character, and the text after it is read again
//     as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds
//     the records after it, each padded with "" (short_row) or cut (long_row)
//     to the first record's width;
//   - each error is {code, line, row}, in the order met, line the 1-based line
//     its record starts on, row its record's index in rows (null for the header).
//
// Speed: the reference reads one character at a time and builds every field
// a character at a time. This one scans with indexOf (V8's native search) and
// slices whole fields at once, so the common case — a plain unquoted field,
// a quoted field with no line break inside — costs a couple of native scans
// and one slice, and no object is allocated per field: the field readers
// report through shared locals. No dependencies, no state kept between calls,
// no clock, no randomness. Pure ES module, standard library only (nothing
// to import).

/** How a field ended: at a comma, at a line break, or at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** The reading of one CSV input, {text, header}: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The field just read: its value, how it ended, and how many characters
  // the last readUnquoted call kept (for quote_junk).
  let fValue = '';
  let fEnded = END;
  let fAdded = 0;

  // Line breaks in the quoted segment just converted.
  let segLines = 0;

  // A quoted field's segment, with its CRs turned into LFs and its line
  // breaks counted into segLines. The fast path (no CR, no LF) returns the
  // segment untouched with 0.
  function convertSegment(seg) {
    if (seg.indexOf('\r') < 0) {
      if (seg.indexOf('\n') < 0) {
        segLines = 0;
        return seg;
      }
      let n = 0;
      let i = -1;
      while ((i = seg.indexOf('\n', i + 1)) >= 0) n += 1;
      segLines = n;
      return seg;
    }
    const conv = seg.replace(/\r\n?/g, '\n');
    let n = 0;
    let i = -1;
    while ((i = conv.indexOf('\n', i + 1)) >= 0) n += 1;
    segLines = n;
    return conv;
  }

  // Stray CRs inside an unquoted stretch: one stray_cr error each, dropped.
  // `seg` holds no line break; returns the stretch with its CRs removed.
  function stripStrayCr(seg) {
    const parts = seg.split('\r');
    for (let k = 0; k < parts.length - 1; k += 1) {
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
    }
    return parts.join('');
  }

  // Reads unquoted characters onto `value` up to the next comma or line break:
  // a CR not followed by LF is dropped (stray_cr). Reports through fValue,
  // fEnded and fAdded (characters kept in this call).
  function readUnquoted(value) {
    let added = 0;
    let iComma = text.indexOf(',', pos);
    if (iComma < 0) iComma = len;
    let iLf = text.indexOf('\n', pos);
    if (iLf < 0) iLf = len;
    if (iComma < iLf) {
      // Ends at a comma. Every CR in the stretch is stray.
      if (iComma !== pos) {
        const seg = text.slice(pos, iComma);
        if (seg.indexOf('\r') < 0) {
          value = value === '' ? seg : value + seg;
          added = seg.length;
        } else {
          const clean = stripStrayCr(seg);
          value = value === '' ? clean : value + clean;
          added = clean.length;
        }
      }
      pos = iComma + 1;
      fValue = value;
      fEnded = COMMA;
      fAdded = added;
      return;
    }
    if (iLf < len) {
      // Ends at a line break. A CR right before the LF is the CRLF half.
      if (iLf !== pos) {
        let seg = text.slice(pos, iLf);
        if (seg.charCodeAt(seg.length - 1) === 13) seg = seg.slice(0, -1);
        if (seg.length > 0) {
          if (seg.indexOf('\r') < 0) {
            value = value === '' ? seg : value + seg;
            added = seg.length;
          } else {
            const clean = stripStrayCr(seg);
            value = value === '' ? clean : value + clean;
            added = clean.length;
          }
        }
      }
      pos = iLf + 1;
      line += 1;
      fValue = value;
      fEnded = LINE_BREAK;
      fAdded = added;
      return;
    }
    // Ends at the end of the text. Every CR left is stray.
    if (pos !== len) {
      const seg = text.slice(pos);
      if (seg.indexOf('\r') < 0) {
        value = value === '' ? seg : value + seg;
        added = seg.length;
      } else {
        const clean = stripStrayCr(seg);
        value = value === '' ? clean : value + clean;
        added = clean.length;
      }
    }
    pos = len;
    fValue = value;
    fEnded = END;
    fAdded = added;
  }

  // Reads a quoted field whose opening quote is at pos. Reports through
  // fValue, fEnded and fAdded.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    let p = pos + 1;
    let extraLines = 0;
    for (;;) {
      const q = text.indexOf('"', p);
      if (q < 0) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        pos = open + 1;
        line = openLine;
        readUnquoted('"');
        return;
      }
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote is one quote inside the field.
        if (q > p) {
          value += convertSegment(text.slice(p, q));
          extraLines += segLines;
        }
        value += '"';
        p = q + 2;
        continue;
      }
      // The closing quote.
      if (q > p) {
        value += convertSegment(text.slice(p, q));
        extraLines += segLines;
      }
      line += extraLines;
      pos = q + 1;
      break;
    }
    if (pos >= len) {
      fValue = value;
      fEnded = END;
      fAdded = 0;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fValue = value;
      fEnded = COMMA;
      fAdded = 0;
      return;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fValue = value;
      fEnded = LINE_BREAK;
      fAdded = 0;
      return;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fValue = value;
      fEnded = LINE_BREAK;
      fAdded = 0;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the next
    // comma or line break.
    readUnquoted(value);
    if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      if (quoted) readQuoted();
      else readUnquoted('');
      fields.push(fValue);
    } while (fEnded === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
