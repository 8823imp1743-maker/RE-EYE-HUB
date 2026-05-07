// ==============================
// Gemini 接続テスト（最終確定版）
// ==============================

const API_KEY = "AIzaSyD4U7cBFRmFL6s3-RINKL23tJ-dL27LaMg";
const MODEL = "gemini-2.0-flash";

const URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

async function run() {
  try {
    const res = await fetch(URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: "Hello test" }
            ]
          }
        ]
      })
    });

    const data = await res.json();

    console.log("Status:", res.status);

    if (res.status === 200) {
      console.log("✅ SUCCESS");
      console.log(data.candidates[0].content.parts[0].text);
    } else {
      console.log("❌ ERROR");
      console.log(JSON.stringify(data, null, 2));
    }

  } catch (err) {
    console.error("🔥 Fetch Error:", err);
  }
}

run();