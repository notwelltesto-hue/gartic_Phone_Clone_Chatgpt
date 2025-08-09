const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

function makeCode() {
  // Generate 5 char alphanumeric code
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // exclude confusing letters
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Lobby data structure
const lobbies = {}; 
// lobbyCode => {
//   players: { id: name }
//   playerOrder: [id]
//   chain: []
//   phaseIndex: -1
//   phaseTimer: null
//   isPublic: bool
// }

function broadcastLobby(lobby, data) {
  const msg = JSON.stringify(data);
  lobby.playersSockets.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

function sendPlayersUpdate(lobby) {
  broadcastLobby(lobby, {
    t: 'playersUpdate',
    players: lobby.players,
    order: lobby.playerOrder,
  });
}

function sendChainUpdate(lobby) {
  broadcastLobby(lobby, { t: 'chainUpdate', chain: lobby.chain });
}

function getCurrentPlayerId(lobby) {
  if (lobby.playerOrder.length === 0) return null;
  return lobby.playerOrder[lobby.phaseIndex % lobby.playerOrder.length];
}

function getCurrentInputType(lobby) {
  return lobby.phaseIndex % 2 === 0 ? 'text' : 'drawing';
}

function startNextPhase(lobbyCode) {
  const lobby = lobbies[lobbyCode];
  if (!lobby) return;
  if (lobby.playerOrder.length === 0) return;

  lobby.phaseIndex++;
  if (lobby.phaseIndex >= lobby.playerOrder.length * 2) {
    // restart after full cycle
    lobby.phaseIndex = 0;
    lobby.chain.length = 0;
    console.log(`Lobby ${lobbyCode} restarted game`);
  }

  const playerId = getCurrentPlayerId(lobby);
  const inputType = getCurrentInputType(lobby);

  broadcastLobby(lobby, {
    t: 'phaseStart',
    playerId,
    inputType,
    phaseIndex: lobby.phaseIndex,
  });
  sendChainUpdate(lobby);

  clearTimeout(lobby.phaseTimer);
  lobby.phaseTimer = setTimeout(() => {
    startNextPhase(lobbyCode);
  }, 30000);
}

// Keep track of each ws's lobby and id
const wsClients = new Map(); // ws => { lobbyCode, id }

wss.on('connection', (ws) => {
  wsClients.set(ws, { lobbyCode: null, id: null });

  ws.on('message', (msg) => {
    let data;
    try {
      data = JSON.parse(msg);
    } catch {
      return;
    }

    if (data.t === 'createLobby') {
      // Create lobby
      let code;
      do {
        code = makeCode();
      } while (lobbies[code]);

      lobbies[code] = {
        players: {},
        playerOrder: [],
        chain: [],
        phaseIndex: -1,
        phaseTimer: null,
        isPublic: !!data.isPublic,
        playersSockets: new Set(),
      };

      ws.send(JSON.stringify({ t: 'lobbyCreated', code }));
      return;
    }

    if (data.t === 'listLobbies') {
      // Return public lobby codes with player counts
      const publicLobbies = Object.entries(lobbies)
        .filter(([, l]) => l.isPublic)
        .map(([code, l]) => ({
          code,
          players: Object.keys(l.players).length,
        }));
      ws.send(JSON.stringify({ t: 'publicLobbies', lobbies: publicLobbies }));
      return;
    }

    if (data.t === 'joinLobby') {
      const { code, id, name } = data;
      const lobby = lobbies[code];
      if (!lobby) {
        ws.send(JSON.stringify({ t: 'error', msg: 'Lobby not found' }));
        return;
      }

      const playerName = (name && name.trim()) || `Guest${Math.floor(10000 + Math.random() * 90000)}`;

      lobby.players[id] = playerName;
      if (!lobby.playerOrder.includes(id)) lobby.playerOrder.push(id);
      lobby.playersSockets.add(ws);

      wsClients.set(ws, { lobbyCode: code, id });

      sendPlayersUpdate(lobby);

      // Start game if enough players
      if (lobby.phaseIndex === -1 && lobby.playerOrder.length >= 2) {
        lobby.phaseIndex = -1;
        startNextPhase(code);
      }
      return;
    }

    if (data.t === 'input') {
      const client = wsClients.get(ws);
      if (!client || !client.lobbyCode) return;
      const lobby = lobbies[client.lobbyCode];
      if (!lobby) return;

      if (data.id !== getCurrentPlayerId(lobby)) return;
      if (data.type !== getCurrentInputType(lobby)) return;

      if (data.type === 'text' && typeof data.content === 'string') {
        lobby.chain[lobby.phaseIndex] = { type: 'text', content: data.content };
        startNextPhase(client.lobbyCode);
      } else if (data.type === 'drawing' && Array.isArray(data.commands) && data.brush) {
        lobby.chain[lobby.phaseIndex] = {
          type: 'drawing',
          commands: data.commands,
          brush: data.brush,
        };
        startNextPhase(client.lobbyCode);
      }
    }
  });

  ws.on('close', () => {
    const client = wsClients.get(ws);
    if (!client || !client.lobbyCode) {
      wsClients.delete(ws);
      return;
    }
    const lobby = lobbies[client.lobbyCode];
    if (!lobby) {
      wsClients.delete(ws);
      return;
    }
    const { id } = client;
    delete lobby.players[id];
    lobby.playerOrder = lobby.playerOrder.filter((pid) => pid !== id);
    lobby.playersSockets.delete(ws);

    sendPlayersUpdate(lobby);

    if (lobby.playerOrder.length === 0) {
      // Delete empty lobby
      clearTimeout(lobby.phaseTimer);
      delete lobbies[client.lobbyCode];
      console.log(`Lobby ${client.lobbyCode} deleted (empty)`);
    }

    wsClients.delete(ws);
  });

});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
