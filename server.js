import express from "express";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";
import { Innertube, Platform } from "youtubei.js";
import { pipeline } from "stream";
import { promisify } from "util";

const streamPipeline = promisify(pipeline);

// The fixed evaluator for youtubei.js
Platform.shim.eval = async (data, env) => {
  const fn = new Function(
    "env",
    `
    ${data.output}

    return {
      n: typeof n === "function"
        ? n(env.n)
        : undefined,

      sig: typeof sig === "function"
        ? sig(env.sig)
        : undefined
    };
    `
  );
  return fn(env);
};

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" },
});

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => res.json({ ok: true, message: "Focus Music Server is running" }));
app.get("/health", (req, res) => res.json({ ok: true, status: "online" }));

const rooms = new Map();

io.on("connection", (socket) => {
  console.log("[SOCKET] Client connected:", socket.id);

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
    callback?.({ success: true, room });
  });

  socket.on("join-room", ({ roomId, username }, callback) => {
    const code = String(roomId || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return callback?.({ success: false, message: "Room not found" });

    if (!room.users.some((user) => user.id === socket.id)) {
      room.users.push({ id: socket.id, name: username || "Guest" });
    }
    socket.join(code);
    io.to(code).emit("room-updated", room);
    callback?.({ success: true, room });
  });

  socket.on("leave-room", ({ roomId }) => {
    const code = String(roomId || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return;

    room.users = room.users.filter((user) => user.id !== socket.id);
    socket.leave(code);

    if (room.users.length === 0) rooms.delete(code);
    else io.to(code).emit("room-updated", room);
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
    }
    if (action === "pause") room.isPlaying = false;
    if (action === "seek" && typeof position === "number") room.position = Math.max(0, position);
    if (action === "skip") {
      if (room.queue.length > 0) room.queue.shift();
      room.currentSong = room.queue[0] || null;
      room.isPlaying = !!room.currentSong;
      room.position = 0;
    }
    io.to(code).emit("room-updated", room);
  });

  socket.on("disconnect", () => {
    console.log("[SOCKET] Client disconnected:", socket.id);
    for (const [roomId, room] of rooms.entries()) {
      room.users = room.users.filter((user) => user.id !== socket.id);
      if (room.users.length === 0) rooms.delete(roomId);
      else io.to(roomId).emit("room-updated", room);
    }
  });
});

const INNERTUBE_API_KEY = process.env.INNERTUBE_API_KEY || "";
const CLIENT_VERSION = "1.20260820.01.00";
const SEARCH_FILTER = "EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D";

function makeContext() {
  return { client: { clientName: "WEB_REMIX", clientVersion: CLIENT_VERSION, hl: "en", gl: "IN" } };
}

function getText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value.simpleText) return value.simpleText;
  if (Array.isArray(value.runs)) return value.runs.map((run) => run.text || "").join("");
  return "";
}

function getThumbnail(item) {
  const thumbnails = item?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || item?.thumbnail?.thumbnails || [];
  return thumbnails.length ? thumbnails[thumbnails.length - 1]?.url || "" : "";
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
  if (!INNERTUBE_API_KEY) throw new Error("INNERTUBE_API_KEY is not configured.");
  const url = `https://music.youtube.com/youtubei/v1/${endpoint}?key=${INNERTUBE_API_KEY}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36",
      Origin: "https://music.youtube.com",
      Referer: "https://music.youtube.com/",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`InnerTube request failed: ${response.status}`);
  return JSON.parse(text);
}

app.get("/api/search", async (req, res) => {
  try {
    const query = String(req.query.q || "").trim();
    if (!query) return res.json({ results: [] });
    const data = await innerTubeRequest("search", { context: makeContext(), query, params: SEARCH_FILTER });
    const songs = removeDuplicates(collectSongs(data)).slice(0, 30);
    return res.json({ results: songs });
  } catch (error) {
    console.error("[SEARCH] Error:", error);
    return res.status(500).json({ error: "Music search failed.", details: error?.message || String(error) });
  }
});

let youtubeClientsPromise = null;
async function getYouTubeClients() {
  if (!youtubeClientsPromise) {
    youtubeClientsPromise = (async () => {
      const clients = [];
      try {
        console.log("[STREAM] Creating ANDROID_VR client...");
        clients.push(await Innertube.create({ client_type: "ANDROID_VR", generate_session_locally: true }));
        console.log("[STREAM] ANDROID_VR ready");
      } catch (error) { console.error("[STREAM] ANDROID_VR failed:", error?.message || error); }

      try {
        console.log("[STREAM] Creating WEB_REMIX client...");
        clients.push(await Innertube.create({ client_type: "WEB_REMIX", generate_session_locally: true }));
        console.log("[STREAM] WEB_REMIX ready");
      } catch (error) { console.error("[STREAM] WEB_REMIX failed:", error?.message || error); }

      if (!clients.length) throw new Error("Unable to initialize any YouTube playback client.");
      return clients;
    })();
  }
  return youtubeClientsPromise;
}

function normalizeUrl(value) {
  if (!value) return null;
  if (value instanceof URL) return value.toString();
  if (typeof value === "string") {
    const text = value.trim();
    if (!text || text === "null" || text === "{}" || text === "[object Promise]") return null;
    if (text.startsWith("http://") || text.startsWith("https://")) return text;
  }
  return null;
}

async function resolveFormatUrl(format) {
  if (!format) return null;
  const candidates = [format.url, format.deciphered_url, format.decipheredUrl, format.original_url, format.originalUrl];
  for (const candidate of candidates) {
    try {
      const value = await candidate;
      const url = normalizeUrl(value);
      if (url) return url;
    } catch (_) {}
  }
  return null;
}

async function resolveAudio(youtube, videoId) {
  const streamingData = await youtube.getStreamingData(videoId, { type: "audio", quality: "best" });
  if (!streamingData) throw new Error("No streaming data was returned.");

  const formats = [];
  if (streamingData.format) formats.push(streamingData.format);
  if (streamingData.audioFormat) formats.push(streamingData.audioFormat);
  if (Array.isArray(streamingData.formats)) formats.push(...streamingData.formats);
  if (Array.isArray(streamingData.adaptiveFormats)) formats.push(...streamingData.adaptiveFormats);
  if (Array.isArray(streamingData.adaptive_formats)) formats.push(...streamingData.adaptive_formats);
  if (!formats.length) formats.push(streamingData);

  const audioFormats = formats.filter(Boolean).filter((format) => {
    const mime = String(format?.mime_type || format?.mimeType || format?.mime || "");
    return mime.startsWith("audio/") || format.type === "audio";
  }).sort((a, b) => Number(b?.bitrate || b?.average_bitrate || 0) - Number(a?.bitrate || a?.average_bitrate || 0));

  const candidates = audioFormats.length ? audioFormats : formats;

  for (const format of candidates) {
    const url = await resolveFormatUrl(format);
    if (url) return url;
  }
  throw new Error("No playable URL could be resolved.");
}

// PROXY STREAM ENDPOINT (Streams raw binary chunks directly to Flutter)
app.get("/api/stream/:videoId", async (req, res) => {
  const videoId = String(req.params.videoId || "").trim();
  if (!videoId) return res.status(400).send("Missing video ID");

  try {
    const clients = await getYouTubeClients();
    let audioUrl = null;

    for (const youtube of clients) {
      try {
        audioUrl = await resolveAudio(youtube, videoId);
        if (audioUrl) break;
      } catch (e) {}
    }

    if (!audioUrl) return res.status(500).send("Could not resolve stream URL");

    const audioRes = await fetch(audioUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Range": req.headers.range || "bytes=0-"
      }
    });

    if (!audioRes.ok) return res.status(500).send("Failed to fetch audio stream");

    res.setHeader("Content-Type", "audio/mpeg");
    if (audioRes.headers.get("content-length")) {
      res.setHeader("Content-Length", audioRes.headers.get("content-length"));
    }

    //@ts-ignore
    await streamPipeline(audioRes.body, res);
  } catch (error) {
    console.error(`[STREAM ERROR]`, error);
    if (!res.headersSent) res.status(500).send("Streaming failed");
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Focus music server running on port ${PORT}`);
});
