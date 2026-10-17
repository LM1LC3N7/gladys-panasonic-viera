// -----------------------------------------------------------------------------
// The pure SOAP / UPnP helpers, on answers shaped like the TVs' ones.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeXml,
  encryptedInner,
  envelope,
  escapeXml,
  needsEncryption,
  parseAppList,
  parseDescription,
  parseFault,
  tagText,
} from '../src/viera/soap.js';
import { APP_LIST, UDN, description, serviceList } from './fixtures/fakeTv.js';

test('tagText ignores namespace prefixes and decodes entities', () => {
  assert.equal(tagText('<u:X_Key a="1"> v&amp;w </u:X_Key>', 'X_Key'), 'v&w');
  assert.equal(tagText('<X_Key>1</X_Key>', 'X_Ke'), undefined);
  assert.equal(tagText(undefined, 'X'), undefined);
  assert.equal(decodeXml('&#65;&#x42;&apos;&unknown;'), "AB'&unknown;");
  assert.equal(
    escapeXml(`<a href="x">'&'</a>`),
    '&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;',
  );
  // Names inside other names, closing prefixes, self-closing elements.
  assert.equal(tagText('<X_KeyEvent>a</X_KeyEvent><X_Key>b</X_Key>', 'X_Key'), 'b');
  assert.equal(tagText('<u:X_Key>c</X_Key >', 'X_Key'), 'c');
  assert.equal(tagText('<X_Key/><X_Key>d</X_Key>', 'X_Key'), 'd');
  assert.equal(tagText('<X_Key />', 'X_Key'), '');
  assert.equal(tagText('<X_Key>no end', 'X_Key'), undefined);
  assert.equal(tagText('</X_Key><X_Key>e</a:X_Key>', 'X_Key'), 'e');
});

test('tagText stays linear on a hostile 512 KB answer', () => {
  const hostile = [
    '<X_Key '.repeat(75_000),
    `<X_Key>${'X_Key'.repeat(105_000)}`,
    '<a:'.repeat(175_000) + 'X_Key>',
    `<X_Key>${'</X_Key '.repeat(66_000)}`,
  ];
  for (const body of hostile) {
    assert.ok(body.length >= 512 * 1024, `${body.length}`);
    const started = performance.now();
    tagText(body, 'X_Key');
    tagText(body, 'CurrentVolume');
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 200, `${elapsed} ms`);
  }
});

test('the envelope and the encrypted inner command', () => {
  const xml = envelope('urn:x', 'X_SendKey', '<X_KeyEvent>K</X_KeyEvent>', 'u');
  assert.match(xml, /<u:X_SendKey xmlns:u="urn:urn:x"><X_KeyEvent>K<\/X_KeyEvent><\/u:X_SendKey>/);
  assert.equal(
    encryptedInner('12', 3, 'svc', 'X_SendKey', ''),
    '<X_SessionId>12</X_SessionId><X_SequenceNumber>00000003</X_SequenceNumber>' +
      '<X_OriginalCommand><u:X_SendKey xmlns:u="urn:svc"></u:X_SendKey></X_OriginalCommand>',
  );
});

test('parseDescription: UDN, name, model; other brands refused', () => {
  assert.deepEqual(parseDescription(description()), {
    udn: UDN,
    name: 'Living room TV',
    model: 'TX-55GZ950',
    manufacturer: 'Panasonic',
  });
  assert.equal(parseDescription(description().replace('Panasonic<', 'Sony<')), undefined);
  assert.equal(parseDescription(description().replace(/<UDN>.*<\/UDN>/, '')), undefined);
  assert.equal(parseDescription(description({ udn: '../../etc' })), undefined);
});

test('needsEncryption reads the action list', () => {
  assert.equal(needsEncryption(serviceList(true)), true);
  assert.equal(needsEncryption(serviceList(false)), false);
});

test('parseAppList: product ids and names, entities or not', () => {
  const expected = [
    { id: '0387878700000003', name: 'Media Player' },
    { id: '0010000200000001', name: 'Netflix' },
    { id: '0020009300000001', name: 'Demand 5' },
  ];
  assert.deepEqual(parseAppList(APP_LIST), expected);
  assert.deepEqual(parseAppList(APP_LIST.replace(/'/g, '&apos;')), expected);
  assert.deepEqual(parseAppList("vc_app'resource_id=1063'Browser'"), []);
});

test('parseFault reads the UPnP error', () => {
  assert.deepEqual(
    parseFault(
      '<s:Fault><detail><UPnPError><errorCode>600</errorCode><errorDescription>Invalid PIN Code</errorDescription></UPnPError></detail></s:Fault>',
    ),
    { code: '600', description: 'Invalid PIN Code' },
  );
  assert.equal(parseFault('<html>500</html>'), undefined);
});
