const express = require("express");
const router = express.Router();

module.exports = function (client) {
  const collection = client.db("database").collection("posts");

  router.post("/", async (req, res) => {
  const { query } = req.body;

  if (!query) {
    return res.status(400).json({ response: "Query is required." });
  }

  try {
    const results = await collection
      .find({ post: { $regex: query, $options: "i" } })
      .limit(3)
      .toArray();

    if (results.length === 0) {
      return res.json({ tweets: [], message: "No tweets found for that topic." });
    }

    res.json({ tweets: results, message: "Tweets found!" });
  } catch (error) {
    console.error("Chatbot error:", error.message);
    res.status(500).json({ message: "Failed to get tweets from DB." });
  }
});


  return router;
};
