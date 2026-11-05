
import mongoose from "mongoose";
import dotenv from "dotenv";
import User from "../models/User.js";

dotenv.config();

const seedSuperAdmin = async () => {
  try {
    if (!process.env.MONGO_URI) {
      throw new Error("MONGO_URI is missing");
    }

    const email = process.env.SUPERADMIN_EMAIL?.trim().toLowerCase();
    const password = process.env.SUPERADMIN_PASSWORD;

    if (!email || !password) {
      throw new Error("SUPERADMIN_EMAIL or SUPERADMIN_PASSWORD missing");
    }

    await mongoose.connect(process.env.MONGO_URI);
    console.log("MongoDB connected");

    let admin = await User.findOne({ role: "SuperAdmin" });

    const emailOwner = await User.findOne({ email });

    if (emailOwner && (!admin || !emailOwner._id.equals(admin._id))) {
      throw new Error("Email already belongs to another user");
    }

    if (admin) {
      admin.name = "Super Admin";
      admin.email = email;
      admin.password = password;
      admin.status = "Active";
      admin.emailVerified = true;

      await admin.save();

      console.log("Existing SuperAdmin updated");
    } else {
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

      console.log("SuperAdmin created");
    }

    console.log("Email:", admin.email);
    console.log("Role:", admin.role);
    console.log("ID:", admin._id);

  } catch (error) {
    console.error("Seed Error:", error.message);
    process.exitCode = 1;
  } finally {
    if (mongoose.connection.readyState) {
      await mongoose.disconnect();
    }
  }
};

seedSuperAdmin();
