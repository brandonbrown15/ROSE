// Standalone chat page served directly by the Worker at `GET /`, so ROSE can
// be demoed from any browser (e.g. an iPhone) with nothing to install or
// transfer — just open the Worker's URL. It only needs the ROSE_API_KEY;
// since this page is served same-origin, it calls `/chat` with a relative
// path instead of needing a separate Worker URL field.
export const CHAT_UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chat with ROSE</title>
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
    --bubble-user: #a8324a;
    --bubble-user-text: #ffffff;
    --bubble-rose: #efeae4;
    --bubble-rose-text: #1a1a1a;
    --error: #b3261e;
    --success: #2e7d32;
    --radius-sm: 8px;
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
      --bubble-rose: #2c2820;
      --bubble-rose-text: #f2ede6;
      --accent-soft: rgba(224, 122, 145, 0.12);
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
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
  h1, h2 { font-family: var(--font-display); font-weight: 600; letter-spacing: -0.01em; }

  .brand { display: flex; align-items: center; gap: 10px; }
  .brand .mark {
    width: 30px; height: 30px; border-radius: 9px; flex-shrink: 0;
    background: linear-gradient(155deg, var(--accent), #c8677c);
    color: #fff; display: flex; align-items: center; justify-content: center;
    font-family: var(--font-display); font-weight: 700; font-size: 15px;
    box-shadow: var(--shadow-sm);
  }
  .brand .wordmark { font-family: var(--font-display); font-weight: 600; font-size: 16px; letter-spacing: -0.01em; line-height: 1.2; }
  .brand .tagline { font-size: 11px; color: var(--muted); margin-top: 1px; display: flex; align-items: center; gap: 5px; }
  .status-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--success); display: inline-block; flex-shrink: 0; }

  header {
    padding: 14px 20px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: var(--panel);
  }
  button.icon {
    background: none;
    border: 1px solid var(--border);
    color: var(--muted);
    border-radius: var(--radius-sm);
    padding: 6px 10px;
    cursor: pointer;
    font-size: 13px;
    transition: color .15s ease, border-color .15s ease;
  }
  button.icon:hover { color: var(--text); border-color: var(--accent); }

  #messages {
    flex: 1;
    overflow-y: auto;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .msg { max-width: 75%; padding: 10px 14px; border-radius: 16px; line-height: 1.45; font-size: 14px; white-space: pre-wrap; box-shadow: var(--shadow-sm); }
  .msg.user { align-self: flex-end; background: var(--bubble-user); color: var(--bubble-user-text); border-bottom-right-radius: 4px; }
  .msg.rose { align-self: flex-start; background: var(--bubble-rose); color: var(--bubble-rose-text); border-bottom-left-radius: 4px; }
  .msg.error { align-self: center; background: transparent; box-shadow: none; color: var(--error); font-size: 13px; text-align: center; max-width: 90%; }
  .msg.meta { align-self: center; background: transparent; box-shadow: none; color: var(--muted); font-size: 12px; }

  form#composer {
    display: flex;
    gap: 8px;
    padding: 14px 20px;
    border-top: 1px solid var(--border);
    background: var(--panel);
  }
  #text {
    flex: 1;
    padding: 10px 14px;
    border-radius: 20px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text);
    font-size: 14px;
    font-family: var(--font-body);
    outline: none;
    transition: border-color .15s ease, box-shadow .15s ease;
  }
  #text:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  #send {
    padding: 10px 22px;
    border-radius: 20px;
    border: none;
    background: var(--accent);
    color: var(--accent-text);
    font-weight: 600;
    cursor: pointer;
    font-size: 14px;
    transition: filter .15s ease, transform .05s ease;
  }
  #send:hover:not(:disabled) { filter: brightness(1.08); }
  #send:active:not(:disabled) { transform: translateY(1px); }
  #send:disabled { opacity: 0.5; cursor: default; }

  #setup {
    max-width: 420px;
    margin: 10vh auto;
    padding: 32px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-md);
  }
  #setup .brand { margin-bottom: 20px; }
  #setup h2 { margin: 0 0 4px; font-size: 19px; }
  #setup p { color: var(--muted); font-size: 13.5px; line-height: 1.55; }
  #setup label { display: block; font-size: 12.5px; font-weight: 600; margin: 16px 0 6px; color: var(--muted); text-transform: uppercase; letter-spacing: .02em; }
  #setup input {
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
  #setup input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  #setup button {
    margin-top: 18px;
    width: 100%;
    padding: 11px;
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
  #setup button:hover { filter: brightness(1.08); }
  #setup button:active { transform: translateY(1px); }
  [hidden] { display: none !important; }
</style>
</head>
<body>

<div id="setup">
  <div class="brand">
    <div class="mark">R</div>
    <div>
      <div class="wordmark">ROSE</div>
      <div class="tagline">Connect to your household</div>
    </div>
  </div>
  <p>Your API key is saved only in this browser (localStorage) — never sent anywhere except to this same page's own <code>/chat</code> endpoint.</p>
  <label for="key">API Key</label>
  <input id="key" type="password" placeholder="your ROSE_API_KEY" autocomplete="off">
  <button id="save">Save &amp; start chatting</button>

  <div id="pinSection" hidden>
    <hr style="border:none;border-top:1px solid var(--border);margin:22px 0 4px;">
    <label for="currentPin">Admin PIN</label>
    <p style="color:var(--muted);font-size:13px;line-height:1.5;margin:0 0 8px;">Required before ROSE will unlock a door or disarm the alarm — one shared PIN for the whole household, 4–8 digits. Defaults to <code>1003</code> until you set your own. Changing it requires the current one.</p>
    <input id="currentPin" type="password" inputmode="numeric" pattern="[0-9]*" placeholder="current PIN" autocomplete="off">
    <label for="newPin">New PIN</label>
    <input id="newPin" type="password" inputmode="numeric" pattern="[0-9]*" placeholder="4-8 digits" autocomplete="off">
    <button id="savePin">Update PIN</button>
    <div id="pinStatus" style="font-size:13px;margin-top:10px;min-height:1.2em;"></div>
  </div>
</div>

<div id="chat" hidden style="display:flex; flex-direction:column; height:100%;">
  <header>
    <div class="brand">
      <div class="mark">R</div>
      <div>
        <div class="wordmark">ROSE</div>
        <div class="tagline"><span class="status-dot"></span>Connected</div>
      </div>
    </div>
    <div style="display:flex; gap:8px;">
      <button class="icon" id="newConvo">New conversation</button>
      <button class="icon" id="settings">Settings</button>
    </div>
  </header>
  <div id="messages"></div>
  <form id="composer">
    <input id="text" placeholder="Say something to Rose…" autocomplete="off">
    <button id="send" type="submit">Send</button>
  </form>
</div>

<script>
(function () {
  var setupEl = document.getElementById('setup');
  var chatEl = document.getElementById('chat');
  var messagesEl = document.getElementById('messages');
  var form = document.getElementById('composer');
  var textInput = document.getElementById('text');
  var sendBtn = document.getElementById('send');
  var pinSection = document.getElementById('pinSection');
  var currentPinInput = document.getElementById('currentPin');
  var newPinInput = document.getElementById('newPin');
  var pinStatus = document.getElementById('pinStatus');

  function getConfig() {
    try {
      return {
        key: localStorage.getItem('rose_key') || '',
        conversationId: localStorage.getItem('rose_conversation_id') || null
      };
    } catch (e) {
      return { key: '', conversationId: null };
    }
  }

  function setConversationId(id) {
    try { localStorage.setItem('rose_conversation_id', id); } catch (e) {}
  }

  function addMessage(role, text) {
    var div = document.createElement('div');
    div.className = 'msg ' + role;
    div.textContent = text;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function showChat() {
    setupEl.hidden = true;
    chatEl.hidden = false;
    chatEl.style.display = 'flex';
    textInput.focus();
  }

  function showSetup() {
    chatEl.hidden = true;
    setupEl.hidden = false;
    // Only offer the PIN section once a key already exists — before that,
    // there's nothing to authenticate the /admin/pin request with yet.
    pinSection.hidden = !getConfig().key;
  }

  document.getElementById('save').addEventListener('click', function () {
    var key = document.getElementById('key').value.trim();
    if (!key) {
      alert('Please enter the API key.');
      return;
    }
    try {
      localStorage.setItem('rose_key', key);
    } catch (e) {
      alert('Could not save to this browser\\'s storage — try a normal (non-private) browser window.');
      return;
    }
    showChat();
  });

  document.getElementById('settings').addEventListener('click', function () {
    showSetup();
  });

  document.getElementById('savePin').addEventListener('click', function () {
    var currentPin = currentPinInput.value.trim();
    var newPin = newPinInput.value.trim();
    if (!/^[0-9]{4,8}$/.test(currentPin) || !/^[0-9]{4,8}$/.test(newPin)) {
      pinStatus.style.color = 'var(--error)';
      pinStatus.textContent = 'Both PINs must be 4-8 digits.';
      return;
    }

    var cfg = getConfig();
    pinStatus.style.color = 'var(--muted)';
    pinStatus.textContent = 'Saving…';

    fetch('/admin/pin', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + cfg.key,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ current_pin: currentPin, new_pin: newPin })
    })
      .then(function (res) {
        return res.json().then(function (data) { return { ok: res.ok, status: res.status, data: data }; });
      })
      .then(function (result) {
        if (!result.ok) {
          pinStatus.style.color = 'var(--error)';
          pinStatus.textContent = 'Error: ' + (result.data && result.data.error ? result.data.error : 'request failed');
          return;
        }
        pinStatus.style.color = 'var(--muted)';
        pinStatus.textContent = 'PIN updated.';
        currentPinInput.value = '';
        newPinInput.value = '';
      })
      .catch(function (err) {
        pinStatus.style.color = 'var(--error)';
        pinStatus.textContent = 'Could not reach ROSE. (' + err.message + ')';
      });
  });

  document.getElementById('newConvo').addEventListener('click', function () {
    try { localStorage.removeItem('rose_conversation_id'); } catch (e) {}
    messagesEl.innerHTML = '';
    addMessage('meta', 'Started a new conversation.');
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = textInput.value.trim();
    if (!text) return;

    var cfg = getConfig();
    addMessage('user', text);
    textInput.value = '';
    sendBtn.disabled = true;

    var body = { text: text };
    if (cfg.conversationId) body.conversation_id = cfg.conversationId;

    fetch('/chat', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + cfg.key,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })
      .then(function (res) {
        return res.json().then(function (data) { return { ok: res.ok, status: res.status, data: data }; });
      })
      .then(function (result) {
        if (!result.ok) {
          addMessage('error', 'Error (' + result.status + '): ' + (result.data && result.data.error ? result.data.error : 'request failed'));
          return;
        }
        if (result.data.conversation_id) setConversationId(result.data.conversation_id);
        addMessage('rose', result.data.reply);
      })
      .catch(function (err) {
        addMessage('error', 'Could not reach ROSE — check your internet connection. (' + err.message + ')');
      })
      .finally(function () {
        sendBtn.disabled = false;
        textInput.focus();
      });
  });

  // Init
  var cfg = getConfig();
  if (cfg.key) {
    showChat();
  } else {
    showSetup();
  }
})();
</script>

</body>
</html>
`;
