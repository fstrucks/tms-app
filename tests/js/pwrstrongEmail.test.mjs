// pwrstrong.net email move: default sender, own domains, inbound on both domains, shown domain behind a flag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { senderConfig } from '../../app/lib/packetSend.js';
import { OWN_DOMAINS, isOwnDomain, matchDomain } from '../../app/lib/packetFingerprint.js';
import { rateconRecipient } from '../../app/lib/rateconEmail.js';
import { INBOUND_DOMAINS, shownInboundDomain, RATECON_DOMAIN, INBOUND_ADDRESS, rateconAddress } from '../../app/lib/rateconDrafts.js';
import { INBOUND_ADDRESS as SERVER_INBOUND } from '../../app/lib/postmarkInbound.js';

const TOKEN = 'a'.repeat(32);

test('default From is noreply@pwrstrong.net; PACKET_FROM_EMAIL still overrides', () => {
  assert.equal(senderConfig({}).from, 'noreply@pwrstrong.net');
  assert.equal(senderConfig({ PACKET_FROM_EMAIL: ' noreply@fstrucks.com ' }).from, 'noreply@fstrucks.com');
});

test('send allow-list default is unchanged (fstrucks.com only)', () => {
  const src = readFileSync('app/lib/packetSend.js', 'utf8');
  assert.match(src, /'fstrucks\.com'/);
});

test('pwrstrong.net is an own domain, never matched as a broker', () => {
  assert.ok(OWN_DOMAINS.includes('pwrstrong.net') && OWN_DOMAINS.includes('fstrucks.com'));
  assert.equal(isOwnDomain('pwrstrong.net'), true);
  assert.equal(matchDomain('dakota@pwrstrong.net'), null);
});

test('rate con address accepted on both inbound domains, case-insensitive; others ignored', () => {
  for (const d of ['in.fstrucks.com', 'in.pwrstrong.net', 'IN.PWRSTRONG.NET']) {
    assert.deepEqual(rateconRecipient({ To: `ratecon+${TOKEN}@${d}` }), { token: TOKEN }, d);
  }
  assert.equal(rateconRecipient({ To: `ratecon+${TOKEN}@pwrstrong.net` }), null);
  assert.equal(rateconRecipient({ To: `ratecon+${TOKEN}@in.pwrstrong.net.evil.example` }), null);
  assert.equal(rateconRecipient({ To: `ratecon+${TOKEN}@inxpwrstrong.net` }), null);
});

test('shown inbound domain stays in.fstrucks.com unless the flag names an accepted domain', () => {
  assert.deepEqual(INBOUND_DOMAINS, ['in.fstrucks.com', 'in.pwrstrong.net']);
  assert.equal(shownInboundDomain(undefined), 'in.fstrucks.com');
  assert.equal(shownInboundDomain(''), 'in.fstrucks.com');
  assert.equal(shownInboundDomain('evil.example'), 'in.fstrucks.com');
  assert.equal(shownInboundDomain(' In.PwrStrong.net '), 'in.pwrstrong.net');
  assert.equal(RATECON_DOMAIN, 'in.fstrucks.com'); // flag unset in tests
  assert.equal(INBOUND_ADDRESS, 'packets@in.fstrucks.com');
  assert.equal(SERVER_INBOUND, INBOUND_ADDRESS);
  assert.equal(rateconAddress(TOKEN), `ratecon+${TOKEN}@in.fstrucks.com`);
});

test('packets page shows the flagged inbound address, not a hard-coded one', () => {
  const src = readFileSync('app/packets/page.js', 'utf8');
  assert.doesNotMatch(src, /in\.fstrucks\.com/);
  assert.match(src, /\{INBOUND_ADDRESS\}/);
  assert.match(readFileSync('app/lib/rateconDrafts.js', 'utf8'), /process\.env\.NEXT_PUBLIC_INBOUND_DOMAIN/);
});
