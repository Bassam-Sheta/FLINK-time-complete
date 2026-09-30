'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const crypto = require('node:crypto');
const a = require('../apps-script/Code.gs');

test('v2 authenticator secrets round-trip and reject ciphertext, nonce and key changes', () => {
  const service = a.SecurityService;
  const secret = 'JBSWY3DPEHPK3PXP';
  const encoded = service.encryptSecret(secret);
  assert.match(encoded,/^enc\$v2\$/);
  assert.equal(service.decryptSecret(encoded),secret);
  const fields = encoded.split('$');
  for (const index of [2,3]) {
    const tampered = fields.slice();
    tampered[index] = (tampered[index][0] === 'a' ? 'b' : 'a') + tampered[index].slice(1);
    assert.throws(()=>service.decryptSecret(tampered.join('$')),/integrity/);
  }
  const oldKey = service._getSecretEncryptionKey;
  service._getSecretEncryptionKey = () => new Uint8Array(32);
  try { assert.throws(()=>service.decryptSecret(encoded),/integrity/); }
  finally { service._getSecretEncryptionKey = oldKey; }
  assert.throws(()=>service.decryptSecret(encoded+'$extra'),/Malformed/);
});

test('legacy v1 fixture remains readable and migrates to v2 on re-encryption', () => {
  const fixture = 'enc$v1$0123456789abcdef0123456789abcdef$41c36c145ba4671a7fb1f8ab84e64511$d199f1b1890769905fa3136fb2c9b2e5c1dedf7812b1e147a4f4fda2297f36ca';
  const plain = a.SecurityService.decryptSecret(fixture);
  assert.equal(plain,'JBSWY3DPEHPK3PXP');
  assert.match(a.SecurityService.encryptSecret(plain),/^enc\$v2\$/);
  assert.throws(()=>a.SecurityService.decryptSecret(fixture+'$trailing'),/Malformed/);
});

test('Apps Script-like V8 executes secretbox without Node crypto or browser APIs', () => {
  const sandbox = {console, Utilities: {
    getUuid: () => crypto.randomUUID(),
    computeHmacSha256Signature: (message,key) => Array.from(crypto.createHmac('sha256',Buffer.from(key)).update(Buffer.from(message)).digest())
  }};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(require.resolve('../apps-script/Code.gs'),'utf8'),sandbox);
  const result = vm.runInContext("SecurityService.decryptSecret(SecurityService.encryptSecret('JBSWY3DPEHPK3PXP'))",sandbox);
  assert.equal(result,'JBSWY3DPEHPK3PXP');
});

test('UUID fallback omits fixed version/variant nibbles and rejects non-v4 sources', () => {
  const oldResolver = a.SecurityService._getCrypto;
  a.SecurityService._getCrypto = () => null;
  global.Utilities = {getUuid:()=> '00000000-0000-4000-8000-000000000000'};
  try {
    assert.equal(a.SecurityService.generateRandomHex(32),'0'.repeat(64));
    global.Utilities.getUuid = () => '00000000-0000-1000-8000-000000000000';
    assert.throws(()=>a.SecurityService.generateRandomHex(32),/invalid UUID/);
  } finally { a.SecurityService._getCrypto = oldResolver; delete global.Utilities; }
});
