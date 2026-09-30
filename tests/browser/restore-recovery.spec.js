'use strict';
const { test, expect } = require('@playwright/test');

async function login(page) {
  await page.goto('/superadmin');
  await page.getByRole('button', { name: 'Continue with Google', exact: true }).click();
  await page.locator('#mfaCode').fill('123456');
  await page.getByRole('button', { name: 'Verify & Sign In', exact: true }).click();
  await expect(page.locator('#appHeader')).toBeVisible();
}

test('restore binds the displayed workspace, prevents double submission, and shows audit failure', async ({ page }) => {
  await login(page);
  const evidence = await page.evaluate(async () => {
    const alerts = [], requests = [];
    window.alert = message => alerts.push(message);
    state.currentWorkspace = 'W1'; openRestoreWizard('BACKUP1');
    let releaseValidation;
    apiCall = async (action, payload) => {
      requests.push({ action, workspaceId: payload.workspaceId });
      if (action === 'backups.restoreValidate') await new Promise(resolve => { releaseValidation = resolve; });
      return { operationId: 'OPERATION1', safetyBackupId: 'SAFETY1', auditRecorded: false, receiptRecorded: true };
    };
    renderSaBackups = async () => {};
    const pending = submitRestoreBackup();
    await submitRestoreBackup();
    state.currentWorkspace = 'W2'; releaseValidation(); await pending;
    return { alerts, requests };
  });
  expect(evidence.requests).toEqual([{ action: 'backups.restoreStatus', workspaceId: 'W1' }, { action: 'backups.restoreValidate', workspaceId: 'W1' }, { action: 'backups.restorePrepare', workspaceId: 'W1' }, { action: 'backups.restoreApply', workspaceId: 'W1' }]);
  expect(evidence.alerts).toHaveLength(1);
  expect(evidence.alerts[0]).toContain('Completion audit logging failed');
});

test('uncertain restore displays recovery IDs and does not offer another submission', async ({ page }) => {
  await login(page);
  const evidence = await page.evaluate(async () => {
    const alerts = []; let calls = 0;
    window.alert = message => alerts.push(message);
    state.currentWorkspace = 'W1'; openRestoreWizard('BACKUP1');
    apiCall = async action => {
      calls++;
      if (action === 'backups.restoreApply') throw { message: 'Owner reconciliation required', details: { recoveryStatus: 'RECONCILIATION_REQUIRED', previousSpreadsheetId: 'ORIGINAL1', candidateFileId: 'CANDIDATE1', safetyBackupId: 'SAFETY1' } };
      return {};
    };
    await submitRestoreBackup(); await submitRestoreBackup();
    return { alerts, calls };
  });
  expect(evidence.calls).toBe(4);
  expect(evidence.alerts[0]).toContain('RECONCILIATION_REQUIRED');
  expect(evidence.alerts[0]).toContain('Candidate Sheet: CANDIDATE1');
  await expect(page.locator('#restoreApplyButton')).toBeDisabled();
  await expect(page.locator('#restoreNewAttemptButton')).toBeHidden();
});

test('reopening after response loss reuses the saved intent and original operation expectation', async ({ page }) => {
  await login(page);
  const evidence = await page.evaluate(async () => {
    const prepared = [], alerts = []; let applied = false;
    window.alert = message => alerts.push(message); renderSaBackups = async () => {};
    state.currentWorkspace = 'W1';
    apiCall = async (action, payload) => {
      if (action === 'backups.restoreStatus') return { operationId: applied ? 'AFTER' : 'BEFORE' };
      if (action === 'backups.restorePrepare') { prepared.push(payload); return { operationId: 'AFTER' }; }
      if (action === 'backups.restoreApply') {
        if (!applied) { applied = true; throw { message: 'Network response lost' }; }
        return { safetyBackupId: 'SAFETY', receiptRecorded: true, replayed: true };
      }
      return {};
    };
    openRestoreWizard('BKP'); await submitRestoreBackup(); closeModal();
    openRestoreWizard('BKP'); await submitRestoreBackup();
    return { prepared, pendingKeys: Object.keys(sessionStorage).filter(key => key.startsWith('flink_restore_intent_')), alerts };
  });
  expect(evidence.prepared).toHaveLength(2);
  expect(evidence.prepared[0].intentId).toBe(evidence.prepared[1].intentId);
  expect(evidence.prepared[1].previousOperationId).toBe('BEFORE');
  expect(evidence.pendingKeys).toEqual([]);
  expect(evidence.alerts[1]).toContain('No restore was repeated');
});

test('a verified rollback offers an explicit new intent bound to the original workspace', async ({ page }) => {
  await login(page);
  await page.evaluate(async () => {
    window.__restorePreparations = []; let applied = 0;
    window.alert = () => {}; renderSaBackups = async () => {}; state.currentWorkspace = 'W1';
    apiCall = async (action, payload) => {
      if (action === 'backups.restoreStatus') return { operationId: applied ? 'ROLLED_BACK_OP' : '' };
      if (action === 'backups.restorePrepare') { window.__restorePreparations.push(payload); return { operationId: 'OP' }; }
      if (action === 'backups.restoreApply') {
        if (++applied === 1) throw { message: 'Original pointer verified', details: { recoveryStatus: 'ROLLED_BACK_VERIFIED' } };
        return { receiptRecorded: true };
      }
      return {};
    };
    openRestoreWizard('BKP'); await submitRestoreBackup(); state.currentWorkspace = 'W2';
  });
  await expect(page.locator('#restoreNewAttemptButton')).toBeVisible();
  await page.locator('#restoreNewAttemptButton').click();
  await page.locator('#restoreApplyButton').click();
  await expect.poll(() => page.evaluate(() => window.__restorePreparations.length)).toBe(2);
  const preparations = await page.evaluate(() => window.__restorePreparations);
  expect(preparations[1].workspaceId).toBe('W1');
  expect(preparations[1].previousOperationId).toBe('ROLLED_BACK_OP');
  expect(preparations[1].intentId).not.toBe(preparations[0].intentId);
});
