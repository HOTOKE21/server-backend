const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const { Readable } = require("stream");

const app = express();
app.set("trust proxy", 1);
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ========== MAPS ==========
const rooms = new Map();
const studyRooms = new Map();

// ========== SOCKET.IO ==========
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  // --- Music Room Events ---
  socket.on("create-room", ({ username }, callback) => {
    const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
    const room = {
      id: roomId,
      host: socket.id,
      users: [{ id: socket.id, name: username || "Host" }],
      queue: [],
      currentSong: null,
      isPlaying: false,
    };
    rooms.set(roomId, room);
    socket.join(roomId);
    callback({ success: true, room });
  });

  socket.on("join-room", ({ roomId, username }, callback) => {
    const code = String(roomId).trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return callback({ success: false, message: "Room not found" });
    room.users.push({ id: socket.id, name: username || "Guest" });
    socket.join(code);
    io.to(code).emit("room-updated", room);
    callback({ success: true, room });
  });

  socket.on("leave-room", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.users = room.users.filter((u) => u.id !== socket.id);
    socket.leave(roomId);
    if (room.users.length === 0) {
      rooms.delete(roomId);
    } else {
      io.to(roomId).emit("room-updated", room);
    }
  });

  socket.on("add-to-queue", ({ roomId, song }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.queue.push(song);
    if (!room.currentSong) {
      room.currentSong = song;
      room.isPlaying = true;
    }
    io.to(roomId).emit("room-updated", room);
  });

  socket.on("playback-action", ({ roomId, action, song }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    if (action === "play") {
      room.isPlaying = true;
      if (song) room.currentSong = song;
    } else if (action === "pause") {
      room.isPlaying = false;
    } else if (action === "skip") {
      room.queue.shift();
      room.currentSong = room.queue[0] || null;
      room.isPlaying = !!room.currentSong;
    } else if (action === "back") {
      // reserved for future use
    }
    io.to(roomId).emit("room-updated", room);
  });

  // --- Study Room Events ---

  socket.on("create-study-room", ({ username }, callback) => {
    const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
    const room = {
      id: roomId,
      host: socket.id,
      users: [{ id: socket.id, name: username || "Host" }],
      timer: { running: false, seconds: 0, mode: "pomodoro", startedBy: null },
    };
    studyRooms.set(roomId, room);
    socket.join(roomId);
    callback({ success: true, room });
  });

  socket.on("join-study-room", ({ roomId, username }, callback) => {
    const code = String(roomId).trim().toUpperCase();
    const room = studyRooms.get(code);
    if (!room) {
      if (callback) callback({ success: false, message: "Study room not found" });
      return;
    }
    room.users.push({ id: socket.id, name: username || "Guest" });
    socket.join(code);
    io.to(code).emit("study-room-updated", room);
    if (callback) callback({ success: true, room });
  });

  socket.on("leave-study-room", ({ roomId }) => {
    const room = studyRooms.get(roomId);
    if (!room) return;
    room.users = room.users.filter((u) => u.id !== socket.id);
    socket.leave(roomId);
    if (room.users.length === 0) {
      studyRooms.delete(roomId);
    } else {
      if (room.host === socket.id) room.host = room.users[0].id;
      io.to(roomId).emit("study-room-updated", room);
    }
  });

  // Only the HOST can sync the timer — prevents conflicts
  socket.on("study-timer-sync", ({ roomId, running, seconds, mode }) => {
    const room = studyRooms.get(roomId);
    if (!room) return;
    if (socket.id !== room.host) return; // Only host controls
    room.timer = { running, seconds, mode, startedBy: socket.id };
    // Broadcast to ALL OTHER users (host continues locally)
    socket.to(roomId).emit("study-timer-update", {
      running,
      seconds,
      mode,
      startedBy: room.users.find((u) => u.id === socket.id)?.name || "Host",
    });
  });

  socket.on("study-timer-action", ({ roomId, action }) => {
    const room = studyRooms.get(roomId);
    if (!room || socket.id !== room.host) return;
    if (action === "pause") room.timer.running = false;
    else if (action === "resume") room.timer.running = true;
    else if (action === "reset")
      room.timer = {
        running: false,
        seconds: 0,
        mode: room.timer.mode,
        startedBy: null,
      };
    io.to(roomId).emit("study-timer-update", {
      running: room.timer.running,
      seconds: room.timer.seconds,
      mode: room.timer.mode,
      startedBy: room.timer.startedBy,
    });
  });

  // --- Disconnect ---
  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);

    // Clean up music rooms
    for (const [roomId, room] of rooms.entries()) {
      room.users = room.users.filter((u) => u.id !== socket.id);
      if (room.users.length === 0) {
        rooms.delete(roomId);
      } else {
        if (room.host === socket.id) room.host = room.users[0]?.id;
        io.to(roomId).emit("room-updated", room);
      }
    }

    // Clean up study rooms
    for (const [roomId, room] of studyRooms.entries()) {
      room.users = room.users.filter((u) => u.id !== socket.id);
      if (room.users.length === 0) {
        studyRooms.delete(roomId);
      } else {
        if (room.host === socket.id) room.host = room.users[0]?.id;
        io.to(roomId).emit("study-room-updated", room);
      }
    }
  });
});

// ========== INNERTUBE API ==========
const INNERTUBE_API_KEY = "AIzaSyAO_FJ2SlqUeR5Z8QJ9JQxQ2xW7QX5mQ8A";
const CLIENT_VERSION = "1.20260820.01.00";
const SEARCH_FILTER = "EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D";

function makeContext() {
  return {
    client: {
      clientName: "WEB_REMIX",
      clientVersion: CLIENT_VERSION,
      hl: "en",
      gl: "IN",
    },
  };
}

function getText(v) {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (v.simpleText) return v.simpleText;
  if (Array.isArray(v.runs)) return v.runs.map((r) => r.text || "").join("");
  return "";
}

function getThumbnail(item) {
  const t =
    item?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ||
    item?.thumbnail?.thumbnails ||
    [];
  return t.length ? t[t.length - 1]?.url || "" : "";
}

function parseSong(item) {
  const r = item?.musicResponsiveListItemRenderer;
  if (!r) return null;
  const fc = r.flexColumns || [];
  const title = getText(
    fc[0]?.musicResponsiveListItemFlexColumnRenderer?.text
  );
  if (!title) return null;
  const videoId =
    r.playlistItemData?.videoId ||
    r.navigationEndpoint?.watchEndpoint?.videoId ||
    "";
  if (!videoId) return null;
  const artist = getText(
    fc[1]?.musicResponsiveListItemFlexColumnRenderer?.text
  );
  return { id: videoId, title, artist, thumbnail: getThumbnail(r), videoId };
}

function collectSongs(node, songs = []) {
  if (!node || typeof node !== "object") return songs;
  if (Array.isArray(node)) {
    for (const item of node) collectSongs(item, songs);
    return songs;
  }
  if (node.musicResponsiveListItemRenderer) {
    const s = parseSong(node);
    if (s) songs.push(s);
  }
  for (const key of Object.keys(node)) collectSongs(node[key], songs);
  return songs;
}

function dedup(songs) {
  const seen = new Set();
  return songs.filter((s) => {
    if (!s.id || seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
}

async function innerTubeRequest(endpoint, body) {
  const url = `https://music.youtube.com/youtubei/v1/${endpoint}?key=${INNERTUBE_API_KEY}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 Chrome/151",
      Origin: "https://music.youtube.com",
      Referer: "https://music.youtube.com/",
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`InnerTube ${resp.status}`);
  return JSON.parse(text);
}

// ========== API ROUTES ==========

// Search songs
app.get("/api/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.json({ results: [] });
    const data = await innerTubeRequest("search", {
      context: makeContext(),
      query: q,
      params: SEARCH_FILTER,
    });
    res.json({ results: dedup(collectSongs(data)).slice(0, 30) });
  } catch (e) {
    res.status(500).json({ error: "Search failed", details: e.message });
  }
});

// Smart suggestions (related songs based on what's playing)
app.get("/api/suggest", async (req, res) => {
  try {
    const videoId = String(req.query.videoId || "").trim();
    if (!videoId) return res.json({ results: [] });
    const data = await innerTubeRequest("next", {
      context: makeContext(),
      videoId: videoId,
      params: "8gBUAg%3D%3D", // Related content params
    });
    const results = dedup(collectSongs(data)).slice(0, 15);
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: "Suggest failed", details: e.message });
  }
});

// Album art / thumbnail redirect
app.get("/api/thumbnail/:videoId", (req, res) => {
  const videoId = String(req.params.videoId || "").trim();
  if (!videoId) return res.status(400).send("Missing videoId");
  const url = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
  res.redirect(302, url);
});

// ========== STREAM RESOLUTION ==========
const PIPED_INSTANCES = [
  "https://pipedapi.kavin.rocks",
  "https://pipedapi.tokhmi.xyz",
  "https://pipedapi.moomoo.me",
  "https://pipedapi.syncpundit.io",
  "https://api-piped.mha.fi",
  "https://piped-api.garudalinux.org",
  "https://pipedapi.rivo.lol",
  "https://pipedapi.leptons.xyz",
  "https://piped-api.lunar.icu",
  "https://ytapi.dc09.ru",
  "https://pipedapi.colinslegacy.com",
  "https://yapi.vyper.me",
  "https://api.looleh.xyz",
  "https://piped-api.cfe.re",
  "https://pipedapi.r4fo.com",
  "https://pipedapi.nosebs.ru",
  "https://pipedapi-libre.kavin.rocks",
  "https://pa.mint.lgbt",
  "https://pa.il.ax",
  "https://piped-api.privacy.com.de",
  "https://api.piped.projectsegfau.lt",
  "https://pipedapi.in.projectsegfau.lt",
  "https://pipedapi.us.projectsegfau.lt",
  "https://watchapi.whatever.social",
  "https://api.piped.privacydev.net",
  "https://pipedapi.palveluntarjoaja.eu",
  "https://pipedapi.smnz.de",
  "https://pipedapi.adminforge.de",
  "https://pipedapi.qdi.fi",
  "https://piped-api.hostux.net",
  "https://pdapi.vern.cc",
  "https://pipedapi.pfcd.me",
  "https://pipedapi.frontendfriendly.xyz",
  "https://api.piped.yt",
  "https://pipedapi.astartes.nl",
  "https://pipedapi.osphost.fi",
  "https://pipedapi.simpleprivacy.fr",
  "https://pipedapi.drgns.space",
  "https://piapi.ggtyler.dev",
  "https://api.watch.pluto.lat",
  "https://piped-backend.seitan-ayoub.lol",
  "https://pipedapi.owo.si",
  "https://api.piped.minionflo.net",
  "https://pipedapi.nezumi.party",
  "https://pipedapi.ducks.party",
  "https://pipedapi.ngn.tf",
  "https://pipedapi.coldforge.xyz",
  "https://piped-api.codespace.cz",
  "https://pipedapi.reallyaweso.me",
  "https://pipedapi.phoenixthrush.com",
  "https://api.piped.private.coffee",
  "https://schaunapi.ehwurscht.at",
  "https://pipedapi.darkness.services",
  "https://pipedapi.andreafortuna.org",
  "https://piped.wireway.ch",
  "https://piped-nextgen.xn--17b.net",
  "https://piped.syncpundit.io",
  "https://piped.ezero.space",
];

async function resolveViaPiped(videoId) {
  const BATCH = 8;
  for (let i = 0; i < PIPED_INSTANCES.length; i += BATCH) {
    const batch = PIPED_INSTANCES.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(async (inst) => {
        const resp = await fetch(`${inst}/streams/${videoId}`, {
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(8000),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        const audio = (data.audioStreams || [])
          .filter((s) => s.url && s.mimeType?.startsWith("audio/"))
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        if (!audio.length) throw new Error("no audio");
        return { url: audio[0].url, instance: inst };
      })
    );
    const ok = results.find((r) => r.status === "fulfilled");
    if (ok) {
      console.log(`[STREAM] OK via ${ok.value.instance}`);
      return ok.value.url;
    }
    console.log(
      `[STREAM] Batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(PIPED_INSTANCES.length / BATCH)}: all failed`
    );
  }
  return null;
}

app.get("/api/stream/:videoId", async (req, res) => {
  const videoId = String(req.params.videoId || "").trim();
  if (!videoId) return res.status(400).json({ error: "Missing videoId." });
  console.log(`[STREAM] Resolving ${videoId}...`);
  const url = await resolveViaPiped(videoId);
  if (url)
    return res.json({
      url: `${req.protocol}://${req.get("host")}/api/proxy?url=${encodeURIComponent(url)}`,
      source: "piped",
    });
  return res.status(404).json({ error: "All instances failed." });
});

app.get("/api/proxy", async (req, res) => {
  try {
    const target = req.query.url;
    if (!target) return res.status(400).send("Missing url");
    const headers = {
      "User-Agent": "Mozilla/5.0 Chrome/151",
      Accept: "*/*",
      "Accept-Encoding": "identity",
      Origin: "https://www.youtube.com",
      Referer: "https://www.youtube.com/",
    };
    if (req.headers.range) headers.Range = req.headers.range;
    const upstream = await fetch(target, {
      headers,
      signal: AbortSignal.timeout(30000),
    });
    res.status(upstream.status);
    for (const h of [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges",
    ]) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (e) {
    res.status(500).json({ error: "Proxy failed" });
  }
});

// ========== START ==========
server.listen(PORT, () => {
  console.log(`KALM server running on port ${PORT}`);
  console.log(`  Music rooms: /api/search, /api/stream, /api/proxy`);
  console.log(`  Study rooms: create-study-room, join-study-room, study-timer-sync`);
  console.log(`  Suggestions: /api/suggest?videoId=xxx`);
  console.log(`  Thumbnails:  /api/thumbnail/:videoId`);
});
