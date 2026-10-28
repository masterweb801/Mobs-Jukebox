# Mobs Jukebox 🎵📻

A synchronized, multi device local Wi Fi music streaming jukebox built for Node.js and Android (Termux). Stream your MP3 library seamlessly across multiple phones simultaneously with sub millisecond clock synchronization no app installation or external cloud required.



## 🚀 Overview

**Mobs Jukebox** solves the classic multi device audio delay problem over local Wi Fi networks. Instead of independent audio streams drifting out of sync, Mobs Jukebox uses an NTP style clock offset calculation and precise timestamp scheduling (`audio.play()` executed at a target epoch time) to ensure every connected phone plays music in absolute harmony.

Designed to handle large offline music collections (200+ songs) smoothly through a clean, mobile optimized music player web interface.



## ✨ Key Features

* **Multi Device Synchronization:** NTP style clock syncing minimizes network jitter and hardware drift across all connected client phones.
* **Intelligent Buffering Windows:** 
  * *20 second pre download buffer* for new tracks to prevent network congestion when multiple devices pull files simultaneously over Wi Fi.
  * *3 second fast resume buffer* for instant unpausing since audio is already cached in RAM.
* **Instant Synchronized Pause:** Pause playback across all devices immediately with zero delay.
* **Searchable Library UI:** Filter through 200+ MP3 tracks instantly using a live search bar and scrollable list.
* **Zero APK Overhead:** Entirely web based run the server in Termux and access it via any mobile browser on your local Wi Fi.
* **Now Playing Banner:** Real time track information and pulsing status indicators shared across all screens.
* **Global Configuration:** Easily adjust buffer times and server ports via configuration variables at the top of the script.

   

## 🛠️ Architecture & How It Works

1. **Signaling:** A lightweight `ws` WebSocket server handles real time command broadcasting (Play, Pause, Resume, Sync Clock).
2. **Clock Offset:** Clients periodically send a `PING` to the server, estimating round trip time (RTT) and calculating a local time offset relative to the server clock.
3. **Scheduled Playback:** When a track is triggered, the server broadcasts a future target epoch timestamp ($T$). Clients count down visually using a progress bar and execute playback right as $T$ hits.
4. **Memory Resident Playback:** Audio files are fetched as binary `Blob` objects and loaded into memory (`URL.createObjectURL`), bypassing HTTP range request errors on mobile browsers.

   

## ⚙️ Prerequisites

* An Android device to act as the host server (running **Termux**).
* Node.js installed in Termux.
* A local Wi Fi network connecting the host phone and listener phones.

   

## 📦 Installation & Setup

### Step 1: Clone the Repository in Termux
Open Termux on your host Android device and install Node.js and Git:
```bash
pkg update && pkg upgrade
pkg install nodejs git
```

Clone the official GitHub repository:
```bash
git clone https://github.com/masterweb801/Mobs Jukebox.git
cd Mobs Jukebox
```

### Step 2: Install Dependencies
Install the required WebSocket package:
```bash
npm install
```

### Step 3: Add Your Music
Drop your `.mp3` files directly into the `Mobs Jukebox` folder.

### Step 4: Run the Server
Start the jukebox server:
```bash
node server.js
```
The console will display your local network address (e.g., `http://192.168.x.x:8080`).

   

## 📱 Usage Guide

1. Connect all listener phones to the same **local Wi Fi network** as the host Termux server.
2. Open any mobile browser and navigate to the server URL provided in the Termux terminal.
3. Tap **"Start Listening"** to unlock browser audio permissions and establish the WebSocket connection.
4. Use the search bar to find a song, select its radio button, and hit the central **Play** button. 
5. Watch the progress bar as devices buffer, and enjoy perfectly synchronized local audio playback!

   

## ⚙️ Configuration

You can tweak global parameters directly at the top of `server.js`:

```javascript
const PORT = 8080;
const BUFFER_TIME_NEW = 20000;    // Pre download buffer window for new songs (in ms)
const BUFFER_TIME_RESUME = 3000;  // Fast resume buffer when unpausing (in ms)
```

   

## 🛡️ Tech Stack

* **Backend:** Node.js, HTTP, `ws` (WebSockets), File System (`fs`)
* **Frontend:** Vanilla JavaScript (ES6+), HTML5 Audio API, CSS3 (Responsive Dark Theme UI)

   

## 👤 Author

Developed by **MD Mobashshirul Karim (Mobashshir)**  
GitHub: [@masterweb801](https://github.com/masterweb801)
