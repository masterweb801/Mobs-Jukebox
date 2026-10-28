'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const WebSocket = require('ws');

// ---------------- Configuration ----------------
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const MUSIC_DIR = path.resolve(process.env.MUSIC_DIR || __dirname);
// Set JUKEBOX_CONTROL_TOKEN to a long random value to require it for controls.
// If unset, anyone who can reach the server can control playback (LAN testing only).
const CONTROL_TOKEN = process.env.JUKEBOX_CONTROL_TOKEN || '';
const PREPARE_TIMEOUT_MS = 15000;
const START_LEAD_MS = 2500;
const MAX_WS_PAYLOAD = 16 * 1024;
const MAX_CONNECTIONS = 100;
const ALLOWED_ORIGINS = (process.env.JUKEBOX_ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const sessions = new Map(); // ws -> { id, isController }
let playback = {
  seq: 0,
  songFile: null,
  state: 'stopped', // stopped | preparing | scheduled | playing | paused | error
  position: 0,
  startedAt: null, // server epoch ms when position 0 started
  targetTime: null,
  readyCount: 0,
  message: null
};
let prepareTimer = null;

function listSongs() {
  try {
    return fs.readdirSync(MUSIC_DIR, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.mp3'))
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    console.error('Unable to list music directory:', err.message);
    return [];
  }
}

function isSafeSongName(name) {
  return typeof name === 'string' && name.length > 0 &&
    name.length <= 255 && name === path.basename(name) &&
    name.toLowerCase().endsWith('.mp3') && !name.includes('\0');
}

function getSongPath(name) {
  if (!isSafeSongName(name)) return null;
  const root = path.resolve(MUSIC_DIR);
  const candidate = path.resolve(root, name);
  if (path.dirname(candidate) !== root) return null;
  return candidate;
}

function currentPosition(now = Date.now()) {
  if (playback.state === 'scheduled' && playback.targetTime != null) {
    return now < playback.targetTime ? Math.max(0, playback.position) : Math.max(0, playback.position + (now - playback.targetTime) / 1000);
  }
  if (playback.state === 'playing' && playback.startedAt != null) {
    return Math.max(0, playback.position + (now - playback.startedAt) / 1000);
  }
  return Math.max(0, playback.position || 0);
}

function publicState() {
  return {
    type: 'STATE',
    seq: playback.seq,
    songFile: playback.songFile,
    state: playback.state,
    position: currentPosition(),
    serverTime: Date.now(),
    targetTime: playback.targetTime,
    message: playback.message
  };
}

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function broadcast(data, predicate = () => true) {
  for (const [client] of sessions) if (predicate(client)) send(client, data);
}

function setStopped(message = null) {
  if (prepareTimer) clearTimeout(prepareTimer);
  prepareTimer = null;
  playback = {
    seq: playback.seq + 1,
    songFile: null,
    state: 'stopped',
    position: 0,
    startedAt: null,
    targetTime: null,
    readyCount: 0,
    message
  };
  broadcast(publicState());
}

function beginPrepare(songFile) {
  if (!listSongs().includes(songFile)) return false;
  if (prepareTimer) clearTimeout(prepareTimer);
  const seq = playback.seq + 1;
  playback = {
    seq, songFile, state: 'preparing', position: 0,
    startedAt: null, targetTime: null, readyCount: 0, message: null
  };
  for (const [client, info] of sessions) info.readySeq = null;
  broadcast({ type: 'PREPARE', seq, songFile, serverTime: Date.now() });

  // Don't wait forever for disconnected/slow devices. Ready devices start;
  // late devices catch up from the authoritative state when they finish loading.
  prepareTimer = setTimeout(() => scheduleStart(seq), PREPARE_TIMEOUT_MS);
  if (sessions.size === 0) scheduleStart(seq);
  return true;
}

function scheduleStart(seq) {
  if (playback.seq !== seq || playback.state !== 'preparing') return;
  if (prepareTimer) clearTimeout(prepareTimer);
  prepareTimer = null;

  const readyClients = [...sessions.entries()].filter(([, info]) => info.readySeq === seq).map(([ws]) => ws);
  if (readyClients.length === 0 && sessions.size > 0) {
    // On iOS, a device may need a real user tap to unlock audible playback.
    // Keep the session preparing instead of failing while every device waits
    // for that tap; a later READY message will schedule playback.
    playback.state = 'preparing';
    playback.message = 'Waiting for devices to enable audio.';
    broadcast(publicState());
    prepareTimer = setTimeout(() => scheduleStart(seq), PREPARE_TIMEOUT_MS);
    return;
  }

  playback.state = 'scheduled';
  playback.position = 0;
  playback.targetTime = Date.now() + START_LEAD_MS;
  playback.startedAt = playback.targetTime;
  broadcast({ type: 'START_AT', seq, songFile: playback.songFile, targetTime: playback.targetTime },
    ws => readyClients.includes(ws));
  broadcast(publicState());
}

function pausePlayback() {
  if (playback.state !== 'playing' && playback.state !== 'scheduled') return;
  playback.position = currentPosition();
  playback.state = 'paused';
  playback.startedAt = null;
  playback.targetTime = null;
  playback.seq += 1;
  broadcast({ type: 'CANCEL', seq: playback.seq });
  broadcast(publicState());
}

function resumePlayback() {
  if (playback.state !== 'paused' || !playback.songFile) return;
  playback.seq += 1;
  playback.state = 'scheduled';
  playback.targetTime = Date.now() + START_LEAD_MS;
  playback.startedAt = playback.targetTime - playback.position * 1000;
  broadcast({
    type: 'RESUME_AT', seq: playback.seq, songFile: playback.songFile,
    position: playback.position, targetTime: playback.targetTime
  });
  broadcast(publicState());
}

function seekPlayback(position) {
  if (!Number.isFinite(position) || position < 0 || !playback.songFile) return;
  playback.position = position;
  playback.seq += 1;
  if (playback.state === 'playing' || playback.state === 'scheduled') {
    playback.state = 'scheduled';
    playback.targetTime = Date.now() + START_LEAD_MS;
    playback.startedAt = playback.targetTime - position * 1000;
    broadcast({ type: 'RESUME_AT', seq: playback.seq, songFile: playback.songFile,
      position, targetTime: playback.targetTime });
  } else {
    playback.startedAt = null;
    playback.targetTime = null;
  }
  broadcast(publicState());
}

function serveFile(req, res, filePath, contentType) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end('File not found.');
    }

    const range = req.headers.range;
    const headers = {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    };

    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        return res.end();
      }
      let start, end;
      if (!match[1]) {
        const suffix = Number(match[2]);
        start = Math.max(0, stat.size - suffix);
        end = stat.size - 1;
      } else {
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : stat.size - 1;
      }
      if (start >= stat.size || end < start) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        return res.end();
      }
      end = Math.min(end, stat.size - 1);
      res.writeHead(206, { ...headers, 'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${stat.size}` });
      const stream = fs.createReadStream(filePath, { start, end });
      stream.on('error', () => res.destroy());
      res.on('close', () => { if (!res.writableEnded) stream.destroy(); });
      return stream.pipe(res);
    }

    res.writeHead(200, { ...headers, 'Content-Length': stat.size });
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => res.destroy());
    res.on('close', () => { if (!res.writableEnded) stream.destroy(); });
    stream.pipe(res);
  });
}

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mobs Jukebox</title>
<style>
:root{color-scheme:dark;--green:#1db954;--panel:#181818;--line:#303030;--muted:#aaa}*{box-sizing:border-box}body{margin:0;padding:24px 16px;min-height:100vh;background:#121212;color:#fff;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;justify-content:center}.app{width:100%;max-width:440px}.card{background:var(--panel);border:1px solid #292929;border-radius:18px;padding:22px;margin-bottom:16px;box-shadow:0 8px 24px #0003}.art{height:120px;border-radius:12px;background:linear-gradient(135deg,#282828,#1db954);display:grid;place-items:center;font-size:42px;margin-bottom:18px}.title{font-weight:700;overflow-wrap:anywhere}.muted{color:var(--muted);font-size:13px}.status{margin-top:8px}.controls{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:18px}.icon-btn{width:46px;height:46px;border:1px solid #444;border-radius:50%;background:#303030;color:#fff;display:grid;place-items:center;cursor:pointer;transition:transform .12s,background .12s}.icon-btn svg{width:20px;height:20px;fill:currentColor}.icon-btn.primary{width:54px;height:54px;background:var(--green);border-color:var(--green);color:#000}.icon-btn:hover{background:#444}.icon-btn.primary:hover{background:#27ce63}.icon-btn:active{transform:scale(.95)}.icon-btn:disabled{opacity:.4;cursor:not-allowed}.ios-retry{display:none;width:100%;margin-top:12px;padding:12px;border:0;border-radius:10px;background:#f4c542;color:#111;font-weight:700;cursor:pointer}.ios-retry.visible{display:block}.enable-audio{display:none;width:100%;margin-top:12px;padding:12px;border:0;border-radius:10px;background:#1db954;color:#071b0e;font-weight:700;cursor:pointer}.enable-audio.visible{display:block}.time-row{display:flex;justify-content:space-between;gap:12px;margin-top:12px;font-variant-numeric:tabular-nums}.seek{width:100%;margin:8px 0 0;accent-color:var(--green);cursor:pointer}.seek:disabled{opacity:.45;cursor:not-allowed}.btn{border:0;border-radius:999px;background:var(--green);color:#000;padding:12px 20px;font-weight:700;cursor:pointer}.btn.secondary{background:#333;color:#fff}.btn:disabled{opacity:.45;cursor:not-allowed}input[type=text],input[type=password]{width:100%;padding:12px;border:1px solid #444;border-radius:8px;background:#292929;color:#fff;margin:8px 0 12px}#songs{max-height:260px;overflow:auto}.song{padding:12px;border-bottom:1px solid #292929;cursor:pointer;overflow-wrap:anywhere}.song:hover,.song.selected{background:#2a2a2a}.song.selected{border-left:3px solid var(--green)}.progress{height:5px;background:#333;border-radius:9px;overflow:hidden;margin-top:15px}.bar{height:100%;width:0;background:var(--green)}.hidden{display:none}.row{display:flex;gap:8px;align-items:center}.row>*{min-width:0}.row input{flex:1}.small{font-size:12px;color:var(--muted)}
</style></head><body><main class="app">
<div class="card"><div class="art">🎵</div><div class="title" id="track">No track selected</div><div class="muted status" id="state">Connecting…</div><div class="progress hidden" id="progress" aria-label="Loading progress"><div class="bar" id="bar"></div></div><div class="time-row small"><span id="currentTime">0:00</span><span id="duration">0:00</span></div><input class="seek" id="seek" type="range" min="0" max="1000" value="0" step="1" aria-label="Song progress" disabled><div class="controls"><button class="icon-btn primary" id="play" type="button" aria-label="Play song" title="Play"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg></button><button class="icon-btn" id="pause" type="button" aria-label="Pause playback" title="Pause"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg></button><button class="icon-btn" id="resume" type="button" aria-label="Resume playback" title="Resume"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5V1L7 6l5 5V7a5 5 0 0 1 5 5 5 5 0 0 1-8.66 3.54l-1.42 1.42A7 7 0 0 0 19 12a7 7 0 0 0-7-7z"/></svg></button><button class="icon-btn" id="stop" type="button" aria-label="Stop playback" title="Stop"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6h12v12H6z"/></svg></button></div><p class="small" id="connection">Connecting to server…</p><button class="enable-audio" id="enableAudio" type="button">Enable audio on this device</button><button class="ios-retry" id="iosRetry" type="button">Tap to start audio on this device</button><p class="small" id="audioHelp">On iPhone/iPad, tap Enable Audio when a song is loading. Each device needs to enable audio once per page session.</p></div>
<div class="card"><strong>Music library</strong><input id="search" type="text" placeholder="Search songs…" autocomplete="off"><div id="songs">Loading songs…</div></div>
<div class="card"><strong>Controller access</strong><p class="muted">If the server administrator configured a control token, enter it here. Leave blank for an open LAN test server.</p><div class="row"><input id="token" type="password" placeholder="Controller token" autocomplete="off"><button class="btn secondary" id="saveToken">Save</button></div><p class="small">Token is kept only in this tab's session storage.</p></div>
<audio id="audio" preload="auto"></audio>
</main><script>
'use strict';
const $=id=>document.getElementById(id);
const audio=$('audio');let ws=null,allSongs=[],selectedSong=null,session=null,clockOffset=0,clockUncertainty=Infinity,seq=0,prepareAbort=null,countdownTimer=null,reconnectTimer=null,reconnectDelay=1000,lastPing=null,preparedSeq=null,audioUnlocked=false,readySentSeq=null;
$('token').value=sessionStorage.getItem('jukeboxToken')||'';
let seeking=false;
function formatTime(value){if(!Number.isFinite(value)||value<0)return '0:00';const seconds=Math.floor(value);const hours=Math.floor(seconds/3600);const minutes=Math.floor((seconds%3600)/60);const rest=String(seconds%60).padStart(2,'0');return hours?hours+':'+String(minutes).padStart(2,'0')+':'+rest:minutes+':'+rest}
function updateProgress(){const duration=audio.duration;const current=Number.isFinite(audio.currentTime)?audio.currentTime:0;$('currentTime').textContent=formatTime(current);$('duration').textContent=formatTime(duration);const valid=Number.isFinite(duration)&&duration>0;$('seek').disabled=!valid;$('seek').max=valid?Math.round(duration*10):1000;if(!seeking)$('seek').value=valid?Math.min(Number($('seek').max),Math.round(current*10)):0}
function token(){return $('token').value.trim()}
function send(data){if(ws&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({...data,token:token()}));else setState('Disconnected — reconnecting…')}
function setState(text){$('state').textContent=text}
function setConnection(text){$('connection').textContent=text}
function serverNow(){return Date.now()+clockOffset}
function cancelPending(){if(countdownTimer!==null)clearTimeout(countdownTimer);countdownTimer=null;if(prepareAbort){prepareAbort.abort();prepareAbort=null}}
function renderSongs(){const term=$('search').value.toLowerCase();const matches=allSongs.filter(s=>s.toLowerCase().includes(term));const box=$('songs');box.replaceChildren();if(!matches.length){box.textContent=allSongs.length?'No matching songs.':'No MP3 files found.';return}for(const song of matches){const item=document.createElement('div');item.className='song'+(selectedSong===song?' selected':'');item.textContent=song;item.tabIndex=0;const choose=()=>{selectedSong=song;renderSongs()};item.addEventListener('click',choose);item.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();choose()}});box.appendChild(item)}}
async function loadSongs(){try{const r=await fetch('/songs',{cache:'no-store'});if(!r.ok)throw Error('HTTP '+r.status);allSongs=await r.json();renderSongs()}catch(e){$('songs').textContent='Could not load songs. Refresh to retry.'}}
function syncClock(){if(!ws||ws.readyState!==WebSocket.OPEN)return;lastPing={sent:performance.now(),wall:Date.now()};send({type:'PING',clientWall:lastPing.wall,clientMono:lastPing.sent})}
function connect(){if(ws&&[WebSocket.OPEN,WebSocket.CONNECTING].includes(ws.readyState))return;const scheme=location.protocol==='https:'?'wss:':'ws:';ws=new WebSocket(scheme+'//'+location.host);ws.onopen=()=>{reconnectDelay=1000;setConnection('Connected');syncClock();send({type:'GET_STATE'})};ws.onmessage=async ev=>{let d;try{d=JSON.parse(ev.data)}catch{return}if(d.type==='PONG'){const received=performance.now();if(lastPing){const rtt=received-lastPing.sent;const estimate=d.serverTime-(lastPing.wall+rtt/2);if(rtt<clockUncertainty||!Number.isFinite(clockUncertainty)){clockOffset=estimate;clockUncertainty=rtt}}return}if(d.type==='PREPARE'){await prepareSong(d);return}if(d.type==='START_AT'){scheduleStart(d,false);return}if(d.type==='RESUME_AT'){scheduleStart(d,true);return}if(d.type==='CANCEL'){seq=Math.max(seq,d.seq);cancelPending();return}if(d.type==='STATE'){applyState(d);return}if(d.type==='ERROR'){setState(d.message||'Command failed');return}};ws.onerror=()=>setConnection('Connection error');ws.onclose=()=>{setConnection('Disconnected — reconnecting…');cancelPending();clearTimeout(reconnectTimer);reconnectTimer=setTimeout(connect,reconnectDelay);reconnectDelay=Math.min(reconnectDelay*2,15000)}}
async function prepareSong(d){
  if(d.seq<seq)return;
  seq=d.seq;preparedSeq=null;readySentSeq=null;cancelPending();
  $('enableAudio').classList.remove('visible');
  setState('Loading '+d.songFile+'…');
  $('track').textContent=d.songFile;
  $('progress').classList.remove('hidden');$('bar').style.width='10%';
  try{
    // Stream the MP3 directly. Fetching the entire song into a Blob is memory-heavy
    // on iPhones and can make long tracks fail before playback begins.
    audio.pause();
    audio.src='/stream?file='+encodeURIComponent(d.songFile);
    const ready=waitForCanPlay(d.seq); // attach listeners before load() to avoid a canplay race
    audio.load();
    await ready;
    if(d.seq!==seq)return;
    $('bar').style.width='100%';
    preparedSeq=d.seq;
    if(audioUnlocked){
      readySentSeq=d.seq;
      send({type:'READY',seq:d.seq});
      $('enableAudio').classList.remove('visible');
      setState('Ready — waiting for synchronized start');
    }else{
      // Do not tell the server this device is ready until the user has made a
      // direct gesture that Safari accepts for this audio element.
      $('enableAudio').classList.add('visible');
      setState('Tap Enable Audio to join synchronized playback');
    }
  }catch(e){
    if(e.name==='AbortError')return;
    setState('Could not load song: '+e.message);
    send({type:'NOT_READY',seq:d.seq,reason:String(e.message).slice(0,200)});
  }
}
function waitForCanPlay(expectedSeq){
  return new Promise((resolve,reject)=>{
    let done=false;
    const clean=()=>{audio.removeEventListener('canplay',ok);audio.removeEventListener('error',bad);clearTimeout(timer)};
    const finish=(fn,v)=>{if(done)return;done=true;clean();fn(v)};
    const ok=()=>finish(resolve);
    const bad=()=>finish(reject,Error('Safari could not decode this MP3. Try a standard MP3 encoded as 44.1 kHz, 128–192 kbps.'));
    const timer=setTimeout(()=>finish(reject,Error('Timed out waiting for audio readiness')),20000);
    audio.addEventListener('canplay',ok);
    audio.addEventListener('error',bad);
    if(expectedSeq!==seq)finish(reject,Error('Superseded'));
    else if(audio.readyState>=HTMLMediaElement.HAVE_FUTURE_DATA)finish(resolve);
  });
}
function desiredPosition(){
  if(!session)return 0;
  if(session.state==='scheduled'&&Number.isFinite(session.targetTime))
    return Math.max(0,(session.position||0)+Math.max(0,serverNow()-session.targetTime)/1000);
  if(session.state==='playing')
    return Math.max(0,(session.position||0)+Math.max(0,serverNow()-(session.serverTime||serverNow()))/1000);
  return Math.max(0,Number(session.position)||0);
}
function enableAudioFromGesture(){
  if(!audio.src || preparedSeq!==seq){
    setState('Audio will be ready to enable when a song has loaded');
    return;
  }
  // This play() call is made directly from the button's click handler and uses
  // the actual prepared song on the same media element used for playback.
  // That is materially more reliable on iOS than waiting for a future timer.
  const previousTime=Number.isFinite(audio.currentTime)?audio.currentTime:0;
  let promise;
  try{promise=audio.play()}catch(e){setState('Safari could not enable audio: '+(e.name||e.message));return}
  if(!promise||typeof promise.then!=='function'){
    audio.pause();
    audioUnlocked=true;
    finishAudioUnlock(previousTime);
    return;
  }
  promise.then(()=>{
    audio.pause();
    try{audio.currentTime=previousTime}catch{}
    audioUnlocked=true;
    finishAudioUnlock(previousTime);
  }).catch(e=>{
    $('enableAudio').classList.add('visible');
    setState('Audio permission was not granted ('+(e.name||'playback error')+'). Tap Enable Audio again.');
  });
}
function finishAudioUnlock(previousTime){
  $('enableAudio').classList.remove('visible');
  $('iosRetry').classList.remove('visible');
  if(preparedSeq===seq && readySentSeq!==preparedSeq){
    readySentSeq=preparedSeq;
    send({type:'READY',seq:preparedSeq});
    setState('Audio enabled — waiting for synchronized start');
  }else if(session&&session.state==='paused'){
    setState('Audio enabled — paused');
  }else{
    setState('Audio enabled on this device');
  }
}
function retryAudioFromGesture(){
  if(!audio.src){setState('Select a song and press Play first');return;}
  // Crucially, call play() synchronously inside this actual tap handler. Do not
  // await a fetch/timer before calling it: iOS Safari can reject scripted playback.
  try{audio.currentTime=desiredPosition()}catch{}
  const promise=audio.play();
  if(promise&&typeof promise.then==='function'){
    promise.then(()=>{
      $('iosRetry').classList.remove('visible');
      setState('Playing on this device');
      $('progress').classList.add('hidden');
    }).catch(e=>setState('Safari still blocked playback ('+(e.name||'play error')+'). Tap the button again or check Silent Mode/volume.'));
  }else{
    $('iosRetry').classList.remove('visible');setState('Playing on this device');
  }
}
$('iosRetry').addEventListener('click',retryAudioFromGesture);$('enableAudio').addEventListener('click',enableAudioFromGesture);
function scheduleStart(d,resume){if(d.seq<seq)return;seq=d.seq;cancelPending();if(!audio.src){setState('Audio is not loaded on this device');return}if(resume&&Number.isFinite(d.position))audio.currentTime=d.position;const tick=async()=>{if(d.seq!==seq)return;const delay=d.targetTime-serverNow();if(delay>30){countdownTimer=setTimeout(tick,Math.min(100,delay-20));return}if(delay>0){countdownTimer=setTimeout(tick,delay);return}try{await audio.play();if(d.seq!==seq){audio.pause();return}$('progress').classList.add('hidden');setState('Playing');}catch(e){$('iosRetry').classList.add('visible');setState('Playback blocked ('+(e.name||'play error')+') — tap the yellow button');send({type:'CLIENT_ERROR',seq:d.seq,reason:(e.name||'play() rejected')+': '+String(e.message||'')})}};setState(resume?'Resuming…':'Starting…');$('progress').classList.remove('hidden');$('bar').style.width='100%';tick()}
function applyState(d){if(d.seq<seq)return;seq=d.seq;session=d;if(d.songFile)$('track').textContent=d.songFile;else if(d.state==='stopped')$('track').textContent='No track selected';if(d.state==='playing'||d.state==='scheduled'){if(d.state==='playing'&&audio.src&&audio.paused){const desired=d.position;if(Number.isFinite(desired)&&Math.abs(audio.currentTime-desired)>1)audio.currentTime=desired;}setState(d.state==='scheduled'?'Scheduled to play':'Playing')}else if(d.state==='paused'){cancelPending();audio.pause();if(audio.src&&Number.isFinite(d.position)){try{audio.currentTime=d.position}catch{}}setState('Paused')}else if(d.state==='preparing'){if(d.message)setState(d.message);else if(preparedSeq!==d.seq)setState('Preparing song…');}else if(d.state==='error')setState(d.message||'Playback error');else if(d.state==='stopped'){cancelPending();audio.pause();setState(d.message||'Stopped')}updateProgress()}
$('play').addEventListener('click',()=>{if(!selectedSong){setState('Select a song first');return}send({type:'PLAY',songFile:selectedSong})});$('pause').addEventListener('click',()=>send({type:'PAUSE'}));$('resume').addEventListener('click',()=>send({type:'RESUME'}));$('stop').addEventListener('click',()=>send({type:'STOP'}));$('seek').addEventListener('input',()=>{seeking=true;const value=Number($('seek').value)/10;$('currentTime').textContent=formatTime(value)});$('seek').addEventListener('change',()=>{const position=Number($('seek').value)/10;seeking=false;if(Number.isFinite(audio.duration)&&audio.duration>0)send({type:'SEEK',position:Math.min(position,audio.duration)});updateProgress()});$('search').addEventListener('input',renderSongs);$('saveToken').addEventListener('click',()=>{sessionStorage.setItem('jukeboxToken',token());setState('Controller token saved for this tab');if(ws&&ws.readyState===WebSocket.OPEN)send({type:'GET_STATE'})});audio.addEventListener('loadedmetadata',updateProgress);audio.addEventListener('durationchange',updateProgress);audio.addEventListener('timeupdate',updateProgress);audio.addEventListener('playing',()=>{if(session&&session.state!=='paused')setState('Playing')});audio.addEventListener('ended',()=>{updateProgress();if(session&&session.state==='playing')send({type:'ENDED',seq})});audio.addEventListener('error',()=>{if(audio.src){const err=audio.error;setState('Audio playback error'+(err?' (code '+err.code+')':''));$('iosRetry').classList.add('visible')}});document.addEventListener('visibilitychange',()=>{if(!document.hidden&&ws&&ws.readyState===WebSocket.OPEN)syncClock()});
loadSongs();connect();setInterval(syncClock,15000);
</script></body></html>`;

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch { res.writeHead(400); return res.end('Bad request'); }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end('Method not allowed');
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' ws: wss:; media-src 'self' blob:; img-src 'self' data:", 'X-Content-Type-Options': 'nosniff' });
    return res.end(req.method === 'HEAD' ? undefined : html);
  }
  if (url.pathname === '/songs') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    return res.end(req.method === 'HEAD' ? undefined : JSON.stringify(listSongs()));
  }
  if (url.pathname === '/stream') {
    const name = url.searchParams.get('file');
    const filePath = getSongPath(name);
    if (!filePath || !listSongs().includes(name)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end('Song not found.');
    }
    if (req.method === 'HEAD') {
      fs.stat(filePath, (err, stat) => {
        if (err || !stat.isFile()) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
        res.end();
      });
      return;
    }
    return serveFile(req, res, filePath, 'audio/mpeg');
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found');
});

const wss = new WebSocket.Server({
  server,
  maxPayload: MAX_WS_PAYLOAD,
  verifyClient: (info, done) => {
    if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(info.origin)) return done(false, 403, 'Origin not allowed');
    done(true);
  }
});

wss.on('connection', (ws, req) => {
  if (sessions.size >= MAX_CONNECTIONS) { ws.close(1013, 'Server busy'); return; }
  const id = crypto.randomUUID();
  const info = { id, readySeq: null, connectedAt: Date.now(), lastSeen: Date.now() };
  sessions.set(ws, info);
  send(ws, { type: 'WELCOME', clientId: id, controlRequired: Boolean(CONTROL_TOKEN) });
  send(ws, publicState());

  ws.on('message', raw => {
    info.lastSeen = Date.now();
    let data;
    try { data = JSON.parse(raw.toString()); }
    catch { send(ws, { type: 'ERROR', message: 'Invalid JSON' }); return; }
    if (!data || typeof data.type !== 'string') return;

    if (data.type === 'PING') {
      send(ws, { type: 'PONG', serverTime: Date.now(), clientWall: data.clientWall, clientMono: data.clientMono });
      return;
    }
    if (data.type === 'GET_STATE') { send(ws, publicState()); return; }

    if (CONTROL_TOKEN && !safeEqual(String(data.token || ''), CONTROL_TOKEN)) {
      send(ws, { type: 'ERROR', message: 'Controller token required or invalid' }); return;
    }

    switch (data.type) {
      case 'PLAY':
        if (!isSafeSongName(data.songFile) || !listSongs().includes(data.songFile)) {
          send(ws, { type: 'ERROR', message: 'Unknown song' }); return;
        }
        beginPrepare(data.songFile);
        break;
      case 'READY':
        if (data.seq !== playback.seq) return;
        info.readySeq = data.seq;
        if (playback.state === 'preparing') {
          playback.readyCount = [...sessions.values()].filter(s => s.readySeq === data.seq).length;
          if ([...sessions.values()].every(s => s.readySeq === data.seq)) scheduleStart(data.seq);
          break;
        }
        // A client that finished downloading late catches up to the live session.
        if (playback.state === 'scheduled' || playback.state === 'playing') {
          // Include the lead time in the late client's position so it joins at
          // approximately the position other clients will have at targetTime.
          const targetTime = Date.now() + START_LEAD_MS;
          const position = currentPosition() + START_LEAD_MS / 1000;
          send(ws, { type: 'RESUME_AT', seq: playback.seq, songFile: playback.songFile, position, targetTime });
        } else {
          send(ws, publicState());
        }
        break;
      case 'NOT_READY':
        if (data.seq === playback.seq) console.warn(`Client ${info.id} could not preload:`, String(data.reason || '').slice(0, 200));
        break;
      case 'PAUSE': pausePlayback(); break;
      case 'RESUME': resumePlayback(); break;
      case 'SEEK':
        if (!Number.isFinite(data.position) || data.position < 0 || data.position > 86400) {
          send(ws, { type: 'ERROR', message: 'Invalid seek position' }); return;
        }
        seekPlayback(data.position);
        break;
      case 'STOP': setStopped(); break;
      case 'ENDED':
        // Only stop if this event refers to the current sequence and server time
        // confirms the track should have ended; clients never choose the position.
        if (data.seq === playback.seq && playback.state === 'playing') setStopped('Finished');
        break;
      case 'CLIENT_ERROR':
        console.warn(`Client ${info.id} playback error:`, String(data.reason || '').slice(0, 200));
        break;
      default: send(ws, { type: 'ERROR', message: 'Unknown command' });
    }
  });
  ws.on('close', () => {
    sessions.delete(ws);
    if (playback.state === 'preparing' && [...sessions.values()].length && [...sessions.values()].every(s => s.readySeq === playback.seq)) scheduleStart(playback.seq);
  });
  ws.on('error', err => console.warn('WebSocket error:', err.message));
});

function safeEqual(a, b) {
  const aa = Buffer.from(a); const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

// Heartbeat removes dead connections and prevents stale clients blocking readiness.
const heartbeat = setInterval(() => {
  for (const [ws, info] of sessions) {
    if (Date.now() - info.lastSeen > 90000) { ws.terminate(); sessions.delete(ws); }
  }
}, 30000);
server.on('close', () => clearInterval(heartbeat));
server.listen(PORT, HOST, () => {
  console.log(`Mobs Jukebox listening on http://${HOST}:${PORT}`);
  console.log(`Music directory: ${MUSIC_DIR}`);
  console.log(CONTROL_TOKEN ? 'Controller token: required' : 'WARNING: no controller token; use only on a trusted network.');
});
