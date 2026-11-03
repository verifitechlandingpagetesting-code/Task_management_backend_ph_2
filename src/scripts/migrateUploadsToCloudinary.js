// One-time: copy files already in backend/uploads/* to Cloudinary.
//   npm run migrate:cloudinary            → upload (local files are kept)
//   npm run migrate:cloudinary -- --delete → upload, then delete each local copy that succeeded
// Needs CLOUDINARY_URL (or CLOUDINARY_CLOUD_NAME / _API_KEY / _API_SECRET) in .env.
// Safe to run again: files keep the same name, so a re-run just overwrites them.
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config();
const { FOLDERS, UPLOADS_ROOT, isCloudStorage, storageMode, persistUpload } = await import("../services/fileStorage.js");

if (!isCloudStorage()) {
  console.error("❌ Cloudinary is not configured — set CLOUDINARY_URL (or CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET) in .env");
  process.exit(1);
}

const keepLocal = !process.argv.includes("--delete");
let uploaded = 0;
let failed = 0;

for (const folder of Object.values(FOLDERS)) {
  const dir = path.join(UPLOADS_ROOT, folder);
  if (!fs.existsSync(dir)) continue;
  // voice-*.webm are temp voice samples, never kept
  const files = fs.readdirSync(dir).filter((f) => !f.startsWith(".") && !f.startsWith("voice-") && fs.statSync(path.join(dir, f)).isFile());
  for (const filename of files) {
    const full = path.join(dir, filename);
    // persistUpload deletes the local copy → work on a copy when keeping the original
    const work = keepLocal ? `${full}.migrating` : full;
    try {
      if (keepLocal) fs.copyFileSync(full, work);
      await persistUpload(folder, { filename, path: work });
      uploaded += 1;
      console.log(`✅ ${folder}/${filename}`);
    } catch (err) {
      failed += 1;
      console.error(`❌ ${folder}/${filename}: ${err.message}`);
    } finally {
      if (keepLocal) fs.rmSync(work, { force: true });
    }
  }
}

console.log(`\nStorage: ${storageMode()} — ${uploaded} uploaded, ${failed} failed${keepLocal ? " (local copies kept; re-run with --delete to remove them)" : ""}`);
process.exit(failed ? 1 : 0);
