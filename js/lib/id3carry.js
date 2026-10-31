'use strict';
/* ─── ID3 carry-over ───
   DOM-free, so node tests can load it.

   browser-id3-writer 4.4.0 writes a fresh ID3v2 tag: addTag() calls
   removeTag() first, so every frame not set again in that call is gone
   (artwork, album artist, lyrics, disc number…). This turns what jsmediatags
   read (its `tags` object, which carries every raw frame keyed by id next to
   the title/artist/… shortcuts) into the setFrame() calls that put the
   untouched frames back, and lists the frames the writer cannot write, so
   the user is told before they are dropped.

   id3CarryPlan(tags) → { frames: [[id, value], …], lost: [id, …] }
   Frames edited in the table (title, artist, album, year, genre, track,
   comment) are not in either list: the writer sets those from the edits. */
const ID3_V22_IDS = {
  TT1: 'TIT1', TT2: 'TIT2', TT3: 'TIT3', TP1: 'TPE1', TP2: 'TPE2', TP3: 'TPE3', TP4: 'TPE4',
  TAL: 'TALB', TYE: 'TYER', TCO: 'TCON', TRK: 'TRCK', COM: 'COMM', TPA: 'TPOS', TCM: 'TCOM',
  TBP: 'TBPM', ULT: 'USLT', PIC: 'APIC', TXX: 'TXXX', TCR: 'TCOP', TPB: 'TPUB', TKE: 'TKEY',
  TRC: 'TSRC', TLA: 'TLAN', TMT: 'TMED', TXT: 'TEXT', TLE: 'TLEN',
  WCM: 'WCOM', WCP: 'WCOP', WAF: 'WOAF', WAR: 'WOAR', WAS: 'WOAS', WPB: 'WPUB',
};
// Set from the editable rows by writeMP3.
const ID3_EDITED_IDS = ['TIT2', 'TPE1', 'TALB', 'TYER', 'TCON', 'TRCK', 'COMM'];
// Plain text frames the writer takes as a string (one per tag).
const ID3_STRING_IDS = ['TIT1', 'TIT3', 'TPE2', 'TPE3', 'TPE4', 'TPOS', 'TMED', 'TPUB', 'TCOP', 'TKEY', 'TEXT', 'TSRC', 'TLAN'];
const ID3_INT_IDS = ['TBPM', 'TLEN'];
const ID3_URL_IDS = ['WCOM', 'WCOP', 'WOAF', 'WOAR', 'WOAS', 'WORS', 'WPAY', 'WPUB'];
// jsmediatags reports the APIC picture type as this text; the writer wants its index.
const ID3_PICTURE_TYPES = ("Other;32x32 pixels 'file icon' (PNG only);Other file icon;Cover (front);Cover (back);Leaflet page;"
  + 'Media (e.g. label side of CD);Lead artist/lead performer/soloist;Artist/performer;Conductor;Band/Orchestra;Composer;'
  + 'Lyricist/text writer;Recording Location;During recording;During performance;Movie/video screen capture;'
  + 'A bright coloured fish;Illustration;Band/artist logotype;Publisher/Studio logotype').split(';');

function id3CarryPlan(tags){
  const frames = [], lost = [];
  const loseOnce = id => { if(lost.indexOf(id) < 0) lost.push(id); };
  const t = tags || {};
  for(const raw of Object.keys(t)){
    if(!/^[A-Z0-9]{3,4}$/.test(raw)) continue;            // title, artist, picture… are shortcuts
    const id = raw.length === 3 ? (ID3_V22_IDS[raw] || raw) : raw;
    const list = [].concat(t[raw]).filter(f => f && f.data != null);
    if(!list.length) continue;
    if(ID3_EDITED_IDS.indexOf(id) >= 0){
      if(id === 'COMM' && list.length > 1) loseOnce('COMM');  // only the first comment is editable
      continue;
    }
    if(id === 'TDRC'){
      // ID3v2.4 recording time. The writer has no TDRC; a bare year is
      // written as TYER (the year row is filled from it), a full date is lost.
      if(!/^\d{4}$/.test(String(list[0].data).trim())) loseOnce(id);
      continue;
    }
    if(id === 'APIC'){
      for(const f of list){
        const d = f.data;
        if(!d || !d.data || !d.data.length){ loseOnce(id); continue; }
        const ix = ID3_PICTURE_TYPES.indexOf(d.type);
        frames.push([id, { type: ix >= 0 ? ix : 3, data: Uint8Array.from(d.data).buffer, description: String(d.description || '') }]);
      }
      continue;
    }
    if(id === 'TXXX'){
      for(const f of list) frames.push([id, { description: String(f.data.user_description || ''), value: String(f.data.data || '') }]);
      continue;
    }
    if(id === 'USLT'){
      for(const f of list){
        const lang = String(f.data.language || '');
        frames.push([id, { language: /^[a-z]{3}$/i.test(lang) ? lang : 'eng', description: String(f.data.descriptor || ''), lyrics: String(f.data.lyrics || '') }]);
      }
      continue;
    }
    if(id === 'TCOM'){ frames.push([id, [String(list[0].data)]]); continue; }
    if(ID3_STRING_IDS.indexOf(id) >= 0 || ID3_URL_IDS.indexOf(id) >= 0){
      if(typeof list[0].data === 'string' && list[0].data !== '') frames.push([id, list[0].data]);
      else if(typeof list[0].data !== 'string') loseOnce(id);
      continue;
    }
    if(ID3_INT_IDS.indexOf(id) >= 0){
      const n = parseInt(list[0].data, 10);
      if(isNaN(n)) loseOnce(id); else frames.push([id, n]);
      continue;
    }
    loseOnce(id);
  }
  return { frames, lost };
}

// The year to show when the tag has no TYER but an ID3v2.4 TDRC.
function id3YearFallback(tags){
  const d = tags && (tags.TDRC || tags.TYER);
  const f = [].concat(d || [])[0];
  const m = f && f.data != null ? /^\s*(\d{4})/.exec(String(f.data)) : null;
  return m ? m[1] : '';
}
