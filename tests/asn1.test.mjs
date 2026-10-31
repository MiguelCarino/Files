// js/lib/asn1.js: the DER/BER reader under js/lib/x509.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lib, need } from './load.mjs';

const B = (...a) => Uint8Array.from(a.flat());

test('TLV: short and long lengths, children, context tags', need('asn1Parse', 'asn1Ctx'), () => {
  const long = new Array(200).fill(0x41);
  const b = B(0x30, 0x81, 206, 0x04, 0x81, 200, long, 0xA0, 0x01, 0x05);
  // 0xA0 0x01 0x05 is not well formed inside (a constructed [0] holding one
  // byte), so the parse must fail on it rather than read past it.
  assert.throws(() => lib.asn1Parse(b), /ASN\.1/);
  const ok = B(0x30, 0x81, 207, 0x04, 0x81, 200, long, 0xA0, 0x02, 0x05, 0x00);
  const n = lib.asn1Parse(ok);
  assert.equal(n.tag, 16);
  assert.equal(n.constructed, true);
  assert.equal(n.end, ok.length);
  assert.equal(n.children[0].end - n.children[0].hdr, 200);
  const ctx = lib.asn1Ctx(n, 0);
  assert.equal(ctx.cls, 2);
  assert.equal(ctx.children[0].tag, 5);
});

test('BER indefinite length (PKCS#7 from some tools)', need('asn1Parse'), () => {
  const n = lib.asn1Parse(B(0x30, 0x80, 0x02, 0x01, 0x07, 0x00, 0x00));
  assert.equal(n.children.length, 1);
  assert.equal(n.end, 7);
  assert.throws(() => lib.asn1Parse(B(0x30, 0x80, 0x02, 0x01, 0x07)), /ASN\.1/);
});

test('depth is capped', need('asn1Parse'), () => {
  const deep = [];
  for (let i = 0; i < 100; i++) deep.push(0x30, 0x80);
  for (let i = 0; i < 100; i++) deep.push(0, 0);
  assert.throws(() => lib.asn1Parse(Uint8Array.from(deep)), /deep/);
});

test('OIDs, including large arcs', need('asn1Parse', 'asn1Oid'), () => {
  const oid = (...a) => lib.asn1Oid(Uint8Array.from([0x06, a.length, ...a]), lib.asn1Parse(Uint8Array.from([0x06, a.length, ...a])));
  assert.equal(oid(0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x0B), '1.2.840.113549.1.1.11');
  assert.equal(oid(0x2B, 0x65, 0x70), '1.3.101.112');
  assert.equal(oid(0x55, 0x1D, 0x11), '2.5.29.17');
  assert.equal(oid(0x88, 0x37, 0x01), '2.999.1');
  assert.equal(oid(0x69, 0x82, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00), '2.25.' + (1n << 64n).toString());
});

test('INTEGER as hex, BigInt and bit length', need('asn1Parse', 'asn1IntHex', 'asn1IntBig', 'asn1IntBits'), () => {
  const n = (...a) => { const b = Uint8Array.from([0x02, a.length, ...a]); return [b, lib.asn1Parse(b)]; };
  assert.equal(lib.asn1IntHex(...n(0x00, 0xFF, 0x01)), 'ff01');
  assert.equal(lib.asn1IntHex(...n(0x00)), '00');
  assert.equal(lib.asn1IntBig(...n(0xFF)), -1n);
  assert.equal(lib.asn1IntBig(...n(0x00, 0x80)), 128n);
  assert.equal(lib.asn1IntBits(...n(0x00, 0x80, 0x00)), 16);
  assert.equal(lib.asn1IntBits(...n(0x01, 0x00)), 9);
});

test('times: UTCTime pivot, GeneralizedTime with fraction and offset', need('asn1Parse', 'asn1Time'), () => {
  const t = (tag, s) => { const b = Uint8Array.from([tag, s.length, ...Buffer.from(s, 'latin1')]); return lib.asn1Time(b, lib.asn1Parse(b)).toISOString(); };
  assert.equal(t(23, '491231235959Z'), '2049-12-31T23:59:59.000Z');
  assert.equal(t(23, '500101000000Z'), '1950-01-01T00:00:00.000Z');
  assert.equal(t(24, '20261031101508.25Z'), '2026-10-31T10:15:08.250Z');
  assert.equal(t(24, '20261031101508+0100'), '2026-10-31T09:15:08.000Z');
  assert.throws(() => t(23, 'nonsense'), /UTCTime/);
});

test('strings: UTF8, Printable, IA5, T61 (latin1), BMP, Universal', need('asn1Parse', 'asn1String'), () => {
  const s = (tag, bytes) => { const b = Uint8Array.from([tag, bytes.length, ...bytes]); return lib.asn1String(b, lib.asn1Parse(b)); };
  assert.equal(s(12, [...Buffer.from('Cariño ✓')]), 'Cariño ✓');
  assert.equal(s(19, [...Buffer.from('MX')]), 'MX');
  assert.equal(s(22, [...Buffer.from('a@b.c')]), 'a@b.c');
  assert.equal(s(20, [0x43, 0xF1]), 'Cñ');
  assert.equal(s(30, [0x00, 0x43, 0x30, 0xC6]), 'Cテ');
  assert.equal(s(28, [0, 0, 0, 0x43, 0, 1, 0xF6, 0x00]), 'C😀');
});

test('huge OIDs and INTEGERs throw fast instead of hanging', need('asn1Parse', 'asn1Oid', 'asn1IntBig'), () => {
  const big = (tag, body) => {
    const n = body.length;
    return Uint8Array.from([tag, 0x83, (n >> 16) & 255, (n >> 8) & 255, n & 255, ...body]);
  };
  const t0 = Date.now();
  const oid = big(0x06, new Array(1 << 20).fill(0x81).concat([0x01]));
  assert.throws(() => lib.asn1Oid(oid, lib.asn1Parse(oid)), /OID too long/);
  const arc = big(0x06, [0x2A, ...new Array(30).fill(0x81), 0x01]);
  assert.throws(() => lib.asn1Oid(arc, lib.asn1Parse(arc)), /arc too long/);
  const int = big(0x02, new Array(1 << 20).fill(0x7F));
  assert.throws(() => lib.asn1IntBig(int, lib.asn1Parse(int)), /INTEGER too long/);
  assert.ok(Date.now() - t0 < 2000, 'fast');
  // A 2.25.<UUID> arc (128 bits, 19 bytes) still reads.
  const uuid = [0x69, 0x83, ...new Array(17).fill(0xFF), 0x7F];
  const u = Uint8Array.from([0x06, uuid.length, ...uuid]);
  assert.match(lib.asn1Oid(u, lib.asn1Parse(u)), /^2\.25\.\d+$/);
});
