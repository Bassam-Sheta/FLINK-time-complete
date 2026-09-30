'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(fault = {}) {
  const workspace = { WorkspaceID: 'W1', SpreadsheetID: 'ORIGINAL', Status: 'ACTIVE' };
  const updates = [], audits = [], trashed = [], properties = new Map(), calls = { releases: 0, freshReads: 0, copies: 0, snapshots: 0 };
  let locked = false;
  const context = vm.createContext({
    console: { error() {}, warn() {} },
    CONSTANTS: { AUTH_MODE: 'GOOGLE', ROLES: { SUPER_ADMIN: 'SUPER_ADMIN' }, WORKSPACE_STATUS: { ACTIVE: 'ACTIVE', MAINTENANCE: 'MAINTENANCE' }, WORKSPACE_TABS: { ACTIVE_TIMERS: 'ActiveTimers' } },
    AuthorizationService: { assertRole() {} },
    Validation: { generateId: () => 'RST_' + require('node:crypto').randomUUID() },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties.get(key) || null }) },
    AuthService: { _verifyPrimaryIdentity: () => true, _writeSecurityProperty(key, raw) {
      assert.equal(locked, true);
      const record = JSON.parse(raw);
      if (record.status === 'COMPLETED' && fault.receipt === 'before') throw Error('Receipt unavailable');
      properties.set(key, raw);
      if (record.status === 'COMPLETED' && fault.receipt === 'after') throw Error('Receipt acknowledgement lost');
    } },
    SecurityService: { constantTimeEquals: (a, b) => a === b },
    LockService: { getScriptLock: () => ({ tryLock() { locked = true; return true; }, waitLock() { locked = true; }, releaseLock() { locked = false; calls.releases++; } }) },
    SpreadsheetApp: { flush() {} },
    WorkspaceRouter: { clearCache() {} },
    SessionService: { revokeAllUserSessions() { if (fault.revoke) throw Error('Session service unavailable'); } },
    MasterRepository: {
      getCredentials: () => ({}),
      beginRequest() { calls.freshReads++; },
      getWorkspace() { if (fault.readback && updates.length) throw Error('Read unavailable'); return { ...workspace }; },
      getWorkspaceAccessForWorkspace: () => [{ UserID: 'U1' }],
      updateWorkspace(id, values) {
        const stage = values.SpreadsheetID === 'ORIGINAL' ? 'rollback' : values.SpreadsheetID === 'CANDIDATE' ? 'switch' : values.Status === 'ACTIVE' ? 'activate' : 'quiesce';
        updates.push({ stage, ...values });
        if (fault[stage] === 'before') throw Error(stage + ' unavailable');
        if (fault[stage] !== 'ignored') Object.assign(workspace, values);
        if (fault[stage] === 'after') throw Error(stage + ' response lost');
      },
      logGlobalAudit(record) { audits.push(record); if (record.Action === 'RESTORE_COMPLETED' && fault.audit) { if (fault.audit === 'false') return false; throw Error('Audit unavailable'); } return true; }
    },
    DriveApp: { getFileById: id => ({ makeCopy() { calls.copies++; if (fault.copy) throw Error('Copy outcome unknown'); return { getId: () => 'CANDIDATE' }; }, setTrashed: value => trashed.push({ id, value }) }) }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/backend/01-Errors.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/backend/29-BackupAndAuditServices.js'), 'utf8'), context);
  const service = context.BackupService;
  service.validateBackup = () => ({ manifestHash: 'HASH' });
  service._getRegistryRecord = () => ({ BackupFileID: 'BACKUP' });
  service._createBackupUnlocked = () => { calls.snapshots++; return { backupId: 'SAFETY' }; };
  service._openBackupSpreadsheet = () => ({ getSheetByName: () => null });
  service._buildManifest = () => ({ manifestHash: 'HASH' });
  service._validateWorkspaceRollupTotals = () => { if (fault.validate) throw Error('Invalid rollups'); return { rawSeconds: 3600 }; };
  const owner = { userId: 'ROOT', role: 'SUPER_ADMIN' }, intentId = 'intent_1234567890123456';
  const prepared = service.prepareRestore(owner, 'W1', 'BKP1', intentId, '');
  calls.releases = 0; calls.freshReads = 0;
  return { workspace, updates, audits, trashed, calls, properties, service, owner, prepared, intentId, fault,
    restore: (operationId = prepared.operationId) => service.restoreBackup(owner, 'W1', 'BKP1', undefined, operationId) };
}

test('restore completion audit failure never rolls back the committed candidate', () => {
  for (const audit of ['throw', 'false']) {
    const f = fixture({ audit });
    const result = f.restore();
    assert.equal(result.auditRecorded, false);
    assert.equal(f.workspace.SpreadsheetID, 'CANDIDATE');
    assert.equal(f.workspace.Status, 'ACTIVE');
    assert.equal(f.updates.some(update => update.stage === 'rollback'), false);
    assert.deepEqual(f.trashed, []);
    assert.equal(f.calls.releases, 1);
  }
});

test('failed rollback preserves the candidate that is still the live workspace pointer', () => {
  const f = fixture({ switch: 'after', rollback: 'before' });
  assert.throws(f.restore, error => error.code === 'CONFLICT' && error.details.recoveryStatus === 'RECONCILIATION_REQUIRED');
  assert.equal(f.workspace.SpreadsheetID, 'CANDIDATE');
  assert.equal(f.workspace.Status, 'MAINTENANCE');
  assert.deepEqual(f.trashed, []);
  assert.equal(f.calls.releases, 1);
});

test('quiesce response loss still triggers rollback and a fresh state check', () => {
  const f = fixture({ quiesce: 'after' });
  assert.throws(f.restore, error => error.details.recoveryStatus === 'ROLLED_BACK_VERIFIED');
  assert.equal(f.workspace.SpreadsheetID, 'ORIGINAL');
  assert.equal(f.workspace.Status, 'ACTIVE');
  assert.ok(f.calls.freshReads > 0);
  assert.deepEqual(f.trashed, []);
});

test('lost rollback acknowledgement is resolved by reading the original pointer', () => {
  const f = fixture({ revoke: true, rollback: 'after' });
  assert.throws(f.restore, error => error.details.recoveryStatus === 'ROLLED_BACK_VERIFIED');
  assert.equal(f.workspace.SpreadsheetID, 'ORIGINAL');
  assert.equal(f.workspace.Status, 'ACTIVE');
  assert.deepEqual(f.trashed, []);
});

test('rollback acknowledgement without a saved pointer cannot be reported as recovery', () => {
  const f = fixture({ revoke: true, rollback: 'ignored' });
  assert.throws(f.restore, error => error.details.recoveryStatus === 'RECONCILIATION_REQUIRED');
  assert.equal(f.workspace.SpreadsheetID, 'CANDIDATE');
  assert.equal(f.workspace.Status, 'MAINTENANCE');
  assert.deepEqual(f.trashed, []);
});

test('unavailable state read leaves recovery uncertain and preserves both datasets', () => {
  const f = fixture({ revoke: true, readback: true });
  assert.throws(f.restore, error => error.details.recoveryStatus === 'RECONCILIATION_REQUIRED' && error.details.previousSpreadsheetId === 'ORIGINAL' && error.details.candidateFileId === 'CANDIDATE' && error.details.safetyBackupId === 'SAFETY');
  assert.equal(f.workspace.Status, 'MAINTENANCE');
  assert.deepEqual(f.trashed, []);
});

test('invalid candidate is preserved without changing the workspace pointer', () => {
  const f = fixture({ validate: true });
  assert.throws(f.restore);
  assert.deepEqual(f.updates, []);
  assert.equal(f.workspace.SpreadsheetID, 'ORIGINAL');
  assert.deepEqual(f.trashed, []);
  assert.equal(f.calls.releases, 1);
});

test('activation response loss restores and verifies the original pointer', () => {
  const f = fixture({ activate: 'after' });
  assert.throws(f.restore, error => error.details.recoveryStatus === 'ROLLED_BACK_VERIFIED');
  assert.equal(f.workspace.SpreadsheetID, 'ORIGINAL');
  assert.equal(f.workspace.Status, 'ACTIVE');
  assert.deepEqual(f.trashed, []);
});

test('successful restore reads back the candidate and reports a recorded audit', () => {
  const f = fixture();
  const result = f.restore();
  assert.equal(result.auditRecorded, true);
  assert.equal(result.restoredSpreadsheetId, 'CANDIDATE');
  assert.equal(f.workspace.Status, 'ACTIVE');
  assert.ok(f.calls.freshReads > 0);
  assert.equal(f.calls.releases, 1);
});

test('replaying a completed operation returns its receipt without another snapshot or copy', () => {
  const f = fixture(); f.restore(); const before = f.updates.length;
  const replay = f.restore();
  assert.equal(replay.replayed, true); assert.equal(replay.receiptRecorded, true);
  assert.equal(f.calls.copies, 1); assert.equal(f.calls.snapshots, 1); assert.equal(f.updates.length, before);
});

test('copy response loss blocks this operation and a different new intent', () => {
  const f = fixture({ copy: true }); assert.throws(f.restore);
  assert.throws(f.restore, /already ran|reconciliation/);
  assert.throws(() => f.service.prepareRestore(f.owner, 'W1', 'BKP1', 'new_intent_1234567890', f.prepared.operationId), /reconciliation/);
  assert.equal(f.calls.copies, 1); assert.equal(f.calls.snapshots, 1); assert.deepEqual(f.updates, []);
});

test('lost completion receipt acknowledgement never triggers rollback or reexecution', () => {
  const f = fixture({ receipt: 'after' }); assert.equal(f.restore().receiptRecorded, false);
  assert.equal(f.restore().replayed, true); assert.equal(f.calls.copies, 1);
  assert.equal(f.workspace.SpreadsheetID, 'CANDIDATE'); assert.deepEqual(f.trashed, []);
});

test('unwritten completion receipt leaves the operation blocked while the candidate stays active', () => {
  const f = fixture({ receipt: 'before' }); assert.equal(f.restore().receiptRecorded, false);
  assert.throws(f.restore, /already ran|reconciliation/); assert.equal(f.calls.copies, 1);
  assert.equal(f.workspace.Status, 'ACTIVE'); assert.equal(f.workspace.SpreadsheetID, 'CANDIDATE');
});

test('unknown, superseded, expired and corrupt operation records never create resources', () => {
  const f = fixture(); assert.throws(() => f.restore('UNKNOWN'), /Unknown|superseded/);
  f.restore(); const next = f.service.prepareRestore(f.owner, 'W1', 'BKP1', 'next_intent_1234567890', f.prepared.operationId);
  assert.notEqual(next.operationId, f.prepared.operationId); assert.throws(f.restore, /superseded/);
  const key = f.service._restoreOperationKey('W1'), record = JSON.parse(f.properties.get(key));
  record.expiresAtMs = Date.now() - 1; f.properties.set(key, JSON.stringify(record));
  assert.throws(() => f.restore(next.operationId), /expired/);
  f.properties.set(key, '{invalid'); assert.throws(() => f.restore(next.operationId), /owner review/);
  assert.equal(f.calls.copies, 1); assert.equal(f.calls.snapshots, 1);
});

test('repeated prepare reuses its operation and rejects changed backup or actor', () => {
  const f = fixture(); assert.equal(f.service.prepareRestore(f.owner, 'W1', 'BKP1', f.intentId, '').operationId, f.prepared.operationId);
  assert.throws(() => f.service.prepareRestore(f.owner, 'W1', 'OTHER', f.intentId, ''), /different request/);
  assert.throws(() => f.service.prepareRestore({ userId: 'OTHER' }, 'W1', 'BKP1', f.intentId, ''), /different request/);
  assert.deepEqual(f.updates, []); assert.equal(f.calls.copies, 0);
});

test('old browser intents cannot be prepared again after the workspace operation changes', () => {
  const f = fixture(); f.restore();
  f.service.prepareRestore(f.owner, 'W1', 'BKP1', 'other_intent_123456789', f.prepared.operationId);
  assert.throws(() => f.service.prepareRestore(f.owner, 'W1', 'BKP1', f.intentId, ''), /changed/);
  assert.equal(f.calls.copies, 1); assert.equal(f.calls.snapshots, 1);
});

test('expired preparations renew safely while retiring the old operation ID', () => {
  const f = fixture(), key = f.service._restoreOperationKey('W1'), record = JSON.parse(f.properties.get(key));
  record.expiresAtMs = Date.now() - 1; f.properties.set(key, JSON.stringify(record));
  const renewed = f.service.prepareRestore(f.owner, 'W1', 'BKP1', f.intentId, '');
  assert.notEqual(renewed.operationId, f.prepared.operationId);
  assert.throws(f.restore, /superseded/);
  assert.equal(f.calls.copies, 0); f.restore(renewed.operationId); assert.equal(f.calls.copies, 1);
});

test('restore status and prepare enforce the real dispatcher MFA, role and step-up gates', () => {
  const backend = require('../apps-script/Code.gs');
  const saved = { validate: backend.SessionService.validateSession, mfa: backend.AuthService.hasVerifiedMfaSession, step: backend.AuthService.assertStepUp };
  try {
    backend.SessionService.validateSession = () => ({ userId: 'ROOT', role: 'SUPER_ADMIN', user: { Role: 'SUPER_ADMIN' } });
    backend.AuthService.hasVerifiedMfaSession = () => false;
    for (const action of ['backups.restoreStatus', 'backups.restorePrepare']) assert.throws(() => backend.dispatchAction(action, { sessionToken: 'ENROLL_ONLY', payload: {} }), /authenticator verification/);
    backend.AuthService.hasVerifiedMfaSession = () => true;
    backend.SessionService.validateSession = () => ({ userId: 'U1', role: 'USER', user: { Role: 'USER' } });
    for (const action of ['backups.restoreStatus', 'backups.restorePrepare']) assert.throws(() => backend.dispatchAction(action, { sessionToken: 'USER', payload: {} }), /Permission denied/);
    backend.SessionService.validateSession = () => ({ userId: 'ROOT', role: 'SUPER_ADMIN', user: { Role: 'SUPER_ADMIN' } });
    backend.AuthService.assertStepUp = () => { throw Error('Fresh MFA required'); };
    assert.throws(() => backend.dispatchAction('backups.restorePrepare', { sessionToken: 'ROOT', payload: {} }), /Fresh MFA required/);
  } finally {
    backend.SessionService.validateSession = saved.validate; backend.AuthService.hasVerifiedMfaSession = saved.mfa; backend.AuthService.assertStepUp = saved.step;
  }
});
