// FCM push — students ko data update ki khabar.
// Firebase Admin SDK chahiye + service account key (data/serviceAccountKey.json).
// Key nahi hai to chupchaap skip (server baaki kaam karta rahega).
let admin = null;
try {
  const fs = require('fs');
  const path = require('path');
  const keyPath = path.join(__dirname, 'data', 'serviceAccountKey.json');
  if (fs.existsSync(keyPath)) {
    admin = require('firebase-admin');
    admin.initializeApp({ credential: admin.credential.cert(require(keyPath)) });
  }
} catch (e) { admin = null; }

// topic = studentId (app isi topic ko subscribe karta hai)
async function pushToStudent(studentId, title, body) {
  if (!admin) return false;
  try {
    await admin.messaging().send({
      topic: 'stu_' + studentId,
      notification: { title, body },
      android: { priority: 'high' },
    });
    return true;
  } catch { return false; }
}

module.exports = { pushToStudent, enabled: () => !!admin };
