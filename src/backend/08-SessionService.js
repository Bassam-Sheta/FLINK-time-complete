/* ===== SessionService.gs ===== */
/**
 * FLINK Time & Workforce Platform — Session Service
 * Manages secure 256-bit token sessions with token hashing, idle & absolute timeouts,
 * and automatic revocation upon password changes or account suspension.
 */

var SessionService = (typeof global !== 'undefined' && global.SessionService) || {
  _idleTimeoutMs() {
    const getter = MasterRepository.getGlobalSettingStrict || MasterRepository.getGlobalSetting;
    const raw = getter
      ? getter.call(MasterRepository, 'IDLE_TIMEOUT_HOURS', CONSTANTS.LIMITS.SESSION_IDLE_TIMEOUT_HOURS)
      : CONSTANTS.LIMITS.SESSION_IDLE_TIMEOUT_HOURS;
    const hours = Number(raw);
    if (!Number.isFinite(hours) || hours < 1 || hours > 24) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, 'Session timeout configuration is invalid.', 503);
    }
    return hours * 3600000;
  },
  _sessionCacheMemory: {},

  _sessionCacheKey(tokenHash) {
    return 'S:' + String(tokenHash || '');
  },

  _getCachedSession(tokenHash) {
    const key = this._sessionCacheKey(tokenHash);
    let raw = '';
    if (typeof CacheService !== 'undefined' && CacheService.getScriptCache) {
      try { raw = CacheService.getScriptCache().get(key) || ''; } catch (e) {}
    } else {
      raw = this._sessionCacheMemory[key] || '';
    }
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) {
      this._deleteCachedSession(tokenHash);
      return null;
    }
  },

  _putCachedSession(tokenHash, session) {
    if (!tokenHash || !session) return;
    const key = this._sessionCacheKey(tokenHash);
    const raw = JSON.stringify(session);
    if (typeof CacheService !== 'undefined' && CacheService.getScriptCache) {
      try { CacheService.getScriptCache().put(key, raw, 300); } catch (e) {}
    } else {
      this._sessionCacheMemory[key] = raw;
    }
  },

  _deleteCachedSession(tokenHash) {
    const key = this._sessionCacheKey(tokenHash);
    if (typeof CacheService !== 'undefined' && CacheService.getScriptCache) {
      try { CacheService.getScriptCache().remove(key); } catch (e) {}
    }
    delete this._sessionCacheMemory[key];
  },

  /**
   * Creates and registers a new authenticated session
   */
  createSession(userId, clientType = 'WEB', clientLabel = '') {
    const normalizedClientType = String(clientType || 'WEB').toUpperCase();
    let verifiedClientLabel = String(clientLabel || '').trim();
    let sessionAccount = null;

    if (
      normalizedClientType !== 'WEB' &&
      normalizedClientType !== 'SETUP_WIZARD'
    ) {
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'Unsupported authentication channel.',
        401
      );
    }

    if (
      normalizedClientType === 'WEB' ||
      normalizedClientType === 'SETUP_WIZARD'
    ) {
      const accountBundle = MasterRepository.getUserAuthBundle
        ? MasterRepository.getUserAuthBundle(userId)
        : { account: MasterRepository.findAccountById(userId), accesses: [] };
      const account = accountBundle.account;
      sessionAccount = account;
      if (!account) {
        throw new AppError(
          ERROR_CODES.AUTH_REQUIRED,
          'User account could not be resolved for session creation.',
          401
        );
      }
      const verifiedEmail = IdentityService.assertAccountIdentity(
        account,
        normalizedClientType
      );
      if (
        verifiedClientLabel &&
        IdentityService.normalizeEmail(verifiedClientLabel) !== verifiedEmail
      ) {
        throw new AppError(
          ERROR_CODES.AUTH_REQUIRED,
          'Verified Google Workspace identity changed before session creation.',
          401
        );
      }
      verifiedClientLabel = verifiedEmail;
    }

    const rawToken = SecurityService.generateSessionToken();
    const tokenHash = SecurityService.hashToken(rawToken);
    const now = new Date();
    const sessionId = Validation.generateId('SES');

    const idleTimeoutMs = this._idleTimeoutMs();
    const absoluteTimeoutMs = CONSTANTS.LIMITS.SESSION_ABSOLUTE_TIMEOUT_HOURS * 3600 * 1000;
    const expiresAt = new Date(now.getTime() + idleTimeoutMs);
    const absoluteExpiresAt = new Date(now.getTime() + absoluteTimeoutMs);

    const sessionRecord = {
      SessionID: sessionId,
      UserID: userId,
      TokenHash: tokenHash,
      ClientType: normalizedClientType,
      ClientLabel: verifiedClientLabel,
      CreatedAt: now.toISOString(),
      LastSeenAt: now.toISOString(),
      ExpiresAt: expiresAt.toISOString(),
      AbsoluteExpiresAt: absoluteExpiresAt.toISOString(),
      Revoked: false,
      RevokedAt: '',
      AccountEpoch:
        sessionAccount && Number(sessionAccount.SessionEpoch) > 0
          ? Number(sessionAccount.SessionEpoch)
          : 1
    };

    MasterRepository.createSession(sessionRecord);
    this._putCachedSession(tokenHash, sessionRecord);

    return {
      sessionId,
      sessionToken: rawToken,
      expiresAt: expiresAt.toISOString()
    };
  },

  /**
   * Validates session token, checks timeouts, verifies user active status, and slides expiration
   */
  validateSession(rawToken) {
    if (!rawToken || typeof rawToken !== 'string') {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Authentication token required.', 401);
    }

    const tokenHash = SecurityService.hashToken(rawToken.trim());
    let session = this._getCachedSession(tokenHash);
    if (!session) {
      session = MasterRepository.findSessionByTokenHashFast
        ? MasterRepository.findSessionByTokenHashFast(tokenHash)
        : MasterRepository.findSessionByTokenHash(tokenHash);
      if (session) this._putCachedSession(tokenHash, session);
    }

    if (!session) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Invalid or expired session.', 401);
    }

    const now = Date.now();
    const expiresAt = new Date(session.ExpiresAt).getTime();
    const lastSeenAt = new Date(session.LastSeenAt).getTime();
    const createdAt = new Date(session.CreatedAt).getTime();

    if ([expiresAt, lastSeenAt, createdAt].some(v => !Number.isFinite(v))) {
      MasterRepository.updateSession(session.SessionID, {
        Revoked: true,
        RevokedAt: new Date().toISOString()
      });
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Session record is invalid. Please sign in again.', 401);
    }

    const idleTimeoutMs = this._idleTimeoutMs();
    const absoluteTimeoutMs = CONSTANTS.LIMITS.SESSION_ABSOLUTE_TIMEOUT_HOURS * 3600 * 1000;
    const storedAbsoluteExpiresAt = new Date(session.AbsoluteExpiresAt || '').getTime();
    const absoluteExpiresAt = isNaN(storedAbsoluteExpiresAt)
      ? createdAt + absoluteTimeoutMs
      : storedAbsoluteExpiresAt;

    if (
      now > expiresAt ||
      (now - lastSeenAt) > idleTimeoutMs ||
      now > absoluteExpiresAt
    ) {
      MasterRepository.updateSession(session.SessionID, {
        Revoked: true,
        RevokedAt: new Date().toISOString()
      });
      throw new AppError(ERROR_CODES.SESSION_EXPIRED, 'Session has expired due to timeout. Please sign in again.', 401);
    }

    // Verify current account/access state. The U:<userId> cache is short-lived
    // and explicitly invalidated by account/access mutations.
    const userBundle = MasterRepository.getUserAuthBundle
      ? MasterRepository.getUserAuthBundle(session.UserID)
      : { account: MasterRepository.findAccountById(session.UserID), accesses: [] };
    const user = userBundle.account;
    if (!user) {
      MasterRepository.updateSession(session.SessionID, {
        Revoked: true,
        RevokedAt: new Date().toISOString()
      });
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'User account no longer exists.', 401);
    }

    if (user.Status === CONSTANTS.ACCOUNT_STATUS.LOCKED) {
      MasterRepository.updateSession(session.SessionID, {
        Revoked: true,
        RevokedAt: new Date().toISOString()
      });
      throw new AppError(ERROR_CODES.ACCOUNT_LOCKED, 'Account is temporarily locked. Sign in again after it is unlocked.', 403);
    }

    if (user.Status !== CONSTANTS.ACCOUNT_STATUS.ACTIVE) {
      MasterRepository.updateSession(session.SessionID, {
        Revoked: true,
        RevokedAt: new Date().toISOString()
      });
      throw new AppError(ERROR_CODES.ACCOUNT_PASSIVE, 'Account is inactive or suspended.', 403);
    }

    const currentEpoch = Number(user.SessionEpoch) > 0 ? Number(user.SessionEpoch) : 1;
    const sessionEpoch = Number(session.AccountEpoch) > 0 ? Number(session.AccountEpoch) : 1;
    if (sessionEpoch !== currentEpoch) {
      this._deleteCachedSession(tokenHash);
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'Session has been revoked. Please sign in again.',
        401
      );
    }

    const normalizedClientType = String(session.ClientType || '').toUpperCase();
    if (
      normalizedClientType !== 'WEB' &&
      normalizedClientType !== 'SETUP_WIZARD'
    ) {
      MasterRepository.updateSession(session.SessionID, {
        Revoked: true,
        RevokedAt: new Date().toISOString(),
        RevokeReason: 'UNSUPPORTED_CLIENT_TYPE'
      });
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'Session authentication channel is no longer supported. Please sign in again.',
        401
      );
    }

    if (
      normalizedClientType === 'WEB' ||
      normalizedClientType === 'SETUP_WIZARD'
    ) {
      try {
        const currentGoogleEmail = IdentityService.assertAccountIdentity(
          user,
          normalizedClientType
        );
        const boundGoogleEmail = IdentityService.normalizeEmail(
          session.ClientLabel || ''
        );
        if (!boundGoogleEmail || boundGoogleEmail !== currentGoogleEmail) {
          throw new AppError(
            ERROR_CODES.AUTH_REQUIRED,
            'Session identity binding does not match the active Google account.',
            401
          );
        }
      } catch (identityErr) {
        MasterRepository.updateSession(session.SessionID, {
          Revoked: true,
          RevokedAt: new Date().toISOString(),
          RevokeReason: 'GOOGLE_IDENTITY_MISMATCH'
        });
        throw new AppError(
          ERROR_CODES.AUTH_REQUIRED,
          'Google Workspace identity changed. Please sign in again.',
          401
        );
      }
    }

    // Persist activity at a coarse interval instead of writing to Sheets on
    // every authenticated read/poll. Idle semantics remain unchanged because
    // the touch interval is tiny compared with the idle timeout.
    const touchIntervalMs =
      (CONSTANTS.LIMITS.SESSION_TOUCH_INTERVAL_MINUTES || 5) * 60 * 1000;
    if ((now - lastSeenAt) >= touchIntervalMs) {
      const newExpiresMs = Math.min(now + idleTimeoutMs, absoluteExpiresAt);
      const touch = {
        LastSeenAt: new Date(now).toISOString(),
        ExpiresAt: new Date(newExpiresMs).toISOString(),
        AbsoluteExpiresAt: new Date(absoluteExpiresAt).toISOString()
      };
      MasterRepository.updateSession(session.SessionID, touch);
      session = { ...session, ...touch };
      this._putCachedSession(tokenHash, session);
    }

    return {
      session,
      user,
      username: user.Username,
      role: user.Role,
      userId: user.UserID
    };
  },

  /**
   * Explicitly revokes a single session (e.g. on logout)
   */
  revokeSession(rawToken) {
    if (!rawToken) return;
    const tokenHash = SecurityService.hashToken(rawToken.trim());
    const session = MasterRepository.findSessionByTokenHashFast
      ? MasterRepository.findSessionByTokenHashFast(tokenHash)
      : MasterRepository.findSessionByTokenHash(tokenHash);
    if (session) {
      MasterRepository.updateSession(session.SessionID, {
        Revoked: true,
        RevokedAt: new Date().toISOString()
      });
    }
    this._deleteCachedSession(tokenHash);
  },

  /**
   * Revokes all active sessions for a user (e.g. password change, account passive)
   */
  revokeAllUserSessions(userId) {
    MasterRepository.revokeAllUserSessions(userId);
  }
};

