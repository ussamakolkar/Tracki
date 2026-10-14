'use strict';
/**
 * Watches the Parsable CV output folder. When a CV file appears (or is
 * re-saved), it queues an "add this to the job tracker?" prompt that the Tracki
 * window shows as a dialog box.
 *
 * Deliberately conservative: it waits for the file size to stop changing before
 * reading, so a CV still being written is never half-parsed.
 */
const fs = require('fs');
const path = require('path');
const { suggestionFromFile } = require('./cv-intake');

const CV_EXTENSIONS = new Set(['.pdf', '.docx', '.doc', '.json', '.txt', '.md', '.markdown', '.html', '.htm', '.rtf', '.odt']);
const SETTLE_MS = 1200;
const SETTLE_TRIES = 12;

class CvWatcher {
  constructor(store, { onQueued } = {}) {
    this.store = store;
    this.onQueued = onQueued || (() => {});
    this.watcher = null;
    this.watchedPath = '';
    this.pendingTimers = new Map();
    this.seen = new Map();
    this.lastError = '';
  }

  get status() {
    return { watching: Boolean(this.watcher), path: this.watchedPath, error: this.lastError };
  }

  start(folder) {
    this.stop();
    this.lastError = '';
    if (!folder) return this.status;

    const resolved = path.resolve(folder);
    if (!fs.existsSync(resolved)) {
      this.lastError = `Folder not found: ${resolved}`;
      console.error(`[tracki] ${this.lastError}`);
      return this.status;
    }
    if (!fs.statSync(resolved).isDirectory()) {
      this.lastError = `Not a folder: ${resolved}`;
      return this.status;
    }

    // Files already there when we start are history, not new saves.
    this.primeExisting(resolved);

    try {
      this.watcher = fs.watch(resolved, { recursive: true }, (eventType, filename) => {
        if (filename) this.onFsEvent(path.join(resolved, filename.toString()));
      });
      this.watcher.on('error', (err) => {
        this.lastError = err.message;
        console.error('[tracki] watcher error:', err.message);
      });
      this.watchedPath = resolved;
      console.log(`[tracki] Watching for saved CVs in ${resolved}`);
    } catch (err) {
      // recursive:true is unsupported on some platforms; fall back to flat watch.
      try {
        this.watcher = fs.watch(resolved, (eventType, filename) => {
          if (filename) this.onFsEvent(path.join(resolved, filename.toString()));
        });
        this.watchedPath = resolved;
        console.log(`[tracki] Watching (top level only) ${resolved}`);
      } catch (inner) {
        this.lastError = inner.message;
        console.error('[tracki] could not watch folder:', inner.message);
      }
    }
    return this.status;
  }

  primeExisting(folder, depth = 0) {
    if (depth > 4) return;
    let entries = [];
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) this.primeExisting(full, depth + 1);
      else if (entry.isFile()) {
        try {
          this.seen.set(full, fs.statSync(full).mtimeMs);
        } catch { /* ignore */ }
      }
    }
  }

  stop() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    for (const timer of this.pendingTimers.values()) clearTimeout(timer);
    this.pendingTimers.clear();
    this.watchedPath = '';
  }

  onFsEvent(filePath) {
    if (!CV_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return;
    if (path.basename(filePath).startsWith('~$')) return; // Office lock file
    if (this.pendingTimers.has(filePath)) return;
    const timer = setTimeout(() => {
      this.pendingTimers.delete(filePath);
      this.whenSettled(filePath, 0);
    }, 300);
    this.pendingTimers.set(filePath, timer);
  }

  whenSettled(filePath, attempt) {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return; // deleted or renamed away again
    }
    if (!stat.isFile()) return;

    const key = `${filePath}:size`;
    const previousSize = this.seen.get(key);
    this.seen.set(key, stat.size);

    if (previousSize !== stat.size && attempt < SETTLE_TRIES) {
      setTimeout(() => this.whenSettled(filePath, attempt + 1), SETTLE_MS);
      return;
    }

    const lastMtime = this.seen.get(filePath);
    if (lastMtime && Math.abs(stat.mtimeMs - lastMtime) < 1500) return; // already handled
    this.seen.set(filePath, stat.mtimeMs);

    this.queue(filePath);
  }

  queue(filePath) {
    try {
      const entry = suggestionFromFile(filePath);
      this.store.addPending(entry);
      console.log(`[tracki] CV saved: ${path.basename(filePath)} - asking whether to track it`);
      this.onQueued(entry);
    } catch (err) {
      console.error('[tracki] could not read saved CV:', err.message);
    }
  }
}

module.exports = { CvWatcher, CV_EXTENSIONS };
