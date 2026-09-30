/** Privacy operations and assurance evidence. These records do not certify compliance. */
var PrivacyService = {
  requestTypes: ['ACCESS', 'RECTIFICATION', 'ERASURE', 'RESTRICTION', 'PORTABILITY', 'OBJECTION'],
  controls: [
    { id: 'ACCESS', title: 'Access and MFA review', reference: 'SOC 2 CC6; GDPR Art. 32' },
    { id: 'CHANGE', title: 'Reviewed changes and release tests', reference: 'SOC 2 CC8' },
    { id: 'RECOVERY', title: 'Backup restore drill and recovery objectives', reference: 'SOC 2 A1; GDPR Art. 32' },
    { id: 'INCIDENT', title: 'Incident response and breach procedure', reference: 'SOC 2 CC7; GDPR Arts. 33–34' },
    { id: 'PROCESSING', title: 'Processing register, lawful basis and DPIA review', reference: 'GDPR Arts. 6, 30, 35' },
    { id: 'VENDORS', title: 'Google contract, subprocessors and transfers', reference: 'SOC 2 CC9; GDPR Arts. 28, 44–49' },
    { id: 'RETENTION', title: 'Retention, erasure and backup expiry review', reference: 'GDPR Arts. 5, 17, 25' }
  ],
  _text(value, name, max = 2000, required = true) {
    if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, name + ' must be bounded text.', 400);
    }
    return value.trim();
  },
  _url(value) {
    const text = this._text(value, 'Evidence URL', 1000);
    if (!/^https:\/\/[a-z0-9][a-z0-9.-]*(?::443)?(?:[/?#][^\s]*)?$/i.test(text)) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Use an HTTPS URL without embedded credentials.', 400);
    }
    return text;
  },
  _root(context) { AuthorizationService.assertRole(context, [CONSTANTS.ROLES.SUPER_ADMIN]); },
  _lock(operation) {
    const lock = LockService.getScriptLock(); lock.waitLock(10000);
    try { return operation(); } finally { lock.releaseLock(); }
  },
  _audit(context, id, action) {
    try { return MasterRepository.logGlobalAudit({ ActorUserID: context.userId, ActorRole: context.role,
      EntityType: 'PRIVACY', EntityID: id, Action: action }) === true; }
    catch (error) { console.error('Privacy record committed but audit logging failed.'); return false; }
  },
  _sheet(tab) {
    const sheet = MasterRepository.getMasterSpreadsheet().getSheetByName(tab);
    if (!sheet) throw new AppError(ERROR_CODES.CONFLICT, 'The owner must initialize Privacy & Assurance first.', 409);
    const headers = sheet.getRange(1, 1, 1, MASTER_SCHEMA[tab].length).getValues()[0];
    if (headers.some((value, i) => value !== MASTER_SCHEMA[tab][i])) {
      throw new AppError(ERROR_CODES.CONFLICT, 'Privacy schema differs from the expected headers. Review it before continuing.', 409);
    }
    return sheet;
  },
  initialize(context) {
    this._root(context);
    return this._lock(() => {
      const ss = MasterRepository.getMasterSpreadsheet();
      for (const tab of ['PrivacyRequests', 'ControlEvidence']) {
        if (!ss.getSheetByName(tab)) ss.insertSheet(tab).getRange(1, 1, 1, MASTER_SCHEMA[tab].length).setValues([MASTER_SCHEMA[tab]]);
        this._sheet(tab);
      }
      return { initialized: true, auditRecorded: this._audit(context, 'REGISTRY', 'PRIVACY_INITIALIZED') };
    });
  },
  getNotice() {
    const raw = MasterRepository.getGlobalSettingStrict('PRIVACY_NOTICE_JSON', '');
    let policy = null;
    if (raw) {
      try {
        policy = JSON.parse(raw);
        for (const key of ['controller', 'privacyContact', 'purpose', 'lawfulBasis', 'dataCategories', 'retentionPolicy', 'version']) this._text(policy[key], key);
        policy.noticeUrl = this._url(policy.noticeUrl);
      } catch (e) { throw new AppError(ERROR_CODES.CONFLICT, 'Stored privacy notice is invalid.', 409); }
    }
    return { configured: !!policy, policy };
  },
  saveNotice(context, payload) {
    this._root(context);
    const policy = {};
    for (const key of ['controller', 'privacyContact', 'purpose', 'lawfulBasis', 'dataCategories', 'retentionPolicy']) {
      policy[key] = this._text(payload[key], key);
    }
    policy.noticeUrl = this._url(payload.noticeUrl);
    policy.version = this._text(payload.version, 'Notice version', 100);
    policy.updatedAt = new Date().toISOString();
    return this._lock(() => {
      MasterRepository.setGlobalSetting('PRIVACY_NOTICE_JSON', JSON.stringify(policy), context.userId);
      return { configured: true, policy, auditRecorded: this._audit(context, policy.version, 'PRIVACY_NOTICE_UPDATED') };
    });
  },
  // One calendar month, clamped to the last day of the destination month.
  responseDueAt(iso) {
    const date = new Date(iso), day = date.getUTCDate();
    date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + 1);
    const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, last)); return date.toISOString();
  },
  submit(context, payload) {
    const type = payload.type;
    if (!this.requestTypes.includes(type)) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Unsupported privacy request type.', 400);
    const operationId = this._text(payload.operationId, 'Operation ID', 100);
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(operationId)) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Invalid operation ID.', 400);
    const detail = this._text(payload.detail, 'Request detail', 2000);
    return this._lock(() => {
      this._sheet('PrivacyRequests');
      const id = 'PRV_' + context.userId + '_' + operationId;
      const existing = MasterRepository.findRowByKey('PrivacyRequests', 'RequestID', id);
      if (existing) {
        if (existing.UserID !== context.userId || existing.Type !== type || (existing.Detail !== detail && existing.Detail !== Validation.sanitizeCellValue(detail))) {
          throw new AppError(ERROR_CODES.CONFLICT, 'Operation ID already belongs to a different request.', 409);
        }
        return { request: this._dto(existing), replayed: true };
      }
      const now = new Date().toISOString();
      const record = { RequestID: id, UserID: context.userId, Type: type, Detail: detail,
        Status: 'PENDING', RequestedAt: now, DueAt: this.responseDueAt(now), Version: 1 };
      MasterRepository.appendRow('PrivacyRequests', record);
      return { request: this._dto(record), replayed: false, auditRecorded: this._audit(context, id, 'PRIVACY_REQUEST_SUBMITTED') };
    });
  },
  _dto(record) {
    const dto = {}; for (const key of MASTER_SCHEMA.PrivacyRequests) dto[key] = record[key] === undefined ? '' : record[key];
    return dto;
  },
  list(context, payload = {}) {
    const sheet = this._sheet('PrivacyRequests'), last = sheet.getLastRow();
    const before = payload.before === undefined ? last + 1 : Number(payload.before);
    if (!Number.isInteger(before) || before < 2 || before > last + 1) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Invalid page cursor.', 400);
    const end = before - 1, start = Math.max(2, end - 199);
    const values = end >= start ? sheet.getRange(start, 1, end - start + 1, MASTER_SCHEMA.PrivacyRequests.length).getValues() : [];
    const records = values.reverse().map(row => Object.fromEntries(MASTER_SCHEMA.PrivacyRequests.map((key, i) => [key, row[i]])));
    return { requests: records.filter(row => context.role === CONSTANTS.ROLES.SUPER_ADMIN || row.UserID === context.userId), nextBefore: start > 2 ? start : null };
  },
  review(context, payload) {
    this._root(context);
    const id = this._text(payload.requestId, 'Request ID', 250);
    if (!['IN_REVIEW', 'CLOSED'].includes(payload.status)) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Invalid review status.', 400);
    const response = this._text(payload.response, 'Response');
    const evidenceUrl = this._url(payload.evidenceUrl);
    return this._lock(() => {
      this._sheet('PrivacyRequests');
      const row = MasterRepository.findRowByKey('PrivacyRequests', 'RequestID', id);
      if (!row) throw new AppError(ERROR_CODES.NOT_FOUND, 'Privacy request not found.', 404);
      if (row.Status === 'CLOSED' || !Number.isInteger(payload.version) || Number(row.Version) !== payload.version) {
        throw new AppError(ERROR_CODES.CONFLICT, 'Request changed or was closed. Reload before recording a decision.', 409);
      }
      const changes = { Status: payload.status, Response: response, EvidenceURL: evidenceUrl,
        ReviewedBy: context.userId, ReviewedAt: new Date().toISOString(), Version: Number(row.Version) + 1 };
      MasterRepository.updateRow('PrivacyRequests', row._rowIndex, changes);
      return { request: this._dto({ ...row, ...changes }), auditRecorded: this._audit(context, id, 'PRIVACY_REQUEST_' + payload.status) };
    });
  },
  assurance(context) {
    this._root(context); this._sheet('ControlEvidence');
    const records = MasterRepository.getTableData('ControlEvidence').rows;
    return { assessment: 'NOT_ASSESSED', controls: this.controls.map(control => {
      const row = records.find(record => record.ControlID === control.id);
      return { ...control, evidence: row ? { owner: row.Owner, url: row.EvidenceURL, reviewedAt: row.ReviewedAt, nextReviewAt: row.NextReviewAt, notes: row.Notes } : null,
        state: !row ? 'MISSING_EVIDENCE' : new Date(row.NextReviewAt).getTime() <= Date.now() ? 'REVIEW_OVERDUE' : 'RECORDED_UNVERIFIED' };
    }) };
  },
  saveEvidence(context, payload) {
    this._root(context);
    if (!this.controls.some(control => control.id === payload.controlId)) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Unknown control.', 400);
    const next = this._text(payload.nextReviewAt, 'Next review date', 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(next) || !Number.isFinite(new Date(next).getTime()) || new Date(next).toISOString().slice(0, 10) !== next) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Use a valid review date, YYYY-MM-DD.', 400);
    }
    const record = { ControlID: payload.controlId, Owner: this._text(payload.owner, 'Control owner', 200), EvidenceURL: this._url(payload.evidenceUrl),
      Notes: this._text(payload.notes, 'Review notes'), ReviewedAt: new Date().toISOString(), ReviewedBy: context.userId, NextReviewAt: next };
    return this._lock(() => {
      this._sheet('ControlEvidence');
      const existing = MasterRepository.findRowByKey('ControlEvidence', 'ControlID', record.ControlID);
      if (existing) MasterRepository.updateRow('ControlEvidence', existing._rowIndex, record);
      else MasterRepository.appendRow('ControlEvidence', record);
      return { recorded: true, auditRecorded: this._audit(context, record.ControlID, 'ASSURANCE_EVIDENCE_RECORDED') };
    });
  }
};
