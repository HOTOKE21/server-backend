var express = require("express");
var cors = require("cors");
var http = require("http");
var { Server } = require("socket.io");
var app = express();
var server = http.createServer(app);
var io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] }, pingInterval: 5000, pingTimeout: 3000 });
var PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

app.get("/", function (_, res) { res.json({ ok: true, message: "Focus Music Server" }); });
app.get("/health", function (_, res) { res.json({ ok: true, status: "online" }); });

var rooms = new Map();
var suggestionCache = new Map();

function genId() {
  var c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", id = "";
  for (var i = 0; i < 5; i++) id += c[Math.floor(Math.random() * c.length)];
  return rooms.has(id) ? genId() : id;
}

function broadcast(rid) {
  var r = rooms.get(rid);
  if (r) io.to(rid).emit("room-updated", Object.assign({}, r, { serverTime: Date.now() }));
}

function advance(room, dir) {
  if (room.repeatMode === "one") { room.position = 0; room.isPlaying = true; room.lastSyncTime = Date.now(); return; }
  var idx = room.queue.findIndex(function (s) { return s.id === (room.currentSong && room.currentSong.id); });
  if (dir > 0) {
    if (idx < room.queue.length - 1) room.currentSong = room.queue[idx + 1];
    else if (room.repeatMode === "all") room.currentSong = room.queue[0];
    else { room.isPlaying = false; room.currentSong = null; }
  } else {
    if (idx > 0) room.currentSong = room.queue[idx - 1];
    else if (room.repeatMode === "all") room.currentSong = room.queue[room.queue.length - 1];
  }
  room.position = 0; room.isPlaying = !!room.currentSong; room.lastSyncTime = Date.now();
}

function shuffleArr(a) { for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } }

io.on("connection", function (s) {
  console.log("Connected:", s.id);

  s.on("create-room", function (d, cb) {
    var rid = genId();
    var room = { id: rid, host: s.id, users: [{ id: s.id, name: (d && d.username) || "Host" }], queue: [], currentSong: null, isPlaying: false, position: 0, repeatMode: "none", shuffleMode: false, autoSuggest: true, lastSyncTime: Date.now() };
    rooms.set(rid, room); s.join(rid);
    if (cb) cb({ success: true, room: room });
  });

  s.on("join-room", function (d, cb) {
    var code = String((d && d.roomId) || "").trim().toUpperCase();
    var room = rooms.get(code);
    if (!room) return cb && cb({ success: false, message: "Room not found" });
    if (room.users.length >= 20) return cb && cb({ success: false, message: "Room full" });
    if (!room.users.some(function (u) { return u.id === s.id; })) room.users.push({ id: s.id, name: (d && d.username) || "Guest" });
    s.join(code); broadcast(code);
    if (cb) cb({ success: true, room: room });
  });

  s.on("leave-room", function (d) {
    var code = String((d && d.roomId) || "").trim().toUpperCase();
    var room = rooms.get(code);
    if (!room) return;
    room.users = room.users.filter(function (u) { return u.id !== s.id; });
    s.leave(code);
    if (room.users.length === 0) rooms.delete(code);
    else { if (room.host === s.id) room.host = room.users[0].id; broadcast(code); }
  });

  s.on("add-to-queue", function (d) {
    var code = String((d && d.roomId) || "").trim().toUpperCase();
    var room = rooms.get(code);
    if (!room || !d || !d.song) return;
    room.queue.push(Object.assign({}, d.song, { addedBy: s.id }));
    if (!room.currentSong) { room.currentSong = room.queue[0]; room.isPlaying = true; room.position = 0; }
    broadcast(code);
  });

  s.on("playback-action", function (d) {
    var code = String((d && d.roomId) || "").trim().toUpperCase();
    var room = rooms.get(code);
    if (!room) return;
    room.lastSyncTime = Date.now();
    var a = d && d.action, p = d && d.position;
    if (a === "play") { room.isPlaying = true; if (d.song) { room.currentSong = d.song; room.position = p || 0; } }
    else if (a === "pause") { room.isPlaying = false; room.position = p || room.position; }
    else if (a === "resume") { room.isPlaying = true; }
    else if (a === "seek") { room.position = p || 0; }
    else if (a === "skip") { advance(room, 1); }
    else if (a === "prev") { advance(room, -1); }
    else if (a === "stop") { room.isPlaying = false; room.currentSong = null; room.position = 0; }
    broadcast(code);
  });

  s.on("set-repeat", function (d) { var r = rooms.get(String((d && d.roomId) || "").trim().toUpperCase()); if (r) { r.repeatMode = d.mode; broadcast(r.id); } });
  s.on("set-shuffle", function (d) { var r = rooms.get(String((d && d.roomId) || "").trim().toUpperCase()); if (!r) return; r.shuffleMode = !!(d && d.enabled); if (r.shuffleMode && r.queue.length > 1) { var cur = r.currentSong; var rest = r.queue.filter(function (x) { return !cur || x.id !== cur.id; }); shuffleArr(rest); r.queue = cur ? [cur].concat(rest) : rest; } broadcast(r.id); });
  s.on("set-auto-suggest", function (d) { var r = rooms.get(String((d && d.roomId) || "").trim().toUpperCase()); if (r) { r.autoSuggest = !!(d && d.enabled); broadcast(r.id); } });

  s.on("sync-time", function (d, cb) {
    var r = rooms.get(String((d && d.roomId) || "").trim().toUpperCase());
    if (!r) return;
    var el = (Date.now() - r.lastSyncTime) / 1000;
    if (cb) cb({ serverTime: Date.now(), position: r.isPlaying ? r.position + el : r.position, isPlaying: r.isPlaying });
  });

  s.on("disconnect", function () {
    for (var entry of rooms.entries()) {
      var rid = entry[0], room = entry[1];
      room.users = room.users.filter(function (u) { return u.id !== s.id; });
      if (room.users.length === 0) rooms.delete(rid);
      else { if (room.host === s.id) room.host = room.users[0].id; broadcast(rid); }
    }
  });
});

var KEY = process.env.INNERTUBE_API_KEY || "AIzaSyAO_FJ2SlqUeR5Z8QJ9JQxQ2xW7QX5mQ8A";
var CV = "1.20260820.01.00";
var SF = "EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D";
function ctx() { return { client: { clientName: "WEB_REMIX", clientVersion: CV, hl: "en", gl: "IN" } }; }
function txt(v) { if (!v) return ""; if (typeof v === "string") return v; if (v.simpleText) return v.simpleText; if (Array.isArray(v.runs)) return v.runs.map(function (r) { return r.text || ""; }).join(""); return ""; }
function thumb(item) { var t = (item && item.thumbnail && item.thumbnail.musicThumbnailRenderer && item.thumbnail.musicThumbnailRenderer.thumbnail && item.thumbnail.musicThumbnailRenderer.thumbnail.thumbnails) || (item && item.thumbnail && item.thumbnail.thumbnails) || []; return t.length ? (t[t.length - 1].url || "") : ""; }

function parseSong(item) {
  var r = item && item.musicResponsiveListItemRenderer;
  if (!r) return null;
  var fc = r.flexColumns || [];
  var title = txt(fc[0] && fc[0].musicResponsiveListItemFlexColumnRenderer && fc[0].musicResponsiveListItemFlexColumnRenderer.text);
  if (!title) return null;
  var vid = (r.playlistItemData && r.playlistItemData.videoId) || (r.navigationEndpoint && r.navigationEndpoint.watchEndpoint && r.navigationEndpoint.watchEndpoint.videoId) || "";
  if (!vid) return null;
  var artist = txt(fc[1] && fc[1].musicResponsiveListItemFlexColumnRenderer && fc[1].musicResponsiveListItemFlexColumnRenderer.text);
  return { id: vid, videoId: vid, title: title, artist: artist, thumbnail: thumb(r) };
}

function collect(node, arr) {
  if (!arr) arr = [];
  if (!node || typeof node !== "object") return arr;
  if (Array.isArray(node)) { for (var i = 0; i < node.length; i++) collect(node[i], arr); return arr; }
  if (node.musicResponsiveListItemRenderer) { var s = parseSong(node); if (s) arr.push(s); }
  var k = Object.keys(node); for (var j = 0; j < k.length; j++) collect(node[k[j]], arr);
  return arr;
}

function dedup(arr) { var seen = {}; return arr.filter(function (s) { if (!s.id || seen[s.id]) return false; seen[s.id] = true; return true; }); }

async function itReq(ep, body) {
  var url = "https://music.youtube.com/youtubei/v1/" + ep + "?key=" + KEY;
  var resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 Chrome/151", "Origin": "https://music.youtube.com", "Referer": "https://music.youtube.com/" }, body: JSON.stringify(body) });
  var txt2 = await resp.text();
  if (!resp.ok) throw new Error("InnerTube " + resp.status);
  return JSON.parse(txt2);
}

app.get("/api/search", async function (req, res) {
  try {
    var q = String(req.query.q || "").trim();
    if (!q) return res.json({ results: [] });
    var data = await itReq("search", { context: ctx(), query: q, params: SF });
    res.json({ results: dedup(collect(data)).slice(0, 30) });
  } catch (e) { console.error("[SEARCH]", e); res.status(500).json({ error: "Search failed" }); }
});

app.get("/api/suggest", async function (req, res) {
  try {
    var vid = String(req.query.videoId || "").trim();
    if (!vid) return res.json({ results: [] });
    var cached = suggestionCache.get(vid);
    if (cached && Date.now() - cached.time < 300000) return res.json({ results: cached.songs });
    var data = await itReq("next", { context: ctx(), videoId: vid });
    var contents = (data && data.contents && data.contents.singleColumnMusicWatchNextResults && data.contents.singleColumnMusicWatchNextResults.results && data.contents.singleColumnMusicWatchNextResults.results.results && data.contents.singleColumnMusicWatchNextResults.results.results.contents) || [];
    var songs = [];
    for (var i = 0; i < contents.length; i++) {
      var sec = (contents[i] && contents[i].musicShelfRenderer && contents[i].musicShelfRenderer.contents) || [];
      if (Array.isArray(sec)) for (var j = 0; j < sec.length; j++) { var f = collect(sec[j]); for (var k = 0; k < f.length; k++) songs.push(f[k]); }
    }
    songs = dedup(songs).slice(0, 20);
    suggestionCache.set(vid, { songs: songs, time: Date.now() });
    res.json({ results: songs });
  } catch (e) { console.error("[SUGGEST]", e); res.status(500).json({ error: "Suggestions failed" }); }
});

var ytPromise = null;
async function getYT() {
  if (!ytPromise) {
    var yt = require("youtubei.js");
    ytPromise = yt.Innertube.create({ generate_session_locally: true });
  }
  return ytPromise;
}

async function resolveAudio(vid) {
  var yt = await getYT();

  // Try getBasicInfo with different client options
  var info = null;
  var clients = ["ANDROID_VR", "ANDROID", "WEB", "IOS", "TV_EMBEDDED"];
  for (var i = 0; i < clients.length; i++) {
    try {
      info = await yt.getBasicInfo(vid, { client: clients[i] });
      var st = info && info.playability_status && info.playability_status.status;
      if (st === "OK") break;
      info = null;
    } catch (e) { info = null; }
  }

  if (!info) throw new Error("All clients failed for video");

  // Collect all formats
  var formats = [];
  try {
    if (info.streaming_data) {
      if (info.streaming_data.adaptive_formats) {
        for (var j = 0; j < info.streaming_data.adaptive_formats.length; j++) {
          var f = info.streaming_data.adaptive_formats[j];
          if (f.mime_type && f.mime_type.indexOf("audio") !== -1) formats.push(f);
        }
      }
      if (formats.length === 0 && info.streaming_data.formats) {
        for (var k = 0; k < info.streaming_data.formats.length; k++) {
          var f2 = info.streaming_data.formats[k];
          if (f2.mime_type && f2.mime_type.indexOf("audio") !== -1) formats.push(f2);
        }
      }
    }
  } catch (e) {}

  // Also try chooseFormat
  if (formats.length === 0) {
    try {
      var fmt = info.chooseFormat({ type: "audio", quality: "best" });
      if (fmt) formats.push(fmt);
    } catch (e) {}
  }

  if (formats.length === 0) throw new Error("No audio format found");

  // Pick best bitrate
  formats.sort(function (a, b) { return (b.bitrate || 0) - (a.bitrate || 0); });
  var best = formats[0];

  var url = null;

  // Try to get URL directly
  try { if (best.url) url = typeof best.url === "string" ? best.url : (best.url instanceof URL ? best.url.toString() : null); } catch (e) {}

  // Try decipher
  if (!url) {
    try {
      if (typeof best.decipher === "function") {
        var deciphered = await best.decipher(yt.session.player);
        if (deciphered) url = typeof deciphered === "string" ? deciphered : null;
      }
    } catch (e) {}
  }

  // Try to construct URL from signatureCipher
  if (!url && best.signature_cipher) {
    try {
      var deciphered = await best.decipher(yt.session.player);
      if (deciphered) url = typeof deciphered === "string" ? deciphered : null;
    } catch (e) {}
  }

  if (!url) throw new Error("Could not resolve playable URL");

  return {
    url: url,
    mimeType: best.mime_type || best.mimeType || null,
    bitrate: best.bitrate || best.average_bitrate || null,
    itag: best.itag || null
  };
}

app.get("/api/stream/:videoId", async function (req, res) {
  var vid = String(req.params.videoId || "").trim();
  if (!vid) return res.status(400).json({ success: false, error: "Missing video ID" });
  try {
    var r = await resolveAudio(vid);
    res.json({ success: true, videoId: vid, url: r.url, mimeType: r.mimeType, bitrate: r.bitrate, itag: r.itag });
  } catch (e) { console.error("[STREAM] " + vid, e && e.message); res.status(500).json({ success: false, error: "Stream failed", details: e && e.message }); }
});

server.listen(PORT, "0.0.0.0", function () { console.log("Server on port " + PORT); });
