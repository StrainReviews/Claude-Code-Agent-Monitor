/**
 * Compatibility wrapper around Node.js built-in node:sqlite (DatabaseSync).
 * Provides a better-sqlite3-compatible API so the rest of the codebase
 * works without the native module.
 *
 * Available on Node.js >= 22.5.0 (node:sqlite is experimental).
 * On older Node versions, require() will throw and the caller should
 * handle the error (e.g. show an informative message).
 *
 * @file This module exports a Database class that wraps node:sqlite's DatabaseSync to provide a better-sqlite3-like API.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { DatabaseSync } = require("node:sqlite");

class Database {
  constructor(filePath) {
    this._db = new DatabaseSync(filePath);
    this._transactionDepth = 0;
    this._spCounter = 0;
  }

  exec(sql) {
    this._db.exec(sql);
    return this;
  }

  pragma(str, options) {
    if (str.includes("=")) {
      this._db.exec(`PRAGMA ${str}`);
      return undefined;
    }
    const row = this._db.prepare(`PRAGMA ${str}`).get();
    if (!row) return undefined;
    const keys = Object.keys(row);
    if (options?.simple || keys.length === 1) return row[keys[0]];
    return row;
  }

  prepare(sql) {
    return this._db.prepare(sql);
  }

  transaction(fn) {
    const self = this;
    const wrapper = (...args) => {
      const nested = self._transactionDepth > 0;
      if (nested) {
        const sp = `_sp_${++self._spCounter}`;
        self._db.exec(`SAVEPOINT ${sp}`);
        self._transactionDepth++;
        try {
          const result = fn(...args);
          self._db.exec(`RELEASE ${sp}`);
          self._transactionDepth--;
          return result;
        } catch (err) {
          self._db.exec(`ROLLBACK TO ${sp}`);
          self._db.exec(`RELEASE ${sp}`);
          self._transactionDepth--;
          throw err;
        }
      } else {
        self._db.exec("BEGIN");
        self._transactionDepth++;
        try {
          const result = fn(...args);
          self._db.exec("COMMIT");
          self._transactionDepth--;
          return result;
        } catch (err) {
          self._db.exec("ROLLBACK");
          self._transactionDepth--;
          throw err;
        }
      }
    };
    return wrapper;
  }

  close() {
    this._db.close();
  }
}

module.exports = Database;
