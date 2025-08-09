const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// Game state
const players = {}; // id -> name
let playerOrder = [];
const chain = []; // entries: { type: 'text', content } or { type: 'drawing', commands, brush }

let phaseIndex = -1; // which turn, cycles 0..playerOrder.length*2-1
let phaseTimer = null;
const PHASE_DURATION = 30000;

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

function sendPlayersUpdate() {
  broadcast({ t: 'playersUpdate', players, order: playerOrder });
}

function sendChainUpdate() {
  broadcast({ t: 'chainUpdate', chain });
}

function getCurrentPlayerId() {
  if (playerOrder.length === 0) return null;
  return playerOrder[phaseIndex % playerOrder.length];
}

function getCurrentInputType() {
  // Even phases = text, odd phases = drawing
  return phaseIndex % 2 === 0 ? 'text' : 'drawing';
}

function startNextPhase() {
  if (playerOrder.length === 0) return;

  phaseIndex++;
  if (phaseIndex >= playerOrder.length * 2) {
    // Game over, restart
    phaseIndex = 0;
    chain.length = 0;
    console.log('Game restarted');
  }

  const playerId = getCurrentPlayerId();
  const inputType = getCurrentInputType();

  broadcast({
    t: 'phaseStart',
    playerId,
    inputType,
    phaseIndex,
  });
  sendChainUpdate();

  console.log(`Phase ${phaseIndex + 1} started. Player ${playerId} to ${inputType}`);

  clearTimeout(phaseTimer);
  phaseTimer = setTimeout(() => {
    // Advance if no input received on time
    startNextPhase();
  }, PHASE_DURATION);
}

wss.on('connection', (ws) => {
  let clientId = null;

  ws.on('message', (msg) => {
    let data;
    try {
      data = JSON.parse(msg);
    } catch {
      return;
    }

    if (data.t === 'join') {
      clientId = data.id;
      players[clientId] = data.name || 'anon';

      if (!playerOrder.includes(clientId)) playerOrder.push(clientId);

      sendPlayersUpdate();

      if (phaseIndex === -1 && playerOrder.length >= 2) {
        phaseIndex = -1; // reset
        startNextPhase();
      }
      return;
    }

    if (data.t === 'input') {
      if (data.id !== getCurrentPlayerId()) {
        // Not this player's turn
        return;
      }

      if (data.type !== getCurrentInputType()) return;

      if (data.type === 'text' && typeof data.content === 'string') {
        chain[phaseIndex] = { type: 'text', content: data.content };
        startNextPhase();
      } else if (data.type === 'drawing' && Array.isArray(data.commands) && data.brush) {
        chain[phaseIndex] = {
          type: 'drawing',
          commands: data.commands,
          brush: data.brush,
        };
        startNextPhase();
      }
    }
  });

  ws.on('close', () => {
    if (!clientId) return;

    delete players[clientId];
    playerOrder = playerOrder.filter(id => id !== clientId);

    sendPlayersUpdate();

    if (playerOrder.length === 0) {
      phaseIndex = -1;
      chain.length = 0;
      clearTimeout(phaseTimer);
    }
  });

  // Send current state to new clients
  ws.send(JSON.stringify({ t: 'playersUpdate', players, order: playerOrder }));
  ws.send(JSON.stringify({ t: 'chainUpdate', chain }));
  if (phaseIndex >= 0) {
    ws.send(JSON.stringify({
      t: 'phaseStart',
      playerId: getCurrentPlayerId(),
      inputType: getCurrentInputType(),
      phaseIndex,
    }));
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
