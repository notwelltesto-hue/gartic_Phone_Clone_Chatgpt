// client.js
const socket = io();

const screens = {
  home: document.getElementById('home'),
  lobby: document.getElementById('lobby'),
  promptEntry: document.getElementById('promptEntry'),
  game: document.getElementById('game'),
  reveal: document.getElementById('reveal')
};

function show(screen) {
  Object.values(screens).forEach(s => s.classList.add('hidden'));
  screen.classList.remove('hidden');
}

// Home
const nameInput = document.getElementById('nameInput');
const publicCheck = document.getElementById('publicCheck');
const createBtn = document.getElementById('createBtn');
const codeInput = document.getElementById('codeInput');
const joinBtn = document.getElementById('joinBtn');
const lobbiesList = document.getElementById('lobbiesList');
const refreshLobbies = document.getElementById('refreshLobbies');

createBtn.onclick = () => {
  const name = nameInput.value.trim() || 'Player';
  socket.emit('createLobby', { name, isPublic: publicCheck.checked });
};

joinBtn.onclick = () => {
  const name = nameInput.value.trim() || 'Player';
  const code = codeInput.value.trim().toUpperCase();
  if (!code) return alert('Enter a code');
  socket.emit('joinLobby', { code, name });
};

refreshLobbies.onclick = () => {
  socket.emit('getLobbies');
};

// Lobby
const lobbyCodeEl = document.getElementById('lobbyCode');
const playersEl = document.getElementById('players');
const readyBtn = document.getElementById('readyBtn');
const leaveBtn = document.getElementById('leaveBtn');
const startBtn = document.getElementById('startBtn');
const systemMsg = document.getElementById('systemMsg');

let currentCode = null;
let mySocketId = null;
let mySlotIndex = null;

readyBtn.onclick = () => {
  socket.emit('toggleReady', { code: currentCode });
};
leaveBtn.onclick = () => {
  socket.emit('leaveLobby', { code: currentCode });
  goHome();
};
startBtn.onclick = () => {
  socket.emit('startGame', { code: currentCode });
};

// Prompt entry
const initialPromptInput = document.getElementById('initialPrompt');
const submitPromptBtn = document.getElementById('submitPrompt');

submitPromptBtn.onclick = () => {
  const prompt = initialPromptInput.value.trim();
  socket.emit('submitInitialPrompt', { code: currentCode, prompt });
  show(screens.lobby);
};

// Game
const phaseTitle = document.getElementById('phaseTitle');
const phaseContent = document.getElementById('phaseContent');
const timerEl = document.getElementById('timer');
const actionArea = document.getElementById('actionArea');
const drawTools = document.getElementById('drawTools');
const clearBtn = document.getElementById('clearBtn');
const undoBtn = document.getElementById('undoBtn');

let canvas, ctx, drawing = false, strokes = [], undoStack = [];
let currentExpecting = null;
let currentSlotIndex = null;
let roundTimer = null;
const ROUND_SECONDS = 60;

function startTimer(sec) {
  let t = sec;
  timerEl.textContent = `Time: ${t}s`;
  clearInterval(roundTimer);
  roundTimer = setInterval(() => {
    t--;
    timerEl.textContent = `Time: ${t}s`;
    if (t <= 0) {
      clearInterval(roundTimer);
      submitCurrent();
    }
  }, 1000);
}

function makeCanvas(w=600,h=400) {
  actionArea.innerHTML = '';
  canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.style.maxWidth = '100%';
  actionArea.appendChild(canvas);
  ctx = canvas.getContext('2d');
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#000';
  strokes = [];
  undoStack = [];
  // mouse
  let last = null;
  function addPoint(x,y,drag) {
    strokes.push({ x, y, drag });
  }
  function redraw() {
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.beginPath();
    let started = false;
    for (let i=0;i<strokes.length;i++){
      const s = strokes[i];
      if (!s.drag || !started) {
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        started = true;
      } else {
        ctx.lineTo(s.x, s.y);
        ctx.stroke();
      }
    }
  }
  canvas.addEventListener('pointerdown', (e)=>{
    drawing = true;
    const r = canvas.getBoundingClientRect();
    addPoint(e.clientX - r.left, e.clientY - r.top, false);
  });
  canvas.addEventListener('pointermove', (e)=>{
    if (!drawing) return;
    const r = canvas.getBoundingClientRect();
    addPoint(e.clientX - r.left, e.clientY - r.top, true);
    redraw();
  });
  window.addEventListener('pointerup', ()=> {
    if (drawing) {
      drawing = false;
      // capture stroke boundary marker (null as separator)
      undoStack.push([...strokes]);
    }
  });
  clearBtn.onclick = () => {
    strokes = [];
    redraw();
  };
  undoBtn.onclick = () => {
    if (undoStack.length>0) {
      undoStack.pop();
      strokes = undoStack.length ? [...undoStack[undoStack.length-1]] : [];
      redraw();
    }
  };
  redraw();
}

function makeTextBox(initial) {
  actionArea.innerHTML = '';
  const ta = document.createElement('textarea');
  ta.rows = 6;
  ta.style.width = '100%';
  ta.value = initial || '';
  actionArea.appendChild(ta);
  return ta;
}

function submitCurrent() {
  // depending on expecting
  if (currentExpecting === 'draw') {
    // export canvas
    const data = canvas.toDataURL('image/png');
    socket.emit('submitRound', { code: currentCode, payload: { slotIndex: currentSlotIndex, data }});
    actionArea.innerHTML = '<div class="card">Submitted drawing. Waiting...</div>';
  } else if (currentExpecting === 'write') {
    const ta = actionArea.querySelector('textarea');
    const text = (ta && ta.value.trim()) || '(no description)';
    socket.emit('submitRound', { code: currentCode, payload: { slotIndex: currentSlotIndex, data: text }});
    actionArea.innerHTML = '<div class="card">Submitted text. Waiting...</div>';
  }
  clearInterval(roundTimer);
}

function goHome() {
  currentCode = null;
  mySlotIndex = null;
  show(screens.home);
}

// Reveal
const chainsEl = document.getElementById('chains');
const backHomeBtn = document.getElementById('backHome');
backHomeBtn.onclick = () => {
  socket.emit('getLobbies');
  goHome();
};

// Socket handlers
socket.on('connect', () => {
  mySocketId = socket.id;
});

socket.on('lobbyList', (list) => {
  if (!list || list.length===0) {
    lobbiesList.innerHTML = '<div class="card">No public lobbies</div>';
    return;
  }
  lobbiesList.innerHTML = '';
  list.forEach(l => {
    const el = document.createElement('div');
    el.className = 'card';
    el.innerHTML = `<strong>${l.code}</strong> — ${l.players} players <button data-code="${l.code}">Join</button>`;
    lobbiesList.appendChild(el);
    el.querySelector('button').onclick = ()=>{
      codeInput.value = l.code;
    };
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
  // show players
  playersEl.innerHTML = '';
  data.players.forEach((p, idx) => {
    const div = document.createElement('div');
    div.className = 'player';
    div.innerHTML = `<div>${p.name}${p.id === data.hostId ? ' (host)' : ''}</div><div>${p.ready ? 'Ready' : ''}</div>`;
    playersEl.appendChild(div);
    if (p.id === mySocketId) mySlotIndex = idx;
  });
  // show start button only for host and lobby state
  if (data.hostId === mySocketId && data.state === 'lobby') startBtn.classList.remove('hidden'); else startBtn.classList.add('hidden');
  if (data.state === 'lobby') {
    show(screens.lobby);
  } else if (data.state === 'gatheringPrompts') {
    // host started and server will request prompts individually via socket event 'requestInitialPrompts'
  } else if (data.state === 'playing') {
    // handled by roundStart events
  } else if (data.state === 'reveal') {
    // handled by reveal event
  }
});

socket.on('requestInitialPrompts', () => {
  initialPromptInput.value = '';
  show(screens.promptEntry);
});

socket.on('roundStart', ({ round, nRounds, expecting, slotIndex, content }) => {
  currentExpecting = expecting;
  currentSlotIndex = slotIndex;
  phaseTitle.textContent = `Round ${round + 1} / ${nRounds} — ${expecting === 'draw' ? 'Draw' : 'Describe'}`;
  // show content (prompt text or previous image)
  phaseContent.innerHTML = '';
  if (content && content.data) {
    if (content.type === 'prompt' || content.type === 'text') {
      phaseContent.innerHTML = `<div class="card"><strong>Prompt:</strong><div>${escapeHtml(content.data)}</div></div>`;
    } else if (content.type === 'image') {
      phaseContent.innerHTML = `<div class="card"><strong>Image you received:</strong><div><img src="${content.data}" style="max-width:100%"/></div></div>`;
    } else {
      phaseContent.innerHTML = `<div class="card">Content:</div>`;
    }
  }

  // prepare input area
  if (expecting === 'draw') {
    drawTools.classList.remove('hidden');
    makeCanvas(700, 420);
  } else {
    drawTools.classList.add('hidden');
    const ta = makeTextBox('');
  }

  show(screens.game);
  startTimer(ROUND_SECONDS);

  // add submit button to action area
  const submitBtn = document.createElement('button');
  submitBtn.textContent = 'Submit Now';
  submitBtn.onclick = submitCurrent;
  actionArea.appendChild(submitBtn);
});

socket.on('reveal', ({ chains }) => {
  chainsEl.innerHTML = '';
  chains.forEach(obj => {
    const el = document.createElement('div');
    el.className = 'chain';
    el.innerHTML = `<strong>Chain for slot ${obj.slot} (owner: ${escapeHtml(obj.owner.name)})</strong>`;
    obj.chain.forEach(item => {
      const itemDiv = document.createElement('div');
      itemDiv.className = 'chain-item';
      if (item.type === 'prompt' || item.type === 'text') {
        itemDiv.innerHTML = `<div>${escapeHtml(item.data)}</div>`;
      } else if (item.type === 'image') {
        itemDiv.innerHTML = `<img src="${item.data}" style="max-width:100%"/>`;
      } else {
        itemDiv.innerHTML = `<div>Unknown</div>`;
      }
      el.appendChild(itemDiv);
    });
    chainsEl.appendChild(el);
  });
  show(screens.reveal);
});

socket.on('systemMsg', (m) => {
  systemMsg.textContent = m;
});

socket.on('errorMsg', (m) => {
  alert(m);
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}
