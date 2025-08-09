// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e7 }); // allow larger payloads

const PORT = process.env.PORT || 10000;

app.use(express.static('public'));
app.use(express.json({ limit: '15mb' }));

// rooms: code -> room
// room: { players:[{id,name}], hostId, isPublic, state, round, nRounds, slotPrompts, submissions, votes }
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

io.on('connection', socket => {
  console.log('connect', socket.id);
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
      submissions: [], // submissions[round][slot] = {data,thumb,fromId}
      votes: null // { round: r, votes: { slot: {optionIndex:count,...} } }
    };
    socket.join(code);
    socket.emit('lobbyCreated', { code });
    io.emit('lobbyList', publicRoomList());
    updateRoomPlayers(code);
  });

  socket.on('getLobbies', () => socket.emit('lobbyList', publicRoomList()));

  socket.on('joinLobby', ({ code, name }) => {
    const room = rooms[code];
    if (!room) { socket.emit('errorMsg', 'Lobby not found'); return; }
    if (room.state !== 'lobby') { socket.emit('errorMsg', 'Game already started'); return; }
    room.players.push({ id: socket.id, name });
    socket.join(code);
    socket.emit('joined', { code });
    io.emit('lobbyList', publicRoomList());
    updateRoomPlayers(code);
  });

  socket.on('leaveLobby', ({ code }) => {
    const removed = leaveRoom(socket.id, code);
    if (removed) io.emit('lobbyList', publicRoomList());
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
    if (socket.id !== room.hostId) { socket.emit('errorMsg', 'Only host can start'); return; }
    if (room.players.length < 2) { socket.emit('errorMsg', 'Need at least 2 players'); return; }

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
      const n = room.players.length;
      room.nRounds = n;
      room.round = 0;
      room.submissions = Array.from({ length: n }, () => Array(n).fill(null));
      room.votes = null;
      room.state = 'playing';
      distributeRound(code);
      updateRoomPlayers(code);
    } else updateRoomPlayers(code);
  });

  // payload: { slotIndex, data, thumb }  (data = full dataURL for drawings or text)
  socket.on('submitRound', ({ code, payload }) => {
    const room = rooms[code];
    if (!room || room.state !== 'playing') return;
    const r = room.round;
    const slotIndex = payload.slotIndex;
    if (slotIndex == null || slotIndex < 0 || slotIndex >= room.players.length) return;
    room.submissions[r][slotIndex] = { data: payload.data, thumb: payload.thumb || null, fromId: socket.id };
    const allDone = room.submissions[r].every(x => x !== null);
    if (allDone) {
      room.round++;
      if (room.round >= room.nRounds) {
        room.state = 'reveal';
        sendReveal(code);
        updateRoomPlayers(code);
      } else {
        distributeRound(code);
        updateRoomPlayers(code);
      }
    } else updateRoomPlayers(code);
  });

  // votes: { slot, choiceIndex } - simple voting on reveal items (e.g., best drawing for a chain)
  socket.on('vote', ({ code, slot, choiceIndex }) => {
    const room = rooms[code];
    if (!room || room.state !== 'reveal') return;
    if (!room.votes) room.votes = {};
    if (!room.votes[slot]) room.votes[slot] = {};
    room.votes[slot][choiceIndex] = (room.votes[slot][choiceIndex] || 0) + 1;
    // broadcast updated vote counts for the slot
    io.to(code).emit('voteUpdate', { slot, counts: room.votes[slot] });
  });

  socket.on('disconnect', () => {
    console.log('disconnect', socket.id);
    for (const code of Object.keys(rooms)) {
      if (leaveRoom(socket.id, code)) io.emit('lobbyList', publicRoomList());
    }
  });
});

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

function leaveRoom(socketId, code) {
  const room = rooms[code];
  if (!room) return false;
  const idx = room.players.findIndex(p => p.id === socketId);
  if (idx !== -1) {
    room.players.splice(idx, 1);
    io.to(code).emit('systemMsg', 'A player left');
    if (room.hostId === socketId) room.hostId = room.players.length ? room.players[0].id : null;
    if (room.players.length === 0) delete rooms[code];
    else updateRoomPlayers(code);
    return true;
  }
  return false;
}

function distributeRound(code) {
  const room = rooms[code];
  if (!room) return;
  const r = room.round;
  const n = room.players.length;
  room.players.forEach((p, pIndex) => {
    const slotIndex = ((pIndex - r) % n + n) % n;
    let content;
    if (r === 0) content = { type: 'prompt', data: room.slotPrompts[slotIndex] };
    else {
      const prev = room.submissions[r-1][slotIndex];
      const prevType = (r-1) % 2 === 0 ? 'image' : 'text';
      content = { type: prevType, data: prev ? prev.data : null, thumb: prev ? prev.thumb : null };
    }
    const expecting = (r % 2 === 0) ? 'draw' : 'write';
    io.to(p.id).emit('roundStart', { round: r, nRounds: n, expecting, slotIndex, content, timeSec: 90 });
  });
}

function sendReveal(code) {
  const room = rooms[code];
  if (!room) return;
  const n = room.players.length;
  const chains = [];
  for (let slot = 0; slot < n; slot++) {
    const chain = [];
    chain.push({ type: 'prompt', data: room.slotPrompts[slot] });
    for (let r = 0; r < n; r++) {
      const itemObj = room.submissions[r][slot];
      const type = r % 2 === 0 ? 'image' : 'text';
      const data = itemObj ? itemObj.data : null;
      const thumb = itemObj ? itemObj.thumb : null;
      chain.push({ type, data, thumb });
    }
    chains.push({ slot, owner: { name: room.players[slot] ? room.players[slot].name : 'Player' }, chain });
  }
  // reset votes
  room.votes = {};
  io.to(code).emit('reveal', { chains });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on ${PORT}`);
});
