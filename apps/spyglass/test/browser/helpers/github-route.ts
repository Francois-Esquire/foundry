import type { Page, Route } from "playwright-core";
import type { fakeGitHub } from "../../lib/helpers/github-fake";

// Answers a page's requests to GitHub's API and raw content host from the
// deterministic fake (`test/lib/helpers/github-fake.ts`), with the CORS
// headers GitHub sends, so a mocked scan spends no rate limit and can hold,
// fail or replace any response. A request the route aborts reaches the
// page as a network failure, as a blocked cross-origin response does.

const GITHUB = /^https:\/\/(api\.github\.com|raw\.githubusercontent\.com)\//;

const CORS = {
  "access-control-allow-headers":
    "Authorization, Content-Type, If-None-Match, User-Agent, X-GitHub-Api-Version",
  "access-control-allow-methods": "GET",
  "access-control-allow-origin": "*",
  "access-control-expose-headers":
    "ETag, Link, Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset",
};

export type FakeGitHub = ReturnType<typeof fakeGitHub>;

export async function routeGitHub(
  page: Page,
  github: FakeGitHub
): Promise<void> {
  await page.route(GITHUB, async (route: Route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      await route.fulfill({ headers: CORS, status: 204 });
      return;
    }
    let response: Response;
    try {
      response = await github.fetch(request.url(), {
        headers: request.headers(),
      });
    } catch {
      await route.abort("failed");
      return;
    }
    await route
      .fulfill({
        body: Buffer.from(await response.arrayBuffer()),
        headers: { ...Object.fromEntries(response.headers), ...CORS },
        status: response.status,
      })
      // The page may have gone, or aborted the request, meanwhile.
      .catch(() => undefined);
  });
}
