/* ===== MasterRepository.gs ===== */
/**
 * FLINK Time & Workforce Platform — Master Control Sheet Repository
 * Encapsulates all read/write operations for the Master Control Sheet.
 * Employs batch reads, header indexing, and sanitization defense.
 */

var MasterRepository = (typeof global !== 'undefined' && global.MasterRepository) || {
  spreadsheetId: null,
  _requestCache: {},
  _userCacheMemory: {},

  beginRequest() {
    this._requestCache = {};
  },

  _userCacheKey(userId) {
    return 'U:' + String(userId || '');
  },

  invalidateUserCache(userId) {
    const key = this._userCacheKey(userId);
    if (typeof CacheService !== 'undefined' && CacheService.getScriptCache) {
      try { CacheService.getScriptCache().remove(key); } catch (e) {}
    }
    delete this._userCacheMemory[key];
  },

  _getCachedUserBundle(userId) {
    const key = this._userCacheKey(userId);
    let raw = '';
    if (typeof CacheService !== 'undefined' && CacheService.getScriptCache) {
      try { raw = CacheService.getScriptCache().get(key) || ''; } catch (e) {}
    } else {
      raw = this._userCacheMemory[key] || '';
    }
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) {
      this.invalidateUserCache(userId);
      return null;
    }
  },

  _putCachedUserBundle(userId, bundle) {
    const key = this._userCacheKey(userId);
    const raw = JSON.stringify(bundle);
    if (typeof CacheService !== 'undefined' && CacheService.getScriptCache) {
      try { CacheService.getScriptCache().put(key, raw, 60); } catch (e) {}
    } else {
      this._userCacheMemory[key] = raw;
    }
  },

  _invalidateTable(tabName) {
    delete this._requestCache[tabName];
  },

  /**
   * Resolves Master Spreadsheet. If spreadsheetId is not set, tries ScriptProperties or getActiveSpreadsheet()
   */
  getMasterSpreadsheet() {
    if (this.spreadsheetId && typeof SpreadsheetApp !== 'undefined') {
      return SpreadsheetApp.openById(this.spreadsheetId);
    }
    if (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties) {
      const id = PropertiesService.getScriptProperties().getProperty('MASTER_SPREADSHEET_ID');
      if (id && typeof SpreadsheetApp !== 'undefined') {
        this.spreadsheetId = id;
        return SpreadsheetApp.openById(id);
      }
    }

    const installerSpreadsheetId = installerBootstrapValue_(
      INSTALLER_BOOTSTRAP && INSTALLER_BOOTSTRAP.masterSpreadsheetId
    );
    if (installerSpreadsheetId && typeof SpreadsheetApp !== 'undefined') {
      this.spreadsheetId = installerSpreadsheetId;
      return SpreadsheetApp.openById(installerSpreadsheetId);
    }

    if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.getActiveSpreadsheet) {
      const active = SpreadsheetApp.getActiveSpreadsheet();
      if (active) return active;
    }
    throw new AppError(ERROR_CODES.INTERNAL_ERROR, 'Master Spreadsheet could not be resolved.');
  },

  /**
   * Helper to retrieve a tab and all rows as array of objects
   */
  getTableData(tabName) {
    if (this._requestCache[tabName]) {
      return this._requestCache[tabName];
    }

    const ss = this.getMasterSpreadsheet();
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      throw new AppError(ERROR_CODES.NOT_FOUND, `Master tab '${tabName}' does not exist.`);
    }

    const range = sheet.getDataRange();
    const values = range.getValues();
    if (values.length <= 1) {
      const empty = { headers: values[0] || [], rows: [], sheet };
      this._requestCache[tabName] = empty;
      return empty;
    }

    const headers = values[0].map(h => String(h).trim());
    const rows = [];
    for (let r = 1; r < values.length; r++) {
      const rowObj = { _rowIndex: r + 1 };
      for (let col = 0; col < headers.length; col++) {
        rowObj[headers[col]] = values[r][col];
      }
      rows.push(rowObj);
    }

    const result = { headers, rows, sheet };
    this._requestCache[tabName] = result;
    return result;
  },

  /**
   * Finds one row by key without loading the entire tab.
   * Growing request-time tables must prefer this path over getTableData().
   */
  findRowByKey(tabName, columnName, value, options = {}) {
    const ss = this.getMasterSpreadsheet();
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      throw new AppError(ERROR_CODES.NOT_FOUND, `Master tab '${tabName}' does not exist.`);
    }

    const schemaHeaders = MASTER_SCHEMA[tabName];
    if (!schemaHeaders) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, `Schema missing for master tab '${tabName}'.`);
    }
    const columnIndex = schemaHeaders.indexOf(columnName);
    if (columnIndex < 0) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, `Column '${columnName}' is not defined for '${tabName}'.`);
    }

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return null;

    const cell = sheet
      .getRange(2, columnIndex + 1, lastRow - 1, 1)
      .createTextFinder(String(value))
      .matchEntireCell(true)
      .matchCase(options.matchCase !== false)
      .findNext();
    if (!cell) return null;

    const rowIndex = cell.getRow();
    const values = sheet.getRange(rowIndex, 1, 1, schemaHeaders.length).getValues()[0];
    const row = { _rowIndex: rowIndex };
    for (let i = 0; i < schemaHeaders.length; i++) row[schemaHeaders[i]] = values[i];
    return row;
  },

  /**
   * Finds all rows matching one key column without loading the whole tab.
   */
  findRowsByKey(tabName, columnName, value, options = {}) {
    const ss = this.getMasterSpreadsheet();
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      throw new AppError(ERROR_CODES.NOT_FOUND, `Master tab '${tabName}' does not exist.`);
    }
    const schemaHeaders = MASTER_SCHEMA[tabName];
    if (!schemaHeaders) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, `Schema missing for master tab '${tabName}'.`);
    }
    const columnIndex = schemaHeaders.indexOf(columnName);
    if (columnIndex < 0) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, `Column '${columnName}' is not defined for '${tabName}'.`);
    }
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];

    const cells = sheet
      .getRange(2, columnIndex + 1, lastRow - 1, 1)
      .createTextFinder(String(value))
      .matchEntireCell(true)
      .matchCase(options.matchCase !== false)
      .findAll();

    return cells.map(cell => {
      const rowIndex = cell.getRow();
      const values = sheet.getRange(rowIndex, 1, 1, schemaHeaders.length).getValues()[0];
      const row = { _rowIndex: rowIndex };
      for (let i = 0; i < schemaHeaders.length; i++) row[schemaHeaders[i]] = values[i];
      return row;
    });
  },

  getUserAuthBundle(userId) {
    const cached = this._getCachedUserBundle(userId);
    if (cached) return cached;

    const account = this.findAccountById(userId);
    const accesses = account ? this.getWorkspaceAccessForUser(userId) : [];
    const bundle = { account, accesses };
    this._putCachedUserBundle(userId, bundle);
    return bundle;
  },

  /**
   * Appends an entity row to a master tab
   */
  appendRow(tabName, entity) {
    const ss = this.getMasterSpreadsheet();
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      throw new AppError(ERROR_CODES.NOT_FOUND, `Master tab '${tabName}' does not exist.`);
    }

    const schemaHeaders = MASTER_SCHEMA[tabName];
    if (!schemaHeaders) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, `Schema missing for master tab '${tabName}'.`);
    }

    const rowData = schemaHeaders.map(col => {
      const val = entity[col] !== undefined ? entity[col] : '';
      return Validation.sanitizeCellValue(val);
    });

    sheet.appendRow(rowData);
    this._invalidateTable(tabName);
    return entity;
  },

  deleteRow(tabName, rowIndex) {
    const ss = this.getMasterSpreadsheet();
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      throw new AppError(ERROR_CODES.NOT_FOUND, `Master tab '${tabName}' does not exist.`);
    }
    sheet.deleteRow(rowIndex);
    this._invalidateTable(tabName);
  },

  deleteRows(tabName, startRow, howMany) {
    const count = Number(howMany || 0);
    if (!Number.isInteger(startRow) || startRow < 2 || !Number.isInteger(count) || count < 1) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Invalid batch row deletion request.', 400);
    }
    const ss = this.getMasterSpreadsheet();
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      throw new AppError(ERROR_CODES.NOT_FOUND, `Master tab '${tabName}' does not exist.`);
    }
    sheet.deleteRows(startRow, count);
    this._invalidateTable(tabName);
  },

  /**
   * Updates specific columns for a row index in a master tab
   */
  updateRow(tabName, rowIndex, updates) {
    const ss = this.getMasterSpreadsheet();
    const sheet = ss.getSheetByName(tabName);
    const headers = sheet
      .getRange(1, 1, 1, sheet.getLastColumn())
      .getValues()[0]
      .map(h => String(h).trim());

    const changes = Object.entries(updates)
      .map(([colName, val]) => ({
        colIdx: headers.indexOf(colName),
        value: Validation.sanitizeCellValue(val)
      }))
      .filter(change => change.colIdx >= 0)
      .sort((a, b) => a.colIdx - b.colIdx);

    // Batch adjacent changed columns into the smallest possible setValues calls.
    // This reduces Sheets service round-trips without overwriting unrelated columns.
    for (let i = 0; i < changes.length;) {
      const group = [changes[i]];
      let j = i + 1;
      while (
        j < changes.length &&
        changes[j].colIdx === group[group.length - 1].colIdx + 1
      ) {
        group.push(changes[j]);
        j++;
      }

      sheet
        .getRange(rowIndex, group[0].colIdx + 1, 1, group.length)
        .setValues([group.map(change => change.value)]);
      i = j;
    }

    this._invalidateTable(tabName);
  },

  /* ------------------- ACCOUNTS & CREDENTIALS ------------------- */

  findAccountByUsername(username) {
    const cleanUsername = String(username).trim().toLowerCase();
    return this.findRowByKey(
      CONSTANTS.MASTER_TABS.ACCOUNTS,
      'Username',
      cleanUsername,
      { matchCase: false }
    );
  },

  findAccountById(userId) {
    return this.findRowByKey(CONSTANTS.MASTER_TABS.ACCOUNTS, 'UserID', userId);
  },

  createAccount(accountData, credentialData) {
    if (!accountData || !accountData.UserID || !credentialData || credentialData.UserID !== accountData.UserID) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        'Account and credential records with the same UserID are required.',
        400
      );
    }

    let accountCreated = false;
    try {
      this.appendRow(CONSTANTS.MASTER_TABS.ACCOUNTS, accountData);
      accountCreated = true;
      this.appendRow(CONSTANTS.MASTER_TABS.CREDENTIALS, credentialData);
      return accountData;
    } catch (err) {
      if (accountCreated) {
        try {
          const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.ACCOUNTS);
          const created = rows.find(row => row.UserID === accountData.UserID);
          if (created) this.deleteRow(CONSTANTS.MASTER_TABS.ACCOUNTS, created._rowIndex);
        } catch (rollbackErr) {
          console.error(
            `Account creation rollback failed for ${accountData.UserID}: ${rollbackErr.message}`
          );
        }
      }
      throw err;
    }
  },

  /**
   * Hard rollback helper for a user that failed during initial provisioning.
   * This is intentionally for creation rollback only, not normal user deletion.
   */
  rollbackUserCreation(userId) {
    const deleteMatches = (tabName, predicate) => {
      const { rows } = this.getTableData(tabName);
      rows
        .filter(predicate)
        .sort((a, b) => b._rowIndex - a._rowIndex)
        .forEach(row => this.deleteRow(tabName, row._rowIndex));
    };

    deleteMatches(
      CONSTANTS.MASTER_TABS.WORKSPACE_ACCESS,
      row => row.UserID === userId
    );
    deleteMatches(
      CONSTANTS.MASTER_TABS.CREDENTIALS,
      row => row.UserID === userId
    );
    deleteMatches(
      CONSTANTS.MASTER_TABS.ACCOUNTS,
      row => row.UserID === userId
    );
  },

  updateAccount(userId, updates) {
    const acc = this.findAccountById(userId);
    if (!acc) throw new AppError(ERROR_CODES.NOT_FOUND, `Account ${userId} not found.`);
    this.updateRow(CONSTANTS.MASTER_TABS.ACCOUNTS, acc._rowIndex, updates);
    this.invalidateUserCache(userId);
    return { ...acc, ...updates };
  },

  getCredentials(userId) {
    return this.findRowByKey(CONSTANTS.MASTER_TABS.CREDENTIALS, 'UserID', userId);
  },

  updateCredentials(userId, updates) {
    const cred = this.getCredentials(userId);
    if (!cred) throw new AppError(ERROR_CODES.NOT_FOUND, `Credentials for ${userId} not found.`);
    this.updateRow(CONSTANTS.MASTER_TABS.CREDENTIALS, cred._rowIndex, updates);
    return { ...cred, ...updates };
  },

  /* ------------------- WORKSPACES & ACCESS ------------------- */

  listWorkspaces() {
    const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.WORKSPACES);
    return rows;
  },

  getWorkspace(workspaceId) {
    return this.findRowByKey(CONSTANTS.MASTER_TABS.WORKSPACES, 'WorkspaceID', workspaceId);
  },

  createWorkspace(workspaceData) {
    this.appendRow(CONSTANTS.MASTER_TABS.WORKSPACES, workspaceData);
    return workspaceData;
  },

  updateWorkspace(workspaceId, updates) {
    const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.WORKSPACES);
    const ws = rows.find(r => r.WorkspaceID === workspaceId);
    if (!ws) throw new AppError(ERROR_CODES.NOT_FOUND, `Workspace ${workspaceId} not found.`);
    this.updateRow(CONSTANTS.MASTER_TABS.WORKSPACES, ws._rowIndex, updates);

    // Workspace status and physical-pointer changes must invalidate the router's
    // warm execution cache immediately; otherwise a previously cached ACTIVE
    // spreadsheet could remain reachable after MAINTENANCE/ARCHIVE transitions.
    if (
      updates &&
      (Object.prototype.hasOwnProperty.call(updates, 'Status') ||
       Object.prototype.hasOwnProperty.call(updates, 'SpreadsheetID')) &&
      typeof WorkspaceRouter !== 'undefined' &&
      WorkspaceRouter.clearCache
    ) {
      WorkspaceRouter.clearCache();
    }

    return { ...ws, ...updates };
  },

  getWorkspaceAccessForUser(userId) {
    return this.findRowsByKey(
      CONSTANTS.MASTER_TABS.WORKSPACE_ACCESS,
      'UserID',
      userId
    ).filter(r => r.Active === true || r.Active === 'TRUE' || r.Active === 1);
  },

  getWorkspaceAccessForWorkspace(workspaceId) {
    return this.findRowsByKey(
      CONSTANTS.MASTER_TABS.WORKSPACE_ACCESS,
      'WorkspaceID',
      workspaceId
    ).filter(r => r.Active === true || r.Active === 'TRUE' || r.Active === 1);
  },

  countActiveAdminWorkspaces(userId) {
    const accesses = this.getWorkspaceAccessForUser(userId);
    return accesses.filter(a => a.Role === CONSTANTS.ROLES.ADMIN).length;
  },

  assignWorkspaceAccess(accessData) {
    const rows = this.findRowsByKey(
      CONSTANTS.MASTER_TABS.WORKSPACE_ACCESS,
      'UserID',
      accessData.UserID
    );
    const existing = rows.find(r => r.WorkspaceID === accessData.WorkspaceID);
    if (existing) {
      this.updateRow(CONSTANTS.MASTER_TABS.WORKSPACE_ACCESS, existing._rowIndex, {
        Role: accessData.Role,
        Active: true,
        AssignedAt: accessData.AssignedAt || new Date().toISOString(),
        AssignedBy: accessData.AssignedBy || ''
      });
      this.invalidateUserCache(accessData.UserID);
      return { ...existing, ...accessData, Active: true };
    }
    const created = this.appendRow(CONSTANTS.MASTER_TABS.WORKSPACE_ACCESS, accessData);
    this.invalidateUserCache(accessData.UserID);
    return created;
  },

  syncWorkspaceAccessRole(userId, role) {
    this.getWorkspaceAccessForUser(userId)
      .forEach(r => this.updateRow(CONSTANTS.MASTER_TABS.WORKSPACE_ACCESS, r._rowIndex, { Role: role }));
    this.invalidateUserCache(userId);
  },

  removeWorkspaceAccess(userId, workspaceId) {
    const rows = this.findRowsByKey(
      CONSTANTS.MASTER_TABS.WORKSPACE_ACCESS,
      'UserID',
      userId
    );
    const existing = rows.find(r => r.WorkspaceID === workspaceId);
    if (existing) {
      this.updateRow(CONSTANTS.MASTER_TABS.WORKSPACE_ACCESS, existing._rowIndex, {
        Active: false
      });
    }

    // PrimaryWorkspaceID is only a UI/default-selection hint. Keep it synchronized
    // so revoked workspaces are not shown as the user's default workspace.
    const account = this.findAccountById(userId);
    if (account && account.PrimaryWorkspaceID === workspaceId) {
      const replacement = rows.find(r =>
        r.UserID === userId &&
        r.WorkspaceID !== workspaceId &&
        (r.Active === true || r.Active === 'TRUE' || r.Active === 1)
      );
      this.updateAccount(userId, {
        PrimaryWorkspaceID: replacement ? replacement.WorkspaceID : '',
        UpdatedAt: new Date().toISOString(),
        UpdatedBy: 'SYSTEM'
      });
    }
    this.invalidateUserCache(userId);
  },

  /* ------------------- SESSIONS ------------------- */

  getSessionEpoch(userId) {
    const account = this.findAccountById(userId);
    if (!account) return null;
    const epoch = Number(account.SessionEpoch);
    return Number.isInteger(epoch) && epoch > 0 ? epoch : 1;
  },

  bumpSessionEpoch(userId) {
    const lock =
      typeof LockService !== 'undefined' && LockService.getScriptLock
        ? LockService.getScriptLock()
        : null;
    const alreadyHeld = !!(lock && typeof lock.hasLock === 'function' && lock.hasLock());
    let acquiredHere = false;

    if (lock && !alreadyHeld) {
      lock.waitLock(10000);
      acquiredHere = true;
    }

    try {
      const account = this.findAccountById(userId);
      if (!account) throw new AppError(ERROR_CODES.NOT_FOUND, `Account ${userId} not found.`);
      const current = Number(account.SessionEpoch);
      const nextEpoch = (Number.isInteger(current) && current > 0 ? current : 1) + 1;
      this.updateRow(CONSTANTS.MASTER_TABS.ACCOUNTS, account._rowIndex, {
        SessionEpoch: nextEpoch,
        UpdatedAt: new Date().toISOString()
      });
      this.invalidateUserCache(userId);
      return nextEpoch;
    } finally {
      if (acquiredHere) lock.releaseLock();
    }
  },

  createSession(sessionData) {
    return this.appendRow(CONSTANTS.MASTER_TABS.SESSIONS, sessionData);
  },

  findSessionByTokenHashFast(tokenHash) {
    const row = this.findRowByKey(CONSTANTS.MASTER_TABS.SESSIONS, 'TokenHash', tokenHash);
    if (!row) return null;
    const revoked = row.Revoked === true || row.Revoked === 'TRUE' || row.Revoked === 1;
    return revoked ? null : row;
  },

  findSessionByTokenHash(tokenHash) {
    return this.findSessionByTokenHashFast(tokenHash);
  },

  updateSession(sessionId, updates) {
    const s = this.findRowByKey(CONSTANTS.MASTER_TABS.SESSIONS, 'SessionID', sessionId);
    if (s) {
      this.updateRow(CONSTANTS.MASTER_TABS.SESSIONS, s._rowIndex, updates);
      if (
        s.TokenHash &&
        typeof SessionService !== 'undefined' &&
        SessionService._deleteCachedSession
      ) {
        SessionService._deleteCachedSession(s.TokenHash);
      }
    }
  },

  revokeAllUserSessions(userId) {
    // Constant-cost revocation: rotate the account epoch. Existing session rows
    // are made invalid immediately and are physically marked/purged by housekeeping.
    return this.bumpSessionEpoch(userId);
  },

  /* ------------------- REQUESTS ------------------- */

  createRequest(requestData) {
    return this.appendRow(CONSTANTS.MASTER_TABS.REQUESTS, requestData);
  },

  getRequest(requestId) {
    const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.REQUESTS);
    return rows.find(r => r.RequestID === requestId) || null;
  },

  listRequests(statusFilter = null, workspaceId = null) {
    const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.REQUESTS);
    return rows.filter(r => {
      if (statusFilter && r.Status !== statusFilter) return false;
      if (workspaceId && r.WorkspaceID !== workspaceId) return false;
      return true;
    });
  },

  updateRequest(requestId, updates) {
    const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.REQUESTS);
    const req = rows.find(r => r.RequestID === requestId);
    if (!req) throw new AppError(ERROR_CODES.NOT_FOUND, `Request ${requestId} not found.`);
    this.updateRow(CONSTANTS.MASTER_TABS.REQUESTS, req._rowIndex, updates);
    return { ...req, ...updates };
  },

  /* ------------------- AUDIT & SECURITY EVENTS ------------------- */

  logSecurityEvent(eventData) {
    try {
      this.appendRow(CONSTANTS.MASTER_TABS.SECURITY_EVENTS, {
        EventID: Validation.generateId('SEC'),
        Timestamp: new Date().toISOString(),
        UserID: eventData.UserID || '',
        Username: eventData.Username || '',
        EventType: eventData.EventType,
        Success: eventData.Success ? true : false,
        MetadataJSON: eventData.MetadataJSON || (eventData.metadata ? JSON.stringify(eventData.metadata) : '')
      });
    } catch (e) {
      // Do not crash primary execution on audit write failure
      console.error('Failed to write security event: ' + e.message);
    }
  },

  logGlobalAudit(auditData) {
    let auditLock = null;
    let acquiredAuditLock = false;
    try {
      if (typeof LockService !== 'undefined' && LockService.getScriptLock) {
        auditLock = LockService.getScriptLock();
        if (
          auditLock &&
          typeof auditLock.hasLock === 'function' &&
          !auditLock.hasLock()
        ) {
          auditLock.waitLock(10000);
          acquiredAuditLock = true;
        }
      }

      // Refresh the chain head after acquiring the lock so concurrent audit
      // writers cannot legitimately select the same predecessor.
      this._invalidateTable(CONSTANTS.MASTER_TABS.GLOBAL_AUDIT);

      const auditId = Validation.generateId('AUD');
      const timestamp = new Date().toISOString();
      const beforeStr = typeof auditData.BeforeJSON === 'object'
        ? JSON.stringify(auditData.BeforeJSON)
        : (auditData.BeforeJSON || '');
      const afterStr = typeof auditData.AfterJSON === 'object'
        ? JSON.stringify(auditData.AfterJSON)
        : (auditData.AfterJSON || '');

      let prevHash = '0000000000000000000000000000000000000000000000000000000000000000';
      const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.GLOBAL_AUDIT);
      if (rows.length > 0 && rows[rows.length - 1].RecordHash) {
        prevHash = rows[rows.length - 1].RecordHash;
      }

      const record = Validation.sanitizeRow({
        AuditID: auditId,
        TimestampUTC: timestamp,
        ActorUserID: auditData.ActorUserID || '',
        ActorRole: auditData.ActorRole || '',
        WorkspaceID: auditData.WorkspaceID || '',
        EntityType: auditData.EntityType,
        EntityID: auditData.EntityID,
        Action: auditData.Action,
        BeforeJSON: beforeStr,
        AfterJSON: afterStr,
        Reason: auditData.Reason || '',
        CorrelationID: auditData.CorrelationID || '',
        ClientType: auditData.ClientType || 'WEB',
        PreviousHash: prevHash,
        RecordHash: ''
      });
      record.RecordHash = SecurityService.computeAuditRecordHashV2(
        prevHash,
        record,
        record.WorkspaceID
      );

      this.appendRow(CONSTANTS.MASTER_TABS.GLOBAL_AUDIT, record);
      return true;
    } catch (e) {
      console.error('Failed to write global audit: ' + e.message);
      return false;
    } finally {
      if (acquiredAuditLock && auditLock) {
        try { auditLock.releaseLock(); } catch (releaseErr) {}
      }
    }
  },

  /* ------------------- GLOBAL SETTINGS ------------------- */

  getAllGlobalSettings() {
    try {
      const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.GLOBAL_SETTINGS);
      const settings = {};
      for (const r of rows) {
        if (r.SettingKey) {
          settings[r.SettingKey] = r.SettingValue;
        }
      }
      return settings;
    } catch (e) {
      return {};
    }
  },

  getAllGlobalSettingsStrict() {
    const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.GLOBAL_SETTINGS);
    const settings = {};
    for (const r of rows) {
      if (r.SettingKey) settings[r.SettingKey] = r.SettingValue;
    }
    return settings;
  },

  getGlobalSettingStrict(key, defaultValue = '') {
    const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.GLOBAL_SETTINGS);
    const row = rows.find(r => r.SettingKey === key);
    return row ? row.SettingValue : defaultValue;
  },

  getGlobalSetting(key, defaultValue = '') {
    try {
      const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.GLOBAL_SETTINGS);
      const row = rows.find(r => r.SettingKey === key);
      return row ? row.SettingValue : defaultValue;
    } catch (e) {
      return defaultValue;
    }
  },

  setGlobalSetting(key, value, updatedBy = 'SYSTEM', description = '') {
    const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.GLOBAL_SETTINGS);
    const existing = rows.find(r => r.SettingKey === key);
    const now = new Date().toISOString();
    if (existing) {
      this.updateRow(CONSTANTS.MASTER_TABS.GLOBAL_SETTINGS, existing._rowIndex, {
        SettingValue: String(value),
        UpdatedAt: now,
        UpdatedBy: updatedBy
      });
    } else {
      this.appendRow(CONSTANTS.MASTER_TABS.GLOBAL_SETTINGS, {
        SettingKey: key,
        SettingValue: String(value),
        Description: description,
        UpdatedAt: now,
        UpdatedBy: updatedBy
      });
    }
  },

  /* ------------------- SECURITY & ACCOUNT MANAGEMENT ------------------- */

  unlockAccount(userId) {
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const user = this.findAccountById(userId);
      if (!user) throw new AppError(ERROR_CODES.NOT_FOUND, `User ${userId} not found.`);

      if (user.Status === CONSTANTS.ACCOUNT_STATUS.LOCKED) {
        this.updateAccount(userId, {
          Status: CONSTANTS.ACCOUNT_STATUS.ACTIVE,
          UpdatedAt: new Date().toISOString(),
          UpdatedBy: 'SUPER_ADMIN'
        });
      }

      const cred = this.getCredentials(userId);
      if (cred) {
        this.updateCredentials(userId, {
          FailedLoginCount: 0,
          LockUntil: ''
        });
      }

      this.logSecurityEvent({
        UserID: userId,
        Username: user.Username,
        EventType: 'ACCOUNT_UNLOCKED',
        Success: true,
        metadata: { unlockedBy: 'SUPER_ADMIN' }
      });

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }
      return { ok: true, message: `Account for ${user.Username} unlocked.` };
    } finally {
      lock.releaseLock();
    }
  },

  listActiveSessions() {
    try {
      const { rows: sessionRows } = this.getTableData(CONSTANTS.MASTER_TABS.SESSIONS);
      const { rows: accountRows } = this.getTableData(CONSTANTS.MASTER_TABS.ACCOUNTS);
      const userMap = {};
      accountRows.forEach(a => { userMap[a.UserID] = a; });

      const now = Date.now();
      return sessionRows
        .filter(s => {
          if (s.Revoked || new Date(s.ExpiresAt).getTime() <= now) return false;
          const account = userMap[s.UserID];
          if (!account) return false;
          const accountEpoch = Number(account.SessionEpoch) > 0 ? Number(account.SessionEpoch) : 1;
          const sessionEpoch = Number(s.AccountEpoch) > 0 ? Number(s.AccountEpoch) : 1;
          return accountEpoch === sessionEpoch;
        })
        .map(s => {
          const user = userMap[s.UserID] || {};
          return {
            sessionId: s.SessionID,
            userId: s.UserID,
            username: user.Username || 'Unknown',
            displayName: user.DisplayName || 'Unknown',
            role: user.Role || 'USER',
            clientType: s.ClientType || 'WEB',
            createdAt: s.CreatedAt,
            lastSeenAt: s.LastSeenAt,
            expiresAt: s.ExpiresAt
          };
        });
    } catch (e) {
      return [];
    }
  },

  deleteWorkspacePermanent(workspaceId) {
    const { rows: wsRows } = this.getTableData(CONSTANTS.MASTER_TABS.WORKSPACES);
    const ws = wsRows.find(w => w.WorkspaceID === workspaceId);
    if (!ws) throw new AppError(ERROR_CODES.NOT_FOUND, `Workspace ${workspaceId} not found.`);

    // Archive / flag deleted in Master
    this.updateRow(CONSTANTS.MASTER_TABS.WORKSPACES, ws._rowIndex, {
      Status: CONSTANTS.WORKSPACE_STATUS.ARCHIVED,
      ArchivedAt: new Date().toISOString()
    });
    if (typeof WorkspaceRouter !== 'undefined' && WorkspaceRouter.clearCache) {
      WorkspaceRouter.clearCache();
    }

    return { ok: true, message: `Workspace ${workspaceId} permanently archived and unlinked.` };
  }
};

