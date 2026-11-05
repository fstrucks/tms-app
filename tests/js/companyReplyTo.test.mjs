// Company Reply-to email (Marc, Oct 26): a per-company field on Company and in setup. Fake data only; no mail.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PROFILE_FIELDS, validateProfile, isReplyToEmail, REPLY_TO_HELP } from '../../app/lib/companyFields.js';
import { buildRow } from '../../app/lib/companyProfile.js';
import { OPTIONAL_COLUMNS } from '../../app/lib/companyProfileSave.js';
import { companyReplyTo, senderConfig } from '../../app/lib/packetSend.js';
import { publicSetupProfile } from '../../app/lib/setupServer.js';
import { downloadedName, packetFileName } from '../../app/lib/loadExport.js';
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('field: listed with a clear label; validated as an email; blank allowed and saved as null', () => {
  assert.deepEqual(PROFILE_FIELDS.find(([k]) => k === 'reply_to_email'), ['reply_to_email', 'Reply-to email']);
  assert.match(REPLY_TO_HELP, /Where broker replies to your emailed paperwork should go/);
  assert.equal(validateProfile({ legal_name: 'FAKE', reply_to_email: 'nope' }).reply_to_email, 'Enter a valid email, or leave it blank.');
  for (const ok of ['', 'office@fake-carrier.com', ' Ops.Team+loads@fake-carrier.co ']) assert.equal(validateProfile({ legal_name: 'FAKE', reply_to_email: ok }).reply_to_email, undefined, ok);
  for (const bad of ['a@b', '@x.com', 'a b@x.com', 'a@@x.com', 'x'.repeat(250) + '@f.com']) assert.equal(isReplyToEmail(bad), false, bad);
  assert.deepEqual(buildRow({ reply_to_email: '  office@fake-carrier.com ' }), { reply_to_email: 'office@fake-carrier.com' });
  assert.deepEqual(buildRow({ reply_to_email: '' }), { reply_to_email: null });
  assert.ok(OPTIONAL_COLUMNS.includes('reply_to_email'), 'save still works before the migration is applied');
});

test('companyReplyTo: company value, else fallback, else null; no marc@ hard-coded for other companies', () => {
  assert.equal(companyReplyTo({ reply_to_email: 'office@fake-carrier.com' }, 'env@fstrucks.com'), 'office@fake-carrier.com');
  assert.equal(companyReplyTo({ reply_to_email: '' }, 'env@fstrucks.com'), 'env@fstrucks.com');
  assert.equal(companyReplyTo({ reply_to_email: 'garbage' }, null), null);
  assert.equal(companyReplyTo(null, null), null);
  assert.equal(senderConfig({}).from, 'noreply@pwrstrong.net', 'From stays the TMS sender');
});

test('setup: the company step offers the optional field (only once the column exists) with the help text', () => {
  assert.equal(publicSetupProfile({ id: 'p', reply_to_email: 'office@fake-carrier.com' }).reply_to_email, 'office@fake-carrier.com');
  assert.equal('reply_to_email' in publicSetupProfile({ id: 'p' }), false);
  const setup = read('../../app/documents/checklist/page.js');
  assert.match(setup, /Reply-to email \(optional\)/); assert.match(setup, /\{REPLY_TO_HELP\}/); assert.match(setup, /isReplyToEmail\(form\.reply_to_email\)/);
  const company = read('../../app/company/page.js');
  assert.match(company, /k === 'reply_to_email' && <p id="cp-reply_to_email-help"/); assert.match(company, /REPLY_TO_HELP/);
  for (const src of [setup, company]) assert.doesNotMatch(src, /marc@/);
});

test('download message uses the real file name (Taylor: NoInvoice file, message said _Packet)', () => {
  const fileNames = { withInvoice: packetFileName({ broker_load_number: 'TEST-QA7' }, true), withoutInvoice: packetFileName({ broker_load_number: 'TEST-QA7' }, false) };
  assert.equal(downloadedName('attachment; filename="TEST-QA7_Packet-NoInvoice.pdf"', { invoice: true }, fileNames), 'TEST-QA7_Packet-NoInvoice.pdf', 'the server’s name wins');
  assert.equal(downloadedName(null, { invoice: false }, fileNames), 'TEST-QA7_Packet-NoInvoice.pdf');
  assert.equal(downloadedName('', { invoice: true }, fileNames), 'TEST-QA7_Packet.pdf');
  assert.equal(downloadedName("attachment; filename*=UTF-8''TEST-QA7_Packet-NoInvoice.pdf", {}, null), 'TEST-QA7_Packet-NoInvoice.pdf');
  assert.equal(downloadedName(null, {}, null), 'Packet.pdf');
  const ui = read('../../app/components/LoadExport.js');
  assert.equal((ui.match(/downloadedName\(r\.headers\.get\('content-disposition'\), sel, info\?\.fileNames\)/g) || []).length, 2);
  assert.match(ui, /a\.download = name;[\s\S]*setNote\(`Downloaded \$\{name\}/);
});
