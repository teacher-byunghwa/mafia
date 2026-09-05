const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const app = express();
app.set('trust proxy', true);
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 30;
const ROLE_REVEAL_SECONDS = 15;
const VOTE_RESULT_SECONDS = 10;
const rooms = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function clampInt(v, min, max, fallback) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function createRoom(settings = {}) {
  const code = makeCode();
  const hostToken = crypto.randomUUID();
  const room = {
    code,
    hostToken,
    createdAt: Date.now(),
    settings: {
      mafia: clampInt(settings.mafia, 1, 10, 2),
      citizen: clampInt(settings.citizen, 0, 29, 6),
      police: clampInt(settings.police, 0, 5, 1),
      doctor: clampInt(settings.doctor, 0, 5, 1),
      daySeconds: clampInt(settings.daySeconds, 30, 900, 180),
      voteSeconds: clampInt(settings.voteSeconds, 15, 180, 45),
      nightSeconds: clampInt(settings.nightSeconds, 20, 180, 45),
      roleRevealSeconds: ROLE_REVEAL_SECONDS,
      voteResultSeconds: VOTE_RESULT_SECONDS
    },
    players: new Map(),
    hostSocketId: null,
    phase: 'lobby',
    round: 0,
    phaseEndsAt: null,
    timer: null,
    votes: new Map(),
    voteResult: null,
    night: {
      policeTargets: new Map(),
      mafiaTargets: new Map(),
      doctorTargets: new Map()
    },
    chat: [],
    log: [],
    winner: null
  };
  rooms.set(code, room);
  return room;
}

function publicUrl(req, code) {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  const host = req.get('host');
  return `${proto}://${host}/?room=${encodeURIComponent(code)}`;
}

app.post('/api/rooms', async (req, res) => {
  const room = createRoom(req.body || {});
  const joinUrl = publicUrl(req, room.code);
  const qrDataUrl = await QRCode.toDataURL(joinUrl, { margin: 1, width: 320 });
  res.json({
    code: room.code,
    hostToken: room.hostToken,
    joinUrl,
    qrDataUrl,
    settings: room.settings
  });
});

app.get('/api/rooms/:code', (req, res) => {
  const room = rooms.get(String(req.params.code).toUpperCase());
  if (!room) return res.status(404).json({ error: '방을 찾을 수 없습니다.' });
  res.json({ code: room.code, phase: room.phase, playerCount: room.players.size, maxPlayers: MAX_PLAYERS });
});

function roleLabel(role) {
  return ({ mafia: '마피아', citizen: '시민', police: '경찰', doctor: '의사' })[role] || role;
}

function alivePlayers(room) {
  return [...room.players.values()].filter(p => p.alive);
}

function roleCounts(room) {
  const counts = { mafia: 0, citizen: 0, police: 0, doctor: 0, citizenTeam: 0, total: 0 };
  for (const p of room.players.values()) {
    if (!p.alive || !p.role) continue;
    counts[p.role] += 1;
    if (p.role !== 'mafia') counts.citizenTeam += 1;
    counts.total += 1;
  }
  return counts;
}

function sanitizeText(text, max = 120) {
  return String(text || '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function sanitizeNick(text) {
  return sanitizeText(text, 18);
}

function isHost(room, token) {
  return Boolean(token && room.hostToken === token);
}

function buildPlayerAction(room, me) {
  if (!me || !me.alive) return null;

  if (room.phase === 'vote') {
    return {
      type: 'vote',
      targets: alivePlayers(room)
        .filter(p => p.id !== me.id)
        .map(p => ({ id: p.id, nickname: p.nickname, isMe: false }))
    };
  }

  if (room.phase !== 'night') return null;

  let candidates = [];
  if (me.role === 'mafia') {
    candidates = alivePlayers(room).filter(p => p.role !== 'mafia');
  } else if (me.role === 'police') {
    candidates = alivePlayers(room).filter(p => p.id !== me.id);
  } else if (me.role === 'doctor') {
    candidates = alivePlayers(room);
  } else {
    return null;
  }

  return {
    type: me.role,
    targets: candidates.map(p => ({ id: p.id, nickname: p.nickname, isMe: p.id === me.id }))
  };
}

function serializeRoomFor(room, playerToken = null, hostToken = null) {
  const me = playerToken ? [...room.players.values()].find(p => p.token === playerToken) : null;
  const host = isHost(room, hostToken);
  const counts = roleCounts(room);
  const revealActive = room.phase === 'reveal';

  const players = [...room.players.values()].map(p => ({
    id: p.id,
    nickname: p.nickname,
    alive: p.alive,
    connected: p.connected,
    // 교사는 항상 역할을 볼 수 있다. 학생에게는 역할 공개 15초 동안 같은 마피아만 표시한다.
    role: host ? p.role : (revealActive && me && me.role === 'mafia' && p.role === 'mafia' ? 'mafia' : undefined),
    isMe: me ? p.id === me.id : false
  }));

  const state = {
    code: room.code,
    phase: room.phase,
    round: room.round,
    phaseEndsAt: room.phaseEndsAt,
    settings: room.settings,
    players,
    playerCount: room.players.size,
    maxPlayers: MAX_PLAYERS,
    counts,
    chat: room.chat.slice(-100),
    log: room.log.slice(-60),
    winner: room.winner,
    voteResult: room.phase === 'voteResult' ? room.voteResult : null,
    me: me ? {
      id: me.id,
      nickname: me.nickname,
      // 역할 자체도 공개 단계에서만 클라이언트로 보낸다.
      role: revealActive ? me.role : undefined,
      alive: me.alive,
      connected: me.connected,
      policeResult: room.phase === 'day' ? (me.policeResult || null) : null,
      // 마피아의 밤 공격으로 탈락한 학생에게만 전달되는 개인 알림이다.
      eliminationNotice: me.eliminationNotice || null,
      mafiaTeammates: revealActive && me.role === 'mafia'
        ? alivePlayers(room).filter(p => p.role === 'mafia' && p.id !== me.id).map(p => p.nickname)
        : undefined
    } : null,
    action: me ? buildPlayerAction(room, me) : null,
    host
  };

  if (host) {
    state.nightSummary = {
      policeSubmitted: room.night.policeTargets.size,
      mafiaSubmitted: room.night.mafiaTargets.size,
      doctorSubmitted: room.night.doctorTargets.size
    };
    state.voteSubmitted = room.votes.size;
  }
  return state;
}

function emitState(room) {
  for (const p of room.players.values()) {
    if (p.socketId) io.to(p.socketId).emit('state', serializeRoomFor(room, p.token, null));
  }
  if (room.hostSocketId) {
    io.to(room.hostSocketId).emit('state', serializeRoomFor(room, null, room.hostToken));
  }
}

function addLog(room, text) {
  room.log.push({ id: crypto.randomUUID(), text, at: Date.now() });
  if (room.log.length > 200) room.log.splice(0, room.log.length - 200);
}

function clearTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
  room.phaseEndsAt = null;
}

function setPhaseTimer(room, seconds, onEnd) {
  clearTimer(room);
  room.phaseEndsAt = Date.now() + seconds * 1000;
  room.timer = setTimeout(() => {
    room.timer = null;
    room.phaseEndsAt = null;
    onEnd();
  }, seconds * 1000);
}

function checkWin(room) {
  if (room.phase === 'ended') return true;
  const counts = roleCounts(room);
  if (counts.mafia <= 0) {
    room.phase = 'ended';
    room.winner = 'citizen';
    room.voteResult = null;
    clearTimer(room);
    addLog(room, '모든 마피아가 탈락했습니다. 시민 팀 승리!');
    emitState(room);
    return true;
  }

  // 사용자 요청 규칙: 살아 있는 마피아 수가 살아 있는 시민 팀(시민+경찰+의사)의 2배 이상이면 마피아 승리.
  if (counts.citizenTeam <= 0 || counts.mafia >= counts.citizenTeam * 2) {
    room.phase = 'ended';
    room.winner = 'mafia';
    room.voteResult = null;
    clearTimer(room);
    addLog(room, '마피아가 시민 팀 수의 두 배 이상이 되었습니다. 마피아 승리!');
    emitState(room);
    return true;
  }
  return false;
}

function startReveal(room) {
  room.phase = 'reveal';
  room.round = 0;
  room.voteResult = null;
  addLog(room, `역할 공개 시간입니다. ${ROLE_REVEAL_SECONDS}초 동안 자신의 역할을 확인하세요.`);
  setPhaseTimer(room, ROLE_REVEAL_SECONDS, () => startDay(room));
  emitState(room);
}

function startDay(room) {
  if (checkWin(room)) return;
  room.phase = 'day';
  room.voteResult = null;
  room.votes.clear();
  room.night.policeTargets.clear();
  room.night.mafiaTargets.clear();
  room.night.doctorTargets.clear();
  room.round += 1;
  addLog(room, `${room.round}라운드 낮이 시작되었습니다.`);
  setPhaseTimer(room, room.settings.daySeconds, () => startVote(room));
  emitState(room);
}

function startVote(room) {
  if (checkWin(room)) return;
  room.phase = 'vote';
  room.voteResult = null;
  room.votes.clear();
  addLog(room, '투표 시간입니다. 마피아라고 생각하는 사람 1명을 지목하세요.');
  setPhaseTimer(room, room.settings.voteSeconds, () => resolveVote(room));
  emitState(room);
}

function tallyTargets(map) {
  const tally = new Map();
  for (const targetId of map.values()) {
    tally.set(targetId, (tally.get(targetId) || 0) + 1);
  }
  const sorted = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  if (!sorted.length) return { targetId: null, tie: false, count: 0, tally };
  if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) return { targetId: null, tie: true, count: sorted[0][1], tally };
  return { targetId: sorted[0][0], tie: false, count: sorted[0][1], tally };
}

function buildVoteResult(room, result) {
  const voted = [...result.tally.entries()]
    .map(([id, votes]) => {
      const p = room.players.get(id);
      return p ? { id, nickname: p.nickname, votes } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.votes - a.votes || a.nickname.localeCompare(b.nickname, 'ko'));

  const target = result.targetId ? room.players.get(result.targetId) : null;
  return {
    results: voted,
    tie: result.tie,
    noVotes: voted.length === 0,
    eliminatedId: target?.id || null,
    eliminatedNickname: target?.nickname || null
  };
}

function resolveVote(room) {
  if (room.phase !== 'vote') return;
  clearTimer(room);
  const result = tallyTargets(room.votes);
  room.voteResult = buildVoteResult(room, result);

  if (!result.targetId) {
    addLog(room, result.tie ? '최다 득표가 동률이라 아무도 탈락하지 않았습니다.' : '투표가 없어 아무도 탈락하지 않았습니다.');
  } else {
    const target = room.players.get(result.targetId);
    if (target && target.alive) {
      target.alive = false;
      addLog(room, `${target.nickname} 학생이 투표로 탈락했습니다. 역할은 ${roleLabel(target.role)}였습니다.`);
    }
  }

  room.phase = 'voteResult';
  addLog(room, `투표 결과를 ${VOTE_RESULT_SECONDS}초 동안 공개합니다.`);
  setPhaseTimer(room, VOTE_RESULT_SECONDS, () => finishVoteResult(room));
  emitState(room);
}

function finishVoteResult(room) {
  if (room.phase !== 'voteResult') return;
  clearTimer(room);
  if (checkWin(room)) return;
  startNight(room);
}

function startNight(room) {
  room.phase = 'night';
  room.voteResult = null;
  // 직전 조사 결과는 낮 동안 유지하고, 새 밤이 시작될 때 초기화한다.
  for (const p of room.players.values()) p.policeResult = null;
  room.night.policeTargets.clear();
  room.night.mafiaTargets.clear();
  room.night.doctorTargets.clear();
  addLog(room, '밤이 되었습니다. 경찰·마피아·의사는 각자 행동을 선택하세요.');
  setPhaseTimer(room, room.settings.nightSeconds, () => resolveNight(room));
  emitState(room);
}

function actionRequiredPlayers(room, role) {
  return alivePlayers(room).filter(p => p.role === role);
}

function allNightActionsSubmitted(room) {
  const police = actionRequiredPlayers(room, 'police').length;
  const mafia = actionRequiredPlayers(room, 'mafia').length;
  const doctor = actionRequiredPlayers(room, 'doctor').length;
  return room.night.policeTargets.size >= police &&
    room.night.mafiaTargets.size >= mafia &&
    room.night.doctorTargets.size >= doctor;
}

function resolveNight(room) {
  if (room.phase !== 'night') return;
  clearTimer(room);

  const mafiaChoice = tallyTargets(room.night.mafiaTargets);

  if (mafiaChoice.targetId && !mafiaChoice.tie) {
    const target = room.players.get(mafiaChoice.targetId);
    if (target && target.alive && target.role !== 'mafia') {
      const doctorSaved = [...room.night.doctorTargets.values()].includes(target.id);
      if (doctorSaved) {
        addLog(room, '밤사이 마피아의 공격이 있었지만 의사가 살려냈습니다.');
      } else {
        target.alive = false;
        target.eliminationNotice = {
          id: crypto.randomUUID(),
          reason: 'mafia',
          round: room.round,
          at: Date.now(),
          message: '마피아의 공격을 받아 탈락했습니다!'
        };
        addLog(room, `${target.nickname} 학생이 밤사이 마피아의 공격으로 탈락했습니다.`);
      }
    }
  } else if (mafiaChoice.tie) {
    addLog(room, '마피아들의 선택이 동률이라 밤사이 아무도 공격받지 않았습니다.');
  } else {
    addLog(room, '밤사이 마피아의 공격 대상이 정해지지 않았습니다.');
  }

  // 경찰 결과는 해당 경찰 개인에게만 보이도록 저장한다.
  for (const [policeId, targetId] of room.night.policeTargets.entries()) {
    const police = room.players.get(policeId);
    const target = room.players.get(targetId);
    if (police && target) {
      police.policeResult = {
        targetNickname: target.nickname,
        isMafia: target.role === 'mafia',
        round: room.round
      };
    }
  }

  emitState(room);
  if (checkWin(room)) return;

  setTimeout(() => {
    if (room.phase === 'night' && !room.winner) startDay(room);
  }, 2500);
}

function assignRoles(room) {
  const s = room.settings;
  const roles = [
    ...Array(s.mafia).fill('mafia'),
    ...Array(s.citizen).fill('citizen'),
    ...Array(s.police).fill('police'),
    ...Array(s.doctor).fill('doctor')
  ];
  const players = [...room.players.values()];
  if (roles.length !== players.length) {
    throw new Error(`역할 수 합계(${roles.length})와 접속 학생 수(${players.length})가 같아야 합니다.`);
  }
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }
  players.forEach((p, idx) => {
    p.role = roles[idx];
    p.alive = true;
    p.policeResult = null;
    p.eliminationNotice = null;
  });
}

function getRoom(code) {
  return rooms.get(String(code || '').trim().toUpperCase());
}

io.on('connection', socket => {
  socket.on('host:attach', ({ code, hostToken }, ack = () => {}) => {
    const room = getRoom(code);
    if (!room || !isHost(room, hostToken)) return ack({ ok: false, error: '교사용 인증에 실패했습니다.' });
    room.hostSocketId = socket.id;
    socket.data.roomCode = room.code;
    socket.data.host = true;
    socket.join(room.code);
    ack({ ok: true });
    emitState(room);
  });

  socket.on('player:join', ({ code, nickname, playerToken }, ack = () => {}) => {
    const room = getRoom(code);
    if (!room) return ack({ ok: false, error: '방을 찾을 수 없습니다.' });
    if (room.phase !== 'lobby') {
      const existing = [...room.players.values()].find(p => p.token === playerToken);
      if (!existing) return ack({ ok: false, error: '이미 게임이 시작된 방입니다.' });
    }

    const nick = sanitizeNick(nickname);
    if (!nick) return ack({ ok: false, error: '닉네임을 입력하세요.' });

    let player = playerToken ? [...room.players.values()].find(p => p.token === playerToken) : null;
    if (player) {
      player.socketId = socket.id;
      player.connected = true;
      player.nickname = nick;
    } else {
      if (room.players.size >= MAX_PLAYERS) return ack({ ok: false, error: '최대 30명까지 참여할 수 있습니다.' });
      const duplicate = [...room.players.values()].some(p => p.nickname.toLowerCase() === nick.toLowerCase());
      if (duplicate) return ack({ ok: false, error: '이미 사용 중인 닉네임입니다.' });
      const token = crypto.randomUUID();
      player = {
        id: crypto.randomUUID(),
        token,
        socketId: socket.id,
        nickname: nick,
        connected: true,
        alive: true,
        role: null,
        policeResult: null,
        eliminationNotice: null
      };
      room.players.set(player.id, player);
    }

    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;
    socket.join(room.code);
    ack({ ok: true, playerToken: player.token, playerId: player.id });
    emitState(room);
  });

  socket.on('host:updateSettings', ({ code, hostToken, settings }, ack = () => {}) => {
    const room = getRoom(code);
    if (!room || !isHost(room, hostToken)) return ack({ ok: false, error: '권한이 없습니다.' });
    if (room.phase !== 'lobby') return ack({ ok: false, error: '게임 시작 후에는 설정을 바꿀 수 없습니다.' });
    room.settings = {
      mafia: clampInt(settings.mafia, 1, 10, room.settings.mafia),
      citizen: clampInt(settings.citizen, 0, 29, room.settings.citizen),
      police: clampInt(settings.police, 0, 5, room.settings.police),
      doctor: clampInt(settings.doctor, 0, 5, room.settings.doctor),
      daySeconds: clampInt(settings.daySeconds, 30, 900, room.settings.daySeconds),
      voteSeconds: clampInt(settings.voteSeconds, 15, 180, room.settings.voteSeconds),
      nightSeconds: clampInt(settings.nightSeconds, 20, 180, room.settings.nightSeconds),
      roleRevealSeconds: ROLE_REVEAL_SECONDS,
      voteResultSeconds: VOTE_RESULT_SECONDS
    };
    ack({ ok: true });
    emitState(room);
  });

  socket.on('host:start', ({ code, hostToken }, ack = () => {}) => {
    const room = getRoom(code);
    if (!room || !isHost(room, hostToken)) return ack({ ok: false, error: '권한이 없습니다.' });
    if (room.phase !== 'lobby') return ack({ ok: false, error: '이미 시작된 게임입니다.' });
    if (room.players.size < 3) return ack({ ok: false, error: '최소 3명 이상 접속해야 합니다.' });
    try {
      assignRoles(room);
    } catch (e) {
      return ack({ ok: false, error: e.message });
    }
    addLog(room, '게임이 시작되었습니다. 첫 15초 동안만 각자 역할을 확인합니다.');
    ack({ ok: true });
    startReveal(room);
  });

  socket.on('host:next', ({ code, hostToken }, ack = () => {}) => {
    const room = getRoom(code);
    if (!room || !isHost(room, hostToken)) return ack({ ok: false, error: '권한이 없습니다.' });
    if (room.phase === 'ended' || room.phase === 'lobby' || room.phase === 'reveal') {
      return ack({ ok: false, error: '현재 단계에서는 사용할 수 없습니다.' });
    }
    if (room.phase === 'day') startVote(room);
    else if (room.phase === 'vote') resolveVote(room);
    else if (room.phase === 'voteResult') finishVoteResult(room);
    else if (room.phase === 'night') resolveNight(room);
    else return ack({ ok: false, error: '잘못된 단계입니다.' });
    ack({ ok: true });
  });

  socket.on('host:clearChat', ({ code, hostToken }, ack = () => {}) => {
    const room = getRoom(code);
    if (!room || !isHost(room, hostToken)) return ack({ ok: false, error: '권한이 없습니다.' });
    room.chat = [];
    ack({ ok: true });
    emitState(room);
  });

  socket.on('chat:send', ({ code, playerToken, text }, ack = () => {}) => {
    const room = getRoom(code);
    if (!room) return ack({ ok: false, error: '방이 없습니다.' });
    const player = [...room.players.values()].find(p => p.token === playerToken);
    if (!player || !player.alive) return ack({ ok: false, error: '채팅할 수 없습니다.' });
    if (!['lobby', 'day'].includes(room.phase)) return ack({ ok: false, error: '지금은 공개 채팅 시간이 아닙니다.' });
    const msg = sanitizeText(text, 160);
    if (!msg) return ack({ ok: false, error: '메시지를 입력하세요.' });
    room.chat.push({ id: crypto.randomUUID(), nickname: player.nickname, text: msg, at: Date.now() });
    if (room.chat.length > 200) room.chat.splice(0, room.chat.length - 200);
    ack({ ok: true });
    emitState(room);
  });

  socket.on('vote:submit', ({ code, playerToken, targetId }, ack = () => {}) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'vote') return ack({ ok: false, error: '지금은 투표 시간이 아닙니다.' });
    const player = [...room.players.values()].find(p => p.token === playerToken);
    const target = room.players.get(targetId);
    if (!player || !player.alive) return ack({ ok: false, error: '투표할 수 없습니다.' });
    if (!target || !target.alive) return ack({ ok: false, error: '유효하지 않은 대상입니다.' });
    if (target.id === player.id) return ack({ ok: false, error: '자기 자신에게는 투표할 수 없습니다.' });
    room.votes.set(player.id, target.id);
    ack({ ok: true });
    emitState(room);
    if (room.votes.size >= alivePlayers(room).length) resolveVote(room);
  });

  socket.on('night:action', ({ code, playerToken, targetId }, ack = () => {}) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'night') return ack({ ok: false, error: '지금은 밤 행동 시간이 아닙니다.' });
    const player = [...room.players.values()].find(p => p.token === playerToken);
    const target = room.players.get(targetId);
    if (!player || !player.alive) return ack({ ok: false, error: '행동할 수 없습니다.' });
    if (!target || !target.alive) return ack({ ok: false, error: '유효하지 않은 대상입니다.' });

    if (player.role === 'police') {
      if (target.id === player.id) return ack({ ok: false, error: '자기 자신은 조사할 수 없습니다.' });
      room.night.policeTargets.set(player.id, target.id);
    } else if (player.role === 'mafia') {
      if (target.role === 'mafia') return ack({ ok: false, error: '마피아는 다른 마피아를 공격할 수 없습니다.' });
      room.night.mafiaTargets.set(player.id, target.id);
    } else if (player.role === 'doctor') {
      room.night.doctorTargets.set(player.id, target.id);
    } else {
      return ack({ ok: false, error: '이 역할은 밤 행동이 없습니다.' });
    }

    ack({ ok: true });
    emitState(room);
    if (allNightActionsSubmitted(room)) resolveNight(room);
  });

  socket.on('disconnect', () => {
    const room = getRoom(socket.data.roomCode);
    if (!room) return;
    if (socket.data.host && room.hostSocketId === socket.id) room.hostSocketId = null;
    if (socket.data.playerId) {
      const player = room.players.get(socket.data.playerId);
      if (player && player.socketId === socket.id) {
        player.connected = false;
        player.socketId = null;
      }
    }
    emitState(room);
  });
});

setInterval(() => {
  const cutoff = Date.now() - 12 * 60 * 60 * 1000;
  for (const [code, room] of rooms.entries()) {
    if (room.createdAt < cutoff) {
      clearTimer(room);
      rooms.delete(code);
    }
  }
}, 60 * 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`Classroom Mafia server running on http://localhost:${PORT}`);
});
