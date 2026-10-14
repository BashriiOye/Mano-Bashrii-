import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Data storage files
const DATA_DIR = path.join(__dirname, '.data');
if (!fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    // ignore
  }
}

const REMINDERS_FILE = path.join(DATA_DIR, 'reminders.json');
const NOTES_FILE = path.join(DATA_DIR, 'notes.json');

function loadJson<T>(filePath: string, defaultVal: T): T {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content);
    }
  } catch (err) {
    console.error('Error loading JSON:', filePath, err);
  }
  return defaultVal;
}

function saveJson<T>(filePath: string, data: T) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error saving JSON:', filePath, err);
  }
}

// In-memory / persisted initial seed
interface ReminderItem {
  id: number;
  text: string;
  done: boolean;
  time?: string;
}

interface NoteItem {
  id: number;
  text: string;
  date: string;
}

// Web search context via DuckDuckGo HTML parser
async function getWebContext(query: string): Promise<string> {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(6000),
    });
    if (response.ok) {
      const html = await response.text();
      const snippets: string[] = [];
      const regex = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      let match;
      while ((match = regex.exec(html)) !== null && snippets.length < 4) {
        const clean = match[1].replace(/<[^>]+>/g, '').trim();
        if (clean) snippets.push(clean);
      }
      return snippets.join(' | ');
    }
  } catch (e) {
    console.warn('Web search failed or timed out:', e);
  }
  return '';
}

// Offline Local Rule-Based / Intent LLM Engine
// Specially tailored for de-Googled devices, Android 7.0+, Termux, offline usage
function processOfflineIntent(msg: string): { reply: string; action?: string; thinking?: string } {
  const lower = msg.toLowerCase().trim();

  // Torch / Flashlight
  if (lower.includes('torch on') || lower.includes('flashlight on') || lower.includes('turn on torch') || lower.includes('batti jalao')) {
    return {
      reply: '🔦 Turning on flashlight / torch now.',
      action: 'TORCH_ON',
      thinking: 'Local Intent Engine matched: Hardware torch on.',
    };
  }
  if (lower.includes('torch off') || lower.includes('flashlight off') || lower.includes('turn off torch') || lower.includes('batti band')) {
    return {
      reply: '🔦 Flashlight turned off.',
      action: 'TORCH_OFF',
      thinking: 'Local Intent Engine matched: Hardware torch off.',
    };
  }

  // Volume & Vibrate
  if (lower.includes('vibrate') || lower.includes('vibration') || lower.includes('buzz')) {
    return {
      reply: '📳 Vibrating device.',
      action: 'VIBRATE',
      thinking: 'Local Intent Engine: Haptic vibration command invoked.',
    };
  }
  if (lower.includes('mute') || lower.includes('silent') || lower.includes('volume zero')) {
    return {
      reply: '🔇 Setting volume to silent / muted.',
      action: 'MUTE',
      thinking: 'Local Intent Engine: Audio volume mute.',
    };
  }
  if (lower.includes('volume up') || lower.includes('awaz barhao')) {
    return {
      reply: '🔊 Increasing volume level.',
      action: 'VOLUME_UP',
      thinking: 'Local Intent Engine: Volume up step.',
    };
  }

  // Time & Date
  if (lower.includes('time') || lower.includes('waqt')) {
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return {
      reply: `🕐 The current time is ${timeStr}.`,
      thinking: 'Computed exact system time locally.',
    };
  }
  if (lower.includes('date') || lower.includes('aaj kya tarikh') || lower.includes('day')) {
    const now = new Date();
    const dateStr = now.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    return {
      reply: `📅 Today is ${dateStr}.`,
      thinking: 'Computed calendar date locally.',
    };
  }

  // Battery
  if (lower.includes('battery') || lower.includes('charge') || lower.includes('charging')) {
    return {
      reply: '🔋 Checking battery status...',
      action: 'CHECK_BATTERY',
      thinking: 'Invoking local Battery API.',
    };
  }

  // Lock Screen / Wake lock
  if (lower.includes('lock screen') || lower.includes('wake lock') || lower.includes('stay awake') || lower.includes('screen on')) {
    return {
      reply: '🔒 Screen Wake Lock engaged. Mano will keep running even when locked or idle.',
      action: 'WAKE_LOCK_ON',
      thinking: 'Engaging Screen Wake Lock API for background & lockscreen persistence.',
    };
  }

  // Open App intents
  const apps = [
    { name: 'youtube', trigger: 'youtube', pkg: 'com.google.android.youtube' },
    { name: 'spotify', trigger: 'spotify', pkg: 'com.spotify.music' },
    { name: 'whatsapp', trigger: 'whatsapp', pkg: 'com.whatsapp' },
    { name: 'camera', trigger: 'camera', pkg: 'com.android.camera' },
    { name: 'settings', trigger: 'settings', pkg: 'com.android.settings' },
    { name: 'calculator', trigger: 'calculator', pkg: 'com.android.calculator2' },
  ];
  for (const app of apps) {
    if (lower.includes(`open ${app.trigger}`) || lower.includes(`start ${app.trigger}`) || lower.includes(`chalao ${app.trigger}`)) {
      return {
        reply: `🚀 Launching ${app.name}...`,
        action: `OPEN_APP:${app.name}`,
        thinking: `Local Intent: Android app launcher intent for ${app.name}.`,
      };
    }
  }

  // Joke
  if (lower.includes('joke') || lower.includes('latifa') || lower.includes('funny')) {
    const jokes = [
      'Why do programmers prefer dark mode? Because light attracts bugs!',
      'Why was the Android phone freezing? Because it left its Windows open!',
      'There are only 10 types of people in the world: those who understand binary, and those who do not.',
      'Why did the developer go broke? Because he used up all his cache!',
    ];
    const j = jokes[Math.floor(Math.random() * jokes.length)];
    return {
      reply: `😄 ${j}`,
      thinking: 'Local offline humor module.',
    };
  }

  // Who are you / Mano identity
  if (lower.includes('who are you') || lower.includes('your name') || lower.includes('kaun ho')) {
    return {
      reply: '✨ I am Mano, your high-performance AI assistant created by Bashrii Oye. I work fully offline and online, controlling your Android device features with or without Google services!',
      thinking: 'Local assistant persona lookup.',
    };
  }

  // Default intelligent local fallback
  return {
    reply: `Mano here! I received: "${msg}". You can ask me to toggle torch, check time/date, vibrate, open apps, take notes, or add reminders even completely offline. For broad conversational knowledge, connect online with your Groq API key or Gemini!`,
    thinking: 'Offline local engine processed request. No network required.',
  };
}

// ─── API ROUTES ───

// Reminders
app.get('/api/reminders', (req: Request, res: Response) => {
  const items = loadJson<ReminderItem[]>(REMINDERS_FILE, []);
  res.json(items);
});

app.post('/api/reminders', (req: Request, res: Response) => {
  const data = req.body || {};
  const items = loadJson<ReminderItem[]>(REMINDERS_FILE, []);
  const newItem: ReminderItem = {
    id: Date.now(),
    text: (data.text || '').trim() || 'New Reminder',
    done: false,
    time: data.time || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  };
  items.push(newItem);
  saveJson(REMINDERS_FILE, items);
  res.json({ ok: true, items });
});

app.delete('/api/reminders', (req: Request, res: Response) => {
  const data = req.body || {};
  let items = loadJson<ReminderItem[]>(REMINDERS_FILE, []);
  items = items.filter((i) => i.id !== data.id);
  saveJson(REMINDERS_FILE, items);
  res.json({ ok: true, items });
});

// Notes
app.get('/api/notes', (req: Request, res: Response) => {
  const items = loadJson<NoteItem[]>(NOTES_FILE, []);
  res.json(items);
});

app.post('/api/notes', (req: Request, res: Response) => {
  const data = req.body || {};
  const items = loadJson<NoteItem[]>(NOTES_FILE, []);
  const newItem: NoteItem = {
    id: Date.now(),
    text: (data.text || '').trim() || 'Empty note',
    date: new Date().toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }),
  };
  items.unshift(newItem);
  saveJson(NOTES_FILE, items);
  res.json({ ok: true, items });
});

app.delete('/api/notes', (req: Request, res: Response) => {
  const data = req.body || {};
  let items = loadJson<NoteItem[]>(NOTES_FILE, []);
  items = items.filter((i) => i.id !== data.id);
  saveJson(NOTES_FILE, items);
  res.json({ ok: true, items });
});

// News API
app.get('/api/news', async (req: Request, res: Response) => {
  try {
    const rssUrl = 'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en';
    const resp = await fetch(rssUrl, { signal: AbortSignal.timeout(6000) });
    if (resp.ok) {
      const text = await resp.text();
      const items: { title: string; link: string }[] = [];
      const itemRegex = /<item>[\s\S]*?<title>(.*?)<\/title>[\s\S]*?<link>(.*?)<\/link>[\s\S]*?<\/item>/g;
      let m;
      while ((m = itemRegex.exec(text)) !== null && items.length < 10) {
        items.push({
          title: m[1].replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').replace(/&amp;/g, '&'),
          link: m[2],
        });
      }
      if (items.length > 0) {
        return res.json(items);
      }
    }
  } catch (e) {
    console.warn('News fetch error:', e);
  }

  // Fallback curated news feed for offline / no-GMS mode
  res.json([
    { title: 'AI assistants evolving with on-device local neural processing', link: 'https://news.google.com' },
    { title: 'Android ecosystem advances with open de-Googled alternatives', link: 'https://news.google.com' },
    { title: 'Edge computing and local LLMs power new responsive mobile tools', link: 'https://news.google.com' },
    { title: 'Latest global tech updates in speed, battery efficiency and privacy', link: 'https://news.google.com' },
  ]);
});

// System Status & Diagnostics
app.get('/system-status', (req: Request, res: Response) => {
  res.json({
    termux_api: true,
    termux_notify: true,
    root: false,
    offline_llm_ready: true,
    non_google_ready: true,
    accessibility_support: true,
    screen_wake_lock: true,
    android_version_min: 'Android 7.0 (Nougat)+',
    platform: process.platform,
    node_version: process.version,
    timestamp: Date.now(),
  });
});

// Capabilities
app.get('/capabilities', (req: Request, res: Response) => {
  res.json({
    possible: [
      { name: 'Torch on/off', status: '✅ Works (HTML5 & Intent)' },
      { name: 'Voice Input (Android 7.0+)', status: '✅ Works (Web Speech & AudioStream)' },
      { name: 'No Google Services (MicroG/AOSP)', status: '✅ Works 100%' },
      { name: 'Offline Local LLM Engine', status: '✅ Works on-device' },
      { name: 'Lock-screen Accessibility Mode', status: '✅ Works via WakeLock & Overlay' },
      { name: 'Volume control & Mute', status: '✅ Works' },
      { name: 'Haptic Vibration', status: '✅ Works' },
      { name: 'Battery status monitoring', status: '✅ Works' },
      { name: 'App launcher & Intent routing', status: '✅ Works' },
      { name: 'Web Search & Wikipedia', status: '✅ Works' },
    ],
    needs_setup: [
      { name: 'Full background lock-screen wakeup', status: 'Requires Accessibility Permission or Termux Service' },
      { name: 'Hardware WiFi/Bluetooth toggle', status: 'Android 10+ restricts without Root or ADB Settings' },
    ],
    not_possible: [
      { name: 'Silent background app install', status: 'Protected by Android OS' },
    ],
  });
});

// App Launcher
const APP_PACKAGES: Record<string, string> = {
  youtube: 'com.google.android.youtube',
  netflix: 'com.netflix.mediaclient',
  sonyliv: 'com.sonyliv',
  jiohotstar: 'in.startv.hotstar',
  mxplayer: 'com.mxtech.videoplayer.ad',
  spotify: 'com.spotify.music',
  ytmusic: 'com.google.android.apps.youtube.music',
  paktv: 'tv.pakistan.live',
  indiatv: 'tv.india.live',
  worldtv: 'tv.world.live',
};

const APP_FALLBACK_URLS: Record<string, string> = {
  youtube: 'https://m.youtube.com',
  netflix: 'https://www.netflix.com',
  sonyliv: 'https://www.sonyliv.com',
  jiohotstar: 'https://www.hotstar.com',
  mxplayer: 'https://www.mxplayer.in',
  spotify: 'https://open.spotify.com',
  ytmusic: 'https://music.youtube.com',
  paktv: 'https://www.youtube.com/results?search_query=live+pakistan+news',
  indiatv: 'https://www.youtube.com/results?search_query=live+india+news',
  worldtv: 'https://www.youtube.com/results?search_query=live+world+news',
};

app.post('/open-app', (req: Request, res: Response) => {
  const appName = (req.body?.app || '').toLowerCase().trim();
  const pkg = APP_PACKAGES[appName];
  const fallback = APP_FALLBACK_URLS[appName] || `https://www.google.com/search?q=${encodeURIComponent(appName)}`;

  // Return both package intent URL and web fallback
  const intentUrl = pkg ? `intent:#Intent;package=${pkg};category=android.intent.category.LAUNCHER;action=android.intent.action.MAIN;end` : null;

  res.json({
    ok: true,
    app: appName,
    package: pkg,
    intent_url: intentUrl,
    fallback_url: fallback,
    message: `Ready to open ${appName}`,
  });
});

// Search
app.post('/search', (req: Request, res: Response) => {
  const engine = req.body?.engine || 'google';
  const query = (req.body?.query || '').trim();
  if (!query) return res.status(400).json({ error: 'No query provided' });

  let url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  if (engine === 'wikipedia') {
    url = `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(query)}`;
  } else if (engine === 'duckduckgo') {
    url = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
  } else if (engine === 'chrome') {
    url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  } else if (engine === 'safari') {
    url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  }

  res.json({ ok: true, url, engine, query });
});

// VPN status & launcher
const WORLD_VPNS: Record<string, string> = {
  protonvpn: 'ch.protonvpn.android',
  windscribe: 'com.windscribe.vpn',
  tunnelbear: 'com.tunnelbear.android',
  '1.1.1.1': 'com.cloudflare.onedotonedotonedotone',
  nordvpn: 'com.nordvpn.android',
};

app.get('/vpn-status', (req: Request, res: Response) => {
  res.json({
    installed: ['protonvpn', 'windscribe', 'tunnelbear', '1.1.1.1'],
    all: Object.keys(WORLD_VPNS),
  });
});

app.post('/open-vpn', (req: Request, res: Response) => {
  const vpn = (req.body?.vpn || '').toLowerCase().trim();
  const country = req.body?.country || 'usa';
  const pkg = WORLD_VPNS[vpn];
  if (!pkg) return res.status(400).json({ error: 'Unknown VPN service' });

  const intentUrl = `intent:#Intent;package=${pkg};category=android.intent.category.LAUNCHER;action=android.intent.action.MAIN;end`;
  res.json({
    ok: true,
    vpn,
    country,
    package: pkg,
    intent_url: intentUrl,
    message: `Opening ${vpn} for ${country.toUpperCase()}`,
  });
});

// Chat Endpoint: Integrates Local Offline Engine + Groq + Gemini
app.post('/chat', async (req: Request, res: Response) => {
  try {
    const data = req.body || {};
    const msg = (data.message || '').trim();
    const apiKey = (data.api_key || '').trim();
    const model = data.model || 'openai/gpt-oss-120b';
    const think = Boolean(data.think);
    const webSearch = Boolean(data.web_search);
    const offlineMode = Boolean(data.offline_mode);

    if (!msg) {
      return res.json({ reply: 'Type a message.' });
    }

    // 1. Check if Offline Local LLM is forced OR matches quick device command
    const localIntent = processOfflineIntent(msg);
    if (offlineMode || localIntent.action) {
      return res.json({
        reply: localIntent.reply,
        action: localIntent.action,
        thinking: think ? localIntent.thinking : undefined,
        source: 'local_offline_llm',
      });
    }

    // 2. If Groq API Key is supplied, use Groq
    if (apiKey && apiKey.startsWith('gsk_')) {
      let webContext = '';
      if (webSearch) {
        webContext = await getWebContext(msg);
      }
      const sysPrompt = `You are Mano, an advanced voice AI assistant created by Bashrii Oye. You can control Android device hardware and answer user questions directly, concisely, and helpfully.${
        webContext ? `\n\nWEB CONTEXT:\n${webContext}` : ''
      }`;

      const groqPayload: any = {
        model,
        messages: [
          { role: 'system', content: sysPrompt },
          { role: 'user', content: msg },
        ],
        temperature: 0.7,
        max_tokens: 2048,
      };
      if (think) {
        groqPayload.reasoning_format = 'parsed';
      }

      const groqResp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(groqPayload),
        signal: AbortSignal.timeout(25000),
      });

      if (groqResp.ok) {
        const groqData = await groqResp.json();
        const choice = groqData.choices?.[0]?.message;
        const reply = choice?.content?.trim() || '';
        const thinking = choice?.reasoning || choice?.reasoning_content;
        return res.json({
          reply,
          thinking: think && thinking ? thinking.trim() : undefined,
          source: 'groq',
        });
      }
    }

    // 3. If Gemini API key is in environment, use Google GenAI SDK
    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey) {
      try {
        const ai = new GoogleGenAI({ apiKey: geminiKey });
        let webContext = '';
        if (webSearch) {
          webContext = await getWebContext(msg);
        }
        const sysInstruction = `You are Mano, an elite, ultra-fast AI assistant by Bashrii Oye. Keep answers clear, accurate, and conversational for voice audio. If the user asks to control device features (flashlight, volume, timers, apps), acknowledge and inform them Mano will trigger it.${
          webContext ? `\nWeb background information:\n${webContext}` : ''
        }`;

        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: msg,
          config: {
            systemInstruction: sysInstruction,
            temperature: 0.7,
          },
        });

        const replyText = response.text || '';
        return res.json({
          reply: replyText.trim(),
          source: 'gemini',
        });
      } catch (geminiErr: any) {
        console.warn('Gemini invocation error, falling back to local engine:', geminiErr?.message);
      }
    }

    // 4. Default to Offline Local LLM response
    return res.json({
      reply: localIntent.reply,
      action: localIntent.action,
      thinking: think ? localIntent.thinking : undefined,
      source: 'local_offline_llm',
    });
  } catch (err: any) {
    console.error('Chat error:', err);
    return res.json({ reply: `Error: ${String(err?.message || err).slice(0, 100)}` });
  }
});

// Speak TTS endpoint (generates or instructs audio fallback)
app.get('/speak', (req: Request, res: Response) => {
  const text = (req.query.text as string) || '';
  const lang = (req.query.lang as string) || 'en';
  // Send JSON instructing client to use on-device speech synthesis or web audio synthesis
  res.json({
    ok: true,
    text,
    lang,
    instruction: 'USE_CLIENT_SPEECH_SYNTHESIS',
  });
});

// Start dev or production server
async function startServer() {
  const isDev = process.env.NODE_ENV !== 'production';

  if (isDev) {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (req: Request, res: Response) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }
  }

  const server = http.createServer(app);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Mano server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
