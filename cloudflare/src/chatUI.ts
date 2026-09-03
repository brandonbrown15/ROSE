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
    --bubble-user: #a8324a;
    --bubble-user-text: #ffffff;
    --bubble-rose: #efeae4;
    --bubble-rose-text: #1a1a1a;
    --error: #b3261e;
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
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
  header {
    padding: 14px 20px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: var(--panel);
  }
  header h1 {
    font-size: 17px;
    margin: 0;
    font-weight: 600;
  }
  header .sub {
    font-size: 12px;
    color: var(--muted);
    margin-top: 2px;
  }
  button.icon {
    background: none;
    border: 1px solid var(--border);
    color: var(--muted);
    border-radius: 8px;
    padding: 6px 10px;
    cursor: pointer;
    font-size: 13px;
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
  .msg { max-width: 75%; padding: 10px 14px; border-radius: 16px; line-height: 1.4; font-size: 14px; white-space: pre-wrap; }
  .msg.user { align-self: flex-end; background: var(--bubble-user); color: var(--bubble-user-text); border-bottom-right-radius: 4px; }
  .msg.rose { align-self: flex-start; background: var(--bubble-rose); color: var(--bubble-rose-text); border-bottom-left-radius: 4px; }
  .msg.error { align-self: center; background: transparent; color: var(--error); font-size: 13px; text-align: center; max-width: 90%; }
  .msg.meta { align-self: center; color: var(--muted); font-size: 12px; }

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
    outline: none;
  }
  #text:focus { border-color: var(--accent); }
  #send {
    padding: 10px 20px;
    border-radius: 20px;
    border: none;
    background: var(--accent);
    color: var(--accent-text);
    font-weight: 600;
    cursor: pointer;
    font-size: 14px;
  }
  #send:disabled { opacity: 0.5; cursor: default; }

  #setup {
    max-width: 420px;
    margin: 10vh auto;
    padding: 28px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 16px;
  }
  #setup h2 { margin-top: 0; font-size: 18px; }
  #setup p { color: var(--muted); font-size: 13px; line-height: 1.5; }
  #setup label { display: block; font-size: 13px; font-weight: 600; margin: 14px 0 6px; }
  #setup input {
    width: 100%;
    padding: 9px 12px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text);
    font-size: 14px;
  }
  #setup button {
    margin-top: 18px;
    width: 100%;
    padding: 10px;
    border-radius: 8px;
    border: none;
    background: var(--accent);
    color: var(--accent-text);
    font-weight: 600;
    cursor: pointer;
    font-size: 14px;
  }
  [hidden] { display: none !important; }
</style>
</head>
<body>

<div id="setup">
  <h2>Connect to ROSE</h2>
  <p>Your API key is saved only in this browser (localStorage) — never sent anywhere except to this same page's own <code>/chat</code> endpoint.</p>
  <label for="key">API Key</label>
  <input id="key" type="password" placeholder="your ROSE_API_KEY" autocomplete="off">
  <button id="save">Save &amp; start chatting</button>
</div>

<div id="chat" hidden style="display:flex; flex-direction:column; height:100%;">
  <header>
    <div>
      <h1>ROSE</h1>
      <div class="sub">connected</div>
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
