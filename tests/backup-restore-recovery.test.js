'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(fault = {}) {
  const workspace = { WorkspaceID: 'W1', SpreadsheetID: 'ORIGINAL', Status: 'ACTIVE' };
  const updates = [], audits = [], trashed = [], calls = { releases: 0, freshReads: 0 };
  const context = vm.createContext({
    console: { error() {}, warn() {} },
    CONSTANTS: { AUTH_MODE: 'GOOGLE', ROLES: { SUPER_ADMIN: 'SUPER_ADMIN' }, WORKSPACE_STATUS: { ACTIVE: 'ACTIVE', MAINTENANCE: 'MAINTENANCE' }, WORKSPACE_TABS: { ACTIVE_TIMERS: 'ActiveTimers' } },
    AuthorizationService: { assertRole() {} },
    AuthService: { _verifyPrimaryIdentity: () => true },
    SecurityService: { constantTimeEquals: (a, b) => a === b },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => calls.releases++ }) },
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
    DriveApp: { getFileById: id => ({ makeCopy: () => ({ getId: () => 'CANDIDATE' }), setTrashed: value => trashed.push({ id, value }) }) }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/backend/01-Errors.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/backend/29-BackupAndAuditServices.js'), 'utf8'), context);
  const service = context.BackupService;
  service.validateBackup = () => ({ manifestHash: 'HASH' });
  service._getRegistryRecord = () => ({ BackupFileID: 'BACKUP' });
  service._createBackupUnlocked = () => ({ backupId: 'SAFETY' });
  service._openBackupSpreadsheet = () => ({ getSheetByName: () => null });
  service._buildManifest = () => ({ manifestHash: 'HASH' });
  service._validateWorkspaceRollupTotals = () => { if (fault.validate) throw Error('Invalid rollups'); return { rawSeconds: 3600 }; };
  return { workspace, updates, audits, trashed, calls, restore: () => service.restoreBackup({ userId: 'ROOT', role: 'SUPER_ADMIN' }, 'W1', 'BKP1') };
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
