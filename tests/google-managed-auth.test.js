'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const a = require('../apps-script/Code.gs');

function fixture(mfa = false) {
  a.CONSTANTS.AUTH_MODE = 'GOOGLE';
  const account = {UserID:'USR1',Username:'employee',Role:'USER',Status:'ACTIVE',Email:'employee@example.test',MustChangePassword:true};
  const cred = {PasswordHash:'legacy-hash',MfaEnabled:mfa,TotpSecret:mfa?'JBSWY3DPEHPK3PXP':'',LastSuccessfulTotpStep:''};
  let currentEmail = account.Email;
  let issued = 0;
  let revoked = 0;
  global.Session = {getActiveUser:()=>({getEmail:()=>currentEmail})};
  global.LockService = {getScriptLock:()=>({waitLock(){},releaseLock(){},hasLock:()=>false})};
  delete global.PropertiesService;
  a.MasterRepository.getTableData = () => ({rows:[account]});
  a.MasterRepository.getCredentials = () => cred;
  a.MasterRepository.findAccountById = () => account;
  a.MasterRepository.updateCredentials = (_id, values) => Object.assign(cred,values);
  a.MasterRepository.updateAccount = (_id, values) => Object.assign(account,values);
  a.MasterRepository.getWorkspaceAccessForUser = () => [];
  a.MasterRepository.logSecurityEvent = () => true;
  a.MasterRepository.logGlobalAudit = () => true;
  a.MasterRepository.beginRequest = () => {};
  a.SessionService.createSession = () => ({sessionId:'S'+(++issued),sessionToken:'TOKEN'+issued,expiresAt:new Date(Date.now()+3600000).toISOString()});
  a.SessionService.revokeAllUserSessions = () => {revoked++;};
  a.AuthService._mfaSessionMemory = {};
  a.AuthService._reauthMemory = {};
  a.AuthService._mfaChallengeMemory = {};
  a.AuthService._mfaEnrollmentMemory = {};
  a.SecurityService.verifyPassword = () => {throw Error('App passwords must never be verified in Google mode');};
  const ctx = {userId:account.UserID,user:account,role:account.Role,session:{SessionID:'S1',ClientType:'WEB',ClientLabel:account.Email}};
  return {account,cred,ctx,changeIdentity(email){currentEmail=email;},getIssued:()=>issued,getRevoked:()=>revoked};
}

test('Google primary identity retires app passwords and returns only an enrollment session', () => {
  const f = fixture();
  const result = a.AuthService.login('forged-root','ignored-password');
  assert.equal(result.user.userId,f.account.UserID);
  assert.equal(result.mfaEnrollmentRequired,true);
  assert.equal(f.cred.PasswordHash,'');
  assert.equal(f.account.MustChangePassword,false);
  assert.equal(a.AuthService.hasVerifiedMfaSession(f.ctx),false);
  assert.throws(()=>a.AuthService.changePassword('token','old','new'),/Google password/);
});

test('enrollment sessions cannot call ordinary APIs, including setup mutations', () => {
  const f = fixture();
  a.SessionService.validateSession = () => f.ctx;
  for (const action of ['dashboard.overview','workspaces.list','entries.list','setup.completeStep']) {
    assert.throws(()=>a.dispatchAction(action,{sessionToken:'token',workspaceId:'W1',step:2}),/authenticator verification/);
  }
  assert.equal(a.dispatchAction('auth.validateSession',{sessionToken:'token'}).mfaEnrollmentRequired,true);
});

test('confirmed enrollment rotates all sessions and grants only the replacement MFA session', () => {
  const f = fixture();
  const enrollment = a.AuthService.enrollMfa(f.ctx);
  assert(enrollment.secret);
  const code = a.SecurityService.generateTotpCode(enrollment.secret);
  const result = a.AuthService.confirmMfa(f.ctx,code);
  assert.equal(f.getRevoked(),1);
  assert.equal(result.sessionToken,'TOKEN1');
  assert.equal(a.AuthService.hasVerifiedMfaSession({...f.ctx,session:{SessionID:'S1'}}),true);
  assert.equal(a.AuthService.hasVerifiedMfaSession({...f.ctx,session:{SessionID:'OLD'}}),false);
});

test('Google login with enrolled MFA issues no session until one-time TOTP succeeds', () => {
  const f = fixture(true);
  const result = a.AuthService.login();
  assert.equal(result.mfaRequired,true);
  assert.equal(f.getIssued(),0);
  const code = a.SecurityService.generateTotpCode(f.cred.TotpSecret);
  const verified = a.AuthService.verifyMfa(result.mfaChallengeToken,code);
  assert.equal(verified.sessionToken,'TOKEN1');
  assert.equal(a.AuthService.hasVerifiedMfaSession(f.ctx),true);
  assert.throws(()=>a.AuthService.verifyMfa(result.mfaChallengeToken,code),/already used|invalid/);
});

test('unknown, duplicate, inactive and changed Google identities fail closed', () => {
  let f = fixture(); f.changeIdentity('attacker@example.test');
  assert.throws(()=>a.AuthService.login(),/unique active/);
  f = fixture(); a.MasterRepository.getTableData = () => ({rows:[f.account,{...f.account,UserID:'OTHER'}]});
  assert.throws(()=>a.AuthService.login(),/unique active/);
  f = fixture(); f.account.Status = 'PASSIVE';
  assert.throws(()=>a.AuthService.login(),/inactive/);
  f = fixture(); f.changeIdentity('attacker@example.test');
  assert.throws(()=>a.AuthService.enrollMfa(f.ctx),/does not match/);
});

test('Google account timed MFA locks recover after expiry, administrative locks remain', () => {
  let f = fixture(true); f.account.Status = 'LOCKED'; f.cred.LockUntil = new Date(Date.now()-1000).toISOString();
  assert.equal(a.AuthService.login().mfaRequired,true);
  assert.equal(f.account.Status,'ACTIVE');
  f = fixture(true); f.account.Status = 'LOCKED'; f.cred.LockUntil = '';
  assert.throws(()=>a.AuthService.login(),/locked/);
});
