const mongoose = require("mongoose");

const otpSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  otp: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  language: { type: String, required: true },
});

module.exports = mongoose.model("Otp", otpSchema);
