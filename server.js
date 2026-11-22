const http = require('node:http');
const { randomBytes, randomInt } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const page = readFileSync(join(__dirname, 'game.html'));
const rooms = new Map();
const boards = {
  quick: { size: 4 },
  classic: { size: 5 },
  long: { size: 7 },
  adventure: { size: 10 }
};
const journeys = {
  classic: ['Up a ladder!', 'Down a snake!'],
  jungle: ['Climb the jungle vine!', 'Slide down a jungle snake!'],
  space: ['Rocket boost!', 'A black hole pulls you back!'],
  ocean: ['Ride the bubble stream!', 'A whirlpool sweeps you back!']
};
function shuffledJumps(size) {
  const candidates = [];
  const finish = size ** 2;
  for (let low = 2; low < finish - size; low++) {
    for (let high = low + size; high < Math.min(finish, low + size * 3 + 1); high++) {
      candidates.push([low, high]);
    }
  }
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const jumps = {};
  const used = new Set();
  const count = size === 10 ? 14 : size === 7 ? 10 : size === 5 ? 6 : 4;
  for (const [low, high] of candidates) {
    if (used.has(low) || used.has(high)) continue;
    const up = Object.keys(jumps).length % 2 === 0;
    jumps[up ? low : high] = up ? high : low;
    used.add(low);
    used.add(high);
    if (Object.keys(jumps).length === count) break;
  }
  return jumps;
}
const games = ['snakes', 'pairs', 'connect', 'drawing', 'frustration'];
const inkColours = ['#282344', '#d52e54', '#e36716', '#f2bf18', '#23865e', '#2664c4', '#833fc1', '#ffffff'];
const themes = ['classic', 'jungle', 'space', 'ocean'];
const pairCounts = { quick: 4, classic: 6, long: 10, big: 18, mega: 24 };
const pictureThemes = ['royal', 'villains', 'friends', 'frozen'];
const pictureCards = Object.fromEntries(pictureThemes.map(theme => {
  const cards = JSON.parse(readFileSync(join(__dirname, 'cards-' + theme + '.json'), 'utf8'));
  if (cards.length !== 24 || new Set(cards.map(card => card.name)).size !== 24 ||
      cards.some(card => !['image/png', 'image/webp'].includes(card.mime) || !card.data)) {
    throw new Error('Incomplete picture theme: ' + theme);
  }
  return [theme, cards.map(card => ({ name: card.name, mime: card.mime, bytes: Buffer.from(card.data, 'base64') }))];
}));
const characterDecks = Object.fromEntries(pictureThemes.map(theme => [theme, pictureCards[theme].map(card => card.name)]));
const pieces = ['★', '♥', '◆', '🐱', '🐶', '🦊', '🐸', '🦄', '🚀', '🐢', '🐙', '🦋'];
function availablePiece(room, choice) {
  const available = pieces.filter(piece => !room.pieces.includes(piece));
  return available.includes(choice) ? choice : available[0];
}
const expiry = 2 * 60 * 60 * 1000;

function newBoard(room) {
  const nextJumps = shuffledJumps(boards[room.pace]?.size || 5);
  const repeated = room.jumps && Object.keys(room.jumps).length === Object.keys(nextJumps).length &&
    Object.entries(nextJumps).every(([from, to]) => room.jumps[from] === to);
  room.jumps = repeated ? Object.fromEntries(Object.entries(nextJumps).map(([from, to]) => [to, Number(from)])) : nextJumps;
  room.strokes = [];
  room.drawingVersion = 0;
  room.turn = 0;
  room.winner = null;
  room.message = '';
  room.positions = Array(room.capacity).fill(1);
  room.round = randomBytes(8).toString('hex');
  room.roll = null;
  room.racers = Array.from({ length: room.capacity }, () => [-1, -1]);
  room.raceDie = null;
  room.grid = Array(42).fill(null);
  const faces = characterDecks[room.pairTheme] || ['🐱', '🐶', '🐸', '🐝', '🦋', '🐢', '🦊', '🐙', '🦄', '🐼',
    '🐷', '🐰', '🦁', '🐨', '🐵', '🦉', '🐧', '🦀', '🐬', '🦒', '🦔', '🐌', '🐞', '🦆'];
  room.cards = faces.slice(0, pairCounts[room.pace]).flatMap(face => [face, face]);
  for (let i = room.cards.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [room.cards[i], room.cards[j]] = [room.cards[j], room.cards[i]];
  }
  room.open = [];
  room.matched = [];
  room.cardOwners = {};
  room.scores = Array(room.capacity).fill(0);
  room.hideAt = 0;
}

function settle(room) {
  if (room.hideAt && Date.now() >= room.hideAt) {
    room.open = [];
    room.hideAt = 0;
    room.turn = (room.turn + 1) % room.capacity;
  }
}

function move(room, player, cell) {
  const seats = room.game === 'connect' ? 2 : room.capacity;
  if (!room.game || room.game === 'drawing' || room.players.length < seats || room.turn !== player || room.winner !== null || room.hideAt) {
    throw new Error('Wait for your turn.');
  }
  if (room.game === 'frustration') {
    if (cell === undefined) {
      if (room.raceDie !== null) throw new Error('Pick a piece to move first.');
      const die = randomInt(1, 7);
      room.roll = { id: randomBytes(8).toString('hex'), player, die };
      room.raceDie = die;
      room.message = `${room.names[player]} rolled ${die}. Pick a glowing piece.`;
      if (!raceChoices(room, player).length) {
        room.raceDie = null;
        room.turn = (player + 1) % seats;
        room.message = 'Your pieces are blocked. Next player’s turn!';
      }
      return;
    }
    if (room.raceDie === null || !raceChoices(room, player).includes(cell)) throw new Error('Pick one of your glowing pieces.');
    const die = room.raceDie;
    const destination = Math.min(24, Math.max(0, room.racers[player][cell]) + die);
    room.racers[player][cell] = destination;
    let bumped = false;
    if (destination < 24) {
      const spot = raceSpot(room, player, destination);
      if (spot % (24 / seats) !== 0) {
        room.racers.forEach((pieces, owner) => {
          if (owner === player) return;
          pieces.forEach((progress, index) => {
            if (progress >= 0 && progress < 24 && raceSpot(room, owner, progress) === spot) {
              pieces[index] = -1;
              bumped = true;
            }
          });
        });
      }
    }
    room.raceDie = null;
    if (room.racers[player].every(progress => progress === 24)) room.winner = player;
    room.message = `${room.names[player]} moved piece ${cell + 1}.` +
      (destination === 24 ? ' Home safe!' : '') + (bumped ? ' Bump! The other piece goes back to base.' : '') +
      (die === 6 && room.winner === null ? ' A six means another turn!' : '');
    if (die !== 6) room.turn = (player + 1) % seats;
    return;
  }
  if (room.game === 'snakes') {
    const { size } = boards[room.pace];
    const jumps = room.jumps;
    const finish = size ** 2;
    const start = room.positions[player];
    const die = randomInt(1, 7);
    const landing = Math.min(finish, start + die);
    const destination = jumps[landing] ?? landing;
    room.positions[player] = destination;
    const journey = journeys[room.theme] || journeys.classic;
    const jump = destination === landing ? '' : ' ' + journey[destination > landing ? 0 : 1];
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
      room.cardOwners[a] = player;
      room.cardOwners[b] = player;
      room.open = [];
      room.scores[player]++;
      if (room.matched.length === room.cards.length) {
        const best = Math.max(...room.scores);
        const winners = room.scores.map((score, i) => score === best ? i : -1).filter(i => i >= 0);
        room.winner = winners.length === 1 ? winners[0] : 'draw';
      }
    } else {
      room.hideAt = Date.now() + 1800;
    }
    return;
  }
  room.turn = (player + 1) % seats;
}

function raceSpot(room, player, progress) {
  return (player * (24 / room.capacity) + progress) % 24;
}

function raceChoices(room, player) {
  if (room.raceDie === null) return [];
  return room.racers[player].flatMap((progress, index, pieces) => {
    const target = Math.min(24, Math.max(0, progress) + room.raceDie);
    const blocked = target < 24 && pieces.some((other, i) => i !== index && other === target);
    return progress === 24 || blocked ? [] : [index];
  });
}

function reply(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function handle(data) {
  const { action, code, token, game, cell, name, pace, capacity, round, theme, piece, pairTheme } = data;
  const nickname = typeof name === 'string' ? name.trim().slice(0, 20) : '';
  const now = Date.now();
  for (const [key, room] of rooms) if (now - room.touched > expiry) rooms.delete(key);
  let room;
  let player;
  if (action === 'create') {
    if (rooms.size >= 500) throw new Error('The game world is busy. Try again soon.');
    let key;
    do { key = randomBytes(5).toString('hex').toUpperCase(); } while (rooms.has(key));
    room = { code: key, game: null, capacity: capacity === 3 ? 3 : 2, players: [randomBytes(24).toString('hex')], names: [nickname || 'Player 1'] };
    room.pace = Object.hasOwn(boards, pace) ? pace : 'classic';
    room.theme = 'classic';
    room.pieces = [];
    room.pieces.push(availablePiece(room, piece));
    newBoard(room);
    rooms.set(key, room);
    player = 0;
  } else {
    room = rooms.get(typeof code === 'string' ? code.trim().toUpperCase() : '');
    if (!room) throw new Error('Room expired or code not found. Check the code or make a new room.');
    if (action === 'join') {
      if (room.players.length >= room.capacity) throw new Error('This lobby is full.');
      player = room.players.push(randomBytes(24).toString('hex')) - 1;
      room.names.push(nickname || 'Player 2');
      room.pieces.push(availablePiece(room, piece));
    } else {
      player = room.players.indexOf(token);
      if (player < 0) throw new Error('Please join the room first.');
    }
  }
  settle(room);
  if (action === 'exit') {
    if (player === 0) rooms.delete(room.code);
    else {
      room.players.splice(player, 1);
      room.names.splice(player, 1);
      room.pieces.splice(player, 1);
      if (room.game === 'drawing') {
        for (const stroke of room.strokes) {
          if (stroke.owner === player) stroke.owner = -1;
          else if (stroke.owner > player) stroke.owner--;
        }
        room.drawingVersion++;
      } else if (room.game !== 'connect' || player === 1) {
        room.game = null;
        newBoard(room);
      }
    }
    return {};
  }
  if (action === 'draw' || action === 'undo') {
    if (room.game !== 'drawing' || round !== room.round) throw new Error('The drawing has changed.');
    if (action === 'draw') {
      const { colour, points } = data;
      if (!inkColours.includes(colour) || !Array.isArray(points) || !points.length || points.length > 500 ||
          !points.every(point => Array.isArray(point) && point.length === 2 &&
            point.every(value => Number.isInteger(value) && value >= 0 && value <= 1000))) {
        throw new Error('That stroke could not be added.');
      }
      if (room.strokes.length >= 300) throw new Error('This picture is full. Start a new picture to keep drawing.');
      room.strokes.push({ owner: player, colour, points });
    } else {
      const last = room.strokes.findLastIndex(stroke => stroke.owner === player);
      if (last >= 0) room.strokes.splice(last, 1);
    }
    room.drawingVersion++;
  }
  if (action === 'piece') {
    if (!pieces.includes(piece) || room.pieces.some((value, i) => i !== player && value === piece)) {
      throw new Error('That piece is taken. Pick another one.');
    }
    room.pieces[player] = piece;
  }
  if (action === 'switch' || action === 'lobby') {
    if (player !== 0) throw new Error('Only the host can choose the game.');
    if (action === 'switch' && !games.includes(game)) throw new Error('Pick a game.');
    room.game = action === 'lobby' ? null : game;
    const lengths = room.game === 'pairs' ? pairCounts : boards;
    room.pace = Object.hasOwn(lengths, pace) ? pace : 'classic';
    room.theme = themes.includes(theme) ? theme : 'classic';
    room.pairTheme = Object.hasOwn(characterDecks, pairTheme) ? pairTheme : 'emoji';
    newBoard(room);
  }
  if (action === 'move' || action === 'restart') {
    if (round !== room.round) throw new Error('The game changed. Try again on the new board.');
  }
  if (action === 'move') move(room, player, cell);
  if (action === 'restart') {
    if (player !== 0 || room.winner === null) throw new Error('Player 1 can restart after the game.');
    newBoard(room);
  }
  room.touched = now;
  return {
    code: room.code, token: room.players[player], player, game: room.game,
    ready: Boolean(room.game) && room.players.length >= (room.game === 'connect' ? 2 : room.capacity),
    capacity: room.capacity, round: room.round, turn: room.turn, winner: room.winner,
    positions: room.positions, size: boards[room.pace]?.size || 5, jumps: room.jumps, pace: room.pace, message: room.message, grid: room.grid,
    names: room.names, roll: room.roll, theme: room.theme, pieces: room.pieces, choices: pieces,
    scores: room.scores, paused: Boolean(room.hideAt),
    pairTheme: room.pairTheme || 'emoji',
    characterFaces: characterDecks[room.pairTheme],
    cards: room.cards.map((face, i) => room.open.includes(i) || room.matched.includes(i) ? face : null),
    matched: room.matched, cardOwners: room.cardOwners,
    racers: room.racers, raceDie: room.raceDie,
    raceChoices: room.game === 'frustration' && room.turn === player ? raceChoices(room, player) : [],
    drawingVersion: room.drawingVersion,
    strokes: room.game === 'drawing' && (action !== 'state' || round !== room.round ||
      data.drawingVersion !== room.drawingVersion) ? room.strokes : undefined
  };
}

const server = http.createServer(async (req, res) => {
  const picture = /^\/cards\/(royal|villains|friends|frozen)\/(\d{1,2})$/.exec(req.url.split('?')[0]);
  if (req.method === 'GET' && picture) {
    const card = pictureCards[picture[1]][Number(picture[2])];
    if (!card) return reply(res, 404, { error: 'Picture not found.' });
    res.writeHead(200, { 'Content-Type': card.mime, 'Content-Length': card.bytes.length,
      'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
    return res.end(card.bytes);
  }
  if (req.method === 'GET' && ['/', '/snakes-setup', '/pairs-setup'].includes(req.url)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'no-referrer' });
    return res.end(page);
  }
  if (req.method !== 'POST' || req.url !== '/room' ||
      req.headers['content-type'] !== 'application/json') return reply(res, 404, { error: 'Page not found.' });
  let body = '';
  try {
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 8192) return reply(res, 413, { error: 'Request is too large.' });
    }
    const data = JSON.parse(body);
    if (!['create', 'join', 'state', 'move', 'restart', 'switch', 'lobby', 'exit', 'piece', 'draw', 'undo'].includes(data?.action)) {
      throw new Error('Choose a room action.');
    }
    reply(res, 200, handle(data));
  } catch (error) {
    reply(res, 400, { error: error instanceof SyntaxError ? 'Invalid request.' : error.message });
  }
});

if (require.main === module) server.listen(process.env.PORT || 3000, '0.0.0.0');
module.exports = server;


