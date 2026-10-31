'use strict';
/* ─── Custom metadata field names (B-4) ───
   DOM-free, so node tests can load it. Which field names each metadata
   writer can store, so the add-field row can say so before anything is
   written, and the writers can refuse instead of dropping a field silently.

   canStore(format, name) → { ok, name, reason, note }
     ok      the writer can store it
     name    the canonical spelling to store it under (JPEG and MP3 names
             match case-insensitively)
     reason  when not ok, the English key that explains why ({name} var);
             null for an empty name (nothing to say yet)
     note    when ok, an English key worth showing (PDF custom property)
   writableFields(format) → the names to suggest (the <datalist>).

   PDF   any name: the standard Info keys, or a custom Info key
   JPEG  the EXIF ASCII tags the piexif writer sets (EXIF_TEXT_FIELDS)
   MP3   the friendly names the tag table uses, and the ID3v2.3 frames the
         browser-id3-writer library can write as text (ID3_TEXT_FRAMES) */
const PDF_INFO_FIELDS = ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer'];

// [name, IFD] — '0th' is piexif.ImageIFD, 'Exif' is piexif.ExifIFD.
const EXIF_TEXT_FIELDS = [
  ['ImageDescription', '0th'], ['Artist', '0th'], ['Copyright', '0th'], ['Software', '0th'],
  ['Make', '0th'], ['Model', '0th'], ['DocumentName', '0th'], ['HostComputer', '0th'],
  ['DateTimeOriginal', 'Exif'], ['DateTimeDigitized', 'Exif'], ['ImageUniqueID', 'Exif'],
  ['CameraOwnerName', 'Exif'], ['BodySerialNumber', 'Exif'], ['LensMake', 'Exif'], ['LensModel', 'Exif'],
];

const ID3_FRIENDLY = ['title', 'artist', 'album', 'year', 'genre', 'track', 'comment'];
// The frames behind the friendly names: typing one means that row.
const ID3_FRIENDLY_FRAMES = { TIT2: 'title', TPE1: 'artist', TALB: 'album', TYER: 'year', TCON: 'genre', TRCK: 'track', COMM: 'comment' };
// Other frames → value kind for browser-id3-writer: 'list' (string array), 'int', or 'text'.
const ID3_TEXT_FRAMES = {
  TCOM: 'list',
  TIT1: 'text', TIT3: 'text', TPE2: 'text', TPE3: 'text', TPE4: 'text',
  TPOS: 'text', TMED: 'text', TPUB: 'text', TCOP: 'text', TKEY: 'text', TEXT: 'text',
  TSRC: 'text', TLAN: 'text',
  TBPM: 'int', TLEN: 'int', TDAT: 'int',
};

function writableFields(format){
  if(format === 'pdf') return PDF_INFO_FIELDS.slice();
  if(format === 'jpeg') return EXIF_TEXT_FIELDS.map(f => f[0]);
  if(format === 'mp3') return ID3_FRIENDLY.concat(Object.keys(ID3_TEXT_FRAMES));
  return [];
}

function canStore(format, name){
  const raw = String(name == null ? '' : name).trim();
  if(!raw) return { ok: false, name: '', reason: null, note: null };
  if(format === 'pdf'){
    const std = PDF_INFO_FIELDS.find(f => f.toLowerCase() === raw.toLowerCase());
    if(std) return { ok: true, name: std, reason: null, note: null };
    return { ok: true, name: raw, reason: null, note: 'Saved as a custom PDF property' };
  }
  if(format === 'mp3'){
    const alias = ID3_FRIENDLY_FRAMES[raw.toUpperCase()];
    if(alias) return { ok: true, name: alias, reason: null, note: null };
  }
  if(format === 'jpeg' || format === 'mp3'){
    const hit = writableFields(format).find(f => f.toLowerCase() === raw.toLowerCase());
    if(hit) return { ok: true, name: hit, reason: null, note: null };
    return { ok: false, name: raw, note: null,
      reason: format === 'jpeg' ? "JPEG can't store “{name}”. Use one of the suggested names."
                                : "MP3 can't store “{name}”. Use one of the suggested names." };
  }
  return { ok: false, name: raw, reason: null, note: null };
}
