import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore, collection, getDocs, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseConfig } from './firebase-config.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

let currentUser = null;
let myPicks = null;
let allUsers = []; // global storage for D3 map
let myData = null;  // global storage for own user data

onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href = "index.html"; return; }
  currentUser = user;
  await loadMyShelf();
  await loadCommunity();
});

// ========== LOAD OWN SHELF ==========
async function loadMyShelf() {
  const userDoc = await getDoc(doc(db, "users", currentUser.uid));
  if (!userDoc.exists()) { window.location.href = "onboarding.html"; return; }

  myData = userDoc.data();
  myPicks = myData.picks;

  const card = document.getElementById("own-shelf-card");
  card.innerHTML = buildShelfCardHTML(myData, null); // null = no match badge for own card
}

// ========== LOAD COMMUNITY ==========
async function loadCommunity() {
  const feed = document.getElementById("discover-feed");
  feed.innerHTML = `<div class="shelf-loading">Loading community…</div>`;

  const snapshot = await getDocs(collection(db, "users"));
  const users = [];
  allUsers = []; // Clear previous

  snapshot.forEach(docSnap => {
    const data = docSnap.data();
    allUsers.push(data); // save all for map
    if (data.uid === currentUser.uid) return; // skip self for list
    const score = calculateMatch(myPicks, data.picks);
    users.push({ ...data, score });
  });

  // Sort by match score descending
  users.sort((a, b) => b.score - a.score);

  if (users.length === 0) {
    feed.innerHTML = `<div class="shelf-loading">No one else has joined yet — share the link with friends! 🎉</div>`;
    return;
  }

  feed.innerHTML = "";
  users.forEach(user => {
    const el = document.createElement("div");
    el.innerHTML = buildShelfCardHTML(user, user.score);
    feed.appendChild(el.firstElementChild);
  });
}

// ========== MATCH ALGORITHM ==========
function calculateMatch(myPicks, theirPicks) {
  if (!myPicks || !theirPicks) return 0;
  let score = 0;
  if (myPicks.movie?.id === theirPicks.movie?.id) score += 33;
  if (myPicks.album?.id === theirPicks.album?.id) score += 34;
  if (myPicks.book?.id === theirPicks.book?.id) score += 33;
  return score;
}

// ========== BUILD CARD HTML ==========
function buildShelfCardHTML(userData, matchScore) {
  const { name, photo, picks } = userData;
  const p = picks || {};

  const matchClass = matchScore === null ? "" :
    matchScore >= 66 ? "match-high" :
    matchScore >= 33 ? "match-mid" : "match-low";

  const matchBadge = matchScore !== null ? `
    <div class="match-badge ${matchClass}">
      <span class="match-percent">${matchScore}%</span>
      <span class="match-label">match</span>
    </div>` : "";

  const makePick = (pick, label) => `
    <div class="shelf-pick">
      ${pick?.thumb ? `<img class="shelf-pick-cover" src="${pick.thumb}" alt="">` : `<div class="shelf-pick-cover"></div>`}
      <span class="shelf-pick-category">${label}</span>
      <span class="shelf-pick-title">${pick?.name || "—"}</span>
    </div>`;

  return `
    <div class="shelf-card">
      <div class="shelf-user-info">
        ${photo ? `<img class="shelf-avatar" src="${photo}" alt="">` : `<div class="shelf-avatar"></div>`}
        <span class="shelf-name">${name || "Anonymous"}</span>
      </div>
      <div class="shelf-picks">
        ${makePick(p.movie, "Movie")}
        ${makePick(p.album, "Album")}
        ${makePick(p.book, "Book")}
      </div>
      ${matchBadge}
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

  const width = container.clientWidth;
  const height = container.clientHeight;

  // 1. Prepare Nodes (Users)
  const nodes = allUsers.map(u => ({
    ...u,
    id: u.uid,
    isMe: u.uid === currentUser.uid
  }));

  // 2. Prepare Links (Shared Taste)
  const links = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const u1 = nodes[i];
      const u2 = nodes[j];
      const matchScore = calculateMatch(u1.picks, u2.picks);
      
      if (matchScore > 0) {
        links.push({
          source: u1.id,
          target: u2.id,
          value: matchScore / 33 // 1, 2, or 3
        });
      }
    }
  }

  const svg = d3.select("#taste-map-canvas")
    .append("svg")
    .attr("width", "100%")
    .attr("height", "100%")
    .attr("viewBox", [0, 0, width, height]);

  const simulation = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links).id(d => d.id).distance(d => 150 - (d.value * 30)))
    .force("charge", d3.forceManyBody().strength(-300))
    .force("center", d3.forceCenter(width / 2, height / 2))
    .force("collision", d3.forceCollide().radius(40));

  // Tooltip
  const tooltip = d3.select("body").append("div")
    .attr("class", "map-tooltip hidden");

  // Define patterns for images (clip circles)
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
      .attr("xlink:href", node.photo || "https://www.gravatar.com/avatar/?d=mp");
  });

  const nodeGroups = svg.append("g")
    .selectAll(".node-group")
    .data(nodes)
    .join("g")
    .attr("class", "node-group")
    .call(drag(simulation));

  // Main Circle
  nodeGroups.append("circle")
    .attr("class", "node-circle")
    .attr("r", d => d.isMe ? 28 : 22)
    .attr("fill", d => `url(#pattern-${d.id})`)
    .attr("stroke", d => d.isMe ? "#2C2C2C" : "rgba(0,0,0,0.1)")
    .attr("stroke-width", d => d.isMe ? 3 : 1);

  // Label
  nodeGroups.append("text")
    .attr("class", "node-label")
    .attr("text-anchor", "middle")
    .attr("dy", d => d.isMe ? 42 : 36)
    .text(d => d.isMe ? "You" : d.name.split(" ")[0]);

  // Hover Events
  nodeGroups.on("mouseenter", (event, d) => {
    tooltip.classList.remove("hidden");
    tooltip.style("left", (event.pageX + 10) + "px")
      .style("top", (event.pageY - 10) + "px")
      .html(`
        <span class="tooltip-title">${d.name}</span>
        <span class="tooltip-pick">🎬 ${d.picks?.movie?.name || "—"}</span>
        <span class="tooltip-pick">🎵 ${d.picks?.album?.name || "—"}</span>
        <span class="tooltip-pick">📖 ${d.picks?.book?.name || "—"}</span>
      `);
  })
  .on("mousemove", (event) => {
    tooltip.style("left", (event.pageX + 10) + "px")
      .style("top", (event.pageY - 10) + "px");
  })
  .on("mouseleave", () => {
    tooltip.classList.add("hidden");
  });

  simulation.on("tick", () => {
    nodeGroups.attr("transform", d => `translate(${d.x},${d.y})`);
  });

  function drag(simulation) {
    function dragstarted(event) {
      if (!event.active) simulation.alphaTarget(0.3).restart();
      event.subject.fx = event.subject.x;
      event.subject.fy = event.subject.y;
    }
    function dragged(event) {
      event.subject.fx = event.x;
      event.subject.fy = event.y;
    }
    function dragended(event) {
      if (!event.active) simulation.alphaTarget(0);
      event.subject.fx = null;
      event.subject.fy = null;
    }
    return d3.drag()
      .on("start", dragstarted)
      .on("drag", dragged)
      .on("end", dragended);
  }
}
