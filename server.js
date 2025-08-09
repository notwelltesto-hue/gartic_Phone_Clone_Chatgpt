const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// --- Game state ---
const players = {}; // id -> name
let playerOrder = []; // array of ids in join order

// Chain stores text or drawing data in turns, alternating:
// { type: 'text', content: '...' }
// { type: 'drawing', commands: [...], brush: { color, size } }
const chain = [];

let phase = 0; // counts turns: 0 = player 0 text, 1 = player 1 draw, 2 = player 2 text, 3 = player 3 draw, etc
let roundTimer = null;
const ROUND_TIME = 30000;

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

function broadcastPlayers() {
  broadcast({ t: 'players', players, order: playerOrder });
}

function broadcastChain() {
  broadcast({ t: 'chainUpdate', chain });
}

function currentPlayerId() {
  if (playerOrder.length === 0) return null;
  return playerOrder[phase % playerOrder.length];
}

function currentPhaseType() {
  return phase % 2 === 0 ? 'text' : 'drawing';
}

function startNextPhase() {
  phase++;
  if (phase >= playerOrder.length * 2) {
    // Game over — reset or loop
    phase = 0;
    chain.length = 0; // clear chain for new game
  }

  const currId = currentPlayerId();
  const currType = currentPhaseType();

  broadcast({
    t: 'phaseStart',
    playerId: currId,
    inputType: currType,
    phase,
  });
  broadcastChain();

  console.log(`Phase ${phase} started: player ${currId} (${currType})`);

  clearTimeout(roundTimer);
  roundTimer = setTimeout(() => {
    // If player didn't send input, advance anyway
    startNextPhase();
  }, ROUND_TIME);
}

// --- WS connection ---

wss.on('connection', (ws) => {
  let clientId = null;

  ws.on('message', (msg) => {
    let data;
    try {
      data = JSON.parse(msg);
    } catch {
      return;
    }

    if (data.t === 'meta') {
      clientId = data.id;
      players[clientId] = data.name || 'anon';
      if (!playerOrder.includes(clientId)) {
        playerOrder.push(clientId);
      }
      broadcastPlayers();

      // On first player connecting, start the game if not started
      if (phase === 0 && playerOrder.length === 1) {
        startNextPhase();
      }
      return;
    }

    // Accept input only from current player and matching phase type
    if (data.t === 'input' && data.id === currentPlayerId()) {
      if (data.type === currentPhaseType()) {
        if (data.type === 'text' && typeof data.content === 'string') {
          chain[phase] = { type: 'text', content: data.content };
          startNextPhase();
        }
        else if (data.type === 'drawing' && Array.isArray(data.commands) && data.brush) {
          chain[phase] = { type: 'drawing', commands: data.commands, brush: data.brush };
          startNextPhase();
        }
      }
    }
  });

  ws.on('close', () => {
    if (clientId) {
      delete players[clientId];
      const idx = playerOrder.indexOf(clientId);
      if (idx !== -1) playerOrder.splice(idx, 1);
      broadcastPlayers();

      // Reset game if no players left
      if (playerOrder.length === 0) {
        phase = 0;
        chain.length = 0;
        clearTimeout(roundTimer);
      }
    }
  });

  // Send initial players and chain state on connect
  ws.send(JSON.stringify({ t: 'players', players, order: playerOrder }));
  ws.send(JSON.stringify({ t: 'chainUpdate', chain }));
  ws.send(JSON.stringify({
    t: 'phaseStart',
    playerId: currentPlayerId(),
    inputType: currentPhaseType(),
    phase,
  }));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
