const https = require('https');
const http = require('http');

app.get("/api/stream/:videoId", async (req, res) => {
  const videoId = String(req.params.videoId || "").trim();
  if (!videoId) return res.status(400).json({ success: false, error: "Invalid video ID." });

  try {
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
          const adaptiveFormats = data.adaptiveFormats || [];
          const audioFormat = adaptiveFormats
            .filter(f => f.type && f.type.startsWith("audio/"))
            .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

          if (audioFormat && audioFormat.url) {
            audioUrl = audioFormat.url;
            break;
          }
        }
      } catch (err) {}
    }

    if (!audioUrl) {
      return res.status(500).json({ success: false, error: "Could not resolve stream URL" });
    }

    // Proxy the stream cleanly so the phone gets binary audio data, avoiding 403 blocks
    const targetUrl = new URL(audioUrl);
    const proxyReq = https.request({
      hostname: targetUrl.hostname,
      path: targetUrl.pathname + targetUrl.search,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Range": req.headers.range || "bytes=0-"
      }
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, {
        "Content-Type": proxyRes.headers["content-type"] || "audio/mpeg",
        "Content-Length": proxyRes.headers["content-length"],
        "Accept-Ranges": "bytes"
      });
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      if (!res.headersSent) res.status(500).json({ success: false, error: "Streaming proxy failed" });
    });

    proxyReq.end();
  } catch (error) {
    console.error("[STREAM ERROR]", error);
    if (!res.headersSent) res.status(500).json({ success: false, error: "Unable to stream." });
  }
});
