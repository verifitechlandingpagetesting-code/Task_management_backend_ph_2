import express from "express";
import {
  heartbeat,
  logout,
  getSummary,
  listUsers,
  listHistory,
  recentLogins,
  getUserHistory,
  listOrganizations,
} from "../controllers/activityController.js";
import {
  requireActivityAccess,
  requireSuperAdmin,
  resolveActivityScope,
} from "../middleware/activityMiddleware.js";

// Mounted at /api/activity behind authenticate → attachScope → attachPermissions (app.js)
const router = express.Router();

// ---- Presence: every logged-in user (records only their OWN session) ----
router.post("/heartbeat", heartbeat);
router.post("/logout", logout);

// ---- Monitoring: SuperAdmin + Admin only; the organization comes from the token ----
const monitor = [requireActivityAccess, resolveActivityScope];

router.get("/summary", ...monitor, getSummary);
router.get("/users", ...monitor, listUsers);
router.get("/users/:userId/history", ...monitor, getUserHistory);
router.get("/history", ...monitor, listHistory);
router.get("/recent", ...monitor, recentLogins);

// ---- Multi-tenant (SuperAdmin only) ----
router.get("/organizations", requireSuperAdmin, listOrganizations);
router.get("/organizations/:orgId", requireSuperAdmin, resolveActivityScope, getSummary);

export default router;
