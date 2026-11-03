// src/services/fileStorage.js
// One place that decides WHERE uploaded files live.
//
//   Cloudinary  — when CLOUDINARY_URL (or CLOUDINARY_CLOUD_NAME + CLOUDINARY_API_KEY +
//                 CLOUDINARY_API_SECRET) is set. Files are uploaded as private
//                 ("authenticated") assets; the local temp copy written by multer is deleted.
//   Local disk  — otherwise (local development, tests): backend/uploads/<folder>, exactly as before.
//
// Every file keeps the same `filename` it always had, so nothing in MongoDB changes.
// Files are NEVER served by a public Cloudinary link: downloads still go through the
// existing authenticated, permission-checked endpoints, which stream the bytes from
// Cloudinary (Range requests pass through, so video seeking keeps working).
// Files uploaded before Cloudinary was switched on are still served from disk when present
// (see scripts/migrateUploadsToCloudinary.js to move them).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { v2 as cloudinary } from "cloudinary";

export const UPLOADS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../uploads");

// Storage folders (same names as the old uploads/ sub-folders)
export const FOLDERS = Object.freeze({
  tasks: "tasks", // task + Task Bank attachments
  chat: "chat", // chat message files
  chatBackup: "chat-backup", // chat files whose message expired
  meetingFiles: "meeting-files", // MoM attachments + in-call chat files
  recordings: "meetings", // MoM / video-call recordings
});

// Local folder (multer writes here first; in Cloudinary mode it is only a temp area)
export const localDir = (folder) => {
  const dir = path.join(UPLOADS_ROOT, folder);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const safeName = (filename) => path.basename(String(filename || ""));
export const localPath = (folder, filename) => path.join(UPLOADS_ROOT, folder, safeName(filename));
const localExists = (folder, filename) => Boolean(filename) && fs.existsSync(localPath(folder, filename));

/* =========================================================
   Cloudinary driver
========================================================= */

const MEDIA_EXT = /\.(webm|mp4|m4a|mp3|ogg|oga|wav|mov|mkv|aac|flac)$/i;
const LARGE_FILE = 20 * 1024 * 1024; // above this → chunked upload

const cloudConfig = () => {
  if (process.env.CLOUDINARY_URL) {
    try {
      const u = new URL(process.env.CLOUDINARY_URL); // cloudinary://KEY:SECRET@CLOUD
      return { cloud_name: u.hostname, api_key: decodeURIComponent(u.username), api_secret: decodeURIComponent(u.password) };
    } catch {
      return null;
    }
  }
  const { CLOUDINARY_CLOUD_NAME: cloud_name, CLOUDINARY_API_KEY: api_key, CLOUDINARY_API_SECRET: api_secret } = process.env;
  return cloud_name && api_key && api_secret ? { cloud_name, api_key, api_secret } : null;
};

export const createCloudinaryDriver = (config) => {
  cloudinary.config({ ...config, secure: true });
  const root = String(process.env.CLOUDINARY_FOLDER || "task-management").replace(/^\/+|\/+$/g, "");

  // audio/video → "video" (Cloudinary's media type, larger size limits); everything else → "raw"
  const asset = (folder, filename) => {
    const name = safeName(filename);
    const ext = path.extname(name).slice(1).toLowerCase();
    const media = MEDIA_EXT.test(name);
    return {
      resource_type: media ? "video" : "raw",
      // raw assets keep the extension in the id; media assets carry it as the format
      public_id: `${root}/${folder}/${media ? name.slice(0, -(ext.length + 1)) : name}`,
      format: media ? ext : undefined,
    };
  };

  const signedUrl = (folder, filename) => {
    const a = asset(folder, filename);
    return cloudinary.url(a.public_id, {
      resource_type: a.resource_type,
      type: "authenticated",
      sign_url: true,
      secure: true,
      ...(a.format ? { format: a.format } : {}),
    });
  };

  return {
    name: "cloudinary",

    async upload(file, folder, filename) {
      const a = asset(folder, filename);
      const options = {
        resource_type: a.resource_type,
        public_id: a.public_id,
        type: "authenticated", // never publicly reachable
        overwrite: true,
        use_filename: false,
        unique_filename: false,
      };
      const size = fs.statSync(file).size;
      if (size > LARGE_FILE) {
        await new Promise((resolve, reject) =>
          cloudinary.uploader.upload_large(file, { ...options, chunk_size: LARGE_FILE }, (err, res) => (err ? reject(err) : resolve(res)))
        );
      } else {
        await cloudinary.uploader.upload(file, options);
      }
    },

    // → { status, headers, body (web stream) } or null when missing
    async open(folder, filename, range) {
      const res = await fetch(signedUrl(folder, filename), { headers: range ? { Range: range } : {} });
      if (res.status === 404 || res.status === 401 || res.status === 403) return null;
      if (!res.ok) throw new Error(`Cloudinary returned ${res.status}`);
      return { status: res.status, headers: res.headers, body: res.body };
    },

    async remove(folder, filename) {
      const a = asset(folder, filename);
      await cloudinary.uploader.destroy(a.public_id, { resource_type: a.resource_type, type: "authenticated", invalidate: true });
    },

    async move(fromFolder, toFolder, filename) {
      const from = asset(fromFolder, filename);
      const to = asset(toFolder, filename);
      await cloudinary.uploader.rename(from.public_id, to.public_id, {
        resource_type: from.resource_type,
        type: "authenticated",
        to_type: "authenticated",
        overwrite: true,
        invalidate: true,
      });
    },
  };
};

/* =========================================================
   Active driver
========================================================= */

let remote = null; // null → local disk only
let remoteResolved = false;

const getRemote = () => {
  if (!remoteResolved) {
    remoteResolved = true;
    const disabled = /^local$/i.test(process.env.FILE_STORAGE || "");
    const config = disabled ? null : cloudConfig();
    remote = config ? createCloudinaryDriver(config) : null;
    if (remote) console.log(`☁️  File storage: Cloudinary (${config.cloud_name})`);
  }
  return remote;
};

// Tests / scripts can plug in another driver (null → local disk)
export const setRemoteStorage = (driver) => {
  remote = driver;
  remoteResolved = true;
};

export const storageMode = () => (getRemote() ? getRemote().name : "local");
export const isCloudStorage = () => Boolean(getRemote());

/* =========================================================
   Public API used by the controllers
========================================================= */

/**
 * After multer saved a file to localDir(folder): send it to the cloud and delete the local copy.
 * Local mode → nothing to do. Throws if the cloud upload fails (the local copy is removed then too).
 */
export const persistUpload = async (folder, file) => {
  const driver = getRemote();
  if (!driver || !file?.filename) return;
  const local = file.path || localPath(folder, file.filename);
  try {
    await driver.upload(local, folder, file.filename, file.mimetype);
  } finally {
    await fs.promises.unlink(local).catch(() => {});
  }
};

export const persistUploads = async (folder, files = []) => {
  const done = [];
  try {
    for (const f of files) {
      await persistUpload(folder, f);
      done.push(f);
    }
  } catch (err) {
    // one failed → undo the ones already uploaded, delete the rest locally
    await Promise.all(done.map((f) => removeStoredFile(folder, f.filename)));
    await Promise.all(files.map((f) => fs.promises.unlink(f.path || localPath(folder, f.filename)).catch(() => {})));
    throw err;
  }
};

/** Delete a stored file everywhere it may be (disk and cloud). Never throws. */
export const removeStoredFile = async (folder, filename) => {
  if (!filename) return;
  await fs.promises.unlink(localPath(folder, filename)).catch(() => {});
  const driver = getRemote();
  if (driver) {
    await driver.remove(folder, safeName(filename)).catch((err) =>
      console.error(`file storage: could not delete ${folder}/${safeName(filename)}:`, err.message)
    );
  }
};

/** Move a file between folders (chat → chat-backup). Returns true when moved. */
export const moveStoredFile = async (fromFolder, toFolder, filename) => {
  if (localExists(fromFolder, filename)) {
    localDir(toFolder);
    await fs.promises.rename(localPath(fromFolder, filename), localPath(toFolder, filename));
    return true;
  }
  const driver = getRemote();
  if (!driver) return false;
  await driver.move(fromFolder, toFolder, safeName(filename));
  return true;
};

/**
 * Send a stored file as the response.
 *   download: true → "Save as" with `name`; otherwise shown inline with `mimetype`.
 * Resolves false (and sends nothing) when the file does not exist, so the caller can 404.
 */
export const sendStoredFile = async (req, res, folder, filename, { name, mimetype, download = true } = {}) => {
  if (!filename) return false;

  // on disk (local mode, or a file from before Cloudinary was switched on)
  if (localExists(folder, filename)) {
    const full = localPath(folder, filename);
    if (download) res.download(full, name || safeName(filename));
    else {
      if (mimetype) res.type(mimetype);
      res.sendFile(full);
    }
    return true;
  }

  const driver = getRemote();
  if (!driver) return false;
  const file = await driver.open(folder, safeName(filename), req.headers.range);
  if (!file) return false;

  res.status(file.status === 206 ? 206 : 200);
  for (const h of ["content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
    const v = file.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  if (!res.getHeader("accept-ranges")) res.setHeader("Accept-Ranges", "bytes");
  res.type(mimetype || file.headers.get("content-type") || "application/octet-stream");
  if (download) res.attachment(name || safeName(filename));
  else res.setHeader("Content-Disposition", "inline");

  await pipeline(Readable.fromWeb(file.body), res).catch(() => {
    /* client went away mid-download */
  });
  return true;
};

/**
 * Run fn(localFilePath) on a stored file (Whisper needs a real file on disk).
 * Cloud files are downloaded to a temp file that is removed afterwards.
 */
export const withLocalCopy = async (folder, filename, fn) => {
  if (localExists(folder, filename)) return fn(localPath(folder, filename));
  const driver = getRemote();
  const file = driver ? await driver.open(folder, safeName(filename)) : null;
  if (!file) throw Object.assign(new Error("The file is missing."), { code: "FILE_MISSING" });

  const tmp = path.join(os.tmpdir(), `tm-${crypto.randomUUID()}${path.extname(safeName(filename))}`);
  try {
    await pipeline(Readable.fromWeb(file.body), fs.createWriteStream(tmp));
    return await fn(tmp);
  } finally {
    await fs.promises.unlink(tmp).catch(() => {});
  }
};
