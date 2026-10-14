'use strict';
/** Runtime configuration: file, then environment, then defaults. */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// TRACKI_CONFIG_FILE lets tests (and multiple profiles) keep their own config.
const CONFIG_FILE = process.env.TRACKI_CONFIG_FILE
  ? path.resolve(process.env.TRACKI_CONFIG_FILE)
  : path.join(ROOT, 'tracki.config.json');

const DEFAULTS = {
  port: 4321,
  host: '127.0.0.1',
  dataDir: path.join(ROOT, 'data'),
  // Folder Parsable CV writes finished CVs into. Set this on your own machine,
  // e.g. "D:\\claude code repo\\Parsable CV\\output".
  parsableCvPath: '',
  // Watch that folder and raise the "add to Tracki?" prompt on a new CV.
  watchParsableCv: true,
  // Extra browser origins allowed to POST into the intake endpoint. The
  // localhost/127.0.0.1 origins Parsable CV is likely to run on are always allowed.
  allowedOrigins: [],
  openBrowserOnStart: true,
};

function loadConfig() {
  let fromFile = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      fromFile = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (err) {
      console.error(`[tracki] Ignoring ${CONFIG_FILE}: ${err.message}`);
    }
  }
  const config = { ...DEFAULTS, ...fromFile };
  if (process.env.TRACKI_PORT) config.port = Number(process.env.TRACKI_PORT);
  if (process.env.TRACKI_DATA_DIR) config.dataDir = process.env.TRACKI_DATA_DIR;
  if (process.env.TRACKI_CV_PATH) config.parsableCvPath = process.env.TRACKI_CV_PATH;
  if (process.env.TRACKI_NO_BROWSER) config.openBrowserOnStart = false;
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) config.port = DEFAULTS.port;
  if (!Array.isArray(config.allowedOrigins)) config.allowedOrigins = [];
  return config;
}

/** Persist the user-editable slice of the config (written from the UI). */
function saveConfig(patch) {
  const current = fs.existsSync(CONFIG_FILE)
    ? (() => {
        try {
          return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        } catch {
          return {};
        }
      })()
    : {};
  const next = { ...current, ...patch };
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
  return next;
}

module.exports = { loadConfig, saveConfig, DEFAULTS, CONFIG_FILE, ROOT };
