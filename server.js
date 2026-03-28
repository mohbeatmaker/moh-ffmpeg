const express      = require('express');
const ffmpeg       = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const fs           = require('fs');
const path         = require('path');
const os           = require('os');
const https        = require('https');
const http         = require('http');
const { URL }      = require('url');

ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/', (req, res) => res.send('MOH FFmpeg Service — OK'));

app.post('/encode', async (req, res) => {
  const { mp3_url, video_url, width, height, duration, grayscale, slides } = req.body;

  const tmpDir     = fs.mkdtempSync(path.join(os.tmpdir(), 'moh-'));
  const mp3Path    = path.join(tmpDir, 'audio.mp3');
  const videoPath  = path.join(tmpDir, 'artist.mp4');
  const outputPath = path.join(tmpDir, 'output.mp4');
  const assPath    = path.join(tmpDir, 'subtitles.ass');

  try {
    await downloadFile(mp3_url,   mp3Path);
    await downloadFile(video_url, videoPath);

    // Vérifier que le fichier vidéo n'est pas une page HTML
    const head = fs.readFileSync(videoPath, { encoding: null }).slice(0, 20).toString('utf8');
    if (head.startsWith('<!') || head.startsWith('<h') || head.startsWith('<?')) {
      throw new Error('artist.mp4 est une page HTML — vérifier le partage Drive');
    }

    fs.writeFileSync(assPath, buildAssFile(slides || [], width, height));

    await new Promise((resolve, reject) => {
      let cmd = ffmpeg()
        .input(videoPath)
        .inputOptions(['-stream_loop -1'])
        .input(mp3Path)
        .audioCodec('aac')
        .videoCodec('libx264')
        .outputOptions([
          '-map 0:v:0',
          '-map 1:a:0',
          '-crf 28',           // compression plus agressive = fichier + petit
          '-preset ultrafast', // encode plus vite = moins de RAM
          '-movflags +faststart',
          '-pix_fmt yuv420p',
          '-threads 1',        // limite l'usage mémoire multi-thread
        ]);

      if (duration && duration > 0) cmd = cmd.duration(duration);
      else cmd = cmd.outputOptions(['-shortest']);

      const vfFilters = [
        buildCropFilter(width, height),
        `scale=${width}:${height}`,
        grayscale ? 'hue=s=0' : null,
        `ass=${assPath}`,
      ].filter(Boolean).join(',');

      cmd.videoFilters(vfFilters)
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // ✅ STREAM depuis le disque — ne charge pas le fichier en RAM
    const stat = fs.statSync(outputPath);
    res.set({
      'Content-Type':   'video/mp4',
      'Content-Length': stat.size,
    });

    const readStream = fs.createReadStream(outputPath);
    readStream.pipe(res);
    readStream.on('end', () => {
      try { fs.rmSync(tmpDir, { recursive: true }); } catch(_) {}
    });
    readStream.on('error', (e) => {
      console.error('Stream error:', e.message);
      try { fs.rmSync(tmpDir, { recursive: true }); } catch(_) {}
    });

  } catch(e) {
    console.error('Erreur:', e.message);
    try { fs.rmSync(tmpDir, { recursive: true }); } catch(_) {}
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// ─── DOWNLOAD multi-redirects + cookies ───────────────────────
function downloadFile(url, destPath, maxRedirects = 10, cookies = '') {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const lib       = parsedUrl.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      path:     parsedUrl.pathname + parsedUrl.search,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        ...(cookies ? { 'Cookie': cookies } : {}),
      },
    };

    lib.get(options, resp => {
      const setCookie  = resp.headers['set-cookie'];
      const newCookies = setCookie
        ? setCookie.map(c => c.split(';')[0]).join('; ')
        : cookies;

      if ([301, 302, 303, 307].includes(resp.statusCode)) {
        if (maxRedirects <= 0) { reject(new Error('Trop de redirections')); return; }
        const location = resp.headers.location;
        const nextUrl  = location.startsWith('http') ? location : parsedUrl.origin + location;
        resp.resume();
        downloadFile(nextUrl, destPath, maxRedirects - 1, newCookies).then(resolve).catch(reject);
      } else if (resp.statusCode === 200) {
        const file = fs.createWriteStream(destPath);
        resp.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
      } else {
        reject(new Error('HTTP ' + resp.statusCode + ' pour ' + url));
      }
    }).on('error', reject);
  });
}

function buildCropFilter(width, height) {
  if (width < height) return 'crop=ih*(9/16):ih:(iw-ih*(9/16))/2:0';
  return 'crop=iw:ih:0:0';
}

function buildAssFile(slides, width, height) {
  const fontSize = width >= 1920 ? 80 : width >= 1280 ? 60 : 50;
  let ass = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Line1,Montserrat,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,5,40,40,40,1
Style: Line2,Bebas Neue,${Math.round(fontSize*0.7)},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,5,40,40,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  for (let i = 0; i < slides.length; i++) {
    const s   = slides[i];
    const end = i + 1 < slides.length ? slides[i+1].start : 9999;
    if (s.text1) ass += `Dialogue: 0,${toAssTime(s.start)},${toAssTime(end)},Line1,,0,0,0,,{\\fad(500,500)}${s.text1}\n`;
    if (s.text2) ass += `Dialogue: 0,${toAssTime(s.start)},${toAssTime(end)},Line2,,0,0,0,,{\\fad(500,500)}${s.text2}\n`;
  }
  return ass;
}

function toAssTime(s) {
  const h  = Math.floor(s / 3600);
  const m  = Math.floor((s % 3600) / 60);
  const sc = Math.floor(s % 60);
  return `${h}:${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}.00`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('MOH FFmpeg Service démarré sur port ' + PORT));
