'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
function harness(initial = {}) {
  const props = { ...initial }; let locked = false, acquired = 0;
  const context = { Date, JSON, console, CONSTANTS: { AUTH_MODE: 'GOOGLE' }, ERROR_CODES: { SERVER_BUSY: 'SERVER_BUSY' },
    AppError: class extends Error { constructor(code, message, status) { super(message); this.code = code; this.statusCode = status; } },
    PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({ ...props }), setProperty(key, value) { props[key] = value; }, deleteProperty(key) { delete props[key]; } }) },
    LockService: { getScriptLock: () => ({ hasLock: () => locked, waitLock() { locked = true; acquired++; }, releaseLock() { locked = false; } }) }
  };
  vm.createContext(context); vm.runInContext(fs.readFileSync('src/backend/09-AuthService.js', 'utf8'), context);
  return { service: context.AuthService, props, setLocked: () => { locked = true; }, acquisitions: () => acquired };
}
test('authentication admission fails closed before property storage reaches Google capacity', () => {
  const { service, props, acquisitions } = harness({ OTHER_DATA: 'a'.repeat(400000) });
  assert.throws(() => service._writeSecurityProperty('FLINK_MFA_SESSION_NEW', '{}'), error => error.statusCode === 503);
  assert.equal(props.FLINK_MFA_SESSION_NEW, undefined); assert.equal(acquisitions(), 1);
});
test('expired security state can be reclaimed while unrelated secrets are preserved', () => {
  const { service, props } = harness({ PEPPER: 'keep-private', OTHER_DATA: 'a'.repeat(350000), FLINK_MFA_SESSION_OLD: JSON.stringify({ expiresAtMs: 1 }) });
  service._writeSecurityProperty('FLINK_MFA_SESSION_NEW', JSON.stringify({ expiresAtMs: Date.now() + 1000 }));
  assert.equal(props.FLINK_MFA_SESSION_OLD, undefined); assert.equal(props.PEPPER, 'keep-private'); assert.ok(props.FLINK_MFA_SESSION_NEW);
});
test('unexpired MFA records are not removed to admit new sessions', () => {
  const record = JSON.stringify({ expiresAtMs: Date.now() + 60000 });
  const { service, props } = harness({ OTHER_DATA: 'a'.repeat(400000), FLINK_MFA_SESSION_ACTIVE: record });
  assert.throws(() => service._writeSecurityProperty('FLINK_MFA_SESSION_NEW', '{}'), /capacity/); assert.equal(props.FLINK_MFA_SESSION_ACTIVE, record);
});
test('value admission counts UTF-8 bytes rather than JavaScript characters', () => {
  const { service, props } = harness(); assert.throws(() => service._writeSecurityProperty('FLINK_REAUTH_NEW', 'ع'.repeat(4001)), /size limit/);
  assert.equal(props.FLINK_REAUTH_NEW, undefined);
});
test('security-state writes reuse an already held Apps Script lock', () => {
  const { service, acquisitions, setLocked } = harness(); setLocked(); service._writeSecurityProperty('FLINK_REAUTH_NEW', '{}'); assert.equal(acquisitions(), 0);
});
