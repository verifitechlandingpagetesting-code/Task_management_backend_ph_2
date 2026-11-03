import mongoose from "mongoose";
import dotenv from "dotenv";
import User from "../models/User.js";

dotenv.config();

const seedSuperAdmin = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ MongoDB connected");

    // Check if SuperAdmin already exists
    const existing = await User.findOne({ role: "SuperAdmin" });

    if (existing) {
      console.log("⚠️  SuperAdmin already exists:");
      console.log(`   Email: ${existing.email}`);
      console.log(`   ID: ${existing._id}`);
      process.exit(0);
    }

    // Create SuperAdmin
    const superAdmin = await User.create({
      name: "Super Admin",
      email: "rjkk20012@gmail.com",
      password: "SuperAdmin@123",
      phone: "9999999999",
      role: "SuperAdmin",
      status: "Active",
      createdBy: null,
    });

    console.log("✅ SuperAdmin created successfully!");
    console.log(`   Name:     ${superAdmin.name}`);
    console.log(`   Email:    ${superAdmin.email}`);
    console.log(`   Password: SuperAdmin@123`);
    console.log(`   ID:       ${superAdmin._id}`);
    console.log("\n⚠️  Change the password after first login!");

    process.exit(0);
  } catch (error) {
    console.error("❌ Seed Error:", error.message);
    process.exit(1);
  }
};

seedSuperAdmin();