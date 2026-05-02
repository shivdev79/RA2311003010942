'use strict';

/**
 * Logging Middleware
 *
 * Implements: Log(stack, level, package, message)
 *
 * Every call:
 *  1. Prints to local console for immediate visibility
 *  2. POST to http://.../evaluation-service/logs (authenticated via Bearer token)
 *
 * Token management is automatic — the module fetches and refreshes the
 * Bearer token using CLIENT_ID / CLIENT_SECRET from process.env.
 *
 * Usage (plain function):
 *   const logger = require('logging_middleware');
 *   await logger.log('backend', 'info', 'handler', 'task started');
 *
 * Usage (Express middleware):
 *   app.use(logger.middleware());
 */

const axios  = require('axios');
const { v4: uuidv4 } = require('uuid');

const API_BASE = process.env.API_BASE_URL || 'http://20.207.122.201/evaluation-service';

const VALID_STACKS = new Set(['backend', 'frontend']);
const VALID_LEVELS = new Set(['debug', 'info', 'warn', 'error', 'fatal']);
const VALID_PACKAGES = new Set([
  // backend
  'cache', 'controller', 'cron_job', 'db', 'domain',
  'handler', 'repository', 'route', 'service',
  // frontend
  'api', 'component', 'hook', 'page', 'state', 'style',
  // both
  'auth', 'config', 'middleware', 'utils',
]);

class Logger {
  constructor() {
    this._token       = null;
    this._tokenExpiry = 0;
    this._refreshing  = null; // deduplicate concurrent refresh calls
  }

  // ── Token management ────────────────────────────────────────────────────────

  async _ensureToken() {
    const now = Math.floor(Date.now() / 1000);
    if (this._token && this._tokenExpiry > now + 60) {
      return this._token; // valid with >60 s remaining
    }
    if (!this._refreshing) {
      this._refreshing = this._refreshToken().finally(() => {
        this._refreshing = null;
      });
    }
    return this._refreshing;
  }

  async _refreshToken() {
    const { EMAIL, NAME, ROLL_NO, ACCESS_CODE, CLIENT_ID, CLIENT_SECRET } = process.env;
    const creds = { EMAIL, NAME, ROLL_NO, ACCESS_CODE, CLIENT_ID, CLIENT_SECRET };
    const missing = Object.entries(creds).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) {
      throw new Error(`Logger: env vars not set: ${missing.join(', ')}`);
    }

    const { data } = await axios.post(`${API_BASE}/auth`, {
      email:        EMAIL,
      name:         NAME,
      rollNo:       ROLL_NO,
      accessCode:   ACCESS_CODE,
      clientID:     CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });

    this._token = data.access_token;

    // expires_in is a Unix timestamp (not a duration in seconds)
    const now = Math.floor(Date.now() / 1000);
    this._tokenExpiry = data.expires_in > now
      ? data.expires_in          // future Unix timestamp → use directly
      : now + data.expires_in;   // small number → treat as seconds duration

    console.log(`[Logger] token refreshed, valid until ${new Date(this._tokenExpiry * 1000).toISOString()}`);
    return this._token;
  }

  // ── Core log function ────────────────────────────────────────────────────────

  /**
   * @param {string} stack   'backend' | 'frontend'
   * @param {string} level   'debug' | 'info' | 'warn' | 'error' | 'fatal'
   * @param {string} pkg     package name, e.g. 'handler', 'service', 'db'
   * @param {string} message log message
   * @returns {Promise<{logID:string}|undefined>}
   */
  async log(stack, level, pkg, message) {
    // Normalise — API requires lowercase
    stack   = String(stack).toLowerCase().trim();
    level   = String(level).toLowerCase().trim();
    pkg     = String(pkg).toLowerCase().trim();
    message = String(message).slice(0, 48); // API enforces 48-char max

    // Always echo locally first so logs work even if the remote API is down
    const prefix = level === 'error' || level === 'fatal' ? '⚠ ' : '';
    console.log(`${prefix}[${level.toUpperCase()}] ${stack}/${pkg}: ${message}`);

    if (!VALID_STACKS.has(stack))    console.warn(`[Logger] unknown stack: ${stack}`);
    if (!VALID_LEVELS.has(level))    console.warn(`[Logger] unknown level: ${level}`);
    if (!VALID_PACKAGES.has(pkg))    console.warn(`[Logger] unknown package: ${pkg}`);

    try {
      const token = await this._ensureToken();
      const { data } = await axios.post(
        `${API_BASE}/logs`,
        { stack, level, package: pkg, message },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      return data; // { logID, message: 'log created successfully' }
    } catch (err) {
      // Never crash the calling application because of a log failure
      console.error('[Logger] remote log failed:', err.response?.data || err.message);
    }
  }

  // ── Convenience wrappers ─────────────────────────────────────────────────────

  debug(pkg, msg) { return this.log('backend', 'debug', pkg, msg); }
  info (pkg, msg) { return this.log('backend', 'info',  pkg, msg); }
  warn (pkg, msg) { return this.log('backend', 'warn',  pkg, msg); }
  error(pkg, msg) { return this.log('backend', 'error', pkg, msg); }
  fatal(pkg, msg) { return this.log('backend', 'fatal', pkg, msg); }

  // ── Express middleware ───────────────────────────────────────────────────────

  /**
   * Returns an Express middleware that:
   *  - Assigns a unique X-Request-ID to every request
   *  - Logs REQUEST start and RESPONSE finish to the remote API (fire-and-forget)
   */
  middleware() {
    const self = this;
    return function loggerMiddleware(req, res, next) {
      const reqID = uuidv4();
      req.requestID = reqID;
      res.setHeader('X-Request-ID', reqID);

      // Fire-and-forget — do not await; never delay the request
      self.log('backend', 'info', 'middleware',
        `${req.method} ${req.path} received`);

      res.on('finish', () => {
        const level = res.statusCode >= 500 ? 'error'
                    : res.statusCode >= 400 ? 'warn'
                    : 'info';
        self.log('backend', level, 'middleware',
          `${req.method} ${req.path} ${res.statusCode}`);
      });

      next();
    };
  }
}

// Export a singleton so token state is shared across the entire process
module.exports = new Logger();
