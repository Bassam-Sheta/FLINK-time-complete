/* ===== Errors.gs ===== */
/**
 * FLINK Time & Workforce Platform — Error Definitions
 */

var ERROR_CODES = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  ACCOUNT_PASSIVE: 'ACCOUNT_PASSIVE',
  PASSWORD_CHANGE_REQUIRED: 'PASSWORD_CHANGE_REQUIRED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  WORKSPACE_DENIED: 'WORKSPACE_DENIED',
  WORKSPACE_NOT_FOUND: 'WORKSPACE_NOT_FOUND',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  ACTIVE_TIMER_EXISTS: 'ACTIVE_TIMER_EXISTS',
  TIMER_NOT_FOUND: 'TIMER_NOT_FOUND',
  ENTRY_LOCKED: 'ENTRY_LOCKED',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVER_BUSY: 'SERVER_BUSY',
  NOT_FOUND: 'NOT_FOUND',
  ADMIN_LIMIT_EXCEEDED: 'ADMIN_LIMIT_EXCEEDED',
  CRYPTO_FAILURE: 'CRYPTO_FAILURE',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
};

var AppError = (typeof global !== 'undefined' && global.AppError) || class AppError extends Error {
  constructor(code, message, statusCode = 400, details = null) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }

  toJSON() {
    return {
      ok: false,
      error: {
        code: this.code,
        message: this.message,
        statusCode: this.statusCode,
        details: this.details
      }
    };
  }
}

/**
 * Optional install-time bootstrap values.
 *
 * Normal/template installs leave the sentinels untouched; installerBootstrapValue_()
 * treats them as empty. The separate official installer may replace only these two
 * sentinel strings before uploading the five production files into a newly created
 * bound Apps Script project.
 */
var INSTALLER_BOOTSTRAP = {
  masterSpreadsheetId: '__FLINK_INSTALLER_MASTER_SPREADSHEET_ID__',
  ownerEmail: '__FLINK_INSTALLER_OWNER_EMAIL__'
};

function installerBootstrapValue_(value) {
  const raw = String(value || '').trim();
  if (!raw || /^__FLINK_INSTALLER_[A-Z0-9_]+__$/.test(raw)) return '';
  return raw;
}

