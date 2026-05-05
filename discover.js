import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore, collection, getDocs, doc, getDoc, updateDoc, setDoc, query, orderBy, where } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseConfig } from './firebase-config.js';

// API Keys for backfilling
const TMDB_KEY = "2dca580c2a14b55200e784d157207b4d";
const LASTFM_KEY = "8814c3cc4bec8589e654f3c7e43618f3";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

let currentUser = null;
let myPicks = null;
let allUsers = []; 
let myData = null;  

let activeCommunity = "creative-computing-s26";
let myCommunities = [];
let communityDocs = {}; // Cache community names

onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href = "index.html"; return; }
  currentUser = user;
  
  try {
    const userDoc = await getDoc(doc(db, "users", currentUser.uid));
    if (!userDoc.exists()) { window.location.href = "onboarding.html"; return; }

    myData = userDoc.data();
    myPicks = myData.picks;
    myCommunities = myData.communities || ["creative-computing-s26"];

    // Clean up URL params
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('c')) window.history.replaceState({}, document.title, "/discover.html");

    // Load UI components
    await loadMyShelf();
    await loadCommunity();
  } catch (err) {
    console.error("Critical Auth/Load Error:", err);
    document.getElementById("own-shelf-wrapper").innerHTML = `<div class="shelf-loading">Error loading your shelf. Please try refreshing.</div>`;
  }
});

// ========== IMAGE QUALITY REPAIR ==========
function repairImageURL(url) {
  if (!url || typeof url !== 'string') return url;
  let newUrl = url;
  
  try {
    // TMDB
    if (newUrl.includes("tmdb.org/t/p/")) {
      newUrl = newUrl.replace(/\/w(92|154|185|200|300|342)\//, "/w500/");
    }
    // Last.fm: Only upgrade tiny thumbnails to a standard large size (300x300)
    // We avoid the '/_/' hack because it breaks for some smaller uploads (like 1989)
    if (newUrl.includes("lastfm.freetls.fastly.net/i/u/")) {
      newUrl = newUrl.replace(/\/i\/u\/(34s|64s|174s)\//, "/i/u/300x300/");
    }
    // OpenLibrary
    if (newUrl.includes("covers.openlibrary.org") && newUrl.includes("-M.jpg")) {
      newUrl = newUrl.replace("-M.jpg", "-L.jpg");
    }
  } catch (e) { console.error("Repair error", e); }
  
  return newUrl;
}

// ========== LOAD OWN SHELF ==========
async function loadMyShelf() {
  if (!myData || !myPicks) return;

  // High-Res Repair
  let needsRepair = false;
  const p = { ...myPicks }; // Clone to avoid mutation issues during repair
  
  if (p.movie?.thumb) {
    const fixed = repairImageURL(p.movie.thumb);
    if (fixed !== p.movie.thumb) { p.movie.thumb = fixed; needsRepair = true; }
  }
  if (p.album?.thumb) {
    const fixed = repairImageURL(p.album.thumb);
    if (fixed !== p.album.thumb) { p.album.thumb = fixed; needsRepair = true; }
  }
  if (p.book?.thumb) {
    const fixed = repairImageURL(p.book.thumb);
    if (fixed !== p.book.thumb) { p.book.thumb = fixed; needsRepair = true; }
  }
  
  if (needsRepair) {
    try {
      await updateDoc(doc(db, "users", currentUser.uid), { picks: p });
      myPicks = p;
      myData.picks = p;
    } catch (e) { console.warn("Background repair update failed", e); }
  }

  const card = document.getElementById("own-shelf-wrapper");
  if (card) card.innerHTML = buildShelfCardHTML(myData, null);
}

// ========== LOAD COMMUNITY ==========
async function loadCommunity() {
  const feed = document.getElementById("discover-feed");
  if (!feed) return;
  feed.innerHTML = `<div class="shelf-loading">loading community…</div>`;

  try {
    // GLOBAL: Fetch all users. We try with order, but fallback if it fails
    let q = query(collection(db, "users"), orderBy("createdAt", "desc"));
    let snapshot;
    try {
      snapshot = await getDocs(q);
    } catch (e) {
      console.warn("Ordered query failed, falling back to unordered", e);
      q = query(collection(db, "users"));
      snapshot = await getDocs(q);
    }

    let users = [];
    allUsers = [];

    snapshot.forEach(docSnap => {
      const data = docSnap.data();
      allUsers.push(data);
      if (data.uid === currentUser.uid) return;
      users.push({ ...data, score: "Analyzing..." });
    });

    feed.innerHTML = "";
    if (users.length === 0) {
      feed.innerHTML = `<div class="shelf-loading">No one else has joined yet! 🎉</div>`;
      return;
    }

    users.forEach(user => {
      if (user.picks) {
        if (user.picks.movie?.thumb) user.picks.movie.thumb = repairImageURL(user.picks.movie.thumb);
        if (user.picks.album?.thumb) user.picks.album.thumb = repairImageURL(user.picks.album.thumb);
        if (user.picks.book?.thumb) user.picks.book.thumb = repairImageURL(user.picks.book.thumb);
      }
      const el = document.createElement("div");
      el.innerHTML = buildShelfCardHTML(user, user.score);
      feed.appendChild(el.firstElementChild);
    });

    // Start background scoring
    fetchAIBatchScores(myPicks, users);

  } catch (err) {
    console.error("Community load error:", err);
    feed.innerHTML = `<div class="shelf-loading">Error loading community. Please refresh.</div>`;
  }
}

// ========== MATCH ALGORITHM ==========
function calculateMatch(p1, p2) {
  if (!p1 || !p2) return 0;
  let totalScore = 0;

  // 1. Movies (Max 33)
  totalScore += scoreCategory(p1.movie, p2.movie, "director", "genres", 33);
  
  // 2. Albums (Max 34)
  totalScore += scoreCategory(p1.album, p2.album, "artist", "tags", 34);

  // 3. Books (Max 33)
  totalScore += scoreCategory(p1.book, p2.book, "author", "subjects", 33);

  return Math.round(totalScore);
}

function scoreCategory(item1, item2, personKey, groupKey, maxPoints) {
  if (!item1 || !item2) return 0;

  // Tier 1: Exact Match
  if (item1.id === item2.id) return maxPoints;

  let partial = 0;

  // Tier 2: Same Creator (Director/Artist/Author)
  if (item1[personKey] && item1[personKey] === item2[personKey]) {
    partial += 15;
  }

  // Tier 3: Shared Genres/Tags/Subjects
  const g1 = item1[groupKey] || [];
  const g2 = item2[groupKey] || [];
  const overlap = g1.filter(x => g2.includes(x)).length;

  if (overlap >= 2) partial += 10;
  else if (overlap === 1) partial += 5;

  return Math.min(maxPoints, partial);
}

// ========== AUTO-BACKFILL LOGIC (SELF-HEALING) ==========
const backfillInProgress = new Set();

async function attemptBackfill(uid, picks) {
  if (!picks || backfillInProgress.has(uid)) return;

  const needsMovie = picks.movie && (!picks.movie.director || !picks.movie.genres);
  const needsAlbum = picks.album && !picks.album.tags;
  const needsBook = picks.book && (!picks.book.author || !picks.book.subjects);

  if (!needsMovie && !needsAlbum && !needsBook) return;

  backfillInProgress.add(uid);
  console.log(`[Backfill] Fixing incomplete profile for ${uid}...`);

  try {
    const updatedPicks = { ...picks };

    if (needsMovie && picks.movie.tmdbId) {
      const r = await fetch(`https://api.themoviedb.org/3/movie/${picks.movie.tmdbId}?api_key=${TMDB_KEY}&append_to_response=credits`);
      const data = await r.json();
      updatedPicks.movie.director = data.credits?.crew?.find(c => c.job === "Director")?.name || "";
      updatedPicks.movie.genres = (data.genres || []).map(g => g.name);
    }

    if (needsAlbum && picks.album.artist) {
      const r = await fetch(`https://ws.audioscrobbler.com/2.0/?method=album.getinfo&api_key=${LASTFM_KEY}&artist=${encodeURIComponent(picks.album.artist)}&album=${encodeURIComponent(picks.album.name)}&format=json`);
      const data = await r.json();
      updatedPicks.album.tags = (data.album?.tags?.tag || []).map(t => t.name);
    }

    if (needsBook && picks.book.id) {
      // Extract key from id (format: ol_WORKS/OL...)
      const key = picks.book.id.replace("ol_", "");
      const r = await fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(picks.book.name)}&limit=1&fields=author_name,subject`);
      const data = await r.json();
      if (data.docs?.[0]) {
        updatedPicks.book.author = data.docs[0].author_name?.[0] || "";
        updatedPicks.book.subjects = (data.docs[0].subject || []).slice(0, 5);
      }
    }

    // Update Firestore
    await updateDoc(doc(db, "users", uid), { picks: updatedPicks });
    console.log(`[Backfill] Successfully updated ${uid}. Refresh to see score updates.`);

  } catch (err) {
    console.error(`[Backfill] Error updating ${uid}:`, err);
  } finally {
    backfillInProgress.delete(uid);
  }
}

function buildShelfCardHTML(userData, matchScore) {
  const { name, photo, picks, uid } = userData;
  const p = picks || {};

  let matchBadge = "";
  if (matchScore !== null) {
    const isAnalyzing = matchScore === "Analyzing...";
    const isNum = typeof matchScore === "number";
    
    let matchClass = "";
    if (isAnalyzing) matchClass = "match-analyzing";
    else if (!isNum) matchClass = "match-low";
    else if (matchScore >= 66) matchClass = "match-high";
    else if (matchScore >= 33) matchClass = "match-mid";
    else matchClass = "match-low";

    const displayScore = isNum ? `${matchScore}%` : matchScore;
    const label = isNum ? "match" : (isAnalyzing ? "" : "taste");
    
    matchBadge = `
    <div class="match-badge-compact ${matchClass}" id="badge-${uid}">
      <span class="match-percent">${displayScore}</span>
      ${label ? `<span class="match-label">${label} <button class="info-btn card-info-btn" title="How is this calculated?">i</button></span>` : ""}
    </div>`;
  }

  const makePick = (pick, label) => `
    <div class="shelf-pick">
      <div class="shelf-pick-image-container">
        ${pick?.thumb
          ? `<img class="shelf-pick-cover" src="${pick.thumb}" alt="" onerror="this.outerHTML='<div class=\\'shelf-pick-cover shelf-pick-cover--empty\\'></div>'">`
          : `<div class="shelf-pick-cover shelf-pick-cover--empty"></div>`}
        <span class="shelf-pick-category-overlay">${label}</span>
      </div>
      <div class="shelf-pick-tile">
        <span class="shelf-pick-title">${pick?.name || "—"}</span>
      </div>
    </div>`;

  return `
    <div class="shelf-card-container">
      <div class="shelf-card-header">
        <div class="shelf-user-info">
          ${photo ? `<img class="shelf-avatar" src="${photo}" onerror="this.outerHTML='<div class=\\'shelf-avatar\\'></div>'" alt="">` : `<div class="shelf-avatar"></div>`}
          <span class="shelf-name">${name || "Anonymous"}</span>
        </div>
        ${matchBadge}
      </div>
      <div class="shelf-card-body">
        <div class="shelf-picks">
          ${makePick(p.movie, "Movie")}
          ${makePick(p.album, "Album")}
          ${makePick(p.book, "Book")}
        </div>
      </div>
      ${matchScore !== null ? `
      <div class="shelf-card-footer">
        <button class="joint-btn" data-uid="${uid}">✨ Ask AI Toggle</button>
      </div>
      <div class="joint-recommendation-wrapper hidden" id="joint-wrap-${uid}"></div>
      ` : ""}
    </div>`;
}

// ========== SIGN OUT ==========
document.getElementById("sign-out-btn").addEventListener("click", async () => {
  await signOut(auth);
  window.location.href = "index.html";
});

// ========== VIEW TOGGLE LOGIC ==========
const listView = document.getElementById("list-view");
const mapView = document.getElementById("map-view");
const listBtn = document.getElementById("view-list");
const mapBtn = document.getElementById("view-map");

listBtn.addEventListener("click", () => {
  listBtn.classList.add("active");
  mapBtn.classList.remove("active");
  listView.classList.remove("hidden");
  mapView.classList.add("hidden");
});

mapBtn.addEventListener("click", () => {
  mapBtn.classList.add("active");
  listBtn.classList.remove("active");
  mapView.classList.remove("hidden");
  listView.classList.add("hidden");
  initTasteMap(); // Initialize/Reset the map
});

// ========== D3 TASTE MAP ==========
function initTasteMap() {
  const container = document.getElementById("taste-map-canvas");
  container.innerHTML = ""; // Clear previous

  const width = container.clientWidth || 800;
  const height = container.clientHeight || 500;
  const centerX = width / 2;
  const centerY = height / 2;

  // Max radius for an orbit is roughly half the shortest dimension minus padding
  const maxRadius = Math.min(width, height) / 2 - 60;

  // 1. Prepare Nodes (Users)
  const nodes = allUsers.map(u => {
    // Fallback to 0 if analyzing hasn't finished
    let score = u.uid === currentUser.uid ? 100 : (typeof u.score === 'number' ? u.score : 0);
    // Inverse distance: 100% = 0px away, 0% = maxRadius away
    let targetRadius = u.uid === currentUser.uid ? 0 : maxRadius - (score / 100 * maxRadius);

    return {
      ...u,
      id: u.uid,
      isMe: u.uid === currentUser.uid,
      score: score,
      targetRadius: targetRadius,
      x: centerX + (Math.random() - 0.5) * 50,
      y: centerY + (Math.random() - 0.5) * 50
    };
  });

  const svg = d3.select("#taste-map-canvas")
    .append("svg")
    .attr("width", "100%")
    .attr("height", "100%")
    .attr("viewBox", [0, 0, width, height]);

  // Draw concentric rings for visual context
  const rings = [25, 50, 75];
  rings.forEach(r => {
    const rpx = maxRadius - (r / 100 * maxRadius);
    svg.append("circle")
      .attr("cx", centerX)
      .attr("cy", centerY)
      .attr("r", rpx)
      .style("fill", "none")
      .style("stroke", "var(--text-light)")
      .style("stroke-width", "1px")
      .style("stroke-dasharray", "4 4")
      .style("opacity", 0.4);
      
    svg.append("text")
      .attr("x", centerX)
      .attr("y", centerY - rpx - 5)
      .style("text-anchor", "middle")
      .style("font-size", "10px")
      .style("fill", "var(--text-light)")
      .style("opacity", 0.6)
      .text(`${r}% Match`);
  });

  // Solar System Force Simulation
  const simulation = d3.forceSimulation(nodes)
    .force("charge", d3.forceManyBody().strength(-200)) // Repel each other gently
    .force("collide", d3.forceCollide().radius(35)) // Prevent overlapping avatars
    .force("r", d3.forceRadial(d => d.targetRadius, centerX, centerY).strength(1)); // Pull into AI score orbit

  // Tooltip
  const tooltip = d3.select("body").append("div")
    .attr("class", "map-tooltip hidden");

  // Define patterns for images
  const defs = svg.append("defs");
  nodes.forEach(node => {
    defs.append("pattern")
      .attr("id", `pattern-${node.id}`)
      .attr("height", 1)
      .attr("width", 1)
      .attr("patternContentUnits", "objectBoundingBox")
      .append("image")
      .attr("height", 1)
      .attr("width", 1)
      .attr("preserveAspectRatio", "xMidYMid slice")
      .attr("href", node.photo || "https://upload.wikimedia.org/wikipedia/commons/8/89/Portrait_Placeholder.png");
  });

  // Draw Nodes
  const nodeGroups = svg.append("g")
    .selectAll("g")
    .data(nodes)
    .enter()
    .append("g")
    .attr("class", "map-node")
    .call(d3.drag()
      .on("start", dragstarted)
      .on("drag", dragged)
      .on("end", dragended));

  nodeGroups.append("circle")
    .attr("r", d => d.isMe ? 35 : 25)
    .style("fill", d => `url(#pattern-${d.id})`)
    .style("stroke", d => d.isMe ? "var(--text-dark)" : "var(--bg)")
    .style("stroke-width", d => d.isMe ? "3px" : "2px")
    .on("mouseover", (event, d) => {
      tooltip.classed("hidden", false)
             .html(`<strong>${d.name || "Anonymous"}</strong><br>${d.isMe ? "You!" : `${d.score}% Match`}`);
      tooltip.style("left", (event.pageX + 10) + "px")
             .style("top", (event.pageY - 20) + "px");
    })
    .on("mouseout", () => {
      tooltip.classed("hidden", true);
    });

  // Label
  nodeGroups.append("text")
    .text(d => d.name?.split(" ")[0] || "Anon")
    .attr("y", d => d.isMe ? 50 : 38)
    .style("text-anchor", "middle")
    .style("font-size", "0.75rem")
    .style("font-weight", d => d.isMe ? "600" : "400")
    .style("fill", "var(--text-dark)");

  simulation.on("tick", () => {
    // Lock the current user directly in the center
    nodes.forEach(d => {
      if (d.isMe) {
        d.x = centerX;
        d.y = centerY;
      }
    });

    nodeGroups.attr("transform", d => `translate(${d.x}, ${d.y})`);
  });

  function dragstarted(event, d) {
    if (d.isMe) return;
    if (!event.active) simulation.alphaTarget(0.3).restart();
    d.fx = d.x;
    d.fy = d.y;
  }
  function dragged(event, d) {
    if (d.isMe) return;
    d.fx = event.x;
    d.fy = event.y;
  }
  function dragended(event, d) {
    if (d.isMe) return;
    if (!event.active) simulation.alphaTarget(0);
    d.fx = null;
    d.fy = null;
  }
}

// ========== AI RECOMMENDATIONS ==========
document.getElementById("ask-ai-btn").addEventListener("click", async () => {
  const wrapper = document.getElementById("ai-recommendation-wrapper");
  wrapper.style.display = "block"; // Show the wrapper
  wrapper.innerHTML = `<div class="shelf-card"><div class="shelf-loading">Analyzing your taste... ✨</div></div>`;
  
  if (!myPicks) {
    wrapper.innerHTML = `<div class="shelf-card"><div class="shelf-loading">Please add picks to your shelf first!</div></div>`;
    return;
  }
  
  try {
    const prompt = `You are a media recommendation AI. The user likes the movie '${myPicks.movie?.name || "none"}', the album '${myPicks.album?.name || "none"}', and the book '${myPicks.book?.name || "none"}'. Recommend 1 new movie, 1 new album, and 1 new book they would enjoy based on these tastes. Respond strictly with a JSON object in this format: {"movie": {"title": "...", "director": "..."}, "album": {"title": "...", "artist": "..."}, "book": {"title": "...", "author": "..."}}. Output only the JSON object, nothing else.`;

    const response = await fetch("https://itp-ima-replicate-proxy.web.app/api/create_n_get", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "meta/meta-llama-3-8b-instruct",
        input: { prompt: prompt, max_new_tokens: 512, temperature: 0.7 }
      })
    });
    
    if (!response.ok) {
      throw new Error("Proxy error");
    }
    
    const result = await response.json();
    let outputStr = result.output.join("");
    
    // Parse the JSON output safely
    if (outputStr.includes("\`\`\`json")) {
        outputStr = outputStr.split("\`\`\`json")[1].split("\`\`\`")[0].trim();
    } else if (outputStr.includes("\`\`\`")) {
        outputStr = outputStr.split("\`\`\`")[1].split("\`\`\`")[0].trim();
    }
    
    const data = JSON.parse(outputStr);
    
    // Fetch images using existing APIs!
    let movieThumb = "", albumThumb = "", bookThumb = "";
    try {
      if (data.movie?.title) {
        const r = await fetch(`https://api.themoviedb.org/3/search/movie?api_key=${TMDB_KEY}&query=${encodeURIComponent(data.movie.title)}`);
        const rData = await r.json();
        if (rData.results?.[0]?.poster_path) {
          movieThumb = `https://image.tmdb.org/t/p/w500${rData.results[0].poster_path}`;
        }
      }
      
      if (data.album?.title) {
        const artist = data.album.artist || "";
        const r = await fetch(`https://ws.audioscrobbler.com/2.0/?method=album.getinfo&api_key=${LASTFM_KEY}&artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(data.album.title)}&format=json`);
        const rData = await r.json();
        const imgList = rData.album?.image;
        if (imgList && imgList.length > 0) {
          albumThumb = imgList[imgList.length - 1]["#text"];
        }
      }
      
      if (data.book?.title) {
        const r = await fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(data.book.title)}&limit=1&fields=cover_i`);
        const rData = await r.json();
        if (rData.docs?.[0]?.cover_i) {
          bookThumb = `https://covers.openlibrary.org/b/id/${rData.docs[0].cover_i}-L.jpg`;
        }
      }
    } catch (e) {
      console.warn("Failed to fetch thumbnails for AI recommendations", e);
    }
    
    // Format the response into the expected format for buildShelfCardHTML
    const aiData = {
      name: "Replicate AI",
      photo: "https://replicate.com/favicon.ico",
      picks: {
        movie: { name: data.movie?.title, director: data.movie?.director, thumb: movieThumb },
        album: { name: data.album?.title, artist: data.album?.artist, thumb: albumThumb },
        book: { name: data.book?.title, author: data.book?.author, thumb: bookThumb }
      }
    };
    
    wrapper.innerHTML = buildShelfCardHTML(aiData, null);
    
  } catch (err) {
    console.error(err);
    wrapper.innerHTML = `<div class="shelf-card"><div class="shelf-loading" style="color: red;">Error getting recommendations: ${err.message}</div></div>`;
  }
});

// ========== JOINT RECOMMENDATIONS ==========
document.getElementById("discover-feed").addEventListener("click", async (e) => {
  if (e.target.classList.contains("card-info-btn")) {
    document.getElementById("info-modal").classList.remove("hidden");
    return;
  }

  if (e.target.classList.contains("joint-btn")) {
    const uid = e.target.getAttribute("data-uid");
    const peerData = allUsers.find(u => u.uid === uid);
    if (!peerData) return;
    
    const wrapper = document.getElementById(`joint-wrap-${uid}`);
    if (wrapper.classList.contains("hidden")) {
      wrapper.classList.remove("hidden");
      e.target.innerHTML = "✨ Hide AI ▲";
      e.target.style.borderBottomLeftRadius = "0";
      e.target.style.borderBottomRightRadius = "0";
      if (wrapper.innerHTML.trim() === "") {
        wrapper.innerHTML = `<div class="shelf-loading" style="padding:1rem;">Asking AI for recommendations…</div>`;
        await fetchJointRecommendations(peerData, wrapper);
      }
    } else {
      wrapper.classList.add("hidden");
      e.target.innerHTML = "✨ Ask AI ▼";
      e.target.style.borderBottomLeftRadius = "var(--radius)";
      e.target.style.borderBottomRightRadius = "var(--radius)";
    }
  }
});

async function fetchJointRecommendations(peerData, wrapper) {
  wrapper.innerHTML = `<div class="shelf-loading">Analyzing your combined tastes... ✨</div>`;
  try {
    const p1 = myPicks || {};
    const p2 = peerData.picks || {};
    
    const prompt = `You are a media recommendation AI. User A likes: Movie: '${p1.movie?.name}', Album: '${p1.album?.name}', Book: '${p1.book?.name}'. User B likes: Movie: '${p2.movie?.name}', Album: '${p2.album?.name}', Book: '${p2.book?.name}'. 
    Recommend 1 new movie, 1 new album, and 1 new book they would BOTH enjoy. 
    Respond ONLY with a raw JSON object. NO backticks, NO markdown, NO preamble.
    Format: {"movie": {"title": "...", "director": "..."}, "album": {"title": "...", "artist": "..."}, "book": {"title": "...", "author": "..."}, "explanation": "..."}`;

    const response = await fetch("https://itp-ima-replicate-proxy.web.app/api/create_n_get", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "meta/meta-llama-3-70b-instruct",
        input: { 
          prompt: prompt,
          max_new_tokens: 1024,
          temperature: 0.7,
          system_prompt: "You are a specialized media recommendation engine. You ONLY output raw JSON. Never include explanations outside the JSON object. Never use markdown code blocks."
        }
      })
    });
    
    if (!response.ok) throw new Error("Proxy error");
    
    const result = await response.json();
    let outputStr = result.output.join("");
    
    // Robust extraction & Auto-Repair
    const firstBrace = outputStr.indexOf("{");
    const lastBrace = outputStr.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1) {
      outputStr = outputStr.substring(firstBrace, lastBrace + 1);
    }
    
    let data;
    try {
      data = JSON.parse(outputStr);
    } catch (e) {
      // Try a simple repair: add missing brace if truncated
      try {
        data = JSON.parse(outputStr + '"}');
      } catch (e2) {
        throw new Error("AI data error. Please try again!");
      }
    }
    
    // Fetch images
    let movieThumb = "", albumThumb = "", bookThumb = "";
    try {
      if (data.movie?.title) {
        const r = await fetch(`https://api.themoviedb.org/3/search/movie?api_key=${TMDB_KEY}&query=${encodeURIComponent(data.movie.title)}`);
        const rData = await r.json();
        if (rData.results?.[0]?.poster_path) movieThumb = `https://image.tmdb.org/t/p/w500${rData.results[0].poster_path}`;
      }
      if (data.album?.title) {
        const artist = data.album.artist || "";
        const r = await fetch(`https://ws.audioscrobbler.com/2.0/?method=album.getinfo&api_key=${LASTFM_KEY}&artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(data.album.title)}&format=json`);
        const rData = await r.json();
        const imgList = rData.album?.image;
        if (imgList && imgList.length > 0) {
          // Try to find 'mega' or 'extralarge', fallback to last available
          const preferredSizes = ['mega', 'extralarge', 'large'];
          let bestImg = imgList[imgList.length - 1]["#text"];
          for (const size of preferredSizes) {
            const found = imgList.find(i => i.size === size);
            if (found && found["#text"]) {
              bestImg = found["#text"];
              break;
            }
          }
          albumThumb = bestImg;
        }
      }
      if (data.book?.title) {
        // Search with title and author for better accuracy
        const q = `${data.book.title} ${data.book.author || ""}`.trim();
        const r = await fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=1&fields=cover_i`);
        const rData = await r.json();
        if (rData.docs?.[0]?.cover_i) {
          bookThumb = `https://covers.openlibrary.org/b/id/${rData.docs[0].cover_i}-L.jpg`;
        }
      }
    } catch (e) { console.warn("Failed fetching thumbs", e); }
    
    const makePick = (pick, label) => `
      <div class="shelf-pick">
        <div class="shelf-pick-image-container">
          ${pick?.thumb
            ? `<img class="shelf-pick-cover" src="${pick.thumb}" alt="" onerror="this.outerHTML='<div class=\\'shelf-pick-cover shelf-pick-cover--empty\\'></div>'">`
            : `<div class="shelf-pick-cover shelf-pick-cover--empty"></div>`}
          <span class="shelf-pick-category-overlay">${label}</span>
        </div>
        <div class="shelf-pick-tile">
          <span class="shelf-pick-title">${pick?.name || "—"}</span>
        </div>
      </div>`;
      
    wrapper.innerHTML = `
      <div class="joint-header">Recommendations for you both:</div>
      <div class="shelf-picks">
        ${makePick({name: data.movie?.title, thumb: movieThumb}, "Movie")}
        ${makePick({name: data.album?.title, thumb: albumThumb}, "Album")}
        ${makePick({name: data.book?.title, thumb: bookThumb}, "Book")}
      </div>
      <p class="ai-explanation">“${data.explanation || "These recommendations blend both of your unique tastes beautifully."}”</p>
    `;
  } catch (err) {
    wrapper.innerHTML = `<div class="shelf-loading" style="color: red;">Error: ${err.message}</div>`;
  }
}

// ========== AI BATCH SCORING ==========
async function fetchAIBatchScores(myPicks, communityUsers) {
  if (!myPicks) return;
  
  const p1 = myPicks;
  let peerText = communityUsers.map((u, i) => {
    const p = u.picks || {};
    return `"${u.uid}": Movie: '${p.movie?.name || "none"}', Album: '${p.album?.name || "none"}', Book: '${p.book?.name || "none"}'`;
  }).join("\n");
  
  const prompt = `You are an expert taste-matching AI. Compare my taste against my peers and calculate a compatibility percentage (0-100) for each peer based on vibe, themes, and aesthetic similarity.
My taste: Movie: '${p1.movie?.name}', Album: '${p1.album?.name}', Book: '${p1.book?.name}'.
Peers:
${peerText}
Instructions:
- Base the score on underlying genre, era, or emotional resonance, even if the exact titles differ.
- Give a minimum baseline score of 15-30 even for poor matches. Good matches should be 60-95.
- Respond ONLY with a valid JSON object mapping the exact string user id to the integer score. NO markdown, NO extra text. Example: {"uid1": 85, "uid2": 42}`;

  try {
    const response = await fetch("https://itp-ima-replicate-proxy.web.app/api/create_n_get", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "meta/meta-llama-3-70b-instruct",
        input: { 
          prompt: prompt,
          max_new_tokens: 1024,
          temperature: 0.2,
          system_prompt: "You are a specialized compatibility scoring engine. You ONLY output raw JSON. Never include explanations. Respond strictly with a JSON object mapping IDs to scores."
        }
      })
    });
    
    if (!response.ok) throw new Error("Proxy error");
    
    const result = await response.json();
    let outputStr = result.output.join("");
    
    // Robust JSON extraction
    const firstBrace = outputStr.indexOf("{");
    const lastBrace = outputStr.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1) {
      outputStr = outputStr.substring(firstBrace, lastBrace + 1);
    }
    
    const scores = JSON.parse(outputStr);
    
    communityUsers.forEach(u => {
      const score = scores[u.uid] !== undefined ? scores[u.uid] : calculateMatch(myPicks, u.picks);
      u.score = score;
      const allUserRef = allUsers.find(x => x.uid === u.uid);
      if (allUserRef) allUserRef.score = score;
      
      const badge = document.getElementById(`badge-${u.uid}`);
      if (badge) {
        const matchClass = score >= 66 ? "match-high" : score >= 33 ? "match-mid" : "match-low";
        badge.className = `match-badge ${matchClass}`;
        badge.innerHTML = `<span class="match-percent">${score}%</span><span class="match-label" style="text-align:center;">match</span>`;
      }
    });
  } catch (err) {
    console.warn("AI Batch Scoring failed, falling back to local math", err);
    communityUsers.forEach(u => {
      const score = calculateMatch(myPicks, u.picks);
      u.score = score;
      const allUserRef = allUsers.find(x => x.uid === u.uid);
      if (allUserRef) allUserRef.score = score;
      
      const badge = document.getElementById(`badge-${u.uid}`);
      if (badge) {
        const matchClass = score >= 66 ? "match-high" : score >= 33 ? "match-mid" : "match-low";
        badge.className = `match-badge ${matchClass}`;
        badge.innerHTML = `<span class="match-percent">${score}%</span><span class="match-label" style="text-align:center;">match</span>`;
      }
    });
  }
}

// ========== INFO MODAL ==========
const infoModal = document.getElementById("info-modal");
document.getElementById("taste-info-btn")?.addEventListener("click", () => {
  infoModal.classList.remove("hidden");
});
document.getElementById("close-info-btn")?.addEventListener("click", () => {
  infoModal.classList.add("hidden");
});

// ========== COMMUNITY SWITCHER & CREATION ==========
// MODAL HELPERS (If still needed for future or removing if unused)
const createClose = document.getElementById("create-close");
if (createClose) {
  createClose.addEventListener("click", () => {
    document.getElementById("create-modal").classList.add("hidden");
  });
}

