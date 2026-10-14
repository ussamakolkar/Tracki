/*!
 * Tracki bridge - drop into the Parsable CV app.
 *
 *   <script src="http://127.0.0.1:4321/integration/tracki-bridge.js"></script>
 *
 * Then, right after your app saves a CV:
 *
 *   Tracki.onCvSaved({
 *     role:    'Senior Backend Engineer',   // all fields optional
 *     company: 'Acme Corp',
 *     jobUrl:  'https://acme.com/jobs/42',
 *     cvFilePath: 'D:\\CVs\\CV_Acme_v3.pdf',
 *     cvVersion:  'CV_backend_v3'
 *   });
 *
 * That raises a dialogue box asking whether to add the job to Tracki. If the
 * answer is yes, the job is written straight into the tracker.
 *
 * Nothing here depends on how Parsable CV is built: no framework, no bundler,
 * no globals other than `Tracki`, and its styles are namespaced so they cannot
 * leak into your page.
 */
(function () {
  'use strict';

  if (window.Tracki && window.Tracki.__loaded) return;

  var DEFAULT_ORIGIN = (function () {
    // Prefer the origin this script was served from, so the port always matches.
    var script = document.currentScript;
    if (script && script.src) {
      try {
        return new URL(script.src).origin;
      } catch (err) { /* fall through */ }
    }
    return 'http://127.0.0.1:4321';
  })();

  var config = {
    origin: DEFAULT_ORIGIN,
    // 'dialog'  - ask here, in the Parsable CV window (the default)
    // 'queue'   - don't ask here; let the Tracki window raise the prompt
    mode: 'dialog',
    defaultStatus: 'Applied',
  };

  var STYLE_ID = 'tracki-bridge-style';
  var CSS =
    '.tracki-overlay{position:fixed;inset:0;background:rgba(10,16,24,.55);z-index:2147483000;' +
    'display:flex;align-items:center;justify-content:center;padding:16px;' +
    'font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#16202b}' +
    '.tracki-card{background:#fff;border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.35);' +
    'width:min(520px,100%);max-height:88vh;overflow:auto;padding:22px 24px}' +
    '.tracki-card h2{margin:0 0 4px;font-size:18px}' +
    '.tracki-card p.tracki-sub{margin:0 0 16px;font-size:13px;color:#5d6b7a}' +
    '.tracki-row{display:flex;flex-direction:column;gap:4px;margin-bottom:11px}' +
    '.tracki-row label{font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#5d6b7a}' +
    '.tracki-row input,.tracki-row select,.tracki-row textarea{font:inherit;padding:9px 10px;border:1px solid #d9e0e8;' +
    'border-radius:8px;background:#fff;color:#16202b;width:100%;box-sizing:border-box}' +
    '.tracki-row textarea{min-height:60px;resize:vertical}' +
    '.tracki-two{display:grid;grid-template-columns:1fr 1fr;gap:11px}' +
    '.tracki-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:18px;padding-top:14px;border-top:1px solid #e6ebf1}' +
    '.tracki-btn{font:inherit;padding:9px 15px;border-radius:8px;border:1px solid #d9e0e8;background:#eef2f7;color:#16202b;cursor:pointer}' +
    '.tracki-btn-primary{background:#1f6feb;border-color:#1f6feb;color:#fff}' +
    '.tracki-btn:disabled{opacity:.6;cursor:default}' +
    '.tracki-note{font-size:13px;padding:9px 11px;border-radius:8px;margin-bottom:12px;' +
    'background:#fff6e0;border:1px solid #e8c268}' +
    '.tracki-note-bad{background:#fdecea;border-color:#c23934}' +
    '.tracki-toast{position:fixed;right:18px;bottom:18px;z-index:2147483000;background:#16202b;color:#fff;' +
    'padding:11px 16px;border-radius:10px;font:14px/1.4 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.3);max-width:330px}' +
    '@media (prefers-color-scheme:dark){.tracki-card{background:#1a212a;color:#e6edf3}' +
    '.tracki-card p.tracki-sub,.tracki-row label{color:#93a1b1}' +
    '.tracki-row input,.tracki-row select,.tracki-row textarea{background:#11161c;color:#e6edf3;border-color:#2f3a47}' +
    '.tracki-btn{background:#222b36;color:#e6edf3;border-color:#2f3a47}' +
    '.tracki-btn-primary{background:#4a8cff;border-color:#4a8cff;color:#fff}' +
    '.tracki-foot{border-top-color:#2f3a47}}';

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function request(path, options) {
    options = options || {};
    return fetch(config.origin + path, {
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      mode: 'cors',
    }).then(function (response) {
      return response.text().then(function (text) {
        var data = text ? JSON.parse(text) : {};
        if (!response.ok) {
          var error = new Error((data.errors || ['Tracki rejected the request']).join('; '));
          error.status = response.status;
          error.payload = data;
          throw error;
        }
        return data;
      });
    });
  }

  function toast(message) {
    var node = document.createElement('div');
    node.className = 'tracki-toast';
    node.textContent = message;
    document.body.appendChild(node);
    setTimeout(function () {
      node.remove();
    }, 4000);
  }

  /** Is Tracki running? Resolves to the ping payload, or null. */
  function ping() {
    return request('/api/ping').catch(function () {
      return null;
    });
  }

  function row(label, name, value, type) {
    var wrap = document.createElement('div');
    wrap.className = 'tracki-row';
    var id = 'tracki-f-' + name;
    var labelNode = document.createElement('label');
    labelNode.setAttribute('for', id);
    labelNode.textContent = label;
    var input;
    if (type === 'textarea') {
      input = document.createElement('textarea');
    } else if (type === 'status') {
      input = document.createElement('select');
      ['Applied', 'Wishlist', 'Screening', 'Interview', 'Offer'].forEach(function (status) {
        var option = document.createElement('option');
        option.value = status;
        option.textContent = status;
        if (status === (value || config.defaultStatus)) option.selected = true;
        input.appendChild(option);
      });
    } else {
      input = document.createElement('input');
      input.type = type || 'text';
    }
    input.id = id;
    input.name = name;
    if (type !== 'status') input.value = value == null ? '' : value;
    wrap.appendChild(labelNode);
    wrap.appendChild(input);
    return { wrap: wrap, input: input };
  }

  /**
   * The dialogue box itself.
   * @returns {Promise<object|null>} the job that was added, or null if declined
   */
  function askDialog(details, context) {
    injectStyle();
    details = details || {};
    context = context || {};

    return new Promise(function (resolve) {
      var overlay = document.createElement('div');
      overlay.className = 'tracki-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');

      var card = document.createElement('div');
      card.className = 'tracki-card';

      var heading = document.createElement('h2');
      heading.textContent = 'Add this job to your tracker?';
      var sub = document.createElement('p');
      sub.className = 'tracki-sub';
      var fileName = (details.cvFilePath || details.cvVersion || '').split(/[\\/]/).pop();
      sub.textContent = fileName
        ? 'Your CV "' + fileName + '" was saved. Tracki can keep this application on its tracker sheet.'
        : 'Your CV was saved. Tracki can keep this application on its tracker sheet.';
      card.appendChild(heading);
      card.appendChild(sub);

      if (context.duplicate) {
        var note = document.createElement('div');
        note.className = 'tracki-note';
        note.textContent =
          'You already track "' + context.duplicate.role + ' at ' + context.duplicate.company +
          '" (' + context.duplicate.status + '). Adding it again creates a second row.';
        card.appendChild(note);
      }

      var problem = document.createElement('div');
      problem.className = 'tracki-note tracki-note-bad';
      problem.style.display = 'none';
      card.appendChild(problem);

      var roleRow = row('Role *', 'role', details.role, 'text');
      var companyRow = row('Company *', 'company', details.company, 'text');
      var linkRow = row('Job link', 'jobUrl', details.jobUrl, 'text');
      var locationRow = row('Location', 'location', details.location, 'text');
      var statusRow = row('Status', 'status', details.status, 'status');
      var cvRow = row('CV version', 'cvVersion', details.cvVersion || fileName, 'text');
      var notesRow = row('Notes', 'notes', details.notes, 'textarea');

      card.appendChild(roleRow.wrap);
      card.appendChild(companyRow.wrap);
      card.appendChild(linkRow.wrap);
      var pair = document.createElement('div');
      pair.className = 'tracki-two';
      pair.appendChild(locationRow.wrap);
      pair.appendChild(statusRow.wrap);
      card.appendChild(pair);
      card.appendChild(cvRow.wrap);
      card.appendChild(notesRow.wrap);

      var foot = document.createElement('div');
      foot.className = 'tracki-foot';
      var noButton = document.createElement('button');
      noButton.type = 'button';
      noButton.className = 'tracki-btn';
      noButton.textContent = 'No thanks';
      var yesButton = document.createElement('button');
      yesButton.type = 'button';
      yesButton.className = 'tracki-btn tracki-btn-primary';
      yesButton.textContent = 'Add to Tracki';
      foot.appendChild(noButton);
      foot.appendChild(yesButton);
      card.appendChild(foot);
      overlay.appendChild(card);
      document.body.appendChild(overlay);

      var previousFocus = document.activeElement;
      setTimeout(function () {
        (details.role ? companyRow.input : roleRow.input).focus();
      }, 20);

      function close(result) {
        document.removeEventListener('keydown', onKeydown, true);
        overlay.remove();
        if (previousFocus && previousFocus.focus) previousFocus.focus();
        resolve(result);
      }

      function onKeydown(event) {
        if (event.key === 'Escape') {
          event.stopPropagation();
          close(null);
        }
      }
      document.addEventListener('keydown', onKeydown, true);
      overlay.addEventListener('click', function (event) {
        if (event.target === overlay) close(null);
      });
      noButton.addEventListener('click', function () {
        close(null);
      });

      function submit(allowDuplicate) {
        var payload = {
          confirm: true,
          allowDuplicate: Boolean(allowDuplicate),
          role: roleRow.input.value,
          company: companyRow.input.value,
          jobUrl: linkRow.input.value,
          location: locationRow.input.value,
          cvVersion: cvRow.input.value,
          cvFilePath: details.cvFilePath || '',
          notes: notesRow.input.value,
          source: details.source || 'Parsable CV',
          job: { status: statusRow.input.value },
        };
        yesButton.disabled = true;
        yesButton.textContent = 'Adding...';
        problem.style.display = 'none';

        request('/api/intake', { method: 'POST', body: payload })
          .then(function (data) {
            toast('Added to Tracki: ' + payload.role + ' at ' + payload.company);
            close(data.job || null);
          })
          .catch(function (err) {
            yesButton.disabled = false;
            yesButton.textContent = 'Add to Tracki';
            if (err.status === 409 && !allowDuplicate) {
              problem.textContent = err.message + ' Press "Add to Tracki" again to add it anyway.';
              problem.style.display = '';
              yesButton.onclick = function () {
                submit(true);
              };
              return;
            }
            problem.textContent =
              err.status === undefined
                ? 'Could not reach Tracki at ' + config.origin + '. Start it (npm start in the Tracki folder) and try again.'
                : err.message;
            problem.style.display = '';
          });
      }

      yesButton.addEventListener('click', function () {
        submit(false);
      });
      card.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' && event.target.tagName !== 'TEXTAREA') {
          event.preventDefault();
          submit(false);
        }
      });
    });
  }

  /**
   * Call this when Parsable CV finishes saving a CV.
   * @param {object} details what you know about the job (every field optional)
   * @returns {Promise<object|null>}
   */
  function onCvSaved(details) {
    details = details || {};
    if (config.mode === 'queue') {
      return request('/api/intake', { method: 'POST', body: details })
        .then(function (data) {
          toast('Tracki is asking about this job in its own window.');
          return data;
        })
        .catch(function () {
          toast('Tracki is not running, so this CV was not queued.');
          return null;
        });
    }

    // Ask Tracki what it knows first (ask:true queues nothing, so the Tracki
    // window does not raise a second dialog about the same CV).
    return request('/api/intake', { method: 'POST', body: Object.assign({ ask: true }, details) })
      .then(function (data) {
        var suggestion = data.suggestion || {};
        // Merge what Tracki worked out from the file with what we were told,
        // letting our own values win.
        var merged = {};
        Object.keys(suggestion).forEach(function (key) {
          if (suggestion[key] !== '' && suggestion[key] !== undefined) merged[key] = suggestion[key];
        });
        Object.keys(details).forEach(function (key) {
          if (details[key] !== '' && details[key] !== undefined) merged[key] = details[key];
        });
        return askDialog(merged, { duplicate: data.duplicate });
      })
      .catch(function () {
        // Tracki is not running: still ask, so a retry after starting it works.
        return askDialog(details, {});
      });
  }

  /**
   * Wire the dialogue up without touching your save code.
   *
   *   Tracki.autoHook();                      // elements marked data-tracki-save
   *   Tracki.autoHook({heuristics: true});    // plus buttons that look like "Save CV"
   *
   * Field values are read from data-tracki-* attributes on the clicked element,
   * or from inputs named role/company/jobUrl anywhere on the page.
   */
  function autoHook(options) {
    options = options || {};
    var guard = 0;

    function readPageFields(element) {
      var details = {};
      var dataset = (element && element.dataset) || {};
      ['role', 'company', 'jobUrl', 'location', 'cvVersion', 'cvFilePath', 'notes'].forEach(function (key) {
        var attribute = 'tracki' + key.charAt(0).toUpperCase() + key.slice(1);
        if (dataset[attribute]) details[key] = dataset[attribute];
      });
      var selectors = {
        role: '[name="role"],[name="jobTitle"],[name="targetRole"],#role,#jobTitle',
        company: '[name="company"],[name="companyName"],#company,#companyName',
        jobUrl: '[name="jobUrl"],[name="jobLink"],#jobUrl,#jobLink',
        location: '[name="location"],#location',
      };
      Object.keys(selectors).forEach(function (key) {
        if (details[key]) return;
        var node = document.querySelector(selectors[key]);
        if (node && node.value) details[key] = node.value;
      });
      return details;
    }

    document.addEventListener(
      'click',
      function (event) {
        var target = event.target.closest('[data-tracki-save]');
        if (!target && options.heuristics) {
          var candidate = event.target.closest('button,a,input[type="submit"]');
          var text = candidate ? (candidate.textContent || candidate.value || '').trim() : '';
          if (candidate && /\b(save|download|export|generate)\b/i.test(text) && /\b(cv|resume|pdf|docx?)\b/i.test(text + ' ' + (candidate.className || ''))) {
            target = candidate;
          }
        }
        if (!target) return;
        var now = Date.now();
        if (now - guard < 1500) return; // one dialogue per save
        guard = now;
        // Let the app's own save handler run first.
        setTimeout(function () {
          onCvSaved(readPageFields(target));
        }, options.delay || 600);
      },
      true
    );

    return true;
  }

  window.Tracki = {
    __loaded: true,
    version: 1,
    config: config,
    configure: function (patch) {
      Object.keys(patch || {}).forEach(function (key) {
        config[key] = patch[key];
      });
      return config;
    },
    onCvSaved: onCvSaved,
    ask: askDialog,
    autoHook: autoHook,
    ping: ping,
    /** Add a job with no dialogue at all. */
    addJob: function (details) {
      return request('/api/intake', { method: 'POST', body: Object.assign({ confirm: true }, details) });
    },
    open: function () {
      window.open(config.origin, '_blank', 'noopener');
    },
  };

  // Honour <script ... data-auto-hook="heuristics">
  (function () {
    var script = document.currentScript;
    if (!script) return;
    var auto = script.getAttribute('data-auto-hook');
    if (auto === 'true' || auto === 'heuristics') {
      var ready = function () {
        autoHook({ heuristics: auto === 'heuristics' });
      };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
      else ready();
    }
  })();
})();
