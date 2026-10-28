const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// ==================== CONFIGURATION ====================
const PORT = 8080;
const MUSIC_DIR = __dirname; // Folder where your MP3 files are stored
const BUFFER_TIME_NEW = 20000;    // 20 seconds for downloading new songs across multiple devices
const BUFFER_TIME_RESUME = 3000;  // 3 seconds for resuming/unpausing (audio is already cached in RAM)
// =======================================================

function getMp3List() {
    try {
        return fs.readdirSync(MUSIC_DIR).filter(file => file.toLowerCase().endsWith('.mp3'));
    } catch (e) {
        return [];
    }
}

const server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

    if (parsedUrl.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(getClientHtml());
    } 
    else if (parsedUrl.pathname === '/songs') {
        const songs = getMp3List();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(songs));
    } 
    else if (parsedUrl.pathname === '/stream') {
        const filename = parsedUrl.searchParams.get('file');
        if (!filename) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            return res.end('Missing file parameter.');
        }

        const safeFilename = path.basename(filename);
        const filePath = path.join(MUSIC_DIR, safeFilename);

        if (!fs.existsSync(filePath)) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            return res.end('Song not found.');
        }

        const stat = fs.statSync(filePath);
        res.writeHead(200, {
            'Content-Length': stat.size,
            'Content-Type': 'audio/mpeg',
        });
        fs.createReadStream(filePath).pipe(res);
    } 
    else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log('New client connected.');

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'PING') {
                ws.send(JSON.stringify({ type: 'PONG', clientTime: data.clientTime, serverTime: Date.now() }));
            }

            if (data.type === 'TRIGGER_SYNC') {
                const targetStartTime = Date.now() + BUFFER_TIME_NEW;
                wss.clients.forEach((client) => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'PRELOAD_AND_PLAY',
                            songFile: data.songFile,
                            targetTime: targetStartTime,
                            bufferTime: BUFFER_TIME_NEW
                        }));
                    }
                });
            }

            if (data.type === 'TRIGGER_PAUSE') {
                wss.clients.forEach((client) => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'PAUSE_ALL' }));
                    }
                });
            }

            if (data.type === 'TRIGGER_RESUME') {
                const targetStartTime = Date.now() + BUFFER_TIME_RESUME;
                wss.clients.forEach((client) => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'RESUME_ALL',
                            targetTime: targetStartTime,
                            currentTime: data.currentTime,
                            bufferTime: BUFFER_TIME_RESUME
                        }));
                    }
                });
            }

        } catch (e) {
            console.error('Invalid JSON message');
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected.');
    });
});

function getClientHtml() {
    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Mobs Jukebox</title>
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; text-align: center; margin: 0; padding: 20px; background: #121212; color: #fff; display: flex; flex-direction: column; align-items: center; min-height: 100vh; box-sizing: border-box; }
            
            .player-card {
                background: #181818;
                width: 100%;
                max-width: 380px;
                border-radius: 16px;
                padding: 24px;
                box-shadow: 0 8px 24px rgba(0,0,0,0.5);
                box-sizing: border-box;
                border: 1px solid #282828;
                margin-bottom: 20px;
            }

            .album-art {
                width: 100%;
                height: 140px;
                background: linear-gradient(135deg, #282828, #1DB954);
                border-radius: 12px;
                display: flex;
                flex-direction: column;
                justify-content: center;
                align-items: center;
                margin-bottom: 16px;
                position: relative;
                overflow: hidden;
            }

            .track-title { font-size: 16px; font-weight: bold; color: #fff; margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; width: 90%; }
            .track-status { font-size: 12px; color: #b3b3b3; text-transform: uppercase; letter-spacing: 1px; }

            .pulse-dot {
                display: inline-block;
                width: 7px;
                height: 7px;
                border-radius: 50%;
                background-color: #1DB954;
                margin-right: 6px;
                animation: pulse 1.5s infinite;
            }
            @keyframes pulse {
                0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(29, 185, 84, 0.7); }
                70% { transform: scale(1); box-shadow: 0 0 0 8px rgba(29, 185, 84, 0); }
                100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(29, 185, 84, 0); }
            }

            /* Main Play/Pause Button */
            .play-btn {
                width: 64px;
                height: 64px;
                border-radius: 50%;
                background: #1DB954;
                border: none;
                color: #000;
                font-size: 24px;
                cursor: pointer;
                display: flex;
                justify-content: center;
                align-items: center;
                margin: 20px auto 10px auto;
                box-shadow: 0 4px 12px rgba(29,185,84,0.4);
                transition: transform 0.1s ease, background 0.2s;
            }
            .play-btn:active { transform: scale(0.95); background: #1aa34a; }

            /* Progress Bar */
            #progressContainer { width: 100%; background: #282828; height: 6px; border-radius: 3px; margin: 15px 0 5px 0; overflow: hidden; display: none; }
            #progressBar { width: 0%; height: 100%; background: #1DB954; transition: width 0.05s linear; }

            /* Search & Song List */
            #searchInput { padding: 12px 16px; font-size: 14px; border-radius: 8px; background: #282828; color: #fff; border: 1px solid #404040; width: 100%; outline: none; margin-bottom: 12px; box-sizing: border-box; }
            #searchInput:focus { border-color: #1DB954; }

            #songListContainer { width: 100%; max-height: 220px; overflow-y: auto; background: #121212; border: 1px solid #282828; border-radius: 8px; text-align: left; padding: 4px; box-sizing: border-box; }
            .song-item { padding: 10px 12px; border-bottom: 1px solid #1a1a1a; display: flex; align-items: center; cursor: pointer; font-size: 13px; color: #ccc; }
            .song-item:hover { background: #222; color: #fff; }
            .song-item input[type="radio"] { margin-right: 12px; accent-color: #1DB954; }
            .song-item label { cursor: pointer; width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

            #unlockScreen { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: #121212; display: flex; flex-direction: column; justify-content: center; align-items: center; z-index: 10; }
            .unlock-btn { padding: 16px 32px; font-size: 16px; background: #1DB954; color: #000; border: none; border-radius: 30px; cursor: pointer; font-weight: bold; }
            
            #status { margin-top: 10px; margin-bottom: 10px; color: #888; font-size: 13px; }
        </style>
    </head>
    <body>

        <!-- Audio Unlock Screen -->
        <div id="unlockScreen">
            <h1 style="margin-bottom: 8px;">Mobs Jukebox</h1>
            <p style="color: #888; margin-bottom: 24px;">Tap once to enable synced audio.</p>
            <button class="unlock-btn" onclick="unlockAudio()">Start Listening</button>
        </div>

        <!-- Main Music Player Interface -->
        <div id="mainContent" style="width: 100%; max-width: 380px;">
            
            <!-- Player Card -->
            <div class="player-card">
                <div class="album-art">
                    <div style="font-size: 32px;">🎵</div>
                </div>
                
                <div class="track-title" id="displayTitle">No track selected</div>
                <div class="track-status" id="displayStatus"><span class="pulse-dot"></span>Ready</div>

                <!-- Progress Bar during sync windows -->
                <div id="progressContainer">
                    <div id="progressBar"></div>
                </div>

                <!-- Central Play/Pause Toggle Button -->
                <button class="play-btn" id="mainPlayBtn" onclick="handleMainPlayPause()">▶</button>
            </div>

	    <div id="status">Connected</div>

            <!-- Library / Search Section -->
            <div class="player-card" style="text-align: left;">
                <label style="font-size: 12px; text-transform: uppercase; color: #888; font-weight: bold; display: block; margin-bottom: 8px;">Library</label>
                <input type="text" id="searchInput" placeholder="Search all songs..." autocomplete="off">
                <div id="songListContainer">
                    <div style="padding: 15px; text-align: center; color: #888;">Loading songs...</div>
                </div>
            </div>
        </div>

        <script>
            let ws;
            let audio = document.createElement('audio');
            let statusDiv = document.getElementById('status');
            let searchInput = document.getElementById('searchInput');
            let songListContainer = document.getElementById('songListContainer');
            let progressContainer = document.getElementById('progressContainer');
            let progressBar = document.getElementById('progressBar');
            let displayTitle = document.getElementById('displayTitle');
            let displayStatus = document.getElementById('displayStatus');
            let mainPlayBtn = document.getElementById('mainPlayBtn');
            
            let allSongs = [];
            let selectedSong = null;
            let timeOffset = 0; 
            let playerState = 'stopped'; // 'stopped', 'playing', 'paused', 'buffering'
            let wakeLock = null;

            async function requestWakeLock() {
                try {
                    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
                } catch (err) {}
            }

            function unlockAudio() {
                audio.volume = 1.0;
                audio.play().catch(() => {});
                requestWakeLock();

                document.getElementById('unlockScreen').style.display = 'none';
                loadSongList();
                initWebSocket();
            }

            async function loadSongList() {
                try {
                    const res = await fetch('/songs');
                    allSongs = await res.json();
                    renderSongList(allSongs);
                } catch (e) {
                    songListContainer.innerHTML = '<div style="padding: 15px; text-align: center; color: #ff5555;">Failed to load song list</div>';
                }
            }

            function renderSongList(songs) {
                songListContainer.innerHTML = '';
                if (songs.length === 0) {
                    songListContainer.innerHTML = '<div style="padding: 15px; text-align: center; color: #888;">No matching songs found</div>';
                    return;
                }

                songs.forEach((song, index) => {
                    let div = document.createElement('div');
                    div.className = 'song-item';
                    let isChecked = (selectedSong === song) ? 'checked' : '';

                    div.innerHTML = \`
                        <input type="radio" name="songRadio" value="\${song}" id="song_\${index}" \${isChecked}>
                        <label for="song_\${index}">\${song}</label>
                    \`;

                    div.onclick = () => {
                        div.querySelector('input').checked = true;
                        selectedSong = song;
                    };
                    songListContainer.appendChild(div);
                });
            }

            searchInput.oninput = (e) => {
                const term = e.target.value.toLowerCase();
                renderSongList(allSongs.filter(song => song.toLowerCase().includes(term)));
            };

            function initWebSocket() {
                ws = new WebSocket('ws://' + window.location.host);

                ws.onopen = () => {
                    statusDiv.innerText = 'Connected to Jukebox';
                    syncClock();
                };

                function syncClock() {
                    const start = Date.now();
                    ws.send(JSON.stringify({ type: 'PING', clientTime: start }));
                }

                ws.onmessage = (event) => {
                    const data = JSON.parse(event.data);

                    if (data.type === 'PONG') {
                        const now = Date.now();
                        const rtt = now - data.clientTime;
                        const estimatedServerTime = data.serverTime + (rtt / 2);
                        timeOffset = estimatedServerTime - now;
                    }

                    // 1. Play New Song
                    if (data.type === 'PRELOAD_AND_PLAY') {
                        playerState = 'buffering';
                        mainPlayBtn.innerText = '⏳';
                        displayTitle.innerText = data.songFile;
                        displayStatus.innerHTML = '<span class="pulse-dot"></span>Buffering...';

                        let isAudioReady = false;
                        fetch('/stream?file=' + encodeURIComponent(data.songFile))
                            .then(response => response.blob())
                            .then(blob => {
                                audio.src = URL.createObjectURL(blob);
                                audio.load();
                                isAudioReady = true;
                            })
                            .catch(err => {
                                displayStatus.innerText = 'Download failed';
                            });

                        runCountdown(data.targetTime, data.bufferTime, () => isAudioReady, () => {
                            playerState = 'playing';
                            mainPlayBtn.innerText = '❚❚';
                            displayStatus.innerHTML = '<span class="pulse-dot"></span>Playing';
                        });
                    }

                    // 2. Pause All
                    if (data.type === 'PAUSE_ALL') {
                        audio.pause();
                        playerState = 'paused';
                        mainPlayBtn.innerText = '▶';
                        displayStatus.innerHTML = '<span class="pulse-dot" style="background-color: #ff5555;"></span>Paused';
                    }

                    // 3. Resume All
                    if (data.type === 'RESUME_ALL') {
                        if (data.currentTime !== undefined) audio.currentTime = data.currentTime;
                        playerState = 'buffering';
                        mainPlayBtn.innerText = '⏳';
                        displayStatus.innerHTML = '<span class="pulse-dot"></span>Resuming...';

                        runCountdown(data.targetTime, data.bufferTime, () => true, () => {
                            playerState = 'playing';
                            mainPlayBtn.innerText = '❚❚';
                            displayStatus.innerHTML = '<span class="pulse-dot"></span>Playing';
                        });
                    }
                };
            }

            function runCountdown(targetTime, totalBuffer, isReadyCheck, onComplete) {
                progressContainer.style.display = 'block';
                
                const checkAndSchedule = () => {
                    const nowServerTime = Date.now() + timeOffset;
                    const delay = targetTime - nowServerTime;

                    const elapsed = totalBuffer - delay;
                    const percent = Math.min(Math.max((elapsed / totalBuffer) * 100, 0), 100);
                    progressBar.style.width = percent + '%';

                    if (delay <= 0) {
                        progressContainer.style.display = 'none';
                        progressBar.style.width = '0%';

                        if (isReadyCheck()) {
                            audio.play().then(onComplete).catch(e => {
                                displayStatus.innerText = 'Tap play to start';
                                mainPlayBtn.innerText = '▶';
                            });
                        } else {
                            displayStatus.innerText = 'Buffer lagging';
                        }
                    } else {
                        setTimeout(checkAndSchedule, 50);
                    }
                };
                checkAndSchedule();
            }

            // Intelligent Play/Pause Toggle Handler
            function handleMainPlayPause() {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    if (playerState === 'playing') {
                        // Currently playing -> Pause
                        ws.send(JSON.stringify({ type: 'TRIGGER_PAUSE' }));
                    } else if (playerState === 'paused') {
                        // Currently paused -> Resume
                        ws.send(JSON.stringify({ type: 'TRIGGER_RESUME', currentTime: audio.currentTime }));
                    } else {
                        // Stopped or fresh start -> Play selected song from radio list
                        const checkedRadio = document.querySelector('input[name="songRadio"]:checked');
                        if (!checkedRadio) {
                            alert('Please select a song from the library first!');
                            return;
                        }
                        ws.send(JSON.stringify({ type: 'TRIGGER_SYNC', songFile: checkedRadio.value }));
                    }
                }
            }
        </script>
    </body>
    </html>
    `;
}

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Mobs Jukebox running on port ${PORT}`);
});
