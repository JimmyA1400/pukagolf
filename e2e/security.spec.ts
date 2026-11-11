import { expect, test } from "@playwright/test";

/*
  The lookups that call outside services on our behalf are for signed-in
  accounts only. Asked with no session, each one answers 401 with a polite
  line, and never reaches the outside service.
*/

const LOOKUPS = [
  "/api/courses/search?q=pine",
  "/api/courses/42",
  "/api/geocode?q=traverse",
  "/api/weather?lat=44.7&lon=-85.6",
];

for (const path of LOOKUPS) {
  test(`${path.split("?")[0]} needs a signed-in account`, async ({ request }) => {
    const response = await request.get(path);

    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({ error: "Sign in to look this up." });
  });
}
