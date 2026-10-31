// js/lib/x509.js (on js/lib/asn1.js): certificates made by openssl, read
// natively, and checked against node:crypto's own X509Certificate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate, createHash } from 'node:crypto';
import { lib, need } from './load.mjs';
import { CERT_PEM, CERT_P7B } from './fixtures.mjs';

const N = ['pemToDer', 'parseCertificate', 'x509Certificates'];
const one = (pem) => lib.parseCertificate(lib.x509Certificates(new TextEncoder().encode(pem))[0]);
const SAN = (n) => ['DNS:' + n + '.test', 'DNS:www.' + n + '.test', 'IP:192.0.2.1', 'email:a@' + n + '.test'];

const CASES = [
  ['rsa2048', { alg: 'RSA', curve: null, bits: 2048, label: 'RSA 2048' }, 'SHA-256 with RSA'],
  ['p256', { alg: 'EC', curve: 'P-256', bits: 256, label: 'ECDSA P-256' }, 'ECDSA with SHA-256'],
  ['p384', { alg: 'EC', curve: 'P-384', bits: 384, label: 'ECDSA P-384' }, 'ECDSA with SHA-384'],
  ['p521', { alg: 'EC', curve: 'P-521', bits: 521, label: 'ECDSA P-521' }, 'ECDSA with SHA-512'],
  ['ed25519', { alg: 'Ed25519', curve: 'Ed25519', bits: 255, label: 'Ed25519' }, 'Ed25519'],
  ['ed448', { alg: 'Ed448', curve: 'Ed448', bits: 448, label: 'Ed448' }, 'Ed448'],
];

for (const [name, spki, sig] of CASES) {
  test(name + ': subject, key, signature, SAN, validity', need(...N), () => {
    const c = one(CERT_PEM[name]);
    const ref = new X509Certificate(CERT_PEM[name]);
    assert.equal(c.version, 3);
    assert.equal(c.serial, '0123456789abcdef');
    assert.equal(c.serial, ref.serialNumber.toLowerCase());
    assert.equal(c.subject.text, 'C=MX, O=Carino Test, CN=' + name + '.test');
    assert.equal(c.issuer.text, c.subject.text);
    assert.deepEqual(c.subject.attrs.map((a) => a.oid), ['2.5.4.6', '2.5.4.10', '2.5.4.3']);
    const { oid, ...rest } = c.spki;
    assert.deepEqual(rest, spki);
    assert.equal(c.sigAlg.name, sig);
    assert.deepEqual(c.extensions.san, SAN(name));
    assert.equal(c.notBefore.getTime(), new Date(ref.validFrom).getTime());
    assert.equal(c.notAfter.getTime(), new Date(ref.validTo).getTime());
    assert.ok(c.extensions.ski && c.extensions.ski === c.extensions.aki, 'self-signed: SKI = AKI');
    assert.deepEqual(c.extensions.basicConstraints, { ca: true, pathLen: null });
    // The fingerprint input is exactly the certificate DER.
    assert.equal(createHash('sha256').update(c.fingerprintInput).digest('hex').toUpperCase(), ref.fingerprint256.replace(/:/g, ''));
  });
}

test('RSA-PSS: UTF-8 subject, PSS names, key usage, EKU, path length', need(...N), () => {
  const c = one(CERT_PEM.pss);
  assert.equal(c.serial, '01');
  assert.equal(c.subject.text, 'C=MX, O=Cariño Pruebas, CN=pss.test');
  assert.equal(c.sigAlg.oid, '1.2.840.113549.1.1.10');
  assert.equal(c.sigAlg.name, 'RSASSA-PSS (SHA-256)');
  assert.equal(c.spki.label, 'RSA-PSS 1024');
  assert.deepEqual(c.extensions.keyUsage, ['keyCertSign', 'cRLSign']);
  assert.deepEqual(c.extensions.extKeyUsage, ['serverAuth', 'clientAuth']);
  assert.deepEqual(c.extensions.basicConstraints, { ca: true, pathLen: 0 });
  assert.deepEqual(c.extensions.san, []);
});

test('DER in, several PEM blocks, and a PKCS#7 bundle', need(...N, 'pkcs7Certificates'), () => {
  const der = lib.pemToDer(CERT_PEM.p384)[0];
  assert.equal(der.label, 'CERTIFICATE');
  assert.deepEqual(lib.x509Certificates(der.der).map((d) => d.length), [der.der.length]);
  assert.equal(lib.parseCertificate(der.der).spki.label, 'ECDSA P-384');
  // A bundle with a key block between: only certificates come back.
  const bundle = CERT_PEM.rsa2048 + '\n-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n' + CERT_PEM.ed448 + '\n';
  const certs = lib.x509Certificates(new TextEncoder().encode(bundle));
  assert.deepEqual(certs.map((d) => lib.parseCertificate(d).spki.label), ['RSA 2048', 'Ed448']);
  // DER PKCS#7 (.p7b) and the same as PEM.
  const p7 = CERT_P7B();
  assert.deepEqual(lib.x509Certificates(p7).map((d) => lib.parseCertificate(d).spki.label).sort(), ['ECDSA P-256', 'Ed25519']);
  const pem = '-----BEGIN PKCS7-----\n' + Buffer.from(p7).toString('base64').replace(/.{64}/g, '$&\n') + '\n-----END PKCS7-----\n';
  assert.equal(lib.x509Certificates(new TextEncoder().encode(pem)).length, 2);
});

test('an unknown algorithm shows as its dotted OID', need(...N), () => {
  const der = Uint8Array.from(lib.pemToDer(CERT_PEM.p256)[0].der);
  // Rewrite the curve OID P-256 (06 08 2A 86 48 CE 3D 03 01 07) to 1.2.840.10045.3.1.99.
  const hex = Buffer.from(der).toString('hex');
  const at = hex.indexOf('06082a8648ce3d030107');
  assert.ok(at > 0);
  der[at / 2 + 9] = 99;
  const c = lib.parseCertificate(der);
  assert.equal(c.spki.curve, '1.2.840.10045.3.1.99');
  assert.equal(c.spki.label, 'ECDSA 1.2.840.10045.3.1.99');
});

test('garbage and truncation throw instead of looping', need(...N), () => {
  const der = lib.pemToDer(CERT_PEM.rsa2048)[0].der;
  assert.throws(() => lib.parseCertificate(der.subarray(0, 200)), /ASN\.1/);
  assert.throws(() => lib.parseCertificate(Uint8Array.from([0x30, 0x84, 0xff, 0xff, 0xff, 0xff, 0])), /ASN\.1/);
  assert.throws(() => lib.parseCertificate(Uint8Array.from([0x02, 0x01, 0x05])), /X\.509/);
  assert.deepEqual(lib.x509Certificates(new TextEncoder().encode('-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----')), []);
});

test('pemToDer: unterminated BEGIN lines do not take quadratic time', need('pemToDer'), () => {
  const t0 = Date.now();
  const junk = '-----BEGIN X-----\nAAAA\n'.repeat(200000);
  assert.deepEqual(lib.pemToDer(junk), []);
  assert.ok(Date.now() - t0 < 2000, 'fast');
  const pem = '-----BEGIN CERTIFICATE-----\nMAA=\n-----END CERTIFICATE-----\n-----BEGIN NOISE-----\nAAAA\n';
  const r = lib.pemToDer(pem);
  assert.equal(r.length, 1);
  assert.equal(r[0].label, 'CERTIFICATE');
  assert.deepEqual([...r[0].der], [0x30, 0x00]);
});
