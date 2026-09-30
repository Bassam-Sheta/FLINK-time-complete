'use strict';
const { test, expect } = require('@playwright/test');
async function login(page, portal = 'user') {
  await page.addInitScript(() => sessionStorage.removeItem('flink_session_token'));
  await page.goto('/' + portal); await page.getByRole('button', { name: 'Continue with Google', exact: true }).click();
  await page.locator('#mfaCode').fill('123456'); await page.getByRole('button', { name: 'Verify & Sign In', exact: true }).click();
  await expect(page.locator('#appHeader')).toBeVisible();
}
test('quick navigation uses only the employee routes and restores keyboard access', async ({ page }) => {
  await login(page); await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog', { name: 'Where would you like to go?' }); await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Admin Console', exact: true })).toHaveCount(0);
  await page.locator('#commandSearch').fill('account'); await dialog.getByRole('button', { name: 'Account', exact: true }).click();
  await expect(page.locator('#pageTitle')).toHaveText('Your account'); await expect(dialog).not.toBeVisible(); await expect(page.locator('#mainContent')).toBeFocused();
});
test('MFA dialog traps focus, escapes and returns focus without leaving the page inert', async ({ page }) => {
  await login(page); await page.getByRole('button', { name: 'Account', exact: true }).click();
  const trigger = page.getByRole('button', { name: 'Set up / Replace MFA', exact: true }); await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Set up or replace authenticator' }); await expect(dialog).toBeVisible();
  await page.keyboard.press('Shift+Tab'); await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
  await page.keyboard.press('Tab'); await expect(page.locator('#mfaPreviousCode')).toBeFocused();
  await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible(); await expect(trigger).toBeFocused();
  expect(await page.locator('#mainContent').evaluate(node => node.inert)).toBe(false);
});
test('identical concurrent reads share one transport call and isolate returned objects', async ({ page }) => {
  await login(page);
  const result = await page.evaluate(async () => {
    const before = window.__mockState.calls.filter(call => call.action === 'projects.list').length;
    const [a, b] = await Promise.all([apiCall('projects.list'), apiCall('projects.list')]);
    a[0].ProjectName = 'Mutated';
    const count = window.__mockState.calls.filter(call => call.action === 'projects.list').length - before;
    await apiCall('projects.list'); return { count, isolated: b[0].ProjectName !== 'Mutated', fresh: window.__mockState.calls.filter(call => call.action === 'projects.list').length - before };
  });
  expect(result).toEqual({ count: 1, isolated: true, fresh: 2 });
});
test('privacy request records the user intent and owner view exposes missing evidence', async ({ page }) => {
  await login(page); await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByText('Request access, correction or another privacy right', { exact: true }).click();
  await page.getByLabel('What would you like us to review?').fill('Please provide my records.');
  await page.getByRole('button', { name: 'Submit privacy request', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ACCESS · PENDING' })).toBeVisible();
  await login(page, 'superadmin'); await page.getByRole('button', { name: 'Privacy & Assurance', exact: true }).click();
  await expect(page.getByText('Access and MFA review · MISSING EVIDENCE', { exact: true })).toBeVisible();
});
test('mobile navigation remains usable and no external fonts are requested', async ({ page }) => {
  const external = []; page.on('request', request => { if (/fonts\.(googleapis|gstatic)\.com/.test(request.url())) external.push(request.url()); });
  await page.setViewportSize({ width: 390, height: 844 }); await login(page);
  await expect(page.locator('#timerToggleBtn')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(external).toEqual([]);
});
test('late tasks and catalog responses cannot replace the newly selected workspace', async ({ page }) => {
  await login(page);
  const values = await page.evaluate(async () => {
    const original = rawApiCall; const pending = [];
    rawApiCall = (action, payload, workspace) => ['tasks.list','projects.list','tags.list'].includes(action) ? new Promise(resolve => pending.push({ action, resolve, workspace })) : original(action, payload, workspace);
    try {
      const project = document.getElementById('timerProjectSelect'); project.replaceChildren(new Option('First', 'P1'), new Option('Second', 'P2'));
      project.value = 'P1'; const first = onTimerProjectChange(); project.value = 'P2'; const second = onTimerProjectChange();
      pending[1].resolve([{ TaskID: 'SECOND', TaskName: 'Current task' }]); await second;
      pending[0].resolve([{ TaskID: 'FIRST', TaskName: 'Stale task' }]); await first;
      const taskIds = [...document.getElementById('timerTaskSelect').options].map(option => option.value);
      const catalog = loadWorkspaceData(); state.currentWorkspace = 'W2';
      pending.find(request => request.action === 'projects.list').resolve([{ ProjectID: 'STALE', ProjectName: 'Wrong workspace' }]);
      pending.find(request => request.action === 'tags.list').resolve([]); await catalog;
      return { taskIds, projectIds: [...project.options].map(option => option.value) };
    } finally { rawApiCall = original; }
  });
  expect(values.taskIds).toEqual(['', 'SECOND']); expect(values.projectIds).toEqual(['P1', 'P2']);
});
test('a read from a replaced session is rejected instead of entering the current UI', async ({ page }) => {
  await login(page);
  const message = await page.evaluate(async () => {
    const original = rawApiCall; let resolve;
    rawApiCall = () => new Promise(done => { resolve = done; });
    try { const pending = apiCall('projects.list'); state.token = 'ROTATED'; resolve([]); await pending; return 'unexpected success'; }
    catch (error) { return error.message; } finally { rawApiCall = original; }
  });
  expect(message).toContain('session changed');
});
test('cancelling mandatory enrollment signs out instead of leaving an empty page', async ({ page }) => {
  await login(page); await page.evaluate(() => showRequiredEnrollment());
  await expect(page.getByRole('dialog', { name: 'Set up or replace authenticator' })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.locator('#loginView')).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('flink_session_token'))).toBe(null);
});
test('closed help is absent from keyboard navigation and Escape returns to its trigger', async ({ page }) => {
  await login(page); const guidance = page.getByRole('complementary', { name: 'Contextual guidance' });
  await expect(guidance).not.toBeVisible(); await page.locator('#helpTrigger').click();
  await expect(guidance).toBeVisible(); await expect(page.getByRole('button', { name: 'Close guidance' })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(guidance).not.toBeVisible(); await expect(page.locator('#helpTrigger')).toBeFocused();
});
