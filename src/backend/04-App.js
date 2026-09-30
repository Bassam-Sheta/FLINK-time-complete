/* ===== App.gs ===== */
/**
 * FLINK Time & Workforce Platform — Main Application Dispatcher & API Controller
 * Serves Google Apps Script Web App (doGet / doPost), embeds into Google Sites,
 * and routes API actions with LockService concurrency guards and unified error handling.
 */

function doGet(e) {
  const params = e ? e.parameter : {};
  const action = params ? params.action : '';
  const view = String(params && params.view ? params.view : 'user').trim().toLowerCase();

  // API-created installations can reach the Web App before the deployment
  // owner's Drive/Sheets scopes have been granted to this new script project.
  // Handle that specific first-run state inside the Web App instead of sending
  // the owner into the Apps Script editor. Manual/template installations are
  // unaffected because their installer bootstrap sentinels remain inert.
  if (!action) {
    const authorizationGate = maybeRenderInstallerAuthorizationGate_(view);
    if (authorizationGate) return authorizationGate;
  }

  // API GET requests are read-only; privileged/admin HTML is not served from this deployment.
  // If action query parameter is passed, treat as GET API request
  if (action) {
    return handleApiRequest_(action, params, 'GET');
  }

  // Otherwise serve the Google Workspace-Native Web Application UI
  try {
    const viewFiles = {
      user: 'User',
      admin: 'Admin',
      superadmin: 'SuperAdmin'
    };
    const fileName = viewFiles[view];
    if (!fileName) {
      throw new AppError(
        ERROR_CODES.NOT_FOUND,
        'Unknown portal view. Use ?view=user, ?view=admin, or ?view=superadmin.',
        404
      );
    }
    const template = HtmlService.createTemplateFromFile(fileName);
    const output = template.evaluate();
    const titles = {
      user: 'FLINK Time — Employee',
      admin: 'FLINK Time — Manager',
      superadmin: 'FLINK Time — Super Admin'
    };
    output.setTitle(titles[view]);
    output.setXFrameOptionsMode(
      view === 'user'
        ? HtmlService.XFrameOptionsMode.ALLOWALL
        : HtmlService.XFrameOptionsMode.DEFAULT
    );
    output.addMetaTag('viewport', 'width=device-width, initial-scale=1');
    return output;
  } catch (err) {
    const correlationId = Validation.generateId('ERR');
    console.error(
      correlationId + ' portal rendering error: ' +
      (err && err.stack ? err.stack : String(err))
    );
    return ContentService
      .createTextOutput('FLINK Platform Portal could not be loaded. Reference: ' + correlationId)
      .setMimeType(ContentService.MimeType.TEXT);
  }
}

function maybeRenderInstallerAuthorizationGate_(view) {
  try {
    if (
      typeof PropertiesService === 'undefined' ||
      !PropertiesService.getScriptProperties ||
      typeof ScriptApp === 'undefined' ||
      !ScriptApp.getAuthorizationInfo
    ) {
      return null;
    }

    const props = PropertiesService.getScriptProperties();
    if (props.getProperty('FLINK_INSTALL_OWNER_EMAIL')) return null;

    const installerOwner = IdentityService.normalizeEmail(
      installerBootstrapValue_(
        INSTALLER_BOOTSTRAP && INSTALLER_BOOTSTRAP.ownerEmail
      )
    );
    if (!installerOwner) return null;

    const activeEmail = IdentityService.getCurrentGoogleEmail(false);
    if (!activeEmail || activeEmail !== installerOwner) {
      return buildInstallerAuthorizationPage_({
        title: 'Installation owner required',
        message:
          'Sign in with the Google Workspace account that installed FLINK Time before continuing first-time setup.',
        authorizationUrl: '',
        continueUrl: '',
        actionLabel: ''
      });
    }

    const authInfo = ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL);
    const status = authInfo.getAuthorizationStatus();
    if (status !== ScriptApp.AuthorizationStatus.REQUIRED) return null;

    const authorizationUrl = String(authInfo.getAuthorizationUrl() || '');
    const serviceUrl = (
      ScriptApp.getService &&
      ScriptApp.getService() &&
      ScriptApp.getService().getUrl
    ) ? String(ScriptApp.getService().getUrl() || '') : '';
    const safeView = ['user', 'admin', 'superadmin'].includes(view)
      ? view
      : 'superadmin';
    const continueUrl = serviceUrl
      ? serviceUrl + '?view=' + encodeURIComponent(safeView)
      : '';

    return buildInstallerAuthorizationPage_({
      title: 'Authorize FLINK Time',
      message:
        'Google requires the installation owner to approve FLINK Time access to its Master Sheet and managed workspace files before first use.',
      authorizationUrl: authorizationUrl,
      continueUrl: continueUrl,
      actionLabel: 'AUTHORIZE FLINK TIME'
    });
  } catch (err) {
    const correlationId = Validation.generateId('ERR');
    console.error(
      correlationId + ' installer authorization gate error: ' +
      (err && err.stack ? err.stack : String(err))
    );
    return buildInstallerAuthorizationPage_({
      title: 'FLINK Time authorization could not be checked',
      message:
        'Reload this page while signed in with the installation owner account. If the problem continues, contact your FLINK Time administrator. Reference: ' +
        correlationId,
      authorizationUrl: '',
      continueUrl: '',
      actionLabel: ''
    });
  }
}

function buildInstallerAuthorizationPage_(options) {
  const opts = options || {};
  const title = escapeInstallerHtml_(opts.title || 'FLINK Time');
  const message = escapeInstallerHtml_(opts.message || '');
  const authorizationUrl = escapeInstallerHtml_(opts.authorizationUrl || '');
  const continueUrl = escapeInstallerHtml_(opts.continueUrl || '');
  const actionLabel = escapeInstallerHtml_(
    opts.actionLabel || 'AUTHORIZE FLINK TIME'
  );

  let actions = '';
  if (authorizationUrl) {
    actions +=
      '<a class="primary" target="_blank" rel="noopener" href="' +
      authorizationUrl + '">' + actionLabel + '</a>';
  }
  if (continueUrl) {
    actions +=
      '<a class="secondary" href="' + continueUrl + '">I HAVE AUTHORIZED — CONTINUE</a>';
  }

  const html =
    '<!doctype html><html><head><base target="_top">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>' +
    'body{margin:0;background:#0b111c;color:#f8fafc;font:15px/1.5 Arial,sans-serif}' +
    'main{max-width:680px;margin:0 auto;padding:72px 24px}' +
    '.card{background:#121b2b;border:1px solid #2a3850;border-radius:14px;padding:28px}' +
    'h1{margin:0 0 10px;font-size:26px}p{color:#a6b2c5;margin:0 0 22px}' +
    '.actions{display:flex;gap:10px;flex-wrap:wrap}' +
    'a{padding:12px 16px;border-radius:8px;text-decoration:none;font-weight:800}' +
    '.primary{background:#3b82f6;color:#fff}.secondary{background:#1c283a;color:#fff;border:1px solid #2a3850}' +
    '.note{font-size:12px;color:#8290a5;margin-top:18px}' +
    '</style></head><body><main><div class="card">' +
    '<h1>' + title + '</h1><p>' + message + '</p>' +
    '<div class="actions">' + actions + '</div>' +
    '<div class="note">This authorization is generated by Google. FLINK Time never receives your Google password.</div>' +
    '</div></main></body></html>';

  return HtmlService
    .createHtmlOutput(html)
    .setTitle(opts.title || 'FLINK Time')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function doPost(e) {
  let action = '';
  let payload = {};

  try {
    if (e && e.postData && e.postData.contents) {
      const parsed = JSON.parse(e.postData.contents);
      action = parsed.action || '';
      payload = parsed;
    } else if (e && e.parameter) {
      action = e.parameter.action || '';
      payload = e.parameter;
    }
  } catch (err) {
    return buildJsonResponse_({
      ok: false,
      error: { code: ERROR_CODES.VALIDATION_ERROR, message: 'Malformed JSON payload: ' + err.message }
    });
  }

  return handleApiRequest_(action, payload, 'POST');
}

/**
 * Centralized Action Permissions Matrix (Default-Deny)
 * Every API endpoint MUST be explicitly declared with its authentication,
 * role authorizations, workspace binding, and mutation requirements.
 */
const ACTION_PERMISSIONS = {
  'privacy.notice': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], isWrite: false },
  'privacy.requests.list': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], isWrite: false },
  'privacy.requests.submit': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], isWrite: true },
  'privacy.initialize': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'privacy.notice.save': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'privacy.requests.review': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'assurance.list': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: false },
  'assurance.save': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  // Public / Unauthenticated
  'auth.login': { authRequired: false, isWrite: true },
  'auth.verifyMfa': { authRequired: false, isWrite: true },
  'setup.status': { authRequired: false, isWrite: false },

  // User Authentication, MFA & Profile
  'auth.validateSession': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], isWrite: false },
  'auth.stepUp': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'auth.logout': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], isWrite: true },
  'auth.changePassword': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], isWrite: true },
  'auth.enrollMfa': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], isWrite: true },
  'auth.confirmMfa': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], isWrite: true },
  'auth.disableMfa': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },

  // Setup Wizard
  'setup.completeStep': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true, allowUnauthStep1: true },
  'setup.finalize': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },

  // Workspaces
  'workspaces.list': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], isWrite: false },
  'workspaces.create': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'workspaces.assignAdmin': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'workspaces.removeAdmin': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'workspaces.deletePermanent': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },

  // Users
  'users.list': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], isWrite: false },
  'users.create': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'users.update': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'users.makePassive': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'users.activate': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'users.resetPassword': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'users.unlock': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'users.forceLogout': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'users.assignWorkspace': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], isWrite: true },

  // Requests
  'requests.submit': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], isWrite: true },
  'requests.list': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], isWrite: false },
  'requests.review': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },

  // Timer & Time Entries
  'timer.start': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: true },
  'timer.stop': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: true },
  'timer.getActive': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: false },
  'entries.createManual': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: true },
  'entries.update': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: true },
  'entries.delete': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: true },
  'entries.list': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: false },
  'entries.bulkAction': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: true },

  // Timesheet & Approvals
  'timesheet.getWeekly': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: false },
  'timesheet.listForReview': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], requiresWorkspace: true, isWrite: false },
  'timesheet.submit': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: true },
  'timesheet.approve': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], requiresWorkspace: true, isWrite: true },
  'timesheet.reject': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], requiresWorkspace: true, isWrite: true },
  'timesheet.reopen': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], requiresWorkspace: true, isWrite: true },

  // Master Data
  'clients.list': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: false },
  'clients.create': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], requiresWorkspace: true, isWrite: true },
  'projects.list': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: false },
  'projects.create': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], requiresWorkspace: true, isWrite: true },
  'projects.update': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], requiresWorkspace: true, isWrite: true },
  'tasks.list': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: false },
  'tasks.create': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], requiresWorkspace: true, isWrite: true },
  'tags.list': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: false },
  'tags.create': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], requiresWorkspace: true, isWrite: true },

  // Reports & Dashboards
  'reports.summary': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: false },
  'reports.detailed': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: false },
  'reports.attendance': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], requiresWorkspace: true, isWrite: false },
  'reports.exceptions': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], requiresWorkspace: true, isWrite: false },
  'reports.exportCsv': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], requiresWorkspace: true, isWrite: true },
  'dashboard.radar': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: false, isWrite: false },
  'dashboard.overview': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: false, isWrite: false },

  // System Diagnostics & Repairs
  'system.health': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'system.repair': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'system.diagnostics': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: false },

  // Settings & Configuration
  'settings.get': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], isWrite: false },
  'settings.save': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },

  // Sessions & Security
  'sessions.listActive': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: false },
  'sessions.revoke': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },

  // Backups & Restores
  'backups.create': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'backups.list': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: false },
  'backups.restoreValidate': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: false },
  'backups.restoreApply': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'backups.restorePrepare': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'backups.restoreStatus': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: false },
  'rollups.rebuild': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], requiresWorkspace: true, isWrite: true },

  // Jobs & Capacity
  'jobs.dispatchHousekeeping': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'jobs.dispatchRollups': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'jobs.capacity': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], isWrite: false },

  // Integrity & Audit
  'integrity.audit': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'audit.verifyChain': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: false }
};

const PRIVILEGED_STEP_UP_ACTIONS = new Set([
  'privacy.initialize', 'privacy.notice.save', 'privacy.requests.review', 'assurance.save',
  'workspaces.create',
  'workspaces.assignAdmin',
  'workspaces.removeAdmin',
  'workspaces.deletePermanent',
  'users.create',
  'users.update',
  'users.makePassive',
  'users.activate',
  'users.resetPassword',
  'users.unlock',
  'users.forceLogout',
  'users.assignWorkspace',
  'requests.review',
  'timesheet.reopen',
  'system.health',
  'system.repair',
  'settings.save',
  'sessions.revoke',
  'backups.create',
  'backups.restoreApply',
  'backups.restorePrepare',
  'jobs.dispatchHousekeeping',
  'jobs.dispatchRollups',
  'integrity.audit'
]);

/**
 * Explicit unauthenticated boundary. Any new public action must be added here
 * and to ACTION_PERMISSIONS with authRequired:false, or CI will fail.
 */
const PUBLIC_ACTIONS = new Set([
  'auth.login',
  'auth.verifyMfa',
  'setup.status'
]);

/**
 * Explicit API GET allowlist.
 *
 * Authenticated actions intentionally remain POST-only even when logically
 * read-only, because this application carries session tokens in request data.
 * Allowing authenticated GET would encourage tokens in URLs, browser history,
 * proxy logs, and referrer surfaces.
 */
const GET_SAFE_ACTIONS = new Set([
  'setup.status'
]);

function isHttpMethodAllowed_(action, method) {
  if (!ACTION_PERMISSIONS[action]) return false;
  const normalized = String(method || '').toUpperCase();
  if (normalized === 'POST') return true;
  if (normalized === 'GET') return GET_SAFE_ACTIONS.has(action);
  return false;
}

/**
 * Universal API Request Handler
 */
function executeApiRequest_(action, requestData, httpMethod = 'POST') {
  // Explicit request boundary for repository caches. Apps Script V8 isolates may
  // be reused between executions, so never allow cached Sheet rows to survive
  // from one API request into another.
  if (typeof MasterRepository !== 'undefined' && MasterRepository.beginRequest) {
    MasterRepository.beginRequest();
  }
  if (typeof SheetRepository !== 'undefined' && SheetRepository.beginRequest) {
    SheetRepository.beginRequest();
  }
  if (typeof WorkspaceRouter !== 'undefined' && WorkspaceRouter.clearCache) {
    WorkspaceRouter.clearCache();
  }

  const perm = ACTION_PERMISSIONS[action];

  if (!perm) {
    return {
      ok: false,
      error: { code: ERROR_CODES.NOT_FOUND, message: `Unknown or forbidden API action: ${action}`, statusCode: 404 }
    };
  }

  if (!isHttpMethodAllowed_(action, httpMethod)) {
    return {
      ok: false,
      error: {
        code: ERROR_CODES.VALIDATION_ERROR,
        message: `HTTP method ${String(httpMethod || '').toUpperCase()} is not allowed for action ${action}.`,
        statusCode: 405
      }
    };
  }

  // Transactional locking is owned by the service performing the mutation.
  try {
    const result = dispatchAction_(action, requestData);
    return { ok: true, data: result };
  } catch (err) {
    if (err instanceof AppError && Number(err.statusCode || 400) < 500) {
      return err.toJSON();
    }
    const correlationId = Validation.generateId('ERR');
    console.error(
      correlationId + ' unexpected API error: ' +
      (err && err.stack ? err.stack : String(err))
    );
    return {
      ok: false,
      error: {
        code: ERROR_CODES.INTERNAL_ERROR,
        message: 'An unexpected internal error occurred. Reference: ' + correlationId,
        statusCode: 500,
        correlationId
      }
    };
  }
}

function handleApiRequest_(action, requestData, httpMethod = 'POST') {
  return buildJsonResponse_(executeApiRequest_(action, requestData, httpMethod));
}

/**
 * In-process bridge for HtmlService/google.script.run.
 * Returns a plain serializable object rather than ContentService.TextOutput.
 */
function handleClientRequest(action, requestData) {
  return executeApiRequest_(action, requestData, 'POST');
}

/**
 * Action Router with Centralized Default-Deny Authorization
 */
function dispatchAction_(action, data) {
  const perm = ACTION_PERMISSIONS[action];
  if (!perm) {
    throw new AppError(ERROR_CODES.NOT_FOUND, `Unknown API action: ${action}`, 404);
  }

  const token = data.sessionToken || data.token || '';
  const wsId = data.workspaceId || (data.payload && data.payload.workspaceId) || '';
  const payload = data.payload || data;

  // Unauthenticated actions
  if (PUBLIC_ACTIONS.has(action)) {
    if (action === 'auth.login') {
      return AuthService.login(payload.username, payload.password, payload.clientType);
    }
    if (action === 'auth.verifyMfa') {
      return AuthService.verifyMfa(payload.mfaChallengeToken, payload.code, payload.clientType);
    }
    if (action === 'setup.status') {
      return SetupService.getSetupStatus();
    }
    throw new AppError(ERROR_CODES.INTERNAL_ERROR, `Unhandled unauthenticated action: ${action}`);
  }

  // Allow unauthenticated bootstrap for Setup step 1 if system is fresh
  if (perm.allowUnauthStep1 === true && (payload.step === 1 || payload.step === '1') && !token) {
    return SetupService.processStep(1, payload, null);
  }

  // All other actions require authenticated session
  const authContext = SessionService.validateSession(token);
  const needsMfaEnrollment = CONSTANTS.AUTH_MODE === 'GOOGLE' && !AuthService.hasVerifiedMfaSession(authContext);
  if (needsMfaEnrollment && !['auth.validateSession', 'auth.enrollMfa', 'auth.confirmMfa', 'auth.logout'].includes(action)) {
    throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Complete authenticator verification before using FLINK.', 403);
  }

  // Forced password change is a server-side security state, not a UI hint.
  // Temporary/reset-password sessions may only validate, change password, or logout.
  const mustChangePassword = CONSTANTS.AUTH_MODE !== 'GOOGLE' && authContext.user &&
    (authContext.user.MustChangePassword === true || authContext.user.MustChangePassword === 'TRUE');
  if (mustChangePassword) {
    const allowedDuringForcedChange = new Set([
      'auth.validateSession',
      'auth.changePassword',
      'auth.logout'
    ]);
    if (!allowedDuringForcedChange.has(action)) {
      throw new AppError(
        ERROR_CODES.PASSWORD_CHANGE_REQUIRED,
        'Password change is required before using the application.',
        403
      );
    }
  }

  // Centralized RBAC Enforcement (Default-Deny)
  if (perm.roles && !perm.roles.includes(authContext.role)) {
    throw new AppError(
      ERROR_CODES.UNAUTHORIZED,
      `Permission denied: Required role not held for action ${action}. Current role: ${authContext.role}`,
      403
    );
  }

  // Centralized Workspace Access Enforcement
  if (perm.requiresWorkspace) {
    if (!wsId) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `workspaceId is required for action ${action}.`, 400);
    }
    AuthorizationService.assertWorkspaceAccess(authContext, wsId);
  }

  if (
    authContext.role === CONSTANTS.ROLES.SUPER_ADMIN &&
    PRIVILEGED_STEP_UP_ACTIONS.has(action)
  ) {
    AuthService.assertStepUp(authContext, payload.stepUpToken || '');
    AuditService.requirePrivilegedActionAudit(authContext, action, wsId || '');
  }

  switch (action) {
    case 'privacy.notice': return PrivacyService.getNotice();
    case 'privacy.requests.list': return PrivacyService.list(authContext, payload);
    case 'privacy.requests.submit': return PrivacyService.submit(authContext, payload);
    case 'privacy.initialize': return PrivacyService.initialize(authContext);
    case 'privacy.notice.save': return PrivacyService.saveNotice(authContext, payload);
    case 'privacy.requests.review': return PrivacyService.review(authContext, payload);
    case 'assurance.list': return PrivacyService.assurance(authContext);
    case 'assurance.save': return PrivacyService.saveEvidence(authContext, payload);
    case 'auth.validateSession':
      return { user: authContext.user, role: authContext.role, mfaEnrollmentRequired: needsMfaEnrollment };

    case 'auth.stepUp':
      return AuthService.stepUp(
        authContext,
        token,
        payload.currentPassword,
        payload.totpCode
      );

    case 'auth.logout':
      return AuthService.logout(token);

    case 'auth.changePassword':
      return AuthService.changePassword(token, payload.oldPassword, payload.newPassword);

    case 'auth.enrollMfa':
      return AuthService.enrollMfa(
        authContext,
        payload.currentPassword,
        payload.currentMfaCode
      );

    case 'auth.confirmMfa':
      return AuthService.confirmMfa(authContext, payload.code);

    case 'auth.disableMfa':
      return AuthService.disableMfa(
        authContext,
        payload.targetUserId,
        payload.adminPassword,
        payload.adminTotpCode
      );

    case 'users.assignWorkspace':
      return WorkspaceService.assignUserToWorkspace(authContext, payload.targetUserId, payload.workspaceId || wsId);

    case 'audit.verifyChain':
      return AuditService.verifyAuditChain(payload.workspaceId || wsId || null);

    /* ---------------- WORKSPACES ---------------- */
    case 'workspaces.list':
      return WorkspaceService.listWorkspaces(authContext);

    case 'workspaces.create':
      return WorkspaceService.createWorkspace(authContext, payload);

    case 'workspaces.assignAdmin':
      return WorkspaceService.assignAdminToWorkspace(authContext, payload.adminUserId, payload.workspaceId);

    case 'workspaces.removeAdmin':
      return WorkspaceService.removeAdminFromWorkspace(authContext, payload.adminUserId, payload.workspaceId);

    /* ---------------- USERS ---------------- */
    case 'users.list':
      return UserService.listUsers(authContext, wsId);

    case 'users.create':
      return UserService.createUser(authContext, payload);

    case 'users.update':
      return UserService.updateUser(authContext, payload.targetUserId, payload.updates);

    case 'users.makePassive':
      return UserService.makeUserPassive(authContext, payload.targetUserId, payload.reason);

    case 'users.activate':
      return UserService.activateUser(authContext, payload.targetUserId);

    case 'users.resetPassword':
      return AuthService.resetPasswordByAdmin(authContext, payload.targetUserId, payload.temporaryPassword);

    /* ---------------- REQUESTS ---------------- */
    case 'requests.submit':
      return AdminRequestService.submitRequest(authContext, payload);

    case 'requests.list':
      return AdminRequestService.listRequests(authContext, payload.statusFilter, wsId);

    case 'requests.review':
      return AdminRequestService.reviewRequest(authContext, payload.requestId, payload);

    /* ---------------- TIMER & ENTRIES ---------------- */
    case 'timer.start':
      return TimerService.startTimer(authContext, wsId, payload);

    case 'timer.stop':
      return TimerService.stopTimer(authContext, wsId, payload);

    case 'timer.getActive':
      return TimerService.getActiveTimer(authContext, wsId);

    case 'entries.createManual':
      return TimeEntryService.createManualEntry(authContext, wsId, payload);

    case 'entries.update':
      return TimeEntryService.updateEntry(
        authContext,
        wsId,
        payload.entryId,
        payload.updates,
        payload.expectedVersion
      );

    case 'entries.delete':
      return TimeEntryService.deleteEntry(
        authContext,
        wsId,
        payload.entryId,
        payload.expectedVersion
      );

    case 'entries.list':
      return TimeEntryService.listEntries(authContext, wsId, payload.filters);

    /* ---------------- TIMESHEET & APPROVALS ---------------- */
    case 'timesheet.getWeekly':
      return TimesheetService.getWeeklyTimesheet(authContext, wsId, payload.targetUserId, payload.weekStartDate);

    case 'timesheet.listForReview':
      return TimesheetService.listTimesheetsForManager(
        authContext,
        wsId,
        payload.statusFilter
      );

    case 'timesheet.submit':
      return TimesheetService.submitTimesheet(authContext, wsId, payload);

    case 'timesheet.approve':
      return ApprovalService.approveTimesheet(authContext, wsId, payload.timesheetId, payload.comment);

    case 'timesheet.reject':
      return ApprovalService.rejectTimesheet(authContext, wsId, payload.timesheetId, payload.comment);

    case 'timesheet.reopen':
      return ApprovalService.reopenTimesheet(authContext, wsId, payload.timesheetId, payload.reason);

    /* ---------------- MASTER DATA ---------------- */
    case 'clients.list':
      return ClientService.listClients(authContext, wsId);

    case 'clients.create':
      return ClientService.createClient(authContext, wsId, payload);

    case 'projects.list':
      return ProjectService.listProjects(authContext, wsId);

    case 'projects.create':
      return ProjectService.createProject(authContext, wsId, payload);

    case 'projects.update':
      return ProjectService.updateProject(authContext, wsId, payload.projectId, payload.updates);

    case 'tasks.list':
      return TaskService.listTasks(authContext, wsId, payload.projectId);

    case 'tasks.create':
      return TaskService.createTask(authContext, wsId, payload);

    case 'tags.list':
      return TagService.listTags(authContext, wsId);

    case 'tags.create':
      return TagService.createTag(authContext, wsId, payload);

    /* ---------------- REPORTS & DASHBOARDS ---------------- */
    case 'reports.summary':
      return ReportService.getSummaryReport(authContext, wsId, payload);

    case 'reports.detailed':
      return ReportService.getDetailedReport(authContext, wsId, payload);

    case 'reports.attendance':
      return ReportService.getAttendanceReport(authContext, wsId, payload);

    case 'reports.exceptions':
      return ReportService.getExceptionsReport(authContext, wsId, payload);

    case 'reports.exportCsv':
      return ExportService.exportDetailedCsv(authContext, wsId, payload);

    case 'dashboard.radar':
      return DashboardService.getLiveWorkforceRadar(authContext, wsId);

    case 'dashboard.overview':
      return DashboardService.getDashboardOverview(authContext, wsId);

    case 'system.health':
      return SetupService.processStep(9, {}, authContext);

    case 'system.repair':
      return SetupService.repairSystem(authContext);

    case 'system.diagnostics':
      return SetupService.getAdvancedDiagnostics(authContext);

    case 'setup.completeStep':
      return SetupService.processStep(payload.step, payload, authContext);

    case 'setup.finalize':
      return SetupService.processStep(9, payload, authContext);

    /* ---------------- SETTINGS & CONFIGURATION ---------------- */
    case 'settings.get': {
      AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN]);
      const allSettings = MasterRepository.getAllGlobalSettingsStrict();
      if (authContext.role === CONSTANTS.ROLES.SUPER_ADMIN) return allSettings;

      const allowedWorkspaceIds = MasterRepository
        .getWorkspaceAccessForUser(authContext.userId)
        .map(access => String(access.WorkspaceID || ''));
      const filtered = {};
      for (const [key, value] of Object.entries(allSettings)) {
        if (!String(key).startsWith('WS_')) {
          filtered[key] = value;
          continue;
        }
        if (allowedWorkspaceIds.some(id => id && String(key).startsWith(`WS_${id}_`))) {
          filtered[key] = value;
        }
      }
      return filtered;
    }

    case 'settings.save': {
      AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
      const cleanSettings = Validation.validateGlobalSettingsPatch(
        payload.settings
      );
      const beforeSettings = {};
      for (const key of Object.keys(cleanSettings)) {
        beforeSettings[key] = MasterRepository.getGlobalSetting(key, '');
      }
      for (const [key, value] of Object.entries(cleanSettings)) {
        MasterRepository.setGlobalSetting(key, value, authContext.userId);
      }
      MasterRepository.logGlobalAudit({
        ActorUserID: authContext.userId,
        ActorRole: authContext.role,
        WorkspaceID: 'MASTER',
        EntityType: 'GLOBAL_SETTINGS',
        EntityID: 'GLOBAL_SETTINGS',
        Action: CONSTANTS.AUDIT_EVENTS.SETTINGS_CHANGED,
        BeforeJSON: beforeSettings,
        AfterJSON: cleanSettings,
        Reason: 'Validated global settings update'
      });
      return { ok: true, message: 'Settings saved successfully.' };
    }

    /* ---------------- SECURITY & SESSIONS ---------------- */
    case 'users.unlock':
      AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
      return MasterRepository.unlockAccount(payload.targetUserId);

    case 'users.forceLogout':
      AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
      SessionService.revokeAllUserSessions(payload.targetUserId);
      return { ok: true, message: `All active sessions revoked for user ${payload.targetUserId}.` };

    case 'sessions.listActive':
      AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
      return MasterRepository.listActiveSessions();

    case 'sessions.revoke':
      AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
      MasterRepository.updateSession(payload.sessionId, { Revoked: true, RevokedAt: new Date().toISOString() });
      return { ok: true, message: 'Session revoked successfully.' };

    /* ---------------- TIME ENTRY BULK & ADVANCED ---------------- */
    case 'entries.bulkAction':
      return {
        ok: true,
        affected: TimeEntryService.bulkAction(authContext, wsId, payload.entryIds, payload.actionType, payload.params)
      };

    case 'workspaces.deletePermanent': {
      AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
      Validation.assertRequired(payload, CONSTANTS.AUTH_MODE === 'GOOGLE' ? ['workspaceId', 'workspaceName'] : ['workspaceId', 'workspaceName', 'adminPassword']);
      const targetWorkspace = MasterRepository.getWorkspace(payload.workspaceId);
      if (!targetWorkspace) {
        throw new AppError(ERROR_CODES.NOT_FOUND, `Workspace ${payload.workspaceId} not found.`, 404);
      }
      if (
        String(payload.workspaceName || '').trim() !==
        String(targetWorkspace.WorkspaceName || '').trim()
      ) {
        throw new AppError(
          ERROR_CODES.VALIDATION_ERROR,
          'Workspace name confirmation does not match the server record.',
          400
        );
      }
      const credRows = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.CREDENTIALS).rows;
      const userCred = credRows.find(c => c.UserID === authContext.userId);
      if (!AuthService._verifyPrimaryIdentity(authContext, payload.adminPassword, userCred)) {
        throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Invalid Super Admin password confirmation.', 401);
      }
      return MasterRepository.deleteWorkspacePermanent(payload.workspaceId);
    }

    /* ---------------- BACKUP & RESTORE ---------------- */
    case 'backups.create':
      return BackupService.createBackup(authContext, wsId);

    case 'backups.list':
      return BackupService.listBackups(authContext, payload.workspaceId || wsId || null);

    case 'backups.restoreValidate':
      return BackupService.validateBackup(authContext, payload.workspaceId || wsId, payload.backupId);

    case 'backups.restoreApply':
      return BackupService.restoreBackup(
        authContext,
        payload.workspaceId || wsId,
        payload.backupId,
        payload.adminPassword,
        payload.operationId
      );

    case 'backups.restorePrepare':
      return BackupService.prepareRestore(authContext, payload.workspaceId || wsId, payload.backupId, payload.intentId, payload.previousOperationId);

    case 'backups.restoreStatus':
      return BackupService.restoreStatus(authContext, payload.workspaceId || wsId);

    case 'rollups.rebuild':
      return RollupService.rebuildRollups(wsId);

    /* ---------------- JOBS & CAPACITY ---------------- */
    case 'jobs.dispatchHousekeeping':
      AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
      return JobService.dispatchHousekeeping();

    case 'jobs.dispatchRollups':
      AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
      return JobService.dispatchRollups();

    case 'jobs.capacity': {
      AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN]);
      const requestedCapacityWorkspace = payload.workspaceId || wsId || '';
      if (authContext.role === CONSTANTS.ROLES.ADMIN) {
        if (!requestedCapacityWorkspace) {
          throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'workspaceId is required for Admin capacity requests.', 400);
        }
        AuthorizationService.assertWorkspaceAccess(authContext, requestedCapacityWorkspace);
        return JobService.getCapacityMetrics(requestedCapacityWorkspace);
      }
      return JobService.getCapacityMetrics(requestedCapacityWorkspace || null);
    }

    /* ---------------- INTEGRITY & AUDIT ---------------- */
    case 'integrity.audit':
      AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
      return IntegrityService.runNightlyAudit();

    default:
      throw new AppError(ERROR_CODES.NOT_FOUND, `Unknown API action: ${action}`, 404);
  }
}

/**
 * Builds ContentService JSON HTTP response
 */
function buildJsonResponse_(obj) {
  const jsonString = JSON.stringify(obj);
  if (typeof ContentService !== 'undefined' && ContentService.createTextOutput) {
    return ContentService.createTextOutput(jsonString).setMimeType(ContentService.MimeType.JSON);
  }
  return obj;
}

const App = {
  ACTION_PERMISSIONS,
  PUBLIC_ACTIONS,
  GET_SAFE_ACTIONS,
  isHttpMethodAllowed: isHttpMethodAllowed_,
  doGet,
  doPost,
  handleApiRequest: handleApiRequest_,
  handleClientRequest,
  executeApiRequest: executeApiRequest_,
  dispatchAction: dispatchAction_,
  buildJsonResponse: buildJsonResponse_
};

/* ============================================================ */

/** FLINK Time — Consolidated identity, authentication, authorization, session, MFA, and tracking policy services. */


