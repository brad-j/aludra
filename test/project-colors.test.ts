import assert from "node:assert/strict";
import test from "node:test";
import { hueIndex, hueOf } from "../src/project-colors.ts";

test("project colors match the amyrlin Mac app's", () => {
	// The same values the Mac app's ProjectColorTests pin, so a project is one color on both.
	assert.equal(hueIndex("aludra"), 6);
	assert.equal(hueIndex("waygate-cs"), 8);
	assert.equal(hueOf("amyrlin"), 300);
});

test("a picked color wins over the name's, for that project only", () => {
	assert.equal(hueOf("aludra", { aludra: 0 }), 300);
	assert.equal(hueOf("amyrlin", { aludra: 2 }), 300);
	assert.equal(hueOf("aludra", { aludra: 99 }), hueOf("aludra"), "an index out of range falls back");
});
