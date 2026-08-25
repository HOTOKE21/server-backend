import express from "express";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";
import { Innertube } from "youtubei.js";

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

/* =========================================================
   BASIC ROUTES
   ========================================================= */

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "Focus Music Server is running",
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: "online",
  });
});

/* =========================================================
   SOCKET.IO ROOMS
   ========================================================= */

const rooms = new Map();

io.on("connection", (socket) => {
  console.log("[SOCKET] Client connected:", socket.id);

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
          name: username || "Host",
        },
      ],
      queue: [],
      currentSong: null,
      isPlaying: false,
      position: 0,
    };

    rooms.set(roomId, room);
    socket.join(roomId);

    callback?.({
      success: true,
      room,
    });
  });

  socket.on("join-room", ({ roomId, username }, callback) => {
    const code = String(roomId || "")
      .trim()
      .toUpperCase();

    const room = rooms.get(code);

    if (!room) {
      callback?.({
        success: false,
        message: "Room not found",
      });
      return;
    }

    if (!room.users.some((user) => user.id === socket.id)) {
      room.users.push({
        id: socket.id,
        name: username || "Guest",
      });
    }

    socket.join(code);

    io.to(code).emit("room-updated", room);

    callback?.({
      success: true,
      room,
    });
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

      io.to(code).emit(
        "room-updated",
        room
      );
    }
  );

  socket.on("disconnect", () => {
    console.log(
      "[SOCKET] Client disconnected:",
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

/* =========================================================
   YOUTUBE MUSIC SEARCH
   ========================================================= */

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
      gl: "IN",
    },
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
      .map((run) => run.text || "")
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

  return (
    thumbnails[thumbnails.length - 1]
      ?.url || ""
  );
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
    videoId,
    title,
    artist,
    thumbnail: getThumbnail(renderer),
  };
}

function collectSongs(node, songs = []) {
  if (!node || typeof node !== "object") {
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
    collectSongs(node[key], songs);
  }

  return songs;
}

function removeDuplicates(songs) {
  const seen = new Set();

  return songs.filter((song) => {
    if (!song.id || seen.has(song.id)) {
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

  const response = await fetch(url, {
    method: "POST",

    headers: {
      "Content-Type": "application/json",

      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 " +
        "Chrome/151 Safari/537.36",

      Origin:
        "https://music.youtube.com",

      Referer:
        "https://music.youtube.com/",
    },

    body: JSON.stringify(body),
  });

  const text = await response.text();

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
        String(req.query.q || "")
          .trim();

      if (!query) {
        return res.json({
          results: [],
        });
      }

      const data =
        await innerTubeRequest(
          "search",
          {
            context: makeContext(),
            query,
            params: SEARCH_FILTER,
          }
        );

      const songs =
        removeDuplicates(
          collectSongs(data)
        ).slice(0, 30);

      return res.json({
        results: songs,
      });

    } catch (error) {
      console.error(
        "[SEARCH] Error:",
        error
      );

      return res.status(500).json({
        error:
          "Music search failed.",
        details:
          error?.message ||
          String(error),
      });
    }
  }
);

/* =========================================================
   YOUTUBE AUDIO RESOLUTION
   ========================================================= */

let youtubePromise = null;

async function getYouTube() {
  if (!youtubePromise) {
    youtubePromise =
      Innertube.create({
        generate_session_locally: true,
      });
  }

  return youtubePromise;
}

function normalizeUrl(value) {
  if (!value) return null;

  if (value instanceof URL) {
    return value.toString();
  }

  if (typeof value !== "string") {
    return null;
  }

  const text = value.trim();

  if (!text) {
    return null;
  }

  if (
    text.startsWith("https://") ||
    text.startsWith("http://")
  ) {
    return text;
  }

  return null;
}

async function resolveAudio(videoId) {
  const youtube =
    await getYouTube();

  console.log(
    `[STREAM] getBasicInfo ${videoId}`
  );

  const info =
    await youtube.getBasicInfo(
      videoId,
      {
        client: "ANDROID_VR",
      }
    );

  const status =
    info?.playability_status?.status;

  const reason =
    info?.playability_status?.reason || "";

  console.log(
    `[STREAM] Playability: ${
      status || "unknown"
    } ${reason}`
  );

  if (
    status &&
    status !== "OK"
  ) {
    throw new Error(
      `YouTube playability: ${status} ${reason}`
    );
  }

  const format =
    info.chooseFormat({
      type: "audio",
      quality: "best",
      format: "any",
    });

  if (!format) {
    throw new Error(
      "No audio format available."
    );
  }

  console.log(
    `[STREAM] Selected itag=${format.itag || "unknown"} ` +
    `mime=${format.mime_type || format.mimeType || "unknown"}`
  );

  let url = null;

  /*
   * youtubei.js can expose decipher()
   * for formats whose URL requires
   * YouTube player signature processing.
   */
  try {
    if (
      typeof format.decipher ===
      "function"
    ) {
      url =
        await format.decipher(
          youtube.session.player
        );
    }
  } catch (error) {
    console.error(
      "[STREAM] Decipher failed:",
      error?.message ||
        error
    );
  }

  /*
   * Some formats already expose a
   * complete URL.
   */
  if (!url) {
    url =
      normalizeUrl(format.url);
  } else {
    url =
      normalizeUrl(url);
  }

  if (!url) {
    throw new Error(
      "Audio format returned without a playable URL."
    );
  }

  return {
    url,

    mimeType:
      format.mime_type ||
      format.mimeType ||
      null,

    bitrate:
      format.bitrate ||
      format.average_bitrate ||
      format.averageBitrate ||
      null,

    contentLength:
      format.content_length ||
      format.contentLength ||
      null,

    itag:
      format.itag ||
      null,
  };
}

app.get(
  "/api/stream/:videoId",
  async (req, res) => {
    const videoId =
      String(
        req.params.videoId ||
          ""
      ).trim();

    if (!videoId) {
      return res.status(400).json({
        success: false,
        error:
          "Missing video ID",
      });
    }

    console.log(
      `[STREAM] Resolving ${videoId}`
    );

    try {
      const result =
        await resolveAudio(
          videoId
        );

      console.log(
        `[STREAM] Successfully resolved ${videoId}`
      );

      return res.json({
        success: true,
        videoId,

        url:
          result.url,

        mimeType:
          result.mimeType,

        bitrate:
          result.bitrate,

        contentLength:
          result.contentLength,

        itag:
          result.itag,
      });

    } catch (error) {
      console.error(
        `[STREAM] Failed for ${videoId}:`,
        error?.stack ||
          error
      );

      return res.status(500).json({
        success: false,

        error:
          "Unable to resolve audio stream",

        details:
          error?.message ||
          String(error),

        videoId,
      });
    }
  }
);

/* =========================================================
   SERVER START
   ========================================================= */

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Focus music server running on port ${PORT}`
    );
  }
);
