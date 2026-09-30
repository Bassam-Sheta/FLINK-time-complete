'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const backend = require('../apps-script/Code.gs');
const { MASTER_SCHEMA, CONSTANTS, ACTION_PERMISSIONS, AppError, ERROR_CODES, Validation } = backend;
function harness() {
  const tables = { PrivacyRequests: [], ControlEvidence: [] }, audits = [];
  let notice = '';
  const context = { Date, JSON, console, AppError, ERROR_CODES, CONSTANTS, MASTER_SCHEMA, Validation,
    AuthorizationService: { assertRole(actor, roles) { if (!roles.includes(actor.role)) throw new AppError('PERMISSION_DENIED', 'Denied', 403); } },
    LockService: { getScriptLock() { return { waitLock() {}, releaseLock() {} }; } },
    MasterRepository: {
      getMasterSpreadsheet() { return { getSheetByName(tab) {
        return { getLastRow: () => tables[tab].length + 1, getRange(row, _column, count) {
          return { getValues: () => row === 1 ? [MASTER_SCHEMA[tab]] : tables[tab].slice(row - 2, row - 2 + count).map(record => MASTER_SCHEMA[tab].map(key => record[key] || '')) };
        } };
      } }; },
      findRowByKey(tab, key, value) { const index = tables[tab].findIndex(row => row[key] === value); return index < 0 ? null : { ...tables[tab][index], _rowIndex: index + 2 }; },
      appendRow(tab, record) { tables[tab].push(Validation.sanitizeRow(record)); },
      updateRow(tab, row, patch) { Object.assign(tables[tab][row - 2], Validation.sanitizeRow(patch)); },
      getTableData(tab) { return { rows: tables[tab] }; },
      getGlobalSettingStrict() { return notice; }, setGlobalSetting(_key, value) { notice = value; },
      logGlobalAudit(record) { audits.push(record); return true; }
    }
  };
  vm.createContext(context); vm.runInContext(fs.readFileSync('src/backend/31-PrivacyService.js', 'utf8'), context);
  return { service: context.PrivacyService, tables, audits, context };
}
const user = { role: 'USER', userId: 'U1' }, root = { role: 'SUPER_ADMIN', userId: 'SA1' };
const payload = { operationId: 'abcdefghijklmnop', type: 'ACCESS', detail: 'Please provide my records.' };
test('privacy submission derives subject from session and retries without duplicate rows', () => {
  const { service, tables, audits } = harness();
  service.submit(user, { ...payload, targetUserId: 'OTHER' });
  assert.equal(service.submit(user, payload).replayed, true);
  assert.equal(tables.PrivacyRequests.length, 1); assert.equal(tables.PrivacyRequests[0].UserID, 'U1');
  assert.equal(audits.length, 1); assert.equal(audits[0].AfterJSON, undefined); assert.equal(audits[0].Reason, undefined);
  assert.throws(() => service.submit(user, { ...payload, detail: 'Different request' }), /different request/);
});
test('privacy listing never exposes another subject to users or managers', () => {
  const { service } = harness(); service.submit(user, payload); service.submit({ userId: 'U2', role: 'USER' }, payload);
  for (const role of ['USER', 'ADMIN']) {
    const page = service.list({ ...user, role }); assert.equal(page.requests.length, 1); assert.equal(page.requests[0].UserID, 'U1');
  }
  assert.equal(service.list(root).requests.length, 2);
});
test('privacy queue uses bounded pages without dropping records', () => {
  const { service, tables } = harness();
  for (let i = 0; i < 451; i++) tables.PrivacyRequests.push({ RequestID: String(i), UserID: 'U1' });
  const first = service.list(root), second = service.list(root, { before: first.nextBefore }), third = service.list(root, { before: second.nextBefore });
  assert.equal(first.requests.length, 200); assert.equal(second.requests.length, 200); assert.equal(third.requests.length, 51);
  assert.equal(third.nextBefore, null); assert.equal(new Set([...first.requests, ...second.requests, ...third.requests].map(row => row.RequestID)).size, 451);
  assert.throws(() => service.list(root, { before: -1 }), /cursor/);
});
test('calendar deadline clamps month ends including leap years', () => {
  const { service } = harness();
  assert.equal(service.responseDueAt('2028-01-31T14:30:00.000Z'), '2028-02-29T14:30:00.000Z');
  assert.equal(service.responseDueAt('2026-01-31T14:30:00.000Z'), '2026-02-28T14:30:00.000Z');
  assert.equal(service.responseDueAt('2026-12-31T14:30:00.000Z'), '2027-01-31T14:30:00.000Z');
});
test('review requires root, HTTPS evidence and current version; closed requests cannot be replayed', () => {
  const { service } = harness(); const id = service.submit(user, payload).request.RequestID;
  const decision = { requestId: id, version: 1, status: 'CLOSED', response: 'Delivered through approved channel.', evidenceUrl: 'https://drive.google.com/file/d/private' };
  assert.throws(() => service.review(user, decision), /Denied/);
  assert.throws(() => service.review(root, { ...decision, evidenceUrl: 'javascript:alert(1)' }), /HTTPS/);
  assert.throws(() => service.review(root, { ...decision, version: 0 }), /changed/);
  assert.equal(service.review(root, decision).request.Status, 'CLOSED');
  assert.throws(() => service.review(root, decision), /closed/);
});
test('request fields are bounded and formula content is neutralized in Sheets', () => {
  const { service, tables } = harness();
  assert.throws(() => service.submit(user, { ...payload, type: 'PASSWORD_RESET' }), /Unsupported/);
  assert.throws(() => service.submit(user, { ...payload, detail: 'a'.repeat(2001) }), /bounded/);
  service.submit(user, { ...payload, detail: '=IMPORTXML("https://evil.test")' });
  assert.ok(tables.PrivacyRequests[0].Detail.startsWith("'="));
  // Sheets may consume its leading text-escape apostrophe when reading values.
  tables.PrivacyRequests[0].Detail = tables.PrivacyRequests[0].Detail.slice(1);
  assert.equal(service.submit(user, { ...payload, detail: '=IMPORTXML("https://evil.test")' }).replayed, true);
});
test('notice rejects credential URLs and validates stored URLs on every read', () => {
  const { service, context } = harness();
  const notice = Object.fromEntries(['controller','privacyContact','purpose','lawfulBasis','dataCategories','retentionPolicy','version'].map(key => [key, 'Operator-reviewed text']));
  assert.throws(() => service.saveNotice(user, notice), /Denied/);
  assert.throws(() => service.saveNotice(root, { ...notice, noticeUrl: 'https://user:password@example.test/' }), /HTTPS/);
  service.saveNotice(root, { ...notice, noticeUrl: 'https://example.test/privacy' }); assert.equal(service.getNotice().configured, true);
  context.MasterRepository.setGlobalSetting('PRIVACY_NOTICE_JSON', JSON.stringify({ ...notice, noticeUrl: 'javascript:alert(1)' }));
  assert.throws(() => service.getNotice(), /invalid/);
});
test('assurance starts missing and records unverified evidence rather than certification', () => {
  const { service } = harness();
  assert.ok(service.assurance(root).controls.every(control => control.state === 'MISSING_EVIDENCE'));
  assert.throws(() => service.saveEvidence(root, { controlId: 'CERTIFIED' }), /Unknown/);
  service.saveEvidence(root, { controlId: 'ACCESS', owner: 'IT owner', evidenceUrl: 'https://example.test/evidence', notes: 'Manual review', nextReviewAt: '2099-10-01' });
  assert.equal(service.assurance(root).assessment, 'NOT_ASSESSED'); assert.equal(service.assurance(root).controls[0].state, 'RECORDED_UNVERIFIED');
  assert.throws(() => service.assurance(user), /Denied/);
});
test('audit failure does not tell the user a committed request failed', () => {
  const { service, context, tables } = harness(); context.MasterRepository.logGlobalAudit = () => { throw new Error('Google unavailable'); };
  assert.equal(service.submit(user, payload).auditRecorded, false); assert.equal(tables.PrivacyRequests.length, 1);
});
test('new API actions require authentication and root-only writes are marked mutations', () => {
  for (const action of ['privacy.notice','privacy.requests.list','privacy.requests.submit','privacy.initialize','privacy.notice.save','privacy.requests.review','assurance.list','assurance.save']) assert.equal(ACTION_PERMISSIONS[action].authRequired, true);
  for (const action of ['privacy.initialize','privacy.notice.save','privacy.requests.review','assurance.save']) {
    assert.deepEqual(ACTION_PERMISSIONS[action].roles, ['SUPER_ADMIN']); assert.equal(ACTION_PERMISSIONS[action].isWrite, true);
  }
});
test('real dispatcher rejects enrollment-only sessions and root mutations without step-up', () => {
  const originalValidate = backend.SessionService.validateSession, originalMfa = backend.AuthService.hasVerifiedMfaSession,
    originalStep = backend.AuthService.assertStepUp;
  try {
    backend.SessionService.validateSession = () => ({ ...user, user: { Role: 'USER' } });
    backend.AuthService.hasVerifiedMfaSession = () => false;
    for (const action of ['privacy.notice','privacy.requests.list','privacy.requests.submit']) {
      assert.throws(() => backend.dispatchAction(action, { sessionToken: 'ENROLLMENT_ONLY', payload }), /authenticator verification/);
    }
    backend.AuthService.hasVerifiedMfaSession = () => true;
    for (const action of ['privacy.initialize','privacy.notice.save','privacy.requests.review','assurance.save']) {
      assert.throws(() => backend.dispatchAction(action, { sessionToken: 'USER', payload }), /Permission denied/);
    }
    backend.SessionService.validateSession = () => ({ ...root, user: { Role: 'SUPER_ADMIN' } });
    backend.AuthService.assertStepUp = () => { throw new AppError('AUTH_REQUIRED', 'Fresh MFA required', 403); };
    for (const action of ['privacy.initialize','privacy.notice.save','privacy.requests.review','assurance.save']) {
      assert.throws(() => backend.dispatchAction(action, { sessionToken: 'ROOT', payload }), /Fresh MFA required/);
    }
  } finally {
    backend.SessionService.validateSession = originalValidate; backend.AuthService.hasVerifiedMfaSession = originalMfa; backend.AuthService.assertStepUp = originalStep;
  }
});
