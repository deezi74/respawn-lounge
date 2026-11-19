import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { publicPlatformScript } from "./publicConfig";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { registerMediaRoutes } from "../features/media";
import { registerCommunityRoutes } from "../features/community";
import { registerSidekickRoutes } from "../features/sidekick";
import { registerPostRoutes } from "../features/posts";
import { registerProfileRoutes } from "../features/profiles";
import { registerSocialRoutes } from "../features/social";

async function startServer() {
  const app = express();
  const server = createServer(app);
  app.disable("x-powered-by");
  // Video/audio uploads use bounded multipart handlers, not large JSON payloads.
  app.use(express.json({ limit: "128kb" }));
  app.use(express.urlencoded({ limit: "128kb", extended: true }));
  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/api/platform/config.js", (_req, res) => {
    res
      .set("Cache-Control", "no-store")
      .type("application/javascript")
      .send(publicPlatformScript());
  });
  registerOAuthRoutes(app);
  registerMediaRoutes(app);
  registerCommunityRoutes(app);
  registerSidekickRoutes(app);
  registerPostRoutes(app);
  registerProfileRoutes(app);
  registerSocialRoutes(app);
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const port = Number(process.env.PORT || "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT");
  server.on("error", error => {
    console.error("Server failed:", error.message);
    process.exit(1);
  });
  server.listen(port, "0.0.0.0", () =>
    console.log(`Server listening on port ${port}`)
  );
}

startServer().catch(error => {
  console.error(error);
  process.exit(1);
});
