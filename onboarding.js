import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore, doc, setDoc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseConfig } from './firebase-config.js';

// API Keys
const TMDB_KEY = "2dca580c2a14b55200e784d157207b4d";
const LASTFM_KEY = "8814c3cc4bec8589e654f3c7e43618f3";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

let currentUser = null;
let picks = { movie: null, album: null, book: null };
let currentStep = "movie";

// Guard: must be logged in
onAuthStateChanged(auth, (user) => {
  if (!user) { window.location.href = "index.html"; return; }
  currentUser = user;
});

// ========== STEP NAVIGATION ==========
function goToStep(step) {
  currentStep = step;
  document.querySelectorAll(".onboarding-step").forEach(s => s.classList.remove("active"));
  document.getElementById(`step-${step}`).classList.add("active");

  const stepMap = { movie: "1", album: "2", book: "3" };
  document.getElementById("step-indicator").textContent = `${stepMap[step]} of 3`;
}

// ========== SEARCH HELPERS ==========
function debounce(fn, delay) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
}

async function searchMovies(query) {
  const r = await fetch(`https://api.themoviedb.org/3/search/movie?api_key=${TMDB_KEY}&query=${encodeURIComponent(query)}&page=1`);
  const data = await r.json();
  return (data.results || []).slice(0, 6).map(m => ({
    id: `tmdb_${m.id}`,
    tmdbId: m.id,
    name: m.title,
    meta: m.release_date ? m.release_date.slice(0, 4) : "",
    thumb: m.poster_path ? `https://image.tmdb.org/t/p/w92${m.poster_path}` : null,
    genre_ids: m.genre_ids || []
  }));
}

async function getMovieDetails(tmdbId) {
  try {
    const r = await fetch(`https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_KEY}&append_to_response=credits`);
    const data = await r.json();
    const director = data.credits?.crew?.find(c => c.job === "Director")?.name || "";
    const genres = (data.genres || []).map(g => g.name);
    return { director, genres };
  } catch (err) {
    return { director: "", genres: [] };
  }
}

async function searchAlbums(query) {
  const r = await fetch(`https://ws.audioscrobbler.com/2.0/?method=album.search&album=${encodeURIComponent(query)}&api_key=${LASTFM_KEY}&format=json&limit=6`);
  const data = await r.json();
  const albums = data.results?.albummatches?.album || [];
  return albums.map(a => ({
    id: `lfm_${a.mbid || a.name}`,
    name: a.name,
    artist: a.artist,
    meta: a.artist,
    thumb: a.image?.[1]?.["#text"] || null
  }));
}

async function getAlbumDetails(artist, album) {
  try {
    const r = await fetch(`https://ws.audioscrobbler.com/2.0/?method=album.getinfo&api_key=${LASTFM_KEY}&artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}&format=json`);
    const data = await r.json();
    const tags = (data.album?.tags?.tag || []).map(t => t.name);
    return { tags };
  } catch (err) {
    return { tags: [] };
  }
}

async function searchBooks(query) {
  try {
    const r = await fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=6&fields=key,title,author_name,cover_i`);
    const data = await r.json();
    return (data.docs || []).map(b => ({
      id: `ol_${b.key}`,
      name: b.title,
      author: b.author_name?.[0] || "",
      meta: b.author_name?.[0] || "",
      thumb: b.cover_i ? `https://covers.openlibrary.org/b/id/${b.cover_i}-M.jpg` : null,
      subjects: (b.subject || []).slice(0, 5)
    }));
  } catch (err) {
    console.error("Book search error:", err);
    return [];
  }
}

// ========== RENDER RESULTS ==========
function renderResults(containerId, results, onSelect) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";
  if (results.length === 0) {
    container.innerHTML = `<div style="padding:1rem; color:#999; text-align:center;">No results found</div>`;
    container.classList.remove("hidden");
    return;
  }
  results.forEach(item => {
    const el = document.createElement("div");
    el.className = "search-result-item";
    el.innerHTML = `
      ${item.thumb ? `<img class="result-thumb" src="${item.thumb}" alt="">` : `<div class="result-thumb"></div>`}
      <div>
        <div class="result-name">${item.name}</div>
        <div class="result-meta">${item.meta}</div>
      </div>
    `;
    el.addEventListener("click", () => onSelect(item));
    container.appendChild(el);
  });
  container.classList.remove("hidden");
}

// ========== SELECT PICK ==========
async function selectPick(type, item) {
  // Show loading on next button
  const nextBtn = document.getElementById(`${type}-next`);
  nextBtn.textContent = "Fetching details…";
  nextBtn.disabled = true;
  nextBtn.classList.remove("hidden");

  let enrichedItem = { ...item };

  // Fetch extra metadata
  if (type === "movie" && item.tmdbId) {
    const details = await getMovieDetails(item.tmdbId);
    enrichedItem.director = details.director;
    enrichedItem.genres = details.genres;
  } else if (type === "album") {
    const details = await getAlbumDetails(item.artist, item.name);
    enrichedItem.tags = details.tags;
  }

  picks[type] = enrichedItem;

  // Reset next button
  nextBtn.textContent = type === "book" ? "Finish & See My Shelf ✨" : "Next →";
  nextBtn.disabled = false;

  // Hide search, show selected preview
  document.getElementById(`${type}-results`).classList.add("hidden");
  document.getElementById(`${type}-search`).value = "";

  const selectedEl = document.getElementById(`${type}-selected`);
  const coverEl = document.getElementById(`${type}-cover`);
  const nameEl = document.getElementById(`${type}-name`);
  const metaEl = document.getElementById(`${type}-meta`);

  if (enrichedItem.thumb) {
    coverEl.innerHTML = `<img src="${enrichedItem.thumb}" style="width:56px;height:56px;border-radius:10px;object-fit:cover;">`;
  }
  nameEl.textContent = enrichedItem.name;
  metaEl.textContent = enrichedItem.meta;

  selectedEl.classList.remove("hidden");
}

// ========== WIRE SEARCH INPUTS ==========
function wireSearch(type, searchFn) {
  const input = document.getElementById(`${type}-search`);
  const resultsId = `${type}-results`;

  input.addEventListener("input", debounce(async (e) => {
    const q = e.target.value.trim();
    if (q.length < 2) {
      document.getElementById(resultsId).classList.add("hidden");
      return;
    }
    const results = await searchFn(q);
    renderResults(resultsId, results, (item) => selectPick(type, item));
  }, 350));

  document.getElementById(`${type}-change`).addEventListener("click", () => {
    picks[type] = null;
    document.getElementById(`${type}-selected`).classList.add("hidden");
    document.getElementById(`${type}-next`).classList.add("hidden");
    input.focus();
  });
}

wireSearch("movie", searchMovies);
wireSearch("album", searchAlbums);
wireSearch("book", searchBooks);

// ========== STEP PROGRESSION ==========
document.getElementById("movie-next").addEventListener("click", () => goToStep("album"));
document.getElementById("album-next").addEventListener("click", () => goToStep("book"));

document.getElementById("book-next").addEventListener("click", async () => {
  if (!picks.movie || !picks.album || !picks.book) return;

  document.getElementById("book-next").textContent = "Saving…";
  document.getElementById("book-next").disabled = true;

  try {
    await setDoc(doc(db, "users", currentUser.uid), {
      uid: currentUser.uid,
      name: currentUser.displayName,
      email: currentUser.email,
      photo: currentUser.photoURL,
      picks: picks,
      onboarded: true,
      createdAt: new Date().toISOString()
    });
    window.location.href = "discover.html";
  } catch (err) {
    console.error("Error saving picks:", err);
    document.getElementById("book-next").textContent = "Error — try again";
    document.getElementById("book-next").disabled = false;
  }
});
