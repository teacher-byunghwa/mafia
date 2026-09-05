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
let lastPhase = null;
let audioCtx = null;
let lastEliminationNoticeId = null;
let eliminationOverlayVisible = false;
let eliminationAutoCloseTimer = null;
let pendingWinnerState = null;
let shownWinnerKey = null;
let lastNightOutcomeId = null;

const roleText = {
  mafia: ['마피아', '밤에 시민 팀 한 명을 골라 공격하세요.'],
  citizen: ['시민', '대화와 추리를 통해 마피아를 찾아내세요.'],
  police: ['경찰', '밤마다 한 명을 조사해 마피아인지 확인할 수 있습니다.'],
  doctor: ['의사', '밤마다 한 명을 골라 마피아의 공격에서 살릴 수 있습니다.']
};
const roleImage = {
  mafia: '/assets/mafia.svg',
  citizen: '/assets/citizen.svg',
  police: '/assets/police.svg',
  doctor: '/assets/doctor.svg'
};
const phaseText = {
  lobby: '대기실',
  reveal: '역할 확인',
  day: '낮 · 토론',
  vote: '투표',
  voteResult: '투표 결과',
  night: '밤 · 모두 선택',
  nightResult: '밤의 결과',
  ended: '게임 종료'
};

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 2600);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>\"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' })[c]);
}

function unlockAudio() {
  if (!audioCtx) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    audioCtx = new AudioContext();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
}

document.addEventListener('pointerdown', unlockAudio, { passive: true });
document.addEventListener('keydown', unlockAudio);

function tone(freq, start, duration, gain = 0.075) {
  if (!audioCtx || audioCtx.state !== 'running') return;
  const osc = audioCtx.createOscillator();
  const vol = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, start);
  vol.gain.setValueAtTime(0.0001, start);
  vol.gain.exponentialRampToValueAtTime(gain, start + 0.012);
  vol.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(vol);
  vol.connect(audioCtx.destination);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

function playDing(kind = 'transition') {
  unlockAudio();
  if (!audioCtx || audioCtx.state !== 'running') return;
  const now = audioCtx.currentTime + 0.01;
  if (kind === 'vote') {
    tone(988, now, 0.11, 0.065);
    tone(1319, now + 0.085, 0.14, 0.07);
  } else {
    tone(784, now, 0.13, 0.06);
    tone(1175, now + 0.10, 0.17, 0.07);
  }
}

function playEliminationSound() {
  unlockAudio();
  if (!audioCtx || audioCtx.state !== 'running') return;
  const now = audioCtx.currentTime + 0.01;
  // 짧고 과하게 무섭지 않은 하강음: 탈락 알림 전용.
  tone(659, now, 0.16, 0.075);
  tone(494, now + 0.13, 0.18, 0.08);
  tone(330, now + 0.28, 0.28, 0.085);
}

function playFanfare() {
  unlockAudio();
  if (!audioCtx || audioCtx.state !== 'running') return;
  const now = audioCtx.currentTime + 0.01;
  // "빰-빠-빰!" 느낌의 짧은 승리 팡파르.
  tone(523, now, 0.16, 0.075);
  tone(659, now + 0.14, 0.16, 0.08);
  tone(784, now + 0.28, 0.18, 0.085);
  tone(1047, now + 0.43, 0.42, 0.095);
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
  unlockAudio();
  socket.emit('host:start', { code: roomCode, hostToken }, r => { if (!r.ok) toast(r.error); });
});

$('nextBtn').addEventListener('click', () => {
  if (!lastState) return;

  if (lastState.phase === 'night') {
    const submitted = lastState.nightSummary?.submitted ?? 0;
    const required = lastState.nightSummary?.required ?? 0;
    const ok = confirm(
      `밤을 강제로 진행할까요?\n\n현재 ${submitted}/${required}명이 선택했습니다.\n미선택 학생의 행동은 없는 것으로 처리됩니다.`
    );
    if (!ok) return;
  }

  socket.emit('host:next', { code: roomCode, hostToken }, r => {
    if (!r.ok) toast(r.error);
  });
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
      const expiredNight = lastState?.phase === 'night' && lastState?.nightExpired;
      if (mode === 'host') $('hostTimer').textContent = expiredNight ? '00:00' : '--:--';
      if (mode === 'player') $('playerTimer').textContent = expiredNight ? '00:00' : '--:--';
      $('revealCountdown').textContent = '';
      $('voteResultCountdown').textContent = '';
      $('nightResultCountdown').textContent = '';
      return;
    }
    const ms = Math.max(0, lastState.phaseEndsAt - Date.now());
    const sec = Math.ceil(ms / 1000);
    const txt = `${String(Math.floor(sec/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`;
    if (mode === 'host') $('hostTimer').textContent = txt;
    if (mode === 'player') $('playerTimer').textContent = txt;
    if (lastState.phase === 'reveal') $('revealCountdown').textContent = `${sec}초 후 역할이 숨겨집니다`;
    if (lastState.phase === 'voteResult') $('voteResultCountdown').textContent = `${sec}초 후 다음 단계로 이동합니다`;
    if (lastState.phase === 'nightResult') $('nightResultCountdown').textContent = `${sec}초 후 다음 단계로 이동합니다`;
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
  $('nextBtn').classList.toggle('hidden', !['day','vote','voteResult','night','nightResult'].includes(s.phase));
  $('nextBtn').textContent = s.phase === 'day' ? '투표로 이동'
    : s.phase === 'vote' ? '투표 즉시 마감'
    : s.phase === 'voteResult' ? '투표 결과 즉시 마감'
    : s.phase === 'night' ? '밤 강제 진행'
    : '밤 결과 즉시 마감';

  if (s.phase === 'lobby') {
    const expected = s.settings.mafia + s.settings.citizen + s.settings.police + s.settings.doctor;
    $('hostNotice').textContent = `설정된 역할 합계 ${expected}명 · 현재 접속 ${s.playerCount}명. 두 수가 같아야 시작할 수 있습니다.`;
  } else if (s.phase === 'reveal') {
    $('hostNotice').textContent = '학생들이 15초 동안 자신의 역할을 확인하고 있습니다. 이 단계는 자동으로 끝납니다.';
  } else if (s.phase === 'night') {
    const submitted = s.nightSummary?.submitted ?? 0;
    const required = s.nightSummary?.required ?? 0;
    $('hostNotice').textContent = s.nightExpired
      ? `밤 시간이 끝났습니다. ${submitted}/${required}명 선택 완료. 기다리거나, 교사만 '밤 강제 진행'을 눌러 현재 제출된 행동만 반영할 수 있습니다.`
      : `밤 선택 ${submitted}/${required}명 완료. 원칙적으로 전원이 선택하면 자동 진행되며, 교사는 필요할 때만 '밤 강제 진행'을 사용할 수 있습니다.`;
  } else if (s.phase === 'nightResult') {
    $('hostNotice').textContent = '밤의 결과를 모두에게 공개하고 있습니다.';
  } else if (s.phase === 'ended') {
    $('hostNotice').innerHTML = `<span class="winner">${s.winner === 'mafia' ? '🕶️ 마피아 승리' : '🏫 시민 팀 승리'}</span>`;
  } else {
    $('hostNotice').textContent = '교사는 필요하면 타이머가 끝나기 전에 다음 단계로 진행할 수 있습니다.';
  }
}

function renderRoleReveal(s) {
  const overlay = $('roleRevealOverlay');
  const me = s.me;
  if (s.phase !== 'reveal' || !me?.role) {
    overlay.classList.add('hidden');
    return;
  }
  const [name, desc] = roleText[me.role];
  $('roleRevealImage').src = roleImage[me.role];
  $('roleRevealName').textContent = name;
  $('roleRevealDesc').textContent = desc;
  const team = $('mafiaTeamInfo');
  if (me.role === 'mafia') {
    const mates = me.mafiaTeammates || [];
    team.classList.remove('hidden');
    team.innerHTML = mates.length
      ? `<b>같은 마피아</b><br>${mates.map(esc).join(', ')}`
      : '<b>당신은 혼자 있는 마피아입니다.</b>';
  } else {
    team.classList.add('hidden');
    team.textContent = '';
  }
  overlay.classList.remove('hidden');
}

function renderVoteResult(s) {
  const overlay = $('voteResultOverlay');
  if (s.phase !== 'voteResult' || !s.voteResult) {
    overlay.classList.add('hidden');
    return;
  }
  const vr = s.voteResult;
  let headline = '';
  if (vr.noVotes) headline = '아무도 표를 받지 않았습니다.';
  else if (vr.tie) headline = '최다 득표가 동률입니다. 아무도 탈락하지 않습니다.';
  else headline = `${esc(vr.eliminatedNickname)} 학생이 가장 많은 표를 받았습니다.`;
  $('voteResultHeadline').innerHTML = headline;
  $('voteResultList').innerHTML = vr.results.length
    ? vr.results.map((r, idx) => `<div class="vote-result-row ${idx === 0 ? 'top' : ''}"><span>${esc(r.nickname)}</span><b>${r.votes}표</b></div>`).join('')
    : '<div class="vote-result-empty">제출된 투표가 없습니다.</div>';
  overlay.classList.remove('hidden');
}

function renderNightOutcome(s) {
  const overlay = $('nightResultOverlay');
  const outcome = s.nightOutcome;
  if (s.phase !== 'nightResult' || !outcome) {
    overlay.classList.add('hidden');
    return;
  }

  if (outcome.id && outcome.id !== lastNightOutcomeId) {
    lastNightOutcomeId = outcome.id;
    playDing('transition');
  }

  const roleBadge = $('nightResultRole');
  if (outcome.kind === 'eliminated') {
    $('nightResultSymbol').textContent = '🌙💥';
    $('nightResultTitle').textContent = `${outcome.nickname || '한 학생'} 탈락`;
    $('nightResultMessage').textContent = outcome.message || '밤에 한 학생이 탈락했습니다.';
    const roleName = roleText[outcome.role]?.[0] || outcome.role || '';
    roleBadge.textContent = roleName ? `역할: ${roleName}` : '';
    roleBadge.classList.toggle('hidden', !roleName);
  } else if (outcome.kind === 'saved') {
    $('nightResultSymbol').textContent = '🌙🩺';
    $('nightResultTitle').textContent = '의사가 구했습니다!';
    $('nightResultMessage').textContent = outcome.message || '마피아가 공격하려던 학생을 의사가 구했습니다.';
    roleBadge.classList.add('hidden');
    roleBadge.textContent = '';
  } else {
    $('nightResultSymbol').textContent = '🌙✨';
    $('nightResultTitle').textContent = '아무도 탈락하지 않았습니다';
    $('nightResultMessage').textContent = outcome.message || '조용한 밤이 지나갔습니다.';
    roleBadge.classList.add('hidden');
    roleBadge.textContent = '';
  }

  overlay.classList.remove('hidden');
}

function closeEliminationOverlay() {
  clearTimeout(eliminationAutoCloseTimer);
  eliminationAutoCloseTimer = null;
  $('eliminationOverlay').classList.add('hidden');
  eliminationOverlayVisible = false;
  if (pendingWinnerState) {
    const queued = pendingWinnerState;
    pendingWinnerState = null;
    showWinnerOverlay(queued);
  }
}

function renderEliminationNotice(s) {
  if (s.host || !s.me?.eliminationNotice) return;
  const notice = s.me.eliminationNotice;
  if (!notice.id || notice.id === lastEliminationNoticeId) return;

  lastEliminationNoticeId = notice.id;
  eliminationOverlayVisible = true;
  $('eliminationTitle').textContent = '탈락했습니다!';
  $('eliminationMessage').textContent = notice.message || '마피아의 공격을 받아 탈락했습니다.';
  $('eliminationOverlay').classList.remove('hidden');
  playEliminationSound();

  // 수업 흐름을 가리지 않도록 잠시 후 자동으로 닫히며, 학생이 직접 닫을 수도 있다.
  clearTimeout(eliminationAutoCloseTimer);
  eliminationAutoCloseTimer = setTimeout(closeEliminationOverlay, 3800);
}

function showWinnerOverlay(s) {
  if (!s?.winner || s.phase !== 'ended') return;
  const key = `${s.code}:${s.winner}`;
  if (shownWinnerKey === key) return;
  shownWinnerKey = key;

  const mafiaWon = s.winner === 'mafia';
  $('winnerSymbol').textContent = mafiaWon ? '🕶️🎉' : '🏫🎉';
  $('winnerTitle').textContent = mafiaWon ? '마피아 승리!' : '시민 팀 승리!';
  $('winnerMessage').textContent = mafiaWon
    ? '마피아가 승리 조건을 달성했습니다.'
    : '모든 마피아를 찾아냈습니다. 시민 팀이 승리했습니다!';
  $('winnerOverlay').classList.remove('hidden');
  playFanfare();
}

function renderWinnerOverlay(s) {
  if (s.phase !== 'ended' || !s.winner) return;
  // 바로 직전에 마피아에게 탈락한 학생은 먼저 자신의 탈락 팝업을 잠깐 본 뒤 승리 팝업을 본다.
  if (eliminationOverlayVisible) {
    pendingWinnerState = s;
    return;
  }
  showWinnerOverlay(s);
}

$('dismissEliminationBtn').addEventListener('click', closeEliminationOverlay);
$('dismissWinnerBtn').addEventListener('click', () => $('winnerOverlay').classList.add('hidden'));

function renderAction(s) {
  const card = $('actionCard');
  const me = s.me;
  const action = s.action;
  if (!me || !me.alive || !action) {
    card.classList.add('hidden');
    return;
  }

  let title = '', help = '', event = null;
  if (action.type === 'vote') {
    title = '🗳️ 마피아라고 생각하는 사람을 지목하세요';
    help = '한 번 선택한 뒤에도 투표 시간이 끝나기 전까지 다른 사람으로 바꿀 수 있습니다.';
    event = 'vote:submit';
  } else if (action.type === 'night') {
    title = '🌙 밤 선택 · 한 명을 고르세요';
    help = action.submitted
      ? '선택 완료! 다른 사람으로 바꾸고 싶으면 다시 누를 수 있습니다. 생존자 전원이 선택하면 자동으로 다음 단계로 넘어갑니다.'
      : '살아 있는 모든 학생이 한 명씩 선택해야 합니다. 타이머가 0초가 되어도 선택 화면은 사라지지 않습니다.';
    event = 'night:action';
  } else {
    card.classList.add('hidden');
    return;
  }

  card.classList.remove('hidden');
  $('actionTitle').textContent = title;
  $('actionHelp').textContent = help;
  $('actionTargets').innerHTML = action.targets.map(p => {
    const selected = action.selectedTargetId === p.id ? ' selected' : '';
    return `<button class="target-btn${selected}" data-id="${p.id}">${esc(p.nickname)}${p.isMe ? ' · 나' : ''}</button>`;
  }).join('');

  [...$('actionTargets').querySelectorAll('button')].forEach(btn => btn.addEventListener('click', () => {
    const payload = { code: roomCode, playerToken, targetId: btn.dataset.id };
    socket.emit(event, payload, r => {
      if (!r.ok) return toast(r.error);
      if (action.type === 'vote') playDing('vote');
      else playDing('vote');
      toast(action.type === 'vote' ? '투표가 제출되었습니다.' : '밤 선택이 완료되었습니다.');
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

  // 평상시에는 역할 카드를 완전히 숨긴다. 역할은 시작 직후 15초 오버레이에서만 공개된다.
  $('roleCard').classList.add('hidden');
  renderRoleReveal(s);
  renderVoteResult(s);

  if (s.phase === 'lobby') {
    $('playerNotice').textContent = '교사가 게임을 시작할 때까지 기다려 주세요.';
  } else if (s.phase === 'reveal') {
    $('playerNotice').textContent = '자신의 역할을 조용히 확인하세요.';
  } else if (!me?.alive) {
    $('playerNotice').innerHTML = '<span class="danger">현재 탈락 상태입니다. 다른 친구들의 플레이를 지켜보세요.</span>';
  } else if (s.phase === 'ended') {
    $('playerNotice').innerHTML = `<span class="winner">${s.winner === 'mafia' ? '🕶️ 마피아 승리' : '🏫 시민 팀 승리'}</span>`;
  } else if (me?.policeResult) {
    $('playerNotice').innerHTML = `🔎 ${esc(me.policeResult.targetNickname)} 조사 결과: <b>${me.policeResult.isMafia ? '마피아입니다.' : '마피아가 아닙니다.'}</b>`;
  } else if (s.phase === 'voteResult') {
    $('playerNotice').textContent = '투표 결과를 확인하세요.';
  } else if (s.phase === 'nightResult') {
    $('playerNotice').textContent = '밤의 결과를 확인하세요.';
  } else {
    $('playerNotice').textContent = s.phase === 'day' ? '친구들과 이야기하며 마피아를 추리하세요.'
      : s.phase === 'vote' ? '투표를 제출하세요.'
      : s.phase === 'night'
        ? (s.nightExpired
            ? (s.action?.submitted ? '시간이 끝났습니다. 아직 선택하지 않은 친구가 완료할 때까지 기다리세요.' : '시간이 끝났지만 선택할 수 있습니다. 반드시 한 명을 선택하세요.')
            : '모든 생존 학생이 한 명을 선택해야 다음 라운드로 넘어갑니다.')
        : '';
  }

  const canChat = me?.alive && ['lobby','day'].includes(s.phase);
  $('chatInput').disabled = !canChat;
  $('sendChatBtn').disabled = !canChat;
  renderAction(s);
}

socket.on('state', s => {
  const previousPhase = lastPhase;
  lastState = s;
  lastPhase = s.phase;
  if (!mode) mode = s.host ? 'host' : 'player';

  if (previousPhase && previousPhase !== s.phase) playDing('transition');

  if (s.host) {
    renderHost(s);
    renderVoteResult(s);
    renderNightOutcome(s);
    $('roleRevealOverlay').classList.add('hidden');
  } else {
    renderPlayer(s);
    renderNightOutcome(s);
    renderEliminationNotice(s);
  }
  renderWinnerOverlay(s);
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
