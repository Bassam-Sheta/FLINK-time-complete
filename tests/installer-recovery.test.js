'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
function harness() {
  const calls = [], props = {};
  const context = { console: { error() {} }, PropertiesService: { getUserProperties: () => ({ getProperty: key => props[key] || null, setProperty(key, value) { props[key] = value; } }) },
    LockService: { getUserLock: () => ({ waitLock() {}, releaseLock() {} }) },
    SpreadsheetApp: { create() { calls.push('sheet'); return { getId: () => 'S1', getUrl: () => 'https://docs.google.com/spreadsheets/d/S1' }; }, openById: () => ({ getId: () => 'S1', getUrl: () => 'https://docs.google.com/spreadsheets/d/S1' }) }
  };
  vm.createContext(context); vm.runInContext(fs.readFileSync('installer/Code.gs', 'utf8'), context);
  context.getInstallerEmail_ = () => 'owner@example.test'; context.loadReleaseFiles_ = () => [];
  let failure = '';
  context.callAppsScriptApi_ = (method, path) => {
    calls.push(method + path); if (path.endsWith(failure) && failure) throw new Error('Response lost after Google may commit');
    if (path === '/v1/projects') return { scriptId: 'P1' };
    if (path.endsWith('/versions')) return { versionNumber: 1 };
    if (path.endsWith('/deployments')) return { deploymentId: 'D1', entryPoints: [{ entryPointType: 'WEB_APP', webApp: { url: 'https://script.google.com/macros/s/D1/exec' } }] };
    return {};
  };
  return { context, calls, props, fail: value => { failure = value; } };
}
test('completed installation retry returns the durable receipt without a second system', () => {
  const { context, calls } = harness(); assert.equal(context.installFlinkTime().ok, true);
  const firstCount = calls.length; assert.equal(context.installFlinkTime().webAppUrl, 'https://script.google.com/macros/s/D1/exec'); assert.equal(calls.length, firstCount);
});
for (const stage of ['projects','versions','deployments']) test('lost ' + stage + ' response blocks duplicate creation and preserves recovery identifiers', () => {
  const { context, calls, props, fail } = harness(); fail(stage);
  const result = context.installFlinkTime(); assert.equal(result.ok, false); assert.equal(result.cleanupSucceeded, null);
  const firstCount = calls.length; fail(''); const retry = context.installFlinkTime();
  assert.equal(retry.code, 'OUTCOME_UNKNOWN'); assert.equal(calls.length, firstCount); assert.ok(JSON.parse(props.FLINK_INSTALL_CHECKPOINT).spreadsheetId);
});
test('content PUT failure resumes safely without another sheet, project or version', () => {
  const { context, calls, fail } = harness(); fail('content'); assert.equal(context.installFlinkTime().ok, false);
  fail(''); assert.equal(context.installFlinkTime().ok, true);
  assert.equal(calls.filter(call => call === 'sheet').length, 1); assert.equal(calls.filter(call => call === 'post/v1/projects').length, 1);
  assert.equal(calls.filter(call => call.endsWith('/versions')).length, 1);
});
test('a corrupt checkpoint does not create another system', () => {
  const { context, props, calls } = harness(); props.FLINK_INSTALL_CHECKPOINT = '{broken';
  assert.equal(context.installFlinkTime().code, 'RECOVERY_REVIEW_REQUIRED'); assert.equal(calls.length, 0);
});
