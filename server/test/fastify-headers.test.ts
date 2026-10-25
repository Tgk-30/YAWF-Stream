import Fastify from "fastify";
import { describe, expect, it } from "vitest";

// Dependency regression for GHSA-389g-gv7q-r4x8. Application authentication
// remains enforced by its hooks, not by these standalone test routes.
describe("Fastify header-name normalization", () => {
  for (const constraint of [
    { name: "enum", schema: { enum: ["X-Debug-Override"] } },
    { name: "const", schema: { const: "X-Debug-Override" } },
  ]) {
    for (const header of ["X-Debug-Override", "x-debug-override", "X-dEbUg-Override"]) {
      it(`rejects ${header} before the handler with ${constraint.name}`, async () => {
        const app = Fastify();
        let handlerCalls = 0;
        app.get("/restricted", {
          schema: {
            headers: { type: "object", propertyNames: { not: constraint.schema } },
          },
        }, () => {
          handlerCalls += 1;
          return { ok: true };
        });
        try {
          const response = await app.inject({
            method: "GET", url: "/restricted", headers: { [header]: "1" },
          });
          expect(response.statusCode).toBe(400);
          expect(handlerCalls).toBe(0);
        } finally {
          await app.close();
        }
      });
    }

    it(`preserves legitimate headers with ${constraint.name}`, async () => {
      const app = Fastify();
      app.get("/restricted", {
        schema: {
          headers: { type: "object", propertyNames: { not: constraint.schema } },
        },
      }, () => ({ ok: true }));
      try {
        const response = await app.inject({
          method: "GET", url: "/restricted", headers: { "X-Allowed": "1" },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ ok: true });
      } finally {
        await app.close();
      }
    });
  }
});
