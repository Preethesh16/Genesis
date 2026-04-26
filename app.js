(() => {
  // Storage keys
  const STORAGE_SAVED = "dg.saved.v2";       // [{ id, reference, text }]
  const STORAGE_LAST = "dg.last.v2";         // { id, reference, text }
  const STORAGE_DAILY = "dg.daily.v2";       // { date, verse }
  const CACHE_EXPLAIN = "dg.explain.v2";     // { [id]: { simple, deep, practical, prompt } }
  const CACHE_MOOD_REFS = "dg.moodrefs.v2";  // { [mood]: [reference, ...] }

  // External, free, no-key APIs
  const BIBLE_API = "https://bible-api.com/";
  const BIBLE_RANDOM = "https://bible-api.com/?random=verse";
  const LLM_API = "https://text.pollinations.ai/";

  const MOODS = ["sad", "anxious", "angry", "fearful", "weary", "grieving", "hopeful", "peaceful"];

  const state = {
    currentMood: null,
    currentVerse: null, // { id, reference, text }
  };

  // ---------- helpers ----------
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const readJSON = (k, fallback) => {
    try {
      const raw = localStorage.getItem(k);
      return raw == null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  };
  const writeJSON = (k, v) => localStorage.setItem(k, JSON.stringify(v));

  const makeId = (reference) =>
    reference.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9:.\-]/g, "");

  const todayKey = () => {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  };

  // ---------- saved ----------
  const loadSaved = () => readJSON(STORAGE_SAVED, []);
  const isSaved = (id) => loadSaved().some(v => v.id === id);

  const toggleSave = (verse) => {
    const saved = loadSaved();
    const idx = saved.findIndex(v => v.id === verse.id);
    if (idx >= 0) saved.splice(idx, 1);
    else saved.unshift({ id: verse.id, reference: verse.reference, text: verse.text });
    writeJSON(STORAGE_SAVED, saved);
    return saved.some(v => v.id === verse.id);
  };

  // ---------- fetching ----------
  const fetchVerseByReference = async (reference) => {
    const res = await fetch(BIBLE_API + encodeURIComponent(reference));
    if (!res.ok) throw new Error("Verse fetch failed");
    const data = await res.json();
    const text = (data.text || "").replace(/\s+/g, " ").trim();
    if (!text) throw new Error("Empty verse");
    const ref = data.reference || reference;
    return { id: makeId(ref), reference: ref, text };
  };

  const fetchRandomVerse = async () => {
    const res = await fetch(BIBLE_RANDOM);
    if (!res.ok) throw new Error("Random verse fetch failed");
    const data = await res.json();
    const text = (data.text || "").replace(/\s+/g, " ").trim();
    if (!text) throw new Error("Empty verse");
    const ref = data.reference || "Unknown";
    return { id: makeId(ref), reference: ref, text };
  };

  // Ask the LLM for a list of references that match a mood, cache them,
  // and pop one at a time. When empty, refill.
  const fetchMoodReference = async (mood) => {
    const cache = readJSON(CACHE_MOOD_REFS, {});
    if (!Array.isArray(cache[mood]) || cache[mood].length === 0) {
      const prompt = `Suggest 8 Bible verse references that someone feeling "${mood}" might find meaningful. Return ONLY a JSON array of strings in the format ["Book Chapter:Verse", ...]. Examples of valid items: "Psalm 23:1", "Matthew 11:28", "Philippians 4:6-7". No prose, no markdown, just the JSON array.`;
      const res = await fetch(LLM_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: prompt }],
          model: "openai",
          jsonMode: true,
        }),
      });
      if (!res.ok) throw new Error("Mood suggestion failed");
      const raw = (await res.text()).trim();
      let refs;
      try { refs = JSON.parse(raw); }
      catch {
        const m = raw.match(/\[[\s\S]*\]/);
        if (!m) throw new Error("Bad mood suggestion format");
        refs = JSON.parse(m[0]);
      }
      if (!Array.isArray(refs) || !refs.length) throw new Error("Empty suggestion list");
      // shuffle for variety across sessions
      refs.sort(() => Math.random() - 0.5);
      cache[mood] = refs;
      writeJSON(CACHE_MOOD_REFS, cache);
    }
    const next = cache[mood].shift();
    writeJSON(CACHE_MOOD_REFS, cache);
    return fetchVerseByReference(next);
  };

  const fetchExplanation = async (verse) => {
    const cache = readJSON(CACHE_EXPLAIN, {});
    if (cache[verse.id]) return cache[verse.id];

    const prompt = `You are a warm, grounded spiritual guide. A reader is sitting with this verse:

"${verse.text}"
— ${verse.reference}

Write a reflection in EXACTLY this JSON shape (no prose outside JSON, no markdown fences):
{
  "simple": "Plain-language meaning of the verse, 1-2 sentences. Warm, not robotic.",
  "deep": "The historical/literary context and a deeper insight, 3-5 sentences. Avoid clichés.",
  "practical": "How a person could apply this in real life today, 3-5 sentences. Concrete, gentle, specific.",
  "prompt": "One short reflective question to sit with, under 15 words."
}

Only output the JSON object. No commentary before or after.`;

    const res = await fetch(LLM_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: prompt }],
        model: "openai",
        jsonMode: true,
      }),
    });
    if (!res.ok) throw new Error("Explanation fetch failed");
    const raw = (await res.text()).trim();
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) throw new Error("Bad explanation format");
      parsed = JSON.parse(m[0]);
    }

    const layers = {
      simple: String(parsed.simple || "").trim(),
      deep: String(parsed.deep || "").trim(),
      practical: String(parsed.practical || "").trim(),
      prompt: String(parsed.prompt || "").trim(),
    };
    if (!layers.simple || !layers.deep || !layers.practical) {
      throw new Error("Incomplete explanation");
    }
    cache[verse.id] = layers;
    writeJSON(CACHE_EXPLAIN, cache);
    return layers;
  };

  // ---------- rendering ----------
  const setVerseDisplay = (verse) => {
    $("#verse-ref").textContent = verse?.reference || "";
    $("#verse-text").textContent = verse?.text ? `"${verse.text}"` : "Loading…";
  };

  const setLayers = (layers) => {
    $("#layer-simple").textContent = layers.simple;
    $("#layer-deep").textContent = layers.deep;
    $("#layer-practical").textContent = layers.practical;
    $("#layer-prompt").textContent = layers.prompt || "What is this verse asking of you today?";
  };

  const showLayersLoading = () => {
    const placeholder = "Reading the verse carefully…";
    setLayers({ simple: placeholder, deep: placeholder, practical: placeholder, prompt: "" });
  };

  const renderShell = () => {
    const verse = state.currentVerse;
    setVerseDisplay(verse);
    $("#layers").hidden = true;
    $("#btn-explain").textContent = "Explain";
    $("#btn-explain").disabled = !verse?.text;
    $("#btn-save").disabled = !verse?.text;
    $("#btn-share").disabled = !verse?.text;

    const saveBtn = $("#btn-save");
    const saved = verse ? isSaved(verse.id) : false;
    saveBtn.setAttribute("aria-pressed", saved ? "true" : "false");
    saveBtn.textContent = saved ? "Saved" : "Save";

    const hint = $("#mood-hint");
    if (state.currentMood) {
      hint.hidden = false;
      hint.textContent = `Showing verses for: ${state.currentMood}.`;
    } else {
      hint.hidden = true;
    }
  };

  const showLoading = (label = "Finding a verse for you…") => {
    state.currentVerse = null;
    $("#verse-ref").textContent = "";
    $("#verse-text").textContent = label;
    $("#layers").hidden = true;
    $("#btn-explain").disabled = true;
    $("#btn-save").disabled = true;
    $("#btn-share").disabled = true;
  };

  const showError = (msg) => {
    $("#verse-ref").textContent = "";
    $("#verse-text").textContent = msg;
  };

  // ---------- actions ----------
  const loadAndShow = async (fetcher, loadingLabel) => {
    showLoading(loadingLabel);
    try {
      const verse = await fetcher();
      state.currentVerse = verse;
      writeJSON(STORAGE_LAST, verse);
      renderShell();
    } catch (err) {
      console.error(err);
      showError("Couldn't load a verse. Check your connection and try again.");
    }
  };

  const onExplainClicked = async () => {
    const verse = state.currentVerse;
    if (!verse?.text) return;
    const layers = $("#layers");
    if (!layers.hidden) {
      layers.hidden = true;
      $("#btn-explain").textContent = "Explain";
      return;
    }
    layers.hidden = false;
    showLayersLoading();
    $("#btn-explain").textContent = "Loading…";
    $("#btn-explain").disabled = true;
    try {
      const data = await fetchExplanation(verse);
      setLayers(data);
      $("#btn-explain").textContent = "Hide explanation";
    } catch (err) {
      console.error(err);
      setLayers({
        simple: "Couldn't generate an explanation right now.",
        deep: "The reflection service is unreachable. Check your connection and try again.",
        practical: "In the meantime, sit quietly with the verse for a minute.",
        prompt: "What stands out to you on a first reading?",
      });
      $("#btn-explain").textContent = "Try again";
    } finally {
      $("#btn-explain").disabled = false;
    }
  };

  const renderSaved = () => {
    const list = $("#saved-list");
    const empty = $("#saved-empty");
    const items = loadSaved();
    list.innerHTML = "";
    empty.hidden = items.length > 0;

    items.forEach(v => {
      const li = document.createElement("li");
      li.className = "saved-item";
      li.innerHTML = `
        <span class="ref"></span>
        <span class="txt"></span>
        <div class="row">
          <button class="btn" data-act="open">Open</button>
          <button class="btn ghost" data-act="remove">Remove</button>
        </div>
      `;
      li.querySelector(".ref").textContent = v.reference;
      li.querySelector(".txt").textContent = `"${v.text}"`;
      li.querySelector('[data-act="open"]').addEventListener("click", () => {
        state.currentVerse = v;
        writeJSON(STORAGE_LAST, v);
        switchView("verse");
        renderShell();
      });
      li.querySelector('[data-act="remove"]').addEventListener("click", () => {
        toggleSave(v);
        renderSaved();
        if (state.currentVerse?.id === v.id) renderShell();
      });
      list.appendChild(li);
    });
  };

  // ---------- view switching ----------
  const switchView = (name) => {
    $$(".view").forEach(v => v.hidden = true);
    const target = document.getElementById(`view-${name}`);
    if (target) target.hidden = false;
    $$(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.view === name));
    if (name === "saved") renderSaved();
  };

  // ---------- toast ----------
  let toastEl;
  const toast = (msg) => {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "toast";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toastEl.classList.remove("show"), 1800);
  };

  // ---------- daily verse ----------
  const getDailyVerse = async () => {
    const stored = readJSON(STORAGE_DAILY, null);
    if (stored && stored.date === todayKey() && stored.verse?.text) {
      return stored.verse;
    }
    const v = await fetchRandomVerse();
    writeJSON(STORAGE_DAILY, { date: todayKey(), verse: v });
    return v;
  };

  // ---------- events ----------
  const wire = () => {
    $$(".nav-btn").forEach(btn => {
      btn.addEventListener("click", () => switchView(btn.dataset.view));
    });

    $("#btn-explain").addEventListener("click", onExplainClicked);

    $("#btn-another").addEventListener("click", () => {
      if (state.currentMood) {
        loadAndShow(() => fetchMoodReference(state.currentMood), `Finding a verse for ${state.currentMood}…`);
      } else {
        loadAndShow(fetchRandomVerse, "Finding a verse…");
      }
    });

    $("#btn-save").addEventListener("click", () => {
      const v = state.currentVerse;
      if (!v?.text) return;
      const nowSaved = toggleSave(v);
      const saveBtn = $("#btn-save");
      saveBtn.setAttribute("aria-pressed", nowSaved ? "true" : "false");
      saveBtn.textContent = nowSaved ? "Saved" : "Save";
      toast(nowSaved ? "Saved for later" : "Removed");
    });

    $("#btn-share").addEventListener("click", async () => {
      const v = state.currentVerse;
      if (!v?.text) return;
      const shareText = `"${v.text}"\n— ${v.reference}`;
      if (navigator.share) {
        try { await navigator.share({ text: shareText, title: "Daily Verse" }); return; }
        catch { /* fall through */ }
      }
      try {
        await navigator.clipboard.writeText(shareText);
        toast("Copied to clipboard");
      } catch {
        toast("Couldn't share");
      }
    });

    $$(".mood").forEach(btn => {
      btn.addEventListener("click", () => {
        const mood = btn.dataset.mood;
        state.currentMood = mood;
        switchView("verse");
        loadAndShow(() => fetchMoodReference(mood), `Finding a verse for ${mood}…`);
      });
    });

    $("#btn-clear-mood").addEventListener("click", () => {
      state.currentMood = null;
      switchView("verse");
      loadAndShow(fetchRandomVerse, "Finding a verse…");
    });
  };

  // ---------- boot ----------
  const boot = async () => {
    wire();
    switchView("verse");

    // If we have a verse from this session, show it instantly; otherwise fetch today's.
    const last = readJSON(STORAGE_LAST, null);
    if (last?.text) {
      state.currentVerse = last;
      renderShell();
      return;
    }
    showLoading("Finding today's verse…");
    try {
      const v = await getDailyVerse();
      state.currentVerse = v;
      writeJSON(STORAGE_LAST, v);
      renderShell();
    } catch (err) {
      console.error(err);
      showError("Couldn't reach the verse service. Check your connection and refresh.");
    }
  };

  document.addEventListener("DOMContentLoaded", boot);
})();
