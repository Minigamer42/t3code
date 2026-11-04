import * as BrowserAuth from "./BrowserAuth.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthRelayWriteScope,
  AuthSessionId,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as AuthHttp from "../auth/http.ts";
import * as CloudLink from "./CloudLink.ts";
import * as ConnectHttp from "./http.ts";

class ConnectTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.connect) {}

// The signed relay routes need no session, so a CloudLink that fails each
// request shows how the transport answers that failure.
type HealthFailure = Effect.Error<
  ReturnType<CloudLink.CloudLink["Service"]["answerHealthRequest"]>
>;

const answerHealthWith = async (failure: HealthFailure) => {
  const layerRoutes = HttpApiBuilder.layer(ConnectTestApi).pipe(
    Layer.provide(ConnectHttp.layer),
    Layer.provide(Layer.mock(BrowserAuth.BrowserAuth)({})),
    Layer.provide(
      Layer.mock(CloudLink.CloudLink)({
        answerHealthRequest: () => Effect.fail(failure),
      }),
    ),
    // The session-gated routes are declared too; this request never reaches them.
    Layer.provide(AuthHttp.layerAuthenticatedAuth),
    Layer.provide(Layer.mock(EnvironmentAuth.EnvironmentAuth)({})),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(layerRoutes, {
    disableLogger: true,
  });
  try {
    const response = await handler(
      new Request("http://127.0.0.1/api/t3-connect/health", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proof: "proof" }),
      }),
    );
    return { status: response.status, body: (await response.json()) as unknown };
  } finally {
    await dispose();
  }
};

describe("connect routes", () => {
  it.each([
    {
      failure: new CloudLink.CloudLinkProofRejectedError({ request: "health" }),
      status: 401,
      body: { _tag: "EnvironmentHttpUnauthorizedError", message: "Invalid cloud health request." },
    },
    {
      failure: new CloudLink.CloudLinkProofReplayedError({ request: "health" }),
      status: 409,
      body: {
        _tag: "EnvironmentHttpConflictError",
        message: "Cloud health request was already consumed.",
      },
    },
    {
      failure: new CloudLink.CloudLinkInternalError({
        operation: "answer-health",
        cause: new Error("disk full"),
      }),
      status: 500,
      body: {
        _tag: "EnvironmentHttpInternalServerError",
        message: "Could not answer cloud health request.",
      },
    },
    {
      failure: new EnvironmentAuth.ServerAuthCloudMintPublicKeyMissingError({}),
      status: 500,
      body: {
        _tag: "EnvironmentHttpInternalServerError",
        message: "Cloud mint public key is not installed for this environment.",
      },
    },
  ])("answers $failure._tag with HTTP $status", async ({ failure, status, body }) => {
    const response = await answerHealthWith(failure);
    expect(response).toEqual({ status, body });
  });
});

describe("native browser sign-in route", () => {
  it.each([true, false])(
    "requires the environment's relay grant (allowed: %s)",
    async (allowed) => {
      const forwarded: Array<Parameters<BrowserAuth.BrowserAuth["Service"]["forward"]>[0]> = [];
      const layerRoutes = HttpApiBuilder.layer(ConnectTestApi).pipe(
        Layer.provide(ConnectHttp.layer),
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(CloudLink.CloudLink, {}),
            Layer.succeed(BrowserAuth.BrowserAuth, {
              forward: (input) => {
                forwarded.push(input);
                return Effect.succeed({
                  status: 200,
                  body: '{"response":{"id":"client"}}',
                  clientToken: "Bearer clerk-client-jwt",
                });
              },
            }),
            Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
              effect.pipe(
                Effect.provideService(EnvironmentAuthenticatedPrincipal, {
                  sessionId: AuthSessionId.make("native-browser"),
                  subject: "native-browser",
                  method: "browser-session-cookie",
                  scopes: new Set(allowed ? [AuthRelayWriteScope] : []),
                }),
              ),
            ),
          ),
        ),
        Layer.provideMerge(
          HttpPlatform.layer.pipe(
            Layer.provideMerge(NodeServices.layer),
            Layer.provideMerge(Etag.layerWeak),
          ),
        ),
      );
      const { handler, dispose } = HttpRouter.toWebHandler(layerRoutes, { disableLogger: true });
      try {
        const response = await handler(
          new Request("http://127.0.0.1/api/connect/native-auth?path=%2Fv1%2Fclient&search=", {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              "x-t3-clerk-client": "browser-client",
              cookie: "environment-cookie=private",
            },
            body: "code=123456",
          }),
        );
        expect(response.status).toBe(allowed ? 200 : 403);
        expect(forwarded).toHaveLength(allowed ? 1 : 0);
        if (allowed) {
          expect(response.headers.get("cache-control")).toBe("no-store");
          expect(response.headers.get("x-t3-clerk-client")).toBe("Bearer clerk-client-jwt");
          expect(forwarded[0]).toMatchObject({
            path: "/v1/client",
            method: "POST",
            clientToken: "browser-client",
            body: new TextEncoder().encode("code=123456"),
          });
        }
      } finally {
        await dispose();
      }
    },
  );
});
