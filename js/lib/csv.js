'use strict';
/* ─── CSV cells ───
   DOM-free, so node tests can load it. Metadata values come from the file
   (an EXIF Artist, a PDF Title, an ID3 comment) and are untrusted: a cell
   that starts with = + - @ or a tab / carriage return runs as a formula when
   the CSV is opened in Excel or LibreOffice. Such a cell gets a leading
   apostrophe, which spreadsheets read as "this is text"; then every cell is
   quoted, with inner quotes doubled. */
function csvCell(v){
  let s = String(v == null ? '' : v);
  if(/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
