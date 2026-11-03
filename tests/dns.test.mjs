import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normaliseName,
  isValidName,
  statusLabel,
  answerKey,
  answerSet,
  compare,
  minTtl,
  maxTtl,
  toDig,
  typeCode,
  splitPreference,
} from '../assets/dns.js';

const answer = (name, data, ttl = 300, type = 1) => ({ name, type, TTL: ttl, data });

const ok = (records, status = 0, ms = 40) => ({
  ok: true,
  ms,
  body: { Status: status, Answer: records },
});

test('normaliseName removes the root dot and lowercases', () => {
  assert.equal(normaliseName('Example.COM.'), 'example.com');
  assert.equal(normaliseName('  example.com  '), 'example.com');
  assert.equal(normaliseName('example.com..'), 'example.com');
});

test('normaliseName survives null and undefined', () => {
  assert.equal(normaliseName(null), '');
  assert.equal(normaliseName(undefined), '');
});

test('isValidName accepts ordinary hostnames', () => {
  for (const name of ['example.com', 'a.b.c.example.co.za', 'localhost', 'xn--80ak6aa92e.com']) {
    assert.equal(isValidName(name), true, name);
  }
});

test('isValidName rejects the things people actually paste', () => {
  for (const name of ['', '   ', 'has space.com', '-leading.com', 'trailing-.com', 'double..dot', 'http://example.com', '*.example.com']) {
    assert.equal(isValidName(name), false, name);
  }
});

test('isValidName rejects names beyond the 253 character limit', () => {
  assert.equal(isValidName('a'.repeat(250) + '.com'), false);
});

test('statusLabel tells "no answers" apart from "no such domain"', () => {
  assert.equal(statusLabel(ok([answer('a.com', '1.2.3.4')])), 'NOERROR');
  assert.equal(statusLabel(ok([])), 'NOERROR (NO ANSWERS)');
  assert.equal(statusLabel(ok([], 3)), 'NXDOMAIN');
  assert.equal(statusLabel(ok([], 2)), 'SERVFAIL');
  assert.equal(statusLabel({ ok: false, error: 'timed out' }), 'TIMED OUT');
});

test('answerKey ignores the trailing dot so the two resolvers can be compared', () => {
  const cloudflare = answer('example.com', '1.2.3.4', 300, 1);
  const google = answer('example.com.', '1.2.3.4', 295, 1);
  assert.equal(answerKey(cloudflare), answerKey(google));
});

test('compare reports agreement when only TTL and trailing dots differ', () => {
  const a = ok([answer('example.com', '1.2.3.4', 300)]);
  const b = ok([answer('example.com.', '1.2.3.4', 120)]);
  const diff = compare(a, b);
  assert.equal(diff.agree, true);
  assert.equal(diff.common.length, 1);
  assert.deepEqual(diff.onlyA, []);
  assert.deepEqual(diff.onlyB, []);
});

test('compare reports records that only one resolver returned', () => {
  const a = ok([answer('example.com', '1.1.1.1')]);
  const b = ok([answer('example.com', '2.2.2.2')]);
  const diff = compare(a, b);
  assert.equal(diff.agree, false);
  assert.equal(diff.onlyA.length, 1);
  assert.equal(diff.onlyB.length, 1);
  assert.equal(diff.common.length, 0);
  assert.match(diff.onlyA[0], /1\.1\.1\.1/);
});

test('compare treats a failed resolver as nothing to compare', () => {
  const a = ok([answer('example.com', '1.1.1.1')]);
  const b = { ok: false, ms: 8000, error: 'timed out' };
  const diff = compare(a, b);
  assert.equal(diff.comparable, true);
  assert.equal(diff.agree, false);
  assert.equal(diff.onlyB.length, 0);
});

test('answerSet is empty for an error result', () => {
  assert.equal(answerSet({ ok: false, error: 'boom' }).size, 0);
  assert.equal(answerSet(undefined).size, 0);
});

test('minTtl and maxTtl describe the answer window', () => {
  const result = ok([answer('a.com', '1.1.1.1', 300), answer('a.com', '2.2.2.2', 60)]);
  assert.equal(minTtl(result), 60);
  assert.equal(maxTtl(result), 300);
  assert.equal(minTtl(ok([])), null);
});

test('typeCode maps the common codes and degrades without throwing', () => {
  assert.equal(typeCode(1), 'A');
  assert.equal(typeCode(28), 'AAAA');
  assert.equal(typeCode(257), 'CAA');
  assert.equal(typeCode(99), 'TYPE99');
});

test('splitPreference separates MX preference from the exchange', () => {
  assert.deepEqual(splitPreference({ data: '10 mail.example.com.' }), {
    preference: 10,
    target: 'mail.example.com.',
  });
  assert.deepEqual(splitPreference({ data: 'v=spf1 -all' }), {
    preference: null,
    target: 'v=spf1 -all',
  });
});

test('toDig produces something that reads like dig output', () => {
  const text = toDig('example.com', 'A', 'Cloudflare', ok([answer('example.com', '1.2.3.4', 300)], 0, 23));
  assert.match(text, /;; Cloudflare/);
  assert.match(text, /;; status: NOERROR {2}query: 23ms/);
  assert.match(text, /example\.com\s+300\s+IN\s+A\s+1\.2\.3\.4/);
});

test('toDig says so when there is nothing to show', () => {
  assert.match(toDig('nope.example', 'A', 'Google', ok([], 3)), /;; status: NXDOMAIN/);
  assert.match(toDig('nope.example', 'A', 'Google', ok([], 3)), /no A records returned/);
  assert.match(toDig('x', 'A', 'Google', { ok: false, error: 'timed out' }), /error: timed out/);
});
