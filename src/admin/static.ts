import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

export async function registerAdminUi(app: FastifyInstance) {
  const roots = [
    resolve(process.cwd(), "dist/admin-ui"),
    fileURLToPath(new URL("../../admin-ui", import.meta.url))
  ];
  const root = roots.find((candidate) => existsSync(join(candidate, "index.html"))) ?? roots[0]!;
  const indexPath = join(root, "index.html");

  if (!existsSync(indexPath)) {
    app.get("/admin", async (_request, reply) => reply.code(503).send({
      error: "管理端资源尚未构建",
      command: "npm run build:admin"
    }));
    return;
  }

  await app.register(fastifyStatic, { root, prefix: "/admin/" });
  app.get("/admin", async (_request, reply) => reply.redirect("/admin/"));
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/admin/")) {
      return reply.type("text/html").sendFile("index.html");
    }
    return reply.code(404).send({ error: "Not Found" });
  });
}
