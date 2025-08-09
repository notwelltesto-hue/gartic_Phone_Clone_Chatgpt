// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  return code;
}

const lobbies = {}; // code -> lobby

// Broadcast helper for a lobby
function broadcastLobby(lobby, data) {
  const msg = JSON.stringify(data);
  for (const [ws] of lobby.playersSockets.entries()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function sendPlayersUpdate(lobby) {
  broadcastLobby(lobby, {
    t: 'playersUpdate',
    players: lobby.players,
    order: lobby.playerOrder,
    hostId: lobby.hostId,
    gameStarted: lobby.gameStarted,
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
    // finish game -> send gameEnded and reset
    broadcastLobby(lobby, { t: 'gameEnded' });
    lobby.gameStarted = false;
    lobby.phaseIndex = -1;
    // keep chain for review, host can restart later
    sendPlayersUpdate(lobby);
    return;
  }

  const playerId = getCurrentPlayerId(lobby);
  const inputType = getCurrentInputType(lobby);

  broadcastLobby(lobby, {
    t: 'phaseStart',
    playerId,
    inputType,
    phaseIndex: lobby.phaseIndex,
    time: 30,
  });
  sendChainUpdate(lobby);

  clearTimeout(lobby.phaseTimer);
  lobby.phaseTimer = setTimeout(() => startNextPhase(lobbyCode), 30000);
}

// Map ws -> { lobbyCode, id }
const wsClients = new Map();

wss.on('connection', (ws) => {
  wsClients.set(ws, { lobbyCode: null, id: null });

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    // Create lobby
    if (data.t === 'createLobby') {
      let code;
      do { code = makeCode(); } while (lobbies[code]);
      lobbies[code] = {
        hostId: null,
        isPublic: !!data.isPublic,
        players: {},           // id -> { name }
        playerOrder: [],       // [id,...]
        chain: [],             // sequence of entries
        phaseIndex: -1,
        phaseTimer: null,
        gameStarted: false,
        playersSockets: new Map(), // ws -> id
      };
      ws.send(JSON.stringify({ t: 'lobbyCreated', code, isPublic: lobbies[code].isPublic }));
      return;
    }

    // List public lobbies
    if (data.t === 'listLobbies') {
      const publicLobbies = Object.entries(lobbies)
        .filter(([, l]) => l.isPublic && !l.gameStarted)
        .map(([code, l]) => ({ code, players: Object.keys(l.players).length }));
      ws.send(JSON.stringify({ t: 'publicLobbies', lobbies: publicLobbies }));
      return;
    }

    // Join lobby
    if (data.t === 'joinLobby') {
      const { code, id, name } = data;
      const lobby = lobbies[code];
      if (!lobby) {
        ws.send(JSON.stringify({ t: 'error', msg: 'Lobby not found' }));
        return;
      }

      if (!lobby.hostId) lobby.hostId = id;
      const playerName = (name && name.trim()) || `Guest${Math.floor(10000 + Math.random() * 90000)}`;

      lobby.players[id] = { name: playerName };
      if (!lobby.playerOrder.includes(id)) lobby.playerOrder.push(id);
      lobby.playersSockets.set(ws, id);

      wsClients.set(ws, { lobbyCode: code, id });
      sendPlayersUpdate(lobby);

      // send initial chain & phase info
      ws.send(JSON.stringify({ t: 'chainUpdate', chain: lobby.chain }));
      if (lobby.phaseIndex >= 0 && lobby.gameStarted) {
        ws.send(JSON.stringify({ t: 'phaseStart', playerId: getCurrentPlayerId(lobby), inputType: getCurrentInputType(lobby), phaseIndex: lobby.phaseIndex, time: 30 }));
      }
      return;
    }

    // Start game (host only)
    if (data.t === 'startGame') {
      const client = wsClients.get(ws);
      if (!client) return;
      const lobby = lobbies[client.lobbyCode];
      if (!lobby) return;
      if (client.id !== lobby.hostId) {
        ws.send(JSON.stringify({ t: 'error', msg: 'Only host can start' }));
        return;
      }
      if (lobby.playerOrder.length < 2) {
        ws.send(JSON.stringify({ t: 'error', msg: 'Need 2+ players' }));
        return;
      }
      lobby.gameStarted = true;
      lobby.phaseIndex = -1;
      lobby.chain.length = 0;
      sendPlayersUpdate(lobby);
      startNextPhase(client.lobbyCode);
      return;
    }

    // Input submitted
    if (data.t === 'input') {
      const client = wsClients.get(ws);
      if (!client || !client.lobbyCode) return;
      const lobby = lobbies[client.lobbyCode];
      if (!lobby || !lobby.gameStarted) return;

      if (data.id !== getCurrentPlayerId(lobby)) return;
      if (data.type !== getCurrentInputType(lobby)) return;

      if (data.type === 'text' && typeof data.content === 'string') {
        lobby.chain[lobby.phaseIndex] = { type: 'text', content: data.content };
        startNextPhase(client.lobbyCode);
      } else if (data.type === 'drawing' && Array.isArray(data.commands) && data.brush) {
        lobby.chain[lobby.phaseIndex] = { type: 'drawing', commands: data.commands, brush: data.brush };
        startNextPhase(client.lobbyCode);
      }
      return;
    }
  });

  ws.on('close', () => {
    const client = wsClients.get(ws);
    if (!client) { wsClients.delete(ws); return; }
    const { lobbyCode, id } = client;
    if (!lobbyCode) { wsClients.delete(ws); return; }
    const lobby = lobbies[lobbyCode];
    if (!lobby) { wsClients.delete(ws); return; }

    delete lobby.players[id];
    lobby.playerOrder = lobby.playerOrder.filter(pid => pid !== id);
    // remove socket entries with that id
    for (const [s, pid] of lobby.playersSockets.entries()) {
      if (pid === id) lobby.playersSockets.delete(s);
    }
    if (lobby.hostId === id) lobby.hostId = lobby.playerOrder.length ? lobby.playerOrder[0] : null;
    sendPlayersUpdate(lobby);

    if (lobby.playerOrder.length === 0) {
      clearTimeout(lobby.phaseTimer);
      delete lobbies[lobbyCode];
      console.log(`Lobby ${lobbyCode} removed (empty)`);
    }

    wsClients.delete(ws);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
