const express = require("express");
const axios = require("axios");
const cors = require("cors");
const crypto = require("crypto");
const { MongoClient } = require("mongodb");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const MONGO_HOST = process.env.MONGO_HOST || "127.0.0.1";
const MONGO_PORT = process.env.MONGO_PORT || "27017";
const MONGO_DATABASE =
  process.env.MONGO_DATABASE || "github_proxy";
const DB_USERNAME = process.env.DB_USERNAME;
const DB_PASSWORD = process.env.DB_PASSWORD;

if (process.env.MONGO_PORT !== undefined) {
  const parsed = Number(process.env.MONGO_PORT);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(
      `MONGO_PORT must be an integer between 1 and 65535 (got "${process.env.MONGO_PORT}")`
    );
  }
}

if ((DB_USERNAME && !DB_PASSWORD) || (!DB_USERNAME && DB_PASSWORD)) {
  throw new Error(
    "DB_USERNAME and DB_PASSWORD must both be set, or both be unset"
  );
}

const MONGO_URI = process.env.MONGO_URI || createMongoUri();
const CACHE_TTL_SECONDS = Number(
  process.env.CACHE_TTL_SECONDS || 300
);

const GITHUB_API = "https://api.github.com";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const mongoClient = new MongoClient(MONGO_URI);
let cacheCollection;
let httpServer;

app.use(cors());

function createMongoUri() {
  const hasCredentials = DB_USERNAME && DB_PASSWORD;
  const credentials = hasCredentials
    ? `${encodeURIComponent(DB_USERNAME)}:${encodeURIComponent(
        DB_PASSWORD
      )}@`
    : "";
  const authentication = hasCredentials
    ? "?authSource=admin"
    : "";

  return `mongodb://${credentials}${MONGO_HOST}:${MONGO_PORT}/${MONGO_DATABASE}${authentication}`;
}

function createCacheKey(url) {
  // Sort query parameters so differently ordered queries share a cache entry.
  const parameters = [...url.searchParams.entries()].sort(
    ([keyA, valueA], [keyB, valueB]) =>
      keyA.localeCompare(keyB) || valueA.localeCompare(valueB)
  );

  const canonicalQuery = new URLSearchParams(parameters).toString();
  const canonicalUrl =
    url.pathname + (canonicalQuery ? `?${canonicalQuery}` : "");

  return crypto
    .createHash("sha256")
    .update(`GET:${canonicalUrl}`)
    .digest("hex");
}

function sendResponse(res, response, cacheStatus) {
  res.set("X-Cache", cacheStatus);

  if (response.contentType) {
    res.set("Content-Type", response.contentType);
  }

  // Preserve GitHub pagination links.
  if (response.link) {
    res.set("Link", response.link);
  }

  return res.status(response.status).send(response.body);
}

app.get("/", (req, res) => {
  res.json({
    message: "GitHub API proxy",
    usage: "/github/users/torvalds",
  });
});

app.use("/github", async (req, res) => {
  // Keep this public proxy read-only.
  if (req.method !== "GET") {
    res.set("Allow", "GET");
    return res.status(405).json({
      error: "Only GET requests are allowed",
    });
  }

  /*
   * Because this handler is mounted at /github:
   * /github/users/torvalds?x=1 becomes /users/torvalds?x=1
   */
  const normalizedUrl = req.url.replace(/^\/+/, "/");
  const localUrl = new URL(normalizedUrl, "http://proxy.local");
  const githubUrl = new URL(GITHUB_API);

  githubUrl.pathname = localUrl.pathname;
  githubUrl.search = localUrl.search;

  const cacheKey = createCacheKey(githubUrl);
  const now = new Date();

  // Try MongoDB first.
  try {
    const cached = await cacheCollection.findOne({
      _id: cacheKey,
      expiresAt: { $gt: now },
    });

    if (cached) {
      return sendResponse(res, cached, "HIT");
    }
  } catch (error) {
    // A cache failure should not stop the proxy.
    console.error("MongoDB cache read failed:", error.message);
  }

  try {
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "github-api-proxy",
    };

    if (GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
    }

    const githubResponse = await axios.get(githubUrl.toString(), {
      headers,
      timeout: 10000,
      responseType: "text",
      transformResponse: [(body) => body],
      validateStatus: () => true,
    });

    const result = {
      status: githubResponse.status,
      body: githubResponse.data,
      contentType:
        githubResponse.headers["content-type"] ||
        "application/json; charset=utf-8",
      link: githubResponse.headers.link || null,
    };

    // Cache only successful responses.
    if (githubResponse.status === 200) {
      const expiresAt = new Date(
        Date.now() + CACHE_TTL_SECONDS * 1000
      );

      try {
        await cacheCollection.updateOne(
          { _id: cacheKey },
          {
            $set: {
              ...result,
              url: githubUrl.toString(),
              createdAt: new Date(),
              expiresAt,
            },
          },
          { upsert: true }
        );
      } catch (error) {
        console.error("MongoDB cache write failed:", error.message);
      }
    }

    return sendResponse(res, result, "MISS");
  } catch (error) {
    console.error("GitHub request failed:", error.message);

    return res.status(502).json({
      error: "Unable to contact GitHub API",
    });
  }
});

async function start() {
  await mongoClient.connect();

  const database = mongoClient.db(MONGO_DATABASE);
  cacheCollection = database.collection("api_cache");

  // MongoDB removes documents after expiresAt has passed.
  await cacheCollection.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0 }
  );

  httpServer = app.listen(PORT, () => {
    console.log(`Proxy running at http://localhost:${PORT}`);
    console.log(`Cache TTL: ${CACHE_TTL_SECONDS} seconds`);
  });
}

start().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});

async function shutdown() {
  if (httpServer) {
    await new Promise((resolve) => httpServer.close(resolve));
  }
  try {
    await mongoClient.close();
  } catch (error) {
    console.error("Error during shutdown:", error.message);
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
