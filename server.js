const express      = require('express');
const ffmpeg       = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const fs           = require('fs');
const path         = require('path');
const os           = require('os');

ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
app.use(express.json({ limit: '500mb' }));

app.get('/', (req, res) => res.send('MOH FFmpeg Service — OK'));

app.post('/encode', async (req, res) => {
  const { mp3_base64, video_base64, width, height, duration, grayscale, slides, transition } = req.body;

  const tmpDir     = fs.mkdtempSync(path.join(os.tmpdir(), 'moh-'));
  const mp3Path    = path.join(tmpDir, 'audio.mp3');
  const videoPath  = path.join(tmpDir, 'artist.mp4');
  const outputPath = path.join(tmpDir, 'output.mp4');
  const assPath    = path.join(tmpDir, 'subtitles.ass');

  try {
    // Décoder les fichiers
    fs.writeFileSync(mp3Path,   Buffer.from(mp3_base64,   'base64'));
    fs.writeFileSync(videoPath, Buffer.from(video_base64, 'base64'));

    // Générer le fichier ASS pour les sous-titres/overlays texte
    const assContent = buildAssFile(slides, width, height);
    fs.writeFileSync(assPath, assContent);

    // Construire la commande FFmpeg
    await new Promise((resolve, reject) => {
      let cmd = ffmpeg()
        .input(videoPath)
        .inputOptions(['-stream_loop -1'])        // boucle la vidéo artiste
        .input(mp3Path)
        .audioCodec('aac')
        .videoCodec('libx264')
        .outputOptions([
          '-map 0:v:0',
          '-map 1:a:0',
          '-crf 23',
          '-preset fast',
          '-movflags +faststart',
          '-pix_fmt yuv420p',
        ]);

      // Durée : soit fixe (Instagram 59s) soit durée du MP3
      if (duration && duration > 0) {
        cmd = cmd.duration(duration);
      } else {
        cmd = cmd.outputOptions(['-shortest']); // s'arrête quand le MP3 se termine
      }

      // Filtre vidéo : crop + scale + N&B + overlay texte ASS
      const cropFilter = buildCropFilter(width, height);
      const vfFilters  = [
        cropFilter,
        `scale=${width}:${height}`,
        grayscale ? 'hue=s=0' : null,            // N&B
        `ass=${assPath}`,                         // overlay textes
      ].filter(Boolean).join(',');

      cmd
        .videoFilters(vfFilters)
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // Renvoyer le MP4 encodé
    const outputBuffer = fs.readFileSync(outputPath);
    res.set('Content-Type', 'video/mp4');
    res.send(outputBuffer);

  } catch(e) {
    console.error('Erreur FFmpeg :', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    // Nettoyage
    try { fs.rmSync(tmpDir, { recursive: true }); } catch(_) {}
  }
});

// ─── CROP INTELLIGENT SELON FORMAT ────────────────────────────
// YouTube 16:9 : pas de crop (déjà horizontal)
// Instagram 9:16 : crop centre vertical depuis vidéo horizontale
function buildCropFilter(width, height) {
  if (width < height) {
    // Format vertical 9:16 : crop la partie centrale
    // Depuis une vidéo 16:9 (ex 1920x1080), on prend la hauteur totale
    // et on calcule la largeur proportionnelle
    return 'crop=ih*(9/16):ih:(iw-ih*(9/16))/2:0';
  }
  // Format horizontal : pas de crop nécessaire
  return 'crop=iw:ih:0:0';
}

// ─── GÉNÉRATION FICHIER ASS (sous-titres stylisés) ────────────
function buildAssFile(slides, width, height) {
  const fontSize = width >= 1920 ? 80 : width >= 1280 ? 60 : 50;
  const isVertical = height > width;

  let ass = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
Collisions: Normal

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Line1,Montserrat,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,5,40,40,40,1
Style: Line2,Bebas Neue,${Math.round(fontSize * 0.7)},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,5,40,40,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  for (let i = 0; i < slides.length; i++) {
    const slide   = slides[i];
    const start   = slide.start;
    const end     = i + 1 < slides.length ? slides[i + 1].start : 9999;
    const startTs = toAssTime(start);
    const endTs   = toAssTime(end);

    if (slide.text1) {
      ass += `Dialogue: 0,${startTs},${endTs},Line1,,0,0,0,,{\\fad(500,500)}${slide.text1}\n`;
    }
    if (slide.text2) {
      ass += `Dialogue: 0,${startTs},${endTs},Line2,,0,0,0,,{\\fad(500,500)}${slide.text2}\n`;
    }
  }

  return ass;
}

function toAssTime(seconds) {
  const h   = Math.floor(seconds / 3600);
  const m   = Math.floor((seconds % 3600) / 60);
  const s   = Math.floor(seconds % 60);
  const cs  = '00'; // centisecondes
  return `${String(h).padStart(1,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${cs}`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('MOH FFmpeg Service démarré sur port ' + PORT));
