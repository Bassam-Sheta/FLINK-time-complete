/* ===== ExportAndMigrationServices.gs ===== */
/**
 * FLINK Time & Workforce Platform — Export & Migration Services
 * Generates formula-sanitized CSV exports, verifies system health, and bootstraps schemas.
 */

var ExportService = (typeof global !== 'undefined' && global.ExportService) || {
  /**
   * Generates sanitized CSV string from detailed report entries
   */
  exportDetailedCsv(authContext, workspaceId, params = {}) {
    const report = ReportService.getDetailedReport(authContext, workspaceId, params);
    const headers = [
      'Entry ID', 'User Name', 'Project', 'Task', 'Description',
      'Start UTC', 'End UTC', 'Duration (Seconds)', 'Duration (HH:MM:SS)',
      'Billable', 'Approval Status', 'Source', 'Manual'
    ];

    const escapeCsv = val => {
      if (val === null || val === undefined) return '""';
      let str = String(val);
      // Neutralize spreadsheet formula injection in CSV exports
      if (/^[=+\-@\t\r\n]/.test(str)) {
        str = "'" + str;
      }
      return '"' + str.replace(/"/g, '""') + '"';
    };

    const csvLines = [headers.map(escapeCsv).join(',')];

    for (const e of report.entries) {
      csvLines.push([
        e.entryId,
        e.userName,
        e.projectName,
        e.taskName,
        e.description,
        e.startUTC,
        e.endUTC,
        e.durationSeconds,
        e.durationFormatted,
        e.billable ? 'YES' : 'NO',
        e.approvalStatus,
        e.source,
        e.manual ? 'YES' : 'NO'
      ].map(escapeCsv).join(','));
    }

    MasterRepository.logGlobalAudit({
      ActorUserID: authContext.userId,
      ActorRole: authContext.role,
      WorkspaceID: workspaceId,
      EntityType: 'EXPORT',
      EntityID: `EXP_${Date.now()}`,
      Action: CONSTANTS.AUDIT_EVENTS.EXPORT_CREATED,
      Reason: 'Detailed CSV export downloaded'
    });

    return {
      filename: `FLINK_Time_Export_${workspaceId}_${new Date().toISOString().substring(0, 10)}.csv`,
      csvContent: csvLines.join('\r\n'),
      totalRows: report.entries.length
    };
  }
};

function trimSheetToSchema_(sheet, columnCount, minimumRows = 1000) {
  if (!sheet || !Number.isInteger(columnCount) || columnCount < 1) return { changed: false };

  const canInspectColumns =
    typeof sheet.getLastColumn === 'function' &&
    typeof sheet.getMaxColumns === 'function';
  const canInspectRows =
    typeof sheet.getLastRow === 'function' &&
    typeof sheet.getMaxRows === 'function';

  let columnsTrimmed = 0;
  let rowsTrimmed = 0;

  if (canInspectColumns) {
    const lastColumn = Math.max(1, Number(sheet.getLastColumn()) || 1);
    const maxColumns = Number(sheet.getMaxColumns()) || lastColumn;
    // Never delete populated data outside the known schema automatically.
    if (
      maxColumns > columnCount &&
      lastColumn <= columnCount &&
      typeof sheet.deleteColumns === 'function'
    ) {
      columnsTrimmed = maxColumns - columnCount;
      sheet.deleteColumns(columnCount + 1, columnsTrimmed);
    }
  }

  if (canInspectRows) {
    const lastRow = Math.max(1, Number(sheet.getLastRow()) || 1);
    const maxRows = Number(sheet.getMaxRows()) || lastRow;
    const targetRows = Math.max(Number(minimumRows) || 1000, lastRow);
    if (maxRows > targetRows && typeof sheet.deleteRows === 'function') {
      rowsTrimmed = maxRows - targetRows;
      sheet.deleteRows(targetRows + 1, rowsTrimmed);
    }
  }

  return {
    changed: columnsTrimmed > 0 || rowsTrimmed > 0,
    columnsTrimmed,
    rowsTrimmed
  };
}

var MigrationService = (typeof global !== 'undefined' && global.MigrationService) || {
  /**
   * Bootstraps only the Master Control Sheet schema and cryptographic secret.
   * It deliberately does NOT create any default/admin credentials.
   */
  bootstrapMasterSheet(masterSpreadsheet = null) {
    const ss = masterSpreadsheet || MasterRepository.getMasterSpreadsheet();

    for (const [tabName, columns] of Object.entries(MASTER_SCHEMA)) {
      let sheet = ss.getSheetByName(tabName);
      if (!sheet) sheet = ss.insertSheet(tabName);
      sheet.getRange(1, 1, 1, columns.length).setValues([columns]);
      sheet.setFrozenRows(1);
      trimSheetToSchema_(sheet, columns.length, 1000);
    }

    const defaultSheet = ss.getSheetByName('Sheet1');
    if (defaultSheet && !MASTER_SCHEMA[defaultSheet.getName()]) {
      try { ss.deleteSheet(defaultSheet); } catch (e) {}
    }

    SecurityService.ensurePepper();
    return { ok: true, message: 'Master Control Sheet schema and cryptographic secret initialized.' };
  },

  /**
   * System Health Diagnostic for Super Admin Console
   */
  getSystemHealth(superAdminContext) {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);

    const workspaces = MasterRepository.listWorkspaces();
    let accessibleWorkspacesCount = 0;
    let healthyWorkspacesCount = 0;

    for (const ws of workspaces) {
      if (ws.Status !== CONSTANTS.WORKSPACE_STATUS.ARCHIVED) {
        accessibleWorkspacesCount++;
        try {
          const ss = WorkspaceRouter.resolveSpreadsheet(ws.WorkspaceID);
          if (ss) healthyWorkspacesCount++;
        } catch (e) {}
      }
    }

    return {
      platformVersion: CONSTANTS.VERSION,
      schemaVersion: CONSTANTS.SCHEMA_VERSION,
      masterSheetStatus: 'HEALTHY',
      workspacesStatus: `${healthyWorkspacesCount}/${accessibleWorkspacesCount} OK`,
      totalRegisteredWorkspaces: workspaces.length,
      timestampUTC: new Date().toISOString()
    };
  }
};

/**
 * Deployment-owner-only PBKDF2 benchmark.
 *
 * Run this private function from the Apps Script editor against the production
 * Apps Script runtime. It does not read or write user credentials. The sample
 * password and salt below are fixed, non-secret benchmark data.
 */
function benchmarkPasswordKdf_() {
  const samplePassword = 'FLINK-PBKDF2-BENCHMARK-NOT-A-REAL-PASSWORD';
  const sampleSalt = '00112233445566778899aabbccddeeff';
  const keyBytes = CONSTANTS.SECURITY.PBKDF2_KEY_BYTES;
  const targets = [10000, 25000, 50000, 100000];
  const results = [];
  const overallStartedAt = Date.now();

  // Warm the V8/runtime path so initialization does not dominate the first sample.
  SecurityService.pbkdf2Sync(samplePassword, sampleSalt, 1000, keyBytes);

  for (const iterations of targets) {
    const startedAt = Date.now();
    SecurityService.pbkdf2Sync(samplePassword, sampleSalt, iterations, keyBytes);
    const elapsedMs = Date.now() - startedAt;
    results.push({
      iterations,
      elapsedMs,
      millisecondsPerIteration: elapsedMs / iterations
    });

    // Keep this diagnostic safely bounded well below Apps Script's execution limit.
    if (elapsedMs >= 10000 || Date.now() - overallStartedAt >= 45000) break;
  }

  const usable = results.filter(result => result.elapsedMs > 0);
  const averageMsPerIteration = usable.length
    ? usable.reduce(
        (sum, result) => sum + result.millisecondsPerIteration,
        0
      ) / usable.length
    : 0;
  const owaspReferenceIterations = 600000;
  const estimatedOwaspRuntimeMs = averageMsPerIteration > 0
    ? Math.round(averageMsPerIteration * owaspReferenceIterations)
    : null;

  const report = {
    currentIterations: CONSTANTS.SECURITY.PBKDF2_ITERATIONS,
    owaspReferenceIterations,
    results,
    estimatedOwaspRuntimeMs,
    estimatedOwaspRuntimeSeconds:
      estimatedOwaspRuntimeMs === null ? null : estimatedOwaspRuntimeMs / 1000,
    oneSecondReferenceMet:
      estimatedOwaspRuntimeMs !== null && estimatedOwaspRuntimeMs <= 1000,
    note:
      'Diagnostic only. Do not change PBKDF2_ITERATIONS until the benchmark result is reviewed and the migration path is selected.'
  };

  console.log(JSON.stringify(report, null, 2));
  return report;
}

/**
 * Adds a tiny installer menu to the bound Master Sheet.
 * The only public simple-trigger entrypoint is onOpen(); all menu handlers stay
 * private (trailing underscore) and therefore are unavailable to google.script.run.
 */
function onOpen() {
  try {
    if (typeof SpreadsheetApp === 'undefined' || !SpreadsheetApp.getUi) return;
    SpreadsheetApp.getUi()
      .createMenu('FLINK Time')
      .addItem('1. Prepare Installation', 'prepareInstallation_')
      .addItem('2. Deployment Instructions', 'showDeploymentInstructions_')
      .addItem('3. Open FLINK Time', 'showWebAppLink_')
      .addToUi();
  } catch (err) {
    console.error('FLINK Time menu could not be added: ' + (err && err.message ? err.message : String(err)));
  }
}

function getBoundMasterSheetOwnerEmail_(spreadsheet) {
  if (!spreadsheet || !spreadsheet.getId) {
    throw new AppError(ERROR_CODES.INTERNAL_ERROR, 'The bound Master Sheet could not be resolved.', 500);
  }

  const activeEmail = IdentityService.getCurrentGoogleEmail(true);
  let ownerEmail = '';
  try {
    if (typeof DriveApp === 'undefined' || !DriveApp.getFileById) {
      throw new Error('Drive service unavailable');
    }
    const file = DriveApp.getFileById(spreadsheet.getId());
    const owner = file && file.getOwner ? file.getOwner() : null;
    ownerEmail = IdentityService.normalizeEmail(
      owner && owner.getEmail ? owner.getEmail() : ''
    );
  } catch (err) {
    throw new AppError(
      ERROR_CODES.UNAUTHORIZED,
      'Initial setup must use a Master Sheet copy owned in My Drive. Make your own copy of the template before preparing FLINK Time.',
      403
    );
  }

  if (!ownerEmail || activeEmail !== ownerEmail) {
    throw new AppError(
      ERROR_CODES.UNAUTHORIZED,
      'Only the Google account that owns this Master Sheet can prepare FLINK Time.',
      403
    );
  }
  return ownerEmail;
}

function prepareInstallationCore_() {
  if (
    typeof SpreadsheetApp === 'undefined' ||
    !SpreadsheetApp.getActiveSpreadsheet
  ) {
    throw new AppError(ERROR_CODES.INTERNAL_ERROR, 'Google Sheets is unavailable in this runtime.', 500);
  }
  if (
    typeof PropertiesService === 'undefined' ||
    !PropertiesService.getScriptProperties
  ) {
    throw new AppError(ERROR_CODES.INTERNAL_ERROR, 'Script Properties are unavailable in this runtime.', 500);
  }

  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) {
    throw new AppError(
      ERROR_CODES.INTERNAL_ERROR,
      'Open the FLINK Time Master Sheet before preparing the installation.',
      500
    );
  }

  const ownerEmail = getBoundMasterSheetOwnerEmail_(spreadsheet);
  const spreadsheetId = spreadsheet.getId();
  const props = PropertiesService.getScriptProperties();
  const configuredSpreadsheetId = String(
    props.getProperty('MASTER_SPREADSHEET_ID') || ''
  ).trim();
  const configuredOwner = IdentityService.normalizeEmail(
    props.getProperty('FLINK_INSTALL_OWNER_EMAIL') || ''
  );

  if (configuredSpreadsheetId && configuredSpreadsheetId !== spreadsheetId) {
    throw new AppError(
      ERROR_CODES.CONFLICT,
      'This Apps Script project is already bound to a different FLINK Time Master Sheet.',
      409
    );
  }
  if (configuredOwner && configuredOwner !== ownerEmail) {
    throw new AppError(
      ERROR_CODES.UNAUTHORIZED,
      'This FLINK Time installation is already bound to another installation owner.',
      403
    );
  }

  props.setProperty('MASTER_SPREADSHEET_ID', spreadsheetId);
  props.setProperty('FLINK_INSTALL_OWNER_EMAIL', ownerEmail);
  props.setProperty('FLINK_INSTALL_PREPARED_AT', new Date().toISOString());
  MasterRepository.spreadsheetId = spreadsheetId;

  let alreadyComplete = false;
  try {
    const existingFlag = MasterRepository.getGlobalSetting('SETUP_COMPLETE', 'false');
    alreadyComplete = existingFlag === true || existingFlag === 'true';
  } catch (err) {
    alreadyComplete = false;
  }

  if (!alreadyComplete) {
    MigrationService.bootstrapMasterSheet(spreadsheet);
  }

  return {
    ok: true,
    alreadyComplete,
    ownerEmail,
    spreadsheetId,
    message: alreadyComplete
      ? 'FLINK Time is already prepared and setup is complete.'
      : 'FLINK Time is prepared. Deploy the Web App, then open the Super Admin link to finish setup.'
  };
}

function prepareInstallation_() {
  try {
    const result = prepareInstallationCore_();
    SpreadsheetApp.getUi().alert(
      'FLINK Time',
      result.message + '\n\nNext: choose FLINK Time → Deployment Instructions.',
      SpreadsheetApp.getUi().ButtonSet.OK
    );
    return result;
  } catch (err) {
    const message = err && err.message ? err.message : 'Installation preparation failed.';
    SpreadsheetApp.getUi().alert(
      'FLINK Time setup could not continue',
      message,
      SpreadsheetApp.getUi().ButtonSet.OK
    );
    throw err;
  }
}

function showDeploymentInstructions_() {
  SpreadsheetApp.getUi().alert(
    'FLINK Time — Deployment Instructions',
    [
      '1. In this Sheet, choose Extensions → Apps Script.',
      '2. In Apps Script choose Deploy → New deployment → Web app.',
      '3. Set Execute as: Me.',
      '4. Set access to users in your Google Workspace domain.',
      '5. Deploy, authorize when Google asks, then return to this Sheet.',
      '6. Choose FLINK Time → Open FLINK Time and open the Super Admin link.',
      '',
      'Only the Employee portal may be embedded in Google Sites. Admin and Super Admin must be opened directly.'
    ].join('\n'),
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

function escapeInstallerHtml_(value) {
  return String(value || '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[ch]);
}

function showWebAppLink_() {
  const ui = SpreadsheetApp.getUi();
  const baseUrl = (
    typeof ScriptApp !== 'undefined' &&
    ScriptApp.getService &&
    ScriptApp.getService().getUrl
  ) ? String(ScriptApp.getService().getUrl() || '') : '';

  if (!baseUrl) {
    ui.alert(
      'FLINK Time is not deployed yet',
      'Complete FLINK Time → Deployment Instructions first, then try again.',
      ui.ButtonSet.OK
    );
    return;
  }

  const safeBase = escapeInstallerHtml_(baseUrl);
  const userUrl = safeBase + '?view=user';
  const adminUrl = safeBase + '?view=admin';
  const superAdminUrl = safeBase + '?view=superadmin';
  const html = HtmlService.createHtmlOutput(
    '<div style="font-family:Arial,sans-serif;padding:18px;line-height:1.55">' +
      '<h2 style="margin-top:0">FLINK Time</h2>' +
      '<p><strong>First installation:</strong> open Super Admin and complete the guided setup.</p>' +
      '<p><a target="_blank" href="' + superAdminUrl + '">Open Super Admin</a></p>' +
      '<p><a target="_blank" href="' + adminUrl + '">Open Admin</a></p>' +
      '<p><a target="_blank" href="' + userUrl + '">Open Employee Portal</a></p>' +
      '<p style="font-size:12px;color:#666">Admin and Super Admin are direct links. Only the Employee portal may be embedded in Google Sites.</p>' +
    '</div>'
  ).setWidth(430).setHeight(300);
  ui.showModalDialog(html, 'FLINK Time Links');
}

/**
 * Backward-compatible private owner helper for maintainers.
 * Normal installers do not need to run code in the Apps Script editor.
 */
function initializeInstallation_() {
  return prepareInstallationCore_();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ERROR_CODES, AppError,
    CONSTANTS, MASTER_SCHEMA, WORKSPACE_SCHEMA, Validation,
    ACTION_PERMISSIONS, PUBLIC_ACTIONS, GET_SAFE_ACTIONS,
    isHttpMethodAllowed: isHttpMethodAllowed_, App, doGet, doPost,
    handleApiRequest: handleApiRequest_, handleClientRequest, executeApiRequest: executeApiRequest_,
    dispatchAction: dispatchAction_, buildJsonResponse: buildJsonResponse_,
    IdentityService, SecurityService, AuthorizationService,
    SessionService, AuthService, TrackingPolicyService,
    MasterRepository, SheetRepository, WorkspaceRouter,
    WorkspaceService, TimezoneService,
    ClientService, ProjectService, TaskService, TagService,
    TimeEntryService, TimerService, TimesheetService,
    ApprovalService, ReportService, RollupService, DashboardService,
    UserService, AdminRequestService, SetupService, IntegrityService,
    JobService, BackupService, AuditService, NotificationService,
    ExportService, MigrationService, initializeInstallation: initializeInstallation_
  };
}
