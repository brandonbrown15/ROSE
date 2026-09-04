// Integrator dashboard, served directly by the Worker at `GET /dashboard` —
// the browser-based replacement for driving /integrator/* by hand with curl
// (see docs/integrators.md). Same approach as chatUI.ts: one self-contained
// HTML+CSS+JS string, no build step, same visual theme.
//
// Auth here is the signed session cookie (integrators.ts), not localStorage —
// the cookie is HttpOnly, so this page can't read it directly. Instead it
// probes `GET /integrator/households` on load: 200 means there's a valid
// session (show the dashboard), 401 means there isn't (show login/signup).
// Every fetch below relies on the browser sending that cookie automatically
// since this page is served same-origin.
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ROSE Integrator Dashboard</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f7f5f2;
    --panel: #ffffff;
    --text: #1a1a1a;
    --muted: #6b6b6b;
    --border: #e2ddd6;
    --accent: #a8324a;
    --accent-text: #ffffff;
    --error: #b3261e;
    --success: #2e7d32;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #17140f;
      --panel: #221e18;
      --text: #f2ede6;
      --muted: #a89f92;
      --border: #3a352c;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    min-height: 100vh;
  }
  a { color: var(--accent); }
  h1, h2, h3 { font-weight: 600; }
  p { line-height: 1.5; }
  label { display: block; font-size: 13px; font-weight: 600; margin: 14px 0 6px; }
  input {
    width: 100%;
    padding: 9px 12px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text);
    font-size: 14px;
  }
  input:focus { outline: none; border-color: var(--accent); }
  button {
    padding: 10px 16px;
    border-radius: 8px;
    border: none;
    background: var(--accent);
    color: var(--accent-text);
    font-weight: 600;
    cursor: pointer;
    font-size: 14px;
  }
  button:disabled { opacity: 0.5; cursor: default; }
  button.secondary {
    background: none;
    border: 1px solid var(--border);
    color: var(--text);
  }
  button.link {
    background: none;
    border: none;
    color: var(--accent);
    font-weight: 600;
    padding: 0;
    cursor: pointer;
    font-size: 13px;
  }
  .status { font-size: 13px; margin-top: 10px; min-height: 1.2em; }
  .status.error { color: var(--error); }
  .status.ok { color: var(--success); }
  .status.muted { color: var(--muted); }
  [hidden] { display: none !important; }

  /* --- Auth view --- */
  #auth {
    max-width: 400px;
    margin: 10vh auto;
    padding: 32px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 16px;
  }
  #auth h1 { font-size: 20px; margin: 0 0 4px; }
  #auth .sub { color: var(--muted); font-size: 13px; margin: 0 0 20px; }
  #auth form button[type="submit"] { width: 100%; margin-top: 18px; }
  #auth .switch { text-align: center; margin-top: 18px; font-size: 13px; color: var(--muted); }

  /* --- Dashboard view --- */
  header {
    padding: 16px 24px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: var(--panel);
  }
  header h1 { font-size: 17px; margin: 0; }
  header .sub { font-size: 12px; color: var(--muted); margin-top: 2px; }
  main {
    max-width: 720px;
    margin: 0 auto;
    padding: 24px 20px 60px;
  }
  .card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px;
    margin-bottom: 20px;
  }
  .card h2 { font-size: 15px; margin: 0 0 4px; }
  .card > .sub { color: var(--muted); font-size: 13px; margin: 0 0 4px; }

  #households { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; }
  .household {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px 16px;
  }
  .household .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .household .name { font-weight: 600; font-size: 14px; }
  .household .id { color: var(--muted); font-size: 12px; font-family: monospace; margin-top: 2px; }
  .household .ha-form { margin-top: 14px; border-top: 1px solid var(--border); padding-top: 14px; }
  .household .ha-form.hidden-form { display: none; }
  .empty { color: var(--muted); font-size: 13px; text-align: center; padding: 20px 0; }

  .apikey-banner {
    background: var(--bg);
    border: 1px solid var(--accent);
    border-radius: 10px;
    padding: 14px 16px;
    margin-top: 14px;
  }
  .apikey-banner .label { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
  .apikey-banner code {
    display: block;
    word-break: break-all;
    font-size: 13px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 10px;
    margin-bottom: 8px;
  }
  .apikey-banner .warn { color: var(--error); font-size: 12px; font-weight: 600; }
</style>
</head>
<body>

<div id="auth">
  <h1>ROSE for integrators</h1>
  <p class="sub">Manage your client households — device connections, access, and (soon) billing — from one dashboard.</p>

  <form id="loginForm">
    <label for="loginEmail">Email</label>
    <input id="loginEmail" type="email" autocomplete="username" required>
    <label for="loginPassword">Password</label>
    <input id="loginPassword" type="password" autocomplete="current-password" required>
    <button type="submit">Log in</button>
    <div id="loginStatus" class="status"></div>
  </form>

  <form id="signupForm" hidden>
    <label for="signupName">Company / your name (optional)</label>
    <input id="signupName" type="text" autocomplete="organization">
    <label for="signupEmail">Email</label>
    <input id="signupEmail" type="email" autocomplete="username" required>
    <label for="signupPassword">Password</label>
    <input id="signupPassword" type="password" autocomplete="new-password" required minlength="8">
    <button type="submit">Create account</button>
    <div id="signupStatus" class="status"></div>
  </form>

  <div class="switch">
    <span id="toSignup">New here? <button type="button" class="link" id="toSignupBtn">Create an account</button></span>
    <span id="toLogin" hidden>Already have an account? <button type="button" class="link" id="toLoginBtn">Log in</button></span>
  </div>
</div>

<div id="dashboard" hidden>
  <header>
    <div>
      <h1>ROSE dashboard</h1>
      <div class="sub" id="whoami"></div>
    </div>
    <button class="secondary" id="logoutBtn">Log out</button>
  </header>

  <main>
    <div class="card">
      <h2>Add a household</h2>
      <p class="sub">Creates a new client household and its access key. The key is shown once — copy it into the customer's Home Assistant integration or the ROSE chat page right away.</p>
      <form id="addHouseholdForm">
        <label for="householdName">Household name</label>
        <input id="householdName" type="text" placeholder="e.g. The Smith Residence" required>
        <button type="submit">Create household</button>
        <div id="addHouseholdStatus" class="status"></div>
      </form>
      <div id="apiKeyBanner" class="apikey-banner" hidden>
        <div class="label">Access key for <strong id="apiKeyHouseholdName"></strong> — save this now:</div>
        <code id="apiKeyValue"></code>
        <div class="warn">This won't be shown again. Give it to the customer for their Home Assistant integration or the ROSE chat page.</div>
      </div>
    </div>

    <div class="card">
      <h2>Households</h2>
      <p class="sub">Click a household to connect its Home Assistant instance.</p>
      <div id="households"></div>
      <div id="householdsEmpty" class="empty" hidden>No households yet — add one above.</div>
    </div>
  </main>
</div>

<script>
(function () {
  var authEl = document.getElementById('auth');
  var dashboardEl = document.getElementById('dashboard');
  var loginForm = document.getElementById('loginForm');
  var signupForm = document.getElementById('signupForm');
  var loginStatus = document.getElementById('loginStatus');
  var signupStatus = document.getElementById('signupStatus');
  var householdsEl = document.getElementById('households');
  var householdsEmptyEl = document.getElementById('householdsEmpty');
  var addHouseholdForm = document.getElementById('addHouseholdForm');
  var addHouseholdStatus = document.getElementById('addHouseholdStatus');
  var apiKeyBanner = document.getElementById('apiKeyBanner');
  var whoamiEl = document.getElementById('whoami');

  function api(path, opts) {
    opts = opts || {};
    opts.credentials = 'same-origin';
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    return fetch(path, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { ok: res.ok, status: res.status, data: data };
      });
    });
  }

  function setStatus(el, message, kind) {
    el.textContent = message || '';
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  function showAuth() {
    dashboardEl.hidden = true;
    authEl.hidden = false;
  }

  function showDashboard(email) {
    authEl.hidden = true;
    dashboardEl.hidden = false;
    whoamiEl.textContent = email || '';
  }

  // --- Login / signup toggle ---
  document.getElementById('toSignupBtn').addEventListener('click', function () {
    loginForm.hidden = true;
    signupForm.hidden = false;
    document.getElementById('toSignup').hidden = true;
    document.getElementById('toLogin').hidden = false;
  });
  document.getElementById('toLoginBtn').addEventListener('click', function () {
    signupForm.hidden = true;
    loginForm.hidden = false;
    document.getElementById('toLogin').hidden = true;
    document.getElementById('toSignup').hidden = false;
  });

  loginForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var email = document.getElementById('loginEmail').value.trim();
    var password = document.getElementById('loginPassword').value;
    setStatus(loginStatus, 'Logging in…', 'muted');
    api('/integrator/login', { method: 'POST', body: JSON.stringify({ email: email, password: password }) })
      .then(function (result) {
        if (!result.ok) {
          setStatus(loginStatus, result.data.error || 'login failed', 'error');
          return;
        }
        setStatus(loginStatus, '', '');
        loadHouseholds(email);
      })
      .catch(function (err) {
        setStatus(loginStatus, 'Could not reach ROSE. (' + err.message + ')', 'error');
      });
  });

  signupForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var name = document.getElementById('signupName').value.trim();
    var email = document.getElementById('signupEmail').value.trim();
    var password = document.getElementById('signupPassword').value;
    if (password.length < 8) {
      setStatus(signupStatus, 'Password must be at least 8 characters.', 'error');
      return;
    }
    setStatus(signupStatus, 'Creating account…', 'muted');
    api('/integrator/signup', { method: 'POST', body: JSON.stringify({ email: email, password: password, name: name || undefined }) })
      .then(function (result) {
        if (!result.ok) {
          setStatus(signupStatus, result.data.error || 'signup failed', 'error');
          return;
        }
        setStatus(signupStatus, '', '');
        loadHouseholds(email);
      })
      .catch(function (err) {
        setStatus(signupStatus, 'Could not reach ROSE. (' + err.message + ')', 'error');
      });
  });

  document.getElementById('logoutBtn').addEventListener('click', function () {
    api('/integrator/logout', { method: 'POST' }).then(function () {
      showAuth();
    });
  });

  // --- Households ---
  function renderHouseholds(households) {
    householdsEl.innerHTML = '';
    householdsEmptyEl.hidden = households.length > 0;
    households.forEach(function (h) {
      var wrap = document.createElement('div');
      wrap.className = 'household';

      var row = document.createElement('div');
      row.className = 'row';
      var info = document.createElement('div');
      info.innerHTML = '<div class="name"></div><div class="id"></div>';
      info.querySelector('.name').textContent = h.name;
      info.querySelector('.id').textContent = h.id;
      var toggleBtn = document.createElement('button');
      toggleBtn.className = 'secondary';
      toggleBtn.textContent = 'Home Assistant';
      row.appendChild(info);
      row.appendChild(toggleBtn);
      wrap.appendChild(row);

      var haForm = document.createElement('form');
      haForm.className = 'ha-form hidden-form';
      haForm.innerHTML =
        '<label>Home Assistant URL</label>' +
        '<input type="text" class="ha-url" placeholder="https://homeassistant.local:8123" required>' +
        '<label>Long-lived access token</label>' +
        '<input type="password" class="ha-token" placeholder="paste token" required>' +
        '<button type="submit">Save connection</button>' +
        '<div class="status ha-status"></div>';
      wrap.appendChild(haForm);

      toggleBtn.addEventListener('click', function () {
        haForm.classList.toggle('hidden-form');
      });

      haForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var urlVal = haForm.querySelector('.ha-url').value.trim();
        var tokenVal = haForm.querySelector('.ha-token').value.trim();
        var haStatus = haForm.querySelector('.ha-status');
        setStatus(haStatus, 'Saving…', 'muted');
        api('/integrator/households/' + encodeURIComponent(h.id) + '/ha', {
          method: 'POST',
          body: JSON.stringify({ url: urlVal, token: tokenVal })
        }).then(function (result) {
          if (!result.ok) {
            setStatus(haStatus, result.data.error || 'failed to save', 'error');
            return;
          }
          setStatus(haStatus, 'Connected.', 'ok');
          haForm.querySelector('.ha-token').value = '';
        }).catch(function (err) {
          setStatus(haStatus, 'Could not reach ROSE. (' + err.message + ')', 'error');
        });
      });

      householdsEl.appendChild(wrap);
    });
  }

  function loadHouseholds(email) {
    return api('/integrator/households').then(function (result) {
      if (!result.ok) {
        showAuth();
        return false;
      }
      showDashboard(email);
      renderHouseholds(result.data.households || []);
      return true;
    });
  }

  addHouseholdForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var nameInput = document.getElementById('householdName');
    var name = nameInput.value.trim();
    if (!name) return;
    setStatus(addHouseholdStatus, 'Creating…', 'muted');
    apiKeyBanner.hidden = true;
    api('/integrator/households', { method: 'POST', body: JSON.stringify({ name: name }) })
      .then(function (result) {
        if (!result.ok) {
          setStatus(addHouseholdStatus, result.data.error || 'failed to create household', 'error');
          return;
        }
        setStatus(addHouseholdStatus, 'Household created.', 'ok');
        nameInput.value = '';
        document.getElementById('apiKeyHouseholdName').textContent = result.data.household.name;
        document.getElementById('apiKeyValue').textContent = result.data.household.api_key;
        apiKeyBanner.hidden = false;
        loadHouseholds(whoamiEl.textContent);
      })
      .catch(function (err) {
        setStatus(addHouseholdStatus, 'Could not reach ROSE. (' + err.message + ')', 'error');
      });
  });

  // Init: the session cookie is HttpOnly (unreadable here), so probe the
  // API — 200 means already logged in, 401 means show the auth view.
  loadHouseholds('').catch(function () { showAuth(); });
})();
</script>

</body>
</html>
`;
