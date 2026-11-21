import assert from "node:assert/strict";
import test from "node:test";
import { hueIndex, hueOf } from "../src/project-colors.ts";

test("project colors match loial's", () => {
	// The same values loial's hosts test pins, so a project is one color in both.
	assert.equal(hueIndex("aludra"), 6);
	assert.equal(hueIndex("waygate-cs"), 8);
	assert.equal(hueOf("pi-desktop"), 300);
});

test("a picked color wins over the name's, for that project only", () => {
	assert.equal(hueOf("aludra", { aludra: 0 }), 300);
	assert.equal(hueOf("pi-desktop", { aludra: 2 }), 300);
	assert.equal(hueOf("aludra", { aludra: 99 }), hueOf("aludra"), "an index out of range falls back");
});
