'use strict';
/* ─── X.509 certificate reader (replaces node-forge's pki) ───
   Needs js/lib/asn1.js. Describes a certificate; never verifies one.
   - pemToDer(text) → [{ label, der }] for every -----BEGIN …----- block.
   - x509Certificates(bytes) → [der, …]: the certificates in a PEM file
     (CERTIFICATE / TRUSTED CERTIFICATE / PKCS7 blocks), a DER certificate,
     or a DER PKCS#7 SignedData bundle (.p7b).
   - parseCertificate(der) → { version, serial, sigAlg, issuer, subject,
     notBefore, notAfter, spki: { alg, curve, bits, label }, extensions:
     { san, keyUsage, extKeyUsage, basicConstraints, ski, aki },
     fingerprintInput }
     issuer and subject are { text: 'CN=…, O=…', attrs: [{ oid, name, value }] };
     sigAlg is { oid, name }; fingerprintInput is the certificate's DER
     (what a SHA-1 / SHA-256 fingerprint is computed over).
   An algorithm or curve this table does not know is shown by its dotted OID. */
const X509_NAMES = {
  '2.5.4.3': 'CN', '2.5.4.4': 'SN', '2.5.4.5': 'serialNumber', '2.5.4.6': 'C', '2.5.4.7': 'L',
  '2.5.4.8': 'ST', '2.5.4.9': 'street', '2.5.4.10': 'O', '2.5.4.11': 'OU', '2.5.4.12': 'title',
  '2.5.4.17': 'postalCode', '2.5.4.42': 'GN', '2.5.4.43': 'initials', '2.5.4.46': 'dnQualifier',
  '2.5.4.65': 'pseudonym', '2.5.4.97': 'organizationIdentifier',
  '1.2.840.113549.1.9.1': 'E', '0.9.2342.19200300.100.1.25': 'DC', '0.9.2342.19200300.100.1.1': 'UID',
  '1.3.6.1.4.1.311.60.2.1.3': 'jurisdictionC', '2.5.4.15': 'businessCategory',
};
const X509_SIG = {
  '1.2.840.113549.1.1.2': 'MD2 with RSA', '1.2.840.113549.1.1.4': 'MD5 with RSA',
  '1.2.840.113549.1.1.5': 'SHA-1 with RSA', '1.2.840.113549.1.1.14': 'SHA-224 with RSA',
  '1.2.840.113549.1.1.11': 'SHA-256 with RSA', '1.2.840.113549.1.1.12': 'SHA-384 with RSA',
  '1.2.840.113549.1.1.13': 'SHA-512 with RSA', '1.2.840.113549.1.1.10': 'RSASSA-PSS',
  '1.2.840.10045.4.1': 'ECDSA with SHA-1', '1.2.840.10045.4.3.1': 'ECDSA with SHA-224',
  '1.2.840.10045.4.3.2': 'ECDSA with SHA-256', '1.2.840.10045.4.3.3': 'ECDSA with SHA-384',
  '1.2.840.10045.4.3.4': 'ECDSA with SHA-512',
  '1.3.101.112': 'Ed25519', '1.3.101.113': 'Ed448',
  '1.2.840.10040.4.3': 'DSA with SHA-1', '2.16.840.1.101.3.4.3.2': 'DSA with SHA-256',
};
const X509_HASH = {
  '1.3.14.3.2.26': 'SHA-1', '2.16.840.1.101.3.4.2.4': 'SHA-224', '2.16.840.1.101.3.4.2.1': 'SHA-256',
  '2.16.840.1.101.3.4.2.2': 'SHA-384', '2.16.840.1.101.3.4.2.3': 'SHA-512',
};
const X509_CURVES = {
  '1.2.840.10045.3.1.7': ['P-256', 256], '1.3.132.0.34': ['P-384', 384], '1.3.132.0.35': ['P-521', 521],
  '1.3.132.0.10': ['secp256k1', 256], '1.2.840.10045.3.1.1': ['P-192', 192], '1.3.132.0.33': ['P-224', 224],
  '1.3.36.3.3.2.8.1.1.7': ['brainpoolP256r1', 256], '1.3.36.3.3.2.8.1.1.11': ['brainpoolP384r1', 384],
  '1.3.36.3.3.2.8.1.1.13': ['brainpoolP512r1', 512],
};
const X509_EKU = {
  '1.3.6.1.5.5.7.3.1': 'serverAuth', '1.3.6.1.5.5.7.3.2': 'clientAuth', '1.3.6.1.5.5.7.3.3': 'codeSigning',
  '1.3.6.1.5.5.7.3.4': 'emailProtection', '1.3.6.1.5.5.7.3.8': 'timeStamping', '1.3.6.1.5.5.7.3.9': 'OCSPSigning',
  '2.5.29.37.0': 'anyExtendedKeyUsage',
};
const X509_KU = ['digitalSignature', 'nonRepudiation', 'keyEncipherment', 'dataEncipherment', 'keyAgreement',
  'keyCertSign', 'cRLSign', 'encipherOnly', 'decipherOnly'];

// Scanned with indexOf, not one lazy regex: a BEGIN line with no END made
// the regex rescan to the end of the text each time (quadratic on a crafted
// file). A BEGIN without its END ends the scan.
function pemToDer(text){
  const out = [];
  const t = String(text), BEGIN = '-----BEGIN ', DASH = '-----';
  let at = 0;
  while(true){
    const b = t.indexOf(BEGIN, at);
    if(b < 0) break;
    const ls = b + BEGIN.length, le = t.indexOf(DASH, ls);
    if(le < 0) break;
    const raw = t.slice(ls, le);
    if(!raw || raw.length > 64 || !/^[A-Z0-9 ]+$/.test(raw)){ at = ls; continue; }
    const endTag = DASH + 'END ' + raw + DASH, bodyStart = le + DASH.length;
    const e = t.indexOf(endTag, bodyStart);
    if(e < 0) break;
    at = e + endTag.length;
    // Skip RFC 7468 header lines (Proc-Type: …) and keep the base64.
    const body = t.slice(bodyStart, e).split(/\r?\n/).filter(l => l.indexOf(':') < 0).join('').replace(/\s+/g, '');
    let bin;
    try { bin = atob(body); } catch(_){ throw new Error('PEM: bad base64 in ' + raw.trim()); }
    const der = new Uint8Array(bin.length);
    for(let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
    out.push({ label: raw.trim(), der });
  }
  return out;
}

// The certificates inside a PKCS#7 SignedData ContentInfo (DER or BER).
function pkcs7Certificates(der){
  const ci = asn1Parse(der);
  const k = ci.children || [];
  if(!asn1Is(k[0], 6) || asn1Oid(der, k[0]) !== '1.2.840.113549.1.7.2') throw new Error('PKCS#7: not SignedData');
  const wrap = asn1Ctx(ci, 0);
  const sd = wrap && wrap.children && wrap.children[0];
  if(!sd || !sd.children) throw new Error('PKCS#7: no SignedData');
  const set = asn1Ctx(sd, 0);
  if(!set || !set.children) return [];
  return set.children.filter(c => asn1Is(c, 16)).map(c => der.subarray(c.start, c.end));
}

function x509Certificates(bytes){
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let i = 0;
  while(i < b.length && (b[i] === 0x20 || b[i] === 0x09 || b[i] === 0x0a || b[i] === 0x0d || b[i] === 0xef || b[i] === 0xbb || b[i] === 0xbf)) i++;
  if(b[i] === 0x2d){                                       // '-': PEM text
    const out = [];
    for(const blk of pemToDer(new TextDecoder().decode(b))){
      if(/^(X509 |TRUSTED )?CERTIFICATE$/.test(blk.label)) out.push(blk.der);
      else if(/^PKCS ?7$|^CMS$/.test(blk.label)) out.push(...pkcs7Certificates(blk.der));
    }
    return out;
  }
  const top = asn1Parse(b);
  const k = top.children || [];
  if(asn1Is(k[0], 6)) return pkcs7Certificates(b.subarray(0, top.end));
  return [b.subarray(0, top.end)];
}

function _x509Name(der, node){
  const attrs = [];
  for(const rdn of node.children || []){
    for(const atv of rdn.children || []){
      const [o, v] = atv.children || [];
      if(!asn1Is(o, 6) || !v) continue;
      const oid = asn1Oid(der, o);
      attrs.push({ oid, name: X509_NAMES[oid] || oid, value: v.constructed ? asn1Hex(asn1Body(der, v)) : asn1String(der, v) });
    }
  }
  return { attrs, text: attrs.map(a => a.name + '=' + a.value).join(', ') };
}

function _x509AlgName(der, alg){
  const k = alg.children || [];
  const oid = asn1Oid(der, k[0]);
  let name = X509_SIG[oid] || oid;
  // RSASSA-PSS names its hash in the parameters: [0] { hashAlgorithm }.
  if(oid === '1.2.840.113549.1.1.10' && k[1] && k[1].children){
    const h = asn1Ctx(k[1], 0);
    const hAlg = h && h.children && h.children[0];
    const hOid = hAlg && hAlg.children && hAlg.children[0] && asn1Oid(der, hAlg.children[0]);
    name += ' (' + (hOid ? (X509_HASH[hOid] || hOid) : 'SHA-1') + ')';
  }
  return { oid, name };
}

function _x509Spki(der, node){
  const [alg, key] = node.children || [];
  const ak = (alg && alg.children) || [];
  const oid = asn1Oid(der, ak[0]);
  const out = { oid, alg: oid, curve: null, bits: null, label: oid };
  if(oid === '1.2.840.113549.1.1.1' || oid === '1.2.840.113549.1.1.10'){
    out.alg = oid === '1.2.840.113549.1.1.1' ? 'RSA' : 'RSA-PSS';
    try {
      const bits = asn1Bits(der, key);
      const seq = asn1Parse(bits.bytes);
      out.bits = asn1IntBits(bits.bytes, seq.children[0]);
    } catch(_){}
    out.label = out.alg + (out.bits ? ' ' + out.bits : '');
  } else if(oid === '1.2.840.10045.2.1'){
    out.alg = 'EC';
    if(asn1Is(ak[1], 6)){
      const c = asn1Oid(der, ak[1]);
      const known = X509_CURVES[c];
      out.curve = known ? known[0] : c;
      out.bits = known ? known[1] : null;
    } else out.curve = 'explicit parameters';
    out.label = 'ECDSA ' + out.curve;
  } else if(oid === '1.3.101.112' || oid === '1.3.101.113' || oid === '1.3.101.110' || oid === '1.3.101.111'){
    out.alg = { '1.3.101.112': 'Ed25519', '1.3.101.113': 'Ed448', '1.3.101.110': 'X25519', '1.3.101.111': 'X448' }[oid];
    out.curve = out.alg;
    out.bits = { Ed25519: 255, Ed448: 448, X25519: 255, X448: 448 }[out.alg];
    out.label = out.alg;
  } else if(oid === '1.2.840.10040.4.1'){
    out.alg = 'DSA';
    out.label = 'DSA';
  }
  return out;
}

function _x509Ip(b){
  if(b.length === 4) return Array.from(b).join('.');
  if(b.length === 16){
    const g = [];
    for(let i = 0; i < 16; i += 2) g.push((b[i] << 8) | b[i + 1]);
    let best = -1, bestLen = 1;                 // RFC 5952: the longest run of 2+ zero groups
    for(let i = 0; i < 8; i++){
      let j = i;
      while(j < 8 && g[j] === 0) j++;
      if(j - i > bestLen){ best = i; bestLen = j - i; }
      if(j > i) i = j;
    }
    const hex = (a) => a.map(x => x.toString(16)).join(':');
    return best < 0 ? hex(g) : hex(g.slice(0, best)) + '::' + hex(g.slice(best + bestLen));
  }
  return asn1Hex(b, ':');
}

function _x509Extensions(der, node, ext){
  const seq = node.children && node.children[0];
  for(const e of (seq && seq.children) || []){
    const k = e.children || [];
    if(!asn1Is(k[0], 6)) continue;
    const oid = asn1Oid(der, k[0]);
    const val = k[k.length - 1];
    if(!asn1Is(val, 4)) continue;
    const body = asn1Body(der, val);
    try {
      const v = asn1Parse(body);
      if(oid === '2.5.29.17'){                                   // subjectAltName
        ext.san = [];
        for(const g of v.children || []){
          if(g.cls !== 2) continue;
          const gb = asn1Body(body, g);
          if(g.tag === 1) ext.san.push('email:' + asn1String(body, g));
          else if(g.tag === 2) ext.san.push('DNS:' + asn1String(body, g));
          else if(g.tag === 6) ext.san.push('URI:' + asn1String(body, g));
          else if(g.tag === 7) ext.san.push('IP:' + _x509Ip(gb));
          else if(g.tag === 4 && g.children && g.children[0]) ext.san.push('DirName:' + _x509Name(body, g.children[0]).text);
        }
      } else if(oid === '2.5.29.15'){                            // keyUsage
        const bits = asn1Bits(body, v);
        ext.keyUsage = X509_KU.filter((n, i) => (i >> 3) < bits.bytes.length && (bits.bytes[i >> 3] & (0x80 >> (i & 7))));
      } else if(oid === '2.5.29.37'){                            // extKeyUsage
        ext.extKeyUsage = (v.children || []).filter(c => asn1Is(c, 6)).map(c => { const o = asn1Oid(body, c); return X509_EKU[o] || o; });
      } else if(oid === '2.5.29.19'){                            // basicConstraints
        const bc = { ca: false, pathLen: null };
        for(const c of v.children || []){
          if(asn1Is(c, 1)) bc.ca = asn1Body(body, c)[0] !== 0;
          else if(asn1Is(c, 2)) bc.pathLen = Number(asn1IntBig(body, c));
        }
        ext.basicConstraints = bc;
      } else if(oid === '2.5.29.14'){                            // subjectKeyIdentifier
        if(asn1Is(v, 4)) ext.ski = asn1Hex(asn1Body(body, v), ':');
      } else if(oid === '2.5.29.35'){                            // authorityKeyIdentifier
        const id = (v.children || []).find(c => c.cls === 2 && c.tag === 0);
        if(id) ext.aki = asn1Hex(asn1Body(body, id), ':');
      }
    } catch(_){ /* one malformed extension does not sink the certificate */ }
  }
}

function parseCertificate(der){
  const b = der instanceof Uint8Array ? der : new Uint8Array(der);
  const cert = asn1Parse(b);
  const [tbs, sigAlg] = cert.children || [];
  if(!asn1Is(cert, 16) || !asn1Is(tbs, 16) || !asn1Is(sigAlg, 16)) throw new Error('Not an X.509 certificate');
  const f = tbs.children.slice();
  let version = 1;
  if(f[0] && f[0].cls === 2 && f[0].tag === 0){
    version = Number(asn1IntBig(b, f[0].children[0])) + 1;
    f.shift();
  }
  const [serial, , issuer, validity, subject, spki] = f;
  if(!asn1Is(serial, 2) || !asn1Is(issuer, 16) || !asn1Is(validity, 16) || !asn1Is(subject, 16) || !asn1Is(spki, 16)
    || validity.children.length < 2 || !spki.children.length || !(spki.children[0].children || []).length)
    throw new Error('Not an X.509 certificate');
  const ext = { san: [], keyUsage: [], extKeyUsage: [], basicConstraints: null, ski: null, aki: null };
  const ex = asn1Ctx(tbs, 3);
  if(ex) _x509Extensions(b, ex, ext);
  return {
    version,
    serial: asn1IntHex(b, serial),
    sigAlg: _x509AlgName(b, sigAlg),
    issuer: _x509Name(b, issuer),
    subject: _x509Name(b, subject),
    notBefore: asn1Time(b, validity.children[0]),
    notAfter: asn1Time(b, validity.children[1]),
    spki: _x509Spki(b, spki),
    extensions: ext,
    fingerprintInput: b.subarray(cert.start, cert.end),
  };
}
