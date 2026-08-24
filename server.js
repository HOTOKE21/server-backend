const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

/* =========================
   BASIC TEST ROUTES
========================= */

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "Focus Music Server is running"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: "online"
  });
});

/* =========================
   ROOMS
========================= */

const rooms = new Map();

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("create-room", ({ username }, callback) => {
    const roomId = Math.random()
      .toString(36)
      .substring(2, 8)
      .toUpperCase();

    const room = {
      id: roomId,
      host: socket.id,
      users: [
        {
          id: socket.id,
          name: username || "Host"
        }
      ],
      queue: [],
      currentSong: null,
      isPlaying: false,
      position: 0
    };

    rooms.set(roomId, room);
    socket.join(roomId);

    if (callback) {
      callback({
        success: true,
        room: room
      });
    }
  });

  socket.on("join-room", ({ roomId, username }, callback) => {
    const code = String(roomId || "")
      .trim()
      .toUpperCase();

    const room = rooms.get(code);

    if (!room) {
      if (callback) {
        callback({
          success: false,
          message: "Room not found"
        });
      }

      return;
    }

    if (!room.users.some((u) => u.id === socket.id)) {
      room.users.push({
        id: socket.id,
        name: username || "Guest"
      });
    }

    socket.join(code);

    io.to(code).emit("room-updated", room);

    if (callback) {
      callback({
        success: true,
        room: room
      });
    }
  });

  socket.on("leave-room", ({ roomId }) => {
    const code = String(roomId || "")
      .trim()
      .toUpperCase();

    const room = rooms.get(code);

    if (!room) return;

    room.users = room.users.filter(
      (user) => user.id !== socket.id
    );

    socket.leave(code);

    if (room.users.length === 0) {
      rooms.delete(code);
    } else {
      io.to(code).emit("room-updated", room);
    }
  });

  socket.on("add-to-queue", ({ roomId, song }) => {
    const code = String(roomId || "")
      .trim()
      .toUpperCase();

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

  socket.on(
    "playback-action",
    ({ roomId, action, song, position }) => {
      const code = String(roomId || "")
        .trim()
        .toUpperCase();

      const room = rooms.get(code);

      if (!room) return;

      if (typeof position === "number") {
        room.position = Math.max(0, position);
      }

      if (action === "play") {
        room.isPlaying = true;

        if (song) {
          room.currentSong = song;
          room.position = 0;
        }
      }

      if (action === "pause") {
        room.isPlaying = false;
      }

      if (action === "seek") {
        if (typeof position === "number") {
          room.position = Math.max(0, position);
        }
      }

      if (action === "skip") {
        if (room.queue.length > 0) {
          room.queue.shift();
        }

        room.currentSong =
          room.queue[0] || null;

        room.isPlaying =
          !!room.currentSong;

        room.position = 0;
      }

      io.to(code).emit("room-updated", room);
    }
  );

  socket.on("disconnect", () => {
    console.log(
      "Client disconnected:",
      socket.id
    );

    for (const [roomId, room] of rooms.entries()) {
      room.users = room.users.filter(
        (user) => user.id !== socket.id
      );

      if (room.users.length === 0) {
        rooms.delete(roomId);
      } else {
        io.to(roomId).emit(
          "room-updated",
          room
        );
      }
    }
  });
});

/* =========================
   YOUTUBE MUSIC SEARCH
========================= */

const INNERTUBE_API_KEY =
  process.env.INNERTUBE_API_KEY || "";

const CLIENT_VERSION =
  "1.20260820.01.00";

const SEARCH_FILTER =
  "EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D";

function makeContext() {
  return {
    client: {
      clientName: "WEB_REMIX",
      clientVersion: CLIENT_VERSION,
      hl: "en",
      gl: "IN"
    }
  };
}

function getText(value) {
  if (!value) return "";

  if (typeof value === "string") {
    return value;
  }

  if (value.simpleText) {
    return value.simpleText;
  }

  if (Array.isArray(value.runs)) {
    return value.runs
      .map((r) => r.text || "")
      .join("");
  }

  return "";
}

function getThumbnail(item) {
  const thumbnails =
    item?.thumbnail
      ?.musicThumbnailRenderer
      ?.thumbnail
      ?.thumbnails ||
    item?.thumbnail?.thumbnails ||
    [];

  if (!thumbnails.length) {
    return "";
  }

  return thumbnails[
    thumbnails.length - 1
  ]?.url || "";
}

function parseSong(item) {
  const renderer =
    item?.musicResponsiveListItemRenderer;

  if (!renderer) {
    return null;
  }

  const flexColumns =
    renderer.flexColumns || [];

  const title = getText(
    flexColumns[0]
      ?.musicResponsiveListItemFlexColumnRenderer
      ?.text
  );

  if (!title) {
    return null;
  }

  const videoId =
    renderer.playlistItemData?.videoId ||
    renderer.navigationEndpoint
      ?.watchEndpoint?.videoId ||
    renderer.onTap
      ?.innertubeCommand
      ?.watchEndpoint?.videoId ||
    "";

  if (!videoId) {
    return null;
  }

  const artist = getText(
    flexColumns[1]
      ?.musicResponsiveListItemFlexColumnRenderer
      ?.text
  );

  return {
    id: videoId,
    title: title,
    artist: artist,
    thumbnail: getThumbnail(renderer),
    videoId: videoId
  };
}

function collectSongs(
  node,
  songs = []
) {
  if (!node ||
      typeof node !== "object") {
    return songs;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectSongs(item, songs);
    }

    return songs;
  }

  if (node.musicResponsiveListItemRenderer) {
    const song = parseSong(node);

    if (song) {
      songs.push(song);
    }
  }

  for (const key of Object.keys(node)) {
    collectSongs(
      node[key],
      songs
    );
  }

  return songs;
}

function removeDuplicates(songs) {
  const seen = new Set();

  return songs.filter((song) => {
    if (!song.id ||
        seen.has(song.id)) {
      return false;
    }

    seen.add(song.id);
    return true;
  });
}

async function innerTubeRequest(
  endpoint,
  body
) {
  if (!INNERTUBE_API_KEY) {
    throw new Error(
      "INNERTUBE_API_KEY is not configured."
    );
  }

  const url =
    `https://music.youtube.com/youtubei/v1/${endpoint}` +
    `?key=${INNERTUBE_API_KEY}`;

  const response = await fetch(
    url,
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json",

        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
          "AppleWebKit/537.36 " +
          "Chrome/151 Safari/537.36",

        "Origin":
          "https://music.youtube.com",

        "Referer":
          "https://music.youtube.com/"
      },

      body: JSON.stringify(body)
    }
  );

  const text =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `InnerTube request failed: ${response.status}`
    );
  }

  return JSON.parse(text);
}

app.get(
  "/api/search",
  async (req, res) => {
    try {
      const query =
        String(
          req.query.q || ""
        ).trim();

      if (!query) {
        return res.json({
          results: []
        });
      }

      const data =
        await innerTubeRequest(
          "search",
          {
            context:
              makeContext(),

            query: query,

            params:
              SEARCH_FILTER
          }
        );

      const songs =
        removeDuplicates(
          collectSongs(data)
        ).slice(0, 30);

      res.json({
        results: songs
      });

    } catch (error) {
      console.error(
        "Search error:",
        error
      );

      res.status(500).json({
        error:
          "Music search failed.",
        details:
          error.message
      });
    }
  }
);

/* =========================
   AUDIO STREAM ENDPOINT
========================= */

app.get(
  "/api/stream/:videoId",
  (req, res) => {

    const videoId =
      String(
        req.params.videoId || ""
      ).trim();

    if (!videoId) {
      return res.status(400).json({
        error:
          "Missing video ID"
      });
    }

    /*
     * This endpoint is intentionally
     * for audio that you are authorized
     * to host.
     */

    return res.status(404).json({
      error:
        "No audio source configured",

      message:
        "The search server works, but a directly playable authorized audio URL has not been configured yet.",

      videoId:
        videoId
    });
  }
);

/* =========================
   START SERVER
========================= */

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Focus music server running on port ${PORT}`
    );
  }
);
