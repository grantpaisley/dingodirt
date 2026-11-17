// node --test apps/nav/tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { pick, sizeFor } = require("../manoeuvre.js");

test("angle limits pick the image size", () => {
  const cases = [
    [0, "slight"], [39, "slight"], [40, "turn"], [110, "turn"],
    [111, "sharp"], [155, "sharp"], [156, "uturn"], [180, "uturn"],
  ];
  for (const [deg, img] of cases) assert.equal(sizeFor(deg), img, `${deg}°`);
});

test("right turns sit right; left turns sit left, mirrored", () => {
  assert.deepEqual(pick({ type: "right", deg: 70 }, 1),
    { img: "turn", side: "right", mirror: false, tone: "turn" });
  assert.deepEqual(pick({ type: "left", deg: -70 }, 1),
    { img: "turn", side: "left", mirror: true, tone: "turn" });
});

test("the sign of deg does not matter, only its size", () => {
  assert.equal(pick({ type: "left", deg: -120 }, 1).img, "sharp");
  assert.equal(pick({ type: "left", deg: 120 }, 1).img, "sharp"); // manual L override on a right-ish bend
  assert.equal(pick({ type: "right", deg: -30.4 }, 1).img, "slight");
  assert.equal(pick({ type: "right", deg: 39.6 }, 1).img, "turn"); // rounds to 40
});

test("riding in reverse swaps the side, not the size", () => {
  assert.deepEqual(pick({ type: "right", deg: 160 }, -1),
    { img: "uturn", side: "left", mirror: true, tone: "turn" });
  assert.deepEqual(pick({ type: "left", deg: -20 }, -1),
    { img: "slight", side: "right", mirror: false, tone: "turn" });
});

test("straight sits left in the turn colour, in both directions", () => {
  for (const dir of [1, -1])
    assert.deepEqual(pick({ type: "straight", deg: 5 }, dir),
      { img: "straight", side: "left", mirror: false, tone: "turn" });
});

test("hazard marks keep their kind; danger and obstacle use the danger colour", () => {
  assert.equal(pick({ type: "danger" }, 1).tone, "danger");
  assert.equal(pick({ type: "obstacle" }, -1).tone, "danger");
  assert.equal(pick({ type: "gate" }, 1).tone, "turn");
  assert.equal(pick({ type: "creek" }, 1).tone, "turn");
  const m = pick({ type: "creek", deg: 90 }, -1);
  assert.equal(m.img, "mark"); assert.equal(m.kind, "creek"); assert.equal(m.side, "left");
});

test("no cue → null", () => {
  assert.equal(pick(null, 1), null);
});
