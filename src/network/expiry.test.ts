import test from 'node:test';
import assert from 'node:assert/strict';
import { expiryFromOptions } from './expiry.js';

const now = Date.parse('2026-10-18T00:00:00.000Z');
const day = 86_400_000;
test('owner expiry accepts UTC seconds/fractions and TTL but stores one canonical timestamp', () => {
  for (const [input, expected] of [
    ['2026-10-18T01:00:00Z', '2026-10-18T01:00:00.000Z'],
    ['2026-10-18T01:00:00.1Z', '2026-10-18T01:00:00.100Z'],
    ['2026-10-18T01:00:00.12+00:00', '2026-10-18T01:00:00.120Z'],
    ['2026-10-18T01:00:00.123Z', '2026-10-18T01:00:00.123Z'],
  ]) assert.equal(expiryFromOptions({ 'expires-at': input! }, day, now), expected);
  for (const [ttl, ms] of [['1s', 1000], ['30m', 1_800_000], ['12h', 43_200_000], ['1d', day]] as const) {
    assert.equal(Date.parse(expiryFromOptions({ ttl }, day, now)) - now, ms);
  }
});
test('expiry rejects ambiguous or overflowing durations and invalid normalized dates', () => {
  for (const ttl of ['0h', '-1h', '1.5h', '01h', 'Infinityh', '2h later', '99999999999999999999d', '25h']) {
    assert.throws(() => expiryFromOptions({ ttl }, day, now), /ttl|Expiry/);
  }
  for (const value of ['2026-02-30T12:00:00Z', '2026-10-18T24:00:00Z', '2026-10-18 01:00:00Z', '2026-10-18T01:00:00', '2026-10-18T01:00:00+01:00', '2026-10-18T01:00:00.1234Z', '2026-10-18T00:00:00Z']) {
    assert.throws(() => expiryFromOptions({ 'expires-at': value }, day, now), /UTC|Expiry/);
  }
  assert.throws(() => expiryFromOptions({}, day, now), /exactly one/);
  assert.throws(() => expiryFromOptions({ ttl: '1h', 'expires-at': '2026-10-18T01:00:00Z' }, day, now), /exactly one/);
  assert.equal(Date.parse(expiryFromOptions({ ttl: '30d' }, 30 * day, now)) - now, 30 * day);
  assert.throws(() => expiryFromOptions({ ttl: '31d' }, 30 * day, now), /within 720 hours/);
});
