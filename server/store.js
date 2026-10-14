'use strict';
/**
 * Durable storage for the tracker.
 *
 * A single JSON file keeps the whole thing portable (copy data/tracki-data.json
 * and your tracker moves with you). Writes go to a temp file and are renamed,
 * so an interrupted write can never truncate the real data, and the previous
 * version is kept as a rotating backup.
 */
const fs = require('fs');
const path = require('path');

const DATA_VERSION = 1;
const MAX_BACKUPS = 15;

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.backupDir = path.join(dataDir, 'backups');
    this.file = path.join(dataDir, 'tracki-data.json');
    this.data = { version: DATA_VERSION, jobs: [], pending: [], settings: {} };
    this.writeQueue = Promise.resolve();
  }

  load() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (!fs.existsSync(this.file)) {
      this.persistSync();
      return this.data;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = {
        version: parsed.version || DATA_VERSION,
        jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
        pending: Array.isArray(parsed.pending) ? parsed.pending : [],
        settings: parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {},
      };
    } catch (err) {
      // Never silently start from scratch on top of a readable-but-broken file.
      const quarantine = path.join(this.dataDir, `corrupt-${Date.now()}.json`);
      fs.copyFileSync(this.file, quarantine);
      console.error(`[tracki] Could not parse ${this.file}: ${err.message}`);
      console.error(`[tracki] The unreadable file was copied to ${quarantine}; starting with an empty tracker.`);
      const latest = this.latestBackup();
      if (latest) console.error(`[tracki] A recent backup exists at ${latest} if you want to restore it.`);
    }
    return this.data;
  }

  latestBackup() {
    if (!fs.existsSync(this.backupDir)) return null;
    const files = fs
      .readdirSync(this.backupDir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .reverse();
    return files.length ? path.join(this.backupDir, files[0]) : null;
  }

  persistSync() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const payload = JSON.stringify(this.data, null, 2);
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, this.file);
  }

  /** Serialised async save: concurrent requests cannot interleave writes. */
  save() {
    this.writeQueue = this.writeQueue.then(() => this.writeOnce()).catch((err) => {
      console.error('[tracki] save failed:', err.message);
    });
    return this.writeQueue;
  }

  async writeOnce() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.mkdirSync(this.backupDir, { recursive: true });
    if (fs.existsSync(this.file)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      try {
        fs.copyFileSync(this.file, path.join(this.backupDir, `tracki-${stamp}.json`));
      } catch (err) {
        console.error('[tracki] backup failed:', err.message);
      }
      this.pruneBackups();
    }
    const payload = JSON.stringify(this.data, null, 2);
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, payload, 'utf8');
    await fs.promises.rename(tmp, this.file);
  }

  pruneBackups() {
    try {
      const files = fs.readdirSync(this.backupDir).filter((n) => n.startsWith('tracki-')).sort();
      for (const stale of files.slice(0, Math.max(0, files.length - MAX_BACKUPS))) {
        fs.unlinkSync(path.join(this.backupDir, stale));
      }
    } catch { /* backups are best-effort */ }
  }

  // ---- jobs ----
  listJobs() {
    return this.data.jobs;
  }

  getJob(id) {
    return this.data.jobs.find((job) => job.id === id) || null;
  }

  addJob(job) {
    this.data.jobs.push(job);
    this.save();
    return job;
  }

  replaceJob(id, job) {
    const index = this.data.jobs.findIndex((item) => item.id === id);
    if (index === -1) return null;
    this.data.jobs[index] = job;
    this.save();
    return job;
  }

  deleteJob(id) {
    const index = this.data.jobs.findIndex((item) => item.id === id);
    if (index === -1) return false;
    this.data.jobs.splice(index, 1);
    this.save();
    return true;
  }

  // ---- pending intake queue (CV saves awaiting a yes/no) ----
  listPending() {
    return this.data.pending;
  }

  addPending(entry) {
    // One prompt per CV file; a re-save refreshes the existing prompt.
    const existing = this.data.pending.findIndex(
      (item) => item.cvFilePath && item.cvFilePath === entry.cvFilePath
    );
    if (existing !== -1) this.data.pending[existing] = { ...this.data.pending[existing], ...entry };
    else this.data.pending.push(entry);
    if (this.data.pending.length > 50) this.data.pending = this.data.pending.slice(-50);
    this.save();
    return entry;
  }

  getPending(id) {
    return this.data.pending.find((item) => item.id === id) || null;
  }

  removePending(id) {
    const index = this.data.pending.findIndex((item) => item.id === id);
    if (index === -1) return false;
    this.data.pending.splice(index, 1);
    this.save();
    return true;
  }

  // ---- settings ----
  getSettings() {
    return this.data.settings;
  }

  updateSettings(patch) {
    this.data.settings = { ...this.data.settings, ...patch };
    this.save();
    return this.data.settings;
  }
}

module.exports = { Store, DATA_VERSION };
