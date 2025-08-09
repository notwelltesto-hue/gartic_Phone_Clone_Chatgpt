// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(express.json({ limit: '10mb' })); // accept big base64 images

// In-memory rooms: { code: { players: [{id,name}], hostId, isPublic, state, round, nRounds, slotPrompts, submissions } }
const rooms = {};
const randomPrompts = [
  "A cat riding a skateboard",
  "A giant pizza in space",
  "A wizard making coffee",
  "A laughing banana",
  "A robot planting a tree",
  "A sleepy dinosaur reading"
];

function makeCode(len = 6) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function publicRoomList() {
  return Object.entries(rooms)
    .filter(([_, r]) => r.isPublic && r.state === 'lobby')
    .map(([code, r]) => ({ code, players: r.players.length }));
}

// Socket events
io.on('connection', socket => {
  console.log('connect', socket.id);

  // Send current public lobbies on new connection
  socket.emit('lobbyList', publicRoomList());

  socket.on('createLobby', ({ name, isPublic }) => {
    const code = makeCode();
    rooms[code] = {
      players: [{ id: socket.id, name }],
      hostId: socket.id,
      isPublic: !!isPublic,
      state: 'lobby',
      round: 0,
      nRounds: 0,
      slotPrompts: [],
      submissions: []
    };
    socket.join(code);
    socket.emit('lobbyCreated', { code });
    io.emit('lobbyList', publicRoomList());
    updateRoomPlayers(code);
  });

  socket.on('getLobbies', () => {
    socket.emit('lobbyList', publicRoomList());
  });

  socket.on('joinLobby', ({ code, name }) => {
    const room = rooms[code];
    if (!room) {
      socket.emit('errorMsg', 'Lobby not found');
      return;
    }
    if (room.state !== 'lobby') {
      socket.emit('errorMsg', 'Game already started');
      return;
    }
    room.players.push({ id: socket.id, name });
    socket.join(code);
    socket.emit('joined', { code });
    io.emit('lobbyList', publicRoomList());
    updateRoomPlayers(code);
  });

  socket.on('leaveLobby', ({ code }) => {
    leaveRoom(socket.id, code);
  });

  socket.on('toggleReady', ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    const p = room.players.find(x => x.id === socket.id);
    if (!p) return;
    p.ready = !p.ready;
    updateRoomPlayers(code);
  });

  socket.on('startGame', ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    if (socket.id !== room.hostId) {
      socket.emit('errorMsg', 'Only host can start');
      return;
    }
    if (room.players.length < 2) {
      socket.emit('errorMsg', 'Need at least 2 players');
      return;
    }

    // Request initial prompts from every player (they can type or server will pick random)
    room.state = 'gatheringPrompts';
    room.slotPrompts = new Array(room.players.length).fill(null);
    io.to(code).emit('requestInitialPrompts');
    updateRoomPlayers(code);
  });

  socket.on('submitInitialPrompt', ({ code, prompt }) => {
    const room = rooms[code];
    if (!room || room.state !== 'gatheringPrompts') return;
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx === -1) return;
    room.slotPrompts[idx] = (prompt && prompt.trim()) || randomPrompts[Math.floor(Math.random()*randomPrompts.length)];

    if (room.slotPrompts.every(x => x !== null)) {
      // all prompts collected -> init game
      const n = room.players.length;
      room.nRounds = n;
      room.round = 0;
      // submissions is an array of rounds, each is array of size n (slots)
      room.submissions = Array.from({ length: n }, () => Array(n).fill(null));
      // store initial prompts separately
      // Move to first round: draw round (round 0 is draw)
      room.state = 'playing';
      // send first round content
      distributeRound(code);
      updateRoomPlayers(code);
    } else {
      updateRoomPlayers(code);
    }
  });

  socket.on('submitRound', ({ code, payload }) => {
    // payload: { slotIndex, data } where slotIndex is the slot being acted on
    const room = rooms[code];
    if (!room || room.state !== 'playing') return;
    const r = room.round;
    const slotIndex = payload.slotIndex;
    if (slotIndex == null || slotIndex < 0 || slotIndex >= room.players.length) return;
    // store in submissions[r][slotIndex]
    room.submissions[r][slotIndex] = payload.data; // either dataURL or text
    // check if round complete (all slots have submission for round r)
    const allDone = room.submissions[r].every(x => x !== null);
    if (allDone) {
      // advance
      room.round++;
      if (room.round >= room.nRounds) {
        room.state = 'reveal';
        // send reveal
        sendReveal(code);
        updateRoomPlayers(code);
      } else {
        distributeRound(code);
        updateRoomPlayers(code);
      }
    } else {
      updateRoomPlayers(code);
    }
  });

  socket.on('disconnect', () => {
    console.log('disconnect', socket.id);
    // remove player from any rooms
    for (const code of Object.keys(rooms)) {
      if (leaveRoom(socket.id, code)) {
        io.emit('lobbyList', publicRoomList());
      }
    }
  });
});

// helper: update player lists to room
function updateRoomPlayers(code) {
  const room = rooms[code];
  if (!room) return;
  const lightPlayers = room.players.map(p => ({ id: p.id, name: p.name, ready: !!p.ready }));
  io.to(code).emit('roomUpdate', {
    players: lightPlayers,
    hostId: room.hostId,
    state: room.state,
    round: room.round,
    nRounds: room.nRounds
  });
}

// helper: leave and cleanup
function leaveRoom(socketId, code) {
  const room = rooms[code];
  if (!room) return false;
  const idx = room.players.findIndex(p => p.id === socketId);
  if (idx !== -1) {
    room.players.splice(idx, 1);
    io.to(code).emit('systemMsg', 'A player left');
    // if host left, pick new host
    if (room.hostId === socketId) {
      room.hostId = room.players.length ? room.players[0].id : null;
    }
    // if no players left, delete
    if (room.players.length === 0) {
      delete rooms[code];
    } else {
      updateRoomPlayers(code);
    }
    return true;
  }
  return false;
}

// main algorithm: distribute content for current round to each player
function distributeRound(code) {
  const room = rooms[code];
  if (!room) return;
  const r = room.round;
  const n = room.players.length;
  // For each player p, compute the slotIndex they act on this round:
  // slotIndex = (pIndex - r + n) % n
  // If r==0 then p acts on their own slot -> initial prompt
  room.players.forEach((p, pIndex) => {
    const slotIndex = ((pIndex - r) % n + n) % n;
    let content;
    if (r === 0) {
      content = { type: 'prompt', data: room.slotPrompts[slotIndex] };
    } else {
      // they act on submissions from previous round for that slot
      const prev = room.submissions[r-1][slotIndex];
      const prevType = (r-1) % 2 === 0 ? 'image' : 'text';
      content = { type: prevType, data: prev };
    }
    // Determine whether this round expects drawing or text:
    const expecting = (r % 2 === 0) ? 'draw' : 'write';
    // Tell the socket
    io.to(p.id).emit('roundStart', {
      round: r,
      nRounds: n,
      expecting,
      slotIndex,
      content
    });
  });
}

// reveal: build chains for each slot (starting owner)
function sendReveal(code) {
  const room = rooms[code];
  if (!room) return;
  const n = room.players.length;
  const chains = [];
  for (let slot = 0; slot < n; slot++) {
    const chain = [];
    chain.push({ type: 'prompt', data: room.slotPrompts[slot] });
    for (let r = 0; r < n; r++) {
      const item = room.submissions[r][slot];
      const type = r % 2 === 0 ? 'image' : 'text';
      chain.push({ type, data: item });
    }
    chains.push({ slot, owner: room.players[slot] ? room.players[slot].name : 'Player', chain });
  }
  io.to(code).emit('reveal', { chains });
}

server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
