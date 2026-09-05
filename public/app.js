const socket = io();
const $ = id => document.getElementById(id);

let mode = null;
let roomCode = null;
let hostToken = null;
let playerToken = null;
let lastState = null;
let qrDataUrl = null;
let joinUrl = null;
let countdownTimer = null;

const roleText = {
  mafia: ['마피아', '밤에 시민 팀 한 명을 골라 공격하세요.'],
  citizen: ['시민', '대화와 추리를 통해 마피아를 찾아내세요.'],
  police: ['경찰', '밤마다 한 명을 조사해 마피아인지 확인할 수 있습니다.'],
  doctor: ['의사', '밤마다 한 명을 골라 마피아의 공격에서 살릴 수 있습니다.']
};
const phaseText = { lobby: '대기실', day: '낮 · 토론', vote: '투표', night: '밤 · 역할 행동', ended: '게임 종료' };

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 2600);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' })[c]);
}

function settingsFromInputs() {
  return {
    mafia: +$('mafiaCount').value,
    citizen: +$('citizenCount').value,
    police: +$('policeCount').value,
    doctor: +$('doctorCount').value,
    daySeconds: +$('daySeconds').value,
    voteSeconds: +$('voteSeconds').value,
    nightSeconds: +$('nightSeconds').value
  };
}

function roleTotal() {
  const s = settingsFromInputs();
  return s.mafia + s.citizen + s.police + s.doctor;
}

$('createRoomBtn').addEventListener('click', async () => {
  if (roleTotal() > 30) return toast('역할 수 합계는 30명을 넘을 수 없습니다.');
  const res = await fetch('/api/rooms', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settingsFromInputs())
  });
  const data = await res.json();
  if (!res.ok) return toast(data.error || '방 생성 실패');
  mode = 'host';
  roomCode = data.code;
  hostToken = data.hostToken;
  qrDataUrl = data.qrDataUrl;
  joinUrl = data.joinUrl;
  sessionStorage.setItem('mafiaHost', JSON.stringify({ roomCode, hostToken, qrDataUrl, joinUrl }));
  socket.emit('host:attach', { code: roomCode, hostToken }, r => {
    if (!r.ok) return toast(r.error);
    showHost();
  });
});

$('joinRoomBtn').addEventListener('click', () => {
  roomCode = $('roomCodeInput').value.trim().toUpperCase();
  const nickname = $('nicknameInput').value.trim();
  if (!roomCode || !nickname) return toast('방 번호와 닉네임을 입력하세요.');
  playerToken = localStorage.getItem(`mafiaPlayer:${roomCode}`);
  socket.emit('player:join', { code: roomCode, nickname, playerToken }, r => {
    if (!r.ok) return toast(r.error);
    mode = 'player';
    playerToken = r.playerToken;
    localStorage.setItem(`mafiaPlayer:${roomCode}`, playerToken);
    localStorage.setItem(`mafiaNick:${roomCode}`, nickname);
    showPlayer();
  });
});

function showHost() {
  $('landing').classList.add('hidden');
  $('playerView').classList.add('hidden');
  $('hostView').classList.remove('hidden');
  $('hostCode').textContent = roomCode;
  $('qrImage').src = qrDataUrl || '';
  $('joinUrl').value = joinUrl || `${location.origin}/?room=${roomCode}`;
}

function showPlayer() {
  $('landing').classList.add('hidden');
  $('hostView').classList.add('hidden');
  $('playerView').classList.remove('hidden');
  $('playerCode').textContent = roomCode;
}

$('copyUrlBtn').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('joinUrl').value);
  toast('입장 링크를 복사했습니다.');
});

$('startBtn').addEventListener('click', () => {
  socket.emit('host:start', { code: roomCode, hostToken }, r => { if (!r.ok) toast(r.error); });
});

$('nextBtn').addEventListener('click', () => {
  if (!lastState) return;
  const next = lastState.phase === 'day' ? 'vote' : lastState.phase === 'vote' ? 'night' : lastState.phase === 'night' ? 'day' : null;
  if (!next) return;
  socket.emit('host:forcePhase', { code: roomCode, hostToken, phase: next }, r => { if (!r.ok) toast(r.error); });
});

$('clearChatBtn').addEventListener('click', () => {
  socket.emit('host:clearChat', { code: roomCode, hostToken }, r => { if (!r.ok) toast(r.error); });
});

function sendChat() {
  const text = $('chatInput').value;
  if (!text.trim()) return;
  socket.emit('chat:send', { code: roomCode, playerToken, text }, r => {
    if (!r.ok) return toast(r.error);
    $('chatInput').value = '';
  });
}
$('sendChatBtn').addEventListener('click', sendChat);
$('chatInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

function renderStats(el, s) {
  const c = s.counts || {};
  const parts = [
    ['마피아', c.mafia ?? 0], ['시민', c.citizen ?? 0], ['경찰', c.police ?? 0], ['의사', c.doctor ?? 0], ['시민팀 전체', c.citizenTeam ?? 0]
  ];
  el.innerHTML = parts.map(([k,v]) => `<div class="stat">${k} <b>${v}</b></div>`).join('');
}

function renderPlayers(el, s, host = false) {
  el.innerHTML = s.players.map(p => `
    <div class="player-chip ${p.alive ? '' : 'dead'}">
      <strong>${esc(p.nickname)}${p.isMe ? ' · 나' : ''}</strong>
      <span class="meta">${p.alive ? '생존' : '탈락'} · ${p.connected ? '접속' : '연결 끊김'}${host && p.role ? ` · ${esc(roleText[p.role]?.[0] || p.role)}` : ''}</span>
    </div>`).join('');
}

function renderChat(el, s) {
  el.innerHTML = s.chat.map(m => `<div class="chat-msg"><b>${esc(m.nickname)}</b>${esc(m.text)}</div>`).join('') || '<div class="small">아직 채팅이 없습니다.</div>';
  el.scrollTop = el.scrollHeight;
}

function renderLog(el, s) {
  el.innerHTML = s.log.map(m => `<div class="log-item">${esc(m.text)}</div>`).join('') || '<div class="small">아직 기록이 없습니다.</div>';
  el.scrollTop = el.scrollHeight;
}

function updateCountdown() {
  clearInterval(countdownTimer);
  const render = () => {
    if (!lastState?.phaseEndsAt) {
      if (mode === 'host') $('hostTimer').textContent = '--:--';
      if (mode === 'player') $('playerTimer').textContent = '--:--';
      return;
    }
    const ms = Math.max(0, lastState.phaseEndsAt - Date.now());
    const sec = Math.ceil(ms / 1000);
    const txt = `${String(Math.floor(sec/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`;
    if (mode === 'host') $('hostTimer').textContent = txt;
    if (mode === 'player') $('playerTimer').textContent = txt;
  };
  render();
  countdownTimer = setInterval(render, 250);
}

function renderHost(s) {
  showHost();
  $('hostPhase').textContent = `${phaseText[s.phase]}${s.round ? ` · ${s.round}라운드` : ''}`;
  $('playerCount').textContent = `${s.playerCount}/${s.maxPlayers}`;
  renderStats($('hostCounts'), s);
  renderPlayers($('hostPlayers'), s, true);
  renderLog($('hostLog'), s);
  renderChat($('hostChat'), s);
  $('startBtn').classList.toggle('hidden', s.phase !== 'lobby');
  $('nextBtn').classList.toggle('hidden', !['day','vote','night'].includes(s.phase));
  $('nextBtn').textContent = s.phase === 'day' ? '투표로 이동' : s.phase === 'vote' ? '투표 즉시 마감' : '밤 즉시 마감';
  if (s.phase === 'lobby') {
    const expected = s.settings.mafia + s.settings.citizen + s.settings.police + s.settings.doctor;
    $('hostNotice').textContent = `설정된 역할 합계 ${expected}명 · 현재 접속 ${s.playerCount}명. 두 수가 같아야 시작할 수 있습니다.`;
  } else if (s.phase === 'ended') {
    $('hostNotice').innerHTML = `<span class="winner">${s.winner === 'mafia' ? '🕶️ 마피아 승리' : '🏫 시민 팀 승리'}</span>`;
  } else {
    $('hostNotice').textContent = '교사는 필요하면 타이머가 끝나기 전에 다음 단계로 진행할 수 있습니다.';
  }
}

function renderAction(s) {
  const card = $('actionCard');
  const me = s.me;
  if (!me || !me.alive) { card.classList.add('hidden'); return; }

  let title = '', help = '', filter = () => false, event = null;
  if (s.phase === 'vote') {
    title = '🗳️ 마피아라고 생각하는 사람을 지목하세요';
    help = '한 번 선택하면 같은 투표 시간 안에서는 다른 사람으로 다시 선택할 수 있습니다.';
    filter = p => p.alive && !p.isMe;
    event = 'vote:submit';
  } else if (s.phase === 'night' && ['mafia','police','doctor'].includes(me.role)) {
    if (me.role === 'mafia') {
      title = '🕶️ 마피아 행동'; help = '공격할 시민 팀 한 명을 고르세요. 같은 마피아는 대상에서 제외됩니다.'; filter = p => p.alive && p.role !== 'mafia';
    } else if (me.role === 'police') {
      title = '🔎 경찰 조사'; help = '한 명을 조사하면 다음 낮에 결과가 내 화면에 표시됩니다.'; filter = p => p.alive && !p.isMe;
    } else {
      title = '🩺 의사 보호'; help = '오늘 밤 살리고 싶은 한 명을 고르세요. 자기 자신도 선택할 수 있습니다.'; filter = p => p.alive;
    }
    event = 'night:action';
  } else {
    card.classList.add('hidden'); return;
  }

  card.classList.remove('hidden');
  $('actionTitle').textContent = title;
  $('actionHelp').textContent = help;
  const candidates = s.players.filter(filter);
  $('actionTargets').innerHTML = candidates.map(p => `<button class="target-btn" data-id="${p.id}">${esc(p.nickname)}</button>`).join('');
  [...$('actionTargets').querySelectorAll('button')].forEach(btn => btn.addEventListener('click', () => {
    const payload = { code: roomCode, playerToken, targetId: btn.dataset.id };
    socket.emit(event, payload, r => {
      if (!r.ok) return toast(r.error);
      toast('선택이 제출되었습니다.');
    });
  }));
}

function renderPlayer(s) {
  showPlayer();
  const me = s.me;
  $('playerName').textContent = me ? me.nickname : '학생';
  $('playerPhase').textContent = `${phaseText[s.phase]}${s.round ? ` · ${s.round}라운드` : ''}`;
  renderStats($('playerCounts'), s);
  renderPlayers($('playerList'), s, false);
  renderChat($('playerChat'), s);

  if (me?.role) {
    const [name, desc] = roleText[me.role];
    $('roleCard').classList.remove('hidden');
    $('roleCard').innerHTML = `<strong>${name}</strong><span>${desc}</span>`;
  } else {
    $('roleCard').classList.add('hidden');
  }

  if (s.phase === 'lobby') {
    $('playerNotice').textContent = '교사가 게임을 시작할 때까지 기다려 주세요.';
  } else if (!me?.alive) {
    $('playerNotice').innerHTML = '<span class="danger">현재 탈락 상태입니다. 다른 친구들의 플레이를 지켜보세요.</span>';
  } else if (s.phase === 'ended') {
    $('playerNotice').innerHTML = `<span class="winner">${s.winner === 'mafia' ? '🕶️ 마피아 승리' : '🏫 시민 팀 승리'}</span>`;
  } else if (me?.policeResult) {
    $('playerNotice').innerHTML = `🔎 ${esc(me.policeResult.targetNickname)} 조사 결과: <b>${me.policeResult.isMafia ? '마피아입니다.' : '마피아가 아닙니다.'}</b>`;
  } else {
    $('playerNotice').textContent = s.phase === 'day' ? '친구들과 이야기하며 마피아를 추리하세요.' : s.phase === 'vote' ? '투표를 제출하세요.' : s.phase === 'night' ? '역할이 있는 학생은 밤 행동을 선택하세요.' : '';
  }

  const canChat = me?.alive && ['lobby','day'].includes(s.phase);
  $('chatInput').disabled = !canChat;
  $('sendChatBtn').disabled = !canChat;
  renderAction(s);
}

socket.on('state', s => {
  lastState = s;
  if (!mode) mode = s.host ? 'host' : 'player';
  if (s.host) renderHost(s); else renderPlayer(s);
  updateCountdown();
});

socket.on('connect', () => {
  $('connectionBadge').textContent = '● 실시간 연결됨';
  const savedHost = JSON.parse(sessionStorage.getItem('mafiaHost') || 'null');
  if (savedHost?.roomCode && savedHost?.hostToken) {
    mode = 'host'; roomCode = savedHost.roomCode; hostToken = savedHost.hostToken; qrDataUrl = savedHost.qrDataUrl; joinUrl = savedHost.joinUrl;
    socket.emit('host:attach', { code: roomCode, hostToken }, r => { if (r.ok) showHost(); });
    return;
  }

  const params = new URLSearchParams(location.search);
  const code = (params.get('room') || '').toUpperCase();
  if (code) {
    $('roomCodeInput').value = code;
    const nick = localStorage.getItem(`mafiaNick:${code}`);
    const token = localStorage.getItem(`mafiaPlayer:${code}`);
    if (nick && token) {
      roomCode = code; playerToken = token;
      socket.emit('player:join', { code, nickname: nick, playerToken: token }, r => {
        if (r.ok) { mode = 'player'; playerToken = r.playerToken; showPlayer(); }
      });
    }
  }
});

socket.on('disconnect', () => {
  $('connectionBadge').textContent = '○ 연결 끊김';
});

(function initFromUrl() {
  const code = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
  if (code) $('roomCodeInput').value = code;
})();
