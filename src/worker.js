const KEY_ENTRIES = "zabaan-entries-v1";
const KEY_RULES = "zabaan-plural-rules-v1";
const KEY_CONTRIBUTIONS = "zabaan-contributions-v1";
const KEY_AUDIO_PREFIX = "zabaan-audio-v1:";

const WRITE_PROTECTED = new Set([
  KEY_ENTRIES,
  KEY_RULES,
  KEY_CONTRIBUTIONS
]);

const VALID_STATUSES = new Set(["APPROVED", "REJECTED", "NEEDS_CORRECTION"]);
const ENTRY_TYPES = new Set(["word", "phrase", "sentence"]);
const MAX_QUEUE_LENGTH = 5000;
const MAX_PAYLOAD = 2_000_000;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function isAdmin(request, env) {
  const supplied = request.headers.get("x-admin-password") || "";
  return Boolean(env.ADMIN_PASSWORD && supplied === env.ADMIN_PASSWORD);
}

function requireKV(env) {
  return env.ZABAAN_KV;
}

async function handleStore(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  if (!key) return json({ error: "missing key" }, 400);

  const kv = requireKV(env);
  if (!kv) return json({ error: "KV namespace not bound" }, 500);

  // Contributions are private to the admin dashboard.
  if (key === KEY_CONTRIBUTIONS && !isAdmin(request, env)) {
    return json({ error: "unauthorized" }, 401);
  }

  if (request.method === "GET") {
    const raw = await kv.get(key);
    return json({ value: raw ? JSON.parse(raw) : null });
  }

  if (request.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  if (WRITE_PROTECTED.has(key) && !isAdmin(request, env)) {
    return json({ error: "unauthorized" }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }

  if (!body || !("value" in body)) {
    return json({ error: "bad body" }, 400);
  }

  const serialized = JSON.stringify(body.value);
  if (serialized.length > MAX_PAYLOAD) {
    return json({ error: "payload too large" }, 413);
  }

  await kv.put(key, serialized);
  return json({ ok: true });
}

function makeAudioId() {
  return "audio-" + Date.now() + "-" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

function dataUrlToBytes(dataUrl) {
  if (typeof dataUrl !== "string") return null;
  const match = dataUrl.match(/^data:([^;,]+)?;base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) return null;
  const mimeType = match[1] || "application/octet-stream";
  const base64 = match[2].replace(/\s/g, "");
  let binary;
  try { binary = atob(base64); } catch { return null; }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { mimeType, bytes };
}

async function handleAudio(request, env, audioId) {
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
  if (!audioId || !/^[A-Za-z0-9_-]+$/.test(audioId)) return json({ error: "bad audio id" }, 400);
  const kv = requireKV(env);
  if (!kv) return json({ error: "KV namespace not bound" }, 500);
  const raw = await kv.get(KEY_AUDIO_PREFIX + audioId);
  if (!raw) return new Response("Audio not found", { status: 404 });
  const match = raw.match(/^([^|]+)\|([A-Za-z0-9+/=]+)$/);
  if (!match) return new Response("Invalid audio", { status: 500 });
  const mimeType = match[1];
  let binary;
  try { binary = atob(match[2]); } catch { return new Response("Invalid audio", { status: 500 }); }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Response(bytes, {
    headers: {
      "content-type": mimeType,
      "cache-control": "public, max-age=31536000, immutable",
      "accept-ranges": "bytes"
    }
  });
}

async function handleContribute(request, env) {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);

  const kv = requireKV(env);
  if (!kv) return json({ error: "KV namespace not bound" }, 500);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "bad json" }, 400); }

  const c = body && body.contribution;
  if (!c || typeof c !== "object" || !c.type) return json({ error: "bad contribution" }, 400);

  const safe = {
    id: "contrib-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
    type: String(c.type).slice(0, 40),
    entryId: c.entryId ? String(c.entryId).slice(0, 100) : undefined,
    entryLabel: c.entryLabel ? String(c.entryLabel).slice(0, 200) : undefined,
    data: (c.data && typeof c.data === "object") ? c.data : {},
    contributorLabel: c.contributorLabel ? String(c.contributorLabel).slice(0, 100) : "Community contributor",
    status: "PENDING",
    submittedAt: new Date().toISOString()
  };

  const raw = await kv.get(KEY_CONTRIBUTIONS);
  const list = raw ? JSON.parse(raw) : [];
  if (list.length >= MAX_QUEUE_LENGTH) return json({ error: "queue full — please try again later" }, 429);

  // Audio is stored separately in KV. The contribution only carries a small reference.
  const audio = body && body.audio;
  if (audio) {
    const parsed = dataUrlToBytes(audio.dataUrl);
    if (!parsed) return json({ error: "invalid audio data" }, 400);
    if (parsed.bytes.byteLength < 100) return json({ error: "audio is empty" }, 400);
    if (parsed.bytes.byteLength > 1_350_000) return json({ error: "audio is too large — keep it under about 1.35 MB" }, 413);
    const allowed = new Set(["audio/mp4", "audio/webm", "audio/webm;codecs=opus", "audio/ogg", "audio/ogg;codecs=opus", "audio/mpeg", "audio/wav", "audio/x-wav"]);
    if (!allowed.has(parsed.mimeType)) return json({ error: "unsupported audio format: " + parsed.mimeType }, 415);

    const audioId = makeAudioId();
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < parsed.bytes.length; i += chunk) {
      binary += String.fromCharCode(...parsed.bytes.subarray(i, Math.min(i + chunk, parsed.bytes.length)));
    }
    const stored = parsed.mimeType + "|" + btoa(binary);
    if (stored.length > MAX_PAYLOAD) return json({ error: "audio is too large" }, 413);
    await kv.put(KEY_AUDIO_PREFIX + audioId, stored);
    safe.data.audioId = audioId;
    safe.data.audioMimeType = parsed.mimeType;
    safe.data.hasAudio = true;
  } else if (safe.data.hasAudio) {
    safe.data.hasAudio = false;
  }

  list.push(safe);
  await kv.put(KEY_CONTRIBUTIONS, JSON.stringify(list));
  return json({ ok: true, contribution: safe });
}

async function handleAdminLogin(request, env) {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const password = body && typeof body.password === "string" ? body.password : "";
  const ok = Boolean(env.ADMIN_PASSWORD && password === env.ADMIN_PASSWORD);
  return json({ ok }, ok ? 200 : 401);
}

async function handleDecide(request, env) {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!isAdmin(request, env)) return json({ error: "unauthorized" }, 401);

  const kv = requireKV(env);
  if (!kv) return json({ error: "KV namespace not bound" }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }

  const id = body && body.id;
  const status = body && body.status;
  const note = body && body.note ? String(body.note).slice(0, 2000) : "";

  if (!id || !VALID_STATUSES.has(status)) {
    return json({ error: "bad request" }, 400);
  }

  const [rawContributions, rawEntries] = await Promise.all([
    kv.get(KEY_CONTRIBUTIONS),
    kv.get(KEY_ENTRIES)
  ]);

  const contributions = rawContributions ? JSON.parse(rawContributions) : [];
  const entries = rawEntries ? JSON.parse(rawEntries) : [];
  const c = contributions.find((x) => x.id === id);

  if (!c) return json({ error: "contribution not found" }, 404);

  c.status = status;
  c.reviewNote = note;
  c.decidedAt = new Date().toISOString();

  if (status === "APPROVED" && ENTRY_TYPES.has(c.type)) {
    const d = c.data || {};
    entries.push({
      id: "entry-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
      code: null,
      isDemo: false,
      lemma: d.ksWord || "(untitled)",
      transliteration: "",
      meaning: d.enMeaning || "",
      pos: d.pos || "other",
      gender: d.gender || null,
      pluralClass: null,
      irregularPlural: null,
      phoneticEasy: d.phonEasy || "",
      ipa: d.ipa || null,
      dialect: d.region || "—",
      region: d.region || "Unspecified",
      verificationStatus: "verified",
      contributors: [c.contributorLabel],
      examples: d.exampleKs
        ? [{ ks: d.exampleKs, en: d.exampleEn || "", phonetic: "", verified: true }]
        : [],
      audio: [],
      notes: d.addlNotes || "",
      revisions: [{
        version: 1,
        note: "Approved from community submission.",
        date: new Date().toISOString().slice(0, 10)
      }]
    });

    await kv.put(KEY_ENTRIES, JSON.stringify(entries));
  }

  await kv.put(KEY_CONTRIBUTIONS, JSON.stringify(contributions));
  return json({ ok: true, entries, contributions });
}

async function handleAPI(request, env, pathname) {
  if (pathname === "/api/store") return handleStore(request, env);
  if (pathname === "/api/contribute") return handleContribute(request, env);
  if (pathname === "/api/admin-login") return handleAdminLogin(request, env);
  if (pathname === "/api/decide") return handleDecide(request, env);
  if (pathname.startsWith("/api/audio/")) return handleAudio(request, env, pathname.slice("/api/audio/".length));
  return json({ error: "not found" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleAPI(request, env, url.pathname);
      } catch (err) {
        console.error(err);
        return json({ error: "internal server error" }, 500);
      }
    }

    // Everything else is served from /public through Cloudflare's
    // Workers Static Assets binding.
    return env.ASSETS.fetch(request);
  }
};
