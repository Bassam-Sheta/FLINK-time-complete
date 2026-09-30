/**
 * FLINK Time — Automated Installer
 *
 * Separate installer application. This is NOT part of the five-file FLINK Time
 * runtime. Deploy this installer as a Web App that executes as USER_ACCESSING.
 *
 * Google intentionally requires each installing user to enable Apps Script API
 * access in their Apps Script dashboard before an application may create or
 * deploy script projects on their behalf.
 */

var INSTALLER_RELEASE = Object.freeze({
  repository: 'Bassam-Sheta/FLINK-time-complete',
  commit: '53351e04eda5d5d7fffafe110548c83d09984865',
  files: [
    { path: 'apps-script/Code.gs', name: 'Code', type: 'SERVER_JS' },
    { path: 'apps-script/User.html', name: 'User', type: 'HTML' },
    { path: 'apps-script/Admin.html', name: 'Admin', type: 'HTML' },
    { path: 'apps-script/SuperAdmin.html', name: 'SuperAdmin', type: 'HTML' },
    { path: 'apps-script/appsscript.json', name: 'appsscript', type: 'JSON' }
  ]
});

var INSTALLER_LINKS = Object.freeze({
  apiSettings: 'https://script.google.com/home/usersettings'
});

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Install FLINK Time')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function getInstallerInfo() {
  const checkpoint = readInstallCheckpoint_();
  return {
    releaseCommit: INSTALLER_RELEASE.commit,
    apiSettingsUrl: INSTALLER_LINKS.apiSettings,
    installerEmail: getInstallerEmail_(),
    recoveryStage: checkpoint ? checkpoint.stage : ''
  };
}

function installFlinkTime() {
  const lock = LockService.getUserLock();
  lock.waitLock(10000);

  let spreadsheetId = '';
  let cleanupSucceeded = null;
  let checkpoint = null;

  try {
    const ownerEmail = getInstallerEmail_();
    checkpoint = readInstallCheckpoint_();
    if (checkpoint && (checkpoint.ownerEmail !== ownerEmail || checkpoint.releaseCommit !== INSTALLER_RELEASE.commit)) {
      throw installerError_('RECOVERY_REVIEW_REQUIRED', 'An earlier installation belongs to another identity or release. Review its private checkpoint before starting another installation.');
    }
    if (checkpoint && checkpoint.stage === 'COMPLETE') return checkpoint.result;
    if (checkpoint && !['SHEET_CREATED', 'PROJECT_CREATED', 'CONTENT_PENDING', 'CONTENT_SAVED', 'VERSION_CREATED'].includes(checkpoint.stage)) {
      throw installerError_('OUTCOME_UNKNOWN', 'A previous Google operation has an unknown outcome. Inspect the Master Sheet and Apps Script project before retrying; another installation has not been created.');
    }
    if (!checkpoint) {
      checkpoint = { ownerEmail, releaseCommit: INSTALLER_RELEASE.commit, stage: 'SHEET_PENDING' };
      saveInstallCheckpoint_(checkpoint);
    }

    const spreadsheet = checkpoint.spreadsheetId ? SpreadsheetApp.openById(checkpoint.spreadsheetId) : SpreadsheetApp.create('FLINK Time Master');
    spreadsheetId = spreadsheet.getId();
    if (!checkpoint.spreadsheetId) { checkpoint.spreadsheetId = spreadsheetId; checkpoint.stage = 'SHEET_CREATED'; saveInstallCheckpoint_(checkpoint); }

    let project = { scriptId: checkpoint.scriptId };
    if (!checkpoint.scriptId) {
      checkpoint.stage = 'PROJECT_PENDING'; saveInstallCheckpoint_(checkpoint);
      project = callAppsScriptApi_(
      'post',
      '/v1/projects',
      {
        title: 'FLINK Time',
        parentId: spreadsheetId
      }
    );
    }

    const scriptId = String(project && project.scriptId || '');
    if (!scriptId) {
      throw installerError_(
        'PROJECT_CREATE_FAILED',
        'Google created the Master Sheet but did not return a bound Apps Script project.'
      );
    }
    if (!checkpoint.scriptId) { checkpoint.scriptId = scriptId; checkpoint.stage = 'PROJECT_CREATED'; saveInstallCheckpoint_(checkpoint); }

    if (['PROJECT_CREATED', 'CONTENT_PENDING'].includes(checkpoint.stage)) {
      const files = loadReleaseFiles_(spreadsheetId, ownerEmail);
      checkpoint.stage = 'CONTENT_PENDING'; saveInstallCheckpoint_(checkpoint);

    callAppsScriptApi_(
      'put',
      '/v1/projects/' + encodeURIComponent(scriptId) + '/content',
      { files: files }
    );
      checkpoint.stage = 'CONTENT_SAVED'; saveInstallCheckpoint_(checkpoint);
    }

    let version = { versionNumber: checkpoint.versionNumber };
    if (!checkpoint.versionNumber) {
      checkpoint.stage = 'VERSION_PENDING'; saveInstallCheckpoint_(checkpoint);
      version = callAppsScriptApi_(
      'post',
      '/v1/projects/' + encodeURIComponent(scriptId) + '/versions',
      { description: 'FLINK Time automated installation ' + INSTALLER_RELEASE.commit.slice(0, 12) }
    );
    }

    const versionNumber = Number(version && version.versionNumber);
    if (!Number.isInteger(versionNumber) || versionNumber < 1) {
      throw installerError_(
        'VERSION_CREATE_FAILED',
        'Google did not return a valid FLINK Time version number.'
      );
    }
    checkpoint.versionNumber = versionNumber; checkpoint.stage = 'VERSION_CREATED'; saveInstallCheckpoint_(checkpoint);

    checkpoint.stage = 'DEPLOYMENT_PENDING'; saveInstallCheckpoint_(checkpoint);
    const deployment = callAppsScriptApi_(
      'post',
      '/v1/projects/' + encodeURIComponent(scriptId) + '/deployments',
      {
        versionNumber: versionNumber,
        manifestFileName: 'appsscript',
        description: 'FLINK Time production Web App'
      }
    );

    const webAppUrl = extractWebAppUrl_(deployment);
    if (!webAppUrl) {
      throw installerError_(
        'DEPLOYMENT_URL_MISSING',
        'Google created the deployment but did not return a Web App URL.'
      );
    }

    const result = {
      ok: true,
      releaseCommit: INSTALLER_RELEASE.commit,
      spreadsheetId: spreadsheetId,
      spreadsheetUrl: spreadsheet.getUrl(),
      scriptId: scriptId,
      deploymentId: String(deployment && deployment.deploymentId || ''),
      versionNumber: versionNumber,
      webAppUrl: webAppUrl,
      employeeUrl: webAppUrl + '?view=user',
      adminUrl: webAppUrl + '?view=admin',
      superAdminUrl: webAppUrl + '?view=superadmin'
    };
    checkpoint.stage = 'COMPLETE'; checkpoint.result = result; saveInstallCheckpoint_(checkpoint);
    return result;
  } catch (err) {
    // Google may have committed even when its response or checkpoint write fails.
    // Preserve resources and the durable stage; never trash a possibly live system.
    if (!spreadsheetId && checkpoint) spreadsheetId = checkpoint.spreadsheetId || '';

    console.error(
      'FLINK installer failure: ' +
      (err && err.stack ? err.stack : String(err))
    );

    const code = err && err.installCode
      ? err.installCode
      : 'INSTALL_FAILED';
    const message = err && err.safeMessage
      ? err.safeMessage
      : 'FLINK Time could not be installed. Check the cleanup status before retrying.';

    return {
      ok: false,
      code: code,
      message: message,
      cleanupSucceeded: cleanupSucceeded,
      recoveryStage: checkpoint ? checkpoint.stage : '',
      scriptUrl: checkpoint && checkpoint.scriptId ? 'https://script.google.com/home/projects/' + encodeURIComponent(checkpoint.scriptId) + '/edit' : '',
      incompleteSpreadsheetUrl: spreadsheetId
        ? 'https://docs.google.com/spreadsheets/d/' + encodeURIComponent(spreadsheetId) + '/edit' : '',
      apiSettingsUrl: INSTALLER_LINKS.apiSettings
    };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

function readInstallCheckpoint_() {
  const raw = PropertiesService.getUserProperties().getProperty('FLINK_INSTALL_CHECKPOINT');
  if (!raw) return null;
  try { const record = JSON.parse(raw); if (!record || typeof record.stage !== 'string') throw new Error(); return record; }
  catch (error) { throw installerError_('RECOVERY_REVIEW_REQUIRED', 'The private installation checkpoint is invalid. Review it before creating another installation.'); }
}

function saveInstallCheckpoint_(record) {
  PropertiesService.getUserProperties().setProperty('FLINK_INSTALL_CHECKPOINT', JSON.stringify(record));
}

function getInstallerEmail_() {
  let email = '';
  try {
    const user = Session.getActiveUser();
    email = String(user && user.getEmail ? user.getEmail() : '')
      .trim()
      .toLowerCase();
  } catch (err) {}

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw installerError_(
      'GOOGLE_IDENTITY_REQUIRED',
      'Sign in with the Google Workspace account that should own FLINK Time.'
    );
  }
  return email;
}

function loadReleaseFiles_(spreadsheetId, ownerEmail) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(spreadsheetId || ''))) {
    throw installerError_('INVALID_SHEET_ID', 'The new Master Sheet ID was invalid.');
  }

  const safeOwnerEmail = escapeSingleQuotedJs_(ownerEmail);

  return INSTALLER_RELEASE.files.map(function(file) {
    let source = fetchPinnedSource_(file.path);

    if (file.name === 'Code') {
      const masterSentinel = '__FLINK_INSTALLER_MASTER_SPREADSHEET_ID__';
      const ownerSentinel = '__FLINK_INSTALLER_OWNER_EMAIL__';

      if (
        source.indexOf(masterSentinel) < 0 ||
        source.indexOf(ownerSentinel) < 0
      ) {
        throw installerError_(
          'RELEASE_BOOTSTRAP_MISMATCH',
          'The selected FLINK Time release is not compatible with this installer.'
        );
      }

      source = source
        .split(masterSentinel).join(String(spreadsheetId))
        .split(ownerSentinel).join(safeOwnerEmail);

      if (
        source.indexOf(masterSentinel) >= 0 ||
        source.indexOf(ownerSentinel) >= 0
      ) {
        throw installerError_(
          'RELEASE_BOOTSTRAP_MISMATCH',
          'The FLINK Time release bootstrap could not be finalized.'
        );
      }
    }

    return {
      name: file.name,
      type: file.type,
      source: source
    };
  });
}

function fetchPinnedSource_(path) {
  const commit = String(INSTALLER_RELEASE.commit || '');
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw installerError_(
      'INVALID_RELEASE_PIN',
      'The installer release pin is invalid.'
    );
  }

  const safePath = String(path || '');
  const allowed = INSTALLER_RELEASE.files.some(function(file) {
    return file.path === safePath;
  });
  if (!allowed) {
    throw installerError_('SOURCE_NOT_ALLOWED', 'Installer source path is not allowed.');
  }

  const url =
    'https://raw.githubusercontent.com/' +
    INSTALLER_RELEASE.repository + '/' +
    commit + '/' + safePath;

  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    muteHttpExceptions: true,
    followRedirects: true,
    validateHttpsCertificates: true
  });

  const status = response.getResponseCode();
  if (status !== 200) {
    throw installerError_(
      'SOURCE_FETCH_FAILED',
      'The pinned FLINK Time release could not be downloaded.'
    );
  }

  const source = response.getContentText('UTF-8');
  if (!source || source.length < 2) {
    throw installerError_(
      'SOURCE_FETCH_FAILED',
      'The pinned FLINK Time release returned an empty file.'
    );
  }
  return source;
}

function callAppsScriptApi_(method, path, body) {
  const response = UrlFetchApp.fetch(
    'https://script.googleapis.com' + path,
    {
      method: String(method || 'get').toLowerCase(),
      contentType: 'application/json',
      payload: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        Authorization: 'Bearer ' + ScriptApp.getOAuthToken()
      },
      muteHttpExceptions: true,
      followRedirects: true,
      validateHttpsCertificates: true
    }
  );

  const status = response.getResponseCode();
  const raw = response.getContentText('UTF-8');
  let parsed = {};
  try { parsed = raw ? JSON.parse(raw) : {}; } catch (e) {}

  if (status >= 200 && status < 300) return parsed;

  const apiMessage = String(
    parsed && parsed.error && parsed.error.message || ''
  );

  if (status === 403 && /apps script api.*(disabled|not enabled)|script management.*disabled|access.*not enabled/i.test(apiMessage)) {
    throw installerError_(
      'SCRIPT_API_ACCESS_REQUIRED',
      'Google Apps Script API access is not enabled for this account. Open the Apps Script API settings, enable access, then run Install again.'
    );
  }

  if (status === 401) throw installerError_('GOOGLE_AUTH_REQUIRED', 'Google authorization expired or is missing. Sign in and authorize the installer again.');
  if (status === 403) throw installerError_('GOOGLE_PERMISSION_DENIED', 'Google denied this operation. Check Workspace administrator policies, installer OAuth scopes, and Apps Script API access.');

  console.error(
    'Apps Script API request failed (' + status + '): ' + apiMessage
  );
  throw installerError_(
    'GOOGLE_API_FAILED',
    'Google could not complete the Apps Script installation request.'
  );
}

function extractWebAppUrl_(deployment) {
  const points = deployment && Array.isArray(deployment.entryPoints)
    ? deployment.entryPoints
    : [];

  for (let i = 0; i < points.length; i++) {
    const point = points[i] || {};
    if (
      point.entryPointType === 'WEB_APP' &&
      point.webApp &&
      point.webApp.url
    ) {
      return String(point.webApp.url);
    }
  }
  return '';
}

function escapeSingleQuotedJs_(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

function installerError_(code, safeMessage) {
  const err = new Error(safeMessage);
  err.installCode = code;
  err.safeMessage = safeMessage;
  return err;
}
