/* ===== IdentityService.gs ===== */
/**
 * FLINK Time & Workforce Platform — Google Workspace Identity Service
 * Binds browser sessions to the server-observed Google account identity.
 *
 * Security rule:
 * - Never trust a client-supplied email as proof of identity.
 * - WEB sessions require Session.getActiveUser().getEmail().
 * - The observed email must exactly match the FLINK account Email.
 */
var IdentityService = (typeof global !== 'undefined' && global.IdentityService) || {
  normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
  },

  getCurrentGoogleEmail(required = true) {
    let email = '';
    try {
      if (
        typeof Session !== 'undefined' &&
        Session.getActiveUser
      ) {
        const activeUser = Session.getActiveUser();
        if (activeUser && activeUser.getEmail) {
          email = this.normalizeEmail(activeUser.getEmail());
        }
      }
    } catch (err) {
      if (!required) return '';
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'Google Workspace identity could not be verified.',
        401
      );
    }

    if (!email && required) {
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'Google Workspace sign-in is required to use FLINK Time.',
        401
      );
    }
    return email;
  },

  getEffectiveGoogleEmail(required = true) {
    let email = '';
    try {
      if (
        typeof Session !== 'undefined' &&
        Session.getEffectiveUser
      ) {
        const effectiveUser = Session.getEffectiveUser();
        if (effectiveUser && effectiveUser.getEmail) {
          email = this.normalizeEmail(effectiveUser.getEmail());
        }
      }
    } catch (err) {
      if (!required) return '';
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'The FLINK Time deployment owner could not be verified.',
        401
      );
    }

    if (!email && required) {
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'The FLINK Time deployment owner could not be verified.',
        401
      );
    }
    return email;
  },

  assertInstallationOwner() {
    if (typeof PropertiesService === 'undefined' || !PropertiesService.getScriptProperties) {
      throw new AppError(
        ERROR_CODES.INTERNAL_ERROR,
        'Installation settings are unavailable.',
        500
      );
    }

    const props = PropertiesService.getScriptProperties();
    let preparedOwner = this.normalizeEmail(
      props.getProperty('FLINK_INSTALL_OWNER_EMAIL') || ''
    );
    const installerOwner = this.normalizeEmail(
      installerBootstrapValue_(
        INSTALLER_BOOTSTRAP && INSTALLER_BOOTSTRAP.ownerEmail
      )
    );
    if (!preparedOwner && installerOwner) preparedOwner = installerOwner;

    if (!preparedOwner) {
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'FLINK Time has not been prepared yet. Open the Master Sheet and choose FLINK Time → Prepare Installation.',
        401
      );
    }

    const activeEmail = this.getCurrentGoogleEmail(true);
    const effectiveEmail = this.getEffectiveGoogleEmail(true);
    if (activeEmail !== preparedOwner || effectiveEmail !== preparedOwner) {
      throw new AppError(
        ERROR_CODES.UNAUTHORIZED,
        'First-time setup must be completed by the Google Workspace account that owns the Master Sheet and deployed this Web App.',
        403
      );
    }

    // Persist installer-injected bootstrap values only after both Google identity
    // checks succeed. From this point onward Script Properties are authoritative.
    if (!props.getProperty('FLINK_INSTALL_OWNER_EMAIL')) {
      props.setProperty('FLINK_INSTALL_OWNER_EMAIL', preparedOwner);
    }
    const installerSpreadsheetId = installerBootstrapValue_(
      INSTALLER_BOOTSTRAP && INSTALLER_BOOTSTRAP.masterSpreadsheetId
    );
    if (
      installerSpreadsheetId &&
      !props.getProperty('MASTER_SPREADSHEET_ID')
    ) {
      props.setProperty('MASTER_SPREADSHEET_ID', installerSpreadsheetId);
    }

    return preparedOwner;
  },

  assertAccountIdentity(account, clientType = 'WEB') {
    const normalizedClient = String(clientType || 'WEB').toUpperCase();
    if (normalizedClient !== 'WEB' && normalizedClient !== 'SETUP_WIZARD') {
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'Unsupported authentication channel.',
        401
      );
    }

    const actualEmail = this.getCurrentGoogleEmail(true);
    const expectedEmail = this.normalizeEmail(account && account.Email);

    if (!expectedEmail || actualEmail !== expectedEmail) {
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'Google Workspace identity does not match this FLINK account.',
        401
      );
    }
    return actualEmail;
  }
};

