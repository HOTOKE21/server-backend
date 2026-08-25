const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingInterval: 5000,
  pingTimeout: 3000,
});

const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

app.get("/", (_, res) => res.json({ ok: true, message: "Focus Music Server" }));
app.get("/health", (_, res) => res.json({ ok: true, status: "online" }));

const rooms = new Map();
const suggestionCache = new Map();

function generateRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let i = 0; i < 5; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(id) ? generateRoomId() : id;
}

function broadcastRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  io.to(roomId).emit("room-updated", Object.assign({}, room, { serverTime: Date.now() }));
}

function advanceQueue(room, direction) {
  if (room.repeatMode === "one") {
    room.position = 0;
    room.isPlaying = true;
    room.lastSyncTime = Date.now();
    return;
  }
  var idx = room.queue.findIndex(function (s) { return s.id === (room.currentSong && room.currentSong.id); });
  if (direction > 0) {
    if (idx < room.queue.length - 1) room.currentSong = room.queue[idx + 1];
    else if (room.repeatMode === "all") room.currentSong = room.queue[0];
    else { room.isPlaying = false; room.currentSong = null; }
  } else {
    if (idx > 0) room.currentSong = room.queue[idx - 1];
    else if (room.repeatMode === "all") room.currentSong = room.queue[room.queue.length - 1];
  }
  room.position = 0;
  room.isPlaying = !!room.currentSong;
  room.lastSyncTime = Date.now();
}

function shuffleArray(arr) {
  for (var i = arr.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var temp = arr[i]; arr[i] = arr[j]; arr[j] = temp;
  }
}

io.on("connection", function (socket) {
  console.log("[SOCKET] Connected:", socket.id);

  socket.on("create-room", function (data, callback) {
    var username = data && data.username;
    var roomId = generateRoomId();
    var room = {
      id: roomId, host: socket.id,
      users: [{ id: socket.id, name: username || "Host" }],
      queue: [], currentSong: null, isPlaying: false, position: 0,
      repeatMode: "none", shuffleMode: false, autoSuggest: true,
      lastSyncTime: Date.now(),
    };
    rooms.set(roomId, room);
    socket.join(roomId);
    if (callback) callback({ success: true, room: room });
  });

  socket.on("join-room", function (data, callback) {
    var code = String((data && data.roomId) || "").trim().toUpperCase();
    var room = rooms.get(code);
    if (!room) return callback && callback({ success: false, message: "Room not found" });
    if (room.users.length >= 20) return callback && callback({ success: false, message: "Room full" });
    var alreadyIn = room.users.some(function (u) { return u.id === socket.id; });
    if (!alreadyIn) room.users.push({ id: socket.id, name: (data && data.username) || "Guest" });
    socket.join(code);
    broadcastRoom(code);
    if (callback) callback({ success: true, room: room });
  });

  socket.on("leave-room", function (data) {
    var code = String((data && data.roomId) || "").trim().toUpperCase();
    var room = rooms.get(code);
    if (!room) return;
    room.users = room.users.filter(function (u) { return u.id !== socket.id; });
    socket.leave(code);
    if (room.users.length === 0) rooms.delete(code);
    else {
      if (room.host === socket.id) room.host = room.users[0].id;
      broadcastRoom(code);
    }
  });

  socket.on("add-to-queue", function (data) {
    var code = String((data && data.roomId) || "").trim().toUpperCase();
    var room = rooms.get(code);
    if (!room || !data || !data.song) return;
    room.queue.push(Object.assign({}, data.song, { addedBy: socket.id }));
    if (!room.currentSong) { room.currentSong = room.queue[0]; room.isPlaying = true; room.position = 0; }
    broadcastRoom(code);
  });

  socket.on("playback-action", function (data) {
    var code = String((data && data.roomId) || "").trim().toUpperCase();
    var room = rooms.get(code);
    if (!room) return;
    room.lastSyncTime =
