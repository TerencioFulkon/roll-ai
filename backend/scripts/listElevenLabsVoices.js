import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import fetch from "node-fetch";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

async function listVoices() {
  const response = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY }
  });

  const data = await response.json();
  console.log("Status:", response.status);
  console.log("Raw response:", JSON.stringify(data, null, 2));

  const voices = data.voices;
  if (!voices) {
    console.error("No voices array in response — API key may be missing or invalid");
    process.exit(1);
  }

  const byGender = { male: [], female: [], other: [] };
  voices.forEach((v) => {
    const g = v.labels?.gender?.toLowerCase();
    (byGender[g] || byGender.other).push(v);
  });
  for (const [gender, list] of Object.entries(byGender)) {
    if (!list.length) continue;
    console.log(`\n=== ${gender.toUpperCase()} ===`);
    list.forEach((v) =>
      console.log(`${v.name.padEnd(20)} | ${v.voice_id} | ${v.labels?.accent || ""} | ${v.labels?.description || ""}`)
    );
  }
}

listVoices().catch(console.error);
