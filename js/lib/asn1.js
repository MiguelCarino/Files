'use strict';
/* ─── DER / BER reader (replaces node-forge's asn1) ───
   asn1Parse(bytes, at?, end?) reads one TLV and, for a constructed value,
   its children, into
     { cls (0 universal, 1 application, 2 context, 3 private), tag,
       constructed, start, hdr (offset of the contents), end (exclusive),
       children (constructed only) }
   Offsets index the Uint8Array that was passed. Every read is bounded by
   that buffer: a length that runs past its parent, a nesting deeper than
   ASN1_MAX_DEPTH or more than ASN1_MAX_NODES values throws. Long-form
   lengths of up to 4 bytes are read; BER's indefinite length (0x80) is read
   for constructed values, as PKCS#7 files from some tools use it.
   The value readers take (bytes, node). */
const ASN1_MAX_DEPTH = 64;
const ASN1_MAX_NODES = 200000;

function asn1Parse(bytes, at, end){
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const state = { n: 0 };
  return _asn1Node(b, at || 0, end == null ? b.length : Math.min(end, b.length), 0, state);
}
function _asn1Node(b, p, limit, depth, state){
  if(depth > ASN1_MAX_DEPTH) throw new Error('ASN.1: nested too deep');
  if(++state.n > ASN1_MAX_NODES) throw new Error('ASN.1: too many values');
  const start = p;
  if(p + 2 > limit) throw new Error('ASN.1: truncated at ' + p);
  const id = b[p++];
  const cls = id >> 6, constructed = !!(id & 0x20);
  let tag = id & 0x1f;
  if(tag === 0x1f){                               // high tag number form
    tag = 0;
    let c, k = 0;
    do {
      if(p >= limit || ++k > 4) throw new Error('ASN.1: bad tag at ' + start);
      c = b[p++];
      tag = tag * 128 + (c & 0x7f);
    } while(c & 0x80);
  }
  if(p >= limit) throw new Error('ASN.1: truncated at ' + start);
  let len = b[p++];
  let indefinite = false;
  if(len === 0x80){
    if(!constructed) throw new Error('ASN.1: indefinite length on a primitive at ' + start);
    indefinite = true;
  } else if(len & 0x80){
    const n = len & 0x7f;
    if(n > 4 || p + n > limit) throw new Error('ASN.1: bad length at ' + start);
    len = 0;
    for(let i = 0; i < n; i++) len = len * 256 + b[p++];
  }
  const hdr = p;
  const node = { cls, tag, constructed, start, hdr, end: 0 };
  if(indefinite){
    node.children = [];
    for(;;){
      if(p + 2 > limit) throw new Error('ASN.1: unterminated value at ' + start);
      if(b[p] === 0 && b[p + 1] === 0){ p += 2; break; }
      const c = _asn1Node(b, p, limit, depth + 1, state);
      node.children.push(c);
      p = c.end;
    }
    node.end = p;
    return node;
  }
  if(hdr + len > limit) throw new Error('ASN.1: length runs past its container at ' + start);
  node.end = hdr + len;
  if(constructed){
    node.children = [];
    let q = hdr;
    while(q < node.end){
      const c = _asn1Node(b, q, node.end, depth + 1, state);
      node.children.push(c);
      q = c.end;
    }
  }
  return node;
}

// The contents of a value (no header).
function asn1Body(bytes, node){ return bytes.subarray(node.hdr, node.end); }
// A universal tag test: asn1Is(node, 6) is an OBJECT IDENTIFIER.
function asn1Is(node, tag){ return !!node && node.cls === 0 && node.tag === tag; }
// A context-specific [n] child of node, or null.
function asn1Ctx(node, n){
  if(!node || !node.children) return null;
  for(const c of node.children) if(c.cls === 2 && c.tag === n) return c;
  return null;
}

// OBJECT IDENTIFIER → '1.2.840.113549.1.1.11'
// Bounded: a BigInt built byte by byte costs the square of its length, so a
// crafted OID could hold the page for minutes. Real OIDs are short; the
// longest arcs in use (2.25.<UUID>, 128 bits) take 19 bytes.
const ASN1_OID_MAX = 1024, ASN1_ARC_MAX = 20;
function asn1Oid(bytes, node){
  const b = asn1Body(bytes, node);
  if(!b.length) throw new Error('ASN.1: empty OID');
  if(b.length > ASN1_OID_MAX) throw new Error('ASN.1: OID too long');
  const arcs = [];
  let v = 0n, first = true, run = 0;
  for(let i = 0; i < b.length; i++){
    if(++run > ASN1_ARC_MAX) throw new Error('ASN.1: OID arc too long');
    if(!(b[i] & 0x80)) run = 0;
    v = (v << 7n) | BigInt(b[i] & 0x7f);
    if(b[i] & 0x80){ if(i === b.length - 1) throw new Error('ASN.1: truncated OID'); continue; }
    if(first){
      const x = v < 40n ? 0n : v < 80n ? 1n : 2n;
      arcs.push(x, v - x * 40n);
      first = false;
    } else arcs.push(v);
    v = 0n;
  }
  return arcs.join('.');
}

// INTEGER → lowercase hex with no sign padding ('00' for zero).
function asn1IntHex(bytes, node){
  const b = asn1Body(bytes, node);
  let i = 0;
  while(i < b.length - 1 && b[i] === 0) i++;
  let s = '';
  for(; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s || '00';
}
// INTEGER → BigInt (two's complement), for small numbers (a version, a
// path length): longer than maxBytes (8 by default) throws, since a BigInt
// built byte by byte costs the square of its length. Big integers (serials,
// moduli) go through asn1IntHex / asn1IntBits.
function asn1IntBig(bytes, node, maxBytes){
  const b = asn1Body(bytes, node);
  if(!b.length) return 0n;
  if(b.length > (maxBytes == null ? 8 : maxBytes)) throw new Error('ASN.1: INTEGER too long');
  let v = 0n;
  for(const x of b) v = (v << 8n) | BigInt(x);
  if(b[0] & 0x80) v -= 1n << BigInt(b.length * 8);
  return v;
}
// The number of significant bits of an unsigned INTEGER (an RSA modulus).
function asn1IntBits(bytes, node){
  const b = asn1Body(bytes, node);
  let i = 0;
  while(i < b.length && b[i] === 0) i++;
  if(i >= b.length) return 0;
  return (b.length - i - 1) * 8 + (32 - Math.clz32(b[i]));
}

// UTCTime (YYMMDDHHMM[SS]Z, years 50–99 are 19xx) or GeneralizedTime
// (YYYYMMDDHH[MM[SS[.fff]]][Z|±hhmm]) → Date.
function asn1Time(bytes, node){
  const s = _asn1Latin1(asn1Body(bytes, node));
  let m;
  if(node.tag === 23){
    m = /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?(Z|[+-]\d{4})$/.exec(s);
    if(!m) throw new Error('ASN.1: bad UTCTime ' + s);
    const yy = +m[1];
    return _asn1Date(yy < 50 ? 2000 + yy : 1900 + yy, m[2], m[3], m[4], m[5], m[6], '', m[7]);
  }
  if(node.tag === 24){
    m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)?(\d\d)?(?:[.,](\d+))?(Z|[+-]\d{4})?$/.exec(s);
    if(!m) throw new Error('ASN.1: bad GeneralizedTime ' + s);
    return _asn1Date(+m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8] || 'Z');
  }
  throw new Error('ASN.1: not a time value');
}
function _asn1Date(y, mo, d, h, mi, s, frac, zone){
  let t = Date.UTC(y, +mo - 1, +d, +h, +(mi || 0), +(s || 0), frac ? Math.round(+('0.' + frac) * 1000) : 0);
  if(zone && zone !== 'Z'){
    const off = (+zone.slice(1, 3) * 60 + +zone.slice(3, 5)) * 60000;
    t += zone[0] === '+' ? -off : off;
  }
  const out = new Date(t);
  if(isNaN(out.getTime())) throw new Error('ASN.1: bad date');
  return out;
}

const _asn1Latin1 = (b) => { let s = ''; for(let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return s; };
// A string type → text: UTF8String (12), NumericString (18), PrintableString
// (19), T61String (20, read as latin1), IA5String (22), VisibleString (26),
// UniversalString (28, UTF-32BE), BMPString (30, UTF-16BE). Others: latin1.
function asn1String(bytes, node){
  const b = asn1Body(bytes, node);
  switch(node.tag){
    case 12: return new TextDecoder('utf-8').decode(b);
    case 30: {
      let s = '';
      for(let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
      return s;
    }
    case 28: {
      let s = '';
      for(let i = 0; i + 3 < b.length; i += 4){
        const cp = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
        s += cp <= 0x10ffff ? String.fromCodePoint(cp) : '�';
      }
      return s;
    }
    default: return _asn1Latin1(b);
  }
}
// BIT STRING → { unused (bits), bytes }
function asn1Bits(bytes, node){
  const b = asn1Body(bytes, node);
  if(!b.length) throw new Error('ASN.1: empty BIT STRING');
  return { unused: b[0], bytes: b.subarray(1) };
}
const asn1Hex = (b, sep) => Array.from(b, x => x.toString(16).padStart(2, '0')).join(sep || '');
