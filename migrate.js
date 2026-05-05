import { db } from "./firebase-config.js";
import { collection, getDocs, doc, setDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.7.2/firebase-firestore.js";

document.getElementById("run-migration").addEventListener("click", async () => {
  const output = document.getElementById("output");
  output.innerText = "Starting migration...\n";
  
  try {
    // 1. Create the community doc
    await setDoc(doc(db, "communities", "creative-computing-s26"), {
      name: "Creative Computing S26",
      hostEmail: "anita3yan@gmail.com",
      createdAt: new Date().toISOString()
    });
    output.innerText += "Created community document.\n";
    
    // 2. Update all users
    const querySnapshot = await getDocs(collection(db, "users"));
    let count = 0;
    for (const docSnap of querySnapshot.docs) {
      await updateDoc(doc(db, "users", docSnap.id), {
        communities: ["creative-computing-s26"]
      });
      count++;
    }
    
    output.innerText += `Successfully updated ${count} users.\nMigration Complete.`;
  } catch (error) {
    output.innerText += `Error: ${error.message}`;
    console.error(error);
  }
});
