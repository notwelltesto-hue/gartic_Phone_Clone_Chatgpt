// client.js - big UI + palette + thumbs + voting + TTS
const socket = io();

// --- DOM ---
const screens = {
  home: document.getElementById('home'),
  lobby: document.getElementById('lobby'),
  promptEntry: document.getElementById('promptEntry'),
  game: document.getElementById('game'),
  reveal: document.getElementById('reveal')
};
const nameInputTop = document.getElementById('nameInputTop');
const publicCheckTop = document.getElementById('publicCheckTop');
const createBtnTop = document.getElementById('createBtnTop');
const codeInputTop = document.getElementById('codeInputTop');
const joinBtnTop = document.getElementById('joinBtnTop');
const refreshLobbies = document.getElementById('refreshLobbies');
const lobbiesList = document.getElementById('lobbiesList');

const lobbyCodeEl = document.getElementById('lobbyCode');
const playersEl = document.getElementById('players');
const readyBtn = document.getElementById('readyBtn');
const leaveBtn = document.getElementById('leaveBtn');
const startBtn = document.getElementById('startBtn');
const systemMsg = document.getElementById('systemMsg');

const initialPromptInput = document.getElementById('initialPrompt');
const submitPromptBtn = document.getElementById('submitPrompt');

const phaseTitle = document.getElementById('phaseTitle');
const phaseContent = document.getElementById('phaseContent');
const actionArea = document.getElementById('actionArea');
const timerEl = document.getElementById('timer');
const brushSizeEl = document.getElementById('brushSize');
const brushDefault = document.getElementById('brushDefault');
const paletteEl = document.getElementById('palette');
const clearBtn = document.getElementById('clearBtn');
const undoBtn = document.getElementById('undoBtn');
const eraserBtn = document.getElementById('eraserBtn');
const submitNowBtn = document.getElementById('submitNow');
const thumbsEl = document.getElementById('thumbs');

const chainsEl = document.getElementById('chains');
const backHomeBtn = document.getElementById('backHome');

const ttsCheck = document.getElementById('ttsCheck');
const enableTTSBtn = document.getElementById('enableTTS');
const voiceSelect = document.getElementById('voiceSelect');

let currentCode = null;
let mySocketId = null;
let mySlotIndex = null;
let canvas, ctx;
let drawing = false;
let strokes = [], undoStack = [];
let currentExpecting = null;
let currentSlotIndex = null;
let roundTimer = null;
let roundTimeLeft = 0;
let roundDuration = 90;
let availableVoices = [];

const defaultColors = ['#000000','#ffffff','#ff3b30','#ff9500','#ffcc00','#4cd964','#34c759','#007aff','#5856d6','#ff2d55'];

// --- Navigation ---
function show(screen) {
  Object.values(screens).forEach(s => s.classList.add('hidden'));
  screen.classList.remove('hidden');
}
show(screens.home);

// --- Top controls ---
createBtnTop.onclick = () => {
  const name = nameInputTop.value.trim() || 'Player';
  socket.emit('createLobby', { name, isPublic: publicCheckTop.checked });
};
joinBtnTop.onclick = () => {
  const name = nameInputTop.value.trim() || 'Player';
  const code = codeInputTop.value.trim().toUpperCase();
  if (!code) return alert('Enter a code');
  socket.emit('joinLobby', { code, name });
};
refreshLobbies.onclick = () => socket.emit('getLobbies');

// --- Lobby ---
readyBtn.onclick = () => socket.emit('toggleReady', { code: currentCode });
leaveBtn.onclick = () => { if (!currentCode) return; socket.emit('leaveLobby', { code: currentCode }); goHome(); };
startBtn.onclick = () => socket.emit('startGame', { code: currentCode });

// --- Prompt ---
submitPromptBtn.onclick = () => {
  const p = initialPromptInput.value.trim();
  socket.emit('submitInitialPrompt', { code: currentCode, prompt: p });
  show(screens.lobby);
};

// --- Canvas & drawing utilities ---
function makeCanvas(w=1200,h=700) {
  actionArea.innerHTML = '';
  canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.style.width = '100%';
  actionArea.appendChild(canvas);
  ctx = canvas.getContext('2d');
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = parseInt(brushDefault.value || 4);
  ctx.fillStyle = '#fff'; ctx.fillRect(0,0,canvas.width,canvas.height);

  strokes = []; undoStack = [];

  function addPoint(x,y,drag) { strokes.push({x,y,drag, color: ctx.strokeStyle, width: ctx.lineWidth}); }
  function redraw() {
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.fillStyle = '#fff'; ctx.fillRect(0,0,canvas.width,canvas.height);
    let started = false;
    for (let i=0;i<strokes.length;i++){
      const s = strokes[i];
      if (!s.drag || !started) { ctx.beginPath(); ctx.moveTo(s.x,s.y); started=true; ctx.strokeStyle = s.color; ctx.lineWidth = s.width; }
      else { ctx.lineTo(s.x,s.y); ctx.stroke(); }
    }
  }

  canvas.addEventListener('pointerdown', (e) => {
    drawing = true;
    const r = canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) * (canvas.width / r.width);
    const y = (e.clientY - r.top) * (canvas.height / r.height);
    addPoint(x,y,false);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const r = canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) * (canvas.width / r.width);
    const y = (e.clientY - r.top) * (canvas.height / r.height);
    addPoint(x,y,true);
    redraw();
  });
  window.addEventListener('pointerup', () => {
    if (drawing) {
      drawing = false;
      undoStack.push([...strokes]);
    }
  });

  clearBtn.onclick = () => { strokes = []; undoStack = []; redraw(); };
  undoBtn.onclick = () => { if (undoStack.length>0) { undoStack.pop(); strokes = undoStack.length ? [...undoStack[undoStack.length-1]] : []; redraw(); } };
  eraserBtn.onclick = () => { ctx.strokeStyle = '#fff'; };

  setBrushSize(parseInt(brushDefault.value || 4));
  redraw();
}

function setBrushSize(size) {
  if (!ctx) return;
  ctx.lineWidth = size;
}
brushSizeEl.oninput = () => setBrushSize(parseInt(brushSizeEl.value));
brushDefault.oninput = () => brushSizeEl.value = brushDefault.value;

function canvasToDataURL(maxW=1200, maxH=700) {
  // return PNG full
  return canvas.toDataURL('image/png');
}
function canvasToThumb(w=240,h=140) {
  const tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  const tctx = tmp.getContext('2d');
  tctx.fillStyle = '#fff'; tctx.fillRect(0,0,w,h);
  tctx.drawImage(canvas, 0, 0, tmp.width, tmp.height);
  return tmp.toDataURL('image/png');
}

// palette
function buildPalette() {
  paletteEl.innerHTML = '';
  defaultColors.forEach(c => {
    const sw = document.createElement('div');
    sw.className = 'palette-swatch';
    sw.style.background = c;
    sw.onclick = () => {
      if (ctx) ctx.strokeStyle = c;
    };
    paletteEl.appendChild(sw);
  });
}
buildPalette();

// --- timer ---
function startTimer(sec) {
  roundTimeLeft = sec;
  timerEl.textContent = `Time: ${roundTimeLeft}s`;
  clearInterval(roundTimer);
  roundTimer = setInterval(() => {
    roundTimeLeft--;
    timerEl.textContent = `Time: ${roundTimeLeft}s`;
    if (roundTimeLeft <= 0) { clearInterval(roundTimer); submitNow(); }
  }, 1000);
}

// --- submit ---
function submitNow() {
  if (!currentCode) return;
  if (currentExpecting === 'draw') {
    const data = canvasToDataURL();
    const thumb = canvasToThumb();
    socket.emit('submitRound', { code: currentCode, payload: { slotIndex: currentSlotIndex, data, thumb }});
    actionArea.innerHTML = '<div class="card">Submitted drawing. Waiting...</div>';
    thumbsEl.innerHTML = ''; // clear thumbnails for next round
  } else if (currentExpecting === 'write') {
    const ta = actionArea.querySelector('textarea');
    const text = (ta && ta.value.trim()) || '(no description)';
    socket.emit('submitRound', { code: currentCode, payload: { slotIndex: currentSlotIndex, data: text }});
    actionArea.innerHTML = '<div class="card">Submitted text. Waiting...</div>';
  }
  clearInterval(roundTimer);
}
submitNowBtn.onclick = submitNow;

// --- thumbnails in top of game ---
function addThumb(thumbData) {
  const img = document.createElement('img');
  img.src = thumbData;
  img.className = 'thumb';
  thumbsEl.appendChild(img);
}

// --- TTS helpers ---
function loadVoices() {
  availableVoices = window.speechSynthesis.getVoices() || [];
  voiceSelect.innerHTML = '';
  availableVoices.forEach((v, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `${v.name} — ${v.lang}`;
    voiceSelect.appendChild(opt);
  });
}
if ('speechSynthesis' in window) {
  loadVoices();
  window.speechSynthesis.onvoiceschanged = loadVoices;
} else {
  voiceSelect.innerHTML = '<option>No voices</option>';
  ttsCheck.disabled = true;
  enableTTSBtn.disabled = true;
}
enableTTSBtn.onclick = () => {
  if (!('speechSynthesis' in window)) return alert('TTS not supported');
  const u = new SpeechSynthesisUtterance('Text to speech enabled.');
  const idx = voiceSelect.value;
  if (availableVoices[idx]) u.voice = availableVoices[idx];
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
  ttsCheck.checked = true;
};
function speak(text) {
  return new Promise(res => {
    if (!('speechSynthesis' in window) || !ttsCheck.checked) return res();
    const u = new SpeechSynthesisUtterance(text);
    const idx = voiceSelect.value;
    if (availableVoices[idx]) u.voice = availableVoices[idx];
    u.onend = res; u.onerror = res;
    window.speechSynthesis.speak(u);
  });
}
async function speakSequence(items) {
  for (const it of items) {
    if (!ttsCheck.checked) break;
    if (it.type === 'prompt' || it.type === 'text') await speak(it.data || '(empty)');
    else if (it.type === 'image') await speak('A drawing.');
    await new Promise(r => setTimeout(r, 200));
  }
}

// --- socket handlers ---
socket.on('connect', () => { mySocketId = socket.id; });

socket.on('lobbyList', (list) => {
  lobbiesList.innerHTML = '';
  if (!list || list.length === 0) { lobbiesList.innerHTML = '<div class="card">No public lobbies</div>'; return; }
  list.forEach(l => {
    const el = document.createElement('div'); el.className = 'card';
    el.innerHTML = `<strong>${l.code}</strong> — ${l.players} players <button data-code="${l.code}">Join</button>`;
    lobbiesList.appendChild(el);
    el.querySelector('button').onclick = () => { codeInputTop.value = l.code; };
  });
});

socket.on('lobbyCreated', ({ code }) => {
  currentCode = code;
  lobbyCodeEl.textContent = code;
  show(screens.lobby);
});

socket.on('joined', ({ code }) => {
  currentCode = code;
  lobbyCodeEl.textContent = code;
  show(screens.lobby);
});

socket.on('roomUpdate', (data) => {
  playersEl.innerHTML = '';
  data.players.forEach((p, idx) => {
    const div = document.createElement('div'); div.className = 'player';
    div.innerHTML = `<div>${p.name}${p.id === data.hostId ? ' (host)' : ''}</div><div>${p.ready ? 'Ready' : ''}</div>`;
    playersEl.appendChild(div);
    if (p.id === mySocketId) mySlotIndex = idx;
  });
  if (data.hostId === mySocketId && data.state === 'lobby') startBtn.classList.remove('hidden'); else startBtn.classList.add('hidden');
  if (data.state === 'lobby') show(screens.lobby);
});

socket.on('requestInitialPrompts', () => { initialPromptInput.value = ''; show(screens.promptEntry); });

socket.on('roundStart', ({ round, nRounds, expecting, slotIndex, content, timeSec }) => {
  currentExpecting = expecting;
  currentSlotIndex = slotIndex;
  roundDuration = timeSec || 90;
  phaseTitle.textContent = `Round ${round + 1} / ${nRounds} — ${expecting === 'draw' ? 'Draw' : 'Describe'}`;
  phaseContent.innerHTML = '';

  // show prompt or image
  if (content && content.data) {
    if (content.type === 'prompt' || content.type === 'text') {
      phaseContent.innerHTML = `<div class="card"><strong>Prompt:</strong><div>${escapeHtml(content.data)}</div></div>`;
      if (ttsCheck.checked) speak(content.data);
    } else if (content.type === 'image') {
      phaseContent.innerHTML = `<div class="card"><strong>Image received:</strong><img src="${content.thumb || content.data}" style="max-width:100%"/></div>`;
      if (ttsCheck.checked) speak('You received a drawing.');
    }
  }

  // prepare input
  if (expecting === 'draw') {
    drawToolsShow(true);
    makeCanvas(1400,800);
    // set brush default
    ctx.lineWidth = parseInt(brushDefault.value || 4);
    ctx.strokeStyle = '#000';
    addThumbIfPresent(content && content.thumb); // if previous round gave thumb, show
  } else {
    drawToolsShow(false);
    actionArea.innerHTML = '';
    const ta = document.createElement('textarea');
    ta.rows = 6; ta.style.width='100%';
    actionArea.appendChild(ta);
  }

  show(screens.game);
  startTimer(roundDuration);
});

function drawToolsShow(visible) {
  document.getElementById('brushSize').parentElement.style.display = visible ? 'block' : 'none';
  document.getElementById('palette').style.display = visible ? 'flex' : 'none';
  clearBtn.style.display = visible ? 'inline-block' : 'none';
  undoBtn.style.display = visible ? 'inline-block' : 'none';
  eraserBtn.style.display = visible ? 'inline-block' : 'none';
  submitNowBtn.style.display = 'inline-block';
}

function addThumbIfPresent(thumb) {
  if (!thumb) return;
  thumbsEl.innerHTML = '';
  const img = document.createElement('img'); img.src = thumb; img.className = 'thumb'; thumbsEl.appendChild(img);
}

socket.on('reveal', async ({ chains }) => {
  chainsEl.innerHTML = '';
  for (const obj of chains) {
    const el = document.createElement('div'); el.className = 'chain';
    el.innerHTML = `<strong>Chain for slot ${obj.slot} (owner: ${escapeHtml(obj.owner.name)})</strong>`;
    obj.chain.forEach(item => {
      const itemDiv = document.createElement('div'); itemDiv.className = 'chain-item';
      if (item.type === 'prompt' || item.type === 'text') itemDiv.innerHTML = `<div>${escapeHtml(item.data)}</div>`;
      else if (item.type === 'image') itemDiv.innerHTML = `<img src="${item.thumb || item.data}" style="max-width:100%"/>`;
      else itemDiv.innerHTML = `<div>Unknown</div>`;
      el.appendChild(itemDiv);
    });

    // voting: simple "funniest" vote among all images in this chain (images only)
    const imageIndices = obj.chain.map((it, i) => it.type === 'image' ? i : -1).filter(i => i >= 0);
    if (imageIndices.length) {
      const voteRow = document.createElement('div'); voteRow.className = 'vote-row';
      voteRow.innerHTML = `<div>Vote for best drawing:</div>`;
      imageIndices.forEach(idx => {
        const b = document.createElement('button'); b.className = 'vote-btn';
        b.textContent = `Pick #${idx}`;
        b.onclick = () => { socket.emit('vote', { code: currentCode, slot: obj.slot, choiceIndex: idx }); b.disabled = true; };
        voteRow.appendChild(b);
      });
      const countsDiv = document.createElement('div'); countsDiv.className='muted'; voteRow.appendChild(countsDiv);
      el.appendChild(voteRow);

      // update counts when server sends voteUpdate
      socket.on('voteUpdate', ({ slot, counts }) => {
        if (slot !== obj.slot) return;
        countsDiv.textContent = 'Counts: ' + JSON.stringify(counts);
      });
    }

    chainsEl.appendChild(el);
  }

  // autoplay TTS reading of chains if enabled
  if (ttsCheck.checked) {
    for (const obj of chains) {
      await speak(`Chain for ${obj.owner.name}`);
      await speakSequence(obj.chain);
      await new Promise(r => setTimeout(r, 400));
    }
  }

  show(screens.reveal);
});

// system messages
socket.on('systemMsg', m => { systemMsg.textContent = m; });
socket.on('errorMsg', m => alert(m));

function escapeHtml(s) { return String(s || '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
