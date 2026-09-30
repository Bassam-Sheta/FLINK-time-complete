/* ===== AuthService.gs ===== */
/**
 * FLINK Time & Workforce Platform — Authentication Service
 * Manages user authentication, lockout protection (5 attempts / 15 min),
 * password changes, administrative resets, and session issuance.
 */

var AuthService = (typeof global !== 'undefined' && global.AuthService) || {
  _mfaChallengeMemory: {},
  _mfaEnrollmentMemory: {},
  _stepUpMemory: {},
  _reauthMemory: {},
  _mfaSessionMemory: {},

  _googleMode() { return CONSTANTS.AUTH_MODE === 'GOOGLE'; },

  _writeSecurityProperty(key, serialized) {
    const bytes = value => unescape(encodeURIComponent(String(value))).length;
    if (bytes(serialized) > 8000) throw new AppError(ERROR_CODES.SERVER_BUSY, 'Security state exceeds its safe size limit.', 503);
    return this._withLoginStateLock(() => {
      const props = PropertiesService.getScriptProperties();
      // All real Apps Script stores expose getProperties. Minimal local adapters
      // may omit it; quota admission is exercised separately with a full adapter.
      if (typeof props.getProperties === 'function') {
        const all = props.getProperties(); let size = 0;
        for (const [name, value] of Object.entries(all)) size += bytes(name) + bytes(value);
        if (size > 350000) {
          for (const [name, value] of Object.entries(all)) {
            if (!/^FLINK_(?:MFA_SESSION|MFA_CHALLENGE|MFA_ENROLLMENT|STEP_UP|REAUTH)_/.test(name)) continue;
            let expires = NaN; try { expires = Number(JSON.parse(value).expiresAtMs); } catch (e) {}
            if (!Number.isFinite(expires) || expires <= Date.now()) {
              props.deleteProperty(name); size -= bytes(name) + bytes(value); delete all[name];
            }
          }
        }
        const replaced = Object.hasOwn(all, key) ? bytes(key) + bytes(all[key]) : 0;
        if (size - replaced + bytes(key) + bytes(serialized) > 400000) {
          throw new AppError(ERROR_CODES.SERVER_BUSY, 'Security state is near capacity. Ask the owner to run housekeeping before signing in again.', 503);
        }
      }
      props.setProperty(key, serialized);
    });
  },

  _verifyPrimaryIdentity(context, password, credentials) {
    if (!credentials) return false;
    if (!this._googleMode()) return SecurityService.verifyPassword(password, credentials.PasswordHash);
    IdentityService.assertAccountIdentity(context.user || MasterRepository.findAccountById(context.userId), 'WEB');
    return true;
  },

  _markMfaSession(session, userId) {
    if (!this._googleMode()) return;
    const key = 'FLINK_MFA_SESSION_' + session.sessionId;
    const record = JSON.stringify({ userId, expiresAtMs: Date.now() + CONSTANTS.LIMITS.SESSION_ABSOLUTE_TIMEOUT_HOURS * 3600000 });
    if (typeof PropertiesService !== 'undefined') this._writeSecurityProperty(key, record);
    else this._mfaSessionMemory[key] = record;
  },

  hasVerifiedMfaSession(context) {
    if (!this._googleMode()) return true;
    const key = 'FLINK_MFA_SESSION_' + (context.session && context.session.SessionID);
    const raw = typeof PropertiesService !== 'undefined'
      ? PropertiesService.getScriptProperties().getProperty(key) : this._mfaSessionMemory[key];
    let record;
    try { record = JSON.parse(raw || 'null'); } catch (e) { return false; }
    return !!(record && record.userId === context.userId && Number(record.expiresAtMs) > Date.now());
  },

  _loginGoogle(clientType = 'WEB') {
    if (!['WEB', 'SETUP_WIZARD'].includes(String(clientType || 'WEB').toUpperCase())) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Unsupported sign-in channel.', 401);
    }
    const email = IdentityService.getCurrentGoogleEmail(true);
    this._enforceLoginRateLimit(email);
    return this._withLoginStateLock(() => {
      const rows = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.ACCOUNTS).rows;
      const matches = rows.filter(row => IdentityService.normalizeEmail(row.Email) === email && row.Status !== CONSTANTS.ACCOUNT_STATUS.DELETED);
      if (matches.length !== 1) {
        throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Your Google account has no unique active FLINK account. Contact your administrator.', 401);
      }
      const account = matches[0];
      IdentityService.assertAccountIdentity(account, clientType);
      const cred = MasterRepository.getCredentials(account.UserID);
      if (!cred) throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Account security configuration is unavailable.', 401);
      const lockUntil = cred.LockUntil ? new Date(cred.LockUntil).getTime() : NaN;
      if (account.Status === CONSTANTS.ACCOUNT_STATUS.LOCKED && Number.isFinite(lockUntil) && lockUntil <= Date.now()) {
        MasterRepository.updateAccount(account.UserID, { Status: CONSTANTS.ACCOUNT_STATUS.ACTIVE });
        MasterRepository.updateCredentials(account.UserID, { LockUntil: '', FailedLoginCount: 0, LastFailedAt: '' });
        account.Status = CONSTANTS.ACCOUNT_STATUS.ACTIVE;
      }
      if (account.Status !== CONSTANTS.ACCOUNT_STATUS.ACTIVE) throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'FLINK account is inactive or locked.', 401);
      if (cred.LockUntil && new Date(cred.LockUntil).getTime() > Date.now()) {
        throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Account verification is temporarily locked.', 429);
      }
      // Retire old app password material as this account migrates. Google is the only primary identity provider.
      if (cred.PasswordHash || account.MustChangePassword === true || account.MustChangePassword === 'TRUE') {
        MasterRepository.updateCredentials(account.UserID, { PasswordHash: '', ResetIssuedAt: '', ResetExpiresAt: '' });
        MasterRepository.updateAccount(account.UserID, { MustChangePassword: false });
      }
      if (cred.MfaEnabled === true || cred.MfaEnabled === 'TRUE') {
        if (!cred.TotpSecret) throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Account MFA configuration is unavailable.', 401);
        if (!String(cred.TotpSecret).startsWith('enc$v2$')) {
          const upgraded = SecurityService.encryptSecret(SecurityService.decryptSecret(cred.TotpSecret));
          MasterRepository.updateCredentials(account.UserID, { TotpSecret: upgraded });
          cred.TotpSecret = upgraded;
        }
        const timestamp = Date.now();
        const sig = SecurityService.hashToken(`${account.UserID}|${timestamp}|${SecurityService.getPepper()}`).substring(0, 16);
        const mfaChallengeToken = `MFA_${account.UserID}_${timestamp}_${sig}`;
        this._storeMfaChallenge(account.UserID, mfaChallengeToken, timestamp + 300000, email);
        return { mfaRequired: true, mfaChallengeToken };
      }
      const session = SessionService.createSession(account.UserID, clientType, email);
      return { ...session, mfaEnrollmentRequired: true, user: {
        userId: account.UserID, username: account.Username, displayName: account.DisplayName,
        role: account.Role, status: account.Status, email, mustChangePassword: false
      }};
    });
  },

  _consumeReauthAttempt(authContext, password, code = '') {
    if (!authContext || !authContext.userId) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Authentication required.', 401);
    }
    if ((password !== undefined && (typeof password !== 'string' || password.length > 1024)) ||
        typeof code !== 'string' || code.length > 6) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Invalid reauthentication input.', 400);
    }
    const key = 'FLINK_REAUTH_' + SecurityService.hashToken(String(authContext.userId));
    const props = typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties
      ? PropertiesService.getScriptProperties() : null;
    const raw = props ? props.getProperty(key) : this._reauthMemory[key];
    let record;
    try { record = raw ? JSON.parse(raw) : null; } catch (e) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, 'Reauthentication limiter unavailable.', 503);
    }
    const now = Date.now();
    if (record && (!Number.isInteger(record.attempts) || record.attempts < 0 || !Number.isFinite(Number(record.expiresAtMs)))) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, 'Reauthentication limiter unavailable.', 503);
    }
    if (!record || now >= Number(record.expiresAtMs)) record = { attempts: 0, expiresAtMs: now + 900000 };
    if (record.attempts >= 10) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Too many verification attempts. Try again in 15 minutes.', 429);
    }
    record.attempts += 1;
    const serialized = JSON.stringify(record);
    if (props) this._writeSecurityProperty(key, serialized);
    else this._reauthMemory[key] = serialized;
  },

  _mfaChallengePropertyKey(userId) {
    return 'FLINK_MFA_CHALLENGE_' + String(userId || '').replace(/[^A-Za-z0-9_-]/g, '');
  },

  _storeMfaChallenge(userId, challengeToken, expiresAtMs, googleEmail = '') {
    const record = JSON.stringify({
      tokenHash: SecurityService.hashToken(challengeToken),
      expiresAtMs: Number(expiresAtMs),
      googleEmail: IdentityService.normalizeEmail(googleEmail)
    });

    if (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties) {
      this._writeSecurityProperty(this._mfaChallengePropertyKey(userId), record);
      return;
    }

    // Local/unit-test fallback only.
    this._mfaChallengeMemory[userId] = record;
  },

  _getMfaChallenge(userId) {
    let raw = '';
    if (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties) {
      raw = PropertiesService
        .getScriptProperties()
        .getProperty(this._mfaChallengePropertyKey(userId)) || '';
    } else {
      raw = this._mfaChallengeMemory[userId] || '';
    }

    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  },

  _deleteMfaChallenge(userId) {
    if (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties) {
      PropertiesService
        .getScriptProperties()
        .deleteProperty(this._mfaChallengePropertyKey(userId));
    } else {
      delete this._mfaChallengeMemory[userId];
    }
  },

  _mfaEnrollmentPropertyKey(userId) {
    return 'FLINK_MFA_ENROLLMENT_' + String(userId || '').replace(/[^A-Za-z0-9_-]/g, '');
  },

  _storeMfaEnrollment(userId, record) {
    const serialized = JSON.stringify(record || {});
    if (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties) {
      this._writeSecurityProperty(
        this._mfaEnrollmentPropertyKey(userId),
        serialized
      );
    } else {
      this._mfaEnrollmentMemory[userId] = serialized;
    }
  },

  _getMfaEnrollment(userId) {
    let raw = '';
    if (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties) {
      raw = PropertiesService.getScriptProperties().getProperty(
        this._mfaEnrollmentPropertyKey(userId)
      ) || '';
    } else {
      raw = this._mfaEnrollmentMemory[userId] || '';
    }
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  },

  _deleteMfaEnrollment(userId) {
    if (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties) {
      PropertiesService.getScriptProperties().deleteProperty(
        this._mfaEnrollmentPropertyKey(userId)
      );
    } else {
      delete this._mfaEnrollmentMemory[userId];
    }
  },

  _stepUpPropertyKey(sessionId) {
    return 'FLINK_STEP_UP_' + String(sessionId || '').replace(/[^A-Za-z0-9_-]/g, '');
  },

  _storeStepUp(sessionId, record) {
    const serialized = JSON.stringify(record || {});
    if (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties) {
      this._writeSecurityProperty(this._stepUpPropertyKey(sessionId), serialized);
    } else {
      this._stepUpMemory[sessionId] = serialized;
    }
  },

  _getStepUp(sessionId) {
    let raw = '';
    if (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties) {
      raw = PropertiesService.getScriptProperties().getProperty(this._stepUpPropertyKey(sessionId)) || '';
    } else {
      raw = this._stepUpMemory[sessionId] || '';
    }
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  },

  _deleteStepUp(sessionId) {
    if (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties) {
      PropertiesService.getScriptProperties().deleteProperty(this._stepUpPropertyKey(sessionId));
    } else {
      delete this._stepUpMemory[sessionId];
    }
  },

  _withLoginStateLock(fn) {
    if (
      typeof LockService === 'undefined' ||
      !LockService.getScriptLock
    ) {
      return fn();
    }

    const lock = LockService.getScriptLock();
    if (!lock || typeof lock.hasLock !== 'function') {
      // Unit-test/non-Apps-Script adapters may not implement hasLock().
      return fn();
    }
    if (lock.hasLock()) return fn();

    lock.waitLock(5000);
    try {
      return fn();
    } finally {
      try { lock.releaseLock(); } catch (e) {}
    }
  },

  _enforceLoginRateLimit(googleEmail) {
    if (
      typeof CacheService === 'undefined' ||
      !CacheService.getScriptCache
    ) {
      return;
    }

    try {
      const cache = CacheService.getScriptCache();
      if (!cache || !cache.get || !cache.put) return;

      const minuteBucket = Math.floor(Date.now() / 60000);
      const identityKey = SecurityService
        .hashToken(IdentityService.normalizeEmail(googleEmail || 'unknown'))
        .substring(0, 20);
      const callerKey = `FLINK_LOGIN_CALLER_${identityKey}_${minuteBucket}`;
      const globalKey = `FLINK_LOGIN_GLOBAL_${minuteBucket}`;

      const updateCounters = () => {
        const callerCount = (parseInt(cache.get(callerKey), 10) || 0) + 1;
        cache.put(callerKey, String(callerCount), 120);

        if (
          callerCount >
            (CONSTANTS.LIMITS.LOGIN_CALLER_ATTEMPTS_PER_MINUTE || 30)
        ) {
          throw new AppError(
            ERROR_CODES.AUTH_REQUIRED,
            'Invalid username or password.',
            401
          );
        }

        const globalCount = (parseInt(cache.get(globalKey), 10) || 0) + 1;
        cache.put(globalKey, String(globalCount), 120);
        if (
          globalCount >
            (CONSTANTS.LIMITS.LOGIN_GLOBAL_ATTEMPTS_PER_MINUTE || 1000)
        ) {
          throw new AppError(
            ERROR_CODES.AUTH_REQUIRED,
            'Invalid username or password.',
            401
          );
        }
      };

      // CacheService has no atomic increment. Serialize this tiny counter update
      // when the real Apps Script Lock API is available.
      if (typeof LockService !== 'undefined' && LockService.getScriptLock) {
        const lock = LockService.getScriptLock();
        if (lock && typeof lock.hasLock === 'function' && !lock.hasLock()) {
          lock.waitLock(2000);
          try {
            updateCounters();
          } finally {
            try { lock.releaseLock(); } catch (e) {}
          }
          return;
        }
      }
      updateCounters();
    } catch (err) {
      if (err instanceof AppError) throw err;
      // Cache/rate-limit infrastructure failure must not disclose internals.
      console.warn('Login rate-limit cache unavailable: ' + err.message);
    }
  },

  _shouldLogRejectedLogin(keyMaterial) {
    if (
      typeof CacheService === 'undefined' ||
      !CacheService.getScriptCache
    ) {
      return true;
    }
    try {
      const cache = CacheService.getScriptCache();
      const bucket = Math.floor(Date.now() / 60000);
      const digest = SecurityService.hashToken(String(keyMaterial || '')).substring(0, 20);
      const key = `FLINK_LOGIN_EVENT_${digest}_${bucket}`;
      if (cache.get(key)) return false;
      cache.put(key, '1', 120);
      return true;
    } catch (e) {
      return true;
    }
  },

  /**
   * Authenticates user with username and password
   */
  login(username, password, clientType = 'WEB') {
    if (this._googleMode()) return this._loginGoogle(clientType);
    const invalidAuth = () => new AppError(
      ERROR_CODES.AUTH_REQUIRED,
      'Invalid username or password.',
      401
    );

    if (
      typeof username !== 'string' ||
      typeof password !== 'string' ||
      !username ||
      !password ||
      username.length > 50 ||
      password.length > (CONSTANTS.LIMITS.MAX_PASSWORD_LENGTH || 128)
    ) {
      throw invalidAuth();
    }

    const normalizedClientType = String(clientType || 'WEB').toUpperCase();
    if (
      normalizedClientType !== 'WEB' &&
      normalizedClientType !== 'SETUP_WIZARD'
    ) {
      throw invalidAuth();
    }
    const cleanUsername = String(username).trim().toLowerCase();

    // WEB authentication is always bound to the server-observed Google account.
    // This is deliberately resolved before FLINK credential validation so the
    // browser cannot self-assert an email in the request body.
    let googleEmail = '';
    if (normalizedClientType === 'WEB' || normalizedClientType === 'SETUP_WIZARD') {
      googleEmail = IdentityService.getCurrentGoogleEmail(true);
    }
    this._enforceLoginRateLimit(googleEmail);

    let account = MasterRepository.findAccountByUsername(cleanUsername);
    if (!account) {
      if (this._shouldLogRejectedLogin('UNKNOWN|' + googleEmail + '|' + cleanUsername)) {
        MasterRepository.logSecurityEvent({
          Username: cleanUsername,
          EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_FAIL,
          Success: false,
          metadata: {
            reason: 'User not found',
            googleIdentity: googleEmail || ''
          }
        });
      }
      throw invalidAuth();
    }

    try {
      googleEmail = IdentityService.assertAccountIdentity(
        account,
        normalizedClientType
      ) || googleEmail;
    } catch (identityErr) {
      MasterRepository.logSecurityEvent({
        UserID: account.UserID,
        Username: account.Username,
        EventType: CONSTANTS.AUDIT_EVENTS.IDENTITY_MISMATCH,
        Success: false,
        metadata: {
          reason: 'Google Workspace identity mismatch',
          observedGoogleIdentity: googleEmail || ''
        }
      });
      throw invalidAuth();
    }

    let cred = MasterRepository.getCredentials(account.UserID);
    if (!cred) {
      MasterRepository.logSecurityEvent({
        UserID: account.UserID,
        Username: account.Username,
        EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_FAIL,
        Success: false,
        metadata: { reason: 'Credentials row missing' }
      });
      throw invalidAuth();
    }

    const now = Date.now();
    const resetExpiresAtMs = cred.ResetExpiresAt
      ? new Date(cred.ResetExpiresAt).getTime()
      : NaN;
    const mustChangePassword =
      account.MustChangePassword === true ||
      account.MustChangePassword === 'TRUE';
    if (
      mustChangePassword &&
      Number.isFinite(resetExpiresAtMs) &&
      resetExpiresAtMs <= now
    ) {
      MasterRepository.logSecurityEvent({
        UserID: account.UserID,
        Username: account.Username,
        EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_FAIL,
        Success: false,
        metadata: { reason: 'Temporary password expired' }
      });
      throw invalidAuth();
    }

    const lockUntilMs = cred.LockUntil
      ? new Date(cred.LockUntil).getTime()
      : NaN;

    // A timed lock can auto-expire. A LOCKED account without a valid LockUntil
    // is treated as an administrative lock and never auto-unlocks here.
    if (
      Number.isFinite(lockUntilMs) &&
      lockUntilMs <= now &&
      account.Status === CONSTANTS.ACCOUNT_STATUS.LOCKED
    ) {
      MasterRepository.updateAccount(account.UserID, {
        Status: CONSTANTS.ACCOUNT_STATUS.ACTIVE
      });
      MasterRepository.updateCredentials(account.UserID, {
        FailedLoginCount: 0,
        LastFailedAt: '',
        LockUntil: ''
      });
      account.Status = CONSTANTS.ACCOUNT_STATUS.ACTIVE;
      cred.FailedLoginCount = 0;
      cred.LastFailedAt = '';
      cred.LockUntil = '';
    }

    if (
      account.Status === CONSTANTS.ACCOUNT_STATUS.LOCKED ||
      (Number.isFinite(lockUntilMs) && lockUntilMs > now)
    ) {
      MasterRepository.logSecurityEvent({
        UserID: account.UserID,
        Username: account.Username,
        EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_FAIL,
        Success: false,
        metadata: {
          reason: 'Attempt while account locked',
          lockUntil: cred.LockUntil || ''
        }
      });
      throw invalidAuth();
    }

    if (account.Status !== CONSTANTS.ACCOUNT_STATUS.ACTIVE) {
      MasterRepository.logSecurityEvent({
        UserID: account.UserID,
        Username: account.Username,
        EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_FAIL,
        Success: false,
        metadata: {
          reason: 'Inactive account',
          accountStatus: account.Status
        }
      });
      throw invalidAuth();
    }

    // Graduated retry throttle after failed password attempts. No sleep is used;
    // Apps Script execution time is preserved and the caller must retry later.
    const failedCount = parseInt(cred.FailedLoginCount, 10) || 0;
    const retrySchedule = Array.isArray(CONSTANTS.LIMITS.LOGIN_RETRY_DELAYS_SECONDS)
      ? CONSTANTS.LIMITS.LOGIN_RETRY_DELAYS_SECONDS
      : [0, 2, 5, 15, 30];
    const delaySeconds = retrySchedule[
      Math.min(failedCount, retrySchedule.length - 1)
    ] || 0;
    const lastFailedMs = cred.LastFailedAt
      ? new Date(cred.LastFailedAt).getTime()
      : NaN;

    if (
      failedCount > 0 &&
      delaySeconds > 0 &&
      Number.isFinite(lastFailedMs) &&
      now < lastFailedMs + delaySeconds * 1000
    ) {
      if (this._shouldLogRejectedLogin('THROTTLED|' + account.UserID)) {
        MasterRepository.logSecurityEvent({
          UserID: account.UserID,
          Username: account.Username,
          EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_THROTTLED,
          Success: false,
          metadata: {
            failedAttempts: failedCount,
            delaySeconds,
            retryAfterMs: Math.max(
              0,
              lastFailedMs + delaySeconds * 1000 - now
            )
          }
        });
      }
      throw invalidAuth();
    }

    const isValid = SecurityService.verifyPassword(
      password,
      cred.PasswordHash
    );

    if (!isValid) {
      return this._withLoginStateLock(() => {
        if (MasterRepository._invalidateTable) {
          MasterRepository._invalidateTable(CONSTANTS.MASTER_TABS.CREDENTIALS);
          MasterRepository._invalidateTable(CONSTANTS.MASTER_TABS.ACCOUNTS);
        }
        const latestCred = MasterRepository.getCredentials(account.UserID);
        const latestAccount = MasterRepository.findAccountById(account.UserID);
        if (!latestCred || !latestAccount) throw invalidAuth();

        // If credentials changed after the expensive password check, do not
        // mutate counters based on stale authentication state.
        if (String(latestCred.PasswordHash) !== String(cred.PasswordHash)) {
          throw invalidAuth();
        }

        const latestLockUntilMs = latestCred.LockUntil
          ? new Date(latestCred.LockUntil).getTime()
          : NaN;
        if (
          latestAccount.Status === CONSTANTS.ACCOUNT_STATUS.LOCKED ||
          (Number.isFinite(latestLockUntilMs) && latestLockUntilMs > Date.now())
        ) {
          throw invalidAuth();
        }

        const latestFailedCount =
          parseInt(latestCred.FailedLoginCount, 10) || 0;
        const newFailedCount = latestFailedCount + 1;
        const failedAt = new Date().toISOString();
        const updates = {
          FailedLoginCount: newFailedCount,
          LastFailedAt: failedAt
        };

        if (newFailedCount >= CONSTANTS.LIMITS.MAX_FAILED_LOGIN_ATTEMPTS) {
          const lockUntil = new Date(
            Date.now() +
            CONSTANTS.LIMITS.LOCKOUT_DURATION_MINUTES * 60 * 1000
          ).toISOString();
          updates.LockUntil = lockUntil;
          MasterRepository.updateAccount(account.UserID, {
            Status: CONSTANTS.ACCOUNT_STATUS.LOCKED
          });

          MasterRepository.logSecurityEvent({
            UserID: account.UserID,
            Username: account.Username,
            EventType: CONSTANTS.AUDIT_EVENTS.ACCOUNT_LOCK,
            Success: false,
            metadata: {
              failedAttempts: newFailedCount,
              lockUntil
            }
          });
        }

        MasterRepository.updateCredentials(account.UserID, updates);
        MasterRepository.logSecurityEvent({
          UserID: account.UserID,
          Username: account.Username,
          EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_FAIL,
          Success: false,
          metadata: {
            reason: 'Invalid password',
            failedAttempts: newFailedCount
          }
        });

        throw invalidAuth();
      });
    }

    // Re-read the authentication state atomically. MFA-enabled accounts are
    // not fully authenticated until the second factor succeeds, so failure
    // counters must not be cleared at the password-only stage.
    this._withLoginStateLock(() => {
      if (MasterRepository._invalidateTable) {
        MasterRepository._invalidateTable(CONSTANTS.MASTER_TABS.CREDENTIALS);
        MasterRepository._invalidateTable(CONSTANTS.MASTER_TABS.ACCOUNTS);
      }
      const latestCred = MasterRepository.getCredentials(account.UserID);
      const latestAccount = MasterRepository.findAccountById(account.UserID);
      if (
        !latestCred ||
        !latestAccount ||
        latestAccount.Status !== CONSTANTS.ACCOUNT_STATUS.ACTIVE ||
        String(latestCred.PasswordHash) !== String(cred.PasswordHash)
      ) {
        throw invalidAuth();
      }

      cred = latestCred;
      account = latestAccount;
    });

    if (cred.MfaEnabled === true || cred.MfaEnabled === 'TRUE') {
      const timestamp = Date.now();
      const sig = SecurityService
        .hashToken(
          `${account.UserID}|${timestamp}|${SecurityService.getPepper()}`
        )
        .substring(0, 16);
      const mfaChallengeToken =
        `MFA_${account.UserID}_${timestamp}_${sig}`;
      this._storeMfaChallenge(
        account.UserID,
        mfaChallengeToken,
        timestamp + 5 * 60 * 1000,
        googleEmail
      );

      MasterRepository.logSecurityEvent({
        UserID: account.UserID,
        Username: account.Username,
        EventType: 'MFA_CHALLENGE_ISSUED',
        Success: true,
        metadata: {
          clientType: normalizedClientType,
          googleIdentity: googleEmail || ''
        }
      });

      return {
        mfaRequired: true,
        mfaChallengeToken,
        userId: account.UserID,
        clientType: normalizedClientType
      };
    }

    MasterRepository.updateCredentials(account.UserID, {
      FailedLoginCount: 0,
      LastFailedAt: '',
      LockUntil: ''
    });

    MasterRepository.updateAccount(account.UserID, {
      LastLoginAt: new Date().toISOString()
    });

    MasterRepository.logSecurityEvent({
      UserID: account.UserID,
      Username: account.Username,
      EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_SUCCESS,
      Success: true,
      metadata: {
        clientType: normalizedClientType,
        mfa: false,
        googleIdentity: googleEmail || ''
      }
    });

    const sessionData = SessionService.createSession(
      account.UserID,
      normalizedClientType,
      googleEmail
    );
    // Password-mode sessions do not grant Google-mode MFA authorization.

    const accesses = MasterRepository.getWorkspaceAccessForUser(account.UserID);
    const assignedWorkspaces = accesses.map(a => a.WorkspaceID);

    return {
      sessionToken: sessionData.sessionToken,
      expiresAt: sessionData.expiresAt,
      user: {
        userId: account.UserID,
        username: account.Username,
        displayName: account.DisplayName,
        role: account.Role,
        status: account.Status,
        email: account.Email || '',
        primaryWorkspaceId:
          account.PrimaryWorkspaceID ||
          assignedWorkspaces[0] ||
          '',
        assignedWorkspaces,
        mustChangePassword:
          account.MustChangePassword === true ||
          account.MustChangePassword === 'TRUE'
      }
    };
  },

  /**
   * Verifies RFC 6238 TOTP code during two-factor login challenge
   */
  verifyMfa(mfaChallengeToken, code, clientType = 'WEB') {
    if (!mfaChallengeToken || !code) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'MFA challenge token and 6-digit code are required.', 401);
    }

    const parts = mfaChallengeToken.split('_');
    if (parts.length !== 4 || parts[0] !== 'MFA') {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Invalid MFA challenge token.', 401);
    }

    const [, userId, timestampStr, sig] = parts;
    const timestamp = parseInt(timestampStr, 10);
    const now = Date.now();

    // 5-minute expiration
    if (isNaN(timestamp) || now - timestamp > 5 * 60 * 1000 || now < timestamp - 60 * 1000) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'MFA challenge token has expired. Please log in again.', 401);
    }

    const expectedSig = SecurityService.hashToken(`${userId}|${timestamp}|${SecurityService.getPepper()}`).substring(0, 16);
    if (!SecurityService.constantTimeEquals(sig, expectedSig)) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'MFA challenge token signature invalid.', 401);
    }

    const storedChallenge = this._getMfaChallenge(userId);
    const suppliedChallengeHash = SecurityService.hashToken(mfaChallengeToken);
    if (
      !storedChallenge ||
      !storedChallenge.tokenHash ||
      !SecurityService.constantTimeEquals(storedChallenge.tokenHash, suppliedChallengeHash) ||
      Number(storedChallenge.expiresAtMs || 0) < now
    ) {
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'MFA challenge is invalid, expired, replaced, or already used. Please log in again.',
        401
      );
    }

    const mfaLock = LockService.getScriptLock();
    mfaLock.waitLock(10000);
    try {
    // Re-check the one-time challenge after entering the critical section.
    // Another concurrent request may have consumed it after our pre-lock check.
    const lockedChallenge = this._getMfaChallenge(userId);
    if (
      !lockedChallenge ||
      !lockedChallenge.tokenHash ||
      !SecurityService.constantTimeEquals(lockedChallenge.tokenHash, suppliedChallengeHash) ||
      Number(lockedChallenge.expiresAtMs || 0) < Date.now()
    ) {
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'MFA challenge is invalid, expired, replaced, or already used. Please log in again.',
        401
      );
    }

    const account = MasterRepository.findAccountById(userId);
    const cred = MasterRepository.getCredentials(userId);
    if (!account || !cred || !cred.TotpSecret) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'User credentials or MFA configuration not found.', 401);
    }

    const normalizedClientType = String(clientType || 'WEB').toUpperCase();
    if (
      normalizedClientType !== 'WEB' &&
      normalizedClientType !== 'SETUP_WIZARD'
    ) {
      this._deleteMfaChallenge(userId);
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'Invalid authentication challenge. Please log in again.',
        401
      );
    }
    let googleEmail = '';
    try {
      googleEmail = IdentityService.assertAccountIdentity(
        account,
        normalizedClientType
      );
      const challengeEmail = IdentityService.normalizeEmail(
        lockedChallenge.googleEmail || ''
      );
      if (
        (normalizedClientType === 'WEB' ||
          normalizedClientType === 'SETUP_WIZARD') &&
        (!challengeEmail || challengeEmail !== googleEmail)
      ) {
        throw new AppError(
          ERROR_CODES.AUTH_REQUIRED,
          'MFA challenge identity mismatch.',
          401
        );
      }
    } catch (identityErr) {
      this._deleteMfaChallenge(userId);
      MasterRepository.logSecurityEvent({
        UserID: account.UserID,
        Username: account.Username,
        EventType: CONSTANTS.AUDIT_EVENTS.IDENTITY_MISMATCH,
        Success: false,
        metadata: {
          reason: 'Google Workspace identity changed during MFA'
        }
      });
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'Invalid authentication challenge. Please log in again.',
        401
      );
    }

    if (
      account.Status === CONSTANTS.ACCOUNT_STATUS.LOCKED ||
      (cred.LockUntil && new Date(cred.LockUntil).getTime() > now)
    ) {
      this._deleteMfaChallenge(userId);
      throw new AppError(ERROR_CODES.ACCOUNT_LOCKED, 'Account is temporarily locked. Try again later.', 403);
    }

    if (account.Status !== CONSTANTS.ACCOUNT_STATUS.ACTIVE) {
      this._deleteMfaChallenge(userId);
      throw new AppError(
        ERROR_CODES.ACCOUNT_PASSIVE,
        'This account is inactive or has been deactivated.',
        403
      );
    }

    const verification = SecurityService.verifyTotpWithStep(cred.TotpSecret, code);
    if (!verification.valid) {
      const failedCount = (parseInt(cred.FailedLoginCount, 10) || 0) + 1;
      const credUpdates = {
        FailedLoginCount: failedCount,
        LastFailedAt: new Date(now).toISOString()
      };

      if (failedCount >= CONSTANTS.LIMITS.MAX_FAILED_LOGIN_ATTEMPTS) {
        const lockUntil = new Date(
          now + CONSTANTS.LIMITS.LOCKOUT_DURATION_MINUTES * 60 * 1000
        ).toISOString();
        credUpdates.LockUntil = lockUntil;
        MasterRepository.updateAccount(account.UserID, {
          Status: CONSTANTS.ACCOUNT_STATUS.LOCKED
        });
      }

      MasterRepository.updateCredentials(account.UserID, credUpdates);
      MasterRepository.logSecurityEvent({
        UserID: account.UserID,
        Username: account.Username,
        EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_FAIL,
        Success: false,
        metadata: { reason: 'Invalid MFA TOTP code', failedAttempts: failedCount }
      });
      throw new AppError(
        failedCount >= CONSTANTS.LIMITS.MAX_FAILED_LOGIN_ATTEMPTS ? ERROR_CODES.ACCOUNT_LOCKED : ERROR_CODES.AUTH_REQUIRED,
        failedCount >= CONSTANTS.LIMITS.MAX_FAILED_LOGIN_ATTEMPTS
          ? 'Account locked after repeated invalid two-factor codes.'
          : 'Invalid two-factor authentication code.',
        failedCount >= CONSTANTS.LIMITS.MAX_FAILED_LOGIN_ATTEMPTS ? 403 : 401
      );
    }

    // RFC 6238 §5.2 Replay Protection: reject previously validated timestep
    const currentStep = verification.timeStep;
    const lastStep = parseInt(cred.LastSuccessfulTotpStep, 10);
    if (!isNaN(lastStep) && currentStep <= lastStep) {
      MasterRepository.logSecurityEvent({
        UserID: account.UserID,
        Username: account.Username,
        EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_FAIL,
        Success: false,
        metadata: { reason: 'Replayed MFA TOTP code detected', step: currentStep, lastStep }
      });
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'Two-factor authentication code has already been used. Please wait for the next 30-second token.',
        401
      );
    }

    // Reset failure counter on success & advance replay protection step
    MasterRepository.updateCredentials(account.UserID, {
      FailedLoginCount: 0,
      LastFailedAt: '',
      LockUntil: '',
      LastSuccessfulTotpStep: currentStep
    });

    // Consume the server-side challenge before minting a session. A later TOTP
    // cannot reuse the same 5-minute challenge to create another session.
    this._deleteMfaChallenge(userId);

    MasterRepository.updateAccount(account.UserID, {
      LastLoginAt: new Date().toISOString()
    });

    MasterRepository.logSecurityEvent({
      UserID: account.UserID,
      Username: account.Username,
      EventType: CONSTANTS.AUDIT_EVENTS.MFA_VERIFIED,
      Success: true,
      metadata: {
        clientType: normalizedClientType,
        step: currentStep,
        googleIdentity: googleEmail || ''
      }
    });
    MasterRepository.logSecurityEvent({
      UserID: account.UserID,
      Username: account.Username,
      EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_SUCCESS,
      Success: true,
      metadata: {
        clientType: normalizedClientType,
        mfa: true,
        googleIdentity: googleEmail || ''
      }
    });

    const sessionData = SessionService.createSession(
      account.UserID,
      normalizedClientType,
      googleEmail
    );
    this._markMfaSession(sessionData, account.UserID);
    const accesses = MasterRepository.getWorkspaceAccessForUser(account.UserID);
    const assignedWorkspaces = accesses.map(a => a.WorkspaceID);

    return {
      sessionToken: sessionData.sessionToken,
      expiresAt: sessionData.expiresAt,
      user: {
        userId: account.UserID,
        username: account.Username,
        displayName: account.DisplayName,
        role: account.Role,
        status: account.Status,
        email: account.Email || '',
        primaryWorkspaceId: account.PrimaryWorkspaceID || assignedWorkspaces[0] || '',
        assignedWorkspaces: assignedWorkspaces,
        mustChangePassword: !this._googleMode() && (account.MustChangePassword === true || account.MustChangePassword === 'TRUE')
      }
    };
    } finally {
      mfaLock.releaseLock();
    }
  },

  /**
   * Fresh password + TOTP verification for high-risk Super Admin actions.
   * Rotates the session and binds a short-lived step-up token to the new SessionID.
   */
  stepUp(authContext, rawSessionToken, currentPassword, totpCode = '') {
    return this._withLoginStateLock(() => {
      this._consumeReauthAttempt(authContext, currentPassword, totpCode);
      return this._stepUpLocked(authContext, rawSessionToken, currentPassword, totpCode);
    });
  },

  _stepUpLocked(authContext, rawSessionToken, currentPassword, totpCode = '') {
    AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
    if (!authContext.session || !authContext.session.SessionID) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'A current authenticated session is required.', 401);
    }

    const cred = MasterRepository.getCredentials(authContext.userId);
    if (!this._verifyPrimaryIdentity(authContext, currentPassword, cred)) {
      MasterRepository.logSecurityEvent({
        UserID: authContext.userId,
        Username: authContext.user ? authContext.user.Username : '',
        EventType: 'STEP_UP_FAILED',
        Success: false,
        metadata: { reason: 'Invalid current password' }
      });
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Fresh Super Admin reauthentication failed.', 401);
    }

    const mfaEnabled = cred.MfaEnabled === true || cred.MfaEnabled === 'TRUE';
    if (!mfaEnabled || !cred.TotpSecret) {
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'Super Admin MFA must be enabled before high-risk administrative actions can be performed.',
        401
      );
    }

    const verification = SecurityService.verifyTotpWithStep(cred.TotpSecret, totpCode);
    const previousStep = parseInt(cred.LastSuccessfulTotpStep, 10);
    if (
      !verification.valid ||
      (!isNaN(previousStep) && verification.timeStep <= previousStep)
    ) {
      MasterRepository.logSecurityEvent({
        UserID: authContext.userId,
        Username: authContext.user ? authContext.user.Username : '',
        EventType: 'STEP_UP_FAILED',
        Success: false,
        metadata: { reason: 'Invalid or replayed MFA code' }
      });
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'Fresh Super Admin MFA verification failed. Use the next authenticator code if the current code was just used.',
        401
      );
    }

    MasterRepository.updateCredentials(authContext.userId, {
      LastSuccessfulTotpStep: verification.timeStep
    });

    const replacement = SessionService.createSession(
      authContext.userId,
      authContext.session.ClientType || 'WEB',
      authContext.session.ClientLabel || ''
    );
    this._markMfaSession(replacement, authContext.userId);
    const stepUpToken = 'STP_' + SecurityService.generateRandomHex(32);
    const stepUpExpiresAtMs =
      Date.now() + (CONSTANTS.LIMITS.STEP_UP_TTL_MINUTES || 5) * 60 * 1000;
    this._storeStepUp(replacement.sessionId, {
      userId: authContext.userId,
      sessionId: replacement.sessionId,
      tokenHash: SecurityService.hashToken(stepUpToken),
      expiresAtMs: stepUpExpiresAtMs
    });

    const auditOk = MasterRepository.logGlobalAudit({
      ActorUserID: authContext.userId,
      ActorRole: authContext.role,
      WorkspaceID: 'MASTER',
      EntityType: 'USER_SECURITY',
      EntityID: authContext.userId,
      Action: 'STEP_UP_AUTHENTICATED',
      Reason: 'Super Admin identity and fresh MFA verification succeeded'
    });
    if (!auditOk) {
      this._deleteStepUp(replacement.sessionId);
      SessionService.revokeSession(replacement.sessionToken);
      throw new AppError(
        ERROR_CODES.CRYPTO_FAILURE,
        'Security audit trail is unavailable. Step-up authentication was not activated.',
        503
      );
    }

    // Invalidate the previous session's privileged grant before revocation.
    // Even if the old session row cannot be updated immediately, it must not
    // retain high-risk authorization after the rotation.
    this._deleteStepUp(authContext.session.SessionID);
    SessionService.revokeSession(rawSessionToken);
    MasterRepository.logSecurityEvent({
      UserID: authContext.userId,
      Username: authContext.user ? authContext.user.Username : '',
      EventType: 'STEP_UP_SUCCESS',
      Success: true,
      metadata: { expiresAtMs: stepUpExpiresAtMs }
    });

    return {
      ok: true,
      sessionToken: replacement.sessionToken,
      expiresAt: replacement.expiresAt,
      stepUpToken,
      stepUpExpiresAt: new Date(stepUpExpiresAtMs).toISOString()
    };
  },

  assertStepUp(authContext, stepUpToken) {
    AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
    if (!authContext.session || !authContext.session.SessionID || !stepUpToken) {
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'Fresh Super Admin reauthentication is required for this action.',
        401
      );
    }

    const record = this._getStepUp(authContext.session.SessionID);
    if (
      !record ||
      record.userId !== authContext.userId ||
      record.sessionId !== authContext.session.SessionID ||
      Number(record.expiresAtMs || 0) < Date.now() ||
      !record.tokenHash ||
      !SecurityService.constantTimeEquals(
        record.tokenHash,
        SecurityService.hashToken(String(stepUpToken))
      )
    ) {
      this._deleteStepUp(authContext.session.SessionID);
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'Fresh Super Admin reauthentication is required for this action.',
        401
      );
    }
    return true;
  },

  /**
   * Enrolls or replaces TOTP MFA only after fresh credential verification.
   * Pending enrollment is bound to the current authenticated session and expires.
   */
  enrollMfa(authContext, currentPassword, currentMfaCode = '') {
    return this._withLoginStateLock(() => {
      this._consumeReauthAttempt(authContext, currentPassword, currentMfaCode);
      return this._enrollMfaLocked(authContext, currentPassword, currentMfaCode);
    });
  },

  _enrollMfaLocked(authContext, currentPassword, currentMfaCode = '') {
    if (!authContext || !authContext.userId || !authContext.session || !authContext.session.SessionID) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'A current authenticated session is required.', 401);
    }
    const cred = MasterRepository.getCredentials(authContext.userId);
    if (!this._verifyPrimaryIdentity(authContext, currentPassword, cred)) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Fresh password verification is required before changing MFA.', 401);
    }

    const replacing =
      cred.MfaEnabled === true ||
      cred.MfaEnabled === 'TRUE';

    if (replacing) {
      if (!currentMfaCode || !cred.TotpSecret) {
        throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'The existing authenticator code is required before replacing MFA.', 401);
      }
      const currentVerification = SecurityService.verifyTotpWithStep(
        cred.TotpSecret,
        currentMfaCode
      );
      const previousStep = parseInt(cred.LastSuccessfulTotpStep, 10);
      if (
        !currentVerification.valid ||
        (!isNaN(previousStep) && currentVerification.timeStep <= previousStep)
      ) {
        throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Existing MFA verification failed.', 401);
      }
      MasterRepository.updateCredentials(authContext.userId, {
        LastSuccessfulTotpStep: currentVerification.timeStep
      });
    }

    const rawSecret = SecurityService.generateTotpSecret();
    const encryptedSecret = SecurityService.encryptSecret(rawSecret);
    const expiresAtMs =
      Date.now() +
      (CONSTANTS.LIMITS.MFA_ENROLLMENT_TTL_MINUTES || 10) * 60 * 1000;

    MasterRepository.updateCredentials(authContext.userId, {
      PendingTotpSecret: encryptedSecret
    });
    this._storeMfaEnrollment(authContext.userId, {
      sessionId: authContext.session.SessionID,
      expiresAtMs,
      replacing
    });

    const username =
      authContext.username ||
      (authContext.user && (authContext.user.Username || authContext.user.username)) ||
      'user';
    const uri = `otpauth://totp/FLINK:${username}?secret=${rawSecret}&issuer=FLINK`;
    return {
      secret: rawSecret,
      qrUri: uri,
      expiresAt: new Date(expiresAtMs).toISOString(),
      replacing,
      message: 'Scan the QR code or enter the secret in your authenticator app, then confirm with a 6-digit code.'
    };
  },

  /**
   * Confirms TOTP MFA enrollment. Enrollment is one-time, session-bound, and short-lived.
   */
  confirmMfa(authContext, code) {
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      this._consumeReauthAttempt(authContext, undefined, code);
      if (!authContext || !authContext.session || !authContext.session.SessionID) {
        throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'A current authenticated session is required.', 401);
      }
      const enrollment = this._getMfaEnrollment(authContext.userId);
      if (
        !enrollment ||
        enrollment.sessionId !== authContext.session.SessionID ||
        Number(enrollment.expiresAtMs || 0) < Date.now()
      ) {
        this._deleteMfaEnrollment(authContext.userId);
        MasterRepository.updateCredentials(authContext.userId, { PendingTotpSecret: '' });
        throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'MFA enrollment is invalid, expired, or belongs to another session.', 401);
      }

      const cred = MasterRepository.getCredentials(authContext.userId);
      if (!cred || !cred.PendingTotpSecret) {
        this._deleteMfaEnrollment(authContext.userId);
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'No pending MFA enrollment found. Call enrollMfa first.');
      }

      const verification = SecurityService.verifyTotpWithStep(cred.PendingTotpSecret, code);
      if (!verification.valid) {
        throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Invalid verification code. Could not verify authenticator app.');
      }

      MasterRepository.updateCredentials(authContext.userId, {
        TotpSecret: cred.PendingTotpSecret,
        MfaEnabled: true,
        PendingTotpSecret: '',
        LastSuccessfulTotpStep: verification.timeStep
      });
      this._deleteMfaEnrollment(authContext.userId);

      let replacementSession = null;
      if (enrollment.replacing === true || this._googleMode()) {
        SessionService.revokeAllUserSessions(authContext.userId);
        replacementSession = SessionService.createSession(
          authContext.userId,
          authContext.session.ClientType || 'WEB',
          authContext.session.ClientLabel || ''
        );
        this._markMfaSession(replacementSession, authContext.userId);
      }

      MasterRepository.logGlobalAudit({
        ActorUserID: authContext.userId,
        ActorRole: authContext.role,
        EntityType: 'USER_SECURITY',
        EntityID: authContext.userId,
        Action: CONSTANTS.AUDIT_EVENTS.MFA_ENROLLED,
        Reason: enrollment.replacing === true
          ? 'TOTP multi-factor authentication replaced after fresh reauthentication'
          : 'TOTP multi-factor authentication successfully enabled'
      });

      return {
        ok: true,
        replaced: enrollment.replacing === true,
        sessionToken: replacementSession ? replacementSession.sessionToken : undefined,
        expiresAt: replacementSession ? replacementSession.expiresAt : undefined,
        message: enrollment.replacing === true
          ? 'Two-factor authentication replaced successfully. Other sessions were revoked.'
          : 'Two-factor authentication successfully enabled.'
      };
    } finally {
      lock.releaseLock();
    }
  },

  /**
   * Disables MFA for a user (Super Admin only or user password confirmation)
   */
  disableMfa(superAdminContext, targetUserId, adminPassword, adminTotpCode = '') {
    return this._withLoginStateLock(() => {
      this._consumeReauthAttempt(superAdminContext, adminPassword, adminTotpCode);
      return this._disableMfaLocked(superAdminContext, targetUserId, adminPassword, adminTotpCode);
    });
  },

  _disableMfaLocked(superAdminContext, targetUserId, adminPassword, adminTotpCode = '') {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
    const targetAccount = MasterRepository.findAccountById(targetUserId);
    if (!targetAccount) throw new AppError(ERROR_CODES.NOT_FOUND, `User ${targetUserId} not found.`);
    if (targetAccount.Role === CONSTANTS.ROLES.SUPER_ADMIN) {
      throw new AppError(
        ERROR_CODES.PERMISSION_DENIED,
        'MFA cannot be disabled for the root Super Admin through the web application.',
        403
      );
    }

    const adminCred = MasterRepository.getCredentials(superAdminContext.userId);
    if (!this._verifyPrimaryIdentity(superAdminContext, adminPassword, adminCred)) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Fresh Super Admin password verification is required.', 401);
    }
    if (adminCred.MfaEnabled === true || adminCred.MfaEnabled === 'TRUE') {
      const verification = SecurityService.verifyTotpWithStep(adminCred.TotpSecret, adminTotpCode);
      const previousStep = parseInt(adminCred.LastSuccessfulTotpStep, 10);
      if (
        !verification.valid ||
        (!isNaN(previousStep) && verification.timeStep <= previousStep)
      ) {
        throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Fresh Super Admin MFA verification is required.', 401);
      }
      MasterRepository.updateCredentials(superAdminContext.userId, {
        LastSuccessfulTotpStep: verification.timeStep
      });
    }

    MasterRepository.updateCredentials(targetUserId, {
      TotpSecret: '',
      MfaEnabled: false,
      PendingTotpSecret: '',
      LastSuccessfulTotpStep: ''
    });

    this._deleteMfaChallenge(targetUserId);
    this._deleteMfaEnrollment(targetUserId);
    SessionService.revokeAllUserSessions(targetUserId);

    MasterRepository.logGlobalAudit({
      ActorUserID: superAdminContext.userId,
      ActorRole: superAdminContext.role,
      EntityType: 'USER_SECURITY',
      EntityID: targetUserId,
      Action: CONSTANTS.AUDIT_EVENTS.MFA_DISABLED,
      Reason: 'Two-factor authentication disabled by Super Admin after fresh reauthentication'
    });

    return { ok: true, message: `MFA disabled for user ${targetAccount.Username}. Active sessions were revoked.` };
  },

  /**
   * Changes authenticated user's password
   */
  changePassword(sessionToken, oldPassword, newPassword) {
    if (this._googleMode()) throw new AppError(ERROR_CODES.PERMISSION_DENIED, 'Manage your Google password in your Google Account. FLINK does not store app passwords.', 403);
    const authContext = SessionService.validateSession(sessionToken);
    Validation.validatePassword(newPassword);

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      this._consumeReauthAttempt(authContext, oldPassword);
      const cred = MasterRepository.getCredentials(authContext.userId);
      if (!cred) throw new AppError(ERROR_CODES.NOT_FOUND, 'Credentials record not found.');

      const isOldValid = SecurityService.verifyPassword(oldPassword, cred.PasswordHash);
      if (!isOldValid) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Current password is incorrect.');
      }
      if (SecurityService.verifyPassword(newPassword, cred.PasswordHash)) {
        throw new AppError(
          ERROR_CODES.VALIDATION_ERROR,
          'New password must be different from the current password.',
          400
        );
      }

      const newHash = SecurityService.hashPassword(newPassword);
      MasterRepository.updateCredentials(authContext.userId, {
        PasswordHash: newHash,
        PasswordVersion: (parseInt(cred.PasswordVersion, 10) || 1) + 1,
        PasswordChangedAt: new Date().toISOString(),
        ResetIssuedAt: '',
        ResetExpiresAt: ''
      });

      MasterRepository.updateAccount(authContext.userId, {
        MustChangePassword: false,
        UpdatedAt: new Date().toISOString(),
        UpdatedBy: authContext.userId
      });

      // Invalidate all active sessions and any outstanding MFA login challenge.
      SessionService.revokeAllUserSessions(authContext.userId);
      this._deleteMfaChallenge(authContext.userId);
      this._deleteMfaEnrollment(authContext.userId);
      const replacementClientType =
        authContext.session && authContext.session.ClientType
          ? authContext.session.ClientType
          : 'WEB';
      const newSession = SessionService.createSession(
        authContext.userId,
        replacementClientType
      );

      MasterRepository.logSecurityEvent({
        UserID: authContext.userId,
        Username: authContext.user.Username,
        EventType: CONSTANTS.AUDIT_EVENTS.PASSWORD_CHANGED,
        Success: true
      });

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }

      return {
        ok: true,
        sessionToken: newSession.sessionToken,
        expiresAt: newSession.expiresAt
      };
    } finally {
      lock.releaseLock();
    }
  },

  /**
   * Super Admin resets a user's password
   */
  resetPasswordByAdmin(superAdminContext, targetUserId, temporaryPassword) {
    if (this._googleMode()) {
      AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
      const account = MasterRepository.findAccountById(targetUserId);
      if (!account) throw new AppError(ERROR_CODES.NOT_FOUND, 'Target account not found.', 404);
      if (account.Role === CONSTANTS.ROLES.SUPER_ADMIN) throw new AppError(ERROR_CODES.PERMISSION_DENIED, 'Root recovery requires the installation owner.', 403);
      SessionService.revokeAllUserSessions(targetUserId);
      this._deleteMfaChallenge(targetUserId);
      MasterRepository.logGlobalAudit({ActorUserID:superAdminContext.userId,ActorRole:superAdminContext.role,EntityType:'USER_SECURITY',EntityID:targetUserId,Action:'SESSION_RECOVERY',Reason:'Google-managed account: FLINK sessions revoked; Google password unchanged'});
      return {ok:true,message:'FLINK sessions revoked. Google manages account passwords.'};
    }
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
    Validation.validatePassword(temporaryPassword);

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const targetAccount = MasterRepository.findAccountById(targetUserId);
      if (!targetAccount) throw new AppError(ERROR_CODES.NOT_FOUND, 'Target account not found.');
      if (
        targetAccount.Status === CONSTANTS.ACCOUNT_STATUS.ARCHIVED ||
        targetAccount.Status === CONSTANTS.ACCOUNT_STATUS.DELETED
      ) {
        throw new AppError(
          ERROR_CODES.CONFLICT,
          'Archived or deleted accounts cannot receive a password reset.',
          409
        );
      }

      const targetCred = MasterRepository.getCredentials(targetUserId);
      if (!targetCred) {
        throw new AppError(ERROR_CODES.NOT_FOUND, 'Target credentials record not found.');
      }
      if (SecurityService.verifyPassword(temporaryPassword, targetCred.PasswordHash)) {
        throw new AppError(
          ERROR_CODES.VALIDATION_ERROR,
          'Temporary password must be different from the user\'s current password.',
          400
        );
      }
      const newHash = SecurityService.hashPassword(temporaryPassword);
      const resetIssuedAt = new Date();
      const resetExpiresAt = new Date(
        resetIssuedAt.getTime() +
        (CONSTANTS.LIMITS.RESET_PASSWORD_TTL_MINUTES || 60) * 60 * 1000
      );
      const nextStatus =
        targetAccount.Status === CONSTANTS.ACCOUNT_STATUS.LOCKED
          ? CONSTANTS.ACCOUNT_STATUS.ACTIVE
          : targetAccount.Status;

      MasterRepository.updateCredentials(targetUserId, {
        PasswordHash: newHash,
        PasswordVersion: (parseInt(targetCred ? targetCred.PasswordVersion : 0, 10) || 1) + 1,
        PasswordChangedAt: new Date().toISOString(),
        FailedLoginCount: 0,
        LockUntil: '',
        ResetIssuedAt: resetIssuedAt.toISOString(),
        ResetExpiresAt: resetExpiresAt.toISOString()
      });

      MasterRepository.updateAccount(targetUserId, {
        MustChangePassword: true,
        Status: nextStatus,
        UpdatedAt: new Date().toISOString(),
        UpdatedBy: superAdminContext.userId
      });

      // Password reset never serves as a PASSIVE-account activation path.
      // It also invalidates sessions and any outstanding MFA challenge.
      SessionService.revokeAllUserSessions(targetUserId);
      this._deleteMfaChallenge(targetUserId);

      MasterRepository.logGlobalAudit({
        ActorUserID: superAdminContext.userId,
        ActorRole: superAdminContext.role,
        EntityType: 'USER',
        EntityID: targetUserId,
        Action: CONSTANTS.AUDIT_EVENTS.PASSWORD_RESET,
        Reason: 'Administrative password reset'
      });

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }

      return {
        ok: true,
        message: `Password reset successfully for user ${targetAccount.Username}. User will be forced to change password on next login.`
      };
    } finally {
      lock.releaseLock();
    }
  },

  /**
   * Logout user and revoke session
   */
  logout(sessionToken) {
    SessionService.revokeSession(sessionToken);
    return { ok: true };
  }
};

