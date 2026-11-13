const http = require('node:http');
const { randomBytes, randomInt } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const page = readFileSync(join(__dirname, 'game.html'));
const rooms = new Map();
const boards = {
  quick: { size: 4, jumps: { 3: 9, 6: 12, 11: 4, 15: 8 } },
  classic: { size: 5, jumps: { 3: 11, 6: 15, 10: 20, 17: 8, 22: 13, 24: 16 } },
  long: { size: 7, jumps: { 4: 17, 9: 23, 19: 32, 28: 41, 38: 46, 15: 7, 26: 13, 35: 22, 44: 31, 48: 39 } }
};
const games = ['snakes', 'pairs', 'connect'];
const expiry = 2 * 60 * 60 * 1000;

function newBoard(room) {
  room.turn = 0;
  room.winner = null;
  room.message = '';
  room.positions = [1, 1];
  room.roll = null;
  room.grid = Array(42).fill(null);
  room.cards = ['🐱', '🐶', '🐸', '🐝', '🦋', '🐢'].flatMap(face => [face, face]);
  for (let i = room.cards.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [room.cards[i], room.cards[j]] = [room.cards[j], room.cards[i]];
  }
  room.open = [];
  room.matched = [];
  room.scores = [0, 0];
  room.hideAt = 0;
}

function settle(room) {
  if (room.hideAt && Date.now() >= room.hideAt) {
    room.open = [];
    room.hideAt = 0;
    room.turn = 1 - room.turn;
  }
}

function move(room, player, cell) {
  if (room.players.length !== 2 || room.turn !== player || room.winner !== null || room.hideAt) {
    throw new Error('Wait for your turn.');
  }
  if (room.game === 'snakes') {
    const { size, jumps } = boards[room.pace];
    const finish = size ** 2;
    const start = room.positions[player];
    const die = randomInt(1, 7);
    const landing = Math.min(finish, start + die);
    const destination = jumps[landing] ?? landing;
    room.positions[player] = destination;
    const jump = destination > landing ? ' Up a ladder!' : destination < landing ? ' Down a snake!' : '';
    room.message = `${room.names[player]} rolled ${die}.${jump}`;
    room.roll = { id: randomBytes(8).toString('hex'), player, die, start, landing, destination };
    if (destination === finish) room.winner = player;
  }
  if (room.game === 'connect') {
    if (!Number.isInteger(cell) || cell < 0 || cell > 6) throw new Error('Pick a column.');
    let row = 5;
    while (row >= 0 && room.grid[row * 7 + cell] !== null) row--;
    if (row < 0) throw new Error('That column is full.');
    room.grid[row * 7 + cell] = player;
    for (const [dy, dx] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
      let count = 1;
      for (const sign of [-1, 1]) {
        let y = row + dy * sign;
        let x = cell + dx * sign;
        while (y >= 0 && y < 6 && x >= 0 && x < 7 && room.grid[y * 7 + x] === player) {
          count++;
          y += dy * sign;
          x += dx * sign;
        }
      }
      if (count >= 4) room.winner = player;
    }
    if (room.winner === null && room.grid.every(value => value !== null)) room.winner = 'draw';
  }
  if (room.game === 'pairs') {
    if (!Number.isInteger(cell) || cell < 0 || cell >= room.cards.length ||
        room.open.includes(cell) || room.matched.includes(cell)) throw new Error('Pick a face-down card.');
    room.open.push(cell);
    if (room.open.length === 1) return;
    const [a, b] = room.open;
    if (room.cards[a] === room.cards[b]) {
      room.matched.push(a, b);
      room.open = [];
      room.scores[player]++;
      if (room.matched.length === room.cards.length) {
        room.winner = room.scores[0] === room.scores[1] ? 'draw' : Number(room.scores[1] > room.scores[0]);
      }
    } else {
      room.hideAt = Date.now() + 1800;
    }
    return;
  }
  room.turn = 1 - player;
}

function reply(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function handle(data) {
  const { action, code, token, game, cell, name, pace } = data;
  const nickname = typeof name === 'string' ? name.trim().slice(0, 20) : '';
  const now = Date.now();
  for (const [key, room] of rooms) if (now - room.touched > expiry) rooms.delete(key);
  let room;
  let player;
  if (action === 'create') {
    if (rooms.size >= 500) throw new Error('The game world is busy. Try again soon.');
    if (!games.includes(game)) throw new Error('Pick a game.');
    let key;
    do { key = randomBytes(5).toString('hex').toUpperCase(); } while (rooms.has(key));
    room = { code: key, game, players: [randomBytes(24).toString('hex')], names: [nickname || 'Player 1'] };
    room.pace = Object.hasOwn(boards, pace) ? pace : 'classic';
    newBoard(room);
    rooms.set(key, room);
    player = 0;
  } else {
    room = rooms.get(typeof code === 'string' ? code.trim().toUpperCase() : '');
    if (!room) throw new Error('Room expired or code not found. Check the code or make a new room.');
    if (action === 'join') {
      if (room.players.length === 2) throw new Error('This room already has two players.');
      player = room.players.push(randomBytes(24).toString('hex')) - 1;
      room.names.push(nickname || 'Player 2');
    } else {
      player = room.players.indexOf(token);
      if (player < 0) throw new Error('Please join the room first.');
    }
  }
  settle(room);
  if (action === 'move') move(room, player, cell);
  if (action === 'restart') {
    if (player !== 0 || room.winner === null) throw new Error('Player 1 can restart after the game.');
    newBoard(room);
  }
  room.touched = now;
  return {
    code: room.code, token: room.players[player], player, game: room.game,
    ready: room.players.length === 2, turn: room.turn, winner: room.winner,
    positions: room.positions, ...boards[room.pace], pace: room.pace, message: room.message, grid: room.grid,
    names: room.names, roll: room.roll,
    scores: room.scores, paused: Boolean(room.hideAt),
    cards: room.cards.map((face, i) => room.open.includes(i) || room.matched.includes(i) ? face : null),
    matched: room.matched
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'no-referrer' });
    return res.end(page);
  }
  if (req.method !== 'POST' || req.url !== '/room' ||
      req.headers['content-type'] !== 'application/json') return reply(res, 404, { error: 'Page not found.' });
  let body = '';
  try {
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 2048) return reply(res, 413, { error: 'Request is too large.' });
    }
    const data = JSON.parse(body);
    if (!['create', 'join', 'state', 'move', 'restart'].includes(data?.action)) {
      throw new Error('Choose a room action.');
    }
    reply(res, 200, handle(data));
  } catch (error) {
    reply(res, 400, { error: error instanceof SyntaxError ? 'Invalid request.' : error.message });
  }
});

if (require.main === module) server.listen(process.env.PORT || 3000, '0.0.0.0');
module.exports = server;

