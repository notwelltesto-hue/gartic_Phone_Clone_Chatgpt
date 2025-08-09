const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

const players = {}; // id -> name
const prompts = ['cat', 'tree', 'car', 'house', 'dog'];
let drawerIndex = -1; // start before first player

wss.on('connection', (ws) => {
  let clientId = null;

  ws.on('message', (message) => {
    let data;
    try { data = JSON.parse(message); } catch (e) { return; }

    if (data.t === 'meta') {
      clientId = data.id;
      players[clientId] = data.name || 'anon';
      broadcastPlayers();
    }

    // Broadcast all drawing/clear/meta except roundStart (server only)
    if (data.t !== 'roundStart') {
      broadcast(data);
    }
  });

  ws.on('close', () => {
    if (clientId && players[clientId]) {
      delete players[clientId];
      broadcastPlayers();
    }
  });
});

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

function broadcastPlayers() {
  broadcast({ t: 'players', players });
}

function startRound() {
  const playerIds = Object.keys(players);
  if (playerIds.length === 0) return;

  drawerIndex = (drawerIndex + 1) % playerIds.length;
  const drawerId = playerIds[drawerIndex];
  const prompt = prompts[Math.floor(Math.random() * prompts.length)];

  broadcast({
    t: 'roundStart',
    drawerId,
    prompt,
  });
}

setInterval(startRound, 30000); // every 30 seconds
startRound(); // start immediately on server start

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
