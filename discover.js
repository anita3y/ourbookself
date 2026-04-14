import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore, collection, getDocs, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseConfig } from './firebase-config.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

let currentUser = null;
let myPicks = null;

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

  const data = userDoc.data();
  myPicks = data.picks;

  const card = document.getElementById("own-shelf-card");
  card.innerHTML = buildShelfCardHTML(data, null); // null = no match badge for own card
}

// ========== LOAD COMMUNITY ==========
async function loadCommunity() {
  const feed = document.getElementById("discover-feed");
  feed.innerHTML = `<div class="shelf-loading">Loading community…</div>`;

  const snapshot = await getDocs(collection(db, "users"));
  const users = [];

  snapshot.forEach(docSnap => {
    const data = docSnap.data();
    if (data.uid === currentUser.uid) return; // skip self
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
