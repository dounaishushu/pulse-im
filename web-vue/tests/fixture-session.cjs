const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

function readFixture() {
  const file = process.env.PULSE_WEB_TEST_FIXTURE || path.join(__dirname, "vue-fixtures.private.json");
  const fixture = JSON.parse(fs.readFileSync(file));
  for (const value of [fixture.base, fixture.ui]) {
    const origin = new URL(value);
    assert.ok(["127.0.0.1", "localhost"].includes(origin.hostname) &&
      origin.protocol === "http:" && !origin.username && !origin.password,
      "The browser suite requires an isolated localhost fixture");
  }
  return fixture;
}

async function loginFixture(request, fixture, account, deviceId) {
  const response = await request.post(fixture.base + "/auth/login", {
    data: { account, password: fixture.password, device_id: deviceId, platform: "web" },
    maxRedirects: 0,
  });
  assert.equal(response.status(), 200, "Create a fresh isolated fixture session");
  return response.json();
}

module.exports = { loginFixture, readFixture };
