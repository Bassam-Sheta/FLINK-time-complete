'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const a = require('../apps-script/Code.gs');

test('employee weekly timesheet redacts immutable financial snapshot without mutating storage', () => {
  const header = {TimesheetID:'TS1', UserID:'U1', Status:'SUBMITTED', EntrySnapshotJSON:'[{"costRateSnapshot":40}]', _rowIndex:3};
  a.AuthorizationService.assertWorkspaceAccess = () => true;
  a.TimesheetService._resolveWeek = () => ({startDate:new Date('2026-09-27'),endDate:new Date('2026-10-03'),dayLabels:[],timezone:'UTC'});
  a.TimesheetService._findCanonicalTimesheet = () => header;
  for (const method of ['listTimeEntries','listProjects','listTasks']) a.SheetRepository[method] = () => [];
  a.SheetRepository.listTimesheets = () => [header];
  const result = a.TimesheetService.getWeeklyTimesheet({role:'USER',userId:'U1'},'W1','U2','2026-09-28');
  assert.equal(result.userId, 'U1');
  assert.equal(result.timesheet.EntrySnapshotJSON, undefined);
  assert.equal(result.timesheet._rowIndex, undefined);
  assert(header.EntrySnapshotJSON.includes('costRateSnapshot'));
});

test('configured one-hour idle limit rejects a two-hour idle session', () => {
  a.MasterRepository.getGlobalSettingStrict = () => '1';
  assert.equal(a.SessionService._idleTimeoutMs(), 3600000);
  const now = Date.now();
  a.MasterRepository.findSessionByTokenHashFast = () => ({SessionID:'S1',UserID:'U1',CreatedAt:new Date(now-10800000).toISOString(),LastSeenAt:new Date(now-7200000).toISOString(),ExpiresAt:new Date(now+3600000).toISOString(),AbsoluteExpiresAt:new Date(now+7200000).toISOString()});
  a.MasterRepository.updateSession = () => {};
  assert.throws(() => a.SessionService.validateSession('synthetic'), /timeout/);
  a.MasterRepository.getGlobalSettingStrict = () => 'bogus';
  assert.throws(() => a.SessionService._idleTimeoutMs(), /configuration/);
});

test('forty bad privileged attempts perform only ten password checks', () => {
  a.CONSTANTS.AUTH_MODE = 'PASSWORD';
  let checks = 0;
  a.AuthService._reauthMemory = {};
  a.MasterRepository.getCredentials = () => ({PasswordHash:'synthetic'});
  a.SecurityService.verifyPassword = () => { checks++; return false; };
  a.MasterRepository.logSecurityEvent = () => {};
  const ctx = {role:'SUPER_ADMIN',userId:'ROOT',session:{SessionID:'S'}};
  for (let i=0; i<40; i++) assert.throws(() => a.AuthService.stepUp(ctx,'token','wrong','000000'));
  assert.equal(checks, 10);
});

test('request schemas reject plaintext credentials and privilege-bearing fields', () => {
  for (const field of ['temporaryPassword','password','workspaceIds','primaryWorkspaceId','__proto__']) {
    const data = JSON.parse('{"username":"newuser","' + field + '":"secret"}');
    assert.throws(() => a.AdminRequestService._safeRequestedData(data), /unsupported/);
  }
  const data = {username:'newuser',displayName:'New User',email:'new@example.test',role:'USER'};
  assert.deepEqual(a.AdminRequestService._safeRequestedData(data), data);
});

test('reserved project names produce summary rows without report exceptions', () => {
  a.AuthorizationService.assertWorkspaceAccess = () => true;
  a.SheetRepository.listTimeEntries = () => [{EntryID:'E1',UserID:'U1',ProjectID:'P1',DurationSeconds:3600,StartUTC:'2026-09-28T08:00:00Z'}];
  a.SheetRepository.listTasks = () => [];
  a.SheetRepository.listMembers = () => [];
  for (const name of ['__proto__','constructor','toString']) {
    a.SheetRepository.listProjects = () => [{ProjectID:'P1',ProjectName:name}];
    assert.doesNotThrow(() => a.ReportService.getSummaryReport({role:'USER',userId:'U1'},'W1',{groupings:['project']}));
  }
});
