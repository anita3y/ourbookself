// Run with: node migrate-node.js
// Requires: npm install firebase-admin

const admin = require("firebase-admin");
const path = require("path");

// ⚠️ You need to download your Firebase service account key from:
// Firebase Console → Project Settings → Service Accounts → Generate New Private Key
// Save it as serviceAccountKey.json in the our-bookshelf folder
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function migrate() {
  console.log("Starting migration...");

  // 1. Create the creative-computing-s26 community doc
  await db.collection("communities").doc("creative-computing-s26").set({
    name: "Creative Computing S26",
    hostEmail: "anita3yan@gmail.com",
    createdAt: new Date().toISOString()
  });
  console.log("✅ Created community document.");

  // 2. Update all users
  const snapshot = await db.collection("users").get();
  let count = 0;
  for (const docSnap of snapshot.docs) {
    await docSnap.ref.update({
      communities: admin.firestore.FieldValue.arrayUnion("creative-computing-s26")
    });
    count++;
    console.log(`  Updated user ${docSnap.id} (${count}/${snapshot.size})`);
  }

  console.log(`\n✅ Migration complete — ${count} users updated.`);
  process.exit(0);
}

migrate().catch(err => {
  console.error("Migration failed:", err);
  process.exit(1);
});
