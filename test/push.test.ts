import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { deviceProblem, encrypt, loadPushKeys, vapid } from "../src/push.ts";
import { decrypt, device, tempDir } from "./helpers.ts";

const b64 = (text: string) => Buffer.from(text.replace(/\s+/g, ""), "base64url");
test("encryption matches RFC 8291's worked example", () => {
	const body = encrypt(
		Buffer.from("When I grow up, I want to be a watermelon"),
		"BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
		"BTBZMqHH6r4Tts7J_aSIgg",
		{ salt: b64("DGv6ra1nlYgDCS1FRnbzlw"), privateKey: b64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw") },
	);
	assert.equal(
		body.toString("base64url"),
		"DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
	);
});

test("a device decrypts what's sent to it, and only a well-formed device signs up", () => {
	const d = device();
	assert.equal(decrypt(encrypt(Buffer.from("tests pass ✓"), d.p256dh, d.authText), d.ecdh, d.auth), "tests pass ✓");
	const ok = { endpoint: "https://push.test/a", p256dh: d.p256dh, auth: d.authText, origin: "https://aludra.example.ts.net" };
	assert.equal(deviceProblem(ok), undefined);
	assert.equal(deviceProblem({ ...ok, endpoint: "http://push.test/a" }), "endpoint isn't https");
	assert.equal(deviceProblem({ ...ok, p256dh: "AAAA" }), "p256dh isn't a P-256 public key");
	assert.equal(deviceProblem({ ...ok, auth: "AAAA" }), "auth isn't 16 bytes");
	assert.equal(deviceProblem({ ...ok, origin: "http://aludra.example.ts.net" }), "the app isn't served over https");
});

test("the key pair is made once and kept private, and pushes are signed with it", (t) => {
	const data = tempDir(t);
	const keys = loadPushKeys(data);
	assert.deepEqual(loadPushKeys(data), keys);
	assert.equal(statSync(join(data, "push-keys.json")).mode & 0o777, 0o600);
	const now = Date.parse("2026-10-11T12:00:00Z");
	const header = vapid("https://web.push.apple.com/QGuQyavXutnMH", keys, "https://aludra.example.ts.net", now);
	const [, token, k] = /^vapid t=(.+), k=(.+)$/.exec(header)!;
	assert.equal(k, keys.publicKey);
	const [head, claims, signature] = token!.split(".");
	assert.deepEqual(JSON.parse(b64(claims!).toString()), { aud: "https://web.push.apple.com", exp: now / 1000 + 12 * 3600, sub: "https://aludra.example.ts.net" });
	const point = b64(keys.publicKey);
	const publicKey = createPublicKey({ key: { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url") }, format: "jwk" });
	assert.ok(verify("sha256", Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, b64(signature!)));
});
