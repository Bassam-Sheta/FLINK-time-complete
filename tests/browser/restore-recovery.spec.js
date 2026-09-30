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
      return { safetyBackupId: 'SAFETY1', auditRecorded: false };
    };
    renderSaBackups = async () => {};
    const pending = submitRestoreBackup();
    await submitRestoreBackup();
    state.currentWorkspace = 'W2'; releaseValidation(); await pending;
    return { alerts, requests };
  });
  expect(evidence.requests).toEqual([{ action: 'backups.restoreValidate', workspaceId: 'W1' }, { action: 'backups.restoreApply', workspaceId: 'W1' }]);
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
  expect(evidence.calls).toBe(2);
  expect(evidence.alerts[0]).toContain('RECONCILIATION_REQUIRED');
  expect(evidence.alerts[0]).toContain('Candidate Sheet: CANDIDATE1');
  await expect(page.locator('#restoreApplyButton')).toBeDisabled();
});
