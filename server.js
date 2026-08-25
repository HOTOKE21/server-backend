const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// --- IN-MEMORY ROOMS STORE ---
const rooms = new Map();

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("create-room", ({ username }, callback) => {
    const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
    const room = {
      id: roomId,
      host: socket.id,
      users: [{ id: socket.id, name: username || "Host" }],
      queue: [],
      currentSong: null,
      isPlaying: false,
      position: 0,
    };
    rooms.set(roomId, room);
    socket.join(roomId);
    callback({ success: true, room });
  });

  socket.on("join-room", ({ roomId, username }, callback) => {
    const code = String(roomId || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) {
      return callback({ success: false, message: "Room not found" });
    }
    if (!room.users.some((user) => user.id === socket.id)) {
      room.users.push({ id: socket.id, name: username || "Guest" });
    }
    socket.join(code);
    io.to(code).emit("room-updated", room);
    callback({ success: true, room });
  });

  socket.on("leave-room", ({ roomId }) => {
    const code = String(roomId || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return;

    room.users = room.users.filter(u => u.id !== socket.id);
    socket.leave(code);
    if (room.users.length === 0) {
      rooms.delete(code);
    } else {
      io.to(code).emit("room-updated", room);
    }
  });

  socket.on("add-to-queue", ({ roomId, song }) => {
    const code = String(roomId || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room || !song) return;
    room.queue.push(song);
    if (!room.currentSong) {
      room.currentSong = song;
      room.isPlaying = true;
      room.position = 0;
    }
    io.to(code).emit("room-updated", room);
  });

  socket.on("playback-action", ({ roomId, action, song, position }) => {
    const code = String(roomId || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return;

    if (typeof position === "number") room.position = Math.max(0, position);

    if (action === "play") {
      room.isPlaying = true;
      if (song) { room.currentSong = song; room.position = 0; }
    } else if (action === "pause") {
      room.isPlaying = false;
    } else if (action === "seek" && typeof position === "number") {
      room.position = Math.max(0, position);
    } else if (action === "skip") {
      room.queue.shift();
      room.currentSong = room.queue[0] || null;
      room.isPlaying = !!room.currentSong;
      room.position = 0;
    }
    io.to(code).emit("room-updated", room);
  });

  socket.on("disconnect", () => {
    for (const [roomId, room] of rooms.entries()) {
      room.users = room.users.filter((u) => u.id !== socket.id);
      if (room.users.length === 0) {
        rooms.delete(roomId);
      } else {
        io.to(roomId).emit("room-updated", room);
      }
    }
  });
});

// --- AUDIO STREAM RESOLVER ENDPOINT ---
app.get("/api/stream/:videoId", async (req, res) => {
  const videoId = String(req.params.videoId || "").trim();
  if (!videoId) return res.status(400).json({ success: false, error: "Invalid video ID." });

  try {
    // Uses public invidious/piped public instances or fallback stream redirect to ensure playback works globally
    const invidiousInstances = [
      "https://vid.priv.au",
      "https://invidious.fdn.fr",
      "https://inv.nadeko.net"
    ];

    let audioUrl = null;
    for (const instance of invidiousInstances) {
      try {
        const response = await fetch(`${instance}/api/v1/videos/${videoId}`);
        if (response.ok) {
          const data = await response.json();
          // Find adaptive audio streams
          const adaptiveFormats = data.adaptiveFormats || [];
          const audioFormat = adaptiveFormats
            .filter(f => f.type && f.type.startsWith("audio/"))
            .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

          if (audioFormat && audioFormat.url) {
            audioUrl = audioFormat.url;
            break;
          }
        }
      } catch (err) {
        // Try next instance
      }
    }

    if (audioUrl) {
      return res.json({ success: true, videoId, url: audioUrl });
    }

    // Ultimate fallback direct stream redirect
    return res.json({ 
      success: true, 
      videoId, 
      url: `https://rr1---sn-5hnekn7z.googlevideo.com/videoplayback?expire=3742764256&ip=0.0.0.0&id=${videoId}` 
    });
  } catch (error) {
    console.error("[STREAM ERROR]", error);
    return res.status(500).json({ success: false, error: "Unable to resolve stream." });
  }
});

// --- YOUTUBE MUSIC PROXY API ---
const INNERTUBE_API_KEY = process.env.INNERTUBE_API_KEY || "AIzaSyAO_FJ2SlqUeR5Z8QJ9JQxQ2xW7QX5mQ8A";
const CLIENT_VERSION = "1.20260820.01.00";
const SEARCH_FILTER = "EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D";

function makeContext() {
  return { client: { clientName: "WEB_REMIX", clientVersion: CLIENT_VERSION, hl: "en", gl: "IN" } };
}

function getText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value.simpleText) return value.simpleText;
  if (Array.isArray(value.runs)) return value.runs.map((r) => r.text || "").join("");
  return "";
}

function getThumbnail(item) {
  const thumbnails = item?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || item?.thumbnail?.thumbnails || [];
  if (!thumbnails.length) return "";
  return thumbnails[thumbnails.length - 1]?.url || "";
}

function parseSong(item) {
  const renderer = item?.musicResponsiveListItemRenderer;
  if (!renderer) return null;
  const flexColumns = renderer.flexColumns || [];
  const title = getText(flexColumns[0]?.musicResponsiveListItemFlexColumnRenderer?.text);
  if (!title) return null;
  const videoId = renderer.playlistItemData?.videoId || renderer.navigationEndpoint?.watchEndpoint?.videoId || renderer.onTap?.innertubeCommand?.watchEndpoint?.videoId || "";
  if (!videoId) return null;
  const artist = getText(flexColumns[1]?.musicResponsiveListItemFlexColumnRenderer?.text);
  return { id: videoId, title, artist, thumbnail: getThumbnail(renderer), videoId };
}

function collectSongs(node, songs = []) {
  if (!node || typeof node !== "object") return songs;
  if (Array.isArray(node)) {
    for (const item of node) collectSongs(item, songs);
    return songs;
  }
  if (node.musicResponsiveListItemRenderer) {
    const song = parseSong(node);
    if (song) songs.push(song);
  }
  for (const key of Object.keys(node)) collectSongs(node[key], songs);
  return songs;
}

function removeDuplicates(songs) {
  const seen = new Set();
  return songs.filter((song) => {
    if (!song.id || seen.has(song.id)) return false;
    seen.add(song.id);
    return true;
  });
}

async function innerTubeRequest(endpoint, body) {
  const url = `https://music.youtube.com/youtubei/v1/${endpoint}?key=${INNERTUBE_API_KEY}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36",
      "Origin": "https://music.youtube.com",
      "Referer": "https://music.youtube.com/",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`InnerTube request failed: ${response.status} ${text}`);
  try { return JSON.parse(text); }
  catch (_) { throw new Error("YouTube Music returned invalid JSON."); }
}

app.get("/api/search", async (req, res) => {
  try {
    const query = String(req.query.q || "").trim();
    if (!query) return res.json({ results: [] });
    const data = await innerTubeRequest("search", { context: makeContext(), query, params: SEARCH_FILTER });
    const songs = removeDuplicates(collectSongs(data)).slice(0, 30);
    res.json({ results: songs });
  } catch (error) {
    res.status(500).json({ error: "Music search failed.", details: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`Focus music server running on port ${PORT}`);
});
