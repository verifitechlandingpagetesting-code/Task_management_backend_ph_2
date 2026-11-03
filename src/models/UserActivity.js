import mongoose from "mongoose";

/* =========================================================
   UserActivity — ONE document per login session.
   A user logged in on two browsers has two documents, so one
   browser closing never marks the other session offline.

   Online  = status "active" AND lastSeenAt within the presence timeout
             (see services/activityService.js → PRESENCE_TIMEOUT_MS).
   Offline = anything else. A background sweep closes sessions whose
             heartbeat stopped ("timed_out") or whose JWT expired ("expired").

   orgId is the tenant key, copied from the user at login:
     Admin → their own _id | Manager/User → admin_id | SuperAdmin → null
========================================================= */

const SESSION_STATUSES = ["active", "logged_out", "timed_out", "expired"];

const userActivitySchema = new mongoose.Schema(
  {
    // Identifies the session from the JWT (the token's `sid`, or a hash of an older
    // token issued before session tracking). Never returned by any API.
    sessionKey: { type: String, required: true, unique: true, select: false },

    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    orgId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    role: { type: String, default: "User" }, // role at login time

    loginAt: { type: Date, required: true, default: Date.now },
    lastSeenAt: { type: Date, required: true, default: Date.now }, // heartbeat / socket / any API call
    lastActivityAt: { type: Date, default: Date.now }, // real interaction (input, API call)
    logoutAt: { type: Date, default: null },
    endedAt: { type: Date, default: null }, // logout / timeout / expiry time
    expiresAt: { type: Date, default: null }, // JWT expiry

    status: { type: String, enum: SESSION_STATUSES, default: "active" },
    // "login" → created by POST /api/auth/login | "resumed" → token from before tracking existed
    source: { type: String, enum: ["login", "resumed"], default: "login" },

    ip: { type: String, default: "" },
    userAgent: { type: String, default: "", maxlength: 512, select: false },
    device: {
      browser: { type: String, default: "Unknown" },
      os: { type: String, default: "Unknown" },
      type: { type: String, default: "Desktop" }, // Desktop | Mobile | Tablet
    },
  },
  { timestamps: true }
);

// Per-user history + "is this user online?" lookups
userActivitySchema.index({ userId: 1, loginAt: -1 });
userActivitySchema.index({ userId: 1, status: 1, lastSeenAt: -1 });
// Tenant-scoped history, "logins today" and online counts
userActivitySchema.index({ orgId: 1, loginAt: -1 });
userActivitySchema.index({ orgId: 1, status: 1, lastSeenAt: -1 });
// Global (SuperAdmin) history + the presence sweep
userActivitySchema.index({ loginAt: -1 });
userActivitySchema.index({ status: 1, lastSeenAt: 1 });

export const ACTIVITY_SESSION_STATUSES = SESSION_STATUSES;

const UserActivity =
  mongoose.models.UserActivity || mongoose.model("UserActivity", userActivitySchema);
export default UserActivity;
