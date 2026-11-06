
import mongoose from "mongoose";
import dotenv from "dotenv";
import User from "../models/User.js";

dotenv.config();

// =====================================================
// TEMPORARY SUPERADMIN CREDENTIALS
// =====================================================

const SUPERADMIN_EMAIL = "digital.1@verifitech.email";
const SUPERADMIN_PASSWORD = "Task_Management_";

const seedSuperAdmin = async () => {
  try {
    if (!process.env.MONGO_URI) {
      throw new Error("MONGO_URI is missing");
    }

    const email = SUPERADMIN_EMAIL.trim().toLowerCase();
    const password = SUPERADMIN_PASSWORD;

    await mongoose.connect(process.env.MONGO_URI);
    console.log("MongoDB connected");

    // Find existing SuperAdmin
    let admin = await User.findOne({ role: "SuperAdmin" });

    // Check whether email already belongs to another user
    const emailOwner = await User.findOne({ email });

    if (emailOwner && (!admin || !emailOwner._id.equals(admin._id))) {
      throw new Error("Email already belongs to another user");
    }

    if (admin) {
      // Update existing SuperAdmin
      admin.name = "Super Admin";
      admin.email = email;
      admin.password = password;
      admin.status = "Active";
      admin.emailVerified = true;

      await admin.save();

      console.log("Existing SuperAdmin updated successfully");
    } else {
      // Create new SuperAdmin
      admin = await User.create({
        name: "Super Admin",
        email,
        password,
        phone: "9999999999",
        role: "SuperAdmin",
        status: "Active",
        emailVerified: true,
        createdBy: null,
        admin_id: null
      });

      console.log("SuperAdmin created successfully");
    }

    console.log("--------------------------------");
    console.log("SuperAdmin Seed Completed");
    console.log("Email:", admin.email);
    console.log("Role:", admin.role);
    console.log("ID:", admin._id);
    console.log("--------------------------------");

  } catch (error) {
    console.error("Seed Error:", error.message);
    process.exitCode = 1;
  } finally {
    if (mongoose.connection.readyState) {
      await mongoose.disconnect();
      console.log("MongoDB disconnected");
    }
  }
};

seedSuperAdmin();
