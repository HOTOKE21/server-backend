// --- AUDIO STREAM RESOLVER ENDPOINT ---
app.get("/api/stream/:videoId", async (req, res) => {
  const videoId = String(req.params.videoId || "").trim();
  if (!videoId) return res.status(400).json({ success: false, error: "Invalid video ID." });

  try {
    // Use an active public piped instance API which is highly reliable for audio extraction
    const pipedApiUrl = `https://pipedapi.kavin.rocks/streams/${videoId}`;
    const response = await fetch(pipedApiUrl);
    
    if (!response.ok) {
      throw new Error("Failed to fetch stream from Piped API");
    }

    const data = await response.json();
    const audioStreams = (data.audioStreams || []).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    
    const audioUrl = audioStreams[0]?.url;

    if (!audioUrl) {
      return res.status(500).json({ success: false, error: "Could not resolve stream URL" });
    }

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

    proxyReq.on('error', () => {
      if (!res.headersSent) res.status(500).json({ success: false, error: "Streaming proxy failed" });
    });

    proxyReq.end();
  } catch (error) {
    console.error("[STREAM ERROR]", error);
    if (!res.headersSent) res.status(500).json({ success: false, error: "Unable to stream." });
  }
});
