// Byte fixtures for the node tests and the smoke run, built from literals:
// no binary blobs in the repo. Each builder returns a fresh Uint8Array.
import { deflateSync, deflateRawSync } from 'node:zlib';

export const enc = (s) => Uint8Array.from(Buffer.from(s, 'latin1'));
export const cat = (...parts) => {
  const out = [];
  for (const p of parts) out.push(...(typeof p === 'string' ? enc(p) : p));
  return Uint8Array.from(out);
};
export const pad = (n) => new Uint8Array(n);
export const rand = (n, seed = 7) => {
  const a = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; a[i] = (x >> 16) & 0xff; }
  a[0] = 0x13; a[1] = 0x37;   // no signature starts 13 37
  return a;
};
export const has = (bytes, s) => Buffer.from(bytes).includes(Buffer.from(s, 'latin1'));

const u16be = (n) => [(n >> 8) & 255, n & 255];
const u32be = (n) => [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
const u32le = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
const bytes = (s) => Array.from(enc(s));
const seg = (marker, payload) => [0xFF, marker, ...u16be(payload.length + 2), ...payload];

const CRC = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
// An independent CRC-32, to check the PNG chunks the scrubber keeps.
export const crc32ref = (a) => { let c = 0xFFFFFFFF; for (const x of a) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };

/* ── detection ── */
export const ftyp = (brand) => cat([0, 0, 0, 0x18], 'ftyp', brand, [0, 0, 0, 0], 'isommp42');
export const PNG_HEAD = () => cat([0x89], 'PNG\r\n\x1a\n', pad(24));
export const DICM = () => cat(pad(128), 'DICM', pad(16));
export const PE = () => cat('MZ', pad(0x3A), [0x80, 0, 0, 0], pad(0x40), 'PE', [0, 0], pad(20));

/* ── scrub (the F2 fixtures) ── */
const APP0 = seg(0xE0, bytes('JFIF\0').concat([1, 1, 0, 0, 1, 0, 1, 0, 0]));
// Minimal big-endian TIFF: IFD0 with Make "Cam" + Orientation.
const exifPayload = (orientation) => bytes('Exif\0\0').concat(
  bytes('MM'), [0, 42], u32be(8), u16be(2),
  u16be(0x010F), u16be(2), u32be(4), bytes('Cam\0'),
  u16be(0x0112), u16be(3), u32be(1), u16be(orientation), [0, 0],
  u32be(0));
export const xmpWithGps = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
  + '<rdf:Description rdf:about="" xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/"'
  + ' exif:GPSLatitude="48,51.5N" exif:GPSLongitude="2,17.4E" exif:ExposureTime="1/60">'
  + '<exif:GPSAltitude>35/1</exif:GPSAltitude><exif:GPSVersionID/><dc:creator>Jo</dc:creator>'
  + '</rdf:Description></rdf:RDF></x:xmpmeta>';
const APP1_XMP = seg(0xE1, bytes('http://ns.adobe.com/xap/1.0/\0').concat(Array.from(Buffer.from(xmpWithGps, 'utf8'))));
const COM = seg(0xFE, bytes('secret comment'));
const APP13 = seg(0xED, bytes('Photoshop 3.0\0').concat(bytes('8BIM'), [4, 4, 0, 0, 0, 0, 0, 0]));
const APP2 = seg(0xE2, bytes('ICC_PROFILE\0').concat([1, 1, 9, 9]));
export const SOS_REST = [0xFF, 0xDA, 0, 8, 1, 1, 0, 0, 0x3F, 0, 0x12, 0x34, 0xFF, 0x00, 0x56, 0xFF, 0xD9];

// APP0 + Exif (orientation 1) + XMP with GPS + COM + scan.
export const jpeg = () => Uint8Array.from([0xFF, 0xD8, ...APP0, ...seg(0xE1, exifPayload(1)), ...APP1_XMP, ...COM, ...SOS_REST]);
// Adds orientation 6, ICC and IPTC.
export const jpegFull = () => Uint8Array.from([0xFF, 0xD8, ...APP0, ...seg(0xE1, exifPayload(6)), ...APP2, ...APP13, ...APP1_XMP, ...COM, ...SOS_REST]);

const chunk = (type, data) => { const td = bytes(type).concat(data); return [...u32be(data.length), ...td, ...u32be(crc32ref(td))]; };
export const png = () => Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
  ...chunk('IHDR', [...u32be(1), ...u32be(1), 8, 6, 0, 0, 0]),
  ...chunk('tEXt', bytes('Author\0Jo')),
  ...chunk('tIME', [7, 234, 10, 31, 12, 0, 0]),
  ...chunk('IDAT', [0x78, 0x9C, 0x63, 0, 0, 0, 2, 0, 1]),
  ...chunk('IEND', [])]);

const rchunk = (fourcc, data) => [...bytes(fourcc), ...u32le(data.length), ...data, ...(data.length & 1 ? [0] : [])];
export const webp = () => {
  const body = [...bytes('WEBP'),
    ...rchunk('VP8X', [0x08 | 0x04 | 0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0]),   // EXIF + XMP + alpha flags
    ...rchunk('VP8L', [0x2F, 0, 0, 0, 0]),
    ...rchunk('EXIF', exifPayload(1).slice(6)),
    ...rchunk('XMP ', bytes('<x:xmpmeta/>'))];
  return Uint8Array.from([...bytes('RIFF'), ...u32le(body.length), ...body]);
};

const ss = (n) => [(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127];
const frame = bytes('TIT2').concat(u32be(4), [0, 0], [0], bytes('Hey'));
const id3v2 = [...bytes('ID3'), 3, 0, 0, ...ss(frame.length), ...frame];
const AUDIO = [0xFF, 0xFB, 0x90, 0x64, 1, 2, 3, 4, 5, 6];
const id3v1 = bytes('TAG').concat(new Array(125).fill(0x20));
export const audio = () => Uint8Array.from(AUDIO);
export const mp3 = () => Uint8Array.from([...id3v2, ...AUDIO, ...id3v1]);
export const mp3Appended = () => Uint8Array.from([...AUDIO,
  ...bytes('ID3'), 4, 0, 0x10, ...ss(frame.length), ...frame, ...bytes('3DI'), 4, 0, 0x10, ...ss(frame.length), ...id3v1]);

/* ── smoke-run files ── */
// A real, decodable 2×2 RGB PNG.
export function realPng() {
  const raw = Uint8Array.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]);
  return Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
    ...chunk('IHDR', [...u32be(2), ...u32be(2), 8, 2, 0, 0, 0]),
    ...chunk('IDAT', Array.from(deflateSync(raw))),
    ...chunk('IEND', [])]);
}
// An APP1 Exif segment whose IFD0 points at a GPS IFD (48°51'30"N 2°17'24"E).
export function exifGpsApp1() {
  const rat3 = (d, m, s) => [...u32be(d), ...u32be(1), ...u32be(m), ...u32be(1), ...u32be(s), ...u32be(1)];
  const tiff = [
    ...bytes('MM'), 0, 42, ...u32be(8),
    // IFD0 at 8: GPSInfo → 26
    ...u16be(1), ...u16be(0x8825), ...u16be(4), ...u32be(1), ...u32be(26), ...u32be(0),
    // GPS IFD at 26: four entries, values from 80
    ...u16be(4),
    ...u16be(1), ...u16be(2), ...u32be(2), ...bytes('N\0'), 0, 0,
    ...u16be(2), ...u16be(5), ...u32be(3), ...u32be(80),
    ...u16be(3), ...u16be(2), ...u32be(2), ...bytes('E\0'), 0, 0,
    ...u16be(4), ...u16be(5), ...u32be(3), ...u32be(104),
    ...u32be(0),
    ...rat3(48, 51, 30), ...rat3(2, 17, 24),
  ];
  return Uint8Array.from(seg(0xE1, bytes('Exif\0\0').concat(tiff)));
}
// A JPEG with that segment spliced in right after SOI.
export function withExifGps(jpegBytes) {
  const j = Uint8Array.from(jpegBytes);
  if (j[0] !== 0xFF || j[1] !== 0xD8) throw new Error('not a JPEG');
  return cat(j.subarray(0, 2), exifGpsApp1(), j.subarray(2));
}

// A 16-bit PCM WAV at any rate (the B-2 smoke run: 22050 Hz must stay 22050).
// A quiet 440 Hz tone, so a decoder has real samples to read.
export function wavPcm({ rate = 22050, channels = 1, frames = 2205 } = {}) {
  const data = [];
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 8000);
    for (let c = 0; c < channels; c++) data.push(v & 255, (v >> 8) & 255);
  }
  return Uint8Array.from([...bytes('RIFF'), ...u32le(36 + data.length), ...bytes('WAVE'),
    ...bytes('fmt '), ...u32le(16), 1, 0, channels, 0, ...u32le(rate), ...u32le(rate * channels * 2), channels * 2, 0, 16, 0,
    ...bytes('data'), ...u32le(data.length), ...data]);
}

// A ZIP assembled by hand, for js/lib/unzip.js: entries are { name, data
// (string or bytes), deflate?, utf8? }; deflated data comes from node:zlib
// deflateRawSync. opts.prefix puts bytes in front (a self-extractor stub),
// opts.comment adds an archive comment, opts.zip64 writes the Zip64 end
// record + locator (and 0xFFFF / 0xFFFFFFFF in the classic end record).
export function zipOf(entries, opts = {}) {
  const u16le = (n) => [n & 255, (n >> 8) & 255];
  const u64le = (n) => [...u32le(n % 4294967296), ...u32le(Math.floor(n / 4294967296))];
  const te = new TextEncoder();
  const pre = Array.from(opts.prefix || []);
  const body = [], central = [];
  let off = 0;
  for (const e of entries) {
    const raw = typeof e.data === 'string' ? te.encode(e.data) : Uint8Array.from(e.data || []);
    const comp = e.deflate ? Uint8Array.from(deflateRawSync(raw)) : raw;
    const name = e.utf8 === false ? enc(e.name) : te.encode(e.name);
    const flags = e.utf8 === false ? 0 : 0x0800;
    const method = e.deflate ? 8 : 0;
    const crc = crc32ref(raw);
    body.push(...u32le(0x04034b50), ...u16le(20), ...u16le(flags), ...u16le(method), 0, 0, 0x21, 0,
      ...u32le(crc), ...u32le(comp.length), ...u32le(raw.length), ...u16le(name.length), ...u16le(0), ...name, ...comp);
    central.push(...u32le(0x02014b50), ...u16le(20), ...u16le(20), ...u16le(flags), ...u16le(method), 0, 0, 0x21, 0,
      ...u32le(crc), ...u32le(comp.length), ...u32le(raw.length), ...u16le(name.length), ...u16le(0), ...u16le(0),
      ...u16le(0), ...u16le(0), ...u32le(0), ...u32le(off), ...name);
    off += 30 + name.length + comp.length;
  }
  const n = entries.length, cdOff = off, cdSize = central.length;
  const tail = [];
  if (opts.zip64) {
    const z = cdOff + cdSize;
    tail.push(...u32le(0x06064b50), ...u64le(44), ...u16le(45), ...u16le(45), ...u32le(0), ...u32le(0),
      ...u64le(n), ...u64le(n), ...u64le(cdSize), ...u64le(cdOff));
    tail.push(...u32le(0x07064b50), ...u32le(0), ...u64le(z), ...u32le(1));
  }
  const comment = enc(opts.comment || '');
  const big = !!opts.zip64;
  tail.push(...u32le(0x06054b50), 0, 0, 0, 0, ...u16le(big ? 0xFFFF : n), ...u16le(big ? 0xFFFF : n),
    ...u32le(big ? 0xFFFFFFFF : cdSize), ...u32le(big ? 0xFFFFFFFF : cdOff), ...u16le(comment.length), ...comment);
  return Uint8Array.from([...pre, ...body, ...central, ...tail]);
}
// A DOCX-like archive: content types stored, core properties deflated.
export const docxLike = () => zipOf([
  { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
  { name: 'docProps/core.xml', deflate: true, data: '<?xml version="1.0"?><cp:coreProperties xmlns:cp="x" xmlns:dc="y">'
    + '<dc:title>Smoke R&amp;D</dc:title><dc:creator>Carino Test</dc:creator><cp:revision>3</cp:revision></cp:coreProperties>' },
  { name: 'word/document.xml', deflate: true, data: '<w:document>' + 'hello '.repeat(200) + '</w:document>' },
]);

// Self-signed X.509 fixtures for tests/x509.test.mjs and the smoke run,
// made once with `openssl req -x509 -newkey <alg> -subj '/C=MX/O=Carino Test/CN=<name>.test'
// -addext 'subjectAltName=DNS:<name>.test,DNS:www.<name>.test,IP:192.0.2.1,email:a@<name>.test'`
// (serial 0x0123456789abcdef). 'pss' is RSA-PSS 1024 with a UTF-8 subject
// (O=Cariño Pruebas), CA:TRUE pathlen 0, keyCertSign + cRLSign, serverAuth +
// clientAuth, serial 1. CERT_P7B is a DER PKCS#7 bundle of p256 + ed25519.
export const CERT_PEM = {
  rsa2048: `-----BEGIN CERTIFICATE-----
MIIDjDCCAnSgAwIBAgIIASNFZ4mrze8wDQYJKoZIhvcNAQELBQAwOjELMAkGA1UE
BhMCTVgxFDASBgNVBAoMC0NhcmlubyBUZXN0MRUwEwYDVQQDDAxyc2EyMDQ4LnRl
c3QwHhcNMjYxMDMxMTAxNTA4WhcNMzYxMDI4MTAxNTA4WjA6MQswCQYDVQQGEwJN
WDEUMBIGA1UECgwLQ2FyaW5vIFRlc3QxFTATBgNVBAMMDHJzYTIwNDgudGVzdDCC
ASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAIi4u6QqXBGsA8reoOxtfmSA
zGqLztQ0X/ljTGqe856V3mYs9yUHkn67Oiw0X9frATiadPPmEjkwYxj+JKsg35+R
7uIqPsioPojABSIZhKkCyhOZ1Ks7EZW+InD63XbXB4rlQ7fJNzxNigI+DRGBgY9F
WAcQ/MP6tLc00ebnxdWlmECu8BAFu78Fzfw6z3t3awesvBsubfODu/I6ytLEXcrJ
ZUF8oeT1Pfj7SQZG46G1zL63V2FWT3W2XyjZjxMZeNbeVhN2Sj4hRqlFByUWdGsb
/pYJwU/zjX2AJbgPsq6gcvDMKbdVmOgZvPS7uRnhMz3kVSAqFxPY7twhSutgD4cC
AwEAAaOBlTCBkjAdBgNVHQ4EFgQUBtU+QIx+ASFNEQTDflF5Etm666AwHwYDVR0j
BBgwFoAUBtU+QIx+ASFNEQTDflF5Etm666AwDwYDVR0TAQH/BAUwAwEB/zA/BgNV
HREEODA2ggxyc2EyMDQ4LnRlc3SCEHd3dy5yc2EyMDQ4LnRlc3SHBMAAAgGBDmFA
cnNhMjA0OC50ZXN0MA0GCSqGSIb3DQEBCwUAA4IBAQA9HH9oYyeo8lLehYyHbOAy
6zkceWNh5IpTLqzd2o2qvCaN7XB6Jmg8JUYVELu1lBDR/lGe/qP+2EwLmjX+HlbZ
7U270lMwqwZAIoQVqUMfCM+FtntsKnxIRYnVlGX+YwYN/VXsIUJC5fpODloqLW72
VDPP7TpjnSKU7ZIsVbv38GTl6TWfTVWugCQV0/sj72obgpAPKDm1VuV+gRFnzUpZ
+CzhgxYOkTk/5XSc8LVaLKj1YawIYt2SJLLcvZjX7okc1X1A3oWo2qFDtw6fLzQJ
qvULdR/Dn5uCwnshkHGIGuBlcf6mbcqEvMHGpezcSBljRIRFkLu6UkA87pASlz7p
-----END CERTIFICATE-----`,
  pss: `-----BEGIN CERTIFICATE-----
MIIC1zCCAgygAwIBAgIBATBBBgkqhkiG9w0BAQowNKAPMA0GCWCGSAFlAwQCAQUA
oRwwGgYJKoZIhvcNAQEIMA0GCWCGSAFlAwQCAQUAogMCASAwOjELMAkGA1UEBhMC
TVgxGDAWBgNVBAoMD0NhcmnDsW8gUHJ1ZWJhczERMA8GA1UEAwwIcHNzLnRlc3Qw
HhcNMjYxMDMxMTAxNTE0WhcNMzYxMDI4MTAxNTE0WjA6MQswCQYDVQQGEwJNWDEY
MBYGA1UECgwPQ2FyacOxbyBQcnVlYmFzMREwDwYDVQQDDAhwc3MudGVzdDCBnTAL
BgkqhkiG9w0BAQoDgY0AMIGJAoGBAKJa0u3ifVHaZyH2FkMnNUCrJgVgVLMlM4b/
R+JklLzchjiHU2cq4yFExk75k1c+bFHJXzfTG4moF6A0uuSwFuF0G0R6N78O8MZ7
+erpV5uqjFHlOEMbGfIaUR+ey5LXSad2fxci0m/572t+eEdjc6uPQOUSnuYRvkfy
Lm5+9J5nAgMBAAGjgYYwgYMwHQYDVR0OBBYEFE/69OswrTGFMKM3uERZreNrW4zK
MB8GA1UdIwQYMBaAFE/69OswrTGFMKM3uERZreNrW4zKMBIGA1UdEwEB/wQIMAYB
Af8CAQAwDgYDVR0PAQH/BAQDAgEGMB0GA1UdJQQWMBQGCCsGAQUFBwMBBggrBgEF
BQcDAjBBBgkqhkiG9w0BAQowNKAPMA0GCWCGSAFlAwQCAQUAoRwwGgYJKoZIhvcN
AQEIMA0GCWCGSAFlAwQCAQUAogMCASADgYEASAjVpgnCuwmvMTsWv4yH+NvJ4e1Q
NTuhc1Tj5UbYyHD9s3lo5he4zY4ACqNAvoBgCiMPEUxf+vC3n0KlOSMLTaqGRaCC
a8uaOmSwcbe41U0ndo+0Jkgsf210UYG5quRt7vmperiPHfOzUuO6YWGgK1bZuIBS
HVUdvFPvHLLsc9g=
-----END CERTIFICATE-----`,
  p256: `-----BEGIN CERTIFICATE-----
MIIB8TCCAZegAwIBAgIIASNFZ4mrze8wCgYIKoZIzj0EAwIwNzELMAkGA1UEBhMC
TVgxFDASBgNVBAoMC0NhcmlubyBUZXN0MRIwEAYDVQQDDAlwMjU2LnRlc3QwHhcN
MjYxMDMxMTAxNTA4WhcNMzYxMDI4MTAxNTA4WjA3MQswCQYDVQQGEwJNWDEUMBIG
A1UECgwLQ2FyaW5vIFRlc3QxEjAQBgNVBAMMCXAyNTYudGVzdDBZMBMGByqGSM49
AgEGCCqGSM49AwEHA0IABN/6JQ04HSfaB+stznR1CGeUrEqMAhP4qlfxejTJ35n2
knl8d6tkYVZsI+EP2i+BwlVxyvuLhCtS2krPDG7M7cujgYwwgYkwHQYDVR0OBBYE
FLt/pWc38ZS4XfLKst+qAFYLIpGtMB8GA1UdIwQYMBaAFLt/pWc38ZS4XfLKst+q
AFYLIpGtMA8GA1UdEwEB/wQFMAMBAf8wNgYDVR0RBC8wLYIJcDI1Ni50ZXN0gg13
d3cucDI1Ni50ZXN0hwTAAAIBgQthQHAyNTYudGVzdDAKBggqhkjOPQQDAgNIADBF
AiEA0WV9cED0+J8bYUOjRhcuFZzVp/juhWSWSottTQ/BWWkCIDcbxRG+fmYZoohM
EBSo03TYexsMxp+oLGGcf5GRBu6b
-----END CERTIFICATE-----`,
  p384: `-----BEGIN CERTIFICATE-----
MIICLzCCAbSgAwIBAgIIASNFZ4mrze8wCgYIKoZIzj0EAwMwNzELMAkGA1UEBhMC
TVgxFDASBgNVBAoMC0NhcmlubyBUZXN0MRIwEAYDVQQDDAlwMzg0LnRlc3QwHhcN
MjYxMDMxMTAxNTA4WhcNMzYxMDI4MTAxNTA4WjA3MQswCQYDVQQGEwJNWDEUMBIG
A1UECgwLQ2FyaW5vIFRlc3QxEjAQBgNVBAMMCXAzODQudGVzdDB2MBAGByqGSM49
AgEGBSuBBAAiA2IABCJ4C1DstorNKPc4Ea7BZn0ytST6/8hNvKz0Xs7Nxjo3ESRZ
+FJlilPzs1S9/I3o1VKgx6cpA73rIWYEHDnddqlefjmj1EiraAfMKlYPD93IcIqi
lNPh0KJaxyecueSAN6OBjDCBiTAdBgNVHQ4EFgQUW7C6S1tZU9dqP8sl4Mm36XWc
ijkwHwYDVR0jBBgwFoAUW7C6S1tZU9dqP8sl4Mm36XWcijkwDwYDVR0TAQH/BAUw
AwEB/zA2BgNVHREELzAtgglwMzg0LnRlc3SCDXd3dy5wMzg0LnRlc3SHBMAAAgGB
C2FAcDM4NC50ZXN0MAoGCCqGSM49BAMDA2kAMGYCMQD3f8H/g7vz0XPFGFvClOzK
3T7jdfKmaRbYW7i9RnqBtnefzC0KWY/CgSS7lvXLTmYCMQCqtshviIfWefOB2Wsv
TzLbP6rM+D3UPfefTcv4Un5m3tdiF/hyxynxhzh7IvPTYM0=
-----END CERTIFICATE-----`,
  p521: `-----BEGIN CERTIFICATE-----
MIICeDCCAdqgAwIBAgIIASNFZ4mrze8wCgYIKoZIzj0EAwQwNzELMAkGA1UEBhMC
TVgxFDASBgNVBAoMC0NhcmlubyBUZXN0MRIwEAYDVQQDDAlwNTIxLnRlc3QwHhcN
MjYxMDMxMTAxNTA4WhcNMzYxMDI4MTAxNTA4WjA3MQswCQYDVQQGEwJNWDEUMBIG
A1UECgwLQ2FyaW5vIFRlc3QxEjAQBgNVBAMMCXA1MjEudGVzdDCBmzAQBgcqhkjO
PQIBBgUrgQQAIwOBhgAEAW/FPqUKlfmprdIi+Dwy8ZeU2Wk0i7qWMCa2NUMpnX7I
GGfkqKecfSAYGsTqazhNYtqo/dtug0EgBq/ZqLtkwWFIAVDLCu3Z6AOlCqDqD8lF
INAxYYBpydqi/GKzo2ysYfxKxHE9yM+LXVIFAZXYmxL3CSmJLNiCb5ZRJHzym7Iz
HB2po4GMMIGJMB0GA1UdDgQWBBSlUJPqy/8zXVB46eA22Z/OgHqtxjAfBgNVHSME
GDAWgBSlUJPqy/8zXVB46eA22Z/OgHqtxjAPBgNVHRMBAf8EBTADAQH/MDYGA1Ud
EQQvMC2CCXA1MjEudGVzdIINd3d3LnA1MjEudGVzdIcEwAACAYELYUBwNTIxLnRl
c3QwCgYIKoZIzj0EAwQDgYsAMIGHAkEwSugBDTJAyc5koJ4nG0J1hKkukhWqrRZv
ng5EBPSNJU9ezUel07+VBYq3R6Sz7IPqeNFDQJTyFhsknZNuD1mqxwJCAc2S5Nph
rEiZnsRZ/UhbCJNq/tSjlNUBW/XkNJjB6HWYKZXKSFaccYKsvIQvmb6u3JwiL03P
yDjQv76xNH9EBcjT
-----END CERTIFICATE-----`,
  ed25519: `-----BEGIN CERTIFICATE-----
MIIBwDCCAXKgAwIBAgIIASNFZ4mrze8wBQYDK2VwMDoxCzAJBgNVBAYTAk1YMRQw
EgYDVQQKDAtDYXJpbm8gVGVzdDEVMBMGA1UEAwwMZWQyNTUxOS50ZXN0MB4XDTI2
MTAzMTEwMTUwOFoXDTM2MTAyODEwMTUwOFowOjELMAkGA1UEBhMCTVgxFDASBgNV
BAoMC0NhcmlubyBUZXN0MRUwEwYDVQQDDAxlZDI1NTE5LnRlc3QwKjAFBgMrZXAD
IQAQBiYRF5zu+JEwOKwYf8ziiWrVbJPwdUWEibDFp2shIKOBlTCBkjAdBgNVHQ4E
FgQUxHHzgAw+LgCVHa2mihS85Lvl8AowHwYDVR0jBBgwFoAUxHHzgAw+LgCVHa2m
ihS85Lvl8AowDwYDVR0TAQH/BAUwAwEB/zA/BgNVHREEODA2ggxlZDI1NTE5LnRl
c3SCEHd3dy5lZDI1NTE5LnRlc3SHBMAAAgGBDmFAZWQyNTUxOS50ZXN0MAUGAytl
cANBAJPOVztx7L5onTbR1Sm2LlF7nvFVTAKcvuxBsAmEndnN1Igvglk2wJt3sbMv
h+83ONv2pYNvJ/y4/iWS+m2GnAs=
-----END CERTIFICATE-----`,
  ed448: `-----BEGIN CERTIFICATE-----
MIICATCCAYGgAwIBAgIIASNFZ4mrze8wBQYDK2VxMDgxCzAJBgNVBAYTAk1YMRQw
EgYDVQQKDAtDYXJpbm8gVGVzdDETMBEGA1UEAwwKZWQ0NDgudGVzdDAeFw0yNjEw
MzExMDE1MDhaFw0zNjEwMjgxMDE1MDhaMDgxCzAJBgNVBAYTAk1YMRQwEgYDVQQK
DAtDYXJpbm8gVGVzdDETMBEGA1UEAwwKZWQ0NDgudGVzdDBDMAUGAytlcQM6ALIy
Un1QVqogpBTCyVXC+Jt67m1TIEvpgKLGtrV6ygGU2pNb/O+jnNJQYd3OyvLD8Bhy
AV5Ek3hSgKOBjzCBjDAdBgNVHQ4EFgQUN1xr91e/wv70jxf6KtJq+bAVJpQwHwYD
VR0jBBgwFoAUN1xr91e/wv70jxf6KtJq+bAVJpQwDwYDVR0TAQH/BAUwAwEB/zA5
BgNVHREEMjAwggplZDQ0OC50ZXN0gg53d3cuZWQ0NDgudGVzdIcEwAACAYEMYUBl
ZDQ0OC50ZXN0MAUGAytlcQNzAHE3SOurjEJFwla5aoVd+dIOopVnzQJctQMTAnbd
tb/55IuQ/0ofexK/H4eP79i53x96VaHEDxQIAHZHbpNbfOxIjtojYNU0Dnoi8oXh
uxEVbZZehkmbDh7gtTFejNrIqka86jcO+3tT+j6azLlaqeANAA==
-----END CERTIFICATE-----`,
};
export const CERT_P7B = () => Uint8Array.from(Buffer.from(
  'MIID5AYJKoZIhvcNAQcCoIID1TCCA9ECAQExADALBgkqhkiG9w0BBwGgggO5MIIB8TCCAZegAwIBAgIIASNFZ4mrze8wCgYI' +
  'KoZIzj0EAwIwNzELMAkGA1UEBhMCTVgxFDASBgNVBAoMC0NhcmlubyBUZXN0MRIwEAYDVQQDDAlwMjU2LnRlc3QwHhcNMjYx' +
  'MDMxMTAxNTA4WhcNMzYxMDI4MTAxNTA4WjA3MQswCQYDVQQGEwJNWDEUMBIGA1UECgwLQ2FyaW5vIFRlc3QxEjAQBgNVBAMM' +
  'CXAyNTYudGVzdDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABN/6JQ04HSfaB+stznR1CGeUrEqMAhP4qlfxejTJ35n2knl8' +
  'd6tkYVZsI+EP2i+BwlVxyvuLhCtS2krPDG7M7cujgYwwgYkwHQYDVR0OBBYEFLt/pWc38ZS4XfLKst+qAFYLIpGtMB8GA1Ud' +
  'IwQYMBaAFLt/pWc38ZS4XfLKst+qAFYLIpGtMA8GA1UdEwEB/wQFMAMBAf8wNgYDVR0RBC8wLYIJcDI1Ni50ZXN0gg13d3cu' +
  'cDI1Ni50ZXN0hwTAAAIBgQthQHAyNTYudGVzdDAKBggqhkjOPQQDAgNIADBFAiEA0WV9cED0+J8bYUOjRhcuFZzVp/juhWSW' +
  'SottTQ/BWWkCIDcbxRG+fmYZoohMEBSo03TYexsMxp+oLGGcf5GRBu6bMIIBwDCCAXKgAwIBAgIIASNFZ4mrze8wBQYDK2Vw' +
  'MDoxCzAJBgNVBAYTAk1YMRQwEgYDVQQKDAtDYXJpbm8gVGVzdDEVMBMGA1UEAwwMZWQyNTUxOS50ZXN0MB4XDTI2MTAzMTEw' +
  'MTUwOFoXDTM2MTAyODEwMTUwOFowOjELMAkGA1UEBhMCTVgxFDASBgNVBAoMC0NhcmlubyBUZXN0MRUwEwYDVQQDDAxlZDI1' +
  'NTE5LnRlc3QwKjAFBgMrZXADIQAQBiYRF5zu+JEwOKwYf8ziiWrVbJPwdUWEibDFp2shIKOBlTCBkjAdBgNVHQ4EFgQUxHHz' +
  'gAw+LgCVHa2mihS85Lvl8AowHwYDVR0jBBgwFoAUxHHzgAw+LgCVHa2mihS85Lvl8AowDwYDVR0TAQH/BAUwAwEB/zA/BgNV' +
  'HREEODA2ggxlZDI1NTE5LnRlc3SCEHd3dy5lZDI1NTE5LnRlc3SHBMAAAgGBDmFAZWQyNTUxOS50ZXN0MAUGAytlcANBAJPO' +
  'Vztx7L5onTbR1Sm2LlF7nvFVTAKcvuxBsAmEndnN1Igvglk2wJt3sbMvh+83ONv2pYNvJ/y4/iWS+m2GnAsxAA=='
, 'base64'));
