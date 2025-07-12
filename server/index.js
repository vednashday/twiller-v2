const express = require("express");
const cors = require("cors");
const { MongoClient } = require("mongodb");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

const createChatbotRoute = require("./routes/chatbot");
const Razorpay = require("razorpay");

require("dotenv").config();

const app = express();
const port = 5000;

const serviceAccount = {
  type: process.env.FIREBASE_TYPE,
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
};

// ✅ MongoDB
const uri = process.env.MONGO_URI;
const client = new MongoClient(uri, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  maxPoolSize: 10,
});

// ✅ Firebase Admin Init
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// ✅ Middleware: Firebase Token Verification
const verifyFirebaseToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Missing or invalid token" });
  }

  const idToken = authHeader.split("Bearer ")[1];

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken;
    next();
  } catch (error) {
    return res.status(401).json({ message: "Unauthorized", error: error.message });
  }
};

// ✅ Email Transporter
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});


// ✅ Express Middleware
app.use(cors());
app.use(express.json());

// ✅ Password Generator
function generatePassword(length = 10) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let password = "";
  for (let i = 0; i < length; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_TEST_KEY_ID,
  key_secret: process.env.RAZORPAY_TEST_KEY_SECRET,
});

function isPaymentWindowOpen() {
  
  const now = new Date();
  const istTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const hours = istTime.getHours();
  return hours === 10;
  
 return true;
}


// ✅ Main Async Run
async function run() {
  try {
    await client.connect();

    const db = client.db("database");
    const usercollection = db.collection("users");
    const postcollection = db.collection("posts");
    const audiOtpCollection = db.collection("audio_otps");

    await audiOtpCollection.createIndex({ createdAt: 1 }, { expireAfterSeconds: 300 });

    const chatbotRoute = createChatbotRoute(client);
    app.use("/api/chatbot", chatbotRoute);

    // Register
    app.post("/register", async (req, res) => {
      const user = req.body;
      const result = await usercollection.insertOne(user);
      res.send(result);
    });

    // Get Logged In User
    app.get("/loggedinuser", async (req, res) => {
      const email = req.query.email;
      if (!email) return res.status(400).json({ error: "Email required" });

      const user = await usercollection.findOne({ email });
      if (!user) return res.status(404).json({ error: "User not found" });

      res.json(user);
    });
    const subscriptionLimits = {
      free: 1,
      bronze: 3,
      silver: 5,
      gold: Infinity,
    };

    // ✅ Create Tweet (protected)
    app.post("/post", verifyFirebaseToken, async (req, res) => {
      const { post, photo, audio, username, name, profilephoto } = req.body;
      const email = req.user.email;
      const user = await usercollection.findOne({ email });

      const plan = user.subscription || "free";
      const tweetLimit = subscriptionLimits[plan];

      const userTweets = await postcollection.countDocuments({
        email,
        createdAt: { $gte: new Date(new Date().setDate(new Date().getDate() - 30)) }, // monthly
      });

      if (userTweets >= tweetLimit) {
        return res.status(403).json({ message: "Tweet limit reached for your plan" });
      }
      const result = await postcollection.insertOne({
        post,
        photo,
        audio,
        username,
        name,
        profilephoto,
        email,
        createdAt: new Date(),
      });

      res.send(result);
    });

    // Get All Posts
    app.get("/post", async (req, res) => {
      const post = await postcollection.find().sort({ createdAt: -1 }).toArray();
      res.send(post);
    });

    // Posts by User
    app.get("/userpost", async (req, res) => {
      const email = req.query.email;
      const posts = await postcollection.find({ email }).sort({ createdAt: -1 }).toArray();
      res.send(posts);
    });

    // All Users
    app.get("/user", async (req, res) => {
      const users = await usercollection.find().toArray();
      res.send(users);
    });

    // Update User
    app.patch("/userupdate/:email", async (req, res) => {
  const email = decodeURIComponent(req.params.email);
  const { username } = req.body;

  if (username) {
    const taken = await usercollection.findOne({ username });
    if (taken && taken.email !== email) {
      return res.status(409).json({ error: "Username already taken" });
    }
  }

  const updateDoc = { $set: req.body };
  const result = await usercollection.updateOne({ email }, updateDoc, { upsert: true });
  res.send(result);
  });

    // ✅ Send OTP for Audio
    app.post("/send-audio-otp", async (req, res) => {
      const { email, idToken } = req.body;
      try {
        const decoded = await admin.auth().verifyIdToken(idToken);
        if (decoded.email !== email) throw new Error("Unauthorized");
      } catch {
        return res.status(403).json({ success: false });
      }

      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      await audiOtpCollection.updateOne(
        { email },
        { $set: { otp, createdAt: new Date() } },
        { upsert: true }
      );

      try {
        await transporter.sendMail({
          from: '"Twiller Voice" <vedanshpsingh@gmail.com>',
          to: email,
          subject: "Your OTP for Audio Upload",
          text: `Your OTP is: ${otp} (Valid for 5 minutes)`,
        });
        res.json({ success: true, message: "OTP sent" });
      } catch (err) {
        console.error("OTP email error:", err.message);
        res.status(500).json({ success: false, message: "Failed to send email." });
      }
    });

    // ✅ Verify OTP
    app.post("/verify-audio-otp", async (req, res) => {
      const { email, otp } = req.body;
      const record = await audiOtpCollection.findOne({ email });

      if (!record) return res.status(404).json({ verified: false });

      const isValid = record.otp === otp && new Date() - new Date(record.createdAt) <= 5 * 60 * 1000;
      return isValid
        ? res.json({ verified: true })
        : res.status(401).json({ verified: false });
    });

    // ✅ Upload Voice Tweet
    app.post("/voice-tweet", async (req, res) => {
      const { email, audioUrl, post, name, username, profilephoto } = req.body;
      if (!email || !audioUrl) return res.status(400).json({ success: false });

      const result = await postcollection.insertOne({
        audio: audioUrl,
        post: post || "",
        name,
        username,
        profilephoto,
        email,
        createdAt: new Date(),
      });

      res.json({ success: true, data: result });
    });

    // ✅ Forgot Password
    app.post("/forgot-password", async (req, res) => {
      const { identifier, method } = req.body;

      if (!identifier || !method) {
        return res.status(400).json({ message: "Identifier and method required." });
      }

      const user = await usercollection.findOne({
        $or: [{ email: identifier }, { phone: identifier }],
      });

      if (!user) {
        return res.status(404).json({ message: "User not found." });
      }

      const now = new Date();
      const lastReset = user.lastPasswordReset ? new Date(user.lastPasswordReset) : null;

      if (lastReset && now - lastReset < 24 * 60 * 60 * 1000) {
        return res.status(429).json({ message: "You can reset only once per day." });
      }

      if (method === "email") {
        try {
          await admin.auth().generatePasswordResetLink(user.email);
          await usercollection.updateOne(
            { _id: user._id },
            { $set: { lastPasswordReset: now } }
          );
          return res.json({ message: `Reset link sent to ${user.email}` });
        } catch (err) {
          return res.status(500).json({ message: "Failed to send reset email." });
        }
      }

      if (method === "generate") {
        const newPassword = generatePassword();
        try {
          const firebaseUser = await admin.auth().getUserByEmail(user.email);
          await admin.auth().updateUser(firebaseUser.uid, { password: newPassword });

          await usercollection.updateOne(
            { _id: user._id },
            { $set: { password: newPassword, lastPasswordReset: now } }
          );

          return res.json({ message: `New password: ${newPassword}` });
        } catch (err) {
          return res.status(500).json({ message: "Failed to update Firebase password." });
        }
      }

      res.status(400).json({ message: "Invalid method." });
    });

    app.post("/create-subscription", verifyFirebaseToken, async (req, res) => {
  if (!isPaymentWindowOpen()) {
    return res.status(403).json({ message: "Payment allowed only between 10–11 AM IST" });
  }

  const { plan } = req.body;
  const amountMap = { bronze: 100, silver: 300, gold: 1000 };

  const amount = amountMap[plan];
  if (!amount) return res.status(400).json({ message: "Invalid plan" });

  const options = {
    amount: amount * 100,
    currency: "INR",
    receipt: `receipt_${Date.now()}`,
  };

  const order = await razorpay.orders.create(options);
  res.json({ orderId: order.id, amount: order.amount });
});

app.get("/tweet-limit", verifyFirebaseToken, async (req, res) => {
  const email = req.user.email;

  const user = await usercollection.findOne({ email });
  const plan = user.subscription || "free";

  const subscriptionLimits = {
    free: 1,
    bronze: 3,
    silver: 5,
    gold: Infinity,
  };

  const tweetLimit = subscriptionLimits[plan];

  const userTweets = await postcollection.countDocuments({
    email,
    createdAt: { $gte: new Date(new Date().setDate(new Date().getDate() - 30)) },
  });

  const tweetsLeft = tweetLimit === Infinity ? Infinity : tweetLimit - userTweets;

  res.json({ tweetsLeft, plan });
});


app.post("/payment-success", async (req, res) => {
  const { email, plan, paymentId } = req.body;

  const amountMap = { bronze: 100, silver: 300, gold: 1000 };

  // Update user's subscription
  await usercollection.updateOne(
    { email },
    { $set: { subscription: plan, subscribedAt: new Date(), paymentId } }
  );

  // Send invoice
  await transporter.sendMail({
    from: '"Twiller Subscriptions" <vedanshpsingh@gmail.com>',
    to: email,
    subject: `Twiller Subscription: ${plan.toUpperCase()} Plan`,
    text: `Thanks for subscribing to ${plan.toUpperCase()} Plan!\n\nAmount: ₹${amountMap[plan]}\nPayment ID: ${paymentId}\nDate: ${new Date().toLocaleString("en-IN")}`,
  });
  console.log(`Updating subscription for ${email} to ${plan}`);
const result = await usercollection.updateOne(
  { email },
  { $set: { subscription: plan, subscribedAt: new Date(), paymentId } }
);
console.log("Mongo update result:", result);

  res.json({ success: true });
});


  } catch (err) {
    console.error("Server Error:", err);
  }
}

run().catch(console.dir);

// Root
app.get("/", (req, res) => {
  res.send("Twiller is working 🚀");
});

app.listen(port, () => {
  console.log(`Twiller backend running on port ${port}`);
});
