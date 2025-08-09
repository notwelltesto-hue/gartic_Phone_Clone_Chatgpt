// server.js
// Run with: node server.js

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

wss.on('connection', (ws) => {
  console.log('client connected');

  ws.on('message', (message) => {
    // Broadcast incoming message to all clients
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  });

  ws.on('close', () => console.log('client disconnected'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
