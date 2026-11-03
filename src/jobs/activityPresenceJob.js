import cron from "node-cron";
import { sweepPresence } from "../services/activityService.js";

// Every minute: sessions whose heartbeat stopped → offline ("timed_out"),
// sessions whose login token expired → "expired". Keeps nobody "online forever".
export const startActivityPresenceJob = () => {
  cron.schedule("* * * * *", async () => {
    try {
      await sweepPresence();
    } catch (err) {
      console.error("activity presence sweep:", err.message);
    }
  });
  console.log("✅ Activity presence sweep scheduled (every minute)");
};
