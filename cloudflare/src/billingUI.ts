// Homeowner billing portal, served directly by the Worker at GET /portal —
// same self-contained-page approach as chatUI.ts and dashboardUI.ts. This
// is the third, separate login (customers.ts): a homeowner claims their
// own household here using its existing api_key, then manages their own
// subscription independent of whoever installed the system. See
// docs/billing.md.
//
// Card entry uses Stripe Elements (loaded from Stripe's own CDN,
// js.stripe.com — a real external site this Worker serves to real
// browsers, not a sandboxed artifact) so card numbers never touch this
// Worker at all; only a client_secret and payment_method id cross the
// wire to us.
export const BILLING_UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ROSE Billing</title>
<script src="https://js.stripe.com/v3/"></script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&display=swap" rel="stylesheet">
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
    --accent-soft: rgba(168, 50, 74, 0.08);
    --error: #b3261e;
    --success: #2e7d32;
    --success-soft: #d5f0d8;
    --error-soft: #f6d6d3;
    --radius-sm: 8px;
    --radius-md: 12px;
    --radius-lg: 18px;
    --shadow-sm: 0 1px 2px rgba(20, 16, 12, 0.05);
    --shadow-md: 0 2px 4px rgba(20, 16, 12, 0.04), 0 12px 28px -12px rgba(20, 16, 12, 0.18);
    --font-display: "Fraunces", Georgia, "Times New Roman", serif;
    --font-body: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #17140f;
      --panel: #221e18;
      --text: #f2ede6;
      --muted: #a89f92;
      --border: #3a352c;
      --accent-soft: rgba(224, 122, 145, 0.12);
      --success-soft: rgba(46, 125, 50, 0.18);
      --error-soft: rgba(179, 38, 30, 0.18);
      --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.35);
      --shadow-md: 0 2px 4px rgba(0, 0, 0, 0.3), 0 16px 32px -16px rgba(0, 0, 0, 0.55);
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-body);
    -webkit-font-smoothing: antialiased;
    min-height: 100vh;
  }
  h1, h2 { font-family: var(--font-display); font-weight: 600; letter-spacing: -0.01em; }
  p { line-height: 1.5; }
  label { display: block; font-size: 12.5px; font-weight: 600; margin: 16px 0 6px; color: var(--muted); text-transform: uppercase; letter-spacing: .02em; }
  input {
    width: 100%;
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text);
    font-size: 14px;
    font-family: var(--font-body);
    transition: border-color .15s ease, box-shadow .15s ease;
  }
  input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  button {
    padding: 10px 16px;
    border-radius: var(--radius-sm);
    border: none;
    background: var(--accent);
    color: var(--accent-text);
    font-weight: 600;
    cursor: pointer;
    font-size: 14px;
    box-shadow: var(--shadow-sm);
    transition: filter .15s ease, transform .05s ease;
  }
  button:hover:not(:disabled) { filter: brightness(1.08); }
  button:active:not(:disabled) { transform: translateY(1px); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button:disabled { opacity: 0.5; cursor: default; filter: none; transform: none; }
  button.secondary { background: none; border: 1px solid var(--border); color: var(--text); box-shadow: none; }
  button.secondary:hover:not(:disabled) { background: var(--accent-soft); border-color: var(--accent); filter: none; }
  button.link { background: none; border: none; color: var(--accent); font-weight: 600; padding: 0; cursor: pointer; font-size: 13px; box-shadow: none; }
  button.link:hover { text-decoration: underline; filter: none; }
  .status { font-size: 13px; margin-top: 10px; min-height: 1.2em; }
  .status.error { color: var(--error); }
  .status.ok { color: var(--success); }
  .status.muted { color: var(--muted); }
  [hidden] { display: none !important; }

  .brand { display: flex; align-items: center; gap: 10px; }
  .brand .mark {
    width: 32px; height: 32px; border-radius: 9px; flex-shrink: 0;
    background: linear-gradient(155deg, var(--accent), #c8677c);
    color: #fff; display: flex; align-items: center; justify-content: center;
    font-family: var(--font-display); font-weight: 700; font-size: 16px;
    box-shadow: var(--shadow-sm);
  }
  .brand .wordmark { font-family: var(--font-display); font-weight: 600; font-size: 17px; letter-spacing: -0.01em; line-height: 1.2; }
  .brand .tagline { font-size: 11.5px; color: var(--muted); margin-top: 1px; text-transform: uppercase; letter-spacing: .04em; }

  #card { max-width: 420px; margin: 8vh auto; padding: 36px; background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-md); }
  #card .brand { margin-bottom: 18px; }
  #card .sub { color: var(--muted); font-size: 13.5px; margin: 0 0 22px; line-height: 1.55; }
  #card form button[type="submit"] { width: 100%; margin-top: 18px; }
  .switch { text-align: center; margin-top: 18px; font-size: 13px; color: var(--muted); }

  header { padding: 18px 24px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; background: var(--panel); }
  .header-right { display: flex; align-items: center; gap: 16px; }
  .header-right .sub { font-size: 12.5px; color: var(--muted); }
  main { max-width: 480px; margin: 0 auto; padding: 32px 20px 60px; }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 22px; margin-bottom: 20px; box-shadow: var(--shadow-sm); }
  .badge { display: inline-flex; align-items: center; gap: 5px; padding: 4px 11px; border-radius: 999px; font-size: 11.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; }
  .badge::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .badge.active { background: var(--success-soft); color: var(--success); }
  .badge.lapsed { background: var(--error-soft); color: var(--error); }
  .badge.none { background: var(--border); color: var(--muted); }
  #card-element { padding: 11px 12px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--bg); margin-top: 8px; transition: border-color .15s ease, box-shadow .15s ease; }
  #card-element.StripeElement--focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  #card-errors { color: var(--error); font-size: 13px; margin-top: 8px; min-height: 1.2em; }
</style>
</head>
<body>

<div id="auth" hidden>
  <div id="card">
    <div class="brand">
      <div class="mark">R</div>
      <div>
        <div class="wordmark">ROSE</div>
        <div class="tagline">Billing</div>
      </div>
    </div>
    <p class="sub">Manage your household's subscription.</p>

    <form id="loginForm">
      <label for="loginEmail">Email</label>
      <input id="loginEmail" type="email" autocomplete="username" required>
      <label for="loginPassword">Password</label>
      <input id="loginPassword" type="password" autocomplete="current-password" required>
      <button type="submit">Log in</button>
      <div id="loginStatus" class="status"></div>
    </form>

    <form id="claimForm" hidden>
      <p class="sub" style="margin:0 0 4px;">First time here? Use the access key your installer gave you (the same one used for the ROSE chat page or Home Assistant) to set up your own login.</p>
      <label for="claimApiKey">Household access key</label>
      <input id="claimApiKey" type="password" autocomplete="off" required>
      <label for="claimEmail">Email</label>
      <input id="claimEmail" type="email" autocomplete="username" required>
      <label for="claimPassword">Password</label>
      <input id="claimPassword" type="password" autocomplete="new-password" required minlength="8">
      <button type="submit">Set up my account</button>
      <div id="claimStatus" class="status"></div>
    </form>

    <div class="switch">
      <span id="toClaim">First time? <button type="button" class="link" id="toClaimBtn">Set up your account</button></span>
      <span id="toLogin" hidden>Already set up? <button type="button" class="link" id="toLoginBtn">Log in</button></span>
    </div>
  </div>
</div>

<div id="billing" hidden>
  <header>
    <div class="brand">
      <div class="mark">R</div>
      <div>
        <div class="wordmark">ROSE</div>
        <div class="tagline">Billing</div>
      </div>
    </div>
    <div class="header-right">
      <div class="sub" id="whoami"></div>
      <button class="secondary" id="logoutBtn">Log out</button>
    </div>
  </header>

  <main>
    <div class="panel">
      <h2>Subscription</h2>
      <p><span class="badge" id="statusBadge"></span> <span class="badge" id="heatingBadge" hidden></span></p>

      <div id="subscribeSection">
        <p class="sub" style="margin-top:0;">£10/month for ROSE — a smart-home assistant for your household.</p>
        <label class="addon-row" style="display:flex; align-items:flex-start; gap:8px; font-weight:400;">
          <input type="checkbox" id="heatingAddon" style="width:auto; margin-top:3px;">
          <span>Add heating optimization (+£15/month) — schedules your heat pump against live Octopus Agile prices and the weather forecast. Only shows up here once your installer has set up the technical side for this household.</span>
        </label>
        <p class="sub" id="totalPrice" style="margin:10px 0 0; font-weight:600; color:var(--text);">Total: £10/month</p>
        <label for="card-element">Card</label>
        <div id="card-element"></div>
        <div id="card-errors"></div>
        <button id="subscribeBtn" style="margin-top:16px; width:100%;">Subscribe</button>
        <div id="subscribeStatus" class="status"></div>
      </div>

      <div id="notConfigured" class="status muted" hidden>Billing isn't set up on this server yet — check back later.</div>
    </div>
  </main>
</div>

<script>
(function () {
  var authEl = document.getElementById('auth');
  var billingEl = document.getElementById('billing');
  var loginForm = document.getElementById('loginForm');
  var claimForm = document.getElementById('claimForm');
  var loginStatus = document.getElementById('loginStatus');
  var claimStatus = document.getElementById('claimStatus');
  var whoamiEl = document.getElementById('whoami');
  var statusBadge = document.getElementById('statusBadge');
  var heatingBadge = document.getElementById('heatingBadge');
  var subscribeSection = document.getElementById('subscribeSection');
  var notConfigured = document.getElementById('notConfigured');
  var subscribeBtn = document.getElementById('subscribeBtn');
  var subscribeStatus = document.getElementById('subscribeStatus');
  var cardErrors = document.getElementById('card-errors');
  var heatingAddonCheckbox = document.getElementById('heatingAddon');
  var totalPriceEl = document.getElementById('totalPrice');

  heatingAddonCheckbox.addEventListener('change', function () {
    totalPriceEl.textContent = 'Total: ' + (heatingAddonCheckbox.checked ? '£25/month (£10 + £15 heating)' : '£10/month');
  });

  var stripe = null;
  var cardElement = null;

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
    billingEl.hidden = true;
    authEl.hidden = false;
  }

  function badgeFor(status) {
    if (status === 'active' || status === 'trialing') return { text: 'Active', cls: 'active' };
    if (status === 'past_due' || status === 'canceled' || status === 'incomplete') return { text: 'Payment needed', cls: 'lapsed' };
    return { text: 'Not subscribed', cls: 'none' };
  }

  function initStripe() {
    return api('/portal/config').then(function (result) {
      if (!result.ok || !result.data.publishable_key) {
        notConfigured.hidden = false;
        subscribeSection.hidden = true;
        return;
      }
      stripe = Stripe(result.data.publishable_key);
      var elements = stripe.elements();
      // Themed to match the surrounding page (Stripe's own default is plain
      // browser-native styling, which would otherwise be the one visibly
      // unstyled field on the page) — read from the live CSS custom
      // properties rather than hardcoding colors, so it follows whichever
      // theme (light/dark) the browser resolved prefers-color-scheme to.
      var rootStyle = getComputedStyle(document.documentElement);
      var textColor = rootStyle.getPropertyValue('--text').trim();
      var mutedColor = rootStyle.getPropertyValue('--muted').trim();
      var errorColor = rootStyle.getPropertyValue('--error').trim();
      cardElement = elements.create('card', {
        style: {
          base: {
            color: textColor,
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            fontSize: '14px',
            '::placeholder': { color: mutedColor }
          },
          invalid: { color: errorColor, iconColor: errorColor }
        }
      });
      cardElement.mount('#card-element');
      cardElement.on('change', function (event) {
        cardErrors.textContent = event.error ? event.error.message : '';
      });
    });
  }

  function showBilling(email, subscriptionStatus, heatingAddonActive) {
    authEl.hidden = true;
    billingEl.hidden = false;
    whoamiEl.textContent = email || '';
    var badge = badgeFor(subscriptionStatus);
    statusBadge.textContent = badge.text;
    statusBadge.className = 'badge ' + badge.cls;
    var subscribed = subscriptionStatus === 'active' || subscriptionStatus === 'trialing';
    if (subscribed) {
      heatingBadge.hidden = false;
      heatingBadge.textContent = heatingAddonActive ? 'Heating: active' : 'Heating: not added';
      heatingBadge.className = 'badge ' + (heatingAddonActive ? 'active' : 'none');
    } else {
      heatingBadge.hidden = true;
    }
    subscribeSection.hidden = subscribed;
    if (!subscribeSection.hidden && !stripe) {
      initStripe();
    }
  }

  document.getElementById('toClaimBtn').addEventListener('click', function () {
    loginForm.hidden = true;
    claimForm.hidden = false;
    document.getElementById('toClaim').hidden = true;
    document.getElementById('toLogin').hidden = false;
  });
  document.getElementById('toLoginBtn').addEventListener('click', function () {
    claimForm.hidden = true;
    loginForm.hidden = false;
    document.getElementById('toLogin').hidden = true;
    document.getElementById('toClaim').hidden = false;
  });

  document.getElementById('logoutBtn').addEventListener('click', function () {
    api('/portal/logout', { method: 'POST' }).then(function () { showAuth(); });
  });

  loginForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var email = document.getElementById('loginEmail').value.trim();
    var password = document.getElementById('loginPassword').value;
    setStatus(loginStatus, 'Logging in…', 'muted');
    api('/portal/login', { method: 'POST', body: JSON.stringify({ email: email, password: password }) })
      .then(function (result) {
        if (!result.ok) {
          setStatus(loginStatus, result.data.error || 'login failed', 'error');
          return;
        }
        setStatus(loginStatus, '', '');
        showBilling(result.data.email, result.data.subscription_status, result.data.heating_addon_active);
      })
      .catch(function (err) { setStatus(loginStatus, 'Could not reach ROSE. (' + err.message + ')', 'error'); });
  });

  claimForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var apiKey = document.getElementById('claimApiKey').value.trim();
    var email = document.getElementById('claimEmail').value.trim();
    var password = document.getElementById('claimPassword').value;
    if (password.length < 8) {
      setStatus(claimStatus, 'Password must be at least 8 characters.', 'error');
      return;
    }
    setStatus(claimStatus, 'Setting up…', 'muted');
    api('/portal/signup', { method: 'POST', body: JSON.stringify({ api_key: apiKey, email: email, password: password }) })
      .then(function (result) {
        if (!result.ok) {
          setStatus(claimStatus, result.data.error || 'setup failed', 'error');
          return;
        }
        setStatus(claimStatus, '', '');
        showBilling(result.data.email, result.data.subscription_status, result.data.heating_addon_active);
      })
      .catch(function (err) { setStatus(claimStatus, 'Could not reach ROSE. (' + err.message + ')', 'error'); });
  });

  subscribeBtn.addEventListener('click', function () {
    if (!stripe || !cardElement) return;
    subscribeBtn.disabled = true;
    setStatus(subscribeStatus, 'Starting subscription…', 'muted');

    api('/portal/billing/start-subscription', {
      method: 'POST',
      body: JSON.stringify({ include_heating: heatingAddonCheckbox.checked })
    })
      .then(function (result) {
        if (!result.ok) {
          setStatus(subscribeStatus, result.data.error || 'could not start subscription', 'error');
          subscribeBtn.disabled = false;
          return;
        }
        setStatus(subscribeStatus, 'Confirming payment…', 'muted');
        return stripe.confirmCardPayment(result.data.client_secret, { payment_method: { card: cardElement } })
          .then(function (confirmResult) {
            if (confirmResult.error) {
              setStatus(subscribeStatus, confirmResult.error.message, 'error');
              subscribeBtn.disabled = false;
              return;
            }
            setStatus(subscribeStatus, 'Payment confirmed — activating…', 'ok');
            // The webhook that flips subscription_status to 'active' can take
            // a few seconds to arrive; poll status a few times rather than
            // assuming it's instant.
            var attempts = 0;
            var poll = setInterval(function () {
              attempts++;
              api('/portal/status').then(function (statusResult) {
                if (statusResult.ok && (statusResult.data.subscription_status === 'active' || statusResult.data.subscription_status === 'trialing')) {
                  clearInterval(poll);
                  showBilling(statusResult.data.email, statusResult.data.subscription_status, statusResult.data.heating_addon_active);
                  setStatus(subscribeStatus, '', '');
                } else if (attempts >= 8) {
                  clearInterval(poll);
                  setStatus(subscribeStatus, 'Payment went through — status will update shortly.', 'ok');
                  subscribeBtn.disabled = false;
                }
              });
            }, 2000);
          });
      })
      .catch(function (err) {
        setStatus(subscribeStatus, 'Could not reach ROSE. (' + err.message + ')', 'error');
        subscribeBtn.disabled = false;
      });
  });

  // Init: the session cookie is HttpOnly (unreadable here), so probe the
  // API — 200 means already logged in, 401 means show the auth view.
  api('/portal/status').then(function (result) {
    if (!result.ok) {
      showAuth();
      return;
    }
    showBilling(result.data.email, result.data.subscription_status, result.data.heating_addon_active);
  }).catch(function () { showAuth(); });
})();
</script>

</body>
</html>
`;
